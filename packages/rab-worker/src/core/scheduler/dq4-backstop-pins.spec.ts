import { WORKER_SCAN_INTERVAL_SETTINGS } from '@rab/server/engine/core-modules/environment/worker-scan-intervals';
import { QUEUE_SETTINGS, SCAN_QUEUES } from './queue-registry';
import { isScanJobEnabled, resolveIntervalMs, SCAN_JOBS } from './scan-jobs';

/**
 * D-Q4 test preparation (docs/PHASE_DQ4_DQ5_PLAN_2026-11-03.md §D-Q4). CHARACTERISATION ONLY: these tests pin today's
 * behaviour that D-Q4 must not change. They pass on the D-Q1 head (09b545c4) and must keep passing after every D-Q4 PR
 * with its flags at their defaults.
 *
 * Owner rule (docs/PHASE_DQ_BULLMQ_FIRST_PLAN.md §12.1 decision 5, §14.2 "Timed transitions"): the backstop scan
 * intervals, deadlines and state transitions stay unchanged even when delayed-job triggers are added. A combined shift
 * scan (D-Q4a) may change HOW the scans are walked, never how often each check runs.
 *
 * Pending specs for code that does not exist yet are `it.todo` (they name the PROPOSED flag / module) — they are never
 * counted as passing.
 */

/** The D-Q4 scope: every scan whose cadence is a backstop for a timed transition or that the combined scan would fold in. */
const BACKSTOP_INTERVALS: ReadonlyArray<[jobName: string, envKey: keyof typeof WORKER_SCAN_INTERVAL_SETTINGS, defaultSeconds: number, min: number, max: number]> = [
  ['offer-expiry', 'WORKER_OFFER_EXPIRY_INTERVAL_SECONDS', 60, 10, 300],
  ['manager-confirmation-timeout', 'WORKER_MANAGER_CONFIRMATION_TIMEOUT_INTERVAL_SECONDS', 60, 10, 300],
  ['late-clock-in', 'WORKER_LATE_CLOCK_IN_INTERVAL_SECONDS', 120, 30, 600],
  ['shift-monitor', 'WORKER_SHIFT_MONITOR_INTERVAL_SECONDS', 300, 30, 600],
  ['attendance-monitor', 'WORKER_ATTENDANCE_MONITOR_INTERVAL_SECONDS', 300, 30, 900],
  ['shift-report-scheduler', 'WORKER_SHIFT_REPORT_SCHEDULER_INTERVAL_SECONDS', 300, 60, 900],
  ['final-timesheet', 'WORKER_FINAL_TIMESHEET_INTERVAL_SECONDS', 300, 60, 900],
  ['replacement-staff', 'WORKER_REPLACEMENT_STAFF_INTERVAL_SECONDS', 120, 30, 600],
  ['shift-cancellation-followup', 'WORKER_SHIFT_CANCELLATION_FOLLOWUP_INTERVAL_SECONDS', 60, 10, 300],
];

describe('D-Q4 characterisation: backstop scan intervals are unchanged (owner rule §12.1/5, §14.2)', () => {
  it.each(BACKSTOP_INTERVALS)('%s: default %s = %ss, bounds unchanged', (jobName, envKey, defaultSeconds, min, max) => {
    const setting = WORKER_SCAN_INTERVAL_SETTINGS[envKey];
    expect(setting).toEqual({ jobName, defaultSeconds, minSeconds: min, maxSeconds: max });
    const def = SCAN_JOBS.find((j) => j.jobName === jobName);
    expect(def).toBeDefined();
    expect(def!.interval).toEqual({ kind: 'env-seconds', key: envKey });
    // None of these is behind an enable switch. D-Q4a: the four combined members are scheduled separately only in
    // WORKER_SHIFT_SCAN_MODE=separate (default); in combined mode the combined scan runs them at this same interval.
    expect(def!.enabledBy).toBeUndefined();
    expect(def!.firstRunAfterInterval).toBeFalsy();
  });
});

