# Venue Manager Send Shift — Assignment Break / DTO / Success UX Fix

## 1. Executive summary
Individual assignment times can extend beyond the entered defaults. Nullable per-person breaks flow through request, approval, offers, attendance calculations and reports. The local stale API was refreshed. Successful request submission displays a centered confirmation sheet with truthful approval wording.

## 2. Root cause of staffAssignments DTO error
Verified stale runtime: Flutter POSTs /shifts/request; SchedulingController uses SubmitShiftRequestDto. Source already decorated staffAssignments, but rab-server-1 (image rab-venue-pipeline:local, node packages/rab-server/dist/main.js, no source mount) had no staffAssignments property in its compiled DTO. Checked via container filesystem before changes. No duplicate field or whitelist bypass was added. Refreshed compiled artifacts now contain staffAssignments and nested breakMinutes; /healthz returns 200.

## 3. Previous API contract
Source supported staffProfileIds plus optional staffAssignments with staffProfileId, startsAt and endsAt. Individual windows were constrained to parent times and all staff inherited the parent break. The running older API rejected staffAssignments.

## 4. Final API contract
POST /rest/v1/shifts/request retains venueId, jobRoleId, startsAt, endsAt, staffRequired, staffProfileIds and optional parent breakMinutes. staffAssignments accepts staffProfileId, full startsAt/endsAt timestamps and nullable breakMinutes. Omitted assignment entries default to entered times; omitted/null individual break inherits the parent. Bulk offers reuse the nested DTO.

## 5. DTO changes
Added optional, non-negative integer breakMinutes to RequestedStaffTimeDto. Nested ValidateNested/Type remain. Bulk staff IDs are unique. No client authority fields added.

## 6. Validation whitelist preservation
ValidationPipe whitelist and forbidNonWhitelisted remain unchanged. Tests accept valid nested assignments/null breaks and reject hackerField, nested workspaceId, negative/fractional/string breaks. Service checks remain independently enforced.

## 7. Previous individual-time restriction
StaffAssignmentDraft.valid and validateAssignmentTime required start >= parent start and end <= parent end. The editor disabled Save with a containment message.

## 8. New individual-time semantics
Containment removed from client and server. Valid complete timestamps, start < end and effective break shorter than individual duration remain mandatory. Existing full-date overnight windows remain canonical.

## 9. Default shift vs assignment time
New staff inherit the main time. Custom times survive picker navigation/default changes. Break-only edits do not mark time customized. Shift.defaultStartsAt/defaultEndsAt preserve the original defaults when the operational parent expands. Historical null defaults fall back to existing parent times. Newly added manager-review staff use preserved defaults.

## 10. Optional individual break
The rounded editor has Start time, End time, numeric Break (minutes) (Optional), Cancel and Save. Blank is allowed. Invalid values disable Save with duration/break wording rather than containment wording.

## 11. Break inheritance
Null/omitted inherits shift.breakMinutes; explicit zero is a real override. Custom break must be an integer >=0 and < assignment duration. No new arbitrary maximum was invented; none existed in this domain validation.

## 12. Break persistence
Nullable break_minutes columns on shift_request_staff and shift_assignment preserve intent through approval. Saved request selection retains existing rows and their values. Manager review shows the effective break and whether inherited.

## 13. Effective break helper
One effectiveAssignmentBreakMinutes helper in scheduling/utils/assignment-time.ts. Offer pay, attendance clock-out/correction, report projection and final timesheet rendering use it. Actual attendance break corrections retain precedence over scheduled assignment break.

## 14. Pay calculation
Existing computeWorkedMinutes and payForMinutes use individual start/end and effective break. No floating-point money formula added. Integration covers a nine-hour individual overnight window with a 60-minute break, persisted approval and matching estimated pay.

## 15. Availability / overlap
Submission and approval check the actual individual interval; database GiST confirmation exclusion is unchanged. Extended-range conflict coverage includes hours beyond the original parent end. Canonical employment/account eligibility remains enforced. Test seeds that omitted active employment were corrected rather than weakening guards.

## 16. Effective overall shift window
Persisted startsAt/endsAt form a conservative operational envelope: min(default, proposed starts), max(default, proposed ends). Request creation stores this envelope plus original defaults and explicit selection windows. Offer insertion expands it transactionally using SQL LEAST/GREATEST, preventing one bulk recipient from shrinking another's extension. Sending locks the shift; existing approval already locks it. Removing/rejecting a recipient does not shrink the envelope, conservatively avoiding premature lifecycle actions. This may retain a longer operational window after removal, intentionally.

## 17. Attendance/worker impact
Individual attendance admission, reminder/no-show/missing-clock-out continue to use assignment.period through existing helpers. Break does not change those thresholds. Shift-level QR/report windows use the expanded parent. Final report readiness still rejects unresolved/clocked-in staff; post-clock-out lifecycle remains based on actual clock-out. Final timesheets resolve individual scheduled break. Added worker regression with original end in the past but operational/individual end in the future: attendance stays clocked_in, assignment confirmed and shift not completed.

