import { formatPence } from '@rab/shared';

/** `GET /payroll/period?month=YYYY-MM` row (server `PayrollPeriodRow`). Figures are verified payroll figures or null. */
export type PayrollStage = 'in_progress' | 'ready' | 'completed' | 'rejected';
/** Approved Shift Statement state as the server reports it (null until the record is approved). */
export type ShiftStatementState = 'processing' | 'available' | 'failed';

export interface ShiftStatementRef {
  state: ShiftStatementState;
  fileId: string | null;
  filename: string | null;
  generatedAt: string | null;
  notifiedAt: string | null;
}

export interface PayrollPeriodRow {
  attendanceId: string;
  payrollRecordId: string | null;
  payrollStatus: string | null;
  stage: PayrollStage;
  attendanceStatus: string;
  staffProfileId: string;
  staffName: string;
  staffRef: string | null;
  staffEmail: string | null;
  staffStatus: string;
  defaultRatePence: number | null;
  roleName: string;
  venueName: string;
  startsAt: string;
  endsAt: string;
  workedMinutes: number | null;
  payRatePence: number | null;
  amountPence: number | null;
  ownHours: boolean;
  statement: ShiftStatementRef | null;
  allocation: AllocationView;
}

/** Agency calendar allocation (server `AllocationView`): the period/payday a record is, or will be, paid in. */
export interface AllocationView {
  status: 'allocated' | 'carried_forward' | 'unallocated';
  payrollPeriod: { id: string; start: string; end: string } | null;
  payday: string | null;
  originalPeriod: { id: string; start: string; end: string } | null;
  runId: string | null;
  runStatus: 'prepared' | 'finalised' | null;
}

export const UNALLOCATED_LABEL = 'Unallocated — no payroll calendar period';

const shortDate = (d: string) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(`${d}T00:00:00Z`));
export const fmtCalendarDate = shortDate;
export const fmtPeriod = (p: { start: string; end: string } | null): string => (p ? `${shortDate(p.start)} – ${shortDate(p.end)}` : EM_DASH);
export const fmtPayday = (a: AllocationView | null | undefined): string => (!a || !a.payday ? (a?.status === 'unallocated' ? UNALLOCATED_LABEL : EM_DASH) : shortDate(a.payday));

export interface PayrollPeriod {
  month: string;
  timezone: string;
  rows: PayrollPeriodRow[];
}

export interface BulkApproveResult {
  approved: Array<{ id: string; staffName: string; statement: ShiftStatementRef | null }>;
  blocked: Array<{ id: string; reason: 'not_found' | 'not_ready' | 'own_hours'; message: string }>;
}

/** Labels for the real stages (no invented statuses). `ready` = payroll record pending approval. */
export const STAGE: Record<PayrollStage, { label: string; tone: 'peach' | 'amber' | 'green' | 'red' }> = {
  in_progress: { label: 'In progress', tone: 'peach' },
  ready: { label: 'Ready for approval', tone: 'amber' },
  completed: { label: 'Completed', tone: 'green' },
  rejected: { label: 'Rejected', tone: 'red' },
};

export const EM_DASH = '—';

/** A row can be approved only when it is a real payroll record waiting for approval and not the viewer's own hours. */
export const isApprovable = (row: PayrollPeriodRow): boolean => row.stage === 'ready' && !!row.payrollRecordId && !row.ownHours;

/** "In progress" in the owner's wording = not completed and not rejected yet (no record, or waiting for approval). */
export const isOpenStage = (stage: PayrollStage): boolean => stage === 'in_progress' || stage === 'ready';

export const hasVerifiedFigures = (row: PayrollPeriodRow): boolean => row.workedMinutes !== null && row.amountPence !== null;

// ---------------------------------------------------------------- months

export function currentMonth(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

export function addMonths(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, 1)));
}

