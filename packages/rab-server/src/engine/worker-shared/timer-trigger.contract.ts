/**
 * Phase D-Q4b (docs/PHASE_DQ4_DQ5_PLAN_2026-11-03.md §2; owner approval OD-3 / OD-4, 2026-11-04): delayed-job TIMER
 * TRIGGERS. Pure constants and pure functions (no Nest, no Redis, no BullMQ runtime import, no `modules/` import), shared by
 * the API producer, the Worker producer (shift-monitor arming), the Worker consumer and the queue registry.
 *
 * WHAT A TRIGGER IS: a BullMQ delayed job, due at the moment a timed transition becomes due, that asks the Worker to run the
 * SAME per-candidate compare-and-set the backstop scan runs, for ONE subject, a little earlier than the scan would. It is a
 * hint and never an authority:
 *   - the payload carries identifiers only (`organisationId`, `workspaceId`, `subjectId`) and the due time the producer
 *     saw (`dueAtEpochMs`); the consumer binds the organisation/workspace with SET LOCAL and re-reads the subject under
 *     FORCE RLS, so a forged scope sees no row;
 *   - a trigger whose due time no longer matches the row (rescheduled, re-accepted) is STALE and does nothing; one that
 *     fires before the database clock reaches the due time is EARLY and does nothing (it may be re-delayed once);
 *   - every existing scan keeps its interval and code: a lost trigger (Redis wipe, publish failure) changes nothing.
 * Triggers add database work (one scoped transaction per fired trigger); they are NOT claimed to reduce it (§14.4).
 */

/** The new consumer queue (legacy `bull` prefix, OD-4). A new name: a Worker built before D-Q4b never consumes it. */
export const TIMER_TRIGGER_QUEUE_NAME = 'crewflow-timer-triggers';

/** The four trigger kinds (plan §2.1). Order is the documentation order; it carries no priority. */
export const TIMER_TRIGGER_KINDS = ['offer-expiry', 'manager-confirmation', 'no-show', 'late-clock-in'] as const;
export type TimerTriggerKind = (typeof TIMER_TRIGGER_KINDS)[number];

/** BullMQ job name of each kind: `<kind>-trigger`. */
export const TIMER_TRIGGER_JOB_NAMES = Object.freeze({
  'offer-expiry': 'offer-expiry-trigger',
  'manager-confirmation': 'manager-confirmation-trigger',
  'no-show': 'no-show-trigger',
  'late-clock-in': 'late-clock-in-trigger',
} as const satisfies Record<TimerTriggerKind, string>);
export type TimerTriggerJobName = (typeof TIMER_TRIGGER_JOB_NAMES)[TimerTriggerKind];

/** Every top-level payload key a trigger job may carry — identifiers and one epoch, nothing else. */
export const TIMER_TRIGGER_PAYLOAD_KEYS = Object.freeze(['organisationId', 'workspaceId', 'subjectId', 'dueAtEpochMs'] as const);

/** The trigger job payload. Ids only. */
export interface TimerTriggerJobData {
  organisationId: string;
  workspaceId: string;
  /** The subject's own id: a `job_offer` id (offer-expiry, manager-confirmation) or a `shift_assignment` id (no-show, late-clock-in). */
  subjectId: string;
  /** The due time the producer computed from the committed row, epoch milliseconds. Compared with the row's due time on consume. */
  dueAtEpochMs: number;
}

/**
 * `WORKER_TIMER_TRIGGERS`:
 *  - `off` (DEFAULT): today exactly — no producer adds a job, the Worker creates no trigger consumer and arms nothing.
 *  - `shadow`: producers arm triggers and the consumer runs a READ ONLY decision, records `<kind>:would-act|stale|early|noop`
 *    and logs it. No business write, no notification, no audit row.
 *  - `on`: the consumer runs the scan's own per-candidate compare-and-set (same `worker_event` key, same notifications).
 */
