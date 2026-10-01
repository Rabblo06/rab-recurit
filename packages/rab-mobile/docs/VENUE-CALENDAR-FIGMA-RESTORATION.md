# Venue Manager Calendar - Figma Restoration

Date: 2026-09-30. Visual reference: user Screenshot 1; current implementation remains the functional authority.

## 1. Root cause of UI drift

VenueCalendarScreen adapted events into the same ScheduleCalendar used by Staff. That widget initially selected Month; Today only suppressed the grid and continued to render _dayContent, including a large selected-date heading, count and generic empty card. There was no week strip/agenda branch. This is the verified local code cause; git history does not establish the human reason for the change. No historical business logic was restored.

## 2. Existing Calendar architecture

VenueManagerProvider supplies server-scoped events and offers. VenueCalendarScreen excludes cancelled records, sorts actual shift starts and supplies existing detail callbacks. ScheduleCalendar owns selected/viewed dates and view mode. The existing shell owns four nested Navigators and the floating bottom bar. These responsibilities remain.

## 3. Files changed

- lib/core/widgets/schedule_calendar.dart: opt-in agendaStyle presentation, compact header, week strip and date rail.
- lib/features/venue_manager/venue_manager_screens.dart: Venue Manager opts into agenda; authorized pay/team fields and pastel styling. Optional now injection supports deterministic tests; runtime defaults to the current clock.
- test/venue_calendar_ui_test.dart: replace superseded identical-Staff-layout assertions with compact Venue Manager geometry; retain Month/Staff/navigation regressions.
- test/venue_calendar_restoration_test.dart: new visual, selection, grouping, missing-pay, loading/error and overnight-policy coverage.
- test/fixtures/venue_calendar_fixture.dart: synthetic test-only provider records, never production seeds.
- test/goldens/venue-calendar-restored.png: newly rendered and visually inspected baseline.
- This report and canonical docs/HANDOFF.md.

Pre-task snapshots: .audit/venue-calendar-restoration/before. Unrelated existing dirty work preserved.

## 4. Header restoration

Venue Manager header is 22px, left-aligned, with a compact 44px profile touch target, 16px side insets and existing SafeArea. The selected/current month is used. Profile callback unchanged. Staff header remains unchanged.

## 5. Today / Month toggle

Reuses the existing 48px pill and restrained selection animation. Venue Manager initially displays Today agenda. Today resets to actual current date (or injected test clock). Month retains the previous grid.

## 6. Seven-day selector

Seven dates surround the initial/current date, including weekday and day number. Selected tile is near-black with white text and rounded corners. Screen-reader selected state and full date label included. Each touch region is at least 44px wide; narrow or enlarged-text displays can scroll the strip horizontally. Tapping sets the same selected date and scrolls to its agenda group.

## 7. Agenda layout

One vertical ListView, compact left date rail and right event column. Multiple records share a date label. Empty days reserve light whitespace. Header follows the same vertical scroll; there is no second vertical scroll container. The seven-day range is presentation-only and makes no per-day requests.

## 8. Shift card design

Reuses ScheduleRecordCard, ScheduleRoundArrow and ScheduleAvatarStack. Mint #E7F4EE and peach #FCEADF alternate deterministically in sorted event order; they do not imply business status. Current role, venue, available address and detail route retained. Existing shared card geometry is reused rather than changing other screens.

## 9. Pay display

Displays payRatePence only when supplied as a number in the current authorized shift response, formatted with the existing money helper. Missing rate falls back to existing Staff joined count; it never fabricates a zero rate. No editing/override control or new API request.

## 10. Team avatars

Existing confirmed-offer team projection only. Up to three initials avatars plus remaining count, with real names in accessible semantics. No invented team membership, remote stock avatars or extra image downloads. Zero team shows No team assigned.

## 11. Empty-state behavior

Today has date labels/whitespace, not one large empty card per date. Entire empty week has one small No scheduled events label. Existing loading skeleton and sanitized retryable error remain. Provider authorization-failure clearing is intentionally unchanged.

## 12. Month view preservation

Previous/next month, date picker, grid selection, dots/legend, selected-day summary and existing empty-day treatment remain. Both widget tests and native Android check verified switching Today/Month. Staff default Month layout remains unchanged.

## 13. Bottom-nav behavior

No navigation-shell source changed. Calendar is still root index 1 and shows the existing floating white bar with black selected circle. Pushed details/Send Shift/Users/Reports retain their recently implemented hidden-nav behavior. Existing back-navigation regressions passed.

## 14. Calendar state handling

One selected date and viewed month remain in ScheduleCalendar state. weekStart anchors the visible seven dates; it is not another selection. Day keys only identify scroll targets. UI transitions use existing reduced-motion handling.

## 15. Timezone / overnight handling

Reused scheduleEntriesOn unchanged: existing model converts server instants with toLocal and includes a record on each local day it overlaps, with exclusive end boundaries. Therefore a 21:00-05:00 shift remains on both overlapping days, while an exact-midnight end does not appear on the next day. This was current intentional behavior and is explicitly regression-tested; no raw UTC grouping or new London-time conversion was introduced. Venue Manager cards represent parent shifts; individual assignment-time work is untouched.

## 16. Security / server scoping

No backend, DTO, permissions, RLS, authentication, eligibility, QR, geofence, replacement, cancellation or worker code changed. Current provider still fetches authenticated scoped /shifts, /venues, /job-roles and /offers in pages of 100 until the existing total is reached. It does not currently use a week-range request; this restoration neither broadens nor redesigns fetching. Card navigation retains the original VenueEventDetail and server checks. Synthetic fixtures are only in test/build QA files.

## 17. Widget tests

72 passed across venue_calendar_restoration_test, venue_calendar_ui_test, calendar_ui_test and venue_manager_test. Includes day selection semantics, Today/Month, multi-event grouping, empty date/week, pay omission, avatars, loading/sanitized retry, existing detail routing, root/nested navigation, overnight behavior and 320/390/393/430px layouts at normal/enlarged text. Logs: .audit/venue-calendar-restoration/tests-final.log.

## 18. Golden comparison

390x844 golden rendered, inspected and then tested without --update-goldens. Compared against supplied Figma for compact header/control, week strip, black tile, date rail, pastel cards, team/rate placement and floating navigation. Android emulator-5554 profile fixture also inspected in Today and Month: .audit/venue-calendar-restoration/android-agenda.png and android-month.png. Native images precede a punctuation-only correction from question mark to middle dot; final golden includes the corrected separator. No native backend/auth integration claim from the in-memory fixture.

## 19. flutter analyze

Clean. Normal lib/main.dart Android profile build passed and was reinstalled and launched on emulator-5554 without clearing app data. The retained session opened Calendar; Today/Month controls and week-date accessibility semantics were verified in normal-calendar-ui.xml. The test fixture is no longer the running application. Build evidence: .audit/venue-calendar-restoration/android-normal-build.log. No release deployment performed.

## 20. Remaining differences from Figma

Actual/current dates and real authorized content replace reference dates/data. Status and scheduled time remain as a compact additional line. Existing accessible touch targets, shared card typography and current floating navigation are retained; no global nav redesign. Initials replace unprovided photos. Missing pay safely shows staffing count. Enlarged text adapts spacing. The current overlap rule for overnight records is preserved rather than silently changed to start-date-only.

## 21. Remaining work

No known unresolved Calendar UI defect after local tests and visual checks. Physical iOS QA and release deployment are not performed. Prior assignment-time worker approval-review block remains a separate task; no worker tests were attempted for this UI-only restoration. Do not describe the emulator fixture as real production staffing data.
