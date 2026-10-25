import { defineConfig, devices } from '@playwright/test';

/**
 * AI Phase 1 full-flow E2E (real API → rab-ai BullMQ → Worker → tools → deterministic model → SSE → React).
 * Started by `run-ai-e2e.sh`, which boots its OWN API (:3998), Worker and Vite (:5176) against the disposable test
 * database and Redis. Never the owner's docker stack, never a real account or provider.
 */
export default defineConfig({
  testDir: '.',
  testMatch: /ai-chat\.e2e\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 10 * 60_000,
  reporter: [['list']],
  use: { baseURL: process.env.AI_E2E_WEB ?? 'http://localhost:5176', trace: 'off', screenshot: 'off' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
