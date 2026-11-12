import { formatPence } from '@rab/shared';

import { fmtDate, fmtDateTime, fmtMinutes, fmtTime } from '../../attendance/templates/adolphus-document';

/**
 * Approved Shift Statement PDF (owner scope 2026-10-21). NOT a payslip: it confirms that one shift's earnings were
 * approved and that payment follows the agency payroll calendar. Built ONLY from the approved payroll record's frozen
 * figures (payable minutes, rate snapshot, gross) plus the recorded attendance and shift facts. "Payroll period" and
 * "Official scheduled payday" come from the agency payment calendar allocation (payroll-allocation.ts); with no
 * configured period they print "To be confirmed" — a payday is never computed. Money is pence.
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

/** One "label | value" row of the statement table. */
export interface StatementRowView {
  label: string;
  value: string;
}

/**
 * APPROVED SHIFT STATEMENT view-model: every string either PDF renderer prints, decided ONCE from the job's data
 * (PDF renderer migration). Both renderers consume this and only this: the Chromium HTML template
 * (`approved-shift-statement.html.ts`, which escapes every value) and the native renderer in rab-worker
 * (`queues/rab-reports/native/`, which draws plain text and never interprets markup).
 *
 * No business rule lives in either renderer. Money is the payroll record's frozen pence (rate snapshot and gross, never
 * recomputed) formatted by `@rab/shared` `formatPence`; payable minutes are the record's stored worked minutes; dates
 * and times use the organisation timezone through the shared `fmt*` helpers; the period / payday labels come from the
 * agency calendar allocation already resolved by the job.
 */
export interface ApprovedShiftStatementViewModel {
  /** Document metadata title (HTML <title>, PDF /Title). */
  documentTitle: string;
  /** The header title, printed upper-case by both renderers. */
  title: string;
  /** "Adolphus Recruitment · <employer>[ · <workspace>]". */
  brandLine: string;
  /** The green "earnings approved" banner. */
  approvedLine: string;
  staffLabel: string;
  staffName: string;
  /** "Staff reference <ref | —>". */
  staffRefLine: string;
  referenceLabel: string;
  statementReference: string;
  /** Venue … approved hourly rate. */
  details: StatementRowView[];
  /** "Approved gross" — the emphasised total row. */
  total: StatementRowView;
  /** Approval date, payroll period, official scheduled payday. */
  approval: StatementRowView[];
  /** "Generated <date, time>." */
  generatedLine: string;
  disclaimer: string;
}

export function buildApprovedShiftStatementViewModel(d: ApprovedShiftStatementData): ApprovedShiftStatementViewModel {
  const tz = d.timezone;
  const row = (label: string, value: string): StatementRowView => ({ label, value });
  const scheduledMinutes = Math.max(0, Math.round((new Date(d.scheduledEnd).getTime() - new Date(d.scheduledStart).getTime()) / 60_000));
  const breakText = d.breakMinutes == null ? '—'
    : d.breakMinutes === 0 ? 'None'
      : `${fmtMinutes(d.breakMinutes)}${d.breakPaid === true ? ' (paid)' : d.breakPaid === false ? ' (unpaid)' : ''}`;
  return {
    documentTitle: APPROVED_SHIFT_STATEMENT_TITLE,
    title: APPROVED_SHIFT_STATEMENT_TITLE,
    brandLine: `Adolphus Recruitment · ${d.employerName}${d.workspaceName ? ` · ${d.workspaceName}` : ''}`,
    approvedLine: SHIFT_EARNINGS_APPROVED_LINE,
    staffLabel: 'Staff member',
    staffName: d.staffName,
    staffRefLine: `Staff reference ${d.staffRef ?? '—'}`,
    referenceLabel: 'Statement reference',
    statementReference: d.statementReference,
    details: [
      row('Venue', d.venueName),
      row('Role', d.roleName),
      row('Shift date', fmtDate(d.scheduledStart, tz)),
      row('Scheduled hours', `${fmtTime(d.scheduledStart, tz)}–${fmtTime(d.scheduledEnd, tz)} (${fmtMinutes(scheduledMinutes)})`),
      row('Actual clock-in', d.clockInAt ? fmtDateTime(d.clockInAt, tz) : '—'),
      row('Actual clock-out', d.clockOutAt ? fmtDateTime(d.clockOutAt, tz) : '—'),
      row('Break', breakText),
      row('Verified payable hours', fmtMinutes(d.payableMinutes)),
      row('Approved hourly rate', `${formatPence(d.payRatePence)} per hour`),
    ],
    total: row('Approved gross', formatPence(d.amountPence)),
    approval: [
      row('Approval date', `${fmtDateTime(d.approvedAt, tz)}${d.approvedByName ? ` by ${d.approvedByName}` : ''}`),
      row('Payroll period', d.payrollPeriodLabel ?? TO_BE_CONFIRMED),
      row('Official scheduled payday', d.paydayLabel ?? TO_BE_CONFIRMED),
    ],
    generatedLine: `Generated ${fmtDateTime(d.generatedAt, tz)}.`,
    disclaimer: STATEMENT_DISCLAIMER,
  };
}
