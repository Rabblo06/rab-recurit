/**
 * Phase A — Worker feature gating, the CONSUMER half: the real `realtime-outbox-publish` and `push-dispatch` scan
 * adapters (the exact objects the scheduler calls) against real Postgres, FORCE RLS, the restricted `crewflow_app`
 * runtime role. The scheduler is meant not to register a disabled feature's job at all (pa-intervals); this proves the
 * defence in depth behind that: when the job runs anyway, it returns idle without touching the database.
 *
 *  1. flags OFF ⇒ both adapters return `false` (idle, never stamped) with ZERO calls into the runtime DataSource
 *     (`createQueryRunner`/`query`/`transaction` — every TypeORM statement goes through one of them) or any
 *     TenantContextService entry point, no Redis PUBLISH and no BullMQ publish; rows that were already pending when the
 *     feature went off (simulated by seeding them first) are left exactly as they were.
 *  2. flags back ON ⇒ the same adapters run their unchanged cycles: those pending rows are published / dispatched
 *     (realtime: to a stub PUBLISH, row completed; push: enqueued, then sent by the real send processor through the FAKE
 *     provider, row ACCEPTED) — and the off→on backlog drains at the cycle's existing per-scope bound (25 realtime
 *     events per scope per cycle), never as one unbounded burst.
 *
 * Process env pins both flags OFF before any import (the shipped default); each adapter instead reads the per-test env
 * handed to it through WorkerDependencies, exactly as in production (`environmentService.get(...)`).
 */
process.env.REALTIME_ENABLED = 'false';
process.env.PUSH_ENABLED = 'false';

import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import { AppModule } from '@rab/server/app.module';
import { PasswordHashingService } from '@rab/server/engine/core-modules/auth/services/password-hashing.service';
import { EnvironmentService } from '@rab/server/engine/core-modules/environment/environment.service';
import { FakeFcmDriver } from '@rab/server/engine/core-modules/push/drivers/fake-fcm.driver';
import { PushDelivery } from '@rab/server/engine/core-modules/push/entities/push-delivery.entity';
import { PushDeviceService } from '@rab/server/engine/core-modules/push/push-device.service';
import { PushService } from '@rab/server/engine/core-modules/push/push.service';
import { realtimeUserChannel } from '@rab/server/engine/core-modules/realtime/realtime-envelope';
import { SecretEncryptionService } from '@rab/server/engine/core-modules/secret-encryption/secret-encryption.service';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { Notification } from '@rab/server/modules/notification/entities/notification.entity';
import { NotificationType } from '@rab/shared';
import { WorkerDependencies, WorkerJobDependencies } from '../../core/scheduler/worker-dependencies';
import { PushScanProcessor } from '../../queues/rab-push/push.processors';
import { createPushSendProcessor } from '../../queues/rab-push/push-send.processor';
import { RealtimeScanProcessor } from '../../queues/rab-realtime/realtime.processors';
import { createAdminDataSource } from './helpers/admin-datasource';
import { createTestIdentityFactory, TestIdentity, TestIdentityFactory } from './helpers/test-identities';

const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(300_000);

const BACKLOG = 30; // > the publisher's per-scope limit of 25

