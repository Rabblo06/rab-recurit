import { chromium } from 'playwright';

/**
 * Per-call `chromium.launch()`/`close()` — not a persistent browser instance
 * held across the whole worker process. Acceptable overhead at these jobs'
 * ~5min polling cadence and low per-tick candidate count (Part 60); a
 * persistent instance would need its own lifecycle/crash-recovery handling
 * for marginal benefit here.
 */
export async function renderHtmlToPdf(html: string): Promise<Buffer> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    return await page.pdf({ format: 'A4', printBackground: true });
  } finally {
    await browser.close();
  }
}
