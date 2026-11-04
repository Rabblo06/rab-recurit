import Redis from 'ioredis';

import { WORKER_SCAN_INTERVAL_SETTINGS } from '@rab/server/engine/core-modules/environment/worker-scan-intervals';
import { WORKER_STATS_KEY } from '@rab/server/engine/worker-shared/heartbeat.constants';
import { WalkMember, WalkResult } from '../../core/database/workspace-discovery';
import { WorkerRuntime } from '../../core/runtime/worker-runtime';
import { registerIntervalScans } from '../../core/scheduler/bullmq-scheduler';
import {
  assertCombinedShiftScanTick,
  COMBINED_SHIFT_SCAN_MEMBERS,
  combinedShiftScanMemberDefs,
  isScanJobEnabled,
  resolveIntervalMs,
  resolveShiftScanMode,
  SCAN_JOBS,
  ScanJobDefinition,
} from '../../core/scheduler/scan-jobs';
import { CombinedShiftScan, COMBINED_SHIFT_SCAN_JOB, withCombinedShiftScan } from './shift-scan-combined.job';
import { ShiftScanProcessor } from './shift.processors';

/**
 * Phase D-Q4a (owner approval 2026-11-04, OD-1): the combined shift scan behind WORKER_SHIFT_SCAN_MODE (default separate).
 * Unit level: registration per mode, the interval rule, due-gating at mixed intervals, the per-member overlap guard,
 * per-member Health keys, a failing member, a failing walk, Lane A member locks. Real PostgreSQL behaviour (SAVEPOINT,
 * RLS, equivalence with separate mode, two replicas) is in dq4-shift-scan-equivalence.integration.spec.ts.
 */
const SECONDS: Record<string, number> = {
  WORKER_SHIFT_MONITOR_INTERVAL_SECONDS: 300,
  WORKER_ATTENDANCE_MONITOR_INTERVAL_SECONDS: 300,
  WORKER_SHIFT_REPORT_SCHEDULER_INTERVAL_SECONDS: 300,
  WORKER_FINAL_TIMESHEET_INTERVAL_SECONDS: 300,
};
const envWith = (over: Record<string, unknown> = {}) => {
  const values: Record<string, unknown> = { ...SECONDS, ...over };
  return {
    get: (key: string) => {
      if (key in values) return values[key];
      const setting = (WORKER_SCAN_INTERVAL_SETTINGS as Record<string, { defaultSeconds: number }>)[key];
      if (setting) return setting.defaultSeconds; // every other seconds key at its default
      if (key.endsWith('_MINUTES')) return 60;
      return undefined;
    },
  } as never;
};
const byJob = (jobName: string) => SCAN_JOBS.find((d) => d.jobName === jobName)!;
const combinedDef = byJob(COMBINED_SHIFT_SCAN_JOB);

function fakeRedis() {
  const hashes = new Map<string, Record<string, string>>();
  const hset = (key: string, a: Record<string, string | number> | string, b?: string | number) => {
    const obj = typeof a === 'string' ? { [a]: b! } : a;
    const h = hashes.get(key) ?? {};
    for (const [k, v] of Object.entries(obj)) h[k] = String(v);
    hashes.set(key, h);
  };
  const redis = {
    hset: async (key: string, obj: Record<string, string | number>) => hset(key, obj),
    multi: () => {
      const ops: Array<() => void> = [];
      const chain = {
        hset: (key: string, a: Record<string, string | number> | string, b?: string | number) => (ops.push(() => hset(key, a, b)), chain),
        hincrby: (key: string, field: string, by: number) =>
          (ops.push(() => {
            const h = hashes.get(key) ?? {};
            h[field] = String(Number(h[field] ?? 0) + by);
            hashes.set(key, h);
          }),
          chain),
        expire: () => chain,
        exec: async () => (ops.forEach((op) => op()), []),
      };
      return chain;
    },
  };
  return { redis: redis as unknown as Redis, stats: () => hashes.get(WORKER_STATS_KEY) ?? {} };
}

const flush = () => new Promise((r) => setImmediate(r));

