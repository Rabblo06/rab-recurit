import Redis from 'ioredis';

import { NO_SHOW_GRACE_MINUTES } from '@rab/server/modules/attendance/services/no-show-policy';
import type { TimerTriggerArm } from '@rab/server/engine/core-modules/timer-trigger/timer-trigger-queue.service';
import {
  TIMER_TRIGGER_ARM_HORIZON_INTERVALS,
  TIMER_TRIGGER_OUTCOMES_KEY,
  TIMER_TRIGGER_OUTCOMES_TTL_SECONDS,
  TimerTriggerKind,
  TimerTriggerOutcome,
} from '@rab/server/engine/worker-shared/timer-trigger.contract';

/** A shift-monitor discovery row (reminder or no-show branch): ids and the assignment's effective start. */
export interface ShiftArmCandidate {
  assignment_id: string;
  organisation_id: string;
  workspace_id: string | null;
  starts_at: Date | string;
}

/** The producer surface arming needs (TimerTriggerQueueService). */
export interface TimerTriggerArmProducer {
  enabled(kind: TimerTriggerKind): boolean;
  publishNow(arm: TimerTriggerArm): Promise<boolean>;
}

/** Publishes in flight at once while arming (each is bounded by the producer's 3 s fail-fast publish). */
const ARM_CONCURRENCY = 10;

/**
 * Phase D-Q4b (plan §2.2): the Worker arms no-show and late clock-in triggers from shift-monitor's EXISTING discovery — no
 * extra query, and no API scheduling / withdraw / cancel code is touched (the regression risk shift-monitor.job.ts's doc
 * comment describes). An assignment is armed when its effective start is in the future and within `horizonMs` (two
 * shift-monitor intervals), with:
 *   no-show-trigger       due = start + NO_SHOW_GRACE_MINUTES (the shift-monitor no-show threshold)
 *   late-clock-in-trigger due = start + LATE_CLOCK_IN_GRACE_MINUTES (the late-clock-in threshold)
 * keyed `<kind>.<assignmentId>.<dueEpochMs>`, so re-arming on the next tick is a BullMQ no-op and a rescheduled start is a
 * new job (the old one is stale on consume). A cancellation or reassignment makes the old trigger a no-op (status check +
 * the scan's own compare-and-set). Rows without a workspace are unreachable by the workspace-scoped Worker and are skipped
 * (exactly as the scans skip them). Never throws: a failure is counted and the unchanged scans remain the backstop.
 */
export async function armShiftTimerTriggers(
  producer: TimerTriggerArmProducer,
  candidates: readonly ShiftArmCandidate[],
  options: { nowMs: number; horizonMs: number; lateClockInGraceMinutes: number; recordOutcome?: (kind: TimerTriggerKind, outcome: TimerTriggerOutcome) => void },
): Promise<{ armed: number; failed: number }> {
  const kinds = (['no-show', 'late-clock-in'] as const).filter((k) => producer.enabled(k));
  if (!kinds.length) return { armed: 0, failed: 0 };
  const arms: TimerTriggerArm[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    if (!c.workspace_id || seen.has(c.assignment_id)) continue;
    const start = (c.starts_at instanceof Date ? c.starts_at : new Date(c.starts_at)).getTime();
    if (!Number.isFinite(start) || start <= options.nowMs || start > options.nowMs + options.horizonMs) continue;
    seen.add(c.assignment_id);
    for (const kind of kinds) {
      const graceMinutes = kind === 'no-show' ? NO_SHOW_GRACE_MINUTES : options.lateClockInGraceMinutes;
      arms.push({ kind, organisationId: c.organisation_id, workspaceId: c.workspace_id, subjectId: c.assignment_id, dueAt: new Date(start + graceMinutes * 60_000) });
    }
  }
  let armed = 0;
  let failed = 0;
  for (let i = 0; i < arms.length; i += ARM_CONCURRENCY) {
    const results = await Promise.all(arms.slice(i, i + ARM_CONCURRENCY).map((arm) => producer.publishNow(arm).catch(() => false)));
    results.forEach((ok, j) => {
      const kind = arms[i + j]!.kind;
      if (ok) armed++;
      else failed++;
      options.recordOutcome?.(kind, ok ? 'armed' : 'arm-failed');
    });
  }
  return { armed, failed };
}

/** HINCRBY `<kind>:<outcome>` on `rab:worker:timer-triggers` (7-day TTL refreshed). Best effort; counts only, never ids. */
export function redisTimerTriggerOutcomeRecorder(redis: Pick<Redis, 'multi'>): (kind: TimerTriggerKind, outcome: TimerTriggerOutcome) => void {
  return (kind, outcome) => {
    redis
      .multi()
      .hincrby(TIMER_TRIGGER_OUTCOMES_KEY, `${kind}:${outcome}`, 1)
      .expire(TIMER_TRIGGER_OUTCOMES_KEY, TIMER_TRIGGER_OUTCOMES_TTL_SECONDS)
      .exec()
      .catch(() => undefined);
  };
}

/**
 * The ONE arming step both shift-monitor paths call between discovery and processing — separate mode
 * (shift.processors.ts) and D-Q4a's combined scan (shift-scan-combined.job.ts) — so the two modes arm identically. No-op
 * (returns at once, no Redis call) when neither shift kind is enabled. Never throws.
 */
export async function armFromShiftMonitorDiscoveries(
  producer: TimerTriggerArmProducer | undefined,
  discoveries: ReadonlyArray<{ assignments: readonly ShiftArmCandidate[] }>,
  deps: {
    environmentService: { get(key: 'WORKER_SHIFT_MONITOR_INTERVAL_SECONDS' | 'LATE_CLOCK_IN_GRACE_MINUTES'): number };
    logger: { warn(message: string): void };
    recordOutcome?: (kind: TimerTriggerKind, outcome: TimerTriggerOutcome) => void;
  },
): Promise<void> {
  if (!producer || !(producer.enabled('no-show') || producer.enabled('late-clock-in'))) return;
  const result = await armShiftTimerTriggers(producer, discoveries.flatMap((d) => d.assignments), {
    nowMs: Date.now(),
    horizonMs: deps.environmentService.get('WORKER_SHIFT_MONITOR_INTERVAL_SECONDS') * 1000 * TIMER_TRIGGER_ARM_HORIZON_INTERVALS,
    lateClockInGraceMinutes: deps.environmentService.get('LATE_CLOCK_IN_GRACE_MINUTES'),
    recordOutcome: deps.recordOutcome,
  }).catch(() => ({ armed: 0, failed: 0 }));
  if (result.failed) deps.logger.warn(`shift monitor: timer-trigger arming failed for ${result.failed} trigger(s); the scans are the backstop`);
}
