import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:rab_staff/core/api/api_client.dart';
import 'package:rab_staff/core/auth/auth_provider.dart';
import 'package:rab_staff/core/auth/biometric_authenticator.dart';

import 'support/biometric_test_support.dart';

/// Increment 3 — a returning user with biometrics already enabled: local
/// biometric success only ever gates whether the app attempts the real
/// `/auth/me` call; that call landing successfully is what actually
/// restores the session.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late Map<String, String> secureStore;

  setUp(() => secureStore = {});
  tearDown(clearSecureStorageChannel);

  test('enabled + fresh timestamp -> lock screen state -> unlock restores the same account', () async {
    secureStore['rab.accessToken'] = 'stored-access';
    secureStore['rab.refreshToken'] = 'stored-refresh';
    secureStore['rab.biometric.enabledUserId'] = 'user-1';
    secureStore['rab.biometric.lastFullAuthenticationAt'] = DateTime.now().toUtc().toIso8601String();
    stubSecureStorageChannel(secureStore);

    final mockClient = MockClient((request) async {
      if (request.url.path.endsWith('/auth/me')) {
        return http.Response(jsonEncode(fakeUserJson()), 200);
      }
      return http.Response('not found', 404);
    });

    final auth = AuthProvider(
      apiClient: ApiClient(httpClient: mockClient),
      biometricAuthenticator: FakeBiometricAuthenticator(),
    );
    await waitUntilPhaseNot(auth, AuthPhase.loading);

    // No /auth/me call should have happened yet — biometric gate first.
    expect(auth.phase, AuthPhase.biometricLocked);
    expect(auth.user, isNull);

    final outcome = await auth.attemptBiometricRestore();

    expect(outcome, BiometricOutcome.success);
    expect(auth.phase, AuthPhase.authenticated);
    expect(auth.user!.id, 'user-1');
  });
}
