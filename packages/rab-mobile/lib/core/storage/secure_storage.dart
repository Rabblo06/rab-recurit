import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// F2 (CREWFLOW_TWENTY_FULL_ENGINE_PARITY_REPORT.md §2/§3.18): the ONE place a
/// `FlutterSecureStorage` is configured. Every store (`ApiClient` tokens and
/// session owner, `BiometricStore`, `PushDeviceStore`, `OnboardingStore`) uses
/// [appSecureStorage]; `test/secure_storage_config_test.dart` fails if any
/// other file under `lib/` constructs its own instance.
///
/// Mirrors the native iPhone app (`rab-iphone/.../SecureStore.swift`):
/// - iOS `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`: readable by
///   background work after the first unlock following a reboot (token refresh
///   during a push/background task), never migrated to another device, never
///   restored onto a different device from a backup. The previous plugin
///   default (`kSecAttrAccessibleWhenUnlocked`) is NOT device-only.
/// - `synchronizable: false`: never synced through iCloud Keychain.
/// - No access group: the app's default keychain group only.
///
/// Android: flutter_secure_storage 11.x has no `encryptedSharedPreferences`
/// option any more; its default cipher (AES/GCM data key wrapped by an
/// RSA-OAEP Android Keystore key, `resetOnError`) is the hardened one. It is
/// spelled out here so a plugin upgrade that changes a default is caught by
/// the options test, and it is deliberately IDENTICAL to the options earlier
/// builds used (`AndroidOptions.defaultOptions`), so existing Android installs
/// need no data migration. Android already loses this storage on uninstall
/// and `android:allowBackup="false"` keeps it out of backups.
const IOSOptions secureStorageIOSOptions = IOSOptions(
  accessibility: KeychainAccessibility.first_unlock_this_device,
  synchronizable: false,
);

const AndroidOptions secureStorageAndroidOptions = AndroidOptions(
  resetOnError: true,
  migrateOnAlgorithmChange: true,
  keyCipherAlgorithm: KeyCipherAlgorithm.RSA_ECB_OAEPwithSHA_256andMGF1Padding,
  storageCipherAlgorithm: StorageCipherAlgorithm.AES_GCM_NoPadding,
);

/// The shared, centrally configured secure storage. Inject a different
/// instance only in tests.
const FlutterSecureStorage appSecureStorage = FlutterSecureStorage(
  iOptions: secureStorageIOSOptions,
  aOptions: secureStorageAndroidOptions,
);

/// The plugin defaults every pre-F2 build wrote with (iOS
/// `kSecAttrAccessibleWhenUnlocked`). Used ONLY by
/// `SecureStorageBootstrap` to find and re-write items created before F2:
/// the iOS plugin puts `kSecAttrAccessible` into its read query, so a read
/// through [appSecureStorage] cannot see them. Never use it for anything else.
const FlutterSecureStorage legacyDefaultSecureStorage = FlutterSecureStorage(
  iOptions: IOSOptions.defaultOptions,
  aOptions: secureStorageAndroidOptions,
);
