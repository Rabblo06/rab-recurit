import {
  DocumentFooterView,
  DocumentShiftInfo,
  documentFooterView,
  fmtDateTime,
  fmtMinutes,
  fmtTime,
  initials,
  ShiftDetailsView,
  shiftDetailsView,
} from './adolphus-document';

/**
 * FINAL TIMESHEET view-model: every string either PDF renderer prints, decided ONCE from the job's data.
 *
 * Both renderers consume this and only this (PDF renderer migration P1): the Chromium HTML template
 * (`final-timesheet.html.ts`, which escapes every value) and the native renderer in rab-worker
 * (`queues/rab-reports/native/`, which draws plain text and never interprets markup). No business rule lives in either
 * renderer: worked minutes are the attendance service's stored values (`@rab/shared` duration rules, never recomputed
 * here — the total is their plain sum, as before), times and dates use the organisation timezone through the shared
 * `fmt*` helpers, labels and counts are computed here.
 *
 * Only recorded facts are printed: actual clock in/out, recorded break, worked minutes, correction / missing / no-show
 * markers, real per-shift staff reviews when one was saved (otherwise "Not reviewed"), and the typed sign-off with the
 * server-recorded account and time. Staff signatures are not collected by the product, so there is no signature column;
 * the typed sign-off is labelled as such and never presented as a handwritten or cryptographic signature.
 */
export interface StaffReviewScores {
  grooming: number;
  attitude: number;
  skills: number;
  attendance: number;
  timeKeeping: number;
}

export interface FinalTimesheetStaffRow {
  name: string;
  staffRef?: string | null;
  roleName: string;
  scheduledStart: string;
  scheduledEnd: string;
  clockInAt: string | null;
  clockOutAt: string | null;
  breakMinutes: number | null;
  workedMinutes: number | null;
  /** Attendance status, or `absent` when no attendance row exists. */
  status: string;
  assignmentStatus?: string;
  corrected: boolean;
  review?: StaffReviewScores | null;
}

export interface FinalTimesheetData extends DocumentShiftInfo {
  staff: FinalTimesheetStaffRow[];
  unsigned?: boolean;
  finalisedByName: string;
  finalisedAt: string;
  /** Typed full-name sign-off (1786718300000); absent on reports finalised before it existed. */
  signedOffName?: string | null;
  breakConfirmed?: boolean | null;
}

/** A run of text and whether it is printed in the muted (grey) style. */
export interface TextLine {
  text: string;
  muted: boolean;
}

export interface FinalTimesheetRowView {
  name: string;
  initials: string;
  /** "staff ref · role" (either part optional). */
  sub: string;
  clockIn: string;
  clockOut: string;
  /** The clock-out cell is flagged (amber, bold): no clock-out and not a no-show. */
  clockOutFlagged: boolean;
  breakText: string;
  hours: string;
  status: string;
  /** "(corrected)" under the status when the attendance has a correction, else null. */
  correctedNote: string | null;
  /** One or two lines: "After manager review" (original), "Not reviewed", or the five scores. */
  review: { lines: string[]; muted: boolean };
}

export interface FinalTimesheetViewModel {
  /** Document metadata title (HTML <title>, PDF /Title). */
  documentTitle: string;
  /** The header title, printed upper-case by both renderers. */
  title: string;
  unsigned: boolean;
  details: ShiftDetailsView;
  summary: string;
  columns: readonly string[];
  rows: FinalTimesheetRowView[];
  /** Printed in place of the rows when there are none. */
  emptyText: string;
  scaleLegend: string;
  notesHeading: string;
  notes: TextLine;
  counts: string;
  signOffHeading: string;
  signOff: TextLine[];
  totalWorked: string;
  footer: DocumentFooterView;
}

const STATUS_LABEL: Record<string, string> = {
  approved: 'Approved',
  clocked_out: 'Clocked out',
  under_review: 'Under review',
  missing_clock_out: 'Missing clock-out',
  clocked_in: 'Clocked in',
  on_break: 'On break',
  late: 'Late',
  absent: 'No attendance',
  disputed: 'Disputed',
};

