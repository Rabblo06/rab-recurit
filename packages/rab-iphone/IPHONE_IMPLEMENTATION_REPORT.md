# Crewflow native iPhone app — implementation report

Date: 2026-10-22. Package: `packages/rab-iphone`. Baseline: HEAD `073aa17c` plus the uncommitted working tree (`docs/SOURCE_BASELINE.md`).

## Account security update (2026-10-25) — source only, NOT compiled

Two-factor sign-in and Profile → Security were added on Windows (no Swift toolchain): nothing new has been built,
run or tested. The full report, state table, static review and the CI proposal are in
`docs/account-security/SWIFTUI_REPORT.md` (repo root, local). Summary: every request now sends
`X-Client-Capabilities: mfa-verify`; `POST /auth/login` 409 `SECOND_FACTOR_REQUIRED` moves the session to the new
`.secondFactor` phase with nothing stored until `POST /auth/mfa/challenge/verify` returns the session; the 13 designed
mobile states are native SwiftUI views under `Crewflow/Features/Authentication/TwoFactor/`; the VM profile gained a
Security row and the Staff Security screen now hosts the same view; the Debug-only `TwoFactorUITestStub` drives the
new UI tests (`CrewflowUITests/TwoFactor`), which attach a PNG per state.

## Status in one paragraph

**CI update (2026-10-22):** GitHub Actions `ci-iphone` (macos-15, Xcode 16.4, Swift 6.1.2 in Swift 5 mode, iOS 18.5 simulator) run 39754177232 on main `5968fc52`: Debug build succeeded unsigned; 203/203 unit tests and 6/6 UI tests (launch, forgot password, Staff sign-in → Home/History/Profile, VM sign-in → Home) passed against the Debug-only canned backends. Not yet verified: a real device, signing, camera/QR, location, Face ID, push, or a live backend.

The native SwiftUI app is **written but has never been compiled, run or tested**. The development host is Windows with no Swift toolchain, Xcode or XcodeGen. Nothing here claims that SwiftUI, UIKit, camera, location, Face ID, push or UI tests pass. The checks that were possible on Windows were done by reading the code: balanced brackets, no duplicate type or extension-member names across the single app module, and a static review of every call from the Staff and Venue Manager features into Core (see "Static review"). Expect a first round of compile fixes on a Mac.

## What exists

| Area | Path | Swift files | Lines |
|---|---|---|---|
| App entry, environment, root routing, shells | `Crewflow/App` | 4 | ~640 |
| Networking, session, Keychain, biometrics, push identity | `Crewflow/Core` | 9 | ~2,090 |
| Design system (tokens, cards, actions, states, toasts) | `Crewflow/DesignSystem` | 5 | ~1,240 |
| Shared models (identity, shift colours, formatting) | `Crewflow/Models` | 4 | ~630 |
| Login, forgot password, set password, biometric lock/setup | `Crewflow/Features/Authentication` | 3 | ~590 |
| Staff app | `Crewflow/Features/Staff` | 20 | ~6,300 |
| Venue Manager app | `Crewflow/Features/VenueManager` | 21 | ~7,660 |
| Unit tests (203 test methods, 115 of them in Staff + VM) | `CrewflowTests` | 16 | ~3,500 |
| UI tests (6 test methods, incl. Staff and VM sign-in → Home) | `CrewflowUITests` | 3 | ~155 |

Project: XcodeGen `project.yml`, iOS 16.0 deployment target, Swift 5.9, no third-party packages. The `.xcodeproj` is generated and not committed.

Docs: `README.md`, `ARCHITECTURE.md`, `docs/FEATURE_PARITY_MATRIX.md` (76 rows, every row filled), `docs/API_CONTRACT_MAP.md`, `docs/BACKEND_DEPENDENCIES.md`, `docs/SOURCE_BASELINE.md`, `docs/SECURITY_NOTES.md`.

## Feature coverage (source)

**Shared:** role-based root gate; login with `Retry-After` lockout; forgot password; forced set-password; Face ID/Touch ID setup and cold-launch unlock (local unlock of a valid session only); 90-day password re-auth; single-flight refresh with generation fencing; logout (deactivate push → revoke → wipe Keychain and per-session files); `rab://login` deep link; errors-only toasts; three-colour shift identity persisted across launches; console entry for Manager/CEO/Admin accounts.

**Staff:** Home (both modes), Offers, Confirmed, Job Details, Calendar, Check In → Clock In → Clock Out (QR scanner; one location fix only at geofenced venues), Teams, History (payroll-approved shifts only), Payslips with PDF viewer, Inbox, Profile and Security.

**Venue Manager:** Home, Calendar, Event Detail, Teams (server-time countdown), Staff QR (shows the pre-shift PDF; no QR is drawn), Users and staff profile, Send Shift, Sent Shifts, report lists and History, Shift report, Review staff report (record attendance, confirm/reopen no-show, on-behalf clock in/out), report PDF.

## Not built (gaps)

| Row | Item | Why |
|---|---|---|
| S2 | Animated Welcome/onboarding | ~1,000 lines of Flutter motion design; needs a design pass. The app opens on Login. |
| S19 | Geofence-exit automatic clock-out | The brief forbids background location tracking. Clock-out stays manual. |
| S31 | Realtime `/realtime/stream` | Not built. Screens refresh on appear, pull-to-refresh, app activation and polling. |
| S32 | APNs registration (`POST /push/devices`) | Needs a real Team ID, bundle id and APNs entitlement. Only the UUID device id and deactivate-on-logout exist. |
| V29/V31 | VM realtime and notification inbox | Not built. |
| V36 | Staff QR image | No QR endpoint exists (G1). V16 shows the PDF instead. |
| V32–V35 | Web-only manager features | Not part of the mobile app. |

