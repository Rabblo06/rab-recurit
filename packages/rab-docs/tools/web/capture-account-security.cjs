// Account security design-parity screenshots (2026-10-25). Captures the REAL rab-front screens (synthetic, fictional API
// responses via fixtures.cjs + account-security-fixtures.cjs; neither fixtures.cjs nor common.cjs is modified) and the
// owner's design file (docs/design/crewflow-account-security.html, driven through its own global setView/setState, with
// the preview scaffolding hidden) at the same viewports, into docs/account-security/screens/. Run from the repository
// root with a rab-front Vite dev server up:
//
//   CREWFLOW_WEB_ORIGIN=http://127.0.0.1:5199 node packages/rab-docs/tools/web/capture-account-security.cjs [real|ref] [state-filter]
'use strict';

const fs = require('fs');
const path = require('path');
const { launch, openPage, settle, APP_ORIGIN } = require('./common.cjs');
const { installAccountSecurity } = require('./account-security-fixtures.cjs');

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const OUT = path.join(REPO, 'docs', 'account-security', 'screens');
const DESIGN = 'file:///' + path.join(REPO, 'docs', 'design', 'crewflow-account-security.html').replace(/\\/g, '/');
const SIZES = [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 800, height: 900 },
  { width: 390, height: 844 },
];
const EMAIL = 'jordan.hale@example.test';
const SAMPLE_PASSWORD = 'sample-password';
const SAMPLE_CODE = '482913';

const SETTINGS = ['off', 'password', 'setup', 'codes', 'on', 'low', 'regenerate', 'disable'];
const SIGNIN = ['password', 'code', 'invalid', 'recovery', 'expired', 'locked'];

fs.mkdirSync(OUT, { recursive: true });
const sizeName = (s) => `${s.width}x${s.height}`;
const out = (name) => path.join(OUT, `${name}.png`);
const [mode = 'all', filter = ''] = process.argv.slice(2);
const wanted = (id) => !filter || id.includes(filter);

async function blur(page) {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
}

async function settingsState(page, state) {
  const dialog = page.getByRole('dialog');
  if (['password', 'setup', 'codes'].includes(state)) {
    await page.getByRole('button', { name: 'Turn on 2FA' }).click();
    await page.getByLabel('Current password').fill(SAMPLE_PASSWORD);
  }
  if (['setup', 'codes'].includes(state)) {
    await dialog.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('dialog', { name: 'Connect your authenticator' }).waitFor();
    await page.getByLabel('6-digit authentication code').fill(SAMPLE_CODE);
  }
  if (state === 'codes') {
    await dialog.getByRole('button', { name: 'Confirm code' }).click();
    await page.getByRole('dialog', { name: 'Save your recovery codes' }).waitFor();
  }
  if (state === 'regenerate') {
    await page.getByRole('button', { name: 'Get new recovery codes' }).click();
    await page.getByLabel('Current password').fill(SAMPLE_PASSWORD);
    await page.getByLabel('6-digit authentication code').fill(SAMPLE_CODE);
  }
  if (state === 'disable') {
    await page.getByRole('button', { name: 'Turn off two-factor authentication' }).click();
    await page.getByLabel('Current password').fill(SAMPLE_PASSWORD);
    await page.getByLabel('6-digit authentication code').fill(SAMPLE_CODE);
  }
}

async function realSettings(browser, size, state, theme, problems) {
  const mfa = ['on', 'regenerate', 'disable'].includes(state) ? 'on' : state === 'low' ? 'low' : 'off';
  const { context, page, errors, fx } = await openPage(browser, { persona: 'manager', theme, viewport: size, deviceScaleFactor: 1 });
  fx.state.me.email = EMAIL;
  fx.state.profile.email = EMAIL;
  await installAccountSecurity(page, { origin: APP_ORIGIN, email: EMAIL, mfa });
  await page.goto(`${APP_ORIGIN}/settings/security`);
  await settle(page, 1200);
  await settingsState(page, state);
  await settle(page, 700);
  await blur(page);
  await page.waitForTimeout(200);
  await page.screenshot({ path: out(`web-settings-${state}@${sizeName(size)}${theme === 'dark' ? '-dark' : ''}`) });
  problems.push(...errors.map((e) => `[settings ${state} ${sizeName(size)} ${theme}] pageerror ${e}`), ...fx.unhandled.map((u) => `[settings ${state} ${sizeName(size)} ${theme}] ${u}`));
  await context.close();
}

