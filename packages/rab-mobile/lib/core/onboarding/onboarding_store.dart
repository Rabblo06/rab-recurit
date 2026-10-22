import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../storage/secure_storage.dart';

/// Whether this device has ever completed the Welcome screen — presentation
/// state, not a credential, but kept on the same `flutter_secure_storage`
/// backend `BiometricStore` already uses rather than introducing a second
/// persistence mechanism (e.g. `shared_preferences`) for one boolean.
/// Welcome is shown once ever per device install, never again after —
/// including after logout (see `AuthFlowShell`/`AuthProvider.hasSeenWelcome`).
/// A reinstall is a new install: the F2 `SecureStorageBootstrap` wipe clears
/// this flag on iOS (where the Keychain would otherwise outlive the app), so
/// Welcome shows once again — the same thing Android has always done.
class OnboardingStore {
  OnboardingStore({FlutterSecureStorage? storage}) : _storage = storage ?? appSecureStorage;

  static const _hasSeenWelcomeKey = 'rab.onboarding.hasSeenWelcome';

  final FlutterSecureStorage _storage;

  Future<bool> getHasSeenWelcome() async => (await _storage.read(key: _hasSeenWelcomeKey)) == 'true';

  Future<void> setHasSeenWelcome() => _storage.write(key: _hasSeenWelcomeKey, value: 'true');
}
