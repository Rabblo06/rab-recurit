# Venue Manager Calendar Consistency Fix

Date: 2026-09-29

## Existing architecture inspected
Staff CalendarScreen reads OffersProvider/AttendanceProvider and renders StaffCalendarView. VenueCalendarScreen reads the existing scoped VenueManagerProvider. Each role retains its existing detail route and shell. MovingTabBar already supplies both roles' navigation geometry.

## Cause of mismatch
The September 28 Staff redesign introduced a private calendar layout in calendar_view.dart. Venue Manager still rendered the old ScheduleCalendar weekly agenda and stock CalendarDatePicker. Despite older documentation, the two roles no longer shared their visual calendar implementation.

## Shared components reused
ScheduleCalendar now owns the existing Staff layout and motion for both roles. CalendarTokens/CalendarStatus moved into core/theme/calendar_tokens.dart (ink/muted derive from ScheduleTokens). ScheduleRecordCard continues to render Venue events; Staff's approved CalendarShiftCard stays intact. ScheduleMessageCard supplies error/retry feedback. MovingTabBar, ScheduleTokens and ShiftVisualStyle are reused unchanged.

## ScheduleCalendar changes
Extracted the Staff presentation instead of building a second calendar. Role-neutral entries carry id, start/end, a presentation status and an existing card builder. Role adapters supply empty copy, legend, singular record noun, refresh/profile callbacks. Month starts selected. Local interval overlap, chronological sorting, picker bounds (2020-2100), loading/error handling and reduced-motion behavior are retained. Today resets to the current day. Selected-date changes stay in Month.

## Venue Manager adapter
Existing cancelled-event exclusion, provider scope, stable shift identity, team data, event-detail route and profile callback are preserved. Raw shift statuses map explicitly to truthful display names: pending_manager_approval -> Awaiting approval; open -> Open request; offered -> Offers sent; partially_filled -> Partially filled; fully_filled -> Filled; confirmed -> Confirmed; in_progress -> Live; completed -> Complete; declined -> Declined; draft -> Draft; unknown -> Updating. No acceptance, confirmation or attendance facts are inferred from counts or device time. No lifecycle or API changes.

## Header
Shared dynamic month/year, 27px heading, 24px page inset and 48px circular Profile control. Month abbreviates at enlarged text exactly as Staff did. Existing profile callbacks remain role-specific.

## Today / Month
One shared white pill with dark active surface; 240ms easeOutCubic movement. Today shows today's agenda; Month shows the selected month/date. Reduced motion settles immediately.

## Calendar card
Shared white 24px-radius card, restrained shadow, month picker and previous/next controls. Seven equal columns follow MaterialLocalizations.firstDayOfWeekIndex. No stock CalendarDatePicker embedded in the page.

## Date cells
Shared 40px rows (48px for enlarged text), 30px selected green circle, thin mint today outline when unselected, scaled two-digit labels and semantic date/status labels. Existing Staff geometry is retained.

## Dots and legend
Up to three distinct status dots per date, matching real event states. Venue legend lists statuses present in authorized records; empty datasets use Confirmed/Open request. Long labels now flex/wrap without overflow at 200% text. Legend height may differ by role when labels wrap; calendar grid geometry is shared.

## Selected-day summary
Same date heading and single-status badge. Venue uses event/events, Staff shift/shifts. Scheduled start/end durations are summed (not attendance/payroll time), with hour/hours agreement. Overnight records keep the existing local-time overlap rule; an end at midnight is excluded from the following day. No organization-timezone normalization was added.

## Event cards
Venue retains shared ScheduleRecordCard, real role, venue/address, joined/required, known team names and original details action. Added the existing eventTime formatter and explicit real shift status. Card color still comes from provider.style(event) -> ShiftVisualStyle.forShift(event.shiftId). Staff card styling was not redesigned.

## Empty state
The same compact white surface as Staff, with Venue copy: No scheduled events / No venue shifts are scheduled for this date. No oversized lavender empty block. Loading and error are distinct from emptiness.

