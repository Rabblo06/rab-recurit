import { defineConfig, devices } from '@playwright/test';

// Baselines are per OS. The Windows captures (Google Chrome, channel 'chrome') stay in __screenshots__/u-settings/; Linux (CI, and the
// mcr.microsoft.com/playwright image they were generated in) uses the Chromium pinned to @playwright/test and its own
// __screenshots__/u-settings/linux/. Run every suite with run-ai-visual.sh, which starts the Vite server and sets the fixture origin.
const LINUX = process.platform === 'linux';

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
  snapshotPathTemplate: `{testDir}/__screenshots__/u-settings/${LINUX ? 'linux/' : ''}{arg}{ext}`,
  outputDir: '../../test-results/ai-u-settings',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  expect: { toHaveScreenshot: { animations: 'disabled', maxDiffPixelRatio: 0.01 } },
  use: { baseURL: process.env.U_SETTINGS_WEB ?? 'http://localhost:5199', trace: 'off', screenshot: 'off' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], ...(LINUX ? {} : { channel: 'chrome' }) } }],
});
