# Internal Manager Staff Selection Flow

Implemented 2026-09-28. Source changes are complete and tested; no API or production deployment was performed.

## Existing behavior discovered
ShiftApprovalDrawer used a two-character search dropdown and persisted each add/remove immediately. Venue Manager requests already stored recipients in shift_request_staff. Approval deliberately allows partial staffing and best-effort recipient sends, rejects zero selected/successful recipients, and derives recipients from persisted rows. These approval rules remain intact.

## Files changed
Frontend, under packages/rab-front/src/features/scheduling:
- ShiftApprovalDrawer.tsx
- StaffSelectionPage.tsx (new)
- staff-selection.css (new)
- ShiftApprovalDrawer.spec.tsx (new)

Minimal supporting API changes, under packages/rab-server/src:
- modules/staff/dto/list-staff.dto.ts: optional validated accountStatus filter.
- modules/staff/services/staff.service.ts: account-status SQL predicate on existing private list.
- modules/scheduling/dto/set-requested-staff.dto.ts (new): validated IDs and expected prior IDs.
- modules/scheduling/controllers/scheduling.controller.ts: guarded PUT requested-staff.
- modules/scheduling/services/scheduling.service.ts: atomic save, reused transaction helpers, capacity guard, employment-aware stillActive, parent-row locking.
- modules/offer/services/offer.service.ts: approval parent-row lock and ACTIVE employment revalidation; existing sendOne and partial-send semantics unchanged.
- __tests__/integration/venue-manager-scoping.integration.spec.ts: selection/denial/race tests; active fixture now activates both employment and account.

Documentation: THREAT-MODEL.md, docs/HANDOFF.md and this report. Existing unrelated edits, including prior changes within scheduling.service.ts/offer.service.ts, were preserved. Normal Users, mobile, RLS, authentication, worker implementations, attendance and payroll were not edited by this task.

## Shift Approval footer
Decline / Select N Staff / Approve. Approve's visible label is always exactly Approve. Full selection shows disabled Staff Complete with a check mark. Existing drawer removals remain immediate, as before.

## Balance calculation
Remaining = max(requiredCount - persistedSelectedCount, 0). Picker counts derive from its unique draft Set; drawer counts derive from refreshed persisted rows. Counts never come from mock production data.

## Select Staff screen
Full main-workspace selection mode, sidebar retained. Compact table, active pills, search, top-right Cancel/Confirm and pagination. Columns: checkbox, name, reference, email, phone, actual default rate, added date. No password/security fields, administrative Options or misleading Select All. Shared PageHeader, TableSkeleton, table/search/button/avatar/badge CSS are reused. Underlying covered workspace is inert while selecting; visible sidebar remains available. Request-open events cannot switch the active request during selection.

## ACTIVE-only filtering
GET /staff requests status=active and accountStatus=active, limit=25, with existing server pagination/search. Exact SQL fields: StaffProfile.employmentStatus = EmploymentStatus.ACTIVE AND User.status = UserStatus.ACTIVE. Frontend also rejects stale responses missing either state. Invited, invite_expired, suspended, deactivated and inactive employment never become selectable. No new status model. Other eligibility such as overlap remains authoritative at save and approval, using existing services; the picker does not invent an availability or qualification filter.

## Current selection preloading
Draft initializes from persisted staffProfileIds, preserving selections across search/page changes. Matching active rows are checked. Inactive recipients are flagged in the drawer and can be removed there; they are not added to the active-only table. Existing recipients outside the manager's private staff scope cannot be retained via the new save action.

## Capacity enforcement
A Set prevents duplicate selection. Further additions at capacity show a small explanatory message without toggling the extra checkbox. DTO rejects duplicate IDs; server checks capacity, and the legacy single-add endpoint also checks capacity under the same shift lock.

## Search
Debounced server-side name/email/reference query, 25 rows per page. Existing StaffService search and manager ownership predicates are reused. No expensive full-table client search. No fake filters/options.

## Confirm behavior
One PUT /shifts/:id/requested-staff carries desired IDs and the exact expected prior IDs. A transaction validates permission, pending status, org/workspace, private ownership, ACTIVE account/employment, availability, uniqueness/capacity and optimistic concurrency before applying changes. Existing per-person audit/removal-notification behavior is reused atomically. A failure rolls back all mutations. Network uncertainty is handled with a safe reload instruction, not a false promise that no write could have committed.

