import { Logger } from '@nestjs/common';

import { PreShiftReportData } from '@rab/server/modules/attendance/templates/pre-shift-report.html';
import type { FinalTimesheetData } from '@rab/server/modules/attendance/templates/final-timesheet.view-model';
import { ApprovedShiftStatementData } from '@rab/server/modules/payroll/templates/approved-shift-statement.html';

import type { NativeReportDocument } from './native/render-native';
import { PDF_RENDER_STEP_TIMEOUT_MS, PdfRenderTimeoutError } from './native/runtime/render-timeout';

/**
 * PDF renderer migration P5: every report PDF is rendered NATIVELY (@react-pdf/renderer, pure JavaScript, vendored
 * fonts) inside the jobs process. There is no browser: Chromium and Playwright were removed from the Worker (the image
 * gate fails if either returns), so the Chromium-era controls (JavaScript off, offline context, request interception,
 * navigation refusal, the launch-environment allowlist) have nothing left to contain. Their native equivalents are
 * structural: the renderer interprets no markup, executes no document-supplied code and opens no URL or file path
 * (P3 security tests). The one shared contract that remains is the time bound below.
 */

/**
 * The render deadline and its error class live in the dependency-free native/runtime/render-timeout.ts (shared with the
 * native render runtime). Re-exported here: ONE class, so `instanceof PdfRenderTimeoutError` holds everywhere.
 */
export { PDF_RENDER_STEP_TIMEOUT_MS, PdfRenderTimeoutError } from './native/runtime/render-timeout';

/** Rejects with `PdfRenderTimeoutError` if `work` has not settled within `ms`. The loser's later rejection is swallowed. */
export async function withRenderStepTimeout<T>(step: string, ms: number, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PdfRenderTimeoutError(step, ms)), ms);
  });
  work.catch(() => undefined);
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const logger = new Logger('RenderReportPdf');

// ─── Renderer selection (P5 / owner decision D10) ─────────────────────────────────────────────────────────────────────

/**
 * `PDF_RENDERER` is kept for ONE release after P5 (D10) and accepts only `native` (or unset / empty, which mean
 * native). `chromium` is refused with a message naming the rollback: there is no Chromium in this image, so the only way
 * back is redeploying the previous (P4) image, never a switch. Anything else is refused as before. The Worker's env
 * validation (`EnvironmentVariables.PDF_RENDERER`) applies the same rule at boot. After that release the key is deleted.
 */
export const PDF_RENDERER_MODES = Object.freeze(['native'] as const);
export type PdfRendererMode = (typeof PDF_RENDERER_MODES)[number];

export function pdfRendererMode(env: NodeJS.ProcessEnv = process.env): PdfRendererMode {
  const raw = env.PDF_RENDERER;
  if (raw === undefined || raw === '' || raw === 'native') return 'native';
  if (raw === 'chromium') {
    throw new Error('PDF_RENDERER=chromium is retired (P5: this Worker has no browser); roll back by redeploying the previous Worker image');
  }
  throw new Error('PDF_RENDERER must be exactly "native" (or unset)');
}

/**
 * The data-in seam (D1): every report PDF is requested as its kind plus the data the job holds. The native renderer
 * derives its output through the document's rab-server view-model builder, so no business rule is re-implemented here.
 */
export type ReportDocument =
  | { kind: 'pre-shift'; data: PreShiftReportData }
  | { kind: 'final-timesheet'; data: FinalTimesheetData }
  | { kind: 'approved-shift-statement'; data: ApprovedShiftStatementData };

/** Every report kind renders natively. */
export const NATIVE_KINDS: ReadonlySet<ReportDocument['kind']> = new Set<ReportDocument['kind']>([
  'pre-shift',
  'final-timesheet',
  'approved-shift-statement',
]);

/** One log line at Worker boot; also re-validates PDF_RENDERER (throws on a bad or retired value). */
export function describePdfRendering(env: NodeJS.ProcessEnv = process.env): string {
  pdfRendererMode(env);
  return `PDF rendering: native for ${[...NATIVE_KINDS].join(', ')}; no browser`;
}

/**
 * Renders a report PDF natively. Resolves to the PDF bytes; a render that does not finish within
 * `PDF_RENDER_STEP_TIMEOUT_MS` rejects with `PdfRenderTimeoutError`. An unknown kind is refused (fail closed); a native
 * failure is thrown as is (T3: no fallback; the job's normal failure / retry path handles it).
 */
export async function renderReportPdf(doc: ReportDocument, env: NodeJS.ProcessEnv = process.env): Promise<Buffer> {
  pdfRendererMode(env);
  if (!NATIVE_KINDS.has(doc.kind)) {
    logger.error(`refused to render an unknown report kind`);
    throw new Error(`no native layout for report kind ${String((doc as { kind?: unknown }).kind)}`);
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { renderNativePdf } = require('./native/render-native') as typeof import('./native/render-native');
  return withRenderStepTimeout('native', PDF_RENDER_STEP_TIMEOUT_MS, renderNativePdf(doc as NativeReportDocument));
}
