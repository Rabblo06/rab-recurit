import { defineConfig, devices } from '@playwright/test';

// E2E_WEB_PORT (default 5173, what CI uses) lets a local run start its own Vite away from the dev stack's 5173.
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 5173);

export default defineConfig({
  testDir: './web',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [['html', { outputFolder: '../../playwright-report' }]],
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
