# RAB MOBILE UI CONSISTENCY + SECURITY AUDIT REPORT

Date: 22 September 2026. Scope: existing Flutter Staff and Venue Manager experiences.

## A. Screens inspected

Staff: Home/Organization/My Space, upcoming deck and expanded list, Offers and Job Details, Calendar, Clock, completed attendance, History, Profile, location recovery and QR scanner.

Venue Manager: Home/Organization/My Space, events and event details, Sent Shifts, Send Shift, users and selection/filter views, Calendar, Reports/report detail, attendance correction, Profile and informational sheets.

Inspection included source, existing regression tests, production-widget captures and the native screens explicitly listed in section U. A source inspection is not recorded as a native screen visit.

## B. Duplicated components discovered

- Staff upcoming cards and Venue Manager event cards independently implemented title, arrow, venue/address, metric and team rows.
- Calendar used two unrelated presentations: Staff's fixed current-month grid and Venue Manager's date picker/event list.
- Modal surfaces repeated platform defaults without common geometry.
- Clock, location and report actions repeated primary-button styles.
- Errors mixed plain labels, retry columns and dialogs. Completed attendance had a standalone status label.
- Role-name identifier fallback existed only in Sent Shifts.

## C. Components reused

`MovingTabBar`, `ScheduleTokens`, `SchedulePanel`, `ScheduleHeader`, `ScheduleSpaceSelector`, `ShiftVisualStyle`, `ShiftMotion`, existing providers, detail routes and persistent tab navigation.

Classic card rendering and the deck's depth-based color rotation are retained. No replacement app or parallel production entry point was created.

## D. Components consolidated

| Component | Result |
|---|---|
| `SchedulePanel` | Existing widget extended with configurable padding; reused by History and Profile. |
| `ScheduleRecordCard` | Shared Staff/Venue Manager event/shift layout and calendar cards. |
| `ScheduleAvatarStack` | Authorized names, initials, actual overflow count; shared with Clock. |
| `ScheduleRoundArrow` | Shared white circular arrow with 48dp target and explicit semantics. |
| `ScheduleCalendar` | One date-strip/agenda/month presentation; role adapters supply records and navigation. |
| `SchedulePrimaryButton` | Shared minimum-height, wrapping, disabled and busy behavior. |
| `ScheduleMessageCard` | Information, success, warning and error surfaces with optional action. |
| `showScheduleSheet` | Shared modal shape, handle, scrolling and safe-area behavior. |
| `showScheduleMessageSheet` | Shared informational/result sheet. |
| `displayRoleName` | Reused missing-role fallback across Sent Shifts, event records and reports. |

Removed duplicate home-card bodies, clock avatar/button bodies, calendar implementations and migrated modal implementations. Specialized form fields, Classic surfaces and domain-specific report rows remain intentional.

## E. Navigation fix

Both roles continue to use `MovingTabBar`: white floating pill, restrained shadow, dark circular selection, four 48dp targets and shared horizontal/bottom inset tokens. Staff shell background now matches the Schedule surface across tabs.

Staff destinations remain Home, Calendar, History, Profile. Venue Manager destinations remain Home, Calendar, Offers, Profile. The reference's speech-bubble icon does not introduce a new messaging destination: accessibility labels retain the actual route names.

Staff's persistent IndexedStack and Venue Manager's nested navigator stacks remain intact. Calendar profile actions use the existing profile tab. Native selected states were exercised in both roles.

## F. Completed/clocked-out state fix

**Before:** standalone completed text in the action area, with no useful next action.

**After:** non-actionable “Shift completed” status with a separate “Back to shifts” button. This is used in Clock and completed Job Details. The return action unwinds to the existing root, rather than creating another screen. Clock's completed collapsed sheet gets additional space so the role is not clipped.

Completion still derives from server attendance/history or the existing successful clock-out response. Dismissing a confirmation never changes attendance. The native completed-detail capture uses an existing completed record; no live shift was ended for QA.

## G. Bottom sheet system

Migrated: Staff Home explanation sheets; Clock Out confirmation; too-early clock-in information; location permission explanation; location unavailable recovery; Job Details readiness; Venue Manager discovery; Sent Shifts filters; user directory filters; attendance correction; Send Shift success/partial-success results.

Shared radius: 32dp. Natural content height with a bounded scrolling surface. Common drag handle and safe top inset. Existing content retains its bottom safe area and keyboard inset where needed.

Informational/confirmation sheets can be dismissed without submitting. Attendance correction has explicit Cancel and disables drag/barrier dismissal; Android back is blocked while saving. Duplicate saves are guarded, and asynchronous error updates check mounted state.

Clock Out retains the exact requested title and explanation, black primary button, and Keep working action. Native Keep working returned to the still-live attendance state.

## H. Calendar redesign

Dynamic month/year header, profile action, Today/Month control, selectable seven-day strip, previous/next week controls and date-grouped pastel cards with a date gutter. Month mode supports date selection. Content scrolls on narrow displays and large text.

