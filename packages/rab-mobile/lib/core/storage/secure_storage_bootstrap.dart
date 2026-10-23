import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:path_provider/path_provider.dart';

import 'secure_storage.dart';

/// A per-install marker kept OUTSIDE the Keychain/secure storage, in storage
/// the OS deletes on uninstall. Its absence is what identifies the first launch
/// of an install.
abstract class InstallMarker {
  Future<bool> exists();
  Future<void> create();
}

/// File in the app's Application Support directory (`path_provider`, already a
/// dependency — no `shared_preferences` added for one flag). iOS and Android
/// both delete it with the app container on uninstall, which is exactly the
/// property the native app's `UserDefaults` marker relies on. It holds no data.
class FileInstallMarker implements InstallMarker {
  FileInstallMarker({Future<Directory> Function()? directory})
    : _directory = directory ?? getApplicationSupportDirectory;

  static const fileName = 'crewflow.installMarker.v1';
  final Future<Directory> Function() _directory;

  Future<File> _file() async => File('${(await _directory()).path}/$fileName');

  @override
  Future<bool> exists() async => (await _file()).exists();

  @override
  Future<void> create() async {
    final file = await _file();
    await file.parent.create(recursive: true);
    await file.writeAsString('1', flush: true);
  }
}

enum SecureStorageBootstrapOutcome {
  /// Marker present: an ordinary restart or app update. Nothing wiped.
  normalLaunch,

  /// Marker absent and no F2 sentinel: a brand-new install, or the first run
  /// of this build over a pre-F2 build. Nothing wiped; pre-F2 iOS items are
  /// re-written with the device-only accessibility.
  firstLaunch,

  /// Marker absent but the F2 sentinel survived: the secure storage outlived
  /// the app container (iOS reinstall). Everything was wiped.
  reinstallWiped,
}

/// F2 — runs once per process, in `main()`, BEFORE anything reads a token.
///
/// Mirrors `FreshInstallGuard` in the native iPhone app: the Keychain survives
/// an uninstall, the app container does not, so a Keychain item with no
/// matching container marker belongs to a previous install and must never
/// resume a session silently.
///
/// Telling a reinstall apart from the first launch of this build over a pre-F2
/// build (where the marker also does not exist yet) uses [sentinelKey]: a
/// secure-storage item that only F2+ builds write, always together with the
/// marker. Marker absent + sentinel present can therefore only mean the
/// container was deleted while the Keychain was kept: wipe. Marker absent +
/// sentinel absent is an upgrade (or an empty fresh install): keep the session.
class SecureStorageBootstrap {
  SecureStorageBootstrap({
    FlutterSecureStorage? storage,
    FlutterSecureStorage? legacyStorage,
    InstallMarker? marker,
    bool? migrateLegacyKeychainItems,
  }) : _storage = storage ?? appSecureStorage,
       _legacy = legacyStorage ?? legacyDefaultSecureStorage,
       _marker = marker ?? FileInstallMarker(),
       _migrateLegacy = migrateLegacyKeychainItems ??
           (!kIsWeb && defaultTargetPlatform == TargetPlatform.iOS);

  static const sentinelKey = 'rab.storage.installSentinel.v1';

  final FlutterSecureStorage _storage;
  final FlutterSecureStorage _legacy;
  final InstallMarker _marker;

  /// Only iOS changed accessibility (Android options are byte-identical to the
  /// pre-F2 defaults), so only iOS has items to re-write.
  final bool _migrateLegacy;

  Future<SecureStorageBootstrapOutcome> run() async {
    bool markerPresent;
    try {
      markerPresent = await _marker.exists();
    } catch (error) {
      // Fail closed: an unreadable marker is treated as absent, so a surviving
      // sentinel still triggers the wipe.
      debugPrint('Install marker unreadable, treating as first launch: $error');
      markerPresent = false;
    }

    var outcome = SecureStorageBootstrapOutcome.normalLaunch;
    // A secure-storage error propagates from here BEFORE the marker is
    // written, so the decision is retried on the next launch.
    var sentinel = await _storage.read(key: sentinelKey);
    if (!markerPresent) {
      if (sentinel != null) {
        // Tokens, session owner, biometric enrolment and remembered account,
        // push device id and the onboarding flag: everything, exactly like the
        // native guard's `removeAll()`. The plugin's deleteAll ignores
        // accessibility, so pre-F2 items go too.
        await _storage.deleteAll();
        sentinel = null;
        outcome = SecureStorageBootstrapOutcome.reinstallWiped;
      } else {
        outcome = SecureStorageBootstrapOutcome.firstLaunch;
      }
    }

    if (sentinel == null && _migrateLegacy) {
      await _migrateLegacyItems();
    }
    // Marker before sentinel: a crash between the two leaves "marker present,
    // sentinel absent", which re-runs the idempotent migration and writes the
    // sentinel next launch. The opposite order would leave "sentinel present,
    // marker absent" and wipe a legitimate session.
    if (!markerPresent) {
      await _marker.create();
    }
    if (sentinel == null) {
      await _storage.write(key: sentinelKey, value: '1');
    }
    return outcome;
  }

  /// Pre-F2 iOS items carry `kSecAttrAccessibleWhenUnlocked`. A read through
  /// the new options cannot see them and a write would collide with them
  /// (errSecDuplicateItem), so each is read through the legacy options,
  /// deleted (the plugin's delete matches every accessibility) and written
  /// back with the device-only accessibility. Same keys, same values: a signed
  /// in user stays signed in. A crash between one item's delete and write
  /// loses only that item — at worst one re-login (fails closed).
  Future<void> _migrateLegacyItems() async {
    final legacyItems = await _legacy.readAll();
    for (final entry in legacyItems.entries) {
      if (entry.key == sentinelKey) continue;
      await _storage.delete(key: entry.key);
      await _storage.write(key: entry.key, value: entry.value);
    }
  }
}
