import { formatPence } from '@rab/shared';

import {
  DocumentShiftInfo,
  documentFooterTemplate,
  fmtDate,
  fmtDateTime,
  fmtMinutes,
  fmtTime,
} from '@rab/server/modules/attendance/templates/adolphus-document';
import { FinalTimesheetData, renderFinalTimesheetHtml } from '@rab/server/modules/attendance/templates/final-timesheet.html';
import { PreShiftReportData, renderPreShiftReportHtml } from '@rab/server/modules/attendance/templates/pre-shift-report.html';
import {
  APPROVED_SHIFT_STATEMENT_TITLE,
  ApprovedShiftStatementData,
  renderApprovedShiftStatementHtml,
  STATEMENT_DISCLAIMER,
  TO_BE_CONFIRMED,
} from '@rab/server/modules/payroll/templates/approved-shift-statement.html';

import { FileKind, FileKindType } from '@rab/server/engine/core-modules/storage/file-kinds';

/**
 * The Chromium `page.pdf()` options the job passed with the HTML (footer template, landscape). Declared here rather than
 * imported, because render-pdf.util.ts stops exporting them when Chromium is removed (P5, native only), and the harness
 * must compile on both trees.
 */
export interface RenderPdfOptions {
  footerTemplate?: string;
  landscape?: boolean;
}

/**
 * THE DOCUMENTS IN SCOPE — verified in code (2026-11-04, db053b92). `renderHtmlToPdf` has exactly three production
 * callers, all in `queues/rab-reports/`:
 *
 *   final-timesheet.job.ts         renderFinalTimesheetHtml   two variants: the unsigned ORIGINAL (`unsigned: true`,
 *                                                              FileKind.FINAL_TIMESHEET_PDF original-timesheet.pdf) and the
 *                                                              finalised one (final-timesheet.pdf); landscape + footer
 *   shift-report-scheduler.job.ts  renderPreShiftReportHtml   the pre-shift roster / "Shift attendance sheet" with the
 *                                                              signed Shift QR (FileKind.SHIFT_ROSTER_PDF); landscape + footer
 *   shift-statement.job.ts         renderApprovedShiftStatementHtml  the "payroll statement": an Approved Shift Statement
 *                                                              for ONE payroll record (FileKind.APPROVED_SHIFT_STATEMENT_PDF);
 *                                                              `renderHtmlToPdf(html)` — portrait, NO footer
 *
 * PAYSLIP_PDF is an uploaded provider document (payroll-run.service.ts), never rendered; no other code renders a PDF.
 *
 * `ReportDocument` is the structured input of one render — what a native (non-HTML) renderer consumes. `renderCall`
 * returns exactly the `(html, options)` pair the job passes to `renderHtmlToPdf` for it.
 */
export type DocumentKind = 'final-timesheet-original' | 'final-timesheet' | 'pre-shift-report' | 'approved-shift-statement';

export type ReportDocument =
  | { kind: 'final-timesheet-original' | 'final-timesheet'; data: FinalTimesheetData; shift: DocumentShiftInfo }
  /** `qrPayload`: the signed Shift QR token the job encoded into `data.qrPngBase64` (what a scanner must read back). */
  | { kind: 'pre-shift-report'; data: PreShiftReportData; shift: DocumentShiftInfo; qrPayload: string }
  | { kind: 'approved-shift-statement'; data: ApprovedShiftStatementData };

export interface DocumentSpec {
  title: string;
  /** Table header labels in order; null when the document has no repeating table header. */
  tableHeader: readonly string[] | null;
  /** Whether the job renders a per-page "Page n of N" footer. */
  hasFooter: boolean;
}

export const DOCUMENT_SPECS: Readonly<Record<DocumentKind, DocumentSpec>> = Object.freeze({
  'final-timesheet-original': {
    title: 'ORIGINAL TIMESHEET',
    tableHeader: ['Staff member', 'Start', 'Finish', 'Break', 'Hours', 'Status', 'Staff review / 1–5'],
    hasFooter: true,
  },
  'final-timesheet': {
    title: 'FINAL TIMESHEET',
    tableHeader: ['Staff member', 'Start', 'Finish', 'Break', 'Hours', 'Status', 'Staff review / 1–5'],
    hasFooter: true,
  },
  'pre-shift-report': {
    title: 'SHIFT ATTENDANCE SHEET',
    tableHeader: ['Assigned staff', 'Scheduled start', 'Scheduled finish', 'Planned break'],
    hasFooter: true,
  },
  'approved-shift-statement': { title: APPROVED_SHIFT_STATEMENT_TITLE.toUpperCase(), tableHeader: null, hasFooter: false },
});

