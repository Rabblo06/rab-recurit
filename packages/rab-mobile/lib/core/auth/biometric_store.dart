import 'dart:convert';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Remembered identity and account-owned biometric preference, not a session.
/// Tokens and active session ownership remain in ApiClient. No biometric data
/// or password is ever stored here.
class BiometricStore {
  BiometricStore({FlutterSecureStorage? storage})
    : _storage = storage ?? const FlutterSecureStorage();

  static const _enabledUserIdKey = 'rab.biometric.enabledUserId';
  static const _lastFullAuthenticationAtKey =
      'rab.biometric.lastFullAuthenticationAt';

  static const _rememberedAccountKey = 'rab.biometric.rememberedAccount';
  static const _confirmedAtKey = 'rab.biometric.confirmedAt';
  final FlutterSecureStorage _storage;

  Future<({String userId, String email})?> getRememberedAccount() async {
    final raw = await _storage.read(key: _rememberedAccountKey);
    if (raw == null) return null;
    try {
      final data = jsonDecode(raw) as Map<String, dynamic>;
      final id = data['userId'] as String;
      final email = data['email'] as String;
      if (id.isEmpty || email.isEmpty) return null;
      return (userId: id, email: email);
    } catch (_) {
      return null;
    }
  }

  Future<void> setRememberedAccount(String userId, String email) =>
      _storage.write(
        key: _rememberedAccountKey,
        value: jsonEncode({'userId': userId, 'email': email}),
      );

  Future<void> clearRememberedAccount() =>
      _storage.delete(key: _rememberedAccountKey);

  Future<DateTime?> getBiometricConfirmedAt() async {
    final raw = await _storage.read(key: _confirmedAtKey);
    return raw == null ? null : DateTime.tryParse(raw);
  }

  Future<void> confirmBiometric(String userId, DateTime when) async {
    // Remove the previous owner's binding before assigning a new owner.
    await clearEnabledUserId();
    await _storage.write(
      key: _confirmedAtKey,
      value: when.toUtc().toIso8601String(),
    );
    await setEnabledUserId(userId);
  }

  Future<String?> getEnabledUserId() => _storage.read(key: _enabledUserIdKey);

  Future<void> setEnabledUserId(String userId) =>
      _storage.write(key: _enabledUserIdKey, value: userId);

  Future<void> clearEnabledUserId() async {
    await _storage.delete(key: _enabledUserIdKey);
    await _storage.delete(key: _confirmedAtKey);
  }

  Future<DateTime?> getLastFullAuthenticationAt() async {
    final raw = await _storage.read(key: _lastFullAuthenticationAtKey);
    if (raw == null) return null;
    return DateTime.tryParse(raw);
  }

  Future<void> setLastFullAuthenticationAt(DateTime when) => _storage.write(
    key: _lastFullAuthenticationAtKey,
    value: when.toUtc().toIso8601String(),
  );
}
