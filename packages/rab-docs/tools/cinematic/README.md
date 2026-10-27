# Cinematic tutorials

The Dashboard tutorial (`videos/getting-started/dashboard-cinematic.mp4`) is built from real UI footage, with an editorial camera (zoom, pan and hold), one cursor, a natural on-device voice and synchronised captions. Each stage has a single owner:

| Stage | Tool | Output |
| --- | --- | --- |
| Narration | `tools/narration/synthesize-neural.cjs` (Kokoro-82M via `npx hyperframes tts`) | `tools/narration/build/<slug>/` with WAVs, `segments.json` and `voice.json` |
| Capture | `tools/web/record-cinematic.cjs` (Playwright clock-stepped, 3200×1800 at 30 fps, fictional fixtures) | `frames/`, `events.json`, `cues.json`, `captions.json`, `run.json` |
| Edit | `tools/cinematic/build-composition.cjs` + `shots/<slug>.json` | `dashboard-tour/` HyperFrames project with `index.html`, `camera.json`, VTT and transcript |
| Render | `npx hyperframes render` (HyperFrames 0.8.181, local Chrome) | `dashboard-tour/renders/*.mp4` |

There is one timeline. The HyperFrames composition (`dashboard-tour/index.html`) owns the camera, chapter labels, captions and audio. The footage is a plain recording with no zoom baked in. The app's CSS, page zoom and behaviour are never changed to fake the camera.

## Requirements

All of these are local; there are no paid or cloud services.

- Node 20+, ffmpeg/ffprobe on `PATH`, and Playwright Chromium (already used by `tools/web`).
- A Python venv with `kokoro-onnx` and `soundfile`. HyperFrames downloads the Kokoro model (~340 MB) to `~/.cache/hyperframes/tts` on first use.
- Optional, for auditions only: a Python with `piper-tts` and an `en_GB-*.onnx` voice.

## Regenerate

From `packages/rab-docs`:

```bash
# 1. Narration (one coherent clip per line; the pacing feeds the recorder)
CREWFLOW_TTS_PYTHON=<venv>/Scripts/python.exe \
  node tools/narration/synthesize-neural.cjs tools/narration/scripts/dashboard-cinematic.json tools/narration/build/dashboard-cinematic

# 2. Isolated front end against a dead API port. Fixtures answer everything; unknown routes return 501 and fail the run.
(cd ../rab-front && VITE_API_URL=http://127.0.0.1:3999/rest/v1 npx vite --port 5174 --host 127.0.0.1 --strictPort) &

# 3. Capture (about 3 minutes of real time for 60 s of footage)
CREWFLOW_WEB_ORIGIN=http://127.0.0.1:5174 \
  node tools/web/record-cinematic.cjs dashboard-cinematic --out <rec-dir> --dpr 2 --fps 30
#    Check <rec-dir>/run.json: unhandled [] and failure null.

# 4. Build the composition (encodes footage once, mixes and loudness-normalises narration to -16 LUFS, writes camera/captions)
node tools/cinematic/build-composition.cjs tools/cinematic/shots/dashboard-cinematic.json <rec-dir>

# 5. Validate and look
cd tools/cinematic/dashboard-tour
npx hyperframes check
npx hyperframes snapshot --at 3,11,18,23,31,38,43,48,54

# 6. Render the clean master and the burned-caption variant (2 workers is modest for a 16-thread / 15 GB machine)
npx hyperframes render --fps 30 --workers 2 --video-frame-format png --quality delivery -o renders/dashboard-cinematic.mp4
npx hyperframes render --fps 30 --workers 2 --video-frame-format png --quality delivery \
  --variables '{"showCaptions":true}' -o renders/dashboard-cinematic-captioned.mp4

# 7. Faststart and publish locally (docs page plays the master with the VTT track)
ffmpeg -i renders/dashboard-cinematic.mp4 -c copy -movflags +faststart ../../../videos/getting-started/dashboard-cinematic.mp4
cp dashboard-cinematic.en.vtt ../../../videos/captions/
ffmpeg -ss 29.6 -i renders/dashboard-cinematic.mp4 -frames:v 1 -c:v libwebp -quality 85 ../../../videos/posters/dashboard-cinematic.webp
```