/**
 * How the production job stores each document: its FileKind (which decides the storage content rule, size ceiling and
 * download policy) and the filename it passes to `files.putObject`. Pinned against the job sources by
 * pdf-harness.unit.spec.ts, so this map cannot drift from what the jobs do.
 */
export const DOCUMENT_FILES: Readonly<Record<DocumentKind, { job: string; fileKind: FileKindType; filename(doc: ReportDocument): string }>> = Object.freeze({
  'final-timesheet-original': { job: 'final-timesheet.job.ts', fileKind: FileKind.FINAL_TIMESHEET_PDF, filename: () => 'original-timesheet.pdf' },
  'final-timesheet': { job: 'final-timesheet.job.ts', fileKind: FileKind.FINAL_TIMESHEET_PDF, filename: () => 'final-timesheet.pdf' },
  'pre-shift-report': { job: 'shift-report-scheduler.job.ts', fileKind: FileKind.SHIFT_ROSTER_PDF, filename: () => 'shift-attendance-sheet.pdf' },
  'approved-shift-statement': {
    job: 'shift-statement.job.ts',
    fileKind: FileKind.APPROVED_SHIFT_STATEMENT_PDF,
    filename: (doc) => (doc.kind === 'approved-shift-statement' ? `approved-shift-statement-${doc.data.statementReference}.pdf` : 'n/a'),
  },
});

/** The `(html, options)` the production job passes to `renderHtmlToPdf` for this document. */
export function renderCall(doc: ReportDocument): { html: string; options: RenderPdfOptions } {
  switch (doc.kind) {
    case 'final-timesheet-original':
      // final-timesheet.job.ts: renderFinalTimesheetHtml({ ...template, unsigned: true }), { footerTemplate, landscape: true }
      return { html: renderFinalTimesheetHtml({ ...doc.data, unsigned: true }), options: { footerTemplate: documentFooterTemplate(doc.shift), landscape: true } };
    case 'final-timesheet':
      return { html: renderFinalTimesheetHtml(doc.data), options: { footerTemplate: documentFooterTemplate(doc.shift), landscape: true } };
    case 'pre-shift-report':
      return { html: renderPreShiftReportHtml(doc.data), options: { footerTemplate: documentFooterTemplate(doc.shift), landscape: true } };
    case 'approved-shift-statement':
      // shift-statement.job.ts: renderHtmlToPdf(html) — no options.
      return { html: renderApprovedShiftStatementHtml(doc.data), options: {} };
  }
}

/** A business value the document must print, and how many times at least. */
export interface BusinessValue {
  /** Where it comes from, for the report (e.g. "row 3 clock-in"). Values with the same text are merged. */
  label: string;
  value: string;
  min: number;
}

export interface DocumentExpectation {
  kind: DocumentKind;
  spec: DocumentSpec;
  values: BusinessValue[];
  /** QR payloads the document must carry (the signed Shift QR token on the roster). */
  qrPayloads: string[];
  /** Text that marks a page as carrying table rows (each staff member's name): such a page must repeat the header. */
  rowMarkers: string[];
  /**
   * Free-text fields whose value holds line breaks (owner decision 2026-11-04: notes keep their original line breaks).
   * Every line of such a value must start a printed line, in order (checker.ts `line-breaks`).
   */
  multiLine: BusinessValue[];
  /**
   * Parse-back (P0 plan §5.2 4(b)): numbers printed as text must parse back to the source exactly. `durations` is the
   * multiset of every "Xh Ym" the document prints, `breaks` of every "N min"; `fields` are labelled single values.
   */
  parseBack: {
    durations: number[];
    breaks: number[];
    fields: ParseBackField[];
  };
}

/**
 * A labelled printed value: `pattern` captures the printed text (group 1), which must parse to `want` exactly and be
 * printed once. `count`: the pattern must simply match `want` times.
 */
export interface ParseBackField {
  label: string;
  pattern: RegExp;
  parse: 'minutes' | 'pence' | 'integer' | 'count';
  want: bigint;
}

/** Regex sources (RegExp objects' `.source`, so no string-escape pitfalls) for a printed amount and a printed duration. */
const PENCE = /(-?£[\d,]+\.\d{2})/.source;
const DURATION = /(\d+h(?: \d+m)?)/.source;

const nonEmpty = (v: string | null | undefined): v is string => typeof v === 'string' && v.trim().length > 0;

