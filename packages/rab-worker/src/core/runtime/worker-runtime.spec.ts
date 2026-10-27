import Redis from 'ioredis';

import { WORKER_STATS_KEY } from '@rab/server/engine/worker-shared/heartbeat.constants';
import { percentile } from './cycle-metrics';
import { WorkerLoopOptions, WorkerRuntime } from './worker-runtime';

/** In-memory stand-in for the few ioredis calls WorkerRuntime makes (hset, multi().hset/hincrby/expire/exec). */
function fakeRedis() {
  const hashes = new Map<string, Record<string, string>>();
  const writes: Array<{ op: string; key: string; value: unknown }> = [];
  const hset = (key: string, a: Record<string, string | number> | string, b?: string | number) => {
    const obj = typeof a === 'string' ? { [a]: b! } : a;
    writes.push({ op: 'hset', key, value: { ...obj } });
    const h = hashes.get(key) ?? {};
    for (const [k, v] of Object.entries(obj)) h[k] = String(v);
    hashes.set(key, h);
  };
  const hincrby = (key: string, field: string, by: number) => {
    writes.push({ op: 'hincrby', key, value: field });
    const h = hashes.get(key) ?? {};
    h[field] = String(Number(h[field] ?? 0) + by);
    hashes.set(key, h);
  };
  const redis = {
    hset: async (key: string, obj: Record<string, string | number>) => hset(key, obj),
    multi: () => {
      const ops: Array<() => void> = [];
      const chain = {
        hset: (key: string, a: Record<string, string | number> | string, b?: string | number) => (ops.push(() => hset(key, a, b)), chain),
        hincrby: (key: string, field: string, by: number) => (ops.push(() => hincrby(key, field, by)), chain),
        expire: (key: string) => (ops.push(() => writes.push({ op: 'expire', key, value: null })), chain),
        exec: async () => (ops.forEach((op) => op()), []),
      };
      return chain;
    },
  };
  return { redis: redis as unknown as Redis, hashes, writes };
}

const flush = () => new Promise((r) => setImmediate(r));
const loop = (overrides: Partial<WorkerLoopOptions> = {}): WorkerLoopOptions => ({
  name: 'email dispatch',
  intervalMs: 60_000,
  statKeys: { lastRunAt: 'lastEmailDispatchAt', failures: 'emailDispatchFailures', skipped: 'emailDispatchSkipped' },
  metricKey: 'email-dispatch',
  run: async () => true,
  ...overrides,
});

