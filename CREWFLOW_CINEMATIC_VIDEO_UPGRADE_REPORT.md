# Crewflow cinematic Dashboard tutorial: upgrade report

**Date:** 2026-10-20
**Scope:** the Dashboard tutorial only (`getting-started/dashboard`), built locally.
**Status:** nothing has been committed, pushed, published or deployed.

## Verdict

| Area | Result | Why |
| --- | --- | --- |
| Footage and editorial camera | **PASS** | Real UI captured at device resolution, with eased zoom, pan and hold onto each card. All 10 focus boxes are in frame, with no blank edges and one cursor. |
| Captions, transcript, chapters | **PASS** | The WebVTT plays on the docs page, the transcript matches the script, and the chapter labels are restrained. |
| Delivery files | **PASS** | 1920×1080, 30 fps, H.264 High + AAC, faststart, -16 LUFS. |
| Narration voice | **PARTIAL** | A neural British voice (Kokoro `bf_emma`) is in use, but **nobody has listened to it yet**. I cannot hear audio in this environment. Pronunciation of "Crewflow" and "Hours worked" is unconfirmed. |
| **Overall** | **PARTIAL** | Becomes PASS after one human listen to the auditions and the final video (see "What you need to do"). |

## Problems with the previous video (measured, not assumed)

The old `videos/getting-started/dashboard-tour.mp4` is kept unchanged, not overwritten.

- **Resolution:** 1600×900 at 30 fps, 143.4 s long.
- **No camera at all:** the whole video is the static full frame, so small card text stays small.
- **Long near-still stretches** (ffmpeg `freezedetect`): 15.6 s (Help Center intro), 36 s, 26.8 s and 12.8 s.
- **Few scene changes:** only at 2.1, 2.4, 18.5 and 87.9 s.
- **Voice:** Windows SAPI "Microsoft Zira Desktop", which is American and audibly mechanical.

## What was used

| Tool | Version | Role |
| --- | --- | --- |
| HyperFrames (CLI + skills `hyperframes`, `hyperframes-core`, `hyperframes-keyframes`, `general-video`) | 0.8.181, pinned in the project | The single authoritative timeline and renderer: camera, labels, captions, audio |
| OpenMontage | commit `c806645` | Its screen-demo direction guidance was read and applied (hold before moving, one idea per shot, no overshoot). Its renderer was **not** used, so there is only one timeline. |
| Hypit | — | **Not installed** on this machine, so not used |
| Playwright | repo version | Clock-stepped capture of the real app against fictional fixtures |
| Kokoro-82M (via `hyperframes tts`) | model cached by HyperFrames | Final narration voice `bf_emma` (en-GB) |
| Piper | `piper-tts` + `en_GB-cori-medium` | Audition only |
| ffmpeg | local | Footage encode, audio mix, loudness, QA |

### Why one renderer, and how capture works

- **Single timeline.** One HyperFrames composition (`tools/cinematic/dashboard-tour/index.html`) drives:
  - one paused GSAP timeline that owns the camera;
  - the chapter labels and captions;
  - the narration track.
- **Plain footage.** The recording is unzoomed, so camera moves can be re-edited without recapturing.
- **Why screencast was rejected.** Chrome's screencast always delivered 1600×900 frames, which would blur any zoom.
- **What we did instead.** We step the page's clock 1/30 s at a time with Playwright and take a 3200×1800 device-pixel screenshot each step. This gives a constant 30 fps at twice the output resolution, so a 1.65× zoom still uses real source pixels. The dashboard's own JavaScript animations (count-ups, bars, tooltip) play on that stepped clock exactly as a user sees them.
- **Nothing in the app was changed.** No CSS, page zoom, animation or app behaviour was altered.

## Camera: before and after

Times are in the new video. Old: every moment is the full 1600×900 frame at 1.0×.

| New time | Shot | Zoom | What the viewer now sees |
| --- | --- | --- | --- |
| 0.0–2.5 s | Title card | — | "The Dashboard", subtitle, quick fade |
| 2.5 s | Wide | 1.00× | Whole dashboard while the intro line plays |
| 10.6 s | Offer progress strip | 1.36× | Pending / accepted / confirmed counts readable |
| 17.8 s | Totals | 1.65× | Staff, venue managers, venues |
| 22.4 s | Hours worked + tooltip | 1.65× | Card and the hovered day's exact total, both in frame |
| 30.6 s | Shifts by venue | 1.65× | Venue bars and labels |
| 36.5 s | Wide (context) | 1.00× | Brief reset before moving right |
| 38.0 s | Shift readiness | 1.65× | Header and stage track |
| 42.9 s | Checklist | 1.46× | Done vs. needs-attention items |
| 47.3 s | This week | 1.65× | Week arrows and day grid |
| 53.9 s | Wide (close) | 1.00× | Closing line over the full page |

**How the camera moves:**

- Moves last 0.7–1.0 s, eased in and out with no overshoot.
- Zoom is interpolated on a log scale, so the speed feels even.
- The frame is clamped to the footage, so no edge ever shows background.
- The builder refuses to produce a camera that would crop a focus box (`camera.json` → `qa`, 10/10 inside).

**Cursor:** one in-page cursor that moves over 350–750 ms, with a 320 ms orange click ring.

## Voice

- **Provider:** Kokoro-82M, on this machine. There was no cloud service, account, key or cost, and no voice cloning or celebrity imitation.
- **Voice and speed:** `bf_emma` at speed 0.88.
- **Pace:**
  - 152 words, spoken for 49.5 s.
  - That is 184 wpm while speaking, but **about 150 wpm across the whole video** once pauses are included (target 135–155).
  - Each line has a 0.5–0.8 s breath after it.
