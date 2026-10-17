# Staff availability warnings and Manager activation/reload errors — fix report

Date: 2026-10-15. Scope: local development only. Nothing committed, pushed or deployed. No migration. No account,
workspace or database record was modified to produce these findings: the deleted accounts were inspected read-only
in a disposable restore of the pre-reset backup.

## Verdict: PASS (with three items for the owner, section 14)

- Both problems are fixed at their root, in the server and in the clients.
- Every new behaviour has tests at the level it lives (shared, server integration, React, Flutter, browser).
- The only server failures that reproduce are the 12 baseline failures.

---

## 1. Root cause of the availability-warning gap

- Availability was collected and stored, but **nothing on any offer path ever read it**.
- The only reader was the replacement-staff worker's shortlist (`replacement-staff.job.ts`), and it only ranks candidates.
- All seven ways an offer is created converge on `OfferService.sendOne()`. That function checked employment status, account status, duplicates and overlaps, but not declared availability.

## 2. Availability schema and persistence

- **Storage:**
  - `staff_profile.available_days text[]`: full English weekday names, as validated by the DTO;
  - `preferred_shift_times text`;
  - `max_hours_per_week int`;
  - migration `1786670800000`;
  - the same columns exist in every workspace schema.
- **No new table was added.**
- **Persistence was verified end to end:**
  - in the pre-reset backup, the staff account `issacn@gmail.com` holds `{Tuesday,Sunday}`, matching your screenshot;
  - a new test creates staff through `POST /staff` with `availableDays`, then reads the row back from PostgreSQL and through `GET /staff/:id`.
- **NULL and `[]` both mean "not provided"**, the existing convention in the worker, and are never treated as unavailable.
- **Gaps that remain (not changed):**
  - staff created through the email-first member-invitation path never get availability;
  - the Flutter app has no screen for editing availability;
  - clearing "max hours" in the web panel stores 0, not null. That's why weekly hours and preferred times are **not** used here (A4).

## 3. Warning behaviour

**Server contract:**
- An unacknowledged conflict returns **409**, with nothing created:

  ```json
  {
    "code": "STAFF_AVAILABILITY_CONFLICT",
    "message": "...",
    "totalRecipients": 1,
    "conflicts": [
      {
        "staffProfileId": "...",
        "staffName": "...",
        "availableDays": ["..."],
        "conflictDates": [{ "date": "YYYY-MM-DD", "weekday": "Monday" }]
      }
    ],
    "unknownAvailability": [...]
  }
  ```

- **"Send anyway"** re-sends the same request with `acknowledgedAvailabilityConflicts: [{ staffProfileId, dates }]`.
- **Recomputed at dispatch:** the server recalculates conflicts and accepts only if every conflicting **London date** is listed. A shift moved to other dates is warned again.
- **No extra authority:** every existing permission, ownership check, venue-team scope, eligibility rule and duplicate guard still applies.

**Initial Manager / internal manager / CEO** (single send, bulk send, create-and-send, pipeline replacements, replacement approval):
- The warning dialog appears before dispatch.
- Cancel dispatches nothing; Send anyway produces one offer through the normal path.
- Each acknowledged send is audited as `offer.availability_conflict_acknowledged`.

**Venue Manager** (mobile app request):
- The Venue Manager is warned when submitting.
- "Submit anyway" only creates the **pending request**. It is audited as `shift.request_availability_conflict_acknowledged` and dispatches nothing.
- **Approval is the dispatch boundary.** The approving manager is warned again and must acknowledge separately; the Venue Manager's acknowledgement never carries over.
- **The approval requirement is unchanged:**
  - a Venue Manager still cannot approve (403 or 404);
  - a repeat approval creates nothing (404, still one offer).

Required wording, as rendered:
- "Staff availability warning" / "John Smith has marked themselves as unavailable on Monday." / "Available days: Tuesday and Sunday." / "You can cancel or choose to send the offer anyway."

## 4. Individual and bulk offers

- **Multi-recipient paths** (bulk, create-and-send, approval, pipeline) check **every** recipient before inserting anything, and return one 409 that lists everyone affected:
  - the bulk wording is "3 of 10 selected Staff have availability conflicts.";
  - each entry shows the name, date and available days;
  - anyone without availability is noted as "not treated as unavailable".
