import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:provider/provider.dart';

import 'package:rab_staff/app.dart';
import 'package:rab_staff/core/api/api_client.dart';
import 'package:rab_staff/core/auth/auth_provider.dart';
import 'package:rab_staff/core/auth/biometric_authenticator.dart';
import 'package:rab_staff/features/home/home_screen.dart';

import 'support/biometric_test_support.dart';

/// Regression test for a real crash: `HomeScreen` reaches
/// `NotificationsScreen`/`OffersScreen` via `Navigator.of(context).push(...)`,
/// which inserts the new route into the app's single `Navigator`'s
/// `Overlay` as a sibling of the calling route — not as its descendant.
/// `OffersProvider`/`NotificationsProvider` used to be scoped inside
/// `_RootGate`, i.e. *below* that `Navigator`, so pushed routes couldn't see
/// them and threw `ProviderNotFoundException` the moment a user tapped the
/// notification bell or the offers summary card on Home. `app.dart` now
/// provides them from `MaterialApp.builder`, which wraps the `Navigator`
/// itself; this proves both pushes now resolve their providers.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late Map<String, String> secureStore;
  setUp(() => secureStore = {});
  tearDown(clearSecureStorageChannel);

  Future<void> settle(WidgetTester tester) async {
    for (var i = 0; i < 60; i++) {
      await tester.pump(const Duration(milliseconds: 16));
    }
  }

  testWidgets('tapping the notification bell and the offers card on Home does not throw ProviderNotFoundException', (tester) async {
    stubSecureStorageChannel(secureStore);

    final mockClient = MockClient((request) async {
      final path = request.url.path;
      if (path.endsWith('/auth/login')) {
        return http.Response(jsonEncode({'accessToken': 'access-1', 'refreshToken': 'refresh-1'}), 200);
      }
      if (path.endsWith('/auth/me')) return http.Response(jsonEncode(fakeUserJson()), 200);
      if (path.endsWith('/offers/mine')) return http.Response(jsonEncode([]), 200);
      if (path.endsWith('/notifications/unread-count')) return http.Response(jsonEncode({'count': 0}), 200);
      if (path.endsWith('/notifications')) return http.Response(jsonEncode([]), 200);
      if (path.endsWith('/attendance/me/active')) {
        return http.Response(jsonEncode({'attendance': null, 'serverNow': DateTime.now().toIso8601String()}), 200);
      }
      if (path.endsWith('/attendance/me/history')) return http.Response(jsonEncode([]), 200);
      return http.Response('not found', 404);
    });
    final auth = AuthProvider(
      apiClient: ApiClient(httpClient: mockClient),
      biometricAuthenticator: FakeBiometricAuthenticator(capability: BiometricCapability.unavailable),
    );

    await tester.pumpWidget(ChangeNotifierProvider.value(value: auth, child: const RabApp()));
    await settle(tester);

    await auth.login('alice@example.test', 'password123');
    await settle(tester);
    expect(find.byType(HomeScreen), findsOneWidget);

    // Push NotificationsScreen the same way Home does: tapping the bell icon.
    await tester.tap(find.byIcon(Icons.notifications_outlined));
    await settle(tester);
    expect(tester.takeException(), isNull);
    expect(find.text('Notifications'), findsOneWidget);
    expect(find.text('No notifications yet.'), findsOneWidget);

    await tester.pageBack();
    await settle(tester);
    expect(find.byType(HomeScreen), findsOneWidget);

    // Push OffersScreen the same way Home does: tapping the summary card.
    await tester.tap(find.text('New offers'));
    await settle(tester);
    expect(tester.takeException(), isNull);
    expect(find.text('Offers'), findsOneWidget);
    expect(find.text('No offers yet. New shift offers from your manager will show up here.'), findsOneWidget);
  });
}
