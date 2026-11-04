/**
 * The render deadline and its error, with NO dependencies, so the native runtime never loads the Chromium renderer
 * module (`render-pdf.util.ts` imports `playwright`, which the no-Chromium Worker image does not ship: MEASURED, the
 * pool failed with MODULE_NOT_FOUND 'playwright' in crewflow-pdf/worker:no-chromium-test-amd64 while it imported the
 * error class from there).
 *
 * Same name, fields and message as the class `render-pdf.util.ts` declares today. At integration that file should
 * re-export these two instead of declaring its own (one class, so `instanceof` holds everywhere):
 *   export { PDF_RENDER_STEP_TIMEOUT_MS, PdfRenderTimeoutError } from './native/runtime/render-timeout';
 */

/** Upper bound for each render step. Real templates render in well under a second. */
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