Staff records still come from confirmed offers with attendance status from the existing provider. Venue Manager records remain scoped provider events, excluding cancelled events. Overlapping overnight records appear on the day they occupy. Taps open the existing role-specific details. No sample shifts, pay or staffing counts are inserted into production.

## I. Card system

Staff Home, Venue Manager Home/event cards and both calendars now share content hierarchy, 28dp corners, arrow layout, metadata alignment and team footer. Staff cards use actual hourly pence; Venue Manager cards use filled/required counts. Existing depth colors and captured detail-flight styles remain unchanged.

History/Profile reuse `SchedulePanel`; smaller dashboard panels retain their intentional 24dp geometry. Long titles/addresses remain bounded in cards, with full details available through the existing routes.

## J. Message/status-card system

Shared feedback is used for completion, calendar load/empty states, Venue Manager load failures, History failures, attendance mutation errors, location/camera recovery, too-early clocking, shift-send results and report empty states.

Error states have text and an icon, not color alone. Retry uses the existing provider/action. History no longer misrepresents a failed history fetch as “No history yet.” Specialized existing status badges and some inline form validation remain; they are not new independent message-card implementations.

## K. Button system

Clock, completed return, location explanation/recovery, message actions, report finalization, attendance correction and primary Job Details actions use `SchedulePrimaryButton`. It has a 48dp minimum height, natural text growth, consistent dark pill shape and a busy state that disables activation.

Secondary Decline, native pickers and compact form controls keep their existing behavior and purposeful variants. No report/send/clock mutation is triggered by opening or dismissing a surface.

## L. Spacing/alignment tokens

Shared tokens now include 48dp targets, 28dp record radius, 32dp sheet radius, 24dp sheet/navigation inset and 12dp navigation bottom minimum. Existing 24dp home inset and 20dp section gap are reused. Calendar intentionally reserves a separate 40dp date gutter.

## M. Shadow system

Shared cards/navigation use the existing restrained `homeShadows` (low alpha, 12px blur, 3px vertical offset). No heavy black shadow was introduced. Date-list cards remain flat. Classic's explicitly separate palette/shadows were preserved.

## N. Typography hierarchy

Shared heading/body/label styles drive the consolidated widgets. Role titles lead; venue names are secondary bold text; addresses and metric labels are quieter; metric values stay legible.

Secondary color changed from `#797B80` to `#62666B`: measured contrast improves from 3.32:1 to 4.53:1 on lavender and from 3.55:1 to 4.84:1 on mint. This calculation covers these shared token/surface pairs, not an assertion that every legacy text color has been audited.

## O. Avatar/arrow components

Initials use grapheme-safe characters. Tooltips and semantics identify real supplied members. Staff's single authorized member is not expanded into a fabricated roster. Overflow counts derive only from provided names. Empty rosters use a neutral person icon.

Arrows retain established Staff “Open shift at …” and Venue Manager “Open event” labels; calendar cards name their actual title/venue. Explicit semantics containers prevent parent card semantics from swallowing the action label.

## P. Staff/Venue Manager consistency

Both experiences share the same calendar, record-card layout, avatar/arrow widgets, message surfaces, modal geometry and primary actions. Role adapters choose data and destinations. Existing role-specific dashboards, report permissions and staff pay versus venue staffing metrics remain distinct.

## Q. UI authorization/security checks

- No backend service, authorization rule, RLS policy, QR signing, geofence calculation, attendance time window, email or PDF implementation changed in this task.
- Providers remain the data source. No client-supplied tenant/organization/workspace identity was added.
- Existing `canSend`, `canFinalise`, assignment and report-lock controls remain.
- Clock confirmation guards, QR/location flow and provider mutation calls remain. Native cancellation preserved live attendance.
- Added correction/finalization duplicate-invocation guards; no optimistic “completed” state was introduced.
- Attendance provider edits are equivalent null-aware map entries for optional location values, to satisfy analyzer lint; wire fields and omission behavior are unchanged.
- Role fallback is presentation only; API identifiers and request schemas are unchanged.
- Existing auth, role isolation and attendance regression tests pass. This is a UI authorization review, not a fresh backend penetration test.

## R. Accessibility findings

Shared navigation/arrows/primary actions have at least 48dp targets. Shared actions grow with text. Calendar dates have full-date semantics and selected states. Feedback uses explicit text/icons. Busy primary buttons cannot be activated. Calendar and message/card layouts are tested at 320px and enlarged text; existing home/send/clock tests cover additional sizes/scales.

Fixed an accessibility regression found during consolidation: arrow labels initially merged into parent card semantics. Explicit semantic boundaries restored discoverability and the existing route tests.

## S. Widget tests

Full suite: **190 tests passed**, including two new golden cases. Logs: `full-tests.log`. Analyzer: **No issues found**, `analyze.log`.

New checks cover sheet dismissal versus confirmation, busy action disabling, overnight calendar inclusion, week/Today/Month navigation, narrow layouts, large text and absence of fabricated avatars. Existing home motion/color/route, role isolation, form and clock failure/retry tests remain green.

