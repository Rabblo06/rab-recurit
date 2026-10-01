# Sent Shifts Projection + Offers Kanban UI Fix

2026-10-01. Source and isolated local verification. No production deployment, running QA container recreation or mobile installation.

## 1. Executive summary

Sent Shifts now reads one server-scoped submitted Shift per card, including requests awaiting approval. Progress comes from real offers and current assignments. Kanban columns grow into available space, retain readable minimum widths and scroll within the board when necessary.

## 2. Mobile Sent Shifts root cause

The screen grouped only VenueManagerProvider.offers from GET /offers. Submission creates a pending Shift and ShiftRequestStaff selection rows, not JobOffers. That data source cannot show preapproval requests although Home's GET /shifts does. Counters also counted individual staff offers, and the screen did not periodically refresh.

The reported postapproval empty screen is NOT reproduced in the clean fixture: the old /offers returns all five approved offers. Its query already scopes assigned venues and has no hidden default status filter. No claim is made that its staff/user joins or parsing caused that particular screenshot. The new projection avoids depending on identity joins for aggregate counts.

Environment evidence: Flutter defaults to API port 3000 unless API_URL is supplied; QA web uses 3101. The installed mobile binary's URL was not extracted. The running QA API's compiled scheduling.service.js lacks listSentShifts. This proves it is stale relative to this fix, not the cause of the original screenshot.

## 3. Existing backend workflow discovered

SendShiftScreen -> POST /shifts/request -> SchedulingService.submitRequest -> pending Shift and selected ShiftRequestStaff -> Internal Manager approval -> canonical OfferService offer/assignment creation -> staff response/assignment lifecycle.

## 4. Venue Manager submission state

The existing post-submit provider refresh now includes the request. Copy is Waiting for manager approval. Required headcount and default scheduled times are visible. No offer exists, so Sent/Accepted/Confirmed remain zero.

## 5. Internal Manager approval state

Approval changes createdBy to the approving Internal Manager but preserves requestedBy. The new projection scopes by original requestedBy, so the same card survives approval. Approval mutations are unchanged.

## 6. JobOffer creation

Existing approval creates five offers/assignments for five selected staff in the real integration fixture. No extra writes or duplicate records were added. This Venue Manager workflow automatically confirms staff acceptance; no additional confirmation step is invented.

## 7. Existing Sent Shifts data source

Previously /offers grouped by shiftId, with individual-row counters. Home separately read /shifts. Generic offers remain available for authorized individual detail rows.

## 8. Corrected Sent Shifts projection

New GET /shifts/sent returns {data,total}; GET /shifts/sent/:id returns the same view or 404. Routes precede /shifts/:id. Rows contain id, canonical status, requiredCount, filledCount, startsAt/endsAt, submittedAt, venueName, roleName, offerCounts, statusLabel, filters and counters. No client scope selectors.

## 9. Aggregate shift model

One Shift per row. Counts use the latest offer per shift/staff, avoiding repeated-offer inflation. Historical sent recipients include terminal offers. Accepted/confirmed use assignment status; confirmed/completed assignments match the web pipeline's confirmed count. A cancelled assignment does not count merely because its historical offer remains manager_confirmed. The initial regression caught and corrected that case. Individual time windows remain separate from default shift times.

## 10. Sent / Accepted / Confirmed counters

Each counts shifts, not staff:

- Sent: at least one real offer exists, including historical delivery for terminal shifts.
- Accepted: an active shift has at least one currently accepted/confirmed assignment.
- Confirmed: an active shift has confirmed assignments meeting requiredCount.

Cancelled/completed/declined whole shifts do not count as active Accepted/Confirmed. These are overlapping progress counters. Card accepted headcount includes confirmed staff.

## 11. Filter behavior

All includes every authorized submitted shift. Pending includes pending-manager requests or pending offers on offered assignments. Accepted includes current accepted/confirmed staff. Confirmed requires all required places. Declined includes a declined request or staff decline on an active shift. The filter sheet retains expired/withdrawn/rejected and adds cancellation/completion. Cancellation includes a cancelled request or staff assignment. Mixed responses may appear in multiple relevant tabs, while remaining in All. Filtered-empty and genuinely empty states remain distinct.

## 12. Polling/refresh behavior

