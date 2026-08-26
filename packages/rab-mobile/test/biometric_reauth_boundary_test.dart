import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:rab_staff/core/api/api_client.dart';
import 'package:rab_staff/core/auth/auth_provider.dart';
import 'package:rab_staff/core/auth/biometric_config.dart';

import 'support/biometric_test_support.dart';

/// Increment 3 — the 30-day periodic full-reauthentication boundary, using
/// an injectable clock rather than real waiting (per the spec's own
/// requirement). Also proves the periodic password login does NOT require
/// re-enrolling biometrics: enablement survives the reauth cycle, only the
/// timestamp resets.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late Map<String, String> secureStore;

  setUp(() => secureStore = {});
  tearDown(clearSecureStorageChannel);

  MockClient buildClient() => MockClient((request) async {
        if (request.url.path.endsWith('/auth/login')) {
          return http.Response(jsonEncode({'accessToken': 'access-1', 'refreshToken': 'refresh-1'}), 200);
        }
        if (request.url.path.endsWith('/auth/me')) {
          return http.Response(jsonEncode(fakeUserJson()), 200);
        }
        return http.Response('not found', 404);
      });

  test('29 days since last full auth -> still biometric-eligible', () async {
    final now = DateTime.now().toUtc();
    secureStore['rab.accessToken'] = 'access';
    secureStore['rab.refreshToken'] = 'refresh';
    secureStore['rab.biometric.enabledUserId'] = 'user-1';
    secureStore['rab.biometric.lastFullAuthenticationAt'] = now.subtract(const Duration(days: 29)).toIso8601String();
    stubSecureStorageChannel(secureStore);

    final auth = AuthProvider(
      apiClient: ApiClient(httpClient: buildClient()),
      biometricAuthenticator: FakeBiometricAuthenticator(),
      now: () => now,
    );
    await waitUntilPhaseNot(auth, AuthPhase.loading);

    expect(auth.phase, AuthPhase.biometricLocked);
  });

  test('$biometricFullReauthDays days since last full auth -> forces password, no biometric offer', () async {
    final now = DateTime.now().toUtc();
    secureStore['rab.accessToken'] = 'access';
    secureStore['rab.refreshToken'] = 'refresh';
    secureStore['rab.biometric.enabledUserId'] = 'user-1';
    secureStore['rab.biometric.lastFullAuthenticationAt'] =
        now.subtract(const Duration(days: biometricFullReauthDays)).toIso8601String();
    stubSecureStorageChannel(secureStore);

    final auth = AuthProvider(
      apiClient: ApiClient(httpClient: buildClient()),
      biometricAuthenticator: FakeBiometricAuthenticator(),
      now: () => now,
    );
    await waitUntilPhaseNot(auth, AuthPhase.loading);

    expect(auth.phase, AuthPhase.reauthRequired);
  });

  test('password login at the reauth boundary resets the timestamp without touching enrollment', () async {
    final now = DateTime.now().toUtc();
    secureStore['rab.accessToken'] = 'access';
    secureStore['rab.refreshToken'] = 'refresh';
    secureStore['rab.biometric.enabledUserId'] = 'user-1';
    secureStore['rab.biometric.lastFullAuthenticationAt'] =
        now.subtract(const Duration(days: biometricFullReauthDays + 1)).toIso8601String();
    stubSecureStorageChannel(secureStore);

    final auth = AuthProvider(
      apiClient: ApiClient(httpClient: buildClient()),
      biometricAuthenticator: FakeBiometricAuthenticator(),
      now: () => now,
    );
    await waitUntilPhaseNot(auth, AuthPhase.loading);
    expect(auth.phase, AuthPhase.reauthRequired);

    // The reasonBanner-carrying LoginScreen's own real password login.
    await auth.login('alice@example.test', 'password123');

    expect(auth.phase, AuthPhase.authenticated);
    expect(secureStore['rab.biometric.enabledUserId'], 'user-1'); // untouched — no re-enrollment needed
    final resetTimestamp = DateTime.parse(secureStore['rab.biometric.lastFullAuthenticationAt']!);
    expect(resetTimestamp.difference(now).inSeconds.abs(), lessThan(2));

    // Simulate a fresh app restart right after: a brand new AuthProvider
    // reading the now-current timestamp should land straight back on the
    // biometric lock screen, not a fresh setup offer.
    final restarted = AuthProvider(
      apiClient: ApiClient(httpClient: buildClient()),
      biometricAuthenticator: FakeBiometricAuthenticator(),
      now: () => now,
    );
    await waitUntilPhaseNot(restarted, AuthPhase.loading);
    expect(restarted.phase, AuthPhase.biometricLocked);
  });
}