function harness(opts: { intervals?: Record<string, number>; walk?: (members: readonly WalkMember[]) => Promise<WalkResult>; now?: () => number; memberLock?: (id: string) => never } = {}) {
  const { redis, stats } = fakeRedis();
  const runtime = new WorkerRuntime(redis, { metricsLogMs: 0, statsWrite: 'fields' });
  const processed: Array<{ member: string; rows: unknown[] }> = [];
  const gates = new Map<string, Promise<void>>();
  const walked: string[][] = [];
  const intervals = opts.intervals ?? {};
  const defaultWalk = async (members: readonly WalkMember[]): Promise<WalkResult> => ({
    members: new Map(members.map((m) => [m.key, { ok: true as const, rows: [`row-of-${m.key}`] }])),
    walkError: null,
  });
  const scan = new CombinedShiftScan({
    bind: () =>
      new Map(
        COMBINED_SHIFT_SCAN_MEMBERS.map((m) => [
          m,
          {
            discover: async () => [],
            process: async (rows: unknown[]) => {
              await (gates.get(m) ?? Promise.resolve());
              processed.push({ member: m, rows });
            },
          },
        ]),
      ),
    walk: async (members) => {
      walked.push(members.map((m) => m.key));
      return (opts.walk ?? defaultWalk)(members);
    },
    intervalOf: (def) => intervals[def.jobName] ?? 300_000,
    tickMs: Math.min(...COMBINED_SHIFT_SCAN_MEMBERS.map((m) => intervals[m] ?? 300_000)),
    runtime,
    memberLock: opts.memberLock,
    now: opts.now,
  });
  return { scan, runtime, processed, gates, walked, stats };
}

describe('D-Q4a registration: exactly one shape of the shift-family scans per mode', () => {
  const members = ['shift-monitor', 'attendance-monitor', 'shift-report-scheduler', 'final-timesheet'];

  it('the members are the four 300-s scans (OD-1); late clock-in and cancellation follow-up stay always-on', () => {
    expect([...COMBINED_SHIFT_SCAN_MEMBERS]).toEqual(members);
    expect(combinedShiftScanMemberDefs().map((d) => d.jobName)).toEqual(members);
    expect(byJob('late-clock-in').shiftScanMode).toBeUndefined();
    expect(byJob('shift-cancellation-followup').shiftScanMode).toBeUndefined();
    expect(combinedDef).toMatchObject({
      queue: 'crewflow-scan-shifts',
      name: 'shift scan (combined)',
      interval: { kind: 'combined-shift-scan' },
      statKeys: { lastRunAt: 'lastShiftScanCombinedAt', failures: 'shiftScanCombinedFailures', skipped: 'shiftScanCombinedSkipped' },
      mayReturnFalse: true,
      shiftScanMode: 'combined',
    });
  });

  it('separate (default, unset, empty or any other value): the members are registered, the combined scan is not', () => {
    for (const value of [undefined, '', 'separate', 'Combined', 'combined ', true]) {
      const env = { get: (k: string) => (k === 'WORKER_SHIFT_SCAN_MODE' ? value : undefined) } as never;
      expect(members.every((m) => isScanJobEnabled(byJob(m), env))).toBe(true);
      expect(isScanJobEnabled(combinedDef, env)).toBe(false);
      expect(isScanJobEnabled(byJob('late-clock-in'), env)).toBe(true);
    }
  });

  it('combined: the combined scan is registered, its four members are not; late clock-in still is', () => {
    const env = { get: (k: string) => (k === 'WORKER_SHIFT_SCAN_MODE' ? 'combined' : undefined) } as never;
    expect(members.some((m) => isScanJobEnabled(byJob(m), env))).toBe(false);
    expect(isScanJobEnabled(combinedDef, env)).toBe(true);
    expect(isScanJobEnabled(byJob('late-clock-in'), env)).toBe(true);
    expect(isScanJobEnabled(byJob('shift-statement-dispatch'), env)).toBe(true);
  });

  it('boot check is strict: only separate / combined (unset or empty = separate)', () => {
    const of = (v: unknown) => resolveShiftScanMode({ get: () => v });
    expect(of(undefined)).toBe('separate');
    expect(of('')).toBe('separate');
    expect(of('separate')).toBe('separate');
    expect(of('combined')).toBe('combined');
    for (const bad of ['Combined', ' combined', 'combined ', 'true', 'on', 1, true]) expect(() => of(bad)).toThrow(/exactly separate or combined/);
  });

  it('interval rule: the combined tick is the gcd of the member intervals; under 30 s refuses (combined mode only)', () => {
    expect(resolveIntervalMs(combinedDef, envWith())).toBe(300_000);
    expect(resolveIntervalMs(combinedDef, envWith({ WORKER_SHIFT_MONITOR_INTERVAL_SECONDS: 60, WORKER_FINAL_TIMESHEET_INTERVAL_SECONDS: 120 }))).toBe(60_000);
    // Separate mode must still boot with 301 s (valid today): resolving the unregistered combined tick does not throw…
    const degenerate = resolveIntervalMs(combinedDef, envWith({ WORKER_SHIFT_MONITOR_INTERVAL_SECONDS: 301 }));
    expect(degenerate).toBe(1_000);
    // …but combined mode refuses it at boot (main.ts → assertCombinedShiftScanTick; env.validation.ts too).
    expect(() => assertCombinedShiftScanTick(degenerate)).toThrow(/at least 30 s/);
    expect(() => assertCombinedShiftScanTick(29_000)).toThrow(/at least 30 s/);
    expect(() => assertCombinedShiftScanTick(30_000)).not.toThrow();
    // A member out of its own bounds is still refused by the member's own check.
    expect(() => resolveIntervalMs(combinedDef, envWith({ WORKER_SHIFT_MONITOR_INTERVAL_SECONDS: 5 }))).toThrow(/shift monitor: invalid interval/);
  });

  it('interval mode, combined: registers shift-scan-combined at the 300-s tick and none of its members', () => {
    const env = envWith({ WORKER_SHIFT_SCAN_MODE: 'combined' });
    const calls: string[] = [];
    const intervals: Record<string, number> = {};
    const runtime = { every: (o: { metricKey?: string; intervalMs: number }) => void (calls.push(o.metricKey!), (intervals[o.metricKey!] = o.intervalMs)) };
    const registry = { scan: (def: ScanJobDefinition) => async () => def.jobName !== '' };
    const { disabled } = registerIntervalScans(runtime as never, registry, SCAN_JOBS, (d) => resolveIntervalMs(d, env), (d) => isScanJobEnabled(d, env));
    expect(calls).toContain('shift-scan-combined');
    expect(intervals['shift-scan-combined']).toBe(300_000);
    for (const m of members) expect(calls).not.toContain(m);
    expect(disabled).toEqual(expect.arrayContaining(members));
    expect(calls).toContain('late-clock-in');
  });

  it('the processor stub fails closed when the combined scan runs without main.ts wiring', async () => {
    await expect(new ShiftScanProcessor({ get: () => ({}) } as never).shiftScanCombined()).rejects.toThrow(/only when main.ts wires it/);
  });

  it('withCombinedShiftScan replaces only the combined handler', async () => {
    const original = jest.fn(async () => 'original');
    const registry = { handlers: [], get: jest.fn(), scan: () => original };
    const run = jest.fn(async () => true);
    const wrapped = withCombinedShiftScan(registry as never, { run });
    await expect(wrapped.scan(combinedDef)()).resolves.toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    await expect(wrapped.scan(byJob('late-clock-in'))()).resolves.toBe('original');
  });
});

