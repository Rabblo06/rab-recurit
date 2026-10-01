# Venue Offer Live Staffing Kanban

Implementation and local verification: 29 September 2026. Local workspace source
is authoritative. Existing unrelated dirty work was preserved.

## 1. Existing systems discovered
Reused OfferService and its state machines; the Phase 3 late predicate;
AttendanceService and canonical worked-time values; UserNoteService; the existing
StaffSelectionPage, AvailabilityService and ReplacementRequestService; ShiftReport,
ShiftReportService, final-timesheet worker/template; FileService, StoredFile and
ReportFilePolicy. Existing Venue Manager finalisedBy/finalisedAt is the sign-off.
There is no existing handwritten signature capture. See VENUE-OFFER-KANBAN-AUDIT.md.

## 2. Duplicate/old post-approval UI removed
The approval drawer no longer renders an approved request's management view.
Approved events redirect to the pipeline; pending and declined retain their
existing review/history drawer. No domain services or general Offers UI removed.

## 3. Files changed
Task-specific production files (some already contained unrelated local work):
- rab-front/src/App.tsx, shell/Layout.tsx
- rab-front/src/features/scheduling/{VenueOffers,ShiftApprovalDrawer,StaffSelectionPage,VenueOfferPipeline}.tsx and venue-offer-pipeline.css
- rab-front/src/features/users/UserDetailPanel.tsx (optional Notes tab event only)
- rab-server/src/modules/offer/offer.module.ts
- rab-server/src/modules/offer/controllers/venue-offer-pipeline.controller.ts
- rab-server/src/modules/offer/services/{venue-offer-pipeline.service,venue-offer-presentation,offer.service,replacement-request.service}.ts
- rab-server/src/modules/scheduling/services/{scheduling.service,late-clock-in}.ts
- rab-server/src/modules/attendance/services/{attendance.service,shift-report.service,report-readiness}.ts
- rab-server/src/modules/attendance/entities/shift-report.entity.ts
- rab-server/src/modules/attendance/templates/final-timesheet.html.ts
- rab-server/src/engine/core-modules/storage/{files.controller.ts,dto/file-previews.dto.ts}
- rab-server/src/database/typeorm/core/migrations/1786673700000-OriginalTimesheetFile.ts
- rab-shared/src/state/shift-transitions.ts (existing shift staffing states may reopen after a cancellation)
- rab-worker/src/queues/rab-shifts/late-clock-in.job.ts
- rab-worker/src/queues/rab-reports/final-timesheet.job.ts
Tests: VenueOfferPipeline.spec.tsx; venue-offer-presentation.spec.ts;
venue-manager-scoping and file-storage-security integration suites; worker
report-worker-concurrency, report-storage-multiworker, attendance-lifecycle-42 and
shift-cancellation-correctness integration suites. Two old fixtures now explicitly
activate employment, as the existing approval/replacement contract requires.
Documentation: this report, audit, docs/HANDOFF.md, THREAT-MODEL.md.
All package paths above start at packages/. QA evidence is under .audit/venue-pipeline/.

## 4. Venue Offers status projection
Exact precedence: declined -> Declined; pending_manager_approval -> Pending approval;
confirmed/completed assignments >= required (required > 0) -> Fully filled;
otherwise staff-declined offer count > 0 -> N staff rejected; otherwise confirmed
plus staff-accepted assignments > 0 -> Partially filled; otherwise Offered.
These are presentation labels, never new database statuses. Historical staff
rejections remain visible until the required seats are confirmed.

## 5. Approval -> Kanban navigation
Approve closes the existing drawer and dispatches open-venue-pipeline. The shell
navigates to /venue-offers/:shiftId. Approved table rows navigate directly. Pending
and declined table rows keep the approval drawer. Refresh reconstructs from API data.

