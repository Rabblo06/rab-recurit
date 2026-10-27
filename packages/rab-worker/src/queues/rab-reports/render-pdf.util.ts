import { Logger } from '@nestjs/common';
import { chromium, errors, Route } from 'playwright';

/**
 * Per-call `chromium.launch()`/`close()` — not a persistent browser instance
 * held across the whole worker process. Acceptable overhead at these jobs'
 * ~5min polling cadence and low per-tick candidate count; a persistent
 * instance would need its own lifecycle/crash-recovery handling for marginal
 * benefit here. The `finally` blocks guarantee the page, context and browser
 * process are closed even when rendering throws, so a failed render never leaks a Chromium.
 *
 * Container support (the production image is `node:alpine`, where Playwright's
 * bundled Chromium does not run): when `CHROMIUM_EXECUTABLE_PATH` is set the
 * renderer launches that system Chromium instead, and `CHROMIUM_NO_SANDBOX=true`
 * adds the sandbox flags a non-root container user needs. Both are unset in
 * local development, where Playwright's own downloaded browser is used.
 *
 * Hardening (Phase 0). Every template is self-contained, server-generated HTML whose values are escaped and whose
 * images (logo, shift QR) are `data:` URIs, so the renderer needs neither script nor any fetch. It therefore renders in
 * an isolated context that:
 *   - runs no page JavaScript (`javaScriptEnabled: false` — <script>, inline handlers and `javascript:` URLs are inert);
 *   - is offline, blocks service workers and refuses downloads;
 *   - aborts every request that is not `data:` / `about:blank` (http, https, ws, file, …) via `page.route`, counting the
 *     blocked requests and logging the count only — never a URL, which could carry document data;
 *   - fails closed if the document tries to navigate away from its own content (e.g. `<meta http-equiv="refresh">`),
 *     instead of printing whatever page it landed on;
 *   - bounds `setContent` and `pdf` by `PDF_RENDER_STEP_TIMEOUT_MS` each, with a clear error.
 * `file://` subresources are additionally refused by Chromium itself for an `about:blank` document (they never reach
 * request interception); `render-pdf-hardening.integration.spec.ts` pins all of the above, and that the real templates
 * render byte-identically to the pre-hardening renderer.
 */
export interface RenderPdfOptions {
  /** Playwright footer template (page x of y); see `documentFooterTemplate`. */
  footerTemplate?: string;
  landscape?: boolean;
}

/** Upper bound for each render step (`setContent`, `pdf`). Real templates render in well under a second. */
export const PDF_RENDER_STEP_TIMEOUT_MS = 30_000;

export class PdfRenderTimeoutError extends Error {
  constructor(
    readonly step: string,
    readonly timeoutMs: number,
  ) {
    super(`PDF render step "${step}" did not finish within ${timeoutMs} ms`);
    this.name = 'PdfRenderTimeoutError';
  }
}

export class PdfRenderNavigationError extends Error {
  constructor() {
    super('PDF render refused: the document tried to navigate away from its own content');
    this.name = 'PdfRenderNavigationError';
  }
}

/** Rejects with `PdfRenderTimeoutError` if `work` has not settled within `ms`. The loser's later rejection is swallowed. */
export async function withRenderStepTimeout<T>(step: string, ms: number, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PdfRenderTimeoutError(step, ms)), ms);
  });
  work.catch(() => undefined); // e.g. a pdf() still pending when the browser is closed in `finally`
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const logger = new Logger('RenderHtmlToPdf');

function isAllowedUrl(url: string): boolean {
  return url.startsWith('data:') || url === 'about:blank';
}

export async function renderHtmlToPdf(html: string, options: RenderPdfOptions = {}): Promise<Buffer> {
  const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || undefined;
  const args = ['--disable-dev-shm-usage'];
  if (process.env.CHROMIUM_NO_SANDBOX === 'true') args.push('--no-sandbox', '--disable-setuid-sandbox');
  const browser = await chromium.launch({ executablePath, args });
  let blockedRequests = 0;
  let navigationAttempted = false;
  try {
    const context = await browser.newContext({
      javaScriptEnabled: false,
      offline: true,
      serviceWorkers: 'block',
      acceptDownloads: false,
    });
    try {
      const page = await context.newPage();
      try {
        await page.route('**/*', async (route: Route) => {
          const request = route.request();
          if (isAllowedUrl(request.url())) return route.continue().catch(() => undefined);
          blockedRequests += 1;
          try {
            if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigationAttempted = true;
          } catch {
            navigationAttempted = true; // no owning frame (e.g. a worker request): treat as unsafe
          }
          return route.abort('blockedbyclient').catch(() => undefined);
        });
        const assertStillOwnDocument = () => {
          if (navigationAttempted || page.url() !== 'about:blank') throw new PdfRenderNavigationError();
        };

        try {
          await page.setContent(html, { waitUntil: 'load', timeout: PDF_RENDER_STEP_TIMEOUT_MS });
        } catch (err) {
          if (err instanceof errors.TimeoutError) throw new PdfRenderTimeoutError('setContent', PDF_RENDER_STEP_TIMEOUT_MS);
          throw err;
        }
        assertStillOwnDocument();
        const pdf = await withRenderStepTimeout(
          'pdf',
          PDF_RENDER_STEP_TIMEOUT_MS,
          page.pdf({
            format: 'A4',
            landscape: options.landscape ?? false,
            printBackground: true,
            ...(options.footerTemplate
              ? {
                  displayHeaderFooter: true,
                  headerTemplate: '<span></span>',
                  footerTemplate: options.footerTemplate,
                  margin: { top: '12mm', bottom: '16mm', left: '12mm', right: '12mm' },
                }
              : {}),
          }),
        );
        assertStillOwnDocument();
        return pdf;
      } finally {
        await page.close().catch(() => undefined);
      }
    } finally {
      await context.close().catch(() => undefined);
    }
  } finally {
    if (blockedRequests > 0) logger.warn(`PDF render blocked ${blockedRequests} external resource request(s)`);
    await browser.close();
  }
}
