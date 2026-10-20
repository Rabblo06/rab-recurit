import { escapeHtml } from '../../../engine/utils/escape-html';
import { DOCUMENT_CSS, DocumentShiftInfo, documentHeaderHtml, fmtDateTime, fmtMinutes, fmtTime, shiftDetailsHtml, staffCellHtml } from './adolphus-document';

/**
 * FINAL TIMESHEET (Adolphus Group template, owner design 2026-10-17). Two variants from the same data, as before: the
 * immutable unsigned ORIGINAL (`unsigned: true`, before manager review) and the finalised document.
 *
 * Only recorded facts are printed: actual clock in/out, recorded break, worked minutes as stored by the attendance
 * service (`@rab/shared` duration rules — never recomputed here), correction / missing / no-show markers, real per-shift
 * staff reviews when one was saved (otherwise "Not reviewed"), and the typed sign-off with the server-recorded account
 * and time. Staff signatures are not collected by the product, so there is no signature column; the typed sign-off is
 * labelled as such and never presented as a handwritten or cryptographic signature.
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

function reviewHtml(r: StaffReviewScores | null | undefined): string {
  if (!r) return '<span class="muted">Not reviewed</span>';
  return `Grooming ${r.grooming}/5 · Attitude ${r.attitude}/5 · Skills ${r.skills}/5<br>Attendance ${r.attendance}/5 · Time keeping ${r.timeKeeping}/5`;
}

export function renderFinalTimesheetHtml(data: FinalTimesheetData): string {
  const tz = data.timezone;
  const totalWorked = data.staff.reduce((sum, s) => sum + (s.workedMinutes ?? 0), 0);
  const corrected = data.staff.filter((s) => s.corrected).length;
  const missing = data.staff.filter((s) => s.assignmentStatus !== 'no_show' && !s.clockOutAt).length;
  const rows = data.staff
    .map((s) => {
      const isMissing = !s.clockOutAt && s.assignmentStatus !== 'no_show';
      const out = s.clockOutAt ? fmtTime(s.clockOutAt, tz) : isMissing ? 'Missing' : '—';
      return `
      <tr>
        <td>${staffCellHtml(s.name, [s.staffRef, s.roleName].filter(Boolean).join(' · '))}</td>
        <td>${escapeHtml(fmtTime(s.clockInAt, tz))}</td>
        <td${isMissing ? ' class="flag"' : ''}>${escapeHtml(out)}</td>
        <td>${s.assignmentStatus !== 'no_show' && s.breakMinutes != null ? `${s.breakMinutes} min` : '—'}</td>
        <td>${escapeHtml(fmtMinutes(s.workedMinutes))}</td>
        <td>${escapeHtml(statusLabel(s))}${s.corrected ? '<br><small class="muted">(corrected)</small>' : ''}</td>
        <td>${data.unsigned ? '<span class="muted">After manager review</span>' : reviewHtml(s.review)}</td>
      </tr>`;
    })
    .join('');

  const summary = data.unsigned
    ? `Original timesheet · unsigned · before manager review · ${data.staff.length} staff`
    : `Manager reviewed: ${escapeHtml(fmtDateTime(data.finalisedAt, tz))} · ${data.staff.length} staff`;

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Final timesheet — ${escapeHtml(data.venueName)}</title>
<style>${DOCUMENT_CSS}</style>
</head>
<body>
  ${documentHeaderHtml(data.unsigned ? 'Original timesheet' : 'Final timesheet')}
  <section class="top"><div>${shiftDetailsHtml(data)}</div></section>
  <div class="summary">${summary}</div>
  <table>
    <thead><tr><th style="width:26%">Staff member</th><th>Start</th><th>Finish</th><th>Break</th><th>Hours</th><th>Status</th><th style="width:28%">Staff review / 1–5</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="7" class="muted">No staff on this shift.</td></tr>'}</tbody>
  </table>
  <div class="note-line">5 Excellent · 4 Good · 3 Satisfactory · 2 Needs improvement · 1 Poor</div>
  <section class="bottom">
    <div>
      <h3>NOTES</h3>
      <p>${data.notes && data.notes.trim() ? escapeHtml(data.notes) : '<span class="muted">No shift notes.</span>'}</p>
      <p class="muted">Corrected entries: ${corrected} · Missing clock-outs: ${missing}</p>
    </div>
    <div>
      <h3>MANAGER SIGN-OFF</h3>
      ${data.unsigned
        ? '<p class="muted">Original Timesheet - Unsigned. Not yet reviewed by a manager.</p>'
        : `<p>Reviewed by ${escapeHtml(data.finalisedByName)} - Finalised at ${escapeHtml(fmtDateTime(data.finalisedAt, tz))}</p>
      ${data.signedOffName ? `<p>Signed off as "${escapeHtml(data.signedOffName)}"${data.breakConfirmed ? ' - break details confirmed accurate' : ''}</p><p class="muted">Typed sign-off recorded with the account above; not a handwritten signature.</p>` : ''}`}
      <p class="muted">Total worked hours: ${escapeHtml(fmtMinutes(totalWorked))}</p>
    </div>
  </section>
</body>
</html>`;
}
