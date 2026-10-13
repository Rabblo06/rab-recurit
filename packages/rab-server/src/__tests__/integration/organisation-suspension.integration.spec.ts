import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { Organisation } from '../../modules/identity/entities';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentityFactory } from './helpers/test-identities';

/**
 * P2.8 — organisation suspension (reversible, platform-admin-only). Real Postgres, RLS on, no
 * mocks — same discipline as every other suite in this folder. Skips locally without DATABASE_URL.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('organisation suspension (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let factory: TestIdentityFactory;
  let passwordHashing: PasswordHashingService;
  let tenantContext: TenantContextService;

  const http = () => request(app.getHttpServer());

  /** A fresh organisation with one Internal Manager holding every PermissionFlag, bootstrapped straight to active platform_admin via `adminDataSource` (rab_owner) — same bypass the real CLI uses for the very first grant. */
  async function seedPlatformAdmin(): Promise<{ organisation: Organisation; email: string; userId: string }> {
    const organisation = await factory.createOrganisation();
    const user = await factory.createInternalManager(organisation, { permissions: 'all', label: 'admin' });
    await adminDataSource.manager.query(`INSERT INTO core.platform_admin (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [user.userId]);
    return { organisation, email: user.email, userId: user.userId };
  }

  /** A fresh, ordinary (non-admin) organisation, with one Internal Manager — the thing being suspended. */
  async function seedTargetOrg(): Promise<{ organisation: Organisation; email: string; userId: string }> {
    const organisation = await factory.createOrganisation();
    const user = await factory.createInternalManager(organisation, { permissions: 'all', label: 'target' });
    return { organisation, email: user.email, userId: user.userId };
  }

  function suspendBody(organisation: Organisation, overrides: Partial<{ reason: string; confirmSlug: string; currentPassword: string }> = {}) {
    return {
      reason: 'Billing dispute under review',
      confirmSlug: organisation.slug,
      currentPassword: factory.testPassword,
      ...overrides,
    };
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
    factory = new TestIdentityFactory({ app, dataSource, adminDataSource, tenantContext, passwordHashing });
  });

  afterAll(async () => {
    await app.close();
    await adminDataSource.destroy();
  });

  describe('authorization', () => {
    it('a non-platform-admin is rejected with 403 and the target organisation is left untouched', async () => {
      const nonAdminOrg = await factory.createOrganisation();
      const nonAdminUser = await factory.createInternalManager(nonAdminOrg, { permissions: 'all', label: 'non-admin' });
      const target = await seedTargetOrg();

      const token = await factory.loginByEmail(nonAdminUser.email);
      const res = await http()
        .post(`/rest/v1/admin/organisations/${target.organisation.id}/suspend`)
        .set('Authorization', `Bearer ${token}`)
        .send(suspendBody(target.organisation));

      expect(res.status).toBe(403);
      const [row] = await adminDataSource.manager.query(`SELECT suspended_at FROM core.organisation WHERE id = $1`, [target.organisation.id]);
      expect(row.suspended_at).toBeNull();
    });

    it('a platform admin with the WRONG current password is rejected with 403 and the target stays active', async () => {
      const admin = await seedPlatformAdmin();
      const target = await seedTargetOrg();
      const adminToken = await factory.loginByEmail(admin.email);

      const res = await http()
        .post(`/rest/v1/admin/organisations/${target.organisation.id}/suspend`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send(suspendBody(target.organisation, { currentPassword: 'definitely-the-wrong-password' }));

      expect(res.status).toBe(403);
      const [row] = await adminDataSource.manager.query(`SELECT suspended_at FROM core.organisation WHERE id = $1`, [target.organisation.id]);
      expect(row.suspended_at).toBeNull();
    });

    it('a platform admin whose confirmSlug does not match the target organisation is rejected with 403', async () => {
      const admin = await seedPlatformAdmin();
      const target = await seedTargetOrg();
      const adminToken = await factory.loginByEmail(admin.email);

      const res = await http()
        .post(`/rest/v1/admin/organisations/${target.organisation.id}/suspend`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send(suspendBody(target.organisation, { confirmSlug: 'not-the-right-slug' }));

      expect(res.status).toBe(403);
      const [row] = await adminDataSource.manager.query(`SELECT suspended_at FROM core.organisation WHERE id = $1`, [target.organisation.id]);
      expect(row.suspended_at).toBeNull();
    });

    it('a platform admin with the correct password and confirmSlug can suspend', async () => {
      const admin = await seedPlatformAdmin();
      const target = await seedTargetOrg();
      const adminToken = await factory.loginByEmail(admin.email);

      const res = await http()
        .post(`/rest/v1/admin/organisations/${target.organisation.id}/suspend`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send(suspendBody(target.organisation));

      expect(res.status).toBe(201);
      expect(res.body.suspended).toBe(true);
      expect(res.body.suspendedBy).toBe(admin.userId);
    });
  });

  describe('session invalidation and login/refresh blocking', () => {
    it('suspending the organisation blocks a FRESH login attempt for its users', async () => {
      const admin = await seedPlatformAdmin();
      const target = await seedTargetOrg();
      const adminToken = await factory.loginByEmail(admin.email);
      await http()
        .post(`/rest/v1/admin/organisations/${target.organisation.id}/suspend`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send(suspendBody(target.organisation));

      const loginRes = await factory.loginRaw({ kind: 'internal_manager', email: target.email, password: factory.testPassword });
      expect(loginRes.status).toBe(401);
    });

    it("an access token issued BEFORE suspension is rejected on the very next authenticated request after suspension", async () => {
      const admin = await seedPlatformAdmin();
      const target = await seedTargetOrg();
      const targetToken = await factory.loginByEmail(target.email);

      const before = await http().get('/rest/v1/auth/me').set('Authorization', `Bearer ${targetToken}`);
      expect(before.status).toBe(200);

      const adminToken = await factory.loginByEmail(admin.email);
      await http()
        .post(`/rest/v1/admin/organisations/${target.organisation.id}/suspend`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send(suspendBody(target.organisation));

      const after = await http().get('/rest/v1/auth/me').set('Authorization', `Bearer ${targetToken}`);
      expect(after.status).toBe(401);
    });

    it('a refresh token issued BEFORE suspension cannot mint a new access token after suspension', async () => {
      const admin = await seedPlatformAdmin();
      const target = await seedTargetOrg();
      const { refreshToken } = await factory.loginTokens({ kind: 'internal_manager', email: target.email, password: factory.testPassword });

      const adminToken = await factory.loginByEmail(admin.email);
      await http()
        .post(`/rest/v1/admin/organisations/${target.organisation.id}/suspend`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send(suspendBody(target.organisation));

      const refreshRes = await http().post('/rest/v1/auth/refresh').set('x-client-platform', 'mobile').send({ refreshToken });
      expect(refreshRes.status).toBe(401);
    });

    it('a platform admin can still log in and operate against a suspended organisation (their own, never suspended)', async () => {
      const admin = await seedPlatformAdmin();
      const target = await seedTargetOrg();
      const adminToken = await factory.loginByEmail(admin.email);
      await http()
        .post(`/rest/v1/admin/organisations/${target.organisation.id}/suspend`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send(suspendBody(target.organisation));

      // The admin's OWN organisation was never suspended — they must still be able to use the API,
      // including re-authenticating, in order to investigate/reactivate the suspended tenant.
      const stillWorks = await http().get('/rest/v1/auth/me').set('Authorization', `Bearer ${adminToken}`);
      expect(stillWorks.status).toBe(200);

      const freshAdminToken = await factory.loginByEmail(admin.email);
      expect(typeof freshAdminToken).toBe('string');
    });
  });

  describe('cross-organisation isolation', () => {
    it('suspending organisation A never affects organisation B — B logs in and operates normally', async () => {
      const admin = await seedPlatformAdmin();
      const orgA = await seedTargetOrg();
      const orgB = await seedTargetOrg();
      const adminToken = await factory.loginByEmail(admin.email);

      await http()
        .post(`/rest/v1/admin/organisations/${orgA.organisation.id}/suspend`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send(suspendBody(orgA.organisation));

      const bToken = await factory.loginByEmail(orgB.email);
      const res = await http().get('/rest/v1/auth/me').set('Authorization', `Bearer ${bToken}`);
      expect(res.status).toBe(200);

      const [rowA] = await adminDataSource.manager.query(`SELECT suspended_at FROM core.organisation WHERE id = $1`, [orgA.organisation.id]);
      const [rowB] = await adminDataSource.manager.query(`SELECT suspended_at FROM core.organisation WHERE id = $1`, [orgB.organisation.id]);
      expect(rowA.suspended_at).not.toBeNull();
      expect(rowB.suspended_at).toBeNull();
    });
  });

  describe('concurrent suspension', () => {
    it('two simultaneous suspend calls for the same organisation are idempotent — exactly one audit entry, no crash', async () => {
      const admin = await seedPlatformAdmin();
      const target = await seedTargetOrg();
      const adminToken = await factory.loginByEmail(admin.email);

      const [resA, resB] = await Promise.all([
        http()
          .post(`/rest/v1/admin/organisations/${target.organisation.id}/suspend`)
          .set('Authorization', `Bearer ${adminToken}`)
          .send(suspendBody(target.organisation)),
        http()
          .post(`/rest/v1/admin/organisations/${target.organisation.id}/suspend`)
          .set('Authorization', `Bearer ${adminToken}`)
          .send(suspendBody(target.organisation)),
      ]);

      expect([resA.status, resB.status]).toEqual([201, 201]);

      const auditRows = await adminDataSource.manager.query(
        `SELECT id FROM core.audit_log WHERE action = 'organisation.suspended' AND entity_id = $1`,
        [target.organisation.id],
      );
      expect(auditRows).toHaveLength(1);
    });
  });

  describe('reactivation', () => {
    it('reactivation restores login/API eligibility but does NOT resurrect a session revoked while suspended', async () => {
      const admin = await seedPlatformAdmin();
      const target = await seedTargetOrg();
      const { refreshToken: preSuspendRefreshToken } = await factory.loginTokens({ kind: 'internal_manager', email: target.email, password: factory.testPassword });
      const adminToken = await factory.loginByEmail(admin.email);

      await http()
        .post(`/rest/v1/admin/organisations/${target.organisation.id}/suspend`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send(suspendBody(target.organisation));

      const reactivateRes = await http()
        .post(`/rest/v1/admin/organisations/${target.organisation.id}/reactivate`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ currentPassword: factory.testPassword });
      expect(reactivateRes.status).toBe(200); // @HttpCode(200) on the reactivate route — a state transition, not a creation
      expect(reactivateRes.body.suspended).toBe(false);
      expect(reactivateRes.body.reactivatedBy).toBe(admin.userId);

      // Eligibility restored: a FRESH login succeeds again.
      const freshToken = await factory.loginByEmail(target.email);
      expect(typeof freshToken).toBe('string');

      // But the refresh token issued BEFORE suspension was revoked, not merely blocked — it must
      // stay dead even now that the organisation is active again (owner's requirement 8).
      const refreshRes = await http().post('/rest/v1/auth/refresh').set('x-client-platform', 'mobile').send({ refreshToken: preSuspendRefreshToken });
      expect(refreshRes.status).toBe(401);
    });

    it('reactivating an already-active organisation is a no-op — no error, no change', async () => {
      const admin = await seedPlatformAdmin();
      const target = await seedTargetOrg();
      const adminToken = await factory.loginByEmail(admin.email);

      const res = await http()
        .post(`/rest/v1/admin/organisations/${target.organisation.id}/reactivate`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ currentPassword: factory.testPassword });

      expect(res.status).toBe(200);
      expect(res.body.suspended).toBe(false);
    });
  });
});
