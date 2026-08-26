import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:rab_staff/core/api/api_client.dart';
import 'package:rab_staff/core/auth/auth_provider.dart';

import 'support/biometric_test_support.dart';

/// Increment 3 — logout must clear the biometric binding so old biometric
/// access cannot silently reopen the account: a fresh app open after
/// logout must land on the normal Welcome/Login flow, never the lock
/// screen.
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
        if (path.endsWith('/auth/logout')) {
          return http.Response('', 200);
        }
        return http.Response('not found', 404);
      });

  test('logout clears the biometric binding; a subsequent app open is plain unauthenticated', () async {
    stubSecureStorageChannel(secureStore);
    final auth = AuthProvider(
      apiClient: ApiClient(httpClient: buildClient()),
      biometricAuthenticator: FakeBiometricAuthenticator(),
    );
    await waitUntilPhaseNot(auth, AuthPhase.loading);

    await auth.login('alice@example.test', 'password123');
    expect(auth.phase, AuthPhase.offeringBiometricSetup);
    await auth.completeBiometricSetup(enable: true);
    expect(secureStore.containsKey('rab.biometric.enabledUserId'), isTrue);

    await auth.logout();

    expect(secureStore.containsKey('rab.biometric.enabledUserId'), isFalse);
    expect(secureStore.containsKey('rab.accessToken'), isFalse);

    // Simulate a fresh app restart — must not land on the lock screen.
    final restarted = AuthProvider(
      apiClient: ApiClient(httpClient: buildClient()),
      biometricAuthenticator: FakeBiometricAuthenticator(),
    );
    await waitUntilPhaseNot(restarted, AuthPhase.loading);

    expect(restarted.phase, AuthPhase.unauthenticated);
  });
}
