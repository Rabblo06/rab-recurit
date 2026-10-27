# Story and motion plan

This is the story and motion plan for the introduction film. Agent B proposed it and the lead reconciled it. Timings are re-anchored to the measured narration in `timeline.json`.

## Rules

**Frame and type**
- The canvas is 1920×1080.
- Content sits between y 24 and y 964. The band from y 972 to 1064 is reserved for captions, so captions never cover UI. Captions use Inter 500 at 30 px, charcoal on `#F8F8F9`, at most 2 lines of 42 characters.

**Web stage**
- Real web footage at native 3200×1800, shown in a white window: 16 px radius, 1 px `#E5E7EB` border, soft shadow, on `#F8F8F9`.
- The camera transform sits inside the window clip. Full stage: 1664×936 at (128, 28). Split stage: 1060×596 at (72, 184).

**Phone**
- Native Flutter footage at 1080×2340 is contain-fitted, never stretched, inside a generic DeviceFrame: 12 px bezel, 44 px radius.
- Hero size is 880 px tall. Use 720 px when two phones share the frame.
- The phone camera is a scale around a target, between 1.2 and 1.6×.

**Camera**
- Overview → focus → hold → return. Moves take 0.8–1.0 s with an ease-in-out cubic and no overshoot. Holds last at least 1.8 s. Zoom stays between 1.2 and 1.65×.
- Only one thing moves at a time. Focus boxes are never cropped.

**Brand**
- Colours: `#FFFFFF`, `#F8F8F9`, `#24252B`, `#646873`, orange `#FF7A1A` / `#FFA31A`, border `#E5E7EB`. Font: Inter. No red anywhere.
- The logo is `images/brand/logo-light.png`, never recoloured.

**Diagrams vs real screens**
- Diagrams sit on a dotted-grid surface with a "DIAGRAM" tag.
- Real screens only ever appear inside the WebStage window or the DeviceFrame.
- Title graphics carry no tag and no UI chrome.

**Tokens**
- The ShiftCard, OfferCards, team chips and the PDF DocToken exist only in flight. They dissolve into the real element they land on.

**Sound**
- About eight sparse accents: soft clicks and two whooshes, generated locally with ffmpeg.
- They are mixed after the narration loudnorm pass. Voice-led, no music.

**Chapters**
- A ChapterCard fills each chapter-end pause: a `#F8F8F9` wipe, "0N" in orange, and the title in charcoal. It is followed by a ChapterPill for 3 s.

## Scene manifest

The timing column is an estimate.

