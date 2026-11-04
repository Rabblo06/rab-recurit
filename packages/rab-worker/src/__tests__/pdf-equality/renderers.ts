import * as renderPdfUtil from '../../queues/rab-reports/render-pdf.util';
import { renderCall, ReportDocument } from './documents';

/**
 * RENDERER SELECTION for the harness: `chromium` or `native`, plugged in HERE and nowhere else.
 *
 * Contract (the native agent's switch, worker/pdf-without-chromium, P0 plan §5.1 / D1): `render-pdf.util.ts` exports
 *   `renderPdf(doc: { kind; viewModel }, env?: NodeJS.ProcessEnv): Promise<Buffer>`   — picks the renderer from
 *       `env.PDF_RENDERER` ('chromium' default | 'native'; anything else refuses);
 *   `chromiumRenderInput(doc): { html, options }`                                   — what the Chromium path renders;
 * and each converted document has a rab-server view-model builder `build<Doc>ViewModel(data)` beside its template.
 * When `renderPdf` exists, BOTH renderers go through it (P0 §5.2 step 2: "the same renderReportPdf(doc)"), with
 * PDF_RENDERER passed per call in `env` (never by mutating process.env, so concurrent renders cannot race).
 *
 * A document kind without a view-model builder yet (P1 converts the final timesheet first) is rendered for Chromium by
 * today's `renderHtmlToPdf(renderCall(doc))` and reported as NOT CONVERTED for native (`NativeNotConvertedError`).
 * Before the switch lands (origin/main), `loadNativeRenderer()` reports why it is unavailable.
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

type RequestDoc = { kind: string; viewModel: unknown };
type SwitchModule = {
  renderPdf?: (doc: RequestDoc, env?: NodeJS.ProcessEnv) => Promise<Buffer>;
  chromiumRenderInput?: (doc: RequestDoc) => { html: string; options: renderPdfUtil.RenderPdfOptions };
};
const switchModule = renderPdfUtil as unknown as SwitchModule;

/** Where each document's view-model builder lives (P0 plan §5.1 naming), and the switch's `kind` for it. */
const VIEW_MODELS: Record<ReportDocument['kind'], { kind: string; module: string; builder: string }> = {
  'final-timesheet-original': { kind: 'final-timesheet', module: '@rab/server/modules/attendance/templates/final-timesheet.view-model', builder: 'buildFinalTimesheetViewModel' },
  'final-timesheet': { kind: 'final-timesheet', module: '@rab/server/modules/attendance/templates/final-timesheet.view-model', builder: 'buildFinalTimesheetViewModel' },
  'pre-shift-report': { kind: 'pre-shift-report', module: '@rab/server/modules/attendance/templates/pre-shift-report.view-model', builder: 'buildPreShiftReportViewModel' },
  'approved-shift-statement': {
    kind: 'approved-shift-statement',
    module: '@rab/server/modules/payroll/templates/approved-shift-statement.view-model',
    builder: 'buildApprovedShiftStatementViewModel',
  },
};

/** The switch's request for a document, or why there is none (no switch yet / no view-model builder for this kind). */
export function switchRequest(doc: ReportDocument): RequestDoc | string {
  if (typeof switchModule.renderPdf !== 'function' || typeof switchModule.chromiumRenderInput !== 'function') return 'render-pdf.util has no renderPdf/chromiumRenderInput switch';
  const vm = VIEW_MODELS[doc.kind];
  let mod: Record<string, unknown>;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require(vm.module) as Record<string, unknown>;
  } catch {
    return `no view-model module ${vm.module}`;
  }
  const build = mod[vm.builder];
  if (typeof build !== 'function') return `${vm.module} exports no ${vm.builder}`;
  return { kind: vm.kind, viewModel: (build as (d: unknown) => unknown)(doc.data) };
}

/**
 * The HTML the Chromium path renders for this document through the switch, when the switch covers it — the harness
 * asserts it equals today's template output (the view-model refactor must keep the HTML byte-identical, P0 §5.1).
 */
export function switchChromiumHtml(doc: ReportDocument): string | null {
  const req = switchRequest(doc);
  return typeof req === 'string' ? null : switchModule.chromiumRenderInput!(req).html;
}

export const chromiumRenderer: Renderer = {
  name: 'chromium',
  render: async (doc) => {
    const req = switchRequest(doc);
    if (typeof req !== 'string') return switchModule.renderPdf!(req, { ...process.env, PDF_RENDERER: 'chromium' });
    const { html, options } = renderCall(doc);
    return renderPdfUtil.renderHtmlToPdf(html, options);
  },
};

export function loadNativeRenderer(): Renderer | { unavailable: string } {
  if (typeof switchModule.renderPdf !== 'function') {
    return { unavailable: 'render-pdf.util.ts exports no renderPdf(doc, env) switch yet (worker/pdf-without-chromium not merged into this tree)' };
  }
  return {
    name: 'native',
    render: async (doc) => {
      const req = switchRequest(doc);
      if (typeof req === 'string') throw new NativeNotConvertedError(doc.kind, req);
      return switchModule.renderPdf!(req, { ...process.env, PDF_RENDERER: 'native' });
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
