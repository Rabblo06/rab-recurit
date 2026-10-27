// Minimal Android emulator driver for the docs' native mobile captures (debug build → mobile-fixture-server.cjs).
// Elements are found by their Flutter semantics labels through `uiautomator dump`; nothing in the app is patched.
//
//   const d = require('./drive.cjs'); await d.tap('Accept'); d.mark('accept');
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ADB = process.env.ADB || path.join(process.env.LOCALAPPDATA || '', 'Microsoft/WinGet/Packages/Genymobile.scrcpy_Microsoft.Winget.Source_8wekyb3d8bbwe/scrcpy-win64-v4.1/adb.exe');
const PKG = 'com.rab.rab_staff';
const FIXTURE = process.env.FIXTURE || 'http://127.0.0.1:4010';
const DUMP = path.join(os.tmpdir(), 'crewflow-ui.xml');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const adb = (...args) => execFileSync(ADB, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const shell = (cmd) => adb('shell', cmd);

function nodes() {
  shell('uiautomator dump /sdcard/crewflow-ui.xml');
  adb('pull', '/sdcard/crewflow-ui.xml', DUMP);
  const xml = fs.readFileSync(DUMP, 'utf8');
  const out = [];
  for (const m of xml.matchAll(/<node [^>]*?>/g)) {
    const tag = m[0];
    const attr = (n) => { const a = tag.match(new RegExp(`${n}="([^"]*)"`)); return a ? a[1].replace(/&#10;/g, ' ').replace(/&amp;/g, '&').replace(/&apos;/g, "'").replace(/&quot;/g, '"') : ''; };
    const b = attr('bounds').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    if (!b) continue;
    const [x1, y1, x2, y2] = b.slice(1).map(Number);
    out.push({ text: attr('text'), desc: attr('content-desc'), clickable: attr('clickable') === 'true', x1, y1, x2, y2 });
  }
  return out;
}
const label = (n) => [n.text, n.desc].filter(Boolean).join(' | ');
const matcher = (p) => (p instanceof RegExp ? (s) => p.test(s) : (s) => s.toLowerCase().includes(String(p).toLowerCase()));
function find(p, nth = 1) {
  const m = matcher(p);
  const hits = nodes().filter((n) => (n.text && m(n.text)) || (n.desc && m(n.desc)));
  return hits[nth - 1] || null;
}
async function waitFor(p, { timeout = 15000, nth = 1 } = {}) {
  const end = Date.now() + timeout;
  for (;;) { const n = find(p, nth); if (n) return n; if (Date.now() > end) throw new Error(`not found: ${p}`); await sleep(400); }
}
async function tap(p, opts = {}) {
  const n = await waitFor(p, opts);
  const x = Math.round((n.x1 + n.x2) / 2 + (opts.dx || 0)); const y = Math.round((n.y1 + n.y2) / 2 + (opts.dy || 0));
  shell(`input tap ${x} ${y}`);
  rec.tap(x, y, String(p), n);
  await sleep(opts.after ?? 700);
  return n;
}
async function tapXY(x, y, name = 'xy', after = 700) { shell(`input tap ${x} ${y}`); rec.tap(x, y, name); await sleep(after); }
async function typeText(text, { charDelay = 70 } = {}) {
  for (const ch of text) { shell(`input text ${ch === ' ' ? '%s' : `'${ch.replace(/'/g, "'\\''")}'`}`); await sleep(charDelay); }
}
async function swipe(x1, y1, x2, y2, ms = 450) { shell(`input swipe ${x1} ${y1} ${x2} ${y2} ${ms}`); await sleep(ms + 300); }
const back = () => shell('input keyevent KEYCODE_BACK');
const list = () => nodes().filter((n) => label(n)).map((n) => `[${n.x1},${n.y1}][${n.x2},${n.y2}] ${n.clickable ? '*' : ' '} ${label(n)}`).join('\n');
const screenshot = (file) => fs.writeFileSync(file, execFileSync(ADB, ['exec-out', 'screencap', '-p']));

async function fixture(pathname, body) {
  const res = await fetch(FIXTURE + pathname, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return res.json().catch(() => ({}));
}

/** Device clock + timezone + clean demo-mode status bar, so on-device "today" matches the scene. */
function setDeviceTime(iso, statusClock) {
  try { adb('root'); } catch { /* already root */ }
  spawnSync(ADB, ['wait-for-device']);
  for (let i = 0; i < 20; i++) { try { shell('true'); break; } catch { spawnSync(process.platform === 'win32' ? 'cmd' : 'sleep', process.platform === 'win32' ? ['/c', 'timeout /t 1 >nul'] : ['1']); } }
  shell('settings put global auto_time 0');
  shell('settings put global auto_time_zone 0');
  shell('cmd alarm set-timezone Europe/London');
  const d = new Date(iso); // device date in UTC (toybox `date -u MMDDhhmmYYYY.ss`)
  const p = (n) => String(n).padStart(2, '0');
  shell(`date -u ${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${d.getUTCFullYear()}.${p(d.getUTCSeconds())}`);
  shell('settings put global sysui_demo_allowed 1');
  shell('am broadcast -a com.android.systemui.demo -e command enter');
  shell(`am broadcast -a com.android.systemui.demo -e command clock -e hhmm ${statusClock}`);
  shell('am broadcast -a com.android.systemui.demo -e command battery -e level 100 -e plugged false');
  shell('am broadcast -a com.android.systemui.demo -e command network -e wifi show -e level 4 -e mobile hide');
  shell('am broadcast -a com.android.systemui.demo -e command notifications -e visible false');
}

async function freshApp() {
  shell(`pm clear ${PKG}`);
  shell(`pm grant ${PKG} android.permission.CAMERA`);
  for (let i = 0; i < 3; i++) { try { shell(`monkey -p ${PKG} -c android.intent.category.LAUNCHER 1`); break; } catch { await sleep(1500); } }
  await sleep(3500);
}

async function login(email) {
  // Credentials are typed before any recording starts; the fixture accepts any password for its fictional personas.
  const em = await waitFor(/^EMAIL$/, { timeout: 25000 });
  await tapXY(540, em.y2 + 75, 'email');
  await typeText(email, { charDelay: 25 });
  const pw = find(/^PASSWORD$/);
  await tapXY(400, pw.y2 + 75, 'password');
  await typeText('demo-password', { charDelay: 25 });
  back(); // close the keyboard so the Sign In button is on screen
  await sleep(700);
  await tap(/^Sign In$/, { after: 3500 });
}

// ── Recording with marks (host-side emulator screen recording: smooth 30 fps) ────────────────────────────────────────
const rec = {
  t0: 0, marks: [], taps: [], file: null,
  start(file) {
    this.file = file; this.marks = []; this.taps = [];
    adb('emu', 'screenrecord', 'start', '--time-limit', '180', '--fps', '30', file.replace(/\\/g, '/'));
    this.t0 = Date.now();
  },
  stop() { adb('emu', 'screenrecord', 'stop'); const r = { file: this.file, marks: this.marks, taps: this.taps }; this.t0 = 0; return r; },
  now() { return this.t0 ? (Date.now() - this.t0) / 1000 : null; },
  mark(id, extra = {}) { if (this.t0) this.marks.push({ id, t: +this.now().toFixed(3), ...extra }); },
  tap(x, y, name, n) { if (this.t0) this.taps.push({ t: +this.now().toFixed(3), x, y, name, bbox: n ? { x: n.x1, y: n.y1, w: n.x2 - n.x1, h: n.y2 - n.y1 } : null }); },
};
async function box(p) { const n = await waitFor(p); return { x: n.x1, y: n.y1, w: n.x2 - n.x1, h: n.y2 - n.y1 }; }
async function markBox(id, p) { const b = await box(p); rec.mark(id, { bbox: b }); return b; }

module.exports = { adb, shell, nodes, find, waitFor, tap, tapXY, typeText, swipe, back, list, screenshot, fixture, setDeviceTime, freshApp, login, rec, box, markBox, sleep, PKG };

/** The demo server's API as a given fictional persona (host side). Used ONLY where the emulator cannot supply real
 *  input — e.g. the QR scan, which needs a physical camera: the clock-in is posted to the same endpoint the app uses,
 *  standing in for the scan, and the film discloses it. */
async function apiAs(email) {
  const base = FIXTURE + '/rest/v1';
  const login = await (await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'demo-password' }) })).json();
  const token = login.accessToken || login.access_token;
  const call = async (method, p, body) => { const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${JSON.stringify(j).slice(0, 200)}`); return j; };
  return { call, token };
}
module.exports.apiAs = apiAs;