## 6. Kanban API/projection
GET /rest/v1/shifts/:id/pipeline returns stored shift details, serverNow, summary,
exact stages, joined staff cards, server cancellation capability, replacementPlaces
and the existing batched report projection. No client timers establish domain facts.
No per-card profile, attendance or notes fetch. Avatar reads are separately batched.

## 7. OFFERED
Pending offer with no persisted notification-read acknowledgement.

## 8. WAITING
A still-pending offer whose offer_sent notification has read_at. This means the
notification was read, not guaranteed delivery or viewing the offer screen. The
system does not invent a delivered/viewed event or move a card using elapsed time.

## 9. STAFF ACCEPTED
staff_accepted or manager_confirmed offer, after attendance/terminal/late precedence.
Venue-request staff acceptance retains existing automatic confirmation.

## 10. LATE STAFF
Shared Phase 3 predicate: confirmed assignment, active shift, configured grace
threshold passed and no attendance. Pipeline uses database time. Actual clock-in
immediately takes precedence over late state.

## 11. CLOCKED IN
Stored clockInAt without clockOutAt; includes on-break/active attendance. No guessed
clock-in based on a mobile UI stage.

## 12. CLOCKED OUT
Stored clockOutAt takes highest precedence, including verified geofence clock-out.
Worked and break minutes come from attendance, not browser arithmetic.

## 13. DELETED OFFER
Declined, expired, withdrawn, manager-rejected or cancelled booking/shift, unless
real attendance takes precedence. Evidence is retained; nothing is hard deleted.
Cards distinguish staff decline, manager cancellation and other terminal outcomes.

## 14. Staff decline behavior
Existing decline service and reason/audit remain unchanged. Polling moves the card
to DELETED OFFER and projects the rejected count/table label.

## 15. Manager T-15 cancellation behavior
Allowed only when database clock_timestamp() < startsAt - 15 minutes, with a legal
active offer/assignment pair and no attendance. Pending offers become withdrawn;
accepted reservations become manager_rejected plus cancelled assignment; confirmed
offer history stays manager_confirmed while its assignment becomes cancelled.
The confirmed count/shift state reopen once, never by decrementing a client counter.
Repeated taps return conflict after one successful transaction.

## 16. Staff Notes reuse
Optional reason is appended through existing UserNoteService with shift context.
No reason creates no empty note. Audit and notification always use existing services.
Card Notes opens the existing UserDetailPanel directly on its Notes tab. Real browser
verification displayed the saved cancellation note, not a duplicate notes panel.

## 17. Replacement Staff reuse
The same StaffSelectionPage supports replacement mode; Confirm becomes Send offers.
Server checks active account/employment, private owner/workspace, availability,
capacity and absence of prior assignment. Canonical send and existing pending
replacement-request reconciliation run atomically. No randomly selected autosend.
Cancelled booking history is retained, so a previously offered staff member is not
silently reoffered through a conflicting unique assignment.

## 18. Automatic refresh mechanism
Existing React Query: pipeline every 5 seconds while active, list every 10 seconds,
mutation invalidation immediately. No new websocket service. Browser verified
notification read, acceptance, decline, late, clock-in/out and reload reconstruction.

## 19. Existing report system reused
The existing report projection now batches staff rows and exposes avatar IDs,
finaliser name and backend readiness. The same final-timesheet worker/template
produces original and final versions; roster worker and VM report UI remain intact.

## 20. Original/unsigned report
Audit found no stored unsigned final-timesheet field. pre_shift_file_id is a
PRE-SHIFT ROSTER and was not relabelled. Minimal additive shift_report.original_file_id
references StoredFile; the existing worker writes an immutable unsigned snapshot
when relevant attendance resolves. Existing generated snapshots are never replaced.

## 21. Venue Manager signed report
Uses existing shift_report.final_file_id, finalised_by and finalised_at. UI labels it
Venue Signed Timesheet and explains the existing recorded finalisation. It does not
claim or manufacture a handwritten signature. Original and final remain separate.

