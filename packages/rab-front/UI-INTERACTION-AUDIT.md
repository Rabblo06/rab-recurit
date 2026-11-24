# UI interaction update — 23 November 2026

## Authoritative source and scope

The newer web UI is in `C:/Users/issac/Documents/Codex/2026-11-07/th/work/crewflow-ui/packages/rab-front`. The running `rab-front-ui-restored` container still mounts that source at localhost:5173. It was not replaced by the main checkout. Android and iPhone changes are in `C:/Rab-recruit/packages/rab-mobile` and `packages/rab-iphone`.

Source inventory: 224 web TSX files (163 contain control declarations), 128 Flutter Dart files (39 contain controls), 78 Swift files (37 contain controls). The scan found approximately 896 control declarations, not 896 distinct runtime buttons. Conditional rendering, generated controls and wrappers mean this is an inventory, not a manual-click coverage claim. Details are in `.audit/ui-refresh-20261123/control-inventory.json`.

## Implemented

- Android and SwiftUI toast: dark #111113 surface, white headings, light body text, semantic badges and countdown line. Removed the close button. Tapping does not dismiss; timer expiry removes the toast. Existing hold-to-pause, queue, deduplication and accessibility announcements remain. Ordinary durations remain 4.5 seconds (info/success) and 7 seconds (warning/error).
- Android shared primary actions and tappable schedule panels: subtle press feedback retains original callbacks, disabled states, focus and layout. Shared staff/venue countdowns roll changing digits; reduced motion renders the supplied value immediately. No client timer or payroll calculation was introduced.
- SwiftUI primary-button press feedback now respects reduced motion and disabled state. Staff/venue countdowns use numeric content transitions on iOS 17+, with an immediate fallback on older versions. Source only; requires Xcode verification.
- Newer web: integrated Sileo with the existing toast event/queue/action lifecycle and reproducible patch; Blobatar fallback preserves the newer authenticated image/session-isolation logic. Existing flow buttons gain press/lift/icon travel; existing sliding sidebar and detail-tab indicators remain in place.
- Newer web date picker: Arc calendar integrated while preserving numeric auto-formatting, month/year jumps, Clear, British dates, limits and portal positioning. No replacement shell, navigation or page layout.

## Resource review

| Resource | Application / decision |
| --- | --- |
| [Beautiful UI](https://beautiful-ui.dev/docs), [motion guidance](https://beautiful-ui.dev/docs/motion) | Reviewed controls, segmented selection, counters and motion/accessibility guidance. React 19/Tailwind 4 source is not a drop-in dependency for React 18 or native apps. Adapted interaction patterns through existing primitives; no claim that paid components were installed. |
| [Cult UI catalogue](https://www.cult-ui.com/llms.txt), [direction-aware tabs](https://www.cult-ui.com/docs/components/direction-aware-tabs.md), [shift card](https://www.cult-ui.com/docs/components/shift-card.md) | Reviewed directional tabs, card transitions, buttons and Dynamic Island visual component. Existing moving selection/navigation and card patterns retained. A React Dynamic Island illustration is not hardware support. |
| [Sileo](https://sileo.aaryan.design/docs) | Installed in the newer web checkout. Native toast uses the existing Flutter/SwiftUI renderer. |
| [Blobatar](https://github.com/Alain00/blobatar) | Local SVG fallback in the newer web Avatar; existing private image transport retained. |
| [Arc date picker](https://uiarc.dev/r/date-picker.json), buttons/dialogs | Calendar source integrated with MIT attribution. Newer flow-button/dialog behavior preserved instead of overwriting it with the older checkout's dialog. |
| [Animate UI](https://animate-ui.com/docs/installation) | Reviewed alongside local animate skill; use existing motion primitives and reduced-motion behavior. No bulk animation CLI rewrite. |
| [Kokonut particle button](https://kokonutui.com/docs/buttons/particle-button) | Reviewed; decorative particles are not added to every operational action. |
| [Interior copy button](https://www.interior.dev/r/copy-button.json), Bencho like | Reviewed earlier. Keep existing copy actions and feedback; no new social-like workflow. |
| Rare UI fluid orb | Earlier source/license review retained; no native port of restricted decorative source. |
| Smooth UI variants | Old competing styling/peer dependency stacks not installed. |
| [Nivo](https://nivo.rocks/bar) | Existing Recharts retained; no second chart engine added. |
| Pasta UI | Earlier skill/design guidance reviewed; paid React 19/Tailwind 4 blocks not installed. |
| Next/Vite/shadcn scaffold examples | No new application or duplicate design system created. |

## Dynamic Island limitation

[Apple Live Activities](https://developer.apple.com/documentation/activitykit/displaying-live-data-with-live-activities) use ActivityKit and a widget extension. Neither existing native target contains that integration. Real Dynamic Island presentation is **not implemented** in this update; a dark ordinary toast is used instead. No screen-height heuristic, device-name guess or fake Android cutout was added. Implementing and validating a real supported-device route remains separate work on an Apple build environment.

## Verification

- Flutter: 17 toast/security tests, 91 existing motion/venue-manager/clock/consistency tests and 2 new button/countdown behavior tests passed (110 total). Reviewed dark-toast golden updated. Debug APK built and installed with app data preserved. Analyzer reports four pre-existing informational lints outside these changes.
- Newer web: type-check passed; production build passed with large-chunk advisory. Focused suites passed: 72 users/date/avatar/tabs/members tests plus 39 toast/profile-feedback tests (111 total). Browser fixtures passed at 375/768/1280 pixels, light/dark, reduced motion at phone width, Pacific/Auckland dates, toast action/queue/persistence, invalid dates, keyboard selection and confirmation cancellation.
- The broad web suite was attempted and stopped to isolate failures/resource contention. It was **not green**. Existing failures include onboarding auth-session mocks missing getGeneration, admin Healthy text matching multiple elements, and timing failures in settings/onboarding. The shared matchMedia test environment gap was fixed; affected toast/profile tests then passed. The Users photo test now targets its intended Change photo control rather than also matching Upload/Remove photo.
- No production deployment, database writes or business-action submissions. The final emulator is at Sign In; live signed-in venue-manager navigation and every business button have **not** been manually verified. User was asked to sign in locally, without sharing credentials. No personal screenshots captured.

## Remaining work

1. After local sign-in, walk the real Android venue-manager screens and record per-control results; use test fixtures for destructive/submitting actions.
2. Validate SwiftUI in Xcode/on device, including timer expiry, VoiceOver, large text and reduced motion.
3. Finish the full per-screen web/native control audit. Source inventory and shared-component coverage are not an assertion that every screen has been redesigned or every button clicked.
4. Resolve unrelated newer-checkout test fixtures/timing failures before claiming a full frontend regression pass.
