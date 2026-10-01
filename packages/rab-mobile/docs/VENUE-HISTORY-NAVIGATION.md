# Venue Manager History Navigation Fix

## Root cause
VenueManagerShell index 2 rendered VenueOffersScreen, which delegates to VenueSentShiftsScreen. Its semantics explicitly said Offers.

## Existing mapping
Home | Calendar | Offers | Profile.

## New mapping
Home | Calendar | History | Profile. Shared MovingTabBar now uses its document/history-style glyph rather than a speech bubble in the third slot. Staff routes and geometry remain unchanged.

## History screen reused/created
No dedicated venue history existed. Added the small VenueHistoryScreen inside the existing venue_manager_screens.dart, reusing VmPage, VmData, ScheduleRecordCard and VenueEventDetail. It displays ended completed shifts and ended confirmed/fully-filled/partially-filled shifts with joined staff, sorted newest end first. Future, pending/open offers, requests and active work are excluded; actual lifecycle status remains visible rather than inferring completion from the clock. Cards show role, venue, date/time, joined count, status and confirmed staff names when available. Existing detail/report routes provide further authorized data; no fabricated attendance status.

## Sent Shifts preserved
VenueOffersScreen and VenueSentShiftsScreen remain unchanged and reachable through Home -> My Space -> Sent offers. Confirmed staff and report overview links remain intact.

## Files changed
- lib/features/venue_manager/venue_manager_screens.dart
- lib/features/venue_manager/venue_manager_provider.dart
- lib/navigation/moving_tab_bar.dart
- test/venue_manager_test.dart
- test/navigation_geometry_test.dart
- docs/VENUE-HISTORY-NAVIGATION.md
- repository docs/HANDOFF.md and THREAT-MODEL.md

## Navigation state
Existing IndexedStack and four nested Navigators retained. History detail and list scroll position survive Calendar -> History. Re-tapping History pops to its root. Only one MovingTabBar.

## Back behavior
Existing selected-tab NavigatorPopHandler retained; Android Back from detail returns to History without affecting inactive tab stacks. Regression tests cover repeated Back and re-tap.

## Security scope
Uses only existing server-scoped VenueManagerProvider data. No new API, widened scope, user-supplied venue selectors or Staff-private state. Existing detail endpoint checks still apply. Refresh errors clear records and show the shared error state.

## Tests
68 tests passed across venue_manager_test, navigation_geometry_test, notifications_offers_navigation_test, root_gate_isolation_test, schedule_consistency_test and venue_calendar_ui_test. Additional focused History state and visual-capture runs passed. Coverage includes filtering, labels/icons, Home Sent Shifts, role isolation, detail/back/re-tap, preserved scroll state and cleared data on refresh failure. Screenshot: .qa-screenshots/venue-manager/history-navigation.png. Logs: build/venue-history-regressions.log, venue-history-state.log and venue-history-visual.log.

## flutter analyze
No issues found (build/venue-history-analyze-final.log).

## Remaining work
None for the requested navigation change. Server authorization is reused, not reimplemented; tests use scoped HTTP fixtures and do not claim a new live-backend security audit.

Android verification: normal profile APK build passed and installed/launched successfully on emulator-5556 without clearing app data. Visual History verification used scoped widget-test fixtures; no live user credentials were entered. Scoped git diff --check passed.
