# Wave 1, Lane M (mobile): F2 Flutter secure storage parity

Branch `feat/twenty-parity-foundation`. Nothing committed. Only `packages/rab-mobile/**`, this report,
`docs/evidence/wave1-lane-m/**` and one appended `THREAT-MODEL.md` entry were touched. No server, auth, migration or
deploy files were changed, and the app was not run on a device or emulator.

## 1. Finding (CLAUDE.md / architecture §5.8 format)

**F2: Flutter secure storage used default Keychain accessibility and had no fresh-install wipe**

- **Severity:** Low–Medium. The fix is defensive, see the reachability notes below.
- **Actor → action → consequence:**
  - A person who gets a device (or an iOS backup or migration of it) where the Flutter app was once signed in reinstalls
    or restores the app. The previous install's `rab.refreshToken` / `rab.accessToken` / `rab.sessionUserId` /
    biometric binding are still in the Keychain, so the session resumes on an install the user never authenticated.
  - With the old `kSecAttrAccessibleWhenUnlocked` default, the items could also travel to a different device through
    an encrypted backup or a device-to-device migration.
- **Location (before the fix):**
  - `packages/rab-mobile/lib/core/api/api_client.dart:136`: `const FlutterSecureStorage()`, with no `IOSOptions` or
    `AndroidOptions`.
  - The same defaults were constructed independently in `lib/core/auth/biometric_store.dart:9`,
    `lib/core/push/push_device_store.dart:17` and `lib/core/onboarding/onboarding_store.dart:10`.
  - Nothing compared install identity with Keychain contents.
- **Root cause:**
  - Every store built its own `FlutterSecureStorage` with plugin defaults. On iOS that means `WhenUnlocked`, which is
    not device-only.
  - There was no equivalent of the native app's `FreshInstallGuard`
    (`packages/rab-iphone/Crewflow/Core/SecureStorage/SecureStore.swift:158-167`).
- **Fix:**
  - **One central configuration:** `lib/core/storage/secure_storage.dart` defines `appSecureStorage` with:
    - `IOSOptions(accessibility: first_unlock_this_device, synchronizable: false)`, which is
      `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` and matches the native app;
    - `AndroidOptions` with the v11 defaults written out explicitly (RSA-OAEP key wrapping + AES-GCM data,
      `resetOnError`). flutter_secure_storage 11.0.0 has no `encryptedSharedPreferences` option any more.
    - `ApiClient`, `BiometricStore`, `PushDeviceStore` and `OnboardingStore` all default to it. A test fails if any
      other file under `lib/` constructs a `FlutterSecureStorage`.
  - **Fresh-install guard:** `lib/core/storage/secure_storage_bootstrap.dart` (`SecureStorageBootstrap`) runs in
    `main()` before `AuthProvider` reads anything.
    - **Marker:** a file `crewflow.installMarker.v1` in Application Support. It uses `path_provider`, which is already a
      dependency (no `shared_preferences` was added), and the OS deletes it on uninstall.
    - **Sentinel:** `rab.storage.installSentinel.v1`, a secure-storage item that only F2+ builds write.
    - **Decision table:**

      | Marker | Sentinel | Meaning | Action |
      |---|---|---|---|
      | present | any | ordinary restart or app update | nothing is wiped |
      | absent | present | the Keychain outlived the container (reinstall) | `deleteAll()` |
      | absent | absent | brand-new install, or first run over a pre-F2 build | no wipe; old items are migrated |

    - Every case then writes the marker first and the sentinel second, so a crash between the two can only cause a
      harmless re-run.
- **Regression tests:** `test/secure_storage_config_test.dart` (18 tests, see §4). They run against
  `test/support/fake_keychain.dart`, a channel stub with the darwin plugin's real query semantics:
  - read and readAll filter by accessibility;
  - an account that exists under a different accessibility fails with a duplicate error (-25299);
  - delete ignores accessibility.

## 2. Decisions

- **What a reinstall wipes:** everything (`deleteAll`), the same as the native guard's `removeAll()`. That covers:
  - tokens and the session owner;
  - biometric enrolment, confirmation, last full authentication and the remembered account;
  - the push device id;
  - the onboarding "has seen welcome" flag.
- **Why the onboarding flag is wiped:** `OnboardingStore` documents Welcome as "once per device install". Android has
  always lost the flag on uninstall, because the plugin data dies with the app. Wiping it on an iOS reinstall makes iOS
  behave the same way. It is presentation state only.
- **Why the push device id is wiped:** a reinstall gets a fresh FCM token anyway. A new id matches Android and native
  behaviour.
- **Logout is unchanged.** `ApiClient.clearTokens()` plus `clearLegacyApplicationPreference()` still delete
  `rab.sessionUserId`, `rab.accessToken`, `rab.refreshToken` and `rab.applicationTarget`. The plugin's delete matches
  any accessibility. Logout still keeps the biometric binding, the remembered account and the device id (tested).
- **Biometric re-auth, push registration and onboarding still work:** they use the same keys and values through the
  shared instance, and the existing suites for them pass.
- **No plaintext token persistence:** grep evidence is in
  `docs/evidence/wave1-lane-m/plaintext-token-grep.txt`.
  - `lib/` uses no `SharedPreferences`.
  - The only file writes are `shift_colours.json` (hashed colour slots), PDF exports to the temp dir before sharing,
    and the install marker (content `1`).

