import 'dart:math';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../storage/secure_storage.dart';

/// The opaque, client-generated, non-secret device identifier push
/// registration keys on (`core.push_device.device_id`, `UNIQUE (user_id,
/// device_id)` server-side). Persisted once per install (survives
/// login/logout, like `BiometricStore`'s remembered account) so a device
/// re-registering after a token refresh or a fresh login upserts the SAME row
/// rather than creating a new one every time. A reinstall gets a new id (F2:
/// the `SecureStorageBootstrap` reinstall wipe removes it on iOS too, matching
/// Android and the native app's `FreshInstallGuard`).
///
/// Phase C1b: the id MUST be a UUID — the server's
/// `/push/devices/:deviceId/deactivate` and `/auth/logout`'s `pushDeviceId`
/// only accept UUIDs, so the old 32-hex id could never be deactivated. A
/// stored non-UUID id is simply replaced: no Flutter build ever registered a
/// device (the push provider was never instantiated before C1b), so there is
/// no server row to migrate.
class PushDeviceStore {
  PushDeviceStore({FlutterSecureStorage? storage})
    : _storage = storage ?? appSecureStorage;

  static const _deviceIdKey = 'rab.push.deviceId';
  final FlutterSecureStorage _storage;

  static final _uuid = RegExp(
    r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
    caseSensitive: false,
  );

  static bool isUuid(String value) => _uuid.hasMatch(value);

  Future<String> getOrCreateDeviceId() async {
    final existing = await _storage.read(key: _deviceIdKey);
    if (existing != null && isUuid(existing)) return existing;
    final generated = generateUuidV4();
    await _storage.write(key: _deviceIdKey, value: generated);
    return generated;
  }

  /// RFC 4122 version 4: 122 random bits from a CSPRNG. Non-secret (a stable
  /// row key, never used for anything cryptographic).
  static String generateUuidV4([Random? random]) {
    final r = random ?? Random.secure();
    final bytes = List<int>.generate(16, (_) => r.nextInt(256));
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
    final hex = bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
    return '${hex.substring(0, 8)}-${hex.substring(8, 12)}-'
        '${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}';
  }
}
