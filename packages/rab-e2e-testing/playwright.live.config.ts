import { readFileSync } from 'node:fs';
import path from 'node:path';

import { defineConfig, devices } from '@playwright/test';

/**
 * Live-backend web specs: a REAL API (built server), PostgreSQL and Redis — disposable ones only — started and seeded by
 * `live/run-live.sh`, which then runs this config one spec file at a time (the auth throttles are real and shared per IP).
 * CI: the `web-live` job in .github/workflows/ci-e2e.yaml. Never the owner's dev stack.
 *
 * Two stacks, because the specs pin two pairs of origins (overridable for local runs; CI uses the defaults):
 *   console  Vite :5173 → API :3000
 *   qa       Vite :5174 → API :3999   (devices-sessions-live, ui-corrections-live)
 */
const WEB = process.env.E2E_WEB_ORIGIN ?? 'http://127.0.0.1:5173';
const QA_WEB = process.env.E2E_QA_WEB_ORIGIN ?? 'http://127.0.0.1:5174';

// One source of truth with live/run-live.sh (which runs exactly these files, stack by stack): live/live-specs.json.
const LIVE_SPECS = JSON.parse(readFileSync(path.join(__dirname, 'live/live-specs.json'), 'utf8')) as { console: string[]; qa: string[] };
export const CONSOLE_LIVE_SPECS = LIVE_SPECS.console;
export const QA_LIVE_SPECS = LIVE_SPECS.qa;
const match = (names: string[]) => new RegExp(`(^|[\\\\/])(${names.join('|')})\\.spec\\.ts$`);
export const LIVE_SPEC_MATCH = match([...CONSOLE_LIVE_SPECS, ...QA_LIVE_SPECS]);

export default defineConfig({
  testDir: './web',
  testMatch: LIVE_SPEC_MATCH,
  // One browser at a time against one API: the specs share real per-IP auth throttles and real seeded records.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  // No retries: a retry would spend the same throttled login budget and could only hide a real failure.
  retries: 0,
  // run-live.sh runs one spec file per invocation and names a folder per file (each run would otherwise wipe the last).
  // Under the repository root's (git-ignored) test-results/, never this package's: the default config wipes that one.
  reporter: [['list'], ['html', { outputFolder: process.env.E2E_LIVE_HTML_REPORT ?? '../../test-results/e2e-live/report', open: 'never' }]],
  outputDir: process.env.E2E_LIVE_OUTPUT_DIR ?? '../../test-results/e2e-live/results',
  // Traces in CI (Linux). Locally on Windows, trace artifacts intermittently fail with ENOENT at context close and would
  // turn a passing test red for a reason that has nothing to do with the app; screenshots stay on everywhere.
  use: { trace: process.env.CI ? 'retain-on-failure' : 'off', screenshot: 'only-on-failure' },
  projects: [
    { name: 'console', testMatch: match(CONSOLE_LIVE_SPECS), use: { ...devices['Desktop Chrome'], baseURL: WEB } },
    { name: 'qa', testMatch: match(QA_LIVE_SPECS), use: { ...devices['Desktop Chrome'], baseURL: QA_WEB } },
  ],
});
