import 'reflect-metadata';
import { UserStatus, PermissionFlag } from '@rab/shared';
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
 * Closes the real gap the user found (a brand-new Manager could see venues
 * created by a different Manager in the same org): `venue` and `job_role`
 * were the only two tenant tables with zero ownership scoping. Same
 * `created_by = ctx.userId` mechanism Staff/Shift/Offer already use — real
 * Postgres, RLS on, no mocks, matching this repo's standing pattern.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('venue/job-role ownership abuse cases (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let passwordHashing: PasswordHashingService;
  let tenantContext: TenantContextService;

  const password = 'correct horse battery staple 1!';

  const MANAGER_PERMS = [
    PermissionFlag.VENUE_CREATE,
    PermissionFlag.VENUE_EDIT,
    PermissionFlag.VENUE_VIEW,
    PermissionFlag.SCHEDULE_VIEW,
    PermissionFlag.SCHEDULE_CREATE,
  ];

  async function ensurePermission(key: string, resource: string, action: string): Promise<Permission> {
    let permission = await dataSource.manager.findOne(Permission, { where: { key } });
    if (!permission) permission = await dataSource.manager.save(Permission, { key, resource, action });
    return permission;
  }

  /** One org, `count` managers. The FIRST manager is granted platform_admin status, same as every other abuse-case spec this session. */
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

    // Only the FIRST manager becomes the platform admin — matches every
    // assertion in this file that treats `managers[0]` as the admin.
    // Written via `adminDataSource` (rab_owner): `platform_admin`'s own
    // write policy requires the ACTING session to already be an admin,
    // impossible for a fresh org's first grant.
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

  async function createVenue(token: string, name = `Venue-${randomUUID()}`) {
    const res = await request(app.getHttpServer())
      .post('/rest/v1/venues')
      .set('Authorization', `Bearer ${token}`)
      .send({ name, type: 'other' });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  async function createJobRole(token: string, name = `Role-${randomUUID()}`) {
    const res = await request(app.getHttpServer())
      .post('/rest/v1/job-roles')
      .set('Authorization', `Bearer ${token}`)
      .send({ name, defaultRatePence: 1200 });
    expect(res.status).toBe(201);
    return res.body.id as string;
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

  it("Manager B never sees Manager A's venue — the exact scenario reported: a brand-new manager could see another manager's venues", async () => {
    const { managers } = await seedOrgWithManagers(2);
    const [a, b] = managers;
    const [tokenA, tokenB] = await Promise.all([login(a!.email), login(b!.email)]);
    const venueAId = await createVenue(tokenA, 'Manager A Venue');

    const listB = await request(app.getHttpServer()).get('/rest/v1/venues').set('Authorization', `Bearer ${tokenB}`);
    expect(listB.status).toBe(200);
    expect(listB.body.map((v: { id: string }) => v.id)).not.toContain(venueAId);

    const getB = await request(app.getHttpServer()).get(`/rest/v1/venues/${venueAId}`).set('Authorization', `Bearer ${tokenB}`);
    expect(getB.status).toBe(404);

    const updateB = await request(app.getHttpServer())
      .patch(`/rest/v1/venues/${venueAId}`)
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ name: 'Hijacked' });
    expect(updateB.status).toBe(404);

    const archiveB = await request(app.getHttpServer()).post(`/rest/v1/venues/${venueAId}/archive`).set('Authorization', `Bearer ${tokenB}`);
    expect(archiveB.status).toBe(404);

    // Manager A still sees their own venue, unaffected.
    const listA = await request(app.getHttpServer()).get('/rest/v1/venues').set('Authorization', `Bearer ${tokenA}`);
    expect(listA.body.map((v: { id: string }) => v.id)).toContain(venueAId);
  });

  it('the platform admin does NOT see every venue unconditionally (Stage 2A Phase 2 retired that bypass) — only their own, same as any Manager, outside an Admin Inspect session', async () => {
    const { managers } = await seedOrgWithManagers(2);
    const [admin, b] = managers; // admin holds platform_admin status (first-seeded)
    const [tokenAdmin, tokenB] = await Promise.all([login(admin!.email), login(b!.email)]);
    const venueBId = await createVenue(tokenB);

    const listAdmin = await request(app.getHttpServer()).get('/rest/v1/venues').set('Authorization', `Bearer ${tokenAdmin}`);
    expect(listAdmin.body.map((v: { id: string }) => v.id)).not.toContain(venueBId);

    const getAdmin = await request(app.getHttpServer()).get(`/rest/v1/venues/${venueBId}`).set('Authorization', `Bearer ${tokenAdmin}`);
    expect(getAdmin.status).toBe(404);
  });

  it("Manager B never sees Manager A's job role via GET /job-roles", async () => {
    const { managers } = await seedOrgWithManagers(2);
    const [a, b] = managers;
    const [tokenA, tokenB] = await Promise.all([login(a!.email), login(b!.email)]);
    const jobRoleAId = await createJobRole(tokenA);

    const listB = await request(app.getHttpServer()).get('/rest/v1/job-roles').set('Authorization', `Bearer ${tokenB}`);
    expect(listB.status).toBe(200);
    expect(listB.body.map((r: { id: string }) => r.id)).not.toContain(jobRoleAId);

    const listA = await request(app.getHttpServer()).get('/rest/v1/job-roles').set('Authorization', `Bearer ${tokenA}`);
    expect(listA.body.map((r: { id: string }) => r.id)).toContain(jobRoleAId);
  });

  it("closes the IDOR ownership scoping would otherwise open: Manager B cannot create a Shift against Manager A's private venue or job role by reusing a known id", async () => {
    const { managers } = await seedOrgWithManagers(2);
    const [a, b] = managers;
    const [tokenA, tokenB] = await Promise.all([login(a!.email), login(b!.email)]);
    const venueAId = await createVenue(tokenA);
    const jobRoleAId = await createJobRole(tokenA);
    // Manager B needs their own accessible job role for the "venue rejected" case, and vice versa.
    const venueBId = await createVenue(tokenB);
    const jobRoleBId = await createJobRole(tokenB);

    const startsAt = new Date(Date.now() + 48 * 3600 * 1000).toISOString();
    const endsAt = new Date(Date.now() + 56 * 3600 * 1000).toISOString();

    const venueRejected = await request(app.getHttpServer())
      .post('/rest/v1/shifts')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ venueId: venueAId, jobRoleId: jobRoleBId, startsAt, endsAt, requiredCount: 1 });
    expect(venueRejected.status).toBe(404);

    const jobRoleRejected = await request(app.getHttpServer())
      .post('/rest/v1/shifts')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ venueId: venueBId, jobRoleId: jobRoleAId, startsAt, endsAt, requiredCount: 1 });
    expect(jobRoleRejected.status).toBe(404);

    // Manager B's own venue + job role together still work — this isn't a blanket lock.
    const ownWorks = await request(app.getHttpServer())
      .post('/rest/v1/shifts')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ venueId: venueBId, jobRoleId: jobRoleBId, startsAt, endsAt, requiredCount: 1 });
    expect(ownWorks.status).toBe(201);
  });

  it('a query with no tenant context bound returns zero rows for venue and job_role', async () => {
    const venueRows = await dataSource.manager.query(`SELECT id FROM core.venue LIMIT 1`);
    expect(venueRows).toEqual([]);
    const jobRoleRows = await dataSource.manager.query(`SELECT id FROM core.job_role LIMIT 1`);
    expect(jobRoleRows).toEqual([]);
  });
});
