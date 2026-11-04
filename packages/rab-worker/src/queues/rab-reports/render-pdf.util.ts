import { Logger } from '@nestjs/common';
import { chromium, errors, Route } from 'playwright';

import { documentFooterTemplate } from '@rab/server/modules/attendance/templates/adolphus-document';
import { renderFinalTimesheetHtml } from '@rab/server/modules/attendance/templates/final-timesheet.html';
import type { FinalTimesheetData } from '@rab/server/modules/attendance/templates/final-timesheet.view-model';
import { PreShiftReportData, renderPreShiftReportHtml } from '@rab/server/modules/attendance/templates/pre-shift-report.html';
import { ApprovedShiftStatementData, renderApprovedShiftStatementHtml } from '@rab/server/modules/payroll/templates/approved-shift-statement.html';

import type { NativeReportDocument } from './native/render-native';
import { PDF_RENDER_STEP_TIMEOUT_MS, PdfRenderTimeoutError } from './native/runtime/render-timeout';

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
 * renderer launches that system Chromium instead. Unset in local development,
 * where Playwright's own downloaded browser is used.
 *
 * OS sandbox (Docker hardening H6, measured): Chromium runs WITHOUT its OS sandbox in every environment. Playwright adds
 * `--no-sandbox` itself unless `chromiumSandbox: true` is passed, so `CHROMIUM_NO_SANDBOX` (whose `true` only repeats
 * the flag) has never switched the sandbox on — unset and `false` were verified to launch with `--no-sandbox` too.
 * `chromiumSandbox: false` below states that explicitly. In the production Worker container the sandbox cannot start
 * anyway: Docker's default seccomp profile refuses the user namespace it needs and the setuid helper has no setuid bit
 * (H1-L2), so `chromiumSandbox: true` aborts the launch. Enabling it is an owner decision (a reviewed seccomp delta for
 * the Worker container; see THREAT-MODEL.md "Docker hardening H6"). The in-page controls below are what contain a
 * hostile document today.
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

/**
 * The render deadline and its error class live in the dependency-free native/runtime/render-timeout.ts (shared with the
 * native render runtime, which must never load this playwright-importing module). Re-exported here: ONE class, so
 * `instanceof PdfRenderTimeoutError` holds for Chromium and native timeouts alike.
 */
export { PDF_RENDER_STEP_TIMEOUT_MS, PdfRenderTimeoutError } from './native/runtime/render-timeout';

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

/**
 * Docker hardening H6: the ONLY environment variables the browser process receives. Playwright's default is the whole
 * `process.env` — in the Worker that is the jobs child's PG_DATABASE_URL, REDIS_URL, APP_SECRET, S3 / SMTP / push
 * credentials — and Chromium runs without its OS sandbox as the same uid, so a renderer bug would land next to them.
 * This is an ALLOWLIST (never a denylist): process location, temp/profile/cache directories, locale, time zone and
 * fontconfig. Nothing here is a credential. Windows names are for local development only (Chromium needs them there).
 * Residual (THREAT-MODEL.md, Docker hardening H6): a same-uid renderer can still read the jobs process's own
 * /proc/<pid>/environ while the OS sandbox is off.
 */
export const CHROMIUM_ENV_KEYS: readonly string[] = Object.freeze([
  'PATH', 'HOME', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR',
  'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'TZ', 'FONTCONFIG_PATH', 'FONTCONFIG_FILE',
]);
const CHROMIUM_WINDOWS_ENV_KEYS: readonly string[] = Object.freeze([
  'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'PROGRAMDATA', 'PROGRAMFILES',
  'PROGRAMFILES(X86)', 'COMMONPROGRAMFILES', 'SYSTEMDRIVE', 'PATHEXT', 'COMSPEC', 'NUMBER_OF_PROCESSORS',
]);

/** The browser's environment: `source` filtered through the allowlist (exact names; case-insensitive on Windows). */
export function chromiumLaunchEnv(source: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Record<string, string> {
  const env: Record<string, string> = {};
  const windows = platform === 'win32';
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== 'string') continue;
    const allowed = CHROMIUM_ENV_KEYS.includes(key) || (windows && [...CHROMIUM_ENV_KEYS, ...CHROMIUM_WINDOWS_ENV_KEYS].includes(key.toUpperCase()));
    if (allowed) env[key] = value;
  }
  return env;
}

