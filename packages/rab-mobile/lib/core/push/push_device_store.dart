import 'dart:math';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../storage/secure_storage.dart';

/// The opaque, client-generated, non-secret device identifier push
/// registration keys on (`core.push_device.device_id`, `UNIQUE (user_id,
/// device_id)` server-side). Nothing in `rab-mobile` generated one before
/// Stage 6 — `core.refresh_token`/`core.user_session` have an optional
/// `deviceId` column, but no controller ever threaded a client-supplied
/// value into it, so this is the first real generator/persister of a device
/// id in this app. Persisted once per install (survives login/logout, like
/// `BiometricStore`'s remembered account) so a device re-registering after a
/// token refresh or a fresh login upserts the SAME row rather than creating
/// a new one every time. A reinstall gets a new id (F2: the
/// `SecureStorageBootstrap` reinstall wipe removes it on iOS too, matching
/// Android and the native app's `FreshInstallGuard`).
class PushDeviceStore {
  PushDeviceStore({FlutterSecureStorage? storage})
    : _storage = storage ?? appSecureStorage;

  static const _deviceIdKey = 'rab.push.deviceId';
  final FlutterSecureStorage _storage;

  Future<String> getOrCreateDeviceId() async {
    final existing = await _storage.read(key: _deviceIdKey);
    if (existing != null && existing.isNotEmpty) return existing;
    final generated = _generateOpaqueId();
    await _storage.write(key: _deviceIdKey, value: generated);
    return generated;
  }

  /// 128 bits from a CSPRNG, hex-encoded — opaque and non-secret (it is
  /// never used for anything cryptographic, only as a stable row key), so a
  /// full UUID library isn't needed for this one generator.
  String _generateOpaqueId() {
    final random = Random.secure();
    final bytes = List<int>.generate(16, (_) => random.nextInt(256));
    return bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
  }
}
