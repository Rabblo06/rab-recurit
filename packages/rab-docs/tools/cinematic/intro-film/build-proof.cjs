#!/usr/bin/env node
// Builds the ~30 s finished PROOF of the introduction film (HyperFrames project in intro-film/proof/), using the final
// components, palette, narration clips and real captures — so the proof and the full film cannot drift apart.
//
//   node tools/cinematic/intro-film/build-proof.cjs --web <rec-intro dir> --mobile <rec-mobile dir>
//
// Sampled scenes: branded opening (c1-connect) → chapter card → venue manager submits the request on the phone (c4-send)
// → phone→web handoff → manager approves in Venue Offers (c4-approve, real web footage, controlled close-ups) →
// Priya's offer travels to her phone → she accepts and is booked (c5-accept).
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const K = require('./lib/components.cjs');
const { phoneClip } = require('./lib/clips.cjs');

const arg = (k) => { const i = process.argv.indexOf(k); return i > -1 ? path.resolve(process.argv[i + 1]) : null; };
const WEB = arg('--web'); const MOB = arg('--mobile');
if (!WEB || !MOB) { console.error('usage: build-proof.cjs --web <dir> --mobile <dir>'); process.exit(2); }
const PROJ = path.join(__dirname, 'proof');
const A = path.join(PROJ, 'assets');
const NARR = path.resolve(__dirname, '..', '..', 'narration', 'build', 'crewflow-introduction');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const ff = (args) => execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'inherit'] });
const segs = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(NARR, 'segments.json'), 'utf8')).map((s) => [s.id, s]));

// ── Film clock (seconds) ──────────────────────────────────────────────────────────────────────────────────────────
const T = { c1: 0.9, card: 7.6, req: 8.6, c4send: 8.8, hand: 14.45, web: 14.5, c4appr: 14.8, split: 22.6, c5acc: 23.4, total: 31.6 };
const SPEECH = [['c1-connect', T.c1], ['c4-send', T.c4send], ['c4-approve', T.c4appr], ['c5-accept', T.c5acc]];
const WEB_REC = { from: 1.5, to: 9.6 };                 // recording seconds used from intro-web-approve
const webFilm = (rec) => +(T.web + (rec - WEB_REC.from)).toFixed(3);

// ── 1. Footage ─────────────────────────────────────────────────────────────────────────────────────────────────────
const webDir = path.join(WEB, 'intro-web-approve');
const ev = JSON.parse(fs.readFileSync(path.join(webDir, 'events.json'), 'utf8'));
{
  const first = Math.round(WEB_REC.from * 30) + 1; const n = Math.round((WEB_REC.to - WEB_REC.from) * 30);
  const hold = T.total - webFilm(WEB_REC.to);
  ff(['-framerate', '30', '-start_number', String(first), '-i', path.join(webDir, 'frames', '%06d.jpg'), '-frames:v', String(n),
    '-vf', `tpad=stop_mode=clone:stop_duration=${hold.toFixed(3)},format=yuv420p`, '-c:v', 'libx264', '-preset', 'slow', '-crf', '14', '-g', '30', '-movflags', '+faststart', path.join(A, 'web-approve.mp4')]);
}
phoneClip(path.join(MOB, 'request.webm'), [
  { from: 94.0, to: 97.0, filmFrom: T.req, filmTo: 11.6 },        // Submit anyway → "Shift submitted successfully … sent for manager approval"
  { from: 104.4, to: 107.4, filmFrom: 11.6, filmTo: T.hand + 0.15 }, // Sent Shifts: "Pending approval · Not sent yet"
], path.join(A, 'phone-request.mp4'));
phoneClip(path.join(MOB, 'offer.webm'), [
  { from: 2.6, to: 3.6, filmFrom: T.split, filmTo: 23.6 },         // Priya's offer in her list
  { from: 11.4, to: 12.6, filmFrom: 23.6, filmTo: 24.8 },           // offer details
  { from: 18.6, to: 24.4, filmFrom: 24.8, filmTo: T.total },        // Accept → Shift status: Confirmed
], path.join(A, 'phone-offer.mp4'));
const reqMarks = JSON.parse(fs.readFileSync(path.join(MOB, 'request.marks.json'), 'utf8'));
const offMarks = JSON.parse(fs.readFileSync(path.join(MOB, 'offer.marks.json'), 'utf8'));
const tapAt = (m, name) => m.taps.find((t) => t.name === name);
const submitTap = tapAt(reqMarks, 'Submit anyway'); const acceptTap = tapAt(offMarks, '/^Accept$/');
const reqTapFilm = +(T.req + (submitTap.t - 94.0)).toFixed(3);
const accTapFilm = +(24.8 + (acceptTap.t - 18.6)).toFixed(3);