- **Delivery:** each line is synthesised as a whole sentence, never word by word.
- **Auditions, kept for a human decision:** both read the same four sample lines.
  - `packages/rab-docs/tools/cinematic/dashboard-tour/review/audition-kokoro-emma.wav`
  - `packages/rab-docs/tools/cinematic/dashboard-tour/review/audition-piper-cori.wav`
- **Why Kokoro was chosen:** the offline speech recogniser understood it much better than Piper ("crew flew dashboard…" vs. "crucial a Dutch bullet"). A pitch-variation measure was inconclusive. Neither measure replaces listening.

## Outputs

| File | Detail |
| --- | --- |
| `packages/rab-docs/videos/getting-started/dashboard-cinematic.mp4` | **Clean master**, 59.6 s, 1920×1080, 30 fps, 15.3 MB, faststart; used on the docs page |
| `packages/rab-docs/tools/cinematic/dashboard-tour/review/dashboard-cinematic-captioned.mp4` | Variant with captions burned in, 59.6 s |
| `packages/rab-docs/tools/cinematic/dashboard-tour/review/dashboard-cinematic-sample.mp4` | 17.6 s sample (first deliverable) |
| `packages/rab-docs/videos/captions/dashboard-cinematic.en.vtt` | WebVTT, ≤ 42 characters per line, 2 lines maximum |
| `packages/rab-docs/videos/posters/dashboard-cinematic.webp` | Poster frame taken at 29.6 s |
| `packages/rab-docs/tools/cinematic/dashboard-tour/transcript.md` | Transcript (also in the page's accordion) |
| `packages/rab-docs/tools/cinematic/dashboard-tour/` | Editable composition: `index.html`, `camera.json` (keyframes), `events.json` (cursor, clicks, element boxes), `cues.json`, `captions.json` |
| `packages/rab-docs/tools/narration/scripts/dashboard-cinematic*.json` | Narration scripts |
| `packages/rab-docs/tools/cinematic/README.md` | Regeneration and editing instructions (no credentials) |
| `packages/rab-docs/getting-started/dashboard.mdx` | Embed now points to the new video, poster and captions, with an updated transcript |

## Checks run

| Check | Result |
| --- | --- |
| Capture | 1757 frames, 58.6 s, 0 unhandled fixture requests, 0 page errors |
| `hyperframes check` | Passes, with one advisory "track too dense" note (many short caption clips) |
| Streams (master and captioned) | H.264 High 1920×1080 30 fps; AAC 48 kHz stereo; durations match |
| Loudness (ebur128) | -16.1 LUFS integrated, peak -4.2 dBFS, LRA 2.5 |
| Silence | The only gap ≥ 2.5 s is the 2.6 s title card; the last line ends at 58.4 s |
| Faststart | `moov` atom before `mdat` |
| Visual | Snapshots at the start, middle and end of every move reviewed: target in frame, sharp, one cursor, no blank edges, captions only in the captioned variant |
| Speech recognition (US model, weak proxy for British speech) | 83% of the 131 script words recognised |
| Docs | `mint validate` passes, `mint broken-links` passes, `check-docs` reports no problems |
| Docs page in a browser (desktop light, 390 px dark) | Video plays with sound after a click (no autoplay, not muted), captions show, transcript opens, no overflow |

### Limits of these checks

- **No human listening** has happened. The speech-recognition score shows the words are intelligible, not that the voice sounds natural.
- **Pure CSS transitions** in the app are not on the stepped clock. They may jump rather than ease in the footage (none were noticed in review).
- **Fixture data only.** The footage shows fictional data and does not test live permissions.
- **Camera framing:**
  - The move from Totals to Hours worked is a moderate diagonal.
  - The lower rows of the week card sit below the recorded viewport.
- **Render time:** about 3 m 50 s per variant with 2 workers (16 threads, 15 GB RAM).

## Privacy and safety

- **Data:** fictional fixtures only. Other origins were blocked, and unknown API calls failed the run, so no real mutation could leak.
- **Nothing sensitive recorded:** no real staff, payroll, emails, messages, credentials or QR secrets were captured, and no password or token was typed.
- **Nothing left the machine:** no footage or data was sent to an external AI service.
- **Nothing outside the docs tooling changed:** no change to app logic, dashboard animations, auth, Redis, workers, RLS, migrations, Docker or databases.

## Costs, downloads and approvals

- **Cost:** none. Everything ran locally.
- **Downloads approved by you ("Kokoro + Piper auditions"):**
  - the Kokoro model, cached by HyperFrames at `~/.cache/hyperframes/tts` (338 MB);
  - `kokoro-onnx` in a project-only venv at `~/.venvs/crewflow-tts`;
  - the Piper `en_GB-cori-medium` voice (63.5 MB) at `~/.venvs/piper-voices`.
- **Other dependencies:**
  - HyperFrames' Chrome at `~/.cache/hyperframes/chrome` (270 MB).
  - GSAP and the Inter fonts are vendored into the project so renders work offline.
- **Kept out of git:** `tools/cinematic/dashboard-tour/.gitignore` excludes renders, review copies and the intermediate footage and audio.

## What you need to do

1. **Listen** to the two audition files and the final video. If "Crewflow" or another word is wrong, add it to the script's `pronounce` map (this changes the spoken text only) and regenerate (`tools/cinematic/README.md`).
2. **Choose the voice:** keep Kokoro `bf_emma`, or switch to Piper `cori` (`--engine piper`).
3. **Decide about the old video:** keep or remove `dashboard-tour.mp4`, which is now unreferenced.
4. **Approve** the commit and the docs publish when you're happy. Neither has been done.