describeIfDb('Phase A gating — realtime publish / push dispatch adapters do no DB work when their feature is off (integration)', () => {
  let app: import('@nestjs/common').INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let tenantContext: TenantContextService;
  let env: EnvironmentService;
  let factory: TestIdentityFactory;
  let manager: TestIdentity;
  let eventIds: string[];
  let deliveryId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    dataSource = app.get(DataSource);
    tenantContext = app.get(TenantContextService);
    env = app.get(EnvironmentService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = createTestIdentityFactory({ app, dataSource, adminDataSource, tenantContext, passwordHashing: app.get(PasswordHashingService) });

    // Rows that already exist when the feature is switched off: a realtime backlog for one user and one PENDING push
    // delivery to an active device (both written exactly as the ON producers write them).
    const org = await factory.createOrganisation();
    manager = await factory.createInternalManager(org, { label: 'gate-worker' });
    // Workspace-scoped events, so exactly one scope (this workspace) can claim them — the per-scope bound below relies on it.
    if (!manager.workspaceId) throw new Error('test setup: expected the internal manager to have a workspace');
    const ctx = { organisationId: manager.organisationId, workspaceId: manager.workspaceId, userId: manager.userId, role: '' };
    const device = await app.get(PushDeviceService).register(ctx, { deviceId: `gate-w-${randomUUID()}`, platform: 'android', pushToken: 'gate-worker-token' });
    ({ eventIds, deliveryId } = await tenantContext.runInTenantContext(ctx, async (m) => {
      const ids: string[] = [];
      for (let i = 0; i < BACKLOG; i++) {
        // eslint-disable-next-line no-await-in-loop
        const [row] = await m.query<Array<{ id: string }>>(
          `INSERT INTO core.realtime_event (organisation_id, workspace_id, target_user_id, event_key, event_type, entity_type, entity_id, payload)
           VALUES ($1, $2, $3, $4, 'offer.sent', 'offer', $5, '{}'::jsonb) RETURNING id`,
          [manager.organisationId, manager.workspaceId, manager.userId, `gate-worker:${randomUUID()}`, randomUUID()],
        );
        ids.push(row!.id);
      }
      const n = await m.save(m.create(Notification, { organisationId: manager.organisationId, userId: manager.userId, type: NotificationType.OFFER_SENT, title: 'T', message: 'M' }));
      const pd = await m.save(m.create(PushDelivery, { organisationId: manager.organisationId, notificationId: n.id, pushDeviceId: device.id, maxAttempts: 3 }));
      return { eventIds: ids, deliveryId: pd.id };
    }));
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await app.close();
    await adminDataSource.destroy();
  });

  function holderWith(flags: { REALTIME_ENABLED: boolean; PUSH_ENABLED: boolean }) {
    const environmentService = { get: (key: string) => (key in flags ? flags[key as keyof typeof flags] : env.get(key as never)) };
    const deps = {
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
      runtimeDataSource: dataSource,
      directDataSource: dataSource,
      tenantContext,
      environmentService,
      pushQueue: { publish: jest.fn().mockResolvedValue(undefined), republish: jest.fn().mockResolvedValue(undefined) },
      pushService: { ambiguousDeliverySafeToRetry: false },
      realtimePublish: jest.fn().mockResolvedValue(1),
    };
    const holder = new WorkerDependencies();
    holder.provide(deps as unknown as WorkerJobDependencies);
    return { holder, deps };
  }

  async function realtimeStatuses(): Promise<Record<string, number>> {
    const rows = await adminDataSource.query<Array<{ status: string; n: number }>>(
      `SELECT status, count(*)::int n FROM core.realtime_event WHERE id = ANY($1::uuid[]) GROUP BY status`,
      [eventIds],
    );
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }

  async function deliveryRow(): Promise<{ status: string; attempt_count: number; dispatch_generation: number; updated_at: Date }> {
    const [row] = await adminDataSource.query(`SELECT status, attempt_count, dispatch_generation, updated_at FROM core.push_delivery WHERE id = $1`, [deliveryId]);
    return row;
  }

  it('flags OFF: both adapters return idle with zero runtime-DB / tenant-context / Redis / queue calls, and pending rows are untouched', async () => {
    const [{ current_user: role }] = await dataSource.query('SELECT current_user');
    expect(role).toBe('crewflow_app');
    const beforeDelivery = await deliveryRow();
    expect(await realtimeStatuses()).toEqual({ pending: BACKLOG });
    expect(beforeDelivery.status).toBe('PENDING');

    const { holder, deps } = holderWith({ REALTIME_ENABLED: false, PUSH_ENABLED: false });
    const dbSpies = (['createQueryRunner', 'query', 'transaction'] as const).map((m) => jest.spyOn(dataSource, m));
    const tenantSpies = Object.getOwnPropertyNames(Object.getPrototypeOf(tenantContext))
      .filter((name) => name !== 'constructor' && typeof (tenantContext as unknown as Record<string, unknown>)[name] === 'function')
      .map((name) => jest.spyOn(tenantContext as never, name as never));
    expect(tenantSpies.length).toBeGreaterThanOrEqual(2); // runInTenantContext + runInWorkspaceContext at least
    try {
      await expect(new RealtimeScanProcessor(holder).realtimeOutboxPublish()).resolves.toBe(false);
      await expect(new PushScanProcessor(holder).pushDispatch()).resolves.toBe(false);
      for (const spy of [...dbSpies, ...tenantSpies]) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of [...dbSpies, ...tenantSpies]) spy.mockRestore();
    }
    expect(deps.realtimePublish).not.toHaveBeenCalled();
    expect(deps.pushQueue.publish).not.toHaveBeenCalled();
    expect(deps.pushQueue.republish).not.toHaveBeenCalled();
    expect(deps.logger.log).not.toHaveBeenCalled();

    // Nothing claimed, retried, cancelled or failed — the rows wait, unchanged.
    expect(await realtimeStatuses()).toEqual({ pending: BACKLOG });
    expect(await deliveryRow()).toEqual(beforeDelivery);
  });

  it('flags back ON: the same adapters publish/dispatch the waiting rows unchanged, and the backlog drains at the existing per-scope bound', async () => {
    const { holder, deps } = holderWith({ REALTIME_ENABLED: true, PUSH_ENABLED: true });

    // Realtime: first cycle publishes at most 25 of this scope's 30 waiting events; the next cycle publishes the rest.
    await expect(new RealtimeScanProcessor(holder).realtimeOutboxPublish()).resolves.toBe(true);
    expect(await realtimeStatuses()).toEqual({ completed: 25, pending: BACKLOG - 25 });
    await new RealtimeScanProcessor(holder).realtimeOutboxPublish();
    expect(await realtimeStatuses()).toEqual({ completed: BACKLOG });
    const channel = realtimeUserChannel(env.get('NODE_ENV'), manager.userId);
    const ours = deps.realtimePublish.mock.calls.filter(([c]) => c === channel);
    expect(ours).toHaveLength(BACKLOG);
    for (const [, message] of ours) expect(JSON.parse(message as string)).toMatchObject({ type: 'offer.sent', organisationId: manager.organisationId, targetUserId: manager.userId });

    // Push: the dispatcher enqueues the waiting delivery (via the stub queue) ...
    await expect(new PushScanProcessor(holder).pushDispatch()).resolves.toBe(true);
    expect(deps.pushQueue.publish).toHaveBeenCalledWith(deliveryId, manager.organisationId);
    // ... and the real send processor delivers it through the FAKE provider (PUSH_PROVIDER=FAKE in tests).
    FakeFcmDriver.reset();
    const send = createPushSendProcessor({ tenantContext, pushService: app.get(PushService), secretEncryption: app.get(SecretEncryptionService), pushDeviceService: app.get(PushDeviceService) });
    await send({ data: { pushDeliveryId: deliveryId, organisationId: manager.organisationId }, attemptsMade: 0 } as never);
    expect((await deliveryRow()).status).toBe('ACCEPTED');
  });
});
