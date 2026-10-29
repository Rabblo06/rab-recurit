import { defineConfig, devices } from '@playwright/test';

/**
 * Mocked-API runs against an ISOLATED Vite instance (never the Docker dev stack on 5173, never a real API):
 *   cd packages/rab-e2e-testing && yarn playwright test -c playwright.isolated.config.ts
 * The webServer block below starts that Vite itself (packages/rab-front, 127.0.0.1:5174, strictPort) with
 * VITE_API_URL=http://127.0.0.1:3996/rest/v1 — a port nothing listens on, so a request a spec forgot to fixture fails
 * instead of reaching a real API. Every /rest/v1 request is answered by page.route fixtures inside the spec.
 * The page and the API share the 127.0.0.1 loopback alias, so the dev-only loopback canonicalisation in main.tsx
 * (shared/lib/loopback-host.ts) never redirects the page away from the baseURL.
 * Locally an already-running isolated Vite on 5174 is reused; in CI a fresh one is always started. globalSetup
 * (isolated-warmup.ts) then compiles the app and every lazy route once, so no spec times the dev server's first compile.
 */
const ISOLATED_WEB_PORT = 5174;
const ISOLATED_API_URL = 'http://127.0.0.1:3996/rest/v1'; // unused port: 3999 is the live qa API, 3998 the AI e2e API

export default defineConfig({
  testDir: './web',
  testMatch: /(availability-and-manager-lifecycle|dev-loopback-cookie-host|master-fix-pipeline-reviews|motion-system|crewflow-new-ui|crewflow-new-ui-motion|settings-nav-highlight|crewflow-ui-corrections|dashboard-number-animation)\.spec\.ts/,
  globalSetup: './isolated-warmup.ts',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${ISOLATED_WEB_PORT}`, trace: 'off' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `yarn workspace @rab/front exec vite --port ${ISOLATED_WEB_PORT} --host 127.0.0.1 --strictPort`,
    url: `http://127.0.0.1:${ISOLATED_WEB_PORT}`,
    env: { VITE_API_URL: ISOLATED_API_URL },
    reuseExistingServer: !process.env.CI,
    cwd: '../..',
  },
});
