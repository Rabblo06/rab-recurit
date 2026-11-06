import { NO_SHOW_GRACE_MINUTES } from '@rab/server/modules/attendance/services/no-show-policy';
import { assignmentTimeSql, confirmationDeadlineSql } from '@rab/server/modules/scheduling/utils/assignment-time';
import {
  parseTimerTriggerPayload,
  TIMER_TRIGGER_EARLY_REDELAY_MAX_MS,
  TIMER_TRIGGER_REDELAY_GRACE_MS,
  TimerTriggerJobData,
  TimerTriggerKind,
  timerTriggerKindOfJobName,
  TimerTriggerMode,
  TimerTriggerOutcome,
} from '@rab/server/engine/worker-shared/timer-trigger.contract';
import { DelayedError, UnrecoverableError } from 'bullmq';
import { EntityManager } from 'typeorm';

/**
 * Phase D-Q4b consumer (docs/PHASE_DQ4_DQ5_PLAN_2026-11-03.md §2.2): one delayed trigger for one subject.
 *
 *  1. Fail closed BEFORE any database access: an unknown job name or a payload that is not exactly
 *     {organisationId, workspaceId, subjectId, dueAtEpochMs} (UUIDs, positive integer epoch) → UnrecoverableError (`invalid`).
 *     A kind not enabled on this Worker (or mode off) → acknowledged as `disabled`, no database access.
 *  2. DECIDE in a READ ONLY transaction bound to the payload's organisation/workspace (`runScoped` = runScopedForOrg:
 *     SET LOCAL + FORCE RLS; under HWS the workspace is routed through the RLS-bound registry, so another organisation's
 *     workspace fails routing). The payload is only a hint: the subject is re-read from the database —
 *       not visible (forged / wrong scope / deleted) or no longer eligible → `noop`;
 *       the row's due time ≠ payload due time → `stale`;
 *       database `now()` < due → `early` (re-delayed ONCE to due + 1 s when at most 5 min early → `redelayed`);
 *       otherwise due.
 *  3. Due: `shadow` → `would-act` (counted + one log line; nothing written). `on` → the scan's OWN per-candidate body
 *     (`actions[kind]`, the same compare-and-set, worker_event key, notifications and audit as the backstop scan) → `acted`
 *     when it changed something, else `noop`. The manager-confirmation kind is a WAKE: its action runs the existing
 *     due-work claim cycle (the pointer stays the authority; the API never calls a due-work definer).
 * A database error throws (BullMQ retries, attempts 3); the unchanged scan remains the backstop throughout.
 */

export interface TimerTriggerDecision {
  outcome: 'due' | 'noop' | 'stale' | 'early';
  /** Due time recomputed from the row (epoch ms), when the subject was visible and eligible. */
  dueAtEpochMs?: number;
  /** Database clock at the decision (epoch ms). */
  dbNowEpochMs?: number;
}

/** The kind-specific "act" step: the scan's per-candidate body for this subject. True when it changed something. */
export type TimerTriggerAction = (payload: TimerTriggerJobData) => Promise<boolean>;

export interface TimerTriggerHandlerDeps {
  mode: TimerTriggerMode;
  enabled: (kind: TimerTriggerKind) => boolean;
  /** runScopedForOrg(tenantContext, organisationId, workspaceId, fn). */
  runScoped: <T>(organisationId: string, workspaceId: string, fn: (manager: EntityManager) => Promise<T>) => Promise<T>;
  actions: Readonly<Record<TimerTriggerKind, TimerTriggerAction>>;
  lateClockInGraceMinutes: number;
  recordOutcome: (kind: TimerTriggerKind, outcome: TimerTriggerOutcome) => void;
  logger: { log(message: string): void; warn(message: string): void };
  now?: () => number;
}

/** The BullMQ job surface the handler needs. */
export interface TimerTriggerJobLike {
  id?: string;
  name: string;
  data: unknown;
  attemptsStarted?: number;
  moveToDelayed(timestamp: number, token?: string): Promise<void>;
}

const epoch = (value: Date | string | null | undefined): number | null => {
  if (value === null || value === undefined) return null;
  const ms = (value instanceof Date ? value : new Date(value)).getTime();
  return Number.isFinite(ms) ? ms : null;
};

