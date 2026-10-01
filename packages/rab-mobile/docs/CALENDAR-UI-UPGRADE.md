# ADOLPHUS Calendar UI Upgrade

Date: 2026-09-28

## Existing calendar behavior discovered
Staff previously used the CalendarDatePicker-based ScheduleCalendar shared with Venue Manager. It filtered manager-confirmed offers, grouped by device-local interval overlap, and opened ScheduleOfferDetailScreen. The old Today mode was a weekly agenda. The new Today mode follows this brief: today's shifts and offers. Venue Manager retains the shared calendar unchanged.

## Files changed
- lib/features/calendar/calendar_screen.dart: existing provider and navigation adapter.
- lib/features/calendar/calendar_view.dart: Staff-only Calendar layout and reusable shift card.
- lib/features/calendar/calendar_presentation.dart: read-only status, date grouping, summary and visual tokens.
- test/calendar_ui_test.dart: behavior, responsive rendering and screenshot fixtures.
- docs/CALENDAR-UI-UPGRADE.md: this report.
- ../../docs/HANDOFF.md: canonical repository handoff.

## Header
Dynamic viewed month/year, bold title and circular profile action. At enlarged text sizes month names abbreviate to avoid splitting words. Profile retains the existing Profile tab destination.

## Today / Month control
White capsule with sliding black selected pill, compact icons and labels. Month opens by default to match the reference. Today resets selection to the current provider/server-clock day and shows today's cards. Month restores the currently selected month.

## Calendar card
Compact white rounded panel, restrained shadow, dropdown date picker and previous/next controls. Existing 2020-2100 date bounds retained.

## Calendar grid
Seven equal columns, locale-aware first weekday, real month lengths, 40px normal rows and 48px enlarged-text rows. Five/six-week months size naturally; no tall empty picker. Two-digit labels scale down within their circle at enlarged text sizes instead of clipping.

## Event dots
A central read-only mapping uses server presentation state first. Confirmed uses blue, pending/open offers mint, staff-accepted pending offers are labelled Awaiting confirmation; Live is green, terminal states neutral. Server labels for Clocked Out, Complete, Ended, Expired, Cancelled, Declined and Not confirmed remain distinct. Attendance is only a fallback when the server projection is absent. A maximum of three distinct status dots per date; no duplicate dot for every shift. The legend explains the primary confirmed/open colors. No backend lifecycle rules were added.

## Selected date behavior
Tap selects a date while remaining in Month. Green circle indicates selection; today gets a subtle outline when another date is selected. Prev/next selects the first of the destination month; dropdown date selection also updates the month and heading. Dates expose full accessible labels and selected semantics.

## Day summary
Actual selected date, count and summed scheduled duration. An overnight shift appears on both overlapping dates, as before; the summary shows full scheduled shift duration, not day-clipped worked hours. Midnight end is excluded from the following day. Mixed-status days omit a potentially misleading single-status badge.

## Shift cards
Pastel card, slim status accent, role, arrow, venue, optional address, local times and actual pence-formatted hourly rate. Overnight end carries a day offset. Stable ShiftVisualStyle color identity is retained across Home/Calendar/Details; blue in QA fixtures does not force all live shifts blue. Whole-card tap opens the existing details route.

## Empty state
Compact No shifts scheduled panel. Static loading placeholders, error/retry and pull-to-refresh use existing OffersProvider operations. No fake live shifts or backend changes.

## Bottom navigation
Existing MovingTabBar, AppShell and destinations unchanged. Calendar content scrolls above the persistent navigation. QA renders include the actual shared navigation component.

## Animations
240ms selected-pill movement, 220ms month fade/16px translation, 180ms selected-circle change, 200ms day-content fade/8px translation. MediaQuery.disableAnimations makes these durations zero and removes translations. Outgoing switcher content cannot receive taps or duplicate accessibility announcements. No new animation dependency.

## Responsive behavior
Checked 320x640, 364x661 (reference size), 393x852 and 430x932 logical pixels. Long role/address text uses bounded lines; content scrolls on short screens. At 200% text, summary/badge stack and month labels abbreviate. Visual inspection discovered and fixed two-digit calendar label clipping missed by the initial no-overflow test.

## Real-data mapping
Production uses OffersProvider.offers only: existing manager_confirmed offers plus pending/staff_accepted offers requested by this brief. Server presentation is authoritative; no API/schema/auth changes. Test examples exist only in test/calendar_ui_test.dart. Mobile has no organisation timezone field in this payload; the existing device-local toLocal() convention is preserved, with trustedNow for the clock when available. This is not a new organisation-timezone implementation.

## Navigation preserved
Profile -> existing Profile tab. Shift -> ScheduleOfferDetailScreen with original offer and same ShiftVisualStyle. Bottom destinations, authentication, Home, History and Venue Manager are unchanged. Widget checks verify Calendar callbacks; existing offer/navigation regressions also run.

## Flutter analyze
Final flutter analyze: no issues found. Normal main.dart Android profile APK build passed. Logs: build/calendar-analyze.log and build/calendar-build.log. No new dependencies.

## Tests
44 checks passed in the Calendar/navigation/lifecycle/color/offer-detail regression run. After adding authoritative terminal-state coverage and the visual accessibility fix, all 12 Calendar tests passed again. Checks cover weekday column alignment, selected date, Today/Month, previous/next month, confirmed/open dots, actual summary, multiple/empty shifts, profile/detail callbacks, loading/retry, reduced-motion durations, overnight and midnight boundaries, server-state precedence, viewport and 200% text layouts.

Logs: build/calendar-tests.log, build/calendar-final-tests.log, build/calendar-analyze.log.

## Visual QA
Actual Flutter-rendered widget screenshots inspected at 320x640, 364x661, 393x852, 430x932, plus 320x640 at 200% text. Inspected single and mixed/multiple shifts, Today empty/single/multiple, Month empty, selected/nonselected today, August six-row month, October next month, long role/address, loading and retry states. QA data is synthetic and confined to tests; these are not authenticated live-account screenshots. No physical-device or iOS certification claimed.

Evidence: build/calendar-qa/*.png. Responsive and states contact sheets are also in that directory. Individual PNGs are authoritative; rerun `flutter test --no-pub test/calendar_ui_test.dart` to regenerate them. The enlarged-date screenshot includes the corrected result.

## Build and review
Run flutter analyze --no-pub, flutter test --no-pub test/calendar_ui_test.dart, and flutter build apk --profile --no-pub from packages/rab-mobile. Review the Calendar with a signed-in staff account containing real offers. No data reset or test account creation is necessary.

Updated normal profile build installed successfully on emulator-5556 and launched; app data preserved. Calendar live-account review requires signing in as staff.
