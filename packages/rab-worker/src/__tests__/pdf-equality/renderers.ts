import * as renderPdfUtil from '../../queues/rab-reports/render-pdf.util';
import { ReportDocument } from './documents';

/**
 * RENDERER SELECTION for the harness: `chromium` or `native`, plugged in HERE and nowhere else.
 *
 * Contract: the data-in seam that landed on worker/pdf-without-chromium (P0 plan §5.1 / D1), `render-pdf.util.ts`:
 *   `renderReportPdf(doc: { kind; data }, env?)` — picks the renderer from `env.PDF_RENDERER` ('chromium' default |
 *       'native'; anything else refuses); the job passes the template's DATA, and each renderer derives its output from
 *       it through the document's rab-server view-model builder;
 *   `htmlFor(doc)` — the HTML the Chromium path renders for it;
 *   `NATIVE_KINDS` — the kinds with a native layout. IN NATIVE MODE `renderReportPdf` RENDERS ANY OTHER KIND THROUGH
 *       CHROMIUM, so the native renderer below refuses a kind outside NATIVE_KINDS (NOT CONVERTED) instead of letting a
 *       Chromium-vs-Chromium comparison pass as Chromium-vs-native.
 * BOTH renderers go through `renderReportPdf` (P0 §5.2 step 2), with PDF_RENDERER passed per call in `env` (never by
 * mutating process.env, so concurrent renders cannot race).
 *
 * (Integration of #51 with #55: the harness was written against a provisional `renderPdf(doc: { kind; viewModel })` /
 * `chromiumRenderInput` contract and therefore skipped the native suite against the seam that actually landed.)
 */
export type RendererName = 'chromium' | 'native';

export interface Renderer {
  name: RendererName;
  render(doc: ReportDocument): Promise<Buffer>;
}

export class NativeNotConvertedError extends Error {
  constructor(kind: string, why: string) {
    super(`native renderer: document "${kind}" is not converted yet (${why})`);
    this.name = 'NativeNotConvertedError';
  }
}

/** The seam document the production job passes to `renderReportPdf` for this harness document (same data, same kind). */
export function seamDocument(doc: ReportDocument): renderPdfUtil.ReportDocument {
  switch (doc.kind) {
    case 'final-timesheet-original':
      // final-timesheet.job.ts: renderReportPdf({ kind: 'final-timesheet', data: { ...prepared.template, unsigned: true } })
      return { kind: 'final-timesheet', data: { ...doc.data, unsigned: true } };
    case 'final-timesheet':
      return { kind: 'final-timesheet', data: doc.data };
    case 'pre-shift-report':
      return { kind: 'pre-shift', data: doc.data };
    case 'approved-shift-statement':
      return { kind: 'approved-shift-statement', data: doc.data };
  }
}

/**
 * The HTML the Chromium path renders for this document through the seam — the harness asserts it equals today's
 * template output (the view-model refactor must keep the HTML byte-identical, P0 §5.1).
 */
export function switchChromiumHtml(doc: ReportDocument): string | null {
  return renderPdfUtil.htmlFor(seamDocument(doc));
}

export const chromiumRenderer: Renderer = {
  name: 'chromium',
  render: async (doc) => renderPdfUtil.renderReportPdf(seamDocument(doc), { ...process.env, PDF_RENDERER: 'chromium' }),
};

export function loadNativeRenderer(): Renderer | { unavailable: string } {
  return {
    name: 'native',
    render: async (doc) => {
      const seam = seamDocument(doc);
      if (!renderPdfUtil.NATIVE_KINDS.has(seam.kind)) throw new NativeNotConvertedError(doc.kind, `"${seam.kind}" is not in NATIVE_KINDS`);
      return renderPdfUtil.renderReportPdf(seam, { ...process.env, PDF_RENDERER: 'native' });
    },
  };
}

export function rendererByName(name: RendererName): Renderer | { unavailable: string } {
  return name === 'chromium' ? chromiumRenderer : loadNativeRenderer();
}

/** Runs `fn` over `items` with at most `limit` in flight; results in input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}
