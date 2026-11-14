// Phase X SC-01: this suite runs with the core entity cache ON, set before any NestJS module compiles (the code default is
// off; every other suite keeps it off). Same convention as core-entity-cache.integration.spec.ts.
process.env.CORE_ENTITY_CACHE_ENABLED = 'true';

import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { NotificationType, UserStatus } from '@rab/shared';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource, EntityManager } from 'typeorm';

import { AppModule } from '../../app.module';
import { AuthCacheRedisClientProvider } from '../../engine/core-modules/auth/services/auth-cache-redis-client.provider';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { CoreEntityCacheService } from '../../engine/core-modules/entity-cache/core-entity-cache.service';
import { EnvironmentService } from '../../engine/core-modules/environment/environment.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { NotificationService } from '../../modules/notification/services/notification.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';
import { applyGlobalValidationPipe } from '../../engine/utils/global-validation-pipe';
import { integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';

/**
 * SC-01 (Phase X Stage 0, S0-C-caches.md): `NotificationService.notify()` addressed its email from
 * `CoreEntityCacheService.getUserDisplay().email`, a display cache whose epoch lives in Redis and is bumped only AFTER
 * commit, and most writers of `user.email` never bumped it. With the cache on, offer and shift mail (PII included) kept
 * going to the OLD address for up to 300 s after an email change, which is often a takeover-recovery action.
 *
 * Fixed in two independent layers, each proven here with the cache ON, real PostgreSQL (RLS), real Redis, real HTTP:
 *  1. the recipient address is read LIVE in the notifying transaction: correct even when the cache entry is stale
 *     (a write path that never clears it, a failed INCR, a crash after commit);
 *  2. every service writer of a field in the `user` display projection (name, email, avatar) or of the row's existence
 *     clears the entry after its commit, so displayed names are fresh too. A failed write clears nothing.
 */
const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('SC-01 notification recipient is live; user display writers clear the entity cache (cache ON)', () => {
  jest.setTimeout(180_000);

  let app: INestApplication;
  let owner: DataSource;
  let factory: TestIdentityFactory;
  let tenantContext: TenantContextService;
  let entityCache: CoreEntityCacheService;
  let notifications: NotificationService;
  let redis: AuthCacheRedisClientProvider;
  let env: EnvironmentService;
  let manager: TestIdentity;
  let managerToken: string;
  let organisationId: string;

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const freshEmail = (label: string) => `${label}-${randomUUID().slice(0, 8)}@example.test`;
  const inOrg = <T>(fn: (m: EntityManager) => Promise<T>) =>
    tenantContext.runInTenantContext({ organisationId, workspaceId: null, userId: '', role: '' }, fn);
  const cachedDisplay = (userId: string) => inOrg((m) => entityCache.getUserDisplay(m, userId));
  const epochOf = async (userId: string) =>
    Number((await redis.client.get(`crewflow:${env.get('NODE_ENV')}:entitycache:user:${userId}:epoch`)) ?? '0');
  const liveEmail = async (userId: string) => ((await owner.query(`SELECT email FROM core."user" WHERE id = $1`, [userId]))[0] as { email: string }).email;

  /** One forced-email notification through the real notify() path; returns the persisted outbox recipient. */
  const notifyAndReadRecipient = async (userId: string): Promise<string> => {
    const title = `SC-01 probe ${randomUUID()}`;
    await inOrg((m) => notifications.notify(m, { organisationId, userId, type: NotificationType.OFFER_SENT, title, message: 'probe', forceEmail: true }));
    const [row] = await owner.query(`SELECT recipient_email FROM core.email_outbox WHERE target_user_id = $1 AND rendered_subject = $2`, [userId, title]);
    expect(row).toBeDefined();
    return (row as { recipient_email: string }).recipient_email;
  };
  const tokenSentTo = async (email: string): Promise<string> => {
    const [row] = await owner.query(
      `SELECT rendered_text FROM core.email_outbox WHERE recipient_email = $1 AND rendered_text LIKE '%confirm-email-change?token=%' ORDER BY created_at DESC LIMIT 1`,
      [email],
    );
    return /token=([0-9a-f]{64})/.exec((row as { rendered_text: string }).rendered_text)![1]!;
  };
  const newStaff = (label: string, status?: string) => factory.createStaff({ id: organisationId }, { owner: manager, label, status });
  const newVenueManager = (label: string) => factory.createVenueManager({ id: organisationId }, { owner: manager, label });
  const makeInvited = (userId: string) => owner.query(`UPDATE core."user" SET status = $2 WHERE id = $1`, [userId, UserStatus.INVITED]);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = applyGlobalValidationPipe(moduleRef.createNestApplication());
    await app.init();
    owner = createAdminDataSource();
    await owner.initialize();
    tenantContext = moduleRef.get(TenantContextService);
    entityCache = moduleRef.get(CoreEntityCacheService);
    notifications = moduleRef.get(NotificationService);
    redis = moduleRef.get(AuthCacheRedisClientProvider);
    env = moduleRef.get(EnvironmentService);
    factory = new TestIdentityFactory({
      app,
      dataSource: moduleRef.get(DataSource),
      adminDataSource: owner,
      tenantContext,
      passwordHashing: moduleRef.get(PasswordHashingService),
    });
    const seeded = await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'sc01' });
    manager = seeded.managers[0]!;
    organisationId = seeded.organisation.id;
    managerToken = await factory.login(manager);
  });

  afterAll(async () => {
    await owner?.destroy();
    await app?.close();
  });

  it('runs with the entity cache ON (sanity check on the env override above)', () => {
    expect(entityCache.isEnabled()).toBe(true);
  });

  it('email change confirmed → the next notification goes to the NEW address, and the display cache shows it', async () => {
    const staff = await newStaff('sc01-confirm');
    const oldEmail = staff.email;
    // Warm the display cache with the old address, exactly as a busy notification path would.
    expect((await cachedDisplay(staff.userId))?.email).toBe(oldEmail);
    expect(await notifyAndReadRecipient(staff.userId)).toBe(oldEmail);

    const target = freshEmail('sc01-new');
    const pending = await http().patch(`/rest/v1/staff/${staff.profileId}/email`).set(as(managerToken)).send({ email: target, currentPassword: manager.password });
    expect(pending.status).toBe(200);
    const epochBefore = await epochOf(staff.userId);
    expect((await http().post('/rest/v1/email-change/confirm').send({ token: await tokenSentTo(target) })).status).toBe(200);
    expect(await liveEmail(staff.userId)).toBe(target);

    expect(await notifyAndReadRecipient(staff.userId)).toBe(target);
    expect(await epochOf(staff.userId)).toBe(epochBefore + 1); // EmailChangeService.confirm cleared the entry after commit
    expect((await cachedDisplay(staff.userId))?.email).toBe(target);
  });

  it('the recipient is read live even when the display cache is STALE (a write that never clears it)', async () => {
    const staff = await newStaff('sc01-stale');
    expect((await cachedDisplay(staff.userId))?.email).toBe(staff.email);
    // Operator SQL / a crash after commit / a failed INCR: the row changes, the cache is NOT cleared.
    const target = freshEmail('sc01-sql');
    await owner.query(`UPDATE core."user" SET email = $2 WHERE id = $1`, [staff.userId, target]);
    expect((await cachedDisplay(staff.userId))?.email).toBe(staff.email); // the display cache really is stale

    expect(await notifyAndReadRecipient(staff.userId)).toBe(target);
  });

  describe('every service writer of the user display projection clears it after commit', () => {
    it('StaffService.update (name)', async () => {
      const staff = await newStaff('sc01-name');
      await cachedDisplay(staff.userId);
      const before = await epochOf(staff.userId);
      expect((await http().patch(`/rest/v1/staff/${staff.profileId}`).set(as(managerToken)).send({ firstName: 'Renamed' })).status).toBe(200);
      expect(await epochOf(staff.userId)).toBe(before + 1);
      expect((await cachedDisplay(staff.userId))?.firstName).toBe('Renamed');
    });

    it('StaffService.update without a display field (phone only) leaves the entry alone', async () => {
      const staff = await newStaff('sc01-phone');
      const before = await epochOf(staff.userId);
      expect((await http().patch(`/rest/v1/staff/${staff.profileId}`).set(as(managerToken)).send({ phone: '+447700900123' })).status).toBe(200);
      expect(await epochOf(staff.userId)).toBe(before);
    });

    it('StaffService.removeAvatar', async () => {
      const staff = await newStaff('sc01-avatar');
      const before = await epochOf(staff.userId);
      expect((await http().delete(`/rest/v1/staff/${staff.profileId}/avatar`).set(as(managerToken))).status).toBe(200);
      expect(await epochOf(staff.userId)).toBe(before + 1);
    });

    it('StaffService.changeEmail, direct path for a never-activated account', async () => {
      const staff = await newStaff('sc01-direct');
      await makeInvited(staff.userId);
      await cachedDisplay(staff.userId);
      const before = await epochOf(staff.userId);
      const target = freshEmail('sc01-direct-new');
      const res = await http().patch(`/rest/v1/staff/${staff.profileId}/email`).set(as(managerToken)).send({ email: target, currentPassword: manager.password });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ email: target });
      expect(await epochOf(staff.userId)).toBe(before + 1);
      expect((await cachedDisplay(staff.userId))?.email).toBe(target);
      expect(await notifyAndReadRecipient(staff.userId)).toBe(target);
    });

    it('StaffService.changeEmail that fails (address taken, 409) clears nothing', async () => {
      const staff = await newStaff('sc01-conflict');
      await makeInvited(staff.userId);
      const taken = await newStaff('sc01-taken');
      const before = await epochOf(staff.userId);
      const res = await http().patch(`/rest/v1/staff/${staff.profileId}/email`).set(as(managerToken)).send({ email: taken.email, currentPassword: manager.password });
      expect(res.status).toBe(409);
      expect(await epochOf(staff.userId)).toBe(before);
    });

    it('StaffService.changePendingEmail', async () => {
      const staff = await newStaff('sc01-pending');
      await makeInvited(staff.userId);
      const before = await epochOf(staff.userId);
      const target = freshEmail('sc01-pending-new');
      expect((await http().patch(`/rest/v1/staff/${staff.profileId}/pending-email`).set(as(managerToken)).send({ email: target })).status).toBe(200);
      expect(await epochOf(staff.userId)).toBe(before + 1);
      expect((await cachedDisplay(staff.userId))?.email).toBe(target);
    });

    it('StaffService.deleteUser', async () => {
      const staff = await newStaff('sc01-delete');
      await cachedDisplay(staff.userId);
      const before = await epochOf(staff.userId);
      expect((await http().delete(`/rest/v1/staff/${staff.profileId}`).set(as(managerToken)).send({ currentPassword: manager.password })).status).toBe(204);
      expect(await epochOf(staff.userId)).toBe(before + 1);
      expect(await cachedDisplay(staff.userId)).toBeNull();
    });

    it('ManagerService.update (name), through the venue-manager route', async () => {
      const vm = await newVenueManager('sc01-vm-name');
      await cachedDisplay(vm.userId);
      const before = await epochOf(vm.userId);
      expect((await http().patch(`/rest/v1/venue-managers/${vm.profileId}`).set(as(managerToken)).send({ lastName: 'Renamed' })).status).toBe(200);
      expect(await epochOf(vm.userId)).toBe(before + 1);
      expect((await cachedDisplay(vm.userId))?.lastName).toBe('Renamed');
    });

    it('ManagerService.changeEmail, direct path for a never-activated account', async () => {
      const vm = await newVenueManager('sc01-vm-direct');
      await makeInvited(vm.userId);
      const before = await epochOf(vm.userId);
      const target = freshEmail('sc01-vm-direct-new');
      const res = await http().patch(`/rest/v1/venue-managers/${vm.profileId}/email`).set(as(managerToken)).send({ email: target, currentPassword: manager.password });
      expect(res.status).toBe(200);
      expect(await epochOf(vm.userId)).toBe(before + 1);
      expect((await cachedDisplay(vm.userId))?.email).toBe(target);
    });

    it('ManagerService.changePendingEmail', async () => {
      const vm = await newVenueManager('sc01-vm-pending');
      await makeInvited(vm.userId);
      const before = await epochOf(vm.userId);
      const target = freshEmail('sc01-vm-pending-new');
      expect((await http().patch(`/rest/v1/venue-managers/${vm.profileId}/pending-email`).set(as(managerToken)).send({ email: target })).status).toBe(200);
      expect(await epochOf(vm.userId)).toBe(before + 1);
    });

    it('VenueManagerService.removeAvatar', async () => {
      const vm = await newVenueManager('sc01-vm-avatar');
      const before = await epochOf(vm.userId);
      expect((await http().delete(`/rest/v1/venue-managers/${vm.profileId}/avatar`).set(as(managerToken))).status).toBe(200);
      expect(await epochOf(vm.userId)).toBe(before + 1);
    });

    it('ManagerService.deleteUser, through the venue-manager route', async () => {
      const vm = await newVenueManager('sc01-vm-delete');
      await cachedDisplay(vm.userId);
      const before = await epochOf(vm.userId);
      expect((await http().delete(`/rest/v1/venue-managers/${vm.profileId}`).set(as(managerToken)).send({ currentPassword: manager.password })).status).toBe(200);
      expect(await epochOf(vm.userId)).toBe(before + 1);
      expect(await cachedDisplay(vm.userId)).toBeNull();
    });
  });
});
