# RAB MOBILE NAV + UPCOMING CARD FIX REPORT

Verified 22 September 2026. Scope: shared bottom navigation and Upcoming Shift card rendering/route handoff.

## A. Root cause of nav mismatch

The existing Schedule variant retained compact shell/indicator dimensions. Its small active control and padding made the bar look compressed beside the supplied reference. This was shared widget geometry, not stale role-specific routing.

## B. Existing nav components found

`navigation/moving_tab_bar.dart` owns `MovingTabBar`. `navigation/app_shell.dart` uses it for Staff; `features/venue_manager/venue_manager_screens.dart` uses it for Venue Manager.

## C. Whether duplication existed

The two active role shells already shared one implementation. No duplicate nav was added. The existing Classic styling branch remains available.

## D. Nav component changed/reused

Updated `MovingTabBar` and centralized Schedule dimensions in `ScheduleTokens`. Existing callbacks, role labels, selected semantics and animated indicator retargeting remain intact.

## E. Before/after dimensions

| Dimension | Before | After |
| --- | --- | --- |
| Shell height | Compact, approximately 54–58dp | 72dp |
| Active circle | 40dp | 54dp |
| Icons | 22dp | 24dp |
| Shell width | Screen minus fixed side insets | 90% screen, capped at 440dp |
| Inner padding | Compact asymmetric padding | 8dp plus 1dp border |
| Items | Existing animated allocation | Four equal Schedule cells |

The white pill has a 36dp radius, subtle shared shadow and light border. The black selected control is centered in its cell.

## F. SafeArea handling

One outer SafeArea retains the system bottom inset with a 12dp minimum. Width is centered within the available space. Tests explicitly cover a 24dp gesture inset. Native screenshots show the pill clear of the Android gesture handle.

## G. Staff nav verification

Geometry and all four selected states verified at 320, 393 and 430dp. Native Home, Calendar, History and Profile destinations exercised and captured on emulator-5554.

## H. Venue Manager nav verification

Same geometry tests with Venue Manager labels; native Home, Calendar, Offers and Profile exercised and captured on emulator-5556. Both roles use the same nav implementation.

## I. Root cause of Upcoming Shift card glitch

The detail handoff hid only the foreground card while leaving complete rear surfaces painted. Before the route overlay appeared, a whole yellow rear card became visible. `before-tap-0.2.png` reproduces this in the actual app. The next frame returned to the lavender route surface.

## J. Cause classification

- Stack ordering: correct rear-to-front order; no reorder needed.
- Clipping: card ink now explicitly clips to its rounded Material surface.
- Scale animation: not the cause; held press retained foreground geometry.
- InkWell/Material: hardened the existing shared card with an opaque Material and anti-aliased clipping.
- Radius mismatch: route previously used 30dp while the card used 28dp; unified to 28dp.
- Primary cause: incomplete deck visibility handoff and hiding the source before the route's first painted frame.

## K. Exact fix

Push the route first and hide the complete Schedule deck after the first frame. Keep every source layer hidden throughout forward/reverse route ownership, restoring it after the route completes. This avoids both the exposed rear card and an empty handoff frame. Preserve the idle accent strips, stable per-record palette, deck order and swipe behavior. Exterior card shadows remain outside the inner Material clip.

## L. Shared card component affected

Reused `ScheduleRecordCard`, `UpcomingShiftDeck` and `pastelDetailRoute`. No parallel card implementation or business-data substitution was introduced.

## M. Widget tests

Added six role/width nav geometry tests and three press/handoff/return tests. They verify equal hit areas, circle alignment, selected semantics, safe inset, stationary held geometry, all rear-layer opacities during transition and restoration. Existing motion tests cover cyclic decks, rapid swipes, reduced motion, five palettes, route reversal and record identity. Existing visual tests cover long content and enlarged text. Reviewed and refreshed the two shared-surface golden baselines for the intended nav change.

## N. Flutter analyze

PASS: no issues found. Evidence: `analyze.log`.

## O. Flutter tests

PASS: 199 tests. Evidence: `tests.log`. The initial run identified only the two expected nav golden differences; final normal run passed after visual review and baseline update.

## P. Android build

PASS: `flutter build apk --profile`, 109.2MB. Evidence: `build.log`. APK: `build/app/outputs/flutter-apk/app-profile.apk`. Installed without clearing signed-in account data.

## Q. Real emulator/device visual QA

Actual native Android app, two signed-in role emulators. Captured idle/held press, opening and Android back transitions. Compared the nav with the supplied target proportions. Reviewed final opening frames at 1.4–1.7 seconds and final return/restoration frames. The yellow rear surface no longer flashes across the foreground. The final handoff preserves foreground coverage; the intended accent strips return after navigation completes.

Key evidence:

- `before-home.png`, `before-pressed.png`, `before-tap.mp4`, `before-tap-0.2.png`.
- `final-home.png`, `final-opening.mp4`, `final-opening-1.5.png`, `final-opening-1.6.png`.
- `final-return.mp4`, `final-return-1.7.png`, `final-return-2.2.png`.
- `staff-home.png`, `staff-calendar.png`, `staff-history.png`, `staff-profile.png`.
- `venue-home.png`, `venue-calendar.png`, `venue-offers.png`, `venue-profile.png`.

Intermediate `after-*` recordings document the investigation; `final-*` recordings verify the final timing fix. Native Venue Manager data had no upcoming events, so its populated card behavior is covered by shared component/widget tests; native card transition reproduction was performed with Staff data.

NAV REFERENCE COMPARED: YES

UPCOMING CARD TAPPED IN REAL APP: YES

GLITCH REPRODUCED BEFORE FIX: YES

GLITCH GONE AFTER FIX: YES

SCREENSHOTS CAPTURED: YES

**NAV + UPCOMING CARD FIX COMPLETE**
