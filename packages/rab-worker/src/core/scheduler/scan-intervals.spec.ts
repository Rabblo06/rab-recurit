import { validate } from '@rab/server/engine/core-modules/environment/env.validation';
import { WORKER_SCAN_INTERVAL_KEYS, WORKER_SCAN_INTERVAL_SETTINGS } from '@rab/server/engine/core-modules/environment/worker-scan-intervals';
import { WorkerLoopOptions, WorkerRuntime } from '../runtime/worker-runtime';
import { loopOptionsOf, registerIntervalScans } from './bullmq-scheduler';
import { isScanJobEnabled, resolveIntervalMs, SCAN_JOBS, ScanJobDefinition } from './scan-jobs';

/**
 * Phase A pa-intervals — configurable scan intervals, the push/realtime enable predicate and interval-mode registration.
 * The defaults-unchanged proof against the hand-transcribed pre-migration table lives in scan-jobs.spec.ts; this file
 * covers the new surface: the key↔scan mapping, bounds (fail closed), the predicate and exactly-once registration.
 */
const base = { DATABASE_URL: 'postgres://rab:rab@localhost:5432/rab', REDIS_URL: 'redis://localhost:6379', APP_SECRET: 'a'.repeat(32) };
const envOf = (overrides: Record<string, string> = {}) => {
  const validated = validate({ ...base, ...overrides }) as unknown as Record<string, unknown>;
  return { get: (k: string) => validated[k] as never };
};
const byJob = (jobName: string) => SCAN_JOBS.find((d) => d.jobName === jobName)!;

// Independently written (seconds) — NOT read from the settings table: the historical constants.
const HISTORICAL_SECONDS: Record<string, number> = {
  'account-invite-cleanup': 900, 'email-dispatch': 2, 'push-dispatch': 2, 'shift-monitor': 300, 'attendance-monitor': 300,
  'late-clock-in': 120, 'shift-cancellation-followup': 60, 'offer-expiry': 60, 'manager-confirmation-timeout': 60,
  'replacement-staff': 120, 'token-cleanup': 86_400, 'storage-cleanup': 86_400, 'shift-report-scheduler': 300,
  'final-timesheet': 300, 'shift-statement-dispatch': 5, 'payroll-period-attention': 1_800, 'realtime-outbox-publish': 2,
};

describe('Phase A scan interval settings', () => {
  it('maps the 17 former constants one-to-one onto WORKER_<JOB>_INTERVAL_SECONDS keys; the 3 minutes keys are unchanged', () => {
    const secondsDefs = SCAN_JOBS.filter((d) => d.interval.kind === 'env-seconds');
    expect(secondsDefs).toHaveLength(17);
    expect(SCAN_JOBS.filter((d) => d.interval.kind === 'constant')).toEqual([]);
    const keys = secondsDefs.map((d) => (d.interval as { key: string }).key);
    expect(new Set(keys).size).toBe(17);
    expect([...keys].sort()).toEqual([...WORKER_SCAN_INTERVAL_KEYS].sort());
    for (const def of secondsDefs) {
      const key = (def.interval as { key: keyof typeof WORKER_SCAN_INTERVAL_SETTINGS }).key;
      expect(WORKER_SCAN_INTERVAL_SETTINGS[key].jobName).toBe(def.jobName);
      expect(key).toBe(`WORKER_${def.jobName.toUpperCase().replace(/-/g, '_')}_INTERVAL_SECONDS`);
    }
    expect(SCAN_JOBS.filter((d) => d.interval.kind === 'env-minutes').map((d) => [d.jobName, d.interval])).toEqual([
      ['login-handoff-cleanup', { kind: 'env-minutes', key: 'LOGIN_HANDOFF_CLEANUP_INTERVAL_MINUTES' }],
      ['outbox-retention', { kind: 'env-minutes', key: 'OUTBOX_RETENTION_INTERVAL_MINUTES' }],
      ['ai-retention', { kind: 'env-minutes', key: 'AI_RETENTION_INTERVAL_MINUTES' }],
    ]);
  });

  it('with NO environment set, every resolved interval equals the historical cadence (and the 3 minutes keys 15/60/60 min)', () => {
    const env = envOf();
    for (const def of SCAN_JOBS) {
      const expected =
        def.interval.kind === 'env-seconds' ? HISTORICAL_SECONDS[def.jobName]! * 1000 : { 'login-handoff-cleanup': 15, 'outbox-retention': 60, 'ai-retention': 60 }[def.jobName]! * 60_000;
      expect([def.jobName, resolveIntervalMs(def, env)]).toEqual([def.jobName, expected]);
    }
    // Each table default is inside its own bounds.
    for (const s of Object.values(WORKER_SCAN_INTERVAL_SETTINGS)) {
      expect(s.defaultSeconds).toBeGreaterThanOrEqual(s.minSeconds);
      expect(s.defaultSeconds).toBeLessThanOrEqual(s.maxSeconds);
    }
  });

  it('owner-assumption bounds: business-timing scans cannot be slowed past their cap; retention sweeps never slower than 24 h', () => {
    const cap = (k: keyof typeof WORKER_SCAN_INTERVAL_SETTINGS) => WORKER_SCAN_INTERVAL_SETTINGS[k].maxSeconds;
    expect(cap('WORKER_OFFER_EXPIRY_INTERVAL_SECONDS')).toBe(300);
    expect(cap('WORKER_MANAGER_CONFIRMATION_TIMEOUT_INTERVAL_SECONDS')).toBe(300);
    expect(cap('WORKER_SHIFT_CANCELLATION_FOLLOWUP_INTERVAL_SECONDS')).toBe(300);
    expect(cap('WORKER_LATE_CLOCK_IN_INTERVAL_SECONDS')).toBe(600);
    expect(cap('WORKER_REPLACEMENT_STAFF_INTERVAL_SECONDS')).toBe(600);
    expect(cap('WORKER_SHIFT_MONITOR_INTERVAL_SECONDS')).toBe(600);
    expect(cap('WORKER_TOKEN_CLEANUP_INTERVAL_SECONDS')).toBe(86_400);
    expect(cap('WORKER_STORAGE_CLEANUP_INTERVAL_SECONDS')).toBe(86_400);
  });

  it('a valid override changes only that scan (bounds inclusive)', () => {
    const env = envOf({ WORKER_OFFER_EXPIRY_INTERVAL_SECONDS: '300', WORKER_EMAIL_DISPATCH_INTERVAL_SECONDS: '1' });
    expect(resolveIntervalMs(byJob('offer-expiry'), env)).toBe(300_000);
    expect(resolveIntervalMs(byJob('email-dispatch'), env)).toBe(1_000);
    expect(resolveIntervalMs(byJob('manager-confirmation-timeout'), env)).toBe(60_000);
  });

  it('resolveIntervalMs fails closed (defence in depth) on a missing, fractional or out-of-bounds value', () => {
    const def = byJob('offer-expiry');
    for (const bad of [undefined, NaN, 1.5, 9, 301, 0, -60, '60']) {
      expect(() => resolveIntervalMs(def, { get: () => bad as never })).toThrow(/offer expiry: invalid interval \(WORKER_OFFER_EXPIRY_INTERVAL_SECONDS must be an integer 10–300\)/);
    }
  });
});

