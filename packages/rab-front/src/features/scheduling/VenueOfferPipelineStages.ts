/**
 * Venue Offers pipeline — the stage contract shared by the board (Pipeline view) and the Analytics view.
 *
 * The SERVER decides which lane each staff member is in (`staff[].stage`) and how many staff each lane holds
 * (`stageCounts`, older builds: `summary`). This module only (1) normalises the server's stage spelling to one key —
 * the current API sends `'STAFF ACCEPTED'` / `'NO SHOW'` and summary keys like `clockedIn`, the new contract sends
 * `staff_accepted` / `no_show` — (2) places each key in its tab, and (3) derives the analytics figures. It never
 * re-derives a lane from raw offer/attendance facts.
 *
 * Unknown keys degrade gracefully: a contract lane the server does not send yet renders with 0, and a stage the client
 * does not know becomes its own neutral lane (placed after the last known stage that preceded it in the server's
 * `stages` order) so nobody silently disappears from the board.
 */

export type PipelineTab = 'staffing' | 'attendance' | 'closed';
export type StageTone = 'brand' | 'neutral' | 'success' | 'info' | 'warning' | 'danger' | 'ink' | 'violet';

export interface StageDef {
  key: string;
  label: string;
  tab: PipelineTab;
  tone: StageTone;
  /** False for a server stage this client does not know (rendered neutral, never dropped). */
  known: boolean;
}

export const PIPELINE_TABS: Array<{ key: PipelineTab; label: string }> = [
  { key: 'staffing', label: 'Staffing' },
  { key: 'attendance', label: 'Attendance' },
  { key: 'closed', label: 'Closed' },
];

/** The agreed stage contract, in board order. */
export const STAGE_DEFS: StageDef[] = [
  { key: 'offered', label: 'Offered', tab: 'staffing', tone: 'brand', known: true },
  { key: 'waiting', label: 'Waiting', tab: 'staffing', tone: 'neutral', known: true },
  { key: 'staff_accepted', label: 'Staff accepted', tab: 'staffing', tone: 'success', known: true },
  { key: 'confirmed', label: 'Confirmed', tab: 'staffing', tone: 'success', known: true },
  { key: 'late', label: 'Late staff', tab: 'attendance', tone: 'brand', known: true },
  { key: 'checked_in', label: 'Checked in', tab: 'attendance', tone: 'info', known: true },
  { key: 'clocked_in', label: 'Clocked in', tab: 'attendance', tone: 'success', known: true },
  { key: 'pending_review', label: 'Pending review', tab: 'attendance', tone: 'warning', known: true },
  { key: 'clocked_out', label: 'Clocked out', tab: 'attendance', tone: 'ink', known: true },
  { key: 'attendance_missing', label: 'Attendance missing', tab: 'attendance', tone: 'warning', known: true },
  { key: 'no_show', label: 'No show', tab: 'attendance', tone: 'danger', known: true },
  { key: 'rejected', label: 'Rejected', tab: 'closed', tone: 'danger', known: true },
  { key: 'cancelled', label: 'Cancelled', tab: 'closed', tone: 'neutral', known: true },
  { key: 'deleted', label: 'Deleted', tab: 'closed', tone: 'neutral', known: true },
];

const KNOWN = new Map(STAGE_DEFS.map((d) => [d.key, d]));

/** Older spellings → contract key. */
const ALIASES: Record<string, string> = {
  accepted: 'staff_accepted',
  late_staff: 'late',
  deleted_offer: 'deleted',
  noshow: 'no_show',
};

/** Seat metrics that live in the legacy `summary` beside the lane counters — never lanes. */
const SEAT_KEYS = new Set(['required', 'filled', 'open']);

/** `'STAFF ACCEPTED'`, `'staff_accepted'`, `'staffAccepted'`, `'Staff-Accepted'` → `'staff_accepted'`. */
export function normaliseStage(raw: string | null | undefined): string {
  if (!raw) return 'unknown';
  const snake = String(raw)
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  return ALIASES[snake] ?? snake;
}

