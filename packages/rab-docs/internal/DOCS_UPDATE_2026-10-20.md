# Documentation, screenshots and narrated tutorials — update of 2026-10-20

Internal maintainer notes (excluded from the published site by `.mintignore`). The short client-facing summary is
`CREWFLOW_DOCUMENTATION_AND_UI_UPDATE_SUMMARY.md` at the repository root. Nothing here was published, committed or deployed.

## Venue manager count on the Dashboard (read-only investigation)

- **Symptom:** a Manager sees **Users → Venue managers · 2**, while the Dashboard shows **Venue managers –**.
- **Cause:** the running `rab-server` container (image created 2026-10-18 14:56 UTC) predates the change that adds `venueManagerCount` to `GET /dashboard/summary`.
  - A read-only grep inside the container finds no `venueManagerCount` in `dist/modules/dashboard/services/dashboard.service.js`.
  - The change exists only in the working tree (`modules/dashboard/services/dashboard.service.ts`, uncommitted).
  - It counts `manager_profile` rows for the caller's organisation, server-derived workspace and `type = venue`, under `VENUE_MANAGER_CREATE`. That is the same population as `GET /venue-managers`.
  - It returns `null` when unavailable, never 0.
- **Frontend mapping:** `Dashboard.tsx` shows the **Venue managers** label and a dash while `venueManagerCount` is missing and `managerCount` is null, which is the correct fail-closed rendering. It does not hardcode, guess or substitute a number.
- **Schema dependency for the count:** none. It uses existing `manager_profile` columns.
  - The dev database (read-only `SELECT name FROM core.migrations`) is at `AttendanceReview1786718500000`.
  - The only unapplied migration in the tree is `NavigationLayout1786718600000`. It is unrelated to the count, but its module ships in the same image.
- **Smallest rollout step (needs approval):** rebuild and restart only the dev `rab-server` service (`docker compose build rab-server && docker compose up -d rab-server`, no `migrate` profile). Migrations are never automatic.
  - Caveat: the rebuilt image contains every uncommitted server change, including the navigation-layout endpoints. Their table does not exist on dev until migration 1786718600000 is approved and applied, so those endpoints would error. No shipped screen calls them.
  - Verify afterwards with a read-only `GET /rest/v1/dashboard/summary` as a Manager, compared with the `total` of `GET /rest/v1/venue-managers?limit=1`.
- **Demo media:** the fictional demo dataset contains two venue managers. That is not evidence that the live discrepancy is fixed.

## Defects and open decisions found while documenting (not fixed here: out of docs scope or rule-bearing)

1. **Payroll status tabs and filter (defect, payroll rule).**
   - Payroll sends `status=active|completed`, but the server accepts only real attendance statuses. As a result, **In progress**, **Completed** and the Status filter return 400 against the real API, and every row's badge reads *In progress*.
   - The docs fixtures and the e2e fixtures fake these values, which hides the problem.
   - In the docs: payroll pages describe *All records* only, and the payroll screenshot and video are no longer embedded.
   - Owner decision needed: which statuses count as Completed.
2. **No web attendance review.** Correction, **Mark reviewed** and **Finalise & send** exist only in the venue manager mobile app. The in-app Help topic "Finalise a timesheet" tells web users to sign and send, which they cannot do.
3. **Audit Log is actor-scoped.** A manager sees only their own actions. Docs now say so. Owner decision: should managers see venue managers' corrections and finalisations?
4. **Staff reviews visibility.** Reviews are shown to the managing (creating) manager only. Owner decision: delegated members, CEOs and sibling managers.
5. **Copy and branding leaks in the UI** (not quoted in public docs): "RAB" in the bulk-email hint, "ADOLPHUS mobile app" in the activation and reset notes, "How you sign in to rab." on Account, and a hard-coded "Verified" badge on Domains.
6. **Orphaned routes, reachable by URL only:** `/settings/workspace`, `/settings/workspace/security` (sign-in provider toggles), `/settings/workspace/domains`, `/settings/workspace/roles`, `/settings/workspace/team`. Not documented.
7. **Command-palette placeholders** (Import Data, Export View, See Deleted Records, New Payroll Record, New Calendar Event, New Hotel Manager): not documented.
8. **Notification preferences:** 14 of 20 types show raw internal keys.
9. **Removing a staff member from a venue manager's team:** whether pending offers or requests are withdrawn is undecided; not documented as settled.
10. **Pay-rate wording** (resolved at shift creation, saved on the booking at confirmation): matches the code; needs owner sign-off because it is a payroll rule.

## Capture and narration pipeline (reproducible)

