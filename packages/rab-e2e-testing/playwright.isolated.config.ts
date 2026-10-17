import { defineConfig, devices } from '@playwright/test';

/**
 * Mocked-API runs against an ISOLATED Vite instance (never the Docker dev stack on 5173, never a real API):
 *   cd packages/rab-front && VITE_API_URL=http://127.0.0.1:3999/rest/v1 npx vite --port 5174 --host 127.0.0.1 --strictPort
 *   npx playwright test -c packages/rab-e2e-testing/playwright.isolated.config.ts
 * Every /rest/v1 request is answered by page.route fixtures inside the spec.
 */
export default defineConfig({
  testDir: './web',
  testMatch: /(availability-and-manager-lifecycle|dev-loopback-cookie-host)\.spec\.ts/,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:5174', trace: 'off' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
