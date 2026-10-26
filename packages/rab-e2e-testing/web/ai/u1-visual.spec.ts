import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';

/**
 * U1 visual regression (owner approval 2026-10-26): one screenshot baseline per U1 state, light and dark, from the REAL
 * rab-front with the fictional rab-docs fixtures (no backend, no model, no real data). Baselines are Crewflow's own
 * captures, never the mockups. Run with playwright.u1.config.ts against a running Vite (U1_WEB).
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { install } = require(path.resolve(__dirname, '../../../rab-docs/tools/web/fixtures.cjs'));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { installAi } = require(path.resolve(__dirname, '../../../rab-docs/tools/web/ai-twenty-parity-fixtures.cjs'));

const WEB = process.env.U1_WEB ?? 'http://localhost:5198';
const LIMITS = { maxInputChars: 4000, userRatePerMinute: 10, orgDailyTokenBudget: 200000 };

async function open(page: Page, theme: 'light' | 'dark', state: Record<string, unknown> = {}, availability?: Record<string, unknown>) {
  await install(page, { persona: 'ceo', theme });
  await installAi(page, state);
  if (availability) {
    await page.route('**/rest/v1/ai/availability', (r) =>
      r.fulfill({ status: 200, headers: { 'access-control-allow-origin': WEB, 'access-control-allow-credentials': 'true', 'content-type': 'application/json' }, body: JSON.stringify({ limits: LIMITS, usage: null, levels: null, assistant: null, ...availability }) }),
    );
  }
}
const settle = async (page: Page) => {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
};
const shot = (name: string) => ({ name: `${name}.png`, opts: { animations: 'disabled' as const, maxDiffPixelRatio: 0.01 } });

for (const theme of ['light', 'dark'] as const) {
  test.describe(`U1 · ${theme}`, () => {
    test.use({ viewport: { width: 1440, height: 900 }, colorScheme: theme, reducedMotion: 'reduce', locale: 'en-GB', timezoneId: 'Europe/London' });

    test('chat 1 Empty', async ({ page }) => {
      await open(page, theme);
      await page.goto(`${WEB}/chat`);
      await settle(page);
      await expect(page.getByRole('heading', { name: 'How can I help you?' })).toBeVisible();
      const s = shot(`chat-empty-${theme}`);
      await expect(page).toHaveScreenshot(s.name, s.opts);
    });

    for (const [kind, availability] of [
      ['provider', { available: false, reason: 'not_configured', setup: 'provider', message: "AI isn't set up yet. A platform admin needs to add a provider key" }],
      ['model', { available: false, reason: 'not_configured', setup: 'model', message: 'Choose a model in Settings → AI' }],
      ['demo', { available: false, reason: 'demo_data_only', message: 'AI is available for demo data only until the provider checklist is complete.' }],
    ] as const) {
      test(`chat 6 Unavailable · ${kind}`, async ({ page }) => {
        await open(page, theme, {}, availability);
        await page.goto(`${WEB}/chat`);
        await settle(page);
        await expect(page.locator(`.ai-banner[data-kind="${kind}"]`)).toBeVisible();
        const s = shot(`chat-unavailable-${kind}-${theme}`);
        await expect(page).toHaveScreenshot(s.name, s.opts);
      });
    }

    test('chat 6 Unavailable · turn failed', async ({ page }) => {
      await open(page, theme, { conversation: 'failed' });
      await page.goto(`${WEB}/chat`);
      await settle(page);
      await page.getByRole('button', { name: 'Which shifts this weekend are unfilled?' }).first().click();
      await expect(page.locator('.ai-banner[data-kind="failed"]')).toBeVisible();
      const s = shot(`chat-turn-failed-${theme}`);
      await expect(page).toHaveScreenshot(s.name, s.opts);
    });

    test('tier picker, model card and model details', async ({ page }) => {
      await open(page, theme);
      await page.goto(`${WEB}/chat`);
      await settle(page);
      await page.getByRole('button', { name: /^Level:/ }).click();
      await expect(page.getByRole('slider', { name: 'Answer level' })).toBeVisible();
      let s = shot(`tier-picker-${theme}`);
      await expect(page).toHaveScreenshot(s.name, s.opts);
      await page.getByRole('button', { name: 'Model details' }).click();
      await expect(page.getByLabel('Model details', { exact: true }).first()).toBeVisible();
      s = shot(`model-details-${theme}`);
      await expect(page).toHaveScreenshot(s.name, s.opts);
      await page.keyboard.press('Escape');
      await expect(page.getByRole('slider', { name: 'Answer level' })).toHaveCount(0);
    });

    test('Settings → AI → Models', async ({ page }) => {
      await open(page, theme);
      await page.goto(`${WEB}/settings/ai?tab=models`);
      await settle(page);
      await expect(page.getByRole('table', { name: 'Answer levels' })).toBeVisible();
      let s = shot(`models-top-${theme}`);
      await expect(page).toHaveScreenshot(s.name, s.opts);
      await page.getByRole('switch', { name: 'Choose automatically' }).click();
      await expect(page.getByRole('list', { name: 'Model for each level' })).toBeVisible();
      s = shot(`models-tree-${theme}`);
      await expect(page).toHaveScreenshot(s.name, s.opts);
      await page.locator('#ai-preview-title').scrollIntoViewIfNeeded();
      s = shot(`models-preview-${theme}`);
      await expect(page).toHaveScreenshot(s.name, s.opts);
      await page.locator('#ai-catalogue-title').scrollIntoViewIfNeeded();
      s = shot(`models-catalogue-${theme}`);
      await expect(page).toHaveScreenshot(s.name, s.opts);
    });
  });
}