Five-second polling reuses provider.refresh while the route is current and no request is in flight; the timer is disposed on exit. Existing manual/submission/resume refresh remains. Loaded content stays mounted during refresh, retaining search/filter state and stable card keys. Permission/load errors still fail closed rather than silently displaying an empty success.

## 13. Workspace/RLS security

Existing authentication and SCHEDULE_VIEW guard, a service-level permission check, and ResourceScopeService venue scope are required. SQL restricts organisation, requested_by=session user and assigned venues under TenantContextService's existing workspace/org RLS. Aggregate reads use authorized shift IDs and organisation via rab_app. No owner business reads, grants, policies, schema changes or RLS weakening.

## 14. IDOR tests

New tests deny foreign organisation, sibling workspace and same-venue different submitter: empty list and 404 detail. Internal Manager access to this Venue Manager projection is forbidden. Existing venue/offer/request ownership and workspace suites pass. Shift, assignment and offer tables retain ENABLED/FORCED flags. Existing detail contracts were not broadened.

## 15. Mobile widget tests

Full Flutter suite: 383 passed, including 46 Venue Manager tests. New coverage verifies preapproval visibility, truthful zero counters, one postapproval card, polling, retained search text and tabs. Final capture rerun: five passed, with confirmed/declined headcount assertions and four phone widths. MockClient fixtures are test-only; no claim of native authenticated device QA.

## 16. Kanban root cause

Non-growing fixed columns constrained readable card space and did not distribute spare width. Seven stages naturally exceed many sidebar content regions. The card-header flex row allowed name/menu competition. A separate existing browser-wide overflow defect was not reproduced; explicit containment now enforces the intended boundary.

## 17. Previous layout rules

Board display:flex, 12px gaps, overflow-x:auto. Columns flex:0 0 235px with 230px narrow override. Cards had padding without explicit width/box sizing; header used flex and a 5px gap.

## 18. New responsive layout

Pipeline and board use 100% of the actual content container, min-width:0 and border-box sizing. Columns share spare width. No 100vw workaround or body overflow masking was introduced.

## 19. Column sizing

flex:1 0 260px. Seven columns plus six gaps need 1892px of board space. At 1920px with sidebar/padding, board scrolling is intentional. At 2560px the fixture's 2294px board distributes width to approximately 317px per column with no horizontal scroll.

## 20. Card sizing

Cards occupy 100% of inner column width. Header grid minmax(0,1fr) auto reserves menu room. Names wrap/clamp at three lines, retain full accessible text and title; roles wrap safely. Menu popover starts below the actual summary height, including enlarged text.

## 21. Horizontal overflow behavior

Only .pipeline-board scrolls horizontally when minimum widths cannot fit. Measurements at 1024/1280/1440/1920/2560 show document width equal to viewport width and cards filling the inner column. Existing main-content min-width:0/overflow containment is unchanged.

## 22. Empty columns

All seven backend stages and the existing No staff in this stage placeholders remain, with consistent column sizing. No stages or business states were hidden or renamed.

## 23. Polling stability

React Query's five-second interval and offerId/stage keys remain. DOM tests retain board/card nodes, scrollLeft and an open menu across refresh. Existing stage-movement test passes. Real browser scrolling remains at 500px after an interval.

## 24. Accessibility

Semantic staff buttons and native details/summary disclosure remain keyboard accessible. Explicit focus outlines added; Enter opens the menu in browser checks. Full names remain accessible despite clamping. 200% text checks show no body overflow and usable menus. This is targeted coverage, not a full WCAG certification.

## 25. Responsive/visual tests

Playwright renders the actual component, global app stylesheet and shell sizing classes with a labelled isolated sidebar/API fixture. Captures: 1920x1080, 1440x1080, 1280x1080, 1024x1080, 2560x1080, open menu and 200% text. Zero page errors. Flutter captures cover 320/375/393/430 logical widths and pending/sent/confirmed/declined responses. Fixtures never enter production code.

## 26. Shift -> request -> offers mapping

The request is the Shift itself with ShiftRequestStaff selection rows, not a duplicated aggregate. The five-staff test proves one Home row, one Sent Shifts row, five identical pipeline offer IDs and one matching listMine offer for EACH staff member, all attached to the submitted shift ID.

## 27. Mobile/web consistency proof

