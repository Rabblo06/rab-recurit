# Crewflow complete introduction video: report

**Date:** 2026-10-20

**Film:** "From staffing request to final timesheet", 4 min 48 s (288.3 s).

**Status:** built and checked locally. It is not committed, pushed or published.

## Verdict

| Area | Result | Why |
| --- | --- | --- |
| Complete core journey | **PASS** | Covers who uses Crewflow, building the team, the request, approval, offers and confirmation (both paths), shift day, reviewing hours, the final timesheet, payroll/reviews/dashboard, what runs behind the scenes, and where to start. Every claim is backed by a code reference (`tools/cinematic/intro-film/PRODUCT_TRUTH.md`). |
| Web footage | **PASS** | The real current web console against fictional fixtures, with no unhandled requests and no page errors. One continuous story is used throughout: Riverside House, Fri 23 Oct, 12:00–18:00, with Priya, Grace, Leah and Isla. |
| Mobile footage | **PARTIAL** | The real current Flutter app (debug build at `f5187172`) was recorded on the Pixel 5 emulator against a demo backend. **The QR scan is simulated:** the emulator cannot read a QR code, so the clock-in/out was posted to the demo backend's clock-in endpoint as a stand-in for the scan. This is labelled on screen and in the page caption. |
| Narration | **PARTIAL** | A natural local British voice (Kokoro bf_emma, 161 wpm while speaking), but **nobody has listened to it yet**. |
| Delivery and docs | **PASS** | The output files, captions, transcript, chapter list and homepage embed all pass their checks, and the page was tested in a browser at desktop and phone widths. |
| **Overall** | **PARTIAL** | Becomes PASS after a human listens to the narration. The scan cannot be shown truthfully until a real camera is available, so it stays labelled as simulated. |

## What the introduction explains

| Time | Chapter | What the viewer sees |
| --- | --- | --- |
| 0:00 | Why Crewflow | Three disconnected roles (venue, manager, staff) are joined into one journey: Request → Confirm → Work → Review → Final timesheet. Then the logo. |
| 0:19 | Who uses it | The manager's web console (real Dashboard, private workspace). Two phones show the venue manager and staff apps. |
| 0:40 | Build the team | Staff and venue records. Riley Chen's assigned team: the manager adds Isla. In Riley's app, Riley sees only that team. |
| 1:06 | Request and approve | Riley builds the request on the phone, gets the availability warning (Leah) and taps Submit anyway; the request becomes "Pending approval · Not sent yet". The request card flies to the web, where the manager checks the four people and approves in Venue Offers. |
| 1:41 | Offers and confirmation | Diagram: one offer per person. Priya accepts on her phone and is confirmed at once (approved-request rule). Diagram: a manager-created shift holds the place until the manager confirms it; a real web inset shows a different person and shift. Then the live staffing board. |
| 2:12 | Shift day | Priya's confirmed shift, the clock-in countdown, location consent and the real scanner screen (labelled "QR scan simulated"). Then LIVE SHIFT, timed by server time, and clock-out ("End your shift?" → Clocked Out). |
| 2:42 | Review the hours | Riley's real shift report flags Isla's missing clock-out. Riley enters 18:00 with a reason, and the record shows "Corrected · Awaiting review", which is not reviewed. Riley marks each person reviewed. The optional rating tab is shown. Finalise & send unlocks only when all four are reviewed. A tracker diagram mirrors each state. |
| 3:22 | Final timesheet | Sign-off sheet: break confirmation and a typed name ("not a handwritten signature"). The real app moves through "Generating the final timesheet" → "Queued for delivery" → "Sent", then the real PDF (Adolphus template) and History. On the web, the Timesheet report shows the original and signed timesheets. |
| 3:50 | Manage the operation | Payroll is framed on the hours and pay columns only ("no money moved"), then Staff reviews, Calendar and the Dashboard with its real count-ups. |
| 4:13 | Behind the scenes | Diagram: the web console and the app → one Crewflow service, which checks who you are and your workspace on every request. Background jobs handle reminders, expiries and documents. |
| 4:30 | Get started | Recap (Request · Approve · Work · Review · Sign off), then the logo and "Open the guide for your role". |

## Product claims verified

The full matrix, with source paths, is in `packages/rab-docs/tools/cinematic/intro-film/PRODUCT_TRUTH.md`. Key points:

- **Requests:** a venue manager's request always waits for manager approval (`scheduling.service.ts`). The request size equals the number of people picked.
- **Accepting offers:**
  - On an approved request, accepting confirms immediately (`offer.service.ts`: `requestedBy != null`).
  - On a manager-created shift, the place is held until the manager confirms it.
- **Availability:** a weekday-availability conflict is an overridable warning. An overlapping confirmed booking is a hard block.
- **Corrections and review:**
  - A correction needs a reason. It sets "under review" and clears any earlier review.
  - "Mark reviewed" is a separate step.
  - Ratings are optional and do not block finalising.
  - Finalising requires every seat to be reviewed.
