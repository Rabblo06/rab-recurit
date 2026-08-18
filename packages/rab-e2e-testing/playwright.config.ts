import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './web',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [['html', { outputFolder: '../../playwright-report' }]],
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npx nx start rab-front',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    cwd: '../..',
  },
});
