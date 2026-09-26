# Shift colour distribution verification

2026-09-22 — SHIFT COLOUR DISTRIBUTION FIX COMPLETE

## Cause and correction

Previously, `ShiftVisualStyle.forShift` computed `hash = (hash * 31 + UTF16Unit) % 2147483647`, then selected `hash % 5`. The approved palette remains lavender, yellow, peach, mint and blue. Direct modulo has collisions: QA IDs `cb91c175-d33b-4524-9105-249e9a1e07f3` and `24ffa39a-04e5-4441-9f60-114557fdaa7f` both preferred mint. Earlier QA also produced two mint and two peach cards.

The hash now supplies a preference, not the final assignment. One shared `ShiftColourRegistry` records Shift ID -> palette slot. Whole-group registration reserves existing assignments, picks the least-used nearby slot, probes deterministically from the preferred slot and avoids the previous colour when alternatives exist. A new five-shift group can fill all five slots before reuse. All surfaces continue using `ShiftVisualStyle.forShift`; there are no separate screen allocation algorithms. Offer/attendance IDs, titles, dates and list indices do not identify colours.

## Lifetime and limitations

The smallest requested option was selected: process-lifetime memory. Navigation, rebuilds, refresh, filtering, insertion, logout/login and role switching keep existing assignments. A cold restart starts a new allocation session. The same discovery sequence reproduces assignments; a different discovery sequence may not. There is no local persistent cache, backend column or cross-device guarantee.

Known shifts are never recoloured. If previously separate groups with conflicting assignments later merge or are filtered together, those existing collisions remain: immutable identity takes priority. New assignments use available alternatives. Status styling remains independent.

## Real Android visual matrix

Profile APK on emulator-5554, 1080 x 2340. Every listed surface was opened, captured and visually inspected. Details uses its existing stronger tint/gradient within the same colour family.

| Shift ID | Upcoming | Home | Calendar | History | Details |
| --- | --- | --- | --- | --- | --- |
| 6a8cd10f-1463-44d7-87dd-883f5f3600c6 | Yellow | Yellow | Yellow | Yellow | Yellow |
| cb91c175-d33b-4524-9105-249e9a1e07f3 | Blue | Blue | Blue | Blue | Blue |
| 24ffa39a-04e5-4441-9f60-114557fdaa7f | Mint | Mint | Mint | Mint | Mint |
| 6870a12c-0b07-4421-8601-dfaf8ae8c2d6 | Lavender | Lavender | Lavender | Lavender | Lavender |
| b99c97eb-fd2d-4f64-9740-976d63584d97 | Peach | Peach | Peach | Peach | Peach |

Venue Manager Calendar also matched every row. Upcoming started from the fifth card after cycling the deck, demonstrating unchanged colours under list rotation. History displays reverse completion order and still matches.

Evidence: [Home/Details comparison](comparison.html), [contact sheet](comparison.png), `upcoming-top.png`, `upcoming-bottom.png`, `calendar-top.png`, `calendar-bottom.png`, `history-top.png`, `history-bottom.png`, `vm-calendar-top.png`, `vm-calendar-bottom.png`, and `colour-matrix.json`. Original future dates distinguish the initial cards; `history-proof.json` identifies each completed record and its order after fixture scheduling adjustments.

## QA fixture integrity and cleanup

Organisation: `03d5ee54-4766-4849-9c16-66f30718c6d6`.
Workspace: `eae9b4fa-814d-4f5b-bb89-9e6db398564f`.
Venue: `902bf8ee-e823-4cfa-b34c-21c49367a079`.

Five real confirmed assignments were created through the local application APIs. After future-card captures, only these verified disposable shifts' schedules were adjusted to the current clock window. Fresh signed QR identity/venue/version was checked against database state. Each pair of clock-in/out calls used the same QR and valid venue coordinates through the real Staff APIs. Attendance rows and statuses were not fabricated or directly overwritten. This prepared real History data; it is not evidence of a native camera/scan flow. No stale or unknown attendance was touched.

Cleanup verified no active attendance. All five shifts are completed, all three QA users are deactivated with credentials removed, and zero refresh tokens remain unrevoked. Local credential file deleted. QA organisation, workspace, venue, assignments, completed attendance and immutable audit records retained. See `cleanup-proof.json`.

## Code and verification

Changed this task:

- `lib/core/theme/shift_visual_style.dart`: shared registry and portable preference seed.
- `lib/features/offers/offers_provider.dart`: register the loaded offer group.
- `lib/features/venue_manager/venue_manager_provider.dart`: register the loaded event group.
- `lib/features/home/widgets/upcoming_shift_deck.dart`: register all records before lazy rendering.
- `lib/features/history/history_screen.dart`: register history identities before rendering.
- `test/shift_colour_identity_test.dart`: collision distribution, five colours, neighbours, reuse, immutable assignments, duplicate IDs, insertion/filter/reorder and deterministic session replay.
- Canonical `docs/HANDOFF.md` updated; this document is a verification report, not a second handoff.

`flutter analyze`: no issues. `flutter test`: 231 passed, including existing goldens, role isolation and card-morph/handoff regressions. `flutter build apk --profile`: passed, 109.2 MB. `git diff --check`: passed. No golden regeneration needed.

Card morph, route handoff, geometry, navigation and production backend logic were not changed. The shared deck only gained group registration. All five native detail opens and returns completed successfully. No new frame-by-frame video claim is made. Existing Upcoming pinned-header card overlap remains outside this colour-only change.
