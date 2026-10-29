import {
  WORKER_SCAN_INTERVAL_SETTINGS,
  WorkerScanIntervalKey,
} from '@rab/server/engine/core-modules/environment/worker-scan-intervals';
import { SCAN_QUEUES, ScanQueueName } from './queue-registry';

/**
 * The 20 periodic scans of the jobs process (the 19 pre-migration loops + AI Phase 1's `ai-retention`, appended last) — the single source of truth for BOTH scheduler modes (BullMQ migration,
 * Lane A M2/M4). Order, human names, intervals and stats keys are exactly the pre-migration `main.ts` `runtime.every()`
 * calls (verified line by line against main.ts @ a743806f): interval mode registers them in this order, with these
 * names/keys, so its behaviour is unchanged; bullmq mode creates one job scheduler per entry.
 *
 * Interval sources (Phase A pa-intervals): every scan's cadence is an environment setting. 17 scans read a
 * `WORKER_<JOB>_INTERVAL_SECONDS` key (engine/core-modules/environment/worker-scan-intervals.ts — defaults EXACTLY the
 * constants this file used to hold, bounded, out-of-range refuses to boot); 3 keep their pre-existing minutes keys
 * (LOGIN_HANDOFF_CLEANUP_INTERVAL_MINUTES, OUTBOX_RETENTION_INTERVAL_MINUTES, AI_RETENTION_INTERVAL_MINUTES).
 *
 * Enable switches: the login handoff cleanup / outbox retention / AI retention switches stay INSIDE the cycle (a disabled
 * job still fires on schedule and returns `ran: false`, never stamped as a successful run). Phase A adds a REGISTRATION
 * predicate for two scans only (`enabledBy`): `push-dispatch` runs only when PUSH_ENABLED=true and
 * `realtime-outbox-publish` only when REALTIME_ENABLED=true. A disabled scan is not registered in interval mode, and in
 * bullmq mode its Crewflow scheduler is removed on reconcile (re-added when re-enabled).
 */
export type IntervalSource =
  | { kind: 'constant'; ms: number }
  | { kind: 'env-seconds'; key: WorkerScanIntervalKey }
  | { kind: 'env-minutes'; key: 'LOGIN_HANDOFF_CLEANUP_INTERVAL_MINUTES' | 'OUTBOX_RETENTION_INTERVAL_MINUTES' | 'AI_RETENTION_INTERVAL_MINUTES' };

/** Boolean env switches a scan's registration may depend on (Phase A contract with the realtime/push gating lane). */
export type ScanEnableKey = 'REALTIME_ENABLED' | 'PUSH_ENABLED';

export interface ScanJobDefinition {
  queue: ScanQueueName;
  /** BullMQ job name, `@Process(jobName)` target, metrics key. */
  jobName: string;
  /** Human name — exactly the pre-migration log name (`<name> cycle failed`, overlap warnings). */
  name: string;
  interval: IntervalSource;
  statKeys: { lastRunAt: string; failures: string; skipped: string };
  /**
   * True for the seven cycles whose `return false` means "nothing to record" (claimed nothing / disabled). Documentation +
   * test anchor only: the processor's own return value is what the runtime honours.
   */
  mayReturnFalse: boolean;
  /**
   * Phase A: registration predicate. Absent ⇒ always registered. Present ⇒ registered only while that env switch is
   * exactly `true` (anything else — false, missing, malformed — means NOT registered: fail closed).
   */
  enabledBy?: ScanEnableKey;
  /**
   * Phase A generic scheduler hook (default OFF for every scan): when true, a newly registered scan first runs ONE
   * INTERVAL after registration instead of immediately (interval mode: no tick at process start; bullmq mode: a new
   * scheduler's first job is delayed by one interval). Exists for scans whose immediate start-up run is undesirable
   * (e.g. a 24 h sweep on every deploy); enabling it for a scan is a coordinator/owner decision, not set here.
   */
  firstRunAfterInterval?: boolean;
}