- **Missing clock-outs** are flagged, never auto-closed.
- **Delivery states:** Generating PDF → Queued for delivery → Sent. The PDF goes by email to the venue's venue managers, and only if email is configured. The film does not say who receives it.
- **Payroll** lists hours and calculated pay. There is no payment run and no bank transfer.
- **Not claimed:** the film makes no claim about push notifications, real-time updates, iOS, AI, CSV export or hard-coded time windows.

## Discrepancies found (not fixed, owner decisions)

**Documentation that disagrees with the code**
- `getting-started/workflow-overview.mdx` says:
  - the final PDF goes to the manager (the code sends it to venue managers);
  - staff always wait for manager confirmation (approved requests confirm at once);
  - the pay rate is locked at send (it is re-captured at confirmation).
- `how-crewflow-works.mdx:48` has the same pay-rate wording.
- `attendance/clock-in-and-out.mdx`: automatic clock-out on leaving the area applies to any venue with coordinates, not only venues that enforce the geofence.
- In-app help "Finalise a timesheet" describes a web flow that doesn't exist; finalising happens only in the venue manager's app.

**App labels and display bugs**
- The venue manager app's "Send Shift Offer" button actually submits a request for approval.
- The approval drawer shows a literal "?" between each person's times.
- The Payroll tabs and the Status column are broken (400 errors; every row reads "In progress").
- The New shift Venue/Role pickers open off-screen.

**Possible data exposure (unverified)**
- The "new shift request" notification may go to every manager and CEO in the organisation, not just the owning workspace. This is from reading code; it was not tested at runtime.

## Footage provenance

**Web.** `tools/web/record-cinematic.cjs`, slugs `intro-web-console`, `-team`, `-approve`, `-board`, `-confirm` and `-after`.
- **Source:** the real `rab-front` on an isolated Vite server whose API port has nothing listening.
- **Fixtures:** every response comes from `tools/web/fixtures.cjs`. Unknown requests fail and other origins are blocked.
- **Data:** the story is kept consistent by capture-time data adjustments (`story.request`, `story.offered`, `story.done`).
- **Capture:** 3200×1800 at 30 fps.

**Mobile.** `tools/mobile/record-intro.cjs`, scenes `request`, `offer`, `shiftday`, `clockout`, `review`/`finalise` and `history`.
- **Source:** the real debug APK built at `f5187172` with `API_URL` pointed at the demo backend (`tools/mobile-fixture-server.cjs`).
- **Demo backend:** extended for this film with a scene clock, the current report, review and finalise endpoints, and a real PDF from the server's own template (`mobile-fixture-documents.cjs`).
- **Emulator:**
  - The device clock is set per scene, with the status bar in demo mode.
  - Location is simulated (`adb emu geo fix`).
  - The camera is the emulator's virtual room.
- **Capture:** 1080×2340, real-time screen recording.

**QR.** The emulator's virtual camera cannot show a QR code: replacing its poster image didn't help in this emulator build, and the original was restored. With your approval to bypass, the clock-in and clock-out were posted to the demo backend's own endpoints from the host. The demo backend does not check QR codes or GPS. On screen: "Demo · QR scan simulated (no camera in the emulator)".

**Previously recorded phone media.** The phone media already in the docs dates from 13 October, before two app updates. Its venue manager report screens are out of date. It was not used in this film.

## Guides: what was adopted and omitted

| Guide | Adopted | Adapted | Left out |
| --- | --- | --- | --- |
| Motion as Code | Voice first, then alignment; reusable scenes; one authoritative timeline; deterministic, time-driven frames; stills before the full render | Re-timed by measured narration segments rather than word-level alignment | Its separate TypeScript/three.js starter kit and folder layout; 60 fps (source capture is 30 fps) |
| Level 5 | One idea per scene, a cue sheet (`STORY_PLAN.md`), a storyboard and one approval before the full render, speech kept dominant, self-review of rendered frames | About 10 quiet sound accents (clicks and soft whooshes), −16 LUFS | Constant glitches, a permanent HUD, the "comment this keyword" ending, the black/red look, impacts on every word |
| Five Skills | Used as a catalogue only; HyperFrames was already installed and is the renderer | — | OneTake (noncommercial licence), Collage B-roll, Claude Animation Base and Lemo Opuscar; nothing new installed |
| Kinetic Type | Restrained kinetic phrases on key words, reusable treatments, a short proof first, numbered review frames, editable source and a style guide | Phrases sit in reserved areas and never cover the controls being explained | A presenter or talking head, matting, face or depth models, the red palette, After Effects export |

## Tools and skills used

**Rendering and visuals**
- HyperFrames 0.8.181 (CLI `check`, `snapshot` and `render`) as the single renderer.
- Skills: `hyperframes`, `hyperframes-core`, `general-video`.
- GSAP 3, vendored.
- The Inter font.

**Capture**
- Playwright stepped-clock capture for the web.
- Android emulator 36.3 with adb and uiautomator for the phone.
- Flutter 3 debug build.

**Audio and media**
- ffmpeg for encoding, mixing, loudness, silence, freeze and SSIM checks.
- Kokoro-82M through `hyperframes tts`.

**Docs**
- Mintlify CLI (`validate`, `broken-links`, local preview).

