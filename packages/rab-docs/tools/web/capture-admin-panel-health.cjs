// Admin panel follow-up (2026-10-25): Health tab screenshots with the BullMQ metrics chart. Captures the REAL rab-front
// Admin panel with synthetic, fictional API responses (fixtures.cjs + admin-panel-fixtures.cjs, plus the follow-up
// routes below, registered last so they win) into docs/admin-panel/screenshots/. Nothing reaches a real API.
//
//   CREWFLOW_WEB_ORIGIN=http://127.0.0.1:5199 node packages/rab-docs/tools/web/capture-admin-panel-health.cjs
//
// New file on purpose (owner rule: docs fixtures change in NEW files only). The numbers are invented sample data in the
// shape the server returns (`GET /admin/queues/:queue/metrics`); a real panel only ever shows the Workers' BullMQ metrics.
'use strict';

const fs = require('fs');
const path = require('path');
const { launch, openPage, settle, APP_ORIGIN } = require('./common.cjs');
const { installAdmin } = require('./admin-panel-fixtures.cjs');

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const OUT = path.join(REPO, 'docs', 'admin-panel', 'screenshots');
const MOCKUP = 'file:///' + path.join(REPO, 'docs', 'design', 'crewflow-admin-panel-mockup.html').replace(/\\/g, '/');
const SIZES = [
  { name: '1440x900', viewport: { width: 1440, height: 900 } },
  { name: '1280x800', viewport: { width: 1280, height: 800 } },
  { name: '800x900', viewport: { width: 800, height: 900 } },
];
const out = (name) => path.join(OUT, `${name}.png`);
fs.mkdirSync(OUT, { recursive: true });

const RANGE = { '1H': [60, 1], '4H': [4, 60], '12H': [12, 60], '1D': [24, 60], '7D': [168, 60] };
/** Deterministic sample series (same idea as the mockup's `series()`): busier in the day, a failure spike late on. */
function seeded(i, s) {
  const x = Math.sin(i * 12.9898 + s * 78.233) * 43758.5453;
  return x - Math.floor(x);
}
function sampleMetrics(queue, range, opts) {
  const [count, bucketMinutes] = RANGE[range];
  const bucketMs = bucketMinutes * 60_000;
  const last = Math.floor(Date.now() / bucketMs) * bucketMs;
  const first = last - (count - 1) * bucketMs;
  const buckets = [];
  for (let i = 0; i < count; i += 1) {
    const at = new Date(first + i * bucketMs);
    const hour = at.getHours();
    const perBucket = (opts.perHour * bucketMinutes) / 60;
    const day = hour > 7 && hour < 20 ? 1.3 : 0.6;
    const completed = opts.available ? Math.round(perBucket * (0.55 + 0.9 * seeded(i, queue.length)) * day) : 0;
    const failed = opts.available && opts.failRate ? Math.round((completed * opts.failRate) / 100 * (i >= count - 5 ? 2.2 : 0.25 * seeded(i, 3))) : 0;
    buckets.push({ at: at.toISOString(), completed, failed });
  }
  const totals = buckets.reduce((t, b) => ({ completed: t.completed + b.completed, failed: t.failed + b.failed }), { completed: 0, failed: 0 });
  return {
    queue,
    range,
    bucketMinutes,
    from: new Date(first).toISOString(),
    to: new Date(last + bucketMs).toISOString(),
    available: opts.available,
    reason: opts.available ? null : 'NO_DATA',
    buckets,
    totals: opts.available ? totals : { completed: 0, failed: 0 },
    generatedAt: new Date().toISOString(),
  };
}
const QUEUE_PROFILE = {
  'rab-email': { available: true, perHour: 175, failRate: 6 },
  'rab-push': { available: true, perHour: 380, failRate: 1 },
  'rab-shift-statements': { available: false, perHour: 0, failRate: 0 },
};

async function installFollowup(page) {
  await page.route('**/rest/v1/admin/queues**', async (r) => {
    const req = r.request();
    const url = new URL(req.url());
    const p = url.pathname.replace(/^.*\/rest\/v1/, '');
    const m = p.match(/^\/admin\/queues\/([^/]+)\/metrics$/);
    if (req.method() === 'GET' && m) {
      const queue = decodeURIComponent(m[1]);
      const body = sampleMetrics(queue, url.searchParams.get('range') || '1D', QUEUE_PROFILE[queue] || { available: false, perHour: 0 });
      return r.fulfill({ status: 200, headers: { 'access-control-allow-origin': APP_ORIGIN, 'access-control-allow-credentials': 'true', 'content-type': 'application/json' }, body: JSON.stringify(body) });
    }
    // `/admin/queues` itself stays the base fixture's answer (the chart does not read its `metrics` field).
    return r.fallback();
  });
}

async function health(browser, size, problems, variants) {
  const { context, page, errors, fx } = await openPage(browser, { persona: 'platformAdmin', viewport: size.viewport, deviceScaleFactor: 1 });
  await installAdmin(page, { origin: APP_ORIGIN });
  await installFollowup(page);
  await page.addInitScript(() => { try { localStorage.setItem('cf-admin-tab', 'health'); } catch { /* ignore */ } });
  await page.goto(`${APP_ORIGIN}/settings/admin`);
  await settle(page, 1800);
  await page.getByRole('region', { name: 'Worker queues' }).scrollIntoViewIfNeeded().catch(() => undefined);
  await settle(page, 600);
  await page.screenshot({ path: out(`real-health-${size.name}`) });
  if (variants) {
    const queues = page.getByRole('region', { name: 'Worker queues' });
    await queues.screenshot({ path: out(`real-health-chart-1D-${size.name}`) });
    for (const range of ['1H', '7D']) {
      await page.getByRole('button', { name: range, exact: true }).click();
      await settle(page, 900);
      await queues.screenshot({ path: out(`real-health-chart-${range}-${size.name}`) });
    }
    await page.getByRole('button', { name: '1D', exact: true }).click();
    await page.getByRole('button', { name: /^rab-shift-statements/ }).click();
    await settle(page, 900);
    await queues.screenshot({ path: out(`real-health-chart-unavailable-${size.name}`) });
  }
  problems.push(...errors.map((e) => `[health ${size.name}] pageerror ${e}`), ...fx.unhandled.map((u) => `[health ${size.name}] ${u}`));
  await context.close();
}

async function mockupHealth(browser, size) {
  const context = await browser.newContext({ viewport: size.viewport, deviceScaleFactor: 1, reducedMotion: 'reduce', locale: 'en-GB' });
  const page = await context.newPage();
  await page.goto(MOCKUP);
  await page.waitForTimeout(800);
  await page.click('[data-tab="health"]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: out(`mockup-health-${size.name}`) });
  await context.close();
}

(async () => {
  const browser = await launch();
  const problems = [];
  try {
    for (const [i, size] of SIZES.entries()) {
      await health(browser, size, problems, i === 0);
      await mockupHealth(browser, size);
    }
  } finally {
    await browser.close();
  }
  for (const p of problems) console.log(p);
  console.log(`screenshots written to ${OUT}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
