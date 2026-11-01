import { randomBytes } from 'node:crypto';

/**
 * Lead follow-up (C-report §6.1): the Worker's own queue producers fail fast. The shift-statement producer gets its own
 * fail-fast connection (Agent C's helper, `@rab/server/engine/worker-shared/queue-producer-connection`) and every `add`
 * is bounded, so a Redis outage rejects the publish within seconds — the dispatcher records `publishFailed`, the claimed
 * row stays for its lease / the next claim, and the queue's runner is never wedged.
 *
 * The compiled `@rab/server` dist predates C's helper (built before this wave), so the spec maps the helper to its SOURCE
 * (C's real code, not a stand-in). Once the server dist is rebuilt the mapping is a no-op.
 */
jest.mock(
  '@rab/server/engine/worker-shared/queue-producer-connection',
  () => jest.requireActual('../../../../rab-server/src/engine/worker-shared/queue-producer-connection'),
  { virtual: true },
);

// eslint-disable-next-line import/first
import { createQueueProducerConnection } from '@rab/server/engine/worker-shared/queue-producer-connection';
// eslint-disable-next-line import/first
import { BoundedProducerQueue } from './bounded-producer-queue';

jest.setTimeout(20_000);

describe('BoundedProducerQueue', () => {
  it('Redis unreachable: add() rejects with QueuePublishUnavailableError within a few seconds (never hangs, nothing buffered)', async () => {
    const connection = createQueueProducerConnection('redis://127.0.0.1:1');
    const queue = new BoundedProducerQueue<{ v: number }>('phase-d-bounded-unreachable', connection, 'test publish');
    const startedAt = Date.now();
    await expect(queue.add('job', { v: 1 }, { jobId: 'x.attempt.0' })).rejects.toMatchObject({ name: 'QueuePublishUnavailableError' });
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    await queue.closeBounded();
  });

  const describeIfRedis = process.env.REDIS_URL ? describe : describe.skip;
  describeIfRedis('Redis reachable', () => {
    it('add() publishes normally with the caller\'s jobId (no behaviour change when Redis is up)', async () => {
      const name = `phase-d-bounded-${randomBytes(4).toString('hex')}`;
      const connection = createQueueProducerConnection(process.env.REDIS_URL!);
      const queue = new BoundedProducerQueue<{ v: number }>(name, connection, 'test publish');
      const job = await queue.add('job', { v: 2 }, { jobId: 'shift-statement.abc.gen.3', attempts: 1 });
      expect(job.id).toBe('shift-statement.abc.gen.3');
      await queue.obliterate({ force: true });
      await queue.closeBounded();
    });
  });
});
