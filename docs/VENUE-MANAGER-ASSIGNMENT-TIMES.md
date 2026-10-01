# Venue Manager - Send Shift / Staff / Reports UI Update

Date: 2026-09-30. Scope: existing application plus explicitly approved assignment-time dependency.

## 1. Executive summary

Implemented the existing Venue Manager draft UI and approved individual-time propagation. Verification evidence below is local/disposable; no production deployment or real outbound messages.

## 2. Existing navigation architecture

Existing IndexedStack with four persistent nested Navigators and MovingTabBar. Kept provider, route ownership, back handling and root destinations.

## 3. Navigation changes

Root Home/Calendar/History/Profile: navigation remains visible. Every pushed workflow route: bottomNavigationBar is null, removing layout height and hit targets. System Back restores the root bar. No opacity-only hiding.

## 4. Send Shift before

Existing form had More options with Notes/pay controls and selected IDs without individual schedule intent.

## 5. Send Shift after

Venue/Role, Date, start/end, break and selected-count controls retained. Selected staff cards show real draft identity, status, assignment window and edit action. Final CTA remains Send Shift Offer.

## 6. More Options removal

Removed the More options UI.

## 7. Notes removal

Removed Notes input and controller. Request service does not persist a submitted note. Existing unrelated shift notes remain unchanged.

## 8. Venue Manager pay override removal

Removed pay override input/controller and request DTO property. Service rejects an override even for direct internal calls. Internal Manager pay controls elsewhere remain unchanged.

## 9. Selected Staff section

White rounded selected-person cards with initials, name, employment status, dark time/edit pill. Narrow/large-text layouts stack the time action below identity. No fabricated staff data.

## 10. Select Staff draft-selection flow

Picker receives a copy of committed selection. Submit commits only to the local draft; Cancel/system Back discard picker edits. No offer is sent by picker Submit.

## 11. Selected count

Derived from draft.assignments; no independently mutable count. Existing mobile request uses selected team size as staffRequired. Backend requiredCount remains a separate capacity concept.

## 12. Per-staff time model

ShiftAssignmentDraft owns a map of StaffAssignmentDraft entries. Each contains staff, full startsAt/endsAt and customised flag. Server reuses existing ShiftAssignment.period as the canonical approved schedule.

## 13. Default assignment time behavior

New selections inherit the parent window; deleting then reselecting creates a fresh default. Unchanged selected IDs retain their custom window.

## 14. Time-edit UI

Existing Material time pickers inside a compact modal. Cancel does not commit. Save is disabled for invalid containment/duration/break. Edit action has a staff-specific semantic label.

## 15. Overnight shift handling

Full dates cross midnight; UTC ISO timestamps on the wire. HH:mm and (+1 day) display; no invalid 24:00/AM/PM mixture. Next civil date construction preserves local daylight-saving semantics.

## 16. Parent shift-time changes

Parent changes update only non-custom entries. Custom entries retain their times and become visibly invalid if outside the new parent window. Invalid draft disables submission.

## 17. Custom-time persistence

Draft identity map survives picker visits. Request selection starts_at/ends_at persist through manager review and approval into assignment.period. Existing bulk-offer path also transports optional assignment windows.

## 18. All Users UI

Existing scoped All Users browser, search, filters, availability and add-to-team actions retained. Nested navigation hidden.

## 19. Users UI

Existing scoped Users roster and actions retained. Nested navigation hidden. The existing plus action opens the authorized All Users/add-to-team flow.

## 20. Add User UI

Repository inspection found no separate Flutter Add User/create-account form in this Venue Manager module. Preserved its existing add-to-team flow and server permissions; did not invent account-creation authority. A distinct creation form remains outside this change unless its intended existing route is supplied.

## 21. User Details UI

Existing user detail data/actions and server authorization retained; nested navigation hidden.

## 22. Reports UI

Existing Reports list/detail and scoped API retained. Individual report rows now display scheduled start/end separately from actual clock-in/out. Finalisation and correction workflow unchanged.

## 23. State-management changes

One committed assignment map; picker has a temporary editing copy. No second selected-ID state or duplicate selected count.

## 24. API payload changes

Optional staffAssignments: [{staffProfileId, startsAt, endsAt}] on request and existing authorized bulk-send DTOs. Full timestamp validation includes timezone. Existing staffProfileIds remains for backward compatibility; omitted windows inherit parent.

## 25. Backend validation changes

Reject duplicate/unknown assignment IDs, out-of-parent windows, invalid ordering/dates and break that consumes the assignment. Revalidate active account/employment, authorized pool and live availability. Server-derived identity/workspace retained.

## 26. Venue authorization

Existing venue relationship and scope checks remain; no client-supplied manager/organization identity accepted.

## 27. Staff/workspace isolation

Existing tenant context, workspace predicates, resource ownership and RLS remain. New request columns do not change policies. No assignment-table RLS disabling was added.

## 28. Availability revalidation

Directory refetch behavior retained. Request submit and approval use each proposed window. Manager review/picker availability reads saved windows for existing selections. Busy-for-parent staff can enter the mobile draft for a narrower time; final server submission remains authoritative.

