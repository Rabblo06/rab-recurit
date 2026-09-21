import { chromium } from 'playwright';

/**
 * Per-call `chromium.launch()`/`close()` — not a persistent browser instance
 * held across the whole worker process. Acceptable overhead at these jobs'
 * ~5min polling cadence and low per-tick candidate count; a persistent
 * instance would need its own lifecycle/crash-recovery handling for marginal
 * benefit here. The `finally` guarantees the browser process is closed even
 * when rendering throws, so a failed render never leaks a Chromium.
 *
 * Container support (the production image is `node:alpine`, where Playwright's
 * bundled Chromium does not run): when `CHROMIUM_EXECUTABLE_PATH` is set the
 * renderer launches that system Chromium instead, and `CHROMIUM_NO_SANDBOX=true`
 * adds the sandbox flags a non-root container user needs. Both are unset in
 * local development, where Playwright's own downloaded browser is used.
 */
export async function renderHtmlToPdf(html: string): Promise<Buffer> {
  const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || undefined;
  const args = ['--disable-dev-shm-usage'];
  if (process.env.CHROMIUM_NO_SANDBOX === 'true') args.push('--no-sandbox', '--disable-setuid-sandbox');
  const browser = await chromium.launch({ executablePath, args });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    return await page.pdf({ format: 'A4', printBackground: true });
  } finally {
    await browser.close();
  }
}
