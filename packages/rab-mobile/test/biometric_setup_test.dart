import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:rab_staff/core/api/api_client.dart';
import 'package:rab_staff/core/auth/auth_provider.dart';
import 'package:rab_staff/core/auth/biometric_authenticator.dart';

import 'support/biometric_test_support.dart';

/// Increment 3 — the post-first-login setup offer: shown when capability is
/// available+enrolled and not yet enabled for this account; skipped
/// entirely otherwise.
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

  test('capability available + enrolled -> offered after login; enabling persists it', () async {
    stubSecureStorageChannel(secureStore);
    final fakeAuth = FakeBiometricAuthenticator();
    final auth = AuthProvider(
      apiClient: ApiClient(httpClient: buildClient()),
      biometricAuthenticator: fakeAuth,
    );
    await waitUntilPhaseNot(auth, AuthPhase.loading);

    await auth.login('alice@example.test', 'password123');

    expect(auth.phase, AuthPhase.offeringBiometricSetup);
    expect(secureStore.containsKey('rab.biometric.enabledUserId'), isFalse);

    await auth.completeBiometricSetup(enable: true);

    expect(auth.phase, AuthPhase.authenticated);
    expect(auth.biometricEnabledForCurrentUser, isTrue);
    expect(secureStore['rab.biometric.enabledUserId'], 'user-1');
    expect(fakeAuth.authenticateCalls, 1); // one live check to confirm the sensor works
  });

  test('"Not Now" proceeds without persisting anything', () async {
    stubSecureStorageChannel(secureStore);
    final fakeAuth = FakeBiometricAuthenticator();
    final auth = AuthProvider(
      apiClient: ApiClient(httpClient: buildClient()),
      biometricAuthenticator: fakeAuth,
    );
    await waitUntilPhaseNot(auth, AuthPhase.loading);

    await auth.login('alice@example.test', 'password123');
    expect(auth.phase, AuthPhase.offeringBiometricSetup);

    await auth.completeBiometricSetup(enable: false);

    expect(auth.phase, AuthPhase.authenticated);
    expect(auth.biometricEnabledForCurrentUser, isFalse);
    expect(secureStore.containsKey('rab.biometric.enabledUserId'), isFalse);
    expect(fakeAuth.authenticateCalls, 0); // never touches the sensor for a decline
  });

  test('device with no biometric hardware/enrollment: never offered, straight to authenticated', () async {
    stubSecureStorageChannel(secureStore);
    final auth = AuthProvider(
      apiClient: ApiClient(httpClient: buildClient()),
      biometricAuthenticator: FakeBiometricAuthenticator(capability: BiometricCapability.unavailable),
    );
    await waitUntilPhaseNot(auth, AuthPhase.loading);

    await auth.login('alice@example.test', 'password123');

    expect(auth.phase, AuthPhase.authenticated);
  });
}
