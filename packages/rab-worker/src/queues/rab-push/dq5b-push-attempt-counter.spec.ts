import { type Job, UnrecoverableError } from 'bullmq';

import { PushDelivery } from '@rab/server/engine/core-modules/push/entities/push-delivery.entity';
import { PushDevice } from '@rab/server/engine/core-modules/push/entities/push-device.entity';
import { PushSendError } from '@rab/server/engine/core-modules/push/drivers/interfaces/push-driver.interface';
import { Notification } from '@rab/server/modules/notification/entities/notification.entity';

import { createPushSendProcessor, type PushSendProcessorDeps } from './push-send.processor';

/**
 * D-Q5b (docs/PHASE_DQ4_DQ5_PLAN_2026-11-03.md §5.1; owner approval 2026-11-04 OC-1): push `attempt_count` is cumulative
 * across dispatch generations, exactly like email's `infrastructure_attempt_count`. Before, every write used
 * `job.attemptsMade + 1`, so a row republished under a new generation (new BullMQ job, attemptsMade back at 0) restarted
 * at 1 and `isFinal` compared the NEW job's count against `max_attempts`: the cap of 5 applied per generation.
 *
 * Unit level, scripted fake manager that applies the claim's `attempt_count + 1` and `attempt_count < max_attempts` gate the
 * way PostgreSQL would. The real-database version is `dq5b-cumulative-attempts.integration.spec.ts`.
 */
const ORG = '00000000-0000-4000-8000-000000000002';
const ID = '00000000-0000-4000-8000-000000000001';

interface Fake {
  delivery: Record<string, unknown>;
  writes: Array<Record<string, unknown>>;
}

function fakeDeps(f: Fake, send: jest.Mock): PushSendProcessorDeps {
  const manager = {
    findOne: async (entity: unknown) => {
      if (entity === PushDelivery) return { ...f.delivery };
      if (entity === PushDevice) return { id: 'd1', active: true, pushTokenEncrypted: 'x', platform: 'android' };
      if (entity === Notification) return { id: 'n1', type: 'OFFER_RECEIVED' };
      return null;
    },
    createQueryBuilder: () => {
      let values: Record<string, unknown> = {};
      let where = '';
      let params: Record<string, unknown> = {};
      const qb = {
        update: () => qb,
        set: (v: Record<string, unknown>) => {
          values = v;
          return qb;
        },
        where: (w: string, p: Record<string, unknown>) => {
          where = w;
          params = p ?? {};
          return qb;
        },
        returning: () => qb,
        execute: async () => {
          const row = f.delivery;
          if (Array.isArray(params.open) && !(params.open as string[]).includes(row.status as string)) return { affected: 0, raw: [] };
          if (params.token !== undefined && (row.status !== 'PROCESSING' || row.processingToken !== params.token)) return { affected: 0, raw: [] };
          if (where.includes('attempt_count < max_attempts') && (row.attemptCount as number) >= (row.maxAttempts as number)) return { affected: 0, raw: [] };
          f.writes.push(values);
          if (typeof values.status === 'string') row.status = values.status;
          if (typeof values.processingToken === 'string') row.processingToken = values.processingToken;
          if (typeof values.attemptCount === 'function') row.attemptCount = (row.attemptCount as number) + 1;
          else if (typeof values.attemptCount === 'number') row.attemptCount = values.attemptCount;
          return { affected: 1, raw: [{ attempt_count: row.attemptCount, max_attempts: row.maxAttempts }] };
        },
      };
      return qb;
    },
  };
  return {
    tenantContext: { runInTenantContext: async (_ctx: unknown, fn: (m: unknown) => Promise<unknown>) => fn(manager) },
    pushService: { send },
    secretEncryption: { decrypt: () => 'device-token' },
    pushDeviceService: { deactivateInvalidToken: jest.fn() },
  } as unknown as PushSendProcessorDeps;
}

