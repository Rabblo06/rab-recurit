import { defineConfig, devices } from '@playwright/test';

// Baselines are per OS. The Windows captures (Google Chrome, channel 'chrome') stay in __screenshots__/u8/; Linux (CI, and the
// mcr.microsoft.com/playwright image they were generated in) uses the Chromium pinned to @playwright/test and its own
// __screenshots__/u8/linux/. Run every suite with run-ai-visual.sh, which starts the Vite server and sets the fixture origin.
const LINUX = process.platform === 'linux';

/**
 * U8 hardening: in-page a11y audit, keyboard, 390 px baselines (u8-a11y.spec.ts). Expects a rab-front Vite dev server of THIS worktree at U8_WEB
 * (default http://localhost:5198; never the owner's preview port 5174). All API traffic is answered by the fictional
 * rab-docs fixtures inside the browser; nothing reaches a backend.
 */
export default defineConfig({
  testDir: '.',
  testMatch: /u8-a11y\.spec\.ts/,
  snapshotPathTemplate: `{testDir}/__screenshots__/u8/${LINUX ? 'linux/' : ''}{arg}{ext}`,
  outputDir: '../../test-results/ai-u8',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  expect: { toHaveScreenshot: { animations: 'disabled', maxDiffPixelRatio: 0.01 } },
  use: { baseURL: process.env.U8_WEB ?? 'http://localhost:5198', trace: 'off', screenshot: 'off' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], ...(LINUX ? {} : { channel: 'chrome' }) } }],
});