## 18. Success bottom sheet
Uses shared modal insets/scrolling/safe-area/rounded white surface and drag handle. Centered pale-green circle/check, bold heading, muted centered explanation and full-width dark rounded Done button. Submission is locked before awaiting the HTTP response; sheet appears only after confirmed success.

## 19. Success copy
“Shift submitted successfully”. “Your staffing request has been sent for manager approval. You can track its status from your shifts.” Venue submission creates a pending manager request, not staff offers. Existing bulk-offer flow retains its separate partial-success handling.

## 20. Done/navigation behavior
Done dismisses the modal, then the completed form pops with created ID. Completed prevents resubmission. Outside tap/drag dismissal is disabled; a system dismissal still exits the completed workflow through the awaiting continuation. Draft is retained until successful completion/exit.

## 21. Error-state behavior
Failures show existing errors and do not show the success sheet. Correctable rejections retain draft. Ambiguous create/network outcomes preserve existing duplicate-prevention behavior requiring status review rather than blind retry. No idempotency mechanism was removed or fabricated.

## 22. Security / IDOR
Existing org/workspace context, RLS, venue relationship, staff-team scope, active account/employment, ownership, eligibility, approval, QR/geofence and offer lifecycle remain. No auth changes. Unknown authority fields remain rejected. Test services are isolated loopback PostgreSQL/Redis with local storage and external email disabled.

## 23. Files changed
Mobile: shift_assignment_draft.dart, send_shift_screen.dart and their tests. Server: assignment-time helper/tests; SubmitShiftRequestDto and SendBulkOfferDto; Shift/ShiftAssignment/ShiftRequestStaff entities; SchedulingService, OfferService, AttendanceService, ShiftReportService; new migration; venue-manager-scoping and attendance fixture tests. Worker: final-timesheet projection, extended-window test and shared active test identity fixture. Frontend: requested-staff type and approval break display. Root handoff/threat model and this report. Pre-existing dirty work preserved.

## 24. Migration
1786674300000-AssignmentBreakAndDefaults, one append-only migration. Adds nullable non-negative breaks to request/assignment tables and nullable paired default timestamps to shift with ordered-date check. No historical rewrite or RLS change. Applied successfully on dedicated audit database and local Docker database. Deploy migration before coordinated API/worker release.

## 25. Flutter tests
Full suite: 382 passed. Focused final editor/draft/navigation rerun and visual capture results recorded in verification update below. Includes custom/blank/zero break, invalid effective break, default preservation, request payload, double-submit lock, no premature success and Done.

## 26. Server tests
146 passed across five suites: venue-manager-scoping, scheduling-offer-abuse-cases, attendance-abuse-cases, resource-ownership-abuse-cases and assignment-time. Includes real request/review/approval/time/break/pay/report propagation and DTO whitelist coverage. Logs in .audit/venue-assignment-times/server-breaks-final.log.

## 27. Worker/lifecycle tests
Initial run identified inactive fixture assumptions in three suites. Production eligibility was retained; shared test identities now explicitly seed active employment. Final targeted recheck and unique totals recorded below. Audit discovery's existing transactional RLS handling was not altered by this task.

## 28. Regression results
See exact verification update below; do not treat intermediate failed runs as final passes. Server test framework uses forceExit, so these runs do not prove absence of open handles. Local logs remain under .audit/venue-assignment-times/.

## 29. flutter analyze
Full-run analysis clean. Final source verification recorded below.

## 30. Builds/lint
Shared/server/worker/frontend build passed; server lint passed. Normal Android profile APK built. Local API artifacts were copied into the existing development container and it was restarted; the standard Dockerfile subsequently rebuilt the local rab-venue-pipeline:local image successfully. The rebuilt tag is available for future recreation; no registry publication was performed. No production deployment.

## 31. Manual emulator/device QA
Widget-rendered editor/success captures inspected against the supplied screenshot. Current screenshots: packages/rab-mobile/.qa-screenshots/venue-manager/assignment-break-editor.png and 16-send-success.png. Test data is synthetic. Normal APK installation status recorded below. No authenticated native end-to-end submission/approval was performed; widget/server integration tests are not claimed as manual device QA.

## 32. Remaining work
Authorized native end-to-end submission/approval QA; physical iOS QA; coordinated production migration/API/worker release. Local image build is complete. No production deployment or registry publication.

### Final verification (2026-09-30)
Flutter: 382 full-suite tests passed; final focused rerun 48 passed; analyze clean. Normal profile APK built and installed/launched on emulator-5554 without clearing data. Server: 146 passed across five suites; final contract subset 56 passed (not additional unique tests). Worker: 227 unique passing tests across nine suites, combining unaffected initial suites and the final four-suite recheck (89 passed). Frontend: 147 passed. Shared/server/worker/frontend builds and server lint passed. Standard Docker image build passed for local tag rab-venue-pipeline:local. Refreshed local API /healthz returned HTTP 200. Migration applied locally; production not deployed.
Final editor/success widget captures regenerated. Native authenticated submission/approval and physical iOS remain unverified. Whole-worktree whitespace check reports pre-existing EOF blank lines in final-timesheet.html.ts and pre-shift-report.html.ts; unrelated edits preserved.
