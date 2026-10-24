import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { randomBytes } from 'node:crypto';

import { startBullmqScheduler, BullmqScheduler, closeWorkersBounded } from '../../core/scheduler/bullmq-scheduler';
import { buildHandlerRegistry } from '../../core/scheduler/processor-explorer';
import { CONSUMER_QUEUES, SCAN_JOB_OPTIONS, SCAN_QUEUE_NAMES } from '../../core/scheduler/queue-registry';
import { assertRedisReadyForBullmq, RedisPreflightError } from '../../core/scheduler/redis-preflight';
import { CrewflowSchedulerManager, removeCrewflowSchedulers } from '../../core/scheduler/scheduler-manager';
import { resolveIntervalMs, SCAN_JOBS, ScanJobDefinition, schedulerIdOf } from '../../core/scheduler/scan-jobs';
import { WorkerRuntime } from '../../core/runtime/worker-runtime';

/**
 * Lane A M4/M7 — the Crewflow job-scheduler lifecycle against a REAL Redis (REDIS_URL = the disposable test Redis) and,
 * for the two-replica case, the real scan lock on the disposable test PostgreSQL (crewflow_app). Every test uses its own
 * random prefix, so nothing here can see or touch another run's (or the API's `bull:`) keys.
 */
jest.setTimeout(120_000);
const REDIS_URL = process.env.REDIS_URL;
const DB_URL = process.env.DATABASE_URL; // crewflow_app (jest-setup points it at TEST_DATABASE_URL)
const describeIf = REDIS_URL && DB_URL ? describe : describe.skip;

const env = { get: (k: string) => ({ LOGIN_HANDOFF_CLEANUP_INTERVAL_MINUTES: 15, OUTBOX_RETENTION_INTERVAL_MINUTES: 60 })[k] as number };
const intervalOf = (def: ScanJobDefinition) => resolveIntervalMs(def, env);
const quietLogger = { log: () => undefined, warn: () => undefined, error: () => undefined } as unknown as Logger;
const freshPrefix = () => `crewflow:it-${randomBytes(4).toString('hex')}:bull`;

async function keysUnder(redis: Redis, pattern: string): Promise<string[]> {
  const out: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 1000);
    cursor = next;
    out.push(...batch);
  } while (cursor !== '0');
  return out;
}

/** Every pending (delayed/wait/prioritized) job of every scan queue under `prefix`, with its scheduler key. */
async function pendingSchedulerJobs(redis: Redis, prefix: string) {
  const jobs: Array<{ queue: string; id: string; scheduler: string | undefined; name: string; data: string; opts: string }> = [];
  for (const name of SCAN_QUEUE_NAMES) {
    const q = new Queue(name, { connection: redis, prefix });
    for (const job of await q.getJobs(['delayed', 'wait', 'prioritized', 'paused'])) {
      if (!job) continue;
      jobs.push({ queue: name, id: String(job.id), scheduler: job.repeatJobKey, name: job.name, data: JSON.stringify(job.data), opts: JSON.stringify(job.opts) });
    }
    await q.close();
  }
  return jobs;
}

async function wipePrefix(redis: Redis, prefix: string) {
  for (const key of await keysUnder(redis, `${prefix}:*`)) await redis.del(key);
}