## Rules carried over from the Flutter app and the backend

- `X-Client-Platform: mobile` on every request; `/auth/me` is the identity source; capabilities only hide buttons, the server decides.
- No Idempotency-Key exists server-side, so clock-in/out, accept/decline, Send Shift and other mutations are **never auto-retried**. Only finalise, attendance-review and confirm-no-show retry once (the contract marks them safe to repeat). Uncertain outcomes re-fetch state before showing anything.
- No success toasts on mobile; errors only.
- Worked minutes are never computed on the phone; running timers render server time.
- Record attendance starts with empty times and echoes the server attendance version.
- `chargeRatePence` is never decoded. Send Shift has no note field because the server drops it.
- Downloaded PDFs go to a per-session temporary folder wiped on sign-out.
- UI-test canned backends (`StaffUITestStub`, `VMUITestStub`) are `#if DEBUG` and need two launch arguments; they do not exist in Release builds.

## Placeholders that need real, approved values

Nothing below was invented. Each must be supplied before any device build that leaves the simulator:

- Apple Team ID and code signing.
- Bundle identifier (currently `com.example.crewflow`).
- API host (`dev-host.invalid` placeholder; Release refuses non-HTTPS) and console URL.
- APNs entitlement environment and server-side APNs key.
- App icon artwork.

No App Store, TestFlight, device registration, paid CI or Mac rental has been done or is authorised.

## Backend dependencies

Several rows only work once the test-DB-only backend work is deployed to dev (not done; awaiting approval): manual attendance and no-show review, check-in / on-behalf punches / geofence evidence (migration `1786719450000`), and offer kinds for replacement/standby (migration `1786719400000`). Full list: `docs/BACKEND_DEPENDENCIES.md`.

Backend bugs found while mapping the contract (not fixed; outside this package): the Flutter push deviceId is not a UUID, so logout's deactivate call 404s; `POST /shifts/request` drops `note`; the Venue Manager app receives `chargeRatePence`; Flutter's VM bulk-send targets a web-only route and can never succeed.

## Decisions waiting for the owner

1. **Background polls and the idle session (B11).** The iPhone app marks its background refreshes with `X-Crewflow-Background: 1`, so they do not keep the 7-day idle session alive. This is stricter than Flutter. Keep it, or match Flutter?
2. **Display filters on the phone clock.** Upcoming/confirmed lists and the Users "busy now" filter use the device clock, as Flutter does. The server still decides availability.
3. **Times shown in Europe/London.** All dates are formatted in the venue time zone (Europe/London) rather than the phone's zone, matching the web console.

## Static review

A reviewer read the code to find errors a compiler would catch. It read all of Core, App, DesignSystem, Models and Authentication, and every Staff and Venue Manager source and test file. It found and fixed five definite errors:

1. **`DesignSystem/Components/Toast.swift`:** the toast host's scene closure called a main-actor method without being main-actor itself. It and `View.toastHost` are now `@MainActor`.
2. **`VMEventDetailView.swift`**, 3. **`VMSendShiftView.swift`** and 4. **`StaffJobDetailScreen.swift`:** each had a view block with 11 children. iOS 16 allows at most 10, so the trailing children are now wrapped in `Group {}`. The layout is unchanged.
5. **`CrewflowTests/VenueManager/VMRepositoryTests.swift`:** a mixed-type dictionary literal needed an explicit `[String: Any]`.

**Checked by reading, no problems found:**
- Every Staff and Venue Manager call into Core uses labels, `async`/`throws` and types that match the real declarations.
- `public` declarations expose no `internal` types.
- Every `switch` covers all cases.
- No API needs iOS 17 or later.
- The test fixtures are bundled.
- The camera, location and Face ID permission texts are present.
- No type or extension member is declared twice.

**Possible issues left unchanged:**
- The main-actor `setUp() async throws` overrides in `SessionCoordinatorTests` and `VMStoreTests` depend on how XCTest is annotated in the installed Xcode. I believe they are fine on Xcode 15, but this is unconfirmed.
- Most Venue Manager sheets rely on the parent's environment objects being passed down. If one isn't, it fails when the app runs, not at compile time.

**What reading cannot confirm:**
- that the Swift type checker can finish on long SwiftUI modifier chains;
- which overload SwiftUI chooses in ambiguous calls;
- how result builders infer types through custom initialisers;
- the actor and Sendable diagnostics of the installed SDK and compiler.

Only `xcodebuild` on a Mac is conclusive.

## How to build (on a Mac)

```bash
brew install xcodegen
cd packages/rab-iphone
cp Config/Local.xcconfig.example Config/Local.xcconfig   # set API_BASE_URL, bundle id, team
./Scripts/generate-project.sh
open Crewflow.xcodeproj
```

Then build the `Crewflow` scheme for an iOS 16+ simulator, run the unit tests, and run the two sign-in UI tests (`-CrewflowUITesting` plus `-CrewflowStaffStub` or `-CrewflowUITestVenueManagerStub`; the test classes pass these themselves).
