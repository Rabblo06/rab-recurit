import { PasswordResetTokenService } from '../../engine/core-modules/auth/token/services/password-reset-token.service';
import { PasswordResetTokenPurpose } from '@rab/shared';
import 'reflect-metadata';
import { MAX_PASSWORD_LENGTH, PermissionFlag, UserStatus } from '@rab/shared';
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
import { EnvironmentService } from '../../engine/core-modules/environment/environment.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { createAdminDataSource } from './helpers/admin-datasource';

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

describeIfDb('application-bound authentication (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let passwordHashing: PasswordHashingService;
  let tenantContext: TenantContextService;
  let webOrigin: string;

  const password = 'Correct horse battery staple 1!';
  let orgA: Organisation;
  let orgB: Organisation;
  let orgAAdminEmail: string;

  async function seedOrgWithAdmin(
    overrides: { email?: string; password?: string; role?: string; status?: 'active' | 'invited' } = {},
  ): Promise<{ organisation: Organisation; adminEmail: string }> {
    const slug = `test-${randomUUID()}`;
    const email = overrides.email ?? `admin-${randomUUID()}@example.test`;
    const adminPassword = overrides.password ?? password;

    const insertResult = await adminDataSource.manager.insert(Organisation, { name: slug, slug });
    const organisation = await adminDataSource.manager.findOneByOrFail(Organisation, {
      id: insertResult.identifiers[0]!.id as string,
    });

    await tenantContext.runInTenantContext(
      { organisationId: organisation.id, workspaceId: null, userId: randomUUID(), role: '' },
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
          key: overrides.role ?? 'org_admin',
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
          status: overrides.status ?? UserStatus.ACTIVE,
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
    webOrigin = moduleRef.get(EnvironmentService).corsOrigins[0]!;
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();

    const a = await seedOrgWithAdmin();
    orgA = a.organisation;
    orgAAdminEmail = a.adminEmail;
    const b = await seedOrgWithAdmin();
    orgB = b.organisation;
  });

  afterAll(async () => {
    await app.close();
    await adminDataSource.destroy();
  });


  for (const role of ['staff', 'venue_manager', 'manager']) {
    it(role + ' uses universal mobile login with server-derived identity', async () => {
      const seed = await seedOrgWithAdmin({ role });
      const res = await request(app.getHttpServer()).post('/rest/v1/auth/login').set('X-Client-Platform', 'mobile').send({ email: seed.adminEmail, password });
      expect(res.status).toBe(200);
      const target = role === 'venue_manager' ? 'venue_manager_app' : 'staff_app';
      const payload = JSON.parse(Buffer.from(res.body.accessToken.split('.')[1], 'base64url').toString());
      expect(payload.applicationTarget).toBe(target);
      expect(payload.roles).toEqual([role]);
      const me = await request(app.getHttpServer()).get('/rest/v1/auth/me').set('Authorization', 'Bearer ' + res.body.accessToken);
      expect(me.status).toBe(200);
      expect(me.body.roles).toEqual([role]);
      const refresh = await request(app.getHttpServer()).post('/rest/v1/auth/refresh').set('X-Client-Platform', 'mobile').send({ refreshToken: res.body.refreshToken });
      expect(refresh.status).toBe(200);
      const wrong = await request(app.getHttpServer()).get('/rest/v1/auth/me').set('Authorization', 'Bearer ' + res.body.accessToken).set('X-Application-Target', target === 'staff_app' ? 'venue_manager_app' : 'staff_app');
      expect(wrong.status).toBe(403);
    });
    it(role + ' follows the complete application matrix without changing identity', async () => {
      const seed = await seedOrgWithAdmin({ role });
      for (const applicationTarget of ['manager_web', 'venue_manager_app', 'staff_app']) {
        const allowed = role === 'manager' || (role === 'staff' ? applicationTarget === 'staff_app' : applicationTarget === 'venue_manager_app');
        const res = await request(app.getHttpServer()).post('/rest/v1/auth/login').set('X-Client-Platform', 'mobile').send({ email: seed.adminEmail, password, applicationTarget });
        expect(res.status).toBe(allowed ? 200 : 403);
        if (!allowed) {
          expect(res.body.code).toBe('APPLICATION_ACCESS_DENIED');
          expect(res.body.accessToken).toBeUndefined();
          expect(res.headers['set-cookie']).toBeUndefined();
          continue;
        }
        const me = await request(app.getHttpServer()).get('/rest/v1/auth/me').set('Authorization', 'Bearer ' + res.body.accessToken).set('X-Application-Target', applicationTarget);
        expect(me.status).toBe(200);
        expect(me.body.roles).toEqual([role]);
        const refreshed = await request(app.getHttpServer()).post('/rest/v1/auth/refresh').set('X-Client-Platform', 'mobile').set('X-Application-Target', applicationTarget).send({ refreshToken: res.body.refreshToken });
        expect(refreshed.status).toBe(200);
        const payload = JSON.parse(Buffer.from(refreshed.body.accessToken.split('.')[1], 'base64url').toString());
        expect(payload.applicationTarget).toBe(applicationTarget);
        expect(payload.roles).toEqual([role]);
        if (applicationTarget !== 'manager_web') {
          const wrong = await request(app.getHttpServer()).post('/rest/v1/auth/refresh').set('X-Application-Target', 'manager_web').send({ refreshToken: refreshed.body.refreshToken });
          expect(wrong.status).toBe(403);
          const managerApi = await request(app.getHttpServer()).get('/rest/v1/auth/me').set('Authorization', 'Bearer ' + refreshed.body.accessToken).set('X-Application-Target', 'manager_web');
          expect(managerApi.status).toBe(403);
          const withoutHeader = await request(app.getHttpServer()).get('/rest/v1/roles').set('Authorization', 'Bearer ' + refreshed.body.accessToken);
          expect(withoutHeader.status).toBe(403);
        }
      }
    });
  }
  it('does not activate invited staff on reset or wrong-app login; activates on Staff login', async () => {
    const seed = await seedOrgWithAdmin({ role: 'staff', status: 'invited' });
    const user = await adminDataSource.manager.findOneByOrFail(User, { email: seed.adminEmail });
    const ctx = { organisationId: seed.organisation.id, workspaceId: null, userId: user.id, role: '' };
    const token = await tenantContext.runInTenantContext(ctx, manager => app.get(PasswordResetTokenService).issue(manager, { organisationId: seed.organisation.id, userId: user.id, purpose: PasswordResetTokenPurpose.FORGOT_PASSWORD, applicationTarget: 'staff_app' }));
    const reset = await request(app.getHttpServer()).post('/rest/v1/auth/reset-password').send({ token: token.token, newPassword: password });
    expect(reset.status).toBe(200);
    expect(reset.body).toEqual({ applicationTarget: 'staff_app' });
    expect(reset.headers['set-cookie']).toBeUndefined();
    expect((await adminDataSource.manager.findOneByOrFail(User, { id: user.id })).status).toBe('invited');
    const wrong = await request(app.getHttpServer()).post('/rest/v1/auth/login').send({ email: seed.adminEmail, password, applicationTarget: 'manager_web' });
    expect(wrong.status).toBe(403);
    expect((await adminDataSource.manager.findOneByOrFail(User, { id: user.id })).status).toBe('invited');
    const right = await request(app.getHttpServer()).post('/rest/v1/auth/login').send({ email: seed.adminEmail, password, applicationTarget: 'staff_app' });
    expect(right.status).toBe(200);
    expect((await adminDataSource.manager.findOneByOrFail(User, { id: user.id })).status).toBe('active');
  });
  it('keeps the existing ten-failure account limiter and reports Retry-After', async () => {
    const email = 'bad-' + randomUUID() + '@example.test';
    for (let i = 0; i < 10; i++) {
      const res = await request(app.getHttpServer()).post('/rest/v1/auth/login').send({ email, password: 'wrong', applicationTarget: 'manager_web' });
      expect(res.status).toBe(401);
      expect(res.body.message).toBe('Invalid email or password.');
    }
    const res = await request(app.getHttpServer()).post('/rest/v1/auth/login').send({ email, password: 'wrong', applicationTarget: 'manager_web' });
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe('900');
  });
  it('rejects role/tenant injection and arbitrary application targets', async () => {
    for (const extra of [{ role: 'manager' }, { organisationId: orgA.id }, { applicationTarget: 'https://evil.example' }]) {
      const res = await request(app.getHttpServer()).post('/rest/v1/auth/login').send({ email: orgAAdminEmail, password, ...extra });
      expect(res.status).toBe(400);
    }
  });
  it('rejects a formerly allowed session after its role is removed', async () => {
    const seed = await seedOrgWithAdmin({ role: 'manager' });
    const login = await request(app.getHttpServer()).post('/rest/v1/auth/login').set('X-Client-Platform', 'mobile').send({ email: seed.adminEmail, password, applicationTarget: 'manager_web' });
    expect(login.status).toBe(200);
    const user = await adminDataSource.manager.findOneByOrFail(User, { email: seed.adminEmail });
    await tenantContext.runInTenantContext({ organisationId: seed.organisation.id, workspaceId: null, userId: user.id, role: 'manager' }, manager => manager.delete(UserRole, { userId: user.id }));
    const me = await request(app.getHttpServer()).get('/rest/v1/auth/me').set('Authorization', 'Bearer ' + login.body.accessToken);
    expect(me.status).toBe(403);
    const refresh = await request(app.getHttpServer()).post('/rest/v1/auth/refresh').set('X-Client-Platform', 'mobile').set('X-Application-Target', 'manager_web').send({ refreshToken: login.body.refreshToken });
    expect(refresh.status).toBe(403);
  });
});
