import { DocumentFooterView, DocumentShiftInfo, documentFooterView, fmtTime, initials, ShiftDetailsView, shiftDetailsView } from './adolphus-document';

/**
 * PRE-SHIFT ATTENDANCE SHEET (the roster) view-model: every string either PDF renderer prints, decided ONCE from the
 * job's data (PDF renderer migration). Both renderers consume this and only this: the Chromium HTML template
 * (`pre-shift-report.html.ts`, which escapes every value) and the native renderer in rab-worker
 * (`queues/rab-reports/native/pre-shift-report.document.ts`, which draws plain text and never interprets markup).
 *
 * No business rule lives here or in either renderer: each staff member's scheduled window and planned break are the
 * job's (`effectiveAssignmentTime` / `effectiveAssignmentBreakMinutes`), times use the organisation timezone through the
 * shared `fmtTime`, and the QR is the signed Shift QR PNG from `AttendanceQrService` + `QrImageService`, carried as the
 * same base64 bytes the job produced — never re-encoded or re-generated. Ratings, confirmation and signatures are not
 * part of this before-shift document.
 */
export interface PreShiftReportStaffRow {
  name: string;
  staffRef?: string | null;
  roleName: string;
  /** This staff member's effective scheduled window (per-assignment period, falling back to the shift's). */
  scheduledStart: string;
  scheduledEnd: string;
  breakMinutes: number | null;
}

export interface PreShiftReportData extends DocumentShiftInfo {
  staff: PreShiftReportStaffRow[];
  qrPngBase64: string;
}

export interface PreShiftReportRowView {
  name: string;
  initials: string;
  /** "staff ref · role" (either part optional). */
  sub: string;
  start: string;
  finish: string;
  /** "30 min", or "—" when no planned break. */
  breakText: string;
}

export interface PreShiftReportViewModel {
  /** Document metadata title (HTML <title>, PDF /Title). */
  documentTitle: string;
  /** The header title, printed upper-case by both renderers. */
  title: string;
  details: ShiftDetailsView;
  qr: {
    /** The signed Shift QR PNG exactly as `QrImageService.generatePng` returned it, base64 (no data: prefix). */
    pngBase64: string;
    alt: string;
    label: string;
    caption: string;
  };
  summary: string;
  columns: readonly string[];
  rows: PreShiftReportRowView[];
  /** Printed in place of the rows when there are none. */
  emptyText: string;
  noteLine: string;
  notesHeading: string;
  /** The shift's notes, or the muted "No shift notes." when there are none. */
  notes: { text: string; muted: boolean };
  /** Muted line under the notes. */
  qrScopeNote: string;
  beforeShiftHeading: string;
  beforeShiftLines: readonly string[];
  footer: DocumentFooterView;
}

export const PRE_SHIFT_REPORT_COLUMNS = Object.freeze(['Assigned staff', 'Scheduled start', 'Scheduled finish', 'Planned break']);

export function buildPreShiftReportViewModel(data: PreShiftReportData): PreShiftReportViewModel {
  const tz = data.timezone;
  return {
    documentTitle: `Shift attendance sheet — ${data.venueName}`,
    title: 'Shift attendance sheet',
    details: shiftDetailsView(data),
    qr: {
      pngBase64: data.qrPngBase64,
      alt: 'Shift QR code for clock in and clock out',
      label: 'CLOCK IN / OUT',
      caption: 'System-generated code',
    },
    summary: `Before shift · ${data.staff.length} assigned staff · Scan the QR in the staff app to clock in or out`,
    columns: PRE_SHIFT_REPORT_COLUMNS,
    rows: data.staff.map(
      (s): PreShiftReportRowView => ({
        name: s.name,
        initials: initials(s.name),
        sub: [s.staffRef, s.roleName].filter(Boolean).join(' · '),
        start: fmtTime(s.scheduledStart, tz),
        finish: fmtTime(s.scheduledEnd, tz),
        breakText: s.breakMinutes != null ? `${s.breakMinutes} min` : '—',
      }),
    ),
    emptyText: 'No confirmed staff yet.',
    noteLine: 'Staff review and signatures are added only after the venue manager reviews and confirms the report.',
    notesHeading: 'NOTES',
    notes: data.notes && data.notes.trim() ? { text: data.notes, muted: false } : { text: 'No shift notes.', muted: true },
    qrScopeNote: 'The QR grants attendance access for this shift only.',
    beforeShiftHeading: 'BEFORE-SHIFT DOCUMENT',
    beforeShiftLines: Object.freeze(['Use the QR above to clock in and clock out.', 'Ratings, confirmation and signatures are not included yet.']),
    footer: documentFooterView(data),
  };
}