## 22. Staff report data
Actual profile image (authorized bounded preview, initials fallback), name, role,
clock-in/out, break, worked minutes, attendance status and corrected indicator.
The panel also shows venue and scheduled date/time. View/Download uses authenticated
existing /files/:id access and both downloaded files were real PDFs in browser QA.

## 23. Workspace/RLS
Manager application and existing permissions plus explicit org/workspace/private
owner checks; forced RLS unchanged. Same-workspace Manager B cannot read/cancel/
replace Manager A's pipeline or download either report. Staff/VM cannot use manager
pipeline APIs. Batch previews preserve existing image policy and reject scope fields.

## 24. Concurrency/idempotency
Parent-first shift locking coordinates cancel/accept/clock-in/replacement; fresh
DB cutoff and locked rows prevent stale decisions. Five duplicate cancellations
produce one note/audit; acceptance racing cancellation leaves a terminal booking
and no filled seat. Report advisory locks, immutable objects, email CAS/outbox and
rollback cleanup remain in the existing worker. Both PDF versions survive retries.

## 25. Tests
- Projection unit suite: 25 passed.
- Venue Manager scope/selector/pipeline integration: 37 passed.
- Full frontend suite: 109 passed (15 suites), including 6 pipeline tests.
- File storage authorization/integrity, including batch previews: 39 passed.
- Attendance abuse integration: 41 passed.
- Late and replacement existing regressions: 66 passed.
- Shift cancellation existing regressions: 28 passed.

## 26. Existing report regressions
attendance-lifecycle-42: all 42 steps pass, including QR, geofence, duplicate
clock-in, correction, finalisation and real PDF/email evidence. report-worker-
concurrency plus report-storage-multiworker: 21 passed. New test proves unsigned
snapshot then existing VM finalise, separate immutable PDFs, no duplicate email,
readiness before/after attendance, and same-workspace foreign-manager denial.

## 27. Typecheck/lint
Repository lint targets are TypeScript checks. Server, frontend and worker checks
pass. Shared/API/worker compile and Docker image build pass; frontend Vite production
build passes. Existing warnings: Vite large bundle, Redis 5 versus recommended 6.2,
and ts-jest isolatedModules deprecation. No fabricated lint or performance scores.

## 28. Visual QA
Real Chromium + local API/Postgres/MinIO: pending approval -> board, direct approved
row reopen, optional-reason cancellation, existing replacement picker, automatic
stage movement, avatar, report downloads, Notes and refresh. No page errors.
Screenshots inspected at 1024, 1440, 1920 pixels, no body overflow. Horizontal board
scroll is intentional. Report and cancellation reuse the workspace-level dock.
Evidence: browser-first.json, browser-live.json, browser-layout.json; board-*.png,
report-signed.png, staff-notes.png, replacement.png. The existing desktop console's
phone shell is outside this change; mobile Staff/VM UI was not redesigned.

## 29. Newly discovered defects
Fixed: report drawer initially nested inside page instead of shared dock host;
private MinIO image URLs unusable by browser (now authorized verified batch bytes);
missing original report version; existing report staff N+1 reads; unresolved
assignments incorrectly eligible for finalise; post-approval list scope too broad.
Test infrastructure: old lifecycle/replacement fixtures needed active employment;
Docker Chromium path needed Windows runner override; running local scheduler was
interfering with worker race fixtures, so it was paused for deterministic checks.
No production environment values were loaded from the checked-out .env.

## 30. Remaining work
No known implementation work within the requested desktop pipeline scope. Production
release is not performed. Before production: review the wider dirty workspace,
apply 1786673700000-OriginalTimesheetFile through the normal migration process, then
release API, worker and web together. No bootstrap/reset. Existing finalised rows
may acquire originals through the bounded worker scan; preserved older finalised
reports remain compatible. Retain shared storage and existing file policies.

Local deployment and temporary-fixture cleanup evidence: deployment.json,
worker-deployment.json, cleanup.json. See docs/HANDOFF.md for the latest local status.
