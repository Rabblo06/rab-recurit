import { SCAN_QUEUES, ScanQueueName } from './queue-registry';

/**
 * The 19 periodic scans of the jobs process — the single source of truth for BOTH scheduler modes (BullMQ migration,
 * Lane A M2/M4). Order, human names, intervals and stats keys are exactly the pre-migration `main.ts` `runtime.every()`
 * calls (verified line by line against main.ts @ a743806f): interval mode registers them in this order, with these
 * names/keys, so its behaviour is unchanged; bullmq mode creates one job scheduler per entry.
 *
 * Interval sources: 17 constants (copied, not re-derived) and 2 environment-driven values
 * (LOGIN_HANDOFF_CLEANUP_INTERVAL_MINUTES, OUTBOX_RETENTION_INTERVAL_MINUTES). Enable switches stay INSIDE the cycle
 * (login handoff cleanup, outbox retention): a disabled job still fires on schedule and returns `ran: false`, which is
 * never stamped as a successful run — the same contract as interval mode, and no flapping if replicas disagree.
 */
export type IntervalSource =
  | { kind: 'constant'; ms: number }
  | { kind: 'env-minutes'; key: 'LOGIN_HANDOFF_CLEANUP_INTERVAL_MINUTES' | 'OUTBOX_RETENTION_INTERVAL_MINUTES' | 'AI_RETENTION_INTERVAL_MINUTES' };