**Agents.** Four specialist subagents ran:
1. A product-truth audit: feature matrix, forbidden claims, discrepancies.
2. A mobile footage audit: provenance and missing demo-backend endpoints.
3. A story and motion plan: scene manifest, proof cut, continuity flags.
4. A narration review: rewrites, pronunciation, pacing.

A fifth agent extended the mobile demo backend.

**Resolved disagreements**
- **Who Riley requests:** Riley requests all four people, so 4 of 4 matches the real request rule.
- **Shift notes:** dropped from the script, because venue manager requests can't carry notes in the real product.
- **Banned wording:** "live staffing board" and "ready for your payroll provider" were removed to avoid implying realtime updates or an export.
- **"Isla":** the pronunciation map was left as is because the voice already says it correctly.

## Voice

- **Voice:** Kokoro-82M `bf_emma` (local, Apache-2.0). No paid provider, no cloning, nothing sent off the machine.
- **Pace:** 603 words; speed 0.82 overall and 0.78 on dense lines; 224.5 s of speech at 161 wpm while speaking.
- **Pronunciation fix:** "Priya" is spoken as "Preeya". The text and captions are unchanged.
- **Not yet listened to by a person.** Review copy: `packages/rab-docs/tools/cinematic/intro-film/review/crewflow-introduction-captioned.mp4`.

## Checks

| Check | Result |
| --- | --- |
| `hyperframes check` | Passed (lint, runtime, layout, contrast). Two overlaps and two contrast issues found earlier were fixed. |
| Storyboard review | About 50 frames reviewed across all chapters. Fixed: tap rings stuck on screen, a stray keyboard, a black camera frame, the live-shift timing, the Payroll framing (tabs and Status column kept out of frame), and phone placement. |
| Master (render) | 288.3 s, 1920×1080 at 30 fps, H.264 High with AAC 48 kHz stereo, −16.1 LUFS, peak −4.3 dBFS, LRA 4.6 |
| Web delivery file | CRF 24 at 18.7 MB, under Mintlify's 20 MB limit; SSIM 0.9987 against the master; −16.1 LUFS; peak −3.3 dBFS; faststart |
| Silence | Only planned gaps: about 3 s at each chapter card, plus the opening logo (4.9 s) and the end card (5.7 s) |
| Still sections | 4 near-static stretches, all intentional: the opening, the two-branch diagram, the scanner hold and the end card |
| Docs | `check-docs`: no problems. Warnings: four unreferenced older videos, including `overview-tour.mp4`, which is kept. `mint validate` passes and `mint broken-links` passes. |
| Browser | Homepage at 1440 light and 390 dark: video loads (288.3 s) with no autoplay, not muted, controls shown; it plays from a seek, the captions track is active, the Chapters list opens, no overflow, no broken images |

**Limits of these checks**
- No human listened to the voice.
- The web footage proves the UI renders the fixture data, not live backend correctness.
- The phone footage is the real app against a demo backend that doesn't check QR codes or GPS.
- Captions on the live Mintlify site may still return 404 for `.vtt` files (found earlier). Transcripts are on the page.

## Outputs

| File | Notes |
| --- | --- |
| `packages/rab-docs/videos/getting-started/crewflow-introduction.mp4` | Web delivery copy, embedded on the homepage |
| `packages/rab-docs/videos/posters/crewflow-introduction.webp` | Poster |
| `packages/rab-docs/videos/captions/crewflow-introduction.en.vtt` | English captions, 60 cues |
| `packages/rab-docs/index.mdx` | "See how Crewflow works" section: description, video, Chapters list, transcript by chapter. Caption: "Fictional demonstration data. The phone's QR scan is simulated in this demo." |
| `tools/cinematic/intro-film/film/` | Editable composition, transcript, chapters and manifest (scenes, camera keyframes, accents, provenance). `renders/` holds the full-quality master and the captioned copy (gitignored). |
| `tools/cinematic/intro-film/proof/`, `review/` | Approved proof; captioned review copies |
| `tools/cinematic/intro-film/README.md` | Rebuild instructions |
| `tools/cinematic/intro-film/script.json`, `PRODUCT_TRUTH.md`, `STORY_PLAN.md` | Script, evidence, scene plan |
| `tools/mobile/drive.cjs`, `record-intro.cjs`, `aim-virtualscene.ps1` | Mobile capture scripts |
| `tools/mobile-fixture-server.cjs`, `mobile-fixture-documents.cjs` | Demo backend (extended) and PDF rendering |
| `tools/web/record-cinematic.cjs`, `fixtures.cjs` | `intro-web-*` scripts and the story data. The fixture now honours a story session expiry. |

**Old video:** the homepage's previous `overview-tour.mp4` is kept and is no longer referenced.

## Local, approved and published

- **Local:** everything above.
- **Approved by you:** the story, look, voice and full render (from the proof); the QR approach (poster swap, then the API bypass).
- **Published:** nothing. Not committed and not pushed. The homepage changes are local only.

## Still to do

1. Listen to the film and approve the voice.
2. To show a genuine scan, film it on a real phone or with a webcam pointed at a printed QR code.
3. Decide on the owner items listed under "Discrepancies found".
4. Approve the commit and the push.
