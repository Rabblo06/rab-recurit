# Source baseline for the Crewflow native iPhone port

Recorded 2026-10-21 by the inventory and contracts agent (Agent I). This agent read the repository only. It made no commits, pushes, deploys, service restarts or database writes.

## 1. Baseline

| Item | Value |
|---|---|
| Repository | `C:\Rab-recruit` |
| Branch | `feat/venue-manager-teams-ui` (main branch: `main`) |
| HEAD | `073aa17c feat(mobile): staff and venue manager redesign, payroll-gated history, payslips` |
| Working tree | **99 uncommitted entries** from `git status --short`: about 65 modified/deleted tracked files and about 34 untracked files or folders. This does not count `packages/rab-iphone/`, which another agent is creating at the same time. |
| Contract source | **The current local source**, including the uncommitted changes. It is **not** GitHub and **not** HEAD. Several contracts in these docs (check-in, on-behalf punches, manual attendance, replacement/standby `offerKind`) exist only in the uncommitted working tree. |
| Flutter reference app | `packages/rab-mobile` (Flutter, package `rab_staff`). It has **no `ios/` folder**, only `android/`. |
| Backend | `packages/rab-server` (NestJS, every route under `rest/v1`) and `packages/rab-worker` (BullMQ jobs, push sender) |
| Canonical handoff | `docs/HANDOFF.md` (6,197 lines). These docs relied on the sections dated 2026-10-20 and 2026-10-21 (lines ~5894–6197), Stage 5 (realtime, ~3845) and Stage 6 (push, ~3997). |

### Missing input

The owner referred to a handoff attachment, **"Pasted text(20261021-213320).txt"**. It is **not on disk**. Searches of the repository (depth 4) and `C:\Users\issac` (depth 3) found nothing. These docs therefore rely only on `docs/HANDOFF.md` and the code. If that attachment holds decisions that are not in HANDOFF.md, reconcile them against these docs.

## 2. Areas currently being changed by other sessions

Source: `git status --short` at baseline. Treat every file below as **in flux**. If the iOS port mirrors one of these files, it must be re-checked before release.

### 2.1 Flutter app: `packages/rab-mobile`

**Modified files**

- `lib/core/models/attendance.dart`: CheckInState, LocationEvidenceLimits, new AttendanceSummary fields
- `lib/core/models/offer.dart`: checkInRequired, checkedInAt, checkInSource, geofenceEnforced
- `lib/core/services/location_service.dart`: `LocationFix` with capturedAt anchored to the server
- `lib/core/widgets/schedule_feedback.dart`
- `lib/features/home/attendance_provider.dart`: check-in, clock-in/out with location, geofence exit
- `lib/features/home/clock_presentation.dart`
- `lib/features/home/schedule_clock_screen.dart`
- `lib/features/home/schedule_home_screen.dart`
- `lib/features/offers/schedule_offer_detail_screen.dart`
- `lib/features/profile/profile_screen.dart`
- `lib/features/venue_manager/confirmed_staff.dart`
- `lib/features/venue_manager/review_staff_report_screen.dart`: Record attendance, Confirm no-show, Reopen no-show
- `lib/features/venue_manager/shift_report.dart`
- `lib/features/venue_manager/shift_report_screen.dart`
- `lib/features/venue_manager/shift_staff_screens.dart`
- `lib/features/venue_manager/venue_manager_provider.dart`: record-attendance, confirm/reopen no-show, on-behalf
- `lib/features/venue_manager/venue_manager_screens.dart`: Event Details Qr-Code and Clock-In/Out buttons
- `test/report_review_timesheet_test.dart`
- `test/venue_manager_redesign_test.dart`

**New files (untracked)**

- `lib/core/api/attendance_messages.dart`
- `lib/core/widgets/shift_countdown_panel.dart`
- `lib/features/venue_manager/attendance_correction_sheet.dart`
- `lib/features/venue_manager/staff_qr_screen.dart`
- `lib/features/venue_manager/venue_teams_screen.dart`
- `test/check_in_flow_test.dart`
- `test/venue_teams_test.dart`

### 2.2 Server: `packages/rab-server`

**Attendance (modified):**
- `modules/attendance/controllers/attendance.controller.ts`
- `modules/attendance/controllers/shift-report.controller.ts`
- `modules/attendance/dto/attendance-location.dto.ts`
- `modules/attendance/dto/geofence-exit.dto.ts`
- `modules/attendance/entities/attendance.entity.ts`
- `modules/attendance/exceptions/attendance.exceptions.ts`
- `modules/attendance/services/attendance.service.ts`
- `modules/attendance/services/shift-report.service.ts`

**Attendance (new):**
- `dto/check-in.dto.ts`
- `dto/record-attendance.dto.ts`
- `services/no-show-policy.ts`

**Offers (modified):**
- `modules/offer/controllers/offer.controller.ts`
- `dto/send-bulk-offer.dto.ts`
- `entities/job-offer.entity.ts`
- `services/apply-offer-confirmation.ts`
- `services/offer.service.ts`
- `services/venue-offer-pipeline.service.ts`
- `services/venue-offer-presentation(.spec).ts`

**Offers (new):**
- `modules/offer/constants/` (offer-kind)
- `services/shift-vacancy.ts`

**Scheduling:** `modules/scheduling/entities/shift-assignment.entity.ts` (modified)

