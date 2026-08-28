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
import 'package:rab_staff/features/login/login_screen.dart';
import 'package:rab_staff/features/welcome/welcome_screen.dart';
import 'package:rab_staff/navigation/app_shell.dart';

import 'support/biometric_test_support.dart';

/// Regression test for a real bug: `LoginScreen` reached via `Navigator.push`
/// (the Welcome -> "Login" path) sits on top of `_RootGate` in the
/// navigation stack. A successful login flips `AuthProvider.phase`, which
/// makes `_RootGate` rebuild into `AppShell`/`SetPasswordScreen`/etc.
/// underneath — but nothing ever popped the still-pushed `LoginScreen` off
/// the top, so the user stayed stuck looking at the login form after every
/// successful login, with no visible feedback, until repeated taps
/// eventually hit the rate limiter. `login_screen.dart`'s `_signIn()` now
/// pops back to the root on success; this proves it.
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

  testWidgets('logging in via the pushed LoginScreen (Welcome -> Login) reaches the app, not stuck on the form', (tester) async {
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
      return http.Response('not found', 404);
    });
    final auth = AuthProvider(
      apiClient: ApiClient(httpClient: mockClient),
      biometricAuthenticator: FakeBiometricAuthenticator(capability: BiometricCapability.unavailable),
    );

    await tester.pumpWidget(ChangeNotifierProvider.value(value: auth, child: const RabApp()));
    await settle(tester);
    expect(find.byType(WelcomeScreen), findsOneWidget);

    await tester.tap(find.text('Login'));
    await settle(tester);
    expect(find.byType(LoginScreen), findsOneWidget);

    await tester.enterText(find.byType(TextField).at(0), 'alice@example.test');
    await tester.enterText(find.byType(TextField).at(1), 'password123');
    await settle(tester);

    await tester.tap(find.text('Log in'));
    await settle(tester);

    // The actual regression: the pushed LoginScreen must be gone, revealing
    // whatever `_RootGate` now renders for the authenticated user.
    expect(find.byType(LoginScreen), findsNothing);
    expect(find.byType(AppShell), findsOneWidget);
  });
}