## 3. Migration behaviour for existing installs

- **Android (the only platform `rab-mobile` ships):**
  - The Android options are byte-identical to the pre-F2 defaults. A test asserts this against
    `AndroidOptions.defaultOptions.toMap()`, so no data is re-encrypted.
  - The first launch after the update finds no marker and no sentinel, so it migrates nothing and wipes nothing. It
    writes the marker and the sentinel.
  - **No user is logged out.**
  - A reinstall cannot leave data behind on Android: the plugin storage is deleted with the app, and the manifest sets
    `android:allowBackup="false"`.
- **iOS:**
  - `packages/rab-mobile` has no `ios/` runner, and none ever existed in git history. iOS users run the native
    `rab-iphone` app, which already has this protection. So there are no shipped Flutter iOS installs to migrate; the iOS
    half of this fix covers any future iOS runner.
  - The darwin plugin puts `kSecAttrAccessible` in its read query. A pre-F2 item is therefore invisible to the new
    options, and a new write to it would fail with a duplicate-item error.
  - The bootstrap handles this. On iOS it reads the old items through `legacyDefaultSecureStorage`, deletes each one
    (delete matches any accessibility) and writes it back with the new accessibility. Keys and values stay the same, so a
    signed-in user stays signed in.
  - If the app is killed between one item's delete and its re-write, only that item is lost. At worst that costs one
    re-login, which fails closed.

```
SECURITY TRADE-OFF
Decision:   "No marker AND no F2 sentinel" is treated as an upgrade (keep and migrate any pre-F2 Keychain items), not as a
            reinstall (wipe).
Reason:     The marker and sentinel are both new, so a pre-F2 install upgrading to this build looks exactly like a fresh
            install sitting on a pre-F2 install's Keychain residue. Wiping would log out every existing user once.
Risk:       On iOS only, a reinstall whose PREVIOUS install was a pre-F2 build resumes that session exactly once.
            Practically empty: no Flutter iOS build has ever shipped (no ios/ runner in history). Android is unaffected
            because its storage dies with the app.
Mitigation: From the first F2 launch on, every install carries the sentinel, so every later reinstall is wiped.
Reversal:   In SecureStorageBootstrap.run(), call _storage.deleteAll() in the "marker absent, sentinel absent" branch too.
            Every existing user then signs in again once.
```

**Other residual risk (same as native):**
- The marker lives in Application Support, which iOS includes in backups, just as the native app's `UserDefaults`
  marker is.
- So an encrypted backup restored to the **same** device brings back both the ThisDeviceOnly items and the marker, and
  the session resumes.
- A restore to a different device brings back neither the items nor the session.
- Excluding the marker from backup would need native code (`NSURLIsExcludedFromBackupKey`). It is not done here, to keep
  parity with native.

## 4. Test results (observed)

- **`flutter test` (full suite):** 652 passed, 0 failed, 0 skipped. That is the earlier ~634 plus the 18 new tests.
  Output: `docs/evidence/wave1-lane-m/flutter-test-full.txt` (`All tests passed!`, exit=0).
- **`flutter analyze`:** 4 `info` lints, no errors or warnings, exit=1. All four are in files this lane did not modify:
  - `lib/features/venue_manager/attendance_correction_sheet.dart:162`
  - `lib/features/venue_manager/availability_conflict.dart:52`
  - `lib/features/venue_manager/shift_report_screen.dart:36`
  - `test/root_gate_isolation_test.dart:272`

  None is in the new or changed files. Output: `docs/evidence/wave1-lane-m/flutter-analyze.txt`.
- **Mutation checks** (`docs/evidence/wave1-lane-m/mutation-checks.txt`): each of these sabotages makes the new tests
  fail, and the restored sources pass 18/18:
  - accessibility put back to `unlocked`: 11 tests fail;
  - the reinstall `deleteAll` removed: 4 fail;
  - the marker ignored: 7 fail;
  - the iOS migration skipped: 2 fail.

## 5. Files changed

- New:
  - `packages/rab-mobile/lib/core/storage/secure_storage.dart`
  - `packages/rab-mobile/lib/core/storage/secure_storage_bootstrap.dart`
  - `packages/rab-mobile/test/secure_storage_config_test.dart`
  - `packages/rab-mobile/test/support/fake_keychain.dart`
- Modified:
  - `packages/rab-mobile/lib/main.dart`: runs the bootstrap before `runApp`.
  - `packages/rab-mobile/lib/core/api/api_client.dart`: storage can be injected and defaults to `appSecureStorage`.
  - `packages/rab-mobile/lib/core/auth/biometric_store.dart`
  - `packages/rab-mobile/lib/core/push/push_device_store.dart`
  - `packages/rab-mobile/lib/core/onboarding/onboarding_store.dart`
- Docs:
  - `THREAT-MODEL.md`: F2 entry appended.
  - This report.
  - `docs/evidence/wave1-lane-m/`.
- `docs/HANDOFF.md` is left to the coordinator. Suggested line: "Mobile secure storage: one `appSecureStorage`
  (`lib/core/storage`), `SecureStorageBootstrap` in `main()` wipes on reinstall (marker file + keychain sentinel)."
