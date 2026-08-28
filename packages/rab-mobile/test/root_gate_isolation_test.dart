import 'dart:convert';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:provider/provider.dart';

import 'package:rab_staff/app.dart';
import 'package:rab_staff/core/api/api_client.dart';
import 'package:rab_staff/core/auth/auth_provider.dart';
import 'package:rab_staff/core/auth/biometric_authenticator.dart';
import 'package:rab_staff/features/notifications/notifications_provider.dart';
import 'package:rab_staff/features/offers/offers_provider.dart';
import 'package:rab_staff/navigation/app_shell.dart';

import 'support/biometric_test_support.dart';

/// Increment 1 (Auth Foundation) — proves the keyed `MultiProvider` in
/// `_RootGate` (`key: ValueKey(auth.user!.id)`) actually disposes and
/// reconstructs `OffersProvider`/`NotificationsProvider` on every account
/// switch, rather than mutating shared instances. This is the concrete
/// mechanism that gives two different Staff accounts on one physical
/// device correct isolation — no separate cache-clearing logic exists (or
/// is needed) because Flutter tears the whole per-session provider subtree
/// down and rebuilds it fresh whenever the authenticated user id changes.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const channel = MethodChannel('plugins.it_nomads.com/flutter_secure_storage');
  late Map<String, String> secureStore;

  setUp(() {
    secureStore = {};
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, (call) async {
      final args = call.arguments is Map ? call.arguments as Map : const {};
      switch (call.method) {
        case 'write':
          secureStore[args['key'] as String] = args['value'] as String;
          return null;
        case 'read':
          return secureStore[args['key'] as String];
        case 'delete':
          secureStore.remove(args['key'] as String);
          return null;
        case 'containsKey':
          return secureStore.containsKey(args['key'] as String);
        default:
          return null;
      }
    });
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, null);
  });

  const staffAEmail = 'staffA@example.test';
  const staffBEmail = 'staffB@example.test';
  const password = 'correct horse battery staple 1!';

  Map<String, dynamic> currentUserJson(String who) => {
        'id': 'user-$who',
        'email': who == 'A' ? staffAEmail : staffBEmail,
        'firstName': 'Staff',
        'lastName': who,
        'organisationId': 'org-1',
        'roles': ['staff'],
        'mustResetPassword': false,
      };

  int unreadCountFor(String? who) => who == 'A' ? 1 : 2;

  /// `NotificationsProvider.load()` recomputes `unreadCount` from whatever
  /// this list contains (`notifications_provider.dart`), independent of the
  /// polled `/notifications/unread-count` value — so the mock must return a
  /// list whose unread count agrees with `unreadCountFor`, or the two
  /// diverge exactly like the real backend's `take: 50` cap can in
  /// production for a user with many notifications (out of scope to fix
  /// here — Increment 1 is Auth Foundation, not Notifications).
  List<Map<String, dynamic>> notificationsListFor(String? who) {
    final now = DateTime.now().toUtc();
    return List.generate(
      unreadCountFor(who),
      (i) => {
        'id': 'notification-$who-$i',
        'type': 'offer_sent',
        'title': 'New offer',
        'message': 'You have a new offer',
        'readAt': null,
        'createdAt': now.toIso8601String(),
      },
    );
  }

  Map<String, dynamic> offerJson(String who) {
    final now = DateTime.now().toUtc();
    return {
      'id': 'offer-$who',
      'status': 'pending',
      'sentAt': now.toIso8601String(),
      'expiresAt': now.add(const Duration(days: 1)).toIso8601String(),
      'estimatedPayPence': 10000,
      'shiftId': 'shift-$who',
      'startsAt': now.add(const Duration(days: 2)).toIso8601String(),
      'endsAt': now.add(const Duration(days: 2, hours: 8)).toIso8601String(),
      'venueName': 'Venue $who',
      'roleName': 'Role $who',
      'staffProfileId': 'staff-profile-$who',
      'staffName': 'Staff $who',
    };
  }

  /// A handful of short pumps to flush chained async work (secure-storage
  /// reads, mocked HTTP round trips) that `pumpAndSettle` can otherwise
  /// exit past if nothing has scheduled a new frame yet at the moment it
  /// checks — more deterministic here than relying on that heuristic alone.
  Future<void> settle(WidgetTester tester) async {
    for (var i = 0; i < 10; i++) {
      await tester.pump(const Duration(milliseconds: 1));
    }
  }

  testWidgets(
    'logging out and back in as a different Staff account fully replaces per-session state — no bleed',
    (tester) async {
      final unreadCallsByUser = <String, int>{'A': 0, 'B': 0};

      String? whoFor(http.Request request) {
        final authHeader = request.headers['Authorization'] ?? '';
        if (authHeader.contains('access-A')) return 'A';
        if (authHeader.contains('access-B')) return 'B';
        return null;
      }

      final mockClient = MockClient((request) async {
        final path = request.url.path;

        if (path.endsWith('/auth/login')) {
          final body = jsonDecode(request.body) as Map<String, dynamic>;
          final who = body['email'] == staffAEmail ? 'A' : 'B';
          return http.Response(jsonEncode({'accessToken': 'access-$who', 'refreshToken': 'refresh-$who'}), 200);
        }

        final who = whoFor(request);

        if (path.endsWith('/auth/me')) {
          return http.Response(jsonEncode(currentUserJson(who!)), 200);
        }
        if (path.endsWith('/offers/mine')) {
          return http.Response(jsonEncode([offerJson(who!)]), 200);
        }
        if (path.endsWith('/notifications/unread-count')) {
          if (who != null) unreadCallsByUser[who] = (unreadCallsByUser[who] ?? 0) + 1;
          return http.Response(jsonEncode({'count': unreadCountFor(who)}), 200);
        }
        if (path.endsWith('/notifications')) {
          return http.Response(jsonEncode(notificationsListFor(who)), 200);
        }
        if (path.endsWith('/auth/logout')) {
          return http.Response('', 200);
        }
        return http.Response('not found', 404);
      });

      // A real LocalAuthBiometricAuthenticator's platform-channel call
      // inside a directly-awaited (un-pumped) `login()` call hangs
      // indefinitely in a `testWidgets` FakeAsync zone — unlike a plain
      // `test()` body (see auth_flow_test.dart), where the same call
      // resolves to MissingPluginException immediately. Increment 3's
      // capability probe on every login means this test now needs a fake
      // authenticator to avoid that hang; biometrics aren't otherwise
      // relevant to what this test proves (provider disposal/isolation).
      final authProvider = AuthProvider(
        apiClient: ApiClient(httpClient: mockClient),
        biometricAuthenticator: FakeBiometricAuthenticator(capability: BiometricCapability.unavailable),
      );

      await tester.pumpWidget(
        ChangeNotifierProvider<AuthProvider>.value(value: authProvider, child: const RabApp()),
      );
      await tester.pumpAndSettle();
      expect(find.text('Create your dream now'), findsOneWidget);

      // --- Staff A logs in ---
      await authProvider.login(staffAEmail, password);
      await tester.pumpAndSettle();

      final shellContextA = tester.element(find.byType(AppShell));
      final offersA = Provider.of<OffersProvider>(shellContextA, listen: false);
      final notificationsA = Provider.of<NotificationsProvider>(shellContextA, listen: false);
      await settle(tester); // let OffersProvider's/NotificationsProvider's constructor-triggered loads land
      expect(offersA.offers.map((o) => o.id), contains('offer-A'));
      expect(notificationsA.unreadCount, 1);

      // Force one extra 30s poll cycle while Staff A is still logged in.
      await tester.pump(const Duration(seconds: 31));
      final callsToAAfterFirstTick = unreadCallsByUser['A']!;
      expect(callsToAAfterFirstTick, greaterThanOrEqualTo(2)); // constructor call + one timer tick

      // --- Logout, then Staff B logs in on the same device ---
      await authProvider.logout();
      await tester.pumpAndSettle();
      expect(find.text('Create your dream now'), findsOneWidget);

      await authProvider.login(staffBEmail, password);
      await tester.pumpAndSettle();

      final shellContextB = tester.element(find.byType(AppShell));
      final offersB = Provider.of<OffersProvider>(shellContextB, listen: false);
      final notificationsB = Provider.of<NotificationsProvider>(shellContextB, listen: false);
      await settle(tester);

      // New instances, not the same objects mutated in place.
      expect(identical(offersA, offersB), isFalse);
      expect(identical(notificationsA, notificationsB), isFalse);

      // Staff B sees only Staff B's data.
      expect(offersB.offers.map((o) => o.id), contains('offer-B'));
      expect(offersB.offers.map((o) => o.id), isNot(contains('offer-A')));
      expect(notificationsB.unreadCount, 2);

      // Staff A's disposed NotificationsProvider must not still be polling —
      // its Timer.periodic is cancelled in dispose() (notifications_provider.dart).
      await tester.pump(const Duration(seconds: 31));
      expect(unreadCallsByUser['A'], callsToAAfterFirstTick, reason: 'Staff A\'s poll timer must stop firing once disposed on logout');
      expect(unreadCallsByUser['B']!, greaterThanOrEqualTo(2));
    },
  );
}