describe('WorkerRuntime (BullMQ migration M1/M5)', () => {
  it('interval mode (default): every settle HSETs the WHOLE stats object to rab:worker:stats, startedAt included — unchanged', async () => {
    const { redis, writes } = fakeRedis();
    const runtime = new WorkerRuntime(redis, { metricsLogMs: 0 });
    runtime.every(loop());
    await flush();
    runtime.beginShutdown();
    await runtime.drain(1000);
    const statsWrites = writes.filter((w) => w.key === WORKER_STATS_KEY);
    expect(statsWrites).toHaveLength(1);
    expect(Object.keys(statsWrites[0]!.value as object).sort()).toEqual(['lastEmailDispatchAt', 'startedAt']);
    // The new skip counter is never written in interval mode.
    expect(writes.some((w) => JSON.stringify(w.value).includes('Skipped'))).toBe(false);
  });

  it('`return false` never stamps lastRunAt (both drivers); a failure increments the failure counter and logs', async () => {
    for (const statsWrite of ['whole', 'fields'] as const) {
      const { redis, hashes } = fakeRedis();
      const runtime = new WorkerRuntime(redis, { statsWrite, metricsLogMs: 0 });
      expect(await runtime.runOnce(loop({ run: async () => false }))).toBe('idle');
      await flush();
      expect(hashes.get(WORKER_STATS_KEY)?.lastEmailDispatchAt).toBeUndefined();
      const spy = jest.spyOn((runtime as unknown as { logger: { error: () => void } }).logger, 'error').mockImplementation(() => undefined);
      expect(await runtime.runOnce(loop({ run: async () => Promise.reject(new Error('db down')) }))).toBe('failed');
      await flush();
      expect(hashes.get(WORKER_STATS_KEY)?.emailDispatchFailures).toBe('1');
      expect(spy).toHaveBeenCalledWith('email dispatch cycle failed', expect.any(Error));
      expect(await runtime.runOnce(loop())).toBe('succeeded');
      await flush();
      expect(Number(hashes.get(WORKER_STATS_KEY)?.lastEmailDispatchAt)).toBeGreaterThan(0);
    }
  });

  it('bullmq ("fields") mode writes only the changed fields: a replica never overwrites another replica`s fresher timestamp', async () => {
    const shared = fakeRedis();
    const a = new WorkerRuntime(shared.redis, { statsWrite: 'fields', metricsLogMs: 0 });
    const b = new WorkerRuntime(shared.redis, { statsWrite: 'fields', metricsLogMs: 0 });
    await a.runOnce(loop()); // A stamps email dispatch at t1
    await flush();
    const t1 = Number(shared.hashes.get(WORKER_STATS_KEY)!.lastEmailDispatchAt);
    await new Promise((r) => setTimeout(r, 5));
    await b.runOnce(loop()); // B stamps it later
    await flush();
    const t2 = Number(shared.hashes.get(WORKER_STATS_KEY)!.lastEmailDispatchAt);
    expect(t2).toBeGreaterThan(t1);
    // A now runs a DIFFERENT scan; in whole mode it would rewrite lastEmailDispatchAt back to t1.
    await a.runOnce(loop({ name: 'shift monitor', metricKey: 'shift-monitor', statKeys: { lastRunAt: 'lastShiftMonitorAt', failures: 'shiftMonitorFailures', skipped: 'shiftMonitorSkipped' } }));
    await flush();
    expect(Number(shared.hashes.get(WORKER_STATS_KEY)!.lastEmailDispatchAt)).toBe(t2);
    // Failure counters are cluster-wide HINCRBY totals in this mode.
    jest.spyOn((a as unknown as { logger: { error: () => void } }).logger, 'error').mockImplementation(() => undefined);
    jest.spyOn((b as unknown as { logger: { error: () => void } }).logger, 'error').mockImplementation(() => undefined);
    await a.runOnce(loop({ run: () => Promise.reject(new Error('x')) }));
    await b.runOnce(loop({ run: () => Promise.reject(new Error('x')) }));
    await flush();
    expect(shared.hashes.get(WORKER_STATS_KEY)!.emailDispatchFailures).toBe('2');
  });

  it('skips: a second job for a scan already running on this instance is skipped (never stacked), counted, not stamped', async () => {
    const { redis, hashes } = fakeRedis();
    const runtime = new WorkerRuntime(redis, { statsWrite: 'fields', metricsLogMs: 0 });
    jest.spyOn((runtime as unknown as { logger: { warn: () => void } }).logger, 'warn').mockImplementation(() => undefined);
    let release!: () => void;
    const first = runtime.runOnce(loop({ run: () => new Promise<boolean>((r) => (release = () => r(true))) }));
    await flush();
    expect(await runtime.runOnce(loop())).toBe('skipped-running');
    // Cross-replica: the scan lock is held elsewhere → skipped-locked, never run, never stamped.
    const ran = jest.fn();
    expect(await runtime.runOnce(loop({ name: 'other', metricKey: 'other', run: async () => ran() }), async () => ({ acquired: false }))).toBe('skipped-locked');
    expect(ran).not.toHaveBeenCalled();
    release();
    expect(await first).toBe('succeeded');
    await flush();
    expect(hashes.get(WORKER_STATS_KEY)!.emailDispatchSkipped).toBe('2');
    expect(runtime.metrics.summary('email-dispatch')).toMatchObject({ succeeded: 1, skipped: 1, n: 1 });
  });

  it('after beginShutdown no new cycle starts (bullmq job delivered during shutdown → skipped-shutdown)', async () => {
    const { redis } = fakeRedis();
    const runtime = new WorkerRuntime(redis, { statsWrite: 'fields', metricsLogMs: 0 });
    runtime.beginShutdown();
    const run = jest.fn(async () => true);
    expect(await runtime.runOnce(loop({ run }))).toBe('skipped-shutdown');
    expect(run).not.toHaveBeenCalled();
  });

  it('provisioner identity: full stats to its own key; only its loop fields (never startedAt) mirrored to rab:worker:stats', async () => {
    const { redis, hashes } = fakeRedis();
    hashes.set(WORKER_STATS_KEY, { startedAt: '111' }); // the jobs process's own start time
    const runtime = new WorkerRuntime(redis, { statsKey: 'rab:workspace-provisioner:stats', mirrorKey: WORKER_STATS_KEY, metricsLogMs: 0 });
    await runtime.runOnce(loop({ name: 'workspace provisioning', statKeys: { lastRunAt: 'lastWorkspaceProvisioningAt', failures: 'workspaceProvisioningFailures' } }));
    await flush();
    expect(hashes.get(WORKER_STATS_KEY)!.startedAt).toBe('111');
    expect(Number(hashes.get(WORKER_STATS_KEY)!.lastWorkspaceProvisioningAt)).toBeGreaterThan(0);
    expect(hashes.get('rab:workspace-provisioner:stats')!.startedAt).toBe(String(runtime.stats.startedAt));
  });

  it('M1: records per-loop durations and computes nearest-rank p50/p95/p99/max; flushes them to the durations hash', async () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(percentile([5], 99)).toBe(5);
    expect(percentile([], 99)).toBeNull();
    const { redis, hashes } = fakeRedis();
    const runtime = new WorkerRuntime(redis, { durationsKey: 'rab:worker:cycle-durations', metricsFlushMs: 0, metricsLogMs: 0 });
    for (let i = 0; i < 3; i += 1) await runtime.runOnce(loop({ run: () => new Promise((r) => setTimeout(() => r(true), 10)) }));
    await runtime.flushMetrics();
    const field = JSON.parse(hashes.get('rab:worker:cycle-durations')!['email-dispatch']!);
    expect(field).toMatchObject({ n: 3, succeeded: 3, failed: 0, skipped: 0 });
    expect(field.p50).toBeGreaterThanOrEqual(5);
    expect(field.p99).toBeGreaterThanOrEqual(field.p50);
    // Only numbers, counters and an instance label — no configuration or payload.
    expect(Object.keys(field).sort()).toEqual(['at', 'failed', 'idle', 'instance', 'lastMs', 'max', 'n', 'p50', 'p95', 'p99', 'skipped', 'succeeded']);
  });

  it('bullmq progress fields appear only after enableSchedulerProgress (the interval-mode heartbeat file shape is unchanged)', () => {
    const { redis } = fakeRedis();
    const runtime = new WorkerRuntime(redis, { metricsLogMs: 0 });
    expect(Object.keys(runtime.progress()).sort()).toEqual(['inFlight', 'lastCycleSettledAt', 'lastCycleSucceededAt', 'oldestInFlight', 'shuttingDown', 'startedAt']);
    runtime.enableSchedulerProgress();
    runtime.markConsumersReady(5);
    runtime.markReconcileOk(6);
    expect(runtime.progress()).toMatchObject({ mode: 'bullmq', consumersReadyAt: 5, reconcileOkAt: 6 });
  });
});
