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
});
