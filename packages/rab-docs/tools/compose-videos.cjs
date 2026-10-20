// Turns raw tutorial captures into finished documentation videos:
//   title card (2.4 s) → real recording with burned-in captions → H.264 MP4 (+faststart) and a WebP poster.
//
// Inputs (produced by tools/web/record-tutorials.cjs and tools/capture-mobile.ps1):
//   web:    <REC_DIR>/<slug>/frames/*.jpg, frames.json [{file,t}], captions.json [{start,end,text}]
//   mobile: videos/raw-mobile/<slug>.mp4 and <slug>.captions.json
// Requires an ffmpeg with libx264 and libwebp:  FFMPEG=/path/to/ffmpeg node tools/compose-videos.cjs [slug…]
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const REC_DIR = process.env.REC_DIR || path.join(root, 'videos', 'raw-web');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-video-'));

const TUTORIALS = [
  { slug: 'assign-venue-manager-staff', kind: 'web', out: 'managers', title: 'Assigning staff to a venue manager', sub: 'Users, Venue managers, Assigned staff' },
  { slug: 'staffing-pipeline', kind: 'web', out: 'offers', title: 'Following a shift in Venue Offers', sub: 'The staffing board and the timesheet report' },
  { slug: 'staff-reviews', kind: 'web', out: 'managers', title: 'Reading staff reviews', sub: 'Ratings and feedback from venue managers' },
  { slug: 'sidebar-shortcuts', kind: 'web', out: 'getting-started', title: 'Adding sidebar shortcuts', sub: 'Operations, Add menu item' },
  { slug: 'dashboard-tour', kind: 'web', out: 'getting-started', title: 'The Dashboard', sub: 'What each card shows and how its figures load' },
  { slug: 'overview-tour', kind: 'web', out: 'getting-started', title: 'A tour of the Crewflow web console', sub: 'Dashboard, users, venues, shifts, offers, calendar and payroll' },
  { slug: 'invite-manager', kind: 'web', out: 'managers', title: 'Adding a manager', sub: 'Users → Managers → New manager' },
  { slug: 'create-workspace', kind: 'web', out: 'managers', title: 'Creating your workspace', sub: 'Workspace, profile, preparation and welcome' },
  { slug: 'add-staff', kind: 'web', out: 'managers', title: 'Adding a staff member', sub: 'The four-step staff form and invitation' },
  { slug: 'create-venue', kind: 'web', out: 'managers', title: 'Creating a venue', sub: 'Address, geofence, breaks and pay rates' },
  { slug: 'create-shift-send-offers', kind: 'web', out: 'offers', title: 'Creating a shift and sending offers', sub: 'One step from new shift to offers sent' },
  { slug: 'confirm-offers', kind: 'web', out: 'offers', title: 'Confirming accepted offers', sub: 'One at a time, or a whole batch' },
  { slug: 'venue-request-approval', kind: 'web', out: 'offers', title: 'Approving a venue request', sub: 'Review, adjust staff and approve' },
  { slug: 'timesheets-review', kind: 'web', out: 'managers', title: 'Reviewing a shift’s timesheets', sub: 'Live staffing board and timesheet report' },
  { slug: 'payroll-review', kind: 'web', out: 'managers', title: 'Reviewing payroll', sub: 'Completed attendance, filters and totals' },
  { slug: 'staff-accept-offer', kind: 'mobile', out: 'mobile', title: 'Accepting an offer', sub: 'Staff app' },
  { slug: 'staff-app-tour', kind: 'mobile', out: 'mobile', title: 'A tour of the staff app', sub: 'Home, calendar, history and profile' },
  { slug: 'venue-send-shift', kind: 'mobile', out: 'mobile', title: 'Sending a shift request', sub: 'Venue manager app' },
  { slug: 'clock-in-out', kind: 'mobile', out: 'attendance', title: 'Clocking in and out', sub: 'Staff app' },
];

