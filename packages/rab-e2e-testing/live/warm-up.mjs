#!/usr/bin/env node
/**
 * Warms each live-stack Vite dev server before the first spec runs: a cold Vite compiles the console module graph (and may
 * re-optimise dependencies and reload) on the first real browser visit, which can take longer than a test's own timeout.
 * Opens <origin>/login in Chromium and waits for the sign-in screen to render. Exits non-zero if it never does.
 *
 *   node live/warm-up.mjs http://127.0.0.1:5173 http://127.0.0.1:5174
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('@playwright/test');

const origins = process.argv.slice(2);
const browser = await chromium.launch();
try {
  for (const origin of origins) {
    const started = Date.now();
    const page = await browser.newPage();
    await page.goto(`${origin}/login`, { timeout: 240_000 });
    await page.getByRole('button', { name: 'Continue with email' }).waitFor({ state: 'visible', timeout: 240_000 });
    // A dependency re-optimisation reloads the page once; wait for the network to settle and check the screen again.
    await page.waitForLoadState('networkidle', { timeout: 120_000 }).catch(() => undefined);
    await page.getByRole('button', { name: 'Continue with email' }).waitFor({ state: 'visible', timeout: 120_000 });
    console.log(`[e2e-live] warmed ${origin} in ${Math.round((Date.now() - started) / 1000)} s`);
    await page.close();
  }
} finally {
  await browser.close();
}
