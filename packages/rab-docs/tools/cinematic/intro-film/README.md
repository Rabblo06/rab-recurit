# Crewflow introduction film: "From staffing request to final timesheet"

This is a 4 min 48 s narrated introduction. It follows one fictional shift through the web console and the mobile app.

One HyperFrames composition (`film/`) owns the single timeline. The timeline is derived from the measured narration (`timeline.cjs`).

## Files

| File | What it is |
| --- | --- |
| `script.json` | Narration script: segments, chapters and pauses. Every claim is checked against `PRODUCT_TRUTH.md`. |
| `PRODUCT_TRUTH.md` | Feature-to-evidence matrix (code paths), forbidden claims, and doc/code discrepancies. |
| `STORY_PLAN.md` | Scene manifest, layout rules, the proof cut and continuity decisions. |
| `timeline.cjs` | The film clock: measured segments laid end to end, with chapter gaps and visual holds. No speech is ever stretched. |
| `lib/components.cjs` | Shared look: palette, web stage, device frame, cards, chips, chapter cards and captions. Also the camera runtime. |
| `lib/clips.cjs` | Cuts real footage onto the film clock: trimmed, or holding its last frame, never time-stretched. |
| `build-proof.cjs` → `proof/` | The approved 31.6 s proof. |
| `build-film.cjs` → `film/` | The full film: `index.html`, `crewflow-introduction.en.vtt`, `transcript.md`, `chapters.json`, `manifest.json` (scene, camera and provenance metadata). |
| `../../mobile/record-intro.cjs`, `drive.cjs` | Native app recordings on the emulator, with tap and mark metadata. |
| `../../mobile-fixture-server.cjs` | The phone app's demo backend, with a scene clock and fictional data. |
| `../../web/record-cinematic.cjs` | `intro-web-*` web captures, with story data adjustments (`story.request/offered/done`). |

## Rebuild

Run everything from `packages/rab-docs/tools`. Nothing here touches a real backend, database or worker.

**1. Narration.** Generate it locally with Kokoro-82M (bf_emma, speed 0.82):

```bash
CREWFLOW_TTS_PYTHON=<venv>/Scripts/python.exe node narration/synthesize-neural.cjs cinematic/intro-film/script.json narration/build/crewflow-introduction
```

**2. Web footage.** Start the isolated front end against a dead API port, so only fixtures answer:

```bash
(cd ../../rab-front && VITE_API_URL=http://127.0.0.1:3999/rest/v1 npx vite --port 5174 --host 127.0.0.1 --strictPort) &
for s in intro-web-console intro-web-team intro-web-approve intro-web-board intro-web-confirm intro-web-after; do
  CREWFLOW_WEB_ORIGIN=http://127.0.0.1:5174 node web/record-cinematic.cjs $s --out <rec-intro>; done
```

**3. Phone footage.**
- Use a debug APK built with `--dart-define=API_URL=http://10.0.2.2:4010/rest/v1`, the `Pixel_5` emulator and the demo backend.
- Use short delivery timers so "Generating PDF → Queued → Sent" changes on camera.

```bash
FIXTURE_PDF_MIN_SECONDS=4 FIXTURE_DELIVERY_SECONDS=7 node mobile-fixture-server.cjs &
for s in request offer shiftday clockout review history; do node mobile/record-intro.cjs $s --out <rec-mobile>; done
```

The `review` scene writes `review.*` and `finalise.*`, because the emulator recorder stops at 180 s.

**4. Composition, check and render.** This renders the clean master, then a burned-caption review copy.

```bash
node cinematic/intro-film/build-film.cjs --web <rec-intro> --mobile <rec-mobile>
cd cinematic/intro-film/film && npx hyperframes check
npx hyperframes render --fps 30 --workers 2 --video-frame-format png --quality delivery -o renders/crewflow-introduction.mp4
npx hyperframes render --fps 30 --workers 2 --video-frame-format png --quality delivery --variables '{"showCaptions":true}' -o renders/crewflow-introduction-captioned.mp4
```

**5. Publish locally.** Copy into the docs and point `index.mdx` at the new files:
- the master to `videos/getting-started/crewflow-introduction.mp4`, with faststart;
- the VTT to `videos/captions/`;
- a poster to `videos/posters/`.

## Honesty notes

- **Data:** all data is fictional. Web footage comes from `tools/web/fixtures.cjs`. Phone footage comes from the demo backend.
- **Not a backend test:** fixture footage is not an end-to-end test of the real backend.
- **QR scan is simulated:** the emulator has no camera that can read a QR code. For Priya's clock-in and clock-out, the scanner screen is filmed live. The clock-in or clock-out itself is then posted to the demo backend from the host, using the same endpoint the app calls, as a stand-in for the scan. The film labels this on screen ("Demo · QR scan simulated").
- **The demo backend does not validate QR tokens or GPS.**
- **Narration:** a synthetic voice. Nobody has listened to it yet; it needs a human review.
