import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * U8 hardening (owner approval 2026-10-26): every AI surface, light and dark, 1440 and 390 px, with reduced motion —
 * the in-page audit (accessible names, landmark names, duplicate ids, WCAG AA contrast, no horizontal scroll, no running
 * animation), a keyboard pass with a visible focus indicator on every AI stop, Esc closing every popover / menu / sheet
 * with focus returned, and 390 px visual baselines. The REAL rab-front with the fictional rab-docs fixtures. Contrast of
 * text drawn in `--font-tertiary` is reported, not failed: that token is an open owner decision (index.css unchanged).
 * Optional `U8_OUT`: writes report.json and a screenshot per state for the compare page.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { install } = require(path.resolve(__dirname, '../../../rab-docs/tools/web/fixtures.cjs'));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { installAi, captureStreamShim, STREAM_PLAN } = require(path.resolve(__dirname, '../../../rab-docs/tools/web/ai-twenty-parity-fixtures.cjs'));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { auditPage, focusAudit } = require(path.resolve(__dirname, '../../../rab-docs/tools/web/ai-a11y-audit.cjs'));

const WEB = process.env.U8_WEB ?? 'http://localhost:5198';
const OUT = process.env.U8_OUT;
const TITLE = 'Which shifts this weekend are unfilled?';
type Problem = { impact: string; rule: string; ratio?: number; text?: string; el?: string };
const report: Record<string, Problem[]> = {};

