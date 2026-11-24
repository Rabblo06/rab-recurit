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

// ─── PDF_RENDERER is retired (Phase X X5.4, owner decision D10) ───────────────────────────────────────────────────────

/**
 * `PDF_RENDERER` was kept for ONE release after P5 (D10), accepting only `native`, and is now deleted as D10 planned: every
 * report renders natively and there is nothing to select. A deployment that still sets it gets this one warning at Worker
 * boot (the name only, never the value) and the value is ignored: this image has no other renderer, so no value can select
 * one (going back to Chromium was, and stays, redeploying a pre-P5 image). Null when it is unset or empty.
 */
export function retiredPdfRendererWarning(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.PDF_RENDERER === undefined || env.PDF_RENDERER === ''
    ? null
    : 'PDF_RENDERER is retired and ignored (every report renders natively): remove it from the environment';
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

/** One log line at Worker boot. */
export function describePdfRendering(): string {
  return `PDF rendering: native for ${[...NATIVE_KINDS].join(', ')}; no browser`;
}

/**
 * Renders a report PDF natively. Resolves to the PDF bytes; a render that does not finish within
 * `PDF_RENDER_STEP_TIMEOUT_MS` rejects with `PdfRenderTimeoutError` (step `native-render`, enforced by the render pool,
 * which terminates the render thread; a timer here could not stop a thread). Native failures carry a stable `code`
 * (native/runtime/render-protocol.ts, e.g. error_PDF_NATIVE_RENDER; a timeout carries error_PDF_RENDER_TIMEOUT). An
 * unknown kind is refused (fail closed); a native failure is thrown as is (T3: no fallback) — the job's normal failure /
 * retry path handles it (warning log with the code; for the statement, `statement_error` and the SHIFT_STATEMENT_FAILED
 * audit row carry it).
 */
export async function renderReportPdf(doc: ReportDocument): Promise<Buffer> {
  if (!NATIVE_KINDS.has(doc.kind)) {
    logger.error(`refused to render an unknown report kind`);
    throw new Error(`no native layout for report kind ${String((doc as { kind?: unknown }).kind)}`);
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { renderNativePdf } = require('./native/render-native') as typeof import('./native/render-native');
  return renderNativePdf(doc as NativeReportDocument);
}

/**
 * " [<code>]" for a report-job failure log line when the error carries a stable code of the renderers' shape
 * (`error_PDF_NATIVE_RENDER`, `error_PDF_RENDER_TIMEOUT`, …), else "": a failed native render is attributable in the
 * Worker log, never silent. Only a code of that fixed shape is printed, never free text.
 */
export function errorCodeSuffix(error: unknown): string {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && /^error_[A-Z0-9_]{1,40}$/.test(code) ? ` [${code}]` : '';
}
