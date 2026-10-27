#!/usr/bin/env node
// Builds the complete Crewflow introduction film as ONE HyperFrames composition (intro-film/film/), on ONE clock taken
// from the measured narration (timeline.cjs). Same components and palette as the approved proof (lib/components.cjs).
//
//   node tools/cinematic/intro-film/build-film.cjs --web <rec-intro dir> --mobile <rec-mobile dir>
//
// Real footage only: web console = record-cinematic.cjs captures (fixtures); phones = native Flutter debug app on the
// Pixel_5 emulator (tools/mobile/record-intro.cjs, mobile-fixture-server.cjs). Phone recordings are cut into pieces and
// placed on the film clock; nothing is time-stretched (a piece is trimmed or its last frame held).
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const K = require('./lib/components.cjs');
const { phoneClip, webClip } = require('./lib/clips.cjs');

const arg = (k) => { const i = process.argv.indexOf(k); return i > -1 ? path.resolve(process.argv[i + 1]) : null; };
const WEB = arg('--web'); const MOB = arg('--mobile');
if (!WEB || !MOB) { console.error('usage: build-film.cjs --web <dir> --mobile <dir>'); process.exit(2); }
const HERE = __dirname;
const PROJ = path.join(HERE, 'film'); const A = path.join(PROJ, 'assets');
const NARR = path.resolve(HERE, '..', '..', 'narration', 'build', 'crewflow-introduction');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const ff = (args) => execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'inherit'] });

// Project scaffold (shared fonts/GSAP/logo with the proof).
fs.mkdirSync(A, { recursive: true });
for (const d of ['vendor', 'fonts']) fs.cpSync(path.join(HERE, 'proof', 'assets', d), path.join(A, d), { recursive: true });
fs.copyFileSync(path.join(HERE, 'proof', 'assets', 'logo.png'), path.join(A, 'logo.png'));
fs.copyFileSync(path.join(HERE, 'proof', 'hyperframes.json'), path.join(PROJ, 'hyperframes.json'));
{ const p = JSON.parse(fs.readFileSync(path.join(HERE, 'proof', 'package.json'), 'utf8')); p.name = 'crewflow-introduction'; fs.writeFileSync(path.join(PROJ, 'package.json'), `${JSON.stringify(p, null, 2)}\n`); }
fs.writeFileSync(path.join(PROJ, '.gitignore'), 'renders/\n.hyperframes/\nassets/*.mp4\nassets/*.wav\nrenders.log\n');

const tl = require('./timeline.cjs')(path.join(NARR, 'segments.json'), path.join(HERE, 'script.json'));
const S = (id) => tl.seg[id];
const TOTAL = tl.total;
const chapterStart = Object.fromEntries(tl.chapters.map((c) => [c.title, c]));

// ── 1. Web footage (each capture placed on the film clock by a fixed offset, or by narration cues) ─────────────────
const FW = 3200, FH = 1800;
function webRange(name, offset, winFrom, winTo) {
  const dir = path.join(WEB, name);
  const frames = JSON.parse(fs.readFileSync(path.join(dir, 'frames.json'), 'utf8'));
  const ev = JSON.parse(fs.readFileSync(path.join(dir, 'events.json'), 'utf8'));
  const recFrom = Math.max(0, winFrom - offset); const recEnd = frames[frames.length - 1].t;
  const recTo = Math.min(recEnd, winTo - offset);
  const first = Math.round(recFrom * 30) + 1; const n = Math.max(1, Math.round((recTo - recFrom) * 30));
  const hold = Math.max(0, winTo - winFrom - n / 30);
  const out = path.join(A, `${name}.mp4`);
  ff(['-framerate', '30', '-start_number', String(first), '-i', path.join(dir, 'frames', '%06d.jpg'), '-frames:v', String(n),
    '-vf', `tpad=stop_mode=clone:stop_duration=${hold.toFixed(3)},format=yuv420p`, '-c:v', 'libx264', '-preset', 'slow', '-crf', '14', '-g', '30', '-movflags', '+faststart', out]);
  const marks = Object.fromEntries(ev.events.filter((e) => e.type === 'mark').map((e) => [e.id, e.bbox]));
  const cams = ev.events.filter((e) => e.type === 'camera').map((e) => ({ id: e.id, t: +(e.t + (e.offset || 0) + offset).toFixed(3), d: e.duration ?? 0.8, full: e.rect === 'full', marks: e.marks || [] }))
    .filter((c) => c.t >= winFrom - 0.01 && c.t <= winTo);
  return { name, file: `assets/${name}.mp4`, from: winFrom, to: winTo, marks, cams };
}
const camRect = (clip, c) => (c.full ? { x: 0, y: 0, w: FW, h: FH } : K.focusRect(c.marks.map((m) => clip.marks[m])));

const W = {};
W.console = webRange('intro-web-console', 21.0, 21.9, chapterStart['Who uses it'].end - 0.05);
W.team = webRange('intro-web-team', S('c3-records').start, 42.3, chapterStart['Build the team'].end - 0.05);
W.approve = webRange('intro-web-approve', 92.0, 92.9, chapterStart['Request and approve'].end + 0.3);
W.confirm = webRange('intro-web-confirm', S('c5-branch').start, S('c5-branch').start, S('c5-board').start);
W.board = webRange('intro-web-board', S('c5-board').start, S('c5-board').start - 0.2, chapterStart['Offers and confirmation'].end + 0.3);
{
  const after = webClip(path.join(WEB, 'intro-web-after'), tl, { segs: ['c8-web', 'c9-payroll', 'c9-reviews', 'c9-dash'], filmStart: S('c8-web').start - 0.4, filmEnd: chapterStart['Manage the operation'].end + 0.3 }, path.join(A, 'intro-web-after.mp4'));
  const ev = JSON.parse(fs.readFileSync(path.join(WEB, 'intro-web-after', 'events.json'), 'utf8'));
  W.after = { name: 'intro-web-after', file: 'assets/intro-web-after.mp4', from: after.filmStart, to: after.filmEnd,
    marks: Object.fromEntries(ev.events.filter((e) => e.type === 'mark').map((e) => [e.id, e.bbox])),
    cams: after.camera.map((c) => ({ id: c.id, t: c.t, d: c.d, full: c.full, marks: c.marks })) };
}
// Main stage camera: each clip starts from its first framing (cut), then follows its own cues.
const mainClips = [W.console, W.team, W.approve, W.board, W.after];
// Payroll is never shown wide: frame Staff → Amount only, below the tabs and left of the Status column (both affected
// by the known payroll status defect, so they stay out of frame).
const PAYROLL_RECT = (() => { const m = W.after.marks; const x0 = m['pay-cols.0'].x * 2 - 40; const x1 = (m['pay-cols.1'].x + m['pay-cols.1'].w) * 2; const y0 = m['pay-cols.0'].y * 2 - 16; const w = x1 - x0; return { x: Math.round(x0), y: Math.round(y0), w: Math.round(w), h: Math.round(w * 9 / 16) }; })();
const camKeys = [];
for (const c of mainClips) {
  const firstRect = c.cams.length && c.cams[0].t <= c.from + 0.6 ? camRect(c, c.cams[0]) : { x: 0, y: 0, w: FW, h: FH };
  camKeys.push({ t: c.from, d: 0, r: firstRect });
  for (const k of c.cams) camKeys.push({ t: Math.max(k.t, c.from), d: k.d, r: (c.name === 'intro-web-after' && ['payroll', 'pay-cols'].includes(k.id)) ? PAYROLL_RECT : camRect(c, k) });
}
camKeys.sort((a, b) => a.t - b.t);
// Approve: widen as the board opens (as in the approved proof).
const approveEv = JSON.parse(fs.readFileSync(path.join(WEB, 'intro-web-approve', 'events.json'), 'utf8'));
const approveClick = +(approveEv.events.find((e) => e.type === 'click' && /Approve/.test(e.selector)).t + 92.0).toFixed(3);
const insetKeys = [{ t: W.confirm.from, d: 0, r: { x: 0, y: 0, w: FW, h: FH } }, ...W.confirm.cams.map((k) => ({ t: k.t, d: k.d, r: camRect(W.confirm, k) }))];

