import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';

/**
 * U4 / U6 / U7 visual regression (owner pre-approval 2026-10-26): one baseline per new Settings → AI state, light and
 * dark, from the REAL rab-front with the fictional rab-docs fixtures (no backend, no model, no real data). Baselines are
 * Crewflow's own captures, never the mockups. Run with playwright.u-settings.config.ts against a running Vite on :5199.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { install } = require(path.resolve(__dirname, '../../../rab-docs/tools/web/fixtures.cjs'));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { installAi } = require(path.resolve(__dirname, '../../../rab-docs/tools/web/ai-twenty-parity-fixtures.cjs'));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { installUSettings, installAdminAi } = require(path.resolve(__dirname, '../../../rab-docs/tools/web/ai-u-settings-fixtures.cjs'));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { installAdmin } = require(path.resolve(__dirname, '../../../rab-docs/tools/web/admin-panel-fixtures.cjs'));

const WEB = process.env.U_SETTINGS_WEB ?? 'http://localhost:5199';

async function open(page: Page, theme: 'light' | 'dark', variant: Record<string, unknown> = {}) {
  await install(page, { persona: 'ceo', theme });
  await installAi(page, {});
  await installUSettings(page, WEB, variant);
}
const settle = async (page: Page) => {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
};
const snap = async (page: Page, name: string) => expect(page).toHaveScreenshot(`${name}.png`, { animations: 'disabled', maxDiffPixelRatio: 0.01 });
const toSection = async (page: Page, selector: string) => {
  // Scrolls only the page's own scroll container (never the window), so the app shell stays put.
  await page.locator(selector).first().evaluate((el) => { const t = el.closest('.settings-section') ?? el; let p = t.parentElement; while (p && !(/(auto|scroll)/.test(getComputedStyle(p).overflowY) && p.scrollHeight > p.clientHeight)) p = p.parentElement; if (p) p.scrollTop += t.getBoundingClientRect().top - p.getBoundingClientRect().top - 8; });
  await page.waitForTimeout(200);
};

for (const theme of ['light', 'dark'] as const) {
  test.describe(`U-settings · ${theme}`, () => {
    test.use({ viewport: { width: 1440, height: 900 }, colorScheme: theme, reducedMotion: 'reduce', locale: 'en-GB', timezoneId: 'Europe/London' });

    test('U4 Overview (top and lower)', async ({ page }) => {
      await open(page, theme);
      await page.goto(`${WEB}/settings/ai`);
      await settle(page);
      await expect(page.getByRole('heading', { name: 'At a glance' })).toBeVisible();
      await snap(page, `u4-overview-${theme}`);
      await toSection(page, '#ai-mcp-title');
      await expect(page.getByText('Coming later')).toBeVisible();
      await snap(page, `u4-overview-lower-${theme}`);
    });

    test('U4 System prompt page (with and without the S9 skill list)', async ({ page }) => {
      await open(page, theme);
      await page.goto(`${WEB}/settings/ai?tab=overview&page=prompt`);
      await settle(page);
      await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toBeVisible();
      await snap(page, `u4-prompt-${theme}`);
      await toSection(page, '#ai-prompt-skills');
      await snap(page, `u4-prompt-skills-${theme}`);
    });

    test('U4 System prompt · skill list not sent yet', async ({ page }) => {
      await open(page, theme, { promptSkills: false });
      await page.goto(`${WEB}/settings/ai?tab=overview&page=prompt`);
      await settle(page);
      await toSection(page, '#ai-prompt-skills');
      await expect(page.getByText(/This server doesn’t send the list of skills/)).toBeVisible();
      await snap(page, `u4-prompt-skills-missing-${theme}`);
    });

    test('U4 Skills list, standard skill, custom skill', async ({ page }) => {
      await open(page, theme);
      await page.goto(`${WEB}/settings/ai?tab=skills`);
      await settle(page);
      await expect(page.getByRole('table', { name: 'Skills' })).toBeVisible();
      await snap(page, `u4-skills-${theme}`);
      await page.goto(`${WEB}/settings/ai?tab=skills&skill=shift-filling`);
      await settle(page);
      await expect(page.getByText('Standard skill: only on/off can change.')).toBeVisible();
      await snap(page, `u4-skill-standard-${theme}`);
      await page.goto(`${WEB}/settings/ai?tab=skills&skill=riverside-bar-rules`);
      await settle(page);
      await expect(page.getByText('/ 20,000')).toBeVisible();
      await snap(page, `u4-skill-custom-${theme}`);
    });

    test('U4 Tools list and tool page', async ({ page }) => {
      await open(page, theme);
      await page.goto(`${WEB}/settings/ai?tab=tools`);
      await settle(page);
      await expect(page.getByRole('table', { name: 'Assistant tools' })).toBeVisible();
      await snap(page, `u4-tools-${theme}`);
      await page.goto(`${WEB}/settings/ai?tab=tools&tool=list_unfilled_shifts`);
      await settle(page);
      await expect(page.getByRole('table', { name: 'Parameters' })).toBeVisible();
      await snap(page, `u4-tool-${theme}`);
    });

    test('U6 Agents list and agent page tabs', async ({ page }) => {
      await open(page, theme);
      await page.goto(`${WEB}/settings/ai?tab=agents`);
      await settle(page);
      await expect(page.getByRole('table', { name: 'Agents' })).toBeVisible();
      await snap(page, `u6-agents-list-${theme}`);
      await page.goto(`${WEB}/settings/ai?tab=agents&agent=ag-1`);
      await settle(page);
      await expect(page.getByRole('tab', { name: 'Runs' })).toBeDisabled();
      await snap(page, `u6-agent-settings-${theme}`);
      await page.getByRole('tab', { name: 'Role' }).click();
      await expect(page.getByRole('checkbox', { name: 'See shifts' })).toBeVisible();
      await snap(page, `u6-agent-role-${theme}`);
      await page.getByRole('tab', { name: 'Triggers' }).click();
      await expect(page.getByRole('button', { name: 'Turn on' }).first()).toBeDisabled();
      await snap(page, `u6-agent-triggers-${theme}`);
      await page.getByRole('button', { name: 'Add trigger' }).click();
      await expect(page.getByRole('group', { name: 'New trigger' })).toBeVisible();
      await snap(page, `u6-agent-trigger-add-${theme}`);
      await page.keyboard.press('Escape');
      await expect(page.getByRole('group', { name: 'New trigger' })).toHaveCount(0);
    });

    test('U6 standard agent (read-only)', async ({ page }) => {
      await open(page, theme);
      await page.goto(`${WEB}/settings/ai?tab=agents&agent=ag-3`);
      await settle(page);
      await expect(page.getByText('Standard agent: it can’t be edited or deleted.')).toBeVisible();
      await snap(page, `u6-agent-standard-${theme}`);
    });

    test('U7 Usage with the daily series, a day read by keyboard, the tables', async ({ page }) => {
      await open(page, theme);
      await page.goto(`${WEB}/settings/ai?tab=usage`);
      await settle(page);
      await expect(page.getByRole('group', { name: /Daily estimated cost/ })).toBeVisible();
      await snap(page, `u7-usage-${theme}`);
      await page.locator('.ai-usage-chart').focus();
      await page.keyboard.press('End');
      await page.keyboard.press('ArrowLeft');
      await expect(page.locator('.ai-usage-tip')).toBeVisible();
      await snap(page, `u7-usage-tooltip-${theme}`);
      await page.keyboard.press('Escape');
      await expect(page.locator('.ai-usage-tip')).toHaveCount(0);
      await toSection(page, '#ai-usage-people');
      await snap(page, `u7-usage-tables-${theme}`);
    });

    test('U7 Usage before S8', async ({ page }) => {
      await open(page, theme, { daily: false });
      await page.goto(`${WEB}/settings/ai?tab=usage`);
      await settle(page);
      await expect(page.getByText(/The daily series arrives with the next server update/)).toBeVisible();
      await snap(page, `u7-usage-no-daily-${theme}`);
    });

    test('U7 Admin panel AI usage (7b fields)', async ({ page }) => {
      await install(page, { persona: 'platformAdmin', theme });
      await page.addInitScript(() => { try { localStorage.setItem('cf-admin-tab', 'health'); } catch { /* blocked */ } });
      await installAdmin(page, { origin: WEB });
      await installAdminAi(page, WEB);
      await page.goto(`${WEB}/settings/admin`);
      await settle(page);
      const table = page.locator('.ap-block[aria-label="AI assistant health"] .ap-tablewrap');
      await table.scrollIntoViewIfNeeded();
      await expect(page.getByText('Cost 80 %')).toBeVisible();
      await expect(table).toHaveScreenshot(`u7-admin-usage-${theme}.png`, { animations: 'disabled', maxDiffPixelRatio: 0.01 });
    });
  });
}