function add(values: BusinessValue[], label: string, value: string | null | undefined, min = 1): void {
  if (!nonEmpty(value)) return;
  const existing = values.find((v) => v.value === value);
  if (existing) {
    existing.min += min;
    if (!existing.label.includes(label)) existing.label = `${existing.label}; ${label}`;
  } else values.push({ label, value, min });
}

/**
 * A line break in stored text: LF, CRLF, a lone CR, U+2028 or U+2029. The native renderer prints every one of them as a
 * line break (glyph guard, review L-6); HTML treats LF, CRLF and a lone CR as line ends.
 */
export const LINE_BREAK = /\r\n|\r|\n|\u2028|\u2029/;

/**
 * The free-text fields each document prints that keep their line breaks — the shift notes, on the final timesheet (both
 * variants) and on the pre-shift roster (the Approved Shift Statement has no free text). Owner decision 2026-11-04:
 * notes keep their original line breaks; the field list agreed with the renderer agents is NOTES-FIELDS.md.
 */
export function multiLineFields(doc: ReportDocument): BusinessValue[] {
  if (doc.kind === 'approved-shift-statement') return [];
  const notes = doc.data.notes;
  return nonEmpty(notes) && LINE_BREAK.test(notes) ? [{ label: 'shift notes', value: notes, min: 1 }] : [];
}

function shiftValues(values: BusinessValue[], s: DocumentShiftInfo): void {
  add(values, 'venue name', s.venueName);
  add(values, 'venue address', s.venueAddress);
  add(values, 'role', s.roleName);
  add(values, 'shift date', fmtDate(s.startsAt, s.timezone));
  add(values, 'scheduled window', `${fmtTime(s.startsAt, s.timezone)}–${fmtTime(s.endsAt, s.timezone)}`);
  add(values, 'contact name', s.contactName);
  add(values, 'contact phone', s.contactPhone);
  add(values, 'shift reference', s.shiftReference);
  add(values, 'shift notes', s.notes);
  add(values, 'footer workspace', s.workspaceName);
  add(values, 'footer generated time', fmtDateTime(s.generatedAt, s.timezone));
}

/**
 * The values each document must print, derived from the render input with the templates' OWN exported formatters
 * (`fmtDate` / `fmtTime` / `fmtDateTime` / `fmtMinutes` / `formatPence`) — never re-derived arithmetic. Labels and
 * column headings are not business values; the token comparison covers them.
 */
