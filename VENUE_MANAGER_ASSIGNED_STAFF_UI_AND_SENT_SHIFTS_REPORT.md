# Venue Manager assigned staff, Users UI and Sent Shifts redesign

Date: 2026-10-16. Scope: local development only. Nothing is committed, pushed or deployed.

## Verdict: PARTIAL

| Area | Result |
|---|---|
| Owner-assigned teams, discovery removed | PASS |
| Server and RLS | PASS |
| Web Assigned Staff | PASS |
| Venue Manager Users and Staff Profile UI | PASS |
| Long-press actions | PASS |
| Notes and Email excluded | PASS |
| Sent Shifts redesign | PASS, with remaining items below |

PARTIAL rather than PASS because of:
- **Not captured on the device:** peach Pending and mint Accepted cards, and error-state screenshots. There is no live shift in those states; the states are covered by widget tests.
- **No Staff Review section:** there is no review data in the system to show.
- **Residual RLS hardening item:** see section 17.

## 1. Staff visibility: before and after

| | Before | After |
|---|---|---|
| Who decides which staff a Venue Manager sees | The Venue Manager, by adding people from "All Users" (the whole workspace pool) | The workspace owner (the Initial Manager) assigns them explicitly |
| What the Venue Manager can see | The workspace pool, plus their own team | Only their assigned team |
| Database writes allowed to the Venue Manager on `venue_manager_staff` | Insert, update and delete own rows | Read own rows; update only their own favourite and emergency tags |
| Newly created staff | Visible in the pool immediately | Invisible until assigned |

## 2. Database relationship reused

- **Table:** `core.venue_manager_staff`, together with its per-workspace copies. Same rows, keys and composite foreign keys; there is no second table. The 15 existing rows are kept.
- **Migration `1786718200000`, additive:**
  - adds `is_favourite` and `is_emergency` (boolean, default false);
  - replaces the single Venue-Manager-only policy with three: `vm_select`, `vm_update` and `owner`.
- **Where it runs:**
  - core and all four workspace schemas on the dev database (ledger 174 → 175);
  - the disposable database;
  - new workspaces, through the provisioner (`V1_EXPECTED.policies` is now 22).
- **Backup before applying:** `C:\Crewflow-Docker-Archive\20261016T193838Z-pre-1786718200000`, 1,952 table-of-contents entries, SHA-256 manifest.

## 3. API routes

| Route | Who | Purpose |
|---|---|---|
| `GET /venue-managers/:id/staff` | Workspace owner | List the assigned team |
| `POST /venue-managers/:id/staff` `{staffProfileIds[1..100]}` | Workspace owner | Assign staff. All-or-nothing; duplicates are reported in `alreadyAssigned` |
| `DELETE /venue-managers/:id/staff/:staffId` | Workspace owner | Remove an assignment. The account and all history are kept |
| `GET /staff/venue-directory` | Venue Manager | Own team only. Adds `jobRoleName`, `isFavourite`, `isEmergency` and `?tag=favourite\|emergency` |
| `GET /staff/venue-directory/:id` | Venue Manager | Profile with operational fields only; 404 if the person isn't on their team |
| `PATCH /staff/venue-directory/:id/tags` `{favourite?, emergency?}` | Venue Manager | Their own tags only |

Assignment is audited as `venue_team.staff_assigned` and `venue_team.staff_unassigned`.

## 4. Removed

**Server:**
- `GET /staff/venue-directory/pool` and `POST /staff/venue-directory/team/:id`;
- `StaffService.venueStaffPool` and `addVenueTeamMember`.

**Mobile:**
- `VenueAllUsersScreen`;
- the All Users mode, the add/"Added" buttons and the NEW badge;
- `searchAllUsers` and `addTeamMember`.

**Kept:** the web console's Staff administration page.

## 5. Initial Manager Add Staff (web)

1. Users → Venue managers → open a Venue Manager.
2. The **Assigned Staff · N** section shows:
   - a search box;
   - rows with name, role, employment status and assignment status;
   - an ✕ on each row to remove that assignment, after a confirmation dialog.
