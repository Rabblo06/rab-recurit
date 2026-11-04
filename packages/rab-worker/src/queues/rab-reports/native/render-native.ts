import { renderToBuffer } from '@react-pdf/renderer';

import { buildFinalTimesheetViewModel, FinalTimesheetData } from '@rab/server/modules/attendance/templates/final-timesheet.view-model';

import { buildPreShiftReportViewModel, PreShiftReportData } from '@rab/server/modules/attendance/templates/pre-shift-report.view-model';

import { FinalTimesheetDocument } from './final-timesheet.native';
import { PreShiftReportDocument } from './pre-shift-report.native';
import { ensureNativePdfFonts } from './fonts';
import { h } from './document-components';

/**
 * Native PDF rendering (PDF_RENDERER=native, PDF renderer P1): @react-pdf/renderer — pure JavaScript (layout through
 * yoga's embedded WebAssembly, PDF writing through pdfkit), no browser, no child process, no native addon, no network.
 * Only `renderReportPdf` (render-pdf.util.ts) calls this, and only for the kinds in NATIVE_KINDS.
 *
 * Each document's rab-server view-model builder turns the job's data into display strings HERE, at the seam; the
 * layout receives only that view-model. INTERIM: rendering runs in-process; the render-runtime agent's worker_threads
 * pool (size 2, 30 s terminate, heap cap, empty env, plan §4.2) replaces `renderInProcess` behind this same function.
 */
export type NativeReportDocument = { kind: 'final-timesheet'; data: FinalTimesheetData } | { kind: 'pre-shift'; data: PreShiftReportData };

/** Native rendering of one document; resolves to PDF bytes. The caller (renderReportPdf) applies the deadline. */
export async function renderNativePdf(doc: NativeReportDocument): Promise<Buffer> {
  const pdf = await renderInProcess(doc);
  if (!Buffer.isBuffer(pdf) || pdf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('native PDF renderer: output is not a PDF');
  return pdf;
}

async function renderInProcess(doc: NativeReportDocument): Promise<Buffer> {
  ensureNativePdfFonts();
  switch (doc.kind) {
    case 'final-timesheet': {
      const vm = buildFinalTimesheetViewModel(doc.data);
      // D7: deterministic metadata — the document's own generatedAt, never the wall clock.
      const element = h(FinalTimesheetDocument, { vm, creationDate: new Date(doc.data.generatedAt) });
      return renderToBuffer(element as Parameters<typeof renderToBuffer>[0]);
    }
    case 'pre-shift': {
      const vm = buildPreShiftReportViewModel(doc.data);
      // D7: deterministic metadata — the document's own generatedAt, never the wall clock.
      const element = h(PreShiftReportDocument, { vm, creationDate: new Date(doc.data.generatedAt) });
      return renderToBuffer(element as Parameters<typeof renderToBuffer>[0]);
    }
    default: {
      // Exhaustive: with more than one kind, `doc` itself narrows to never here (so `doc.kind` would not compile).
      const unknown: never = doc;
      throw new Error(`native PDF renderer: no native layout for ${String((unknown as { kind?: unknown }).kind)}`);
    }
  }
}
