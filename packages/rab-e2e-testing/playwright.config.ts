import { defineConfig, devices } from '@playwright/test';

import isolatedConfig from './playwright.isolated.config';
import { LIVE_SPEC_MATCH } from './playwright.live.config';

// E2E_WEB_PORT (default 5173, what CI uses) lets a local run start its own Vite away from the dev stack's 5173.
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 5173);

/**
 * The MOCKED web specs (every API call answered by page.route fixtures) — CI job `web-mocked` in ci-e2e.yaml.
 * Specs that need another stack run in their own job and are excluded here, derived from those configs so the two can
 * never drift (check-spec-coverage.mjs fails CI when a spec is in no job or in two):
 *   - playwright.isolated.config.ts  (job web-isolated: isolated Vite on :5174, dead API URL)
 *   - playwright.live.config.ts      (job web-live: real API + PostgreSQL + Redis, live/run-live.sh)
 *   - web/ai/**                      (job web-ai-visual: web/ai/run-ai-visual.sh, one config per suite)
 */
const testIgnore = [LIVE_SPEC_MATCH, /[\\/]ai[\\/]/, ...[isolatedConfig.testMatch ?? []].flat()];

export default defineConfig({
  testDir: './web',
  testIgnore,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [['list'], ['html', { outputFolder: '../../playwright-report', open: 'never' }]],
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: WEB_PORT === 5173 ? 'npx nx start rab-front' : `yarn workspace @rab/front exec vite --port ${WEB_PORT} --strictPort`,
    url: `http://localhost:${WEB_PORT}`,
    reuseExistingServer: !process.env.CI,
    cwd: '../..',
  },
});
