/**
 * D-Q5b (docs/PHASE_DQ4_DQ5_PLAN_2026-11-03.md §5.1; owner approval 2026-11-04, OC-1 confirmed): push `attempt_count` is
 * cumulative across republish generations, like email's. Real PostgreSQL (RLS-bound crewflow_app runtime), the real
 * `FakeFcmDriver` provider (PUSH_PROVIDER defaults to FAKE — never a real push).
 *
 *  1. The count accumulates across retries and across generations: 3 attempts in generation 0 + dispatcher republish + 2
 *     more → FAILED at 5 (before: 5 per generation). A stale RETRY whose provider call started is DELIVERY_UNCERTAIN, never
 *     republished (push at-most-once, unchanged).
 *  2. A republished accepted push records the cumulative count; a row at the cap is never claimed again.
 *  3. The last allowed attempt dying after the provider call (PROCESSING at the cap, marker set) stays DELIVERY_UNCERTAIN —
 *     the push "uncertain" rule is unchanged by the counter (OD-6).
 *  4. Tenant isolation (a job naming another organisation sees nothing, counts nothing) and multi-replica (two consumers
 *     race one row: one provider call, one count).
 */
process.env.PUSH_ENABLED = 'true';

import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { UnrecoverableError } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import { AppModule } from '@rab/server/app.module';
import { PasswordHashingService } from '@rab/server/engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { SecretEncryptionService } from '@rab/server/engine/core-modules/secret-encryption/secret-encryption.service';
import { PushDeviceService } from '@rab/server/engine/core-modules/push/push-device.service';
import { PushService } from '@rab/server/engine/core-modules/push/push.service';
import { FakeFcmDriver } from '@rab/server/engine/core-modules/push/drivers/fake-fcm.driver';
import { NotificationService } from '@rab/server/modules/notification/services/notification.service';
import { AuthContext } from '@rab/server/engine/core-modules/tenant/auth-context.interface';
import { NotificationType } from '@rab/shared';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';
import { dispatchPushScope } from '../../queues/rab-push/push-dispatch.job';
import { createPushSendProcessor } from '../../queues/rab-push/push-send.processor';

const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(120_000);