// ── 2. Web camera from the recorder's own marks ────────────────────────────────────────────────────────────────────
const marks = Object.fromEntries(ev.events.filter((e) => e.type === 'mark').map((e) => [e.id, e.bbox]));
const cue = (id) => ev.events.find((e) => e.type === 'camera' && e.id === id).t;
const full = { x: 0, y: 0, w: 3200, h: 1800 };
const camKeys = [
  { t: T.web, d: 0, r: K.focusRect([marks['pending.0'], marks['pending.1']]) },
  { t: webFilm(cue('open')), d: 0.9, r: full },
  { t: webFilm(cue('selected')), d: 0.9, r: K.focusRect([marks['selected.0'], marks['selected.1']]) },
  { t: webFilm(cue('approve')), d: 0.8, r: K.focusRect([marks['approve.0'], marks['approve.1']]) },
  { t: +(webFilm(ev.events.find((e) => e.type === 'click' && /Approve/.test(e.selector)).t) + 0.35).toFixed(3), d: 0.9, r: full }, // widen as the board opens
];
const S = K.G.stageFull;
// Where the real "Pending approval" row sits on screen when the stage first appears → the ShiftCard lands there.
const r0 = camKeys[0].r; const s0 = S.w / r0.w; const row = marks['pending.0'];
const land = { x: S.x + (row.x * 2 - r0.x) * s0, y: S.y + (row.y * 2 - r0.y) * s0, w: 1500 * s0, h: row.h * 2 * s0 };
const approveClickFilm = webFilm(ev.events.find((e) => e.type === 'click' && /Approve/.test(e.selector)).t);