const ff = (args) => execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
const probe = (file) => {
  let info = '';
  try { execFileSync(FFMPEG, ['-hide_banner', '-i', file], { stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { info = String(e.stderr); }
  const [w, h] = (info.match(/, (\d{3,4})x(\d{3,4})/) || [0, 0, 0]).slice(1).map(Number);
  const d = (info.match(/Duration: (\d+):(\d+):([\d.]+)/) || []).slice(1).map(Number);
  return { w, h, duration: d.length ? d[0] * 3600 + d[1] * 60 + d[2] : 0 };
};

const logo = 'data:image/png;base64,' + fs.readFileSync(path.join(root, 'images/brand/logo-light.png')).toString('base64');
const titleHtml = (t, W, H) => {
  const portrait = H > W;
  return `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>html,body{margin:0;width:${W}px;height:${H}px;background:#f7f4ef;font-family:Inter,system-ui,sans-serif;color:#1c1917}
.c{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;padding:0 ${portrait ? 56 : 120}px}
.logo{height:${portrait ? 44 : 52}px;align-self:flex-start;margin-bottom:${portrait ? 56 : 64}px}
.eyebrow{font-size:${portrait ? 22 : 24}px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:#79543a;margin-bottom:20px}
h1{margin:0;font-size:${portrait ? 54 : 72}px;line-height:1.08;letter-spacing:-.025em;font-weight:700;max-width:${portrait ? 600 : 1200}px}
p{margin:28px 0 0;font-size:${portrait ? 26 : 30}px;color:#57534e;max-width:${portrait ? 600 : 1100}px;line-height:1.35}
.rule{position:absolute;left:${portrait ? 56 : 120}px;right:${portrait ? 56 : 120}px;bottom:${portrait ? 96 : 72}px;height:2px;background:#e8e2da}
.foot{position:absolute;left:${portrait ? 56 : 120}px;bottom:${portrait ? 52 : 34}px;font-size:${portrait ? 18 : 20}px;color:#78716c}</style></head>
<body><div class="c"><img class="logo" src="${logo}"><div class="eyebrow">Crewflow tutorial</div><h1>${t.title}</h1><p>${t.sub}</p></div>
<div class="rule"></div><div class="foot">Real Crewflow interface · fictional demo data</div></body></html>`;
};
const captionHtml = (text, W, H) => {
  const portrait = H > W;
  const fs_ = portrait ? Math.round(W / 26) : Math.round(W / 52);
  return `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@500;600&display=swap" rel="stylesheet">
<style>html,body{margin:0;width:${W}px;height:${H}px;background:transparent;font-family:Inter,system-ui,sans-serif}
.b{position:absolute;left:0;right:0;bottom:${portrait ? 58 : Math.round(H * 0.06)}px;display:flex;justify-content:center}
.p{max-width:${portrait ? 86 : 72}%;background:rgba(28,25,23,.86);color:#fff;font-size:${fs_}px;font-weight:500;line-height:1.35;
padding:${Math.round(fs_ * 0.55)}px ${Math.round(fs_ * 0.95)}px;border-radius:${Math.round(fs_ * 0.7)}px;text-align:center;
box-shadow:0 10px 30px -12px rgba(0,0,0,.5)}</style></head><body><div class="b"><div class="p">${text}</div></div></body></html>`;
};

async function renderPng(browser, html, W, H, file, transparent) {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: file, omitBackground: transparent });
  await page.close();
}

function webMain(t, dir) {
  const frames = JSON.parse(fs.readFileSync(path.join(dir, 'frames.json'), 'utf8'));
  const list = [];
  for (let i = 0; i < frames.length; i++) {
    const next = i + 1 < frames.length ? frames[i + 1].t : frames[i].t + 1.5;
    // Exact source timing. Screencast frames can arrive faster than 30 fps; never pad them, or the
    // timeline stretches and the captions (timed on the same clock) drift. fps=30 below resamples.
    const dur = Math.max(0.001, next - frames[i].t);
    list.push(`file '${path.join(dir, 'frames', path.basename(frames[i].file)).replace(/\\/g, '/')}'`, `duration ${dur.toFixed(4)}`);
  }
  list.push(`file '${path.join(dir, 'frames', path.basename(frames[frames.length - 1].file)).replace(/\\/g, '/')}'`);
  const concat = path.join(work, `${t.slug}.txt`);
  fs.writeFileSync(concat, list.join('\n'));
  const out = path.join(work, `${t.slug}-main.mp4`);
  ff(['-f', 'concat', '-safe', '0', '-i', concat, '-vf', 'scale=1600:900:force_original_aspect_ratio=decrease,pad=1600:900:(ow-iw)/2:(oh-ih)/2:color=0xf7f4ef,fps=30,format=yuv420p',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', out]);
  return { file: out, captions: JSON.parse(fs.readFileSync(path.join(dir, 'captions.json'), 'utf8')) };
}

function mobileMain(t) {
  const raw = path.join(root, 'videos', 'raw-mobile', `${t.slug}.mp4`);
  const out = path.join(work, `${t.slug}-main.mp4`);
  // Normalise to 720×1560 CFR 30 and add a 200 px caption band below the phone screen, so captions never cover app controls.
  ff(['-i', raw, '-vf', 'scale=720:1560:force_original_aspect_ratio=decrease,pad=720:1760:(ow-iw)/2:0:color=0xf7f4ef,fps=30,format=yuv420p',
    '-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', out]);
  return { file: out, captions: JSON.parse(fs.readFileSync(path.join(root, 'videos', 'raw-mobile', `${t.slug}.captions.json`), 'utf8')) };
}

const vttTime = (sec) => { const ms = Math.round(sec * 1000); const h = Math.floor(ms / 3600000); const m = Math.floor(ms / 60000) % 60; const s = Math.floor(ms / 1000) % 60; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`; };
// Splits a spoken line into caption-sized chunks (≤ ~84 characters, two lines) timed by their share of the line.
function captionChunks(cue, offset) {
  const words = cue.text.split(/\s+/);
  const chunks = [];
  let cur = '';
  for (const w of words) { if ((cur + ' ' + w).trim().length > 84 && cur) { chunks.push(cur); cur = w; } else cur = (cur + ' ' + w).trim(); }
  if (cur) chunks.push(cur);
  const total = chunks.reduce((a, c) => a + c.length, 0);
  let at = offset + cue.start;
  return chunks.map((text) => { const d = cue.seconds * (text.length / total); const c = { start: at, end: at + d, text }; at += d; return c; });
}

async function composeNarrated(browser, t, main, W, H, duration, cues, webDir) {
  const TITLE = 2.4;
  // Refuse a stale recording: every cue must match the CURRENT synthesised narration (text and audio length).
  const segFile = path.join(__dirname, 'narration', 'build', t.slug, 'segments.json');
  const current = Object.fromEntries(JSON.parse(fs.readFileSync(segFile, 'utf8')).map((x) => [x.id, x]));
  for (const c of cues) {
    const seg = current[c.id];
    if (!seg || seg.text !== c.text || Math.abs(seg.seconds - c.seconds) > 0.01) throw new Error(`${t.slug}: recording is stale for narration line "${c.id}" — re-record it`);
  }
  const titlePng = path.join(work, `${t.slug}-title.png`);
  await renderPng(browser, titleHtml(t, W, H), W, H, titlePng, false);
  const titleMp4 = path.join(work, `${t.slug}-title.mp4`);
  ff(['-loop', '1', '-t', String(TITLE), '-i', titlePng, '-vf', `fps=30,format=yuv420p,fade=t=out:st=${TITLE - 0.35}:d=0.35`, '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', titleMp4]);
  const silent = path.join(work, `${t.slug}-silent.mp4`);
  ff(['-i', titleMp4, '-i', main.file, '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0,format=yuv420p[v]', '-map', '[v]',
    '-c:v', 'libx264', '-profile:v', 'high', '-preset', 'slow', '-crf', '25', silent]);
  const total = TITLE + duration;
  const last = cues[cues.length - 1];
  if (TITLE + last.start + last.seconds > total + 0.05) throw new Error(`${t.slug}: narration runs past the end of the recording`);

  // Voice track: every segment delayed to its spoken moment, mixed without level changes, loudness-normalised once.
  const inputs = ['-i', silent];
  const parts = [];
  cues.forEach((c, i) => {
    inputs.push('-i', c.file);
    const ms = Math.round((TITLE + c.start) * 1000);
    parts.push(`[${i + 1}:a]aresample=48000,adelay=${ms}:all=1[a${i}]`);
  });
  const mix = `${parts.join(';')};${cues.map((_, i) => `[a${i}]`).join('')}amix=inputs=${cues.length}:normalize=0:dropout_transition=0,apad,loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[aout]`;
  const outDir = path.join(root, 'videos', t.out);
  fs.mkdirSync(outDir, { recursive: true });
  const final = path.join(outDir, `${t.slug}.mp4`);
  ff([...inputs, '-filter_complex', mix, '-map', '0:v', '-map', '[aout]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-shortest', '-movflags', '+faststart', final]);

  // Poster: a real frame from the finished recording (the populated dashboard), not the title card.
  const posterDir = path.join(root, 'videos', 'posters');
  fs.mkdirSync(posterDir, { recursive: true });
  const posterAt = TITLE + (cues.find((c) => c.id === (t.posterCue || 'strip')) || cues[Math.min(3, cues.length - 1)]).start;
  ff(['-ss', posterAt.toFixed(2), '-i', final, '-frames:v', '1', '-c:v', 'libwebp', '-quality', '82', path.join(posterDir, `${t.slug}.webp`)]);

  // Captions (WebVTT, same clock as the final video) and transcript.
  const capDir = path.join(root, 'videos', 'captions');
  fs.mkdirSync(capDir, { recursive: true });
  const chunks = cues.flatMap((c) => captionChunks(c, TITLE));
  const NL = '\n';
  fs.writeFileSync(path.join(capDir, `${t.slug}.en.vtt`), ['WEBVTT', '', ...chunks.map((c, i) => [String(i + 1), `${vttTime(c.start)} --> ${vttTime(c.end)}`, c.text, ''].join(NL))].join(NL));
  const buildDir = path.join(__dirname, 'narration', 'build', t.slug);
  fs.mkdirSync(buildDir, { recursive: true });
  fs.writeFileSync(path.join(buildDir, 'transcript.md'), `# ${t.title}${NL}${NL}${cues.map((c) => c.text).join(NL + NL)}${NL}`);
  const p = probe(final);
  const meta = {
    slug: t.slug, title: t.title, video: path.relative(root, final).split(path.sep).join('/'), poster: `videos/posters/${t.slug}.webp`, captions: `videos/captions/${t.slug}.en.vtt`,
    seconds: +p.duration.toFixed(2), size: `${p.w}x${p.h}`, mb: +(fs.statSync(final).size / 1048576).toFixed(2), titleCardSeconds: TITLE,
    cues: cues.map((c) => ({ id: c.id, start: +(TITLE + c.start).toFixed(3), seconds: c.seconds })), recording: path.relative(root, webDir).split(path.sep).join('/'),
    builtAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(buildDir, 'build.json'), JSON.stringify(meta, null, 2));
  return { slug: t.slug, file: meta.video, size: meta.size, seconds: meta.seconds, mb: meta.mb, narrated: true, captions: chunks.length };
}

(async () => {
  const only = new Set(process.argv.slice(2));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const report = [];
  for (const t of TUTORIALS) {
    if (only.size && !only.has(t.slug)) continue;
    const webDir = path.join(REC_DIR, t.slug);
    const available = t.kind === 'web'
      ? fs.existsSync(path.join(webDir, 'frames.json'))
      : fs.existsSync(path.join(root, 'videos', 'raw-mobile', `${t.slug}.mp4`));
    if (!available) { report.push({ slug: t.slug, status: 'no capture' }); continue; }

    const main = t.kind === 'web' ? webMain(t, webDir) : mobileMain(t);
    const { w: W, h: H, duration } = probe(main.file);
    const TITLE = 2.4;

    // Title card
    const titlePng = path.join(work, `${t.slug}-title.png`);
    await renderPng(browser, titleHtml(t, W, H), W, H, titlePng, false);
    const titleMp4 = path.join(work, `${t.slug}-title.mp4`);
    ff(['-loop', '1', '-t', String(TITLE), '-i', titlePng, '-vf', `fps=30,format=yuv420p,fade=t=out:st=${TITLE - 0.35}:d=0.35`, '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', titleMp4]);

    // Narrated tutorial (cues.json from record-tutorials.cjs + synthesised segments): a real voice track, captions as a
    // switchable WebVTT track (not burned in), a transcript and build metadata. The recording is never stretched — each
    // line is placed at the moment it was spoken during the capture.
    const cuesFile = t.kind === 'web' ? path.join(webDir, 'cues.json') : null;
    if (cuesFile && fs.existsSync(cuesFile)) {
      report.push(await composeNarrated(browser, t, main, W, H, duration, JSON.parse(fs.readFileSync(cuesFile, 'utf8')), webDir));
      continue;
    }

    // Captions → overlays on the main recording
    const caps = main.captions.filter((c) => c.text && c.end > c.start && c.start < duration);
    // Keep the caption script in the repo so narration can be reviewed and the video re-made.
    fs.mkdirSync(path.join(__dirname, 'captions'), { recursive: true });
    fs.writeFileSync(path.join(__dirname, 'captions', `${t.slug}.json`), JSON.stringify({ title: t.title, subtitle: t.sub, titleCardSeconds: 2.4, captions: caps }, null, 1));
    const inputs = ['-i', main.file];
    const filters = [];
    let last = '0:v';
    for (let i = 0; i < caps.length; i++) {
      const png = path.join(work, `${t.slug}-cap-${i}.png`);
      await renderPng(browser, captionHtml(caps[i].text.replace(/&/g, '&amp;').replace(/</g, '&lt;'), W, H), W, H, png, true);
      inputs.push('-i', png);
      const s = Math.max(0, caps[i].start).toFixed(2), e = Math.min(duration, caps[i].end).toFixed(2);
      filters.push(`[${last}][${i + 1}:v]overlay=0:0:enable='between(t,${s},${e})'[v${i}]`);
      last = `v${i}`;
    }
    const captioned = path.join(work, `${t.slug}-cap.mp4`);
    if (filters.length) ff([...inputs, '-filter_complex', filters.join(';'), '-map', `[${last}]`, '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', captioned]);
    else fs.copyFileSync(main.file, captioned);

    // Join title + captioned recording, encode for the web
    const outDir = path.join(root, 'videos', t.out);
    fs.mkdirSync(outDir, { recursive: true });
    const final = path.join(outDir, `${t.slug}.mp4`);
    ff(['-i', titleMp4, '-i', captioned, '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0,format=yuv420p[v]', '-map', '[v]',
      '-c:v', 'libx264', '-profile:v', 'high', '-preset', 'slow', '-crf', W > H ? '25' : '26', '-movflags', '+faststart', final]);

    // Poster: the title card
    const posterDir = path.join(root, 'videos', 'posters');
    fs.mkdirSync(posterDir, { recursive: true });
    ff(['-i', titlePng, '-c:v', 'libwebp', '-quality', '82', path.join(posterDir, `${t.slug}.webp`)]);

    const p = probe(final);
    report.push({ slug: t.slug, file: path.relative(root, final).replace(/\\/g, '/'), size: `${p.w}x${p.h}`, seconds: +p.duration.toFixed(1), mb: +(fs.statSync(final).size / 1048576).toFixed(2), captions: caps.length });
  }
  await browser.close();
  fs.rmSync(work, { recursive: true, force: true });
  console.log(JSON.stringify(report, null, 1));
})().catch((e) => { console.error(e); process.exitCode = 1; });
