# RAB SHIFT COLOUR + HANDOFF SYSTEM REPORT

22 September 2026. Scope: stable shift visual identity and persistent agent handoff. No backend contracts or business rules changed.

## A. Root cause

The same underlying Shift could acquire unrelated colours because presentation code used deck encounter order, provider encounter order, list position, calendar parity, fixed defaults or offer status. The previous per-deck cache survived some reorders but not remounts, filtering/reintroduction or other screens.

## B. Previous selection locations

| Location | Previous selection | Current rule |
| --- | --- | --- |
| `ShiftVisualStyle.forSlot/forList` | Slot/list palettes | Removed; one `forShift` resolver |
| `ScheduleTokens.stackColorForDepth/expandedColorForIndex` | Position/interpolated palette | Removed |
| `UpcomingShiftDeck._syncStyles` | Encounter counter/cache | Underlying shift id |
| `UpcomingShiftCard` fallback | Stack depth | Underlying shift id |
| `shift_routes.dart` | List colour interpolation; lavender fallback | Same shift style throughout route |
| Staff Home today's card | Fixed peach | Today's shift id, neutral empty-state fallback |
| Staff Calendar | Even/odd mint/peach; lavender details | Offer's shift id |
| Staff Offers | Enum indexed by row | Offer's shift id |
| Staff History | White shift panel | Attendance's shift id |
| Staff Details | Lavender default | Offer's shift id default |
| Staff Clock | Yellow/default route styling | Authoritative displayed record/selected shift id |
| VM provider | Encounter-order cache | `VenueEvent.shiftId` |
| VM Home next event | Fixed peach | Provider's shared resolver |
| VM Calendar | Even/odd mint/peach; lavender details | Event's shift id |
| VM Sent Shifts | Whole-card status tint | Offer's shift id; status label retained |
| VM event/report lists | Provider-generated style | Inherit the shared resolver |

The non-shift staff/member list formerly used `forList`; it now uses a neutral surface. Aggregate dashboard statistics, status badges, permission warnings and empty placeholders retain semantic styling. The old non-Schedule presentation branch remains for compatibility; active application callers use Schedule.

## C. Stable identity

`OfferSummary.shiftId` and `AttendanceSummary.shiftId` refer to the underlying Shift. Offer/attendance `id` values are distinct record identities and are not used for colour. `VenueEvent.id` comes from the shift payload; `shiftId` aliases that value. `ShiftReport.shiftId` already exists. Server offer mapping explicitly returns `r.shift_id`. No additional backend field was needed. QA used actual created Shift UUIDs and confirmed assignments, not matching titles or venues.

## D. Deterministic algorithm

`ShiftVisualStyle.forShift`: start at zero; for each UTF-16 code unit compute `(hash * 31 + unit) % 2147483647`; select `palette[hash % 5]`. Arithmetic remains exact on Dart VM and JavaScript. Empty identity is rejected. No runtime hashCode, random value, date, row position or mutable cache participates.

## E. Shared palette

One fixed order in `ShiftVisualStyle.palette`: lavender, yellow, peach, mint, blue. Existing RGB tokens remain in `ScheduleTokens`: DFE2FF, FFDA79, F6E7DF, DDEFE9, DCEAFB. Palette order and algorithm are documented visual contracts. Different shifts may legitimately collide on a colour.

## F–I. Migration and transition consistency

Staff and Venue Manager use the same resolver. Existing `ScheduleRecordCard`, `UpcomingShiftCard` and deck architecture are reused. Calendar date filtering and order cannot affect colour. The tap-to-detail morph still captures the source bounds and selected style, with the existing first-frame handoff and reverse dismissal restoration. Details retain their existing stronger gradient derived from the same style; they are not flat cards with identical RGB at every pixel. Clock likewise retains its established derived ring/sheet shades. Status badges remain semantically separate.

Production files changed for this task: `core/theme/shift_visual_style.dart`, `core/theme/schedule_tokens.dart`; Staff `calendar_screen.dart`, `history_screen.dart`, `schedule_home_screen.dart`, `schedule_clock_screen.dart`, `schedule_offers_screen.dart`, `schedule_offer_detail_screen.dart`; Home widgets `upcoming_shift_card.dart`, `upcoming_shift_deck.dart`, `shift_routes.dart`; VM `venue_manager_provider.dart`, `venue_manager_screens.dart`, `sent_shifts_screen.dart`. Eleven existing analyzer brace findings were fixed in `forgot_password_screen.dart`, `attendance_provider_test.dart`, `login_navigation_test.dart`, `root_gate_isolation_test.dart`. No attendance/security behavior changed.