describe('Phase A enable predicate (push-dispatch ⇐ PUSH_ENABLED, realtime-outbox-publish ⇐ REALTIME_ENABLED)', () => {
  it('only those two scans carry a predicate; no scan has firstRunAfterInterval on by default', () => {
    expect(SCAN_JOBS.filter((d) => d.enabledBy).map((d) => [d.jobName, d.enabledBy])).toEqual([
      ['push-dispatch', 'PUSH_ENABLED'],
      ['realtime-outbox-publish', 'REALTIME_ENABLED'],
    ]);
    expect(SCAN_JOBS.filter((d) => d.firstRunAfterInterval)).toEqual([]);
  });

  it('defaults (both switches false) disable exactly those two; "true" enables; anything not exactly true stays disabled', () => {
    const off = envOf();
    expect(SCAN_JOBS.filter((d) => !isScanJobEnabled(d, off)).map((d) => d.jobName)).toEqual(['push-dispatch', 'realtime-outbox-publish']);
    const on = envOf({ PUSH_ENABLED: 'true', PUSH_PROVIDER: 'FAKE', REALTIME_ENABLED: 'true' });
    expect(SCAN_JOBS.every((d) => isScanJobEnabled(d, on))).toBe(true);
    for (const value of ['true', 1, 'yes', undefined, null]) {
      expect(isScanJobEnabled(byJob('push-dispatch'), { get: () => value as never })).toBe(false);
    }
    expect(isScanJobEnabled(byJob('push-dispatch'), { get: () => true })).toBe(true);
    expect(isScanJobEnabled(byJob('offer-expiry'), { get: () => false })).toBe(true);
  });
});