async function open(page: Page, theme: 'light' | 'dark', state: Record<string, unknown> = {}, frames?: unknown[]) {
  await install(page, { persona: 'ceo', theme });
  await installAi(page, state);
  if (frames) await captureStreamShim(page, frames);
}
const settle = async (page: Page, ms = 500) => {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(ms);
};
const chat = async (page: Page, conversation?: boolean) => {
  // The history list is a side column at desktop width; at 390 px it sits behind the menu. The conversation is chosen at
  // desktop width and the viewport set back afterwards (the chat keeps the selection).
  const size = page.viewportSize();
  if (conversation && size && size.width < 800) await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${WEB}/chat`);
  await settle(page);
  if (conversation) {
    await page.getByRole('button', { name: TITLE }).first().click();
    await settle(page, 600);
    if (size && size.width < 800) {
      await page.setViewportSize(size);
      await settle(page, 400);
    }
  }
};

async function audit(page: Page, key: string) {
  const problems: Problem[] = await auditPage(page);
  report[key] = problems;
  if (OUT) {
    fs.mkdirSync(OUT, { recursive: true });
    await page.screenshot({ path: path.join(OUT, `${key}.png`) });
  }
  const failing = problems.filter((p) => p.impact === 'serious' || p.impact === 'moderate');
  expect(failing, `${key}: ${JSON.stringify(failing, null, 1)}`).toEqual([]);
}

test.afterAll(() => {
  if (!OUT) return;
  const file = path.join(OUT, 'report.json');
  const prev = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  fs.writeFileSync(file, JSON.stringify({ ...prev, ...report }, null, 2));
});

for (const theme of ['light', 'dark'] as const) {
  for (const width of [1440, 390] as const) {
    test.describe(`U8 audit · ${theme} · ${width}`, () => {
      test.use({ viewport: { width, height: width === 390 ? 844 : 900 }, colorScheme: theme, reducedMotion: 'reduce', locale: 'en-GB', timezoneId: 'Europe/London' });
      const k = (name: string) => `${name}-${theme}-${width}`;

      test('chat: empty, tag menu, level picker, usage popover, "See what I can do"', async ({ page }) => {
        await open(page, theme);
        await chat(page);
        await audit(page, k('empty'));
        await page.getByRole('button', { name: 'Tag a skill' }).click();
        await expect(page.getByRole('menu', { name: 'Skills' })).toBeVisible();
        await audit(page, k('tag-menu'));
        await page.keyboard.press('Escape');
        await expect(page.getByRole('button', { name: 'Tag a skill' })).toBeFocused();
        await page.getByRole('button', { name: /^Level:/ }).click();
        await expect(page.getByRole('slider', { name: 'Answer level' })).toBeVisible();
        await audit(page, k('level-picker'));
        await page.keyboard.press('Escape');
        await expect(page.getByRole('button', { name: /^Level:/ })).toBeFocused();
        await page.getByRole('button', { name: 'See what I can do' }).click();
        await expect(page.getByRole('dialog', { name: 'What I can do' })).toBeVisible();
        await audit(page, k('capabilities'));
        await page.keyboard.press('Escape');
        await expect(page.getByRole('dialog', { name: 'What I can do' })).toHaveCount(0);
      });

      test('chat: an answer (steps, table, chips) with a step open and the usage popover', async ({ page }) => {
        await open(page, theme, { conversation: 'u2answer' });
        await chat(page, true);
        await page.getByRole('button', { name: /Shift filling/ }).click();
        await audit(page, k('answer'));
        await page.getByRole('button', { name: 'Context and usage' }).click();
        await page.locator('.ai-popover-body').getByRole('button', { name: 'More' }).click();
        await audit(page, k('usage'));
        await page.keyboard.press('Escape');
        await expect(page.getByRole('button', { name: 'Context and usage' })).toBeFocused();
      });

      test('cards: approval (and the reject box), high impact, question, form', async ({ page }) => {
        await open(page, theme, { conversation: 'u5approval', cards: 'approval' });
        await chat(page, true);
        await audit(page, k('approval'));
        const card = page.getByRole('region', { name: 'Update a draft shift' });
        await card.getByRole('button', { name: 'Reject' }).click();
        await audit(page, k('approval-reject'));
        await card.getByLabel('Tell Crewflow why').press('Escape');
        await expect(card.getByRole('button', { name: /^Approve/ })).toBeVisible();
        await open(page, theme, { conversation: 'u5question', cards: 'form' });
        await chat(page, true);
        await page.getByRole('region', { name: 'Shift details' }).getByRole('button', { name: 'Send answers' }).click();
        await audit(page, k('form'));
      });
    });
  }

  test.describe(`U8 keyboard · ${theme}`, () => {
    test.use({ viewport: { width: 1440, height: 900 }, colorScheme: theme, reducedMotion: 'reduce', locale: 'en-GB', timezoneId: 'Europe/London' });

    test('every AI keyboard stop shows a visible focus indicator (answer + approval card + composer)', async ({ page }) => {
      await open(page, theme, { conversation: 'u5approval', cards: 'approval' });
      await chat(page, true);
      await page.locator('body').click({ position: { x: 5, y: 5 } });
      const { stops, missing } = await focusAudit(page, 70);
      if (OUT) fs.writeFileSync(path.join(OUT, `focus-${theme}.json`), JSON.stringify({ stops, missing }, null, 2));
      expect(stops.length).toBeGreaterThan(8);
      expect(missing, `no visible focus: ${missing.join(', ')}`).toEqual([]);
    });

    test('Ask AI panel: Ctrl+J opens, audit, Esc closes and focus returns', async ({ page }) => {
      await open(page, theme, { conversation: 'u2queued' }, STREAM_PLAN);
      await page.goto(`${WEB}/`);
      await settle(page, 800);
      const trigger = page.getByRole('button', { name: 'Ask AI', exact: true });
      await trigger.focus();
      await page.keyboard.press('Control+j');
      const panel = page.getByRole('complementary', { name: 'Ask AI' });
      await expect(panel).toBeVisible();
      await panel.getByRole('button', { name: 'Show history' }).click();
      await panel.getByRole('button', { name: TITLE }).first().click();
      await settle(page, 500);
      await audit(page, `panel-${theme}-1440`);
      await panel.getByRole('button', { name: 'Close Ask AI' }).click();
      await expect(panel).toBeHidden();
      await expect(trigger).toBeFocused();
    });
  });

  test.describe(`U8 390 px visual · ${theme}`, () => {
    test.use({ viewport: { width: 390, height: 844 }, colorScheme: theme, reducedMotion: 'reduce', locale: 'en-GB', timezoneId: 'Europe/London' });
    const shot = (name: string) => ({ name: `${name}-${theme}.png`, opts: { animations: 'disabled' as const, maxDiffPixelRatio: 0.01 } });

    test('390 px: answer, approval card, tag menu', async ({ page }) => {
      await open(page, theme, { conversation: 'u2answer' });
      await chat(page, true);
      let s = shot('m390-answer');
      await expect(page).toHaveScreenshot(s.name, s.opts);
      await open(page, theme, { conversation: 'u5approval', cards: 'approval' });
      await chat(page, true);
      await page.getByRole('region', { name: 'Update a draft shift' }).scrollIntoViewIfNeeded();
      s = shot('m390-approval');
      await expect(page).toHaveScreenshot(s.name, s.opts);
      await open(page, theme);
      await chat(page);
      await page.getByRole('button', { name: 'Tag a skill' }).click();
      await expect(page.getByRole('menu', { name: 'Skills' })).toBeVisible();
      s = shot('m390-tag-menu');
      await expect(page).toHaveScreenshot(s.name, s.opts);
    });
  });
}
