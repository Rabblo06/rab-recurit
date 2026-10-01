# Internal Manager Select Staff Load Fix

Date: 2026-09-28. Local implementation and running API verified. No UI redesign.

## Failed request discovered

Endpoint: `GET /rest/v1/staff?status=active&accountStatus=active&page=1&limit=25&sort=name&direction=asc`

HTTP status: **400**.

Safe response: `{"message":["property accountStatus should not exist"],"error":"Bad Request","statusCode":400}`.

Reproduced through the actual local browser login and pending Venue Manager request before the fix. Evidence: `.audit/select-staff-load/failed-request.json`, `before.png`.

## Root cause

The live frontend used the newer accountStatus filter, but rab-server-1 ran an older compiled image without source mounts. Its validation DTO rejected the parameter. This was not a Venue Manager pool permission failure. Source changes alone could not repair the running API.

## Old data source

Generic `/staff` with client-provided active filters. Normal Users routes remain unchanged by this fix.

## New data source

`GET /rest/v1/shifts/:id/selectable-staff?q=...&page=1&limit=25`.

Dedicated Internal Manager endpoint with ManagerApplication, STAFF_VIEW, STAFFING_REQUEST_APPROVE and workspace guards. Service repeats permissions and validates a pending Venue Manager request in the authenticated organisation/workspace. Returns only id, firstName, lastName, staffRef, email, phone, defaultPayRatePence, employmentStatus, accountStatus, createdAt and available, plus total. No HR, password or invitation data. Invalid client scope/status/time overrides are rejected.

## ACTIVE account enforcement

SQL joins a real User and requires UserStatus.ACTIVE. Frontend retains a defensive typed active check.

## ACTIVE employment enforcement

SQL requires a real StaffProfile with EmploymentStatus.ACTIVE. Inactive combinations are covered by integration tests; filtering happens before pagination.

## Manager/workspace isolation

Authenticated organisation, workspace and user determine scope. StaffProfile.createdBy must equal the manager user ID. Cross-organisation/workspace and other-manager records are excluded. Venue Manager caller is denied. The existing Venue Manager directory remains Venue-Manager-only (Internal Manager receives its existing 404). No RLS/auth architecture changes.

## Availability behavior

Canonical AvailabilityService.findBusyStaffIds uses the saved shift start/end and excludes that shift. Active busy staff can appear but are labelled Unavailable and cannot be newly selected. Existing busy selection can be unchecked. Requested-staff response also flags availability for the drawer. Save revalidates all recipients, including selections outside the currently displayed page; stale eligibility is rejected rather than silently accepted.

## Search

250ms debounce. Server searches first name, last name, full name, email and staff reference with existing escaped ILIKE helper. Selection survives searches.

## Pagination

Real SQL count/offset/limit with stable first-name, last-name and ID order. Frontend uses 25 rows per page. Integration covers pages; frontend tests cover page-two selection retention. Real browser session additionally verified distinct API pages using limit=1 (the isolated live fixture has two staff).

## Existing selection handling

Saved recipients prepopulate the local draft Set. Selection survives searching and paging. Inactive/stale recipients remain visible in the approval drawer with eligibility warnings; unavailable active recipients can be deselected. Cancel discards the draft. Optimistic expected prior IDs prevent overwriting a concurrently changed selection.

## Confirm behavior

Confirm calls existing atomic PUT requested-staff and returns to the drawer. It sends no offers. Approve remains a separate action using the persisted recipient list.

Real browser/API proof: saved Alpha only, zero offers after Confirm, then exactly one successful offer for Alpha after Approve. No API data mocks. A deliberate transport abort tested the error/Retry state, then real networking resumed. One initial assertion used a brittle drawer text locator; the save had succeeded. Repeated verification with a stable control assertion passed.

## Files changed

- packages/rab-server/src/modules/scheduling/dto/list-selectable-staff.dto.ts (new)
- packages/rab-server/src/modules/scheduling/controllers/scheduling.controller.ts
- packages/rab-server/src/modules/scheduling/services/scheduling.service.ts
- packages/rab-server/src/__tests__/integration/venue-manager-scoping.integration.spec.ts
- packages/rab-front/src/features/scheduling/StaffSelectionPage.tsx
- packages/rab-front/src/features/scheduling/ShiftApprovalDrawer.tsx
- packages/rab-front/src/features/scheduling/ShiftApprovalDrawer.spec.tsx
- THREAT-MODEL.md
- docs/HANDOFF.md
- docs/INTERNAL-MANAGER-STAFF-SELECTION.md (runtime-status pointer)
- this report; local evidence under .audit/select-staff-load/

Earlier unrelated dirty changes were preserved. No changes to normal Users, mobile, Venue Manager directory, attendance, calendar, payroll or offer lifecycle for this fix.

## Backend tests

30 real local PostgreSQL/RLS integration tests pass. Includes scope, minimal response, active account/employment combinations, availability, search, pagination, override rejection, existing atomic save and approval flow. No remote .env database used. Evidence: integration.log.

## Frontend tests

103 tests in 14 suites pass; focused drawer/selector suite: 17 pass. Includes loading, failure/Retry, unavailable disabled rows, pagination, selection, Cancel and separate Confirm/Approve. Evidence: frontend-all.log and frontend.log.

## Typecheck/lint

Frontend and server TypeScript checks pass (package lint uses TypeScript). Normal server Docker compilation passes, including shared dependencies. No new dependencies or migrations.

## Visual QA

Actual Chromium browser, real local Vite frontend and API, synthetic test records. Screenshots reviewed at 1366x900, 1440x900 and 1920x900. Sidebar and existing full-page table retained, no body horizontal overflow. Drawer returns after Confirm. Evidence: loaded-1366.png, loaded-1440.png, loaded-1920.png, confirmed-drawer.png, live-verification.json.

## Local runtime and cleanup

Built local image rab-select-staff-api:local from current workspace source using a sanitized build context. Canary API on port 3002 passed health and actual selector HTTP 200 before replacing only rab-server-1 on port 3000. Preserved local environment/network; no migrations/bootstrap ran. Worker container was not replaced. API is healthy. This is a local runtime update, not a production deployment; the image includes current workspace source, including pre-existing changes, and should not be promoted as an isolated production patch without review.

Automatic review rejected an initial organisation-wide fixture cleanup proposal. A read-only query then proved the four exact synthetic identities, and an explicitly narrowed cleanup succeeded: cancelled only the QA shift, suspended those four accounts, cleared their test credentials and revoked their sessions. Audit/history retained. Temporary private credential/config files removed. Other accounts untouched.

Deployment and cleanup evidence: deployment.json, cleanup.json. Previous report's source-only/no-deployment limitation is superseded for this local API. Next action: reload the local browser and review an existing pending request; production release remains a separate reviewed deployment.
