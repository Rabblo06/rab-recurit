import 'reflect-metadata';
import { PermissionFlag, UserStatus } from '@rab/shared';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { Organisation, Permission, Role, RolePermission, User, UserRole } from '../../modules/identity/entities';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { PlatformAdminService } from '../../engine/core-modules/platform-admin/platform-admin.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';

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
  let passwordHashing: PasswordHashingService;
  let tenantContext: TenantContextService;
  let platformAdmin: PlatformAdminService;

  const password = 'correct horse battery staple 1!';

  const MANAGER_PERMS = [PermissionFlag.STAFF_CREATE, PermissionFlag.STAFF_VIEW, PermissionFlag.AUDIT_VIEW];

  async function ensurePermission(key: string, resource: string, action: string): Promise<Permission> {
    let permission = await dataSource.manager.findOne(Permission, { where: { key } });
    if (!permission) permission = await dataSource.manager.save(Permission, { key, resource, action });
    return permission;
  }

  /** One org, 3 managers sharing one role; the first wins the platform-admin claim (real crowning path, not a test shortcut). */
  async function seedOrgWithManagers(count: number): Promise<{
    organisation: Organisation;
    managers: Array<{ email: string; userId: string }>;
  }> {
    const slug = `test-${randomUUID()}`;
    const orgInsert = await dataSource.manager.insert(Organisation, { name: slug, slug });
    const organisation = await dataSource.manager.findOneByOrFail(Organisation, { id: orgInsert.identifiers[0]!.id as string });

    const managers: Array<{ email: string; userId: string }> = [];

    await tenantContext.runInTenantContext({ organisationId: organisation.id, userId: randomUUID(), role: '' }, async (manager) => {
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
        await platformAdmin.tryClaim(manager, organisation.id, userId);
        managers.push({ email, userId });
      }
    });

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
    platformAdmin = moduleRef.get(PlatformAdminService);
  });

  afterAll(async () => {
    await app.close();
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
    // ordinary unscoped (platform-admin, org-wide) view applies instead of
    // being narrowed to just managerB's data.
    const ended = await request(app.getHttpServer())
      .get('/rest/v1/staff')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Inspect-Session-Id', sessionId);
    expect(ended.status).toBe(200);
    expect(ended.body.map((s: { id: string }) => s.id).sort()).toEqual([adminStaff, staffB].sort());
  });

  it('audit entries for inspect start/end attribute to the real admin, with inspectedTargetUserId metadata', async () => {
    const { organisation, managers } = await seedOrgWithManagers(2);
    const [admin, managerB] = managers;
    const adminToken = await login(admin!.email);

    const sessionId = await startInspect(adminToken, managerB!.userId);
    await request(app.getHttpServer()).post('/rest/v1/admin/inspect/end').set('Authorization', `Bearer ${adminToken}`);

    const rows = await tenantContext.runInTenantContext({ organisationId: organisation.id, userId: admin!.userId, role: '' }, (manager) =>
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
});
