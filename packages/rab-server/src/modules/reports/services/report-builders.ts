import { haversineDistanceMeters, ReportKey, ReportKeyType } from '@rab/shared';
import { EntityManager } from 'typeorm';

import { businessTables } from '../../../engine/core-modules/tenant/business-tables';
import { FieldPolicy } from '../../identity/member-access/field-policy.service';
import { buildPayrollRunCsv, csvCell, loadPayrollRunView } from '../../payroll/services/payroll-run.service';
import { assignmentTimeSql } from '../../scheduling/utils/assignment-time';

/**
 * Owner decision 29: the five report builders. Each runs in the Worker, inside the export's own organisation + workspace
 * binding, against the requester's STORED decision (scope, venue, pay / hours columns) that `ReportExportService.request`
 * checked when the export was asked for, and that the download re-checks. Nothing here reads a client value.
 *
 * Scope (the same rule as the manager lists): a Venue Manager's export covers only the venues stored on the row; any
 * other export covers only the records of the stored owner (`created_by`, the workspace owner for a delegated member).
 * Dates are the work date (the assignment's start) in Europe/London, inclusive.
 *
 * ASSUMPTIONS flagged for the owner (payroll / attendance figures):
 *  - report 1's gross pay is the earnings snapshotted at clock-out (`attendance.earned_pence`), before payroll approval
 *    or any adjustment; the payroll run summary (report 5) is the approved figure;
 *  - "late" reuses the live late-clock-in grace (LATE_CLOCK_IN_GRACE_MINUTES), as the AI attendance summary does;
 *  - "out of area" = a clock-in fix farther from the venue than its geofence radius (venues that do not enforce the
 *    geofence can record one);
 *  - "above 48 hours" is per calendar week (Monday to Sunday); the Working Time Regulations limit is an average over
 *    17 weeks, so the column is a warning, not a breach finding;
 *  - fill rate counts shifts that were published (not draft, pending approval, declined or cancelled).
 */
export interface ReportExportJob {
  id: string;
  organisation_id: string;
  workspace_id: string;
  requested_by: string;
  report_key: ReportKeyType;
  period_from: string | null;
  period_to: string | null;
  venue_id: string | null;
  payroll_run_id: string | null;
  include_pay: boolean;
  include_hours: boolean;
  scope_kind: 'owner' | 'venue';
  scope_owner_user_id: string | null;
  scope_venue_ids: string[];
}

export interface ReportTable {
  header: string[];
  rows: string[][];
}

export interface ReportBuildOptions {
  lateGraceMinutes: number;
  now?: Date;
}

const LONDON = `'Europe/London'`;
const MINUTES_48_HOURS = 48 * 60;

/** Pence (bigint, from the database as text) to a plain decimal string for a spreadsheet: "1234.56". Integer arithmetic only. */
export function penceToDecimal(pence: string | number | bigint): string {
  const value = BigInt(pence);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  return `${negative ? '-' : ''}${(abs / 100n).toString()}.${(abs % 100n).toString().padStart(2, '0')}`;
}

/** Minutes to hours with two decimals (display only; the minutes themselves come from the stored attendance). */
export function minutesToHours(minutes: number | string): string {
  return (Number(minutes) / 60).toFixed(2);
}

/** One CSV document: header and rows through the payroll CSV's formula-neutralising `csvCell`. */
export function toCsv(table: ReportTable): string {
  return [table.header, ...table.rows].map((row) => row.map((cell) => csvCell(cell)).join(',')).join('\n');
}

interface Sql {
  params: unknown[];
  p: (value: unknown) => string;
}

function sqlParams(): Sql {
  const params: unknown[] = [];
  return { params, p: (value: unknown) => { params.push(value); return `$${params.length}`; } };
}

/** Staff-based scope (attendance and assignments), the same rule as `attendanceReadScopeCondition`. */
function staffScope(job: ReportExportJob, q: Sql): string {
  return job.scope_kind === 'venue' ? `s.venue_id = ANY(${q.p(job.scope_venue_ids)}::uuid[])` : `sp.created_by = ${q.p(job.scope_owner_user_id)}`;
}

