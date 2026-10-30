import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { randomBytes } from 'node:crypto';

import { BullmqScheduler, closeWorkersBounded, startBullmqScheduler } from '../../core/scheduler/bullmq-scheduler';
import { buildHandlerRegistry } from '../../core/scheduler/processor-explorer';
import { SCAN_JOBS, schedulerIdOf } from '../../core/scheduler/scan-jobs';
import { WorkerRuntime } from '../../core/runtime/worker-runtime';

/**
 * Lane A M6/M7 — shutdown with work in flight, against the real disposable Redis + PostgreSQL:
 *  - a scan in flight finishes inside the drain budget; its job completes, nothing queued is deleted;
 *  - a scan that outlives the budget is force-closed; its job stays in Redis and is RECOVERED (stalled check) by another
 *    replica — never lost, never deleted;
 *  - a long consumer job (the PDF / statement / email shape) finishes inside the budget, or stays queued for recovery;
 *  - schedulers survive every shutdown; scan locks are released (session closed).
 */
jest.setTimeout(180_000);
const REDIS_URL = process.env.REDIS_URL;
const DB_URL = process.env.DATABASE_URL;
const describeIf = REDIS_URL && DB_URL ? describe : describe.skip;
const quiet = { log: () => undefined, warn: () => undefined, error: () => undefined } as unknown as Logger;
const def = SCAN_JOBS.find((d) => d.jobName === 'storage-cleanup')!; // a long scan in real life
const prefixFor = () => `crewflow:it-${randomBytes(4).toString('hex')}:bull`;

async function replica(prefix: string, handlerMs: number, onRun: (who: string) => void, who: string) {
  const conn = new Redis(REDIS_URL!, { maxRetriesPerRequest: null });
  const runtime = new WorkerRuntime(conn, { statsKey: `${prefix}:stats`, statsWrite: 'fields', metricsLogMs: 0 });
  jest.spyOn((runtime as unknown as { logger: Logger }).logger, 'warn').mockImplementation(() => undefined);
  const registry = buildHandlerRegistry([
    {
      queue: def.queue, jobName: def.jobName, source: 'slow',
      handler: async () => {
        onRun(who);
        await new Promise((r) => setTimeout(r, handlerMs));
        return true;
      },
    },
  ]);
  const scheduler = await startBullmqScheduler({
    redis: conn, redisUrl: REDIS_URL!, lockConnection: { connectionString: DB_URL! }, prefix, reconcileMs: 60_000, runtime, registry, jobs: [def], intervalOf: () => 60 * 60 * 1000, logger: quiet,
  });
  return { conn, runtime, scheduler };
}

async function shutdownLikeMain(r: { conn: Redis; runtime: WorkerRuntime; scheduler: BullmqScheduler }, budgetMs: number) {
  const t0 = Date.now();
  r.runtime.beginShutdown();
  r.scheduler.manager.stop();
  const { timedOut } = await closeWorkersBounded(r.scheduler.scanWorkers, budgetMs, quiet);
  const drain = await r.runtime.drain(Math.max(0, budgetMs - (Date.now() - t0)));
  await r.scheduler.manager.close();
  await r.scheduler.scanLock.close();
  return { timedOut, drained: drain.drained, ms: Date.now() - t0 };
}

describeIf('bullmq-mode shutdown with work in flight (integration)', () => {
  let redis: Redis;
  beforeAll(() => {
    redis = new Redis(REDIS_URL!, { maxRetriesPerRequest: null });
  });
  afterAll(async () => {
    await redis.quit();
  });

  it('an in-flight scan finishes inside the budget; its job completes; the scheduler and its next job survive', async () => {
    const prefix = prefixFor();
    const runs: string[] = [];
    const a = await replica(prefix, 3_000, (w) => runs.push(w), 'A');
    await new Promise((r) => setTimeout(r, 800)); // the brand-new scheduler's first job is running now
    expect(a.runtime.isRunning(def.name)).toBe(true);
    const result = await shutdownLikeMain(a, 15_000);
    expect(result).toMatchObject({ timedOut: 0, drained: true });
    expect(result.ms).toBeGreaterThanOrEqual(1_500);
    const q = new Queue(def.queue, { connection: redis, prefix });
    expect((await q.getJobs(['completed'])).map((j) => j.returnvalue)).toEqual([{ outcome: 'succeeded' }]);
    expect((await q.getJobSchedulers()).map((s) => s.key)).toEqual([schedulerIdOf(def)]);
    expect(await q.getJobCounts('delayed', 'wait')).toMatchObject({ delayed: 1 }); // next tick still queued
    await q.close();
    await a.conn.quit();
  });

  it('a scan that outlives the budget is reported (the process then exits) and its job is NOT deleted — it stays active in Redis', async () => {
    const prefix = prefixFor();
    const runs: string[] = [];
    const a = await replica(prefix, 8_000, (w) => runs.push(w), 'A');
    await new Promise((r) => setTimeout(r, 800));
    const t0 = Date.now();
    a.runtime.beginShutdown();
    a.scheduler.manager.stop();
    const { timedOut } = await closeWorkersBounded(a.scheduler.scanWorkers, 1_000, quiet);
    expect(timedOut).toBe(1);
    expect(Date.now() - t0).toBeLessThan(3_000); // bounded: the budget, not the 8 s scan
    const q = new Queue(def.queue, { connection: redis, prefix });
    expect(await q.getJobCounts('active')).toMatchObject({ active: 1 }); // still in Redis for stalled recovery
    expect((await q.getJobSchedulers()).map((s) => s.key)).toEqual([schedulerIdOf(def)]);
    // (In main.ts the process exits here; recovery by another replica after a real process death is the cluster
    // harness C4 and bundle B5 cases.) Let this in-process scan finish so the test leaves no spinning connection.
    await a.runtime.drain(15_000);
    await Promise.all(a.scheduler.scanWorkers.map((w) => w.close()));
    await a.scheduler.manager.close();
    await a.scheduler.scanLock.close();
    expect(runs).toEqual(['A']);
    await q.close();
    await a.conn.quit();
  });

  it('consumer jobs (PDF / statement / email shape): finish inside the budget, or stay queued — never dropped', async () => {
    const name = `lane-a-consumer-${randomBytes(3).toString('hex')}`;
    const conn = new Redis(REDIS_URL!, { maxRetriesPerRequest: null });
    const producer = new Queue(name, { connection: conn });
    let done = 0;
    const worker = new Worker(name, async () => {
      await new Promise((r) => setTimeout(r, 2_000));
      done += 1;
    }, { connection: conn, concurrency: 2 });
    await producer.add('render', { id: 'x1' }, { jobId: 'x1', attempts: 1 });
    await producer.add('render', { id: 'x2' }, { jobId: 'x2', attempts: 1 });
    await producer.add('render', { id: 'x3' }, { jobId: 'x3', attempts: 1 });
    await new Promise((r) => setTimeout(r, 500)); // x1, x2 active; x3 waiting
    const { timedOut } = await closeWorkersBounded([worker], 10_000, quiet);
    expect(timedOut).toBe(0);
    expect(done).toBe(2); // in-flight jobs finished
    expect(await producer.getJobCounts('completed', 'wait', 'active')).toMatchObject({ completed: 2, wait: 1, active: 0 }); // x3 kept
    await producer.obliterate({ force: true });
    await producer.close();
    await conn.quit();
  });
});
