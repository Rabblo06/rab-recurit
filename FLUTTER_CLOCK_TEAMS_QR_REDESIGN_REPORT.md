# Flutter Clock, Teams and QR redesign

Date: 2026-10-16. Local changes only; no commit, push, deployment or development/production migration.

## Verdict: PARTIAL

The Flutter redesign, real attendance integration and restricted Teams endpoint are implemented. The Teams database migration is prepared but **not applied**: approval to apply it only to disposable test database `127.0.0.1:15436` remains pending. Therefore new Teams/RLS integration coverage is written but not yet proven. Native camera/GPS end-to-end acceptance on physical devices is also outstanding. Do not ship the endpoint without the migration and passing isolation tests.

## Before / after

| Surface | Before | After |
|---|---|---|
| Clock collapsed | Circular duration ring; edge-to-edge pastel sheet | Off-white page, circular Back, centered heading, server-anchored start/overdue/elapsed countdown, mint/red status, venue placeholder, inset yellow gradient card, visible role/rate and action |
| Clock expanded | Pastel drawer with optional notes | Animated yellow card, scrollable real notes or explicit empty state, schedule, real roster initials when available, Teams and attendance actions |
| Teams | No Staff-facing same-shift roster | Navy venue/countdown panel, mint future or red overdue state, minimal coworker rows, loading/error/empty states and anchored attendance action |
| Scanner | Full-screen black camera and rectangular outline | Off-white heading, rounded navy camera area, four white corner brackets, instructions, retry and Cancel scan |
| Active / completed | Ring and completion panel | Clocked In only from authoritative state; elapsed timer. Clocked Out only with confirmed response/timestamp; returned worked minutes and expandable summary |

The user subsequently selected `assets/onboarding/hero.jpg` as the Clock artwork. It now appears as the reference's circular ballroom crop; it is decorative artwork, not a new venue-photo API contract. Clock-specific yellow is an intentional reference-design exception; shared shift identity colours elsewhere are unchanged. No unrelated global theme changes.

## Reference refinement — 2026-10-16

Replaced the stacked/reflowing hero with an overlapping layout: the countdown stays in place while the full-width expanded card rises over it. Matched compact typography, card proportions, yellow gradient, note panel, circular back control, smaller roster initials, Teams rows and scanner bracket geometry. The pay label and amount align to the card's right content edge, covered by a geometry assertion.

The primary action always reads **Clock in** before attendance begins. Early taps show the supplied white **Your shift hasn’t started yet!** sheet, live server-anchored minutes until the configured opening window, and **Back**. The yellow card is hidden while this sheet is open. Reaching the opening time changes the explanation without submitting attendance. The countdown remains factual rather than displaying an artificial zero.

Updated captures, including 320×690 reference fixtures and early-arrival state, are linked first in `.audit/clock-redesign-20261016/gallery.html`. Test fixture names/photos are not production roster data; production initials still come from the restricted roster response. OS status/navigation chrome and actual camera imagery remain device-owned.

Refinement validation: 477 full Flutter tests passed with concurrency 2, 35 final Clock/QR visual tests passed, and the final isolated early-sheet check passed. Static analysis has only the existing informational lint in `test/root_gate_isolation_test.dart:272`. Earlier higher/concurrent runner attempts exhausted host memory; reduced-concurrency runs passed. No new APK was installed or deployment performed for this refinement.

## Production files changed by this task

- `packages/rab-mobile/lib/features/home/schedule_clock_screen.dart`: existing screen/actions reused for Clock and Teams; card/layout, real roster loading, resume refresh, server-time boundaries and guarded completion mapping.
- `packages/rab-mobile/lib/features/home/clock_presentation.dart`: feature palette, header, status badge, isolated countdown subtree.
- `packages/rab-mobile/lib/features/home/shift_team_member.dart`: minimal read-only contract.
- `packages/rab-mobile/lib/features/home/attendance_provider.dart`: Teams GET and backend early-window configuration parsing; authentication and attendance mutations retained.
- `packages/rab-mobile/lib/features/home/qr_scan_screen.dart`: existing `mobile_scanner` integration restyled; explicit externally-owned-controller lifecycle and stop/disposal.
- `packages/rab-server/src/modules/attendance/controllers/attendance.controller.ts`: guarded Teams GET with UUID parsing.
- `packages/rab-server/src/modules/attendance/services/shift-team.service.ts`: restricted roster read.
- `packages/rab-server/src/modules/attendance/attendance.module.ts`: register roster service.
- `packages/rab-server/src/modules/attendance/services/attendance.service.ts`: expose existing `CLOCK_IN_EARLY_MINUTES` in active-read response; no mutation/window/payroll policy change.
- `packages/rab-server/src/database/typeorm/core/migrations/1786718100000-ShiftTeamReadScope.ts`: additive SELECT policy for core and existing physical workspace schemas; unapplied.
- `packages/rab-server/src/database/typeorm/workspace-schema/v1/shift-team-policy.ts`: frozen scoped policy definition.
- `packages/rab-server/src/database/typeorm/workspace-schema/provision-workspace-schema.ts`: install the same policy for newly provisioned workspaces; expected policy count 20.
- `packages/rab-server/src/engine/core-modules/tenant/tenant-context.service.ts`: reset roster capability context in the existing GUC-binding round trip.