Confirm never calls approve, creates job offers, changes Shift to OFFERED, or notifies staff. Existing removal notifications to the requesting Venue Manager remain part of the saved selection change.

## Cancel behavior
Picker changes are local until Confirm. Cancel makes no selection mutation and restores/refetches the same drawer. It does not undo drawer removals explicitly made before opening the picker.

## Return-to-drawer behavior
Successful Confirm invalidates/refetches requested staff and Venue Offers counters before returning. The original request ID remains fixed. Errors stay on the picker with safe messaging. Empty results disable Confirm; loading uses table skeletons and failed loads offer Retry.

## Approve behavior
Existing POST approve body stays empty. Backend derives recipients from persisted shift_request_staff, preserving partial staffing/sends and existing duplicate/overlap protections. ACTIVE account revalidation was already present; ACTIVE employment is now also rechecked here. Save/add/remove/approve/decline lock the parent shift to prevent interleaved recipient edits and approval. No state-machine redesign.

## Workspace isolation
Verified server context supplies workspace and organisation; frontend supplies neither. StaffService.list retains createdBy = ctx.userId plus org scope and RLS. New save repeats private ownership and workspace checks in-service, alongside permission and route guards. Wrong-workspace staff, same-workspace other-owner staff, cross-org requests and Venue Manager writes are denied. Existing shared approval-queue visibility is unchanged.

## Tests
- Full rab-front suite: 100 passed (14 suites).
- Final targeted Select Staff frontend suite: 14 passed.
- Venue Manager/selection real-Postgres integration suite: 27 passed.
- Offer and resource-ownership integration regressions: 45 passed.
- Phase 4 replacement and same-org manager-isolation regressions: 58 passed.
Total backend integration checks across these suites: 130. Tests use local Docker Postgres with runtime RLS; the remote database in the developer .env was not used. EMAIL_DRIVER=LOGGER for test processes. Existing test fixtures and audit/outbox data are retained under isolated test organisations; no production accounts were modified.

Tests cover current selection, status exclusion, counts, capacity, search, cancel, atomic confirm with zero offers, subsequent persisted-recipient approval, duplicates, stale saves, concurrent saves, wrong scope, active-at-load/inactive-at-approval, safe errors and keyboard Space.

## Typecheck/lint
Both packages' configured lint commands are TypeScript --noEmit; both passed. Vite production build passed. Vite reports a bundle chunk above 500kB; no bundle-performance claim is made. Integration runs also report existing local Redis-version and test-runner deprecation warnings; suites pass.

## Visual QA
Real Chromium rendering through the full application shell at 1366x900, 1440x900 and 1920x900. Inspected table/sidebar, preselection, capacity feedback, search, empty/loading/error/retry and the settled returned approval drawer. Browser test asserts no horizontal body overflow and no page errors. Browser API fixtures are isolated synthetic data, not authenticated production accounts; real backend behavior was verified separately through HTTP integration tests.

Artifacts under .audit/select-staff/: selector-1366.png, selector-1440.png, selector-1920.png, capacity.png, empty.png, loading.png, error.png, confirmed-drawer.png; browser.cjs reproduces the visual exercise. Logs: frontend-tests.log, selection-tests.log, integration.log, regressions.log, worker-regressions.log and build.log.

## Release / next action
Release web and API together: the new accountStatus filter and PUT endpoint are required. No migration or dependency changes. The current local rab-server-1 runs a built image with no source mount and was NOT rebuilt/restarted during this task. Its old API will reject the new filter/endpoint until updated. Do not deploy the entire dirty working tree blindly; preserve/review the separate in-progress work. After an intended API/web release, review with a real Internal Manager account and pending Venue Manager request.

## Supporting correctness findings
- Medium: an authenticated approver could exceed requiredCount through the old single-add action because it lacked a capacity check. Fixed in SchedulingService.addRequestedStaffTx with parent-row locking and a count guard. Regression rejects the extra POST on a full request.
- Medium: an active account whose employment was inactive could pass approval's previous account-only check. Fixed in OfferService.approveShiftRequest by checking existing EmploymentStatus.ACTIVE before sendOne; regression proves the inactive recipient receives no offer while existing partial-send behavior remains.


Runtime update (2026-09-28): the subsequent loading fix and local API deployment supersede the source-only status above. See [load fix report](INTERNAL-MANAGER-SELECT-STAFF-LOAD-FIX.md).
