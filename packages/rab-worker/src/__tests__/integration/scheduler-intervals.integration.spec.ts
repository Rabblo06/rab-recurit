import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { randomBytes } from 'node:crypto';

import { BullmqScheduler, closeWorkersBounded, startBullmqScheduler } from '../../core/scheduler/bullmq-scheduler';
import { buildHandlerRegistry } from '../../core/scheduler/processor-explorer';
import { SCAN_QUEUE_NAMES } from '../../core/scheduler/queue-registry';
import { CrewflowSchedulerManager } from '../../core/scheduler/scheduler-manager';
import { isScanJobEnabled, resolveIntervalMs, SCAN_JOBS, ScanJobDefinition, schedulerIdOf } from '../../core/scheduler/scan-jobs';
import { WorkerRuntime } from '../../core/runtime/worker-runtime';
import { defaultIntervalEnv } from './helpers/default-interval-env';
import { EXPECTED_SCAN_SCHEDULER_IDS } from './helpers/expected-scan-jobs';

/**
 * Phase A pa-intervals — configurable intervals + the push/realtime enable predicate against a REAL Redis (the disposable
 * test Redis) and, where replicas run scans, the real scan lock on the disposable test PostgreSQL (crewflow_app). Every
 * test uses its own random prefix; nothing touches the API's `bull:` keys.
 */
jest.setTimeout(120_000);
const REDIS_URL = process.env.REDIS_URL;
const DB_URL = process.env.DATABASE_URL;
const describeIf = REDIS_URL && DB_URL ? describe : describe.skip;

const quietLogger = { log: () => undefined, warn: () => undefined, error: () => undefined } as unknown as Logger;
const freshPrefix = () => `crewflow:it-pa-${randomBytes(4).toString('hex')}:bull`;
const PUSH_ID = 'crewflow:crewflow-scan-push:push-dispatch';
const REALTIME_ID = 'crewflow:crewflow-scan-realtime:realtime-outbox-publish';
const GATED = [PUSH_ID, REALTIME_ID];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const def = (jobName: string) => SCAN_JOBS.find((d) => d.jobName === jobName)!;

/** The enable predicate exactly as main.ts builds it, from an env stub. */
const enabledFrom = (switches: { PUSH_ENABLED: boolean; REALTIME_ENABLED: boolean }) => (d: ScanJobDefinition) => isScanJobEnabled(d, { get: (k) => switches[k] });
const ALL_OFF = enabledFrom({ PUSH_ENABLED: false, REALTIME_ENABLED: false }); // the defaults
const ALL_ON = enabledFrom({ PUSH_ENABLED: true, REALTIME_ENABLED: true });
const intervalOfEnv = (overrides: Record<string, number> = {}) => {
  const env = defaultIntervalEnv(overrides);
  return (d: ScanJobDefinition) => resolveIntervalMs(d, env);
};

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

async function schedulers(redis: Redis, prefix: string): Promise<Map<string, { every?: number; next?: number }>> {
  const out = new Map<string, { every?: number; next?: number }>();
  for (const name of SCAN_QUEUE_NAMES) {
    const q = new Queue(name, { connection: redis, prefix });
    for (const s of await q.getJobSchedulers(0, -1, true)) {
      expect(out.has(s.key)).toBe(false); // a scheduler id is never listed twice
      out.set(s.key, { every: s.every === undefined ? undefined : Number(s.every), next: s.next === undefined ? undefined : Number(s.next) });
    }
    await q.close();
  }
  return out;
}

async function pending(redis: Redis, prefix: string) {
  const jobs: Array<{ queue: string; id: string; scheduler: string | undefined; state: string; dueAt: number }> = [];
  for (const name of SCAN_QUEUE_NAMES) {
    const q = new Queue(name, { connection: redis, prefix });
    for (const state of ['delayed', 'wait', 'prioritized', 'paused'] as const) {
      for (const job of await q.getJobs([state])) {
        if (job) jobs.push({ queue: name, id: String(job.id), scheduler: job.repeatJobKey, state, dueAt: job.timestamp + (job.delay ?? 0) });
      }
    }
    await q.close();
  }
  return jobs;
}

