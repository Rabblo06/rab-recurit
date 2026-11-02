import { Queue } from 'bullmq';
import Redis from 'ioredis';

import { EnvironmentService } from '../environment/environment.service';
import { PushQueueService, PUSH_QUEUE_JOB_OPTIONS } from '../push/push-queue.service';
import { EMAIL_QUEUE_NAME } from './email-queue.constants';
import { EmailOutboxService } from './email-outbox.service';
import { EmailQueueService, EMAIL_QUEUE_JOB_OPTIONS } from './email-queue.service';

/**
 * D5 (D0-C §1.4 / §4.12): the email and push queue PRODUCERS (API fast publish, admin replay, Worker dispatchers) used
 * an ioredis client with the offline queue on, maxRetriesPerRequest null and no command timeout — during a Redis outage
 * a publish never failed: the admin replay request hung and Worker dispatch cycles stalled. A failed publish is safe
 * (the outbox row is durable; the dispatcher republishes it), so the producers now fail fast and bounded.
 * Also: retry backoff gets jitter (synchronised retries after an outage hit the provider together).
 */
const UNREACHABLE = 'redis://127.0.0.1:1';
const env = (url: string) => ({ get: (key: string) => (key === 'REDIS_URL' ? url : undefined) }) as unknown as EnvironmentService;
const ID = '11111111-1111-4111-8111-111111111111';
const ORG = '22222222-2222-4222-8222-222222222222';

async function elapsed(fn: () => Promise<unknown>): Promise<{ ms: number; error: unknown }> {
  const started = Date.now();
  try {
    await fn();
    return { ms: Date.now() - started, error: null };
  } catch (error) {
    return { ms: Date.now() - started, error };
  }
}

describe.each([
  ['email', (url: string) => new EmailQueueService(env(url)), EMAIL_QUEUE_JOB_OPTIONS],
  ['push', (url: string) => new PushQueueService(env(url)), PUSH_QUEUE_JOB_OPTIONS],
] as const)('%s queue producer', (_name, make, jobOptions) => {
  it('retries back off exponentially WITH jitter (same 5 attempts, same 5 s base)', () => {
    expect(jobOptions).toMatchObject({ attempts: 5, backoff: { type: 'exponential', delay: 5_000 } });
    expect(jobOptions.backoff.jitter).toBeGreaterThan(0);
    expect(jobOptions.backoff.jitter).toBeLessThanOrEqual(1);
  });

  it('its Redis client has no offline queue and a bounded command timeout', async () => {
    const service = make(UNREACHABLE);
    const connection = (service as unknown as { connection: Redis }).connection;
    expect(connection.options.enableOfflineQueue).toBe(false);
    expect(connection.options.commandTimeout).toBeGreaterThan(0);
    expect(connection.options.commandTimeout).toBeLessThanOrEqual(5_000);
    expect(connection.options.maxRetriesPerRequest).not.toBeNull();
    await service.onModuleDestroy();
  });

  it('with Redis unreachable, publish and republish reject quickly with a clear error instead of hanging', async () => {
    const service = make(UNREACHABLE);
    try {
      for (const call of [() => service.publish(ID, ORG), () => service.republish(ID, ORG, 3)]) {
        const { ms, error } = await elapsed(call);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(/Redis/);
        expect((error as Error).message).toMatch(/durable/);
        expect(ms).toBeLessThan(5_000);
      }
    } finally {
      const { ms } = await elapsed(() => service.onModuleDestroy());
      expect(ms).toBeLessThan(5_000);
    }
  }, 20_000);
});

describe('email fast path during a Redis outage', () => {
  it('tryFastPublish never fails and settles within the bound (the business request is never failed or held)', async () => {
    const queue = new EmailQueueService(env(UNREACHABLE));
    const outbox = new EmailOutboxService();
    jest.spyOn((outbox as unknown as { logger: { warn: () => void } }).logger, 'warn').mockImplementation(() => undefined);
    try {
      const { ms, error } = await elapsed(() => outbox.tryFastPublish((id, org) => queue.publish(id, org), { id: ID, organisationId: ORG }));
      expect(error).toBeNull();
      expect(ms).toBeLessThan(5_000);
    } finally {
      await queue.onModuleDestroy();
    }
  }, 20_000);
});

const REDIS_URL = process.env.REDIS_URL;
(REDIS_URL ? describe : describe.skip)('email queue producer against the disposable test Redis', () => {
  it('publishes jobId email-outbox.<id>.attempt.0 / .attempt.<gen> with the jittered options (convention unchanged)', async () => {
    const service = new EmailQueueService(env(REDIS_URL!));
    const reader = new Queue(EMAIL_QUEUE_NAME, { connection: new Redis(REDIS_URL!, { maxRetriesPerRequest: null }) });
    const id = `d5-${Date.now()}`;
    try {
      await service.publish(id, ORG);
      await service.republish(id, ORG, 2);
      const first = await reader.getJob(`email-outbox.${id}.attempt.0`);
      const second = await reader.getJob(`email-outbox.${id}.attempt.2`);
      expect(first?.data).toEqual({ emailOutboxId: id, organisationId: ORG });
      expect(second?.opts.backoff).toMatchObject({ type: 'exponential', delay: 5_000, jitter: EMAIL_QUEUE_JOB_OPTIONS.backoff.jitter });
      await first?.remove();
      await second?.remove();
    } finally {
      await reader.close();
      await (reader.opts.connection as Redis).quit?.().catch(() => undefined);
      await service.onModuleDestroy();
    }
  });
});