## Bottom navigation
No shell/navigation changes. Venue: Home, Calendar, Offers, Profile. Staff retains History. Existing MovingTabBar sizing, safe insets, icon centers and per-tab navigation are untouched and regression-tested.

## Staff regression results
Existing Staff calendar suite passes: grid/date alignment, selection, status dots, months, callbacks, loading/error/retry, overnight grouping, server lifecycle precedence, responsive rendering and reduced motion. Only implementation location changed; shared summary also correctly singularizes one hour.

## Files changed in this task
- lib/core/widgets/schedule_calendar.dart: shared presentation and role-neutral adapter.
- lib/core/theme/calendar_tokens.dart: extracted calendar tokens/status labels.
- lib/features/calendar/calendar_view.dart: thin Staff adapter; approved shift card retained.
- lib/features/calendar/calendar_presentation.dart: imports/re-exports shared tokens, Staff mapping retained.
- lib/features/calendar/calendar_screen.dart: architecture comment only beyond pre-existing work.
- lib/features/venue_manager/venue_manager_screens.dart: Venue calendar presentation adapter/status mapping only.
- test/schedule_consistency_test.dart: update old weekly/stock-picker assertions to requested shared month UI.
- test/venue_calendar_ui_test.dart: new parity, status, duration and responsive regressions.
- docs/VENUE-CALENDAR-CONSISTENCY.md and repository docs/HANDOFF.md.
Existing unrelated uncommitted changes were preserved. No dependencies, backend, auth, Offers, payroll, attendance, permissions or routes changed.

## Flutter analyze
`flutter analyze --no-pub`: no issues. Evidence: build/venue-calendar-analyze.log.

## Tests
82 tests passed with:
`flutter test --no-pub test/venue_calendar_ui_test.dart test/calendar_ui_test.dart test/schedule_consistency_test.dart test/venue_manager_test.dart test/navigation_geometry_test.dart test/shift_colour_identity_test.dart`
Evidence: build/venue-calendar-final-tests.log. Direct parity cases cover 320x640, 393x852, 430x932 and 390x844, each at 100% and 200% text. Large-text cases also disable animations. Tests compare header/profile, calendar position/width and navigation bounds, real status labels/dots, empty/populated states, Today/Month and stable card identity. Existing role routing suite covers navigation and details.
Initial QA caught a long legend overflow, fixed with Flexible text. Test harness fixes scroll virtualized content into view and avoid accidentally invoking a real provider refresh while scrolling to the top.

## Native emulator QA
Built and installed a profile preview using the production StaffCalendarView and VenueCalendarScreen with an isolated synthetic provider; no login, session storage or real API records modified. Pixel_5_2 / emulator-5556: 1080x2340 physical, density440 (~393x851 logical).
Inspected Staff and Venue side by side at identical size, populated Month, populated Today and selected empty date; exercised next/previous month and date switching. Headers, pill, grid, markers, spacing and navigation align. Venue-specific card content remains intentional.
Evidence under build/venue-calendar-qa/: native-comparison.jpg; venue-month.png; staff-month.png; venue-today.png; staff-today.png; venue-empty.png; staff-empty.png; venue-next-month.png; motion.mp4; motion-review.jpg. Inspected all 33 captured motion frames. Variable-rate emulator recording confirms composition/choreography, not frame-rate performance. Real iOS hardware and real-account data were not tested; iPhone-like dimensions are widget tests.
Normal main.dart `flutter build apk --profile --no-pub` passes and normal APK restored with adb install -r, then launched. App data was not cleared. Logs: build/venue-calendar-native-build-final.log and build/venue-calendar-normal-build.log. Native harness/evidence are ignored build artifacts, never a production entrypoint.

## Next action
Review Calendar on an authenticated Venue Manager account with its real scoped events. No production deployment or schema migration is needed for this presentation change; release through the normal mobile distribution process.
