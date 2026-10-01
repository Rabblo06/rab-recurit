import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:rab_staff/core/api/api_client.dart';
import 'package:rab_staff/core/auth/auth_provider.dart';
import 'package:rab_staff/core/auth/biometric_authenticator.dart';
import 'package:rab_staff/core/auth/biometric_config.dart';
import 'support/biometric_test_support.dart';

class DeferredBiometric extends FakeBiometricAuthenticator {
  final result = Completer<BiometricOutcome>();
  @override
  Future<BiometricOutcome> authenticate({required String reason}) {
    authenticateCalls++;
    return result.future;
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final confirmed = DateTime.utc(2026, 1, 1);
  late DateTime now;
  late Map<String, String> store;
  late List<String> calls;
  late String userId;
  late int meStatus;
  late int refreshStatus;
  late bool offline;
  late bool expiredAccess;
  late bool mustReset;
  setUp(() {
    now = confirmed.add(const Duration(days: 10));
    calls = [];
    userId = 'user-1';
    meStatus = 200;
    refreshStatus = 200;
    offline = false;
    expiredAccess = false;
    mustReset = false;
    store = {
      'rab.accessToken': 'access',
      'rab.refreshToken': 'refresh',
      'rab.sessionUserId': 'user-1',
      'rab.biometric.enabledUserId': 'user-1',
      'rab.biometric.confirmedAt': confirmed.toIso8601String(),
      // MOB-02: the 90-day deadline is anchored to this, not confirmedAt —
      // a fixture representing a genuinely-valid existing binding needs
      // both set (and consistent), matching what a real device migrating
      // onto the fix would have.
      'rab.biometric.lastFullAuthenticationAt': confirmed.toIso8601String(),
      'rab.biometric.rememberedAccount': jsonEncode({
        'userId': 'user-1',
        'email': 'alice@example.test',
      }),
    };
    stubSecureStorageChannel(store);
  });
  tearDown(clearSecureStorageChannel);
  Future<AuthProvider> create({FakeBiometricAuthenticator? bio}) async {
    final auth = AuthProvider(
      now: () => now,
      biometricAuthenticator: bio ?? FakeBiometricAuthenticator(),
      apiClient: ApiClient(
        httpClient: MockClient((r) async {
          final path = r.url.path.split('/').last;
          calls.add(path);
          if (offline) throw const SocketException('offline');
          if (path == 'login') {
            return http.Response(
              jsonEncode({
                'accessToken': 'new-access',
                'refreshToken': 'new-refresh',
              }),
              200,
            );
          }
          if (path == 'refresh') {
            expiredAccess = false;
            return http.Response(
              jsonEncode({
                'accessToken': 'rotated',
                'refreshToken': 'rotated-refresh',
              }),
              refreshStatus,
            );
          }
          if (path == 'me') {
            return http.Response(
              jsonEncode(
                fakeUserJson(
                  id: userId,
                  email: userId == 'user-1'
                      ? 'alice@example.test'
                      : 'bob@example.test',
                  mustResetPassword: mustReset,
                ),
              ),
              expiredAccess ? 401 : meStatus,
            );
          }
          if (path == 'logout') {
            if (expiredAccess) return http.Response('{}', 401);
            expect(
              jsonDecode(r.body)['refreshToken'],
              store['rab.refreshToken'],
            );
            return http.Response('', 200);
          }
          return http.Response('', 404);
        }),
      ),
    );
    await auth.initialized;
    addTearDown(auth.dispose);
    return auth;
  }

  test(
    'canonical lifetime is 90 days',
    () => expect(biometricFullReauthDays, 90),
  );
  for (final offset in [-1, 0, 1]) {
    test('expiry boundary offset $offset microseconds', () async {
      now = confirmed
          .add(const Duration(days: biometricFullReauthDays))
          .add(Duration(microseconds: offset));
      final auth = await create();
      expect(
        auth.phase,
        offset < 0 ? AuthPhase.biometricLocked : AuthPhase.reauthRequired,
      );
      expect(calls, isEmpty);
    });
  }
  test('routine unlock never slides confirmation deadline', () async {
    now = confirmed.add(const Duration(days: 89));
    final auth = await create();
    expect(await auth.attemptBiometricRestore(), BiometricOutcome.success);
    expect(store['rab.biometric.confirmedAt'], confirmed.toIso8601String());
    now = confirmed.add(const Duration(days: biometricFullReauthDays));
    expect((await create()).phase, AuthPhase.reauthRequired);
  });
  test(
    'expiry while lock screen open blocks native prompt and refresh',
    () async {
      final bio = FakeBiometricAuthenticator();
      final auth = await create(bio: bio);
      now = confirmed.add(const Duration(days: biometricFullReauthDays));
      await auth.attemptBiometricRestore();
      expect(auth.phase, AuthPhase.reauthRequired);
      expect(bio.authenticateCalls, 0);
      expect(calls, isEmpty);
    },
  );
  test('expiry during native prompt cannot unlock', () async {
    final bio = DeferredBiometric();
    final auth = await create(bio: bio);
    final attempt = auth.attemptBiometricRestore();
    while (bio.authenticateCalls == 0) {
      await Future<void>.delayed(Duration.zero);
    }
    now = confirmed.add(const Duration(days: biometricFullReauthDays));
    bio.result.complete(BiometricOutcome.success);
    await attempt;
    expect(auth.phase, AuthPhase.reauthRequired);
    expect(calls, isEmpty);
  });
  test(
    'expired password login requires fresh setup and native confirmation',
    () async {
      now = confirmed.add(const Duration(days: biometricFullReauthDays));
      final auth = await create();
      await auth.login('alice@example.test', 'test-password');
      expect(auth.phase, AuthPhase.offeringBiometricSetup);
      expect(store['rab.biometric.confirmedAt'], isNull);
      await auth.completeBiometricSetup(enable: true);
      expect(auth.phase, AuthPhase.authenticated);
      expect(store['rab.biometric.confirmedAt'], now.toIso8601String());
      expect((await create()).phase, AuthPhase.biometricLocked);
    },
  );
  for (final outcome in [
    null,
    BiometricOutcome.cancelled,
    BiometricOutcome.failed,
    BiometricOutcome.notAvailable,
  ]) {
    test(
      'expired setup skip/failure $outcome leaves biometric inactive',
      () async {
        now = confirmed.add(const Duration(days: biometricFullReauthDays));
        final auth = await create(
          bio: FakeBiometricAuthenticator(
            outcome: outcome ?? BiometricOutcome.success,
          ),
        );
        await auth.login('alice@example.test', 'test-password');
        await auth.completeBiometricSetup(enable: outcome != null);
        expect(
          auth.phase,
          outcome == null
              ? AuthPhase.authenticated
              : AuthPhase.offeringBiometricSetup,
        );
        if (outcome != null) await auth.completeBiometricSetup(enable: false);
        expect(auth.phase, AuthPhase.authenticated);
        expect(auth.biometricEnabledForCurrentUser, isFalse);
        expect(store['rab.biometric.confirmedAt'], isNull);
        expect((await create()).phase, AuthPhase.reauthRequired);
      },
    );
  }
  test(
    'logout revokes session, preserves identity/trust, same user rearms without setup',
    () async {
      final auth = await create();
      await auth.attemptBiometricRestore();
      await auth.logout();
      expect(calls, contains('logout'));
      expect(auth.user, isNull);
      expect(store['rab.accessToken'], isNull);
      expect(store['rab.refreshToken'], isNull);
      expect(store['rab.sessionUserId'], isNull);
      expect(store['rab.biometric.enabledUserId'], 'user-1');
      final restart = await create();
      expect(restart.phase, AuthPhase.unauthenticated);
      expect(restart.rememberedEmail, 'alice@example.test');
      await restart.login('alice@example.test', 'test-password');
      expect(restart.phase, AuthPhase.authenticated);
      expect(restart.biometricEnabledForCurrentUser, isTrue);
      expect(store['rab.biometric.confirmedAt'], confirmed.toIso8601String());
      expect((await create()).phase, AuthPhase.biometricLocked);
    },
  );
  test(
    'different account never inherits preference/email/confirmation',
    () async {
      final auth = await create();
      await auth.logout();
      userId = 'user-2';
      await auth.login('bob@example.test', 'test-password');
      expect(auth.phase, AuthPhase.offeringBiometricSetup);
      expect(auth.rememberedUserId, 'user-2');
      expect(auth.rememberedEmail, 'bob@example.test');
      expect(store['rab.biometric.enabledUserId'], isNull);
      expect(store['rab.biometric.confirmedAt'], isNull);
    },
  );
  test(
    'backend identity mismatch after native success cannot authenticate',
    () async {
      final auth = await create();
      userId = 'user-2';
      await auth.attemptBiometricRestore();
      expect(auth.phase, AuthPhase.unauthenticated);
      expect(auth.user, isNull);
      expect(store['rab.refreshToken'], isNull);
    },
  );
  test('stored owner mismatch cannot show lock screen', () async {
    store['rab.sessionUserId'] = 'user-2';
    expect((await create()).phase, AuthPhase.reauthRequired);
  });
  test('legacy/missing confirmation cannot reuse password timestamp', () async {
    store.remove('rab.biometric.confirmedAt');
    store['rab.biometric.lastFullAuthenticationAt'] = now.toIso8601String();
    expect((await create()).phase, AuthPhase.reauthRequired);
  });
  test('future confirmation fails closed', () async {
    store['rab.biometric.confirmedAt'] = now
        .add(const Duration(days: 1))
        .toIso8601String();
    expect((await create()).phase, AuthPhase.reauthRequired);
  });
  test(
    'missing session prevents biometric prompt despite preference',
    () async {
      store.remove('rab.accessToken');
      store.remove('rab.refreshToken');
      final bio = FakeBiometricAuthenticator();
      final auth = await create(bio: bio);
      expect(auth.phase, AuthPhase.unauthenticated);
      await auth.attemptBiometricRestore();
      expect(bio.authenticateCalls, 0);
    },
  );
  test('expired access refreshes after native verification', () async {
    expiredAccess = true;
    final auth = await create();
    expect(calls, isEmpty);
    await auth.attemptBiometricRestore();
    expect(auth.phase, AuthPhase.authenticated);
    expect(calls, ['me', 'refresh', 'me']);
  });
  test('refresh-only session can restore after native verification', () async {
    store.remove('rab.accessToken');
    expiredAccess = true;
    final auth = await create();
    await auth.attemptBiometricRestore();
    expect(auth.phase, AuthPhase.authenticated);
  });
  for (final status in [401, 403]) {
    test(
      'backend denial $status clears session but preserves preference',
      () async {
        final auth = await create();
        meStatus = status;
        refreshStatus = status;
        await auth.attemptBiometricRestore();
        expect(auth.phase, AuthPhase.unauthenticated);
        expect(store['rab.refreshToken'], isNull);
        expect(store['rab.biometric.enabledUserId'], 'user-1');
      },
    );
  }
  for (final status in [0, 500]) {
    test(
      'transient error $status permits retry without destroying trust',
      () async {
        final auth = await create();
        offline = status == 0;
        meStatus = status == 0 ? 200 : status;
        expect(await auth.attemptBiometricRestore(), BiometricOutcome.error);
        expect(auth.phase, AuthPhase.biometricLocked);
        expect(store['rab.refreshToken'], 'refresh');
        offline = false;
        meStatus = 200;
        await auth.attemptBiometricRestore();
        expect(auth.phase, AuthPhase.authenticated);
      },
    );
  }
  test('refresh service failure retains refresh token for retry', () async {
    final auth = await create();
    expiredAccess = true;
    refreshStatus = 503;
    await auth.attemptBiometricRestore();
    expect(auth.phase, AuthPhase.biometricLocked);
    expect(store['rab.refreshToken'], 'refresh');
  });
  test(
    'hardware removal falls back; password does not rearm unavailable biometrics',
    () async {
      final bio = FakeBiometricAuthenticator();
      final auth = await create(bio: bio);
      bio.capability = BiometricCapability.unavailable;
      await auth.attemptBiometricRestore();
      expect(auth.phase, AuthPhase.unauthenticated);
      await auth.login('alice@example.test', 'test-password');
      expect(auth.phase, AuthPhase.authenticated);
      expect(auth.biometricEnabledForCurrentUser, isFalse);
    },
  );
  test('explicit disable removes preference and confirmation only', () async {
    final auth = await create();
    await auth.attemptBiometricRestore();
    await auth.disableBiometric();
    expect(store['rab.biometric.enabledUserId'], isNull);
    expect(store['rab.biometric.confirmedAt'], isNull);
    expect(auth.rememberedEmail, 'alice@example.test');
    expect((await create()).phase, AuthPhase.reauthRequired);
  });
  test('failed login/me never overwrites remembered account', () async {
    final auth = await create();
    await auth.logout();
    userId = 'user-2';
    meStatus = 403;
    await expectLater(
      auth.login('bob@example.test', 'test-password'),
      throwsA(isA<ApiException>()),
    );
    expect(auth.rememberedEmail, 'alice@example.test');
    expect(store['rab.accessToken'], isNull);
  });
  test('forced reset still precedes biometric setup/app entry', () async {
    final auth = await create();
    await auth.logout();
    mustReset = true;
    await auth.login('alice@example.test', 'test-password');
    expect(auth.phase, AuthPhase.mustResetPassword);
    expect(await auth.completeBiometricSetup(enable: true), isNull);
  });
  test('logout during native prompt cannot resurrect session', () async {
    final bio = DeferredBiometric();
    final auth = await create(bio: bio);
    final pending = auth.attemptBiometricRestore();
    while (bio.authenticateCalls == 0) {
      await Future<void>.delayed(Duration.zero);
    }
    await auth.logout();
    bio.result.complete(BiometricOutcome.success);
    await pending;
    expect(auth.phase, AuthPhase.unauthenticated);
    expect(auth.user, isNull);
    expect(store['rab.refreshToken'], isNull);
  });
  test(
    'logout with expired access revokes the rotated refresh token',
    () async {
      final auth = await create();
      expiredAccess = true;
      await auth.logout();
      expect(calls, ['logout', 'refresh', 'logout']);
      expect(store['rab.refreshToken'], isNull);
      expect(auth.phase, AuthPhase.unauthenticated);
    },
  );
  test(
    'offline logout still removes local session and preserves trust',
    () async {
      final auth = await create();
      offline = true;
      await auth.logout();
      expect(store['rab.refreshToken'], isNull);
      expect(store['rab.biometric.enabledUserId'], 'user-1');
      expect(auth.user, isNull);
    },
  );
}
