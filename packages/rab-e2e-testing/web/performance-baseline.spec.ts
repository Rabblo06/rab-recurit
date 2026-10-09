import { test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * P1A (FULL-ARCHITECTURE-UPGRADE-PLAN.md — P1 program, checkpoint A, item A4): the frontend half
 * of the fresh "before" baseline — request-waterfall evidence for later P1 checkpoints (notably
 * P1G's bootstrap-endpoint/frontend-integration final benchmark) to compare against. Gated behind
 * `RUN_PERF_BASELINE=true` for the same reason as the backend baseline spec: a measurement tool,
 * not a correctness test, and not something ordinary `playwright test` runs should pay for.
 *
 * Run explicitly (backend on :3000, frontend on :5173 already running, per this repo's existing
 * e2e convention — see smoke.spec.ts):
 *   RUN_PERF_BASELINE=true npx playwright test web/performance-baseline.spec.ts
 *
 * Measures, using only the real browser's own Navigation/Resource Timing APIs — no instrumentation
 * added to the frontend source itself:
 *   - cold shell-ready: time from navigation start to the /login page's first paint.
 *   - cold authorized-data-ready: time from clicking "Sign In" to the post-login shell (sidebar)
 *     actually visible — i.e. the point a user can do something, not just "got a 200".
 *   - number of distinct HTTP requests fired between login submit and that shell being visible.
 *   - warm navigation: time to switch to an already-visited in-app route (Settings).
 *
 * Output: `.audit/p1a-baseline/frontend-baseline-<timestamp>.json` (gitignored, same location
 * convention as the backend artifact).
 */
test.skip(process.env.RUN_PERF_BASELINE !== 'true', 'gated — perf baseline capture, not a correctness test');

const BASE_URL = 'http://127.0.0.1:5173';
const EMAIL = 'manager.a.e2e@example.test';
const PASSWORD = 'ChangeMe123!';

test('P1A frontend baseline: cold shell-ready, cold authorized-data-ready, request count, warm navigation', async ({ page }) => {
  const requestsDuringLogin: string[] = [];

  // ---- cold shell-ready: the /login page itself ----
  const coldLoginNav = await page.goto(`${BASE_URL}/login`);
  await page.getByLabel('Email').waitFor({ state: 'visible' });
  const loginPaintTiming = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    const paint = performance.getEntriesByType('paint').find((e) => e.name === 'first-contentful-paint');
    return { domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventEnd) : null, firstContentfulPaintMs: paint ? Math.round(paint.startTime) : null };
  });

  await page.getByLabel('Email').fill(EMAIL);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Password').fill(PASSWORD);

  page.on('request', (req) => requestsDuringLogin.push(req.url()));

  const loginStart = Date.now();
  await page.getByRole('button', { name: 'Sign in' }).click();
  // "authorized-data-ready" = the post-login shell's own nav is actually visible, not merely URL==/.
  await page.locator('.sidebar-nav', { hasText: 'Dashboard' }).waitFor({ state: 'visible', timeout: 15_000 });
  const coldAuthorizedDataReadyMs = Date.now() - loginStart;
  const requestCountDuringLogin = requestsDuringLogin.length;
  const apiRequestCountDuringLogin = requestsDuringLogin.filter((u) => u.includes('/rest/v1/')).length;

  // ---- warm navigation: an already-bundled in-app route ----
  const warmStart = Date.now();
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.waitForURL(/\/settings/);
  const warmNavigationMs = Date.now() - warmStart;

  const artifact = {
    capturedAt: new Date().toISOString(),
    note: 'P1A frontend baseline — compare against P1G final benchmark, not a production SLA.',
    coldShellReady: loginPaintTiming,
    coldAuthorizedDataReadyMs,
    requestCountDuringLogin,
    apiRequestCountDuringLogin,
    warmNavigationMs,
  };

  const dir = path.join(process.cwd(), '..', '..', '.audit', 'p1a-baseline');
  mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, `frontend-baseline-${Date.now()}.json`);
  writeFileSync(outPath, JSON.stringify(artifact, null, 2));
  // eslint-disable-next-line no-console
  console.log(`P1A frontend baseline written to ${outPath}\n${JSON.stringify(artifact, null, 2)}`);

  void coldLoginNav; // navigation result only used to let Playwright await the initial goto
});