3. **Add Staff** opens a dialog:
   - it lists your own workspace's assignable staff;
   - already-assigned staff are disabled and marked "Already assigned";
   - you can select several, with an "N selected" count, then **Assign**.

Nothing is created or sent to the staff member.

**Playwright run on dev as `intaltest1`, at 1440, 1920 and 1024 px wide:**

| Step | Assigned Staff | `venutest1` sees (their own API) |
|---|---|---|
| Before | 5 | 5 |
| Remove Staff Test 5, reload | 4 | 4 |
| Re-add Staff Test 5, reload | 5 | 5 |

Screenshots: `.audit/mobile-ui-20261016/web-team-*.png`.

## 6. Venue Manager Users page (Android emulator, debug build)

- **Layout:**
  - back button, **Edit** (which becomes **Done** while selecting), title "Users";
  - search box and filter button;
  - All / Favourite / Emergency chips;
  - compact rows: initials, name, role, and an availability badge only when the server actually evaluated availability.
- **Selection:** navy checkboxes and a sticky **Send Offer** button. There is no Delete.
- **States:** skeleton loading, empty, no results, error with Retry, 403, and "no longer assigned".

## 7. Staff Profile

Matches the reference:
- back button, "Staff Profile" header and heart;
- uppercase name, role, tag rows and a large initials tile;
- a draggable lower sheet with WORK PROFILE (values right-aligned), SKILLS chips and AVAILABILITY day squares, preferred shift and maximum hours;
- **Send Offer** at the bottom.

Sections without data show "Not provided"; no values are invented. To check the full layout, Staff Test 1's profile details were entered by `intaltest1` through the normal `PATCH /staff/:id`.

## 8. Favourite, Emergency, Notes and Email

- **Favourite and Emergency:** stored per Venue Manager. Verified live: Staff Test 1 is a favourite and Staff Test 3 is emergency cover, both set by `venutest1`, and the filters show only those staff.
- **Notes and Email: removed by your decision.**
  - There's no UI for them in the Venue Manager app.
  - On dev, `venutest1`'s token gets 403 on `/staff/:id/notes` (read and add), `/staff/:id/emails` and `/staff/bulk-email`.
  - Covered by server and Flutter tests.

## 9. Long-press quick actions

- **The preview:** dims the screen and shows a card with the name pill centred, the role and work profile, and a large initials tile.
- **The menu:** compact and left-aligned, with Add to/Remove from favourite, Add to/Remove from emergency, Send offer and View profile.
- **Not offered:** Delete, removing someone from the team, Notes or Email.
- **Behaviour:** tapping outside or Back closes it, and screen readers get the same actions.

## 10. Sent Shifts: before and after

**Before:** bright yellow and lavender tiles with large type.

**After:**
- tinted cards by state;
- a status pill top-left and "Sent Nh ago" at the right edge;
- the venue as the title, with the role underneath;
- the date and time row with icons, with "(+1)" for overnight shifts;
- a thin divider, a muted "│ Sent to N staff", and the round ↗ button.

Search, filters, summary counters, pull-to-refresh, pagination and the detail screen are unchanged.

**Titles:** the backend has no event-title field, so the venue name is used. "Birthday" and "Party" aren't invented.

## 11. Status mapping (`sentShiftLook`, matching the server's `statusLabel` order)

| Real state | Pill | Card colour |
|---|---|---|
| `pending_manager_approval` | Pending approval | Peach |
| Shift declined | Declined | Light red |
| Shift cancelled | Cancelled | Grey |
| Completed | Completed | Grey |
| `counters.confirmed` | Confirmed | Light blue |
| `counters.accepted` (not yet all confirmed) | Accepted | Mint |
| Pending offers | Pending | Peach |
| Declined responses | Declined | Light red |
| Staff cancelled | Staff cancelled | Grey |
| Otherwise | No active offers | Off-white |

Staff acceptance is never shown as manager confirmation.

## 12. Screenshot comparison evidence

