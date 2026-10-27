import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { randomBytes } from 'node:crypto';

import { BullmqScheduler, closeWorkersBounded, startBullmqScheduler } from '../../core/scheduler/bullmq-scheduler';
import { buildHandlerRegistry } from '../../core/scheduler/processor-explorer';
import { SCAN_JOBS } from '../../core/scheduler/scan-jobs';
import { WorkerRuntime } from '../../core/runtime/worker-runtime';

/**
 * Admin panel follow-up: the scan Workers record BullMQ metrics (completed AND failed, one-minute points, a week kept),
 * which is what the API's Health chart reads with `Queue.getMetrics`. Real Redis, real scan lock (crewflow_app), a
 * random prefix (nothing here sees or touches another run's keys or the API's `bull:` queues).
 */
jest.setTimeout(120_000);
const REDIS_URL = process.env.REDIS_URL;
const DB_URL = process.env.DATABASE_URL;
const describeIf = REDIS_URL && DB_URL ? describe : describe.skip;
const quietLogger = { log: () => undefined, warn: () => undefined, error: () => undefined } as unknown as Logger;

describeIf('BullMQ Worker metrics (integration, real Redis)', () => {
  let redis: Redis;
  const prefix = `crewflow:it-metrics-${randomBytes(4).toString('hex')}:bull`;

  beforeAll(async () => {
    redis = new Redis(REDIS_URL!, { maxRetriesPerRequest: null });
    await redis.ping();
  });
  afterAll(async () => {
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}:*`, 'COUNT', 1000);
      cursor = next;
      if (keys.length) await redis.del(...keys);
    } while (cursor !== '0');
    await redis.quit();
  });

  it('scan Workers count completed and failed jobs into the metrics keys (numbers only, bounded to one week)', async () => {
    const defs = SCAN_JOBS.filter((d) => ['email-dispatch', 'offer-expiry'].includes(d.jobName));
    const conn = new Redis(REDIS_URL!, { maxRetriesPerRequest: null });
    const runtime = new WorkerRuntime(conn, { statsKey: `${prefix}:stats`, statsWrite: 'fields', metricsLogMs: 0 });
    jest.spyOn((runtime as unknown as { logger: Logger }).logger, 'warn').mockImplementation(() => undefined);
    jest.spyOn((runtime as unknown as { logger: Logger }).logger, 'error').mockImplementation(() => undefined);
    const registry = buildHandlerRegistry([
      { queue: defs[0]!.queue, jobName: defs[0]!.jobName, source: 'ok', handler: async () => true },
      { queue: defs[1]!.queue, jobName: defs[1]!.jobName, source: 'failing', handler: async () => Promise.reject(new Error('boom: row value x@y')) },
    ]);
    const scheduler: BullmqScheduler = await startBullmqScheduler({
      redis: conn, redisUrl: REDIS_URL!, lockUrl: DB_URL!, prefix, reconcileMs: 2_000, runtime, registry, jobs: defs, intervalOf: () => 1_000, logger: quietLogger,
    });
    await new Promise((r) => setTimeout(r, 6_000));
    // Workers closed BEFORE the runtime's shutdown flag: a job delivered after the flag returns 'skipped-shutdown',
    // which BullMQ records as completed, so the main.ts order would let a skipped tick on the failing queue count as
    // "completed" here. This test measures real handler outcomes only; skipped-tick counting is a separate question.
    scheduler.manager.stop();
    await closeWorkersBounded(scheduler.scanWorkers, 10_000, quietLogger);
    runtime.beginShutdown();
    await scheduler.manager.close();
    await scheduler.scanLock.close();
    await conn.quit();

    const okQueue = new Queue(defs[0]!.queue, { connection: redis, prefix });
    const failQueue = new Queue(defs[1]!.queue, { connection: redis, prefix });
    const completed = await okQueue.getMetrics('completed');
    const failed = await failQueue.getMetrics('failed');
    // Before the first minute rolls over, BullMQ keeps the count in `meta.count` (the data list fills per minute).
    expect(completed.meta.count).toBeGreaterThanOrEqual(2);
    expect(failed.meta.count).toBeGreaterThanOrEqual(2);
    expect((await failQueue.getMetrics('completed')).meta.count).toBe(0);
    await okQueue.close();
    await failQueue.close();

    // The metrics keys hold counters and timestamps only — never job data, failure text or ids.
    for (const key of [`${prefix}:${defs[0]!.queue}:metrics:completed`, `${prefix}:${defs[1]!.queue}:metrics:failed`]) {
      const meta = await redis.hgetall(key);
      expect(Object.keys(meta).sort()).toEqual(['count', 'prevCount', 'prevTS']);
      for (const v of Object.values(meta)) expect(v).toMatch(/^\d+$/);
      const points = await redis.lrange(`${key}:data`, 0, -1);
      for (const p of points) expect(p).toMatch(/^\d+$/);
      expect(points.length).toBeLessThanOrEqual(10_080);
    }
  });
});
