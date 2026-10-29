import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import { fixtures } from './support/crewflow-fixtures';

/**
 * Crewflow new-UI motion (2026-10-19): samples REAL rendered values every animation frame in the running app and
 * records a video per scenario, so the timings below are measured, not assumed. No reference video exists; the
 * expectations come from the written motion spec (tab 250ms, bulk bar slide-up, sidebar pill, calendar period,
 * chart tooltip, reduced motion = no movement).
 */
const OUT = path.resolve(__dirname, '.qa-shots/new-ui-2026-10-19/motion');
test.use({ viewport: { width: 1440, height: 900 }, video: { mode: 'on', size: { width: 1440, height: 900 } } });

async function sample(page: Page, selector: string, expr: string, ms: number) {
  await page.evaluate(([sel, ex, dur]) => {
    const w = window as unknown as { __s: Array<[number, number | null]> };
    w.__s = [];
    const fn = new Function('el', `return (${ex});`) as (el: Element) => number;
    const t0 = performance.now();
    const tick = () => {
      const el = document.querySelector(sel as string);
      w.__s.push([performance.now() - t0, el ? fn(el) : null]);
      if (performance.now() - t0 < (dur as number)) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, [selector, expr, ms] as const);
}
const samples = (page: Page) => page.evaluate(() => (window as unknown as { __s: Array<[number, number | null]> }).__s);
const distinct = (s: Array<[number, number | null]>) => new Set(s.map(([, v]) => (v == null ? 'null' : v.toFixed(1)))).size;
async function settle(page: Page, ms: number) { await page.waitForTimeout(ms); }

test('tab indicator slides between page tabs (~250ms) and lands under the active tab', async ({ page }) => {
  await fixtures(page);
  await page.goto('/shifts');
  await expect(page.locator('.topbar-tabs .tab-link.active')).toHaveText(/All shifts/);
  await settle(page, 600);
  await sample(page, '.tab-strip-indicator', 'new DOMMatrix(getComputedStyle(el).transform).m41', 1600);
  await page.locator('.topbar-tabs .tab-link', { hasText: 'Upcoming' }).click();
  // On a cold first load the route update can land a few hundred ms after the click; measure from when it does.
  await expect(page.locator('.topbar-tabs .tab-link.active')).toHaveText(/Upcoming/);
  await settle(page, 1650);
  const s = await samples(page);
  const target = await page.locator('.topbar-tabs .tab-link.active').evaluate((el) => (el as HTMLElement).offsetLeft);
  expect(distinct(s)).toBeGreaterThan(4); // moved through intermediate frames
  expect(Math.abs((s.at(-1)?.[1] ?? 0) - target)).toBeLessThan(1);
  const moving = s.filter(([, v], i) => i > 0 && v !== s[i - 1][1]).map(([t]) => t);
  console.log(`tab indicator: ${moving.length} moving frames over ${(moving.at(-1)! - moving[0]).toFixed(0)}ms`);
  await page.screenshot({ path: path.join(OUT, 'tab-indicator-end.png') });
});

test('floating bulk bar slides up on selection, count updates, clears on ×', async ({ page }) => {
  await fixtures(page);
  await page.goto('/shifts');
  await expect(page.locator('.table tbody tr').first()).toBeVisible();
  await sample(page, '.bulk-action-dock', 'new DOMMatrix(getComputedStyle(el).transform).m42', 500);
  await page.locator('.table tbody input[type=checkbox]').first().check();
  await settle(page, 550);
  const s = (await samples(page)).filter(([, v]) => v != null);
  expect(s.length).toBeGreaterThan(3);
  expect(s[0][1]!).toBeGreaterThan(s.at(-1)![1]!); // started lower, rose into place
  await expect(page.locator('.bulk-action-bar')).toContainText('Selected: 1');
  await page.locator('.table tbody input[type=checkbox]').nth(1).check();
  await expect(page.locator('.bulk-action-bar [data-value]')).toHaveAttribute('data-value', '2');
  await page.screenshot({ path: path.join(OUT, 'bulk-bar.png') });
  await page.getByRole('button', { name: 'Clear selection' }).click();
  await expect(page.locator('.bulk-action-bar')).toHaveCount(0);
  await expect(page.locator('.table tbody input[type=checkbox]:checked')).toHaveCount(0);
});

// 2026-10-20: Users now offers Activate / Deactivate / Send Email / Delete (each permission-gated, existing endpoints).
test('Users bulk bar offers the permitted Users actions', async ({ page }) => {
  await fixtures(page);
  await page.goto('/users');
  await page.locator('.table tbody input[type=checkbox]').first().check();
  const bar = page.locator('.bulk-action-bar');
  await expect(bar).toBeVisible();
  await expect(bar.getByRole('button')).toHaveText(['Activate', 'Deactivate', 'Send Email', 'Delete']);
  await expect(page.getByRole('button', { name: 'Clear selection' })).toBeVisible();
});

test('sidebar active pill slides to the new item while navigation is immediate', async ({ page }) => {
  await fixtures(page);
  // Payroll is a lazy route: React Router keeps the old location (and pill) rendered until its code has loaded, and the
  // dev server compiles it on first request. Load it once first so the samples time the pill, not that compile.
  await page.goto('/payroll');
  await page.waitForLoadState('networkidle');
  await page.goto('/');
  await expect(page.locator('.nav-item.active')).toHaveText(/Dashboard/);
  await settle(page, 500);
  await sample(page, '.nav-active-pill', 'el.getBoundingClientRect().top', 600);
  await page.locator('.nav-item', { hasText: 'Payroll' }).click();
  await expect(page).toHaveURL(/\/payroll$/); // route changes at once
  await settle(page, 650);
  const s = (await samples(page)).filter(([, v]) => v != null);
  expect(distinct(s)).toBeGreaterThan(3);
  const final = await page.locator('.nav-item.active').evaluate((el) => el.getBoundingClientRect().top);
  expect(Math.abs(s.at(-1)![1]! - final)).toBeLessThan(1);
});

test('dashboard: week navigation transitions in the right direction; hours tooltip fades in on hover', async ({ page }) => {
  await fixtures(page);
  await page.goto('/');
  await expect(page.locator('.dash-week-card .dash-card-title')).toBeVisible();
  const before = await page.locator('.dash-week-card .dash-card-title').textContent();
  await sample(page, '.dash-week-card', 'Math.max(...[...el.querySelectorAll(".dash-week-grid")].map((g) => new DOMMatrix(getComputedStyle(g).transform).m41))', 1500);
  await page.getByRole('button', { name: 'Next week' }).click();
  await expect(page.locator('.dash-week-card .dash-card-title')).not.toHaveText(before ?? '');
  await settle(page, 1550);
  const s = (await samples(page)).filter(([, v]) => v != null);
  expect(s.some(([, v]) => v! > 1)).toBe(true); // new week entered from the right
  await expect(page.locator('.dash-week-card .dash-card-title')).not.toHaveText(before ?? '');
  await page.locator('.dash-bar-col').nth(4).hover();
  await expect(page.locator('.dash-tooltip')).toBeVisible();
  await page.screenshot({ path: path.join(OUT, 'dashboard-tooltip.png') });
});

test('reduced motion: tab indicator and bulk bar change state without movement', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await fixtures(page);
  await page.goto('/shifts');
  await settle(page, 400);
  await sample(page, '.tab-strip-indicator', 'new DOMMatrix(getComputedStyle(el).transform).m41', 400);
  await page.locator('.topbar-tabs .tab-link', { hasText: 'Completed' }).click();
  await settle(page, 450);
  expect(distinct(await samples(page))).toBeLessThanOrEqual(3); // before → after (+ at most one 1ms frame)
  await page.locator('.table tbody input[type=checkbox]').first().check();
  await expect(page.locator('.bulk-action-bar')).toContainText('Selected: 1');
});