describeIf('Crewflow BullMQ scheduler lifecycle (integration, real Redis)', () => {
  let redis: Redis;
  const prefixes: string[] = [];
  const track = (p: string) => (prefixes.push(p), p);

  beforeAll(async () => {
    redis = new Redis(REDIS_URL!, { maxRetriesPerRequest: null });
    await redis.ping();
  });
  afterAll(async () => {
    for (const p of prefixes) await wipePrefix(redis, p);
    await redis.quit();
  });

  it('reconcile is idempotent: 19 schedulers, ONE pending job each, and a re-reconcile does not move the next run (no 24 h re-run)', async () => {
    const prefix = track(freshPrefix());
    const manager = new CrewflowSchedulerManager({ connection: redis, prefix, jobs: SCAN_JOBS, intervalOf, logger: quietLogger });
    const first = await manager.reconcile();
    expect(first.upserted).toHaveLength(19);
    const before = await pendingSchedulerJobs(redis, prefix);
    expect(before).toHaveLength(19);
    expect(new Set(before.map((j) => j.scheduler))).toEqual(new Set(SCAN_JOBS.map(schedulerIdOf)));
    for (let i = 0; i < 3; i += 1) await manager.reconcile();
    const after = await pendingSchedulerJobs(redis, prefix);
    expect(after).toHaveLength(19);
    // Same job ids = same next-run timestamps (`repeat:<id>:<nextMillis>`): restarts/reconciles never re-trigger a scan.
    expect(after.map((j) => j.id).sort()).toEqual(before.map((j) => j.id).sort());
    const token = new Queue('crewflow-scan-maintenance', { connection: redis, prefix });
    const s = await token.getJobScheduler('crewflow:crewflow-scan-maintenance:token-cleanup');
    expect(s).toMatchObject({ every: 24 * 60 * 60 * 1000, name: 'token-cleanup' });
    await token.close();
    await manager.close();
  });

  it('concurrent replicas: 5 managers reconciling at once (×3) still leave exactly one scheduler + one pending job per id', async () => {
    const prefix = track(freshPrefix());
    const conns = Array.from({ length: 5 }, () => new Redis(REDIS_URL!, { maxRetriesPerRequest: null }));
    const managers = conns.map((c) => new CrewflowSchedulerManager({ connection: c, prefix, jobs: SCAN_JOBS, intervalOf, logger: quietLogger }));
    for (let round = 0; round < 3; round += 1) await Promise.all(managers.map((m) => m.reconcile()));
    let schedulers = 0;
    for (const name of SCAN_QUEUE_NAMES) {
      const q = new Queue(name, { connection: redis, prefix });
      schedulers += await q.getJobSchedulersCount();
      await q.close();
    }
    expect(schedulers).toBe(19);
    const pending = await pendingSchedulerJobs(redis, prefix);
    expect(pending).toHaveLength(19);
    expect(new Set(pending.map((j) => j.scheduler)).size).toBe(19);
    await Promise.all(managers.map((m) => m.close()));
    await Promise.all(conns.map((c) => c.quit()));
  });

  it('stale Crewflow-owned schedulers are removed; foreign schedulers on the same queues are left untouched', async () => {
    const prefix = track(freshPrefix());
    const shifts = new Queue('crewflow-scan-shifts', { connection: redis, prefix });
    await shifts.upsertJobScheduler('crewflow:crewflow-scan-shifts:retired-scan', { every: 60_000 }, { name: 'retired-scan' });
    await shifts.upsertJobScheduler('other-team:nightly-export', { every: 60_000 }, { name: 'nightly-export' });
    await shifts.upsertJobScheduler('crewflow:crewflow-scan-offers:wrong-queue', { every: 60_000 }, { name: 'x' }); // not this queue's own prefix
    const manager = new CrewflowSchedulerManager({ connection: redis, prefix, jobs: SCAN_JOBS, intervalOf, logger: quietLogger });
    const report = await manager.reconcile();
    expect(report.removedStale).toEqual(['crewflow:crewflow-scan-shifts:retired-scan']);
    expect(report.foreignUntouched.sort()).toEqual(['crewflow-scan-shifts/crewflow:crewflow-scan-offers:wrong-queue', 'crewflow-scan-shifts/other-team:nightly-export']);
    const ids = (await shifts.getJobSchedulers()).map((s) => s.key).sort();
    expect(ids).toEqual(
      ['crewflow:crewflow-scan-offers:wrong-queue', 'other-team:nightly-export', ...SCAN_JOBS.filter((d) => d.queue === 'crewflow-scan-shifts').map(schedulerIdOf)].sort(),
    );
    await shifts.close();
    await manager.close();
  });

  it('a Redis flush/restart that loses the schedulers is repaired by the next reconcile', async () => {
    const prefix = track(freshPrefix());
    const manager = new CrewflowSchedulerManager({ connection: redis, prefix, jobs: SCAN_JOBS, intervalOf, logger: quietLogger });
    await manager.reconcile();
    await wipePrefix(redis, prefix); // what a non-AOF Redis restart does to our keys
    expect(await pendingSchedulerJobs(redis, prefix)).toHaveLength(0);
    await manager.reconcile();
    expect(await pendingSchedulerJobs(redis, prefix)).toHaveLength(19);
    await manager.close();
  });

  it('isolation + payload: scan keys live only under the scan prefix (nothing under bull:), payload is {"v":1}, scan options only', async () => {
    const prefix = track(freshPrefix());
    const bullBefore = (await keysUnder(redis, 'bull:*')).sort();
    const manager = new CrewflowSchedulerManager({ connection: redis, prefix, jobs: SCAN_JOBS, intervalOf, logger: quietLogger });
    await manager.reconcile();
    expect((await keysUnder(redis, 'bull:*')).sort()).toEqual(bullBefore);
    expect(await keysUnder(redis, 'bull:crewflow-scan-*')).toEqual([]);
    for (const q of Object.values(CONSUMER_QUEUES)) expect(await keysUnder(redis, `${prefix}:${q.name}:*`)).toEqual([]);
    const jobs = await pendingSchedulerJobs(redis, prefix);
    for (const job of jobs) {
      expect(job.data).toBe('{"v":1}');
      const opts = JSON.parse(job.opts);
      expect(opts.attempts).toBe(SCAN_JOB_OPTIONS.attempts);
      expect(opts.removeOnComplete).toEqual({ age: 3600, count: 1000 });
      expect(opts.removeOnFail).toEqual({ age: 604800 });
    }
    // The raw scheduler hashes hold only name/every/template metadata — no ids, tokens, bodies, URLs.
    const schedulerHashes = await keysUnder(redis, `${prefix}:*:repeat:crewflow:*`);
    expect(schedulerHashes.length).toBeGreaterThanOrEqual(19);
    for (const key of schedulerHashes) {
      if ((await redis.type(key)) !== 'hash') continue;
      const h = await redis.hgetall(key);
      if (!('every' in h)) continue; // a per-iteration job hash, checked through getJobs above
      expect(Object.keys(h).sort()).toEqual(['data', 'every', 'ic', 'name', 'offset', 'opts'].filter((k) => k in h).sort());
      expect(Object.keys(h).every((k) => ['data', 'every', 'ic', 'name', 'offset', 'opts'].includes(k))).toBe(true);
      expect(h.data).toBe('{"v":1}');
      expect(JSON.stringify(h)).not.toMatch(/postgres:|redis:\/\/|password|@/i);
    }
    await manager.close();
  });

  it('removeCrewflowSchedulers (rollback command) removes only Crewflow-owned schedulers', async () => {
    const prefix = track(freshPrefix());
    const manager = new CrewflowSchedulerManager({ connection: redis, prefix, jobs: SCAN_JOBS, intervalOf, logger: quietLogger });
    await manager.reconcile();
    const shifts = new Queue('crewflow-scan-shifts', { connection: redis, prefix });
    await shifts.upsertJobScheduler('other-team:nightly-export', { every: 60_000 }, { name: 'nightly-export' });
    const removed = await removeCrewflowSchedulers(redis, prefix, SCAN_QUEUE_NAMES);
    expect(removed.sort()).toEqual(SCAN_JOBS.map(schedulerIdOf).sort());
    expect((await shifts.getJobSchedulers()).map((s) => s.key)).toEqual(['other-team:nightly-export']);
    await shifts.close();
    await manager.close();
  });

  it('Redis preflight: noeviction passes (warns when unauthenticated); an evicting Redis refuses bullmq mode, naming the policy only', async () => {
    const warn = jest.fn();
    const ok = await assertRedisReadyForBullmq(redis, REDIS_URL!, { warn });
    expect(ok.maxmemoryPolicy).toBe('noeviction');
    expect(ok.authenticated).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/unauthenticated/));
    expect(warn.mock.calls.join(' ')).not.toContain(REDIS_URL!);
    const lruUrl = process.env.BQ_REDIS_LRU_URL;
    if (lruUrl) {
      const lru = new Redis(lruUrl, { maxRetriesPerRequest: null });
      const error = await assertRedisReadyForBullmq(lru, lruUrl, { warn }).catch((e: Error) => e);
      expect(error).toBeInstanceOf(RedisPreflightError);
      expect((error as Error).message).toMatch(/maxmemory-policy is "allkeys-lru"; WORKER_SCHEDULER=bullmq requires "noeviction"/);
      expect((error as Error).message).not.toContain(lruUrl);
      await lru.quit();
    }
    // A URL with credentials is reported authenticated (parsed only, never printed).
    const fake = { ping: async () => 'PONG', info: async (s: string) => (s === 'memory' ? 'maxmemory_policy:noeviction\r\n' : 'redis_version:7.4.0\r\n'), config: async () => [] };
    await expect(assertRedisReadyForBullmq(fake as never, 'redis://:s3cret@h:6379', { warn: jest.fn() })).resolves.toMatchObject({ authenticated: true });
    // INFO unavailable and CONFIG unavailable → fail closed.
    const blind = { ping: async () => 'PONG', info: async () => '', config: async () => Promise.reject(new Error('unknown command')) };
    await expect(assertRedisReadyForBullmq(blind as never, 'redis://h', { warn: jest.fn() })).rejects.toThrow(/could not determine Redis maxmemory-policy/);
  });

  describe('two replicas sharing one Redis + one PostgreSQL (in-process, real scan lock)', () => {
    // A 1 s cadence for three scans: one fast, one SLOWER than its interval (exercises overlap), one failing.
    const defs = SCAN_JOBS.filter((d) => ['email-dispatch', 'shift-monitor', 'offer-expiry'].includes(d.jobName));
    const fastInterval = () => 1_000;

    it('one scheduler identity, work distributed, never the same scan concurrently, survives a stopped replica', async () => {
      const prefix = track(freshPrefix());
      const active = new Map<string, number>();
      const maxActive = new Map<string, number>();
      const runsBy = new Map<string, number>();
      const enter = (job: string, replica: string) => {
        active.set(job, (active.get(job) ?? 0) + 1);
        maxActive.set(job, Math.max(maxActive.get(job) ?? 0, active.get(job)!));
        runsBy.set(`${replica}:${job}`, (runsBy.get(`${replica}:${job}`) ?? 0) + 1);
      };
      const leave = (job: string) => active.set(job, active.get(job)! - 1);
      const replicas: Array<{ name: string; redis: Redis; runtime: WorkerRuntime; scheduler: BullmqScheduler }> = [];
      for (const name of ['A', 'B']) {
        const conn = new Redis(REDIS_URL!, { maxRetriesPerRequest: null });
        const runtime = new WorkerRuntime(conn, { statsKey: `${prefix}:stats`, statsWrite: 'fields', metricsLogMs: 0 });
        jest.spyOn((runtime as unknown as { logger: Logger }).logger, 'warn').mockImplementation(() => undefined);
        jest.spyOn((runtime as unknown as { logger: Logger }).logger, 'error').mockImplementation(() => undefined);
        const handler = (job: string, ms: number) => async () => {
          enter(job, name);
          await new Promise((r) => setTimeout(r, ms));
          leave(job);
          return true;
        };
        const registry = buildHandlerRegistry([
          { queue: defs[0]!.queue, jobName: defs[0]!.jobName, source: 'fast', handler: handler('email-dispatch', 50) },
          { queue: defs[1]!.queue, jobName: defs[1]!.jobName, source: 'slow', handler: handler('shift-monitor', 2_500) },
          { queue: defs[2]!.queue, jobName: defs[2]!.jobName, source: 'failing', handler: async () => Promise.reject(new Error('boom: row value x@y')) },
        ]);
        const scheduler = await startBullmqScheduler({
          redis: conn, redisUrl: REDIS_URL!, lockUrl: DB_URL!, prefix, reconcileMs: 2_000, runtime, registry, jobs: defs, intervalOf: fastInterval, logger: quietLogger,
        });
        replicas.push({ name, redis: conn, runtime, scheduler });
      }
      await new Promise((r) => setTimeout(r, 12_000));

      // One scheduler per scan (two replicas reconciling every 2 s).
      for (const def of defs) {
        const q = new Queue(def.queue, { connection: redis, prefix });
        expect((await q.getJobSchedulers()).map((s) => s.key)).toEqual([schedulerIdOf(def)]);
        await q.close();
      }
      // Never the same scan on two replicas (or twice on one) at the same time — even the 2.5 s scan on a 1 s schedule.
      expect(maxActive.get('email-dispatch')).toBe(1);
      expect(maxActive.get('shift-monitor')).toBe(1);
      // Not N× the ticks: ~1 run/s cluster-wide for the fast scan (12 s window, generous bounds), not ~2/s.
      const fastRuns = (runsBy.get('A:email-dispatch') ?? 0) + (runsBy.get('B:email-dispatch') ?? 0);
      expect(fastRuns).toBeGreaterThanOrEqual(6);
      expect(fastRuns).toBeLessThanOrEqual(16);
      // Distribution: both replicas won work.
      const byReplica = (r: string) => [...runsBy.entries()].filter(([k]) => k.startsWith(`${r}:`)).reduce((s, [, n]) => s + n, 0);
      expect(byReplica('A')).toBeGreaterThan(0);
      expect(byReplica('B')).toBeGreaterThan(0);
      // Failure accounting: a failing scan fails its BullMQ job with a fixed message (no row values in Redis).
      const offersQ = new Queue('crewflow-scan-offers', { connection: redis, prefix });
      const failed = await offersQ.getJobs(['failed']);
      expect(failed.length).toBeGreaterThan(0);
      for (const job of failed) {
        expect(job.failedReason).toBe('offer expiry cycle failed (details in the worker log)');
        expect(JSON.stringify(job.stacktrace)).not.toContain('x@y');
      }
      await offersQ.close();
      const stats = await redis.hgetall(`${prefix}:stats`);
      expect(Number(stats.offerExpiryFailures)).toBeGreaterThan(0);
      expect(stats.lastOfferExpiryAt).toBeUndefined(); // a failing scan is never shown successful
      expect(Number(stats.lastEmailDispatchAt)).toBeGreaterThan(0);

      // Stop replica A the way shutdown does (stop reconcile, bounded close, release locks) — scheduling continues on B.
      const a = replicas[0]!;
      a.runtime.beginShutdown();
      a.scheduler.manager.stop();
      await closeWorkersBounded(a.scheduler.scanWorkers, 10_000, quietLogger);
      await a.scheduler.manager.close();
      await a.scheduler.scanLock.close();
      const bBefore = runsBy.get('B:email-dispatch') ?? 0;
      await new Promise((r) => setTimeout(r, 5_000));
      expect((runsBy.get('B:email-dispatch') ?? 0) - bBefore).toBeGreaterThanOrEqual(3);
      // Schedulers were NOT removed by A's shutdown.
      const q = new Queue(defs[0]!.queue, { connection: redis, prefix });
      expect((await q.getJobSchedulers()).map((s) => s.key)).toEqual([schedulerIdOf(defs[0]!)]);
      await q.close();

      const b = replicas[1]!;
      b.runtime.beginShutdown();
      b.scheduler.manager.stop();
      await closeWorkersBounded(b.scheduler.scanWorkers, 10_000, quietLogger);
      await b.scheduler.manager.close();
      await b.scheduler.scanLock.close();
      await Promise.all(replicas.map((r) => r.redis.quit()));
    });
  });
});
