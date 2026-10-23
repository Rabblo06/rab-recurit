import { defineConfig, devices } from '@playwright/test';

/**
 * Wave 6 lane E2E — whole-system run against the DISPOSABLE stack (system/docker-compose.e2e.yml + the host Vite on 5300).
 * Serial on purpose: the specs are one agency's story in order (platform admin → two organisations → business flow →
 * isolation → auth → resilience), sharing ids through E2E_STATE_FILE. Never points at the dev stack.
 *
 *   E2E_ENV_FILE=<scratchpad>/e2e.env npx playwright test -c packages/rab-e2e-testing/system/playwright.system.config.ts
 */
export default defineConfig({
  testDir: './specs',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 5 * 60_000,
  expect: { timeout: 20_000 },
  reporter: [['list'], ['json', { outputFile: process.env.E2E_JSON_REPORT ?? '../test-results/system-report.json' }]],
  outputDir: '../test-results/system',
  use: {
    baseURL: 'http://127.0.0.1:5300',
    trace: 'retain-on-failure',
    actionTimeout: 30_000,
    navigationTimeout: 45_000,
    screenshot: 'only-on-failure',
    viewport: { width: 1440, height: 900 },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
});
