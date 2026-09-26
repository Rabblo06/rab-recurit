# RAB MOBILE UI FINAL CLEANUP REPORT

Date: 22 September 2026. Scope: the remaining-defects request, preserving the existing app and attendance/security architecture. Evidence paths below are relative to this directory.

## A. VM blank-tab root cause

The inactive nested Navigators received cancelled system-back callbacks through NavigatorPopHandler. The old callback unconditionally popped its Navigator, including inactive root routes, leaving Offers/Profile blank. Keeping an IndexedStack alone did not protect those roots.

## B. Exact navigation fix

In venue_manager_screens.dart, the callback now pops only when its index is the selected tab and its Navigator canPop(). Existing stable Navigator keys, IndexedStack and tab stacks remain. MovingTabBar retains its 72dp shell, 54dp selected circle, 24dp icons, equal cells and SafeArea. No route or backend permission was broadened.

## C. Reproduction test

venue_manager_test.dart invokes the real binding handlePopRoute(), repeats Users → Android Back → Reports → report detail → Offers → Profile → Home three times, and checks populated destinations and restoration of the same report State/Element. Root routes must survive. The fixture includes the real API's string-valued earnedPence.

## D. Real emulator verification

Three complete cycles passed on emulator-5556. See navigation-proof.json and final-users-N.png, final-report-N.png, final-offers-N.png, final-restored-report-N.png (N=1–3). Profile content was asserted without saving credentials. The report detail remained populated after switching tabs. The original blank-screen evidence remains in ../nav-card/audit-sent-shifts.png and audit-venue-profile.png.

Staff and VM calendars were opened and inspected: final-staff-calendar.png and final-vm-calendar.png. Date grouping, pastel cards, selected date and selected navigation item remain consistent with the references.

## E. Completed-state reconciliation fix

Before: the clock screen could retain active attendance metrics after a successful clock-out when history lagged. Home could also offer Clock in before the completed shift's scheduled end.

After: successful clock-out retains only the completed attendance identifier. The screen reads the matching ended record from refreshed server history. It never uses the former active record or locally calculated clock-in/out duration as final worked time. Until history and workedMinutes arrive, it displays the shared completed acknowledgement, Updating worked time, Back to shifts and a retry control, without stale timer metrics. Missing records, missing metrics and failed history fetches are covered. Retry reconciles authoritative data without another clock-out POST. Home now recognises ended server attendance before scheduled end, including after restart.

## F. Post-clock-out native verification

A new isolated local QA organisation/workspace and canonical Staff/VM/Internal Manager identities were created. The older live attendance record was not clocked out or reused. The dedicated shift was approved and its Staff offer accepted through the existing guarded API. Geofencing remained enforced at latitude 51.508, longitude -0.1281, radius 100m. Emulator GPS was placed inside it.

Fresh QR claims were checked against fresh database shift/venue/version state using the existing QR validation service. The same QR was scanned through the production native camera for both actions; no direct clock-in/out API shortcut or scanner bypass was used. Hardware rendering was needed for the emulator camera texture.

| Identifier | Value |
| --- | --- |
| Organisation | 9cd63f56-1a31-495b-953f-e68608e6e86a |
| Workspace | 68efda6b-f116-4248-8b58-f980b53f1db9 |
| Staff user | e3818b85-24eb-4d6b-882f-2dea84bf3055 |
| Staff profile | bed84c99-8bd6-429a-8598-166fb724855d |
| Venue | 914799fa-4260-436e-8a57-79f75a26afc1 |
| Native clock shift | 3af86dd1-c5b2-4e25-b028-65c9a51fefe1 |
| Attendance | fc53793b-72c0-4315-8628-b7e974cb2596 |
| Additional upcoming shift | 0edf1052-c062-4738-a913-dd4dc249f40b |

QR version: 1. Same-token SHA-256: bc818a25c230bea9ca40cdf8babee0b0b133bee41b178e1636491549f9533df7. No QR payload or credentials are included.

Database clock-in: 2026-09-22T11:52:04.977Z. Clock-out: 2026-09-22T11:53:12.126Z. Final attendance clocked_out, workedMinutes=1, assignment completed, shift completed, activeAttendanceId=null. History matched that record. Evidence: fixture-proof.json, attendance-proof-clocked-in.json, attendance-proof-completed.json. qa-completed.png shows authoritative 00:01, the shared success card and Back to shifts. final-staff-home-completed.png verifies completion after final-build restart.

| Required native state | Real screen opened | Reference compared | Screenshot | Issue found during pass |
| --- | --- | --- | --- | --- |
| Successful Clock In/live | YES | YES | qa-clock-in.png; qa-clocked-in.png | NO UI defect; camera rendering configuration corrected |
| Clock Out sheet | YES | YES | qa-clock-out-sheet.png | NO |
| Completed post-clock-out | YES | YES | qa-completed.png; final-staff-home-completed.png | YES: Home completion before scheduled end, fixed |
| Shared message card | YES | YES | qa-completed.png | YES: error-card column could expand, fixed to natural height |
| Populated VM upcoming | YES | YES | qa-vm-final-home.png; final-vm-upcoming-full.png | YES: completed event remained upcoming, fixed |

## G. Message-card consolidation