- **Nobody is silently dropped.**
- **Partial acknowledgements don't count:** acknowledging only some of the conflicts is still a conflict.
- **Retries never duplicate:** an acknowledged retry is absorbed by the existing `(shift, staff)` uniqueness check.
- **Concurrent requests:** two simultaneous acknowledged sends produce exactly one offer.

## 5. UK weekday handling

- `@rab/shared` `availability.ts` works on **Europe/London calendar dates**. There is no venue-level timezone, and the worker already uses London.
- An overnight shift covers every London day it touches; a shift ending at exactly 00:00 doesn't touch the next day.
- Working on civil dates, rather than 24-hour steps, makes BST and GMT changes irrelevant.
- **Tests cover:**
  - every weekday, Monday to Sunday;
  - 00:30 BST Monday, which is still Sunday in UTC;
  - Sunday-to-Monday overnight shifts;
  - midnight end times;
  - the BST→GMT change (25-hour night) and the GMT→BST change (23-hour night);
  - a shift moved to a new date.

## 6. Root cause of the activation and reload errors

There were three separate causes.

1. **The status label lied.** `deriveInvitationStatus` returned `null` once an invite was **accepted**: the link was used and a password set, but the account stays `INVITED` until first sign-in, which is the existing, tested policy. The UI turned `null` into "Pending — invite not sent".
2. **The panel offered actions the state machine refuses.** For that same state it showed **Reactivate** (the "Activate" button calls `/reactivate`) and **Reset password**, and hid **Resend**, which is the action the server actually allows. The Users list did the same and swallowed the errors.
3. **The reload logout was a local host mismatch.**
   - `APP_URL` was `http://localhost:5173` while the API is `http://127.0.0.1:3000`. To a browser those are different **sites**, so the `SameSite=Lax` session cookie set at sign-in is never stored.
   - Sign-in works from memory, and the first reload goes back to `/login`.
   - Real Chromium confirms it: page on localhost with the API on 127.0.0.1 gives `/auth/me` 401 after reload; with both on 127.0.0.1 it gives 200.
   - Cookie security was **not** weakened.

The server also showed four serialization retries (`40001`) on the session-validity update when a page fires parallel requests. These are handled by the existing retry-then-503 logic and caused no logout; recorded only.

## 7. Which account was which (verified by ID and role)

| Account | User ID | Type and role | State at 13:15 UTC |
|---|---|---|---|
| `issacn90474@gmail.com` ("issac n") | `84c1c5db…` | Venue Manager (`feea2cb1…`, venue `e04d82a7…`) | invite sent 11:02, accepted 11:07:24, never signed in, status `invited` |
| `issacabin@gmail.com` ("issac n") | `0232b988…` | Venue Manager (`29866849…`, same venue) | invite sent 11:16, accepted 11:21:01, never signed in, status `invited` |
| `issacn@gmail.com` | `96bd8f46…` | Staff | accepted 11:06:58, first sign-in in the staff app 11:07:50, `active`, availability `{Tuesday,Sunday}` |

- **No Initial Manager existed.** Every manager profile had `is_initial_manager = false`.
- **The success screen was correct:** "You can now sign in using the ADOLPHUS mobile app" is right for a Venue Manager. The server derives it from the role (`venue_manager_app`).
- **The real Initial Manager flow was tested separately** (section 11): its destination is `manager_web` (Manager Portal), never mobile.
- These accounts were later removed by the workspace resets you asked for, so the live database no longer has them.

## 8. The exact 409s and 400s (API log, 11:12–11:14 UTC, all button clicks, none automatic on reload)

- **`POST /managers/:id/reactivate` → 409 (×6):** "This account has not been activated yet — use Resend Invitation or Re-invite instead." A correct refusal, kept.
- **`POST /managers/:id/reset-password` → 409 (×2):** same reason. Correct, kept.
- **`DELETE /managers/:id` → 400 (×2):** the panel sent **no body**, but the route requires the actor's `currentPassword` (step-up). Fixed in the client; the server is unchanged.
- **`POST /auth/activate-account` → 400:**
  - at 11:06:04 and 11:06:09, rejected attempts just before the staff member's acceptance at 11:06:58;
  - at 11:11:34, after both acceptances, which fits a replay of an already-used link.
