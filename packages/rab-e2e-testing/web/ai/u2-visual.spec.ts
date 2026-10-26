import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';

/**
 * U2 visual regression (owner approval 2026-10-26, docs/ai/UI_U2_U8_PLAN.md §B): the answer (steps, a table, record
 * chips, the level · model · cost footer), an expanded tool step, the usage popover with real S1 figures, and the Ask AI
 * panel opened with Ctrl+J showing a running answer with one queued question and Stop — light and dark. The REAL
 * rab-front with the fictional rab-docs fixtures (no backend, no model, no real data). Run with playwright.u2.config.ts
 * against a running Vite of this worktree (U2_WEB, default http://localhost:5198).
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { install } = require(path.resolve(__dirname, '../../../rab-docs/tools/web/fixtures.cjs'));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { installAi, captureStreamShim, STREAM_PLAN } = require(path.resolve(__dirname, '../../../rab-docs/tools/web/ai-twenty-parity-fixtures.cjs'));

const WEB = process.env.U2_WEB ?? 'http://localhost:5198';
const TITLE = 'Which shifts this weekend are unfilled?';

async function open(page: Page, theme: 'light' | 'dark', state: Record<string, unknown>, frames?: unknown[]) {
  await install(page, { persona: 'ceo', theme });
  await installAi(page, state);
  if (frames) await captureStreamShim(page, frames);
}
const settle = async (page: Page, ms = 500) => {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(ms);
};
const shot = (name: string) => ({ name: `${name}.png`, opts: { animations: 'disabled' as const, maxDiffPixelRatio: 0.01 } });

for (const theme of ['light', 'dark'] as const) {
  test.describe(`U2 · ${theme}`, () => {
    test.use({ viewport: { width: 1440, height: 900 }, colorScheme: theme, reducedMotion: 'reduce', locale: 'en-GB', timezoneId: 'Europe/London' });

    test('2 Answer: steps, table, record chips, footer; a step expanded; usage popover', async ({ page }) => {
      await open(page, theme, { conversation: 'u2answer' });
      await page.goto(`${WEB}/chat`);
      await settle(page);
      await page.getByRole('button', { name: TITLE }).first().click();
      await expect(page.getByRole('link', { name: 'Shift: Sat 31 Oct · 18:00' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Venue: Example Riverside Bar' })).toBeVisible();
      await expect(page.getByText('Record unavailable')).toBeVisible();
      await expect(page.getByRole('table')).toBeVisible();
      await page.locator('.ai-message.assistant').hover();
      await expect(page.getByText('Extra fast · Claude Haiku 5.5 · $0.0011')).toBeVisible();
      let s = shot(`answer-${theme}`);
      await expect(page).toHaveScreenshot(s.name, s.opts);

      const step = page.getByRole('button', { name: /Shift filling/ });
      await step.click();
      await expect(step).toHaveAttribute('aria-expanded', 'true');
      await expect(page.getByText('Inputs and outputs aren’t shown.', { exact: false })).toBeVisible();
      s = shot(`answer-step-open-${theme}`);
      await expect(page.locator('.ai-message.assistant')).toHaveScreenshot(s.name, s.opts);

      await page.getByRole('button', { name: 'Context and usage' }).click();
      const pop = page.locator('.ai-popover-body');
      await pop.getByRole('button', { name: 'More' }).click();
      await expect(pop.getByText('$0.0011')).toBeVisible();
      await expect(pop.getByText('$0.0034')).toBeVisible();
      s = shot(`usage-more-${theme}`);
      await expect(page).toHaveScreenshot(s.name, s.opts);
      await page.keyboard.press('Escape');
      await expect(pop).toHaveCount(0);
    });

    test('3 Ask AI panel: Ctrl+J, history, a running answer with one queued question and Stop', async ({ page }) => {
      await open(page, theme, { conversation: 'u2queued' }, STREAM_PLAN);
      await page.goto(`${WEB}/`);
      await settle(page, 800);
      await page.keyboard.press('Control+j');
      const panel = page.getByRole('complementary', { name: 'Ask AI' });
      await expect(panel).toBeVisible();
      await panel.getByRole('button', { name: 'Show history' }).click();
      await panel.getByRole('button', { name: TITLE }).first().click();
      await expect(panel.getByRole('article', { name: 'Your queued question' })).toBeVisible();
      await expect(panel.getByRole('button', { name: 'Stop response' })).toBeVisible();
      await expect(panel.getByRole('button', { name: /^Send message/ })).toHaveCount(0);
      await settle(page, 400);
      const s = shot(`panel-queued-${theme}`);
      await expect(page).toHaveScreenshot(s.name, s.opts);
      await page.keyboard.press('Control+j');
      await expect(panel).toBeHidden();
    });
  });
}