// ── 2. Phone footage pieces (recording seconds → film seconds) ─────────────────────────────────────────────────────
const seq = (video, list, name) => {
  let t = list.start; const pieces = list.pieces.map(([from, to, until]) => { const p = { from, to, filmFrom: +t.toFixed(3), filmTo: +(until ?? t + (to - from)).toFixed(3) }; t = p.filmTo; return p; }); // until = hold the piece's last frame up to that film time
  if (list.end != null) pieces[pieces.length - 1].filmTo = +list.end.toFixed(3);
  phoneClip(path.join(MOB, `${video}.webm`), pieces, path.join(A, `${name}.mp4`));
  return { file: `assets/${name}.mp4`, from: pieces[0].filmFrom, to: pieces[pieces.length - 1].filmTo, pieces };
};
const PH = {};
PH.vmIdle = seq('request', { start: S('c2-mobile').start - 0.4, pieces: [[0.3, 1.2]], end: chapterStart['Who uses it'].end - 0.05 }, 'ph-vm-idle');
PH.staffIdle = seq('offer', { start: S('c2-mobile').start - 0.4, pieces: [[2.6, 10.4]], end: chapterStart['Who uses it'].end - 0.05 }, 'ph-staff-idle');
PH.scope = seq('request', { start: S('c3-scope').start - 0.3, pieces: [[60.6, 66.9]], end: chapterStart['Build the team'].end - 0.05 }, 'ph-scope');
PH.request = seq('request', { start: S('c4-need').start, pieces: [[0.3, 5.7], [5.6, 7.2], [14.9, 15.7], [57.0, 58.3], [67.4, 71.5], [76.0, 77.2], [79.0, 80.3], [85.6, 89.34], [94.0, 96.6], [104.5, 107.2]], end: 93.95 }, 'ph-request');
PH.offer = seq('offer', { start: S('c5-accept').start - 3.34, pieces: [[2.6, 5.94], [11.2, 13.2], [18.6, 24.6]], end: S('c5-branch').start - 0.05 }, 'ph-offer');
PH.shift = seq('shiftday', { start: S('c6-ready').start, pieces: [[1.6, 5.2], [8.6, 12.17], [15.5, 16.9], [34.6, 40.3, S('c6-live').start], [56.6, 62.38]], end: S('c6-out').start }, 'ph-shift');
PH.out = seq('clockout', { start: S('c6-out').start, pieces: [[10.0, 11.5], [15.3, 16.6], [35.0, 35.9], [53.6, 54.9]], end: chapterStart['Shift day'].end - 0.05 }, 'ph-out');
PH.review = seq('review', { start: S('c7-report').start, pieces: [[2.0, 3.5], [5.6, 7.55], [7.55, 17.24], [25.7, 27.2], [44.0, 47.5], [53.2, 54.25], [54.25, 57.0], [62.5, 65.6], [139.1, 141.6], [77.0, 81.36]], end: S('c7-gate').start }, 'ph-review');
PH.fin = seq('finalise', { start: S('c7-gate').start, pieces: [[0.5, 5.6]], end: chapterStart['Review the hours'].end - 0.05 }, 'ph-gate');
PH.sign = seq('finalise', { start: S('c8-sign').start, pieces: [[5.6, 7.6], [11.2, 14.4], [16.4, 19.25], [20.6, 23.0], [27.2, 29.0], [37.2, 38.8], [47.5, 50.38]], end: S('c8-history').start }, 'ph-sign');
PH.hist = seq('history', { start: S('c8-history').start, pieces: [[3.6, 7.0]], end: S('c8-web').start + 0.6 }, 'ph-history');
// c6: the scanner piece is held until c6-live so the live screen lands on its line.
{ const p = PH.shift.pieces; }
const pfilm = (ph, recT) => { const p = ph.pieces.find((x) => recT >= x.from && recT <= x.to); return p ? +(p.filmFrom + (recT - p.from)).toFixed(3) : null; };
const reqTaps = JSON.parse(fs.readFileSync(path.join(MOB, 'request.marks.json'), 'utf8')).taps;
const offTaps = JSON.parse(fs.readFileSync(path.join(MOB, 'offer.marks.json'), 'utf8')).taps;
const finTaps = JSON.parse(fs.readFileSync(path.join(MOB, 'finalise.marks.json'), 'utf8')).taps;
const revTaps = JSON.parse(fs.readFileSync(path.join(MOB, 'review.marks.json'), 'utf8')).taps;
const tapList = [
  ...reqTaps.map((t) => ({ ph: PH.request, t })), ...offTaps.map((t) => ({ ph: PH.offer, t })),
  ...revTaps.map((t) => ({ ph: PH.review, t })), ...finTaps.map((t) => ({ ph: PH.sign, t })), ...finTaps.map((t) => ({ ph: PH.fin, t })),
].map(({ ph, t }) => ({ film: pfilm(ph, t.t), x: t.x, y: t.y, name: t.name })).filter((x) => x.film != null);
const acceptFilm = pfilm(PH.offer, offTaps.find((t) => t.name === '/^Accept$/').t);
const signFilm = pfilm(PH.sign, finTaps.find((t) => t.name === 'Sign & send').t);