Real API/service tests compare web and Sent Shifts confirmed totals after each of five acceptances. Full confirmation counts one shift. Cancelling one booking reduces confirmed headcount from five to four and removes full confirmation. Real decline remains visible. Separate widget/component fixtures verify rendering; screenshots are not a live cross-client session.

## 28. Files changed

Task-specific changes preserve all earlier dirty work:

- Server scheduling controller/service; new sent-shift-presentation.ts and its spec; venue-manager-scoping.integration.spec.ts.
- Mobile venue_manager/sent_shift.dart (new), sent_shifts_screen.dart, venue_manager_provider.dart, venue_manager_screens.dart (optional refresh presentation), test/venue_manager_test.dart.
- Web scheduling/venue-offer-pipeline.css, VenueOfferPipeline.tsx (full-name title only), VenueOfferPipeline.spec.tsx.
- This report, docs/HANDOFF.md, THREAT-MODEL.md.

Ignored evidence/scripts live in .audit/sent-shifts-fix and mobile .qa-screenshots/venue-manager. No worker/auth/production infrastructure changes.

## 29. Server changes

Two scoped read endpoints and a read-only presentation helper were needed because /offers cannot represent pending requests. No write/state-transition changes. Deploy API support before the mobile provider: the new endpoint is required and a missing/denied endpoint yields an error rather than a false empty list.

## 30. Migrations

NONE. Existing requested_by, shift defaults, assignments, offers and RLS are sufficient.

## 31. Regression results

113 unique server test cases across six suites, 23 web tests across three suites, 383 Flutter tests. Final strengthened mapping-only rerun passed two tests (38 intentionally excluded after the full 40-test suite passed). Final mobile capture rerun passed five tests. Reruns are not double-counted; identically named parameterized cases remain distinct.

See .audit/sent-shifts-fix/verification-summary.json for evidence. Initial test-helper typo, the cancelled-assignment aggregation bug and a test Unicode separator artifact were corrected. Their earlier failures remain recorded. Final relevant runs pass. Existing ts-jest warnings, Jest forceExit and Vite chunk-size warning remain; no open-handle certification is claimed.

## 32. Flutter analyze

Clean: No issues found, flutter-analyze-clean.log. A multiline-if brace warning was corrected without behavior change; subsequent mobile edits only strengthened test assertions/captures.

## 33. Frontend lint/build

Server/frontend type-check lint and builds pass. Latest server build includes assignment-count correction; latest frontend build includes long-name/menu refinement. Logs: server-lint-final.log, server-build-final.log, front-lint-final.log, front-build-final.log. Existing Vite >500kB warning remains.

## 34. Screenshots / visual verification

[Desktop](../.audit/sent-shifts-fix/kanban-1920.png), plus kanban-1440.png, kanban-1280.png, kanban-1024.png, kanban-2560.png, kanban-menu.png and kanban-text-200.png in the same evidence directory. Measurements: visual-results.json.

Mobile: [pending](../packages/rab-mobile/.qa-screenshots/venue-manager/sent-request-before-approval.png), [sent](../packages/rab-mobile/.qa-screenshots/venue-manager/sent-request-after-approval.png), [confirmed](../packages/rab-mobile/.qa-screenshots/venue-manager/sent-request-confirmed.png), [decline responses](../packages/rab-mobile/.qa-screenshots/venue-manager/sent-request-declined.png). These are local ignored artifacts. Pending/confirmed and final desktop/enlarged-text captures were visually inspected; automated checks also covered all requested widths.

## 35. Remaining work

Source fixes are verified locally. Running QA API3101 is compiled and lacks this projection; rebuild/recreate it through the existing QA procedure before using updated mobile. QA front5174 bind-mounts current source. Run Android emulator mobile against the same API with --dart-define=API_URL=http://10.0.2.2:3101/rest/v1; default3000 points at old dev. No mobile installation, authenticated manual workflow, container replacement or production release was performed. Confirm the original postapproval screenshot against matching running artifacts; its precise cause remains unproven.

Manual-QA records remain untouched. Tests used existing disposable loopback audit PostgreSQL55439/Redis56389, LOGGER mail and local storage, rather than inserting into available manual-QA or old dev databases. The broader report/timesheet UI audit remains unresumed.