/** Shift-based scope (the shift list's rule): a Venue Manager's venues, otherwise the owner's shifts. */
function shiftScope(job: ReportExportJob, q: Sql): string {
  return job.scope_kind === 'venue' ? `s.venue_id = ANY(${q.p(job.scope_venue_ids)}::uuid[])` : `s.created_by = ${q.p(job.scope_owner_user_id)}`;
}

function periodAndVenue(job: ReportExportJob, q: Sql, startSql: string): string {
  const parts = [`(${startSql} AT TIME ZONE ${LONDON})::date BETWEEN ${q.p(job.period_from)}::date AND ${q.p(job.period_to)}::date`];
  if (job.venue_id) parts.push(`s.venue_id = ${q.p(job.venue_id)}`);
  return parts.join(' AND ');
}

const staffName = (r: { first_name: string; last_name: string }) => `${r.first_name} ${r.last_name}`;
const londonDate = (d: Date | string) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Europe/London' });

/** 1. Hours and gross pay by venue and period. */
async function hoursAndPayByVenue(m: EntityManager, job: ReportExportJob): Promise<ReportTable> {
  const t = businessTables(m);
  const q = sqlParams();
  const start = assignmentTimeSql('sa', 's').start;
  const rows: Array<{ venue: string; shifts: number; minutes: string; pence: string }> = await m.query(
    // sql-injection-reviewed: table names from businessTables, fragments are code constants; every value is a bound $n parameter.
    `SELECT v.name AS venue, count(*)::int AS shifts, coalesce(sum(a.worked_minutes), 0)::text AS minutes, coalesce(sum(a.earned_pence), 0)::text AS pence
       FROM ${t.attendance} a
       JOIN ${t.shift_assignment} sa ON sa.id = a.shift_assignment_id
       JOIN ${t.shift} s ON s.id = a.shift_id
       JOIN ${t.venue} v ON v.id = s.venue_id
       JOIN ${t.staff_profile} sp ON sp.id = a.staff_profile_id
      WHERE ${staffScope(job, q)} AND a.clock_out_at IS NOT NULL AND ${periodAndVenue(job, q, start)}
      GROUP BY v.id, v.name
      ORDER BY v.name, v.id`,
    q.params,
  );
  const header = ['Venue', 'Period start', 'Period end', 'Shifts worked'];
  if (job.include_hours) header.push('Hours');
  if (job.include_pay) header.push('Gross pay recorded at clock-out (GBP)');
  return {
    header,
    rows: rows.map((r) => {
      const row = [r.venue, job.period_from!, job.period_to!, String(r.shifts)];
      if (job.include_hours) row.push(minutesToHours(r.minutes));
      if (job.include_pay) row.push(penceToDecimal(r.pence));
      return row;
    }),
  };
}

