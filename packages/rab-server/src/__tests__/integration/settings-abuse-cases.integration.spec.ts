import 'reflect-metadata';
import { PermissionFlag, UserStatus } from '@rab/shared';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
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
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { createAdminDataSource } from './helpers/admin-datasource';

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
  let passwordHashing: PasswordHashingService;
  let tenantContext: TenantContextService;

  const password = 'correct horse battery staple 1!';

  /** Seeds an organisation with one active user holding EVERY existing PermissionFlag — the strongest non-owner adversary this suite can construct. */
  async function seedOrgWithFullyPermissionedUser(): Promise<{ organisation: Organisation; email: string; userId: string }> {
    const slug = `test-${randomUUID()}`;
    const email = `full-perms-${randomUUID()}@example.test`;

    const insertResult = await adminDataSource.manager.insert(Organisation, { name: slug, slug });
    const organisation = await adminDataSource.manager.findOneByOrFail(Organisation, {
      id: insertResult.identifiers[0]!.id as string,
    });

    let userId = '';
    await tenantContext.runInTenantContext(
      { organisationId: organisation.id, workspaceId: null, userId: randomUUID(), role: '' },
      async (manager) => {
        const allPermissionKeys = Object.values(PermissionFlag);
        const permissions = await Promise.all(
          allPermissionKeys.map(async (key) => {
            let permission = await manager.findOne(Permission, { where: { key } });
            if (!permission) {
              const [resource, action] = key.split('.');
              permission = await manager.save(Permission, { key, resource, action });
            }
            return permission;
          }),
        );

        const roleResult = await manager.insert(Role, {
          organisationId: organisation.id,
          key: 'everything',
          name: 'Everything',
          isSystem: false,
        });
        const roleId = roleResult.identifiers[0]!.id as string;
        await manager.insert(
          RolePermission,
          permissions.map((p) => ({ roleId, permissionId: p.id, organisationId: organisation.id })),
        );

        const passwordHash = await passwordHashing.hash(password);
        const userResult = await manager.insert(User, {
          organisationId: organisation.id,
          email,
          passwordHash,
          firstName: 'Full',
          lastName: 'Perms',
          status: UserStatus.ACTIVE,
        });
        userId = userResult.identifiers[0]!.id as string;
        await manager.insert(UserRole, { userId, roleId, organisationId: organisation.id });
      },
    );

    return { organisation, email, userId };
  }

  async function login(email: string): Promise<string> {
    const res = await request(app.getHttpServer()).post('/rest/v1/auth/login').send({ email, password });
    expect(res.status).toBe(200);
    return res.body.accessToken as string;
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

    it('an existing platform admin can grant another user platform_admin status; the target immediately gains access', async () => {
      const { userId: adminUserId, email: adminEmail } = await seedOrgWithFullyPermissionedUser();
      await bootstrapAdmin(adminUserId);
      const adminToken = await login(adminEmail);

      const target = await seedOrgWithFullyPermissionedUser();
      const targetToken = await login(target.email);

      const before = await request(app.getHttpServer()).get('/rest/v1/admin/general').set('Authorization', `Bearer ${targetToken}`);
      expect(before.status).toBe(403);

      const grantRes = await request(app.getHttpServer())
        .post(`/rest/v1/admin/platform-admins/${target.userId}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(grantRes.status).toBe(201);
      expect(grantRes.body.granted).toBe(true);

      const after = await request(app.getHttpServer()).get('/rest/v1/admin/general').set('Authorization', `Bearer ${targetToken}`);
      expect(after.status).toBe(200);
    });

    it('a non-admin — even one holding every existing PermissionFlag — cannot grant platform_admin to anyone (blocked by PlatformAdminGuard before the handler runs)', async () => {
      const { email: nonAdminEmail } = await seedOrgWithFullyPermissionedUser();
      const nonAdminToken = await login(nonAdminEmail);
      const target = await seedOrgWithFullyPermissionedUser();

      const res = await request(app.getHttpServer())
        .post(`/rest/v1/admin/platform-admins/${target.userId}`)
        .set('Authorization', `Bearer ${nonAdminToken}`);
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
        .set('Authorization', `Bearer ${adminToken}`);
      expect(revokeRes.status).toBe(200);
      expect(revokeRes.body.revoked).toBe(true);

      const after = await request(app.getHttpServer()).get('/rest/v1/admin/general').set('Authorization', `Bearer ${secondAdminToken}`);
      expect(after.status).toBe(403);
    });

    it('a revoked admin can be re-granted, and immediately regains access (no permanent lockout)', async () => {
      const { userId: adminUserId, email: adminEmail } = await seedOrgWithFullyPermissionedUser();
      await bootstrapAdmin(adminUserId);
      const adminToken = await login(adminEmail);

      await request(app.getHttpServer()).delete(`/rest/v1/admin/platform-admins/${adminUserId}`).set('Authorization', `Bearer ${adminToken}`);
      // Now revoked — needs a second, still-active admin to re-grant (matches
      // the guard: only an ACTIVE admin may grant/revoke).
      const { userId: secondAdminUserId, email: secondAdminEmail } = await seedOrgWithFullyPermissionedUser();
      await bootstrapAdmin(secondAdminUserId);
      const secondAdminToken = await login(secondAdminEmail);

      const stillBlocked = await request(app.getHttpServer()).get('/rest/v1/admin/general').set('Authorization', `Bearer ${adminToken}`);
      expect(stillBlocked.status).toBe(403);

      const regrant = await request(app.getHttpServer())
        .post(`/rest/v1/admin/platform-admins/${adminUserId}`)
        .set('Authorization', `Bearer ${secondAdminToken}`);
      expect(regrant.status).toBe(201);
      expect(regrant.body.granted).toBe(true);

      const restored = await request(app.getHttpServer()).get('/rest/v1/admin/general').set('Authorization', `Bearer ${adminToken}`);
      expect(restored.status).toBe(200);
    });

    it('granting an already-active admin is idempotent, not an error', async () => {
      const { userId: adminUserId, email: adminEmail } = await seedOrgWithFullyPermissionedUser();
      await bootstrapAdmin(adminUserId);
      const adminToken = await login(adminEmail);

      const res = await request(app.getHttpServer())
        .post(`/rest/v1/admin/platform-admins/${adminUserId}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(201);
      expect(res.body.granted).toBe(false); // already active — no row change, not an error
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
      });

      const tokenA = await login(orgA.email);
      const res = await request(app.getHttpServer())
        .delete(`/rest/v1/profile/sessions/${familyId}`)
        .set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(404);
    });
  });

  describe('PATCH /workspace/domain — cross-org slug collision', () => {
    it('rejects a slug already taken by a different organisation with a clean 409, not a 500', async () => {
      // Regression test for a real, previously-latent bug: this pre-check
      // runs on the unscoped dataSource.manager connection, outside any
      // bound tenant context. `organisation` is intentionally not FORCE'd
      // (pre-auth login needs to look up an org by email/slug before any
      // tenant context can exist) — but under the intended rab_app runtime
      // role, a query with no context bound sees zero rows regardless,
      // which used to make this check a permanent no-op and let a genuine
      // collision reach the DB's raw UNIQUE(slug) constraint as an
      // unhandled 500 instead of this clean 409.
      const taken = await seedOrgWithFullyPermissionedUser();
      const other = await seedOrgWithFullyPermissionedUser();
      const otherToken = await login(other.email);

      const res = await request(app.getHttpServer())
        .patch('/rest/v1/workspace/domain')
        .set('Authorization', `Bearer ${otherToken}`)
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