const perScheduler = (jobs: Array<{ scheduler: string | undefined }>) => {
  const counts = new Map<string, number>();
  for (const j of jobs) counts.set(String(j.scheduler), (counts.get(String(j.scheduler)) ?? 0) + 1);
  return counts;
};

describeIf('Phase A scheduler intervals + enable predicate (integration, real Redis)', () => {
  let redis: Redis;
  const prefixes: string[] = [];
  const track = (p: string) => (prefixes.push(p), p);

  beforeAll(async () => {
    redis = new Redis(REDIS_URL!, { maxRetriesPerRequest: null });
    await redis.ping();
  });
  afterAll(async () => {
    for (const p of prefixes) for (const key of await keysUnder(redis, `${p}:*`)) await redis.del(key);
    await redis.quit();
  });

  it('defaults (PUSH_ENABLED=false, REALTIME_ENABLED=false): 19 schedulers, never a push or realtime one', async () => {
    const prefix = track(freshPrefix());
    const manager = new CrewflowSchedulerManager({ connection: redis, prefix, jobs: SCAN_JOBS, intervalOf: intervalOfEnv(), isEnabled: ALL_OFF, logger: quietLogger });
    const report = await manager.reconcile();
    expect(report.disabled).toEqual(GATED);
    expect(report.removedDisabled).toEqual([]);
    const ids = [...(await schedulers(redis, prefix)).keys()].sort();
    expect(ids).toEqual(EXPECTED_SCAN_SCHEDULER_IDS.filter((id) => !GATED.includes(id)).sort());
    const jobs = await pending(redis, prefix);
    expect(jobs).toHaveLength(19);
    expect(jobs.some((j) => GATED.includes(String(j.scheduler)))).toBe(false);
    await manager.close();
  });

  it('disable ⇒ the existing schedulers AND their already-due jobs are removed (others untouched); re-enable ⇒ registered again', async () => {
    const prefix = track(freshPrefix());
    const intervalOf = intervalOfEnv();
    const on = new CrewflowSchedulerManager({ connection: redis, prefix, jobs: SCAN_JOBS, intervalOf, isEnabled: ALL_ON, logger: quietLogger });
    await on.reconcile();
    expect((await schedulers(redis, prefix)).size).toBe(21);
    const before = await pending(redis, prefix);
    // A brand-new scheduler's first job is due immediately (wait), which removeJobScheduler alone would leave behind.
    expect(before.filter((j) => GATED.includes(String(j.scheduler))).map((j) => j.state)).toEqual(['wait', 'wait']);

    const off = new CrewflowSchedulerManager({ connection: redis, prefix, jobs: SCAN_JOBS, intervalOf, isEnabled: ALL_OFF, logger: quietLogger });
    const report = await off.reconcile();
    expect(report.removedDisabled.sort()).toEqual([...GATED].sort());
    expect(report.removedStale).toEqual([]);
    expect([...(await schedulers(redis, prefix)).keys()].some((id) => GATED.includes(id))).toBe(false);
    const after = await pending(redis, prefix);
    expect(after.some((j) => GATED.includes(String(j.scheduler)))).toBe(false); // stops firing: nothing left to run
    // The 19 other schedulers keep their exact pending job (same id = same next-run time).
    expect(after.map((j) => j.id).sort()).toEqual(before.filter((j) => !GATED.includes(String(j.scheduler))).map((j) => j.id).sort());
    // Idempotent: a second disabled pass removes nothing more.
    expect((await off.reconcile()).removedDisabled).toEqual([]);

    const back = await on.reconcile();
    expect(back.removedDisabled).toEqual([]);
    expect([...(await schedulers(redis, prefix)).keys()].sort()).toEqual([...EXPECTED_SCAN_SCHEDULER_IDS].sort());
    const again = await pending(redis, prefix);
    expect([...perScheduler(again).values()].every((n) => n === 1)).toBe(true);
    expect(again).toHaveLength(21);
    await on.close();
    await off.close();
  });

  it('interval change ⇒ the SAME scheduler id updated in place: one scheduler, one pending job, next run time kept', async () => {
    const prefix = track(freshPrefix());
    // firstRunAfterInterval gives the scan a FUTURE next run, so "kept" is observable (an overdue job is due now anyway).
    const offerExpiry: ScanJobDefinition = { ...def('offer-expiry'), firstRunAfterInterval: true };
    const jobs = SCAN_JOBS.map((d) => (d.jobName === 'offer-expiry' ? offerExpiry : d));
    const id = schedulerIdOf(offerExpiry);
    const m1 = new CrewflowSchedulerManager({ connection: redis, prefix, jobs, intervalOf: intervalOfEnv(), logger: quietLogger });
    await m1.reconcile();
    const [first] = (await pending(redis, prefix)).filter((j) => j.scheduler === id);
    expect(first!.state).toBe('delayed');

    const m2 = new CrewflowSchedulerManager({ connection: redis, prefix, jobs, intervalOf: intervalOfEnv({ WORKER_OFFER_EXPIRY_INTERVAL_SECONDS: 300 }), logger: quietLogger });
    const report = await m2.reconcile();
    expect(report.intervalChanged).toEqual([`${id} 60000→300000`]);
    const all = await schedulers(redis, prefix);
    expect(all.size).toBe(21);
    expect(all.get(id)!.every).toBe(300_000);
    const now = (await pending(redis, prefix)).filter((j) => j.scheduler === id);
    expect(now).toHaveLength(1);
    expect(now[0]!.id).toBe(first!.id); // same `repeat:<id>:<millis>` ⇒ the pending run time did not move
    // Every other scan untouched; still exactly one pending job per scheduler.
    expect([...perScheduler(await pending(redis, prefix)).values()].every((n) => n === 1)).toBe(true);
    // Changing back is symmetric and still one scheduler.
    await m1.reconcile();
    expect((await schedulers(redis, prefix)).get(id)!.every).toBe(60_000);
    expect((await pending(redis, prefix)).filter((j) => j.scheduler === id).map((j) => j.id)).toEqual([first!.id]);
    await m1.close();
    await m2.close();
  });

  it('replicas DISAGREEING on intervals (rolling deploy), reconciling concurrently ×3: one scheduler + one pending job per id, no extra run', async () => {
    const prefix = track(freshPrefix());
    const storage: ScanJobDefinition = { ...def('storage-cleanup'), firstRunAfterInterval: true };
    const jobs = SCAN_JOBS.map((d) => (d.jobName === 'storage-cleanup' ? storage : d));
    const conns = Array.from({ length: 4 }, () => new Redis(REDIS_URL!, { maxRetriesPerRequest: null }));
    const managers = conns.map(
      (c, i) =>
        new CrewflowSchedulerManager({
          connection: c,
          prefix,
          jobs,
          // Two replicas on the old settings, two on new ones (storage cleanup 24 h vs 12 h, email dispatch 2 s vs 5 s).
          intervalOf: i % 2 === 0 ? intervalOfEnv() : intervalOfEnv({ WORKER_STORAGE_CLEANUP_INTERVAL_SECONDS: 43_200, WORKER_EMAIL_DISPATCH_INTERVAL_SECONDS: 5 }),
          isEnabled: ALL_ON,
          logger: quietLogger,
        }),
    );
    await managers[0]!.reconcile();
    const storageFirst = (await pending(redis, prefix)).find((j) => j.scheduler === schedulerIdOf(storage))!;
    for (let round = 0; round < 3; round += 1) await Promise.all(managers.map((m) => m.reconcile()));
    const all = await schedulers(redis, prefix);
    expect([...all.keys()].sort()).toEqual([...EXPECTED_SCAN_SCHEDULER_IDS].sort());
    const jobsNow = await pending(redis, prefix);
    expect(jobsNow).toHaveLength(21);
    expect([...perScheduler(jobsNow).values()].every((n) => n === 1)).toBe(true);
    // The 24 h sweep's next run never moved forward to "now" while the replicas flipped its interval.
    expect(jobsNow.find((j) => j.scheduler === schedulerIdOf(storage))!.id).toBe(storageFirst.id);
    expect([86_400_000, 43_200_000]).toContain(all.get(schedulerIdOf(storage))!.every);
    await Promise.all(managers.map((m) => m.close()));
    await Promise.all(conns.map((c) => c.quit()));
  });

  it('firstRunAfterInterval (generic hook, default off): a new scheduler is first due one interval later; default is due now', async () => {
    const prefix = track(freshPrefix());
    const delayed: ScanJobDefinition = { ...def('token-cleanup'), firstRunAfterInterval: true };
    const immediate = def('account-invite-cleanup');
    const t0 = Date.now();
    const manager = new CrewflowSchedulerManager({ connection: redis, prefix, jobs: [delayed, immediate], intervalOf: intervalOfEnv(), logger: quietLogger });
    await manager.reconcile();
    const jobs = await pending(redis, prefix);
    const d = jobs.find((j) => j.scheduler === schedulerIdOf(delayed))!;
    const i = jobs.find((j) => j.scheduler === schedulerIdOf(immediate))!;
    expect(d.state).toBe('delayed');
    expect(d.dueAt).toBeGreaterThanOrEqual(t0 + 86_400_000 - 1_000);
    expect(d.dueAt).toBeLessThanOrEqual(Date.now() + 86_400_000 + 1_000);
    expect(i.state).toBe('wait');
    // Re-reconciling never pushes the delayed first run further out.
    await manager.reconcile();
    expect((await pending(redis, prefix)).find((j) => j.scheduler === schedulerIdOf(delayed))!.id).toBe(d.id);
    await manager.close();
  });

  describe('replicas running scans (real scan lock on the test database)', () => {
    type Replica = { redis: Redis; runtime: WorkerRuntime; scheduler: BullmqScheduler };
    async function startReplica(prefix: string, defs: readonly ScanJobDefinition[], handlers: Record<string, () => Promise<boolean>>, isEnabled: (d: ScanJobDefinition) => boolean): Promise<Replica> {
      const conn = new Redis(REDIS_URL!, { maxRetriesPerRequest: null });
      const runtime = new WorkerRuntime(conn, { statsKey: `${prefix}:stats`, statsWrite: 'fields', metricsLogMs: 0 });
      jest.spyOn((runtime as unknown as { logger: Logger }).logger, 'warn').mockImplementation(() => undefined);
      const registry = buildHandlerRegistry(defs.map((d) => ({ queue: d.queue, jobName: d.jobName, source: d.jobName, handler: handlers[d.jobName]! })));
      const scheduler = await startBullmqScheduler({
        redis: conn, redisUrl: REDIS_URL!, lockConnection: { connectionString: DB_URL! }, prefix, reconcileMs: 2_000, runtime, registry, jobs: defs, intervalOf: () => 1_000, isEnabled, logger: quietLogger,
      });
      return { redis: conn, runtime, scheduler };
    }
    async function stopReplica(r: Replica) {
      r.runtime.beginShutdown();
      r.scheduler.manager.stop();
      await closeWorkersBounded(r.scheduler.scanWorkers, 10_000, quietLogger);
      await r.scheduler.manager.close();
      await r.scheduler.scanLock.close();
      await r.redis.quit();
    }

    it('two replicas: one scheduler per ENABLED scan, none for the disabled ones, a disabled scan never runs (even a leftover job)', async () => {
      const prefix = track(freshPrefix());
      // push-dispatch (own queue) and late-clock-in (a queue shared with an enabled scan) disabled; two scans enabled.
      const defs = ['email-dispatch', 'push-dispatch', 'shift-monitor', 'late-clock-in'].map(def);
      const disabledNames = ['push-dispatch', 'late-clock-in'];
      const isEnabled = (d: ScanJobDefinition) => !disabledNames.includes(d.jobName);
      const runs = new Map<string, number>();
      const handler = (name: string) => async () => (runs.set(name, (runs.get(name) ?? 0) + 1), true);
      const handlers = Object.fromEntries(defs.map((d) => [d.jobName, handler(d.jobName)]));
      const a = await startReplica(prefix, defs, handlers, isEnabled);
      const b = await startReplica(prefix, defs, handlers, isEnabled);
      // A leftover late-clock-in job (e.g. due just before it was disabled) on the shared shifts queue.
      const shifts = new Queue('crewflow-scan-shifts', { connection: redis, prefix });
      const leftover = await shifts.add('late-clock-in', { v: 1 }, { attempts: 1 });
      await sleep(7_000);

      const all = await schedulers(redis, prefix);
      expect([...all.keys()].sort()).toEqual(['crewflow:crewflow-scan-email:email-dispatch', 'crewflow:crewflow-scan-shifts:shift-monitor']);
      expect(runs.get('push-dispatch')).toBeUndefined();
      expect(runs.get('late-clock-in')).toBeUndefined();
      expect(runs.get('email-dispatch')!).toBeGreaterThanOrEqual(3);
      expect(runs.get('email-dispatch')!).toBeLessThanOrEqual(10); // ~1/s cluster-wide, not 2/s: no duplicate scheduler
      // No scan Worker for a queue whose scans are all disabled (push); the shifts queue still has one.
      for (const r of [a, b]) expect(r.scheduler.scanWorkers.map((w) => w.name)).toEqual(['crewflow-scan-email', 'crewflow-scan-shifts']);
      const done = await shifts.getJob(String(leftover.id));
      expect(await done?.getState()).toBe('completed');
      expect(done?.returnvalue).toEqual({ outcome: 'disabled' });
      await shifts.close();
      await stopReplica(a);
      await stopReplica(b);
    });

    it('worker restart: schedulers intact (same ids, same intervals), the job due during the downtime runs after restart', async () => {
      const prefix = track(freshPrefix());
      const defs = ['email-dispatch', 'offer-expiry'].map(def);
      const runs = new Map<string, number>();
      const handlers = Object.fromEntries(defs.map((d) => [d.jobName, async () => (runs.set(d.jobName, (runs.get(d.jobName) ?? 0) + 1), true)]));
      const first = await startReplica(prefix, defs, handlers, () => true);
      await sleep(3_000);
      await stopReplica(first);
      const beforeSchedulers = await schedulers(redis, prefix);
      await sleep(2_500); // downtime: each scheduler's next job comes due with no consumer
      const due = await pending(redis, prefix);
      expect(due).toHaveLength(2);
      expect([...(await schedulers(redis, prefix)).entries()]).toEqual([...beforeSchedulers.entries()]); // nothing removed on shutdown
      const runsBefore = new Map(runs);

      const second = await startReplica(prefix, defs, handlers, () => true);
      await sleep(4_000);
      const afterSchedulers = await schedulers(redis, prefix);
      expect([...afterSchedulers.keys()].sort()).toEqual([...beforeSchedulers.keys()].sort());
      for (const [id, s] of afterSchedulers) expect(s.every).toBe(beforeSchedulers.get(id)!.every);
      // No job loss: the job that was pending across the restart was processed (completed) by the restarted replica.
      for (const job of due) {
        const q = new Queue(job.queue, { connection: redis, prefix });
        expect(await (await q.getJob(job.id))?.getState()).toBe('completed');
        await q.close();
      }
      for (const d of defs) expect((runs.get(d.jobName) ?? 0) - (runsBefore.get(d.jobName) ?? 0)).toBeGreaterThanOrEqual(2);
      // Still exactly one pending job per scheduler after the restart's reconciles.
      expect([...perScheduler(await pending(redis, prefix)).values()].every((n) => n === 1)).toBe(true);
      await stopReplica(second);
    });
  });
});
