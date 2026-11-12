import { buildFinalTimesheetViewModel, FinalTimesheetData } from '@rab/server/modules/attendance/templates/final-timesheet.view-model';
import { buildPreShiftReportViewModel, PreShiftReportData } from '@rab/server/modules/attendance/templates/pre-shift-report.view-model';
import { ApprovedShiftStatementData, buildApprovedShiftStatementViewModel } from '@rab/server/modules/payroll/templates/approved-shift-statement.view-model';

import { renderInPool } from './runtime/render-pool';
import type { NativeRenderRequest } from './runtime/render-protocol';

/**
 * Native PDF rendering (PDF_RENDERER=native, PDF renderer P1). Only `renderReportPdf` (render-pdf.util.ts) calls this,
 * and only for the kinds in NATIVE_KINDS.
 *
 * Here, in the jobs process, each document's rab-server view-model builder turns the job's data into display strings;
 * only that plain view-model crosses into the render pool (runtime/render-pool.ts: worker_threads, size
 * PDF_NATIVE_CONCURRENCY, empty env, 384 MB heap cap within PDF_NATIVE_MEMORY_BUDGET_MB, glyph-coverage guard, sha256-verified fonts, the 30 s deadline
 * enforced by terminating the thread → PdfRenderTimeoutError). The layouts run in the thread from
 * native-documents.ts. Errors propagate unchanged: no fallback to Chromium (T3).
 */
export type NativeReportDocument =
  | { kind: 'final-timesheet'; data: FinalTimesheetData }
  | { kind: 'pre-shift'; data: PreShiftReportData }
  | { kind: 'approved-shift-statement'; data: ApprovedShiftStatementData };

/**
 * The pool request for one document: its rab-server view-model and its own timestamp. Exported so the harness can send
 * the same requests to a pool whose thread history it controls (pdf-native-determinism.spec.ts).
 */
export function nativeRenderRequest(doc: NativeReportDocument): NativeRenderRequest {
  switch (doc.kind) {
    case 'final-timesheet':
      // D7: generatedAt becomes the PDF creation date (and the thread's clock), never the wall clock.
      return { kind: 'final-timesheet', viewModel: buildFinalTimesheetViewModel(doc.data), generatedAt: doc.data.generatedAt };
    case 'pre-shift':
      // Roster (#59): its view-model carries the signed QR PNG as base64 (plain data, postMessage-safe).
      return { kind: 'pre-shift', viewModel: buildPreShiftReportViewModel(doc.data), generatedAt: doc.data.generatedAt };
    case 'approved-shift-statement':
      // Statement (#57): the SAME view-model builder the Chromium template prints from (money via formatPence, stored
      // minutes, org-timezone dates); the layout does no arithmetic.
      return { kind: 'approved-shift-statement', viewModel: buildApprovedShiftStatementViewModel(doc.data), generatedAt: doc.data.generatedAt };
    default: {
      // Exhaustive: with more than one kind, `doc` itself narrows to never here (so `doc.kind` would not compile).
      const unknown: never = doc;
      throw new Error(`native PDF renderer: no native layout for ${String((unknown as { kind?: unknown }).kind)}`);
    }
  }
}

export async function renderNativePdf(doc: NativeReportDocument): Promise<Buffer> {
  return renderInPool(nativeRenderRequest(doc));
}
