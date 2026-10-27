import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';

/**
 * U3 visual regression (owner approval 2026-10-26, docs/ai/UI_U2_U8_PLAN.md): the composer's "＋ Tag a skill" menu (also
 * opened with "/"), two tagged skills as chips, and "See what I can do" from GET /ai/capabilities — light and dark. The
 * REAL rab-front with the fictional rab-docs fixtures (no backend, no model, no real data). Run with
 * playwright.u3.config.ts against a running Vite of this worktree (U3_WEB, default http://localhost:5198).
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { install } = require(path.resolve(__dirname, '../../../rab-docs/tools/web/fixtures.cjs'));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { installAi } = require(path.resolve(__dirname, '../../../rab-docs/tools/web/ai-twenty-parity-fixtures.cjs'));

const WEB = process.env.U3_WEB ?? 'http://localhost:5198';

async function open(page: Page, theme: 'light' | 'dark') {
  await install(page, { persona: 'ceo', theme });
  await installAi(page, {});
  await page.goto(`${WEB}/chat`);
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
}
const shot = (name: string) => ({ name: `${name}.png`, opts: { animations: 'disabled' as const, maxDiffPixelRatio: 0.01 } });

for (const theme of ['light', 'dark'] as const) {
  test.describe(`U3 · ${theme}`, () => {
    test.use({ viewport: { width: 1440, height: 900 }, colorScheme: theme, reducedMotion: 'reduce', locale: 'en-GB', timezoneId: 'Europe/London' });

    test('skill tags: "/" opens the menu, at most two, chips in the composer', async ({ page }) => {
      await open(page, theme);
      const box = page.getByRole('textbox', { name: 'Message Crewflow AI' });
      await expect(page.getByRole('button', { name: 'Tag a skill' })).toBeVisible();
      await box.focus();
      await page.keyboard.press('/');
      const menu = page.getByRole('menu', { name: 'Skills' });
      await expect(menu).toBeVisible();
      await expect(box).toHaveValue('');
      await page.keyboard.press('Enter'); // the first item has focus
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Space');
      await expect(menu.getByRole('menuitemcheckbox', { checked: true })).toHaveCount(2);
      await expect(menu.locator('[aria-disabled="true"]').first()).toBeVisible();
      let s = shot(`tag-menu-${theme}`);
      await expect(page).toHaveScreenshot(s.name, s.opts);
      await page.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Tag a skill' })).toBeFocused();
      await box.fill('Who could cover Saturday evening?');
      await expect(page.getByRole('list', { name: 'Tagged skills' }).getByRole('listitem')).toHaveCount(2);
      s = shot(`tag-chips-${theme}`);
      await expect(page.locator('.ai-composer-area')).toHaveScreenshot(s.name, s.opts);
    });

    test('"See what I can do" lists the server’s tools and skills', async ({ page }) => {
      await open(page, theme);
      await page.getByRole('button', { name: 'See what I can do' }).click();
      const sheet = page.getByRole('dialog', { name: 'What I can do' });
      await expect(sheet).toBeVisible();
      await expect(page.getByRole('button', { name: 'Draft a rota' })).toHaveCount(0); // approval cards ship in U5
      const s = shot(`capabilities-${theme}`);
      await expect(page).toHaveScreenshot(s.name, s.opts);
      await page.keyboard.press('Escape');
      await expect(sheet).toHaveCount(0);
    });
  });
}
