/**
 * Stage 6 — worker-side push dispatch/claim/send/retry/fail/invalid-token classification.
 * Real Postgres, real tenant context; the provider itself is always `FakeFcmDriver`
 * (PUSH_PROVIDER defaults to FAKE), so this suite never requires real Firebase credentials.
 * Device registration / fan-out creation itself is tested in `rab-server`'s own
 * `push-delivery.integration.spec.ts` — this file only exercises `runPushDispatchCycle`/
 * `createPushSendProcessor`, the two functions that live in THIS package.
 */
process.env.PUSH_ENABLED = 'true';

import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import { AppModule } from '@rab/server/app.module';
import { PasswordHashingService } from '@rab/server/engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { SecretEncryptionService } from '@rab/server/engine/core-modules/secret-encryption/secret-encryption.service';
import { PushDeviceService } from '@rab/server/engine/core-modules/push/push-device.service';
import { PushDeliveryService } from '@rab/server/engine/core-modules/push/push-delivery.service';
import { PushService } from '@rab/server/engine/core-modules/push/push.service';
import { FakeFcmDriver } from '@rab/server/engine/core-modules/push/drivers/fake-fcm.driver';
import { NotificationService } from '@rab/server/modules/notification/services/notification.service';
import { AuthContext } from '@rab/server/engine/core-modules/tenant/auth-context.interface';
import { NotificationType } from '@rab/shared';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';
import { runPushDispatchCycle } from '../../queues/rab-push/push-dispatch.job';
import { createPushSendProcessor } from '../../queues/rab-push/push-send.processor';

const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
// 30s was enough when this file was written; the shared dev database's organisation catalog
// (which `runPushDispatchCycle`'s `organisationIds()` scans in full, every cycle — see that
// function's own doc comment) has grown substantially since, including from this session's own
// new shift-monitor-clock-in-reminder fixtures, pushing tests 7/8's single cycle call past 30s.
// Bumped, not redesigned — the underlying full-catalog-scan cost is a pre-existing, already-
// documented architectural note for a future performance pass, not something to silently
// work around here.
jest.setTimeout(90_000);

