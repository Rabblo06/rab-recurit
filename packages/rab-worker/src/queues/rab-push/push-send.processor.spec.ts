import { type Job, UnrecoverableError } from 'bullmq';

import { AuditAction } from '@rab/server/engine/core-modules/audit/audit.service';
import { PushSendError } from '@rab/server/engine/core-modules/push/drivers/interfaces/push-driver.interface';

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
  /** Throw from the device read (a database fault during revalidation). */
  failDeviceRead?: boolean;
  /** The fenced provider-call marker write finds another claim owns the row (affected: 0). */
  markerTokenLost?: boolean;
  /** attempt_count / max_attempts the claim's RETURNING reports (default 1 / 5). */
  claimed?: { attempt_count: number; max_attempts: number };
  audits?: Array<{ action: string; opts: Record<string, unknown> }>;
}

function fakeDeps(f: Fake, send: jest.Mock): PushSendProcessorDeps {
  // Each runInTenantContext call is one transaction: its writes reach `f.writes` only if the callback resolves (a throw
  // rolls them back, as PostgreSQL would).
  let pending: Array<Record<string, unknown>> = [];
  const manager = {
    findOne: async (entity: unknown) => {
      if (entity === PushDelivery) return f.rows.delivery;
      if (entity === PushDevice && f.failDeviceRead) throw new Error('canceling statement due to statement timeout');
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
          if (f.markerTokenLost && typeof values.providerCallStartedAt === 'function') return { affected: 0, raw: [] };
          pending.push(values);
          // D-Q5b: the claim counts the attempt in SQL and returns the new count (RETURNING); first attempt by default.
          return { affected: 1, raw: [f.claimed ?? { attempt_count: 1, max_attempts: 5 }] };
        },
      };
      return qb;
    },
  };
  return {
    tenantContext: {
      runInTenantContext: async (_ctx: unknown, fn: (m: unknown) => Promise<unknown>) => {
        pending = [];
        const result = await fn(manager);
        f.writes.push(...pending);
        pending = [];
        return result;
      },
    },
    pushService: { send },
    secretEncryption: { decrypt: () => 'device-token' },
    pushDeviceService: { deactivateInvalidToken: jest.fn() },
    auditService: {
      record: jest.fn(async (_m: unknown, _ctx: unknown, action: string, opts: Record<string, unknown>) => {
        (f.audits ??= []).push({ action, opts });
      }),
    },
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

/**
 * Mirrors email-send.processor.ts: revalidation runs in its own transaction after the counted claim committed, so a
 * database fault there is a failed attempt (RETRY / FAILED at the cap) instead of rolling the claim back (the unbounded
 * retry loop email fixed). A FAILED attempt is audited (PUSH_DELIVERY_FAILED), the way email audits EMAIL_DELIVERY_FAILED.
 */
describe('push send processor — revalidation outside the claim, failure audit', () => {
  const statuses = (f: Fake) => f.writes.map((w) => w.status).filter(Boolean);

  it("the claim clears the previous attempt's provider-call marker", async () => {
    const f: Fake = { rows: visible(), writes: [], failAcceptedWrites: 0 };
    await createPushSendProcessor(fakeDeps(f, jest.fn(async () => ({ provider: 'fake-fcm' }))))(job);
    const claim = f.writes.find((w) => w.status === 'PROCESSING')!;
    expect(claim).toHaveProperty('providerCallStartedAt', null);
  });

  it('a database fault during revalidation keeps the counted claim and ends the attempt RETRY, sending nothing', async () => {
    const send = jest.fn();
    const f: Fake = { rows: visible(), writes: [], failAcceptedWrites: 0, failDeviceRead: true };
    const error = await createPushSendProcessor(fakeDeps(f, send))(job).catch((e: Error) => e);
    expect(send).not.toHaveBeenCalled();
    // Old code: the fault rolled the claim back with its count (no writes at all), so the row never reached its cap.
    expect(statuses(f)).toEqual(['PROCESSING', 'RETRY']);
    expect(f.writes.find((w) => w.status === 'RETRY')).toMatchObject({ attemptCount: 1, lastErrorCode: 'REVALIDATION_FAILED' });
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).not.toBe('UnrecoverableError'); // BullMQ backoff applies
    expect(f.audits ?? []).toEqual([]); // not final: no failure audit yet
  });

  it('a database fault during revalidation on the last allowed attempt ends FAILED and is audited', async () => {
    const f: Fake = { rows: visible(), writes: [], failAcceptedWrites: 0, failDeviceRead: true, claimed: { attempt_count: 5, max_attempts: 5 } };
    await expect(createPushSendProcessor(fakeDeps(f, jest.fn()))(job)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(statuses(f)).toEqual(['PROCESSING', 'FAILED']);
    expect(f.audits).toEqual([
      {
        action: AuditAction.PUSH_DELIVERY_FAILED,
        opts: expect.objectContaining({
          entityType: 'push_delivery',
          entityId: ID,
          actorUserId: null,
          metadata: { pushDeliveryId: ID, notificationId: 'n1', errorCode: 'REVALIDATION_FAILED', attempts: 5, retryable: true },
        }),
      },
    ]);
  });

  it('a permanent provider failure ends FAILED with one audit row carrying no token or notification content', async () => {
    const send = jest.fn(async () => {
      throw new PushSendError('Requested entity was not found.', false, false, 'messaging/registration-token-not-registered');
    });
    const f: Fake = { rows: visible(), writes: [], failAcceptedWrites: 0 };
    await expect(createPushSendProcessor(fakeDeps(f, send))(job)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(statuses(f)).toEqual(['PROCESSING', 'FAILED']);
    expect(f.audits).toHaveLength(1);
    expect(f.audits![0]!.action).toBe('push.delivery_failed');
    expect(f.audits![0]!.opts.metadata).toEqual({
      pushDeliveryId: ID, notificationId: 'n1', errorCode: 'messaging/registration-token-not-registered', attempts: 1, retryable: false,
    });
    expect(JSON.stringify(f.audits)).not.toContain('device-token');
  });

  it('a retryable provider failure below the cap is not audited (RETRY only)', async () => {
    const send = jest.fn(async () => {
      throw new PushSendError('unavailable', true);
    });
    const f: Fake = { rows: visible(), writes: [], failAcceptedWrites: 0 };
    await expect(createPushSendProcessor(fakeDeps(f, send))(job)).rejects.toThrow(/unavailable/);
    expect(statuses(f)).toEqual(['PROCESSING', 'RETRY']);
    expect(f.audits ?? []).toEqual([]);
  });

  it('a successful send writes no failure audit', async () => {
    const f: Fake = { rows: visible(), writes: [], failAcceptedWrites: 0 };
    await createPushSendProcessor(fakeDeps(f, jest.fn(async () => ({ provider: 'fake-fcm' }))))(job);
    expect(statuses(f)).toEqual(['PROCESSING', 'ACCEPTED']);
    expect(f.audits ?? []).toEqual([]);
  });

  it('a lost token at the provider-call marker sends nothing and writes nothing more', async () => {
    const send = jest.fn(async () => ({ provider: 'fake-fcm' }));
    const f: Fake = { rows: visible(), writes: [], failAcceptedWrites: 0, markerTokenLost: true };
    const deps = fakeDeps(f, send);
    await expect(createPushSendProcessor(deps)(job)).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
    // Only the claim committed: no marker, no RETRY/FAILED/ACCEPTED/CANCELLED, no audit.
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]).toMatchObject({ status: 'PROCESSING' });
    expect(f.audits ?? []).toEqual([]);
    expect((deps.pushDeviceService as unknown as { deactivateInvalidToken: jest.Mock }).deactivateInvalidToken).not.toHaveBeenCalled();
  });
});
