/**
 * Owner decision 29 (21 Nov 2026): the reports page v1. Five reports, filtered by period and venue, downloaded as CSV.
 * The Worker builds each export in the background; the user gets an in-app notice; the download is a single-use link
 * valid for 60 seconds that re-checks permission; the file is deleted after 24 hours (the audit record stays).
 *
 * Who sees what (the decision's table, mapped onto the existing flags): `report.view` opens the page and lists one's own
 * exports; `report.export` starts an export and downloads it. Pay columns only with `payroll.view` and never for a
 * Venue Manager, who is limited to their own venues. Staff hold neither flag.
 */
export const ReportKey = {
  /** 1. Hours and gross pay by venue and period. */
  HOURS_AND_PAY_BY_VENUE: 'hours_and_pay_by_venue',
  /** 2. Attendance exceptions: no-shows, late arrivals, missing clock-outs, out-of-area clock-ins. */
  ATTENDANCE_EXCEPTIONS: 'attendance_exceptions',
  /** 3. Hours per staff member per week, with a warning above 48 hours (Working Time Regulations). */
  WEEKLY_HOURS_PER_STAFF: 'weekly_hours_per_staff',
  /** 4. Fill rate: positions filled vs unfilled, by venue. */
  FILL_RATE_BY_VENUE: 'fill_rate_by_venue',
  /** 5. Payroll run summary (the payroll-provider CSV, built in the background). */
  PAYROLL_RUN_SUMMARY: 'payroll_run_summary',
} as const;
export type ReportKeyType = (typeof ReportKey)[keyof typeof ReportKey];
export const REPORT_KEYS: readonly ReportKeyType[] = Object.freeze(Object.values(ReportKey));

export const REPORT_LABELS: Readonly<Record<ReportKeyType, string>> = Object.freeze({
  hours_and_pay_by_venue: 'Hours and gross pay by venue',
  attendance_exceptions: 'Attendance exceptions',
  weekly_hours_per_staff: 'Hours per staff member per week',
  fill_rate_by_venue: 'Fill rate by venue',
  payroll_run_summary: 'Payroll run summary',
});

/** Reports that take a period (and optional venue). The payroll run summary takes a payroll run instead. */
export function reportTakesPeriod(key: ReportKeyType): boolean {
  return key !== ReportKey.PAYROLL_RUN_SUMMARY;
}

/** The only report whose every figure is pay: refused without `payroll.view`, and always for a Venue Manager. */
export function reportIsPayOnly(key: ReportKeyType): boolean {
  return key === ReportKey.PAYROLL_RUN_SUMMARY;
}

/**
 * Server-driven export lifecycle (`core.report_export.status`). No client ever sends a status.
 *   pending → ready   (the Worker built the file)
 *           | failed  (the Worker gave up after REPORT_EXPORT_MAX_ATTEMPTS)
 *   ready   → expired (the Worker deleted the file REPORT_EXPORT_FILE_RETENTION_HOURS after it was ready)
 *   failed, expired: terminal. Mirrored by the database trigger `core.report_export_guard()`.
 */
export const ReportExportStatus = {
  PENDING: 'pending',
  READY: 'ready',
  FAILED: 'failed',
  EXPIRED: 'expired',
} as const;
export type ReportExportStatusType = (typeof ReportExportStatus)[keyof typeof ReportExportStatus];

/** Seconds a download link stays valid after it is issued. Single use. Fixed by the database, not by the caller. */
export const REPORT_EXPORT_LINK_TTL_SECONDS = 60;
/** Hours a built file is kept before the Worker deletes it. */
export const REPORT_EXPORT_FILE_RETENTION_HOURS = 24;
/** Exports one user may start per rolling hour (owner decision: "a limited number"; this value is an assumption). */
export const REPORT_EXPORTS_PER_USER_PER_HOUR = 10;
/** Longest period one export may cover, in days (inclusive). */
export const REPORT_EXPORT_MAX_PERIOD_DAYS = 366;
/** Build attempts before an export is marked failed. */
export const REPORT_EXPORT_MAX_ATTEMPTS = 3;
/** Largest CSV the Worker stores, in bytes; a bigger result fails with `too_large` (narrow the period or venue). */
export const REPORT_EXPORT_MAX_BYTES = 10 * 1024 * 1024;

/** Why an export failed, as stored and shown (never an exception message). */
export const ReportExportError = {
  TOO_LARGE: 'too_large',
  NOT_FOUND: 'not_found',
  BUILD_FAILED: 'build_failed',
} as const;
export type ReportExportErrorType = (typeof ReportExportError)[keyof typeof ReportExportError];

/** One export as the API returns it (never the file content, never a token hash). */
export interface ReportExportSummary {
  id: string;
  reportKey: ReportKeyType;
  periodFrom: string | null;
  periodTo: string | null;
  venueId: string | null;
  payrollRunId: string | null;
  includePay: boolean;
  status: ReportExportStatusType;
  errorCode: ReportExportErrorType | null;
  rowCount: number | null;
  createdAt: string;
  readyAt: string | null;
  fileExpiresAt: string | null;
}