## 29. Overlap/concurrency protection

Existing canonical availability query and GiST exclusion remain. Actual confirmation is the commitment protected from double booking; pending requests do not reserve staff. Do not claim that concurrent pending requests are exclusive reservations.

## 30. Per-assignment time validation

Dates, containment, positive duration and shared parent break checked server-side and in draft. Break remains parent-level; no new per-person break policy.

## 31. Pay-rate security

Pay rate comes from existing server resolver. Estimated pay uses individual scheduled duration minus the existing parent break via shared money helpers. Actual attendance/payroll facts are not replaced by schedule.

## 32. IDOR negative tests

Established venue-manager-scoping, scheduling/offer-abuse, attendance-abuse and resource-ownership suites rerun against disposable PostgreSQL/Redis with real RLS. Cross-tenant/workspace/venue/pool and tampering assertions retained.

## 33. Flutter widget tests

47 tests passed: Venue Manager widgets plus assignment-draft tests. Includes picker Cancel/Submit, root/nested Back, duplicate-send guard, narrow displays, large text and overnight editor. Existing navigation assertions changed only where the requested hidden-nav behavior superseded them.

## 34. Server integration tests

139 tests passed across five focused server suites on the final expanded propagation assertions (server-final.log). New tests exercise request persistence/approval, canonical range parsing, boundaries, break, individual clock-in window and legacy fallback.

## 35. Existing regression tests

222 tests passed across nine worker suites; 37 manager UI tests passed across three suites. A final targeted monitor run covers the subsequent exact-end discovery change and earlier-individual-end regression.

## 36. Build / flutter analyze

Flutter analysis clean. Four-package build and server lint passed. Normal Android profile APK built successfully from lib/main.dart (not a fixture). Final verification log paths below.

## 37. Visual QA

Fresh production-widget captures inspected for selected-staff layout and 320px large-text overnight layout. Capture suite covers Users/All Users/Reports/form/selection and 320,375,393,430px layouts. Some inherited Material text styles use widget-test fallback glyphs in captures; do not represent these as native screenshots. No physical-device verification claimed.

## 38. Files changed

See task file inventory below. Existing extensive unrelated work was preserved; no commit/reset/stash used.

## 39. Schema/migration changes

Append-only 1786674200000-RequestAssignmentTimes adds nullable starts_at/ends_at to core.shift_request_staff with both-null-or-positive-window CHECK. Existing approved assignment.period reused. Upgrade and complete fresh-database migration chain passed only on disposable audit databases (fresh database used the existing core-schema bootstrap). Down/up checked inside a transaction and rolled back; RLS enabled+forced asserted. No historical backfill.

## 40. Existing security invariants preserved

Approval chain, staff accept/manager confirm state machine, JWT/session behavior, QR validation, geofence, ownership, cancellation/replacement and worker idempotency retained. The parent still drives intentionally shift-level QR/report/lifecycle timing.

## 41. Newly discovered issues

Existing Add User is add-to-team rather than a create-account form. Missing-clock-out discovery needed exact individual-end filtering before its limit; now scoped by workspace with assignment RLS active. Prior unapproved RLS-disable proposal was rejected and never applied. Build reports an existing large web bundle warning.

## 42. Remaining work

No production migration/deployment or signed release distribution performed. Native authenticated device smoke test remains a release check. Existing Add User route discrepancy is documented in section 20. See final verification update for any remaining failed/pending checks.

## Per-Staff Assignment Time Propagation

| Consumer | Authoritative source |
| --- | --- |
| Draft and request intent | Individual full timestamps, persisted on shift_request_staff |
| Manager review/approval | Saved request window; approval creates assignment.period |
| Offers, staff upcoming/history projection | lower/upper assignment.period through assignmentTimeSql |
| Availability/overlap | Proposed individual range and existing GiST exclusion |
| Estimated pay | Individual duration; unchanged parent break/rate rules |
| Attendance admission | effectiveAssignmentTime passed to existing clock-window validation |
| Late-clock / reminder / no-show | Individual start for scan, evaluation and message |
| Missing clock-out | Individual end + existing 30-minute grace; scoped exact query, unchanged actual attendance |
| Reports / timesheets | Individual scheduled fields; actual clock timestamps unchanged |
| Legacy reads | Missing period falls back to parent; no read-time mutation |
| Shift-level lifecycle / QR / report scheduling | Overall parent window intentionally retained |

Canonical helpers live in scheduling/utils/assignment-time.ts. Invalid nonempty ranges fail rather than silently inheriting a different schedule. The database already stores parent-equivalent period for normal legacy assignments.

Evidence: .audit/venue-assignment-times/{server,worker,worker-monitor,front-tests,flutter-final,flutter-analyze-final,server-lint-final,build,android-build,migrationcheck}.log. Test fixtures use dedicated loopback audit services, local storage, logger or test-local SMTP; no production services. Widget images: packages/rab-mobile/.qa-screenshots/venue-manager/.

