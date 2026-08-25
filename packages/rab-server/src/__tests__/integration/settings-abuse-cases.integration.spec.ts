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
  PlatformAdminClaim,
  PlatformConfig,
  RefreshToken,
  Role,
  RolePermission,
  User,
  UserPreference,
  UserRole,
} from '../../modules/identity/entities';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { PlatformAdminService } from '../../engine/core-modules/platform-admin/platform-admin.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';

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
  let passwordHashing: PasswordHashingService;
  let tenantContext: TenantContextService;
  let platformAdmin: PlatformAdminService;

  const password = 'correct horse battery staple 1!';

  /** Seeds an organisation with one active user holding EVERY existing PermissionFlag — the strongest non-owner adversary this suite can construct. */
  async function seedOrgWithFullyPermissionedUser(): Promise<{ organisation: Organisation; email: string; userId: string }> {
    const slug = `test-${randomUUID()}`;
    const email = `full-perms-${randomUUID()}@example.test`;

    const insertResult = await dataSource.manager.insert(Organisation, { name: slug, slug });
    const organisation = await dataSource.manager.findOneByOrFail(Organisation, {
      id: insertResult.identifiers[0]!.id as string,
    });

    let userId = '';
    await tenantContext.runInTenantContext(
      { organisationId: organisation.id, userId: randomUUID(), role: '' },
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
    platformAdmin = moduleRef.get(PlatformAdminService);
  });

  afterAll(async () => {
    await app.close();
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

    it('the organisation owner (tryClaim winner) is granted access', async () => {
      const { organisation, email, userId } = await seedOrgWithFullyPermissionedUser();
      const claimed = await tenantContext.runInTenantContext(
        { organisationId: organisation.id, userId, role: '' },
        (manager) => platformAdmin.tryClaim(manager, organisation.id, userId),
      );
      expect(claimed).toBe(true);

      const token = await login(email);
      const res = await request(app.getHttpServer()).get('/rest/v1/admin/general').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.version).toEqual(expect.any(String));
    });

    it("/admin/recent-users is tenant-scoped — an owner never sees another organisation's users", async () => {
      const ownerOrg = await seedOrgWithFullyPermissionedUser();
      await tenantContext.runInTenantContext(
        { organisationId: ownerOrg.organisation.id, userId: ownerOrg.userId, role: '' },
        (manager) => platformAdmin.tryClaim(manager, ownerOrg.organisation.id, ownerOrg.userId),
      );
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

  describe('PlatformAdminService.tryClaim — race safety and non-repromotion', () => {
    it('two concurrent claim attempts for the same organisation resolve to exactly one winner', async () => {
      const { organisation, userId: userA } = await seedOrgWithFullyPermissionedUser();
      const userB = (
        await dataSource.manager.insert(User, {
          organisationId: organisation.id,
          email: `race-b-${randomUUID()}@example.test`,
          passwordHash: await passwordHashing.hash(password),
          firstName: 'Race',
          lastName: 'B',
          status: UserStatus.ACTIVE,
        })
      ).identifiers[0]!.id as string;

      const [resultA, resultB] = await Promise.all([
        tenantContext.runInTenantContext(
          { organisationId: organisation.id, userId: userA, role: '' },
          (manager) => platformAdmin.tryClaim(manager, organisation.id, userA),
        ),
        tenantContext.runInTenantContext(
          { organisationId: organisation.id, userId: userB, role: '' },
          (manager) => platformAdmin.tryClaim(manager, organisation.id, userB),
        ),
      ]);

      expect([resultA, resultB].filter(Boolean)).toHaveLength(1);
      const claims = await tenantContext.runInTenantContext(
        { organisationId: organisation.id, userId: userA, role: '' },
        (manager) => manager.find(PlatformAdminClaim, { where: { organisationId: organisation.id } }),
      );
      expect(claims).toHaveLength(1);
    });

    it('a revoked claim is never reclaimed by a later tryClaim call', async () => {
      const { organisation, userId: originalOwner } = await seedOrgWithFullyPermissionedUser();
      const ownerCtx = { organisationId: organisation.id, userId: originalOwner, role: '' };
      await tenantContext.runInTenantContext(ownerCtx, (manager) => platformAdmin.tryClaim(manager, organisation.id, originalOwner));
      await tenantContext.runInTenantContext(ownerCtx, (manager) =>
        manager.update(PlatformAdminClaim, { organisationId: organisation.id }, { revokedAt: new Date() }),
      );

      const newUser = (
        await dataSource.manager.insert(User, {
          organisationId: organisation.id,
          email: `successor-${randomUUID()}@example.test`,
          passwordHash: await passwordHashing.hash(password),
          firstName: 'New',
          lastName: 'User',
          status: UserStatus.ACTIVE,
        })
      ).identifiers[0]!.id as string;

      const reclaimed = await tenantContext.runInTenantContext(
        { organisationId: organisation.id, userId: newUser, role: '' },
        (manager) => platformAdmin.tryClaim(manager, organisation.id, newUser),
      );
      expect(reclaimed).toBe(false);

      const claim = await tenantContext.runInTenantContext(
        { organisationId: organisation.id, userId: originalOwner, role: '' },
        (manager) => manager.findOneByOrFail(PlatformAdminClaim, { organisationId: organisation.id }),
      );
      expect(claim.userId).toBe(originalOwner);
      expect(claim.revokedAt).not.toBeNull();
    });
  });

  describe('cross-tenant access to another organisation\'s session is rejected', () => {
    it('DELETE /profile/sessions/:familyId 404s for a family belonging to a different organisation', async () => {
      const orgA = await seedOrgWithFullyPermissionedUser();
      const orgB = await seedOrgWithFullyPermissionedUser();

      const familyId = randomUUID();
      await dataSource.manager.insert(RefreshToken, {
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

  describe('row-level security — the fail-closed guarantee', () => {
    it('a query with no tenant context bound returns zero rows for every new Settings table', async () => {
      const { organisation, userId } = await seedOrgWithFullyPermissionedUser();

      // Seed a real row in each new table first, via a properly bound
      // tenant context — this asserts RLS is actively filtering them out
      // of the unscoped read below, not that the tables just happen to be
      // empty.
      await tenantContext.runInTenantContext({ organisationId: organisation.id, userId, role: '' }, async (manager) => {
        await manager.insert(UserPreference, { userId, organisationId: organisation.id });
        await manager.insert(NotificationPreference, {
          userId,
          organisationId: organisation.id,
          notificationType: 'offer_sent',
        });
        await manager.insert(PlatformConfig, { organisationId: organisation.id, smtpHost: 'smtp.example.test' });
        await platformAdmin.tryClaim(manager, organisation.id, userId);
      });

      await expect(dataSource.manager.find(UserPreference, { where: { organisationId: organisation.id } })).resolves.toEqual([]);
      await expect(
        dataSource.manager.find(NotificationPreference, { where: { organisationId: organisation.id } }),
      ).resolves.toEqual([]);
      await expect(
        dataSource.manager.find(PlatformAdminClaim, { where: { organisationId: organisation.id } }),
      ).resolves.toEqual([]);
      await expect(dataSource.manager.find(PlatformConfig, { where: { organisationId: organisation.id } })).resolves.toEqual([]);
    });
  });
});
