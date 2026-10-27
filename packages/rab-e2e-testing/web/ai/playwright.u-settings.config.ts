import { defineConfig, devices } from '@playwright/test';

/**
 * U4 / U6 / U7 visual-regression baselines (u-settings-visual.spec.ts). Expects a rab-front Vite dev server of THIS
 * worktree at U_SETTINGS_WEB (default http://localhost:5199; never the owner's ports 5173 / 5174). All API traffic is
 * answered by the fictional rab-docs fixtures inside the browser; nothing reaches a backend. Set the fixtures' origin to
 * the same value (the app redirects 127.0.0.1 to localhost, so use `localhost`):
 *   CREWFLOW_WEB_ORIGIN=http://localhost:5199 U_SETTINGS_WEB=http://localhost:5199 \
 *     node node_modules/@playwright/test/cli.js test -c packages/rab-e2e-testing/web/ai/playwright.u-settings.config.ts
 */
export default defineConfig({
  testDir: '.',
  testMatch: /u-settings-visual\.spec\.ts/,
  snapshotPathTemplate: '{testDir}/__screenshots__/u-settings/{arg}{ext}',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  expect: { toHaveScreenshot: { animations: 'disabled', maxDiffPixelRatio: 0.01 } },
  use: { baseURL: process.env.U_SETTINGS_WEB ?? 'http://localhost:5199', trace: 'off', screenshot: 'off' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], channel: 'chrome' } }],
});
