import 'reflect-metadata';
import { ManagerType, UserStatus, PermissionFlag } from '@rab/shared';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { Organisation, Permission, Role, RolePermission, User, UserRole } from '../../modules/identity/entities';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { createAdminDataSource } from './helpers/admin-datasource';

/**
 * The finding: a not-yet-onboarded Manager (`ctx.workspaceId === null`)
 * hitting Staff/Venue/JobRole creation used to reach Postgres and get
 * rejected by the `workspace_id = current_workspace()` `WITH CHECK` clause
 * with a raw, uncontrolled error — `NULL = NULL` is never true in Postgres,
 * so a NULL-workspace row can never satisfy that check (see
 * `SelectPreconditionForWritesRlsFix`'s own doc comment for the fuller
 * explanation of this Postgres behaviour). `RequireWorkspaceGuard` +
 * `ResourceScopeService.assertHasWorkspace` now reject this BEFORE the
 * request reaches the database, with a controlled 403 — and the DB-level
 * `WITH CHECK` is left completely untouched as the fail-closed backstop
 * (proven directly in this file, not just asserted).
 *
 * No CEO/Admin carve-out exists here deliberately — see
 * `ResourceScopeService.assertHasWorkspace`'s own doc comment: no
 * `targetWorkspaceId` mechanism exists anywhere in this codebase, so there
 * is no currently-working privileged flow to preserve. A platform admin is
 * just a Manager with their own real Workspace, and is blocked identically
 * to any other Manager until they complete onboarding — proven below.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('workspace required for operational create (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let passwordHashing: PasswordHashingService;
  let tenantContext: TenantContextService;

  const password = 'correct horse battery staple 1!';

  const MANAGER_PERMS = [
    PermissionFlag.STAFF_CREATE,
    PermissionFlag.STAFF_VIEW,
    PermissionFlag.VENUE_CREATE,
    PermissionFlag.VENUE_VIEW,
    PermissionFlag.SCHEDULE_CREATE,
    PermissionFlag.SCHEDULE_VIEW,
  ];

  async function ensurePermission(key: string, resource: string, action: string): Promise<Permission> {
    let permission = await dataSource.manager.findOne(Permission, { where: { key } });
    if (!permission) permission = await dataSource.manager.save(Permission, { key, resource, action });
    return permission;
  }

  /**
   * One org, `count` Managers, each with real Staff/Venue/JobRole
   * permissions and a real login-capable User — but deliberately NO
   * `ManagerWorkspace` row, matching the finding's exact precondition
   * (`ctx.workspaceId` resolves to null on login). Tests that need a
   * completed-onboarding Manager call `createWorkspace()` afterward, using
   * the real onboarding endpoint — never seeded directly.
   */
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
        await manager.query(`INSERT INTO core.manager_profile (organisation_id, user_id, type) VALUES ($1, $2, $3)`, [
          organisation.id,
          userId,
          ManagerType.INTERNAL,
        ]);
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

  /** The real onboarding flow — never seeded directly. */
  async function createWorkspace(token: string): Promise<void> {
    const res = await request(app.getHttpServer())
      .post('/rest/v1/manager-workspaces')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: `Workspace ${randomUUID()}`, subdomain: `ws-${randomUUID().slice(0, 8)}` });
    expect(res.status).toBe(201);
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

  // 1 & 2 — Manager without Workspace -> operational create returns a controlled 4xx, no row is created.
  it('a Manager with no Workspace gets a controlled 403 creating Staff, Venue, or a JobRole — and no row is created', async () => {
    const { organisation, managers } = await seedOrgWithManagers(1);
    const token = await login(managers[0]!.email);

    const staffRes = await request(app.getHttpServer())
      .post('/rest/v1/staff')
      .set('Authorization', `Bearer ${token}`)
      .send({ email: `staff-${randomUUID()}@example.test`, firstName: 'A', lastName: 'B', staffRef: randomUUID() });
    expect(staffRes.status).toBe(403);

    const venueRes = await request(app.getHttpServer())
      .post('/rest/v1/venues')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Should Not Exist', type: 'other' });
    expect(venueRes.status).toBe(403);

    const jobRoleRes = await request(app.getHttpServer())
      .post('/rest/v1/job-roles')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Should Not Exist', defaultRatePence: 1000 });
    expect(jobRoleRes.status).toBe(403);

    const rows = await adminDataSource.manager.query(
      `SELECT
         (SELECT COUNT(*) FROM core.staff_profile WHERE organisation_id = $1) AS staff_count,
         (SELECT COUNT(*) FROM core.venue WHERE organisation_id = $1) AS venue_count,
         (SELECT COUNT(*) FROM core.job_role WHERE organisation_id = $1) AS job_role_count`,
      [organisation.id],
    );
    expect(rows[0]).toEqual({ staff_count: '0', venue_count: '0', job_role_count: '0' });
  });

  // 3 — Direct DB insertion with no Workspace context remains denied by RLS (the DB-level backstop, untouched by this fix).
  it('a direct DB insert with no workspace context bound is still rejected by RLS (WITH CHECK, NULL = NULL is never true)', async () => {
    const { organisation, managers } = await seedOrgWithManagers(1);

    await expect(
      tenantContext.runInTenantContext({ organisationId: organisation.id, workspaceId: null, userId: managers[0]!.userId, role: '' }, (manager) =>
        manager.query(`INSERT INTO core.venue (organisation_id, name, workspace_id) VALUES ($1, $2, NULL)`, [organisation.id, 'Direct Insert']),
      ),
    ).rejects.toThrow();
  });

  // 4 — Manager with Workspace -> normal creation still works.
  it('a Manager who has completed Workspace onboarding creates Staff/Venue/JobRole normally', async () => {
    const { managers } = await seedOrgWithManagers(1);
    const token = await login(managers[0]!.email);
    await createWorkspace(token);

    const staffRes = await request(app.getHttpServer())
      .post('/rest/v1/staff')
      .set('Authorization', `Bearer ${token}`)
      .send({ email: `staff-${randomUUID()}@example.test`, firstName: 'A', lastName: 'B', staffRef: randomUUID() });
    expect(staffRes.status).toBe(201);

    const venueRes = await request(app.getHttpServer())
      .post('/rest/v1/venues')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Real Venue', type: 'other' });
    expect(venueRes.status).toBe(201);

    const jobRoleRes = await request(app.getHttpServer())
      .post('/rest/v1/job-roles')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Real Role', defaultRatePence: 1000 });
    expect(jobRoleRes.status).toBe(201);
  });

  // 5 — a Manager cannot specify another Workspace manually (no such field exists on any of these DTOs; DTO whitelisting rejects it).
  it('a client-supplied workspaceId in the body is rejected by DTO whitelisting, on all three routes', async () => {
    const { managers } = await seedOrgWithManagers(1);
    const token = await login(managers[0]!.email);
    await createWorkspace(token);
    const foreignWorkspaceId = randomUUID();

    const staffRes = await request(app.getHttpServer())
      .post('/rest/v1/staff')
      .set('Authorization', `Bearer ${token}`)
      .send({
        email: `staff-${randomUUID()}@example.test`,
        firstName: 'A',
        lastName: 'B',
        staffRef: randomUUID(),
        workspaceId: foreignWorkspaceId,
      });
    expect(staffRes.status).toBe(400);

    const venueRes = await request(app.getHttpServer())
      .post('/rest/v1/venues')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Hijack', type: 'other', workspaceId: foreignWorkspaceId });
    expect(venueRes.status).toBe(400);

    const jobRoleRes = await request(app.getHttpServer())
      .post('/rest/v1/job-roles')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Hijack', defaultRatePence: 1000, workspaceId: foreignWorkspaceId });
    expect(jobRoleRes.status).toBe(400);
  });

  // 6 — CEO/Admin privileged flows: no targetWorkspaceId mechanism exists anywhere in this codebase (confirmed by
  // grep before implementing), so there is no currently-working privileged bypass to preserve. The platform admin
  // is blocked identically to any other not-yet-onboarded Manager, and works identically once they onboard too —
  // proven directly rather than assumed.
  it('the platform admin is blocked identically to any other Manager without a Workspace, and works identically once onboarded', async () => {
    const { managers } = await seedOrgWithManagers(1);
    await adminDataSource.manager.query(`INSERT INTO core.platform_admin (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [
      managers[0]!.userId,
    ]);
    const token = await login(managers[0]!.email);

    const blocked = await request(app.getHttpServer())
      .post('/rest/v1/venues')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Admin Pre-Onboarding', type: 'other' });
    expect(blocked.status).toBe(403);

    await createWorkspace(token);

    const allowed = await request(app.getHttpServer())
      .post('/rest/v1/venues')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Admin Post-Onboarding', type: 'other' });
    expect(allowed.status).toBe(201);
  });

  // 7 — legitimate pre-onboarding endpoints (the Workspace-creation flow itself) still work with no Workspace context.
  it('Workspace onboarding endpoints keep working before onboarding completes', async () => {
    const { managers } = await seedOrgWithManagers(1);
    const token = await login(managers[0]!.email);

    const check = await request(app.getHttpServer())
      .post('/rest/v1/manager-workspaces/subdomain/check')
      .set('Authorization', `Bearer ${token}`)
      .send({ candidate: `check-${randomUUID().slice(0, 8)}` });
    expect(check.status).toBe(201);
    expect(check.body.available).toBe(true);

    const create = await request(app.getHttpServer())
      .post('/rest/v1/manager-workspaces')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Onboarding Itself', subdomain: `onb-${randomUUID().slice(0, 8)}` });
    expect(create.status).toBe(201);

    const complete = await request(app.getHttpServer())
      .post('/rest/v1/manager-workspaces/me/complete-onboarding')
      .set('Authorization', `Bearer ${token}`);
    expect(complete.status).toBe(200);
  });
});
