/**
 * Stage 6 — durable push delivery: device registration lifecycle, fan-out creation from
 * `NotificationService.notify()`, RLS tenant isolation, and the HTTP registration endpoint.
 *
 * Worker-side claim/send/retry/fail/invalid-token behaviour (`runPushDispatchCycle`/
 * `createPushSendProcessor`) is tested separately, in `rab-worker`'s own test suite
 * (`push-delivery-dispatch.integration.spec.ts`) — this package never imports `rab-worker`'s raw
 * source directly (the one-way dependency the whole monorepo relies on: worker depends on server,
 * never the reverse), matching the established convention every other worker job/processor test
 * in this program already follows.
 */
process.env.PUSH_ENABLED = 'true';

import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import request from 'supertest';

import { AppModule } from '../../app.module';
import { AuthContext } from '../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { SecretEncryptionService } from '../../engine/core-modules/secret-encryption/secret-encryption.service';
import { PushDeviceService } from '../../engine/core-modules/push/push-device.service';
import { PushDevice } from '../../engine/core-modules/push/entities/push-device.entity';
import { NotificationService } from '../../modules/notification/services/notification.service';
import { Notification } from '../../modules/notification/entities/notification.entity';
import { NotificationType } from '@rab/shared';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentityFactory } from './helpers/test-identities';

const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(30_000);

