#!/usr/bin/env node
// Real Flutter client on the Android emulator: installs a debug APK built with API_URL=http://10.0.2.2:<COST_API_PORT>
// /rest/v1, signs in one synthetic user at a time through the real UI, opens the screen, and counts the requests the API
// receives over fixed windows: foreground, background (Home pressed), foreground again. Nothing else talks to the
// harness API during these windows, so the API's own request_complete log IS this device's traffic (healthz excluded).
// Network bytes: `dumpsys netstats detail` for the app uid, sampled at each window boundary.
//
//   node flutter/measure-flutter.mjs --apk <app-debug.apk> --out <dir> [--window-s 120] [--avd Pixel_5]
//        [--users vm:venuemanager3@org06.example.test,staff:staff23@org06.example.test] [--keep-emulator]
// The emulator is started here (headless) and killed at the end unless --keep-emulator. One heavy thing at a time:
// run it through heavy-run (measure-flutter.sh does).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { assertHarnessApi, seedPassword } from '../lib/harness.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith('--') ? [...a, [x.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? '1' : all[i + 1]]] : a), []));
const OUT = path.resolve(args.out ?? (console.error('--out required'), process.exit(2)));
const APK = path.resolve(args.apk ?? (console.error('--apk required'), process.exit(2)));
const WIN_S = Number(args['window-s'] ?? 120);
const AVD = args.avd ?? 'Pixel_5';
const USERS = (args.users ?? 'vm:venuemanager3@org06.example.test,staff:staff23@org06.example.test').split(',').map((x) => { const [kind, email] = x.split(':'); return { kind, email }; });
const PKG = 'com.rab.rab_staff';
const SDK = process.env.ANDROID_SDK_ROOT || path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk');
const ADB = path.join(SDK, 'platform-tools', 'adb.exe');
const EMU = path.join(SDK, 'emulator', 'emulator.exe');
fs.mkdirSync(OUT, { recursive: true });
assertHarnessApi();
const SEED_PW = seedPassword();
const dockerEnv = { ...process.env, MSYS_NO_PATHCONV: '1' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const adb = (...a) => execFileSync(ADB, a, { encoding: 'utf8', maxBuffer: 1 << 26, env: dockerEnv }).replace(/\r/g, '');
const sh = (cmd) => adb('shell', cmd);
const log = (m) => { console.log(`[flutter] ${new Date().toISOString()} ${m}`); fs.appendFileSync(path.join(OUT, 'flutter.log'), `${new Date().toISOString()} ${m}\n`); };

// ---- UI helpers (uiautomator dump of the Flutter semantics tree) ----------------------------------------------------
function dump() {
  // uiautomator fails now and then while the app animates: retry. EditText values (the password field) are redacted.
  for (let i = 0; i < 6; i++) {
    const x = sh('rm -f /sdcard/st-ui.xml; uiautomator dump /sdcard/st-ui.xml >/dev/null 2>&1; cat /sdcard/st-ui.xml 2>/dev/null; true');
    if (x.includes('<hierarchy')) return x.replace(/<node [^>]*class="android\.widget\.EditText"[^>]*>/g, (n) => n.replace(/ text="[^"]*"/, ' text=""'));
    execFileSync('ping', ['-n', '2', '127.0.0.1'], { stdio: 'ignore' }); // ~1 s, synchronous
  }
  return '';
}
function nodes(xml) {
  return [...xml.matchAll(/<node [^>]*>/g)].map((m) => {
    const a = Object.fromEntries([...m[0].matchAll(/([\w-]+)="([^"]*)"/g)].map((x) => [x[1], x[2]]));
    const b = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(a.bounds ?? '');
    return { ...a, cx: b ? (Number(b[1]) + Number(b[3])) >> 1 : 0, cy: b ? (Number(b[2]) + Number(b[4])) >> 1 : 0 };
  });
}
const label = (n) => `${n.text ?? ''} ${n['content-desc'] ?? ''} ${n.hint ?? ''}`.trim();
async function waitFor(pred, what, timeoutMs = 60_000) {
  const t = Date.now();
  while (Date.now() - t < timeoutMs) {
    const ns = nodes(dump());
    const hit = ns.find(pred);
    if (hit) return hit;
    await sleep(1500);
  }
  fs.writeFileSync(path.join(OUT, `ui-timeout-${what.replace(/\W+/g, '-')}.xml`), dump());
  throw new Error(`UI: '${what}' not found within ${timeoutMs} ms (dump saved)`);
}
const tap = (n) => sh(`input tap ${n.cx} ${n.cy}`);
const typeText = (s) => sh(`input text '${s.replace(/'/g, '').replace(/ /g, '%s')}'`);

// ---- API-side counting --------------------------------------------------------------------------------------------
function apiRequests(sinceIso, untilIso) {
  const text = execFileSync('docker', ['logs', 'costaudit-api', '--since', sinceIso, '--until', untilIso], { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'], env: dockerEnv }).replace(/\x1b\[[0-9;]*m/g, '');
  const rows = [];
  for (const block of text.split("event: 'request_complete'").slice(1)) {
    const g = (k) => { const m = new RegExp(`${k}: '?([^,'\\n]+)'?`).exec(block); return m ? m[1] : null; };
    const route = g('route');
    if (!route || route === '/healthz') continue;
    rows.push({ method: g('method'), route, status: Number(g('status')), sqlCount: Number(g('sqlCount')), durationMs: Number(g('durationMs')) });
  }
  return rows;
}
function uidBytes(uid) {
  // netstats detail: "ident=... uid=<uid> set=FOREGROUND|DEFAULT tag=0x0" followed by "st=... rb=<rx> rp=.. tb=<tx> tp=.."
  sh('dumpsys netstats --poll'); // flush the kernel counters into the history before reading
  const txt = sh('dumpsys netstats detail');
  let rx = 0, tx = 0, inUid = false;
  for (const line of txt.split('\n')) {
    if (/ uid=/.test(line)) inUid = new RegExp(`uid=${uid}\\b`).test(line) && /tag=0x0\b/.test(line);
    else if (inUid) { const m = /rb=(\d+).*tb=(\d+)/.exec(line); if (m) { rx += Number(m[1]); tx += Number(m[2]); } }
  }
  return { rx, tx };
}

// ---- emulator -----------------------------------------------------------------------------------------------------
let emu = null;
async function startEmulator() {
  const running = adb('devices').split('\n').some((l) => /^emulator-\d+\s+device/.test(l));
  if (running) { log('an emulator is already running; using it'); return; }
  log(`starting emulator ${AVD} (headless)`);
  emu = spawn(EMU, ['-avd', AVD, '-no-window', '-no-audio', '-no-boot-anim', '-no-snapshot', '-memory', '2048', '-gpu', 'swiftshader_indirect'], { stdio: ['ignore', fs.openSync(path.join(OUT, 'emulator.log'), 'a'), fs.openSync(path.join(OUT, 'emulator.log'), 'a')], detached: false });
  adb('wait-for-device');
  for (let i = 0; i < 180; i++) { if (sh('getprop sys.boot_completed').trim() === '1') break; await sleep(2000); }
  sh('settings put global window_animation_scale 0; settings put global transition_animation_scale 0; settings put global animator_duration_scale 0');
  log('emulator booted');
}

const results = [];
try {
  await startEmulator();
  log(`installing ${path.basename(APK)}`);
  adb('install', '-r', '-g', APK);
  const uid = /(?:userId|appId)=(\d+)/.exec(sh(`dumpsys package ${PKG}`))?.[1];
  log(`app uid ${uid}`);
  for (const u of USERS) {
    log(`user ${u.kind} ${u.email}: fresh app data, sign in through the UI`);
    sh(`pm clear ${PKG}`);
    for (const p of ['android.permission.ACCESS_FINE_LOCATION', 'android.permission.ACCESS_COARSE_LOCATION', 'android.permission.CAMERA', 'android.permission.POST_NOTIFICATIONS']) { try { sh(`pm grant ${PKG} ${p}`); } catch { /* not requested by this build */ } }
    sh(`am start -n ${PKG}/.MainActivity`);
    // Welcome ("Get Started") -> sign-in form. The keyboard is hidden after each field and the next field's bounds come
    // from a fresh dump (typing while the keyboard has moved the layout lands in the wrong field).
    tap(await waitFor((n) => /^get started$/i.test(label(n)), 'Get Started', 120_000));
    const email = await waitFor((n) => n.class === 'android.widget.EditText' && n.password !== 'true', 'email field');
    tap(email); await sleep(600); typeText(u.email); sh('input keyevent KEYCODE_BACK'); await sleep(800);
    const pw = await waitFor((n) => n.class === 'android.widget.EditText' && n.password === 'true', 'password field');
    tap(pw); await sleep(600); typeText(SEED_PW); sh('input keyevent KEYCODE_BACK'); await sleep(800);
    tap(await waitFor((n) => /^sign in$/i.test(label(n)), 'Sign In button'));
    if (u.kind === 'vm') {
      // Home -> "My Space" -> Overview "Staffing requests" -> Sent Shifts (venue_manager_screens.dart:453-458).
      tap(await waitFor((n) => /^my space$/i.test(label(n)), 'My Space', 90_000)); await sleep(2500);
      tap(await waitFor((n) => /^staffing requests/i.test(label(n)) && n.clickable === 'true', 'Staffing requests', 60_000));
      await waitFor((n) => /^sent shifts$/i.test(label(n)), 'Sent Shifts screen', 60_000);
    } else {
      await waitFor((n) => /^home$/i.test(label(n)), 'staff Home tab', 90_000);
    }
    fs.writeFileSync(path.join(OUT, `ui-${u.kind}-ready.xml`), dump());
    await sleep(15_000); // let the first load finish
    const windows = [];
    for (const [name, action] of [['foreground-1', null], ['background', 'home'], ['foreground-2', 'resume']]) {
      if (action === 'home') sh('input keyevent KEYCODE_HOME');
      if (action === 'resume') sh(`am start -n ${PKG}/.MainActivity`);
      const b0 = uidBytes(uid);
      const t0 = new Date();
      await sleep(WIN_S * 1000);
      const t1 = new Date();
      const b1 = uidBytes(uid);
      await sleep(2500); // log flush
      const rows = apiRequests(t0.toISOString(), t1.toISOString());
      const mins = (t1 - t0) / 60000;
      windows.push({
        name, t0: t0.toISOString(), t1: t1.toISOString(), requests: rows.length, requestsPerMin: +(rows.length / mins).toFixed(2), sqlStatements: rows.reduce((s, r) => s + r.sqlCount, 0),
        r429: rows.filter((r) => r.status === 429).length, routes: Object.fromEntries(Object.entries(Object.groupBy(rows, (r) => `${r.method} ${r.route}`)).map(([k, v]) => [k, v.length])),
        uidRxBytes: b1.rx - b0.rx, uidTxBytes: b1.tx - b0.tx, uidBytesPerHour: Math.round(((b1.rx - b0.rx + b1.tx - b0.tx) / mins) * 60),
      });
      log(`${u.kind} ${name}: ${rows.length} requests, rx ${b1.rx - b0.rx} B, tx ${b1.tx - b0.tx} B`);
    }
    results.push({ kind: u.kind, email: u.email, screen: u.kind === 'vm' ? 'vm-sent-shifts-flutter (Sent Shifts tab)' : 'staff-home-flutter (Home)', windowS: WIN_S, windows });
    sh(`am force-stop ${PKG}`);
  }
} finally {
  if (!args['keep-emulator']) { try { adb('emu', 'kill'); log('emulator stopped'); } catch { /* already gone */ } }
  emu?.unref();
}
fs.writeFileSync(path.join(OUT, 'flutter-summary.json'), JSON.stringify({ method: 'MEASURED: real debug APK on the Android emulator; requests counted from the API request_complete log (only this device talks to the API in these windows); bytes from dumpsys netstats for the app uid', apk: APK, avd: AVD, results }, null, 2));
const L = ['| Flutter screen | window | requests | req/min | SQL stmts | 429 | uid rx+tx bytes/h | routes |', '|---|---|---:|---:|---:|---:|---:|---|'];
for (const r of results) for (const w of r.windows) L.push(`| ${r.screen} | ${w.name} | ${w.requests} | ${w.requestsPerMin} | ${w.sqlStatements} | ${w.r429} | ${w.uidBytesPerHour} | ${Object.entries(w.routes).map(([k, n]) => `${k} ×${n}`).join('; ')} |`);
fs.writeFileSync(path.join(OUT, 'flutter-summary.md'), L.join('\n') + '\n');
console.log(L.join('\n'));
