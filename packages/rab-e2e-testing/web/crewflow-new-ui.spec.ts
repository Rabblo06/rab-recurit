import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fixtures } from './support/crewflow-fixtures';

/**
 * Crewflow new UI (2026-10-19): screenshots of the REAL app (isolated Vite :5174) for every main screen at the
 * reference widths, against deterministic API fixtures (no live data; names are obviously test data). Compared by eye
 * against "01 · Workspace windows · Your new UI.png". Run with playwright.isolated.config.ts.
 *   UI_WIDTHS=1440 npx playwright test -c packages/rab-e2e-testing/playwright.isolated.config.ts crewflow-new-ui
 */
const OUT = path.resolve(__dirname, '.qa-shots/new-ui-2026-10-19');
const WIDTHS: Array<[number, number]> = (process.env.UI_WIDTHS ?? '1920,1440,1366,390')
  .split(',').map(Number).map((w) => [w, w === 1920 ? 1080 : w === 1440 ? 900 : w === 1366 ? 768 : 844]);

const SCREENS: Array<[string, string]> = [
  ['dashboard', '/'], ['users-staff', '/users'], ['users-managers', '/users?tab=managers'], ['shifts', '/shifts'], ['offers', '/offers'],
  ['payroll', '/payroll'], ['venues', '/venues'], ['venue-offers', '/venue-offers'], ['calendar', '/calendar'], ['audit', '/audit'], ['venue-pipeline', '/venue-offers/shift-2'], ['settings', '/settings/profile'],
];

for (const [w, h] of WIDTHS) {
  test.describe(`${w}px`, () => {
    test.use({ viewport: { width: w, height: h } });
    for (const [name, url] of SCREENS) {
      test(`${name}`, async ({ page }) => {
        await fixtures(page);
        await page.goto(url);
        await expect(page.locator('.app-layout')).toBeVisible();
        await page.waitForTimeout(1500);
        await page.screenshot({ path: path.join(OUT, `${w}`, `${name}.png`) });
      });
    }
  });
}