// ── 3. Narration + sparse accents ──────────────────────────────────────────────────────────────────────────────────
const ACC = { clicks: [17.2, approveClick, acceptFilm, signFilm, 281.0], whooshes: [93.1, 106.9, 224.6] };
{
  const ids = tl.order; const raw = path.join(A, 'narration.raw.wav');
  // amix in two stages (ffmpeg has an input limit per filter graph that is comfortably above 40, but keep it explicit)
  const ins = []; const parts = [];
  ids.forEach((id, i) => { ins.push('-i', S(id).file); parts.push(`[${i}:a]aresample=48000,adelay=${Math.round(S(id).start * 1000)}:all=1[a${i}]`); });
  ff([...ins, '-filter_complex', `${parts.join(';')};${ids.map((_, i) => `[a${i}]`).join('')}amix=inputs=${ids.length}:normalize=0:dropout_transition=0,apad,atrim=0:${TOTAL}[m]`, '-map', '[m]', '-ar', '48000', '-ac', '1', raw]);
  const m = spawnSync(FFMPEG, ['-hide_banner', '-i', raw, '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
  const j = JSON.parse(m.slice(m.lastIndexOf('{'), m.lastIndexOf('}') + 1));
  const voice = path.join(A, 'voice.wav');
  ff(['-i', raw, '-af', `loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=${j.input_i}:measured_TP=${j.input_tp}:measured_LRA=${j.input_lra}:measured_thresh=${j.input_thresh}:offset=${j.target_offset}:linear=true,aresample=48000`, '-ac', '2', voice]);
  const click = path.join(A, 'click.wav'); const whoosh = path.join(A, 'whoosh.wav');
  ff(['-f', 'lavfi', '-i', 'sine=frequency=2200:duration=0.035', '-af', 'afade=t=out:st=0.004:d=0.031:curve=exp,volume=0.1', '-ar', '48000', '-ac', '2', click]);
  ff(['-f', 'lavfi', '-i', 'anoisesrc=color=pink:duration=0.7:amplitude=0.25:seed=7', '-af', 'bandpass=f=1400:width_type=o:w=1.6,afade=t=in:d=0.32,afade=t=out:st=0.34:d=0.36,volume=0.25', '-ar', '48000', '-ac', '2', whoosh]);
  const acc = [...ACC.clicks.map((t) => [click, t]), ...ACC.whooshes.map((t) => [whoosh, t])];
  const i2 = ['-i', voice]; const fx = ['[0:a]anull[v]'];
  acc.forEach(([f, t], i) => { i2.push('-i', f); fx.push(`[${i + 1}:a]adelay=${Math.round(t * 1000)}:all=1[s${i}]`); });
  ff([...i2, '-filter_complex', `${fx.join(';')};[v]${acc.map((_, i) => `[s${i}]`).join('')}amix=inputs=${acc.length + 1}:normalize=0:dropout_transition=0,atrim=0:${TOTAL}[o]`, '-map', '[o]', '-ar', '48000', '-ac', '2', path.join(A, 'narration.wav')]);
  [raw, voice, click, whoosh].forEach((f) => fs.unlinkSync(f));
}

// ── 4. Captions, transcript, chapters ──────────────────────────────────────────────────────────────────────────────
const caps = tl.order.flatMap((id) => K.captionChunks(S(id).text, S(id).start, S(id).seconds));
const vtt = (s) => { const ms = Math.round(s * 1000); return `00:${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`; };
fs.writeFileSync(path.join(PROJ, 'crewflow-introduction.en.vtt'), ['WEBVTT', '', ...caps.map((c, i) => `${i + 1}\n${vtt(c.start)} --> ${vtt(c.end)}\n${c.text}\n`)].join('\n'));
fs.writeFileSync(path.join(PROJ, 'transcript.md'), `# Crewflow: from staffing request to final timesheet\n\n${tl.chapters.map((c) => `## ${c.title}\n\n${tl.order.filter((id) => S(id).chapter === c.title).map((id) => S(id).text).join(' ')}\n`).join('\n')}`);
fs.writeFileSync(path.join(PROJ, 'chapters.json'), JSON.stringify(tl.chapters.map((c) => ({ index: c.index, title: c.title, start: +(c.card ? c.card.start : 0).toFixed(1), narrationStart: c.start })), null, 2));

// ── 5. Composition HTML ────────────────────────────────────────────────────────────────────────────────────────────
const G = K.G; const P = G.phone; const PS = P.screenW / 1080;
const SF = G.stageFull; const SPL = G.stageSplit;
const html = [];
const js = [];
const add = (s) => html.push(s);
const at = (s) => js.push(s);
const fx = (n) => Number(n).toFixed(3);
const vid = (id, clip, track) => `<video id="${id}" class="clip" data-start="${fx(clip.from)}" data-duration="${fx(clip.to - clip.from)}" data-track-index="${track}" muted playsinline src="${clip.file}"></video>`;

// Opening title surface
const nodeY = 360; const NX = [480, 960, 1440];
add(`<div id="open" class="layer surface-white">
  <svg id="open-svg" class="layer" viewBox="0 0 1920 1080" width="1920" height="1080">
    <line id="dash-a" x1="${NX[0] + 70}" y1="${nodeY + 48}" x2="${NX[1] - 70}" y2="${nodeY + 48}" stroke="#E5E7EB" stroke-width="3" stroke-dasharray="10 12"/>
    <line id="dash-b" x1="${NX[1] + 70}" y1="${nodeY + 48}" x2="${NX[2] - 70}" y2="${nodeY + 48}" stroke="#E5E7EB" stroke-width="3" stroke-dasharray="10 12"/>
    <path id="journey" d="M 210 ${nodeY + 48} C 330 ${nodeY - 60}, 400 ${nodeY + 150}, ${NX[0]} ${nodeY + 48} S ${NX[1] - 140} ${nodeY - 70}, ${NX[1]} ${nodeY + 48} S ${NX[2] - 140} ${nodeY + 160}, ${NX[2]} ${nodeY + 48} S 1650 ${nodeY - 10}, 1710 ${nodeY + 48}" fill="none" stroke="#FF7A1A" stroke-width="5" stroke-linecap="round"/>
    <circle id="dot" cx="210" cy="${nodeY + 48}" r="9" fill="#FF7A1A"/>
  </svg>
  ${K.roleNode('n-venue', NX[0], nodeY, 'venue', 'Venue', 'Needs a team')}
  ${K.roleNode('n-manager', NX[1], nodeY, 'manager', 'Manager', "Who's booked?")}
  ${K.roleNode('n-staff', NX[2], nodeY, 'staff', 'Staff', 'Where, and what next?')}
  <div id="strip" class="strip" style="left:0;right:0;top:660px;justify-content:center">
    ${['Request', 'Confirm', 'Work', 'Review'].map((s, i) => `<div id="st-${i}" class="step">${s}</div><div class="arrow"></div>`).join('')}<div id="st-4" class="step final">Final timesheet</div>
  </div>
  <div id="logo" class="logo-lock"><img src="assets/logo.png" alt="Crewflow"/><div class="tag">From staffing request to final timesheet</div></div>
</div>`);

// Main web stage (one window, one camera) + inset stage
add(`<div id="stage" class="stage" style="left:${SF.x}px;top:${SF.y}px;width:${SF.w}px;height:${SF.h}px;transform-origin:0 0;opacity:0">
  <div id="cam" class="cam">${mainClips.map((c, i) => vid(`v-web-${i}`, c, 0)).join('')}</div>
</div>`);
const INS = { x: 940, y: 520, w: 800, h: 450 };
add(`<div id="stage2" class="stage" style="left:${INS.x}px;top:${INS.y}px;width:${SF.w}px;height:${SF.h}px;transform-origin:0 0;transform:scale(${INS.w / SF.w});opacity:0">
  <div id="cam2" class="cam">${vid('v-inset', W.confirm, 3)}</div>
</div>`);

// Phones
const ringHtml = (ph, prefix) => tapList.filter((t) => t.film >= ph.from && t.film <= ph.to).map((t, i) => `<div id="${prefix}-r${i}" class="tap-ring" data-t="${t.film}" style="left:${(t.x * PS).toFixed(1)}px;top:${(t.y * PS).toFixed(1)}px;opacity:0"></div>`).join('');
const phonesA = [PH.scope, PH.request, PH.offer, PH.shift, PH.out, PH.review, PH.fin, PH.sign, PH.hist];
add(`<div id="phones" class="layer" style="top:${G.content.y0}px;height:${G.content.y1 - G.content.y0}px;overflow:hidden">
  ${K.phone('phoneA', 1340, 14, phonesA.map((c, i) => vid(`v-ph-${i}`, c, 1) + ringHtml(c, `pa${i}`)).join(''))}
  ${K.phone('phoneB', 1340, 14, vid('v-phb', PH.staffIdle, 2))}
  ${K.phone('phoneC', 820, 14, vid('v-phc', PH.vmIdle, 2))}
</div>`);

// Labels, kinetic phrases, cards and diagrams
const pill = (id, text, x, y) => `<div id="${id}" class="chapter-pill" style="left:${x}px;top:${y}px;opacity:0">${K.esc(text)}</div>`;
const kin = (id, text, x, y) => `<div id="${id}" class="kinetic" style="left:${x}px;top:${y}px;opacity:0">${K.esc(text)}</div>`;
add(pill('role-mgr', 'Manager · Web console', SF.x + 24, SF.y + SF.h - 64));
add(pill('role-vm', 'Venue manager · Crewflow app', 820, G.content.y1 - 46));
add(pill('role-staff', 'Staff · Crewflow app', 1340, G.content.y1 - 46));
add(pill('label-riley', 'Riley Chen · Venue manager, Riverside House', SF.x + 24, SF.y + 24));
add(pill('demo-scan', 'Demo · QR scan simulated (no camera in the emulator)', 1180, 70));
add(kin('k-workspace', 'Private workspace', SF.x + 40, SF.y + SF.h - 140));
add(kin('k-team', 'Assigned team', SF.x + 40, SF.y + SF.h - 140));
add(kin('k-only', 'Only their team', SPL.x, SPL.y + SPL.h + 30));
add(kin('k-approved', 'Approved', SF.x + 40, SF.y + SF.h - 140));
add(kin('k-confirmed', 'Confirmed', 300, 760));
add(kin('k-clock', "Timed by Crewflow's clock", 300, 760));
add(kin('k-hours', 'Recorded hours', 300, 760));
add(kin('k-signed', 'Signed off. Hours locked.', 300, 760));
add(kin('k-pay', 'Hours and pay · no money moved', SF.x + 40, SF.y + SF.h - 140));

// Request card beside the phone (ch4)
add(`<div id="card" class="shift-card" style="left:720px;top:170px;opacity:0">
  <div class="eyebrow">Staffing request · Tuesday</div>
  <div class="head">Riverside House</div>
  <div class="sub">Waiting staff · for Friday</div>
  <div class="rows">
    <div class="row" id="cr-0"><span>Date</span><b>Fri 23 Oct 2026</b></div>
    <div class="row" id="cr-1"><span>Time</span><b>12:00 – 18:00</b></div>
    <div class="row" id="cr-2"><span>Break</span><b>30 min</b></div>
    <div class="row" id="cr-3"><span>Staff</span><div class="avatars"><i>PS</i><i>GK</i><i>LF</i><i>IM</i></div></div>
  </div>
  <div class="state-slot">${K.chip('offered', 'Availability warning', 'chip-warn')}${K.chip('pending', 'Pending approval', 'chip-pending')}</div>
</div>
<div id="flow" style="position:absolute;left:720px;top:760px;white-space:nowrap;opacity:0">
  <div class="diagram-tag" style="position:relative">Diagram</div>
  <div class="flow" style="position:relative;margin-top:12px"><div class="n lit"><i></i>Venue manager</div><div class="l"></div><div class="n lit"><i></i>Manager</div><div class="l dash"></div><div class="n dim"><i></i>Staff · not yet</div></div>
</div>`);

// ch5 offers fan diagram + branch diagram
const people = [['Priya Shah', 'PS'], ['Grace Kim', 'GK'], ['Leah Fischer', 'LF'], ['Isla Moore', 'IM']];
add(`<div id="fan" class="layer surface-grid" style="opacity:0">
  <div class="diagram-tag" style="left:128px;top:112px">Diagram · one offer per person</div>
  <div id="fan-src" class="shift-card" style="left:700px;top:150px;width:520px"><div class="eyebrow">Approved request</div><div class="head">Riverside House</div><div class="sub">Waiting staff · Fri 23 Oct · 12:00–18:00</div></div>
  ${people.map(([n, i], k) => `<div id="fan-${k}" class="shift-card" style="left:${190 + k * 400}px;top:520px;width:340px;padding:20px 22px"><div class="eyebrow">Offer</div><div class="head" style="font-size:24px">${n}</div><div class="sub" style="font-size:18px">Riverside House · 12:00–18:00<br/>Estimated pay shown</div></div>`).join('')}
</div>
<div id="branch" class="layer surface-grid" style="opacity:0">
  <div class="diagram-tag" style="left:128px;top:112px">Diagram · two ways a shift is filled</div>
  <div style="position:absolute;left:128px;top:150px;font-size:24px;font-weight:700">Approved venue request</div>
  <div class="flow" style="left:128px;top:200px;font-size:22px"><div class="n lit"><i></i>Offer</div><div class="l"></div><div class="n lit"><i></i>Accept</div><div class="l"></div><div class="n">${K.chip('confirmed', 'Confirmed')}</div></div>
  <div style="position:absolute;left:128px;top:330px;font-size:24px;font-weight:700">Shift created by the manager</div>
  <div class="flow" style="left:128px;top:380px;font-size:22px"><div class="n lit"><i></i>Offer</div><div class="l"></div><div class="n lit"><i></i>Accept</div><div class="l"></div><div class="n">${K.chip('offered', 'Place held')}</div><div class="l dash"></div><div class="n lit"><i></i>Manager confirms</div><div class="l"></div><div class="n">${K.chip('confirmed', 'Confirmed')}</div></div>
</div>`);
add(`<div id="who" style="position:absolute;left:300px;top:420px;opacity:0"><div style="font-size:30px;font-weight:700">Priya Shah</div><div class="state-slot" style="width:260px">${K.chip('offered', 'Offered', 'chip-offered')}${K.chip('confirmed', 'Confirmed', 'chip-confirmed')}</div></div>`);

// ch6 QR diagram
add(`<div id="qrdiag" style="position:absolute;left:180px;top:260px;width:900px;opacity:0">
  <div class="diagram-tag" style="position:relative">Diagram</div>
  <div class="flow" style="position:relative;margin-top:16px;font-size:26px"><div class="n lit"><i></i>Shift QR code</div><div class="l"></div><div class="n lit"><i></i>Crewflow server checks it</div></div>
  <div class="flow" style="position:relative;margin-top:30px;font-size:22px"><div class="n dim"><i></i>On site</div><div class="l dash"></div><div class="n" style="color:#646873">only where the venue requires it</div></div>
</div>`);

// ch7 review tracker
const trackRows = [['Priya Shah', 'Clocked out'], ['Grace Kim', 'Clocked out'], ['Leah Fischer', 'Clocked out'], ['Isla Moore', 'Missing clock-out']];
add(`<div id="tracker" style="position:absolute;left:160px;top:150px;width:900px;opacity:0">
  <div class="diagram-tag" style="position:relative">Summary · Diagram</div>
  <div class="shift-card" style="position:relative;margin-top:14px;width:820px">
    <div class="head" style="font-size:26px">Riverside House · Fri 23 Oct</div>
    <div class="rows">${trackRows.map(([n, s], i) => `<div class="row" id="tr-${i}"><b>${n}</b><span class="state-slot" style="margin:0;height:38px;width:330px;text-align:right">${i === 3 ? `${K.chip('offered', '! Missing clock-out', 'tr3-missing')}${K.chip('pending', 'Corrected · awaiting review', 'tr3-corr')}` : K.chip('pending', s, `tr${i}-out`)}${K.chip('confirmed', 'Reviewed', `tr${i}-rev`)}</span></div>`).join('')}</div>
    <div style="margin-top:16px;display:flex;justify-content:space-between;align-items:center;font-size:20px"><span id="tr-count" style="color:#646873">Rating is a separate, optional step</span>${K.chip('pending', 'Finalise & send: locked', 'gate-locked')}${K.chip('confirmed', 'Finalise & send: ready', 'gate-open')}</div>
  </div>
</div>`);

// ch8 lifecycle strip
add(`<div id="life" style="position:absolute;left:160px;top:300px;opacity:0">
  <div class="diagram-tag" style="position:relative">What the app shows · Diagram</div>
  <div class="flow" style="position:relative;margin-top:18px;font-size:24px">
    <div class="n" id="lf-0">${K.chip('pending', 'Generating PDF')}</div><div class="l"></div>
    <div class="n" id="lf-1">${K.chip('pending', 'Queued for delivery')}</div><div class="l"></div>
    <div class="n" id="lf-2">${K.chip('confirmed', 'Sent')}</div>
  </div>
</div>
<div id="doc" class="shift-card" style="left:1360px;top:300px;width:300px;padding:18px 20px;opacity:0"><div class="eyebrow">PDF</div><div class="head" style="font-size:22px">Final timesheet</div><div class="sub" style="font-size:16px">Riverside House · Fri 23 Oct</div></div>`);

// ch10 system diagram
add(`<div id="sys" class="layer surface-grid" style="opacity:0">
  <div class="diagram-tag" style="left:128px;top:112px">Diagram · how it fits together</div>
  <div class="shift-card" style="left:160px;top:300px;width:360px"><div class="eyebrow">Web console</div><div class="head" style="font-size:26px">Managers</div></div>
  <div class="shift-card" style="left:160px;top:560px;width:360px"><div class="eyebrow">Crewflow app</div><div class="head" style="font-size:26px">Venue managers · Staff</div></div>
  <div id="svc" class="shift-card" style="left:760px;top:400px;width:420px;border:2px solid #FF7A1A"><div class="eyebrow">One Crewflow service</div><div class="head" style="font-size:26px">Every request is checked</div>
    <div style="margin-top:14px;display:flex;gap:10px">${K.chip('confirmed', 'Who you are', 'sv-a')}${K.chip('confirmed', 'Your workspace', 'sv-b')}</div></div>
  <div id="jobs" class="shift-card" style="left:1360px;top:400px;width:420px"><div class="eyebrow">Background jobs</div><div class="head" style="font-size:24px">Reminders · Expiries · Documents</div></div>
  <svg class="layer" viewBox="0 0 1920 1080" width="1920" height="1080">
    <path id="fl-1" d="M 520 360 C 640 360, 640 470, 760 470" fill="none" stroke="#FF7A1A" stroke-width="4"/>
    <path id="fl-2" d="M 520 620 C 640 620, 640 500, 760 500" fill="none" stroke="#FF7A1A" stroke-width="4"/>
    <path id="fl-3" d="M 1180 480 L 1360 480" fill="none" stroke="#FF7A1A" stroke-width="4" stroke-dasharray="10 10"/>
  </svg>
</div>`);

// ch11 recap + end card
const recapWords = ['Request', 'Approve', 'Work', 'Review', 'Sign off'];
add(`<div id="recap" class="layer surface-white" style="opacity:0">
  <div class="strip" style="left:0;right:0;top:470px;justify-content:center">${recapWords.map((w, i) => `<div id="rc-${i}" class="step" style="opacity:0">${w}</div>${i < 4 ? '<div class="arrow"></div>' : ''}`).join('')}</div>
</div>
<div id="endcard" class="layer surface-white" style="opacity:0">
  <div class="logo-lock" style="top:360px"><img src="assets/logo.png" alt="Crewflow"/><div class="tag">Open the guide for your role</div>
  <div style="margin-top:28px;display:flex;gap:14px;justify-content:center">${['Manager', 'Venue manager', 'Staff'].map((r) => `<span class="chip pending">${r}</span>`).join('')}</div></div>
</div>`);

// Chapter cards + pills
tl.chapters.forEach((c) => { if (c.card) { add(K.chapterCard(`card${c.index}`, c.index, c.title)); add(pill(`pill${c.index}`, c.title, 40, 40)); } });

// Captions + fade + audio
add(`<div id="captions">\n${caps.map((c, i) => `  <p id="cap-${i}" class="cap clip" data-start="${c.start}" data-duration="${(c.end - c.start).toFixed(3)}" data-track-index="5">${K.esc(c.text)}</p>`).join('\n')}\n</div>`);
add(`<div id="fade" class="layer" style="background:#fff;opacity:0"></div>`);
add(`<audio id="narration" class="clip" data-start="0" data-track-index="6" data-volume="1" src="assets/narration.wav"></audio>`);

// ── Timeline (all deterministic tweens on ONE paused timeline) ──
const show = (sel, t, d = 0.35) => at(`tl.to(${JSON.stringify(sel)}, { opacity: 1, duration: ${d} }, ${fx(t)});`);
const hide = (sel, t, d = 0.3) => at(`tl.to(${JSON.stringify(sel)}, { opacity: 0, duration: ${d} }, ${fx(t)});`);
const kinetic = (id, t, until) => { at(`tl.fromTo("#${id}", { opacity: 0, y: 10, "--u": 0 }, { opacity: 1, y: 0, "--u": 1, duration: 0.45, ease: "power2.out" }, ${fx(t)});`); hide(`#${id}`, until); };
const stageTo = (sel, rect, t, d = 0.8) => at(`tl.to("${sel}", { x: ${rect.x - SF.x}, y: ${rect.y - SF.y}, scale: ${(rect.w / SF.w).toFixed(4)}, transformOrigin: "0 0", duration: ${d}, ease: "power3.inOut" }, ${fx(t)});`);
const phoneAt = (sel, x, t, d = 0.6, from = null) => at(`tl.${from != null ? 'fromTo' : 'to'}("${sel}", ${from != null ? `{ x: ${from}, opacity: 0 }, ` : ''}{ x: ${x}, opacity: 1, duration: ${d}, ease: "power3.inOut" }, ${fx(t)});`);
const phoneZoom = (sel, bx, by, scale, t, d = 0.9) => { at(`tl.set("${sel}", { transformOrigin: "${(P.bezel + bx * PS).toFixed(1)}px ${(P.bezel + by * PS).toFixed(1)}px" }, ${fx(t - 0.01)});`); at(`tl.to("${sel}", { scale: ${scale}, duration: ${d}, ease: "power3.inOut" }, ${fx(t)});`); };
const phoneUnzoom = (sel, t, d = 0.7) => at(`tl.to("${sel}", { scale: 1, duration: ${d}, ease: "power3.inOut" }, ${fx(t)});`);
const s = (id) => S(id).start; const e = (id) => S(id).end;

// Opening
at(`tl.to("#dot", { opacity: 1, duration: 0.3 }, 0.2);`);
at(`tl.fromTo("#n-venue", { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.5, ease: "power2.out" }, ${fx(s('c1-need') + 0.2)});`);
at(`tl.fromTo("#n-manager", { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.5, ease: "power2.out" }, ${fx(s('c1-need') + 2.8)});`);
at(`tl.fromTo("#n-staff", { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.5, ease: "power2.out" }, ${fx(s('c1-need') + 5.4)});`);
at(`tl.to(J, { strokeDashoffset: 0, duration: 2.8, ease: "power1.inOut" }, ${fx(s('c1-connect') + 0.3)});`);
at(`tl.to("#dot", { attr: { cx: 1710 }, duration: 2.8, ease: "power1.inOut" }, ${fx(s('c1-connect') + 0.3)});`);
at(`tl.to(["#dash-a", "#dash-b"], { opacity: 0, duration: 0.6 }, ${fx(s('c1-connect') + 1.2)});`);
at(`tl.fromTo("#strip", { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: 0.5, ease: "power2.out" }, ${fx(s('c1-connect') + 1.8)});`);
at(`[0, 1, 2, 3].forEach((i) => tl.to("#st-" + i, { borderColor: "#FF7A1A", color: "#24252B", duration: 0.25 }, ${fx(s('c1-connect') + 2.2)} + i * 0.45));`);
at(`tl.to("#st-4", { backgroundColor: "#24252B", color: "#FFFFFF", duration: 0.3 }, ${fx(e('c1-connect') - 0.6)});`);
at(`tl.to(["#n-venue", "#n-manager", "#n-staff", "#strip", "#open-svg"], { opacity: 0, y: -10, duration: 0.45, ease: "power2.in" }, ${fx(e('c1-connect') + 0.2)});`);
at(`tl.to("#logo", { opacity: 1, duration: 0.01 }, ${fx(e('c1-connect') + 0.5)});`);
at(`tl.to("#logo", { clipPath: "inset(0 0% 0 0)", duration: 0.6, ease: "power2.out" }, ${fx(e('c1-connect') + 0.5)});`);

// Chapter cards (wipe in, hold, wipe out) + pills
tl.chapters.forEach((c) => {
  if (!c.card) return;
  at(`tl.to("#card${c.index}", { clipPath: "inset(0 0 0 0%)", duration: 0.45, ease: "power2.out" }, ${fx(c.card.start)});`);
  at(`tl.to("#card${c.index}", { clipPath: "inset(0 100% 0 0)", duration: 0.4, ease: "power2.in" }, ${fx(c.card.end - 0.3)});`);
  show(`#pill${c.index}`, c.start + 0.2); hide(`#pill${c.index}`, c.start + 3.2);
});
at(`tl.set("#open", { opacity: 0 }, ${fx(tl.chapters[1].card.start + 0.5)});`);

// Ch2 — web console, then the app (two phones)
const ch2 = chapterStart['Who uses it'];
at(`tl.set("#stage", { opacity: 1 }, ${fx(ch2.card.start + 0.5)});`);
show('#role-mgr', s('c2-web') + 0.3); hide('#role-mgr', s('c2-web') + 5);
kinetic('k-workspace', s('c2-web') + 3.4, e('c2-web'));
stageTo('#stage', SPL, s('c2-mobile') - 0.4);
phoneAt('#phoneC', 0, s('c2-mobile') - 0.3, 0.6, 120); phoneAt('#phoneB', 0, s('c2-mobile') + 0.1, 0.6, 120);
at(`tl.set("#phoneC", { left: 1168 }, 0);`); at(`tl.set("#phoneB", { left: 1548 }, 0);`);
at(`tl.set(["#phoneB", "#phoneC"], { scale: 0.82, transformOrigin: "0 0" }, 0);`);
at(`tl.set("#role-vm", { left: 1168, top: ${G.content.y1 - 160} }, 0);`);
at(`tl.set("#role-staff", { left: 1548, top: ${G.content.y1 - 160} }, 0);`);
show('#role-vm', s('c2-mobile') + 0.6); show('#role-staff', s('c2-mobile') + 3.2);
hide(['#phoneB', '#phoneC', '#role-vm', '#role-staff'], ch2.end - 0.6, 0.4);

// Ch3 — team (web full), then Riley's view (split + phone)
const ch3 = chapterStart['Build the team'];
stageTo('#stage', SF, ch3.card.start + 0.5, 0.01);
show('#label-riley', s('c3-riley')); hide('#label-riley', e('c3-riley') + 0.2);
kinetic('k-team', s('c3-assign') + 2.5, e('c3-assign') + 0.2);
stageTo('#stage', SPL, s('c3-scope') - 0.4);
at(`tl.to("#stage", { opacity: 0.6, duration: 0.5 }, ${fx(s('c3-scope'))});`);
at(`tl.set("#phoneA", { x: 0, opacity: 0, scale: 1 }, 0);`);
phoneAt('#phoneA', 0, s('c3-scope') - 0.3, 0.6, 120);
kinetic('k-only', s('c3-scope') + 1.0, ch3.end - 0.5);
at(`tl.set("#stage", { opacity: 0 }, ${fx(chapterStart['Request and approve'].card.start + 0.5)});`);

// Ch4 — request on the phone with the card; handoff; approve on the web
const ch4 = chapterStart['Request and approve'];
at(`tl.set("#phoneA", { left: 300 }, ${fx(ch4.card.start + 0.45)});`);
at(`tl.set("#card", { left: 820 }, 0);`); at(`tl.set("#flow", { left: 820 }, 0);`);
at(`tl.set("#role-vm", { left: 300, top: ${G.content.y1 - 46} }, ${fx(ch4.card.start + 0.45)});`);
show('#role-vm', s('c4-need') + 0.2); hide('#role-vm', s('c4-warn') + 0.4);
at(`tl.fromTo("#card", { opacity: 0, x: 24 }, { opacity: 1, x: 0, duration: 0.5, ease: "power2.out" }, ${fx(s('c4-need') + 1.0)});`);
[0, 1, 2, 3].forEach((i) => at(`tl.fromTo("#cr-${i}", { opacity: 0.25 }, { opacity: 1, duration: 0.3 }, ${fx(s('c4-form') + [0.6, 2.6, 4.1, 5.6][i])});`));
at(`gsap.set(["#cr-0", "#cr-1", "#cr-2", "#cr-3", "#chip-warn", "#chip-pending"], { opacity: 0.25 });`);
at(`gsap.set(["#chip-warn", "#chip-pending"], { opacity: 0 });`);
show('#chip-warn', s('c4-warn') + 1.4, 0.3); hide('#chip-warn', s('c4-send') + 1.2, 0.2);
show('#chip-pending', s('c4-send') + 1.4, 0.3);
show('#flow', s('c4-send') + 2.2, 0.4);
phoneZoom('#phoneA', 540, 1500, 1.35, s('c4-warn') + 0.8); phoneUnzoom('#phoneA', s('c4-send') - 0.2);
// handoff
at(`tl.to(["#phoneA", "#flow"], { opacity: 0, x: -60, duration: 0.45, ease: "power2.in" }, 93.0);`);
stageTo('#stage', SF, 92.8, 0.01);
at(`tl.fromTo("#stage", { opacity: 0, scale: 0.94, transformOrigin: "50% 50%" }, { opacity: 1, scale: 1, duration: 0.55, ease: "power2.out" }, 93.1);`);
at(`tl.to("#card", { x: -560, y: -120, scale: 0.55, transformOrigin: "0 0", duration: 0.85, ease: "power2.inOut" }, 93.1);`);
hide('#card', 93.95, 0.25);
show('#role-mgr', 93.8); hide('#role-mgr', 97.0);
kinetic('k-approved', approveClick + 0.1, ch4.end - 0.4);

// Ch5 — offers fan → Priya accepts → two branches → staffing board
const ch5 = chapterStart['Offers and confirmation'];
at(`tl.set("#stage", { opacity: 0 }, ${fx(ch5.card.start + 0.45)});`);
show('#fan', ch5.card.start + 0.45, 0.01);
people.forEach((_, k) => at(`tl.fromTo("#fan-${k}", { opacity: 0, x: ${(1 - k) * 120 + 60}, y: -300, scale: 0.8 }, { opacity: 1, x: 0, y: 0, scale: 1, duration: 0.7, ease: "power3.out" }, ${fx(s('c5-offers') + 0.6 + k * 0.15)});`));
at(`tl.to("#fan-0", { x: 1150, y: -360, scale: 0.6, transformOrigin: "0 0", duration: 0.8, ease: "power2.inOut" }, ${fx(PH.offer.from - 0.3)});`);
hide('#fan', PH.offer.from + 0.3, 0.3);
at(`tl.set("#phoneA", { left: 1340, x: 0, scale: 1 }, ${fx(PH.offer.from - 0.5)});`);
phoneAt('#phoneA', 0, PH.offer.from - 0.4, 0.6, 120);
at(`tl.set("#role-staff", { left: 1340, top: ${G.content.y1 - 46} }, ${fx(PH.offer.from - 0.5)});`);
show('#role-staff', PH.offer.from); hide('#role-staff', s('c5-branch') - 0.4);
at(`gsap.set("#chip-confirmed", { opacity: 0 });`);
show('#who', s('c5-accept'));
hide('#chip-offered', acceptFilm + 0.5, 0.2);
at(`tl.fromTo("#chip-confirmed", { opacity: 0, scale: 0.85 }, { opacity: 1, scale: 1, duration: 0.3, ease: "back.out(1.4)" }, ${fx(acceptFilm + 0.5)});`);
kinetic('k-confirmed', acceptFilm + 1.0, s('c5-branch') - 0.4);
phoneZoom('#phoneA', 540, 875, 1.45, acceptFilm + 0.9);
hide(['#who', '#phoneA'], s('c5-branch') - 0.4, 0.35);
show('#branch', s('c5-branch') - 0.1, 0.4);
show('#stage2', s('c5-branch') + 2.5, 0.4); hide('#stage2', s('c5-board') - 0.4, 0.3);
hide('#branch', s('c5-board') - 0.3, 0.3);
stageTo('#stage', SF, s('c5-board') - 0.6, 0.01);
show('#stage', s('c5-board') - 0.3, 0.35);
at(`tl.set("#stage", { opacity: 0 }, ${fx(chapterStart['Shift day'].card.start + 0.45)});`);

// Ch6 — shift day on Priya's phone
const ch6 = chapterStart['Shift day'];
at(`tl.set("#phoneA", { left: 1180, x: 0, scale: 1, opacity: 1 }, ${fx(ch6.card.start + 0.45)});`);
at(`tl.set("#role-staff", { left: 1180 }, ${fx(ch6.card.start + 0.45)});`);
show('#role-staff', s('c6-ready')); hide('#role-staff', s('c6-scan'));
at(`tl.set("#k-clock", { left: 300, top: 760 }, 0);`);
show('#qrdiag', s('c6-scan') + 0.3, 0.4); hide('#qrdiag', s('c6-live') - 0.3);
show('#demo-scan', s('c6-scan') + 2.0); hide('#demo-scan', s('c6-live') - 0.3);
kinetic('k-clock', s('c6-live') + 1.6, s('c6-out') - 0.3);
phoneZoom('#phoneA', 300, 700, 1.4, s('c6-live') + 0.4); phoneUnzoom('#phoneA', s('c6-out') - 0.4);
kinetic('k-hours', e('c6-out') - 1.0, ch6.end - 0.4);
show('#demo-scan', s('c6-out') + 2.4, 0.2); hide('#demo-scan', s('c6-out') + 3.3, 0.2);

// Ch7 — review the hours: phone + tracker
const ch7 = chapterStart['Review the hours'];
at(`tl.set("#phoneA", { left: 1240, scale: 1 }, ${fx(ch7.card.start + 0.45)});`);
show('#tracker', s('c7-report') + 0.6, 0.4);
at(`gsap.set(["#tr0-rev","#tr1-rev","#tr2-rev","#tr3-rev","#tr3-corr","#gate-open"], { opacity: 0 });`);
at(`gsap.set(["#tr-0","#tr-1","#tr-2","#tr-3"], { opacity: 0 });`);
[0, 1, 2, 3].forEach((i) => show(`#tr-${i}`, s('c7-missing') + 0.4 + i * 0.5, 0.3));
hide('#tr3-missing', s('c7-correct') + 4.0, 0.2); show('#tr3-corr', s('c7-correct') + 4.0, 0.2);
const revT = [s('c7-review') + 4.3, s('c7-review') + 7.2, s('c7-review') + 7.5, s('c7-review') + 7.8];
[3, 0, 1, 2].forEach((row, k) => { hide(row === 3 ? '#tr3-corr' : `#tr${row}-out`, revT[k], 0.2); show(`#tr${row}-rev`, revT[k], 0.25); });
hide('#gate-locked', s('c7-gate') + 1.0, 0.2); show('#gate-open', s('c7-gate') + 1.0, 0.25);
phoneZoom('#phoneA', 540, 1300, 1.35, s('c7-missing') + 4.5); phoneUnzoom('#phoneA', s('c7-correct') - 0.2);
phoneZoom('#phoneA', 780, 2170, 1.4, s('c7-gate') + 0.6); phoneUnzoom('#phoneA', ch7.end - 0.6);
hide('#tracker', ch7.end - 0.5, 0.4);

// Ch8 — sign-off, delivery states, history, then the web
const ch8 = chapterStart['Final timesheet'];
at(`tl.set("#phoneA", { left: 1240, scale: 1 }, ${fx(ch8.card.start + 0.45)});`);
kinetic('k-signed', signFilm + 0.3, e('c8-sign') + 0.8);
show('#life', s('c8-pdf') + 0.1, 0.4);
at(`gsap.set(["#lf-0","#lf-1","#lf-2"], { opacity: 0.25 });`);
const sp = PH.sign.pieces; // [sheet, tick+name, send, generating, queued, sent, pdf]
at(`tl.to("#lf-0", { opacity: 1, duration: 0.25 }, ${fx(sp[3].filmFrom)});`);
at(`tl.to("#lf-1", { opacity: 1, duration: 0.25 }, ${fx(sp[4].filmFrom)});`);
at(`tl.to("#lf-2", { opacity: 1, duration: 0.25 }, ${fx(sp[5].filmFrom)});`);
phoneZoom('#phoneA', 540, 1500, 1.35, sp[0].filmFrom + 0.4); phoneUnzoom('#phoneA', sp[3].filmFrom - 0.2);
hide('#life', s('c8-history') - 0.2);
// handoff to the web: the PDF travels into the signed timesheet
show('#doc', s('c8-web') - 0.6, 0.25);
at(`tl.to("#doc", { x: -900, y: 120, scale: 0.7, transformOrigin: "0 0", duration: 0.8, ease: "power2.inOut" }, ${fx(s('c8-web') - 0.35)});`);
hide('#doc', s('c8-web') + 0.5, 0.25);
hide('#phoneA', s('c8-web') - 0.3, 0.35);
stageTo('#stage', SF, s('c8-web') - 0.8, 0.01);
at(`tl.fromTo("#stage", { opacity: 0 }, { opacity: 1, duration: 0.5 }, ${fx(s('c8-web') - 0.4)});`);

// Ch9 — payroll, reviews, calendar + dashboard (web full)
kinetic('k-pay', s('c9-payroll') + 3.0, e('c9-payroll') + 0.2);
at(`tl.set("#stage", { opacity: 0 }, ${fx(chapterStart['Behind the scenes'].card.start + 0.45)});`);

// Ch10 — system diagram
const ch10 = chapterStart['Behind the scenes'];
show('#sys', ch10.card.start + 0.45, 0.01);
at(`gsap.set(["#sv-a", "#sv-b", "#jobs"], { opacity: 0 });`);
['#fl-1', '#fl-2'].forEach((p, i) => at(`{ const el = document.querySelector("${p}"); const L = el.getTotalLength(); gsap.set(el, { strokeDasharray: L, strokeDashoffset: L }); tl.to(el, { strokeDashoffset: 0, duration: 0.9, ease: "power2.inOut" }, ${fx(s('c10-system') + 0.8 + i * 0.5)}); }`));
show('#sv-a', s('c10-system') + 5.2, 0.3); show('#sv-b', s('c10-system') + 6.6, 0.3);
show('#jobs', s('c10-jobs') + 0.3, 0.4);
hide('#sys', chapterStart['Get started'].card.start + 0.45, 0.01);

// Ch11 — recap + end card
const ch11 = chapterStart['Get started'];
show('#recap', ch11.card.start + 0.45, 0.01);
recapWords.forEach((_, i) => at(`tl.fromTo("#rc-${i}", { opacity: 0, y: 12 }, { opacity: 1, y: 0, borderColor: "#FF7A1A", color: "#24252B", duration: 0.3 }, ${fx(s('c11-recap') + i * 0.58)});`));
hide('#recap', e('c11-recap') + 0.4, 0.4);
show('#endcard', e('c11-recap') + 0.6, 0.5);
at(`tl.to("#fade", { opacity: 1, duration: 0.8 }, ${fx(TOTAL - 0.8)});`);

// Tap rings
for (const t of tapList) { /* rings are positioned per phone clip; animate each */ }
const ringIds = [];
phonesA.forEach((c, i) => tapList.filter((t) => t.film >= c.from && t.film <= c.to).forEach((t, k) => ringIds.push([`pa${i}-r${k}`, t.film])));
ringIds.forEach(([id, t]) => at(`tl.fromTo("#${id}", { scale: 0.55, opacity: 0.95 }, { scale: 1.15, opacity: 0, duration: 0.32, ease: "power2.out", immediateRender: false }, ${fx(t)});`));

const doc = `<!doctype html>
<html lang="en" data-composition-variables='[{"id":"showCaptions","type":"boolean","label":"Burn in captions","default":false}]'>
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=1920, height=1080" />
<title>Crewflow — from staffing request to final timesheet</title>
<script src="assets/vendor/gsap.min.js"></script>
<style>${K.css}</style>
</head>
<body>
<div id="root" data-composition-id="crewflow-introduction" data-start="0" data-width="1920" data-height="1080" data-duration="${TOTAL}">
${html.join('\n')}
</div>
<script>
  ${K.cameraRuntime}
  const KEYS = ${JSON.stringify(camKeys)};
  const KEYS2 = ${JSON.stringify(insetKeys)};
  const SW = ${SF.w};
  const cam = document.getElementById("cam"); const cam2 = document.getElementById("cam2");
  function applyCam(t) {
    const r = camAt(KEYS, t); const s = SW / r.w; gsap.set(cam, { x: -r.x * s, y: -r.y * s, scale: s, transformOrigin: "0 0" });
    const r2 = camAt(KEYS2, t); const s2 = SW / r2.w; gsap.set(cam2, { x: -r2.x * s2, y: -r2.y * s2, scale: s2, transformOrigin: "0 0" });
  }
  const vars = (window.__hyperframes && window.__hyperframes.getVariables) ? window.__hyperframes.getVariables() : {};
  if (vars.showCaptions !== true) document.getElementById("captions").style.display = "none";
  const tl = gsap.timeline({ paused: true });
  const clock = { t: 0 };
  applyCam(0);
  tl.to(clock, { t: ${TOTAL}, duration: ${TOTAL}, ease: "none", onUpdate: () => applyCam(clock.t) }, 0);
  const J = document.getElementById("journey"); const L = J.getTotalLength();
  gsap.set(J, { strokeDasharray: L, strokeDashoffset: L });
  gsap.set(["#n-venue", "#n-manager", "#n-staff", "#strip", "#logo", "#dot", "#phoneA", "#phoneB", "#phoneC"], { opacity: 0 });
  gsap.set("#logo", { clipPath: "inset(0 100% 0 0)" });
  gsap.set(${JSON.stringify(tl.chapters.filter((c) => c.card).map((c) => `#card${c.index}`))}, { clipPath: "inset(0 0 0 100%)" });
${js.map((l) => `  ${l}`).join('\n')}
  window.__timelines["crewflow-introduction"] = tl;
</script>
</body>
</html>
`;
fs.writeFileSync(path.join(PROJ, 'index.html'), doc);
fs.writeFileSync(path.join(PROJ, 'manifest.json'), JSON.stringify({ total: TOTAL, chapters: tl.chapters, segments: tl.seg, web: Object.fromEntries(Object.entries(W).map(([k, v]) => [k, { file: v.file, from: v.from, to: v.to }])), phone: Object.fromEntries(Object.entries(PH).map(([k, v]) => [k, v])), camera: camKeys, accents: ACC, provenance: {
  web: 'tools/web/record-cinematic.cjs intro-web-* captures: real rab-front UI on an isolated Vite server; every API response from tools/web/fixtures.cjs (fictional; unknown requests fail; other origins blocked)',
  mobile: 'tools/mobile/record-intro.cjs: real Flutter debug app (rab-mobile @ f5187172) on the Pixel_5 emulator, API = tools/mobile-fixture-server.cjs (fictional demo backend with a scene clock). QR clock-in/out: the emulator camera cannot read a QR, so the clock-in/out were posted to the demo server from the host as a stand-in for the scan (disclosed on screen).',
  narration: 'Kokoro-82M bf_emma via hyperframes tts (local), tools/narration/build/crewflow-introduction',
} }, null, 2));
console.log(JSON.stringify({ total: TOTAL, captions: caps.length, camKeys: camKeys.length, approveClick, acceptFilm, signFilm }, null, 1));
