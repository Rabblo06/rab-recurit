#!/usr/bin/env node
// Real web client measurement: serves a rab-front checkout with Vite on 127.0.0.1:23173 (proxy /rest -> the harness API
// only), signs in synthetic users with headless Chromium (Playwright from that checkout's node_modules) and counts every
// /rest request and its bytes per screen over fixed windows: visible, hidden, visible again.
//
//   node web/measure-web.mjs --front <repo>/packages/rab-front --out <dir> [--window-s 90] [--settle-s 20] [--only id,id]
//
// Visibility: headless Chromium keeps a page visible, so "hidden" is EMULATED in the page: document.visibilityState /
// document.hidden are overridden and a `visibilitychange` event is dispatched (what TanStack Query's focusManager and
// any visibility-aware poller listen to). Browser timer throttling of real background tabs is NOT emulated.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { routeOf } from '../lib/engine.mjs';
import { API_ORIGIN, assertHarnessApi, seedPassword, pipelineShiftFor } from '../lib/harness.mjs';
import { WEB_ORIGIN, webViteConfig } from './vite-config.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith('--') ? [...a, [x.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? '1' : all[i + 1]]] : a), []));
const FRONT = path.resolve(args.front ?? 'C:/rab-ai-wt/m2/packages/rab-front');
const OUT = path.resolve(args.out ?? (console.error('--out required'), process.exit(2)));
const WIN_S = Number(args['window-s'] ?? 90);
const SETTLE_S = Number(args['settle-s'] ?? 20);
if (/^[a-z]:[\\/]rab-recruit/i.test(FRONT)) throw new Error('refusing the main checkout as --front');
fs.mkdirSync(OUT, { recursive: true });
assertHarnessApi();
const SEED_PW = seedPassword();

// The front checkout's OWN toolchain (its node_modules), so the before/after builds use their own Vite/React plugin.
const repoRoot = path.resolve(FRONT, '../..');
async function importPkg(name) {
  // The checkout's own hoisted node_modules (some packages do not export ./package.json).
  const dir = path.join(repoRoot, 'node_modules', ...name.split('/'));
  const pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  let e = pj.exports?.['.'] ?? pj.exports ?? pj.module ?? pj.main;
  while (e && typeof e === 'object') e = e.import ?? e.node ?? e.default;
  return import(pathToFileURL(path.join(dir, e ?? 'index.js')).href);
}
const vite = await importPkg('vite');
const reactPlugin = (await importPkg('@vitejs/plugin-react')).default;
const { chromium } = await importPkg('playwright');

const work = 'C:/rab-ai-wt/cost-work/screen-traffic-web';
const envDir = path.join(work, 'empty-env');
fs.mkdirSync(envDir, { recursive: true });
process.env.VITE_API_URL = '/rest/v1';
const server = await vite.createServer(webViteConfig({ front: FRONT, react: reactPlugin, apiOrigin: API_ORIGIN, cacheDir: path.join(work, 'vite-cache', Buffer.from(FRONT).toString('hex').slice(-24)), envDir }));
await server.listen();

const SCENARIOS = [
  { id: 'pipeline', email: 'manager1@org01.example.test', path: () => `/venue-offers/${pipelineShiftFor('manager1@org01.example.test')}` },
  { id: 'venue-offers', email: 'manager1@org03.example.test', path: () => '/venue-offers' },
  { id: 'bell-only', email: 'manager1@org06.example.test', path: () => '/settings/profile' },
  { id: 'admin-health', email: 'manager1@org05.example.test', path: () => '/settings/admin', storage: { 'cf-admin-tab': 'health' }, tab: /health/i },
].filter((s) => !args.only || args.only.split(',').includes(s.id));

const SHIM = `(() => {
  let state = 'visible';
  Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get() { return state; } });
  Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get() { return state === 'hidden'; } });
  window.__stSetVisibility = (s) => { state = s; document.dispatchEvent(new Event('visibilitychange', { bubbles: true })); };
})();`;