describeIfDb('D-Q5b push: cumulative attempt cap (integration)', () => {
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

  async function assertNoContextZeroRows(): Promise<void> {
    const [flags] = await dataSource.query("SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'core.push_delivery'::regclass");
    expect(flags).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    expect(await dataSource.query('SELECT id FROM core.push_delivery')).toEqual([]);
  }
  beforeEach(async () => {
    FakeFcmDriver.reset();
    await assertNoContextZeroRows();
  });
  afterEach(assertNoContextZeroRows);

  const ctxOf = (identity: TestIdentity): AuthContext => ({ organisationId: identity.organisationId, workspaceId: identity.workspaceId, userId: identity.userId, role: '' });

  async function seed(label: string) {
    const org = await factory.createOrganisation();
    const manager = await factory.createInternalManager(org, { label });
    const token = `tok-${label}-${randomUUID().slice(0, 8)}`;
    const device = await pushDeviceService.register(ctxOf(manager), { deviceId: `d-${randomUUID()}`, platform: 'ios', pushToken: token });
    await tenantContext.runInTenantContext(ctxOf(manager), (m) =>
      notificationService.notify(m, { organisationId: org.id, userId: manager.userId, type: NotificationType.OFFER_SENT, title: 'T', message: 'M' }),
    );
    const [row] = await adminDataSource.query(`SELECT id FROM core.push_delivery WHERE push_device_id = $1 ORDER BY created_at DESC LIMIT 1`, [device.id]);
    return { org, token, deliveryId: row.id as string };
  }
  const rowOf = async (id: string) => {
    const [row] = await adminDataSource.query(
      `SELECT status, attempt_count AS count, max_attempts, dispatch_generation AS generation, last_error_code FROM core.push_delivery WHERE id = $1`,
      [id],
    );
    return row as { status: string; count: number; max_attempts: number; generation: number; last_error_code: string | null };
  };
  const setRow = (id: string, sql: string) => adminDataSource.query(`UPDATE core.push_delivery SET ${sql} WHERE id = $1`, [id]);
  const sends = (token: string) => FakeFcmDriver.sentMessages.filter((m) => m.token === token).length;
  const processor = () => createPushSendProcessor({ tenantContext, pushService, secretEncryption, pushDeviceService });
  const jobOf = (id: string, organisationId: string, attemptsMade: number) => ({ data: { pushDeliveryId: id, organisationId }, attemptsMade }) as never;
  const dispatch = async (organisationId: string) => {
    const publish = jest.fn(async () => undefined);
    const republish = jest.fn(async () => undefined);
    const result = await dispatchPushScope(tenantContext, organisationId, undefined, publish, republish, pushService.ambiguousDeliverySafeToRetry);
    return { publish, republish, result };
  };

  it('1a: OC-1 — the count accumulates across the same job retries; a stale RETRY whose provider call started stays DELIVERY_UNCERTAIN (push at-most-once, OD-6 unchanged)', async () => {
    const { org, token, deliveryId } = await seed('dq5bp1a');
    expect((await rowOf(deliveryId)).max_attempts).toBe(5);
    FakeFcmDriver.behaviorForToken.set(token, { outcome: 'retryable-error' });
    const p = processor();
    for (const attemptsMade of [0, 1, 2]) await expect(p(jobOf(deliveryId, org.id, attemptsMade))).rejects.toThrow(/retryable/);
    expect(await rowOf(deliveryId)).toMatchObject({ status: 'RETRY', count: 3, generation: 0 });
    // The BullMQ job is lost. Every one of those attempts reached the provider (marker set), and push drivers are not safe to
    // retry an ambiguous call: recovery marks it DELIVERY_UNCERTAIN and never republishes — unchanged by D-Q5b.
    await setRow(deliveryId, `updated_at = now() - interval '10 minutes'`);
    const { publish, republish } = await dispatch(org.id);
    expect(publish).not.toHaveBeenCalled();
    expect(republish).not.toHaveBeenCalled();
    expect(await rowOf(deliveryId)).toMatchObject({ status: 'FAILED', last_error_code: 'DELIVERY_UNCERTAIN', count: 3 });
    expect(sends(token)).toBe(3);
  });

  it('1b: OC-1 — across generations: 3 claims whose claimant died before the provider call, dispatcher republish (generation 1), 2 more → FAILED at 5 cumulative', async () => {
    const { org, token, deliveryId } = await seed('dq5bp1b');
    // Generation 0 used 3 attempts that never reached the provider (each claim counted; the last claimant died while PROCESSING).
    await setRow(deliveryId, `status = 'PROCESSING', processing_at = now() - interval '20 minutes', processing_token = gen_random_uuid(), attempt_count = 3`);
    const { republish } = await dispatch(org.id);
    expect(republish).toHaveBeenCalledWith(deliveryId, org.id, 1);
    expect(await rowOf(deliveryId)).toMatchObject({ status: 'PENDING', count: 3, generation: 1 });

    // The republished job starts at attemptsMade 0 — the row's count does not.
    FakeFcmDriver.behaviorForToken.set(token, { outcome: 'retryable-error' });
    const p = processor();
    await expect(p(jobOf(deliveryId, org.id, 0))).rejects.toThrow(/retryable/);
    expect(await rowOf(deliveryId)).toMatchObject({ status: 'RETRY', count: 4 });
    await expect(p(jobOf(deliveryId, org.id, 1))).rejects.toBeInstanceOf(UnrecoverableError);
    expect(await rowOf(deliveryId)).toMatchObject({ status: 'FAILED', count: 5 });
    expect(sends(token)).toBe(2);
  });

  it('2: a republished push accepted on its first new-generation attempt records the cumulative count (3 → 4)', async () => {
    const { org, token, deliveryId } = await seed('dq5bp2');
    await setRow(deliveryId, `status = 'PENDING', attempt_count = 3, dispatch_generation = 1`);
    await processor()(jobOf(deliveryId, org.id, 0));
    expect(await rowOf(deliveryId)).toMatchObject({ status: 'ACCEPTED', count: 4 });
    expect(sends(token)).toBe(1);
  });

  it('3: a row that already carries 5 attempts is never claimed again (no provider call); the dispatcher fails it as exhausted', async () => {
    const { org, token, deliveryId } = await seed('dq5bp3');
    await setRow(deliveryId, `status = 'RETRY', attempt_count = 5, updated_at = now() - interval '10 minutes'`);
    await expect(processor()(jobOf(deliveryId, org.id, 0))).resolves.toBeUndefined();
    expect(sends(token)).toBe(0);
    expect((await rowOf(deliveryId)).status).toBe('RETRY');
    const { publish, republish } = await dispatch(org.id);
    expect(publish).not.toHaveBeenCalled();
    expect(republish).not.toHaveBeenCalled();
    expect(await rowOf(deliveryId)).toMatchObject({ status: 'FAILED', last_error_code: 'STUCK_LEASE_ATTEMPTS_EXHAUSTED' });
  });

  it('4: the last allowed attempt dying after the provider call (PROCESSING at the cap, marker set) stays DELIVERY_UNCERTAIN — no resend', async () => {
    const { org, token, deliveryId } = await seed('dq5bp4');
    await setRow(
      deliveryId,
      `status = 'PROCESSING', processing_at = now() - interval '20 minutes', processing_token = gen_random_uuid(),
       provider_call_started_at = now() - interval '20 minutes', attempt_count = 5`,
    );
    const { publish, republish, result } = await dispatch(org.id);
    expect(publish).not.toHaveBeenCalled();
    expect(republish).not.toHaveBeenCalled();
    expect(result).toMatchObject({ deliveryUncertain: 1, failedExhausted: 0 });
    expect(await rowOf(deliveryId)).toMatchObject({ status: 'FAILED', last_error_code: 'DELIVERY_UNCERTAIN' });
    expect(sends(token)).toBe(0);
  });

  it("5: ABUSE — a job naming another organisation cannot see, claim or count this organisation's delivery", async () => {
    const { token, deliveryId } = await seed('dq5bp5');
    const other = await factory.createOrganisation();
    await setRow(deliveryId, `status = 'RETRY', attempt_count = 2`);
    await expect(processor()(jobOf(deliveryId, other.id, 0))).rejects.toThrow(/not visible yet/);
    expect(sends(token)).toBe(0);
    expect(await rowOf(deliveryId)).toMatchObject({ status: 'RETRY', count: 2 });
    // The other organisation's dispatcher never touches it either.
    const { result } = await dispatch(other.id);
    expect(result.claimed).toBe(0);
    await setRow(deliveryId, `status = 'CANCELLED', cancelled_at = now()`); // leave nothing claimable behind
  });

  it('6: multi-replica — two consumers (old and republished generation jobs) race one row: one provider call, count +1 once', async () => {
    const { org, token, deliveryId } = await seed('dq5bp6');
    await setRow(deliveryId, `status = 'RETRY', attempt_count = 2, dispatch_generation = 1`);
    await Promise.all([processor()(jobOf(deliveryId, org.id, 2)), processor()(jobOf(deliveryId, org.id, 0))]);
    expect(sends(token)).toBe(1);
    expect(await rowOf(deliveryId)).toMatchObject({ status: 'ACCEPTED', count: 3 });
  });
});