For the 15–20 s sample, use the same steps with `dashboard-cinematic-sample` in place of `dashboard-cinematic`.

## Task tutorials (the other 12 web videos)

The other web tutorials follow the same pipeline. Their camera is written beside the action in `record-cinematic.cjs`:

- `r.focus(id, [targets], { chapter })` frames the union of real UI elements, with margins, from that moment.
- `r.wide(id)` returns to the whole screen.

`build-composition.cjs` turns these cues into keyframes, so `shots/<slug>.json` only carries the title, subtitle and zoom limits. Each tutorial gets its own HyperFrames project, `tools/cinematic/<slug>/`, scaffolded from `dashboard-tour/`.

The slugs are:

- `overview-tour`
- `sidebar-shortcuts`
- `create-workspace`
- `invite-manager`
- `add-staff`
- `assign-venue-manager-staff`
- `staff-reviews`
- `create-venue`
- `create-shift-send-offers`
- `venue-request-approval`
- `confirm-offers`
- `staffing-pipeline`

```bash
# narration: the existing scripts, re-voiced with Kokoro
CREWFLOW_TTS_PYTHON=<venv>/Scripts/python.exe node tools/narration/synthesize-neural.cjs \
  tools/narration/scripts/<slug>.json tools/narration/build/<slug> --engine kokoro --voice bf_emma --speed 0.88
# quick selector check at low resolution, then the real capture
CREWFLOW_WEB_ORIGIN=http://127.0.0.1:5174 node tools/web/record-cinematic.cjs <slug> --out <dry-dir> --dpr 1 --fps 6
CREWFLOW_WEB_ORIGIN=http://127.0.0.1:5174 node tools/web/record-cinematic.cjs <slug> --out <rec-dir>
node tools/cinematic/build-composition.cjs tools/cinematic/shots/<slug>.json <rec-dir>/<slug>
cd tools/cinematic/<slug> && npx hyperframes check && npx hyperframes render --fps 30 --workers 2 --video-frame-format png --quality delivery -o renders/<slug>.mp4
```

Copy the render, `<slug>.en.vtt` and a poster frame over the existing `videos/<area>/<slug>.mp4`, `videos/captions/` and `videos/posters/` files. The pages already embed those paths.

**Capture notes:**

- During capture, `Element.prototype.animate` is removed in the page. framer-motion then runs its usual opacity and transform animations on its main-thread engine, which follows the stepped clock. Otherwise a drawer's fade can stall half-finished. The app's code and CSS are unchanged.
- The New shift drawer's Venue and Role pickers currently open their menu off-screen, which is a UI defect. The tutorial uses the picker's keyboard support instead (Tab, type, Enter).

## Home-page cover and Key features cards

`tools/web/build-feature-cards.cjs` captures fresh web console screens in light and dark themes, using the same fixtures. It composes the cover and the six cards from an HTML template, and writes them to `images/getting-started/`. The phone screens reuse `images/mobile/`.

```bash
CREWFLOW_WEB_ORIGIN=http://127.0.0.1:5174 node tools/web/build-feature-cards.cjs [--out <dir>] [--keep <work-dir>]
```

## Editing

- **Words:** edit `tools/narration/scripts/<slug>.json`, then rerun steps 1–6. The capture is paced to the spoken line lengths, so new words need a new recording. `pauseAfter` sets the breath after a line, and `pronounce` changes only the spoken text, never the captions.
- **Camera:** edit `shots/<slug>.json` and rerun steps 4–6. No re-recording is needed.
  - `at.cue`/`at.offset` time a move against a narration line.
  - `focus` lists `mark:<id>` boxes recorded during capture; `rect: "full"` is the wide frame.
  - `duration` is the move length. Moves are eased in and out with no overshoot.
  - The builder refuses to write a camera that would crop a focus box.
- **Display:** the composition variables `showCaptions` and `showChapters` switch the burned captions and chapter labels.
- **Studio:** `npx hyperframes preview` opens the composition for visual editing.

## Privacy

Capture uses only `tools/web/fixtures.cjs`, which holds fictional people, venues and numbers. Other origins are blocked, and unhandled API calls fail the run instead of reaching a real server. The recorder logs element boxes and labels, never input values. It never types into password or token fields. Nothing is sent to an external AI service: narration is synthesised on this machine.