All in `.audit/mobile-ui-20261016/emulator-5556/`:

| Screen | Files |
|---|---|
| Users | `vmui-01-users.png` (first render), `vmui-02-users-pass2.png` (compacted) |
| Selection | `vmui-03-selection.png` |
| Long-press | `vmui-04-longpress.png`, then `vmui-05-longpress-pass2.png` (re-laid-out to the reference) |
| Filters | `vmui-06-filter-favourite.png`, `vmui-07-filter-emergency.png` |
| Staff Profile | `vmui-08-profile.png`, then `vmui-09-profile-full.png` (right-aligned values, full data) |
| Sent Shifts | `vmui-10-sent-shifts.png`, then `vmui-11-sent-shifts-pass2.png` |
| Widths | 360 dp and 430 dp: `vmui-*-360dp.png`, `vmui-*-430dp.png`, `montage-360-430.png` (no overflow) |

## 13. Playwright runs

- **What ran:** real Chrome through `playwright-core` against the dev web console. It covered the section 5 flow, the earlier Venue Manager panel, and New-shift staff picker captures.
- **What it doesn't cover:** Flutter is not tested through a browser; all mobile evidence comes from the Android emulator.

## 14. Flutter tests

- **Venue Manager tests:** `flutter test` across `venue_manager_test`, `sent_shift_presentation_test`, `shift_assignment_draft_test` and `venue_manager_silent_refresh_test`: **72/72**.
- **Analysis:** `flutter analyze` on the changed files is clean.
- **Full suite (subagent run):** 493 passed, 5 failed. All 5 failures are in `schedule_clock_screen_test` (your uncommitted clock edits) and don't touch any Venue Manager file.

## 15. Server, RLS and web tests (disposable database 15436, built from migrations)

| Suite | Result |
|---|---|
| `venue-manager-venue-assignment` | 30/30 |
| `venue-manager-scoping` | 47/47 (rewritten to the new model) |
| `staff-profile-rls-abuse-cases` | 22/22 |
| `db-security-posture` | pass (golden unchanged) |
| `scheduling-offer-abuse-cases`, `mobile-application-default-deny`, staff and venue suites | pass |
| Web `features/users` | 75/75 |
| Web `features/scheduling` | 50/50 |

What the server tests cover:
- assigned-only visibility, and Venue Manager B can't see A's staff;
- a cross-workspace or cross-organisation owner can't assign;
- a Venue Manager can't self-add or use the owner route;
- search and direct lookups reveal no unassigned staff;
- a removed assignment is refused at `/shifts/request`;
- concurrent duplicate assignments create one row;
- suspended staff can't be assigned, and invited staff stay hidden until active;
- tags stay scoped to the Venue Manager;
- no Notes or Email access for Venue Managers;
- the service re-checks permissions itself;
- the audit trail.

## 16. Migration and owner approvals

- `1786718200000`: approved and applied to dev.
- Notes and Email: your decision was to exclude them.

## 17. Security notes

- **Live checks on dev:** no organisation or workspace leakage was found.
- **Residual risk:** the `vm_update` policy doesn't pin `staff_profile_id`. The service only writes the tag columns, so exploiting it would need SQL injection. Recommended follow-up: a trigger that blocks changes to the key columns (recorded in THREAT-MODEL).
- **Pending offers:** removing an assignment doesn't withdraw offers or requests that already exist. That lifecycle decision is left to you.

## 18. Remaining design differences

- **Font:** the reference uses a different display font for titles and chips; the app keeps its existing font.
- **Staff Review section:** omitted, because there's no data.
- **Hero status:** shows the real tags rather than "Available", which needs a shift window.
- **Delete:** absent by your requirement (the reference shows a Delete button next to Send Offer).
- **Peach/mint cards:** not captured on the device (see the verdict).

## 19. Pre-existing failures, not caused here

- **`hws-backfill`:** `permission denied for table audit_log`, the documented baseline.
- **`shift-team` › invalid id:** expects 400, gets 404; this is in your new team feature.
- **`schedule_clock_screen_test`:** 5 cases.