const humanise = (key: string) => {
  const text = key.replaceAll('_', ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
};

export interface StageSource {
  stages?: string[] | null;
  stageCounts?: Record<string, number> | null;
  summary?: Record<string, number> | null;
  staff?: Array<{ stage: string }> | null;
}

/** Every lane to render: the full contract plus any server stage this client does not know yet. */
export function stageLanes(source: StageSource): StageDef[] {
  const extra: Array<{ def: StageDef; after: string | null }> = [];
  const seen = new Set<string>();
  const consider = (raw: string, after: string | null) => {
    const key = normaliseStage(raw);
    if (KNOWN.has(key) || seen.has(key) || SEAT_KEYS.has(key)) return;
    seen.add(key);
    const tab = (after && (KNOWN.get(after)?.tab ?? extra.find((e) => e.def.key === after)?.def.tab)) || 'attendance';
    extra.push({ def: { key, label: humanise(key), tab, tone: 'neutral', known: false }, after });
  };
  let previous: string | null = null;
  for (const raw of source.stages ?? []) {
    consider(raw, previous);
    previous = normaliseStage(raw);
  }
  for (const raw of Object.keys(source.stageCounts ?? {})) consider(raw, null);
  for (const row of source.staff ?? []) consider(row.stage, null);
  const lanes = [...STAGE_DEFS];
  for (const { def, after } of extra) {
    const index = after ? lanes.findIndex((l) => l.key === after) : -1;
    if (index >= 0) lanes.splice(index + 1, 0, def);
    else {
      // No known predecessor: last lane of its tab.
      let last = -1;
      lanes.forEach((l, i) => {
        if (l.tab === def.tab) last = i;
      });
      lanes.splice(last + 1, 0, def);
    }
  }
  return lanes;
}

/**
 * Staff per lane, straight from the server: `stageCounts` when present, otherwise the legacy `summary` lane counters,
 * otherwise (neither sent) the cards themselves. Keys are normalised; a lane the server omits reads 0.
 */
export function stageCountsOf(source: StageSource): Record<string, number> {
  const counts: Record<string, number> = {};
  const add = (raw: string, value: unknown) => {
    const key = normaliseStage(raw);
    if (SEAT_KEYS.has(key)) return;
    const n = Number(value);
    counts[key] = (counts[key] ?? 0) + (Number.isFinite(n) ? n : 0);
  };
  if (source.stageCounts && Object.keys(source.stageCounts).length) {
    for (const [k, v] of Object.entries(source.stageCounts)) add(k, v);
  } else if (source.summary && Object.keys(source.summary).some((k) => !SEAT_KEYS.has(k))) {
    for (const [k, v] of Object.entries(source.summary)) add(k, v);
  } else {
    for (const row of source.staff ?? []) add(row.stage, 1);
  }
  return counts;
}

export function tabCounts(lanes: StageDef[], counts: Record<string, number>): Record<PipelineTab, number> {
  const out: Record<PipelineTab, number> = { staffing: 0, attendance: 0, closed: 0 };
  for (const lane of lanes) out[lane.tab] += counts[lane.key] ?? 0;
  return out;
}

/* ───────────────────────── Analytics derivations (from server rows; no client-invented states) ───────────────────────── */

export interface AnalyticsRow {
  stage: string;
  assignmentStatus: string;
  attendanceReviewed?: boolean;
}

/**
 * A `no_show` lane row whose attendance review is still open. Under the agreed contract `no_show` is manager-confirmed
 * only, but the current server still files the worker's automatic mark there with `attendanceReviewed: false` — that is
 * missing attendance awaiting review, never a final no-show, so copy and analytics treat it as such.
 */
export const isProvisionalNoShow = (row: AnalyticsRow) =>
  normaliseStage(row.stage) === 'no_show' && row.attendanceReviewed === false;

/** Lanes whose staff hold a booked seat (confirmed booking, whatever their attendance is doing). */
const SEAT_HOLDING = new Set([
  'confirmed',
  'late',
  'checked_in',
  'clocked_in',
  'pending_review',
  'clocked_out',
  'attendance_missing',
]);

/**
 * Filled seats = staff holding a confirmed booking: every Confirmed/attendance lane except a manager-CONFIRMED no-show.
 * Five confirmed staff with no punches yet are 5 filled seats (previously read 0 once the worker marked them).
 * Assumption (flagged): a manager-confirmed no-show frees the seat for coverage purposes.
 */
export function filledSeats(rows: AnalyticsRow[]): number {
  return rows.filter((row) => {
    const stage = normaliseStage(row.stage);
    if (SEAT_HOLDING.has(stage)) return true;
    if (stage === 'no_show') return isProvisionalNoShow(row);
    // A lane this client does not know: trust the booking itself.
    return !KNOWN.has(stage) && ['confirmed', 'completed'].includes(row.assignmentStatus);
  }).length;
}

export type AttendanceBucket =
  | 'not_started'
  | 'late'
  | 'checked_in'
  | 'clocked_in'
  | 'pending_review'
  | 'clocked_out'
  | 'attendance_missing'
  | 'no_show';

export const ATTENDANCE_BUCKETS: Array<{ key: AttendanceBucket; label: string; hint?: string; tone: StageTone }> = [
  { key: 'not_started', label: 'Confirmed, not started', tone: 'neutral' },
  { key: 'late', label: 'Late, not clocked in', tone: 'brand' },
  { key: 'checked_in', label: 'Checked in', hint: 'arrived, not working', tone: 'info' },
  { key: 'clocked_in', label: 'Clocked in', hint: 'working', tone: 'success' },
  { key: 'pending_review', label: 'Pending review', tone: 'violet' },
  { key: 'clocked_out', label: 'Clocked out', tone: 'ink' },
  { key: 'attendance_missing', label: 'Attendance missing', hint: 'needs review', tone: 'warning' },
  { key: 'no_show', label: 'No-show (confirmed)', tone: 'danger' },
];

/** Which attendance bucket a booked row belongs to; null for rows that never held a seat (offers, closed lanes). */
export function attendanceBucket(row: AnalyticsRow): AttendanceBucket | null {
  const stage = normaliseStage(row.stage);
  switch (stage) {
    case 'confirmed':
      return 'not_started';
    case 'late':
    case 'checked_in':
    case 'clocked_in':
    case 'pending_review':
    case 'clocked_out':
    case 'attendance_missing':
      return stage;
    case 'no_show':
      return isProvisionalNoShow(row) ? 'attendance_missing' : 'no_show';
    default:
      return null;
  }
}

export function attendanceBreakdown(rows: AnalyticsRow[]): { counts: Record<AttendanceBucket, number>; total: number } {
  const counts = Object.fromEntries(ATTENDANCE_BUCKETS.map((b) => [b.key, 0])) as Record<AttendanceBucket, number>;
  let total = 0;
  for (const row of rows) {
    const bucket = attendanceBucket(row);
    if (!bucket) continue;
    counts[bucket] += 1;
    total += 1;
  }
  return { counts, total };
}

export interface Attention {
  title: string;
  detail: string;
  tone: 'warning' | 'danger';
}

/** The attention banner, from real counts. Never calls missing attendance a no-show. */
export function attentionFor(rows: AnalyticsRow[], counts: Record<string, number>): Attention | null {
  const provisional = rows.filter(isProvisionalNoShow).length;
  const missing = (counts.attendance_missing ?? 0) + provisional;
  const pending = counts.pending_review ?? 0;
  const review = missing + pending;
  if (review > 0) {
    const parts: string[] = [];
    if (missing > 0)
      parts.push(
        missing === review
          ? 'No clock-in recorded. Record their attendance or confirm the no-show before finalising the timesheet.'
          : `${missing} with no clock-in recorded`,
      );
    if (pending > 0)
      parts.push(
        pending === review
          ? 'Attendance corrections or missing clock-outs are awaiting review.'
          : `${pending} with a correction or missing clock-out awaiting review`,
      );
    return {
      title: `${review} staff ${review === 1 ? 'needs' : 'need'} attendance review`,
      detail: parts.join(' · '),
      tone: 'warning',
    };
  }
  const late = counts.late ?? 0;
  if (late > 0)
    return {
      title: `${late} staff ${late === 1 ? 'is' : 'are'} late`,
      detail: 'Confirmed for this shift but not clocked in since it started.',
      tone: 'warning',
    };
  return null;
}