describe('D-Q4a combined tick: one walk, each member its own cycle and Health keys', () => {
  it('defaults: every member is due on every tick; ONE walk with all four; each member processes only its own rows', async () => {
    const h = harness();
    const report = await h.scan.tick();
    await Promise.all(report.started);
    expect(h.walked).toEqual([['shift-monitor', 'attendance-monitor', 'shift-report-scheduler', 'final-timesheet']]);
    expect(h.processed.map((p) => [p.member, p.rows])).toEqual(
      expect.arrayContaining(COMBINED_SHIFT_SCAN_MEMBERS.map((m) => [m, [`row-of-${m}`]])),
    );
    expect(h.processed).toHaveLength(4);
    await flush();
    // Health contract: each member keeps its own lastRunAt (and durations under its own metric key).
    expect(Object.keys(h.stats())).toEqual(expect.arrayContaining(['lastShiftMonitorAt', 'lastAttendanceMonitorAt', 'lastShiftReportSchedulerAt', 'lastFinalTimesheetAt']));
    for (const m of COMBINED_SHIFT_SCAN_MEMBERS) expect(h.runtime.metrics.summary(m)?.succeeded).toBe(1);
  });

  it('mixed intervals (60/120/180/300 s → 60-s tick) with timer jitter: each member runs exactly as often as in separate mode', async () => {
    const intervals = { 'shift-monitor': 60_000, 'attendance-monitor': 120_000, 'shift-report-scheduler': 180_000, 'final-timesheet': 300_000 };
    let t = 0;
    const h = harness({ intervals, now: () => t });
    const starts: Record<string, number[]> = {};
    const TICKS = 60; // one hour of 60-s ticks
    for (let i = 0; i < TICKS; i += 1) {
      t = i * 60_000 + ((i * 37) % 400); // 0–399 ms late, never early
      const report = await h.scan.tick();
      for (const m of report.discovered) (starts[m] ??= []).push(t);
      await Promise.all(report.started);
    }
    for (const [member, interval] of Object.entries(intervals)) {
      // Separate mode over the same hour: a run at 0, then every interval.
      expect(starts[member]).toHaveLength(Math.ceil((TICKS * 60_000) / interval));
      const gaps = starts[member]!.slice(1).map((s, i) => s - starts[member]![i]!);
      for (const gap of gaps) {
        expect(gap).toBeGreaterThanOrEqual(interval - 400);
        expect(gap).toBeLessThanOrEqual(interval + 400); // never less often than its own interval
      }
    }
  });

  it('no member due → no walk, idle (not stamped)', async () => {
    let t = 0;
    const h = harness({ now: () => t });
    await Promise.all((await h.scan.tick()).started);
    t = 10_000;
    await expect(h.scan.run()).resolves.toBe(false);
    expect(h.walked).toHaveLength(1);
  });

  it('per-member overlap guard: a member still processing is skipped for that tick only (skipped-running), the others run', async () => {
    let t = 0;
    const h = harness({ now: () => t });
    let release!: () => void;
    h.gates.set('final-timesheet', new Promise<void>((r) => (release = r)));
    const first = await h.scan.tick(); // returns although final-timesheet is still processing (not awaited)
    expect(first.discovered).toHaveLength(4);
    await flush();
    expect(h.runtime.isRunning('final timesheet')).toBe(true);

    t = 300_000;
    const second = await h.scan.tick();
    expect(second.skippedRunning).toEqual(['final-timesheet']);
    expect(h.walked[1]).toEqual(['shift-monitor', 'attendance-monitor', 'shift-report-scheduler']);
    await Promise.all(second.started);
    await flush();
    expect(h.stats().finalTimesheetSkipped).toBe('1');
    expect(h.runtime.metrics.summary('final-timesheet')?.skipped).toBe(1);
    expect(h.processed.filter((p) => p.member === 'shift-monitor')).toHaveLength(2);

    release();
    await Promise.all(first.started);
    t = 600_000;
    const third = await h.scan.tick();
    expect(third.discovered).toEqual(['shift-monitor', 'attendance-monitor', 'shift-report-scheduler', 'final-timesheet']);
    await Promise.all(third.started);
  });

  it('a member whose discovery failed fails ITS cycle (failures + 1, not stamped, nothing processed); the others run', async () => {
    const h = harness({
      walk: async (members) => ({
        members: new Map(
          members.map((m) => [m.key, m.key === 'attendance-monitor' ? { ok: false as const, error: new Error('relation boom') } : { ok: true as const, rows: [m.key] }]),
        ),
        walkError: null,
      }),
    });
    const report = await h.scan.tick();
    expect(report.failed).toEqual(['attendance-monitor']);
    expect(await Promise.all(report.started)).toEqual(['succeeded', 'failed', 'succeeded', 'succeeded']);
    await flush();
    expect(h.stats().attendanceMonitorFailures).toBe('1');
    expect(h.stats().lastAttendanceMonitorAt).toBeUndefined();
    expect(h.stats().lastShiftMonitorAt).toBeDefined();
    expect(h.processed.map((p) => p.member)).not.toContain('attendance-monitor');
  });

  it('a failing walk fails every due member and the combined scan itself (combined failures + 1)', async () => {
    const boom = new Error('catalogue down');
    const h = harness({ walk: async (members) => ({ members: new Map(members.map((m) => [m.key, { ok: false as const, error: boom }])), walkError: boom }) });
    await expect(h.scan.run()).rejects.toBe(boom);
    for (let i = 0; i < 10; i += 1) await flush();
    for (const key of ['shiftMonitorFailures', 'attendanceMonitorFailures', 'shiftReportSchedulerFailures', 'finalTimesheetFailures']) expect(h.stats()[key]).toBe('1');
    expect(h.processed).toHaveLength(0);
  });

  it('Lane A: each member takes its OWN scan lock; a member locked by another replica is skipped-locked, the others run', async () => {
    const asked: string[] = [];
    const memberLock = ((id: string) => {
      asked.push(id);
      return id.endsWith(':final-timesheet') ? async () => ({ acquired: false }) : async (work: () => Promise<unknown>) => ({ acquired: true, value: await work() });
    }) as never;
    const h = harness({ memberLock });
    const outcomes = await Promise.all((await h.scan.tick()).started);
    expect(asked).toEqual([
      'crewflow:crewflow-scan-shifts:shift-monitor',
      'crewflow:crewflow-scan-shifts:attendance-monitor',
      'crewflow:crewflow-scan-reports:shift-report-scheduler',
      'crewflow:crewflow-scan-reports:final-timesheet',
    ]);
    expect(outcomes).toEqual(['succeeded', 'succeeded', 'succeeded', 'skipped-locked']);
    expect(h.processed.map((p) => p.member)).not.toContain('final-timesheet');
  });
});
