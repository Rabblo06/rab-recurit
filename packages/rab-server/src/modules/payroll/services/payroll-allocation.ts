import { EntityManager } from 'typeorm';

/**
 * Payroll period allocation (owner decisions 2026-10-21). Plain functions (no Nest) so the API and the worker share one
 * implementation. Rules:
 *  - A shift belongs to the agency calendar period containing its SCHEDULED START DATE in Europe/London.
 *  - No configured period for that date → `unallocated` ("Unallocated — no payroll calendar period"); never invented.
 *  - If the shift's period run is already FINALISED, the record is carried forward to the NEXT period whose run is not
 *    finalised (`carried_forward`, late approval) — issued payslips are never modified.
 *  - Once a record is a line of a run, that run's period is final (lines are immutable, one run per record).
 */
export const PAYROLL_TIMEZONE = 'Europe/London';

export interface PeriodRef {
  id: string;
  start: string;
  end: string;
  payday: string;
  note: string | null;
  needsConfirmation: boolean;
}

export type AllocationStatus = 'allocated' | 'carried_forward' | 'unallocated';

export interface Allocation {
  status: AllocationStatus;
  /** The period the record is (or will be) paid in; null when unallocated. */
  period: PeriodRef | null;
  /** The period of the work date when it differs from `period` (late approval carried forward). */
  originalPeriod: PeriodRef | null;
  workDate: string;
  runId: string | null;
  runStatus: 'prepared' | 'finalised' | null;
}

export const UNALLOCATED_LABEL = 'Unallocated — no payroll calendar period';

const PERIOD_COLS = `p.id, to_char(p.period_start, 'YYYY-MM-DD') AS start, to_char(p.period_end, 'YYYY-MM-DD') AS "end",
  to_char(p.payday, 'YYYY-MM-DD') AS payday, p.note, p.needs_confirmation`;

function toPeriod(r: Record<string, unknown>): PeriodRef {
  return { id: r.id as string, start: r.start as string, end: r.end as string, payday: r.payday as string, note: (r.note as string) ?? null, needsConfirmation: Boolean(r.needs_confirmation) };
}

/** YYYY-MM-DD of an instant in the payroll timezone. */
export function payrollDate(instant: Date | string, timeZone = PAYROLL_TIMEZONE): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(instant));
}

/** Pure: the period whose [start, end] (inclusive dates) contains `date`. Active periods never overlap (DB exclusion). */
export function periodForDate(periods: readonly PeriodRef[], date: string): PeriodRef | null {
  return periods.find((p) => p.start <= date && date <= p.end) ?? null;
}

export async function activePeriods(m: EntityManager, organisationId: string): Promise<PeriodRef[]> {
  const rows = await m.query(
    `SELECT ${PERIOD_COLS} FROM core.payroll_calendar_period p WHERE p.organisation_id = $1 AND p.active ORDER BY p.period_start`, [organisationId]);
  return rows.map(toPeriod);
}

export async function periodsById(m: EntityManager, organisationId: string, ids: string[]): Promise<Map<string, PeriodRef>> {
  if (!ids.length) return new Map();
  const rows = await m.query(`SELECT ${PERIOD_COLS} FROM core.payroll_calendar_period p WHERE p.organisation_id = $1 AND p.id = ANY($2::uuid[])`, [organisationId, ids]);
  return new Map(rows.map((r: Record<string, unknown>) => [r.id as string, toPeriod(r)]));
}

/** The period containing an instant (scheduled start), or null. */
export async function periodForInstant(m: EntityManager, organisationId: string, instant: Date | string): Promise<PeriodRef | null> {
  return periodForDate(await activePeriods(m, organisationId), payrollDate(instant));
}

/**
 * Allocates payroll records (id + scheduled start). Reads runs and lines of the workspace under the caller's RLS
 * (managers, the record's own staff member, or the worker).
 */
export async function allocateRecords(
  m: EntityManager,
  scope: { organisationId: string; workspaceId: string },
  records: ReadonlyArray<{ id: string; startsAt: Date | string }>,
): Promise<Map<string, Allocation>> {
  const out = new Map<string, Allocation>();
  if (!records.length) return out;
  const periods = await activePeriods(m, scope.organisationId);
  const runs: Array<{ id: string; period_id: string; status: 'prepared' | 'finalised' }> = await m.query(
    `SELECT id, period_id, status FROM payroll_run WHERE organisation_id = $1 AND workspace_id = $2`, [scope.organisationId, scope.workspaceId]);
  const runByPeriod = new Map(runs.map((r) => [r.period_id, r]));
  const lines: Array<{ payroll_record_id: string; run_id: string; late_approval: boolean; original_period_id: string | null; period_id: string; status: 'prepared' | 'finalised' }> = await m.query(
    `SELECT l.payroll_record_id, l.run_id, l.late_approval, l.original_period_id, r.period_id, r.status
       FROM payroll_run_line l JOIN payroll_run r ON r.id = l.run_id
      WHERE l.payroll_record_id = ANY($1::uuid[]) AND l.workspace_id = $2`, [records.map((r) => r.id), scope.workspaceId]);
  const lineByRecord = new Map(lines.map((l) => [l.payroll_record_id, l]));
  const extra = await periodsById(m, scope.organisationId, [...new Set(lines.flatMap((l) => [l.period_id, l.original_period_id ?? '']).filter(Boolean))]);
  const byId = (id: string | null) => (id ? extra.get(id) ?? periods.find((p) => p.id === id) ?? null : null);

  for (const rec of records) {
    const workDate = payrollDate(rec.startsAt);
    const line = lineByRecord.get(rec.id);
    if (line) {
      out.set(rec.id, {
        status: line.late_approval ? 'carried_forward' : 'allocated', period: byId(line.period_id),
        originalPeriod: line.late_approval ? byId(line.original_period_id) : null, workDate, runId: line.run_id, runStatus: line.status,
      });
      continue;
    }
    const natural = periodForDate(periods, workDate);
    if (!natural) { out.set(rec.id, { status: 'unallocated', period: null, originalPeriod: null, workDate, runId: null, runStatus: null }); continue; }
    const naturalRun = runByPeriod.get(natural.id);
    if (naturalRun?.status !== 'finalised') {
      out.set(rec.id, { status: 'allocated', period: natural, originalPeriod: null, workDate, runId: naturalRun?.id ?? null, runStatus: naturalRun?.status ?? null });
      continue;
    }
    const next = periods.find((p) => p.start > natural.start && runByPeriod.get(p.id)?.status !== 'finalised') ?? null;
    const nextRun = next ? runByPeriod.get(next.id) : undefined;
    out.set(rec.id, next
      ? { status: 'carried_forward', period: next, originalPeriod: natural, workDate, runId: nextRun?.id ?? null, runStatus: nextRun?.status ?? null }
      : { status: 'unallocated', period: null, originalPeriod: natural, workDate, runId: null, runStatus: null });
  }
  return out;
}

/** "12 Oct 2026 – 25 Oct 2026" */
export function periodLabel(p: PeriodRef): string {
  const f = (d: string) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(`${d}T00:00:00Z`));
  return `${f(p.start)} – ${f(p.end)}`;
}

/** "Wed, 4 Nov 2026" */
export function paydayLabel(date: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(`${date}T00:00:00Z`));
}
