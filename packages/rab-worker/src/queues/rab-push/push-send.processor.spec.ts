import type { Job } from 'bullmq';

import { PushDelivery } from '@rab/server/engine/core-modules/push/entities/push-delivery.entity';
import { PushDevice } from '@rab/server/engine/core-modules/push/entities/push-device.entity';
import { Notification } from '@rab/server/modules/notification/entities/notification.entity';

import { createPushSendProcessor, type PushSendProcessorDeps } from './push-send.processor';

/**
 * E8 (D0-C §3.3) and completion correctness, over a fake tenant context (no database, no provider).
 *  - A push_delivery row that is not visible yet must FAIL this attempt (BullMQ retries the SAME job with its backoff —
 *    no add(), so no jobId dedupe), never complete: a completed `push-delivery.<id>.attempt.0` is retained 7 days and the
 *    dispatcher's re-add of that jobId is silently dropped, stranding the row PENDING.
 *  - After the provider accepted the push, a failure to persist ACCEPTED must never be treated as a provider failure
 *    (RETRY → a duplicate real push): it is retried locally and otherwise left PROCESSING for the dispatcher's
 *    stale-lease recovery (DELIVERY_UNCERTAIN), exactly like email's persistSent.
 */
const ORG = '00000000-0000-4000-8000-000000000002';
const ID = '00000000-0000-4000-8000-000000000001';

interface Fake {
  rows: { delivery: Record<string, unknown> | null; device: Record<string, unknown> | null; notification: Record<string, unknown> | null };
  writes: Array<Record<string, unknown>>;
  failAcceptedWrites: number;
}

function fakeDeps(f: Fake, send: jest.Mock): PushSendProcessorDeps {
  const manager = {
    findOne: async (entity: unknown) => {
      if (entity === PushDelivery) return f.rows.delivery;
      if (entity === PushDevice) return f.rows.device;
      if (entity === Notification) return f.rows.notification;
      return null;
    },
    createQueryBuilder: () => {
      let values: Record<string, unknown> = {};
      const qb = {
        update: () => qb,
        set: (v: Record<string, unknown>) => {
          values = v;
          return qb;
        },
        where: () => qb,
        returning: () => qb,
        execute: async () => {
          if (values.status === 'ACCEPTED' && f.failAcceptedWrites > 0) {
            f.failAcceptedWrites -= 1;
            throw new Error('connection terminated unexpectedly');
          }
          f.writes.push(values);
          // D-Q5b: the claim counts the attempt in SQL and returns the new count (RETURNING); first attempt here.
          return { affected: 1, raw: [{ attempt_count: 1, max_attempts: 5 }] };
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

function visible(): Fake['rows'] {
  return {
    delivery: { id: ID, organisationId: ORG, status: 'PENDING', pushDeviceId: 'd1', notificationId: 'n1', maxAttempts: 5 },
    device: { id: 'd1', active: true, pushTokenEncrypted: 'x', platform: 'android' },
    notification: { id: 'n1', type: 'OFFER_RECEIVED' },
  };
}

const job = { data: { pushDeliveryId: ID, organisationId: ORG }, attemptsMade: 0 } as unknown as Job;

describe('push send processor — E8 visibility and completion correctness', () => {
  it('a row that is not visible yet fails the attempt (BullMQ retries the same job) instead of completing, and sends nothing', async () => {
    const send = jest.fn();
    const f: Fake = { rows: { delivery: null, device: null, notification: null }, writes: [], failAcceptedWrites: 0 };
    await expect(createPushSendProcessor(fakeDeps(f, send))(job)).rejects.toThrow(/not visible yet/);
    expect(send).not.toHaveBeenCalled();
    expect(f.writes).toEqual([]);
  });

  it('the not-visible failure is a plain (retryable) error, never UnrecoverableError', async () => {
    const f: Fake = { rows: { delivery: null, device: null, notification: null }, writes: [], failAcceptedWrites: 0 };
    const error = await createPushSendProcessor(fakeDeps(f, jest.fn()))(job).catch((e: Error) => e);
    expect((error as Error).name).not.toBe('UnrecoverableError');
  });

  it('terminal rows still complete quietly (ACCEPTED / CANCELLED): nothing to retry', async () => {
    for (const status of ['ACCEPTED', 'CANCELLED']) {
      const send = jest.fn();
      const f: Fake = { rows: { ...visible(), delivery: { ...visible().delivery!, status } }, writes: [], failAcceptedWrites: 0 };
      await expect(createPushSendProcessor(fakeDeps(f, send))(job)).resolves.toBeUndefined();
      expect(send).not.toHaveBeenCalled();
    }
  });

  it('a transient failure writing ACCEPTED after the provider accepted is retried locally — never RETRY, never a second send', async () => {
    const send = jest.fn(async () => ({ provider: 'fake-fcm', providerMessageId: 'm1' }));
    const f: Fake = { rows: visible(), writes: [], failAcceptedWrites: 1 };
    await expect(createPushSendProcessor(fakeDeps(f, send))(job)).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
    expect(f.writes.map((w) => w.status).filter(Boolean)).toEqual(['PROCESSING', 'ACCEPTED']);
  });

  it('if ACCEPTED cannot be persisted at all, the attempt fails loudly but leaves the row PROCESSING (recovery → DELIVERY_UNCERTAIN), never RETRY/FAILED', async () => {
    const send = jest.fn(async () => ({ provider: 'fake-fcm' }));
    const f: Fake = { rows: visible(), writes: [], failAcceptedWrites: 99 };
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(createPushSendProcessor(fakeDeps(f, send))(job)).rejects.toThrow(/connection terminated/);
    errorSpy.mockRestore();
    expect(send).toHaveBeenCalledTimes(1);
    expect(f.writes.map((w) => w.status).filter(Boolean)).toEqual(['PROCESSING']);
  });

  it('a provider failure is still classified (RETRY, then rethrown for the BullMQ backoff)', async () => {
    const send = jest.fn(async () => {
      throw Object.assign(new Error('unavailable'), { name: 'PushSendError' });
    });
    const f: Fake = { rows: visible(), writes: [], failAcceptedWrites: 0 };
    await expect(createPushSendProcessor(fakeDeps(f, send))(job)).rejects.toThrow(/unavailable/);
    expect(f.writes.map((w) => w.status).filter(Boolean)).toEqual(['PROCESSING', 'RETRY']);
  });
});
