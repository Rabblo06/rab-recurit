import {
  COMBINED_SHIFT_SCAN_MIN_TICK_SECONDS,
  combinedShiftScanTickSeconds,
  WORKER_SCAN_INTERVAL_SETTINGS,
  WorkerScanIntervalKey,
} from '@rab/server/engine/core-modules/environment/worker-scan-intervals';
import { SCAN_QUEUES, ScanQueueName } from './queue-registry';

/**
 * The 21 periodic scans of the jobs process (the 19 pre-migration loops + AI Phase 1's `ai-retention` + Phase B P8's
 * `workspace-provisioning-health`, appended last) — the single source of truth for BOTH scheduler modes (BullMQ migration,
 * Lane A M2/M4). Order, human names, intervals and stats keys are exactly the pre-migration `main.ts` `runtime.every()`
 * calls (verified line by line against main.ts @ a743806f): interval mode registers them in this order, with these
 * names/keys, so its behaviour is unchanged; bullmq mode creates one job scheduler per entry.
 *
 * Interval sources (Phase A pa-intervals): every scan's cadence is an environment setting. 17 scans read a
 * `WORKER_<JOB>_INTERVAL_SECONDS` key (engine/core-modules/environment/worker-scan-intervals.ts — defaults EXACTLY the
 * constants this file used to hold, bounded, out-of-range refuses to boot); 3 keep their pre-existing minutes keys
 * (LOGIN_HANDOFF_CLEANUP_INTERVAL_MINUTES, OUTBOX_RETENTION_INTERVAL_MINUTES, AI_RETENTION_INTERVAL_MINUTES).
 *
 * Enable switches: Phase A added a REGISTRATION predicate (`enabledBy`) for `push-dispatch` (PUSH_ENABLED=true) and
 * `realtime-outbox-publish` (REALTIME_ENABLED=true). Phase D (D3, owner decision: do not schedule disabled scans) adds the
 * three switches that used to be checked only inside their cycle: login handoff cleanup (LOGIN_HANDOFF_CLEANUP_ENABLED,
 * default true), outbox retention (OUTBOX_RETENTION_ENABLED, default false) and AI retention (AI_RETENTION_MODE report |
 * purge, default off). A disabled scan is not registered in interval mode, and in bullmq mode its Crewflow scheduler is
 * removed on reconcile (re-added when re-enabled). The cycles keep their own in-cycle check as defence in depth.
 */
export type IntervalSource =
  | { kind: 'constant'; ms: number }
  | { kind: 'env-seconds'; key: WorkerScanIntervalKey }
  | { kind: 'env-minutes'; key: 'LOGIN_HANDOFF_CLEANUP_INTERVAL_MINUTES' | 'OUTBOX_RETENTION_INTERVAL_MINUTES' | 'AI_RETENTION_INTERVAL_MINUTES' | 'AI_STALE_TURN_SWEEP_INTERVAL_MINUTES' }
  // Phase D-Q4a: the combined shift scan's tick, the greatest common divisor of its members' own intervals (each member
  // keeps its own interval and runs only on the ticks where it is due).
  | { kind: 'combined-shift-scan' };

/**
 * Env switches a scan's registration may depend on. Phase A: REALTIME_ENABLED / PUSH_ENABLED. Phase D (D3, owner
 * decision "do not schedule disabled scans"): the three switches that used to be checked only INSIDE their cycle —
 * LOGIN_HANDOFF_CLEANUP_ENABLED, OUTBOX_RETENTION_ENABLED (booleans) and AI_RETENTION_MODE (enabled in `report` / `purge`).
 * The cycles keep their own check (defence in depth).
 */
