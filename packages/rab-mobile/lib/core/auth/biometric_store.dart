import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Secure-storage-backed record of biometric login preference. Deliberately
/// separate from `ApiClient` (which owns transport/tokens) — this is
/// session-preference state, not credential material itself.
///
/// `enabledUserId` stores the *user id*, not a bare boolean
/// (`biometricEnabledForUser = USER_ID`, not `biometricEnabled = true`) —
/// required because more than one Staff member can use the same physical
/// device over time. `ApiClient` only ever holds one account's tokens at a
/// time (switching accounts always goes through `AuthProvider.logout()`
/// first, which clears this key), so at any instant at most one user's
/// enablement is ever "live" — no cross-account leakage risk.
class BiometricStore {
  BiometricStore({FlutterSecureStorage? storage}) : _storage = storage ?? const FlutterSecureStorage();

  static const _enabledUserIdKey = 'rab.biometric.enabledUserId';
  static const _lastFullAuthenticationAtKey = 'rab.biometric.lastFullAuthenticationAt';

  final FlutterSecureStorage _storage;

  Future<String?> getEnabledUserId() => _storage.read(key: _enabledUserIdKey);

  Future<void> setEnabledUserId(String userId) => _storage.write(key: _enabledUserIdKey, value: userId);

  Future<void> clearEnabledUserId() => _storage.delete(key: _enabledUserIdKey);

  Future<DateTime?> getLastFullAuthenticationAt() async {
    final raw = await _storage.read(key: _lastFullAuthenticationAtKey);
    if (raw == null) return null;
    return DateTime.tryParse(raw);
  }

  Future<void> setLastFullAuthenticationAt(DateTime when) =>
      _storage.write(key: _lastFullAuthenticationAtKey, value: when.toUtc().toIso8601String());
}