export interface ScanJobDefinition {
  queue: ScanQueueName;
  /** BullMQ job name, `@Process(jobName)` target, metrics key. */
  jobName: string;
  /** Human name — exactly the pre-migration log name (`<name> cycle failed`, overlap warnings). */
  name: string;
  interval: IntervalSource;
  statKeys: { lastRunAt: string; failures: string; skipped: string };
  /**
   * True for the six cycles whose `return false` means "nothing to record" (claimed nothing / disabled). Documentation +
   * test anchor only: the processor's own return value is what the runtime honours.
   */
  mayReturnFalse: boolean;
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const job = (
  queue: ScanQueueName,
  jobName: string,
  name: string,
  interval: IntervalSource,
  lastRunAt: string,
  failures: string,
  mayReturnFalse = false,
): ScanJobDefinition => ({
  queue,
  jobName,
  name,
  interval,
  // `<loop>Skipped` — new field (bullmq mode only), derived from the existing failures key.
  statKeys: { lastRunAt, failures, skipped: failures.replace(/Failures$/, 'Skipped') },
  mayReturnFalse,
});

const constant = (ms: number): IntervalSource => ({ kind: 'constant', ms });

export const SCAN_JOBS: readonly ScanJobDefinition[] = Object.freeze([
  job(SCAN_QUEUES.maintenance, 'account-invite-cleanup', 'account-invite cleanup', constant(15 * MINUTE), 'lastAccountInviteCleanupAt', 'accountInviteCleanupFailures'),
  job(SCAN_QUEUES.email, 'email-dispatch', 'email dispatch', constant(2_000), 'lastEmailDispatchAt', 'emailDispatchFailures', true),
  job(SCAN_QUEUES.push, 'push-dispatch', 'push dispatch', constant(2_000), 'lastPushDispatchAt', 'pushDispatchFailures', true),
  job(SCAN_QUEUES.shifts, 'shift-monitor', 'shift monitor', constant(5 * MINUTE), 'lastShiftMonitorAt', 'shiftMonitorFailures'),
  job(SCAN_QUEUES.shifts, 'attendance-monitor', 'attendance monitor', constant(5 * MINUTE), 'lastAttendanceMonitorAt', 'attendanceMonitorFailures'),
  job(SCAN_QUEUES.shifts, 'late-clock-in', 'late clock-in', constant(2 * MINUTE), 'lastLateClockInAt', 'lateClockInFailures'),
  job(SCAN_QUEUES.shifts, 'shift-cancellation-followup', 'shift cancellation follow-up', constant(MINUTE), 'lastShiftCancellationFollowupAt', 'shiftCancellationFollowupFailures'),
  job(SCAN_QUEUES.offers, 'offer-expiry', 'offer expiry', constant(MINUTE), 'lastOfferExpiryAt', 'offerExpiryFailures'),
  job(SCAN_QUEUES.offers, 'manager-confirmation-timeout', 'manager confirmation timeout', constant(MINUTE), 'lastManagerConfirmationTimeoutAt', 'managerConfirmationTimeoutFailures'),
  job(SCAN_QUEUES.offers, 'replacement-staff', 'replacement staff', constant(2 * MINUTE), 'lastReplacementStaffAt', 'replacementStaffFailures'),
  job(SCAN_QUEUES.maintenance, 'token-cleanup', 'token cleanup', constant(24 * HOUR), 'lastTokenCleanupAt', 'tokenCleanupFailures'),
  job(
    SCAN_QUEUES.maintenance,
    'login-handoff-cleanup',
    'login handoff cleanup',
    { kind: 'env-minutes', key: 'LOGIN_HANDOFF_CLEANUP_INTERVAL_MINUTES' },
    'lastLoginHandoffCleanupAt',
    'loginHandoffCleanupFailures',
    true,
  ),
  job(SCAN_QUEUES.maintenance, 'storage-cleanup', 'storage cleanup', constant(24 * HOUR), 'lastStorageCleanupAt', 'storageCleanupFailures'),
  job(SCAN_QUEUES.reports, 'shift-report-scheduler', 'shift report scheduler', constant(5 * MINUTE), 'lastShiftReportSchedulerAt', 'shiftReportSchedulerFailures'),
  job(SCAN_QUEUES.reports, 'final-timesheet', 'final timesheet', constant(5 * MINUTE), 'lastFinalTimesheetAt', 'finalTimesheetFailures'),
  job(SCAN_QUEUES.reports, 'shift-statement-dispatch', 'shift statement dispatch', constant(5_000), 'lastShiftStatementDispatchAt', 'shiftStatementDispatchFailures', true),
  job(SCAN_QUEUES.reports, 'payroll-period-attention', 'payroll period attention', constant(30 * MINUTE), 'lastPayrollPeriodAttentionAt', 'payrollPeriodAttentionFailures'),
  job(SCAN_QUEUES.realtime, 'realtime-outbox-publish', 'realtime outbox publish', constant(2_000), 'lastRealtimeOutboxPublishAt', 'realtimeOutboxPublishFailures', true),
  job(
    SCAN_QUEUES.maintenance,
    'outbox-retention',
    'outbox retention',
    { kind: 'env-minutes', key: 'OUTBOX_RETENTION_INTERVAL_MINUTES' },
    'lastOutboxRetentionAt',
    'outboxRetentionFailures',
    true,
  ),
  // AI Phase 1: AI conversation retention (queues/rab-ai/ai.processors.ts). OFF by default (AI_RETENTION_MODE=off ⇒ returns
  // false, never stamped); report/purge through core.ai_purge_expired_conversations, one organisation at a time.
  job(
    SCAN_QUEUES.maintenance,
    'ai-retention',
    'ai retention',
    { kind: 'env-minutes', key: 'AI_RETENTION_INTERVAL_MINUTES' },
    'lastAiRetentionAt',
    'aiRetentionFailures',
    true,
  ),
]);

/** Scheduler id: `crewflow:<queue>:<jobName>` (owner brief). The `crewflow:<queue>:` prefix marks it as Crewflow-owned. */
export const schedulerIdOf = (def: Pick<ScanJobDefinition, 'queue' | 'jobName'>): string => `crewflow:${def.queue}:${def.jobName}`;
export const crewflowSchedulerPrefixOf = (queue: string): string => `crewflow:${queue}:`;

export function resolveIntervalMs(def: ScanJobDefinition, env: { get(key: IntervalSourceEnvKey): number }): number {
  const ms = def.interval.kind === 'constant' ? def.interval.ms : env.get(def.interval.key) * MINUTE;
  if (!Number.isInteger(ms) || ms <= 0) throw new Error(`${def.name}: invalid interval`);
  return ms;
}
type IntervalSourceEnvKey = Extract<IntervalSource, { kind: 'env-minutes' }>['key'];

/**
 * BullMQ lock duration per scan queue (bullmq mode). Rule (owner brief): p99 cycle duration × 3, measured with the M1
 * instrumentation — never invented — floored at BullMQ's own default (30 000 ms, `Worker` defaults in
 * bullmq 5.81.3 dist/cjs/classes/worker.js). The lock is renewed every lockDuration/2 while a scan runs, so this bounds
 * how long a scan held by a DEAD replica stays "active" before BullMQ's stalled check frees it, not how long a scan may
 * run. Measured p99 values (max over the queue's jobs) and where they came from are recorded in
 * docs/ultimate/CREWFLOW_BULLMQ_WORKER_MIGRATION_REPORT.md §Lock durations; `null` = not measured → the floor applies.
 */
export const BULLMQ_DEFAULT_LOCK_DURATION_MS = 30_000;
// Measured 2026-10-24, dev stack (rab-devdb, HWS on), bullmq mode, 41 min, M1 `rab:worker:cycle-durations` (max p99 of
// the queue's jobs, ms; evidence docs/ultimate/evidence/lane-a/dev-soak/05-soak-final.json). All × 3 < 30 000 → the
// floor applies everywhere. Re-measure on production-sized data (≥ 48 h) before stage D; raise only from measurements.
export const MEASURED_P99_MS: Readonly<Record<ScanQueueName, number | null>> = Object.freeze({
  'crewflow-scan-email': 23, // email-dispatch
  'crewflow-scan-push': 18, // push-dispatch
  'crewflow-scan-shifts': 127, // late-clock-in (shift-cancellation-followup 125, shift-monitor 124, attendance 122)
  'crewflow-scan-offers': 123, // replacement-staff (offer-expiry 112, manager-confirmation-timeout 65)
  'crewflow-scan-reports': 124, // shift-report-scheduler (final-timesheet 123, payroll attention 109, statements 64)
  'crewflow-scan-maintenance': 120, // storage-cleanup (login-handoff 88, token 66, invite 58, retention 38 disabled)
  'crewflow-scan-realtime': 30, // realtime-outbox-publish
});

export function lockDurationMsFor(queue: ScanQueueName, measured: Readonly<Record<string, number | null>> = MEASURED_P99_MS): number {
  const p99 = measured[queue];
  return Math.max(BULLMQ_DEFAULT_LOCK_DURATION_MS, typeof p99 === 'number' && p99 > 0 ? Math.ceil(p99 * 3) : 0);
}

/** Number of distinct scans on a queue = that queue's Worker concurrency, so different scans never wait on each other. */
export const scanJobsOn = (queue: ScanQueueName): ScanJobDefinition[] => SCAN_JOBS.filter((d) => d.queue === queue);
