#!/usr/bin/env node
// Server-side polling workload: logs in every user of a mix, runs each user's screen schedule against the disposable
// crewflow-cost API, and records every request (requests.jsonl) plus per-phase summaries (load-summary.json).
//
//   node run-load.mjs --schedule schedules/before-614796f0.mjs --mix mixes/c1-mix.mjs --out <dir> --label mix \
//        --warmup-s 60 --phases visible:600[,hidden:300,visible:120] [--only-screen <id>] [--ready-file <f>]
//
// Refuses any API but http://127.0.0.1:$COST_API_PORT (default 23070) with the crewflow-cost disposable database behind
// it. Reads the seed password from $COST_SECRETS (outside the repo) and never prints it.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ScreenRunner, routeOf } from './lib/engine.mjs';
import { API_PORT, assertHarnessApi, seedPassword, pipelineShiftFor } from './lib/harness.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith('--') ? [...a, [x.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? '1' : all[i + 1]]] : a), []));
const need = (k) => args[k] ?? (console.error(`missing --${k}`), process.exit(2));
const OUT = path.resolve(need('out'));
const LABEL = args.label ?? 'load';
const WARMUP_S = Number(args['warmup-s'] ?? 60);
const PHASES = (args.phases ?? 'visible:600').split(',').map((p) => { const [state, s] = p.split(':'); if (!['visible', 'hidden'].includes(state) || !(Number(s) > 0)) throw new Error(`bad phase ${p}`); return { state, s: Number(s) }; });
const PORT = API_PORT;
const BASE = `http://127.0.0.1:${PORT}/rest/v1`;
if (args.api && args.api !== BASE) throw new Error(`refusing API ${args.api}: only the harness API ${BASE} is allowed`);
const ORIGIN = 'http://127.0.0.1:5173'; // the harness's CORS_ORIGINS default; Origin is required for cookie POSTs
fs.mkdirSync(OUT, { recursive: true });

assertHarnessApi();
const SEED_PW = seedPassword();

const schedule = (await import(pathToFileURL(path.resolve(need('schedule'))).href)).default;
const mix = (await import(pathToFileURL(path.resolve(need('mix'))).href)).default;
let users = mix.users.map((u, i) => ({ ...u, idx: i }));
if (args['only-screen']) users = users.filter((u) => u.screen === args['only-screen']);
if (!users.length) throw new Error('no users selected');
for (const u of users) if (!schedule.screens[u.screen]) throw new Error(`schedule ${schedule.name} has no screen ${u.screen}`);

// Distinct addresses: per-user (198.51.100.x, TEST-NET-2) unless the mix puts the user behind a shared ip.
const ipOf = (u) => (u.ip ? mix.ips[u.ip] : `198.51.100.${10 + u.idx}`);
let loginIp = 0;
const nextLoginIp = () => `192.0.2.${(++loginIp % 250) + 1}`; // logins from TEST-NET-1, one address each

const records = [];
let phase = 'warmup';
const record = (r) => records.push({ phase, ...r });

async function login(u) {
  const mobile = schedule.screens[u.screen].auth === 'mobile';
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': nextLoginIp(), ...(mobile ? { 'x-client-platform': 'mobile' } : { origin: ORIGIN }) },
    // Flutter and iOS send no applicationTarget (auth_provider.dart:261); the web console sends manager_web.
    body: JSON.stringify(mobile ? { email: u.email, password: SEED_PW } : { email: u.email, password: SEED_PW, applicationTarget: 'manager_web' }),
  });
  const t = await res.text();
  if (res.status !== 200) throw new Error(`login ${u.email}: ${res.status} ${t.slice(0, 200)}`);
  if (mobile) return { bearer: JSON.parse(t).accessToken };
  return { cookie: res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ') };
}

