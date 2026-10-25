// Settings → Profile feedback screenshots (2026-10-25): success, failure, progress and validation states of every Profile
// action, against the REAL rab-front build with synthetic fixture responses (fixtures.cjs + profile-feedback-fixtures.cjs).
// Output: docs/feedback/screenshots/<phase>/<state>-<size>.png. Run from the repository root with a rab-front Vite dev
// server up (a private port, so a running local stack is never touched):
//
//   CREWFLOW_WEB_ORIGIN=http://localhost:5231 node packages/rab-docs/tools/web/capture-profile-feedback.cjs before
//   CREWFLOW_WEB_ORIGIN=http://localhost:5231 node packages/rab-docs/tools/web/capture-profile-feedback.cjs after
'use strict';

const fs = require('fs');
const path = require('path');
const { launch, openPage, settle, APP_ORIGIN } = require('./common.cjs');
const { generatedPng } = require('./fixtures.cjs');
const { installProfileFeedback } = require('./profile-feedback-fixtures.cjs');

const phase = process.argv[2];
if (phase !== 'before' && phase !== 'after') {
  console.error('usage: capture-profile-feedback.cjs before|after');
  process.exit(2);
}
const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const OUT = path.join(REPO, 'docs', 'feedback', 'screenshots', phase);
fs.mkdirSync(OUT, { recursive: true });
const SIZES = [
  { name: '1440x900', viewport: { width: 1440, height: 900 } },
  { name: '390x844', viewport: { width: 390, height: 844 } },
];

// A tiny real GIF (accepted by the browser's file picker filter only if forced; rejected by the server's byte sniff).
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
// 11 MB that starts with the PNG signature: over the server's 10 MB AVATAR_MAX_BYTES.
const OVERSIZE = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(11 * 1024 * 1024)]);

const fileInput = 'input[type="file"]';
const card = { photo: '.profile-picture-card', details: '.personal-details-card', password: '.password-access-card', devices: '.devices-card' };

async function editAndSave(page, value = 'Jordan-Lee') {
  await page.locator('#profile-first').fill(value);
  await page.getByRole('button', { name: 'Save changes' }).click();
}

const STATES = [
  { name: 'idle', scenario: null, focus: card.photo, run: async () => {} },
  { name: 'save-success', scenario: null, focus: card.details, run: (p) => editAndSave(p), toast: true },
  { name: 'save-in-progress', scenario: 'save-slow', focus: card.details, run: async (p) => { await editAndSave(p); await p.waitForTimeout(700); } },
  { name: 'save-server-error', scenario: 'save-500', focus: card.details, run: (p) => editAndSave(p), toast: true },
  { name: 'save-empty-first-name', scenario: 'save-400', focus: card.details, run: (p) => editAndSave(p, ''), toast: 'maybe' },
  { name: 'save-forbidden', scenario: 'save-403', focus: card.details, run: (p) => editAndSave(p), toast: true },
  { name: 'save-offline', scenario: 'save-offline', focus: card.details, run: (p) => editAndSave(p), toast: true },
  { name: 'upload-success', scenario: null, focus: card.photo, run: async (p, b) => p.setInputFiles(fileInput, { name: 'jordan.png', mimeType: 'image/png', buffer: await generatedPng(b, 'avatar') }), toast: true },
  { name: 'upload-in-progress', scenario: 'upload-slow', focus: card.photo, run: async (p, b) => { await p.setInputFiles(fileInput, { name: 'jordan.png', mimeType: 'image/png', buffer: await generatedPng(b, 'avatar') }); await p.waitForTimeout(900); } },
  { name: 'upload-invalid-type', scenario: 'upload-type', focus: card.photo, run: (p) => p.setInputFiles(fileInput, { name: 'animation.gif', mimeType: 'image/gif', buffer: GIF }), toast: 'maybe' },
  { name: 'upload-too-large', scenario: 'upload-large', focus: card.photo, run: (p) => p.setInputFiles(fileInput, { name: 'huge-photo.png', mimeType: 'image/png', buffer: OVERSIZE }), toast: 'maybe' },
  { name: 'upload-storage-failure', scenario: 'upload-storage', focus: card.photo, run: async (p, b) => p.setInputFiles(fileInput, { name: 'jordan.png', mimeType: 'image/png', buffer: await generatedPng(b, 'avatar') }), toast: true },
  { name: 'upload-offline', scenario: 'upload-offline', focus: card.photo, run: async (p, b) => p.setInputFiles(fileInput, { name: 'jordan.png', mimeType: 'image/png', buffer: await generatedPng(b, 'avatar') }), toast: true },
  { name: 'remove-success', scenario: null, focus: card.photo, run: (p) => removePhoto(p), toast: true },
  { name: 'remove-failure', scenario: 'remove-500', focus: card.photo, run: (p) => removePhoto(p), toast: true },
  { name: 'password-success', scenario: null, focus: card.password, run: (p) => p.getByRole('button', { name: 'Set password' }).click(), toast: true },
  { name: 'password-rate-limited', scenario: 'password-429', focus: card.password, run: (p) => p.getByRole('button', { name: 'Set password' }).click(), toast: true },
  { name: 'device-logout-failure', scenario: 'device-500', focus: card.devices, run: async (p) => { await p.getByRole('button', { name: /^More options for .*Safari/ }).click(); await p.getByRole('menuitem', { name: 'Log out' }).click(); }, toast: true },
];

async function removePhoto(page) {
  await page.getByRole('button', { name: /^Remove/ }).click();
  // The after phase asks for confirmation first; the before phase removes immediately.
  const confirm = page.getByRole('alertdialog').getByRole('button', { name: /^Remove/ });
  if (await confirm.isVisible().catch(() => false)) await confirm.click();
}

(async () => {
  const browser = await launch();
  const problems = [];
  const written = [];
  try {
    for (const size of SIZES) {
      for (const state of STATES) {
        const { context, page, errors, fx } = await openPage(browser, { persona: 'manager', viewport: size.viewport, deviceScaleFactor: 1 });
        await installProfileFeedback(page, { origin: APP_ORIGIN, scenario: state.scenario });
        await page.goto(`${APP_ORIGIN}/settings/profile`);
        await settle(page, 1200);
        await page.locator(state.focus).scrollIntoViewIfNeeded();
        try {
          await state.run(page, browser);
          if (state.toast) {
            await page.locator('.toast').first().waitFor({ state: 'visible', timeout: state.toast === 'maybe' ? 2500 : 6000 }).catch((e) => {
              if (state.toast !== 'maybe') throw e;
            });
          }
          await page.waitForTimeout(450);
          await page.locator(state.focus).scrollIntoViewIfNeeded();
          const file = path.join(OUT, `${state.name}-${size.name}.png`);
          await page.screenshot({ path: file });
          written.push(path.relative(REPO, file));
        } catch (e) {
          problems.push(`[${state.name} ${size.name}] ${e.message.split('\n')[0]}`);
        }
        problems.push(...errors.map((e) => `[${state.name} ${size.name}] pageerror ${e}`), ...fx.unhandled.filter((u) => u !== 'GET /public/workspace-host').map((u) => `[${state.name} ${size.name}] ${u}`));
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  console.log(written.join('\n'));
  if (problems.length) {
    console.error('\nProblems:\n' + problems.join('\n'));
    process.exitCode = 1;
  }
})();
