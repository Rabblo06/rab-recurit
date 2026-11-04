import { buildFinalTimesheetViewModel, FinalTimesheetData } from '@rab/server/modules/attendance/templates/final-timesheet.view-model';

import { buildPreShiftReportViewModel, PreShiftReportData } from '@rab/server/modules/attendance/templates/pre-shift-report.view-model';

import { renderInPool } from './runtime/render-pool';

/**
 * Native PDF rendering (PDF_RENDERER=native, PDF renderer P1). Only `renderReportPdf` (render-pdf.util.ts) calls this,
 * and only for the kinds in NATIVE_KINDS.
 *
 * Here, in the jobs process, each document's rab-server view-model builder turns the job's data into display strings;
 * only that plain view-model crosses into the render pool (runtime/render-pool.ts: worker_threads, size
 * PDF_NATIVE_CONCURRENCY, empty env, 512 MB heap cap, glyph-coverage guard, sha256-verified fonts, the 30 s deadline
 * enforced by terminating the thread → PdfRenderTimeoutError). The layouts run in the thread from
 * native-documents.ts. Errors propagate unchanged: no fallback to Chromium (T3).
 */
export type NativeReportDocument = { kind: 'final-timesheet'; data: FinalTimesheetData } | { kind: 'pre-shift'; data: PreShiftReportData };

export async function renderNativePdf(doc: NativeReportDocument): Promise<Buffer> {
  switch (doc.kind) {
    case 'final-timesheet':
      // D7: generatedAt becomes the PDF creation date (and the thread's clock), never the wall clock.
      return renderInPool({ kind: 'final-timesheet', viewModel: buildFinalTimesheetViewModel(doc.data), generatedAt: doc.data.generatedAt });
    case 'pre-shift':
      return renderInPool({ kind: 'pre-shift', viewModel: buildPreShiftReportViewModel(doc.data), generatedAt: doc.data.generatedAt });
    default: {
      // Exhaustive: with more than one kind, `doc` itself narrows to never here (so `doc.kind` would not compile).
      const unknown: never = doc;
      throw new Error(`native PDF renderer: no native layout for ${String((unknown as { kind?: unknown }).kind)}`);
    }
  }
}
