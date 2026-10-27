import 'reflect-metadata';
import { PermissionFlag, UserStatus } from '@rab/shared';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import {
  NotificationPreference,
  Organisation,
  Permission,
  PlatformAdmin,
  PlatformConfig,
  RefreshToken,
  Role,
  RolePermission,
  User,
  UserPreference,
  UserRole,
} from '../../modules/identity/entities';
import { AuthCacheRedisClientProvider } from '../../engine/core-modules/auth/services/auth-cache-redis-client.provider';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentityFactory } from './helpers/test-identities';
import { generateFixturePassword } from './helpers/fixture-password';

const FIXTURE_PASSWORD = generateFixturePassword();

/**
 * Integration tests for the Settings feature's authz-sensitive surface
 * (rab-workforce-architecture.md §1.2 abuse-case suite): real Postgres,
 * RLS on, no mocks. Skips locally without DATABASE_URL, same as every
 * other suite in this folder.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('settings abuse cases (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let factory: TestIdentityFactory;
  let passwordHashing: PasswordHashingService;
  let tenantContext: TenantContextService;

  const password = FIXTURE_PASSWORD;

  /** An organisation with one canonical Internal Manager holding EVERY existing PermissionFlag but NOT the platform-admin claim — the strongest non-owner adversary this suite can construct. */
  async function seedOrgWithFullyPermissionedUser(): Promise<{ organisation: Organisation; email: string; userId: string }> {
    const organisation = await factory.createOrganisation();
    const user = await factory.createInternalManager(organisation, { permissions: 'all', label: 'full-perms' });
    return { organisation, email: user.email, userId: user.userId };
  }

  async function login(email: string): Promise<string> {
    return factory.loginByEmail(email);
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    dataSource = moduleRef.get(DataSource);
    passwordHashing = moduleRef.get(PasswordHashingService);
    tenantContext = moduleRef.get(TenantContextService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = new TestIdentityFactory({ app, dataSource, adminDataSource, tenantContext, passwordHashing: passwordHashing });
  });

  afterAll(async () => {
    await app.close();
    await adminDataSource.destroy();
  });

  describe('platform-admin routes reject every non-owner, regardless of PermissionFlag grants', () => {
    it('a user holding every existing PermissionFlag still 403s on /admin/general, /admin/config, /admin/health and /admin/recent-users', async () => {
      const { email } = await seedOrgWithFullyPermissionedUser();
      const token = await login(email);

      for (const path of ['/rest/v1/admin/general', '/rest/v1/admin/config', '/rest/v1/admin/health', '/rest/v1/admin/recent-users']) {
        const res = await request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(403);
      }
    });

    it('a user granted platform_admin status is granted access', async () => {
      const { email, userId } = await seedOrgWithFullyPermissionedUser();
      // Written via `adminDataSource` (rab_owner): `platform_admin`'s own
      // write policy requires the ACTING session to already be an admin,
      // impossible for a fresh grant — matches the real bootstrap CLI path.
      await adminDataSource.manager.query(`INSERT INTO core.platform_admin (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [userId]);

      const token = await login(email);
      const res = await request(app.getHttpServer()).get('/rest/v1/admin/general').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.version).toEqual(expect.any(String));
    });

    it("/admin/recent-users is tenant-scoped — an admin never sees another organisation's users", async () => {
      const ownerOrg = await seedOrgWithFullyPermissionedUser();
      await adminDataSource.manager.query(`INSERT INTO core.platform_admin (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [
        ownerOrg.userId,
      ]);
      const otherOrg = await seedOrgWithFullyPermissionedUser();

      const token = await login(ownerOrg.email);
      const res = await request(app.getHttpServer())
        .get('/rest/v1/admin/recent-users')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.map((u: { email: string }) => u.email)).toContain(ownerOrg.email);
      expect(res.body.map((u: { email: string }) => u.email)).not.toContain(otherOrg.email);
    });
  });

  describe('guarded platform_admin grant/revoke (Stage 2A Phase 2 — genuinely global, explicit-grant model)', () => {
    /** Bootstraps a user straight to active platform_admin, via `adminDataSource` (rab_owner) — the same bypass the real CLI uses for the very first grant. */
    async function bootstrapAdmin(userId: string): Promise<void> {
      await adminDataSource.manager.query(`INSERT INTO core.platform_admin (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [userId]);
    }

    it('an existing platform admin can grant another user platform_admin status; the target gains access on its next sign-in (CF-07)', async () => {
      const { userId: adminUserId, email: adminEmail } = await seedOrgWithFullyPermissionedUser();
      await bootstrapAdmin(adminUserId);
      const adminToken = await login(adminEmail);

      const target = await seedOrgWithFullyPermissionedUser();
      const targetToken = await login(target.email);

      const before = await request(app.getHttpServer()).get('/rest/v1/admin/general').set('Authorization', `Bearer ${targetToken}`);
      expect(before.status).toBe(403);

      // Admin panel follow-up (B3): a reason, and a fresh step-up of this session (the fresh sign-in counts) — no password.
      const grantRes = await request(app.getHttpServer())
        .post(`/rest/v1/admin/platform-admins/${target.userId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'settings abuse grant' });
      expect(grantRes.status).toBe(201);
      expect(grantRes.body.granted).toBe(true);

      // CF-07 (October 15 audit): a promotion ends every session the target already held, so a pre-grant (longer-lived,
      // lower-privilege) session can never carry platform-admin authority. The target signs in again and has access.
      const stale = await request(app.getHttpServer()).get('/rest/v1/admin/general').set('Authorization', `Bearer ${targetToken}`);
      expect(stale.status).toBe(401);
      const fresh = await login(target.email);
      const after = await request(app.getHttpServer()).get('/rest/v1/admin/general').set('Authorization', `Bearer ${fresh}`);
      expect(after.status).toBe(200);
    });

    it('a non-admin — even one holding every existing PermissionFlag — cannot grant platform_admin to anyone (blocked by PlatformAdminGuard before the handler runs)', async () => {
      const { email: nonAdminEmail } = await seedOrgWithFullyPermissionedUser();
      const nonAdminToken = await login(nonAdminEmail);
      const target = await seedOrgWithFullyPermissionedUser();

      const res = await request(app.getHttpServer())
        .post(`/rest/v1/admin/platform-admins/${target.userId}`)
        .set('Authorization', `Bearer ${nonAdminToken}`)
        .send({ reason: 'non-admin attempt' });
      expect(res.status).toBe(403);

      const targetToken = await login(target.email);
      const stillBlocked = await request(app.getHttpServer()).get('/rest/v1/admin/general').set('Authorization', `Bearer ${targetToken}`);
      expect(stillBlocked.status).toBe(403);
    });

    it('an existing platform admin can revoke another admin; the revoked user immediately loses access', async () => {
      const { userId: adminUserId, email: adminEmail } = await seedOrgWithFullyPermissionedUser();
      await bootstrapAdmin(adminUserId);
      const adminToken = await login(adminEmail);

      const { userId: secondAdminUserId, email: secondAdminEmail } = await seedOrgWithFullyPermissionedUser();
      await bootstrapAdmin(secondAdminUserId);
      const secondAdminToken = await login(secondAdminEmail);

      const revokeRes = await request(app.getHttpServer())
        .delete(`/rest/v1/admin/platform-admins/${secondAdminUserId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'settings abuse revoke' });
      expect(revokeRes.status).toBe(200);
      expect(revokeRes.body.revoked).toBe(true);

      const after = await request(app.getHttpServer()).get('/rest/v1/admin/general').set('Authorization', `Bearer ${secondAdminToken}`);
      expect(after.status).toBe(403);
    });

    it('a revoked admin can be re-granted, and regains access on its next sign-in (no permanent lockout; CF-07)', async () => {
      const { userId: adminUserId, email: adminEmail } = await seedOrgWithFullyPermissionedUser();
      await bootstrapAdmin(adminUserId);
      const adminToken = await login(adminEmail);

      // B3: an admin can no longer remove THEMSELVES (409); a second, still-active admin demotes the first one, then
      // re-grants it (only an ACTIVE admin may grant/revoke).
      const self = await request(app.getHttpServer()).delete(`/rest/v1/admin/platform-admins/${adminUserId}`).set('Authorization', `Bearer ${adminToken}`).send({ reason: 'self removal attempt' });
      expect(self.status).toBe(409);
      expect(self.body.code).toBe('PLATFORM_ADMIN_SELF_REMOVAL');
      const { userId: secondAdminUserId, email: secondAdminEmail } = await seedOrgWithFullyPermissionedUser();
      await bootstrapAdmin(secondAdminUserId);
      const secondAdminToken = await login(secondAdminEmail);
      const demoted = await request(app.getHttpServer()).delete(`/rest/v1/admin/platform-admins/${adminUserId}`).set('Authorization', `Bearer ${secondAdminToken}`).send({ reason: 'demote for re-grant test' });
      expect(demoted.status).toBe(200);
      expect(demoted.body.revoked).toBe(true);

      const stillBlocked = await request(app.getHttpServer()).get('/rest/v1/admin/general').set('Authorization', `Bearer ${adminToken}`);
      expect(stillBlocked.status).toBe(403);

      const regrant = await request(app.getHttpServer())
        .post(`/rest/v1/admin/platform-admins/${adminUserId}`)
        .set('Authorization', `Bearer ${secondAdminToken}`)
        .send({ reason: 'settings abuse re-grant' });
      expect(regrant.status).toBe(201);
      expect(regrant.body.granted).toBe(true);

      // CF-07: the re-grant ends the old session; the re-granted admin signs in again and regains access (no lockout).
      expect((await request(app.getHttpServer()).get('/rest/v1/admin/general').set('Authorization', `Bearer ${adminToken}`)).status).toBe(401);
      const restored = await request(app.getHttpServer()).get('/rest/v1/admin/general').set('Authorization', `Bearer ${await login(adminEmail)}`);
      expect(restored.status).toBe(200);
    });

    it('granting an already-active admin is idempotent, not an error', async () => {
      const { userId: adminUserId, email: adminEmail } = await seedOrgWithFullyPermissionedUser();
      await bootstrapAdmin(adminUserId);
      const adminToken = await login(adminEmail);

      const res = await request(app.getHttpServer())
        .post(`/rest/v1/admin/platform-admins/${adminUserId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'idempotent re-grant' });
      expect(res.status).toBe(201);
      expect(res.body.granted).toBe(false); // already active — no row change, not an error
    });

    it('P2.8 / B3 — an active admin\'s OWN valid but STALE session cannot grant platform_admin, and a wrong-password step-up earns nothing (403, target untouched)', async () => {
      const { userId: adminUserId, email: adminEmail } = await seedOrgWithFullyPermissionedUser();
      await bootstrapAdmin(adminUserId);
      const adminToken = await login(adminEmail);
      const target = await seedOrgWithFullyPermissionedUser();
      // The session is older than the step-up window: its sign-in grant has expired (= removed).
      const sid = (JSON.parse(Buffer.from(adminToken.split('.')[1]!, 'base64url').toString('utf8')) as { sid: string }).sid;
      await app.get(AuthCacheRedisClientProvider).client.del(`crewflow:test:step-up:${createHash('sha256').update(sid).digest('hex')}`);

      const res = await request(app.getHttpServer())
        .post(`/rest/v1/admin/platform-admins/${target.userId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'stale session attempt' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('STEP_UP_REQUIRED');
      const wrong = await request(app.getHttpServer())
        .post('/rest/v1/auth/step-up')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('Origin', 'http://localhost:5173')
        .send({ currentPassword: 'definitely-not-the-real-password' });
      expect(wrong.status).toBe(403);
      const again = await request(app.getHttpServer())
        .post(`/rest/v1/admin/platform-admins/${target.userId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'after a wrong password' });
      expect(again.status).toBe(403);

      const targetToken = await login(target.email);
      const stillBlocked = await request(app.getHttpServer()).get('/rest/v1/admin/general').set('Authorization', `Bearer ${targetToken}`);
      expect(stillBlocked.status).toBe(403);
    });

    it('B3 — a missing reason (or a legacy currentPassword body) is rejected (400) before the handler is reached', async () => {
      const { userId: adminUserId, email: adminEmail } = await seedOrgWithFullyPermissionedUser();
      await bootstrapAdmin(adminUserId);
      const adminToken = await login(adminEmail);
      const target = await seedOrgWithFullyPermissionedUser();

      const res = await request(app.getHttpServer())
        .post(`/rest/v1/admin/platform-admins/${target.userId}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(400);
      const legacy = await request(app.getHttpServer())
        .post(`/rest/v1/admin/platform-admins/${target.userId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ currentPassword: factory.testPassword });
      expect(legacy.status).toBe(400);
    });
  });

  describe('cross-tenant access to another organisation\'s session is rejected', () => {
    it('DELETE /profile/sessions/:familyId 404s for a family belonging to a different organisation', async () => {
      const orgA = await seedOrgWithFullyPermissionedUser();
      const orgB = await seedOrgWithFullyPermissionedUser();

      const familyId = randomUUID();
      await adminDataSource.manager.insert(RefreshToken, {
        organisationId: orgB.organisation.id,
        userId: orgB.userId,
        tokenHash: randomUUID(),
        familyId,
        expiresAt: new Date(Date.now() + 60_000),
        familyExpiresAt: new Date(Date.now() + 60_000),
      });

      const tokenA = await login(orgA.email);
      const res = await request(app.getHttpServer())
        .delete(`/rest/v1/profile/sessions/${familyId}`)
        .set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(404);
    });
  });

  describe('organisation slug — platform-admin only (W6-E2E-04), cross-org slug collision', () => {
    it('the former tenant route PATCH /workspace/domain no longer exists (404), even for a user holding every PermissionFlag', async () => {
      const other = await seedOrgWithFullyPermissionedUser();
      const res = await request(app.getHttpServer())
        .patch('/rest/v1/workspace/domain')
        .set('Authorization', `Bearer ${await login(other.email)}`)
        .send({ slug: `free-${randomUUID().slice(0, 8)}` });
      expect(res.status).toBe(404);
    });

    it('a platform admin setting a slug already taken by a different organisation gets a clean 409, not a 500', async () => {
      // Regression test for a real, previously-latent bug (kept from the tenant route): the uniqueness pre-check must go
      // through core.organisation_slug_taken — a bound transaction only sees its own organisation's row.
      const taken = await seedOrgWithFullyPermissionedUser();
      const target = await seedOrgWithFullyPermissionedUser();
      const admin = await factory.createInternalManager(await factory.createOrganisation(), { platformAdmin: true, label: 'slug-admin' });
      const res = await request(app.getHttpServer())
        .patch(`/rest/v1/admin/organisations/${target.organisation.id}/settings/domain`)
        .set('Authorization', `Bearer ${await login(admin.email)}`)
        .send({ slug: taken.organisation.slug });
      expect(res.status).toBe(409);
    });
  });

  describe('row-level security — the fail-closed guarantee', () => {
    it('a query with no tenant context bound returns zero rows for every new Settings table', async () => {
      const { organisation, userId } = await seedOrgWithFullyPermissionedUser();

      // Seed a real row in each new table first, via a properly bound
      // tenant context — this asserts RLS is actively filtering them out
      // of the unscoped read below, not that the tables just happen to be
      // empty.
      await tenantContext.runInTenantContext({ organisationId: organisation.id, workspaceId: null, userId, role: '' }, async (manager) => {
        await manager.insert(UserPreference, { userId, organisationId: organisation.id });
        await manager.insert(NotificationPreference, {
          userId,
          organisationId: organisation.id,
          notificationType: 'offer_sent',
        });
        await manager.insert(PlatformConfig, { organisationId: organisation.id, smtpHost: 'smtp.example.test' });
      });
      // `platform_admin` has no organisation_id at all (genuinely global,
      // not tenant-scoped) — written via `adminDataSource` (rab_owner), the
      // same bypass the real bootstrap CLI uses.
      await adminDataSource.manager.query(`INSERT INTO core.platform_admin (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [userId]);

      await expect(dataSource.manager.find(UserPreference, { where: { organisationId: organisation.id } })).resolves.toEqual([]);
      await expect(
        dataSource.manager.find(NotificationPreference, { where: { organisationId: organisation.id } }),
      ).resolves.toEqual([]);
      // No bound context means current_uid() is NULL too — `user_id = NULL`
      // is never true, and `is_active_platform_admin()` resolves false for
      // the same reason, so this table fails closed identically despite
      // having no organisation_id/tenant dimension to key off at all.
      await expect(dataSource.manager.find(PlatformAdmin, { where: { userId } })).resolves.toEqual([]);
      await expect(dataSource.manager.find(PlatformConfig, { where: { organisationId: organisation.id } })).resolves.toEqual([]);
    });
  });
});
