import 'reflect-metadata';
import { PermissionFlag, UserStatus } from '@rab/shared';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { AdminInspectSession, Organisation, Permission, Role, RolePermission, User, UserRole } from '../../modules/identity/entities';
import { ManagerWorkspace } from '../../modules/manager-workspace/entities/manager-workspace.entity';
import { AccessTokenService } from '../../engine/core-modules/auth/token/services/access-token.service';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { createAdminDataSource } from './helpers/admin-datasource';

/**
 * Admin Inspect — read-only "view the app as another user", server-side
 * session table (`admin_inspect_session`), never a JWT claim. The real admin
 * identity must remain known server-side throughout: `JwtAuthGuard` only
 * ever rebuilds `authContext` from a session row it re-verifies belongs to
 * the CALLING admin's own already-verified token, and `PermissionGuard`
 * rejects every non-GET request while a session is active, regardless of
 * the admin's own permissions. Real Postgres, RLS on, no mocks.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('admin inspect abuse cases (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let passwordHashing: PasswordHashingService;
  let tenantContext: TenantContextService;
  let accessTokenService: AccessTokenService;

  const password = 'correct horse battery staple 1!';

  const MANAGER_PERMS = [PermissionFlag.STAFF_CREATE, PermissionFlag.STAFF_VIEW, PermissionFlag.AUDIT_VIEW];

  async function ensurePermission(key: string, resource: string, action: string): Promise<Permission> {
    let permission = await dataSource.manager.findOne(Permission, { where: { key } });
    if (!permission) permission = await dataSource.manager.save(Permission, { key, resource, action });
    return permission;
  }

  /** One org, 3 managers sharing one role; the first is granted platform_admin status. */
  async function seedOrgWithManagers(count: number): Promise<{
    organisation: Organisation;
    managers: Array<{ email: string; userId: string }>;
  }> {
    const slug = `test-${randomUUID()}`;
    const orgInsert = await adminDataSource.manager.insert(Organisation, { name: slug, slug });
    const organisation = await adminDataSource.manager.findOneByOrFail(Organisation, { id: orgInsert.identifiers[0]!.id as string });

    const managers: Array<{ email: string; userId: string }> = [];

    await tenantContext.runInTenantContext({ organisationId: organisation.id, workspaceId: null, userId: randomUUID(), role: '' }, async (manager) => {
      const roleResult = await manager.insert(Role, { organisationId: organisation.id, key: `manager-${randomUUID()}`, name: 'Manager', isSystem: true });
      const roleId = roleResult.identifiers[0]!.id as string;
      for (const key of MANAGER_PERMS) {
        const permission = await ensurePermission(key, key.split('.')[0]!, key.split('.')[1]!);
        await manager.insert(RolePermission, { roleId, permissionId: permission.id, organisationId: organisation.id });
      }

      for (let i = 0; i < count; i++) {
        const email = `mgr-${randomUUID()}@example.test`;
        const passwordHash = await passwordHashing.hash(password);
        const userResult = await manager.insert(User, {
          organisationId: organisation.id,
          email,
          passwordHash,
          firstName: `Manager${i}`,
          lastName: 'Test',
          status: UserStatus.ACTIVE,
        });
        const userId = userResult.identifiers[0]!.id as string;
        await manager.insert(UserRole, { userId, roleId, organisationId: organisation.id });
        // manager_workspace_write's WITH CHECK requires owner_user_id =
        // current_uid() — rebind it to the real new user, not this
        // transaction's throwaway bootstrap identity.
        await manager.query(`SELECT set_config('rab.user_id', $1, true)`, [userId]);
        await manager.insert(ManagerWorkspace, {
          organisationId: organisation.id,
          ownerUserId: userId,
          name: `Test Workspace ${userId}`,
          subdomain: `test-${userId.slice(0, 8)}`,
          status: 'active',
        });
        managers.push({ email, userId });
      }
    });

    // Only the FIRST manager is granted platform_admin status — via
    // `adminDataSource` (rab_owner): `platform_admin`'s own write policy
    // requires the ACTING session to already be an admin, impossible for a
    // fresh org's first grant.
    if (managers[0]) {
      await adminDataSource.manager.query(`INSERT INTO core.platform_admin (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [
        managers[0].userId,
      ]);
    }

    return { organisation, managers };
  }

  async function login(email: string): Promise<string> {
    const res = await request(app.getHttpServer()).post('/rest/v1/auth/login').send({ email, password });
    expect(res.status).toBe(200);
    return res.body.accessToken as string;
  }

  async function createStaff(token: string, prefix: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/rest/v1/staff')
      .set('Authorization', `Bearer ${token}`)
      .send({ email: `staff-${prefix}-${randomUUID()}@example.test`, firstName: prefix, lastName: 'Staff', staffRef: `STF-${randomUUID().slice(0, 8)}` });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  async function startInspect(adminToken: string, targetUserId: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post(`/rest/v1/admin/inspect/${targetUserId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(201);
    return res.body.sessionId as string;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    dataSource = moduleRef.get(DataSource);
    passwordHashing = moduleRef.get(PasswordHashingService);
    tenantContext = moduleRef.get(TenantContextService);
    accessTokenService = moduleRef.get(AccessTokenService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
  });

  afterAll(async () => {
    await app.close();
    await adminDataSource.destroy();
  });

  it('a non-admin cannot start an inspect session', async () => {
    const { managers } = await seedOrgWithManagers(2);
    const [, managerB] = managers;
    const managerBToken = await login(managerB!.email);

    const res = await request(app.getHttpServer())
      .post(`/rest/v1/admin/inspect/${managers[0]!.userId}`)
      .set('Authorization', `Bearer ${managerBToken}`);
    expect(res.status).toBe(403);
  });

  it('an admin inspecting a target sees exactly that target scoped data, not the admin own or a third manager', async () => {
    const { managers } = await seedOrgWithManagers(3);
    const [admin, managerB, managerC] = managers;
    const adminToken = await login(admin!.email);
    const managerBToken = await login(managerB!.email);
    const managerCToken = await login(managerC!.email);

    await createStaff(adminToken, 'Admin');
    const staffB = await createStaff(managerBToken, 'B');
    await createStaff(managerCToken, 'C');

    const sessionId = await startInspect(adminToken, managerB!.userId);

    const res = await request(app.getHttpServer())
      .get('/rest/v1/staff')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Inspect-Session-Id', sessionId);
    expect(res.status).toBe(200);
    expect(res.body.map((s: { id: string }) => s.id)).toEqual([staffB]);
  });

  it('mutating requests are blocked while inspecting, regardless of the admin own permissions', async () => {
    const { managers } = await seedOrgWithManagers(2);
    const [admin, managerB] = managers;
    const adminToken = await login(admin!.email);

    const sessionId = await startInspect(adminToken, managerB!.userId);

    const blocked = await request(app.getHttpServer())
      .post('/rest/v1/staff')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Inspect-Session-Id', sessionId)
      .send({ email: `blocked-${randomUUID()}@example.test`, firstName: 'Blocked', lastName: 'Staff', staffRef: `STF-${randomUUID().slice(0, 8)}` });
    expect(blocked.status).toBe(403);

    // Same call, no inspect header — the admin's own real permissions are unaffected.
    const allowed = await request(app.getHttpServer())
      .post('/rest/v1/staff')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: `allowed-${randomUUID()}@example.test`, firstName: 'Allowed', lastName: 'Staff', staffRef: `STF-${randomUUID().slice(0, 8)}` });
    expect(allowed.status).toBe(201);
  });

  it('a forged or foreign session id grants no escalated access to a non-admin caller', async () => {
    const { managers } = await seedOrgWithManagers(3);
    const [, managerB, managerC] = managers;
    const managerBToken = await login(managerB!.email);
    const managerCToken = await login(managerC!.email);

    await createStaff(managerBToken, 'B');
    const staffC = await createStaff(managerCToken, 'C');

    // managerC (never the admin on any session row) attaches a random,
    // never-inserted session id. resolveActiveTarget can't match it to
    // managerC's own real identity, so it's ignored — managerC sees only
    // their own scoped data (createdBy = managerC), never managerB's.
    const forged = await request(app.getHttpServer())
      .get('/rest/v1/staff')
      .set('Authorization', `Bearer ${managerCToken}`)
      .set('X-Inspect-Session-Id', randomUUID());
    expect(forged.status).toBe(200);
    expect(forged.body.map((s: { id: string }) => s.id)).toEqual([staffC]);
  });

  it('an ended session no longer scopes the response to the inspected target', async () => {
    const { managers } = await seedOrgWithManagers(2);
    const [admin, managerB] = managers;
    const adminToken = await login(admin!.email);
    const managerBToken = await login(managerB!.email);

    const adminStaff = await createStaff(adminToken, 'AdminOwn');
    const staffB = await createStaff(managerBToken, 'B');

    const sessionId = await startInspect(adminToken, managerB!.userId);
    const whileActive = await request(app.getHttpServer())
      .get('/rest/v1/staff')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Inspect-Session-Id', sessionId);
    expect(whileActive.body.map((s: { id: string }) => s.id)).toEqual([staffB]);

    const endRes = await request(app.getHttpServer()).post('/rest/v1/admin/inspect/end').set('Authorization', `Bearer ${adminToken}`);
    expect(endRes.status).toBe(204);

    // Same (now stale) session id — no longer resolves, so the admin's
    // ordinary OWN scope applies instead of staying narrowed to managerB's
    // data (Stage 2A Phase 2 retired the org-wide "platform admin sees
    // everything" bypass — the admin's own view is exactly their own
    // created-by scope now, same as any other Manager).
    const ended = await request(app.getHttpServer())
      .get('/rest/v1/staff')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Inspect-Session-Id', sessionId);
    expect(ended.status).toBe(200);
    expect(ended.body.map((s: { id: string }) => s.id)).toEqual([adminStaff]);
  });

  it('audit entries for inspect start/end attribute to the real admin, with inspectedTargetUserId metadata', async () => {
    const { organisation, managers } = await seedOrgWithManagers(2);
    const [admin, managerB] = managers;
    const adminToken = await login(admin!.email);

    const sessionId = await startInspect(adminToken, managerB!.userId);
    await request(app.getHttpServer()).post('/rest/v1/admin/inspect/end').set('Authorization', `Bearer ${adminToken}`);

    const rows = await tenantContext.runInTenantContext({ organisationId: organisation.id, workspaceId: null, userId: admin!.userId, role: '' }, (manager) =>
      manager.query(
        `SELECT action, actor_user_id, metadata FROM core.audit_log
          WHERE organisation_id = $1 AND action IN ('admin.inspect_started', 'admin.inspect_ended')
          ORDER BY created_at ASC`,
        [organisation.id],
      ),
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.actor_user_id).toBe(admin!.userId);
      expect(row.metadata.inspectedTargetUserId).toBe(managerB!.userId);
    }
    expect(rows[0].action).toBe('admin.inspect_started');
    expect(rows[1].action).toBe('admin.inspect_ended');

    void sessionId; // asserted indirectly via the audit rows above
  });

  it('POST /admin/inspect/end still works with the inspect header attached (route carve-out)', async () => {
    const { managers } = await seedOrgWithManagers(2);
    const [admin, managerB] = managers;
    const adminToken = await login(admin!.email);

    const sessionId = await startInspect(adminToken, managerB!.userId);

    const endRes = await request(app.getHttpServer())
      .post('/rest/v1/admin/inspect/end')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Inspect-Session-Id', sessionId);
    expect(endRes.status).toBe(204);

    // Confirms the session is actually ended, not just that the route responded.
    const after = await request(app.getHttpServer())
      .get('/rest/v1/staff')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Inspect-Session-Id', sessionId);
    expect(after.status).toBe(200); // falls back to the admin's own (empty) staff list, not managerB's
    expect(after.body).toEqual([]);
  });

  it('a normal, non-inspecting Platform Admin session cannot read Manager B\'s private staff — the org-wide admin bypass stays retired', async () => {
    const { managers } = await seedOrgWithManagers(2);
    const [admin, managerB] = managers;
    const adminToken = await login(admin!.email);
    const managerBToken = await login(managerB!.email);

    const staffB = await createStaff(managerBToken, 'B');

    // No X-Inspect-Session-Id header at all — the admin's ordinary,
    // un-elevated view.
    const res = await request(app.getHttpServer()).get('/rest/v1/staff').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.map((s: { id: string }) => s.id)).not.toContain(staffB);
    expect(res.body).toEqual([]); // the admin has created nothing of their own here
  });

  it('no token is ever minted for the inspected identity — starting inspection returns no accessToken/refreshToken, and the admin\'s own JWT (same sub claim) authenticates every request before, during, and after', async () => {
    const { managers } = await seedOrgWithManagers(2);
    const [admin, managerB] = managers;
    const adminToken = await login(admin!.email);

    const before = accessTokenService.verify(adminToken);
    expect(before.sub).toBe(admin!.userId);

    const startRes = await request(app.getHttpServer())
      .post(`/rest/v1/admin/inspect/${managerB!.userId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(startRes.status).toBe(201);
    // The only thing minted is a session row — never a token. No
    // accessToken/refreshToken field of any kind in the response body.
    expect(startRes.body).not.toHaveProperty('accessToken');
    expect(startRes.body).not.toHaveProperty('refreshToken');
    expect(startRes.body).not.toHaveProperty('token');
    expect(Object.keys(startRes.body).some((k) => k.toLowerCase().includes('token'))).toBe(false);

    // The literal bearer string used for every request while "inspecting"
    // is still the admin's own original token — nothing swapped it out.
    // Decoding it mid-session proves its `sub` never changed to the target.
    const during = accessTokenService.verify(adminToken);
    expect(during.sub).toBe(admin!.userId);
    expect(during.sub).not.toBe(managerB!.userId);

    await request(app.getHttpServer()).post('/rest/v1/admin/inspect/end').set('Authorization', `Bearer ${adminToken}`);
    const after = accessTokenService.verify(adminToken);
    expect(after.sub).toBe(admin!.userId);
  });

  describe('row-level security — the fail-closed guarantee', () => {
    it('a query with no tenant context bound returns zero rows for admin_inspect_session, even over the table-owner connection', async () => {
      const { managers } = await seedOrgWithManagers(2);
      const [admin, managerB] = managers;
      const adminToken = await login(admin!.email);
      const sessionId = await startInspect(adminToken, managerB!.userId);

      const rows = await dataSource.manager.find(AdminInspectSession, { where: { id: sessionId } });
      expect(rows).toHaveLength(0);
    });
  });
});
