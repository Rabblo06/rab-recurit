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
 * renderer launches that system Chromium instead. Unset in local development,
 * where Playwright's own downloaded browser is used.
 *
 * OS sandbox — REQUIRED (owner decision 2026-11-03, "require the Chromium OS sandbox"; THREAT-MODEL.md "Chromium OS
 * sandbox"). Chromium is launched with `chromiumSandbox: true` (its namespace sandbox: renderers in their own user, PID
 * and network namespaces under its seccomp-BPF policy) and `--disable-gpu-sandbox` on Linux (the GPU process's own
 * seccomp policy kills it on musl's pwritev2, which takes the whole browser down; renderers stay sandboxed). In the
 * Worker container this needs the seccomp profile packages/rab-docker/rab/seccomp/chromium-worker.json (Docker's default
 * + user/PID/net/IPC namespaces + chroot); the setuid helper is NOT used (no setuid bit since H1-L2).
 * Fail-safe: if the sandbox cannot start, the launch fails and so does the render (`PdfRenderSandboxError`) — there is
 * no retry without the sandbox. `CHROMIUM_NO_SANDBOX` is IGNORED (it can no longer turn the sandbox off). The only
 * opt-out is the explicit `CHROMIUM_SANDBOX=disabled-outside-production`, for hosts that cannot create user namespaces
 * in local development or host-level tests; it is REFUSED when NODE_ENV or RAB_RUNTIME_ENV is production.
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

export class PdfRenderSandboxError extends Error {
  constructor(cause: unknown) {
    super(
      'PDF render refused: Chromium could not start with its OS sandbox (in the Worker container the seccomp profile ' +
        'packages/rab-docker/rab/seccomp/chromium-worker.json must be applied). There is no fallback to --no-sandbox.',
    );
    this.name = 'PdfRenderSandboxError';
    // The launch error is kept for logs; it names Chromium's sandbox failure, never a credential (env is allowlisted).
    (this as { cause?: unknown }).cause = cause;
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

/**
 * Docker hardening H6: the ONLY environment variables the browser process receives. Playwright's default is the whole
 * `process.env` — in the Worker that is the jobs child's PG_DATABASE_URL, REDIS_URL, APP_SECRET, S3 / SMTP / push
 * credentials — and the browser process (which is never itself inside the sandbox) runs as the same uid.
 * This is an ALLOWLIST (never a denylist): process location, temp/profile/cache directories, locale, time zone and
 * fontconfig. Nothing here is a credential. Windows names are for local development only (Chromium needs them there).
 * With the OS sandbox (below) a compromised renderer is in its own user/PID/network namespaces under seccomp-BPF and
 * cannot open another process's /proc entries; without it (the non-production opt-out) a same-uid renderer could still
 * read the jobs process's own /proc/<pid>/environ.
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

export type ChromiumSandboxMode = 'required' | 'disabled-outside-production';

/**
 * Strict CHROMIUM_SANDBOX: unset/empty/"required" → required; "disabled-outside-production" → only outside production;
 * anything else, or the opt-out in production, throws (fail closed — never a silent mode choice).
 */
export function chromiumSandboxMode(env: NodeJS.ProcessEnv = process.env): ChromiumSandboxMode {
  const raw = env.CHROMIUM_SANDBOX;
  if (raw === undefined || raw === '' || raw === 'required') return 'required';
  if (raw === 'disabled-outside-production') {
    if (env.NODE_ENV === 'production' || env.RAB_RUNTIME_ENV === 'production') {
      throw new Error('CHROMIUM_SANDBOX=disabled-outside-production is refused in production: the Chromium OS sandbox is required');
    }
    return raw;
  }
  throw new Error('CHROMIUM_SANDBOX must be "required" (the default) or "disabled-outside-production"');
}

/** The launch options' sandbox part: required → sandbox on (+ GPU-process exemption on Linux), never `--no-sandbox`. */
export function chromiumSandboxLaunch(mode: ChromiumSandboxMode, platform: NodeJS.Platform = process.platform): { chromiumSandbox: boolean; args: string[] } {
  if (mode === 'required') return { chromiumSandbox: true, args: platform === 'linux' ? ['--disable-gpu-sandbox'] : [] };
  return { chromiumSandbox: false, args: [] }; // Playwright then adds --no-sandbox itself; never reachable in production
}

let warnedSandboxOff = false;
let warnedIgnoredNoSandbox = false;

export async function renderHtmlToPdf(html: string, options: RenderPdfOptions = {}): Promise<Buffer> {
  const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || undefined;
  const mode = chromiumSandboxMode();
  const sandbox = chromiumSandboxLaunch(mode);
  if (process.env.CHROMIUM_NO_SANDBOX === 'true' && !warnedIgnoredNoSandbox) {
    warnedIgnoredNoSandbox = true;
    logger.warn('CHROMIUM_NO_SANDBOX=true is ignored: the Chromium OS sandbox is required (CHROMIUM_SANDBOX)');
  }
  if (mode !== 'required' && !warnedSandboxOff) {
    warnedSandboxOff = true;
    logger.warn('CHROMIUM_SANDBOX=disabled-outside-production: Chromium runs WITHOUT its OS sandbox (never allowed in production)');
  }
  const args = ['--disable-dev-shm-usage', ...sandbox.args];
  // env: the allowlisted environment only (chromiumLaunchEnv) — never the Worker's credentials.
  let browser: Awaited<ReturnType<typeof chromium.launch>>;
  try {
    browser = await chromium.launch({ executablePath, args, chromiumSandbox: sandbox.chromiumSandbox, env: chromiumLaunchEnv() });
  } catch (error) {
    // Fail-safe: no second attempt without the sandbox.
    if (mode === 'required') throw new PdfRenderSandboxError(error);
    throw error;
  }
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