const delivery = (attemptCount: number, status = 'PENDING') => ({
  id: ID, organisationId: ORG, status, pushDeviceId: 'd1', notificationId: 'n1', attemptCount, maxAttempts: 5, processingToken: null,
});
const jobOf = (attemptsMade: number) => ({ data: { pushDeliveryId: ID, organisationId: ORG }, attemptsMade }) as unknown as Job;
const retryable = () => new PushSendError('unavailable', true);
const statusWrites = (f: Fake) =>
  f.writes.filter((w) => typeof w.status === 'string').map((w) => ({ status: w.status, count: typeof w.attemptCount === 'function' ? '+1' : w.attemptCount }));

describe('D-Q5b (OC-1): push attempt_count is cumulative across generations', () => {
  it('the claim counts the attempt in SQL; ACCEPTED records the cumulative count', async () => {
    const f: Fake = { delivery: delivery(0), writes: [] };
    const send = jest.fn(async () => ({ provider: 'fake-fcm', providerMessageId: 'm1' }));
    await createPushSendProcessor(fakeDeps(f, send))(jobOf(0));
    expect(statusWrites(f)).toEqual([{ status: 'PROCESSING', count: '+1' }, { status: 'ACCEPTED', count: 1 }]);
  });

  it('a republished row (prior count 3) accepted on its first new-generation attempt records 4, not 1', async () => {
    const f: Fake = { delivery: delivery(3), writes: [] };
    await createPushSendProcessor(fakeDeps(f, jest.fn(async () => ({ provider: 'fake-fcm' }))))(jobOf(0));
    expect(statusWrites(f).at(-1)).toEqual({ status: 'ACCEPTED', count: 4 });
  });

  it('a republished row (prior count 4, max 5) that fails retryably reaches the cap: FAILED with count 5, UnrecoverableError', async () => {
    const f: Fake = { delivery: delivery(4), writes: [] };
    const send = jest.fn(async () => {
      throw retryable();
    });
    await expect(createPushSendProcessor(fakeDeps(f, send))(jobOf(0))).rejects.toBeInstanceOf(UnrecoverableError);
    expect(statusWrites(f).at(-1)).toEqual({ status: 'FAILED', count: 5 });
  });

  it('below the cap a retryable failure is RETRY with the cumulative count (prior 1 → 2), rethrown for the backoff', async () => {
    const f: Fake = { delivery: delivery(1, 'RETRY'), writes: [] };
    const send = jest.fn(async () => {
      throw retryable();
    });
    await expect(createPushSendProcessor(fakeDeps(f, send))(jobOf(0))).rejects.toThrow(/unavailable/);
    expect(statusWrites(f).at(-1)).toEqual({ status: 'RETRY', count: 2 });
  });

  it('across generations the cap is 5 in total (3 + 2), never 5 per generation', async () => {
    const f: Fake = { delivery: delivery(0), writes: [] };
    const send = jest.fn(async () => {
      throw retryable();
    });
    const processor = createPushSendProcessor(fakeDeps(f, send));
    for (const attemptsMade of [0, 1, 2]) await expect(processor(jobOf(attemptsMade))).rejects.toThrow(/unavailable/);
    expect(f.delivery).toMatchObject({ status: 'RETRY', attemptCount: 3 });
    f.delivery.status = 'PENDING'; // the dispatcher's stale-RETRY recovery republishes a new generation (row → PENDING)
    await expect(processor(jobOf(0))).rejects.toThrow(/unavailable/);
    await expect(processor(jobOf(1))).rejects.toBeInstanceOf(UnrecoverableError);
    expect(f.delivery).toMatchObject({ status: 'FAILED', attemptCount: 5 });
    expect(send).toHaveBeenCalledTimes(5);
  });

  it('a row that already carries 5 cumulative attempts is never claimed again: no provider call', async () => {
    const f: Fake = { delivery: delivery(5, 'RETRY'), writes: [] };
    const send = jest.fn();
    await expect(createPushSendProcessor(fakeDeps(f, send))(jobOf(0))).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
    expect(f.writes).toEqual([]);
  });
});