Two test-environment fixes: explicitly open the selected ended record around midnight; acknowledge the native location event channel in visual tests without emitting synthetic positions. Expected completed UI assertions now check the new status and return action.

## T. Golden tests and visual captures

New deterministic Staff/Venue Manager shared-surface baselines live in `test/goldens/schedule-*-surfaces.png`. They were generated, visually opened/reviewed, then tested without updating.

Existing production-widget capture suites generated Staff Home, populated Venue Manager Home, calendar, Clock In, live Clock, Clock Out confirmation, completed Clock/Job Details and navigation images. Captures were inspected, including a completed-sheet clipping issue that was fixed before final verification. These broader captures are review artifacts, not all automated pixel-diff goldens.

## U. Android visual QA

Real emulator: `emulator-5554`, installed profile APK, package `com.rab.rab_staff`. Fresh UI trees are required by `native-qa.ps1`; stale dumps are rejected. Screenshots are in this directory.

| State | Reference checked | Real screen opened | Native screenshot captured |
|---|---|---|---|
| Staff Home / navigation | YES | YES | YES — `native-home.png` |
| Staff Calendar, populated / selected tab | YES | YES | YES — `native-calendar-populated.png` |
| Clock In, no active attendance | YES | NO | NO — widget capture only |
| Clocked In | YES | YES | YES — `native-clocked-in.png` |
| Clock Out confirmation | YES | YES | YES — `native-clock-out-sheet.png` |
| Completed Job Details / shared success card | YES | YES | YES — `native-completed-detail.png` |
| Completed Clock after successful mutation | YES | NO | NO — widget capture only |
| Staff History | YES | YES | YES — `native-history.png` |
| Staff Profile | YES | YES | YES — `native-profile.png` |
| Venue Manager Home (real empty state) | YES | YES | YES — `native-venue-home.png` |
| Venue Manager My Space | YES | YES | YES — `native-venue-my-space.png` |
| Venue Manager Calendar | YES | YES | YES — `native-venue-calendar-final.png` |
| Venue Manager Offers | YES | YES | YES — `native-venue-offers.png` |
| Venue Manager Reports / detail | YES | YES | YES — `native-venue-reports.png`, `native-venue-report-detail.png` |
| Sent Shifts | YES | YES | YES — `native-sent-shifts.png` |
| Send Shift form (not submitted) | YES | YES | YES — `native-send-shift.png` |

Native Staff captures precede the last secondary-text contrast refinement; final contrast is covered by reviewed golden/widget captures. The available Venue Manager QA data has no upcoming events/confirmed report staff, so populated Home and correction states are covered by widgets/source rather than claimed native visits.

The final APK was installed successfully. Venue Manager Home/Calendar and report views were reopened after that installation; the report now displays “Role unavailable” rather than a raw role identifier.

## V. Remaining verification/inconsistencies

- Native Clock In requires a Staff QA session with a current confirmed shift and no active attendance. The user was asked to sign in such an account, without sharing a password. No live attendance was altered to manufacture this state.
- Native completed Clock after mutation and populated attendance-correction state are not claimed as verified. Completed Job Details and confirmation cancellation were verified natively.
- Some specialized inline validation/status badges and native date/time pickers remain intentionally separate; this pass does not assert every legacy widget was replaced.
- Staff native screenshots need a final recapture after the contrast-only token refinement once a Staff QA session is available.

## W. Files changed by this pass

Core: `schedule_tokens.dart`, `display_labels.dart`, `schedule_home_components.dart`, new `schedule_feedback.dart`, `schedule_record_card.dart`, `schedule_calendar.dart`.

Navigation: `app_shell.dart`, `moving_tab_bar.dart`.

Staff: `calendar_screen.dart`, `history_screen.dart`, `profile_screen.dart`, `schedule_home_screen.dart`, `schedule_clock_screen.dart`, `upcoming_shift_card.dart`, `location_permission_sheet.dart`, `location_unavailable_dialog.dart`, `qr_scan_screen.dart`, `schedule_offer_detail_screen.dart`, and equivalent optional-map syntax in `attendance_provider.dart`.

Venue Manager: `venue_manager_screens.dart`, `venue_manager_provider.dart` (display label only), `sent_shifts_screen.dart`, `send_shift_screen.dart`, `venue_staff_directory.dart`, `attendance_correction_sheet.dart`.

Tests: new `schedule_consistency_test.dart`, `schedule_components_golden_test.dart`, `support/location_stream_stub.dart`, two golden PNGs; updated existing home/clock visual tests. QA helper, screenshots, logs and this report are under `.qa-screenshots/ui-consistency`.

Unrelated existing repository/server edits were not part of this pass and were not reverted.

## X. Final result

Shared UI implementation, analyzer, full Flutter tests and Android build are verified. Native visual review was performed on both roles with the limits above. **Full visual sign-off remains pending the outstanding Staff QA states; the unconditional “RAB MOBILE UI CONSISTENCY PASS COMPLETE” declaration is deliberately not made.**
