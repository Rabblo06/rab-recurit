import { validate } from '@rab/server/engine/core-modules/environment/env.validation';
import { CONSUMER_QUEUES, LEGACY_BULL_PREFIX, resolveScanPrefix, SCAN_JOB_DATA, SCAN_JOB_OPTIONS, SCAN_QUEUE_NAMES } from './queue-registry';
import { BULLMQ_DEFAULT_LOCK_DURATION_MS, lockDurationMsFor, resolveIntervalMs, SCAN_JOBS, scanJobsOn, schedulerIdOf } from './scan-jobs';

/**
 * Registry completeness + verbatim parity with the pre-migration main.ts (a743806f, lines 286–584). The expected table
 * below was transcribed from that main.ts by hand — if a cadence or a stats key ever changes, this fails.
 */
const MIN = 60_000;
const PRE_MIGRATION_MAIN_TS: Array<[string, number | string, string, string]> = [
  ['account-invite cleanup', 15 * MIN, 'lastAccountInviteCleanupAt', 'accountInviteCleanupFailures'],
  ['email dispatch', 2_000, 'lastEmailDispatchAt', 'emailDispatchFailures'],
  ['push dispatch', 2_000, 'lastPushDispatchAt', 'pushDispatchFailures'],
  ['shift monitor', 5 * MIN, 'lastShiftMonitorAt', 'shiftMonitorFailures'],
  ['attendance monitor', 5 * MIN, 'lastAttendanceMonitorAt', 'attendanceMonitorFailures'],
  ['late clock-in', 2 * MIN, 'lastLateClockInAt', 'lateClockInFailures'],
  ['shift cancellation follow-up', MIN, 'lastShiftCancellationFollowupAt', 'shiftCancellationFollowupFailures'],
  ['offer expiry', MIN, 'lastOfferExpiryAt', 'offerExpiryFailures'],
  ['manager confirmation timeout', MIN, 'lastManagerConfirmationTimeoutAt', 'managerConfirmationTimeoutFailures'],
  ['replacement staff', 2 * MIN, 'lastReplacementStaffAt', 'replacementStaffFailures'],
  ['token cleanup', 24 * 60 * MIN, 'lastTokenCleanupAt', 'tokenCleanupFailures'],
  ['login handoff cleanup', 'LOGIN_HANDOFF_CLEANUP_INTERVAL_MINUTES', 'lastLoginHandoffCleanupAt', 'loginHandoffCleanupFailures'],
  ['storage cleanup', 24 * 60 * MIN, 'lastStorageCleanupAt', 'storageCleanupFailures'],
  ['shift report scheduler', 5 * MIN, 'lastShiftReportSchedulerAt', 'shiftReportSchedulerFailures'],
  ['final timesheet', 5 * MIN, 'lastFinalTimesheetAt', 'finalTimesheetFailures'],
  ['shift statement dispatch', 5_000, 'lastShiftStatementDispatchAt', 'shiftStatementDispatchFailures'],
  ['payroll period attention', 30 * MIN, 'lastPayrollPeriodAttentionAt', 'payrollPeriodAttentionFailures'],
  ['realtime outbox publish', 2_000, 'lastRealtimeOutboxPublishAt', 'realtimeOutboxPublishFailures'],
  ['outbox retention', 'OUTBOX_RETENTION_INTERVAL_MINUTES', 'lastOutboxRetentionAt', 'outboxRetentionFailures'],
  // AI Phase 1 (not a pre-migration loop): AI conversation retention, appended last.
  ['ai retention', 'AI_RETENTION_INTERVAL_MINUTES', 'lastAiRetentionAt', 'aiRetentionFailures'],
];

