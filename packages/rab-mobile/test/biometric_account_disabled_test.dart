import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:rab_staff/core/api/api_client.dart';
import 'package:rab_staff/core/auth/auth_provider.dart';
import 'package:rab_staff/core/auth/biometric_authenticator.dart';

import 'support/biometric_test_support.dart';

/// Increment 3 — the central security guarantee: a locally-successful
/// biometric unlock must still go through real backend session validation.
/// If the account is disabled/deleted or the refresh token has been
/// revoked, the backend's `/auth/me` rejection is what actually denies
/// access — local biometric success alone is never sufficient.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late Map<String, String> secureStore;

  setUp(() => secureStore = {});
  tearDown(clearSecureStorageChannel);

  test('local biometric success + backend rejection on /auth/me -> denied, both tokens and enrollment cleared', () async {
    secureStore['rab.accessToken'] = 'stored-access';
    secureStore['rab.refreshToken'] = 'stored-refresh';
    secureStore['rab.biometric.enabledUserId'] = 'user-1';
    secureStore['rab.biometric.lastFullAuthenticationAt'] = DateTime.now().toUtc().toIso8601String();
    stubSecureStorageChannel(secureStore);

    // Account disabled server-side: /auth/me now rejects the stored token,
    // and the refresh-retry (ApiClient's existing 401 handling) also fails
    // since the account itself is the problem, not just an expired token.
    final mockClient = MockClient((request) async {
      if (request.url.path.endsWith('/auth/me')) {
        return http.Response('{"message":"Account disabled"}', 401);
      }
      if (request.url.path.endsWith('/auth/refresh')) {
        return http.Response('{"message":"Invalid refresh token"}', 401);
      }
      return http.Response('not found', 404);
    });

    final auth = AuthProvider(
      apiClient: ApiClient(httpClient: mockClient),
      biometricAuthenticator: FakeBiometricAuthenticator(), // local sensor succeeds
    );
    await waitUntilPhaseNot(auth, AuthPhase.loading);
    expect(auth.phase, AuthPhase.biometricLocked);

    final outcome = await auth.attemptBiometricRestore();

    // The OS-level prompt itself succeeded...
    expect(outcome, BiometricOutcome.success);
    // ...but the backend's answer is what actually decided access:
    expect(auth.phase, AuthPhase.unauthenticated);
    expect(auth.user, isNull);
    expect(secureStore.containsKey('rab.accessToken'), isFalse);
    expect(secureStore.containsKey('rab.biometric.enabledUserId'), isFalse);
  });
}
