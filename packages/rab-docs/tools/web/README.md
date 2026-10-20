# Web console captures

Scripts that produce the screenshots and tutorial recordings of the Crewflow web console used in
these docs.

## What is real and what is synthetic

- **Real:** the UI. Every page, drawer, label, validation message and interaction comes from the
  running `rab-front` Vite dev server. Nothing under `packages/rab-front` is modified.
- **Synthetic:** every API response. `fixtures.cjs` intercepts each `**/rest/v1/**` request inside
  the browser (`page.route`) and answers it from an in-memory, stateful demo backend. No request
  reaches a real API, database, queue or mail server. Realtime (`/realtime/**`) is answered with
  `204`, which the app treats as "realtime off".
- All people, venues, emails (`@example.test`), phone numbers (`+44 7700 900xxx`) and IP
  addresses (documentation ranges) are fictional. Dates are computed relative to the moment the
  script runs, so lists always look current.
- The timesheet PDF opened in the `timesheets-review` recording is rendered with rab-server's own
  template (`modules/attendance/templates/final-timesheet.html.ts`), filled with synthetic rows.

## Requirements

- The `rab-front` Vite dev server running on `http://127.0.0.1:5173`
  (override with `CREWFLOW_WEB_ORIGIN`).
- Google Chrome installed (Playwright launches it with `channel: 'chrome'`).
- Repository dependencies installed (`playwright` and `typescript` from the root `node_modules`).

## Run

From the repository root:

```bash
# Screenshots → packages/rab-docs/images/web/<area>/<name>.png
node packages/rab-docs/tools/web/capture-screens.cjs
node packages/rab-docs/tools/web/capture-screens.cjs offers     # only matching jobs

# Tutorial recordings → <out>/<slug>/frames/*.jpg, frames.json, captions.json
node packages/rab-docs/tools/web/record-tutorials.cjs "" --out ./tmp/recordings
node packages/rab-docs/tools/web/record-tutorials.cjs confirm-offers --out ./tmp/recordings
```

Screenshots use a 1440×900 viewport at 2× pixel density, light theme and reduced motion (except
the onboarding flow, which needs its real animation for the welcome overlay). Drawer and panel
shots are cropped to the panel; when a drawer scrolls, the viewport is made taller so the whole
panel is visible.

Recordings use a 1600×900 viewport at 1×, light theme and full motion. Frames come from the
Chrome DevTools Protocol screencast, which only emits a frame when the screen changes, so
`frames.json` carries a timestamp (`t`, seconds from the first frame) for each frame. Assemble
them by timestamp, not at a fixed frame rate. `captions.json` uses the same clock. The cursor and
click ripple are drawn by an injected script because headless Chrome has no visible pointer.

## Files

| File | Purpose |
| --- | --- |
| `fixtures.cjs` | Stateful fixture backend: `install(page, { persona, theme, latencyMs })`. Personas: `manager`, `ceo`, `platformAdmin`, `newManager`, `anon`. |
| `common.cjs` | Shared launch, settle, crop and viewport helpers. |
| `capture-screens.cjs` | Screenshot jobs. |
| `record-tutorials.cjs` | Tutorial recordings with captions. |

Mutations update the in-memory state, so a recording shows real results: created staff appear in
the list, confirmed offers change status, an approved venue request opens its live pipeline, and
`POST /shifts/with-offers` applies the same overlap rule and message as the server
(`This staff member already has a confirmed shift that overlaps this time.`).

Any request the fixture does not recognise is logged as "unhandled" in the script output. Add a
handler in `fixtures.cjs` rather than changing the app.

## Strict fixtures and narrated tutorials (2026-10-20)

- Unknown `/rest/v1` requests now return **501** and fail the capture job or recording (they used to return an empty list). Every request to another origin is **blocked** and reported. Flag icons for the phone field are served from the local `country-flag-icons` package.
- Pass `realtime: true` to `openPage` to serve the app's real server-sent-event stream. `fx.push('offer.accepted')` then delivers one event, and the app refreshes itself.
- Narrated tutorials call `r.say('<segment id>')`. Segments come from `../narration/build/<slug>/segments.json`, produced by `../narration/synthesize.ps1` from `../narration/scripts/<slug>.json`. Each line waits for the previous one, and `cues.json` records when it was spoken, so `../compose-videos.cjs` places the voice without stretching the video.
- The full workflow, including QA and embedding, is in `../../internal/DOCS_UPDATE_2026-10-20.md`.