export async function renderHtmlToPdf(html: string, options: RenderPdfOptions = {}): Promise<Buffer> {
  const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || undefined;
  const args = ['--disable-dev-shm-usage'];
  if (process.env.CHROMIUM_NO_SANDBOX === 'true') args.push('--no-sandbox', '--disable-setuid-sandbox');
  // chromiumSandbox: Playwright's own default, stated (see "OS sandbox" above): never read as a sandbox being on.
  // env: the allowlisted environment only (chromiumLaunchEnv) — never the Worker's credentials.
  const browser = await chromium.launch({ executablePath, args, chromiumSandbox: false, env: chromiumLaunchEnv() });
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

// ─── Renderer switch and data-in seam (PDF renderer P1, owner decisions D1 / T3) ─────────────────────────────────────

/**
 * `PDF_RENDERER` selects how a document whose kind is in `NATIVE_KINDS` is rendered:
 *   - `chromium` (DEFAULT; also when unset or empty): the HTML template through `renderHtmlToPdf` above, as before;
 *   - `native`: @react-pdf/renderer in the Worker process (`native/`), no browser at all.
 * Anything else (a different case, surrounding spaces, another word) is refused: the Worker's env validation
 * (`EnvironmentVariables.PDF_RENDERER`) stops the process at boot, and this parser throws at render time for any caller
 * that did not boot through it. Never a silent choice of either renderer.
 */
export const PDF_RENDERER_MODES = Object.freeze(['chromium', 'native'] as const);
export type PdfRendererMode = (typeof PDF_RENDERER_MODES)[number];

export function pdfRendererMode(env: NodeJS.ProcessEnv = process.env): PdfRendererMode {
  const raw = env.PDF_RENDERER;
  if (raw === undefined || raw === '') return 'chromium';
  if ((PDF_RENDERER_MODES as readonly string[]).includes(raw)) return raw as PdfRendererMode;
  throw new Error('PDF_RENDERER must be exactly "chromium" (the default) or "native"');
}

/**
 * The data-in seam (D1): every report PDF is requested as its kind plus the SAME data the job used to give the HTML
 * template. Each renderer derives its output from that data through the document's rab-server view-model builder, so
 * no business rule (minutes, money, dates, labels, QR, references) is ever re-implemented in a renderer.
 */
export type ReportDocument =
  | { kind: 'pre-shift'; data: PreShiftReportData }
  | { kind: 'final-timesheet'; data: FinalTimesheetData }
  | { kind: 'approved-shift-statement'; data: ApprovedShiftStatementData };

/** Kinds with a native layout: the final timesheet (P1) and the pre-shift roster (P2); every other kind renders through Chromium in either mode. */
export const NATIVE_KINDS: ReadonlySet<ReportDocument['kind']> = new Set<ReportDocument['kind']>(['final-timesheet', 'pre-shift']);

/** Chromium: today's template output for the document, unchanged. */
export function htmlFor(doc: ReportDocument): string {
  switch (doc.kind) {
    case 'pre-shift':
      return renderPreShiftReportHtml(doc.data);
    case 'final-timesheet':
      return renderFinalTimesheetHtml(doc.data);
    case 'approved-shift-statement':
      return renderApprovedShiftStatementHtml(doc.data);
  }
}

/** Chromium: today's page.pdf() options for the document (roster and timesheet landscape with the footer; statement {}). */
export function optionsFor(doc: ReportDocument): RenderPdfOptions {
  switch (doc.kind) {
    case 'pre-shift':
    case 'final-timesheet':
      return { footerTemplate: documentFooterTemplate(doc.data), landscape: true };
    case 'approved-shift-statement':
      return {};
  }
}

function isNative(doc: ReportDocument): doc is ReportDocument & NativeReportDocument {
  return NATIVE_KINDS.has(doc.kind);
}

/** One log line naming the renderer per kind (Worker boot); also re-validates PDF_RENDERER (throws on a bad value). */
export function describePdfRendering(env: NodeJS.ProcessEnv = process.env): string {
  const mode = pdfRendererMode(env);
  const native = mode === 'native' ? [...NATIVE_KINDS] : [];
  return `PDF_RENDERER=${mode}: native ${native.length ? native.join(', ') : 'none'}; Chromium for every other report kind`;
}

/**
 * Renders a report PDF with the renderer PDF_RENDERER selects for its kind. Same contract either way: resolves to the
 * PDF bytes; a render that does not finish within `PDF_RENDER_STEP_TIMEOUT_MS` rejects with `PdfRenderTimeoutError`
 * (native: step `native-render`, enforced by the render pool; Chromium bounds `setContent` and `pdf` itself). Native
 * failures carry a stable `code` (runtime/render-protocol.ts, e.g. error_PDF_GLYPH_UNSUPPORTED). A native failure is thrown as is: there is NO
 * runtime fallback to Chromium (T3) — the job's normal failure / retry path handles it, and rollback is the explicit
 * `PDF_RENDERER=chromium`.
 */
export async function renderReportPdf(doc: ReportDocument, env: NodeJS.ProcessEnv = process.env): Promise<Buffer> {
  if (pdfRendererMode(env) === 'chromium' || !isNative(doc)) return renderHtmlToPdf(htmlFor(doc), optionsFor(doc));
  // Loaded on first native use only: a Chromium-mode Worker never starts the render pool. The pool enforces the 30 s
  // deadline itself by terminating the render thread (a timer here could not stop a thread).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { renderNativePdf } = require('./native/render-native') as typeof import('./native/render-native');
  return renderNativePdf(doc);
}
