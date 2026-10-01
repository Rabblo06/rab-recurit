# Existing Auth UI Figma Update

2026-09-29. Scope: existing Flutter sign-in presentation only.

## 1. Existing architecture found
AuthFlowShell remains the persistent root for unauthenticated, biometricLocked, reauthRequired, mustResetPassword and offeringBiometricSetup phases. AuthBackdrop owns the black upper region; AuthSheet (rab_auth_sheet.dart) owns the white docked surface. Existing MatchedAuthLayout owns onboarding-to-Login travel. LoginSheetContent owns the only email/password controllers, submit/error/cooldown state and forgot-password action. AuthProvider owns session truth; LocalAuthBiometricAuthenticator invokes local_auth. RabApp's root gate resolves CurrentUser.presentation after backend validation.

## 2. Confirmed no duplicate auth UI created
Reused AuthFlowShell, AuthBackdrop, AuthSheet, LoginSheetContent, BiometricLockSheetContent, AuthProvider, BiometricAuthenticator, BiometricStore, biometricIcon, existing theme tokens and ForgotPasswordScreen. RabBiometricVisual remains unchanged for setup/other consumers; only returning-user unlock replaces its old green hero with a compact static tile. Small shared AuthWelcomeHeading, AuthPrimaryButton, AuthFooterLine and AuthContentLayout primitives live in the existing auth-sheet file. No new screen, route, AuthProvider, AuthPhase or dependency.

## 3. Files changed
- lib/features/auth_flow/auth_flow_shell.dart: presentation-only password fallback, mounted content and stable sheet.
- lib/features/biometric_lock/biometric_lock_sheet_content.dart: ready/busy/failed rendering, explicit prompt and compact Figma presentation.
- lib/features/login/login_sheet_content.dart: same form with password fallback/normal variants, black button, shared header/footer.
- lib/core/widgets/rab_auth_sheet.dart: shared sign-in geometry and presentation primitives.
- test/biometric_fallback_test.dart: extended existing tests for four states, state identity, duplicate taps, denial, roles and responsive/keyboard behavior.
- test/login_layout_test.dart: new button copy and scroll-to-action check on compact viewports.
- test/login_navigation_test.dart and test/auth_errors_visual_test.dart: approved Sign In label.
- docs/EXISTING-AUTH-UI-FIGMA-UPDATE.md; repository docs/HANDOFF.md and THREAT-MODEL.md.
No edits to core/auth, backend, tokens/session APIs, onboarding visuals, Calendar, Offers, attendance, reports or database. Pre-existing uncommitted changes preserved.

## 4. Shared AuthFlowShell
One black backdrop and docked white sheet, 32px upper corners, no floating card or green hero. Sign-in sheet top is safe-area-aware (31% of usable height plus top inset); all four sign-in states share the same geometry. Other setup/reset sheet placement retains its prior ratio. Sheet padding is shared; fields/buttons have the Figma inset relative to the heading. AuthContentLayout naturally scrolls when keyboard/large text requires it, with a low footer otherwise.

## 5. Biometric ready state
Welcome back / Log in to see your shifts. Compact 52px grey tile uses existing biometricIcon resolver. Sign in with a passkey is retained as requested product terminology. Description truthfully says Use your device biometrics. Nothing to remember. The black Continue with passkey button is explicit: mounting only probes capability; it does not start authentication.

## 6. Biometric failure state
Ordinary cancellation/failed authentication changes only the primary label to Try again. No red panel or layout shift. Busy state shows Authenticating... with a spinner, disables switching and blocks duplicate calls. Lockout/error uses a small inline message. notAvailable falls back through the existing AuthProvider.fallBackToPassword method. The UI never interprets a local success as a verified server session.

## 7. Password fallback state
Use password instead selects a UI flag inside AuthFlowShell while the provider remains biometricLocked. The existing form shows Sign in with a password and Continue with passkey. Both existing content widgets remain mounted in an IndexedStack, retaining form controllers; hidden content cannot receive focus. Returning resets the biometric presentation to Ready without invoking the OS prompt automatically. No Navigator.push or new auth phase is involved. Keeping the existing locked provider gate is intentional: the UI flag cannot manufacture biometric eligibility.

## 8. No-biometric state
Normal unauthenticated and mandatory reauth states use the same LoginSheetContent with Sign in to your account and no biometric secondary action. The UI flag is cleared whenever the provider leaves biometricLocked. No new path bypasses the existing password reauthentication window. Normal footer uses the brief's preferred corrected English: Get offers. Complete shifts. Get paid.

## 9. Email/account handling
The existing locked provider has no verified user/email before /auth/me. The biometric surface therefore shows read-only Saved account, with an accessibility explanation; no fabricated example email, new email persistence, password storage or token decoding. The password form remains editable and authenticates normally. Its typed email never selects a different saved biometric session. Synthetic screenshot email appears only in the QA password form.

