#!/usr/bin/env node
// Builds a HyperFrames composition (one authoritative timeline) from a cinematic capture + a shot plan.
//
//   node tools/cinematic/build-composition.cjs <shots.json> <recording-dir> [--captions on|off]
//
// Inputs: <recording-dir> from tools/web/record-cinematic.cjs (frames/*.jpg at constant fps, cues.json, events.json).
// Writes into tools/cinematic/<project>/:
//   assets/footage.mp4   the recording, encoded ONCE (3200×1800, constant fps, high quality) — the only intermediate
//   assets/narration.wav every spoken line placed at its recorded moment, loudness-normalised once (−16 LUFS, −1.5 dBTP)
//   camera.json          editorial camera keyframes (frame px) computed from real target boxes; QA checks included
//   captions.json / <slug>.en.vtt / transcript.md
//   index.html           composition: footage inside a camera wrapper, chapter labels, optional captions, narration
// Nothing here changes the app, its CSS or the browser zoom: the camera is a transform on the footage wrapper.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const [shotsPath, recDir] = process.argv.slice(2);
const opt = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const plan = JSON.parse(fs.readFileSync(shotsPath, 'utf8'));
const proj = path.resolve(__dirname, plan.project);
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const frames = JSON.parse(fs.readFileSync(path.join(recDir, 'frames.json'), 'utf8'));
const cues = JSON.parse(fs.readFileSync(path.join(recDir, 'cues.json'), 'utf8'));
const ev = JSON.parse(fs.readFileSync(path.join(recDir, 'events.json'), 'utf8'));
const { fps, dpr, viewport } = ev;
const FW = viewport.width * dpr, FH = viewport.height * dpr; // frame px
const OUT_W = 1920, OUT_H = 1080;
const TITLE = plan.title ? Number(plan.titleSeconds || 2.2) : 0;
fs.mkdirSync(path.join(proj, 'assets'), { recursive: true });
// New tutorial → scaffold its HyperFrames project from the Dashboard one (vendored GSAP + Inter, pinned CLI, config).
const TEMPLATE = path.resolve(__dirname, 'dashboard-tour');
if (!fs.existsSync(path.join(proj, 'assets', 'vendor', 'gsap.min.js'))) {
  for (const d of ['vendor', 'fonts']) fs.cpSync(path.join(TEMPLATE, 'assets', d), path.join(proj, 'assets', d), { recursive: true });
  fs.copyFileSync(path.join(TEMPLATE, 'hyperframes.json'), path.join(proj, 'hyperframes.json'));
  fs.copyFileSync(path.join(TEMPLATE, '.gitignore'), path.join(proj, '.gitignore'));
  const pkg = JSON.parse(fs.readFileSync(path.join(TEMPLATE, 'package.json'), 'utf8')); pkg.name = plan.project;
  fs.writeFileSync(path.join(proj, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  fs.writeFileSync(path.join(proj, 'meta.json'), `${JSON.stringify({ id: plan.project, name: plan.project, createdAt: new Date().toISOString() }, null, 2)}\n`);
}

// ── Timeline mapping ─────────────────────────────────────────────────────────────────────────────────────────────
// The edit starts two frames after the click that opened the page (so the page's first-load reveal is complete in the
// footage); composition time = recording time − cutIn + title.
const cutEvt = ev.events.find((e) => e.type === 'cut-in');
const clickBefore = cutEvt ? [...ev.events].filter((e) => e.type === 'click' && e.t <= cutEvt.t).pop() : null;
const cutIn = clickBefore ? clickBefore.t + 2 / fps : cutEvt ? cutEvt.t : 0;
const toComp = (t) => t - cutIn + TITLE;
const lastCue = cues[cues.length - 1];
const recEnd = Math.min(frames[frames.length - 1].t, lastCue.start + lastCue.seconds + (plan.tail ?? 0.8));
const firstFrame = Math.round(cutIn * fps);
const nFrames = Math.round((recEnd - cutIn) * fps);
const footageSeconds = nFrames / fps;
const total = Number((TITLE + footageSeconds).toFixed(3));

// ── 1. Footage: encode once, constant fps, from the real captured frames ──────────────────────────────────────────
const footageOut = path.join(proj, 'assets', 'footage.mp4');
const footageFresh = fs.existsSync(footageOut) && fs.statSync(footageOut).mtimeMs > fs.statSync(path.join(recDir, 'frames.json')).mtimeMs
  && Math.abs(Number(spawnSync(process.env.FFPROBE || 'ffprobe', ['-v', 'error', '-count_packets', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', footageOut], { encoding: 'utf8' }).stdout) - nFrames) === 0;
if (!footageFresh) execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-framerate', String(fps), '-start_number', String(firstFrame + 1),
  '-i', path.join(recDir, 'frames', '%06d.jpg'), '-frames:v', String(nFrames), '-c:v', 'libx264', '-preset', 'slow', '-crf', '12',
  '-pix_fmt', 'yuv420p', '-g', String(fps), '-movflags', '+faststart', path.join(proj, 'assets', 'footage.mp4')]);

// ── 2. Narration: each line at its recorded moment; one loudness normalisation pass ───────────────────────────────
{
  const inputs = []; const parts = [];
  cues.forEach((c, i) => { inputs.push('-i', c.file); parts.push(`[${i}:a]aresample=48000,adelay=${Math.round(toComp(c.start) * 1000)}:all=1[a${i}]`); });
  const mixed = path.join(proj, 'assets', 'narration.raw.wav');
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...inputs, '-filter_complex',
    `${parts.join(';')};${cues.map((_, i) => `[a${i}]`).join('')}amix=inputs=${cues.length}:normalize=0:dropout_transition=0,apad,atrim=0:${total}[m]`,
    '-map', '[m]', '-ar', '48000', '-ac', '1', mixed]);
  // Two-pass loudnorm: measure, then apply linearly (no pumping) to −16 LUFS integrated, −1.5 dBTP.
  const m = spawnSync(FFMPEG, ['-hide_banner', '-i', mixed, '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
  const j = JSON.parse(m.slice(m.lastIndexOf('{'), m.lastIndexOf('}') + 1));
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', mixed, '-af',
    `loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=${j.input_i}:measured_TP=${j.input_tp}:measured_LRA=${j.input_lra}:measured_thresh=${j.input_thresh}:offset=${j.target_offset}:linear=true,aresample=48000`,
    '-ac', '2', path.join(proj, 'assets', 'narration.wav')]);
  fs.unlinkSync(mixed);
}

// ── 3. Camera: semantic focus regions from the recorded target boxes ─────────────────────────────────────────────
const marks = Object.fromEntries(ev.events.filter((e) => e.type === 'mark').map((e) => [e.id, e.bbox]));
const cueStart = Object.fromEntries(cues.map((c) => [c.id, c.start]));
const full = { x: 0, y: 0, w: FW, h: FH };
function focusRect(ids) {
  const boxes = ids.map((id) => { const b = marks[id.replace(/^mark:/, '')]; if (!b) throw new Error(`no mark ${id}`); return { x: b.x * dpr, y: b.y * dpr, w: b.w * dpr, h: b.h * dpr }; });
  let x0 = Math.min(...boxes.map((b) => b.x)), y0 = Math.min(...boxes.map((b) => b.y));
  let x1 = Math.max(...boxes.map((b) => b.x + b.w)), y1 = Math.max(...boxes.map((b) => b.y + b.h));
  const mx = Math.max(80, (x1 - x0) * plan.marginRatio), my = Math.max(80, (y1 - y0) * plan.marginRatio); // comfortable margins
  x0 -= mx; x1 += mx; y0 -= my; y1 += my;
  let w = x1 - x0, h = y1 - y0;
  if (w / h < 16 / 9) w = h * 16 / 9; else h = w * 9 / 16;   // 16:9, never stretched
  w = Math.max(w, FW / plan.maxZoom); h = w * 9 / 16;         // zoom ceiling (source resolution)
  w = Math.min(w, FW); h = Math.min(h, FH);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const x = Math.min(Math.max(0, cx - w / 2), FW - w), y = Math.min(Math.max(0, cy - h / 2), FH - h); // no blank edges
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h), boxes };
}
// Shots come from the plan, or — for task tutorials — from the camera cues the recorder logged beside each action.
const shots = plan.shots || [
  { id: 'open', recT: cutIn, rect: 'full' },
  ...ev.events.filter((e) => e.type === 'camera').map((e) => ({ id: e.id, recT: e.t + (e.offset || 0), duration: e.duration, chapter: e.chapter, ...(e.rect === 'full' ? { rect: 'full' } : { focus: e.marks }) })),
];
const camera = [];
const qa = [];
for (const s of shots) {
  const t = Number(Math.max(TITLE, s.recT != null ? toComp(s.recT) : toComp(cueStart[s.at.cue]) + (s.at.offset || 0)).toFixed(3));
  const r = s.rect === 'full' ? { ...full } : focusRect(s.focus);
  if (r.boxes) for (const b of r.boxes) {
    const inside = b.x >= r.x && b.y >= r.y && b.x + b.w <= r.x + r.w && b.y + b.h <= r.y + r.h;
    qa.push({ shot: s.id, box: b, inside });
    if (!inside) throw new Error(`shot ${s.id}: a focus box would be cropped — widen the shot`);
  }
  delete r.boxes;
  camera.push({ id: s.id, t, duration: s.duration || 0, rect: r, zoom: Number((FW / r.w).toFixed(3)), chapter: s.chapter || null });
}
fs.writeFileSync(path.join(proj, 'camera.json'), JSON.stringify({ frame: { width: FW, height: FH }, output: { width: OUT_W, height: OUT_H }, cutIn, title: TITLE, keyframes: camera, qa }, null, 2));

