# NAV + UPCOMING SHIFT CARD FIX REPORT

22 September 2026. Focused changes to the existing Flutter app; no attendance, API authorization or scheduling logic changed.

## A. Nav root cause

MovingTabBar used an independently positioned indicator whose x-coordinate was interpolated between tabs. Icon colours transitioned separately. Rapid selection could therefore show the indicator between icon centres. The Classic branch additionally redistributed selected width and animated its label, moving neighbouring icons. These mechanisms were found in source; this pass did not record the old build reproducing the user's video.

## B. Nav fix

The same MovingTabBar now renders a Row of four Expanded cells. Every cell has the same fixed bounds, a centred 54dp circle box and a 24dp icon. Selection changes background/icon colour immediately within that cell. There is no sliding Positioned indicator, width interpolation or selected-label expansion. The existing Schedule shell remains 72dp with its existing padding, shadow, SafeArea and width constraints.

## C. Did selected/unselected outer geometry differ?

Schedule: its cells already had equal widths; the independent indicator still moved between them. Classic: YES, selected width and label expansion changed the layout. Both now have fixed equal cells. Classic destination names remain available through tooltips and semantics rather than an expanding selected label.

## D. Did animation cause re-layout?

YES in the Classic width interpolation. Schedule animated indicator position without changing cell width. Both mechanisms were removed. The shell and every item Rect are tested before selection and at intermediate frame intervals afterward.

## E. Upcoming card root cause

The source deck and custom expanding detail route had separate visual ownership. The route recreated the front card while the deck hid its layers on a later frame. The accent was absent from that recreation; the front surface then expanded independently. This architecture permitted a detached/hanging appearance during the handoff even though the deck's own paint order was correct. This is a source-based diagnosis, not a claim of a fresh pre-fix native reproduction.

## F. Classification

| Candidate | Finding |
| --- | --- |
| Stack order | Foreground was already last at rest; not reversed on a tap |
| Clipping | Existing shared card clipping retained |
| Transform.scale | Deck depth scaling serves deliberate stacking/swiping; no new press scale added |
| InkWell/Material | Existing bounded ink feedback retained; native held frame changes tone without geometry movement |
| Hero | No Hero involved; the custom route performed a similar front-only recreation |
| Radius mismatch | Shared 28dp card radius already consistent |
| Offset/margin | Schedule detail tap already avoided the earlier pre-route lift |
| Actual change | Removed front-only route recreation and expanding geometry |

## G. Exact card fix

The shared pastelDetailRoute now fades the destination over the intact mounted source deck (200ms, or 140ms reduced motion). UpcomingShiftDeck does not hide its layers for that detail path. No foreground clone is painted, no source radius/size/position changes, and no separate rear layer is left hanging. Reverse navigation reveals the same deck. Input remains locked while navigation is active. Deliberate vertical deck cycling and View all behavior remain intact.

The brief full-page crossfade blends the destination and Home normally; it does not move the rear accent over the foreground. This intentionally replaces the broken expansion animation rather than preserving it.

## H. Shared components

Refactored MovingTabBar, UpcomingShiftDeck and pastelDetailRoute in shift_routes.dart. Staff and Venue Manager already call these shared components. UpcomingShiftCard, ScheduleRecordCard, VenueEventCard and existing visual tokens were reused. No second nav or card widget was created. The native recording in this pass is Staff; shared VM behavior is covered by the existing full widget suite.

## I. Widget tests

navigation_geometry_test.dart checks Staff/VM destination labels at 320, 393 and 430 logical pixels. It compares the shell and all four item Rects before/after every selection and at intermediate intervals, verifies a constant 54dp circle centred in the selected cell, and retains semantics checks.

home_visual_states_test.dart checks idle/held geometry at three widths, intact layer opacities during entry/return, all five card styles, correct route content, and no source recreation. Existing long text, pay, footer/avatar, overflow, rapid tap and swipe tests pass. Assertions tied to the obsolete expanding route were replaced with stable-source assertions.

## J. Golden tests

All eight existing Staff/VM nav goldens pass unchanged. Added upcoming-deck-idle.png and upcoming-deck-pressed.png in test/goldens and visually inspected both. Their geometry and accent relationship are identical. Existing surface and clock goldens continue to pass. The first new-golden run failed because no baseline existed; only the two new baselines were generated, then the full suite passed.

## K. Flutter analyze

PASS: no issues found, 5.7 seconds. Log: ../nav-card/two-bugs-analyze.log.

## L. Flutter test

PASS: 223 tests. Log: ../nav-card/two-bugs-tests.log. A subsequent test-only string interpolation lint fix does not change test behavior.

## M. Android build

PASS: profile APK, 109.2MB. Log: ../nav-card/two-bugs-build.log. Installed on emulator-5554 for the recordings below.

## N. Real emulator QA

Production app, normal QA login, real confirmed shift data in an isolated local organisation. No demo app, alternate widget entrypoint or fabricated production response was used.

Videos:

- [Native tab sequence](nav-after.mp4): Home → Calendar → History → Profile → Home.
- [Native card sequence](card-after.mp4): idle → held press → detail entry → detail → Android Back → Home, with two real upcoming shifts and a visible rear accent.

Frames were extracted from the videos and opened for inspection, including 20ms sampling around card entry. Examples: card-after-0.1.png (idle), card-after-1.8.png / 1.84.png (held), card-after-1.88.png / 1.92.png (entry), card-after-2.png (detail), card-after-3.9.png (reverse), card-after-4.2.png (returned). Nav frames at 0.1, 0.8, 1.2, 2, 4, 6 and 8 seconds show the fixed shell/icon centres and selected-circle size across all four destinations. No rear/front inversion, lifting or rear-colour bleed was observed in the inspected after-fix sequence.

Explicit results:

| Required statement | Result |
| --- | --- |
| NAV BUG REPRODUCED BEFORE FIX | NO — source inspected; no fresh before-build recording |
| NAV GLITCH GONE AFTER FIX | YES — observed after-fix sequence and geometry tests |
| UPCOMING CARD BUG REPRODUCED BEFORE FIX | NO — source inspected; no fresh before-build recording |
| REAR COLOUR BLEED GONE | YES — observed two-layer sequence |
| CARD HANGING/LIFTING GLITCH GONE | YES — observed press, entry and return |
| REAL VIDEO AFTER FIX CHECKED | YES — extracted native video frames inspected |

### QA isolation and cleanup

Organisation e3ce6c0c-d577-4a88-b486-46a50052f720; workspace e8376fb6-d1b3-4eb5-9de6-d1e7473e929a. Fixture shifts: 9677afba-b912-469c-8db0-111b581571f4, dc99158e-354b-4a26-aa56-b799b2dddd1a and ca4c535a-3a73-47f8-b7d8-2c1e79f7fb5b. The latter two provided the upcoming layers. Fixture proof JSON files contain their venue/assignment scope.

The existing overlap guard rejected an overlapping second shift; a non-overlapping next-day shift was used instead. Login throttling was allowed to expire. Neither guard was changed or bypassed.

All three shifts were cancelled through the guarded API. All three QA users were deactivated, password hashes cleared, refresh tokens revoked (zero remain), and the Staff profile deactivated. The emulator returned to login. Private credential and QR files were deleted. Isolated cancelled records and audit history were retained for referential integrity; see cleanup-proof.json. No attendance action was performed in this UI-only test.

**NAV + UPCOMING SHIFT CARD FIX COMPLETE**