Tests: updated `schedule_clock_screen_test.dart`, new `qr_scan_screen_test.dart`, new `shift-team.integration.spec.ts`, reviewed Clock golden images. Documentation: this report, `THREAT-MODEL.md`, canonical `docs/HANDOFF.md`.

The working tree was already extensively modified. Existing scanner error colours, security guards, authentication, other mobile screens and unrelated changes were preserved. Task-start Clock/QR source and Clock golden copies are under `.audit/clock-redesign-20261016/`.

## Attendance logic preserved

- Existing `/attendance/clock-in`, `/attendance/clock-out`, active/history and geofence APIs; same authentication/provider architecture and QR package.
- No optimistic success, offline write queue, fake production timestamps, QR credentials in logs, new payroll arithmetic or altered geofence policy.
- Location permission/fix occurs before scanning; scanner returns one token; existing provider submits it; backend rejection remains visible above the action.
- Clock out retains `End your shift?` / `Keep working`, duplicate-submit locks and backend-confirmed worked time. Passing scheduled end never marks a worker Clocked Out.
- Countdown uses `AttendanceProvider.trustedNow` (server anchor plus monotonic stopwatch). Missing trusted time renders an em dash. Only the timer subtree ticks; parent refreshes at boundaries and resume.
- Removed the screen's hard-coded early-window assumption: current API exposes its configured early minutes; older API responses omit it and backend enforcement remains authoritative.
- Scanner tests exposed a pre-existing lifecycle gap: supplying an external controller disables the package's automatic lifecycle observer. The screen now owns pause/resume and stops before disposal.

## Teams endpoint and security

`GET /rest/v1/attendance/me/shift/:shiftId/team`

Requires authenticated `staff_app`, `attendance.clock`, workspace context, a Staff profile resolved from the verified user, and a current confirmed assignment. Service repeats application/role/permission checks. Parent-first shared locks coordinate with cancellation/assignment changes. Queries constrain organisation, workspace, venue and exact shift and use canonical individual assignment periods.

Returns only `{ displayName, startsAt, endsAt, isYou }`. Display name is first name, with a neutral fallback for absent names. No profile/user/assignment IDs, contact fields, pay or attendance. Only `confirmed` assignments appear; completed/cancelled shifts and unassigned callers are 404. Missing migration yields 503 rather than a misleading self-only roster. Mobile clears rows on refresh/failure and refreshes Teams every 30 seconds and on resume.

**Security trade-off:** the additive RLS policy trusts transaction-local capability GUCs bound by the service after self-resolution and membership checks, analogous to the existing worker context. Incorrect future server binding/SQL injection could broaden profile row reads in that transaction. Existing profile/write policies and FORCE RLS remain; the policy rechecks scope, both confirmed assignments and nonterminal shift. The HTTP response remains minimal. A dedicated database projection/role would provide stronger separation at additional architectural cost. This decision and the test plan are also in `THREAT-MODEL.md`.

Owner approved the restricted endpoint. The subsequent request to apply migration `1786718100000` **only to the disposable database** has not received an explicit answer. No migration was applied by this task.

## States and interactions

- Confirmed: mint Shift confirmed; starts countdown; early action explains the backend-configured opening time.
- Near start: Start in Xm; at/past start: explicit Clock-in overdue with nonnegative elapsed delay.
- Pending request: disabled loading action; repeat taps cannot submit again.
- Active: Clocked In, live elapsed time and Clock out confirmation.
- Completed: Clocked Out, returned worked time or Updating worked time with retry; View shift summary. Teams returns to the parent shift after completion.
- Cancelled/ended/no shift: truthful status and navigation; no attendance CTA.
- Backend error: retry/error state; no attendance success inferred.
- Team rows, real initial previews, empty/retry states, expanded notes and missing-notes state are implemented. No unsupported chat/break/payment/support-ticket controls.
- Directions remain a future addition: no existing venue-map integration was found. No new external map integration was introduced.