## J. Tests

- Added `shift_colour_identity_test.dart`: 100 repeated calls per known id, fixed expected values, all five colours reachable, empty-id rejection, Staff/VM underlying identity, reorder/filter/new model instances.
- Updated `shift_motion_test.dart`: actual shift mapping during every swipe frame, rebuild, reorder, removal and reintroduction.
- Updated `home_visual_states_test.dart`: identity colour across Offers, View All, detail routes and Back; existing handoff/cancellation assertions retained.
- Visually reviewed changed deck/clock/completion golden output before refreshing `schedule_components_golden_test.dart` and `schedule_clock_screen_test.dart` baselines. Golden changes are expected identity colours; geometry is preserved.

## K. Real native visual QA

Android emulator-5554, installed profile APK. Five confirmed shifts in one isolated local organisation/workspace, same Staff assignment and venue. Native Home deck, Upcoming list, Calendar, Details, VM Home deck, VM Calendar and VM Sent Shifts were opened and captured. Screenshot timestamps/date-times and the controlled API dataset establish the mapping; identical titles alone were not used as identity evidence.

| Shift ID | Home | Calendar | Upcoming | Details style | VM Home/Calendar/Sent | Match |
| --- | --- | --- | --- | --- | --- | --- |
| f9508b09-d47d-48c2-9f05-ca988be1c391 | mint | mint | mint | mint | mint | YES |
| beb0e732-a0fd-4f98-8eee-87afeff9e6bc | peach | peach | peach | peach | peach | YES |
| d6c0d594-11c2-424c-ad5a-4d6e09fdcc9f | mint | mint | mint | mint | mint | YES |
| 4882387d-91d0-45be-8f19-4ce799399785 | peach | peach | peach | peach | peach | YES |
| 86745fb8-78fc-4564-8b4c-6be9088aa40d | lavender | lavender | lavender | lavender | lavender | YES |

[Comparison page](comparison.html), [comparison image](comparison.png), `home-1..5.png`, `detail-1..5.png`, `upcoming-top/bottom.png`, `calendar-top/bottom.png`, `vm-home-1..5.png`, `vm-calendar-top/bottom.png`, `vm-sent-top/bottom.png`. `vm-restarted.png` confirms the first shift retains mint after process restart. Two QA colours collide by design; all five palette entries are covered by deterministic tests.

Native completed History, clock mutations and finalised reports were not repeated: the fixture contains future shifts only. History/Clock/report consumers were inspected/migrated and relevant regression suites passed. Upcoming satisfies the requested History/Upcoming matrix alternative.

## L–N. Handoff, instructions and secrets

Created the single canonical `docs/HANDOFF.md`; no prior HANDOFF existed. Added root `AGENTS.md` and linked existing `CLAUDE.md` to the same file. They require reading it before changes, inspecting git state, checking documentation against code, and updating the handoff after substantial work or important new modules. Handoff records actual architecture, security, components, attendance, Worker/API, current LOCAL/S3 storage, tests, decisions and remaining QA. Reviewed for secrets/personal data: environment variable names only, no secret values or credentials.

## O–Q. Regression results

- `flutter analyze`: no issues (`analyze.log`).
- `flutter test`: 227 passed (`test.log`), including refreshed goldens.
- `flutter build apk --profile`: passed, 109.2 MB (`build.log`).
- Backend/API contract tests not required: no contract or backend production changes.

## R. Cleanup and limits

Organisation `f7df3f5a-6685-4025-8a5a-59c1a537d9f6`, workspace `273988ec-f195-4d1f-b0bc-860840e09297`. `fixture-proof.json`, `colour-matrix.json` and `cleanup-proof.json` contain non-secret QA identifiers. All five shifts cancelled; three QA users deactivated/password hashes removed; zero unrevoked refresh tokens; private local credential file deleted. QA organisation, workspace, venue, profiles, cancelled shifts, assignments and audit history retained intentionally. No attendance was clocked or modified.

No remaining colour mismatch in verified surfaces. Existing Upcoming scrolling/header overlap and the VM Home card's below-fold content are layout follow-ups outside this colour-only change. Original screenshot title/pay discrepancies are not proof of a shared Shift and were not silently rewritten. Physical-device release QA remains separate.

SHIFT COLOUR CONSISTENCY + HANDOFF COMPLETE