| Scene | Chapter | Narration | Layout | Real footage | Graphics |
| --- | --- | --- | --- | --- | --- |
| S00 | Why Crewflow | silent beat, then c1-need | Title surface | none | Three RoleNodes (Venue "Needs a team", Manager "Who's booked?", Staff "Where, and what next?") with dashed, broken links. |
| S01 | Why Crewflow | c1-connect, then HOLD | Title surface | none | An orange line connects the nodes, then becomes the strip Request → Confirm → Work → Review → Final timesheet, then the logo lockup and subtitle. ♪ click. |
| CC1 | Who uses it | gap | Card | none | "02 · Who uses it" |
| S02 | Who uses it | c2-web | Web stage, full | intro-web-console (Dashboard, sidebar workspace) | RoleNode "Manager · Web console". Kinetic "Private workspace". |
| S03 | Who uses it | c2-mobile | Web stage, split, plus two phones | VM Sent shifts and Staff Offers (idle) | RoleNodes "Venue manager · App" and "Staff · App". |
| CC2 | Build the team | gap | Card | none | "03 · Build the team" |
| S04 | Build the team | c3-records | Web stage, full | intro-web-team: Users, then Venues | none |
| S05 | Build the team | c3-assign | Web stage, full | intro-web-team: Riley → Assigned staff → add Isla | Label "Riley Chen · Riverside House". Kinetic "Assigned team". |
| S06 | Build the team | c3-scope | Web stage dims left, phone right | VM Select staff list | Four name chips fly from web to phone. Kinetic "Only their team". |
| CC3 | Request and approve | gap | Card | none | "04 · Request and approve" |
| S07–S10 | Request and approve | c4-need → c4-send | Phone hero plus ShiftCard | VM Send Shift form, Select staff (4), availability warning → Submit anyway → success → Sent shifts | ShiftCard fills field by field and gains a "Pending approval" chip. [D] inset: VM → Manager (lit) ┄ Staff (dim, "Not yet"). |
| S11 | Request and approve | c4-approve | Phone → web handoff | intro-web-approve: pending row → Shift Approval drawer → Approve → board | The ShiftCard arcs from the phone and lands on the "Pending approval" row. ♪ whoosh, then ♪ click on Approve. Kinetic "Approved". |
| CC4 | Offers and confirmation | gap | Card | none | "05 · Offers and confirmation" |
| S12 | Offers and confirmation | c5-offers | [D], then phone | Staff Offers list | The ShiftCard splits into four OfferCards (values copied from the fixture). Priya's card flies into the phone. |
| S13 | Offers and confirmation | c5-accept | Phone hero | Offer details → Accept → CONFIRMED | StateChip changes Offered → Confirmed. ♪ click. |
| S14 | Offers and confirmation | c5-branch | [D] "Two ways to fill a shift", plus a web inset | intro-web-confirm (Daniel Okafor, Awaiting Confirmation) | Lane A: Accept → Confirmed. Lane B: Accept → Accepted (reserved) → Manager confirms → Confirmed. No timeout numbers. |
| S15 | Offers and confirmation | c5-board | Web stage, full | intro-web-board | none |
| CC5 | Shift day | gap | Card | none | "06 · Shift day" |
| S16 | Shift day | c6-ready | Phone hero | Staff confirmed shift with notes, then the clock screen | Eyebrow "Friday". |
| S17 | Shift day | c6-scan | [D] left, phone right | Location sheet → Scan venue QR → clocked in | [D] One signed QR → "Crewflow server checks the code". Dashed: "On site — where the venue requires it". ♪ tick. |
| S18 | Shift day | c6-live | Phone hero | LIVE SHIFT timer | Kinetic "Timed by Crewflow's clock". |
| S19 | Shift day | c6-out | Phone hero | Scan again → clocked out | StateChip "Clocked out". Kinetic "Recorded hours". |
| CC6 | Review the hours | gap | Card | none | "07 · Review the hours" |
| S20–S25 | Review the hours | c7-report → c7-gate | Phone plus [D] ReviewTracker | VM Reports → shift report (Isla Missing) → correction with reason → Save → Mark reviewed ×4 → Staff review tab → footer enabled | Tracker rows: Missing → "Corrected · awaiting review" (not reviewed) → Reviewed 4/4. Rating shown as an optional, detached row. Gate opens. |
| CC7 | Final timesheet | gap | Card | none | "08 · Final timesheet" |
| S26 | Final timesheet | c8-sign | Phone hero | Sign off the timesheet: tick, typed name, Sign & send | Kinetic "Signed off. Hours locked." ♪ click. |
| S27 | Final timesheet | c8-pdf | Phone plus [D] lifecycle strip | Generating PDF → Queued for delivery → Sent; then the PDF viewer | Chips light on the exact frames the app labels change. |
| S28 | Final timesheet | c8-web | Phone → web | intro-web-after: board → Timesheet report drawer; mobile History | A DocToken flies from the phone to "Venue Signed Timesheet". ♪ whoosh. |
| CC8 | Manage the operation | gap | Card | none | "09 · Manage the operation" |
| S29 | Manage the operation | c9-payroll | Web stage, full | intro-web-after: Payroll, All records, never wide | Kinetic "Ready for your payroll provider". |
| S30 | Manage the operation | c9-reviews | Web stage, full | intro-web-after: Priya → Staff reviews | none |
| S31 | Manage the operation | c9-dash | Web stage, full | intro-web-after: Calendar → Dashboard with real count-ups | none |
| CC9 | Behind the scenes | gap | Card | none | "10 · Behind the scenes" |
| S32–S33 | Behind the scenes | c10-system, c10-jobs | [D] "How it fits together" | none | Web console and app → one Crewflow service. Request pulses tick "Who you are ✓" and "Your workspace ✓". A Background jobs node with Reminders · Expiries · Documents. |
| S34 | Get started | c11-recap | Title surface | Five real stills from the film | Request / Confirm / Work / Review / Timesheet land on their spoken words, then converge into the logo. |
| S35 | Get started | c11-guide | Title surface | none | Logo plus "Open the guide for your role", with chips Manager · Venue manager · Staff. ♪ click. |

## Proof cut, about 28 s

1. Opening line and node connection, the logo lock, and a ♪ click.
2. A short chapter card.
3. c4-send on the phone, with the ShiftCard showing "Pending approval".
4. Phone → web handoff, ♪ whoosh.
5. c4-approve as real web footage with close-ups.
6. The OfferCard travels to the phone.
7. c5-accept: Accept → CONFIRMED.

The proof uses the full film's narration clips, captions in the band and three accents.

## Continuity decisions

These decisions resolve the flags raised during planning.

- **The request:** Riley's request names Priya, Grace, Leah and Isla (4 of 4). The manager adds Isla to Riley's team in chapter 3. Riley's team already contains Leah.
- **Web footage:** web captures use the story adjustments in `tools/web/record-cinematic.cjs` (`story.request`, `story.offered`, `story.done`), so the timesheet drawer and Payroll show the Riverside wedding.
- **Manager-created branch:** the inset uses Daniel Okafor at Harbour Kitchen, a different person, so it can't be mistaken for the story shift.
- **No close-ups on:**
  - the "Send Shift Offer" button label (it actually submits a request);
  - the "?" in the Shift Approval drawer's per-person times;
  - Payroll tabs and the Status column;
  - any numeric clock-window or timeout text.
- **The QR scan:** it must show only the QR code: a synthetic emulator scene, or a tightly framed code. No room and no faces.