const MINUTE = 60 * 1000;

const job = (
  queue: ScanQueueName,
  jobName: string,
  name: string,
  interval: IntervalSource,
  lastRunAt: string,
  failures: string,
  mayReturnFalse = false,
  extra: Pick<ScanJobDefinition, 'enabledBy' | 'firstRunAfterInterval'> = {},
): ScanJobDefinition => ({
  queue,
  jobName,
  name,
  interval,
  // `<loop>Skipped` — new field (bullmq mode only), derived from the existing failures key.
  statKeys: { lastRunAt, failures, skipped: failures.replace(/Failures$/, 'Skipped') },
  mayReturnFalse,
  ...extra,
});

const envSeconds = (key: WorkerScanIntervalKey): IntervalSource => ({ kind: 'env-seconds', key });

export const SCAN_JOBS: readonly ScanJobDefinition[] = Object.freeze([
  job(SCAN_QUEUES.maintenance, 'account-invite-cleanup', 'account-invite cleanup', envSeconds('WORKER_ACCOUNT_INVITE_CLEANUP_INTERVAL_SECONDS'), 'lastAccountInviteCleanupAt', 'accountInviteCleanupFailures'),
  job(SCAN_QUEUES.email, 'email-dispatch', 'email dispatch', envSeconds('WORKER_EMAIL_DISPATCH_INTERVAL_SECONDS'), 'lastEmailDispatchAt', 'emailDispatchFailures', true),
  job(SCAN_QUEUES.push, 'push-dispatch', 'push dispatch', envSeconds('WORKER_PUSH_DISPATCH_INTERVAL_SECONDS'), 'lastPushDispatchAt', 'pushDispatchFailures', true, { enabledBy: 'PUSH_ENABLED' }),
  job(SCAN_QUEUES.shifts, 'shift-monitor', 'shift monitor', envSeconds('WORKER_SHIFT_MONITOR_INTERVAL_SECONDS'), 'lastShiftMonitorAt', 'shiftMonitorFailures'),
  job(SCAN_QUEUES.shifts, 'attendance-monitor', 'attendance monitor', envSeconds('WORKER_ATTENDANCE_MONITOR_INTERVAL_SECONDS'), 'lastAttendanceMonitorAt', 'attendanceMonitorFailures'),
  job(SCAN_QUEUES.shifts, 'late-clock-in', 'late clock-in', envSeconds('WORKER_LATE_CLOCK_IN_INTERVAL_SECONDS'), 'lastLateClockInAt', 'lateClockInFailures'),
  job(SCAN_QUEUES.shifts, 'shift-cancellation-followup', 'shift cancellation follow-up', envSeconds('WORKER_SHIFT_CANCELLATION_FOLLOWUP_INTERVAL_SECONDS'), 'lastShiftCancellationFollowupAt', 'shiftCancellationFollowupFailures'),
  job(SCAN_QUEUES.offers, 'offer-expiry', 'offer expiry', envSeconds('WORKER_OFFER_EXPIRY_INTERVAL_SECONDS'), 'lastOfferExpiryAt', 'offerExpiryFailures'),
  job(SCAN_QUEUES.offers, 'manager-confirmation-timeout', 'manager confirmation timeout', envSeconds('WORKER_MANAGER_CONFIRMATION_TIMEOUT_INTERVAL_SECONDS'), 'lastManagerConfirmationTimeoutAt', 'managerConfirmationTimeoutFailures'),
  job(SCAN_QUEUES.offers, 'replacement-staff', 'replacement staff', envSeconds('WORKER_REPLACEMENT_STAFF_INTERVAL_SECONDS'), 'lastReplacementStaffAt', 'replacementStaffFailures'),
  job(SCAN_QUEUES.maintenance, 'token-cleanup', 'token cleanup', envSeconds('WORKER_TOKEN_CLEANUP_INTERVAL_SECONDS'), 'lastTokenCleanupAt', 'tokenCleanupFailures'),
  job(
    SCAN_QUEUES.maintenance,
    'login-handoff-cleanup',
    'login handoff cleanup',
    { kind: 'env-minutes', key: 'LOGIN_HANDOFF_CLEANUP_INTERVAL_MINUTES' },
    'lastLoginHandoffCleanupAt',
    'loginHandoffCleanupFailures',
    true,
  ),
  // Phase A pa-storage: returns false when it skips (recent run cluster-wide, or another replica holds the reconcile lock).
  job(SCAN_QUEUES.maintenance, 'storage-cleanup', 'storage cleanup', envSeconds('WORKER_STORAGE_CLEANUP_INTERVAL_SECONDS'), 'lastStorageCleanupAt', 'storageCleanupFailures', true),
  job(SCAN_QUEUES.reports, 'shift-report-scheduler', 'shift report scheduler', envSeconds('WORKER_SHIFT_REPORT_SCHEDULER_INTERVAL_SECONDS'), 'lastShiftReportSchedulerAt', 'shiftReportSchedulerFailures'),
  job(SCAN_QUEUES.reports, 'final-timesheet', 'final timesheet', envSeconds('WORKER_FINAL_TIMESHEET_INTERVAL_SECONDS'), 'lastFinalTimesheetAt', 'finalTimesheetFailures'),
  job(SCAN_QUEUES.reports, 'shift-statement-dispatch', 'shift statement dispatch', envSeconds('WORKER_SHIFT_STATEMENT_DISPATCH_INTERVAL_SECONDS'), 'lastShiftStatementDispatchAt', 'shiftStatementDispatchFailures', true),
  job(SCAN_QUEUES.reports, 'payroll-period-attention', 'payroll period attention', envSeconds('WORKER_PAYROLL_PERIOD_ATTENTION_INTERVAL_SECONDS'), 'lastPayrollPeriodAttentionAt', 'payrollPeriodAttentionFailures'),
  job(SCAN_QUEUES.realtime, 'realtime-outbox-publish', 'realtime outbox publish', envSeconds('WORKER_REALTIME_OUTBOX_PUBLISH_INTERVAL_SECONDS'), 'lastRealtimeOutboxPublishAt', 'realtimeOutboxPublishFailures', true, { enabledBy: 'REALTIME_ENABLED' }),
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

/**
 * The scan's interval in ms. Fail closed: a non-integer, non-positive or (for the Phase A seconds keys) out-of-bounds
 * value throws — EnvironmentService has already refused to boot on such a value, so this is defence in depth for any
 * caller that passes another source (tests, tools).
 */
export function resolveIntervalMs(def: ScanJobDefinition, env: { get(key: IntervalSourceEnvKey): number }): number {
  const source = def.interval;
  let ms: number;
  if (source.kind === 'constant') {
    ms = source.ms;
  } else if (source.kind === 'env-seconds') {
    const seconds = env.get(source.key);
    const bounds = WORKER_SCAN_INTERVAL_SETTINGS[source.key];
    if (!Number.isInteger(seconds) || seconds < bounds.minSeconds || seconds > bounds.maxSeconds) {
      throw new Error(`${def.name}: invalid interval (${source.key} must be an integer ${bounds.minSeconds}–${bounds.maxSeconds})`);
    }
    ms = seconds * 1000;
  } else {
    ms = env.get(source.key) * MINUTE;
  }
  if (!Number.isInteger(ms) || ms <= 0) throw new Error(`${def.name}: invalid interval`);
  return ms;
}
export type IntervalSourceEnvKey = Exclude<IntervalSource, { kind: 'constant' }>['key'];

/** Phase A registration predicate: true unless the scan names a switch that is not exactly `true` (fail closed). */
export function isScanJobEnabled(def: Pick<ScanJobDefinition, 'enabledBy'>, env: { get(key: ScanEnableKey): boolean }): boolean {
  return def.enabledBy === undefined || env.get(def.enabledBy) === true;
}

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