const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const sc of SCENARIOS) {
    const context = await browser.newContext({ baseURL: WEB_ORIGIN, viewport: { width: 1440, height: 900 } });
    await context.addInitScript(SHIM);
    if (sc.storage) await context.addInitScript((kv) => { for (const [k, v] of Object.entries(kv)) try { localStorage.setItem(k, v); } catch { /* ignore */ } }, sc.storage);
    const login = await context.request.post(`${WEB_ORIGIN}/rest/v1/auth/login`, { data: { email: sc.email, password: SEED_PW, applicationTarget: 'manager_web' }, headers: { origin: WEB_ORIGIN } });
    if (login.status() !== 200) throw new Error(`${sc.id}: login ${login.status()} ${(await login.text()).slice(0, 200)}`);
    const page = await context.newPage();
    let phase = 'load';
    const rows = [];
    page.on('requestfinished', async (r) => {
      const u = new URL(r.url());
      if (!u.pathname.startsWith('/rest/')) return;
      const t = Date.now(), ph = phase;
      const [sizes, res] = await Promise.all([r.sizes().catch(() => null), r.response().catch(() => null)]);
      rows.push({ phase: ph, t, method: r.method(), route: routeOf(r.method(), u.pathname.replace(/^\/rest\/v1/, '') + u.search), status: res?.status() ?? 0, down: sizes ? sizes.responseBodySize + sizes.responseHeadersSize : 0, up: sizes ? sizes.requestBodySize + sizes.requestHeadersSize : 0, background: (await r.allHeaders().catch(() => ({})))['x-crewflow-background'] === '1' });
    });
    page.on('requestfailed', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/rest/')) rows.push({ phase, t: Date.now(), method: r.method(), route: routeOf(r.method(), u.pathname.replace(/^\/rest\/v1/, '') + u.search), status: 0, down: 0, up: 0, failed: r.failure()?.errorText }); });
    const url = sc.path();
    await page.goto(url, { waitUntil: 'load' });
    if (sc.tab) { const tab = page.getByRole('tab', { name: sc.tab }); if (await tab.count()) await tab.first().click().catch(() => {}); }
    await page.waitForTimeout(SETTLE_S * 1000);
    const landed = new URL(page.url()).pathname;
    if (landed !== new URL(url, WEB_ORIGIN).pathname) console.error(`WARNING ${sc.id}: landed on ${landed}, not ${url}`);
    await page.screenshot({ path: path.join(OUT, `${sc.id}.png`) });
    const phases = [];
    for (const [name, vis] of [['visible-1', 'visible'], ['hidden', 'hidden'], ['visible-2', 'visible']]) {
      await page.evaluate((v) => window.__stSetVisibility(v), vis);
      phase = name;
      const t0 = Date.now();
      await page.waitForTimeout(WIN_S * 1000);
      phases.push({ name, visibility: vis, t0, t1: Date.now() });
    }
    phase = 'end';
    await page.waitForTimeout(500);
    await context.close();
    const summary = Object.fromEntries(['load', ...phases.map((p) => p.name)].map((ph) => {
      const v = rows.filter((r) => r.phase === ph);
      const p = phases.find((x) => x.name === ph);
      const mins = p ? (p.t1 - p.t0) / 60000 : null;
      return [ph, {
        requests: v.length, requestsPerMin: mins ? +(v.length / mins).toFixed(2) : null, downBytes: v.reduce((s, r) => s + r.down, 0), downBytesPerHour: mins ? Math.round((v.reduce((s, r) => s + r.down, 0) / mins) * 60) : null,
        r429: v.filter((r) => r.status === 429).length, errors: v.filter((r) => r.status === 0 || r.status >= 500).length, withBackgroundHeader: v.filter((r) => r.background).length,
        firstRequestAfterPhaseStartMs: p && v.length ? Math.min(...v.map((r) => r.t)) - p.t0 : null,
        routes: Object.fromEntries(Object.entries(Object.groupBy(v, (r) => r.route)).map(([k, x]) => [k, x.length])),
      }];
    }));
    results.push({ id: sc.id, user: sc.email, url, landedPath: landed, windowS: WIN_S, settleS: SETTLE_S, phases, summary });
    fs.writeFileSync(path.join(OUT, `web-${sc.id}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    console.log(JSON.stringify({ id: sc.id, landed, ...Object.fromEntries(Object.entries(summary).map(([k, v]) => [k, v.requests])) }));
  }
} finally {
  await browser.close();
  await server.close();
}
const out = { front: FRONT, method: 'MEASURED: headless Chromium (Playwright), real rab-front served by Vite, same-origin /rest proxy to the harness API; hidden = emulated document visibility', windowS: WIN_S, results };
fs.writeFileSync(path.join(OUT, 'web-summary.json'), JSON.stringify(out, null, 2));
const L = ['| Web screen | phase | requests | req/min | down KB/h | 429 | bg header | routes |', '|---|---|---:|---:|---:|---:|---:|---|'];
for (const r of results) for (const [ph, s] of Object.entries(r.summary)) L.push(`| ${r.id} | ${ph} | ${s.requests} | ${s.requestsPerMin ?? '-'} | ${s.downBytesPerHour == null ? '-' : Math.round(s.downBytesPerHour / 1024)} | ${s.r429} | ${s.withBackgroundHeader} | ${Object.entries(s.routes).map(([k, n]) => `${k} ×${n}`).join('; ')} |`);
fs.writeFileSync(path.join(OUT, 'web-summary.md'), L.join('\n') + '\n');
console.log(L.join('\n'));
