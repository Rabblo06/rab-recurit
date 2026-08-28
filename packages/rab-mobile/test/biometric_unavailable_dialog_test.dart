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
import 'package:rab_staff/features/biometric_setup/biometric_setup_prompt.dart';

import 'support/biometric_test_support.dart';

/// The biometric-unavailable dialog (Figma "Prompt · Face ID unavailable" —
/// the dialog itself is fully type-agnostic, see `showBiometricUnavailableDialog`)
/// closes a real gap: previously `completeBiometricSetup(enable: true)`
/// silently swallowed a `BiometricOutcome.notAvailable` result and the user
/// just landed in the app with no explanation. Proves the dialog now shows
/// on that outcome, and only that outcome, with the live-detected label.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late Map<String, String> secureStore;

  setUp(() => secureStore = {});
  tearDown(clearSecureStorageChannel);

  MockClient buildClient() => MockClient((request) async {
        final path = request.url.path;
        if (path.endsWith('/auth/login')) {
          return http.Response(jsonEncode({'accessToken': 'access-1', 'refreshToken': 'refresh-1'}), 200);
        }
        if (path.endsWith('/auth/me')) {
          return http.Response(jsonEncode(fakeUserJson()), 200);
        }
        return http.Response('not found', 404);
      });

  Future<AuthProvider> loggedInAuth(FakeBiometricAuthenticator fakeAuth) async {
    stubSecureStorageChannel(secureStore);
    final auth = AuthProvider(apiClient: ApiClient(httpClient: buildClient()), biometricAuthenticator: fakeAuth);
    await waitUntilPhaseNot(auth, AuthPhase.loading);
    await auth.login('alice@example.test', 'password123');
    expect(auth.phase, AuthPhase.offeringBiometricSetup);
    return auth;
  }

  Widget wrap(AuthProvider auth) => ChangeNotifierProvider.value(
        value: auth,
        child: MaterialApp(theme: buildLightTheme(), home: const BiometricSetupPromptScreen()),
      );

  // The screen's "busy" state (an indeterminate CircularProgressIndicator,
  // shown from the moment "Enable"/"Skip" is tapped) never resets — fine in
  // the real app, where `_RootGate` tears this screen down the instant
  // `AuthPhase` flips to `authenticated`, but fatal to `pumpAndSettle` here,
  // where the screen is pumped standalone and the spinner just keeps
  // animating forever. Bounded pumps instead, same idiom already used in
  // `root_gate_isolation_test.dart` for exactly this class of problem.
  Future<void> settle(WidgetTester tester) async {
    for (var i = 0; i < 30; i++) {
      await tester.pump(const Duration(milliseconds: 16));
    }
  }

  testWidgets('tapping Enable shows the unavailable dialog when the live check fails that way', (tester) async {
    final fakeAuth = FakeBiometricAuthenticator(outcome: BiometricOutcome.notAvailable);
    final auth = await loggedInAuth(fakeAuth);

    await tester.pumpWidget(wrap(auth));
    await settle(tester);

    // FakeBiometricAuthenticator's default single enrolled type (fingerprint)
    // now resolves to its real per-type, per-platform label ("Fingerprint"
    // on this non-iOS test runner) rather than the old generic fallback.
    await tester.tap(find.text('Enable Fingerprint'));
    await settle(tester);

    expect(find.text('Fingerprint not available'), findsOneWidget);
    expect(find.textContaining('You will use your email and password each time'), findsOneWidget);
    expect(auth.phase, AuthPhase.authenticated); // still proceeds into the app, per the design

    await tester.tap(find.text('Confirm'));
    await settle(tester);
    expect(find.text('Fingerprint not available'), findsNothing);
  });

  testWidgets('a successful Enable never shows the unavailable dialog', (tester) async {
    final fakeAuth = FakeBiometricAuthenticator(); // default outcome: success
    final auth = await loggedInAuth(fakeAuth);

    await tester.pumpWidget(wrap(auth));
    await settle(tester);

    await tester.tap(find.text('Enable Fingerprint'));
    await settle(tester);

    expect(find.text('Fingerprint not available'), findsNothing);
    expect(auth.phase, AuthPhase.authenticated);
    expect(auth.biometricEnabledForCurrentUser, isTrue);
  });
}
