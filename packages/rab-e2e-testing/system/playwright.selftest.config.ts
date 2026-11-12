import { defineConfig } from '@playwright/test';

/**
 * Self-tests for the system e2e's own helpers (lib/*.selftest.ts). No stack, no browser, no network: pure functions run
 * against committed fixtures.
 *
 *   npx playwright test -c packages/rab-e2e-testing/system/playwright.selftest.config.ts
 */
export default defineConfig({
  testDir: './lib',
  testMatch: /\.selftest\.ts$/,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list']],
  outputDir: '../test-results/system-selftest',
});
