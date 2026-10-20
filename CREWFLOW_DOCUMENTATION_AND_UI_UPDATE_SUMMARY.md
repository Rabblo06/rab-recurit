# Crewflow documentation and UI update: summary

**Date:** 20 October 2026. **Status:** PARTIAL. The documentation is updated and verified locally but has **not** been published. A few items are blocked (section 6).

## 1. What changed in the Web App documentation

Every user-guide page was checked against the current application:

- **63 pages updated, 2 added.**
  - The new pages are a **Dashboard** guide (what each figure counts and over which dates, how figures load and refresh, and how missing data is shown) and a **Staff reviews** guide.
  - All existing addresses and links still work.
- **Navigation:** sidebar groups, the account menu, search, the command palette and the Operations **+** shortcuts.
- **Users:** row selection and the bulk-action bar, the detail drawers, the venue manager lifecycle, and **Assigned staff**.
- **Offers and shifts:**
  - the difference between a staffing request and its offers;
  - staff acceptance followed by manager confirmation;
  - the **Expired** view;
  - the 12-lane staffing board.
- **Timesheets:** the venue manager app flow — correct, **Mark reviewed**, **Finalise & send**, sign off. Optional ratings are not required. On the web you can view and download only.
- **Account:** devices, **Log out all other devices**, current session lengths, members and roles. "Sign out everywhere" no longer appears.

## 2. Screenshots refreshed

80 web screenshots were captured from the running application using a clearly fictional demo company: 60 replace older images and 20 are new. They cover:

- the Dashboard, including empty and unavailable states;
- selected rows with the bulk bar;
- venue manager list, detail and Assigned staff, plus the Select Staff picker;
- Staff reviews;
- the account menu, **+** menu, Help Center and Support;
- Members, Devices and the staffing board.

Payroll and mobile screenshots were not refreshed.

## 3. Narrated videos

Thirteen web tutorials now have **spoken narration**, switchable English captions and an on-page transcript:

- Dashboard tour and console tour
- Adding staff and adding a manager
- Creating a workspace, a venue, and a shift with offers
- Approving a venue request and confirming offers
- Assigning staff to a venue manager
- The staffing board
- Staff reviews and sidebar shortcuts

The narration uses a voice built into Windows, so no paid service was used and no data left the machine. Videos only play when the viewer starts them, with sound on.

## 4. Dashboard animation

The animation work was documented, not rebuilt:

- **When the reveal plays:** numbers count up and bars grow on arrival, and again when you deliberately return to the Dashboard.
- **When it doesn't:** unchanged background refreshes don't replay it, and reduced-motion users see final values at once.
- **Missing figures:** unavailable figures show "–", never 0.

It was reported PASS. It used fixture data, made no backend or database change, and added no circular indicator, because the design has none.

## 5. Testing

| Check | Result |
| --- | --- |
| Frontend unit tests | 553/553 previously reported; **rerun now: 553/553** |
| Dashboard animation browser tests | 10/10 previously reported (preview and dev); **rerun now on dev: 10/10** |
| Docs validation and broken links | Pass (now) |
| Media and content checks | Pass (now) |
| Docs pages on desktop/light and phone/dark: images, layout, playback after a click, captions, transcript | Pass (now) |
| Narrated videos: audio present, level, no clipping, no long gaps, speech matches the script (automated) | 13/13 pass (now) |

All media use **fictional data and simulated responses**. They show the real interface, but they don't prove live permissions or production readiness. No real system was contacted.

## 6. Remaining blockers

1. **Venue managers count** on the live Dashboard still shows "–". The fix is in the code, but the running development server predates it. Making it live needs approval to rebuild that server; no database change is needed for the count.
2. **Payroll** "In progress" and "Completed" views fail against the real system. Fixing them needs a decision on which attendance states count as completed.
3. **Voice:** only US-English voices are installed. A British voice needs approval to install the Windows UK English speech pack.
4. **Human review:** nobody has yet watched and listened to the videos.
5. **Product decisions:**
   - who can see staff reviews;
   - whether managers should review timesheets on the web;
   - Audit Log scope;
   - a real support contact.
6. **Pages:** a few shifts, calendar and venue pages received only partial updates. Mobile tutorials and screenshots were not refreshed.

## 7. Publication status

Everything is **local and previewed**: nothing has been published, committed or deployed. Publishing the documentation needs separate approval.