export type ScanEnableKey = 'REALTIME_ENABLED' | 'PUSH_ENABLED' | 'LOGIN_HANDOFF_CLEANUP_ENABLED' | 'OUTBOX_RETENTION_ENABLED' | 'AI_RETENTION_MODE' | 'AI_STALE_TURN_SWEEP';

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
   * (e.g. a 24 h sweep on every deploy). Phase D (D3, owner decision): on for the three daily housekeeping scans.
   */
  firstRunAfterInterval?: boolean;
  /**
   * Phase D-Q4a: registered only in this WORKER_SHIFT_SCAN_MODE (absent: both modes). The four combined members say
   * `separate`, the combined scan says `combined`, so exactly one of the two shapes is ever scheduled.
   */
  shiftScanMode?: ShiftScanMode;
}

export type ShiftScanMode = 'separate' | 'combined';

const MINUTE = 60 * 1000;

const job = (
  queue: ScanQueueName,
  jobName: string,
  name: string,
  interval: IntervalSource,
  lastRunAt: string,
  failures: string,
  mayReturnFalse = false,
  extra: Pick<ScanJobDefinition, 'enabledBy' | 'firstRunAfterInterval' | 'shiftScanMode'> = {},
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
  // Phase D-Q4a: the four members of the combined shift scan are registered only in WORKER_SHIFT_SCAN_MODE=separate.
  job(SCAN_QUEUES.shifts, 'shift-monitor', 'shift monitor', envSeconds('WORKER_SHIFT_MONITOR_INTERVAL_SECONDS'), 'lastShiftMonitorAt', 'shiftMonitorFailures', false, { shiftScanMode: 'separate' }),
  job(SCAN_QUEUES.shifts, 'attendance-monitor', 'attendance monitor', envSeconds('WORKER_ATTENDANCE_MONITOR_INTERVAL_SECONDS'), 'lastAttendanceMonitorAt', 'attendanceMonitorFailures', false, { shiftScanMode: 'separate' }),
  job(SCAN_QUEUES.shifts, 'late-clock-in', 'late clock-in', envSeconds('WORKER_LATE_CLOCK_IN_INTERVAL_SECONDS'), 'lastLateClockInAt', 'lateClockInFailures'),
  job(SCAN_QUEUES.shifts, 'shift-cancellation-followup', 'shift cancellation follow-up', envSeconds('WORKER_SHIFT_CANCELLATION_FOLLOWUP_INTERVAL_SECONDS'), 'lastShiftCancellationFollowupAt', 'shiftCancellationFollowupFailures'),
  job(SCAN_QUEUES.offers, 'offer-expiry', 'offer expiry', envSeconds('WORKER_OFFER_EXPIRY_INTERVAL_SECONDS'), 'lastOfferExpiryAt', 'offerExpiryFailures'),
  job(SCAN_QUEUES.offers, 'manager-confirmation-timeout', 'manager confirmation timeout', envSeconds('WORKER_MANAGER_CONFIRMATION_TIMEOUT_INTERVAL_SECONDS'), 'lastManagerConfirmationTimeoutAt', 'managerConfirmationTimeoutFailures'),
  job(SCAN_QUEUES.offers, 'replacement-staff', 'replacement staff', envSeconds('WORKER_REPLACEMENT_STAFF_INTERVAL_SECONDS'), 'lastReplacementStaffAt', 'replacementStaffFailures'),
  // Phase D (D3): the daily housekeeping scans first run one interval after start (interval mode: timed from the persisted
  // lastRunAt stamp, so frequent deploys never starve them — see registerIntervalScans / firstRunDelayFromStamp).
  job(SCAN_QUEUES.maintenance, 'token-cleanup', 'token cleanup', envSeconds('WORKER_TOKEN_CLEANUP_INTERVAL_SECONDS'), 'lastTokenCleanupAt', 'tokenCleanupFailures', false, { firstRunAfterInterval: true }),
  job(
    SCAN_QUEUES.maintenance,
    'login-handoff-cleanup',
    'login handoff cleanup',
    { kind: 'env-minutes', key: 'LOGIN_HANDOFF_CLEANUP_INTERVAL_MINUTES' },
    'lastLoginHandoffCleanupAt',
    'loginHandoffCleanupFailures',
    true,
    { enabledBy: 'LOGIN_HANDOFF_CLEANUP_ENABLED' },
  ),
  // Phase A pa-storage: returns false when it skips (recent run cluster-wide, or another replica holds the reconcile lock).
  job(SCAN_QUEUES.maintenance, 'storage-cleanup', 'storage cleanup', envSeconds('WORKER_STORAGE_CLEANUP_INTERVAL_SECONDS'), 'lastStorageCleanupAt', 'storageCleanupFailures', true, { firstRunAfterInterval: true }),
  job(SCAN_QUEUES.reports, 'shift-report-scheduler', 'shift report scheduler', envSeconds('WORKER_SHIFT_REPORT_SCHEDULER_INTERVAL_SECONDS'), 'lastShiftReportSchedulerAt', 'shiftReportSchedulerFailures', false, { shiftScanMode: 'separate' }),
  job(SCAN_QUEUES.reports, 'final-timesheet', 'final timesheet', envSeconds('WORKER_FINAL_TIMESHEET_INTERVAL_SECONDS'), 'lastFinalTimesheetAt', 'finalTimesheetFailures', false, { shiftScanMode: 'separate' }),
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
    { enabledBy: 'OUTBOX_RETENTION_ENABLED' },
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
    { enabledBy: 'AI_RETENTION_MODE' },
  ),
  // Phase B P8 (E6 gates 10/14, owner decision C): READ-ONLY daily stuck-workspace alert on the runtime connection — counts
  // only through core.worker_workspace_provisioning_health() (ProvisioningHealth1786721220000); Sentry warning + warn line
  // when either count is above zero. Never retries or provisions. queues/rab-maintenance/workspace-provisioning-health.job.ts.
  job(
    SCAN_QUEUES.maintenance,
    'workspace-provisioning-health',
    'workspace provisioning health',
    { kind: 'constant', ms: 24 * 60 * MINUTE },
    'lastWorkspaceProvisioningHealthAt',
    'workspaceProvisioningHealthFailures',
    false,
    { firstRunAfterInterval: true },
  ),
  // Phase D-Q2: AI stale-queued-turn sweep (queues/rab-ai/ai.processors.ts). OFF by default (AI_STALE_TURN_SWEEP=false ⇒
  // not registered); finalises turns whose BullMQ job was lost as failed AI_WORKER_INTERRUPTED, never requeues.
  job(
    SCAN_QUEUES.maintenance,
    'ai-stale-turn-sweep',
    'ai stale turn sweep',
    { kind: 'env-minutes', key: 'AI_STALE_TURN_SWEEP_INTERVAL_MINUTES' },
    'lastAiStaleTurnSweepAt',
    'aiStaleTurnSweepFailures',
    true,
    { enabledBy: 'AI_STALE_TURN_SWEEP' },
  ),
  // Phase D-Q4a (owner approval 2026-11-04, OD-1): the combined shift scan (queues/rab-shifts/shift-scan-combined.job.ts).
  // Registered only with WORKER_SHIFT_SCAN_MODE=combined, instead of its four members (COMBINED_SHIFT_SCAN_MEMBERS). One
  // workspace walk per tick; each due member keeps its own discovery SQL, interval, processing and Health keys. Returns
  // false (idle, not stamped) on a tick where no member was due or every due member was still running.
  job(SCAN_QUEUES.shifts, 'shift-scan-combined', 'shift scan (combined)', { kind: 'combined-shift-scan' }, 'lastShiftScanCombinedAt', 'shiftScanCombinedFailures', true, {
    shiftScanMode: 'combined',
  }),
]);

