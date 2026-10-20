import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import { fixtures } from './support/crewflow-fixtures';

/**
 * Settings sidebar active-page highlight (2026-10-19): the current Settings destination carries the same white rounded
 * `nav-active-pill` as the Home navigation, driven by React Router (aria-current), exactly one at a time, sliding
 * between rows. Real app on isolated Vite :5174 with fixtures. Set SHOT_TAG=before|after to label screenshots.
 */
const OUT = path.resolve(__dirname, '.qa-shots/settings-nav-2026-10-19');
const TAG = process.env.SHOT_TAG ?? 'after';
const ROUTES: Array<[string, string]> = [
  ['Profile', '/settings/profile'],
  ['Experience', '/settings/experience'],
  ['Account', '/settings/account'],
  ['General', '/settings/my-workspace'],
  ['Domains', '/settings/my-workspace/domains'],
  ['Members', '/settings/workspace/members'],
];
const nav = (page: Page) => page.getByRole('complementary', { name: 'Settings navigation' });

async function expectSelected(page: Page, label: string) {
  const current = nav(page).locator('[aria-current="page"]');
  await expect(current).toHaveCount(1);
  await expect(current).toHaveAttribute('aria-label', label);
  if (TAG === 'before') return;
  await expect(nav(page).locator('.nav-active-pill')).toHaveCount(1);
  await expect(current.locator('.nav-active-pill')).toHaveCount(1);
  // Same white rounded surface as Home's selected item.
  await expect.poll(() => current.locator('.nav-active-pill').evaluate((el) => {
    const cs = getComputedStyle(el); return `${cs.backgroundColor}|${cs.borderRadius}`;
  })).toBe('rgb(255, 255, 255)|6px');
}

test.use({ viewport: { width: 1440, height: 900 } });

for (const [label, url] of ROUTES) {
  test(`${label}: direct URL and reload select exactly one item`, async ({ page }) => {
    await fixtures(page);
    await page.goto(url);
    await expectSelected(page, label);
    await page.reload();
    await expectSelected(page, label);
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(OUT, TAG, `${label.toLowerCase()}.png`), clip: { x: 0, y: 0, width: 520, height: 600 } });
  });
}

test('clicking moves the highlight (animated), Back/Forward follow the route', async ({ page }) => {
  test.skip(TAG === 'before');
  await fixtures(page);
  await page.goto('/settings/profile');
  await expectSelected(page, 'Profile');
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const w = window as unknown as { __s: number[] }; w.__s = [];
    const t0 = performance.now();
    const tick = () => { const el = document.querySelector('[aria-label="Settings navigation"] .nav-active-pill'); if (el) w.__s.push(Math.round(el.getBoundingClientRect().top)); if (performance.now() - t0 < 600) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  await nav(page).getByRole('link', { name: 'Account' }).click();
  await expect(page).toHaveURL(/\/settings\/account$/); // navigation is not delayed by the animation
  await page.waitForTimeout(650);
  const tops = await page.evaluate(() => (window as unknown as { __s: number[] }).__s);
  expect(new Set(tops).size).toBeGreaterThan(3); // slid through intermediate positions
  await expectSelected(page, 'Account');
  await nav(page).getByRole('link', { name: 'Domains' }).click();
  await expectSelected(page, 'Domains');
  await page.goBack();
  await expectSelected(page, 'Account');
  await page.goBack();
  await expectSelected(page, 'Profile');
  await page.goForward();
  await expectSelected(page, 'Account');
});

test('nested route: the role editor under Members keeps Members selected; Domains never also lights General', async ({ page }) => {
  test.skip(TAG === 'before');
  await fixtures(page);
  await page.goto('/settings/my-workspace/domains');
  await expectSelected(page, 'Domains');
  await page.goto('/settings/workspace/members/roles/role-1');
  await expectSelected(page, 'Members');
});

test('reduced motion: the highlight jumps straight to the new row', async ({ page }) => {
  test.skip(TAG === 'before');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await fixtures(page);
  await page.goto('/settings/profile');
  await expectSelected(page, 'Profile');
  await nav(page).getByRole('link', { name: 'Experience' }).click();
  // Measure in the same frame the route becomes current (a lazy route may hold the old page briefly; that is not motion).
  const offset = await page.evaluate(() => new Promise<number>((resolve) => {
    const check = () => {
      const row = document.querySelector('[aria-label="Settings navigation"] a[aria-label="Experience"]');
      const pill = document.querySelector('[aria-label="Settings navigation"] .nav-active-pill');
      if (row?.getAttribute('aria-current') === 'page' && pill) resolve(Math.abs(pill.getBoundingClientRect().top - row.getBoundingClientRect().top));
      else requestAnimationFrame(check);
    };
    check();
  }));
  expect(offset).toBeLessThan(1);
});

test('collapsed and narrow sidebars keep exactly one selected item', async ({ page }) => {
  test.skip(TAG === 'before');
  await fixtures(page);
  await page.goto('/settings/account');
  await page.getByRole('button', { name: 'Collapse sidebar' }).click();
  await expectSelected(page, 'Account');
  await page.waitForTimeout(400); // width transition
  await expect.poll(() => nav(page).locator('.nav-active-pill').evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
  await page.screenshot({ path: path.join(OUT, TAG, 'collapsed.png'), clip: { x: 0, y: 0, width: 300, height: 600 } });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await expectSelected(page, 'Account');
  await page.screenshot({ path: path.join(OUT, TAG, 'narrow-390.png') });
});

test('Home and Settings selected items look the same', async ({ page }) => {
  test.skip(TAG === 'before');
  await fixtures(page);
  await page.goto('/shifts');
  const style = (sel: string) => page.locator(sel).evaluate((el) => { const c = getComputedStyle(el); return [c.backgroundColor, c.borderRadius, c.boxShadow].join('|'); });
  await page.waitForTimeout(400);
  const home = await style('.nav-item.active .nav-active-pill');
  await page.goto('/settings/profile');
  await page.waitForTimeout(400);
  expect(await style('[aria-label="Settings navigation"] .nav-item.active .nav-active-pill')).toBe(home);
});
