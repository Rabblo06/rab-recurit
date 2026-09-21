import { assertVenueTeamSelection } from '../../modules/staff/services/venue-team-scope';
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
    PermissionFlag.STAFF_DEACTIVATE,
    PermissionFlag.VENUE_CREATE,
    PermissionFlag.VENUE_VIEW,
    PermissionFlag.SCHEDULE_VIEW,
    PermissionFlag.SCHEDULE_CREATE,
    PermissionFlag.SCHEDULE_PUBLISH,
    PermissionFlag.OFFER_SEND,
    PermissionFlag.STAFFING_REQUEST_APPROVE,
  ];
  const VENUE_MANAGER_PERMS = [PermissionFlag.VENUE_VIEW, PermissionFlag.SCHEDULE_VIEW, PermissionFlag.STAFF_VIEW, PermissionFlag.REPORT_VIEW, PermissionFlag.ATTENDANCE_VIEW, PermissionFlag.STAFFING_REQUEST_CREATE];

  async function ensurePermission(key: string, resource: string, action: string): Promise<Permission> {
    // `permission` is global reference data, not tenant-scoped — no RLS, safe via the raw dataSource connection.
    let permission = await dataSource.manager.findOne(Permission, { where: { key } });
    if (!permission) permission = await dataSource.manager.save(Permission, { key, resource, action });
    return permission;
  }

  /** One org, one real Internal Manager (platform admin, first-claimed), one real Venue Manager, two venues. All FORCE-RLS'd tables written inside one bound tenant context, matching this repo's other abuse-case specs. */
  async function seedOrg(existingOrganisation?: Organisation): Promise<{
    organisation: Organisation;
    manager: { email: string; userId: string };
    venueManagerProfileId: string;
    venueManager: { email: string; userId: string };
    venue1: Venue;
    venue2: Venue;
  }> {
    const slug = `test-${randomUUID()}`;
    const organisation = existingOrganisation ?? await adminDataSource.manager.save(Organisation, { name: slug, slug });

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
          const existing = await m.findOne(Role, {where: {organisationId: organisation.id, key}});
          if (existing) return existing.id;
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
    const res = await request(app.getHttpServer()).post('/rest/v1/auth/login').send({ email, password, applicationTarget: email.startsWith('venuemgr-') ? 'venue_manager_app' : 'manager_web' });
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

  /**
   * "Users" (`venue-directory`) now requires the Staff account to be ACTIVE
   * (past its own real activate/first-login flow — unit-tested end to end
   * elsewhere: `AuthService.login`), and `sendOne` now revalidates that same
   * ACTIVE status before an offer can even be created — so this must run
   * BEFORE `sendOffer`, not after. This test suite is about venue-SCOPED
   * visibility, not re-proving the activation flow itself, so it reaches
   * the same end state directly, matching this file's own existing pattern
   * of raw `tenantContext`-bound writes for fixture setup (e.g. `seedJobRole`).
   */
  async function activateStaff(organisation: Organisation, managerUserId: string, staffProfileId: string) {
    const [{ id: workspaceId }] = await adminDataSource.manager.query<[{ id: string }]>(
      `SELECT id FROM core.manager_workspace WHERE organisation_id = $1`,
      [organisation.id],
    );
    await tenantContext.runInTenantContext(
      { organisationId: organisation.id, workspaceId, userId: managerUserId, role: '' },
      (m) => m.query(`UPDATE core."user" SET status = 'active' WHERE id = (SELECT user_id FROM core.staff_profile WHERE id = $1)`, [staffProfileId]),
    );
  }

  /**
   * `venue-directory`'s "Users" also requires a CONFIRMED `ShiftAssignment`
   * (real accept+confirm flow — `scheduling-offer-abuse-cases.integration.spec.ts`
   * owns that state machine). Called AFTER `sendOffer`, once the assignment
   * row actually exists.
   */
  async function confirmAssignment(organisation: Organisation, managerUserId: string, staffProfileId: string, shiftId: string) {
    const [{ id: workspaceId }] = await adminDataSource.manager.query<[{ id: string }]>(
      `SELECT id FROM core.manager_workspace WHERE organisation_id = $1`,
      [organisation.id],
    );
    await tenantContext.runInTenantContext(
      { organisationId: organisation.id, workspaceId, userId: managerUserId, role: '' },
      (m) => m.query(
        `UPDATE core.shift_assignment SET status = 'confirmed', confirmed_at = now() WHERE shift_id = $1 AND staff_profile_id = $2`,
        [shiftId, staffProfileId],
      ),
    );
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
    expect(listRes.body.data.map((v: { id: string }) => v.id)).toEqual([venue1.id]);

    const getVenue1 = await request(app.getHttpServer()).get(`/rest/v1/venues/${venue1.id}`).set('Authorization', `Bearer ${vmToken}`);
    expect(getVenue1.status).toBe(200);
    const getVenue2 = await request(app.getHttpServer()).get(`/rest/v1/venues/${venue2.id}`).set('Authorization', `Bearer ${vmToken}`);
    expect(getVenue2.status).toBe(404);

    // The assigning Manager still sees every org venue, unchanged.
    const managerList = await request(app.getHttpServer()).get('/rest/v1/venues').set('Authorization', `Bearer ${managerToken}`);
    expect(managerList.body.data.map((v: { id: string }) => v.id).sort()).toEqual([venue1.id, venue2.id].sort());
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
    await activateStaff(organisation, manager.userId, staff1);
    await activateStaff(organisation, manager.userId, staff2);
    const offer1 = await sendOffer(managerToken, shift1, staff1);
    await sendOffer(managerToken, shift2, staff2);

    const shiftsRes = await request(app.getHttpServer()).get('/rest/v1/shifts').set('Authorization', `Bearer ${vmToken}`);
    expect(shiftsRes.status).toBe(200);
    expect(shiftsRes.body.data.map((s: { id: string }) => s.id)).toEqual([shift1]);

    const offersRes = await request(app.getHttpServer()).get('/rest/v1/offers').set('Authorization', `Bearer ${vmToken}`);
    expect(offersRes.status).toBe(200);
    expect(offersRes.body.data.map((o: { id: string }) => o.id)).toEqual([offer1]);
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
    expect(beforeUnassign.body.data).toHaveLength(1);

    const unassignRes = await request(app.getHttpServer())
      .delete(`/rest/v1/managers/${venueManagerProfileId}/venues/${venue1.id}`)
      .set('Authorization', `Bearer ${managerToken}`);
    expect(unassignRes.status).toBe(204);

    const afterUnassign = await request(app.getHttpServer()).get('/rest/v1/venues').set('Authorization', `Bearer ${vmToken}`);
    expect(afterUnassign.body.data).toEqual([]);
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
  it('minimal directory, search and capabilities obey venue scope and revoke immediately', async () => {
    const { organisation, manager, venueManagerProfileId, venueManager, venue1, venue2 } = await seedOrg();
    const managerToken = await login(manager.email);
    const vmToken = await login(venueManager.email);
    await request(app.getHttpServer()).post('/rest/v1/managers/' + venueManagerProfileId + '/venues')
      .set('Authorization', 'Bearer ' + managerToken).send({ venueId: venue1.id }).expect(204);
    const shift1 = await createAndPublishShift(managerToken, organisation, venue1);
    const shift2 = await createAndPublishShift(managerToken, organisation, venue2);
    const staff1 = await createStaff(managerToken, 'Visible');
    const staff2 = await createStaff(managerToken, 'Hidden');
    await activateStaff(organisation, manager.userId, staff1);
    await activateStaff(organisation, manager.userId, staff2);
    await sendOffer(managerToken, shift1, staff1);
    await sendOffer(managerToken, shift2, staff2);
    await confirmAssignment(organisation, manager.userId, staff1, shift1);
    await confirmAssignment(organisation, manager.userId, staff2, shift2);
    const get = (path: string) => request(app.getHttpServer()).get(path).set('Authorization', 'Bearer ' + vmToken);
    await request(app.getHttpServer()).post('/rest/v1/staff/venue-directory/team/' + staff1).set('Authorization', 'Bearer ' + vmToken).expect(201);
    const directory = await get('/rest/v1/staff/venue-directory').expect(200);
    expect(directory.body.total).toBe(1);
    expect(directory.body.data.map((u: {id: string}) => u.id)).toEqual([staff1]);
    expect(Object.keys(directory.body.data[0]).sort()).toEqual(['employmentStatus','firstName','id','lastName']);
    expect((await get('/rest/v1/staff/venue-directory?q=Hidden').expect(200)).body.total).toBe(0);
    expect((await get('/rest/v1/staff/venue-directory?q=Visible').expect(200)).body.total).toBe(1);
    await get('/rest/v1/staff/' + staff2).expect(404);
    const caps = await get('/rest/v1/auth/capabilities').expect(200);
    expect(caps.body['staff.view']).toBe(true);
    expect(caps.body['offer.send']).toBe(false);
    await request(app.getHttpServer()).post('/rest/v1/shifts/' + shift1 + '/offers/bulk')
      .set('Authorization', 'Bearer ' + vmToken).send({ staffProfileIds: [staff2] }).expect(403);
    await request(app.getHttpServer()).delete('/rest/v1/managers/' + venueManagerProfileId + '/venues/' + venue1.id)
      .set('Authorization', 'Bearer ' + managerToken).expect(204);
    expect((await get('/rest/v1/staff/venue-directory').expect(200)).body).toEqual({data: [], total: 0});
    expect((await get('/rest/v1/shifts').expect(200)).body.data).toEqual([]);
    expect((await get('/rest/v1/offers').expect(200)).body.data).toEqual([]);
  });

  it('a second Venue Manager cannot enumerate another manager venue, shifts, offers or staff', async () => {
    const a = await seedOrg(); const b = await seedOrg();
    const am = await login(a.manager.email); const bm = await login(b.manager.email);
    const av = await login(a.venueManager.email); const bv = await login(b.venueManager.email);
    for (const [seed, token] of [[a,am],[b,bm]] as const) {
      await request(app.getHttpServer()).post('/rest/v1/managers/' + seed.venueManagerProfileId + '/venues')
        .set('Authorization','Bearer ' + token).send({venueId:seed.venue1.id}).expect(204);
    }
    const shift = await createAndPublishShift(am,a.organisation,a.venue1);
    const staff = await createStaff(am,'Private');
    await activateStaff(a.organisation, a.manager.userId, staff);
    await sendOffer(am,shift,staff);
    await confirmAssignment(a.organisation, a.manager.userId, staff, shift);
    await request(app.getHttpServer()).post('/rest/v1/staff/venue-directory/team/' + staff).set('Authorization', 'Bearer ' + av).expect(201);
    await request(app.getHttpServer()).post('/rest/v1/staff/venue-directory/team/' + staff).set('Authorization', 'Bearer ' + bv).expect(404);
    const aStaff = await request(app.getHttpServer()).get('/rest/v1/staff/venue-directory').set('Authorization','Bearer ' + av).expect(200);
    expect(aStaff.body.data.map((row:{id:string})=>row.id)).toContain(staff);
    for (const resource of ['venues/' + a.venue1.id,'shifts/' + shift,'staff/' + staff]) {
      await request(app.getHttpServer()).get('/rest/v1/' + resource).set('Authorization','Bearer ' + bv).expect(404);
    }
    for (const resource of ['shifts','offers','staff/venue-directory','staff/venue-directory/pool']) {
      const response = await request(app.getHttpServer()).get('/rest/v1/' + resource).set('Authorization','Bearer ' + bv).expect(200);
      expect(response.body.data).toEqual([]);
    }
  });

  it('All Users (pool) only shows ACTIVE Staff — pending and suspended stay hidden, workspace scope holds', async () => {
    const { organisation, manager, venueManagerProfileId, venueManager, venue1 } = await seedOrg();
    const managerToken = await login(manager.email);
    const vmToken = await login(venueManager.email);
    await request(app.getHttpServer()).post('/rest/v1/managers/' + venueManagerProfileId + '/venues')
      .set('Authorization', 'Bearer ' + managerToken).send({ venueId: venue1.id }).expect(204);

    const pendingStaff = await createStaff(managerToken, 'Pending'); // never activated — still `invited`
    const activeStaff = await createStaff(managerToken, 'ActivePool');
    const suspendedStaff = await createStaff(managerToken, 'Suspended');

    const [{ id: workspaceId }] = await adminDataSource.manager.query<[{ id: string }]>(
      `SELECT id FROM core.manager_workspace WHERE organisation_id = $1`,
      [organisation.id],
    );
    await tenantContext.runInTenantContext(
      { organisationId: organisation.id, workspaceId, userId: manager.userId, role: '' },
      async (m) => {
        for (const id of [activeStaff, suspendedStaff]) {
          await m.query(`UPDATE core."user" SET status = 'active' WHERE id = (SELECT user_id FROM core.staff_profile WHERE id = $1)`, [id]);
        }
      },
    );
    // Real app action, not a raw update — exercises the actual suspend path
    // (`StaffService.deactivate` → `setEmploymentStatus`), which is itself
    // what flips `User.status` back to `suspended`.
    await request(app.getHttpServer()).post('/rest/v1/staff/' + suspendedStaff + '/deactivate')
      .set('Authorization', 'Bearer ' + managerToken).send({}).expect(201);

    const get = (path: string) => request(app.getHttpServer()).get(path).set('Authorization', 'Bearer ' + vmToken);
    expect((await get('/rest/v1/staff/venue-directory').expect(200)).body.total).toBe(0);
    const add = (id: string) => request(app.getHttpServer()).post('/rest/v1/staff/venue-directory/team/' + id).set('Authorization', 'Bearer ' + vmToken);
    await add(pendingStaff).expect(404);
    await add(suspendedStaff).expect(404);
    await add(activeStaff).expect(201);
    await add(activeStaff).expect(201);
    const saved = await get('/rest/v1/staff/venue-directory').expect(200);
    expect(saved.body.data.map((u: {id:string}) => u.id)).toEqual([activeStaff]);
    const pool = await get('/rest/v1/staff/venue-directory/pool').expect(200);
    expect(pool.body.data.find((u: {id:string}) => u.id === activeStaff).added).toBe(true);
    const ids = pool.body.data.map((r: { id: string }) => r.id);
    expect(ids).toContain(activeStaff);
    expect(ids).not.toContain(pendingStaff);
    expect(ids).not.toContain(suspendedStaff);
    expect((await get('/rest/v1/staff/venue-directory/pool?q=Pending').expect(200)).body.total).toBe(0);
    expect((await get('/rest/v1/staff/venue-directory/pool?q=Suspended').expect(200)).body.total).toBe(0);
  });

  it('team membership rejects sibling workspace staff and raw RLS bypass, selector excludes unadded staff', async () => {
    const a = await seedOrg(); const b = await seedOrg(a.organisation);
    const am = await login(a.manager.email); const bm = await login(b.manager.email);
    await request(app.getHttpServer()).post('/rest/v1/managers/' + a.venueManagerProfileId + '/venues')
      .set('Authorization', 'Bearer ' + am).send({venueId:a.venue1.id}).expect(204);
    const av = await login(a.venueManager.email);
    const own = await createStaff(am, 'OwnTeam'); const unadded = await createStaff(am, 'Unadded');
    const foreign = await createStaff(bm, 'Sibling');
    await activateStaff(a.organisation, a.manager.userId, own);
    await activateStaff(a.organisation, a.manager.userId, unadded);
    await activateStaff(b.organisation, b.manager.userId, foreign);
    const post = (id:string) => request(app.getHttpServer()).post('/rest/v1/staff/venue-directory/team/' + id).set('Authorization','Bearer ' + av);
    await post(foreign).expect(404); await post(own).expect(201); await post(own).expect(201);
    const ctx = {organisationId:a.organisation.id, workspaceId:a.venue1.workspaceId ?? null, userId:a.venueManager.userId, role:'venue_manager'};
    await expect(tenantContext.runInTenantContext(ctx, m => assertVenueTeamSelection(m, ctx, [unadded], a.venue1.workspaceId))).rejects.toThrow('team');
    await tenantContext.runInTenantContext(ctx, async m => {
      await assertVenueTeamSelection(m, ctx, [own], a.venue1.workspaceId);
      const rows = await m.query('SELECT * FROM core.venue_manager_staff');
      expect(rows).toHaveLength(1);
      expect((await m.query('SELECT * FROM core.shift_assignment'))).toHaveLength(0);
    });
    await expect(tenantContext.runInTenantContext(ctx, m => m.query(
      'INSERT INTO core.venue_manager_staff (organisation_id,workspace_id,manager_profile_id,staff_profile_id) VALUES ($1,$2,$3,$4)',
      [a.organisation.id,b.venue1.workspaceId,a.venueManagerProfileId,foreign]))).rejects.toThrow();
  });

  if (process.env.VM_NATIVE_FIXTURE === 'true') it('prepares an isolated local native QA account', async () => {
    const seed = await seedOrg(); const token = await login(seed.manager.email);
    await request(app.getHttpServer()).post('/rest/v1/managers/' + seed.venueManagerProfileId + '/venues')
      .set('Authorization','Bearer ' + token).send({venueId:seed.venue1.id}).expect(204);
    const shift = await createAndPublishShift(token,seed.organisation,seed.venue1);
    const staff = await createStaff(token,'Alice'); await activateStaff(seed.organisation, seed.manager.userId, staff); await sendOffer(token,shift,staff);
    const fs = await import('node:fs/promises'); const os = await import('node:os'); const path = await import('node:path');
    await fs.writeFile(path.join(os.tmpdir(),'rab-venue-manager-native-qa.json'),JSON.stringify({email:seed.venueManager.email,password,shiftId:shift,organisationId:seed.organisation.id}));
  });

  describe('Venue Offers — Internal Manager review of a Venue Manager\'s pending request', () => {
    /** Assigns the venue, builds two ACTIVE team staff, and submits a pending request for both. */
    async function seedPendingRequest(requiredCount = 2) {
      const seed = await seedOrg();
      const managerToken = await login(seed.manager.email);
      const vmToken = await login(seed.venueManager.email);
      await request(app.getHttpServer())
        .post(`/rest/v1/managers/${seed.venueManagerProfileId}/venues`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ venueId: seed.venue1.id })
        .expect(204);
      const jobRole = await seedJobRole(seed.organisation, seed.manager.userId);
      const staffA = await createStaff(managerToken, 'Alpha');
      const staffB = await createStaff(managerToken, 'Bravo');
      await activateStaff(seed.organisation, seed.manager.userId, staffA);
      await activateStaff(seed.organisation, seed.manager.userId, staffB);
      await request(app.getHttpServer()).post(`/rest/v1/staff/venue-directory/team/${staffA}`).set('Authorization', `Bearer ${vmToken}`).expect(201);
      await request(app.getHttpServer()).post(`/rest/v1/staff/venue-directory/team/${staffB}`).set('Authorization', `Bearer ${vmToken}`).expect(201);

      const startsAt = new Date(Date.now() + 72 * 3600 * 1000);
      const endsAt = new Date(startsAt.getTime() + 5 * 3600 * 1000);
      const submitRes = await request(app.getHttpServer())
        .post('/rest/v1/shifts/request')
        .set('Authorization', `Bearer ${vmToken}`)
        .send({
          venueId: seed.venue1.id,
          jobRoleId: jobRole.id,
          startsAt: startsAt.toISOString(),
          endsAt: endsAt.toISOString(),
          staffRequired: requiredCount,
          staffProfileIds: [staffA, staffB],
        });
      expect(submitRes.status).toBe(201);
      return { ...seed, managerToken, vmToken, shiftId: submitRes.body.id as string, staffA, staffB };
    }

    it('Internal Manager sees the pending request in the Venue Offers queue with the real recipient count', async () => {
      const { managerToken, shiftId } = await seedPendingRequest();
      const listRes = await request(app.getHttpServer()).get('/rest/v1/shifts/requests?status=pending').set('Authorization', `Bearer ${managerToken}`);
      expect(listRes.status).toBe(200);
      const row = listRes.body.data.find((r: { id: string }) => r.id === shiftId);
      expect(row).toBeTruthy();
      expect(Number(row.selectedCount)).toBe(2);
      expect(row.status).toBe('pending_manager_approval');
    });

    it('removing a staff member drops them from the recipient list, is audited, and notifies the Venue Manager — approval then sends offers only to whoever remains', async () => {
      const { managerToken, shiftId, staffA, staffB } = await seedPendingRequest();

      const removeRes = await request(app.getHttpServer())
        .delete(`/rest/v1/shifts/${shiftId}/requested-staff/${staffA}`)
        .set('Authorization', `Bearer ${managerToken}`);
      expect(removeRes.status).toBe(200);

      // Idempotency: the same staff member cannot be removed twice.
      const secondRemove = await request(app.getHttpServer())
        .delete(`/rest/v1/shifts/${shiftId}/requested-staff/${staffA}`)
        .set('Authorization', `Bearer ${managerToken}`);
      expect(secondRemove.status).toBe(404);

      const remaining = await request(app.getHttpServer())
        .get(`/rest/v1/shifts/${shiftId}/requested-staff`)
        .set('Authorization', `Bearer ${managerToken}`);
      expect(remaining.body.map((s: { staffProfileId: string }) => s.staffProfileId)).toEqual([staffB]);

      const approveRes = await request(app.getHttpServer())
        .post(`/rest/v1/shifts/${shiftId}/approve`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({});
      expect(approveRes.status).toBe(201);
      expect(approveRes.body.results).toHaveLength(1);
      expect(approveRes.body.results[0].staffProfileId).toBe(staffB);

      // The removed staff member never received an offer — server-derived
      // recipient list, never the client's original submission.
      const offersForRemoved = await adminDataSource.manager.query(
        `SELECT jo.id FROM core.job_offer jo JOIN core.shift_assignment sa ON sa.id = jo.shift_assignment_id WHERE sa.shift_id = $1 AND jo.staff_profile_id = $2`,
        [shiftId, staffA],
      );
      expect(offersForRemoved).toHaveLength(0);
    });

    it('approving with zero remaining recipients is rejected — a request cannot be approved into silence', async () => {
      const { managerToken, shiftId, staffA, staffB } = await seedPendingRequest();
      await request(app.getHttpServer()).delete(`/rest/v1/shifts/${shiftId}/requested-staff/${staffA}`).set('Authorization', `Bearer ${managerToken}`).expect(200);
      await request(app.getHttpServer()).delete(`/rest/v1/shifts/${shiftId}/requested-staff/${staffB}`).set('Authorization', `Bearer ${managerToken}`).expect(200);
      const approveRes = await request(app.getHttpServer()).post(`/rest/v1/shifts/${shiftId}/approve`).set('Authorization', `Bearer ${managerToken}`).send({});
      expect(approveRes.status).toBe(409);
    });

    it('a replacement staff member can be added before approval and receives an offer', async () => {
      const { managerToken, organisation, manager, shiftId, staffA, staffB } = await seedPendingRequest();
      await request(app.getHttpServer()).delete(`/rest/v1/shifts/${shiftId}/requested-staff/${staffB}`).set('Authorization', `Bearer ${managerToken}`).expect(200);
      const replacement = await createStaff(managerToken, 'Replacement');
      await activateStaff(organisation, manager.userId, replacement);

      const addRes = await request(app.getHttpServer())
        .post(`/rest/v1/shifts/${shiftId}/requested-staff/${replacement}`)
        .set('Authorization', `Bearer ${managerToken}`);
      expect(addRes.status).toBe(201);

      const dup = await request(app.getHttpServer())
        .post(`/rest/v1/shifts/${shiftId}/requested-staff/${replacement}`)
        .set('Authorization', `Bearer ${managerToken}`);
      expect(dup.status).toBe(409);

      const approveRes = await request(app.getHttpServer()).post(`/rest/v1/shifts/${shiftId}/approve`).set('Authorization', `Bearer ${managerToken}`).send({});
      expect(approveRes.status).toBe(201);
      const recipientIds = approveRes.body.results.map((r: { staffProfileId: string }) => r.staffProfileId).sort();
      expect(recipientIds).toEqual([staffA, replacement].sort());
    });

    it('declining the whole request sends no offers and requires no client-supplied staff list', async () => {
      const { managerToken, shiftId } = await seedPendingRequest();
      const declineRes = await request(app.getHttpServer())
        .post(`/rest/v1/shifts/${shiftId}/decline`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ reason: 'Venue cancelled the event' });
      expect(declineRes.status).toBe(201);
      expect(declineRes.body.status).toBe('declined');
      expect(declineRes.body.declinedReason).toBe('Venue cancelled the event');
      const offers = await adminDataSource.manager.query(
        `SELECT jo.id FROM core.job_offer jo JOIN core.shift_assignment sa ON sa.id = jo.shift_assignment_id WHERE sa.shift_id = $1`,
        [shiftId],
      );
      expect(offers).toHaveLength(0);
    });

    it('cross-org isolation: another organisation\'s Internal Manager gets 404, never the data, on every Venue Offers action', async () => {
      const { shiftId, staffA } = await seedPendingRequest();
      const other = await seedOrg();
      const otherToken = await login(other.manager.email);

      await request(app.getHttpServer()).get(`/rest/v1/shifts/${shiftId}/requested-staff`).set('Authorization', `Bearer ${otherToken}`).expect(404);
      await request(app.getHttpServer()).delete(`/rest/v1/shifts/${shiftId}/requested-staff/${staffA}`).set('Authorization', `Bearer ${otherToken}`).expect(404);
      await request(app.getHttpServer()).post(`/rest/v1/shifts/${shiftId}/approve`).set('Authorization', `Bearer ${otherToken}`).send({}).expect(404);

      const otherList = await request(app.getHttpServer()).get('/rest/v1/shifts/requests').set('Authorization', `Bearer ${otherToken}`);
      expect(otherList.body.data.find((r: { id: string }) => r.id === shiftId)).toBeUndefined();
    });
  });

  describe('Staff Availability', () => {
    /** One org, one venue-team staff member with a real CONFIRMED assignment on a known window. */
    async function seedBusyStaff(startsAt: Date, endsAt: Date) {
      const seed = await seedOrg();
      const managerToken = await login(seed.manager.email);
      const vmToken = await login(seed.venueManager.email);
      await request(app.getHttpServer())
        .post(`/rest/v1/managers/${seed.venueManagerProfileId}/venues`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ venueId: seed.venue1.id })
        .expect(204);
      const jobRole = await seedJobRole(seed.organisation, seed.manager.userId);
      const staffId = await createStaff(managerToken, 'Busy');
      await activateStaff(seed.organisation, seed.manager.userId, staffId);

      const createRes = await request(app.getHttpServer())
        .post('/rest/v1/shifts')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ venueId: seed.venue1.id, jobRoleId: jobRole.id, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), requiredCount: 1 });
      expect(createRes.status).toBe(201);
      const busyShiftId = createRes.body.id as string;
      await request(app.getHttpServer()).post(`/rest/v1/shifts/${busyShiftId}/publish`).set('Authorization', `Bearer ${managerToken}`).expect(201);
      await sendOffer(managerToken, busyShiftId, staffId);
      // Raw confirm (this file's own established helper) rather than a real
      // staff login+accept — `createStaff`/`activateStaff` here only flip
      // `User.status`, they never set a real password for this fixture
      // account to log in with (unlike `scheduling-offer-abuse-cases`'s own
      // `seedStaff`). `AvailabilityService` only cares that the resulting
      // `shift_assignment` row is `status='confirmed'` with a real `period`
      // (already set at offer-creation time) — not how it got there.
      await confirmAssignment(seed.organisation, seed.manager.userId, staffId, busyShiftId);

      return { ...seed, managerToken, vmToken, staffId, busyShiftId, jobRole };
    }

    it('a staff member with an overlapping CONFIRMED assignment is reported unavailable in the bulk directory listing', async () => {
      const busyStart = new Date(Date.now() + 72 * 3600 * 1000);
      const busyEnd = new Date(busyStart.getTime() + 8 * 3600 * 1000);
      const { vmToken, staffId } = await seedBusyStaff(busyStart, busyEnd);
      await request(app.getHttpServer()).post(`/rest/v1/staff/venue-directory/team/${staffId}`).set('Authorization', `Bearer ${vmToken}`).expect(201);

      const overlapStart = new Date(busyStart.getTime() + 3600 * 1000);
      const overlapEnd = new Date(busyEnd.getTime() + 3600 * 1000);
      const res = await request(app.getHttpServer())
        .get(`/rest/v1/staff/venue-directory?startAt=${overlapStart.toISOString()}&endAt=${overlapEnd.toISOString()}`)
        .set('Authorization', `Bearer ${vmToken}`);
      expect(res.status).toBe(200);
      const row = res.body.data.find((r: { id: string }) => r.id === staffId);
      expect(row.available).toBe(false);
    });

    it('the same staff member is available for a genuinely non-overlapping window', async () => {
      const busyStart = new Date(Date.now() + 72 * 3600 * 1000);
      const busyEnd = new Date(busyStart.getTime() + 8 * 3600 * 1000);
      const { vmToken, staffId } = await seedBusyStaff(busyStart, busyEnd);
      await request(app.getHttpServer()).post(`/rest/v1/staff/venue-directory/team/${staffId}`).set('Authorization', `Bearer ${vmToken}`).expect(201);

      const freeStart = new Date(busyEnd.getTime() + 24 * 3600 * 1000);
      const freeEnd = new Date(freeStart.getTime() + 8 * 3600 * 1000);
      const res = await request(app.getHttpServer())
        .get(`/rest/v1/staff/venue-directory?startAt=${freeStart.toISOString()}&endAt=${freeEnd.toISOString()}`)
        .set('Authorization', `Bearer ${vmToken}`);
      const row = res.body.data.find((r: { id: string }) => r.id === staffId);
      expect(row.available).toBe(true);
    });

    it('overnight shifts overlap correctly across the midnight boundary', async () => {
      // Existing confirmed: 20:00 -> +6h (crosses midnight). New window: starts 3h into it, also crossing midnight further.
      const busyStart = new Date(Date.now() + 72 * 3600 * 1000);
      busyStart.setUTCHours(20, 0, 0, 0);
      const busyEnd = new Date(busyStart.getTime() + 6 * 3600 * 1000);
      const { vmToken, staffId } = await seedBusyStaff(busyStart, busyEnd);
      await request(app.getHttpServer()).post(`/rest/v1/staff/venue-directory/team/${staffId}`).set('Authorization', `Bearer ${vmToken}`).expect(201);

      const overlapStart = new Date(busyStart.getTime() + 3 * 3600 * 1000);
      const overlapEnd = new Date(overlapStart.getTime() + 8 * 3600 * 1000);
      const res = await request(app.getHttpServer())
        .get(`/rest/v1/staff/venue-directory?startAt=${overlapStart.toISOString()}&endAt=${overlapEnd.toISOString()}`)
        .set('Authorization', `Bearer ${vmToken}`);
      const row = res.body.data.find((r: { id: string }) => r.id === staffId);
      expect(row.available).toBe(false);
    });

    it('excludeShiftId lets a staff member appear available for their own already-assigned shift (editing)', async () => {
      const busyStart = new Date(Date.now() + 72 * 3600 * 1000);
      const busyEnd = new Date(busyStart.getTime() + 8 * 3600 * 1000);
      const { vmToken, staffId, busyShiftId } = await seedBusyStaff(busyStart, busyEnd);
      await request(app.getHttpServer()).post(`/rest/v1/staff/venue-directory/team/${staffId}`).set('Authorization', `Bearer ${vmToken}`).expect(201);

      const withoutExclude = await request(app.getHttpServer())
        .get(`/rest/v1/staff/venue-directory?startAt=${busyStart.toISOString()}&endAt=${busyEnd.toISOString()}`)
        .set('Authorization', `Bearer ${vmToken}`);
      expect(withoutExclude.body.data.find((r: { id: string }) => r.id === staffId).available).toBe(false);

      const withExclude = await request(app.getHttpServer())
        .get(`/rest/v1/staff/venue-directory?startAt=${busyStart.toISOString()}&endAt=${busyEnd.toISOString()}&excludeShiftId=${busyShiftId}`)
        .set('Authorization', `Bearer ${vmToken}`);
      expect(withExclude.body.data.find((r: { id: string }) => r.id === staffId).available).toBe(true);
    });

    it('server-side revalidation rejects submitting a request for a staff member who is no longer available, even though the client could only have seen a stale "available" read', async () => {
      const busyStart = new Date(Date.now() + 72 * 3600 * 1000);
      const busyEnd = new Date(busyStart.getTime() + 8 * 3600 * 1000);
      const { vmToken, staffId, organisation, venue1 } = await seedBusyStaff(busyStart, busyEnd);
      await request(app.getHttpServer()).post(`/rest/v1/staff/venue-directory/team/${staffId}`).set('Authorization', `Bearer ${vmToken}`).expect(201);
      const jobRole = await seedJobRole(organisation, venue1.createdBy!);

      const overlapStart = new Date(busyStart.getTime() + 3600 * 1000);
      const overlapEnd = new Date(busyEnd.getTime() + 3600 * 1000);
      const submitRes = await request(app.getHttpServer())
        .post('/rest/v1/shifts/request')
        .set('Authorization', `Bearer ${vmToken}`)
        .send({
          venueId: venue1.id,
          jobRoleId: jobRole.id,
          startsAt: overlapStart.toISOString(),
          endsAt: overlapEnd.toISOString(),
          staffRequired: 1,
          staffProfileIds: [staffId],
        });
      expect(submitRes.status).toBe(409);
      expect(submitRes.body.message).toContain('no longer available');
    });
  });

});