describeIfDb('push dispatch — worker claim/send/retry/fail (integration)', () => {
  let app: import('@nestjs/common').INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let tenantContext: TenantContextService;
  let secretEncryption: SecretEncryptionService;
  let pushDeviceService: PushDeviceService;
  let pushService: PushService;
  let notificationService: NotificationService;
  let factory: TestIdentityFactory;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    dataSource = moduleRef.get(DataSource);
    tenantContext = moduleRef.get(TenantContextService);
    secretEncryption = moduleRef.get(SecretEncryptionService);
    pushDeviceService = moduleRef.get(PushDeviceService);
    pushService = moduleRef.get(PushService);
    notificationService = moduleRef.get(NotificationService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = new TestIdentityFactory({ app, dataSource, adminDataSource, tenantContext, passwordHashing: moduleRef.get(PasswordHashingService) });
  });

  afterAll(async () => {
    await app.close();
    await adminDataSource.destroy();
  });

  beforeEach(() => FakeFcmDriver.reset());

  function ctxOf(identity: TestIdentity): AuthContext {
    return { organisationId: identity.organisationId, workspaceId: identity.workspaceId, userId: identity.userId, role: '' };
  }

  async function rowFor(table: 'push_device' | 'push_delivery', id: string): Promise<Record<string, unknown> | null> {
    const rows = await adminDataSource.manager.query(`SELECT * FROM core.${table} WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }

  async function seedDeliveredNotification(org: { id: string }, manager: TestIdentity, token: string) {
    const device = await pushDeviceService.register(ctxOf(manager), { deviceId: `d-${randomUUID()}`, platform: 'ios', pushToken: token });
    await tenantContext.runInTenantContext(ctxOf(manager), (m) =>
      notificationService.notify(m, { organisationId: org.id, userId: manager.userId, type: NotificationType.OFFER_SENT, title: 'T', message: 'M' }),
    );
    const [row] = await adminDataSource.manager.query(
      `SELECT pd.id FROM core.push_delivery pd WHERE pd.push_device_id = $1 ORDER BY pd.created_at DESC LIMIT 1`,
      [device.id],
    );
    return { deviceId: device.id, deliveryId: row.id as string };
  }

  async function runProcessor(deliveryId: string, organisationId: string) {
    const processor = createPushSendProcessor({ tenantContext, pushService, secretEncryption, pushDeviceService });
    const job = { data: { pushDeliveryId: deliveryId, organisationId }, attemptsMade: 0 } as never;
    await processor(job);
  }

  it('1: a delivery whose provider call is ACCEPTED ends in ACCEPTED with a provider message id, never evidence of on-device display', async () => {
    const org = await factory.createOrganisation();
    const manager = await factory.createInternalManager(org, { label: 'pushdispatch1' });
    const { deliveryId } = await seedDeliveredNotification(org, manager, 'tok-accept');

    await runProcessor(deliveryId, org.id);
    const row = await rowFor('push_delivery', deliveryId);
    expect(row!.status).toBe('ACCEPTED');
    expect(row!.provider_message_id).toBeTruthy();
    expect(row!.accepted_at).toBeTruthy();
  });

  it('2: a RETRYABLE provider error moves the delivery to RETRY, never FAILED, while attempts remain', async () => {
    const org = await factory.createOrganisation();
    const manager = await factory.createInternalManager(org, { label: 'pushdispatch2' });
    const { deliveryId } = await seedDeliveredNotification(org, manager, 'tok-retry');
    FakeFcmDriver.behaviorForToken.set('tok-retry', { outcome: 'retryable-error' });

    await expect(runProcessor(deliveryId, org.id)).rejects.toThrow();
    const row = await rowFor('push_delivery', deliveryId);
    expect(row!.status).toBe('RETRY');
    expect(row!.attempt_count).toBe(1);
  });

  it('3: a PERMANENT (non-invalid-token) provider error moves straight to FAILED, device stays active', async () => {
    const org = await factory.createOrganisation();
    const manager = await factory.createInternalManager(org, { label: 'pushdispatch3' });
    const { deliveryId, deviceId } = await seedDeliveredNotification(org, manager, 'tok-permanent');
    FakeFcmDriver.behaviorForToken.set('tok-permanent', { outcome: 'permanent-error' });

    await expect(runProcessor(deliveryId, org.id)).rejects.toThrow();
    const row = await rowFor('push_delivery', deliveryId);
    expect(row!.status).toBe('FAILED');
    expect((await rowFor('push_device', deviceId))!.active).toBe(true); // the token itself may still be good
  });

  it('4: an INVALID-TOKEN provider error FAILS the delivery AND deactivates the device (invalid-device cleanup)', async () => {
    const org = await factory.createOrganisation();
    const manager = await factory.createInternalManager(org, { label: 'pushdispatch4' });
    const { deliveryId, deviceId } = await seedDeliveredNotification(org, manager, 'tok-invalid');
    FakeFcmDriver.behaviorForToken.set('tok-invalid', { outcome: 'invalid-token' });

    await expect(runProcessor(deliveryId, org.id)).rejects.toThrow();
    expect((await rowFor('push_delivery', deliveryId))!.status).toBe('FAILED');
    const device = await rowFor('push_device', deviceId);
    expect(device!.active).toBe(false);
    expect(device!.deactivated_reason).toBe('provider_reported_invalid_token');
  });

  it('5: a device deactivated AFTER the delivery row was created (but before the worker claims it) is revalidated and the delivery is CANCELLED, never sent to a dead registration', async () => {
    const org = await factory.createOrganisation();
    const manager = await factory.createInternalManager(org, { label: 'pushdispatch5' });
    const { deliveryId, deviceId } = await seedDeliveredNotification(org, manager, 'tok-c5');

    await adminDataSource.manager.query(`UPDATE core.push_device SET active = false WHERE id = $1`, [deviceId]);
    await runProcessor(deliveryId, org.id);

    expect((await rowFor('push_delivery', deliveryId))!.status).toBe('CANCELLED');
    expect(FakeFcmDriver.sentMessages.find((m) => m.token === 'tok-c5')).toBeUndefined(); // never actually called the provider
  });

  it('6: a duplicate claim attempt on an already-ACCEPTED delivery is a no-op — never a second provider send', async () => {
    const org = await factory.createOrganisation();
    const manager = await factory.createInternalManager(org, { label: 'pushdispatch6' });
    const { deliveryId } = await seedDeliveredNotification(org, manager, 'tok-dup');

    await runProcessor(deliveryId, org.id);
    expect(FakeFcmDriver.sentMessages.filter((m) => m.token === 'tok-dup')).toHaveLength(1);

    await runProcessor(deliveryId, org.id); // BullMQ redelivering the same completed job id
    expect(FakeFcmDriver.sentMessages.filter((m) => m.token === 'tok-dup')).toHaveLength(1); // still exactly one real send
  });

  it('7: the dispatch cycle claims a PENDING row and publishes it exactly once', async () => {
    const org = await factory.createOrganisation();
    const manager = await factory.createInternalManager(org, { label: 'pushdispatch7' });
    const { deliveryId } = await seedDeliveredNotification(org, manager, 'tok-c6');

    const published: Array<{ id: string; org: string }> = [];
    const result = await runPushDispatchCycle(
      dataSource,
      tenantContext,
      async (id, orgId) => { published.push({ id, org: orgId }); },
      async () => {},
      pushService.ambiguousDeliverySafeToRetry,
    );

    expect(published.some((p) => p.id === deliveryId)).toBe(true);
    expect(result.published).toBeGreaterThanOrEqual(1);
  });

  it('8: a stuck PROCESSING row past its lease is recovered with a bumped dispatch_generation, never re-using the old generation', async () => {
    const org = await factory.createOrganisation();
    const manager = await factory.createInternalManager(org, { label: 'pushdispatch8' });
    const { deliveryId } = await seedDeliveredNotification(org, manager, 'tok-stuck');

    await adminDataSource.manager.query(
      `UPDATE core.push_delivery SET status = 'PROCESSING', processing_at = now() - interval '20 minutes', processing_token = gen_random_uuid() WHERE id = $1`,
      [deliveryId],
    );

    const republished: Array<{ id: string; generation: number }> = [];
    await runPushDispatchCycle(dataSource, tenantContext, async () => {}, async (id, _org, generation) => { republished.push({ id, generation }); }, pushService.ambiguousDeliverySafeToRetry);

    expect(republished.find((r) => r.id === deliveryId)?.generation).toBe(1); // bumped from the default 0
  });

  it('9: a stuck row that already exhausted its attempt budget is moved straight to FAILED, never republished — same STUCK_LEASE_ATTEMPTS_EXHAUSTED contract email_outbox already proves (P2.8)', async () => {
    const org = await factory.createOrganisation();
    const manager = await factory.createInternalManager(org, { label: 'pushdispatch9' });
    const { deliveryId } = await seedDeliveredNotification(org, manager, 'tok-exhausted');

    await adminDataSource.manager.query(
      `UPDATE core.push_delivery SET status = 'PROCESSING', processing_at = now() - interval '20 minutes',
         processing_token = gen_random_uuid(), attempt_count = max_attempts WHERE id = $1`,
      [deliveryId],
    );

    // The cycle scans every organisation in this shared dev database — other orgs' own leftover
    // PENDING/stuck rows legitimately get published/republished too, so the real assertion is
    // "THIS delivery never appears in either list," never "the lists are globally empty."
    const published: string[] = [];
    const republished: string[] = [];
    await runPushDispatchCycle(
      dataSource,
      tenantContext,
      async (id) => { published.push(id); },
      async (id) => { republished.push(id); },
      pushService.ambiguousDeliverySafeToRetry,
    );

    expect(published).not.toContain(deliveryId);
    expect(republished).not.toContain(deliveryId);
    const row = await rowFor('push_delivery', deliveryId);
    expect(row!.status).toBe('FAILED');
    expect(row!.last_error_code).toBe('STUCK_LEASE_ATTEMPTS_EXHAUSTED');
  });
});