All captures use the real `rab-front` UI on an isolated Vite dev server and the synthetic fixture backend:
- Every `**/rest/v1/**` request is answered in the browser.
- Unknown requests return **501** and fail the job.
- Every other origin is **blocked** and reported.
- Phone-input flag icons are served from the local `country-flag-icons` package.

The isolated Vite server points its API at `127.0.0.1:3999`, where nothing listens, so even a fixture gap could not reach dev or production.

```bash
# 1. Isolated front-end (repo root)
cd packages/rab-front && VITE_API_URL=http://127.0.0.1:3999/rest/v1 npx vite --port 5174 --host 127.0.0.1 --strictPort
# 2. Screenshots (reduced motion) → images/web/**/*.png, then WebP (web only; mobile set untouched)
CREWFLOW_WEB_ORIGIN=http://127.0.0.1:5174 node packages/rab-docs/tools/web/capture-screens.cjs [filter]
node packages/rab-docs/tools/process-images.cjs --web-only
# 3. Narration (offline Windows SAPI voice; no network, no key) → tools/narration/build/<slug>/*.wav + segments.json
powershell -NoProfile -ExecutionPolicy Bypass -File packages/rab-docs/tools/narration/synthesize.ps1 -Script packages/rab-docs/tools/narration/scripts/<slug>.json -OutDir packages/rab-docs/tools/narration/build/<slug>
# 4. Recording (full motion, CDP screencast, narration cues on the same clock) → <out>/<slug>/{frames,frames.json,cues.json,run.json}
CREWFLOW_WEB_ORIGIN=http://127.0.0.1:5174 node packages/rab-docs/tools/web/record-tutorials.cjs <slug> --out <out>
# 5. Compose (title card + recording by timestamp + voice track placed at each cue + WebVTT + transcript + poster)
cd packages/rab-docs && REC_DIR=<out> node tools/compose-videos.cjs <slug>
# 6. QA (streams, loudness, peak, silence, offline speech-recognition word recall) → tools/narration/build/qa.json
node tools/narration/qa-videos.cjs [slug]
# 7. Embed (VideoTutorial + captions + on-page transcript) and manifest
python tools/narration/embed.py <page.mdx> <slug> "<title>" --replace <old src> | --after "<heading line>"
node tools/build-media-manifest.cjs
```

**Safeguards**
- Compose refuses a recording whose cues no longer match the current narration (stale capture).
- The recording is never stretched to fit the voice. Each line starts only after the previous one ends, and actions happen while it is spoken.

**Voice**
- Microsoft Zira Desktop (en-US), rate −1.
- No en-GB voice is installed on this machine. Installing the Windows English (United Kingdom) speech pack is an OS change that needs approval. The scripts are written in British English.
- Pronunciation hint: "Crewflow" is spoken as "Crew flow".
- Automated QA is not a human listen. Pronunciation of product terms and overall voice quality still need a person to review.

## Not refreshed

**Mobile tutorials**

- `staff-accept-offer`, `staff-app-tour`, `venue-send-shift` and `clock-in-out`: silent, older UI. These need the mobile capture pipeline and an emulator or device, which are outside this web update.
- All `images/mobile/*` screenshots. `vm-correction.webp`, `vm-shift-report.webp` and `vm-reports.webp` show removed UI; references to them were removed.

**Web video and screenshots**

- `videos/managers/payroll-review.mp4` is no longer embedded (payroll defect). The file is kept.
- `videos/managers/timesheets-review.mp4` is replaced on its page by the narrated `staffing-pipeline` video. The file is kept.
- `images/web/payroll/*`: not refreshed (payroll defect).
- `images/web/auth/accept-invitation.webp` — now captured (job added 2026-10-20).

## Pages only partly updated (edits refused by the tool-permission check; not forced)

- **`shifts/live-staffing-pipeline.mdx`:** the card-actions, fill-gaps and timesheet-table details still need rewriting.
- **Not yet updated:** `shifts/cancelling-shifts.mdx`, `shifts/offer-expiry.mdx` (add the 5-hour action window), `shifts/status-reference.mdx` (offer label sets, request statuses, the 12 board columns), `calendar/overview.mdx`, and `venues/overview.mdx` (archive is immediate; error texts).
- **Updated here:** the `venues/pay-rates.mdx` rate wording now matches the code (the rate is set at shift creation and saved at confirmation). It still needs owner sign-off because it is a payroll rule.
- **Additional defect (not documented publicly):** on the Shifts page, the **Upcoming** tab and the **Shift date** filter send query parameters the list endpoint does not accept. The docs describe **All shifts** and **Completed** only.
- **"Confirm All Accepted (N)":** N counts the rows on the page, but the action confirms every accepted offer in those batches. Owner decision: is this intended?