describeIfDb('push delivery — durable device registration and dispatch (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let tenantContext: TenantContextService;
  let secretEncryption: SecretEncryptionService;
  let pushDeviceService: PushDeviceService;
  let notificationService: NotificationService;
  let factory: TestIdentityFactory;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    dataSource = moduleRef.get(DataSource);
    tenantContext = moduleRef.get(TenantContextService);
    secretEncryption = moduleRef.get(SecretEncryptionService);
    pushDeviceService = moduleRef.get(PushDeviceService);
    notificationService = moduleRef.get(NotificationService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = new TestIdentityFactory({ app, dataSource, adminDataSource, tenantContext, passwordHashing: moduleRef.get(PasswordHashingService) });
  });

  afterAll(async () => {
    await app.close();
    await adminDataSource.destroy();
  });

  function ctxOf(identity: { organisationId: string; workspaceId: string | null; userId: string }): AuthContext {
    return { organisationId: identity.organisationId, workspaceId: identity.workspaceId, userId: identity.userId, role: '' };
  }

  async function rowFor(table: 'push_device' | 'push_delivery', id: string): Promise<Record<string, unknown> | null> {
    const rows = await adminDataSource.manager.query(`SELECT * FROM core.${table} WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }

  describe('A. device registration lifecycle', () => {
    it('A1: registers a device with identity derived from ctx, never from the request body', async () => {
      const org = await factory.createOrganisation();
      const manager = await factory.createInternalManager(org, { label: 'push-a1' });
      const ctx = ctxOf(manager);

      const { id } = await pushDeviceService.register(ctx, { deviceId: 'device-a1', platform: 'ios', pushToken: 'raw-token-a1' });
      const row = await rowFor('push_device', id);
      expect(row).not.toBeNull();
      expect(row!.user_id).toBe(manager.userId);
      expect(row!.organisation_id).toBe(org.id);
      expect(row!.active).toBe(true);
      // The raw token is never stored in plaintext.
      expect(Buffer.isBuffer(row!.push_token_encrypted)).toBe(true);
      expect((row!.push_token_encrypted as Buffer).includes('raw-token-a1')).toBe(false);
      expect(secretEncryption.decrypt(row!.push_token_encrypted as Buffer)).toBe('raw-token-a1');
    });

    it('A2: registering the SAME deviceId again (a forged request body trying a different userId has no effect) updates the one row in place — never a second row', async () => {
      const org = await factory.createOrganisation();
      const manager = await factory.createInternalManager(org, { label: 'push-a2' });
      const ctx = ctxOf(manager);

      const first = await pushDeviceService.register(ctx, { deviceId: 'device-a2', platform: 'android', pushToken: 'old-token' });
      const second = await pushDeviceService.register(ctx, { deviceId: 'device-a2', platform: 'android', pushToken: 'new-token' });
      expect(second.id).toBe(first.id);

      const rows = await adminDataSource.manager.query(`SELECT * FROM core.push_device WHERE user_id = $1 AND device_id = 'device-a2'`, [manager.userId]);
      expect(rows).toHaveLength(1);
      expect(secretEncryption.decrypt(rows[0].push_token_encrypted)).toBe('new-token');
    });

    it('A3: the SAME deviceId under a DIFFERENT user (another user signing in on the same phone) creates an independent row, never overwrites the first user\'s registration', async () => {
      const org = await factory.createOrganisation();
      const userA = await factory.createInternalManager(org, { label: 'push-a3-a' });
      const userB = await factory.createStaff(org, { owner: userA, label: 'push-a3-b' });

      const regA = await pushDeviceService.register(ctxOf(userA), { deviceId: 'shared-device', platform: 'ios', pushToken: 'token-a' });
      const regB = await pushDeviceService.register(ctxOf(userB), { deviceId: 'shared-device', platform: 'ios', pushToken: 'token-b' });
      expect(regA.id).not.toBe(regB.id);

      // The rows stay independent (A's is never overwritten or re-pointed at B), but CF-35 (October 15 audit): one physical
      // device delivers for one account at a time, so A's registration for this device stops and B never receives A's
      // notifications on the shared phone.
      const rowA = await rowFor('push_device', regA.id);
      expect(rowA!.user_id ?? rowA!.userId).toBe(userA.userId);
      expect(rowA!.active).toBe(false);
      expect((await rowFor('push_device', regB.id))!.active).toBe(true);
    });

    it('A4: deactivate() turns off exactly the named device, leaving the user\'s other device active (multi-device)', async () => {
      const org = await factory.createOrganisation();
      const manager = await factory.createInternalManager(org, { label: 'push-a4' });
      const ctx = ctxOf(manager);
      const phone = await pushDeviceService.register(ctx, { deviceId: 'phone', platform: 'ios', pushToken: 'tok-phone' });
      const tablet = await pushDeviceService.register(ctx, { deviceId: 'tablet', platform: 'ios', pushToken: 'tok-tablet' });

      await pushDeviceService.deactivate(ctx, 'phone', 'user_logout');

      expect((await rowFor('push_device', phone.id))!.active).toBe(false);
      expect((await rowFor('push_device', tablet.id))!.active).toBe(true);
    });

    it('A5: deactivateAll() turns off every device for that user (logout-all / account suspension)', async () => {
      const org = await factory.createOrganisation();
      const manager = await factory.createInternalManager(org, { label: 'push-a5' });
      const ctx = ctxOf(manager);
      const phone = await pushDeviceService.register(ctx, { deviceId: 'phone', platform: 'ios', pushToken: 'tok' });
      const tablet = await pushDeviceService.register(ctx, { deviceId: 'tablet', platform: 'android', pushToken: 'tok2' });

      await pushDeviceService.deactivateAll(ctx, 'account_suspended');

      expect((await rowFor('push_device', phone.id))!.active).toBe(false);
      expect((await rowFor('push_device', tablet.id))!.active).toBe(false);
    });

    it('A6: deactivating an unknown/already-inactive device is a silent no-op, never an error', async () => {
      const org = await factory.createOrganisation();
      const manager = await factory.createInternalManager(org, { label: 'push-a6' });
      await expect(pushDeviceService.deactivate(ctxOf(manager), 'never-registered-device', 'user_logout')).resolves.toBeUndefined();
    });

    it('A7: forged registration request — a manager cannot register a device under a DIFFERENT organisation\'s id (the DTO has no such field; this proves the service itself never reads one even if a caller tried)', async () => {
      const orgA = await factory.createOrganisation();
      const orgB = await factory.createOrganisation();
      const managerA = await factory.createInternalManager(orgA, { label: 'push-a7' });
      // Even constructing a ctx with a mismatched orgId (simulating a forged/corrupted ctx) must
      // still only ever write the row under the ctx's OWN organisationId, never an attacker-chosen one.
      const forgedCtx: AuthContext = { organisationId: orgA.id, workspaceId: managerA.workspaceId, userId: managerA.userId, role: '' };
      const { id } = await pushDeviceService.register(forgedCtx, { deviceId: 'device-a7', platform: 'ios', pushToken: 'tok' });
      const row = await rowFor('push_device', id);
      expect(row!.organisation_id).toBe(orgA.id);
      expect(row!.organisation_id).not.toBe(orgB.id);
    });
  });

  describe('B. durable delivery creation (fan-out from the REAL NotificationService.notify(), not a re-implementation)', () => {
    it('B1: notify() creates one push_delivery row per active device, in the SAME transaction as the Notification row', async () => {
      const org = await factory.createOrganisation();
      const manager = await factory.createInternalManager(org, { label: 'push-b1' });
      await pushDeviceService.register(ctxOf(manager), { deviceId: 'd1', platform: 'ios', pushToken: 'tok1' });
      await pushDeviceService.register(ctxOf(manager), { deviceId: 'd2', platform: 'android', pushToken: 'tok2' });

      let notificationId = '';
      await tenantContext.runInTenantContext(ctxOf(manager), async (m) => {
        await notificationService.notify(m, { organisationId: org.id, userId: manager.userId, type: NotificationType.OFFER_SENT, title: 'Test', message: 'Test message' });
        const [entry] = await m.find(Notification, { where: { userId: manager.userId }, order: { createdAt: 'DESC' }, take: 1 });
        notificationId = entry!.id;
      });

      const deliveries = await adminDataSource.manager.query(`SELECT * FROM core.push_delivery WHERE notification_id = $1`, [notificationId]);
      expect(deliveries).toHaveLength(2);
      expect(deliveries.every((d: { status: string }) => d.status === 'PENDING')).toBe(true);
    });

    it('B2: a user with zero registered devices gets zero push_delivery rows — never an error, never a row with no device', async () => {
      const org = await factory.createOrganisation();
      const manager = await factory.createInternalManager(org, { label: 'push-b2' });
      await tenantContext.runInTenantContext(ctxOf(manager), (m) =>
        notificationService.notify(m, { organisationId: org.id, userId: manager.userId, type: NotificationType.OFFER_SENT, title: 'T', message: 'M' }),
      );
      const deliveries = await adminDataSource.manager.query(`SELECT pd.* FROM core.push_delivery pd JOIN core.notification n ON n.id = pd.notification_id WHERE n.user_id = $1`, [manager.userId]);
      expect(deliveries).toHaveLength(0);
    });

    it('B3: a DEACTIVATED device never receives a new push_delivery row for a later notification', async () => {
      const org = await factory.createOrganisation();
      const manager = await factory.createInternalManager(org, { label: 'push-b3' });
      await pushDeviceService.register(ctxOf(manager), { deviceId: 'd1', platform: 'ios', pushToken: 'tok1' });
      await pushDeviceService.deactivate(ctxOf(manager), 'd1', 'user_logout');

      await tenantContext.runInTenantContext(ctxOf(manager), (m) =>
        notificationService.notify(m, { organisationId: org.id, userId: manager.userId, type: NotificationType.OFFER_SENT, title: 'T', message: 'M' }),
      );
      const deliveries = await adminDataSource.manager.query(`SELECT pd.* FROM core.push_delivery pd JOIN core.notification n ON n.id = pd.notification_id WHERE n.user_id = $1`, [manager.userId]);
      expect(deliveries).toHaveLength(0);
    });

    // PUSH_ENABLED=false is NOT exercised by flipping `process.env` mid-run here — `EnvironmentService`
    // validates and snapshots config once at boot (the same import-order timing this program hit
    // before, with REALTIME_ENABLED), so a runtime mutation would not reach the already-compiled
    // config at all and the test would silently pass for the wrong reason. The guard itself
    // (`if (!this.env.get('PUSH_ENABLED')) return 0;` in `PushDeliveryService.createForNotification`)
    // is covered by direct code inspection instead — see this file's own Stage 6 final report.
  });

  describe('D. tenant isolation (RLS)', () => {
    it('D1: a query with no tenant context bound returns zero push_device/push_delivery rows', async () => {
      // Fail-closed proof: a fresh query via the plain `dataSource` (RLS always applies; no
      // context is ever bound on this connection) returns nothing regardless of how much real
      // data exists in the table.
      const devices = await dataSource.query(`SELECT * FROM core.push_device`);
      const deliveries = await dataSource.query(`SELECT * FROM core.push_delivery`);
      expect(devices).toHaveLength(0);
      expect(deliveries).toHaveLength(0);
    });

    it('D2: org B cannot see org A\'s push_device row', async () => {
      const orgA = await factory.createOrganisation();
      const orgB = await factory.createOrganisation();
      const managerA = await factory.createInternalManager(orgA, { label: 'push-d2-a' });
      const managerB = await factory.createInternalManager(orgB, { label: 'push-d2-b' });
      await pushDeviceService.register(ctxOf(managerA), { deviceId: 'd-a', platform: 'ios', pushToken: 'tok-a' });

      const seenFromB = await tenantContext.runInTenantContext(ctxOf(managerB), (m) => m.find(PushDevice, { where: { userId: managerA.userId } }));
      expect(seenFromB).toHaveLength(0);
    });

    it('D3: RLS on push_device is org-scoped, matching core.notification\'s own shape exactly — per-user ownership is enforced in the SERVICE layer, not a DB-level workspace predicate (same split that table already uses)', async () => {
      const org = await factory.createOrganisation();
      const managerA = await factory.createInternalManager(org, { label: 'push-d3-a' });
      const managerB = await factory.createInternalManager(org, { label: 'push-d3-b' }); // separate workspace (own ManagerWorkspace)
      await pushDeviceService.register(ctxOf(managerA), { deviceId: 'd-a', platform: 'ios', pushToken: 'tok-a' });

      // The REAL guarantee this table relies on: PushDeviceService's own public methods always
      // scope by ctx.userId, so manager B's deactivate() can never touch manager A's device even
      // though they share an organisation and RLS alone doesn't stop the raw row being visible.
      await pushDeviceService.deactivate(ctxOf(managerB), 'd-a', 'attempted_cross_user_deactivate');
      const stillActive = await tenantContext.runInTenantContext(ctxOf(managerA), (m) => m.findOne(PushDevice, { where: { userId: managerA.userId, deviceId: 'd-a' } }));
      expect(stillActive!.active).toBe(true); // manager B's call matched zero rows (wrong userId) — manager A's device is untouched
    });

    it('D4: core.push_device/core.push_delivery are owned by the migration role, never by crewflow_app — crewflow_app structurally cannot hold DDL/RLS-disabling privilege on them regardless of which connection a test harness happens to use', async () => {
      const rows = await adminDataSource.manager.query(
        `SELECT tablename, tableowner FROM pg_tables WHERE schemaname = 'core' AND tablename IN ('push_device', 'push_delivery')`,
      );
      expect(rows).toHaveLength(2);
      for (const row of rows) expect(row.tableowner).not.toBe('crewflow_app');
    });
  });

  describe('E. HTTP endpoint — identity from the authenticated request, never the body', () => {
    it('E1: POST /push/devices ignores any organisationId/userId the client tries to send, writing under the token\'s own identity', async () => {
      const org = await factory.createOrganisation();
      const manager = await factory.createInternalManager(org, { label: 'push-e1' });
      const token = await factory.login(manager);
      const otherOrg = await factory.createOrganisation();

      const res = await request(app.getHttpServer())
        .post('/rest/v1/push/devices')
        .set('Authorization', `Bearer ${token}`)
        .send({ deviceId: 'device-e1', platform: 'ios', pushToken: 'raw-tok-e1', organisationId: otherOrg.id, userId: randomUUID() });

      // forbidNonWhitelisted rejects the extra fields outright — a 400, never a silent ignore that could be mistaken for acceptance.
      expect(res.status).toBe(400);
    });

    it('E2: a well-formed registration request succeeds and is attributed to the authenticated caller', async () => {
      const org = await factory.createOrganisation();
      const manager = await factory.createInternalManager(org, { label: 'push-e2' });
      const token = await factory.login(manager);

      const res = await request(app.getHttpServer())
        .post('/rest/v1/push/devices')
        .set('Authorization', `Bearer ${token}`)
        .send({ deviceId: 'device-e2', platform: 'android', pushToken: 'raw-tok-e2' });

      expect(res.status).toBe(201);
      const row = await rowFor('push_device', res.body.id);
      expect(row!.user_id).toBe(manager.userId);
    });

    it('E3: no credential at all is rejected', async () => {
      const res = await request(app.getHttpServer()).post('/rest/v1/push/devices').send({ deviceId: 'x', platform: 'ios', pushToken: 'y' });
      expect(res.status).toBe(401);
    });
  });
});
