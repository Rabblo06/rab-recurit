import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:rab_staff/core/api/api_client.dart';
import 'package:rab_staff/core/auth/auth_provider.dart';
import 'package:rab_staff/core/auth/biometric_authenticator.dart';

import 'support/biometric_test_support.dart';

/// Increment 3 — a cancelled/failed/locked-out biometric attempt must never
/// be a dead end: the lock screen stays up (retry available) and "Use
/// password instead" always works.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late Map<String, String> secureStore;

  setUp(() => secureStore = {});
  tearDown(clearSecureStorageChannel);

  void seedEnabledUser() {
    secureStore['rab.biometric.enabledUserId'] = 'user-1';
    secureStore['rab.biometric.lastFullAuthenticationAt'] = DateTime.now().toUtc().toIso8601String();
  }

  MockClient buildClient() => MockClient((request) async {
        if (request.url.path.endsWith('/auth/login')) {
          return http.Response(jsonEncode({'accessToken': 'access-1', 'refreshToken': 'refresh-1'}), 200);
        }
        if (request.url.path.endsWith('/auth/me')) {
          return http.Response(jsonEncode(fakeUserJson()), 200);
        }
        return http.Response('not found', 404);
      });

  for (final outcome in [BiometricOutcome.cancelled, BiometricOutcome.failed, BiometricOutcome.lockedOut]) {
    test('$outcome keeps the lock state, never grants access', () async {
      seedEnabledUser();
      stubSecureStorageChannel(secureStore);

      final auth = AuthProvider(
        apiClient: ApiClient(httpClient: buildClient()),
        biometricAuthenticator: FakeBiometricAuthenticator(outcome: outcome),
      );
      await waitUntilPhaseNot(auth, AuthPhase.loading);
      expect(auth.phase, AuthPhase.biometricLocked);

      final result = await auth.attemptBiometricRestore();

      expect(result, outcome);
      expect(auth.phase, AuthPhase.biometricLocked);
      expect(auth.user, isNull);
    });
  }

  test('"Use password instead" reaches a working plain login, no dead end', () async {
    seedEnabledUser();
    stubSecureStorageChannel(secureStore);

    final auth = AuthProvider(
      apiClient: ApiClient(httpClient: buildClient()),
      biometricAuthenticator: FakeBiometricAuthenticator(outcome: BiometricOutcome.failed),
    );
    await waitUntilPhaseNot(auth, AuthPhase.loading);
    await auth.attemptBiometricRestore();
    expect(auth.phase, AuthPhase.biometricLocked);

    auth.fallBackToPassword();
    expect(auth.phase, AuthPhase.unauthenticated);

    await auth.login('alice@example.test', 'password123');
    expect(auth.phase, AuthPhase.authenticated);
  });
}
