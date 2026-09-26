# RAB STAFF SHIFT UI CLEANUP REPORT

## A-H. Shared components and changes

Reused ScheduleHomeScreen, UpcomingShiftCard, ScheduleRecordCard and ScheduleOfferDetailScreen. Existing ShiftStatusControl remains the single lifecycle indicator on Details. No duplicate component or backend change.

- Today: address replaced by actual date; venue, pay and time retained. Original fixed peach is preserved.
- Upcoming: compact date/time row added through ScheduleRecordCard.scheduleLabel; rate, Team Member, original height and shift palette retained.
- Confirmed upcoming Details: Be Ready removed entirely.
- Clocked-out/complete/expired Details: no bottom status panel or Back to shifts. Passive states have no footer padding reserved for an action. Errors and actual actionable operations remain available.
- NOTE, real content/No Details, top Back and SafeArea retained. Route/morph code unchanged.

Production files changed:
- lib/features/home/schedule_home_screen.dart
- lib/features/home/widgets/upcoming_shift_card.dart
- lib/core/widgets/schedule_record_card.dart
- lib/features/offers/schedule_offer_detail_screen.dart

## I-L. Verification

244 Flutter tests passed; flutter analyze clean; Android profile build/install passed (109.2 MB). Tests updated in home_visual_states_test.dart and staff_shift_lifecycle_test.dart. Golden fixture clock parameter added to support/motion_fixtures.dart and used in schedule_components_golden_test.dart. Upcoming idle/pressed goldens reviewed and refreshed. Existing motion, colour, navigation and role tests pass.

## M. Real emulator screenshots

- home.png: Today's Shift date, no address, pay and time. Captured before final card-height restoration; primary card unchanged afterward.
- home-final.png: final compact Upcoming with date/time/rate/Team Member.
- confirmed-final.png: central Confirmed, No Details, no Be Ready.
- clocked-out-final.png: single central Clocked Out, real Note, no bottom panel/button.

Compared to supplied screenshots for the requested removals and preserved visual structure. Top Back and Android Back checked. This UI task used real validated clock APIs to prepare disposable attendance, not a new native scanner test.

TODAY ADDRESS REMOVED: YES
TODAY DATE ADDED: YES
UPCOMING DATE ADDED: YES
BE READY REMOVED: YES
BOTTOM CLOCKED OUT PANEL REMOVED: YES
BACK TO SHIFTS REMOVED: YES
CENTRAL STATUS CHIP PRESERVED: YES
EMPTY BOTTOM SPACE REMOVED: YES (no reserved footer; ordinary remaining viewport/background remains)

## N. Handoff and QA data

Canonical docs/HANDOFF.md section 21 updated.
Disposable local organisation: 6d3169cd-3402-4c7d-9e89-486936e72a3d
Workspace: 74cfe5f2-adce-4497-a219-9537817aaa03
Venue: 9d82bab4-5b17-4680-8e93-3ea7b9e09454
Clocked-out shift: f104f661-3863-4665-a1e5-b45a1a6f2bc5
Upcoming shift: 508cfeaf-f611-4bf6-8895-484bc84ab739
Unknown existing attendance was untouched. Cleanup proof recorded separately; audit/attendance history retained.

Cleanup verified: all three QA users deactivated, password hashes cleared, refresh tokens revoked, unused upcoming shift cancelled. Completed attendance/audit retained. Private credential and QR files removed.

STAFF SHIFT UI CLEANUP COMPLETE
