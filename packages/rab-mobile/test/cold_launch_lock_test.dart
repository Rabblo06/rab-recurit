import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:rab_staff/app.dart';
import 'package:rab_staff/features/login/login_sheet_content.dart';
import 'package:rab_staff/navigation/app_shell.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:rab_staff/core/api/api_client.dart';
import 'package:rab_staff/core/auth/auth_provider.dart';
import 'support/biometric_test_support.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  tearDown(clearSecureStorageChannel);
  for (final route in [
    '/shift/123',
    '/notifications',
    '/calendar',
    '/reports',
  ]) {
    testWidgets('cold entry $route cannot reveal authenticated content', (
      t,
    ) async {
      stubSecureStorageChannel({
        'rab.refreshToken': 'refresh',
        'rab.accessToken': 'access',
        'rab.biometric.rememberedAccount':
            '{"userId":"user-1","email":"alice@example.test"}',
      });
      final auth = AuthProvider(
        apiClient: ApiClient(
          httpClient: MockClient(
            (_) async => http.Response(jsonEncode(fakeUserJson()), 200),
          ),
        ),
        biometricAuthenticator: FakeBiometricAuthenticator(),
      );
      addTearDown(auth.dispose);
      await t.pumpWidget(
        ChangeNotifierProvider.value(value: auth, child: const RabApp()),
      );
      expect(find.byType(AppShell), findsNothing);
      await t.pumpAndSettle();
      expect(auth.phase, AuthPhase.reauthRequired);
      expect(find.byType(LoginSheetContent), findsOneWidget);
      final context = t.element(find.byType(LoginSheetContent));
      Navigator.of(context).pushNamed(route);
      await t.pumpAndSettle();
      expect(find.byType(AppShell), findsNothing);
      expect(find.byType(LoginSheetContent), findsOneWidget);
      expect(auth.canAccessAuthenticatedUi, false);
    });
  }
  test(
    'skip unlocks only process A; process B needs real password, retries safely',
    () async {
      final store = <String, String>{};
      stubSecureStorageChannel(store);
      var reject = false;
      var offline = false;
      var logoutCalls = 0;
      final now = DateTime.utc(2026, 9, 30);
      ApiClient client() => ApiClient(
        httpClient: MockClient((request) async {
          if (request.url.path.endsWith('/auth/login')) {
            if (offline) throw http.ClientException('offline');
            if (reject) {
              return http.Response('{"message":"Invalid credentials"}', 401);
            }
            return http.Response(
              '{"accessToken":"access","refreshToken":"refresh"}',
              200,
            );
          }
          if (request.url.path.endsWith('/auth/me')) {
            return http.Response(jsonEncode(fakeUserJson()), 200);
          }
          if (request.url.path.endsWith('/auth/logout')) logoutCalls++;
          return http.Response('{}', 200);
        }),
      );
      final a = AuthProvider(
        apiClient: client(),
        biometricAuthenticator: FakeBiometricAuthenticator(),
        now: () => now,
      );
      expect(a.unlockState, AppUnlockState.locked);
      await a.initialized;
      await a.login('alice@example.test', 'test-password');
      expect(a.phase, AuthPhase.offeringBiometricSetup);
      await a.completeBiometricSetup(enable: false);
      expect(a.canAccessAuthenticatedUi, true);
      final anchor = store['rab.biometric.lastFullAuthenticationAt'];
      a.dispose(); // No detached callback: a new instance is a fresh process.
      final b = AuthProvider(
        apiClient: client(),
        biometricAuthenticator: FakeBiometricAuthenticator(),
        now: () => now.add(const Duration(days: 1)),
      );
      addTearDown(b.dispose);
      expect(b.unlockState, AppUnlockState.locked);
      await b.initialized;
      expect(b.phase, AuthPhase.reauthRequired);
      expect(b.canAccessAuthenticatedUi, false);
      expect(logoutCalls, 0);
      expect(store['rab.refreshToken'], 'refresh');
      reject = true;
      await expectLater(
        b.login('alice@example.test', 'wrong'),
        throwsA(isA<ApiException>()),
      );
      expect(b.canAccessAuthenticatedUi, false);
      reject = false;
      offline = true;
      await expectLater(
        b.login('alice@example.test', 'test-password'),
        throwsA(anything),
      );
      expect(b.canAccessAuthenticatedUi, false);
      expect(store['rab.biometric.lastFullAuthenticationAt'], anchor);
      expect(b.rememberedEmail, 'alice@example.test');
      offline = false;
      await b.login('alice@example.test', 'test-password');
      await b.completeBiometricSetup(enable: false);
      expect(b.canAccessAuthenticatedUi, true);
      expect(store['rab.biometric.lastFullAuthenticationAt'], isNot(anchor));
      await b.logout();
      expect(b.unlockState, AppUnlockState.locked);
      expect(b.canAccessAuthenticatedUi, false);
      expect(logoutCalls, 1);
    },
  );
}