// ── 3. Narration + sparse accents (one track) ─────────────────────────────────────────────────────────────────────
{
  const inputs = []; const parts = [];
  SPEECH.forEach(([id, t], i) => { inputs.push('-i', path.join(NARR, segs[id].file)); parts.push(`[${i}:a]aresample=48000,adelay=${Math.round(t * 1000)}:all=1[a${i}]`); });
  const raw = path.join(A, 'narration.raw.wav');
  ff([...inputs, '-filter_complex', `${parts.join(';')};${SPEECH.map((_, i) => `[a${i}]`).join('')}amix=inputs=${SPEECH.length}:normalize=0:dropout_transition=0,apad,atrim=0:${T.total}[m]`, '-map', '[m]', '-ar', '48000', '-ac', '1', raw]);
  const m = spawnSync(FFMPEG, ['-hide_banner', '-i', raw, '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
  const j = JSON.parse(m.slice(m.lastIndexOf('{'), m.lastIndexOf('}') + 1));
  const voice = path.join(A, 'voice.wav');
  ff(['-i', raw, '-af', `loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=${j.input_i}:measured_TP=${j.input_tp}:measured_LRA=${j.input_lra}:measured_thresh=${j.input_thresh}:offset=${j.target_offset}:linear=true,aresample=48000`, '-ac', '2', voice]);
  const click = path.join(A, 'click.wav'); const whoosh = path.join(A, 'whoosh.wav');
  ff(['-f', 'lavfi', '-i', 'sine=frequency=2200:duration=0.035', '-af', 'afade=t=out:st=0.004:d=0.031:curve=exp,volume=0.1', '-ar', '48000', '-ac', '2', click]);
  ff(['-f', 'lavfi', '-i', 'anoisesrc=color=pink:duration=0.7:amplitude=0.25:seed=7', '-af', 'bandpass=f=1400:width_type=o:w=1.6,afade=t=in:d=0.32,afade=t=out:st=0.34:d=0.36,volume=0.25', '-ar', '48000', '-ac', '2', whoosh]);
  const accents = [[click, 6.5], [whoosh, T.hand], [click, approveClickFilm], [click, accTapFilm]];
  const ins = ['-i', voice]; const fx = ['[0:a]anull[v]'];
  accents.forEach(([f, t], i) => { ins.push('-i', f); fx.push(`[${i + 1}:a]adelay=${Math.round(t * 1000)}:all=1[s${i}]`); });
  ff([...ins, '-filter_complex', `${fx.join(';')};[v]${accents.map((_, i) => `[s${i}]`).join('')}amix=inputs=${accents.length + 1}:normalize=0:dropout_transition=0,atrim=0:${T.total}[o]`, '-map', '[o]', '-ar', '48000', '-ac', '2', path.join(A, 'narration.wav')]);
  [raw, voice, click, whoosh].forEach((f) => fs.unlinkSync(f));
}

// ── 4. Captions ────────────────────────────────────────────────────────────────────────────────────────────────────
const caps = SPEECH.flatMap(([id, t]) => K.captionChunks(segs[id].text, t, segs[id].seconds));
const vtt = (s) => { const ms = Math.round(s * 1000); return `00:${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`; };
fs.writeFileSync(path.join(PROJ, 'proof.en.vtt'), ['WEBVTT', '', ...caps.map((c, i) => `${i + 1}\n${vtt(c.start)} --> ${vtt(c.end)}\n${c.text}\n`)].join('\n'));

// ── 5. Composition ─────────────────────────────────────────────────────────────────────────────────────────────────
const P = K.G.phone; const PS = P.screenW / 1080;           // phone screen px per device px
const phoneReq = { x: 520, y: 38 }; const phoneOff = { x: 1340, y: 38 };
const ringAt = (id, dx, dy) => `<div id="${id}" class="tap-ring" style="left:${(dx * PS).toFixed(1)}px;top:${(dy * PS).toFixed(1)}px;opacity:0"></div>`;
const originFor = (bx, by) => `${(P.bezel + bx * PS).toFixed(1)}px ${(P.bezel + by * PS).toFixed(1)}px`;
const pend = reqMarks.marks.find((m) => m.id === 'pending').bbox; const conf = offMarks.marks.find((m) => m.id === 'confirmed').bbox;
const nodeY = 360; const NX = [480, 960, 1440];

const html = `<!doctype html>
<html lang="en" data-composition-variables='[{"id":"showCaptions","type":"boolean","label":"Burn in captions","default":true}]'>
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=1920, height=1080" />
<title>Crewflow introduction — proof</title>
<script src="assets/vendor/gsap.min.js"></script>
<style>${K.css}</style>
</head>
<body>
<div id="root" data-composition-id="crewflow-intro-proof" data-start="0" data-width="1920" data-height="1080" data-duration="${T.total}">
  <!-- Opening: title surface (no UI chrome) -->
  <div id="open" class="layer surface-white">
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
  </div>

  ${K.chapterCard('card4', 4, 'Request and approve')}
  <div id="pill4" class="chapter-pill" style="left:40px;top:40px">Request and approve</div>

  <!-- Venue manager's phone + the request (ShiftCard) -->
  <div id="req" class="layer">
    <div style="position:absolute;left:0;top:${K.G.content.y0}px;width:1920px;height:${K.G.content.y1 - K.G.content.y0}px;overflow:hidden">
      ${K.phone('phone-req', phoneReq.x, phoneReq.y - K.G.content.y0, `<video id="v-req" class="clip" data-start="${T.req}" data-duration="${(T.hand + 0.15 - T.req).toFixed(3)}" data-track-index="1" muted playsinline src="assets/phone-request.mp4"></video>${ringAt('ring-req', submitTap.x, submitTap.y)}`)}
    </div>
    <div id="role-vm" class="chapter-pill" style="left:${phoneReq.x}px;top:${K.G.content.y1 - 46}px;opacity:0">Venue manager · Crewflow app</div>
    <div id="card" class="shift-card" style="left:1080px;top:190px">
      <div class="eyebrow">Staffing request</div>
      <div class="head">Riverside House</div>
      <div class="sub">Waiting staff · for Friday</div>
      <div class="rows">
        <div class="row"><span>Date</span><b>Fri 23 Oct 2026</b></div>
        <div class="row"><span>Time</span><b>12:00 – 18:00</b></div>
        <div class="row"><span>Break</span><b>30 min</b></div>
        <div class="row"><span>Staff</span><div class="avatars"><i>PS</i><i>GK</i><i>LF</i><i>IM</i></div></div>
      </div>
      <div class="state-slot">${K.chip('pending', 'Pending approval', 'chip-pending')}</div>
    </div>
    <div id="flow" style="position:absolute;left:1080px;top:760px;width:760px;white-space:nowrap">
      <div class="diagram-tag" style="position:relative">Diagram</div>
      <div class="flow" style="position:relative;margin-top:12px"><div class="n lit"><i></i>Venue manager</div><div class="l"></div><div class="n lit"><i></i>Manager</div><div class="l dash"></div><div class="n dim"><i></i>Staff · not yet</div></div>
    </div>
  </div>

  <!-- Manager's web console: real footage in a window, camera inside -->
  <div id="stage" class="stage" style="left:${S.x}px;top:${S.y}px;width:${S.w}px;height:${S.h}px;transform-origin:0 0">
    <div id="cam" class="cam"><video id="v-web" class="clip" data-start="${T.web}" data-duration="${(T.total - T.web).toFixed(3)}" data-track-index="0" muted playsinline src="assets/web-approve.mp4"></video></div>
  </div>
  <div id="role-mgr" class="chapter-pill" style="left:${S.x + 24}px;top:${S.y + S.h - 64}px;opacity:0">Manager · Web console</div>
  <div id="row-hl" class="row-highlight" style="left:${land.x.toFixed(1)}px;top:${land.y.toFixed(1)}px;width:${land.w.toFixed(1)}px;height:${land.h.toFixed(1)}px;opacity:0"></div>
  <div id="k-approved" class="kinetic" style="left:${S.x + 40}px;top:${S.y + S.h - 120}px;opacity:0">Approved</div>

  <!-- Staff phone -->
  <div id="off" class="layer" style="opacity:0">
    <div style="position:absolute;left:0;top:${K.G.content.y0}px;width:1920px;height:${K.G.content.y1 - K.G.content.y0}px;overflow:hidden">
      ${K.phone('phone-off', phoneOff.x, phoneOff.y - K.G.content.y0, `<video id="v-off" class="clip" data-start="${T.split}" data-duration="${(T.total - T.split).toFixed(3)}" data-track-index="2" muted playsinline src="assets/phone-offer.mp4"></video>${ringAt('ring-acc', acceptTap.x, acceptTap.y)}`)}
    </div>
    <div id="who" style="position:absolute;left:${K.G.stageSplit.x}px;top:810px;display:flex;align-items:center;gap:18px">
      <div style="font-size:26px;font-weight:700">Priya Shah</div>
      <div class="state-slot" style="margin:0;width:200px">${K.chip('offered', 'Offered', 'chip-offered')}${K.chip('confirmed', 'Confirmed', 'chip-confirmed')}</div>
    </div>
    <div id="role-staff" class="chapter-pill" style="left:${phoneOff.x}px;top:${K.G.content.y1 - 46}px">Staff · Crewflow app</div>
  </div>

  <!-- Travelling token: one offer per person -->
  <div id="offer-token" class="shift-card" style="left:300px;top:380px;width:380px;padding:20px 22px;opacity:0">
    <div class="eyebrow">Offer · Priya Shah</div>
    <div class="head" style="font-size:24px">Riverside House</div>
    <div class="sub" style="font-size:18px">Fri 23 Oct · 12:00–18:00 · Waiting staff</div>
  </div>

  <div id="captions">
${caps.map((c, i) => `    <p id="cap-${i}" class="cap clip" data-start="${c.start}" data-duration="${(c.end - c.start).toFixed(3)}" data-track-index="5">${K.esc(c.text)}</p>`).join('\n')}
  </div>
  <div id="fade" class="layer" style="background:#fff;opacity:0"></div>
  <audio id="narration" class="clip" data-start="0" data-track-index="6" data-volume="1" src="assets/narration.wav"></audio>
</div>
<script>
  ${K.cameraRuntime}
  const KEYS = ${JSON.stringify(camKeys)};
  const SW = ${S.w};
  const cam = document.getElementById("cam");
  function applyCam(t) { const r = camAt(KEYS, t); const s = SW / r.w; gsap.set(cam, { x: -r.x * s, y: -r.y * s, scale: s, transformOrigin: "0 0" }); }
  const vars = (window.__hyperframes && window.__hyperframes.getVariables) ? window.__hyperframes.getVariables() : {};
  if (vars.showCaptions === false) document.getElementById("captions").style.display = "none";

  const tl = gsap.timeline({ paused: true });
  const clock = { t: 0 };
  applyCam(0);
  tl.to(clock, { t: ${T.total}, duration: ${T.total}, ease: "none", onUpdate: () => applyCam(clock.t) }, 0);

  // Initial states
  const J = document.getElementById("journey"); const L = J.getTotalLength();
  gsap.set(J, { strokeDasharray: L, strokeDashoffset: L });
  gsap.set(["#n-venue", "#n-manager", "#n-staff", "#strip", "#logo", "#dot"], { opacity: 0 });
  gsap.set("#logo", { clipPath: "inset(0 100% 0 0)" });
  gsap.set("#card4", { clipPath: "inset(0 0 0 100%)" });
  gsap.set(["#pill4", "#req", "#card", "#flow", "#chip-pending", "#stage", "#role-mgr", "#chip-confirmed"], { opacity: 0 });

  // ── Opening (problem → one connected journey → logo) ──
  tl.to("#dot", { opacity: 1, duration: 0.3 }, 0.1);
  tl.fromTo("#n-venue", { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.5, ease: "power2.out" }, 0.35);
  tl.fromTo("#n-manager", { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.5, ease: "power2.out" }, 0.55);
  tl.fromTo("#n-staff", { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.5, ease: "power2.out" }, 0.75);
  tl.to(J, { strokeDashoffset: 0, duration: 2.6, ease: "power1.inOut" }, ${T.c1 + 0.3});
  tl.to(["#dash-a", "#dash-b"], { opacity: 0, duration: 0.6 }, ${T.c1 + 1.2});
  tl.to("#dot", { attr: { cx: 1710 }, duration: 2.6, ease: "power1.inOut" }, ${T.c1 + 0.3});
  tl.fromTo("#strip", { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: 0.5, ease: "power2.out" }, ${T.c1 + 2.0});
  [0, 1, 2, 3].forEach((i) => tl.to("#st-" + i, { borderColor: "#FF7A1A", color: "#24252B", duration: 0.25 }, ${T.c1 + 2.4} + i * 0.45));
  tl.to("#st-4", { backgroundColor: "#24252B", color: "#FFFFFF", duration: 0.3 }, ${T.c1 + 4.4});
  tl.to(["#n-venue", "#n-manager", "#n-staff", "#strip", "#open-svg"], { opacity: 0, y: -10, duration: 0.45, ease: "power2.in" }, 6.0);
  tl.to("#logo", { opacity: 1, duration: 0.01 }, 6.35);
  tl.to("#logo", { clipPath: "inset(0 0% 0 0)", duration: 0.6, ease: "power2.out" }, 6.35);

  // ── Chapter card ──
  tl.to("#card4", { clipPath: "inset(0 0 0 0%)", duration: 0.45, ease: "power2.out" }, ${T.card});
  tl.set("#open", { opacity: 0 }, ${T.card + 0.5});
  tl.to("#req", { opacity: 1, duration: 0.01 }, ${T.card + 0.5});
  tl.to("#card4", { clipPath: "inset(0 100% 0 0)", duration: 0.4, ease: "power2.in" }, ${T.req - 0.25});
  tl.to("#pill4", { opacity: 1, duration: 0.3 }, ${T.req + 0.3});
  tl.to("#pill4", { opacity: 0, duration: 0.3 }, ${T.req + 3.3});

  // ── Request on the phone; the ShiftCard beside it ──
  tl.to("#role-vm", { opacity: 1, duration: 0.3 }, ${T.req + 0.2});
  tl.fromTo("#card", { opacity: 0, x: 24 }, { opacity: 1, x: 0, duration: 0.5, ease: "power2.out" }, ${T.req + 0.2});
  tl.fromTo("#ring-req", { scale: 0.55, opacity: 0.95 }, { scale: 1.15, opacity: 0, duration: 0.32, ease: "power2.out" }, ${reqTapFilm});
  tl.fromTo("#chip-pending", { opacity: 0, scale: 0.9 }, { opacity: 1, scale: 1, duration: 0.3 }, 11.7);
  tl.fromTo("#flow", { opacity: 0 }, { opacity: 1, duration: 0.4 }, 12.0);
  gsap.set("#phone-req", { transformOrigin: "${originFor(pend.x + pend.w / 2, pend.y + pend.h / 2)}" });
  tl.to("#phone-req", { scale: 1.3, duration: 0.9, ease: "power3.inOut" }, 12.1);

  // ── Handoff: phone → web; the request lands on the real "Pending approval" row ──
  tl.to(["#phone-req", "#role-vm", "#flow"], { opacity: 0, x: -60, duration: 0.45, ease: "power2.in" }, ${T.hand - 0.15});
  tl.fromTo("#stage", { opacity: 0, scale: 0.94, transformOrigin: "50% 50%" }, { opacity: 1, scale: 1, duration: 0.55, ease: "power2.out" }, ${T.hand});
  tl.to("#card", { x: ${(land.x - 1080).toFixed(1)}, y: ${(land.y - 70 - 190).toFixed(1)}, scale: 0.55, transformOrigin: "0 0", duration: 0.85, ease: "power2.inOut" }, ${T.hand});
  tl.to("#card", { opacity: 0, duration: 0.25 }, ${T.hand + 0.85});
  tl.to("#row-hl", { opacity: 1, duration: 0.2 }, ${T.hand + 0.9});
  tl.to("#row-hl", { opacity: 0, duration: 0.4 }, ${T.hand + 1.5});
  tl.to("#role-mgr", { opacity: 1, duration: 0.3 }, ${T.hand + 0.6});
  tl.to("#role-mgr", { opacity: 0, duration: 0.3 }, ${T.hand + 3.6});
  tl.set("#req", { opacity: 0 }, ${T.hand + 0.6});
  tl.fromTo("#k-approved", { opacity: 0, y: 10, "--u": 0 }, { opacity: 1, y: 0, "--u": 1, duration: 0.45, ease: "power2.out" }, ${approveClickFilm + 0.1});
  tl.to("#k-approved", { opacity: 0, duration: 0.3 }, ${T.split - 0.35});

  // ── One offer per person: Priya's travels to her phone ──
  const SPLIT = ${JSON.stringify(K.G.stageSplit)};
  tl.to("#stage", { x: SPLIT.x - ${S.x}, y: SPLIT.y - ${S.y}, scale: SPLIT.w / ${S.w}, transformOrigin: "0 0", duration: 0.8, ease: "power3.inOut" }, ${T.split});
  tl.to("#off", { opacity: 1, duration: 0.01 }, ${T.split});
  tl.fromTo("#phone-off", { opacity: 0, x: 120 }, { opacity: 1, x: 0, duration: 0.6, ease: "power2.out" }, ${T.split + 0.05});
  tl.fromTo("#offer-token", { opacity: 0, scale: 0.9 }, { opacity: 1, scale: 1, duration: 0.25 }, ${T.split});
  tl.to("#offer-token", { x: ${phoneOff.x + 30 - 300}, y: ${160 - 380}, scale: 0.8, transformOrigin: "0 0", duration: 0.8, ease: "power2.inOut" }, ${T.split + 0.25});
  tl.to("#offer-token", { opacity: 0, duration: 0.25 }, ${T.split + 1.0});
  tl.fromTo("#ring-acc", { scale: 0.55, opacity: 0.95 }, { scale: 1.15, opacity: 0, duration: 0.32, ease: "power2.out" }, ${accTapFilm});
  tl.to("#chip-offered", { opacity: 0, duration: 0.2 }, ${accTapFilm + 0.5});
  tl.fromTo("#chip-confirmed", { opacity: 0, scale: 0.85 }, { opacity: 1, scale: 1, duration: 0.3, ease: "back.out(1.4)" }, ${accTapFilm + 0.5});
  gsap.set("#phone-off", { transformOrigin: "${originFor(conf.x + conf.w / 2, conf.y + conf.h / 2)}" });
  tl.to("#phone-off", { scale: 1.45, duration: 0.9, ease: "power3.inOut" }, ${accTapFilm + 0.9});
  tl.to("#fade", { opacity: 1, duration: 0.6 }, ${T.total - 0.6});

  window.__timelines["crewflow-intro-proof"] = tl;
</script>
</body>
</html>
`;
fs.writeFileSync(path.join(PROJ, 'index.html'), html);
fs.writeFileSync(path.join(PROJ, 'manifest.json'), JSON.stringify({ total: T.total, times: T, camera: camKeys, land, taps: { submit: reqTapFilm, accept: accTapFilm, approveClick: approveClickFilm }, captions: caps }, null, 2));
console.log(JSON.stringify({ total: T.total, approveClickFilm, reqTapFilm, accTapFilm, captions: caps.length }, null, 1));
