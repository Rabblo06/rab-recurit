# Biometric Setup Figma Update

## Existing component updated
Updated `lib/features/biometric_setup/biometric_setup_sheet_content.dart` directly.

## Confirmed no duplicate auth UI
No new production screens, providers, routes, forms, credential storage or passkey implementation. No new dependencies.

## Files changed
- lib/features/biometric_setup/biometric_setup_sheet_content.dart
- lib/features/auth_flow/auth_flow_shell.dart (setup sheet variant selection only)
- lib/core/widgets/rab_auth_sheet.dart (optional setup geometry, shared heading parameters and button radius)
- lib/core/auth/auth_provider.dart (successful enable or explicit Skip advances; failed enable stays on setup)
- test/biometric_setup_test.dart
- test/biometric_unavailable_dialog_test.dart
- test/biometric_reauth_boundary_test.dart
- docs/BIOMETRIC-SETUP-FIGMA-UPDATE.md
- repository docs/HANDOFF.md and THREAT-MODEL.md
Existing unrelated dirty work was preserved. Ignored native fixture/evidence lives under build/setup-figma-qa.

## Auth shell reuse
Same AuthFlowShell, AuthSheet, backdrop and root gates. Native confirmation does not push another Flutter route. Login/onboarding/reset designs remain unchanged.

## Sheet geometry
Setup uses the existing sign-in vertical region with 28px rounded top corners, white docked surface, safe-area bottom padding, and 40px top padding (24px compact). AuthContentLayout provides scrolling only when content requires it and keeps the footer low on taller displays. No border or floating shadow.

## Header
Shared AuthWelcomeHeading with Set up Biometric Login at 20px semibold/bold; Log in to see your shifts. at 11px green.

## Biometric visual
80px white outlined circle enclosing a 46px grey rounded tile and 26px icon from biometricIcon. Removed the large green RabBiometricVisual panel. Native capability continues selecting the appropriate existing icon.

## Setup heading
Setup the passkey Login, centered, 12px bold.

## Description
Requested biometric description, constrained to 290px, 12px muted type and compact line height. Natural wrapping expands at accessibility text scales; it is never truncated to force three lines. Final source uses an escaped em dash to avoid PowerShell encoding corruption.

## Enable Passkey button
Reuses black AuthPrimaryButton, 50px minimum height, 10px radius, inline biometric icon, and existing completeBiometricSetup(enable: true). Both actions disable while the native request is pending; duplicate taps do not prompt twice.

## Skip for now
Transparent TextButton with key icon and 48px touch target. Calls existing completeBiometricSetup(enable: false), writes no biometric binding, and reaches the existing app root.

## Security footer
Reuses AuthFooterLine with shield and approved truthful copy: Protected by your device biometrics. No WebAuthn/phishing-resistance claim.

## Existing biometric logic preserved
Native local_auth remains authoritative. Only native success saves trust. Session storage, 90-day lifetime, remembered email, logout, role selection and password reset are unchanged. Narrow requested integration: unsuccessful confirmation now remains in offeringBiometricSetup with inline retry/Skip messaging, instead of the prior automatic navigation to the app. Capability lost before mount skips unavailable setup through the existing provider method.

## Tests
158 authentication/navigation/onboarding/root-gate tests passed. Setup coverage includes all requested copy/visual primitives; failure/cancellation/no binding; same mounted shell/no added route; duplicate tap prevention; successful binding; Staff and Venue Manager roots; Skip; unavailable hardware; 320x568, 393x851, 430x932 and 390x844 layouts at 100% and 200% text. Log: build/setup-figma-auth-suite.log.

## flutter analyze
No issues found. Log: build/setup-figma-analyze-final.log. Normal main.dart Android profile APK build passed: build/setup-figma-normal-build.log.

## Native visual comparison
Android emulator-5556, 1080x2340 physical screen. Real production shell/provider/native authenticator exercised using an ignored QA entrypoint whose HTTP and secure-storage collaborators are entirely synthetic/in-memory. No real account login, tokens, enrollment or trust records were changed.

Captured and inspected initial.png against the supplied reference: black top, rounded white sheet, compact header, outlined circle/grey tile, neutral copy, black full-width primary, centered Skip, muted low footer. Screen proportions adapt to the taller Pixel viewport rather than hard-coding screenshot coordinates. Initial capture precedes the final punctuation-only correction.

Native prompt was verified with native-prompt.xml (Authentication required / Verify identity / Confirm biometric login for rab / Fingerprint sensor / Cancel). Android excludes the OS prompt from ADB screenshots: native-prompt.png contains black instead of prompt pixels. Cancellation returns to the same screen with Setup cancelled. Try again or skip for now. (cancelled.png/xml). Skip reaches the real Staff root with synthetic empty account data (skip.png/xml); the fixture logged phase=authenticated binding=false.

The virtual sensor rejected tested fingerprint IDs; native-unmatched and native-last evidence is NOT a successful confirmation. Success/binding/role routing is verified by automated tests, not claimed as native success. The normal production entrypoint profile APK was rebuilt/restored after QA, preserving existing app data.

## Remaining work
Successful native fingerprint confirmation using a matching enrolled emulator ID or a physical device remains to be captured. Native OS prompt pixels cannot be captured via this emulator's ADB screenshot path; its UI hierarchy is recorded instead. Therefore the complete native-QA checklist is not declared complete. UI implementation, responsive tests, analyzer and build are finished.