/** YYYY-MM-DD of an instant in a timezone (the organisation's — the same one the server used to pick the month). */
export function dayKey(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

export interface CalendarCell { key: string; day: number; weekend: boolean }

/** Mon–Sun weeks covering the month; `null` pads days outside it. */
export function calendarWeeks(month: string): Array<Array<CalendarCell | null>> {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const first = new Date(Date.UTC(y, m - 1, 1));
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const lead = (first.getUTCDay() + 6) % 7; // Monday = 0
  const cells: Array<CalendarCell | null> = Array.from({ length: lead }, () => null);
  for (let d = 1; d <= days; d++) {
    const weekday = (lead + d - 1) % 7;
    cells.push({ key: `${month}-${String(d).padStart(2, '0')}`, day: d, weekend: weekday >= 5 });
  }
  while (cells.length % 7) cells.push(null);
  const weeks: Array<Array<CalendarCell | null>> = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

// ---------------------------------------------------------------- aggregates

export interface Progress { completed: number; total: number; percent: number }

/** Completed share of the records. 0 of anything is 0% — never 100% (owner screenshot bug). */
export function progress(rows: PayrollPeriodRow[]): Progress {
  const total = rows.length;
  const completed = rows.filter((r) => r.stage === 'completed').length;
  return { completed, total, percent: total === 0 ? 0 : Math.round((completed / total) * 100) };
}

export function countByStage(rows: PayrollPeriodRow[]): Record<PayrollStage, number> {
  const out: Record<PayrollStage, number> = { in_progress: 0, ready: 0, completed: 0, rejected: 0 };
  for (const r of rows) out[r.stage] += 1;
  return out;
}

export interface Totals { minutes: number | null; pence: number | null; pending: boolean }

/** Sums verified figures only. `null` when no row has them; `pending` when at least one row has none yet. */
export function totals(rows: PayrollPeriodRow[]): Totals {
  const verified = rows.filter(hasVerifiedFigures);
  return {
    minutes: verified.length ? verified.reduce((s, r) => s + r.workedMinutes!, 0) : null,
    pence: verified.length ? verified.reduce((s, r) => s + r.amountPence!, 0) : null,
    pending: rows.some((r) => !hasVerifiedFigures(r)),
  };
}

export interface StaffSummary {
  staffProfileId: string;
  staffName: string;
  initials: string;
  rows: PayrollPeriodRow[];
  /** The most actionable stage across the staff member's records. */
  stage: PayrollStage;
}

const STAGE_PRIORITY: PayrollStage[] = ['ready', 'in_progress', 'rejected', 'completed'];

export function dominantStage(rows: PayrollPeriodRow[]): PayrollStage {
  for (const s of STAGE_PRIORITY) if (rows.some((r) => r.stage === s)) return s;
  return 'in_progress';
}

export function initialsOf(name: string): string {
  return name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('');
}

export function staffSummaries(rows: PayrollPeriodRow[]): StaffSummary[] {
  const by = new Map<string, PayrollPeriodRow[]>();
  for (const r of rows) by.set(r.staffProfileId, [...(by.get(r.staffProfileId) ?? []), r]);
  return [...by.entries()]
    .map(([id, list]) => ({ staffProfileId: id, staffName: list[0]!.staffName, initials: initialsOf(list[0]!.staffName), rows: list, stage: dominantStage(list) }))
    .sort((a, b) => a.staffName.localeCompare(b.staffName));
}

// ---------------------------------------------------------------- formatting

export const fmtHours = (minutes: number | null): string => (minutes === null ? EM_DASH : `${(minutes / 60).toFixed(2).replace(/\.00$/, '')} hrs`);
export const fmtMoney = (pence: number | null): string => (pence === null ? EM_DASH : formatPence(pence));
export const fmtDate = (iso: string, timeZone: string): string =>
  new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));

/** Owner wording for a bulk result: "8 records approved. 2 require attention." */
export function bulkMessage(approved: number, blocked: number): string {
  const a = `${approved} record${approved === 1 ? '' : 's'} approved.`;
  return blocked ? `${a} ${blocked} require${blocked === 1 ? 's' : ''} attention.` : a;
}

// ---------------------------------------------------------------- records view

export type RecordsTab = 'all' | 'in_progress' | 'completed';
export type SortKey = 'date_desc' | 'date_asc' | 'staff' | 'amount';
export interface RecordFilter { stage: PayrollStage | ''; venue: string }

export function applyRecordsView(rows: PayrollPeriodRow[], opts: { tab: RecordsTab; search: string; filter: RecordFilter; sort: SortKey }): PayrollPeriodRow[] {
  const q = opts.search.trim().toLowerCase();
  const out = rows.filter((r) =>
    (opts.tab === 'all' || (opts.tab === 'in_progress' ? isOpenStage(r.stage) : r.stage === opts.tab))
    && (!opts.filter.stage || r.stage === opts.filter.stage)
    && (!opts.filter.venue || r.venueName === opts.filter.venue)
    && (!q || r.staffName.toLowerCase().includes(q) || r.venueName.toLowerCase().includes(q)));
  const byDate = (a: PayrollPeriodRow, b: PayrollPeriodRow) => a.startsAt.localeCompare(b.startsAt) || a.attendanceId.localeCompare(b.attendanceId);
  const sorted = [...out];
  if (opts.sort === 'date_asc') sorted.sort(byDate);
  else if (opts.sort === 'date_desc') sorted.sort((a, b) => byDate(b, a));
  else if (opts.sort === 'staff') sorted.sort((a, b) => a.staffName.localeCompare(b.staffName) || byDate(a, b));
  else sorted.sort((a, b) => (b.amountPence ?? -1) - (a.amountPence ?? -1) || byDate(a, b));
  return sorted;
}

/** CSV of the given rows (Export). Only real values; missing figures are empty cells. */
export function toCsv(rows: PayrollPeriodRow[], timeZone: string): string {
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const head = ['Staff', 'Reference', 'Venue', 'Role', 'Shift date', 'Status', 'Hours', 'Rate (GBP)', 'Gross (GBP)'];
  const lines = rows.map((r) => [
    r.staffName, r.staffRef ?? '', r.venueName, r.roleName, dayKey(r.startsAt, timeZone), STAGE[r.stage].label,
    r.workedMinutes === null ? '' : (r.workedMinutes / 60).toFixed(2),
    r.payRatePence === null ? '' : (r.payRatePence / 100).toFixed(2),
    r.amountPence === null ? '' : (r.amountPence / 100).toFixed(2),
  ].map(esc).join(','));
  return [head.join(','), ...lines].join('\n');
}