- **The `/auth/me` and `/auth/refresh` 401 pairs** came from a tab with no session (the activation page). The CEO's own session (`c002416d…`) stayed live from 10:54 to 11:20.

## 9. Files changed

**Shared** (`packages/rab-shared/src/utils/`):
- `availability.ts` (new, with spec);
- `index.ts`.

**Server, `packages/rab-server/src/`:**

- `modules/staff/`:
  - new `services/staff-availability.ts`;
  - new `dto/availability-acknowledgement.dto.ts`;
  - new `exceptions/staff-availability.exceptions.ts`.
- `modules/offer/`:
  - `services/offer.service.ts`, `services/replacement-request.service.ts` and `services/venue-offer-pipeline.service.ts`;
  - `controllers/venue-offer-pipeline.controller.ts`;
  - DTOs: `send-offer`, `send-bulk-offer`, `create-shift-and-send`, `approve-shift-request` and `approve-replacement-request`.
- `modules/scheduling/`:
  - `services/scheduling.service.ts`;
  - `dto/submit-shift-request.dto.ts`.
- `modules/manager/services/manager.service.ts`: `isInitialManager` added to the summary.
- `engine/core-modules/auth/services/account-invite.service.ts`: the `accepted` state and deterministic outbox ordering.
- `engine/core-modules/audit/audit.service.ts`: two audit actions.

**Web, `packages/rab-front/src/`:**

- `features/scheduling/`:
  - new `AvailabilityConflictDialog.tsx`, `availability-conflict.css` and `AvailabilityConflictDialog.spec.tsx`;
  - `ShiftDrawers.tsx`, `ShiftApprovalDrawer.tsx`, `ShiftRequestDrawer.tsx` and `StaffSelectionPage.tsx`.
- `features/users/`:
  - `UserDetailPanel.tsx` and `Users.tsx`;
  - `staffStatus.ts`;
  - specs: `UserDetailPanel.spec.tsx` and `staffStatus.spec.ts`.
- `shared/lib/loopback-host.ts` (new, with spec) and `main.tsx`.

**Mobile, `packages/rab-mobile/`:**
- `lib/features/venue_manager/availability_conflict.dart` (new) and `send_shift_screen.dart`;
- `test/availability_conflict_test.dart`.

**Tests:**
- Integration specs, `packages/rab-server/src/__tests__/integration/`:
  - `scheduling-offer-abuse-cases` (+12 tests);
  - `venue-manager-scoping` (+4);
  - `account-invite-abuse-cases` (+5);
  - `initial-manager-invitation` (+1).
- Browser (`packages/rab-e2e-testing/`): `web/availability-and-manager-lifecycle.spec.ts`, `web/dev-loopback-cookie-host.spec.ts` and `playwright.isolated.config.ts`.

**Configuration and docs:**
- `packages/rab-docker/docker-compose.yml`: `APP_URL` and `ACCOUNTS_URL` set to `http://127.0.0.1:5173`.
- `THREAT-MODEL.md` and `docs/HANDOFF.md`.

## 10. API and database changes

- **Offer and request endpoints:** optional `acknowledgedAvailabilityConflicts` on all six dispatching endpoints:
  - `POST /shifts/:id/offers`, `/offers/bulk`, `/shifts/with-offers`;
  - `/shifts/:id/approve`, `/shifts/request`;
  - `/replacement-requests/:id/approve` and `/shifts/:id/pipeline/replacements`.
- **New error code:** 409 `STAFF_AVAILABILITY_CONFLICT`.
- **Manager summary:**
  - `isInitialManager` added;
  - `invitationStatus` gains `accepted`.
- **Two new audit actions.**
- **Database:** no migration, schema or RLS change. Availability is read through the caller's existing workspace RLS.

## 11. Tests