/** 2. Attendance exceptions: no-shows, late arrivals, missing clock-outs, out-of-area clock-ins. */
async function attendanceExceptions(m: EntityManager, job: ReportExportJob, options: ReportBuildOptions): Promise<ReportTable> {
  const t = businessTables(m);
  const { start, end } = assignmentTimeSql('sa', 's');
  const out: Array<{ at: Date; venue: string; staff: string; ref: string; type: string; detail: string }> = [];

  let q = sqlParams();
  const noShows: Array<{ at: Date; venue: string; first_name: string; last_name: string; staff_ref: string | null; reviewed: boolean }> = await m.query(
    // sql-injection-reviewed: table names from businessTables, fragments are code constants; every value is a bound $n parameter.
    `SELECT ${start} AS at, v.name AS venue, u.first_name, u.last_name, sp.staff_ref, sa.attendance_reviewed_at IS NOT NULL AS reviewed
       FROM ${t.shift_assignment} sa
       JOIN ${t.shift} s ON s.id = sa.shift_id
       JOIN ${t.venue} v ON v.id = s.venue_id
       JOIN ${t.staff_profile} sp ON sp.id = sa.staff_profile_id
       JOIN core."user" u ON u.id = sp.user_id
      WHERE ${staffScope(job, q)} AND sa.status = 'no_show' AND ${periodAndVenue(job, q, start)}`,
    q.params,
  );
  for (const r of noShows) {
    out.push({ at: r.at, venue: r.venue, staff: staffName(r), ref: r.staff_ref ?? '', type: 'No-show', detail: r.reviewed ? 'Confirmed by a manager' : 'Not yet reviewed' });
  }

  q = sqlParams();
  const grace = q.p(options.lateGraceMinutes);
  const now = q.p(options.now ?? new Date());
  const attendance: Array<{
    at: Date; venue: string; first_name: string; last_name: string; staff_ref: string | null;
    late_minutes: number; missing_clock_out: boolean;
    clock_in_lat: string | null; clock_in_lng: string | null; venue_lat: string | null; venue_lng: string | null; radius_m: number | null;
  }> = await m.query(
    // sql-injection-reviewed: table names from businessTables, fragments are code constants; every value is a bound $n parameter.
    `SELECT ${start} AS at, v.name AS venue, u.first_name, u.last_name, sp.staff_ref,
            CASE WHEN a.clock_in_at > ${start} + make_interval(mins => ${grace}::int)
                 THEN floor(extract(epoch FROM (a.clock_in_at - ${start})) / 60)::int ELSE 0 END AS late_minutes,
            (a.clock_out_at IS NULL AND ${end} < ${now}::timestamptz) AS missing_clock_out,
            a.clock_in_lat::text, a.clock_in_lng::text, v.lat::text AS venue_lat, v.lng::text AS venue_lng, v.geofence_radius_m AS radius_m
       FROM ${t.attendance} a
       JOIN ${t.shift_assignment} sa ON sa.id = a.shift_assignment_id
       JOIN ${t.shift} s ON s.id = a.shift_id
       JOIN ${t.venue} v ON v.id = s.venue_id
       JOIN ${t.staff_profile} sp ON sp.id = a.staff_profile_id
       JOIN core."user" u ON u.id = sp.user_id
      WHERE ${staffScope(job, q)} AND ${periodAndVenue(job, q, start)}`,
    q.params,
  );
  for (const r of attendance) {
    const base = { at: r.at, venue: r.venue, staff: staffName(r), ref: r.staff_ref ?? '' };
    if (r.late_minutes > 0) out.push({ ...base, type: 'Late arrival', detail: `Clocked in ${r.late_minutes} min after the start` });
    if (r.missing_clock_out) out.push({ ...base, type: 'Missing clock-out', detail: 'No clock-out recorded after the shift ended' });
    if (r.clock_in_lat !== null && r.clock_in_lng !== null && r.venue_lat !== null && r.venue_lng !== null && r.radius_m !== null) {
      const metres = haversineDistanceMeters({ lat: Number(r.clock_in_lat), lng: Number(r.clock_in_lng) }, { lat: Number(r.venue_lat), lng: Number(r.venue_lng) });
      if (metres > r.radius_m) out.push({ ...base, type: 'Out-of-area clock-in', detail: `Clocked in about ${Math.round(metres)} m from the venue (geofence ${r.radius_m} m)` });
    }
  }

  out.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime() || a.venue.localeCompare(b.venue) || a.staff.localeCompare(b.staff) || a.type.localeCompare(b.type));
  return {
    header: ['Date', 'Venue', 'Staff reference', 'Staff name', 'Exception', 'Detail'],
    rows: out.map((e) => [londonDate(e.at), e.venue, e.ref, e.staff, e.type, e.detail]),
  };
}

/** 3. Hours per staff member per week, with a warning above 48 hours. */
async function weeklyHoursPerStaff(m: EntityManager, job: ReportExportJob): Promise<ReportTable> {
  const t = businessTables(m);
  const q = sqlParams();
  const start = assignmentTimeSql('sa', 's').start;
  const rows: Array<{ staff_ref: string | null; first_name: string; last_name: string; week_start: string; shifts: number; minutes: number }> = await m.query(
    // sql-injection-reviewed: table names from businessTables, fragments are code constants; every value is a bound $n parameter.
    `SELECT sp.staff_ref, u.first_name, u.last_name,
            to_char(date_trunc('week', ${start} AT TIME ZONE ${LONDON}), 'YYYY-MM-DD') AS week_start,
            count(*)::int AS shifts, coalesce(sum(a.worked_minutes), 0)::int AS minutes
       FROM ${t.attendance} a
       JOIN ${t.shift_assignment} sa ON sa.id = a.shift_assignment_id
       JOIN ${t.shift} s ON s.id = a.shift_id
       JOIN ${t.staff_profile} sp ON sp.id = a.staff_profile_id
       JOIN core."user" u ON u.id = sp.user_id
      WHERE ${staffScope(job, q)} AND a.clock_out_at IS NOT NULL AND ${periodAndVenue(job, q, start)}
      GROUP BY sp.id, sp.staff_ref, u.first_name, u.last_name, week_start
      ORDER BY u.last_name, u.first_name, sp.id, week_start`,
    q.params,
  );
  return {
    header: ['Staff reference', 'Staff name', 'Week starting (Monday)', 'Shifts', 'Hours', 'Above 48 hours'],
    rows: rows.map((r) => [r.staff_ref ?? '', staffName(r), r.week_start, String(r.shifts), minutesToHours(r.minutes), Number(r.minutes) > MINUTES_48_HOURS ? 'Yes' : 'No']),
  };
}

