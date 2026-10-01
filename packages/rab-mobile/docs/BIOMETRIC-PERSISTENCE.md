# Existing-account biometric lifecycle ? 2026-09-29

## Before-change audit
AuthProvider currently gates startup using enabledUserId and lastFullAuthenticationAt (30 days), without checking for stored tokens. Password login resets that clock. Logout deletes the preference. BiometricStore has no remembered account or biometric-confirmation timestamp. The lock screen displays ?Saved account?. /auth/me bypasses refresh-on-401, and any unlock server error clears preference and tokens. Role routing and must-reset-password gates already exist. local_auth supplies native biometric-only verification; it does not expose a reliable enrollment-set identifier. Shell resume handlers refresh domain data, not authentication.

## Decisions
Keep the existing provider, store, native authenticator and screens. Remember one verified account. Store session owner separately with tokens; remembered identity is display data, never authority. Legacy biometric records lack confirmation evidence: require password plus fresh native setup, never manufacture a confirmation date from an old password timestamp. Normal logout preserves preference and binding but removes session ownership and tokens. Capability signals are honored; no custom enrollment hash. The deadline is measured from native confirmation, never password login or routine unlock. Recheck at unlock before and after asynchronous work. Existing general app-resume behavior remains unchanged.

## Implemented flow
- Successful password login plus /auth/me stores verified user ID/email, session owner, and full-password timestamp. Editable password email is prefilled; biometric email stays read-only.
- No tokens: password login regardless of remembered preference. With tokens and matching remembered/session/preference IDs: biometric lock only when confirmation is present, not future-dated, younger than 90 days, and device biometrics remain usable.
- Native success is followed by /auth/me (refresh-on-401 supported), ownership comparison, and another deadline check. No refresh or native success advances confirmation time. Rejected sessions lose tokens; temporary network/server failures remain retryable.
- Logout attempts backend revocation, clears local session and session ownership, preserves remembered identity and valid trust. Same-user password login within the cycle rearms automatically when hardware is available. Different-account login removes previous trust before offering the existing setup screen.
- At expiry: password required, then existing setup offered when capable. Only native success writes a new confirmation timestamp. Skip/cancellation/failure proceeds with the password-authenticated session and no active biometric binding. Explicit disable clears preference and confirmation, retaining remembered identity.
- No new routes/providers/forms, forget-account feature, credential service, or backend APIs. Existing role routing and forced password reset gates preserved.

## Storage
Existing secure storage holds tokens and `rab.sessionUserId` in ApiClient. BiometricStore holds `rab.biometric.rememberedAccount` (one JSON userId/email pair), existing `rab.biometric.enabledUserId` (preference owner), `rab.biometric.confirmedAt`, and existing `rab.biometric.lastFullAuthenticationAt` (password audit timestamp only). The old password date is never used as confirmation evidence. All biometric preference clearing also clears confirmation; remembered-account clearing is available for a future explicit forget-account feature.

## Verification
- 140 auth/biometric/login/navigation/onboarding/root-gate tests passed; includes 33 lifecycle tests and existing responsive keyboard/200% text coverage.
- flutter analyze --no-pub: no issues.
- flutter build apk --profile --no-pub: passed.
- Local logs (ignored): build/biometric-persistence-verified.log, build/biometric-persistence-analyze-verified.log, build/biometric-persistence-build-final.log.
- Backend lifecycle assertions use controlled HTTP responses; no production credentials/accounts were used for testing. Native challenge implementation is unchanged.

## Limits / next verification
Offline logout cannot guarantee remote revocation, although it clears locally; revocation is bounded at 10 seconds and refresh retries use the rotated token. The installed local_auth API reports capability/enrollment availability, not a reliable enrollment-set identity. Device-clock trust and general app-resume behavior remain as before; startup and every biometric unlock enforce the deadline. Complete an existing-account password login and native confirmation on a physical Android/iOS device to verify deployment-specific server connectivity and OS enrollment behavior. Existing legacy biometric installations intentionally show password login once because their old records cannot prove native confirmation time.

Android smoke check: final profile APK installed successfully on emulator-5556 without clearing app data; launched com.rab.rab_staff/.MainActivity. UI hierarchy confirms Welcome back / Sign in to your account / Sign In, with no biometric-unlock button. No real credentials entered.
