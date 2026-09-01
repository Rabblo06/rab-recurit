import 'reflect-metadata';
import { ManagerType, PermissionFlag, UserStatus } from '@rab/shared';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { Organisation, Permission, Role, RolePermission, User, UserRole } from '../../modules/identity/entities';
import { Venue } from '../../modules/venue/entities/venue.entity';
import { JobRole } from '../../modules/scheduling/entities/job-role.entity';
import { ManagerWorkspace } from '../../modules/manager-workspace/entities/manager-workspace.entity';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { createAdminDataSource } from './helpers/admin-datasource';

/**
 * Wires up the previously-dead `manager_venue` table (Venue Manager
 * assignment) and fixes the real bug it exposed: Increment 2's
 * `createdBy`-based ownership scoping on Shift/Offer made `GET /shifts` and
 * `GET /offers` always return empty for a Venue Manager, since they never
 * create shifts/offers themselves. Real Postgres, RLS on, no mocks.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('venue manager scoping (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let passwordHashing: PasswordHashingService;
  let tenantContext: TenantContextService;

  const password = 'correct horse battery staple 1!';

  const MANAGER_PERMS = [
    PermissionFlag.MANAGER_MANAGE,
    PermissionFlag.STAFF_CREATE,
    PermissionFlag.VENUE_CREATE,
    PermissionFlag.VENUE_VIEW,
    PermissionFlag.SCHEDULE_VIEW,
    PermissionFlag.SCHEDULE_CREATE,
    PermissionFlag.SCHEDULE_PUBLISH,
    PermissionFlag.OFFER_SEND,
  ];
  const VENUE_MANAGER_PERMS = [PermissionFlag.VENUE_VIEW, PermissionFlag.SCHEDULE_VIEW];

  async function ensurePermission(key: string, resource: string, action: string): Promise<Permission> {
    // `permission` is global reference data, not tenant-scoped — no RLS, safe via the raw dataSource connection.
    let permission = await dataSource.manager.findOne(Permission, { where: { key } });
    if (!permission) permission = await dataSource.manager.save(Permission, { key, resource, action });
    return permission;
  }

  /** One org, one real Internal Manager (platform admin, first-claimed), one real Venue Manager, two venues. All FORCE-RLS'd tables written inside one bound tenant context, matching this repo's other abuse-case specs. */
  async function seedOrg(): Promise<{
    organisation: Organisation;
    manager: { email: string; userId: string };
    venueManagerProfileId: string;
    venueManager: { email: string; userId: string };
    venue1: Venue;
    venue2: Venue;
  }> {
    const slug = `test-${randomUUID()}`;
    const orgInsert = await adminDataSource.manager.insert(Organisation, { name: slug, slug });
    const organisation = await adminDataSource.manager.findOneByOrFail(Organisation, { id: orgInsert.identifiers[0]!.id as string });

    for (const key of MANAGER_PERMS) await ensurePermission(key, key.split('.')[0]!, key.split('.')[1]!);
    for (const key of VENUE_MANAGER_PERMS) await ensurePermission(key, key.split('.')[0]!, key.split('.')[1]!);

    let manager!: { email: string; userId: string };
    let venueManager!: { email: string; userId: string };
    let venueManagerProfileId!: string;
    let venue1!: Venue;
    let venue2!: Venue;
    let workspaceId!: string;

    // Two sequential transactions, not one: the ManagerWorkspace doesn't
    // exist yet at the start (nothing to bind `current_workspace()` to), and
    // Venue's combined org+workspace RLS WITH CHECK needs the SESSION's
    // bound workspace context to actually match the row being inserted, not
    // just the row's own `workspace_id` value — matching the pattern already
    // established in this session's other split-seed abuse-case specs.
    await tenantContext.runInTenantContext(
      { organisationId: organisation.id, workspaceId: null, userId: randomUUID(), role: '' },
      async (m) => {
        async function insertRoleWithPerms(key: string, name: string, perms: string[]): Promise<string> {
          const roleResult = await m.insert(Role, { organisationId: organisation.id, key, name, isSystem: true });
          const roleId = roleResult.identifiers[0]!.id as string;
          for (const permKey of perms) {
            const permission = await dataSource.manager.findOneByOrFail(Permission, { key: permKey });
            await m.insert(RolePermission, { roleId, permissionId: permission.id, organisationId: organisation.id });
          }
          return roleId;
        }

        async function insertUser(roleId: string, firstName: string): Promise<{ email: string; userId: string }> {
          const email = `${firstName.toLowerCase()}-${randomUUID()}@example.test`;
          const passwordHash = await passwordHashing.hash(password);
          const userResult = await m.insert(User, {
            organisationId: organisation.id,
            email,
            passwordHash,
            firstName,
            lastName: 'Test',
            status: UserStatus.ACTIVE,
          });
          const userId = userResult.identifiers[0]!.id as string;
          await m.insert(UserRole, { userId, roleId, organisationId: organisation.id });
          return { email, userId };
        }

        const managerRoleId = await insertRoleWithPerms('manager', 'Manager', MANAGER_PERMS);
        const venueManagerRoleId = await insertRoleWithPerms('venue_manager', 'Venue Manager', VENUE_MANAGER_PERMS);

        manager = await insertUser(managerRoleId, 'Manager');
        // A real ManagerWorkspace, otherwise this manager's resolved
        // workspaceId stays NULL forever and every Venue/Staff/Shift they
        // create trips the combined org+workspace RLS WITH CHECK (NULL =
        // NULL is never true) — matching the fix already applied to this
        // session's other abuse-case specs. manager_workspace_write's own
        // WITH CHECK also requires owner_user_id = current_uid() — rebind
        // it to the real new manager, not this transaction's throwaway
        // bootstrap identity.
        await m.query(`SELECT set_config('rab.user_id', $1, true)`, [manager.userId]);
        const workspace = await m.save(ManagerWorkspace, {
          organisationId: organisation.id,
          ownerUserId: manager.userId,
          name: `Test Workspace ${manager.userId}`,
          subdomain: `test-${manager.userId.slice(0, 8)}`,
          status: 'active',
        });
        await m.query(`INSERT INTO core.manager_profile (organisation_id, user_id, type, workspace_id) VALUES ($1, $2, $3, $4)`, [
          organisation.id,
          manager.userId,
          ManagerType.INTERNAL,
          workspace.id,
        ]);

        venueManager = await insertUser(venueManagerRoleId, 'VenueMgr');
        const venueManagerProfileResult = await m.query(
          `INSERT INTO core.manager_profile (organisation_id, user_id, type) VALUES ($1, $2, $3) RETURNING id`,
          [organisation.id, venueManager.userId, ManagerType.VENUE],
        );
        venueManagerProfileId = venueManagerProfileResult[0].id as string;
        workspaceId = workspace.id;
      },
    );
    await adminDataSource.manager.query(`INSERT INTO core.platform_admin (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [
      manager.userId,
    ]);

    // Second transaction, bound to the now-real workspace — Venue's
    // combined org+workspace RLS WITH CHECK requires the SESSION context to
    // match, not just the inserted row's own workspace_id value.
    await tenantContext.runInTenantContext(
      { organisationId: organisation.id, workspaceId, userId: manager.userId, role: '' },
      async (m) => {
        venue1 = await m.save(Venue, { organisationId: organisation.id, name: 'Venue One', workspaceId, createdBy: manager.userId });
        venue2 = await m.save(Venue, { organisationId: organisation.id, name: 'Venue Two', workspaceId, createdBy: manager.userId });
      },
    );

    return { organisation, manager, venueManagerProfileId, venueManager, venue1, venue2 };
  }

  async function login(email: string): Promise<string> {
    const res = await request(app.getHttpServer()).post('/rest/v1/auth/login').send({ email, password });
    expect(res.status).toBe(200);
    return res.body.accessToken as string;
  }

  async function seedJobRole(organisation: Organisation, createdBy: string): Promise<JobRole> {
    const [{ id: workspaceId }] = await adminDataSource.manager.query<[{ id: string }]>(
      `SELECT id FROM core.manager_workspace WHERE organisation_id = $1`,
      [organisation.id],
    );
    return tenantContext.runInTenantContext(
      { organisationId: organisation.id, workspaceId, userId: createdBy, role: '' },
      (manager) => manager.save(JobRole, { organisationId: organisation.id, name: `Role-${randomUUID()}`, defaultRatePence: 1200, workspaceId, createdBy }),
    );
  }

  async function createAndPublishShift(token: string, organisation: Organisation, venue: Venue) {
    const jobRole = await seedJobRole(organisation, venue.createdBy!);
    const startsAt = new Date(Date.now() + 48 * 3600 * 1000);
    const endsAt = new Date(startsAt.getTime() + 8 * 3600 * 1000);
    const createRes = await request(app.getHttpServer())
      .post('/rest/v1/shifts')
      .set('Authorization', `Bearer ${token}`)
      .send({ venueId: venue.id, jobRoleId: jobRole.id, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), requiredCount: 1 });
    expect(createRes.status).toBe(201);
    const publishRes = await request(app.getHttpServer())
      .post(`/rest/v1/shifts/${createRes.body.id}/publish`)
      .set('Authorization', `Bearer ${token}`);
    expect(publishRes.status).toBe(201);
    return createRes.body.id as string;
  }

  async function createStaff(token: string, prefix: string) {
    const res = await request(app.getHttpServer())
      .post('/rest/v1/staff')
      .set('Authorization', `Bearer ${token}`)
      .send({ email: `staff-${prefix}-${randomUUID()}@example.test`, firstName: prefix, lastName: 'Staff', staffRef: `STF-${randomUUID().slice(0, 8)}` });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  async function sendOffer(token: string, shiftId: string, staffProfileId: string) {
    const res = await request(app.getHttpServer())
      .post(`/rest/v1/shifts/${shiftId}/offers`)
      .set('Authorization', `Bearer ${token}`)
      .send({ staffProfileId });
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

  it('assigning a Venue Manager to a venue scopes their venue list to it, and only it', async () => {
    const { manager, venueManagerProfileId, venueManager, venue1, venue2 } = await seedOrg();
    const managerToken = await login(manager.email);
    const vmToken = await login(venueManager.email);

    const assignRes = await request(app.getHttpServer())
      .post(`/rest/v1/managers/${venueManagerProfileId}/venues`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ venueId: venue1.id });
    expect(assignRes.status).toBe(204);

    const listRes = await request(app.getHttpServer()).get('/rest/v1/venues').set('Authorization', `Bearer ${vmToken}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.map((v: { id: string }) => v.id)).toEqual([venue1.id]);

    const getVenue1 = await request(app.getHttpServer()).get(`/rest/v1/venues/${venue1.id}`).set('Authorization', `Bearer ${vmToken}`);
    expect(getVenue1.status).toBe(200);
    const getVenue2 = await request(app.getHttpServer()).get(`/rest/v1/venues/${venue2.id}`).set('Authorization', `Bearer ${vmToken}`);
    expect(getVenue2.status).toBe(404);

    // The assigning Manager still sees every org venue, unchanged.
    const managerList = await request(app.getHttpServer()).get('/rest/v1/venues').set('Authorization', `Bearer ${managerToken}`);
    expect(managerList.body.map((v: { id: string }) => v.id).sort()).toEqual([venue1.id, venue2.id].sort());
  });

  it('regression: a Venue Manager sees shifts and offers at their assigned venue (previously always empty)', async () => {
    const { organisation, manager, venueManagerProfileId, venueManager, venue1, venue2 } = await seedOrg();
    const managerToken = await login(manager.email);
    const vmToken = await login(venueManager.email);

    await request(app.getHttpServer())
      .post(`/rest/v1/managers/${venueManagerProfileId}/venues`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ venueId: venue1.id });

    const shift1 = await createAndPublishShift(managerToken, organisation, venue1);
    const shift2 = await createAndPublishShift(managerToken, organisation, venue2);
    const staff1 = await createStaff(managerToken, 'S1');
    const staff2 = await createStaff(managerToken, 'S2');
    const offer1 = await sendOffer(managerToken, shift1, staff1);
    await sendOffer(managerToken, shift2, staff2);

    const shiftsRes = await request(app.getHttpServer()).get('/rest/v1/shifts').set('Authorization', `Bearer ${vmToken}`);
    expect(shiftsRes.status).toBe(200);
    expect(shiftsRes.body.map((s: { id: string }) => s.id)).toEqual([shift1]);

    const offersRes = await request(app.getHttpServer()).get('/rest/v1/offers').set('Authorization', `Bearer ${vmToken}`);
    expect(offersRes.status).toBe(200);
    expect(offersRes.body.map((o: { id: string }) => o.id)).toEqual([offer1]);
  });

  it('unassigning a venue removes visibility', async () => {
    const { manager, venueManagerProfileId, venueManager, venue1 } = await seedOrg();
    const managerToken = await login(manager.email);
    const vmToken = await login(venueManager.email);

    await request(app.getHttpServer())
      .post(`/rest/v1/managers/${venueManagerProfileId}/venues`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ venueId: venue1.id });
    const beforeUnassign = await request(app.getHttpServer()).get('/rest/v1/venues').set('Authorization', `Bearer ${vmToken}`);
    expect(beforeUnassign.body).toHaveLength(1);

    const unassignRes = await request(app.getHttpServer())
      .delete(`/rest/v1/managers/${venueManagerProfileId}/venues/${venue1.id}`)
      .set('Authorization', `Bearer ${managerToken}`);
    expect(unassignRes.status).toBe(204);

    const afterUnassign = await request(app.getHttpServer()).get('/rest/v1/venues').set('Authorization', `Bearer ${vmToken}`);
    expect(afterUnassign.body).toEqual([]);
  });

  it('a caller without MANAGER_MANAGE cannot assign venues', async () => {
    const { venueManagerProfileId, venueManager, venue1 } = await seedOrg();
    const vmToken = await login(venueManager.email); // holds VENUE_VIEW/SCHEDULE_VIEW only, not MANAGER_MANAGE

    const res = await request(app.getHttpServer())
      .post(`/rest/v1/managers/${venueManagerProfileId}/venues`)
      .set('Authorization', `Bearer ${vmToken}`)
      .send({ venueId: venue1.id });
    expect(res.status).toBe(403);
  });

  it('assigning a venue to a non-Venue-Manager profile is rejected', async () => {
    const { organisation, manager, venue1 } = await seedOrg();
    const managerToken = await login(manager.email);
    const managerProfile = await tenantContext.runInTenantContext(
      { organisationId: organisation.id, workspaceId: null, userId: randomUUID(), role: '' },
      (m) => m.query(`SELECT id FROM core.manager_profile WHERE user_id = $1`, [manager.userId]),
    );

    const res = await request(app.getHttpServer())
      .post(`/rest/v1/managers/${managerProfile[0].id}/venues`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ venueId: venue1.id });
    expect(res.status).toBe(400);
  });
});