describe('scan job registry (BullMQ migration M2/M4)', () => {
  // Phase A pa-intervals: the REAL validated environment with nothing set — every interval must resolve to exactly the
  // pre-migration cadence below (the defaults-unchanged proof). Minimal base = the keys validate() requires.
  const validated = validate({ DATABASE_URL: 'postgres://rab:rab@localhost:5432/rab', REDIS_URL: 'redis://localhost:6379', APP_SECRET: 'a'.repeat(32) });
  const env = { get: (k: string) => (validated as unknown as Record<string, number>)[k]! };

  it('has exactly the 19 jobs-process loops, in main.ts order, plus the AI retention scan, with the same names, intervals and stats keys', () => {
    expect(SCAN_JOBS).toHaveLength(21);
    SCAN_JOBS.slice(0, PRE_MIGRATION_MAIN_TS.length).forEach((def, i) => {
      const [name, interval, lastRunAt, failures] = PRE_MIGRATION_MAIN_TS[i]!;
      expect(def.name).toBe(name);
      expect(def.statKeys.lastRunAt).toBe(lastRunAt);
      expect(def.statKeys.failures).toBe(failures);
      expect(def.statKeys.skipped).toBe(failures.replace(/Failures$/, 'Skipped'));
      // Phase A: the 17 former constants are now env-seconds settings whose UNSET value resolves to the same cadence.
      if (typeof interval === 'number') {
        expect(def.interval.kind).toBe('env-seconds');
        expect(resolveIntervalMs(def, env)).toBe(interval);
      } else expect(def.interval).toEqual({ kind: 'env-minutes', key: interval });
    });
    expect(resolveIntervalMs(SCAN_JOBS[11]!, env)).toBe(15 * MIN);
    expect(resolveIntervalMs(SCAN_JOBS[18]!, env)).toBe(60 * MIN);
    expect(resolveIntervalMs(SCAN_JOBS[19]!, env)).toBe(60 * MIN);
  });

  it('Phase B P8 (owner decision C): ONE provisioning scan is appended last — the counts-only health alert, constant 24 h', () => {
    expect(SCAN_JOBS.slice(20).map((d) => [d.jobName, d.queue, d.interval, d.statKeys.lastRunAt, d.statKeys.failures, d.mayReturnFalse])).toEqual([
      ['workspace-provisioning-health', 'crewflow-scan-maintenance', { kind: 'constant', ms: 24 * 60 * MIN }, 'lastWorkspaceProvisioningHealthAt', 'workspaceProvisioningHealthFailures', false],
    ]);
    expect(resolveIntervalMs(SCAN_JOBS[20]!, env)).toBe(86_400_000);
    // The runtime drift scan is deferred (HWS prerequisite): not registered.
    expect(SCAN_JOBS.some((d) => /drift-runtime/.test(d.jobName))).toBe(false);
  });

  it('the eight `return false` cycles are flagged (dispatchers, login-handoff and storage cleanup, outbox and AI retention)', () => {
    expect(SCAN_JOBS.filter((d) => d.mayReturnFalse).map((d) => d.jobName)).toEqual([
      'email-dispatch', 'push-dispatch', 'login-handoff-cleanup', 'storage-cleanup', 'shift-statement-dispatch', 'realtime-outbox-publish', 'outbox-retention', 'ai-retention',
    ]);
  });

  it('scheduler ids are unique and `crewflow:<queue>:<jobName>`; job names unique per queue', () => {
    const ids = SCAN_JOBS.map(schedulerIdOf);
    expect(new Set(ids).size).toBe(21);
    for (const def of SCAN_JOBS) expect(schedulerIdOf(def)).toBe(`crewflow:${def.queue}:${def.jobName}`);
    expect(schedulerIdOf(SCAN_JOBS[1]!)).toBe('crewflow:crewflow-scan-email:email-dispatch');
    // Each queue's Worker concurrency = its number of distinct scans.
    expect(SCAN_QUEUE_NAMES.map((q) => [q, scanJobsOn(q).length])).toEqual([
      ['crewflow-scan-email', 1], ['crewflow-scan-push', 1], ['crewflow-scan-shifts', 4], ['crewflow-scan-offers', 3],
      ['crewflow-scan-reports', 4], ['crewflow-scan-maintenance', 7], ['crewflow-scan-realtime', 1],
    ]);
  });

  it('consumer queues keep the legacy `bull` prefix, their names and concurrency 5 / 10 / 2 (+ AI Phase 1 rab-ai, 4)', () => {
    expect(Object.values(CONSUMER_QUEUES).map((q) => [q.name, q.jobName, q.prefix, q.concurrency])).toEqual([
      ['rab-email', 'send-email', LEGACY_BULL_PREFIX, 5],
      ['rab-push', 'send-push', LEGACY_BULL_PREFIX, 10],
      ['rab-shift-statements', 'generate-shift-statement', LEGACY_BULL_PREFIX, 2],
      ['rab-ai', 'ai-turn', LEGACY_BULL_PREFIX, 4],
    ]);
    // No scan queue reuses a consumer queue name.
    for (const q of SCAN_QUEUE_NAMES) expect(Object.values(CONSUMER_QUEUES).map((c) => c.name)).not.toContain(q);
  });

  it('the scan prefix is env-specific by default and can never be the legacy `bull` namespace', () => {
    expect(resolveScanPrefix('development', undefined)).toBe('crewflow:development:bull');
    expect(resolveScanPrefix('production', '')).toBe('crewflow:production:bull');
    expect(resolveScanPrefix('test', 'crewflow:qa:bull')).toBe('crewflow:qa:bull');
    expect(() => resolveScanPrefix('test', 'bull')).toThrow(/legacy/);
    expect(() => resolveScanPrefix('test', 'bull:x')).toThrow(/legacy/);
  });

  it('scan job options: attempts 1, removeOnComplete {age 3600, count 1000}, removeOnFail {age 604800}; payload is metadata only', () => {
    expect(SCAN_JOB_OPTIONS).toEqual({ attempts: 1, removeOnComplete: { age: 3600, count: 1000 }, removeOnFail: { age: 604800 } });
    expect(SCAN_JOB_DATA).toEqual({ v: 1 });
  });

  it('lock duration = max(BullMQ default 30 s, measured p99 × 3); unmeasured → the default', () => {
    expect(BULLMQ_DEFAULT_LOCK_DURATION_MS).toBe(30_000);
    expect(lockDurationMsFor('crewflow-scan-email', { 'crewflow-scan-email': null })).toBe(30_000);
    expect(lockDurationMsFor('crewflow-scan-reports', { 'crewflow-scan-reports': 25_000 })).toBe(75_000);
    expect(lockDurationMsFor('crewflow-scan-shifts', { 'crewflow-scan-shifts': 40 })).toBe(30_000);
    for (const q of SCAN_QUEUE_NAMES) expect(lockDurationMsFor(q)).toBeGreaterThanOrEqual(30_000);
  });
});
