import { formatPence } from '@rab/shared';

import { escapeHtml } from '../../../engine/utils/escape-html';
import { DOCUMENT_CSS, documentHeaderHtml, fmtDate, fmtDateTime, fmtMinutes, fmtTime } from '../../attendance/templates/adolphus-document';

/**
 * Approved Shift Statement PDF (owner scope 2026-10-21). NOT a payslip: it confirms that one shift's earnings were
 * approved and that payment follows the agency payroll calendar. Built ONLY from the approved payroll record's frozen
 * figures (payable minutes, rate snapshot, gross) plus the recorded attendance and shift facts. "Payroll period" and
 * "Official scheduled payday" come from the agency payment calendar allocation (payroll-allocation.ts); with no
 * configured period they print "To be confirmed" — a payday is never computed. Every value is escaped; money is pence.
 */
export interface ApprovedShiftStatementData {
  statementReference: string;
  employerName: string;
  workspaceName: string | null;
  staffName: string;
  staffRef: string | null;
  venueName: string;
  roleName: string;
  scheduledStart: string;
  scheduledEnd: string;
  clockInAt: string | null;
  clockOutAt: string | null;
  breakMinutes: number | null;
  /** true / false when it can be read from the recorded figures; null when it cannot. */
  breakPaid: boolean | null;
  payableMinutes: number;
  payRatePence: number;
  amountPence: number;
  approvedAt: string;
  approvedByName: string | null;
  payrollPeriodLabel: string | null;
  paydayLabel: string | null;
  timezone: string;
  generatedAt: string;
}

export const APPROVED_SHIFT_STATEMENT_TITLE = 'Approved Shift Statement';
export const SHIFT_EARNINGS_APPROVED_LINE = 'Shift earnings approved — payment scheduled according to the agency payroll calendar.';
export const STATEMENT_DISCLAIMER =
  'This statement is not a payslip. It shows approved gross earnings for one shift only; it does not show tax, National Insurance or any other deductions.';
export const TO_BE_CONFIRMED = 'To be confirmed';

export function shiftStatementReference(recordId: string, startsAt: string, timezone: string): string {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(startsAt));
  return `ASS-${day.replace(/-/g, '')}-${recordId.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

/** Break paid/unpaid read from the recorded figures: payable = elapsed − break → unpaid; payable = elapsed → paid. */
export function breakPaidFromFigures(clockInAt: string | null, clockOutAt: string | null, breakMinutes: number | null, payableMinutes: number): boolean | null {
  if (!clockInAt || !clockOutAt || breakMinutes == null || breakMinutes === 0) return null;
  const elapsed = Math.max(0, Math.round((new Date(clockOutAt).getTime() - new Date(clockInAt).getTime()) / 60_000));
  if (payableMinutes === Math.max(0, elapsed - breakMinutes)) return false;
  if (payableMinutes === elapsed) return true;
  return null;
}

export function renderApprovedShiftStatementHtml(d: ApprovedShiftStatementData): string {
  const tz = d.timezone;
  const row = (label: string, value: string) => `<tr><th scope="row">${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`;
  const scheduledMinutes = Math.max(0, Math.round((new Date(d.scheduledEnd).getTime() - new Date(d.scheduledStart).getTime()) / 60_000));
  const breakText = d.breakMinutes == null ? '—'
    : d.breakMinutes === 0 ? 'None'
      : `${fmtMinutes(d.breakMinutes)}${d.breakPaid === true ? ' (paid)' : d.breakPaid === false ? ' (unpaid)' : ''}`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${APPROVED_SHIFT_STATEMENT_TITLE}</title><style>${DOCUMENT_CSS}
    @page { size: A4 portrait; }
    .brand { font-size: 11px; color: #6B7270; margin: -10px 0 14px; }
    .approved { margin: 0 0 16px; padding: 10px 12px; border-left: 3px solid #2E7D4F; background: #EEF7F1; font-size: 12px; font-weight: 600; }
    .grid { display: flex; gap: 32px; margin-bottom: 16px; }
    .grid > div { flex: 1; }
    .label { color: #8A8F8C; font-size: 9.5px; text-transform: uppercase; letter-spacing: .4px; margin-bottom: 3px; }
    .value { font-size: 12px; font-weight: 600; }
    table.kv th { background: #F4F5F3; color: #1F2321; width: 38%; font-weight: 600; }
    .total td, .total th { font-size: 13px; font-weight: 700; }
    .disclaimer { margin-top: 18px; padding: 10px 12px; border: 1px solid #F0C9A6; background: #FFF6EE; font-size: 10.5px; }
  </style></head><body>
  ${documentHeaderHtml(APPROVED_SHIFT_STATEMENT_TITLE)}
  <div class="brand">Adolphus Recruitment · ${escapeHtml(d.employerName)}${d.workspaceName ? ` · ${escapeHtml(d.workspaceName)}` : ''}</div>
  <div class="approved">${escapeHtml(SHIFT_EARNINGS_APPROVED_LINE)}</div>
  <div class="grid">
    <div><div class="label">Staff member</div><div class="value">${escapeHtml(d.staffName)}</div><div class="muted">Staff reference ${escapeHtml(d.staffRef ?? '—')}</div></div>
    <div><div class="label">Statement reference</div><div class="value">${escapeHtml(d.statementReference)}</div></div>
  </div>
  <table class="kv">
    <tbody>
      ${row('Venue', d.venueName)}
      ${row('Role', d.roleName)}
      ${row('Shift date', fmtDate(d.scheduledStart, tz))}
      ${row('Scheduled hours', `${fmtTime(d.scheduledStart, tz)}–${fmtTime(d.scheduledEnd, tz)} (${fmtMinutes(scheduledMinutes)})`)}
      ${row('Actual clock-in', d.clockInAt ? fmtDateTime(d.clockInAt, tz) : '—')}
      ${row('Actual clock-out', d.clockOutAt ? fmtDateTime(d.clockOutAt, tz) : '—')}
      ${row('Break', breakText)}
      ${row('Verified payable hours', fmtMinutes(d.payableMinutes))}
      ${row('Approved hourly rate', `${formatPence(d.payRatePence)} per hour`)}
    </tbody>
    <tbody class="total">${row('Approved gross', formatPence(d.amountPence))}</tbody>
    <tbody>
      ${row('Approval date', `${fmtDateTime(d.approvedAt, tz)}${d.approvedByName ? ` by ${d.approvedByName}` : ''}`)}
      ${row('Payroll period', d.payrollPeriodLabel ?? TO_BE_CONFIRMED)}
      ${row('Official scheduled payday', d.paydayLabel ?? TO_BE_CONFIRMED)}
    </tbody>
  </table>
  <p class="note-line">Generated ${escapeHtml(fmtDateTime(d.generatedAt, tz))}.</p>
  <div class="disclaimer">${escapeHtml(STATEMENT_DISCLAIMER)}</div>
</body></html>`;
}
