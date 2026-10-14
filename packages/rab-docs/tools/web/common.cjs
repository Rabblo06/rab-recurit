// Shared browser helpers for capture-screens.cjs and record-tutorials.cjs.
'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require(path.resolve(__dirname, '..', '..', '..', '..', 'node_modules', 'playwright'));
const { install, APP_ORIGIN } = require('./fixtures.cjs');

async function launch() {
  return chromium.launch({ channel: 'chrome', headless: true });
}

/** Fresh isolated context + page with the fixture backend installed. */
async function openPage(browser, {
  persona = 'manager', theme = 'light', viewport = { width: 1440, height: 900 }, deviceScaleFactor = 2,
  reducedMotion = 'reduce', latencyMs = 0, mutate, readyAfterPolls,
} = {}) {
  const context = await browser.newContext({ viewport, deviceScaleFactor, colorScheme: theme === 'dark' ? 'dark' : 'light', reducedMotion, locale: 'en-GB', timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const fx = await install(page, { persona, theme, latencyMs, mutate, readyAfterPolls });
  return { context, page, errors, fx };
}

async function settle(page, extraMs = 1200) {
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await page.evaluate(() => document.fonts.ready).catch(() => {});
  await page.waitForTimeout(extraMs);
}

async function go(page, route, extraMs) {
  await page.goto(APP_ORIGIN + route);
  await settle(page, extraMs);
}

/** Grows the viewport so a scrolling container (drawer body, settings page, …) shows all of its content. */
async function expandFor(page, selector, max = 2400) {
  const extra = await page.evaluate((sel) => {
    const els = sel ? [...document.querySelectorAll(sel)] : [...document.querySelectorAll('*')].filter((el) => {
      const cs = getComputedStyle(el);
      return /(auto|scroll)/.test(cs.overflowY) && el.clientHeight > 100;
    });
    return Math.max(0, ...els.map((el) => el.scrollHeight - el.clientHeight));
  }, selector);
  if (extra > 0) {
    const vp = page.viewportSize();
    await page.setViewportSize({ width: vp.width, height: Math.min(max, vp.height + extra + 8) });
    await page.waitForTimeout(400);
  }
}

function outPath(area, name) {
  const dir = path.resolve(__dirname, '..', '..', 'images', 'web', area);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${name}.png`);
}

/** Full-viewport capture. */
async function shot(page, area, name) {
  const file = outPath(area, name);
  await page.screenshot({ path: file });
  return file;
}

/** Capture of one region (an element, or an explicit box) with padding, clamped to the viewport. */
async function crop(page, area, name, target, pad = 24) {
  const box = typeof target === 'object' && 'x' in target ? target : await page.locator(target).first().boundingBox();
  if (!box) throw new Error(`crop target not visible: ${target}`);
  const vp = page.viewportSize();
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  const clip = { x, y, width: Math.min(vp.width, box.x + box.width + pad) - x, height: Math.min(vp.height, box.y + box.height + pad) - y };
  const file = outPath(area, name);
  await page.screenshot({ path: file, clip });
  return file;
}

/** Union of several elements' boxes. */
async function unionBox(page, selectors) {
  const boxes = [];
  for (const sel of selectors) {
    const b = await page.locator(sel).first().boundingBox();
    if (b) boxes.push(b);
  }
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return { x, y, width: Math.max(...boxes.map((b) => b.x + b.width)) - x, height: Math.max(...boxes.map((b) => b.y + b.height)) - y };
}

/** Holds the `open-user-detail` hand-off so the create drawer's own success message stays on screen. */
async function holdDetailHandOff(page) {
  await page.evaluate(() => {
    window.addEventListener('open-user-detail', (e) => { if (window.__holdDetail) e.stopImmediatePropagation(); }, true);
    window.__holdDetail = true;
  });
}

const drawer = '.side-panel-dock:not(.ai-panel-dock)';

module.exports = { launch, openPage, settle, go, expandFor, shot, crop, unionBox, holdDetailHandOff, outPath, drawer, APP_ORIGIN };
