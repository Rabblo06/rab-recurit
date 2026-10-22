import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:rab_staff/core/api/api_client.dart';
import 'package:rab_staff/core/auth/auth_provider.dart';
import 'package:rab_staff/core/auth/biometric_store.dart';
import 'package:rab_staff/core/onboarding/onboarding_store.dart';
import 'package:rab_staff/core/push/push_device_store.dart';
import 'package:rab_staff/core/storage/secure_storage.dart';
import 'package:rab_staff/core/storage/secure_storage_bootstrap.dart';

import 'support/biometric_test_support.dart';
import 'support/fake_keychain.dart';

/// F2 — device-only secure storage, one shared configuration, and the
/// fresh-install (reinstall) wipe that mirrors the native app's
/// `FreshInstallGuard`.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late FakeKeychain keychain;

  setUp(() {
    debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
    keychain = FakeKeychain();
  });

  tearDown(() {
    debugDefaultTargetPlatformOverride = null;
    FakeKeychain.detach();
  });

  /// Everything a signed-in, biometric-enrolled, onboarded F2+ install holds.
  const sessionKeys = {
    'rab.accessToken': 'access-old',
    'rab.refreshToken': 'refresh-old',
    'rab.sessionUserId': 'user-1',
    'rab.biometric.enabledUserId': 'user-1',
    'rab.biometric.confirmedAt': '2026-10-01T09:00:00.000Z',
    'rab.biometric.lastFullAuthenticationAt': '2026-10-01T09:00:00.000Z',
    'rab.biometric.rememberedAccount':
        '{"userId":"user-1","email":"alice@example.test"}',
    'rab.push.deviceId': '0123456789abcdef0123456789abcdef',
    'rab.onboarding.hasSeenWelcome': 'true',
  };

  void seedSignedInInstall({String accessibility = 'first_unlock_this_device'}) {
    sessionKeys.forEach(
      (k, v) => keychain.seed(k, v, accessibility: accessibility),
    );
  }

  group('central configuration', () {
    test('iOS: AfterFirstUnlockThisDeviceOnly, never iCloud-synced, no access group', () {
      final ios = appSecureStorage.iOptions;
      expect(ios.accessibility, KeychainAccessibility.first_unlock_this_device);
      expect(ios.synchronizable, isFalse);
      expect(ios.groupId, isNull);
      expect(ios.accessControlFlags, isEmpty);
      expect(ios.toMap()['accessibility'], 'first_unlock_this_device');
      expect(ios.toMap()['synchronizable'], 'false');
    });

    test('Android: v11 hardened cipher spelled out, identical to the pre-F2 defaults (no data migration)', () {
      final android = appSecureStorage.aOptions.toMap();
      expect(android['keyCipherAlgorithm'], 'RSA_ECB_OAEPwithSHA_256andMGF1Padding');
      expect(android['storageCipherAlgorithm'], 'AES_GCM_NoPadding');
      expect(android['resetOnError'], 'true');
      expect(android, AndroidOptions.defaultOptions.toMap());
    });

    test('legacy instance reads only with the pre-F2 iOS default (WhenUnlocked)', () {
      expect(legacyDefaultSecureStorage.iOptions.toMap()['accessibility'], 'unlocked');
      expect(
        legacyDefaultSecureStorage.aOptions.toMap(),
        appSecureStorage.aOptions.toMap(),
      );
    });

    test('no file under lib/ constructs its own FlutterSecureStorage', () {
      const allowed = 'lib/core/storage/secure_storage.dart';
      final constructor = RegExp(r'FlutterSecureStorage\s*\(');
      final offenders = <String>[];
      for (final entity in Directory('lib').listSync(recursive: true)) {
        if (entity is! File || !entity.path.endsWith('.dart')) continue;
        final path = entity.path.replaceAll(r'\', '/');
        if (path == allowed) continue;
        if (constructor.hasMatch(entity.readAsStringSync())) offenders.add(path);
      }
      expect(offenders, isEmpty);
      expect(constructor.allMatches(File(allowed).readAsStringSync()).length, 2,
          reason: 'exactly appSecureStorage + legacyDefaultSecureStorage');
    });

    test('every store writes through the device-only options by default', () async {
      final api = ApiClient(httpClient: MockClient((_) async => http.Response('', 404)));
      await api.storeTokens('a', 'r');
      await api.setSessionUserId('user-1');
      final biometric = BiometricStore();
      await biometric.setRememberedAccount('user-1', 'alice@example.test');
      await biometric.confirmBiometric('user-1', DateTime.utc(2026, 10, 1));
      await biometric.setLastFullAuthenticationAt(DateTime.utc(2026, 10, 1));
      await PushDeviceStore().getOrCreateDeviceId();
      await OnboardingStore().setHasSeenWelcome();

      final writes = keychain.calls.where((c) => c.method == 'write').toList();
      expect(writes.map((c) => (c.arguments as Map)['key']).toSet(), {
        'rab.accessToken',
        'rab.refreshToken',
        'rab.sessionUserId',
        'rab.biometric.rememberedAccount',
        'rab.biometric.confirmedAt',
        'rab.biometric.enabledUserId',
        'rab.biometric.lastFullAuthenticationAt',
        'rab.push.deviceId',
        'rab.onboarding.hasSeenWelcome',
      });
      for (final options in keychain.optionsOf('write')) {
        expect(options['accessibility'], 'first_unlock_this_device');
        expect(options['synchronizable'], 'false');
      }
      for (final options in keychain.optionsOf('read')) {
        expect(options['accessibility'], 'first_unlock_this_device');
      }
    });
  });

  group('SecureStorageBootstrap (reinstall guard)', () {
    test('marker absent + F2 sentinel present (reinstall): wipes tokens, session, biometrics, device id, onboarding', () async {
      seedSignedInInstall();
      keychain.seed(SecureStorageBootstrap.sentinelKey, '1');
      final marker = FakeInstallMarker();

      final outcome = await SecureStorageBootstrap(marker: marker).run();

      expect(outcome, SecureStorageBootstrapOutcome.reinstallWiped);
      expect(keychain.items.keys, [SecureStorageBootstrap.sentinelKey]);
      expect(marker.present, isTrue);
    });

    test('marker absent also wipes items a pre-F2 build left in the Keychain after an F2 install', () async {
      keychain.seed(SecureStorageBootstrap.sentinelKey, '1');
      keychain.seed('rab.refreshToken', 'stale', accessibility: 'unlocked');

      await SecureStorageBootstrap(marker: FakeInstallMarker()).run();

      expect(keychain.items.containsKey('rab.refreshToken'), isFalse);
    });

    test('marker present (ordinary restart or app update): nothing wiped, nothing written', () async {
      seedSignedInInstall();
      keychain.seed(SecureStorageBootstrap.sentinelKey, '1');
      final marker = FakeInstallMarker(present: true);

      final outcome = await SecureStorageBootstrap(marker: marker).run();

      expect(outcome, SecureStorageBootstrapOutcome.normalLaunch);
      expect(keychain.valuesWith('first_unlock_this_device'), {
        ...sessionKeys,
        SecureStorageBootstrap.sentinelKey: '1',
      });
      expect(keychain.calls.map((c) => c.method), ['read']);
      expect(marker.creates, 0);
    });

    test('brand-new install: marker and sentinel created; a second launch is a normal launch', () async {
      final marker = FakeInstallMarker();

      expect(await SecureStorageBootstrap(marker: marker).run(),
          SecureStorageBootstrapOutcome.firstLaunch);
      expect(marker.present, isTrue);
      expect(keychain.valuesWith('first_unlock_this_device'),
          {SecureStorageBootstrap.sentinelKey: '1'});

      await ApiClient(httpClient: MockClient((_) async => http.Response('', 404)))
          .storeTokens('a', 'r');
      expect(await SecureStorageBootstrap(marker: marker).run(),
          SecureStorageBootstrapOutcome.normalLaunch);
      expect(keychain.items.containsKey('rab.refreshToken'), isTrue);
    });

    test('first launch of this build over a pre-F2 iOS build: session kept, items re-written device-only', () async {
      seedSignedInInstall(accessibility: 'unlocked');
      final marker = FakeInstallMarker();

      // Without the migration the new options can neither see nor overwrite
      // the old items (the plugin keeps kSecAttrAccessible in its queries).
      final api = ApiClient(httpClient: MockClient((_) async => http.Response('', 404)));
      expect(await api.getRefreshToken(), isNull);
      await expectLater(api.storeTokens('a', 'r'), throwsA(isA<PlatformException>()));

      final outcome = await SecureStorageBootstrap(marker: marker).run();

      expect(outcome, SecureStorageBootstrapOutcome.firstLaunch);
      expect(keychain.valuesWith('unlocked'), isEmpty);
      expect(keychain.valuesWith('first_unlock_this_device'), {
        ...sessionKeys,
        SecureStorageBootstrap.sentinelKey: '1',
      });
      expect(await api.getRefreshToken(), 'refresh-old');
      await api.storeTokens('access-new', 'refresh-new');
      expect(await api.getRefreshToken(), 'refresh-new');
      expect(marker.present, isTrue);
    });

    test('crash after the marker but before the sentinel: next launch finishes the migration, no wipe', () async {
      keychain.seed('rab.refreshToken', 'refresh-old', accessibility: 'unlocked');

      final outcome = await SecureStorageBootstrap(
        marker: FakeInstallMarker(present: true),
      ).run();

      expect(outcome, SecureStorageBootstrapOutcome.normalLaunch);
      expect(keychain.valuesWith('first_unlock_this_device'), {
        'rab.refreshToken': 'refresh-old',
        SecureStorageBootstrap.sentinelKey: '1',
      });
    });

    test('Android upgrade (options unchanged, storage dies with the app): no migration, no wipe', () async {
      debugDefaultTargetPlatformOverride = TargetPlatform.android;
      seedSignedInInstall(accessibility: 'unlocked'); // Android options carry no accessibility

      final outcome = await SecureStorageBootstrap(marker: FakeInstallMarker()).run();

      expect(outcome, SecureStorageBootstrapOutcome.firstLaunch);
      expect(keychain.calls.map((c) => c.method), isNot(contains('readAll')));
      expect(keychain.calls.map((c) => c.method), isNot(contains('deleteAll')));
      expect(keychain.items.keys, containsAll(sessionKeys.keys));
    });

    test('unreadable marker fails closed: a surviving sentinel still wipes', () async {
      seedSignedInInstall();
      keychain.seed(SecureStorageBootstrap.sentinelKey, '1');
      final marker = FakeInstallMarker(present: true)
        ..existsError = const FileSystemException('denied');

      final outcome = await SecureStorageBootstrap(marker: marker).run();

      expect(outcome, SecureStorageBootstrapOutcome.reinstallWiped);
      expect(keychain.items.containsKey('rab.refreshToken'), isFalse);
    });

    test('secure storage unavailable: throws without writing the marker, so the check reruns', () async {
      keychain.failWith = PlatformException(code: '-25308', message: 'errSecInteractionNotAllowed');
      final marker = FakeInstallMarker();

      await expectLater(SecureStorageBootstrap(marker: marker).run(),
          throwsA(isA<PlatformException>()));
      expect(marker.present, isFalse);
    });

    test('after a reinstall wipe the app opens signed out on Welcome, with no network call', () async {
      seedSignedInInstall();
      keychain.seed(SecureStorageBootstrap.sentinelKey, '1');
      await SecureStorageBootstrap(marker: FakeInstallMarker()).run();

      final requests = <String>[];
      final auth = AuthProvider(
        apiClient: ApiClient(httpClient: MockClient((request) async {
          requests.add(request.url.path);
          return http.Response('', 500);
        })),
        biometricAuthenticator: FakeBiometricAuthenticator(),
      );
      await waitUntilPhaseNot(auth, AuthPhase.loading);

      expect(auth.phase, AuthPhase.unauthenticated);
      expect(auth.hasSeenWelcome, isFalse);
      expect(auth.rememberedEmail, isNull);
      expect(auth.biometricEnabledForCurrentUser, isFalse);
      expect(requests, isEmpty);
    });

    test('without the wipe the same keychain would have resumed the old session (control)', () async {
      seedSignedInInstall();
      keychain.seed(SecureStorageBootstrap.sentinelKey, '1');
      await SecureStorageBootstrap(marker: FakeInstallMarker(present: true)).run();

      final auth = AuthProvider(
        apiClient: ApiClient(httpClient: MockClient((_) async => http.Response('', 500))),
        biometricAuthenticator: FakeBiometricAuthenticator(),
      );
      await waitUntilPhaseNot(auth, AuthPhase.loading);

      expect(auth.phase, isNot(AuthPhase.unauthenticated));
    });
  });

  group('FileInstallMarker', () {
    test('absent until created; survives a new instance (app restart)', () async {
      final dir = await Directory.systemTemp.createTemp('rab_marker_');
      addTearDown(() => dir.delete(recursive: true));
      final marker = FileInstallMarker(directory: () async => Directory('${dir.path}/support'));

      expect(await marker.exists(), isFalse);
      await marker.create();
      expect(await marker.exists(), isTrue);
      expect(await FileInstallMarker(directory: () async => Directory('${dir.path}/support')).exists(), isTrue);
      expect(File('${dir.path}/support/${FileInstallMarker.fileName}').readAsStringSync(), '1');
    });
  });

  group('logout', () {
    test('clears tokens, session owner and the legacy preference (any accessibility); keeps device-level items', () async {
      final auth = AuthProvider(
        apiClient: ApiClient(httpClient: MockClient((request) async {
          final path = request.url.path;
          if (path.endsWith('/auth/login')) {
            return http.Response(jsonEncode({'accessToken': 'a1', 'refreshToken': 'r1'}), 200);
          }
          if (path.endsWith('/auth/me')) return http.Response(jsonEncode(fakeUserJson()), 200);
          if (path.endsWith('/auth/logout')) return http.Response('', 200);
          return http.Response('not found', 404);
        })),
        biometricAuthenticator: FakeBiometricAuthenticator(),
      );
      await waitUntilPhaseNot(auth, AuthPhase.loading);
      await auth.login('alice@example.test', 'password123');
      await auth.completeBiometricSetup(enable: true);
      await PushDeviceStore().getOrCreateDeviceId();
      keychain.seed('rab.applicationTarget', 'STAFF', accessibility: 'unlocked');
      expect(keychain.items.keys, containsAll(['rab.accessToken', 'rab.refreshToken', 'rab.sessionUserId']));

      await auth.logout();

      for (final key in ['rab.accessToken', 'rab.refreshToken', 'rab.sessionUserId', 'rab.applicationTarget']) {
        expect(keychain.items.containsKey(key), isFalse, reason: key);
      }
      // Unchanged pre-F2 logout behaviour: remembered account, biometric
      // binding and the device id are install-level, not session-level.
      expect(keychain.items.containsKey('rab.biometric.enabledUserId'), isTrue);
      expect(keychain.items.containsKey('rab.biometric.rememberedAccount'), isTrue);
      expect(keychain.items.containsKey('rab.push.deviceId'), isTrue);
    });
  });
}