describe('interval-mode registration (registerIntervalScans)', () => {
  const registry = { scan: (def: ScanJobDefinition) => async () => def.jobName !== '' };
  const fakeRuntime = () => {
    const calls: WorkerLoopOptions[] = [];
    return { calls, runtime: { every: (o: WorkerLoopOptions) => void calls.push(o) } };
  };

  it('defaults: the 18 enabled scans, in registry order, once each, with their resolved intervals; push/realtime absent', () => {
    const env = envOf();
    const { calls, runtime } = fakeRuntime();
    const result = registerIntervalScans(runtime, registry, SCAN_JOBS, (d) => resolveIntervalMs(d, env), (d) => isScanJobEnabled(d, env));
    expect(result.disabled).toEqual(['push-dispatch', 'realtime-outbox-publish']);
    const expected = SCAN_JOBS.filter((d) => !['push-dispatch', 'realtime-outbox-publish'].includes(d.jobName));
    expect(calls.map((c) => c.metricKey)).toEqual(expected.map((d) => d.jobName));
    expect(new Set(calls.map((c) => c.name)).size).toBe(18);
    calls.forEach((c, i) => expect(c.intervalMs).toBe(resolveIntervalMs(expected[i]!, env)));
    expect(calls.some((c) => c.firstRunAfterInterval)).toBe(false);
  });

  it('re-enabled (PUSH_ENABLED / REALTIME_ENABLED true): all 20, in the historical order', () => {
    const env = envOf({ PUSH_ENABLED: 'true', PUSH_PROVIDER: 'FAKE', REALTIME_ENABLED: 'true' });
    const { calls, runtime } = fakeRuntime();
    registerIntervalScans(runtime, registry, SCAN_JOBS, (d) => resolveIntervalMs(d, env), (d) => isScanJobEnabled(d, env));
    expect(calls.map((c) => c.metricKey)).toEqual(SCAN_JOBS.map((d) => d.jobName));
  });

  it('exactly once per runtime: a second registration is refused and adds no timer', () => {
    const env = envOf();
    const { calls, runtime } = fakeRuntime();
    registerIntervalScans(runtime, registry, SCAN_JOBS, (d) => resolveIntervalMs(d, env));
    const before = calls.length;
    expect(() => registerIntervalScans(runtime, registry, SCAN_JOBS, (d) => resolveIntervalMs(d, env))).toThrow(/already registered/);
    expect(calls).toHaveLength(before);
  });

  it('a duplicate scheduler id or an invalid interval is refused before ANY loop starts', () => {
    const env = envOf();
    const dup = fakeRuntime();
    expect(() => registerIntervalScans(dup.runtime, registry, [...SCAN_JOBS, SCAN_JOBS[0]!], (d) => resolveIntervalMs(d, env))).toThrow(/duplicate/);
    expect(dup.calls).toHaveLength(0);
    const bad = fakeRuntime();
    const broken = { get: (k: string) => (k === 'WORKER_STORAGE_CLEANUP_INTERVAL_SECONDS' ? 172_800 : env.get(k)) as never };
    expect(() => registerIntervalScans(bad.runtime, registry, SCAN_JOBS, (d) => resolveIntervalMs(d, broken))).toThrow(/storage cleanup: invalid interval/);
    expect(bad.calls).toHaveLength(0);
    // ...and the refused runtime was not marked registered, so a corrected boot path could still register once.
    registerIntervalScans(bad.runtime, registry, SCAN_JOBS, (d) => resolveIntervalMs(d, env));
    expect(bad.calls).toHaveLength(20);
  });

  it('loopOptionsOf carries firstRunAfterInterval only when the scan opts in (default shape unchanged)', () => {
    const handler = async () => true;
    expect(Object.keys(loopOptionsOf(SCAN_JOBS[0]!, handler, 1_000)).sort()).toEqual(['intervalMs', 'metricKey', 'name', 'run', 'statKeys']);
    expect(loopOptionsOf({ ...SCAN_JOBS[0]!, firstRunAfterInterval: true }, handler, 1_000).firstRunAfterInterval).toBe(true);
  });
});

describe('WorkerRuntime.every firstRunAfterInterval hook (generic, default off)', () => {
  const chain: Record<string, unknown> = {};
  for (const op of ['hset', 'hincrby', 'expire']) chain[op] = () => chain;
  chain.exec = async () => [];
  const redis = { hset: async () => 1, set: async () => 'OK', hgetall: async () => ({}), multi: () => chain } as never;
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('default: runs immediately, then every interval; opted in: first run only after one interval', async () => {
    const runtime = new WorkerRuntime(redis, { statsKey: 'phase-a:test:stats', metricsLogMs: 0 });
    const immediate = jest.fn().mockResolvedValue(false);
    const delayed = jest.fn().mockResolvedValue(false);
    runtime.every({ name: 'immediate', intervalMs: 10_000, statKeys: { lastRunAt: 'a', failures: 'aFailures' }, run: immediate });
    runtime.every({ name: 'delayed', intervalMs: 10_000, statKeys: { lastRunAt: 'b', failures: 'bFailures' }, run: delayed, firstRunAfterInterval: true });
    expect(immediate).toHaveBeenCalledTimes(1);
    expect(delayed).toHaveBeenCalledTimes(0);
    await jest.advanceTimersByTimeAsync(9_999);
    expect(delayed).toHaveBeenCalledTimes(0);
    await jest.advanceTimersByTimeAsync(1);
    expect(delayed).toHaveBeenCalledTimes(1);
    expect(immediate).toHaveBeenCalledTimes(2);
    runtime.beginShutdown();
  });
});
