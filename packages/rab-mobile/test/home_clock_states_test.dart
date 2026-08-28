import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:provider/provider.dart';

import 'package:rab_staff/core/api/api_client.dart';
import 'package:rab_staff/core/auth/auth_provider.dart';
import 'package:rab_staff/core/theme/tokens.dart';
import 'package:rab_staff/features/home/attendance_provider.dart';
import 'package:rab_staff/features/home/home_screen.dart';
import 'package:rab_staff/features/notifications/notifications_provider.dart';
import 'package:rab_staff/features/offers/offers_provider.dart';

import 'support/biometric_test_support.dart';

/// Proves the Home screen's Clock In/Out card reflects real
/// `AttendanceProvider`/`OffersProvider` state — never a hardcoded value —
/// for the two states reachable without device biometrics: assigned-and-
/// not-clocked-in (shows "Clock in") and clocked-in-live (shows the live
/// timer and "Check out", sourced from the mocked `clockInAt`).
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late Map<String, String> secureStore;
  setUp(() => secureStore = {});
  tearDown(clearSecureStorageChannel);

  Future<void> settle(WidgetTester tester) async {
    for (var i = 0; i < 20; i++) {
      await tester.pump(const Duration(milliseconds: 16));
    }
  }

  Map<String, dynamic> todayOfferJson() {
    final now = DateTime.now().toUtc();
    return {
      'id': 'offer-1',
      'status': 'manager_confirmed',
      'sentAt': now.toIso8601String(),
      'expiresAt': now.add(const Duration(days: 1)).toIso8601String(),
      'estimatedPayPence': 6000,
      'shiftId': 'shift-1',
      'startsAt': now.toIso8601String(),
      'endsAt': now.add(const Duration(hours: 8)).toIso8601String(),
      'venueName': 'Acme Venue',
      'roleName': 'Bartender',
      'staffProfileId': 'staff-1',
      'staffName': 'Alice Example',
    };
  }

  Widget wrap(http.Client client) {
    final api = ApiClient(httpClient: client);
    return MultiProvider(
      providers: [
        ChangeNotifierProvider<AuthProvider>(create: (_) => AuthProvider(apiClient: api)),
        ChangeNotifierProvider<OffersProvider>(create: (_) => OffersProvider(api)),
        ChangeNotifierProvider<NotificationsProvider>(create: (_) => NotificationsProvider(api)),
        ChangeNotifierProvider<AttendanceProvider>(create: (_) => AttendanceProvider(api)),
      ],
      child: MaterialApp(theme: buildLightTheme(), home: const HomeScreen()),
    );
  }

  testWidgets('assigned today, not clocked in -> shows the shift and a Clock in button', (tester) async {
    stubSecureStorageChannel(secureStore);
    final client = MockClient((request) async {
      final path = request.url.path;
      if (path.endsWith('/auth/me')) return http.Response(jsonEncode(fakeUserJson()), 200);
      if (path.endsWith('/offers/mine')) return http.Response(jsonEncode([todayOfferJson()]), 200);
      if (path.endsWith('/notifications/unread-count')) return http.Response(jsonEncode({'count': 0}), 200);
      if (path.endsWith('/notifications')) return http.Response(jsonEncode([]), 200);
      if (path.endsWith('/attendance/me/active')) return http.Response(jsonEncode({'attendance': null, 'serverNow': DateTime.now().toIso8601String()}), 200);
      if (path.endsWith('/attendance/me/history')) return http.Response(jsonEncode([]), 200);
      return http.Response('not found', 404);
    });
    await secureStore.let((s) async {
      s['rab.accessToken'] = 'access-1';
      s['rab.refreshToken'] = 'refresh-1';
    });

    await tester.pumpWidget(wrap(client));
    await settle(tester);

    expect(find.text("TODAY'S SHIFT"), findsOneWidget);
    expect(find.text('Acme Venue'), findsOneWidget);
    expect(find.text('Clock in'), findsOneWidget);
    expect(find.text('Check out'), findsNothing);
  });

  testWidgets('clocked in -> shows the live timer and a Check out button, not the Clock in card', (tester) async {
    stubSecureStorageChannel(secureStore);
    final clockInAt = DateTime.now().toUtc().subtract(const Duration(minutes: 5)).toIso8601String();
    final client = MockClient((request) async {
      final path = request.url.path;
      if (path.endsWith('/auth/me')) return http.Response(jsonEncode(fakeUserJson()), 200);
      if (path.endsWith('/offers/mine')) return http.Response(jsonEncode([todayOfferJson()]), 200);
      if (path.endsWith('/notifications/unread-count')) return http.Response(jsonEncode({'count': 0}), 200);
      if (path.endsWith('/notifications')) return http.Response(jsonEncode([]), 200);
      if (path.endsWith('/attendance/me/active')) {
        return http.Response(
          jsonEncode({
            'attendance': {
              'id': 'att-1',
              'status': 'active',
              'clockInAt': clockInAt,
              'clockOutAt': null,
              'workedMinutes': null,
              'earnedPence': null,
              'shiftId': 'shift-1',
              'startsAt': DateTime.now().toUtc().toIso8601String(),
              'endsAt': DateTime.now().toUtc().add(const Duration(hours: 8)).toIso8601String(),
              'venueName': 'Acme Venue',
              'roleName': 'Bartender',
              'staffProfileId': 'staff-1',
              'staffName': 'Alice Example',
            },
            'serverNow': DateTime.now().toIso8601String(),
          }),
          200,
        );
      }
      if (path.endsWith('/attendance/me/history')) return http.Response(jsonEncode([]), 200);
      return http.Response('not found', 404);
    });
    await secureStore.let((s) async {
      s['rab.accessToken'] = 'access-1';
      s['rab.refreshToken'] = 'refresh-1';
    });

    await tester.pumpWidget(wrap(client));
    await settle(tester);

    expect(find.text('TIME ON SHIFT'), findsOneWidget);
    expect(find.text('Check out'), findsOneWidget);
    expect(find.text('Clock in'), findsNothing);
  });
}

extension _Let<T> on T {
  Future<void> let(Future<void> Function(T) fn) => fn(this);
}