Reused ScheduleMessageCard for offer mutation errors/awaiting confirmation, clock loading errors, Send Shift access/loading/submission failures, correction/report errors and VM empty/access/unavailable states. Covered VM venues, upcoming events, event periods, confirmed staff, reports, directory access, staff detail and sent-shift detail. Geometry is shared across info/success/warning/error; optional actions use the shared button. Natural-height columns prevent large empty error cards. Native permission dialogs remain platform-owned.

## H. Button consolidation

Send Shift's manually styled navy button now uses SchedulePrimaryButton. Staff-selection submission, empty sent-shift Send Shift and event-detail Send offers also reuse it. Busy/disabled behavior prevents repeated submission. Existing pastel Home shortcuts, secondary Decline/Cancel, text actions and destructive profile actions remain deliberate semantic variants.

## I. Token consolidation

Reused ScheduleTokens and introduced named panelRadius=24, rowRadius=20, fieldRadius=12, badgeRadius=16, cardInset=16, sheetTextGap=12 and sheetActionGap=20. Consolidated repeated VM form/list radii and page padding. Existing 28dp upcoming card/route radius and transition handoff were preserved. No new parallel design system or duplicate nav/card implementation was created.

## J. Sheet consistency

showScheduleSheet now owns keyboard inset, bottom SafeArea, bounded height, scrolling and 24dp horizontal/bottom content padding. Existing 32dp top radius and shared handle remain. Removed redundant wrappers from Home explanation, Clock Out confirmation, location permission/unavailable, offer readiness, VM discovery, sent-shift filters, staff-directory filters and attendance correction. Content determines height. Informational/confirmation dismissal remains non-mutating. Correction retains conservative dismissal/busy protection. A 320×640 test with 250px keyboard and 24px safe area verifies one inset, reachable CTA and scrolling.

## K. Golden coverage

19 golden images pass: 8 individual Staff/VM navigation states; 4 semantic message states; Clock In, live, confirmation sheet, completed and pending reconciliation; 2 existing shared Staff/VM surface composites. Clock states and representative message/nav renders were visually inspected rather than blindly accepted; the expanded error-card issue was corrected before baseline acceptance.

Full Staff Home, VM Home and Calendar retain widget/layout and screenshot coverage, with native screenshots above. They do not have new individual deterministic full-screen goldens because their current fixtures include wall-clock dates/update labels. This is the documented coverage exception to the request's “where practical” qualification. No claim of native testing for delayed-history failures: those are controlled widget regressions.

## L. Flutter analyze

PASS: no issues found (7.4 seconds). See flutter-analyze.log.

## M. Flutter tests

PASS: 222 tests. See flutter-test.log. Includes nested system Back, preserved navigation/card handoff, role routes, completed reconciliation, Home completion before scheduled end, feedback variants/adoption, shared buttons, duplicate submission, sheet dismissal/keyboard, responsive layouts and goldens.

Native report inspection exposed PostgreSQL bigint earnedPence arriving as a JSON string. The mobile decoder now accepts string/numeric/null values; four contract tests cover those forms and a large integer. qa-report-response.json is the actual local API response. No server contract or authorization change was required.

## N. Android build

PASS: flutter build apk --profile; 109.2MB APK, 46.9 seconds. See android-build.log. Final APK installed on Staff emulator for restart verification. VM three-cycle verification used the same implementation before the final Staff-only Home condition was added.

## O. Remaining exceptions and cleanup

No known remaining defect from this focused cleanup request. Full-screen golden coverage is qualified in K. Classic UI remains selectable. Platform permission prompts, secondary actions and status-only badges remain intentional exceptions to primary-button/message-shell uniformity. Report hours retain existing one-decimal formatting (one minute displays 0.0h there); authoritative clock completion shows 00:01. No report was finalised or emailed during QA.

Cleanup verified the isolated tenant contained exactly the three known QA users and no active attendance. The future QA shift was cancelled through the existing API. All three QA accounts were deactivated, password hashes cleared, refresh tokens revoked (remaining unrevoked: 0), and the Staff profile marked inactive. Both emulator sessions returned to login. The temporary camera QR poster was reset, and local private credentials/QR files were deleted.

The isolated organisation/workspace, venue, profiles, assignments, completed attendance, report data and immutable audit history are deliberately retained for evidence and referential integrity. See cleanup-proof.json. No hard deletion, RLS bypass, production-like attendance mutation or backend business-logic change was made. The emulator's local camera-control service may remain available for subsequent QA.

### Files changed by this cleanup

Mobile source: core/theme/schedule_tokens.dart; core/widgets/schedule_feedback.dart and schedule_home_components.dart; features/home/schedule_home_screen.dart, schedule_clock_screen.dart, location_permission_sheet.dart, location_unavailable_dialog.dart; features/offers/schedule_offer_detail_screen.dart; features/venue_manager/venue_manager_screens.dart, venue_manager_provider.dart, send_shift_screen.dart, sent_shifts_screen.dart, venue_staff_directory.dart, attendance_correction_sheet.dart and shift_report.dart.

Tests: home_visual_states_test.dart, schedule_clock_screen_test.dart, venue_manager_test.dart, schedule_components_golden_test.dart, shift_report_contract_test.dart and test/goldens. QA evidence and repeatable helper scripts are in this final-cleanup directory. Other pre-existing working-tree changes were preserved and are not attributed to this cleanup.

**PROMPT FULLY APPLIED**