export const TIMER_TRIGGER_MODES = ['off', 'shadow', 'on'] as const;
export type TimerTriggerMode = (typeof TIMER_TRIGGER_MODES)[number];

export class TimerTriggerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimerTriggerConfigError';
  }
}

/** Strict: exactly `off`, `shadow` or `on`; unset/empty → `off`. Anything else (OFF, On, ' on', true, 1) throws. */
export function parseTimerTriggerMode(raw: unknown): TimerTriggerMode {
  if (raw === undefined || raw === null || raw === '') return 'off';
  if (typeof raw === 'string' && (TIMER_TRIGGER_MODES as readonly string[]).includes(raw)) return raw as TimerTriggerMode;
  throw new TimerTriggerConfigError('WORKER_TIMER_TRIGGERS must be exactly off, shadow or on');
}

/**
 * `WORKER_TIMER_TRIGGER_KINDS` (OD-3: "on one kind at a time, each with separate approval"): the kinds the mode applies to,
 * a comma-separated list without spaces. Unset/empty → all four. Unknown, duplicate or empty items throw. A kind not in the
 * list behaves exactly as `off` for that kind (no producer adds it; a leftover job is acknowledged without a database read).
 */
export function parseTimerTriggerKinds(raw: unknown): readonly TimerTriggerKind[] {
  if (raw === undefined || raw === null || raw === '') return TIMER_TRIGGER_KINDS;
  if (typeof raw !== 'string') throw new TimerTriggerConfigError('WORKER_TIMER_TRIGGER_KINDS must be a comma-separated list');
  const items = raw.split(',');
  const kinds: TimerTriggerKind[] = [];
  for (const item of items) {
    if (!(TIMER_TRIGGER_KINDS as readonly string[]).includes(item)) {
      throw new TimerTriggerConfigError(`WORKER_TIMER_TRIGGER_KINDS: each item must be one of ${TIMER_TRIGGER_KINDS.join(', ')} (no spaces)`);
    }
    if (kinds.includes(item as TimerTriggerKind)) throw new TimerTriggerConfigError('WORKER_TIMER_TRIGGER_KINDS must not repeat a kind');
    kinds.push(item as TimerTriggerKind);
  }
  return Object.freeze(kinds);
}

/** The regex the environment class validates `WORKER_TIMER_TRIGGER_KINDS` with (same rule as `parseTimerTriggerKinds`, minus duplicates). */
export const TIMER_TRIGGER_KINDS_PATTERN = new RegExp(`^(?:${TIMER_TRIGGER_KINDS.join('|')})(?:,(?:${TIMER_TRIGGER_KINDS.join('|')}))*$`);

export interface TimerTriggerSettings {
  readonly mode: TimerTriggerMode;
  readonly kinds: readonly TimerTriggerKind[];
}

/** Resolves both variables (fail closed). `enabled(kind)` is false for every kind when the mode is `off`. */
export function resolveTimerTriggerSettings(env: { get(key: string): unknown }): TimerTriggerSettings & { enabled(kind: TimerTriggerKind): boolean } {
  const mode = parseTimerTriggerMode(env.get('WORKER_TIMER_TRIGGERS'));
  const kinds = parseTimerTriggerKinds(env.get('WORKER_TIMER_TRIGGER_KINDS'));
  return { mode, kinds, enabled: (kind) => mode !== 'off' && kinds.includes(kind) };
}

export const timerTriggerKindOfJobName = (jobName: string): TimerTriggerKind | null =>
  (TIMER_TRIGGER_KINDS.find((k) => TIMER_TRIGGER_JOB_NAMES[k] === jobName) ?? null);

/**
 * Deterministic jobId `<kind>.<subjectId>.<dueAtEpochMs>` (`.` separators: BullMQ refuses a custom id containing `:`).
 * The same subject and due time always map to the same id, so a re-arm is deduplicated by BullMQ; a moved due time (a
 * rescheduled shift) is a NEW id, and the old job becomes stale. ≤ 200 characters (validated by `registeredJob`).
 */