/** 4. Fill rate: positions filled vs unfilled, by venue. */
async function fillRateByVenue(m: EntityManager, job: ReportExportJob): Promise<ReportTable> {
  const t = businessTables(m);
  const q = sqlParams();
  const rows: Array<{ venue: string; shifts: number; required: number; filled: number }> = await m.query(
    // sql-injection-reviewed: table names from businessTables, fragments are code constants; every value is a bound $n parameter.
    `SELECT v.name AS venue, count(*)::int AS shifts, sum(s.required_count)::int AS required, sum(LEAST(s.filled_count, s.required_count))::int AS filled
       FROM ${t.shift} s
       JOIN ${t.venue} v ON v.id = s.venue_id
      WHERE ${shiftScope(job, q)} AND s.status IN ('open', 'offered', 'partially_filled', 'fully_filled', 'confirmed', 'in_progress', 'completed')
        AND ${periodAndVenue(job, q, 's.starts_at')}
      GROUP BY v.id, v.name
      ORDER BY v.name, v.id`,
    q.params,
  );
  return {
    header: ['Venue', 'Period start', 'Period end', 'Shifts', 'Positions', 'Filled', 'Unfilled', 'Fill rate (%)'],
    rows: rows.map((r) => [
      r.venue, job.period_from!, job.period_to!, String(r.shifts), String(r.required), String(r.filled), String(r.required - r.filled),
      r.required > 0 ? ((r.filled * 100) / r.required).toFixed(1) : '',
    ]),
  };
}

/** 5. Payroll run summary: the payroll-provider CSV (the same columns as `GET /payroll/runs/:id/export`). */
async function payrollRunSummary(m: EntityManager, job: ReportExportJob): Promise<{ csv: string; rowCount: number }> {
  const view = await loadPayrollRunView(m, job.organisation_id, job.workspace_id, job.payroll_run_id!);
  const hidden = new Set<string>();
  if (!job.include_hours) hidden.add('workedTime');
  if (!job.include_pay) hidden.add('amount');
  const policy: FieldPolicy = { object: 'payroll_record', hiddenFields: hidden, hiddenProperties: new Set() };
  return { csv: buildPayrollRunCsv(view, policy), rowCount: view.staff.length };
}

/** Builds one export's CSV and its data-row count. Throws on any database error (the Worker records the failure). */
export async function buildReportCsv(m: EntityManager, job: ReportExportJob, options: ReportBuildOptions): Promise<{ csv: string; rowCount: number }> {
  if (job.report_key === ReportKey.PAYROLL_RUN_SUMMARY) {
    return payrollRunSummary(m, job);
  }
  let table: ReportTable;
  switch (job.report_key) {
    case ReportKey.HOURS_AND_PAY_BY_VENUE:
      table = await hoursAndPayByVenue(m, job);
      break;
    case ReportKey.ATTENDANCE_EXCEPTIONS:
      table = await attendanceExceptions(m, job, options);
      break;
    case ReportKey.WEEKLY_HOURS_PER_STAFF:
      table = await weeklyHoursPerStaff(m, job);
      break;
    case ReportKey.FILL_RATE_BY_VENUE:
      table = await fillRateByVenue(m, job);
      break;
    default:
      // Fail closed: an unknown key never builds anything.
      throw new Error(`Unknown report key ${String(job.report_key)}`);
  }
  return { csv: toCsv(table), rowCount: table.rows.length };
}
