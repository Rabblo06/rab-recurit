import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:provider/provider.dart';

import 'package:rab_staff/core/api/api_client.dart';
import 'package:rab_staff/core/auth/auth_provider.dart';
import 'package:rab_staff/core/auth/biometric_authenticator.dart';
import 'package:rab_staff/core/theme/tokens.dart';
import 'package:rab_staff/features/biometric_setup/biometric_setup_sheet_content.dart';

import 'support/biometric_test_support.dart';

/// Setup now reports unavailable confirmation inline, preserving the same
/// mounted screen for retry or explicit Skip instead of pushing a dialog.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late Map<String, String> secureStore;

  setUp(() => secureStore = {});
  tearDown(clearSecureStorageChannel);

  MockClient buildClient() => MockClient((request) async {
    final path = request.url.path;
    if (path.endsWith('/auth/login')) {
      return http.Response(
        jsonEncode({'accessToken': 'access-1', 'refreshToken': 'refresh-1'}),
        200,
      );
    }
    if (path.endsWith('/auth/me')) {
      return http.Response(jsonEncode(fakeUserJson()), 200);
    }
    return http.Response('not found', 404);
  });

  Future<AuthProvider> loggedInAuth(FakeBiometricAuthenticator fakeAuth) async {
    stubSecureStorageChannel(secureStore);
    final auth = AuthProvider(
      apiClient: ApiClient(httpClient: buildClient()),
      biometricAuthenticator: fakeAuth,
    );
    await waitUntilPhaseNot(auth, AuthPhase.loading);
    await auth.login('alice@example.test', 'password123');
    expect(auth.phase, AuthPhase.offeringBiometricSetup);
    return auth;
  }

  // `create:` (not `.value()`) so provider disposes `auth` when the
  // framework unmounts the tree between tests — MOB-01's 90-day deadline
  // Timer must be cancelled before flutter_test's own pending-timer check,
  // which runs before `addTearDown` callbacks ever get a chance to.
  Widget wrap(AuthProvider auth) => ChangeNotifierProvider(
    create: (_) => auth,
    child: MaterialApp(
      theme: buildLightTheme(),
      home: const Scaffold(body: BiometricSetupSheetContent(reveal: 1)),
    ),
  );

  Future<void> settle(WidgetTester tester) async {
    for (var i = 0; i < 30; i++) {
      await tester.pump(const Duration(milliseconds: 16));
    }
  }

  testWidgets(
    'unavailable confirmation stays on setup with an inline message',
    (tester) async {
      final fakeAuth = FakeBiometricAuthenticator(
        outcome: BiometricOutcome.notAvailable,
      );
      final auth = await loggedInAuth(fakeAuth);

      await tester.pumpWidget(wrap(auth));
      await settle(tester);

      // FakeBiometricAuthenticator's default single enrolled type (fingerprint)
      // now resolves to its real per-type, per-platform label ("Fingerprint"
      // on this non-iOS test runner) rather than the old generic fallback.
      await tester.tap(find.text('Enable Passkey'));
      await settle(tester);

      expect(
        find.text('Biometrics are unavailable. You can skip for now.'),
        findsOneWidget,
      );
      expect(auth.phase, AuthPhase.offeringBiometricSetup);
      expect(auth.biometricEnabledForCurrentUser, isFalse);
      expect(find.byType(AlertDialog), findsNothing);
      await tester.tap(find.text('Skip for now'));
      await settle(tester);
      expect(auth.phase, AuthPhase.authenticated);
    },
  );

  testWidgets('a successful Enable never shows the unavailable dialog', (
    tester,
  ) async {
    final fakeAuth = FakeBiometricAuthenticator(); // default outcome: success
    final auth = await loggedInAuth(fakeAuth);

    await tester.pumpWidget(wrap(auth));
    await settle(tester);

    await tester.tap(find.text('Enable Passkey'));
    await settle(tester);

    expect(find.text('Fingerprint not available'), findsNothing);
    expect(auth.phase, AuthPhase.authenticated);
    expect(auth.biometricEnabledForCurrentUser, isTrue);
  });
}
