import * as renderPdfUtil from '../../queues/rab-reports/render-pdf.util';
import { renderCall, RenderPdfOptions, ReportDocument } from './documents';

/**
 * RENDERER SELECTION for the harness: `chromium` or `native`, plugged in HERE and nowhere else. Feature-detected, so the
 * same harness runs on three trees:
 *
 *   origin/main (before the seam)     `renderHtmlToPdf(html, options)` only: Chromium renders today's `renderCall(doc)`;
 *                                     the native renderer is unavailable (the native suites skip, or fail with
 *                                     PDF_EQUALITY_REQUIRE_NATIVE=1).
 *   pre-removal (#55 … #57 merged)    the data-in seam (P0 plan §5.1 / D1): `renderReportPdf(doc: { kind; data }, env)`
 *                                     picks the renderer from `env.PDF_RENDERER` ('chromium' | 'native'); `htmlFor(doc)`
 *                                     is the HTML the Chromium path prints; `NATIVE_KINDS` the kinds with a native layout.
 *                                     BOTH renderers go through `renderReportPdf` (P0 §5.2 step 2), with PDF_RENDERER
 *                                     passed per call in `env` (never by mutating process.env, so renders cannot race).
 *   native-only (P5, #61 merged)      `renderReportPdf` + `NATIVE_KINDS`; no `renderHtmlToPdf` / `htmlFor`. The Chromium
 *                                     renderer FAILS LOUDLY (ChromiumRemovedError) — run with PDF_EQUALITY_MODE=native-only
 *                                     (mode.ts), which never calls it.
 *
 * IN NATIVE MODE `renderReportPdf` RENDERS A KIND OUTSIDE NATIVE_KINDS THROUGH CHROMIUM (pre-removal), so the native
 * renderer here refuses such a kind (NOT CONVERTED) instead of letting a Chromium-vs-Chromium comparison pass as
 * Chromium-vs-native.
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

export class ChromiumRemovedError extends Error {
  constructor() {
    super('Chromium renderer removed (P5, native only): run the harness with PDF_EQUALITY_MODE=native-only on this tree');
    this.name = 'ChromiumRemovedError';
  }
}

/** The production seam document kinds (render-pdf.util.ts `ReportDocument['kind']`). */
type SeamKind = 'final-timesheet' | 'pre-shift' | 'approved-shift-statement';
interface SeamDocument {
  kind: SeamKind;
  data: unknown;
}
interface SeamModule {
  renderReportPdf?: (doc: SeamDocument, env?: NodeJS.ProcessEnv) => Promise<Buffer>;
  NATIVE_KINDS?: ReadonlySet<string>;
  htmlFor?: (doc: SeamDocument) => string;
  renderHtmlToPdf?: (html: string, options?: RenderPdfOptions) => Promise<Buffer>;
}
const seam = renderPdfUtil as unknown as SeamModule;

/** The seam document the production job passes to `renderReportPdf` for this harness document (same data, same kind). */
export function seamDocument(doc: ReportDocument): SeamDocument {
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

/** Why this tree has no Chromium renderer, or null when it has one. */
export function chromiumUnavailable(): string | null {
  return typeof seam.renderHtmlToPdf === 'function' ? null : 'render-pdf.util.ts exports no renderHtmlToPdf (Chromium removed, P5)';
}

/** Today's Chromium call with explicit HTML and options (the self-test's "footer lost" alteration). Fails loudly without Chromium. */
export function renderHtmlWithChromium(html: string, options: RenderPdfOptions): Promise<Buffer> {
  if (typeof seam.renderHtmlToPdf !== 'function') return Promise.reject(new ChromiumRemovedError());
  return seam.renderHtmlToPdf(html, options);
}

/**
 * The HTML the Chromium path renders for this document through the seam — the harness asserts it equals today's
 * template output (the view-model refactor must keep the HTML byte-identical, P0 §5.1). Null where the tree has no
 * `htmlFor` (before the seam, or native only).
 */
export function switchChromiumHtml(doc: ReportDocument): string | null {
  return typeof seam.htmlFor === 'function' ? seam.htmlFor(seamDocument(doc)) : null;
}

export const chromiumRenderer: Renderer = {
  name: 'chromium',
  render: async (doc) => {
    if (typeof seam.renderHtmlToPdf !== 'function') throw new ChromiumRemovedError();
    if (typeof seam.renderReportPdf === 'function') return seam.renderReportPdf(seamDocument(doc), { ...process.env, PDF_RENDERER: 'chromium' });
    const { html, options } = renderCall(doc);
    return seam.renderHtmlToPdf(html, options);
  },
};

export function loadNativeRenderer(): Renderer | { unavailable: string } {
  const render = seam.renderReportPdf;
  const kinds = seam.NATIVE_KINDS;
  if (typeof render !== 'function' || !(kinds instanceof Set)) {
    return { unavailable: 'render-pdf.util.ts exports no renderReportPdf / NATIVE_KINDS (worker/pdf-without-chromium not merged into this tree)' };
  }
  return {
    name: 'native',
    render: async (doc) => {
      const s = seamDocument(doc);
      if (!kinds.has(s.kind)) throw new NativeNotConvertedError(doc.kind, `"${s.kind}" is not in NATIVE_KINDS`);
      return render(s, { ...process.env, PDF_RENDERER: 'native' });
    },
  };
}

export function rendererByName(name: RendererName): Renderer | { unavailable: string } {
  if (name === 'native') return loadNativeRenderer();
  const why = chromiumUnavailable();
  return why ? { unavailable: why } : chromiumRenderer;
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