## 10. Password form reuse
One existing pair of controllers and the same AuthProvider.login call. Validation, loading guard, visibility toggle, 401/network/server errors and 429 cooldown logic preserved. Sign In now uses the shared black 50px-minimum button with key icon, aligned with the 46px inputs. Responsive button height can grow with accessibility text.

## 11. Forgot password reuse
Same ForgotPasswordScreen route and initialEmail argument, same backend reset behavior. Link remains beside PASSWORD in muted green. Native navigation and widget regressions pass.

## 12. Biometric authentication reuse
Core authenticator/store/provider code unchanged. The OS local_auth prompt is still the only biometric mechanism; no fingerprint data handling, physical security-key support or WebAuthn backend added. attemptBiometricRestore still calls refreshUser /auth/me after local success, with existing rejection/cleanup. Security footer is Protected by your device biometrics, not an unsupported phishing-resistance claim.

## 13. State transitions
A/B to C and C to A retain the same mounted shell and white sheet, switching content without a black gap, exit slide or pushed Login route. Normal failures keep positions stable. Onboarding's existing whole-scene transition, timing, Back and controllers remain unchanged; its tests pass. Existing transitions to setup/reset are preserved.

## 14. Staff routing regression
A new UI test taps Continue, exercises the existing provider with a mocked server response, and verifies the existing AppShell. Rejected /auth/me after local biometric success leaves user null and returns to normal login. Existing account-isolation and password navigation tests pass.

## 15. Venue Manager routing regression
The equivalent biometric UI test verifies VenueManagerShell through CurrentUser.presentation. No destination hard-coded into either auth content widget. Existing navigation tests pass.

## 16. Responsive behavior
Four-state tests at 320x568, 393x852, 430x932 and 390x844 with 100%/200% text; dedicated 320x568, 200% text and 260px keyboard tests for fallback and normal login. Existing Login tests also cover 375x812 and 393x851 with SafeAreas/keyboard. Width-constrained copy initially exposed IntrinsicHeight clipping; replaced that estimate with shared natural-height scroll layout. Native full keyboard verified on the normal build: password stays visible and scrolling exposes Sign In above the keyboard. Original emulator keyboard setting restored. No physical iOS run is claimed.

## 17. Tests
110 passed across every existing test file whose name matches auth|biometric|login|root_gate|password|welcome|onboarding|navigation, including extended biometric_fallback tests. Covers explicit prompt, duplicates, ready/retry, lockout/unavailable, same form/shell and no route push, controller retention, mandatory reauth, session rejection, Staff/Venue routing, forgot password, eye, invalid login, cooldown, logout/account isolation, responsive keyboard and existing onboarding.
Command (PowerShell):
`$authTests = Get-ChildItem test -Filter '*test.dart' | Where-Object { $_.Name -match 'auth|biometric|login|root_gate|password|welcome|onboarding|navigation' } | ForEach-Object { $_.FullName }; flutter test --no-pub $authTests`
Evidence: build/auth-figma-tests-final.log. Focused responsive run: 27 passed, build/auth-figma-responsive-final.log.

## 18. flutter analyze
`flutter analyze --no-pub`: no issues. Log: build/auth-figma-analyze-final.log. Normal `flutter build apk --profile --no-pub` passes; log build/auth-figma-normal-build.log. Normal main.dart APK installed with adb install -r and launched on emulator-5556. No stored data cleared.

## 19. Native visual comparison
Pixel_5_2 / emulator-5556, 1080x2340 at density440. Profile QA entrypoint uses production shell/content/provider, the real LocalAuthBiometricAuthenticator, and in-memory synthetic API/store collaborators; no real account/session reset or network write. Inspected all four Figma states side by side, explicit OS prompt, cancel -> Try again, retry prompt, fallback, return-ready, no-biometric login and Forgot password. Final full-software-keyboard check performed on restored normal app with empty fields and no submitted credentials.
Evidence in build/auth-figma-qa/: four-state-comparison.jpg; ready.png; failed.png; retry.png; password-fallback.png; return-ready.png; normal-login.png; forgot-password.png; software-keyboard.png; software-keyboard-submit.png. Native prompt and retry were confirmed by Android window focus and UI hierarchy (native-prompt.xml/native-retry.xml: Authentication required, Verify identity, Unlock rab to continue, Fingerprint sensor, Cancel). ADB images of the focused system dialog were black; those are not claimed as visible prompt screenshots. App-state screenshots are ordinary native captures. The isolated native harness remains an ignored build artifact, never a production entrypoint.

## 20. Remaining work
No known remaining implementation issue in the requested UI scope. Native system-prompt screenshot capture is limited as described above; physical iOS/hardware performance and real-account server acceptance were not claimed. Backend acceptance/denial is covered by existing and extended mocked-HTTP tests, while the native OS prompt itself was exercised. Normal app is restored at the returning-user sign-in UI. No production distribution performed.
