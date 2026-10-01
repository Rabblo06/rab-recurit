# RAB Mobile Onboarding Redesign

Date: 2026-09-28. Scope: the existing Flutter welcome/Get Started presentation.

## Implementation

- `lib/features/welcome/welcome_header.dart`: three-page PageView, PageController, safe-area shell, accessible page controls, image precache, shared footer.
- `lib/features/welcome/onboarding_page.dart`: angular ClipPath welcome, asymmetric serif hospitality story, four pastel/dark opportunity preview cards. Compact phones use reduced spacing and image/card heights; enlarged text reflows into scrollable columns. Width is bounded on tablets.
- `lib/features/welcome/onboarding_motion.dart`: local motion tokens, staggered fade/translate/image-scale reveal, accessible InkWell CTA with 150ms press feedback. No dependencies or looping animation.
- `lib/core/widgets/rab_atmospheric_background.dart`: removed green geometry and floating black square; welcome fades to the existing login band. The final band geometry and back-button position are preserved.
- `lib/features/auth_flow/auth_flow_shell.dart`: composes the new welcome widget using the original callback. Welcome owns its entrance ticker; downstream auth entrance remains unchanged.
- `pubspec.yaml`: registers the three local assets.
- `test/onboarding_layout_test.dart`: responsive swipe, page controls, CTA callback, enlarged-text/reduced-motion checks using real Flutter SDK Roboto metrics.
- `test/welcome_flow_test.dart`: retains existing back/persistence checks and adds final-page completion coverage.

## Navigation and content

Get Started on **any** page calls the original `AuthProvider.completeWelcome()` through `_handleGetStarted`. It opens the same login sheet in place, saves the same `rab.onboarding.hasSeenWelcome` flag, and retains first-run back behavior. Swiping alone never completes onboarding. No new routes, registration, API calls or auth/session rules.

Opportunity figures, rate and match score are static Figma-inspired illustrations, explicitly labelled **Illustrative preview - not live opportunities**. They are not connected to live jobs or candidate scoring.

## Supplied assets

Exact local copies, verified by matching SHA-256 to their source files:

- `assets/onboarding/frontdesk.jpg`: welcome and hospitality reception images.
- `assets/onboarding/bedcleaning.jpg`: housekeeping image (the supplied filename is `bedcleaning.jpg`, not `bdcleaning.jpg`).
- `assets/onboarding/hero.jpg`: hospitality dining-room image.

Source: `packages/rab-website/image/`. No runtime website dependency, new stock images or generated imagery. Decode widths are bounded at 700/900px and images are precached. No font or animation package added; serif uses the platform fallback.

## Motion

700ms entrance: heading 80-300ms; image 150-550ms; supporting copy 250-600ms; CTA 400-700ms. Page offset drives restrained fade, 1-.97 scale and separate text/image parallax; settled pages stay still. Indicators use 260ms ease-out. CTA compresses and shifts its arrow northeast over 150ms before the existing callback. Reduced motion renders reveals immediately and removes parallax/scale/fade transitions and programmed page animation.

## Verification

`flutter analyze --no-pub`: no issues. Scoped test command below: **51 passed**. Debug Android APK build passed. No release/store deployment.

```powershell
flutter test --no-pub test/onboarding_layout_test.dart test/welcome_flow_test.dart test/login_layout_test.dart test/login_navigation_test.dart test/root_gate_isolation_test.dart test/auth_flow_test.dart test/password_success_test.dart test/biometric_label_test.dart test/biometric_setup_test.dart
flutter build apk --debug --no-pub
```

Native screenshots: all three pages inspected on Pixel_5_2 (`emulator-5556`) at 1080x2340 pixels, density 440 (approximately 393x851 logical). Also inspected all three at an 880x1562 override (320x568 logical), then restored the original resolution. Compact layout fixes allow all four bento cards and the disclaimer to fit without default-size scrolling. Native horizontal swipes verified.

Widget layout sizes: 320x568, 393x851, 393x852, 430x932, 768x1024 and 844x390. Each tested at 100%, 125% and 200% text. The 200% case uses reduced motion. No tested RenderFlex overflow. Safe-area fixtures include top/bottom insets. Actual iOS hardware and frame-rate profiling were not run; iPhone-sized layout checks are Flutter widget tests, not iOS device certification.

Local QA artifacts (generated/ignored): `build/onboarding-qa/page-{1,2,3}.png`, `small-page-{1,2,3}.png`; analyzer/test/build logs under `build/onboarding-*.log`.

## Boundaries

Backend, API client, auth provider, persisted session implementation, login form, password/biometric content, Home, Offers, Calendar, Clock In/Out, History, Profile and venue-manager screens were not redesigned. Existing unrelated dirty files and pre-existing `test/failures/` artifacts were preserved. Canonical `docs/HANDOFF.md` updated per repository workflow.


## Motion-only follow-up (2026-09-28)

The user approved the settled design. It is unchanged. Auto movement now uses
five-second holds plus 900ms easeInOutCubic page transitions, including a smooth
3-to-1 loop using virtual pages modulo three. Each full-width page is hard-edge
clipped before its content transforms, fixing neighboring-image fragments.
Pages 2/3 use restrained horizontal slide-in offsets within those boundaries.
Touch/drag pauses the timer; settling restarts it. Backgrounding, reduced motion,
disabled tickers and completion suspend auto movement. Timer/observer cleanup is
owned by WelcomeOnboarding. Reduced-motion manual controls remain available.

This supersedes the original no-loop description above; no new animation library
or settled design changes. Added `test/onboarding_motion_test.dart` (five checks).
29 targeted tests pass with clean Flutter analysis; debug build installed on
emulator-5556. Inspected a 23-second actual native loop recording and sampled
transition frames, including 3-to-1. Artifacts in `build/onboarding-qa/`:
`onboarding-motion.mp4`, `motion-contact-sheet.jpg`. No release deployment or
physical iOS performance certification is implied.