describe('D-Q4a characterisation: the five shift-family scans are separate scans today', () => {
  const members = ['shift-monitor', 'attendance-monitor', 'late-clock-in', 'shift-report-scheduler', 'final-timesheet'];

  it('each member is its own scan, on today\'s queue, with its own stats keys', () => {
    const byName = new Map(SCAN_JOBS.map((j) => [j.jobName, j]));
    expect(byName.get('shift-monitor')!.queue).toBe(SCAN_QUEUES.shifts);
    expect(byName.get('attendance-monitor')!.queue).toBe(SCAN_QUEUES.shifts);
    expect(byName.get('late-clock-in')!.queue).toBe(SCAN_QUEUES.shifts);
    expect(byName.get('shift-report-scheduler')!.queue).toBe(SCAN_QUEUES.reports);
    expect(byName.get('final-timesheet')!.queue).toBe(SCAN_QUEUES.reports);
    // The Health contract keys a combined scan must keep writing per member (D-Q4 plan: metrics continuity).
    expect(members.map((m) => byName.get(m)!.statKeys)).toEqual([
      { lastRunAt: 'lastShiftMonitorAt', failures: 'shiftMonitorFailures', skipped: 'shiftMonitorSkipped' },
      { lastRunAt: 'lastAttendanceMonitorAt', failures: 'attendanceMonitorFailures', skipped: 'attendanceMonitorSkipped' },
      { lastRunAt: 'lastLateClockInAt', failures: 'lateClockInFailures', skipped: 'lateClockInSkipped' },
      { lastRunAt: 'lastShiftReportSchedulerAt', failures: 'shiftReportSchedulerFailures', skipped: 'shiftReportSchedulerSkipped' },
      { lastRunAt: 'lastFinalTimesheetAt', failures: 'finalTimesheetFailures', skipped: 'finalTimesheetSkipped' },
    ]);
  });

  it('D-Q4a: the combined scan exists but is NOT scheduled by default (separate); no timer-trigger queue (D-Q4b) yet', () => {
    const defaults = { get: () => undefined } as never;
    expect(SCAN_JOBS.filter((j) => /combined|timer-trigger/i.test(j.jobName)).map((j) => j.jobName)).toEqual(['shift-scan-combined']);
    expect(SCAN_JOBS.filter((j) => /combined/.test(j.jobName) && isScanJobEnabled(j, defaults))).toEqual([]);
    expect(members.every((m) => isScanJobEnabled(SCAN_JOBS.find((j) => j.jobName === m)!, defaults))).toBe(true);
    expect(Object.keys(QUEUE_SETTINGS).filter((q) => /timer|trigger/i.test(q))).toEqual([]);
  });

  it('scan queue concurrency equals the number of scans on that queue (D-Q4d baseline)', () => {
    for (const queue of [SCAN_QUEUES.shifts, SCAN_QUEUES.offers, SCAN_QUEUES.reports]) {
      const scans = SCAN_JOBS.filter((j) => j.queue === queue).map((j) => j.jobName);
      expect(QUEUE_SETTINGS[queue].worker.concurrency).toBe(scans.length);
      expect([...QUEUE_SETTINGS[queue].jobNames].sort()).toEqual([...scans].sort());
    }
  });

  it('D-Q4d baseline: consumer queue concurrency and stall settings', () => {
    const pick = (q: keyof typeof QUEUE_SETTINGS) => ({ c: QUEUE_SETTINGS[q].worker.concurrency, lock: QUEUE_SETTINGS[q].worker.lockDurationMs, stalls: QUEUE_SETTINGS[q].worker.maxStalledCount });
    expect(pick('rab-email')).toEqual({ c: 5, lock: 30_000, stalls: 1 });
    expect(pick('rab-push')).toEqual({ c: 10, lock: 30_000, stalls: 1 });
    expect(pick('rab-shift-statements')).toEqual({ c: 2, lock: 30_000, stalls: 1 });
    expect(pick('rab-ai')).toEqual({ c: 4, lock: 60_000, stalls: 1 });
  });

  // D-Q4a (implemented): flag default/strictness → rab-server env.validation.worker-shift-scan-mode.spec.ts; own interval,
  // own stats keys, per-member overlap guard → queues/rab-shifts/shift-scan-combined.spec.ts; SAVEPOINT per member →
  // core/database/workspace-discovery.members.spec.ts and (real PostgreSQL) dq4-shift-scan-equivalence.integration.spec.ts.
  it('D-Q4a: in combined mode the members keep their own intervals and the combined tick divides every one of them', () => {
    const seconds: Record<string, number> = { WORKER_SHIFT_MONITOR_INTERVAL_SECONDS: 60, WORKER_ATTENDANCE_MONITOR_INTERVAL_SECONDS: 120, WORKER_SHIFT_REPORT_SCHEDULER_INTERVAL_SECONDS: 180, WORKER_FINAL_TIMESHEET_INTERVAL_SECONDS: 900 };
    const env = { get: (k: string) => seconds[k] } as never;
    const tick = resolveIntervalMs(SCAN_JOBS.find((j) => j.jobName === 'shift-scan-combined')!, env);
    expect(tick).toBe(60_000);
    for (const m of ['shift-monitor', 'attendance-monitor', 'shift-report-scheduler', 'final-timesheet']) {
      const own = resolveIntervalMs(SCAN_JOBS.find((j) => j.jobName === m)!, env);
      expect(own % tick).toBe(0);
    }
  });
  it.todo('PROPOSED D-Q4b: WORKER_TIMER_TRIGGERS defaults to `off`; any value other than off|shadow|on refuses to boot');
  it.todo('PROPOSED D-Q4b: the timer-trigger queue is in the registry with an organisation scope, ids-only payload keys and explicit options');
});
