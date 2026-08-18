import 'reflect-metadata';
import { PermissionFlag, UserStatus } from '@rab/shared';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import {
  Organisation,
  Permission,
  Role,
  RolePermission,
  User,
  UserRole,
} from '../../modules/identity/entities';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';

/**
 * Integration tests (rab-workforce-architecture.md §1.2 abuse-case suite):
 * real Postgres, RLS on, no mocks. Needs DATABASE_URL — ci-server.yaml
 * provides it (postgres-init bootstraps rab_owner/rab_app so this runs
 * against the real role model, not a bare superuser). Skips locally if
 * unset rather than failing a plain `yarn test` for a dev without Postgres
 * running.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('auth abuse cases (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let passwordHashing: PasswordHashingService;
  let tenantContext: TenantContextService;

  const password = 'correct horse battery staple 1!';
  let orgA: Organisation;
  let orgB: Organisation;
  let orgAAdminEmail: string;

  async function seedOrgWithAdmin(
    overrides: { email?: string; password?: string } = {},
  ): Promise<{ organisation: Organisation; adminEmail: string }> {
    const slug = `test-${randomUUID()}`;
    const email = overrides.email ?? `admin-${randomUUID()}@example.test`;
    const adminPassword = overrides.password ?? password;

    const insertResult = await dataSource.manager.insert(Organisation, { name: slug, slug });
    const organisation = await dataSource.manager.findOneByOrFail(Organisation, {
      id: insertResult.identifiers[0]!.id as string,
    });

    await tenantContext.runInTenantContext(
      { organisationId: organisation.id, userId: randomUUID(), role: '' },
      async (manager) => {
        let permission = await manager.findOne(Permission, {
          where: { key: PermissionFlag.PAYROLL_APPROVE },
        });
        if (!permission) {
          permission = await manager.save(Permission, {
            key: PermissionFlag.PAYROLL_APPROVE,
            resource: 'payroll',
            action: 'approve',
          });
        }

        const roleResult = await manager.insert(Role, {
          organisationId: organisation.id,
          key: 'org_admin',
          name: 'Org Admin',
          isSystem: true,
        });
        const roleId = roleResult.identifiers[0]!.id as string;
        await manager.insert(RolePermission, {
          roleId,
          permissionId: permission.id,
          organisationId: organisation.id,
        });

        const passwordHash = await passwordHashing.hash(adminPassword);
        const userResult = await manager.insert(User, {
          organisationId: organisation.id,
          email,
          passwordHash,
          firstName: 'Test',
          lastName: 'Admin',
          status: UserStatus.ACTIVE,
        });
        await manager.insert(UserRole, {
          userId: userResult.identifiers[0]!.id as string,
          roleId,
          organisationId: organisation.id,
        });
      },
    );

    return { organisation, adminEmail: email };
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    dataSource = moduleRef.get(DataSource);
    passwordHashing = moduleRef.get(PasswordHashingService);
    tenantContext = moduleRef.get(TenantContextService);

    const a = await seedOrgWithAdmin();
    orgA = a.organisation;
    orgAAdminEmail = a.adminEmail;
    const b = await seedOrgWithAdmin();
    orgB = b.organisation;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('login', () => {
    it('succeeds with correct email/password — no organisation slug required', async () => {
      const res = await request(app.getHttpServer())
        .post('/rest/v1/auth/login')
        .send({ email: orgAAdminEmail, password });
      expect(res.status).toBe(200);
      expect(res.body.accessToken).toEqual(expect.any(String));
      expect(res.body.refreshToken).toEqual(expect.any(String));
    });

    it('wrong password → 401 with the generic message', async () => {
      const res = await request(app.getHttpServer())
        .post('/rest/v1/auth/login')
        .send({ email: orgAAdminEmail, password: 'wrong' });
      expect(res.status).toBe(401);
      expect(res.body.message).toBe('Invalid email or password.');
    });

    it('unknown email → the SAME message as wrong password (no enumeration)', async () => {
      const res = await request(app.getHttpServer())
        .post('/rest/v1/auth/login')
        .send({ email: 'nobody@example.test', password });
      expect(res.status).toBe(401);
      expect(res.body.message).toBe('Invalid email or password.');
    });

    it('the same email registered under two different orgs with different passwords resolves to the matching org, not the other one', async () => {
      const sharedEmail = `shared-${randomUUID()}@example.test`;
      const passwordForOrgA = 'orgA correct horse battery staple!';
      const passwordForOrgC = 'orgC correct horse battery staple!';
      const seededA = await seedOrgWithAdmin({ email: sharedEmail, password: passwordForOrgA });
      const seededC = await seedOrgWithAdmin({ email: sharedEmail, password: passwordForOrgC });

      const loginA = await request(app.getHttpServer())
        .post('/rest/v1/auth/login')
        .send({ email: sharedEmail, password: passwordForOrgA });
      expect(loginA.status).toBe(200);

      const meA = await request(app.getHttpServer())
        .get('/rest/v1/auth/me')
        .set('Authorization', `Bearer ${loginA.body.accessToken}`);
      expect(meA.body.organisationId).toBe(seededA.organisation.id);
      expect(meA.body.organisationId).not.toBe(seededC.organisation.id);

      const loginC = await request(app.getHttpServer())
        .post('/rest/v1/auth/login')
        .send({ email: sharedEmail, password: passwordForOrgC });
      expect(loginC.status).toBe(200);
      const meC = await request(app.getHttpServer())
        .get('/rest/v1/auth/me')
        .set('Authorization', `Bearer ${loginC.body.accessToken}`);
      expect(meC.body.organisationId).toBe(seededC.organisation.id);

      // A password that's valid for neither of the two org accounts still 401s.
      const wrongForBoth = await request(app.getHttpServer())
        .post('/rest/v1/auth/login')
        .send({ email: sharedEmail, password: 'neither of the above' });
      expect(wrongForBoth.status).toBe(401);
    });

    it('rejects a request body carrying unknown fields (e.g. organisationId/organisationSlug injection attempt)', async () => {
      const res = await request(app.getHttpServer())
        .post('/rest/v1/auth/login')
        .send({ email: orgAAdminEmail, password, organisationId: orgB.id });
      expect(res.status).toBe(400);

      const legacySlug = await request(app.getHttpServer())
        .post('/rest/v1/auth/login')
        .send({ organisationSlug: orgA.slug, email: orgAAdminEmail, password });
      expect(legacySlug.status).toBe(400);
    });
  });

  describe('refresh token reuse', () => {
    it('reusing a rotated-away token revokes the WHOLE family, including the newer token', async () => {
      const login = await request(app.getHttpServer())
        .post('/rest/v1/auth/login')
        .send({ email: orgAAdminEmail, password });
      const originalRefresh = login.body.refreshToken;

      const rotate1 = await request(app.getHttpServer())
        .post('/rest/v1/auth/refresh')
        .send({ refreshToken: originalRefresh });
      expect(rotate1.status).toBe(200);
      const rotatedRefresh = rotate1.body.refreshToken;

      // Replay the original (already-rotated-away) token.
      const replay = await request(app.getHttpServer())
        .post('/rest/v1/auth/refresh')
        .send({ refreshToken: originalRefresh });
      expect(replay.status).toBe(401);

      // The legitimately-rotated token must ALSO be dead now — reuse
      // detection revokes the family, not just the one bad token.
      const rotate2 = await request(app.getHttpServer())
        .post('/rest/v1/auth/refresh')
        .send({ refreshToken: rotatedRefresh });
      expect(rotate2.status).toBe(401);
    });
  });

  describe('logout', () => {
    it('requires a bearer token', async () => {
      const res = await request(app.getHttpServer())
        .post('/rest/v1/auth/logout')
        .send({ refreshToken: 'whatever' });
      expect(res.status).toBe(401);
    });

    it('revokes the refresh token so it cannot be used again', async () => {
      const login = await request(app.getHttpServer())
        .post('/rest/v1/auth/login')
        .send({ email: orgAAdminEmail, password });

      const logoutRes = await request(app.getHttpServer())
        .post('/rest/v1/auth/logout')
        .set('Authorization', `Bearer ${login.body.accessToken}`)
        .send({ refreshToken: login.body.refreshToken });
      expect(logoutRes.status).toBe(204);

      const afterLogout = await request(app.getHttpServer())
        .post('/rest/v1/auth/refresh')
        .send({ refreshToken: login.body.refreshToken });
      expect(afterLogout.status).toBe(401);
    });
  });

  describe('row-level security — the fail-closed guarantee', () => {
    it('a query with no tenant context bound returns zero rows, not all rows', async () => {
      // Direct query, no runInTenantContext — `core.role` is FORCEd, and
      // `rab.organisation_id` is unset on this connection.
      const rows = await dataSource.manager.find(Role);
      expect(rows).toEqual([]);
    });

    it("org A's bound context cannot see org B's roles", async () => {
      const rows = await tenantContext.runInTenantContext(
        { organisationId: orgA.id, userId: randomUUID(), role: '' },
        (manager) => manager.find(Role, { where: { organisationId: orgB.id } }),
      );
      expect(rows).toEqual([]);
    });

    it("org A's bound context CAN see org A's own roles", async () => {
      const rows = await tenantContext.runInTenantContext(
        { organisationId: orgA.id, userId: randomUUID(), role: '' },
        (manager) => manager.find(Role, { where: { organisationId: orgA.id } }),
      );
      expect(rows.length).toBeGreaterThan(0);
    });
  });
});