/** READ ONLY decision for one subject under the bound tenant context. Exported for unit tests. */
export async function decideTimerTrigger(
  manager: EntityManager,
  kind: TimerTriggerKind,
  payload: TimerTriggerJobData,
  settings: { lateClockInGraceMinutes: number },
): Promise<TimerTriggerDecision> {
  await manager.query('SET TRANSACTION READ ONLY');
  let dueAt: number | null;
  let dbNow: number | null;
  if (kind === 'offer-expiry') {
    const [row] = await manager.query<Array<{ status: string; expires_at: Date; db_now: Date }>>(
      `SELECT status, expires_at, now() AS db_now FROM job_offer WHERE id = $1`,
      [payload.subjectId],
    );
    if (!row) return { outcome: 'noop' };
    dbNow = epoch(row.db_now);
    if (row.status !== 'pending') return { outcome: 'noop' };
    dueAt = epoch(row.expires_at);
  } else if (kind === 'manager-confirmation') {
    // Due at the manager-confirmation DEADLINE (owner rule 2026-11-06), the same SQL the API armed the trigger with, so
    // the stale check below holds. Every kind (standby included) is eligible: the cycle withdraws, it never confirms.
    const [row] = await manager.query<Array<{ status: string; shift_status: string; deadline_at: Date; db_now: Date }>>(
      // sql-injection-reviewed: code-constant SQL fragment from a helper called with literal aliases; values are bound $n parameters.
      `SELECT o.status, s.status AS shift_status, ${confirmationDeadlineSql('o', 'sa', 's')} AS deadline_at, now() AS db_now
         FROM job_offer o JOIN shift_assignment sa ON sa.id = o.shift_assignment_id JOIN shift s ON s.id = sa.shift_id
        WHERE o.id = $1`,
      [payload.subjectId],
    );
    if (!row) return { outcome: 'noop' };
    dbNow = epoch(row.db_now);
    if (row.status !== 'staff_accepted' || row.shift_status === 'cancelled') return { outcome: 'noop' };
    dueAt = epoch(row.deadline_at);
  } else {
    const t = assignmentTimeSql();
    const eventKey = `${kind}:${payload.subjectId}`;
    const [row] = await manager.query<
      Array<{ status: string; shift_status: string; checked_in: boolean; has_attendance: boolean; already_claimed: boolean; starts_at: Date; db_now: Date }>
    >(
      // sql-injection-reviewed: code-constant SQL fragment from a helper called with literal aliases; values are bound $n parameters.
      `SELECT sa.status, s.status AS shift_status, sa.checked_in_at IS NOT NULL AS checked_in,
              EXISTS (SELECT 1 FROM attendance a WHERE a.shift_assignment_id = sa.id) AS has_attendance,
              EXISTS (SELECT 1 FROM core.worker_event we WHERE we.event_key = $2 AND we.status IN ('completed', 'cancelled')) AS already_claimed,
              ${t.start} AS starts_at, now() AS db_now
         FROM shift_assignment sa
         JOIN shift s ON s.id = sa.shift_id
        WHERE sa.id = $1`,
      [payload.subjectId, eventKey],
    );
    if (!row) return { outcome: 'noop' };
    dbNow = epoch(row.db_now);
    // The scans' own discovery conditions (shift-monitor no-show branch / late-clock-in query). The bodies re-check them.
    if (row.status !== 'confirmed' || row.shift_status === 'cancelled' || row.shift_status === 'completed') return { outcome: 'noop' };
    if (row.has_attendance || row.already_claimed) return { outcome: 'noop' };
    if (kind === 'no-show' && row.checked_in) return { outcome: 'noop' };
    const start = epoch(row.starts_at);
    if (start === null) return { outcome: 'noop' };
    dueAt = start + (kind === 'no-show' ? NO_SHOW_GRACE_MINUTES : settings.lateClockInGraceMinutes) * 60_000;
  }
  if (dueAt === null || dbNow === null) return { outcome: 'noop' };
  if (dueAt !== payload.dueAtEpochMs) return { outcome: 'stale', dueAtEpochMs: dueAt, dbNowEpochMs: dbNow };
  if (dbNow < dueAt) return { outcome: 'early', dueAtEpochMs: dueAt, dbNowEpochMs: dbNow };
  return { outcome: 'due', dueAtEpochMs: dueAt, dbNowEpochMs: dbNow };
}

/**
 * Handles one trigger job. Returns the outcome (BullMQ stores it as the job's return value: counts only, no ids). Throws
 * UnrecoverableError for an invalid job, DelayedError after a re-delay, and any database error (retried by BullMQ).
 */
export async function handleTimerTrigger(job: TimerTriggerJobLike, token: string | undefined, deps: TimerTriggerHandlerDeps): Promise<{ outcome: TimerTriggerOutcome }> {
  const kind = timerTriggerKindOfJobName(job.name);
  const payload = kind ? parseTimerTriggerPayload(job.data) : null;
  if (!kind || !payload) {
    if (kind) deps.recordOutcome(kind, 'invalid');
    deps.logger.warn(`timer trigger job ${job.id ?? '?'} refused: invalid job name or payload (failed closed, not run)`);
    throw new UnrecoverableError('invalid timer trigger job');
  }
  const done = (outcome: TimerTriggerOutcome) => {
    deps.recordOutcome(kind, outcome);
    return { outcome };
  };
  // A leftover job after a rollback to off (or a kind not enabled here): acknowledged with no database access.
  if (deps.mode === 'off' || !deps.enabled(kind)) return done('disabled');

  const decision = await deps.runScoped(payload.organisationId, payload.workspaceId, (manager) =>
    decideTimerTrigger(manager, kind, payload, {
      lateClockInGraceMinutes: deps.lateClockInGraceMinutes,
    }),
  );

  if (decision.outcome === 'early') {
    const ahead = decision.dueAtEpochMs! - decision.dbNowEpochMs!;
    // Once: only on the job's first start (a re-delayed job starts again with attemptsStarted 2).
    if (ahead <= TIMER_TRIGGER_EARLY_REDELAY_MAX_MS && (job.attemptsStarted ?? 1) <= 1) {
      const now = (deps.now ?? Date.now)();
      await job.moveToDelayed(now + ahead + TIMER_TRIGGER_REDELAY_GRACE_MS, token);
      deps.recordOutcome(kind, 'redelayed');
      throw new DelayedError();
    }
    return done('early');
  }
  if (decision.outcome !== 'due') return done(decision.outcome);

  if (deps.mode === 'shadow') {
    const lag = decision.dbNowEpochMs! - decision.dueAtEpochMs!;
    deps.logger.log(`timer trigger (shadow) ${kind} would act: subject=${payload.subjectId} lateByMs=${lag}`);
    return done('would-act');
  }
  const acted = await deps.actions[kind](payload);
  return done(acted ? 'acted' : 'noop');
}