function statusLabel(s: FinalTimesheetStaffRow): string {
  if (s.assignmentStatus === 'no_show') return 'No-show';
  return STATUS_LABEL[s.status] ?? s.status.replace(/_/g, ' ');
}

export const FINAL_TIMESHEET_COLUMNS = Object.freeze(['Staff member', 'Start', 'Finish', 'Break', 'Hours', 'Status', 'Staff review / 1–5']);

export function buildFinalTimesheetViewModel(data: FinalTimesheetData): FinalTimesheetViewModel {
  const tz = data.timezone;
  const unsigned = !!data.unsigned;
  const totalWorked = data.staff.reduce((sum, s) => sum + (s.workedMinutes ?? 0), 0);
  const corrected = data.staff.filter((s) => s.corrected).length;
  const missing = data.staff.filter((s) => s.assignmentStatus !== 'no_show' && !s.clockOutAt).length;

  const rows = data.staff.map((s): FinalTimesheetRowView => {
    const isMissing = !s.clockOutAt && s.assignmentStatus !== 'no_show';
    const r = s.review;
    return {
      name: s.name,
      initials: initials(s.name),
      sub: [s.staffRef, s.roleName].filter(Boolean).join(' · '),
      clockIn: fmtTime(s.clockInAt, tz),
      clockOut: s.clockOutAt ? fmtTime(s.clockOutAt, tz) : isMissing ? 'Missing' : '—',
      clockOutFlagged: isMissing,
      breakText: s.assignmentStatus !== 'no_show' && s.breakMinutes != null ? `${s.breakMinutes} min` : '—',
      hours: fmtMinutes(s.workedMinutes),
      status: statusLabel(s),
      correctedNote: s.corrected ? '(corrected)' : null,
      review: unsigned
        ? { lines: ['After manager review'], muted: true }
        : !r
          ? { lines: ['Not reviewed'], muted: true }
          : {
              lines: [
                `Grooming ${r.grooming}/5 · Attitude ${r.attitude}/5 · Skills ${r.skills}/5`,
                `Attendance ${r.attendance}/5 · Time keeping ${r.timeKeeping}/5`,
              ],
              muted: false,
            },
    };
  });

  const signOff: TextLine[] = unsigned
    ? [{ text: 'Original Timesheet - Unsigned. Not yet reviewed by a manager.', muted: true }]
    : [
        { text: `Reviewed by ${data.finalisedByName} - Finalised at ${fmtDateTime(data.finalisedAt, tz)}`, muted: false },
        ...(data.signedOffName
          ? [
              { text: `Signed off as "${data.signedOffName}"${data.breakConfirmed ? ' - break details confirmed accurate' : ''}`, muted: false },
              { text: 'Typed sign-off recorded with the account above; not a handwritten signature.', muted: true },
            ]
          : []),
      ];

  return {
    documentTitle: `Final timesheet — ${data.venueName}`,
    title: unsigned ? 'Original timesheet' : 'Final timesheet',
    unsigned,
    details: shiftDetailsView(data),
    summary: unsigned
      ? `Original timesheet · unsigned · before manager review · ${data.staff.length} staff`
      : `Manager reviewed: ${fmtDateTime(data.finalisedAt, tz)} · ${data.staff.length} staff`,
    columns: FINAL_TIMESHEET_COLUMNS,
    rows,
    emptyText: 'No staff on this shift.',
    scaleLegend: '5 Excellent · 4 Good · 3 Satisfactory · 2 Needs improvement · 1 Poor',
    notesHeading: 'NOTES',
    notes: data.notes && data.notes.trim() ? { text: data.notes, muted: false } : { text: 'No shift notes.', muted: true },
    counts: `Corrected entries: ${corrected} · Missing clock-outs: ${missing}`,
    signOffHeading: 'MANAGER SIGN-OFF',
    signOff,
    totalWorked: `Total worked hours: ${fmtMinutes(totalWorked)}`,
    footer: documentFooterView(data),
  };
}
