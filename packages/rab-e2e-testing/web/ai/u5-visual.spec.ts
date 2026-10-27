import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';

/**
 * U5 visual regression (owner approval 2026-10-26): the approval card (diff from previousValue, only proposed fields
 * editable, ⌘/Ctrl+↵), the reject box, a high-impact card (reason + step-up note), the question card and a form card with
 * its validation — light and dark. The REAL rab-front with the fictional rab-docs fixtures (no backend, no model, no real
 * data). Run with playwright.u5.config.ts against a running Vite of this worktree (U5_WEB, default http://localhost:5198).
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { install } = require(path.resolve(__dirname, '../../../rab-docs/tools/web/fixtures.cjs'));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { installAi } = require(path.resolve(__dirname, '../../../rab-docs/tools/web/ai-twenty-parity-fixtures.cjs'));

const WEB = process.env.U5_WEB ?? 'http://localhost:5198';
const TITLE = 'Which shifts this weekend are unfilled?';

async function open(page: Page, theme: 'light' | 'dark', conversation: string, cards: string) {
  await install(page, { persona: 'ceo', theme });
  await installAi(page, { conversation, cards });
  await page.goto(`${WEB}/chat`);
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.getByRole('button', { name: TITLE }).first().click();
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
}
const shot = (name: string) => ({ name: `${name}.png`, opts: { animations: 'disabled' as const, maxDiffPixelRatio: 0.01 } });

for (const theme of ['light', 'dark'] as const) {
  test.describe(`U5 · ${theme}`, () => {
    test.use({ viewport: { width: 1440, height: 900 }, colorScheme: theme, reducedMotion: 'reduce', locale: 'en-GB', timezoneId: 'Europe/London' });

    test('4 Approval: card, reject box, approve with Ctrl+Enter', async ({ page }) => {
      await open(page, theme, 'u5approval', 'approval');
      const card = page.getByRole('region', { name: 'Update a draft shift' });
      await expect(card.getByText('Needs your approval', { exact: true })).toBeVisible();
      await expect(card.getByLabel('Was 2')).toBeVisible();
      await expect(card.getByLabel('Role')).toHaveCount(0); // not editable
      let s = shot(`approval-${theme}`);
      await expect(page).toHaveScreenshot(s.name, s.opts);
      await card.getByRole('button', { name: 'Reject' }).click();
      await card.getByLabel('Tell Crewflow why').fill('Keep 18:00, only add the extra place.');
      s = shot(`approval-reject-${theme}`);
      await expect(card).toHaveScreenshot(s.name, s.opts);
      await card.getByRole('button', { name: 'Cancel' }).click();
      await card.getByLabel('Places').focus();
      await page.keyboard.press('Control+Enter');
      await expect(card.getByText('Done', { exact: true })).toBeVisible();
      s = shot(`approval-done-${theme}`);
      await expect(card).toHaveScreenshot(s.name, s.opts);
    });

    test('4 Approval · high impact: reason + "Confirm it’s you" note', async ({ page }) => {
      await open(page, theme, 'u5approval', 'highImpact');
      const card = page.getByRole('region', { name: 'Update a draft shift' });
      await expect(card.getByText(/affects 14 people/)).toBeVisible();
      await expect(card.getByRole('button', { name: /^Approve/ })).toBeDisabled();
      const s = shot(`approval-high-${theme}`);
      await expect(card).toHaveScreenshot(s.name, s.opts);
    });

    test('5 Question and a form with validation', async ({ page }) => {
      await open(page, theme, 'u5question', 'question');
      const q = page.getByRole('region', { name: 'A question for you' });
      await expect(q.getByRole('button', { name: 'Yes, past staff at this venue only' })).toBeVisible();
      let s = shot(`question-${theme}`);
      await expect(page).toHaveScreenshot(s.name, s.opts);

      await open(page, theme, 'u5question', 'form');
      const f = page.getByRole('region', { name: 'Shift details' });
      await f.getByRole('button', { name: 'Send answers' }).click();
      await expect(f.getByText('Required.')).toHaveCount(2);
      s = shot(`form-invalid-${theme}`);
      await expect(f).toHaveScreenshot(s.name, s.opts);
    });
  });
}