async function realSignin(browser, size, state, theme, problems) {
  const challengeFailure = state === 'expired' ? 'expired' : state === 'locked' ? 'locked' : 'invalid';
  const { context, page, errors, fx } = await openPage(browser, { persona: 'anon', theme, viewport: size, deviceScaleFactor: 1 });
  await installAccountSecurity(page, { origin: APP_ORIGIN, email: EMAIL, challengeFailure });
  await page.goto(`${APP_ORIGIN}/login`);
  await settle(page, 1000);
  await page.getByRole('button', { name: 'Continue with email' }).click();
  await page.locator('#email').fill(EMAIL);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.locator('#password').fill(SAMPLE_PASSWORD);
  if (state !== 'password') {
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByRole('heading', { name: 'Verify your sign-in' }).waitFor();
  }
  if (['invalid', 'expired', 'locked'].includes(state)) await page.getByLabel('6-digit authentication code').fill('123456');
  if (state === 'recovery') {
    await page.getByRole('button', { name: 'Use a recovery code' }).click();
    await page.getByLabel('Recovery code').fill('K7MP-2XQ9-4TZR-8HWE');
  }
  await settle(page, 700);
  // Wait for toasts raised by the failure to be visible (real feedback, kept in the capture).
  await blur(page);
  await page.waitForTimeout(250);
  await page.screenshot({ path: out(`web-signin-${state}@${sizeName(size)}${theme === 'dark' ? '-dark' : ''}`) });
  problems.push(...errors.map((e) => `[signin ${state} ${sizeName(size)} ${theme}] pageerror ${e}`), ...fx.unhandled.map((u) => `[signin ${state} ${sizeName(size)} ${theme}] ${u}`));
  await context.close();
}

async function reference(browser, size) {
  const context = await browser.newContext({ viewport: size, deviceScaleFactor: 1, reducedMotion: 'reduce', locale: 'en-GB' });
  const page = await context.newPage();
  await page.goto(DESIGN);
  await page.addStyleTag({ content: '.design-tools,.sample-label{display:none!important}.modal-layer{inset:0!important}.auth{min-height:100vh!important}' });
  for (const [view, states] of [['settings', SETTINGS], ['signin', SIGNIN]]) {
    for (const state of states) {
      if (!wanted(`${view}-${state}`)) continue;
      await page.evaluate(([v, s]) => {
        // eslint-disable-next-line no-undef
        setView(v);
        // eslint-disable-next-line no-undef
        setState(s);
      }, [view, state]);
      await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
      await page.waitForTimeout(150);
      await page.screenshot({ path: out(`ref-web-${view}-${state}@${sizeName(size)}`) });
    }
  }
  await context.close();
}

(async () => {
  const browser = await launch();
  const problems = [];
  try {
    if (mode === 'all' || mode === 'ref') for (const size of SIZES) await reference(browser, size);
    if (mode === 'all' || mode === 'real') {
      const runs = [...SIZES.map((size) => ({ size, theme: 'light' })), { size: SIZES[0], theme: 'dark' }];
      for (const { size, theme } of runs) {
        for (const state of SETTINGS) if (wanted(`settings-${state}`)) await realSettings(browser, size, state, theme, problems);
        for (const state of SIGNIN) if (wanted(`signin-${state}`)) await realSignin(browser, size, state, theme, problems);
      }
    }
  } finally {
    await browser.close();
  }
  for (const p of problems) console.log(p);
  console.log(`screenshots written to ${OUT}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