/**
 * Phase D-Q4a: the combined scan's members, in registration order (OD-1: the four 300-s scans only; late clock-in stays
 * its own 120-s scan). Their interval keys are COMBINED_SHIFT_SCAN_MEMBER_KEYS (worker-scan-intervals.ts).
 */
export const COMBINED_SHIFT_SCAN_MEMBERS = Object.freeze(['shift-monitor', 'attendance-monitor', 'shift-report-scheduler', 'final-timesheet'] as const);
export type CombinedShiftScanMember = (typeof COMBINED_SHIFT_SCAN_MEMBERS)[number];

/** The member definitions, from SCAN_JOBS (a missing one is a programming error: fail closed). */
export function combinedShiftScanMemberDefs(jobs: readonly ScanJobDefinition[] = SCAN_JOBS): ScanJobDefinition[] {
  return COMBINED_SHIFT_SCAN_MEMBERS.map((jobName) => {
    const def = jobs.find((d) => d.jobName === jobName);
    if (!def) throw new Error(`combined shift scan member ${jobName} is not in SCAN_JOBS`);
    return def;
  });
}

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
  } else if (source.kind === 'combined-shift-scan') {
    // The greatest common divisor of the members' own (validated) intervals. The 30-s floor is enforced where the mode is
    // known (env.validation.ts; main.ts via assertCombinedShiftScanTick): in separate mode this scan is never registered,
    // so a degenerate common tick there must not refuse a boot that is valid today.
    ms = combinedShiftScanTickSeconds(combinedShiftScanMemberDefs().map((member) => resolveIntervalMs(member, env) / 1000)) * 1000;
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
export type IntervalSourceEnvKey = Extract<IntervalSource, { key: string }>['key'];

/**
 * Registration predicate: true unless the scan names a switch that is off. Boolean switches must be exactly `true`;
 * AI_RETENTION_MODE must be exactly `report` or `purge`. Anything else — false, missing, malformed — means NOT
 * registered (fail closed).
 */
export function isScanJobEnabled(
  def: Pick<ScanJobDefinition, 'enabledBy' | 'shiftScanMode'>,
  env: { get(key: ScanEnableKey | 'WORKER_SHIFT_SCAN_MODE'): unknown },
): boolean {
  // Phase D-Q4a: exactly one shape of the shift-family scans is registered. Only the exact value `combined` selects the
  // combined scan; anything else keeps today's four separate scans (main.ts refuses to boot on a value that is neither).
  if (def.shiftScanMode !== undefined && shiftScanModeOf(env.get('WORKER_SHIFT_SCAN_MODE')) !== def.shiftScanMode) return false;
  if (def.enabledBy === undefined) return true;
  const value = env.get(def.enabledBy);
  if (def.enabledBy === 'AI_RETENTION_MODE') return value === 'report' || value === 'purge';
  return value === true;
}

/** Registration reading of WORKER_SHIFT_SCAN_MODE: `combined` only for the exact value, otherwise today's `separate`. */
const shiftScanModeOf = (value: unknown): ShiftScanMode => (value === 'combined' ? 'combined' : 'separate');

export class ShiftScanModeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShiftScanModeError';
  }
}