export function expectationFor(doc: ReportDocument): DocumentExpectation {
  const values: BusinessValue[] = [];
  const spec = DOCUMENT_SPECS[doc.kind];
  let qrPayloads: string[] = [];
  let rowMarkers: string[] = [];
  const parseBack: DocumentExpectation['parseBack'] = { durations: [], breaks: [], fields: [] };
  switch (doc.kind) {
    case 'final-timesheet-original':
    case 'final-timesheet': {
      const d = doc.data;
      const tz = d.timezone;
      shiftValues(values, d);
      d.staff.forEach((s, i) => {
        const row = `row ${i + 1}`;
        add(values, `${row} name`, s.name);
        add(values, `${row} staff ref`, s.staffRef);
        if (s.clockInAt) add(values, `${row} clock-in`, fmtTime(s.clockInAt, tz));
        if (s.clockOutAt) add(values, `${row} clock-out`, fmtTime(s.clockOutAt, tz));
        if (s.assignmentStatus !== 'no_show' && s.breakMinutes != null) add(values, `${row} break`, `${s.breakMinutes} min`);
        if (s.workedMinutes != null) add(values, `${row} worked`, fmtMinutes(s.workedMinutes));
        if (doc.kind === 'final-timesheet' && s.review) {
          const r = s.review;
          add(values, `${row} review`, `Grooming ${r.grooming}/5 · Attitude ${r.attitude}/5 · Skills ${r.skills}/5`);
          add(values, `${row} review`, `Attendance ${r.attendance}/5 · Time keeping ${r.timeKeeping}/5`);
        }
      });
      // Stored worked minutes (never recomputed) per row, plus the printed total of those stored minutes.
      const worked = d.staff.map((s) => s.workedMinutes).filter((m): m is number => m != null);
      const total = worked.reduce((a, b) => a + b, 0);
      parseBack.durations.push(...worked, total);
      parseBack.breaks.push(...d.staff.filter((s) => s.assignmentStatus !== 'no_show' && s.breakMinutes != null).map((s) => s.breakMinutes!));
      parseBack.fields.push(
        { label: 'total worked hours', pattern: new RegExp(`Total worked hours: ${DURATION}`), parse: 'minutes', want: BigInt(total) },
        { label: 'corrected entries', pattern: /Corrected entries: (\d+)/, parse: 'integer', want: BigInt(d.staff.filter((s) => s.corrected).length) },
        {
          label: 'missing clock-outs',
          pattern: /Missing clock-outs: (\d+)/,
          parse: 'integer',
          want: BigInt(d.staff.filter((s) => s.assignmentStatus !== 'no_show' && !s.clockOutAt).length),
        },
        { label: 'staff count', pattern: /· (\d+) staff/, parse: 'integer', want: BigInt(d.staff.length) },
      );
      if (doc.kind === 'final-timesheet') {
        add(values, 'finalised by (signature name)', d.finalisedByName);
        add(values, 'finalised at', fmtDateTime(d.finalisedAt, tz));
        add(values, 'typed sign-off (signature name)', d.signedOffName);
      }
      rowMarkers = d.staff.map((s) => s.name);
      break;
    }
    case 'pre-shift-report': {
      const d = doc.data;
      const tz = d.timezone;
      shiftValues(values, d);
      d.staff.forEach((s, i) => {
        const row = `row ${i + 1}`;
        add(values, `${row} name`, s.name);
        add(values, `${row} staff ref`, s.staffRef);
        add(values, `${row} scheduled start`, fmtTime(s.scheduledStart, tz));
        add(values, `${row} scheduled finish`, fmtTime(s.scheduledEnd, tz));
        if (s.breakMinutes != null) add(values, `${row} planned break`, `${s.breakMinutes} min`);
      });
      rowMarkers = d.staff.map((s) => s.name);
      qrPayloads = [doc.qrPayload];
      parseBack.breaks.push(...d.staff.filter((s) => s.breakMinutes != null).map((s) => s.breakMinutes!));
      parseBack.fields.push({ label: 'assigned staff count', pattern: /Before shift · (\d+) assigned staff/, parse: 'integer', want: BigInt(d.staff.length) });
      break;
    }
    case 'approved-shift-statement': {
      const d = doc.data;
      const tz = d.timezone;
      add(values, 'statement reference', d.statementReference);
      add(values, 'employer', d.employerName);
      add(values, 'workspace', d.workspaceName);
      add(values, 'staff name', d.staffName);
      add(values, 'staff ref', d.staffRef);
      add(values, 'venue', d.venueName);
      add(values, 'role', d.roleName);
      add(values, 'shift date', fmtDate(d.scheduledStart, tz));
      add(values, 'scheduled start', fmtTime(d.scheduledStart, tz));
      add(values, 'scheduled finish', fmtTime(d.scheduledEnd, tz));
      if (d.clockInAt) add(values, 'clock-in', fmtDateTime(d.clockInAt, tz));
      if (d.clockOutAt) add(values, 'clock-out', fmtDateTime(d.clockOutAt, tz));
      if (d.breakMinutes != null && d.breakMinutes > 0) add(values, 'break', fmtMinutes(d.breakMinutes));
      add(values, 'payable hours', fmtMinutes(d.payableMinutes));
      add(values, 'hourly rate (pence → £)', `${formatPence(d.payRatePence)} per hour`);
      add(values, 'approved gross (pence → £)', formatPence(d.amountPence));
      add(values, 'approval date', fmtDateTime(d.approvedAt, tz));
      add(values, 'approved by (signature name)', d.approvedByName);
      add(values, 'payroll period', d.payrollPeriodLabel ?? TO_BE_CONFIRMED);
      add(values, 'payday', d.paydayLabel ?? TO_BE_CONFIRMED);
      add(values, 'generated time', fmtDateTime(d.generatedAt, tz));
      add(values, 'not-a-payslip disclaimer', STATEMENT_DISCLAIMER);
      parseBack.fields.push(
        { label: 'verified payable hours (stored minutes)', pattern: new RegExp(`Verified payable hours ${DURATION}`), parse: 'minutes', want: BigInt(d.payableMinutes) },
        { label: 'approved hourly rate (pence)', pattern: new RegExp(`Approved hourly rate ${PENCE} per hour`), parse: 'pence', want: BigInt(d.payRatePence) },
        { label: 'approved gross (pence)', pattern: new RegExp(`Approved gross ${PENCE}`), parse: 'pence', want: BigInt(d.amountPence) },
      );
      if (!d.payrollPeriodLabel && !d.paydayLabel) {
        parseBack.fields.push({ label: '"To be confirmed" (no period)', pattern: new RegExp(`(${TO_BE_CONFIRMED})`), parse: 'count', want: 2n });
      }
      break;
    }
  }
  return { kind: doc.kind, spec, values, qrPayloads, rowMarkers, multiLine: multiLineFields(doc), parseBack };
}
