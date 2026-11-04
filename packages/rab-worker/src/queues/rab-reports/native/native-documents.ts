import { createElement as h } from 'react';

import type { FinalTimesheetViewModel } from '@rab/server/modules/attendance/templates/final-timesheet.view-model';

import { FinalTimesheetDocument } from './final-timesheet.native';
import type { NativeDocumentMeta } from './runtime/render-protocol';

/**
 * The native document registry, loaded INSIDE the render thread (runtime/render-thread.ts `require`s this module by
 * path). Each entry turns a view-model (built in the jobs process by the document's rab-server builder) into the
 * react-pdf element; `meta` carries the deterministic creation date (D7).
 *
 * Everything imported from here runs in the guarded thread: layouts and the shared components only — no business
 * logic, nothing that reaches TypeORM, pg, ioredis, BullMQ, Nest services or any socket module (the thread refuses
 * them). rab-server imports are type-only, except the logo module (a string constant).
 * Roster and statement layouts add their kinds here (with NATIVE_KINDS in render-pdf.util.ts).
 */
export const NATIVE_DOCUMENT_REGISTRY = Object.freeze({
  'final-timesheet': (vm: unknown, meta: NativeDocumentMeta) =>
    h(FinalTimesheetDocument, { vm: vm as FinalTimesheetViewModel, creationDate: meta.creationDate }),
  // INTEGRATION SLOT 'pre-shift' (#59, roster): import { PreShiftReportDocument } from './pre-shift-report.native';
  //   'pre-shift': (vm: unknown, meta: NativeDocumentMeta) => h(PreShiftReportDocument, { vm: vm as PreShiftReportViewModel, creationDate: meta.creationDate }),
  // INTEGRATION SLOT 'approved-shift-statement' (#57, payroll): import { ApprovedShiftStatementDocument } from './approved-shift-statement.native';
  //   'approved-shift-statement': (vm: unknown, meta: NativeDocumentMeta) => h(ApprovedShiftStatementDocument, { vm: vm as ApprovedShiftStatementViewModel, creationDate: meta.creationDate }),
  // Each slot also needs: the kind in NATIVE_KINDS (render-pdf.util.ts) and a `case` in render-native.ts that calls
  // renderInPool({ kind, viewModel: build…ViewModel(doc.data), generatedAt: doc.data.generatedAt }).
});
