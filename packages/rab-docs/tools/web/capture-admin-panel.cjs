// Admin panel design-parity screenshots (2026-10-24). Captures the REAL rab-front Admin panel (synthetic, fictional API
// responses via fixtures.cjs + admin-panel-fixtures.cjs) and the owner's two design files at the same viewports, into
// docs/admin-panel/screenshots/. Run from the repository root with a rab-front Vite dev server up:
//
//   CREWFLOW_WEB_ORIGIN=http://127.0.0.1:5199 node packages/rab-docs/tools/web/capture-admin-panel.cjs
'use strict';

const fs = require('fs');
const path = require('path');
const { launch, openPage, settle, APP_ORIGIN } = require('./common.cjs');
const { installAdmin } = require('./admin-panel-fixtures.cjs');

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const OUT = path.join(REPO, 'docs', 'admin-panel', 'screenshots');
const MOCKUP = 'file:///' + path.join(REPO, 'docs', 'design', 'crewflow-admin-panel-mockup.html').replace(/\\/g, '/');
const SECURITY_DESIGN = 'file:///' + path.join(REPO, 'docs', 'design', 'crewflow-account-security.html').replace(/\\/g, '/');
const SIZES = [
  { name: '1440x900', viewport: { width: 1440, height: 900 } },
  { name: '1280x800', viewport: { width: 1280, height: 800 } },
  { name: '800x900', viewport: { width: 800, height: 900 } },
];
const TABS = ['general', 'health', 'config', 'security', 'workspaces', 'audit'];
const LABEL = { general: 'General', health: 'Health', config: 'Config', security: 'Security', workspaces: 'Workspaces', audit: 'Audit' };

fs.mkdirSync(OUT, { recursive: true });
const out = (name) => path.join(OUT, `${name}.png`);

async function realPanel(browser, size, problems) {
  const { context, page, errors, fx } = await openPage(browser, { persona: 'platformAdmin', viewport: size.viewport, deviceScaleFactor: 1 });
  await installAdmin(page, { origin: APP_ORIGIN });
  await page.addInitScript(() => { try { localStorage.removeItem('cf-admin-tab'); } catch { /* ignore */ } });
  await page.goto(`${APP_ORIGIN}/settings/admin`);
  await settle(page, 1500);
  for (const tab of TABS) {
    await page.getByRole('tab', { name: new RegExp(`^${LABEL[tab]}`) }).click();
    await settle(page, 900);
    await page.screenshot({ path: out(`real-${tab}-${size.name}`) });
  }
  problems.push(...errors.map((e) => `[real ${size.name}] pageerror ${e}`), ...fx.unhandled.map((u) => `[real ${size.name}] ${u}`));
  await context.close();
}

async function accountSecurityStates(browser, problems) {
  const size = SIZES[0];
  const { context, page, errors, fx } = await openPage(browser, { persona: 'platformAdmin', viewport: size.viewport, deviceScaleFactor: 1 });
  await installAdmin(page, { origin: APP_ORIGIN });
  await page.addInitScript(() => { try { localStorage.setItem('cf-admin-tab', 'general'); } catch { /* ignore */ } });
  await page.goto(`${APP_ORIGIN}/settings/admin`);
  await settle(page, 1500);
  const table = page.getByRole('region', { name: 'User security' });
  await table.scrollIntoViewIfNeeded();
  await settle(page, 400);
  await page.screenshot({ path: out(`real-user-security-table-${size.name}`) });
  await page.getByRole('button', { name: 'Reset 2FA for Alex Morgan' }).click();
  await settle(page, 600);
  await page.getByLabel('Reason for reset').fill('User lost access to their authenticator and recovery codes');
  await page.screenshot({ path: out(`real-reset-2fa-dialog-${size.name}`) });
  await page.getByRole('button', { name: 'Reset two-factor authentication' }).click();
  await settle(page, 900);
  await page.locator('p.ap-callout.ap-success').scrollIntoViewIfNeeded();
  await page.screenshot({ path: out(`real-reset-2fa-completed-${size.name}`) });
  // Look up → User: a search showing the user card (mockup #userResult).
  await page.getByLabel('Search', { exact: true }).fill('sam.patel@example-agency.test');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await settle(page, 900);
  await page.getByRole('heading', { name: 'Look up' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: out(`real-user-card-${size.name}`) });
  problems.push(...errors.map((e) => `[security states] pageerror ${e}`), ...fx.unhandled.map((u) => `[security states] ${u}`));
  await context.close();
}

async function mockup(browser, size) {
  const context = await browser.newContext({ viewport: size.viewport, deviceScaleFactor: 1, reducedMotion: 'reduce', locale: 'en-GB' });
  const page = await context.newPage();
  await page.goto(MOCKUP);
  await page.waitForTimeout(800);
  for (const tab of TABS) {
    await page.click(`[data-tab="${tab}"]`);
    await page.waitForTimeout(300);
    await page.screenshot({ path: out(`mockup-${tab}-${size.name}`) });
  }
  await context.close();
}

async function securityDesign(browser) {
  const size = SIZES[0];
  const context = await browser.newContext({ viewport: size.viewport, deviceScaleFactor: 1, reducedMotion: 'reduce', locale: 'en-GB' });
  const page = await context.newPage();
  await page.goto(SECURITY_DESIGN);
  await page.waitForTimeout(800);
  for (const [state, name] of [[null, 'users'], ['reset', 'reset-dialog'], ['reset-done', 'reset-completed']]) {
    await page.evaluate((s) => {
      // eslint-disable-next-line no-undef
      setView('admin');
      // eslint-disable-next-line no-undef
      if (s) setState(s);
    }, state);
    await page.waitForTimeout(300);
    await page.screenshot({ path: out(`design-account-security-admin-${name}-${size.name}`) });
  }
  await context.close();
}

(async () => {
  const browser = await launch();
  const problems = [];
  try {
    for (const size of SIZES) {
      await realPanel(browser, size, problems);
      await mockup(browser, size);
    }
    await accountSecurityStates(browser, problems);
    await securityDesign(browser);
  } finally {
    await browser.close();
  }
  for (const p of problems) console.log(p);
  console.log(`screenshots written to ${OUT}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