function transportFor(u, client) {
  return async (ctx, method, p, body, meta) => {
    const send = async () => {
      const h = { 'cf-connecting-ip': ipOf(u) };
      if (u.auth.bearer) {
        h.authorization = `Bearer ${u.auth.bearer}`;
        h['x-client-platform'] = 'mobile';
        if (client === 'flutter') h['x-client-capabilities'] = 'mfa-verify';
      } else {
        h.cookie = u.auth.cookie;
        h.origin = ORIGIN;
      }
      if (meta.background) h['x-crewflow-background'] = '1';
      if (body !== undefined) h['content-type'] = 'application/json';
      const t0 = Date.now();
      const tp = performance.now();
      let status = 0, bytes = 0, hdrBytes = 0, requestId = null, json = null, retryAfter;
      try {
        const res = await fetch(`${BASE}${p}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), signal: meta.signal });
        const buf = Buffer.from(await res.arrayBuffer());
        status = res.status;
        bytes = buf.length;
        for (const [k, v] of res.headers) hdrBytes += k.length + v.length + 4;
        requestId = res.headers.get('x-request-id');
        const ra = res.headers.get('retry-after');
        if (ra) retryAfter = /^\d+$/.test(ra) ? Number(ra) : Math.max(0, Math.round((Date.parse(ra) - Date.now()) / 1000));
        if (status < 400 && buf.length) { try { json = JSON.parse(buf.toString('utf8')); } catch { json = null; } }
      } catch (e) {
        status = e.name === 'AbortError' ? -1 : 0; // -1 = cancelled by the client (iOS structured concurrency)
      }
      const reqBytes = Object.entries(h).reduce((s, [k, v]) => s + k.length + String(v).length + 4, 0) + method.length + p.length + 20 + (body === undefined ? 0 : JSON.stringify(body).length);
      record({ user: u.email, ip: u.ip ?? 'own', screen: ctx.screenId, timer: meta.timer, method, route: routeOf(method, p), status, bytes, hdrBytes, reqBytes, ms: +(performance.now() - tp).toFixed(1), t0, requestId, background: !!meta.background });
      return { status, json, retryAfter };
    };
    let r = await send();
    if (r.status === 401) {
      // Access tokens live 15 min; the clients refresh on 401. Here: re-login once (recorded as screen 'auth').
      phase !== 'done' && records.push({ phase, user: u.email, ip: u.ip ?? 'own', screen: 'auth', timer: 'relogin', method: 'POST', route: 'POST /auth/login', status: 200, bytes: 0, t0: Date.now() });
      u.auth = await login(u);
      r = await send();
    }
    return r;
  };
}

// Per-user parameters the mix asks the harness to resolve deterministically from the seeded data.
function resolveParams(u) {
  const params = { ...(u.params ?? {}) };
  if (params.pipelineShiftId === 'auto') params.pipelineShiftId = pipelineShiftFor(u.email);
  return params;
}

const startedAt = Date.now();
for (const u of users) {
  u.auth = await login(u);
  u.params = resolveParams(u);
}
const runners = users.map((u, i) => new ScreenRunner({ user: u.email, screenId: u.screen, screen: schedule.screens[u.screen], params: u.params, transport: transportFor(u, schedule.screens[u.screen].client), record, seed: 20261030 + i }));
// Staggered start over 5 s (real devices do not open their screens in the same millisecond); deterministic offsets.
await Promise.all(runners.map((r, i) => new Promise((ok) => setTimeout(() => { r.start(); ok(); }, Math.round((i * 5000) / runners.length)))));

const phaseLog = [];
const snap = () => runners.map((r) => r.stats());
let before = snap();
const mark = (name, state, t0, t1, after) => phaseLog.push({ name, state, t0, t1, timers: runners.map((r, j) => ({ user: users[j].email, screen: users[j].screen, stats: Object.fromEntries(Object.entries(after[j]).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).filter(([kk]) => !['running', 'failures'].includes(kk)).map(([kk, vv]) => [kk, vv - (before[j][k]?.[kk] ?? 0)]))])) })) });

let t = Date.now();
await new Promise((ok) => setTimeout(ok, WARMUP_S * 1000));
let after = snap(); mark('warmup', 'visible', t, Date.now(), after); before = after;
if (args['ready-file']) fs.writeFileSync(args['ready-file'], String(Date.now()));
for (const [i, p] of PHASES.entries()) {
  phase = `${i + 1}-${p.state}`;
  for (const r of runners) await r.setHidden(p.state === 'hidden');
  t = Date.now();
  await new Promise((ok) => setTimeout(ok, p.s * 1000));
  after = snap();
  mark(phase, p.state, t, Date.now(), after);
  before = after;
}
phase = 'done';
for (const r of runners) r.stop();
await new Promise((ok) => setTimeout(ok, 1500)); // let in-flight requests land (recorded under 'done')

fs.writeFileSync(path.join(OUT, `requests-${LABEL}.jsonl`), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
const meta = {
  label: LABEL, schedule: schedule.name, scheduleFile: path.basename(need('schedule')), mix: mix.name, onlyScreen: args['only-screen'] ?? null,
  users: users.map((u) => ({ email: u.email, screen: u.screen, client: schedule.screens[u.screen].client, basis: schedule.screens[u.screen].basis, ip: u.ip ?? 'own', clientIp: ipOf(u), params: u.params })),
  warmupS: WARMUP_S, phases: phaseLog, startedAt, endedAt: Date.now(), apiBase: BASE,
};
fs.writeFileSync(path.join(OUT, `load-meta-${LABEL}.json`), JSON.stringify(meta, null, 2));
console.log(JSON.stringify({ label: LABEL, users: users.length, requests: records.length, phases: phaseLog.map((p) => p.name) }));