Deployment order: apply the new migration with the existing migration process, deploy server and worker together, then publish the mobile app/web review update. Old clients can omit staffAssignments; old requests inherit parent times. Avoid downgrading server/worker after individual assignments are in use because old consumers would show parent times. Never run migration down on production records merely to roll back application code.

## Task file inventory

- packages/rab-mobile/lib/features/venue_manager/send_shift_screen.dart
- packages/rab-mobile/lib/features/venue_manager/shift_report.dart
- packages/rab-mobile/lib/features/venue_manager/venue_manager_screens.dart
- packages/rab-mobile/lib/features/venue_manager/venue_staff_directory.dart
- packages/rab-server/src/modules/attendance/services/attendance.service.ts
- packages/rab-server/src/modules/attendance/services/shift-report.service.ts
- packages/rab-server/src/modules/attendance/templates/pre-shift-report.html.ts
- packages/rab-server/src/modules/offer/dto/send-bulk-offer.dto.ts
- packages/rab-server/src/modules/offer/services/offer.service.ts
- packages/rab-server/src/modules/offer/services/venue-offer-pipeline.service.ts
- packages/rab-server/src/modules/scheduling/dto/submit-shift-request.dto.ts
- packages/rab-server/src/modules/scheduling/entities/shift-assignment.entity.ts
- packages/rab-server/src/modules/scheduling/entities/shift-request-staff.entity.ts
- packages/rab-server/src/modules/scheduling/services/scheduling.service.ts
- packages/rab-worker/src/queues/rab-reports/final-timesheet.job.ts
- packages/rab-worker/src/queues/rab-reports/shift-report-scheduler.job.ts
- packages/rab-worker/src/queues/rab-shifts/attendance-monitor.job.ts
- packages/rab-worker/src/queues/rab-shifts/late-clock-in.job.ts
- packages/rab-worker/src/queues/rab-shifts/shift-monitor.job.ts

Additional files: new assignment draft/helper/tests/migration, manager review type/display, docs/HANDOFF.md, THREAT-MODEL.md, and this report. See git diff for pre-existing changes; repository-wide dirty status is not this task's change list.

## Final verification update

- Server: **139 passed / 5 suites**, `server-final.log` and `server-final.json`. Explicit overnight test now verifies request/review persistence, approved assignment period, staff offer display, pay calculation, non-overlap before midnight, true overlap after midnight, and report scheduled fields. Separate real QR-backed attendance test proves a later assignment is not eligible merely because its parent has started.
- Workers: **222 passed / 9 suites**, `worker.log`/`worker.json`; additional targeted run reported **61 passed / 3 suites**, including the new earlier-individual-end missing-clock-out test and later-individual-start late-clock test. The latter log (`worker-monitor.log`) contains interleaved output from an interrupted earlier server runner whose child completed later; its JSON was subsequently overwritten. Do not treat that file as clean standalone final evidence.
- Requested clean final monitor rerun **BLOCKED by automatic approval review**. Review rejected running the pre-existing attendance/shift RLS-disable discovery path, even on verified disposable containers. Read-only comparison proved these statements are unchanged from the pre-task snapshot; the new assignment reads retain RLS. A retry with that evidence was also rejected. No workaround or further execution attempted. User approval is needed to rerun this existing worker behavior. Do not mark this task fully verified until that final evidence is recorded.
- Frontend: **37 passed / 3 suites**, `front-tests.log`.
- Flutter: **47 passed**, `flutter-final.log`; `flutter-analyze-final.log` clean.
- Server lint and final shared/server/worker/frontend builds passed. Normal Android profile APK built at `packages/rab-mobile/build/app/outputs/flutter-apk/app-profile.apk`.
- Migration: upgrade, full fresh chain after standard bootstrap, and transactional down/up with RLS enabled/forced passed. Production data untouched.
- Native authenticated device smoke test and coordinated deployment remain release work. No physical-device, production-deployment, or full-completion claim.

Additional changed/new source files not present in the initial folder snapshot include:

- `packages/rab-mobile/lib/features/venue_manager/shift_assignment_draft.dart`
- `packages/rab-mobile/test/shift_assignment_draft_test.dart`
- `packages/rab-mobile/test/venue_manager_test.dart`
- `packages/rab-server/src/modules/scheduling/utils/assignment-time.ts`
- `packages/rab-server/src/modules/scheduling/utils/assignment-time.spec.ts`
- `packages/rab-server/src/modules/scheduling/entities/shift-assignment.entity.ts` (canonical-field comment)
- `packages/rab-server/src/database/typeorm/core/migrations/1786674200000-RequestAssignmentTimes.ts`
- `packages/rab-server/src/__tests__/integration/venue-manager-scoping.integration.spec.ts`
- `packages/rab-server/src/__tests__/integration/attendance-abuse-cases.integration.spec.ts`
- `packages/rab-worker/src/__tests__/integration/late-clock-in-correctness.integration.spec.ts`
- `packages/rab-worker/src/__tests__/integration/worker-event-idempotency.integration.spec.ts`
- `packages/rab-front/src/features/scheduling/StaffSelectionPage.tsx`
- `packages/rab-front/src/features/scheduling/ShiftApprovalDrawer.tsx`
