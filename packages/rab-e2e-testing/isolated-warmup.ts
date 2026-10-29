import fs from 'node:fs';
import path from 'node:path';
import { chromium, type FullConfig } from '@playwright/test';

/**
 * globalSetup for playwright.isolated.config.ts: compiles the app on the freshly started dev server before any test runs.
 *
 * Vite transforms modules on first request. On a cold server the first page load takes tens of seconds (measured ~17 s
 * for one browser on Windows, longer with several workers loading at once), and a lazy route's first visit pays its own
 * compile while React Router keeps the previous route rendered. The isolated specs measure animations and frame timings,
 * so that one-off compile would be timed as if it were the app. This loads the app once and imports every lazy route
 * module listed in rab-front's App.tsx, so the server's transform cache is warm. No API is involved: every /rest/v1
 * request is answered 401 here, and nothing is asserted.
 */
export default async function warmIsolatedDevServer(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use.baseURL;
  if (!baseURL) throw new Error('playwright.isolated.config.ts must set use.baseURL');
  const appSource = fs.readFileSync(path.resolve(__dirname, '../rab-front/src/App.tsx'), 'utf8');
  const lazyModules = [...appSource.matchAll(/lazy\(\(\) => import\('\.\/([^']+)'\)\)/g)].map((m) => `/src/${m[1]}`);
  if (!lazyModules.length) throw new Error('No lazy routes found in rab-front/src/App.tsx; update isolated-warmup.ts');

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('**/rest/v1/**', (route) =>
      route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ message: 'Invalid session.' }) }),
    );
    // A lazy module can pull in a dependency Vite has not pre-bundled yet; Vite then re-optimises and reloads the page,
    // which destroys this evaluate. That reload is exactly what the warm-up is for, so load again and repeat (bounded).
    let failed: string[] = lazyModules;
    for (let attempt = 1; attempt <= 5 && failed.length; attempt++) {
      // /login: the signed-out landing page, so the app does not redirect away mid-load.
      try {
        await page.goto(new URL('/login', baseURL).href, { waitUntil: 'load', timeout: 180_000 });
        failed = await page.evaluate(async (modules) => {
          const results = await Promise.allSettled(modules.map((m) => import(/* @vite-ignore */ m)));
          return modules.filter((_, i) => results[i]!.status === 'rejected');
        }, lazyModules);
      } catch (error) {
        const reloaded = /Execution context was destroyed|interrupted by another navigation|ERR_ABORTED/.test(String(error));
        if (!reloaded || attempt === 5) throw error;
      }
    }
    if (failed.length) throw new Error(`Dev server could not compile: ${failed.join(', ')}`);
  } finally {
    await browser.close();
  }
}