## Verification and evidence

- Focused Flutter screen/scanner/provider run: **45 passed** (final screenshot run); mocked HTTP/platform adapters exist only in tests.
- Full Flutter suite: **476 passed** on the final rerun, without updating goldens.
- Server TypeScript application/spec typechecks: passed.
- Existing real-Postgres attendance abuse suite: **42 passed**, including signed QR, clock windows, geofence and duplicate/rate-limit cases. The test guard verified both connections target disposable DB `127.0.0.1:15436` before fixtures. The two stopped disposable containers were restarted; no development data was used.
- Flutter analysis: no issues in changed files; one existing informational lint remains at `test/root_gate_isolation_test.dart:272` (`prefer_interpolation_to_compose_strings`).
- Android profile APK built successfully at `packages/rab-mobile/build/app/outputs/flutter-apk/app-profile.apk`; Java 8/deprecation warnings are inherited plugin build warnings. PowerShell can report a nonzero wrapper result for stderr warnings even though Gradle and Flutter report a successful artifact; the file was verified.
- New Teams integration test source covers minimal projection, unconfirmed callers/peers, foreign organisation/workspace, wrong application, anonymous/invalid requests, current assignment periods, cancellation and ordinary/no-context/pooled RLS visibility. **Not executed pending migration approval.** Physical-workspace policy/provisioning still needs integration verification.

Responsive widget checks cover 320px at 2× text, 360, 375, 390, 393, 430, 432, and 844×390 landscape, safe-area padding, long venue/role/notes, reduced motion, and reachable bottom actions. Teams includes a many-member fixture and scanner layouts cover 360/390/430. No RenderFlex overflow in the passing focused run. Physical permission sheets, measured 60 FPS and actual iPhone/Android camera/GPS flows are not certified by widget tests.

Screenshots are test-rendered evidence, not authenticated native captures:

- `packages/rab-mobile/.qa-screenshots/clock-confirmed-before-window.png`
- `packages/rab-mobile/.qa-screenshots/clock-yellow-collapsed.png`
- `packages/rab-mobile/.qa-screenshots/clock-yellow-expanded.png`
- `packages/rab-mobile/.qa-screenshots/clock-teams-before.png`
- `packages/rab-mobile/.qa-screenshots/clock-teams-overdue.png`
- `packages/rab-mobile/.qa-screenshots/clock-teams-error.png`
- `packages/rab-mobile/.qa-screenshots/clock-teams-empty.png`
- `packages/rab-mobile/.qa-screenshots/qr-scanning-390.png`
- `packages/rab-mobile/.qa-screenshots/qr-permission-denied.png`
- `packages/rab-mobile/.qa-screenshots/clock-live.png`
- `packages/rab-mobile/.qa-screenshots/clock-completed.png`
- `packages/rab-mobile/.qa-screenshots/clock-completion-pending.png`
- `packages/rab-mobile/.qa-screenshots/clock-accessible-expanded.png`
- `packages/rab-mobile/.qa-screenshots/clock-cancelled.png`

Visual review: card inset/radius/gradient, compact metadata, white notes panel, black pill actions, navy/mint/red Teams hierarchy and framed scanner follow the reference. Differences are the honest venue placeholder, accessible minimum 48px actions, real-data empty/error states and scrollable content on constrained screens. Expanded status remains visible above the card. No fake reference coworkers or dress code were inserted into production.

Logs and gallery: `.audit/clock-redesign-20261016/` (`flutter-focused.log`, `flutter-all.log`, `flutter-analyze.log`, `attendance-security.log`, `android-build.log`, `gallery.html`). Baselines/screenshots are local artifacts; retain them separately if sharing this report.

## Remaining actions

1. Approve applying the prepared migration **only to the disposable test DB**, then run Teams and physical-workspace provisioning/isolation suites and resolve any failures.
2. Perform native signed-QR/location Clock In and Clock Out acceptance using isolated approved fixtures; exercise actual OS permission sheets and physical devices. No live Staff attendance was changed by this task.
3. Deploy only after separately authorised migration/application rollout. Nothing was committed, pushed or deployed here.
