import 'reflect-metadata';
import { PermissionFlag, UserStatus } from '@rab/shared';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { Organisation, Permission, Role, RolePermission, User, UserRole } from '../../modules/identity/entities';
import { ManagerWorkspace } from '../../modules/manager-workspace/entities/manager-workspace.entity';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { createAdminDataSource } from './helpers/admin-datasource';

/**
 * Regression suite for a real, confirmed gap: before `ActiveAccountGuard`
 * existed, deactivating Staff (or suspending a Manager) changed a status
 * column nothing else read — the account's existing access token kept
 * working until its own 15-minute expiry, and its refresh token (never
 * revoked) could mint new ones indefinitely. Real Postgres, RLS on, no
 * mocks, same conventions as every other suite in this folder.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('account deactivation abuse cases (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let passwordHashing: PasswordHashingService;
  let tenantContext: TenantContextService;

  const password = 'correct horse battery staple 1!';
  const MANAGER_PERMS = [PermissionFlag.STAFF_CREATE, PermissionFlag.STAFF_VIEW, PermissionFlag.STAFF_DEACTIVATE, PermissionFlag.MANAGER_MANAGE];

  async function ensurePermission(key: string, resource: string, action: string): Promise<Permission> {
    let permission = await dataSource.manager.findOne(Permission, { where: { key } });
    if (!permission) permission = await dataSource.manager.save(Permission, { key, resource, action });
    return permission;
  }

  /** One org, one platform-admin manager (STAFF_DEACTIVATE + MANAGER_MANAGE). */
  async function seedOrg(): Promise<{ organisation: Organisation; managerEmail: string; managerUserId: string }> {
    const slug = `test-${randomUUID()}`;
    const managerEmail = `mgr-${randomUUID()}@example.test`;
    const orgInsert = await adminDataSource.manager.insert(Organisation, { name: slug, slug });
    const organisation = await adminDataSource.manager.findOneByOrFail(Organisation, { id: orgInsert.identifiers[0]!.id as string });

    let managerUserId!: string;
    await tenantContext.runInTenantContext({ organisationId: organisation.id, workspaceId: null, userId: randomUUID(), role: '' }, async (manager) => {
      const roleResult = await manager.insert(Role, { organisationId: organisation.id, key: `manager-${randomUUID()}`, name: 'Manager', isSystem: true });
      const roleId = roleResult.identifiers[0]!.id as string;
      for (const key of MANAGER_PERMS) {
        const permission = await ensurePermission(key, key.split('.')[0]!, key.split('.')[1]!);
        await manager.insert(RolePermission, { roleId, permissionId: permission.id, organisationId: organisation.id });
      }

      const passwordHash = await passwordHashing.hash(password);
      const userResult = await manager.insert(User, {
        organisationId: organisation.id,
        email: managerEmail,
        passwordHash,
        firstName: 'Manager',
        lastName: 'Test',
        status: UserStatus.ACTIVE,
      });
      managerUserId = userResult.identifiers[0]!.id as string;
      await manager.insert(UserRole, { userId: managerUserId, roleId, organisationId: organisation.id });
      // manager_workspace_write's WITH CHECK requires owner_user_id =
      // current_uid() — this transaction is bound to a throwaway bootstrap
      // identity, not the real new manager, so current_uid() must be
      // rebound to them just for this insert.
      await manager.query(`SELECT set_config('rab.user_id', $1, true)`, [managerUserId]);
      await manager.insert(ManagerWorkspace, {
        organisationId: organisation.id,
        ownerUserId: managerUserId,
        name: `Test Workspace ${managerUserId}`,
        subdomain: `test-${managerUserId.slice(0, 8)}`,
        status: 'active',
      });
    });
    await adminDataSource.manager.query(`INSERT INTO core.platform_admin (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [
      managerUserId,
    ]);

    return { organisation, managerEmail, managerUserId };
  }

  /** A second real Manager account, for the Manager-suspension test — no platform-admin claim. */
  async function seedSecondManager(organisation: Organisation): Promise<{ email: string; userId: string }> {
    const email = `mgr2-${randomUUID()}@example.test`;
    let userId!: string;
    await tenantContext.runInTenantContext({ organisationId: organisation.id, workspaceId: null, userId: randomUUID(), role: '' }, async (manager) => {
      const roleResult = await manager.insert(Role, { organisationId: organisation.id, key: `manager2-${randomUUID()}`, name: 'Manager2', isSystem: true });
      const roleId = roleResult.identifiers[0]!.id as string;
      const passwordHash = await passwordHashing.hash(password);
      const userResult = await manager.insert(User, {
        organisationId: organisation.id,
        email,
        passwordHash,
        firstName: 'ManagerB',
        lastName: 'Test',
        status: UserStatus.ACTIVE,
      });
      userId = userResult.identifiers[0]!.id as string;
      await manager.insert(UserRole, { userId, roleId, organisationId: organisation.id });
      await manager.query(`INSERT INTO core.manager_profile (organisation_id, user_id, type) VALUES ($1, $2, 'internal')`, [organisation.id, userId]);
    });
    return { email, userId };
  }

  /** Real password already set (ACTIVE, not INVITED) so the staff can log in immediately, matching this folder's established shortcut for tests that need a real staff session. */
  async function seedStaff(organisation: Organisation, createdByUserId: string): Promise<{ email: string; userId: string }> {
    const email = `staff-${randomUUID()}@example.test`;
    let userId!: string;
    const [{ id: creatorWorkspaceId }] = await adminDataSource.manager.query<[{ id: string }]>(
      `SELECT id FROM core.manager_workspace WHERE owner_user_id = $1`,
      [createdByUserId],
    );
    await tenantContext.runInTenantContext(
      { organisationId: organisation.id, workspaceId: creatorWorkspaceId, userId: randomUUID(), role: '' },
      async (manager) => {
      let role = await manager.findOne(Role, { where: { organisationId: organisation.id, key: 'staff' } });
      if (!role) {
        const roleResult = await manager.insert(Role, { organisationId: organisation.id, key: 'staff', name: 'Staff', isSystem: true });
        role = await manager.findOneByOrFail(Role, { id: roleResult.identifiers[0]!.id as string });
      }
      const passwordHash = await passwordHashing.hash(password);
      const userResult = await manager.insert(User, {
        organisationId: organisation.id,
        email,
        passwordHash,
        firstName: 'Staff',
        lastName: 'Member',
        status: UserStatus.ACTIVE,
      });
      userId = userResult.identifiers[0]!.id as string;
      await manager.insert(UserRole, { userId, roleId: role.id, organisationId: organisation.id });
      await manager.query(
        `INSERT INTO core.staff_profile (organisation_id, user_id, staff_ref, created_by, workspace_id) VALUES ($1, $2, $3, $4, $5)`,
        [organisation.id, userId, `STF-${randomUUID().slice(0, 8)}`, createdByUserId, creatorWorkspaceId],
      );
    });
    return { email, userId };
  }

  async function login(email: string): Promise<{ accessToken: string; refreshToken: string }> {
    // Mobile-flagged so the refresh token comes back in the body, as this
    // file's own assertions expect — the underlying revoke-on-deactivation
    // logic being tested here is identical for Web's cookie-based transport.
    const res = await request(app.getHttpServer())
      .post('/rest/v1/auth/login')
      .set('X-Client-Platform', 'mobile')
      .send({ email, password });
    expect(res.status).toBe(200);
    return { accessToken: res.body.accessToken as string, refreshToken: res.body.refreshToken as string };
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

  it('deactivating a Staff member denies their existing access token, their refresh token, and reactivation restores login', async () => {
    const { organisation, managerEmail, managerUserId } = await seedOrg();
    const staff = await seedStaff(organisation, managerUserId);
    const { accessToken, refreshToken } = await login(staff.email);

    // Sanity: the token works before deactivation.
    const before = await request(app.getHttpServer()).get('/rest/v1/auth/me').set('Authorization', `Bearer ${accessToken}`);
    expect(before.status).toBe(200);

    const managerToken = (await login(managerEmail)).accessToken;
    const [{ id: managerWorkspaceId }] = await adminDataSource.manager.query<[{ id: string }]>(
      `SELECT id FROM core.manager_workspace WHERE owner_user_id = $1`,
      [managerUserId],
    );
    const staffProfile = await tenantContext.runInTenantContext(
      { organisationId: organisation.id, workspaceId: managerWorkspaceId, userId: managerUserId, role: '' },
      (manager) => manager.query(`SELECT id FROM core.staff_profile WHERE user_id = $1`, [staff.userId]),
    );
    const staffProfileId = staffProfile[0].id as string;

    const deactivateRes = await request(app.getHttpServer())
      .post(`/rest/v1/staff/${staffProfileId}/deactivate`)
      .set('Authorization', `Bearer ${managerToken}`);
    expect(deactivateRes.status).toBe(201);

    // The still-unexpired access token must now be denied — the whole
    // point of ActiveAccountGuard, not just eventual refresh-revocation.
    const afterAccessToken = await request(app.getHttpServer()).get('/rest/v1/auth/me').set('Authorization', `Bearer ${accessToken}`);
    expect(afterAccessToken.status).toBe(401);

    // The refresh token must be revoked too — no way to mint a fresh access token instead.
    const refreshAttempt = await request(app.getHttpServer()).post('/rest/v1/auth/refresh').send({ refreshToken });
    expect(refreshAttempt.status).toBe(401);

    // Reactivate — a brand-new login must succeed again.
    const reactivateRes = await request(app.getHttpServer())
      .post(`/rest/v1/staff/${staffProfileId}/reactivate`)
      .set('Authorization', `Bearer ${managerToken}`);
    expect(reactivateRes.status).toBe(201);

    const afterReactivate = await login(staff.email);
    const meAfterReactivate = await request(app.getHttpServer())
      .get('/rest/v1/auth/me')
      .set('Authorization', `Bearer ${afterReactivate.accessToken}`);
    expect(meAfterReactivate.status).toBe(200);
  });

  it('suspending a Manager denies their existing access token and refresh token; reactivating restores login', async () => {
    const { organisation, managerEmail } = await seedOrg();
    const managerB = await seedSecondManager(organisation);
    const adminToken = (await login(managerEmail)).accessToken;
    const { accessToken, refreshToken } = await login(managerB.email);

    const before = await request(app.getHttpServer()).get('/rest/v1/auth/me').set('Authorization', `Bearer ${accessToken}`);
    expect(before.status).toBe(200);

    const managerBProfile = await tenantContext.runInTenantContext(
      { organisationId: organisation.id, workspaceId: null, userId: managerB.userId, role: '' },
      (manager) => manager.query(`SELECT id FROM core.manager_profile WHERE user_id = $1`, [managerB.userId]),
    );
    const managerBProfileId = managerBProfile[0].id as string;

    const suspendRes = await request(app.getHttpServer())
      .post(`/rest/v1/managers/${managerBProfileId}/deactivate`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(suspendRes.status).toBe(201);

    const afterAccessToken = await request(app.getHttpServer()).get('/rest/v1/auth/me').set('Authorization', `Bearer ${accessToken}`);
    expect(afterAccessToken.status).toBe(401);

    const refreshAttempt = await request(app.getHttpServer()).post('/rest/v1/auth/refresh').send({ refreshToken });
    expect(refreshAttempt.status).toBe(401);

    const reactivateRes = await request(app.getHttpServer())
      .post(`/rest/v1/managers/${managerBProfileId}/reactivate`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(reactivateRes.status).toBe(201);

    const afterReactivate = await login(managerB.email);
    const meAfterReactivate = await request(app.getHttpServer())
      .get('/rest/v1/auth/me')
      .set('Authorization', `Bearer ${afterReactivate.accessToken}`);
    expect(meAfterReactivate.status).toBe(200);
  });
});
