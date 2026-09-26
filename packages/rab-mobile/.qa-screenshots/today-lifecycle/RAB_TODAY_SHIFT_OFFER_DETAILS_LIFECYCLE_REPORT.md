# RAB TODAY SHIFT + OFFER DETAILS LIFECYCLE REPORT

Date: 2026-09-22. Scope includes the subsequent persisted Worker lifecycle amendment.

## A. Existing architecture found

One Flutter schedule detail screen, OffersProvider, AttendanceProvider, HomeDashboardData, existing pastelDetailRoute and ShiftVisualStyle registry. NestJS Attendance owns clock mutations and official worked duration. Offer expiry means invitation expiry; Attendance status supports payroll review/approval; Shift/Assignment completion already occurs at clock-out. Existing Worker shift monitor polls every five minutes with bounded owner discovery and tenant-scoped runtime mutations.

## B. Reused components/services

ScheduleOfferDetailScreen, SchedulePanel, ScheduleMessageCard, existing buttons/Note surfaces, pastelDetailRoute, ShiftVisualStyle, TenantContextService, runScopedForOrg, AuditService, existing Worker runtime and shift monitor. QR signing, geofence, authorisation, payroll calculations and notification infrastructure remain intact.

## C. New code

- `ShiftStatusControl`: one central status/timer visual.
- `staff-shift-presentation.ts`: one backend projection for status, Home heading, organisation-local day and reconciliation boundary.
- `PostShiftLifecycleService`: discovery and locked, audited milestone advancement.
- Migration `1786672700000-AttendancePostShiftLifecycle`: two nullable milestone timestamps on existing Attendance, timestamp-order constraint, due index and clock-out correction reset trigger. No new enum, tenant table, backend or queue.
- Projection, Worker integration and Flutter lifecycle tests.

## D?F. Next / Today / Live

HomeDashboardData selects authoritative live first, today's confirmed shift, recent post-shift state, then next confirmed shift. Organisation timezone defines Today, including an ongoing overnight shift. The API supplies the heading. Existing information and shift colour are retained. Future shifts show Be Ready rather than a misleading Clock In label.

## G. Card ? Details routing

Whole Next, Today and Live cards open the same ScheduleOfferDetailScreen with the matching Offer/Shift and shared style. No duplicate detail screens. Widget tests cover all three routes and Back restoration.

## H. Morph verification

Existing custom shared-surface route reused; no generic slide or Hero replacement. Source remains until destination's first frame, then hides; reverse restores it before overlay removal. Upcoming deck implementation was not changed by this task. Native `primary-morph.mp4` was extracted and inspected, including expansion/contraction and final restoration. See `morph-transition-review.jpg` and `morph-review.jpg`. No rear-layer flash observed. Existing motion regression tests pass.

## I?J. Details and Note

Existing role/venue/address/pay/date/time layout and colour family retained. NOTE always renders. Missing Note ? centred No Details in white panel; real notes render verbatim. Native captures: `today-detail.png`, `clocked-out-detail.png`, `worker-complete-detail.png`, `next-detail-final.png`.

## K?M. Pending / Confirmed / live HH:MM:SS

Staff acceptance alone remains Pending; confirmed assignment renders Confirmed. Live clock uses server clockInAt and serverNow plus monotonic elapsed time, rendering once per second in the small status subtree. No database writes per second. Official pay/duration remain server-calculated. Resume and periodic refresh reconcile authoritative data. Native timer increased 00:01:52 ? 00:01:57 and restored at 00:05:06 after restart (`live-detail-1/2`, `live-restart-detail`).

## N?P. Persisted delayed lifecycle

API immediately persists clock-out. Worker milestone eligibility:

| Time from authoritative clockOutAt | UI status |
|---|---|
| 0h | Clocked Out |
| 2h | Complete |
| 6h | Expired |

`post_shift_completed_at` and `post_shift_expired_at` are orthogonal milestones; Attendance payroll/review status and money are not overwritten. API reads persisted milestones and never advances them. This supersedes the earlier read-time-only approach. PostgreSQL handles threshold arithmetic without JavaScript timestamp precision loss. Existing five-minute Worker cadence means processing occurs on the next successful scan, not a guarantee of a UI update at the exact wall-clock second. Milestones retain exact eligibility timestamps. An overdue/restarted worker can apply both transitions atomically in one run.

## Q. Authority, security and idempotency

Discovery stays in the existing bounded/advisory-locked owner scan. Per-record work uses rab_app tenant/workspace transactions, explicit scope predicates, RLS, fresh row validation and FOR UPDATE locking. Each milestone and actor-less Worker audit event commit together. Reruns do nothing; concurrent workers produce one event per transition. No automatic email or notification added. Clock-out corrections invalidate obsolete milestones. Unowned legacy workspace-null records remain excluded rather than guessing ownership.

