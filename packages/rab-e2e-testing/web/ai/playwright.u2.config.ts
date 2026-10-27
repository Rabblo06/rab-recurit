import { defineConfig, devices } from '@playwright/test';

/**
 * U2 visual-regression baselines (u2-visual.spec.ts). Expects a rab-front Vite dev server of THIS worktree at U2_WEB
 * (default http://localhost:5198; never the owner's preview port 5174). All API traffic is answered by the fictional
 * rab-docs fixtures inside the browser; nothing reaches a backend.
 */
export default defineConfig({
  testDir: '.',
  testMatch: /u2-visual\.spec\.ts/,
  snapshotPathTemplate: '{testDir}/__screenshots__/u2/{arg}{ext}',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  expect: { toHaveScreenshot: { animations: 'disabled', maxDiffPixelRatio: 0.01 } },
  use: { baseURL: process.env.U2_WEB ?? 'http://localhost:5198', trace: 'off', screenshot: 'off' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], channel: 'chrome' } }],
});