export function timerTriggerJobId(kind: TimerTriggerKind, subjectId: string, dueAtEpochMs: number): string {
  return `${kind}.${subjectId}.${Math.trunc(dueAtEpochMs)}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Latest due time a trigger may carry (a producer bug or a forged job far in the future is refused): year 2100. */
const MAX_DUE_EPOCH_MS = 4_102_444_800_000;

/**
 * Consumer-side shape check (fail closed; the producer side is the registry's `registeredJob`): exactly the four keys,
 * three UUIDs and a positive integer epoch. Returns null for anything else — the consumer then refuses the job without
 * touching the database.
 */
export function parseTimerTriggerPayload(data: unknown): TimerTriggerJobData | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const keys = Object.keys(data);
  if (keys.length !== TIMER_TRIGGER_PAYLOAD_KEYS.length || !TIMER_TRIGGER_PAYLOAD_KEYS.every((k) => keys.includes(k))) return null;
  const d = data as Record<string, unknown>;
  for (const k of ['organisationId', 'workspaceId', 'subjectId'] as const) {
    if (typeof d[k] !== 'string' || !UUID.test(d[k] as string)) return null;
  }
  const due = d.dueAtEpochMs;
  if (typeof due !== 'number' || !Number.isInteger(due) || due <= 0 || due > MAX_DUE_EPOCH_MS) return null;
  return { organisationId: d.organisationId as string, workspaceId: d.workspaceId as string, subjectId: d.subjectId as string, dueAtEpochMs: due };
}

/** An early trigger is re-delayed ONCE to `due + TIMER_TRIGGER_REDELAY_GRACE_MS` when it is at most this far ahead of the DB clock (plan §2.2 step 3). */
export const TIMER_TRIGGER_EARLY_REDELAY_MAX_MS = 5 * 60_000;
export const TIMER_TRIGGER_REDELAY_GRACE_MS = 1_000;

/**
 * Worker arming of no-show / late clock-in (plan §2.2): an assignment discovered by shift-monitor's reminder branch is armed
 * when its effective start is within this many shift-monitor intervals. Two intervals: a missed tick still arms in time.
 */
export const TIMER_TRIGGER_ARM_HORIZON_INTERVALS = 2;

/** Redis hash of trigger outcome counters (`<kind>:<outcome>` → count; 7-day TTL refreshed). Counts only, never ids. */
export const TIMER_TRIGGER_OUTCOMES_KEY = 'rab:worker:timer-triggers';
export const TIMER_TRIGGER_OUTCOMES_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Consumer outcomes:
 *  - `acted`: `on`, the shared compare-and-set changed something (offer expired, no-show flagged, late flagged, wake confirmed one)
 *  - `would-act`: `shadow`, the subject is due and still eligible — `on` would have run the compare-and-set now
 *  - `noop`: the subject is not visible (forged / wrong scope / deleted) or no longer eligible (accepted, cancelled,
 *    clocked in, already flagged), or `on` ran the compare-and-set and it matched nothing
 *  - `stale`: the row's current due time differs from the payload's (rescheduled, re-accepted, changed timeout)
 *  - `early`: the database clock has not reached the due time (and the job was not re-delayed)
 *  - `redelayed`: early by at most TIMER_TRIGGER_EARLY_REDELAY_MAX_MS; moved to `due + 1 s` once
 *  - `disabled`: the mode is `off` or the kind is not enabled on this Worker; acknowledged with no database read
 *  - `invalid`: the payload failed the consumer's shape check; failed closed with no database read
 *  Producer outcomes (API and Worker arming): `armed`, `arm-failed`, `arm-skipped` (in-flight bound).
 */
export type TimerTriggerOutcome = 'acted' | 'would-act' | 'noop' | 'stale' | 'early' | 'redelayed' | 'disabled' | 'invalid' | 'armed' | 'arm-failed' | 'arm-skipped';
