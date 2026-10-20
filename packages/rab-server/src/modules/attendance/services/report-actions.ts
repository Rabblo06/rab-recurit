/**
 * The Venue Manager Shift report footer and Time-sheet document, decided ONCE on the server from DB time, so no client
 * re-derives the windows. Owner brief 2026-10-17 ("Time-sheet button routing"):
 *
 *  A. `scheduled`  now < starts_at − REPORT_AVAILABLE_BEFORE_MINUTES      → no actions.
 *  B. `pre_shift`  window open, before starts_at                          → Time-sheet only (pre-shift QR attendance sheet).
 *  C. `started`    starts_at ≤ now, report not finalised                  → Time-sheet + Finalise & send (enabled only when
 *                                                                           the server readiness rule holds).
 *  E. `finalised`  report finalised                                       → Time-sheet only (final PDF when it exists).
 *
 * A cancelled shift never offers Finalise & send. The document is "preparing" while the worker has not stored it yet
 * (the client shows a Preparing state with Retry, never a broken PDF). The QR attendance window, the five-hour
 * lifecycle and finalisation rules are independent of this and unchanged.
 */
export type ReportStage = 'scheduled' | 'pre_shift' | 'started' | 'finalised';
export type DocumentKind = 'pre_shift' | 'final';

export interface ReportDocumentRef {
  kind: DocumentKind;
  fileId: string;
  filename: string;
}

export interface ReportActions {
  stage: ReportStage;
  /** When the pre-shift Time-sheet becomes available (starts_at − REPORT_AVAILABLE_BEFORE_MINUTES). */
  timesheetAvailableAt: string;
  timesheet: 'hidden' | 'preparing' | 'available';
  finalise: 'hidden' | 'disabled' | 'enabled';
  /** What "Time-sheet" opens: the final PDF once stored, otherwise the pre-shift attendance sheet. */
  document: ReportDocumentRef | null;
  /** After finalisation, the final PDF is still being generated/stored. */
  finalDocumentPending: boolean;
  /** The earlier pre-shift sheet, still openable (labelled as such) after finalisation. */
  preShiftDocument: ReportDocumentRef | null;
}

export interface ReportActionsInput {
  now: Date;
  startsAt: Date;
  shiftStatus: string;
  reportAvailableBeforeMinutes: number;
  reportStatus: 'pending' | 'ready' | 'finalised';
  ready: boolean;
  preShiftFile: { fileId: string; filename: string } | null;
  finalFile: { fileId: string; filename: string } | null;
}

export function reportActions(i: ReportActionsInput): ReportActions {
  const availableAt = i.startsAt.getTime() - i.reportAvailableBeforeMinutes * 60_000;
  const now = i.now.getTime();
  const preShift: ReportDocumentRef | null = i.preShiftFile ? { kind: 'pre_shift', ...i.preShiftFile } : null;
  const final: ReportDocumentRef | null = i.finalFile ? { kind: 'final', ...i.finalFile } : null;
  const base = { timesheetAvailableAt: new Date(availableAt).toISOString(), preShiftDocument: preShift };

  if (i.reportStatus === 'finalised') {
    return {
      ...base,
      stage: 'finalised',
      timesheet: final || preShift ? 'available' : 'preparing',
      finalise: 'hidden',
      document: final ?? preShift,
      finalDocumentPending: !final,
    };
  }
  if (now < availableAt) {
    return { ...base, stage: 'scheduled', timesheet: 'hidden', finalise: 'hidden', document: null, finalDocumentPending: false };
  }
  const timesheet = preShift ? 'available' : 'preparing';
  if (now < i.startsAt.getTime()) {
    return { ...base, stage: 'pre_shift', timesheet, finalise: 'hidden', document: preShift, finalDocumentPending: false };
  }
  return {
    ...base,
    stage: 'started',
    timesheet,
    finalise: i.shiftStatus === 'cancelled' ? 'hidden' : i.ready ? 'enabled' : 'disabled',
    document: preShift,
    finalDocumentPending: false,
  };
}