Clock-out response is retained as authoritative history while refresh runs. A stale live offer projection shows Updating status instead of continuing the old timer. Tests cover history refresh failure. Offline lifecycle labels remain last-known; they do not advance using the device clock.

## R. Restart behaviour

Native live timer restored from server timestamp. Complete rendered after restart/login from persisted Worker milestone. Expired rendered after app restart through Calendar ? Details. No persistent Flutter delay controls these states.

## S. Tests and build

- Flutter analyze: no issues.
- Flutter test: **244 passed**, including existing goldens, colour, motion, role/navigation and new whole-card/status tests. Goldens were not regenerated.
- Android profile APK: passed, 109.2 MB; installed on emulator.
- Server TypeScript compilation/type-check: passed.
- Projection unit tests: **12 passed**.
- Worker lifecycle integration: **6 passed**; 11 unrelated tests excluded by explicit test-name filter. Tests cover database-time boundaries 7199/7200/21599/21600s, discovery, rerun, restart catch-up, concurrency, once-only audit, corrections, wrong/missing state and cross-tenant denial.
- Offer/attendance abuse integration: **78 passed** after migration.
- Diff whitespace check: passed for changed task paths.

Logs are in this directory. Initial integration setup exceeded Jest's five-second default; rerun used 60 seconds. Existing test app handles require forceExit; Redis emitted its existing version recommendation. Neither was a failed assertion in final runs.

## T. Android native QA

Real Pixel_5 emulator, production profile app and local API. Native camera scanned the same freshly generated shift QR for Clock In and Clock Out; GPS was inside the verified venue geofence. Server DB proof recorded clocked_out, no active attendance, completed assignment and 9 official worked minutes. Original mutation proof: `attendance-proof-clocked-out.json`.

| State | Real screen opened | Screenshot inspected/evidence |
|---|---|---|
| Next ? Details | YES | next-home-final / next-detail-final; native morph video |
| Today ? Confirmed | YES | today-detail |
| Live and increasing timer | YES | live-detail-1 / live-detail-2 |
| Live after restart | YES | live-restart-detail |
| Clock Out confirmation/result | YES | clock-out-sheet / clock-out-result |
| Clocked Out Details | YES | clocked-out-detail |
| Worker-persisted Complete / real Note | YES | worker-complete-detail |
| Worker-persisted Expired after restart | YES | worker-expired-restart-detail |
| Expired Calendar / History | YES | worker-expired-calendar / worker-expired-history |

Timed QA used only the dedicated attendance timestamps. After the Worker amendment, the production lifecycle service was invoked under the exact QA tenant/workspace to avoid running a global discovery sweep against unrelated local data; Worker wiring and discovery were inspected and tested separately. `worker-proof-complete.json` and `worker-proof-expired.json` prove persisted milestones. Earlier derived-state captures are not presented as Worker proof. Pending is covered by widget/domain tests, not a new native pending fixture.

Disposable identifiers:
- Organisation: eebab9e6-51f0-4593-b104-cfc552fd3407
- Workspace: 2b79d7a9-b4cd-4e30-bbdd-12f22fac5bd9
- Native Clock In/Out shift: a3c19f27-34ab-40b2-86d8-424f5735b03e
- Venue: 7fb41708-88ec-4f0c-a4d8-ce55aa982ed8
- Future Next fixture: 76c4fcce-cfc6-45b1-976d-eda6c7afe7c2

Cleanup: three QA users deactivated, password hashes cleared, Staff inactive, zero unrevoked refresh tokens, future shift cancelled; completed attendance and immutable audit retained. Timestamp ageing intentionally makes the retained QA times unsuitable for payroll; original native timestamps and 9-minute result remain in the original proof. No unknown attendance touched. QR poster reset; private local QA credentials/QR removed. See cleanup-proof.json. Integration fixtures follow the repository's existing retention convention.

## U. Handoff

Updated the same `docs/HANDOFF.md` and threat model. No second handoff.

## V. Remaining limitations / release action

Deploy migration before the revised API/Worker. Local migration applied; production deployment was not requested. Existing Worker processing latency is up to the next successful five-minute scan (longer during outage/contention); null-workspace legacy records are excluded. Global production-like Worker sweep and physical-device QA were not performed. Existing owner discovery briefly takes bounded table locks; this inherited architecture was not replaced. Historical broader UI audit completion is not implied.

**TODAY SHIFT + OFFER DETAILS LIFECYCLE COMPLETE** for the implemented, locally validated scope, with the polling and deployment limitations above.