**Engine (modified):**
- `audit/audit.service.ts`
- `environment/environment-variables.ts`
- `user-deletion/user-deletion.service.ts`
- `.env.example`

**Database (modified):** `database/typeorm/workspace-schema/provision-workspace-schema.ts`

**New migrations and frozen SQL:**
- `core/migrations/1786719400000-OfferKind.ts`
- `core/migrations/1786719450000-AttendanceCheckIn.ts`
- `workspace-schema/v1/offer-kind.ts`
- `workspace-schema/v1/attendance-check-in.ts`

**Integration tests:**
- modified: `attendance-abuse-cases`, `attendance-storage-outage`, `payroll-approval`, `payroll-runs`, `venue-manager-scoping`
- new: `attendance-check-in`, `manual-attendance`, `replacement-standby-offers`

### 2.3 Shared package: `packages/rab-shared`

- `src/state/shift-transitions(.spec).ts`: `no_show → completed`
- `src/utils/index.ts`
- new: `src/utils/location-evidence(.spec).ts`, the single geofence verdict

### 2.4 Worker: `packages/rab-worker`

- `queues/rab-offers/offer-expiry.job.ts`: the standby timeout
- `queues/rab-shifts/shift-monitor.job.ts`: provisional no-show; checked-in staff are never flagged
- integration tests:
  - modified: `attendance-lifecycle-42`, `shift-statement`
  - new: `no-show-provisional`, `replacement-standby-timeout`

### 2.5 Web and docs (not used by the iPhone app, listed for completeness)

- `packages/rab-front/src/features/scheduling/`:
  - modified: `ShiftDrawers.tsx`, `VenueOfferPipeline(.spec).tsx`, `venue-offer-pipeline.css`
  - new: `ShiftDrawers.replacement.spec.tsx`, `VenueOfferPipelineAnalytics.tsx`, `VenueOfferPipelineStages.ts`
- `packages/rab-docs/tools/**`: fixture servers, cinematic and narration tooling
- Root: `THREAT-MODEL.md` (modified), `skills-lock.json`, and three deleted `CREWFLOW_*_REPORT.md` files

## 3. Deployment state of the backend contracts (per `docs/HANDOFF.md`)

| Contract | Migration | On dev DB? |
|---|---|---|
| Venue photo (`venuePhotoFileId`, `/files/:id` for venue photos) | `1786718700000-VenuePhoto` | **UNVERIFIED.** The 20 Oct section says "test DB only". A later `migrate` run on dev (21 Oct 12:42) would have applied it if it was pending. Confirm with `SELECT name FROM migrations`. |
| Payroll record → `payrollStatus` / `payrollApprovedPence` | `1786718800000`, `1786718900000` | Applied to dev |
| Approved shift statements, payroll calendar/runs, payslips (`/payroll/me/statements`, `/payroll/me/payslips`) | `1786719000000`, `1786719100000`, `1786719200000`, `1786719300000` | **Applied to dev 2026-10-21 12:42–12:47** (owner-approved); the images were rebuilt |
| Manual attendance / provisional no-show | none (code + `@rab/shared`) | **Dev API, worker and shared were not rebuilt** |
| Check In, geofence on all three steps, VM on-behalf punches | `1786719450000-AttendanceCheckIn` | **Test DB 15436 only.** Awaiting an owner-approved dev deploy. |
| Replacement / standby `offerKind` | `1786719400000-OfferKind` | **Test DB 15436 only.** Awaiting an owner-approved dev deploy. |

The current source selects the new check-in columns in the attendance and report SQL. An API image built from today's source therefore returns **500** on every `/attendance/me/*` and report read until `1786719450000` is applied. Because of this, manual attendance can't ship on its own; it ships together with the check-in migration.

## 4. Rule: reconcile when a contract changes

1. **The local source wins over these docs.** Before you implement or release an iOS feature, re-read the server controller, DTO and service projection it depends on. Also re-read the Flutter counterpart. Do this especially for any file listed in §2.
2. **When a contract changes**, update `API_CONTRACT_MAP.md` and `FEATURE_PARITY_MATRIX.md` (the state column) in the **same change** as the Swift code that follows it, with the date and the commit or working-tree basis. Do not let the Swift code and these docs drift apart.
3. **Re-baseline after every commit to `main`** that touches `packages/rab-server/src/modules/{attendance,offer,payroll,scheduling,staff}`, `engine/core-modules/{auth,push,realtime,storage}`, `packages/rab-shared/src/{types,state,utils}` or `packages/rab-mobile/lib/**`. Run `git log --oneline -1` and `git status --short`, then refresh §1 and §2.
4. **Don't build against an undeployed contract as if it were live.** A feature whose backend is test-DB-only must degrade the way the Flutter app does. For example, `checkInRequired` defaults to `false` when absent, and an unknown `code` falls back to `message`. Hide or flag it until the owner approves the dev deploy. Never fake the server response.
5. **Never invent a business rule** for payroll, attendance, permissions or retention (CLAUDE.md). If the Swift port needs a rule the server doesn't express, raise it as an owner decision in `BACKEND_DEPENDENCIES.md`.
6. **Update `docs/HANDOFF.md`** (the canonical handoff) after substantial iOS changes, per `CLAUDE.md`. These docs are not a replacement for it.
