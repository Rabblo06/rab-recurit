import { defineConfig, devices } from '@playwright/test';

// Baselines are per OS. The Windows captures (Google Chrome, channel 'chrome') stay in __screenshots__/u2/; Linux (CI, and the
// mcr.microsoft.com/playwright image they were generated in) uses the Chromium pinned to @playwright/test and its own
// __screenshots__/u2/linux/. Run every suite with run-ai-visual.sh, which starts the Vite server and sets the fixture origin.
const LINUX = process.platform === 'linux';

/**
 * U2 visual-regression baselines (u2-visual.spec.ts). Expects a rab-front Vite dev server of THIS worktree at U2_WEB
 * (default http://localhost:5198; never the owner's preview port 5174). All API traffic is answered by the fictional
 * rab-docs fixtures inside the browser; nothing reaches a backend.
 */
export default defineConfig({
  testDir: '.',
  testMatch: /u2-visual\.spec\.ts/,
  snapshotPathTemplate: `{testDir}/__screenshots__/u2/${LINUX ? 'linux/' : ''}{arg}{ext}`,
  outputDir: '../../test-results/ai-u2',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  expect: { toHaveScreenshot: { animations: 'disabled', maxDiffPixelRatio: 0.01 } },
  use: { baseURL: process.env.U2_WEB ?? 'http://localhost:5198', trace: 'off', screenshot: 'off' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], ...(LINUX ? {} : { channel: 'chrome' }) } }],
});
