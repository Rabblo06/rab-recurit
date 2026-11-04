import { WORKER_SCAN_INTERVAL_SETTINGS } from '@rab/server/engine/core-modules/environment/worker-scan-intervals';
import { QUEUE_SETTINGS, SCAN_QUEUES } from './queue-registry';
import { SCAN_JOBS } from './scan-jobs';

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
    // None of these is behind a registration switch: each is always scheduled, so each always backstops.
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

  it('no combined scan and no timer-trigger queue exists by default', () => {
    expect(SCAN_JOBS.filter((j) => /combined|timer-trigger/i.test(j.jobName))).toEqual([]);
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

  it.todo('PROPOSED D-Q4a: WORKER_SHIFT_SCAN_MODE defaults to `separate`; any value other than separate|combined refuses to boot');
  it.todo('PROPOSED D-Q4a: in combined mode each member still runs at its own configured interval (never less often than separate mode)');
  it.todo('PROPOSED D-Q4a: in combined mode each member keeps its own lastRunAt / failures / skipped stats keys');
  it.todo('PROPOSED D-Q4a: a member still running from the previous tick is skipped for that member only (per-member overlap guard)');
  it.todo('PROPOSED D-Q4a: a failing member query does not fail the other members of the same workspace walk (SAVEPOINT per member)');
  it.todo('PROPOSED D-Q4b: WORKER_TIMER_TRIGGERS defaults to `off`; any value other than off|shadow|on refuses to boot');
  it.todo('PROPOSED D-Q4b: the timer-trigger queue is in the registry with an organisation scope, ids-only payload keys and explicit options');
});
