import { ReportActionsInput, reportActions } from './report-actions';

const start = new Date('2026-10-18T14:00:00Z');
const MIN = 60_000;
const pre = { fileId: 'f-pre', filename: 'shift-attendance-sheet.pdf' };
const fin = { fileId: 'f-final', filename: 'final-timesheet.pdf' };
const at = (offsetMs: number, over: Partial<ReportActionsInput> = {}) =>
  reportActions({
    now: new Date(start.getTime() + offsetMs),
    startsAt: start,
    shiftStatus: 'fully_filled',
    reportAvailableBeforeMinutes: 180,
    reportStatus: 'pending',
    ready: false,
    preShiftFile: pre,
    finalFile: null,
    ...over,
  });

describe('Shift report footer / Time-sheet document (server time)', () => {
  it('Stage A: more than REPORT_AVAILABLE_BEFORE_MINUTES before the start — no actions at all', () => {
    const a = at(-180 * MIN - 1_000);
    expect(a).toMatchObject({ stage: 'scheduled', timesheet: 'hidden', finalise: 'hidden', document: null });
    expect(a.timesheetAvailableAt).toBe(new Date(start.getTime() - 180 * MIN).toISOString());
  });

  it('Stage B: exactly at T-3h only Time-sheet, opening the pre-shift attendance sheet; never Finalise', () => {
    expect(at(-180 * MIN)).toMatchObject({ stage: 'pre_shift', timesheet: 'available', finalise: 'hidden', document: { kind: 'pre_shift', ...pre } });
    expect(at(-1_000)).toMatchObject({ stage: 'pre_shift', finalise: 'hidden' });
  });

  it('worker still generating the sheet: Preparing, never a broken document', () => {
    expect(at(-60 * MIN, { preShiftFile: null })).toMatchObject({ stage: 'pre_shift', timesheet: 'preparing', document: null });
  });

  it('Stage C: from the start, Time-sheet + Finalise & send — disabled until the server readiness rule holds', () => {
    expect(at(0)).toMatchObject({ stage: 'started', timesheet: 'available', finalise: 'disabled' });
    expect(at(8 * 60 * MIN, { ready: true })).toMatchObject({ stage: 'started', finalise: 'enabled' });
  });

  it('a cancelled shift never offers Finalise & send', () => {
    expect(at(60 * MIN, { shiftStatus: 'cancelled', ready: true }).finalise).toBe('hidden');
  });

  it('Stage E: finalised — one Time-sheet; the earlier sheet is never presented as the final timesheet while it is generated', () => {
    const pending = at(9 * 60 * MIN, { reportStatus: 'finalised', ready: true });
    expect(pending).toMatchObject({ stage: 'finalised', finalise: 'hidden', finalDocumentPending: true, document: { kind: 'pre_shift' } });
    const done = at(9 * 60 * MIN, { reportStatus: 'finalised', ready: true, finalFile: fin });
    expect(done).toMatchObject({ finalDocumentPending: false, document: { kind: 'final', ...fin }, preShiftDocument: { kind: 'pre_shift' } });
    expect(at(9 * 60 * MIN, { reportStatus: 'finalised', preShiftFile: null }).timesheet).toBe('preparing');
  });

  it('the window follows the configured REPORT_AVAILABLE_BEFORE_MINUTES', () => {
    expect(at(-50 * MIN, { reportAvailableBeforeMinutes: 45 }).stage).toBe('scheduled');
    expect(at(-45 * MIN, { reportAvailableBeforeMinutes: 45 }).stage).toBe('pre_shift');
  });
});