/**
 * Phase D-Q4a boot check (main.ts, fail closed, defence in depth behind env.validation.ts): WORKER_SHIFT_SCAN_MODE must be
 * exactly `separate` or `combined` (unset or empty means `separate`, like every optional env key).
 */
export function resolveShiftScanMode(env: { get(key: 'WORKER_SHIFT_SCAN_MODE'): unknown }): ShiftScanMode {
  const raw = env.get('WORKER_SHIFT_SCAN_MODE');
  if (raw === undefined || raw === null || raw === '') return 'separate';
  if (raw === 'separate' || raw === 'combined') return raw;
  throw new ShiftScanModeError('WORKER_SHIFT_SCAN_MODE must be exactly separate or combined');
}

/** Combined mode only: the combined tick must be a whole number of ms and at least 30 s (fail closed). */
export function assertCombinedShiftScanTick(tickMs: number): void {
  if (!Number.isInteger(tickMs) || tickMs < COMBINED_SHIFT_SCAN_MIN_TICK_SECONDS * 1000) {
    throw new ShiftScanModeError(
      `WORKER_SHIFT_SCAN_MODE=combined needs a common tick of at least ${COMBINED_SHIFT_SCAN_MIN_TICK_SECONDS} s across the member intervals (got ${tickMs / 1000} s)`,
    );
  }
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