// ── 4. Captions (WebVTT + JSON) and transcript, on the composition clock ────────────────────────────────────────
const chunks = [];
for (const c of cues) {
  const words = c.text.split(/\s+/); const lines = []; let cur = '';
  for (const w of words) { if ((cur + ' ' + w).trim().length > 42 && cur) { lines.push(cur); cur = w; } else cur = (cur + ' ' + w).trim(); }
  if (cur) lines.push(cur);
  const groups = []; for (let i = 0; i < lines.length; i += 2) groups.push(lines.slice(i, i + 2).join('\n'));
  const totalChars = groups.reduce((a, g) => a + g.length, 0); let at = toComp(c.start);
  for (const g of groups) { const d = c.seconds * (g.length / totalChars); chunks.push({ start: +at.toFixed(3), end: +(at + d).toFixed(3), text: g }); at += d; }
}
const vtt = (s) => { const ms = Math.round(s * 1000); return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`; };
fs.writeFileSync(path.join(proj, 'captions.json'), JSON.stringify(chunks, null, 2));
fs.writeFileSync(path.join(proj, `${plan.slug}.en.vtt`), ['WEBVTT', '', ...chunks.map((c, i) => `${i + 1}\n${vtt(c.start)} --> ${vtt(c.end)}\n${c.text}\n`)].join('\n'));
fs.writeFileSync(path.join(proj, 'transcript.md'), `# ${plan.title}\n\n${cues.map((c) => c.text).join('\n\n')}\n`);
fs.copyFileSync(path.join(recDir, 'events.json'), path.join(proj, 'events.json'));
fs.copyFileSync(path.join(recDir, 'cues.json'), path.join(proj, 'cues.json'));

// ── 5. Composition HTML ──────────────────────────────────────────────────────────────────────────────────────────
const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const showCaptions = opt('--captions', 'off') === 'on';
// A chapter label stays up until the next chapter starts (camera moves in between don't interrupt it).
const chaptered = camera.filter((k) => k.chapter);
const chapters = chaptered.map((k, i) => ({ ...k, end: i + 1 < chaptered.length ? chaptered[i + 1].t : total }));
const html = `<!doctype html>
<html lang="en" data-composition-variables='[{"id":"showCaptions","type":"boolean","label":"Burn in captions","default":${showCaptions}},{"id":"showChapters","type":"boolean","label":"Chapter labels","default":true}]'>
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=${OUT_W}, height=${OUT_H}" />
<title>Crewflow — ${esc(plan.title || 'The Dashboard')}</title>
<script src="assets/vendor/gsap.min.js"></script>
<style>
  @font-face { font-family: "Inter"; src: url("assets/fonts/inter-latin-500-normal.woff2") format("woff2"); font-weight: 500; }
  @font-face { font-family: "Inter"; src: url("assets/fonts/inter-latin-600-normal.woff2") format("woff2"); font-weight: 600; }
  @font-face { font-family: "Inter"; src: url("assets/fonts/inter-latin-700-normal.woff2") format("woff2"); font-weight: 700; }
  body { margin: 0; background: #f5f5f4; font-family: "Inter", sans-serif; }
  #root { position: relative; width: 100%; height: 100%; overflow: hidden; background: #f5f5f4; }
  #stage { position: absolute; inset: 0; overflow: hidden; }
  /* The footage keeps its native 3200×1800 pixels; the camera wrapper scales it to the 1920×1080 canvas. */
  #camera { position: absolute; left: 0; top: 0; width: ${FW}px; height: ${FH}px; transform-origin: 0 0; }
  #footage { position: absolute; left: 0; top: 0; width: ${FW}px; height: ${FH}px; }
  .chapter { position: absolute; left: 40px; bottom: 36px; padding: 9px 16px; border-radius: 999px; background: rgba(28, 25, 23, 0.86); color: #fff; font-weight: 600; font-size: 22px; letter-spacing: 0.01em; opacity: 0; }
  .chapter::before { content: ""; display: inline-block; width: 9px; height: 9px; border-radius: 50%; background: #f97316; margin-right: 10px; vertical-align: 2px; }
  #captions { position: absolute; left: 0; right: 0; bottom: 48px; height: 120px; }
  .cap { position: absolute; left: 0; right: 0; bottom: 0; width: fit-content; margin: 0 auto; max-width: 1180px; padding: 12px 24px; border-radius: 14px; background: rgba(28, 25, 23, 0.84); color: #fff; font-weight: 500; font-size: 32px; line-height: 1.32; text-align: center; white-space: pre-line; }
  #title-card { position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: center; padding: 0 140px; background: #fafaf9; }
  #title-card .eyebrow { font-weight: 600; font-size: 24px; letter-spacing: 0.12em; text-transform: uppercase; color: #ea580c; }
  #title-card h1 { margin: 18px 0 0; font-weight: 700; font-size: 84px; letter-spacing: -0.02em; color: #1c1917; }
  #title-card p { margin: 22px 0 0; font-weight: 500; font-size: 30px; color: #57534e; }
</style>
</head>
<body>
<div id="root" data-composition-id="${plan.project}" data-start="0" data-width="${OUT_W}" data-height="${OUT_H}" data-duration="${total}">
  <div id="stage">
    <div id="camera" data-layout-allow-overflow>
      <video id="footage" class="clip" data-start="${TITLE}" data-track-index="0" muted playsinline src="assets/footage.mp4"></video>
    </div>
  </div>
${plan.title ? `  <section id="title-card" class="clip" data-start="0" data-duration="${(TITLE + 0.5).toFixed(2)}" data-track-index="1">
    <div id="title-inner"><div class="eyebrow">Crewflow tutorial</div><h1>${esc(plan.title)}</h1><p>${esc(plan.subtitle || '')}</p></div>
  </section>\n` : ''}${chapters.map((k, i) => `  <div id="chapter-${i}" class="chapter clip" data-start="${k.t}" data-duration="${(k.end - k.t).toFixed(3)}" data-track-index="2">${esc(k.chapter)}</div>`).join('\n')}
  <div id="captions">
${chunks.map((c, i) => `    <p id="cap-${i}" class="cap clip" data-start="${c.start}" data-duration="${(c.end - c.start).toFixed(3)}" data-track-index="3">${esc(c.text)}</p>`).join('\n')}
  </div>
  <audio id="narration" class="clip" data-start="0" data-track-index="4" data-volume="1" src="assets/narration.wav"></audio>
</div>
<script>
  // Camera: a pure function of composition time, driven by ONE seek-safe tween (no clocks, no randomness).
  const KEYS = ${JSON.stringify(camera.map(({ t, duration, rect }) => ({ t, d: duration, r: rect })))};
  const OUT_W = ${OUT_W};
  const ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2); // ease-in-out, no overshoot
  function lerp(a, b, t0, d, t) {
    const e = ease(d > 0 ? Math.min(1, Math.max(0, (t - t0) / d)) : 1);
    const w = Math.exp(Math.log(a.w) + (Math.log(b.w) - Math.log(a.w)) * e); // zoom interpolates perceptually (log)
    const cx = a.x + a.w / 2 + (b.x + b.w / 2 - a.x - a.w / 2) * e, cy = a.y + a.h / 2 + (b.y + b.h / 2 - a.y - a.h / 2) * e;
    return { x: cx - w / 2, y: cy - (w * 9 / 16) / 2, w, h: w * 9 / 16 };
  }
  // Each move starts from wherever the camera actually is, so a move that begins before the last one finished
  // continues smoothly instead of jumping.
  function rectAt(t) {
    let seg = null;
    for (let i = 1; i < KEYS.length; i++) {
      const k = KEYS[i];
      if (t < k.t) break;
      const from = seg ? lerp(seg.a, seg.b, seg.t0, seg.d, k.t) : KEYS[0].r;
      seg = { a: from, b: k.r, t0: k.t, d: k.d };
    }
    return seg ? lerp(seg.a, seg.b, seg.t0, seg.d, t) : KEYS[0].r;
  }
  const cam = document.getElementById("camera");
  function apply(t) { const r = rectAt(t); const s = OUT_W / r.w; gsap.set(cam, { x: -r.x * s, y: -r.y * s, scale: s, transformOrigin: "0 0" }); }
  const vars = (window.__hyperframes && window.__hyperframes.getVariables) ? window.__hyperframes.getVariables() : {};
  if (vars.showCaptions === false || (vars.showCaptions === undefined && ${!showCaptions})) document.getElementById("captions").style.display = "none";
  if (vars.showChapters === false) document.querySelectorAll(".chapter").forEach((e) => (e.style.display = "none"));
  const tl = gsap.timeline({ paused: true });
  const clock = { t: 0 };
  apply(0);
  tl.to(clock, { t: ${total}, duration: ${total}, ease: "none", onUpdate: () => apply(clock.t) }, 0);
${chapters.map((k, i) => `  tl.fromTo("#chapter-${i}", { opacity: 0 }, { opacity: 1, duration: 0.35, ease: "power2.out" }, ${(k.t + k.duration * 0.6).toFixed(3)});
  tl.to("#chapter-${i}", { opacity: 0, duration: 0.3, ease: "power2.in" }, ${Math.max(k.t + 0.5, k.end - 0.35).toFixed(3)});`).join('\n')}
${plan.title ? `  tl.fromTo("#title-inner", { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.6, ease: "power2.out" }, 0.15);
  tl.to("#title-card", { opacity: 0, duration: 0.5, ease: "power2.inOut" }, ${(TITLE - 0.1).toFixed(2)});` : ''}
  window.__timelines["${plan.project}"] = tl;
</script>
</body>
</html>
`;
fs.writeFileSync(path.join(proj, 'index.html'), html);
console.log(JSON.stringify({ project: proj, cutIn: +cutIn.toFixed(3), footageSeconds: +footageSeconds.toFixed(3), total, frames: nFrames, keyframes: camera.map((k) => `${k.id}@${k.t}s zoom ${k.zoom}`), captions: chunks.length, focusChecks: qa.map((q) => `${q.shot}:${q.inside ? 'in-frame' : 'CROPPED'}`) }, null, 1));