| Suite | Result |
|---|---|
| `@rab/shared` | 69/69 (new: 11 availability, both BST changes) |
| Server, new and affected suites, run individually on the disposable test DB (15436) | scheduling-offer 52/52, venue-manager-scoping 44/44, account-invite 38/38, initial-manager-invitation (incl. new activation → cookie sign-in → reload → second tab) pass, account-lifecycle 9/9, storage-cleanup 33/33, google-oauth-handoff, staff-security-hardening, containment-suspend 5/5 |
| Server, full suite (3 workers) | 1,685 passed, 36 failed, 61 skipped |
| Web (Jest) | 466/466 |
| Flutter | 460/460 (+5 new) |
| Browser (Playwright, isolated, mocked API, plus a real-cookie probe) | 12/12 |

**How the 36 full-run failures break down:**
- **12 are the documented baseline:** `hws-backfill` 9, `identity-security-table-rls` 2, `audit-log-immutable-identifiers` 1.
- **The other 24 occur only in the parallel full run, and each of those suites passes on its own (shown above):**
  - `containment-suspend` refuses, by design, when another process queries the same database;
  - the rest are load and timeout failures on this machine.
- **The first full run is not counted.** It failed 394 tests with "Memory allocation error" while the machine was starved, so it was discarded and rerun.

**Test infrastructure changes:**
- **Test database credentials:** the disposable test database's credentials could not be recovered, so I set new passwords on its `crewflow_app` and `rab` roles. That cluster is disposable only; its `crewflow.disposable_test_database = true` marker is unchanged.
- **Redis:** tests used the disposable `audit-redis` container.

## 12. Screenshots

All in `docs/qa/staff-availability-manager-activation/`, at 1920, 1366 and 390 px:
- `availability-single-*`;
- `availability-bulk-*`;
- `manager-accepted-*`.

**Layout checks:** no horizontal overflow, the dialog stays within the viewport, and the drawer footer isn't clipped.

**Bug found by the browser test and fixed:** the dialog first rendered *under* the right-side drawer, so it couldn't be clicked. It is now portalled to `<body>` above the drawer, marked `data-rab-portal` so the drawer doesn't treat clicks in it as outside clicks, and Escape closes only the dialog.

## 13. Security and isolation verification

- **Availability isn't readable across organisations.** Another organisation's manager gets a 404 with no availability data. The query runs under the caller's workspace RLS and after the existing eligibility check.
- **Acknowledgements can't be forged or reused:**
  - a malformed acknowledgement is a 400;
  - an acknowledgement for other dates doesn't count.
- **Acknowledgements grant nothing:** a Venue Manager can't dispatch with one, and unsupported actors are still refused by the unchanged guards.
- **Lifecycle refusals are unchanged:** activation is still single use, the 409 refusals (reactivate and reset on never-activated accounts) and the Delete step-up (none → 400, wrong → 403) are untouched and still tested.
- **The Initial Manager lands on the web:** destination `manager_web`, and the cookie session survives a reload and a second tab.
- **Not weakened:** cookie attributes, CSRF, RLS, Redis integrity and the one-current-Initial-Manager constraint.
- **`THREAT-MODEL.md`** has a new entry.

## 14. Outstanding items and owner decisions

1. **Override permission:** should "Send anyway" require `schedule.override_conflict`? The flag is granted to managers and CEOs but used nowhere today. It isn't required now, so custom roles that can send offers can also acknowledge.
2. **Running Docker API and worker:** these are still the old image.
   - The web console on 5173 hot-reloads this code, but the warning and "Awaiting first sign-in" only appear once the API is rebuilt.
   - The API changes don't depend on the unapplied migrations 1786717600000–1786717900000, but other working-tree code from the security remediation does. A rebuild should wait for that rollout decision.
   - The `APP_URL` compose change takes effect when the `server` container is recreated. Until then, the new dev redirect covers activation links that open on `localhost`.
3. **Known gaps, not changed:**
   - no availability for staff created through member invitations;
   - no Flutter availability editor;
   - "max hours" cleared to 0 in the web panel;
   - weekly hours and preferred shift times are not enforced (advisory only, by instruction).

The disposable container `crewflow-prereset-inspect-20261015`, a read-only restore of this morning's backup used for section 7, is stopped but kept; it can be removed when no longer needed.

## 15. Verdict

**PASS.** Every behaviour required in A1–A8 and B1–B9 is implemented and verified. The open items in section 14 are owner decisions and existing gaps, not defects in this change.
