import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { Job, Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { randomBytes } from 'node:crypto';

import { bullmqWorkerOptionsOf, QUEUE_SETTINGS } from '@rab/server/engine/worker-shared/queue-registry';
import { createConsumerWorkers } from '../../core/scheduler/bullmq-scheduler';
import { buildHandlerRegistry } from '../../core/scheduler/processor-explorer';
import { CONSUMER_QUEUES } from '../../core/scheduler/queue-registry';

/**
 * Phase D-Q1 against a REAL Redis (the disposable test Redis): the four consumer Workers built by createConsumerWorkers
 *  - run with every option from the queue registry (concurrency, lockDuration, maxStalledCount, stalledInterval — the
 *    pre-D-Q1 effective values), and
 *  - FAIL CLOSED on a job whose name the registry does not list for the queue: the job lands in BullMQ's failed set after
 *    ONE attempt (UnrecoverableError, even though it asked for 5) and the handler — the code with side effects — never
 *    runs; a registered name on the same queue is handled normally.
 * Pre-D-Q1 the same `bogus` job on rab-email was handed to the email send handler (it would have sent the email).
 * The consumer queues use BullMQ's default `bull` prefix (as in production), so the suite runs only on the disposable test
 * Redis; its job ids carry a random run token, assertions look only at those jobs, and it removes them afterwards.
 */
jest.setTimeout(60_000);
const REDIS_URL = process.env.REDIS_URL;
const describeIf = REDIS_URL ? describe : describe.skip;
const ORG = '00000000-0000-4000-8000-00000000000a';
const RUN = randomBytes(4).toString('hex');
const quietLogger = { log: () => undefined, warn: () => undefined, error: () => undefined } as unknown as Logger;

async function until<T>(probe: () => Promise<T | undefined>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

describeIf('consumer Workers from the queue registry (D-Q1, real Redis)', () => {
  let redis: Redis;
  let workers: Map<string, Worker> | undefined;
  const handled: Array<{ queue: string; name: string; id: string }> = [];
  const mine = (queue: string) => handled.filter((h) => h.queue === queue && h.id.startsWith(`dq1.${RUN}.`));
  const added: Job[] = [];

  beforeAll(async () => {
    redis = new Redis(REDIS_URL!, { maxRetriesPerRequest: null });
    const registry = buildHandlerRegistry(
      Object.values(CONSUMER_QUEUES).map((q) => ({
        queue: q.name,
        jobName: q.jobName,
        source: `test.${q.key}`,
        handler: async (job: Job) => void handled.push({ queue: q.name, name: job.name, id: String(job.id) }),
      })),
    );
    workers = createConsumerWorkers(registry, redis, quietLogger);
  });

  afterAll(async () => {
    for (const w of workers?.values() ?? []) await w.close();
    for (const job of added) await job.remove().catch(() => undefined);
    await redis.quit();
  });

  it('every consumer Worker runs with the registry options (= the pre-D-Q1 effective values)', () => {
    for (const def of Object.values(CONSUMER_QUEUES)) {
      const w = workers!.get(def.key)!;
      const expected = bullmqWorkerOptionsOf(def.name);
      expect({ concurrency: w.opts.concurrency, lockDuration: w.opts.lockDuration, maxStalledCount: w.opts.maxStalledCount, stalledInterval: w.opts.stalledInterval }).toEqual(expected);
      expect(w.opts.prefix ?? 'bull').toBe('bull');
    }
    expect(bullmqWorkerOptionsOf('rab-ai').lockDuration).toBe(60_000);
  });

  it.each(Object.values(CONSUMER_QUEUES).map((d) => [d.name, d] as const))('%s: an unregistered job name is failed after one attempt and never handled; a registered one is handled', async (name, def) => {
    const queue = new Queue(name, { connection: redis });
    try {
      const bogus = await queue.add('bogus-job', { emailOutboxId: ORG, pushDeliveryId: ORG, organisationId: ORG }, { jobId: `dq1.${RUN}.${def.key}.bogus`, attempts: 5 });
      added.push(bogus);
      const failed = await until(async () => ((await bogus.getState()) === 'failed' ? await Job.fromId(queue, bogus.id!) : undefined));
      expect(failed!.attemptsMade).toBe(1);
      expect(failed!.failedReason).toBe(`unknown job name for ${name}`);
      expect(mine(name)).toEqual([]);

      for (const jobName of QUEUE_SETTINGS[def.name].jobNames) {
        const ok = await queue.add(jobName, { organisationId: ORG }, { jobId: `dq1.${RUN}.${def.key}.${jobName}`, attempts: 1 });
        added.push(ok);
        await until(async () => ((await ok.getState()) === 'completed' ? true : undefined));
      }
      expect(mine(name).map((h) => h.name)).toEqual([...QUEUE_SETTINGS[def.name].jobNames]);
    } finally {
      await queue.close();
    }
  });
});
