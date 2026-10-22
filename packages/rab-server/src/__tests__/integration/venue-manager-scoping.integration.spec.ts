import { insertMembership } from './helpers/test-identities';
import { AvailabilityService } from '../../modules/scheduling/services/availability.service';
import { ShiftReportService } from '../../modules/attendance/services/shift-report.service';
import { OfferService } from '../../modules/offer/services/offer.service';
import { assertVenueTeamSelection } from '../../modules/staff/services/venue-team-scope';
import 'reflect-metadata';
import { payForMinutes, ManagerType, PermissionFlag, UserStatus } from '@rab/shared';
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
import { BootstrapTimer } from './helpers/bootstrap-trace';
import { generateFixturePassword } from './helpers/fixture-password';

const FIXTURE_PASSWORD = generateFixturePassword();

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

  const password = FIXTURE_PASSWORD;

  const MANAGER_PERMS = [
    PermissionFlag.MANAGER_MANAGE,
    // Production manager/CEO roles hold it; the workspace owner assigns Staff to Venue Manager teams with it.
    PermissionFlag.VENUE_MANAGER_CREATE,
    PermissionFlag.STAFF_CREATE,
    PermissionFlag.STAFF_VIEW,
    PermissionFlag.STAFF_DEACTIVATE,
    PermissionFlag.VENUE_CREATE,
    PermissionFlag.VENUE_VIEW,
    PermissionFlag.SCHEDULE_VIEW,
    PermissionFlag.SCHEDULE_CREATE,
    PermissionFlag.SCHEDULE_PUBLISH,
    PermissionFlag.OFFER_SEND,
    PermissionFlag.OFFER_CONFIRM,
    PermissionFlag.OFFER_WITHDRAW,
    PermissionFlag.REPORT_VIEW,
    PermissionFlag.REPORT_EXPORT,
    PermissionFlag.STAFFING_REQUEST_APPROVE,
  ];
  const VENUE_MANAGER_PERMS = [PermissionFlag.VENUE_VIEW, PermissionFlag.SCHEDULE_VIEW, PermissionFlag.STAFF_VIEW, PermissionFlag.REPORT_VIEW, PermissionFlag.ATTENDANCE_VIEW, PermissionFlag.REPORT_EXPORT, PermissionFlag.STAFFING_REQUEST_CREATE, PermissionFlag.REVIEW_CREATE, PermissionFlag.ATTENDANCE_EDIT];

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
        await insertMembership(m, organisation.id, manager.userId, workspace.id);
        await m.query(`INSERT INTO core.manager_profile (organisation_id, user_id, type, workspace_id) VALUES ($1, $2, $3, $4)`, [
          organisation.id,
          manager.userId,
          ManagerType.INTERNAL,
          workspace.id,
        ]);

        venueManager = await insertUser(venueManagerRoleId, 'VenueMgr');
        const venueManagerProfileResult = await m.query(
          `INSERT INTO core.manager_profile (organisation_id, user_id, type, workspace_id) VALUES ($1, $2, $3, $4) RETURNING id`,
          [organisation.id, venueManager.userId, ManagerType.VENUE, workspace.id],
        );
        venueManagerProfileId = venueManagerProfileResult[0].id as string;
        // Production writes this membership for every VENUE-type manager (ManagerService → WorkspaceMembershipService.assignToWorkspace).
        // Without it the Venue Manager's session resolves no workspace, and staff_profile_select correctly shows zero Staff.
        await insertMembership(m, organisation.id, venueManager.userId, workspace.id);
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

  /**
   * A second Internal Manager bound to an EXISTING workspace from the start — never created-then-rebound. Added after
   * `ManagerProfileWorkspaceBindingGuard1786677600000` made `manager_profile.workspace_id` immutable once set: the
   * original fixture here called `seedOrg()` (which always creates its OWN fresh workspace) and then UPDATEd the
   * result's `workspace_id` to match `seed`'s — exactly the mutation that guard now correctly rejects. This creates
   * the manager pre-bound to the given workspace instead, so the test's actual subject (same-workspace, different
   * manager, private ownership still holds) is unaffected by the fixture change.
   */
  async function seedManagerInWorkspace(organisation: Organisation, workspaceId: string): Promise<{ email: string; userId: string }> {
    for (const key of MANAGER_PERMS) await ensurePermission(key, key.split('.')[0]!, key.split('.')[1]!);
    return tenantContext.runInTenantContext({ organisationId: organisation.id, workspaceId, userId: randomUUID(), role: '' }, async (m) => {
      let roleId = (await m.findOne(Role, { where: { organisationId: organisation.id, key: 'manager' } }))?.id;
      if (!roleId) {
        roleId = (await m.insert(Role, { organisationId: organisation.id, key: 'manager', name: 'Manager', isSystem: true })).identifiers[0]!.id as string;
        for (const permKey of MANAGER_PERMS) {
          const permission = await dataSource.manager.findOneByOrFail(Permission, { key: permKey });
          await m.insert(RolePermission, { roleId, permissionId: permission.id, organisationId: organisation.id });
        }
      }
      const email = `othermgr-${randomUUID()}@example.test`;
      const passwordHash = await passwordHashing.hash(password);
      const userResult = await m.insert(User, { organisationId: organisation.id, email, passwordHash, firstName: 'OtherMgr', lastName: 'Test', status: UserStatus.ACTIVE });
      const userId = userResult.identifiers[0]!.id as string;
      await m.insert(UserRole, { userId, roleId, organisationId: organisation.id });
      await m.query(`SELECT set_config('rab.user_id', $1, true)`, [userId]);
      await m.query(`INSERT INTO core.manager_profile (organisation_id, user_id, type, workspace_id) VALUES ($1, $2, $3, $4)`, [
        organisation.id,
        userId,
        ManagerType.INTERNAL,
        workspaceId,
      ]);
      await insertMembership(m, organisation.id, userId, workspaceId);
      return { email, userId };
    });
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
      .send({ email: `staff-${prefix}-${randomUUID()}@example.test`, firstName: prefix, lastName: 'Staff' });
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
      `SELECT id FROM core.manager_workspace WHERE owner_user_id = $1`,
      [managerUserId],
    );
    await tenantContext.runInTenantContext(
      { organisationId: organisation.id, workspaceId, userId: managerUserId, role: '' },
      async (m) => {
        await m.query(`UPDATE core."user" SET status = 'active' WHERE id = (SELECT user_id FROM core.staff_profile WHERE id = $1)`, [staffProfileId]);
        await m.query(`UPDATE core.staff_profile SET employment_status = 'active' WHERE id = $1`, [staffProfileId]);
      },
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
    const __bt = new BootstrapTimer('venue-manager-scoping');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    __bt.mark('compile');
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    __bt.mark('init');
    await app.get(DataSource).query('SELECT 1');
    __bt.mark('dbPing');
    __bt.log();

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
      { organisationId: organisation.id, workspaceId: null, userId: manager.userId, role: '' },
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
    await request(app.getHttpServer()).post('/rest/v1/venue-managers/' + venueManagerProfileId + '/staff').set('Authorization', 'Bearer ' + managerToken).send({ staffProfileIds: [staff1] }).expect(201);
    const directory = await get('/rest/v1/staff/venue-directory').expect(200);
    expect(directory.body.total).toBe(1);
    expect(directory.body.data.map((u: {id: string}) => u.id)).toEqual([staff1]);
    expect(Object.keys(directory.body.data[0]).sort()).toEqual(['employmentStatus','firstName','id','isEmergency','isFavourite','jobRoleName','lastName']);
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
    await request(app.getHttpServer()).post('/rest/v1/venue-managers/' + a.venueManagerProfileId + '/staff').set('Authorization', 'Bearer ' + am).send({ staffProfileIds: [staff] }).expect(201);
    // Another organisation's owner cannot put A's staff on their own Venue Manager's team.
    await request(app.getHttpServer()).post('/rest/v1/venue-managers/' + b.venueManagerProfileId + '/staff').set('Authorization', 'Bearer ' + bm).send({ staffProfileIds: [staff] }).expect(404);
    const aStaff = await request(app.getHttpServer()).get('/rest/v1/staff/venue-directory').set('Authorization','Bearer ' + av).expect(200);
    expect(aStaff.body.data.map((row:{id:string})=>row.id)).toContain(staff);
    for (const resource of ['venues/' + a.venue1.id,'shifts/' + shift,'staff/' + staff]) {
      await request(app.getHttpServer()).get('/rest/v1/' + resource).set('Authorization','Bearer ' + bv).expect(404);
    }
    for (const resource of ['shifts','offers','staff/venue-directory']) {
      const response = await request(app.getHttpServer()).get('/rest/v1/' + resource).set('Authorization','Bearer ' + bv).expect(200);
      expect(response.body.data).toEqual([]);
    }
  });

  it('owner-assigned team: the Venue Manager can no longer discover or self-add staff; suspended staff cannot be assigned; invited staff stay hidden until active', async () => {
    const { organisation, manager, venueManagerProfileId, venueManager, venue1 } = await seedOrg();
    const managerToken = await login(manager.email);
    const vmToken = await login(venueManager.email);
    await request(app.getHttpServer()).post('/rest/v1/managers/' + venueManagerProfileId + '/venues')
      .set('Authorization', 'Bearer ' + managerToken).send({ venueId: venue1.id }).expect(204);

    const pendingStaff = await createStaff(managerToken, 'Pending'); // never activated, still `invited`
    const activeStaff = await createStaff(managerToken, 'ActivePool');
    const suspendedStaff = await createStaff(managerToken, 'Suspended');
    const unassigned = await createStaff(managerToken, 'Unassigned');
    const [{ id: workspaceId }] = await adminDataSource.manager.query<[{ id: string }]>(
      `SELECT id FROM core.manager_workspace WHERE organisation_id = $1`,
      [organisation.id],
    );
    await tenantContext.runInTenantContext(
      { organisationId: organisation.id, workspaceId, userId: manager.userId, role: '' },
      async (m) => {
        for (const id of [activeStaff, suspendedStaff, unassigned]) {
          await m.query(`UPDATE core."user" SET status = 'active' WHERE id = (SELECT user_id FROM core.staff_profile WHERE id = $1)`, [id]);
        }
      },
    );
    await request(app.getHttpServer()).post('/rest/v1/staff/' + suspendedStaff + '/deactivate')
      .set('Authorization', 'Bearer ' + managerToken).send({}).expect(201);

    const vmGet = (path: string) => request(app.getHttpServer()).get(path).set('Authorization', 'Bearer ' + vmToken);
    // The removed discovery and self-add surface is gone for the Venue Manager.
    expect([400, 404]).toContain((await vmGet('/rest/v1/staff/venue-directory/pool')).status);
    expect((await request(app.getHttpServer()).post('/rest/v1/staff/venue-directory/team/' + activeStaff).set('Authorization', 'Bearer ' + vmToken)).status).toBe(404);
    // ...and a Venue Manager cannot use the owner's assignment route either.
    expect([403, 404]).toContain((await request(app.getHttpServer()).post('/rest/v1/venue-managers/' + venueManagerProfileId + '/staff').set('Authorization', 'Bearer ' + vmToken).send({ staffProfileIds: [activeStaff] })).status);
    expect((await vmGet('/rest/v1/staff/venue-directory').expect(200)).body.total).toBe(0);

    const assign = (ids: string[]) => request(app.getHttpServer()).post('/rest/v1/venue-managers/' + venueManagerProfileId + '/staff')
      .set('Authorization', 'Bearer ' + managerToken).send({ staffProfileIds: ids });
    await assign([suspendedStaff]).expect(404);
    await assign([activeStaff, suspendedStaff]).expect(404); // all-or-nothing
    expect((await vmGet('/rest/v1/staff/venue-directory').expect(200)).body.total).toBe(0);
    const first = await assign([activeStaff, pendingStaff]).expect(201);
    expect(first.body.added.sort()).toEqual([activeStaff, pendingStaff].sort());
    const again = await assign([activeStaff]).expect(201);
    expect(again.body).toEqual({ added: [], alreadyAssigned: [activeStaff] });

    const saved = await vmGet('/rest/v1/staff/venue-directory').expect(200);
    expect(saved.body.data.map((u: { id: string }) => u.id)).toEqual([activeStaff]); // invited stays hidden until active
    await vmGet('/rest/v1/staff/venue-directory/' + unassigned).expect(404);
    await vmGet('/rest/v1/staff/venue-directory/' + pendingStaff).expect(404);
    const profile = await vmGet('/rest/v1/staff/venue-directory/' + activeStaff).expect(200);
    // Operational fields only: no contact details, date of birth, address, right-to-work, pay or emergency contacts.
    expect(Object.keys(profile.body).sort()).toEqual(['availableDays', 'employmentType', 'firstName', 'id', 'isEmergency', 'isFavourite', 'jobRoleName', 'lastName', 'maxHoursPerWeek', 'preferredShiftTimes', 'skills', 'yearsExperience'].sort());
    expect((await vmGet('/rest/v1/staff/venue-directory?q=Unassigned').expect(200)).body.total).toBe(0);

    // Owner removal takes effect on the Venue Manager's very next request; the account itself is untouched.
    const listed = await request(app.getHttpServer()).get('/rest/v1/venue-managers/' + venueManagerProfileId + '/staff').set('Authorization', 'Bearer ' + managerToken).expect(200);
    expect(listed.body.map((r: { id: string }) => r.id).sort()).toEqual([activeStaff, pendingStaff].sort());
    await request(app.getHttpServer()).delete('/rest/v1/venue-managers/' + venueManagerProfileId + '/staff/' + activeStaff).set('Authorization', 'Bearer ' + managerToken).expect(204);
    await request(app.getHttpServer()).delete('/rest/v1/venue-managers/' + venueManagerProfileId + '/staff/' + activeStaff).set('Authorization', 'Bearer ' + managerToken).expect(404);
    expect((await vmGet('/rest/v1/staff/venue-directory').expect(200)).body.total).toBe(0);
    await vmGet('/rest/v1/staff/venue-directory/' + activeStaff).expect(404);
    await request(app.getHttpServer()).get('/rest/v1/staff/' + activeStaff).set('Authorization', 'Bearer ' + managerToken).expect(200);
  });

  it('team tags are the Venue Manager\'s own: favourite / emergency filter only their team, and cannot tag anyone else', async () => {
    const { manager, venueManagerProfileId, venueManager, venue1, organisation } = await seedOrg();
    const managerToken = await login(manager.email);
    const vmToken = await login(venueManager.email);
    await request(app.getHttpServer()).post('/rest/v1/managers/' + venueManagerProfileId + '/venues')
      .set('Authorization', 'Bearer ' + managerToken).send({ venueId: venue1.id }).expect(204);
    const fav = await createStaff(managerToken, 'Fav'); const plain = await createStaff(managerToken, 'Plain'); const outsider = await createStaff(managerToken, 'Outsider');
    for (const id of [fav, plain, outsider]) await activateStaff(organisation, manager.userId, id);
    await request(app.getHttpServer()).post('/rest/v1/venue-managers/' + venueManagerProfileId + '/staff').set('Authorization', 'Bearer ' + managerToken).send({ staffProfileIds: [fav, plain] }).expect(201);
    const patch = (id: string, body: Record<string, unknown>) => request(app.getHttpServer()).patch('/rest/v1/staff/venue-directory/' + id + '/tags').set('Authorization', 'Bearer ' + vmToken).send(body);
    expect((await patch(fav, { favourite: true }).expect(200)).body).toEqual({ isFavourite: true, isEmergency: false });
    expect((await patch(fav, { emergency: true }).expect(200)).body).toEqual({ isFavourite: true, isEmergency: true });
    await patch(outsider, { favourite: true }).expect(404);
    await patch(fav, {}).expect(400);
    await patch(fav, { favourite: true, staffProfileId: outsider }).expect(400);
    const get = (q: string) => request(app.getHttpServer()).get('/rest/v1/staff/venue-directory' + q).set('Authorization', 'Bearer ' + vmToken);
    expect((await get('?tag=favourite').expect(200)).body.data.map((r: { id: string }) => r.id)).toEqual([fav]);
    expect((await get('?tag=emergency').expect(200)).body.data.map((r: { id: string }) => r.id)).toEqual([fav]);
    expect((await get('').expect(200)).body.total).toBe(2);
    await get('?tag=everyone').expect(400);
  });

  it('a removed assignment is refused at the shift-request boundary, and concurrent duplicate assignments create one row', async () => {
    const seed = await seedOrg();
    const managerToken = await login(seed.manager.email);
    const vmToken = await login(seed.venueManager.email);
    await request(app.getHttpServer()).post('/rest/v1/managers/' + seed.venueManagerProfileId + '/venues')
      .set('Authorization', 'Bearer ' + managerToken).send({ venueId: seed.venue1.id }).expect(204);
    const jobRole = await seedJobRole(seed.organisation, seed.manager.userId);
    const staff = await createStaff(managerToken, 'Removed');
    await activateStaff(seed.organisation, seed.manager.userId, staff);
    const assign = () => request(app.getHttpServer()).post('/rest/v1/venue-managers/' + seed.venueManagerProfileId + '/staff')
      .set('Authorization', 'Bearer ' + managerToken).send({ staffProfileIds: [staff] });
    const results = await Promise.all([assign(), assign(), assign(), assign(), assign()]);
    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
    expect(results.flatMap((r) => r.body.added)).toEqual([staff]);
    const team = await request(app.getHttpServer()).get('/rest/v1/venue-managers/' + seed.venueManagerProfileId + '/staff').set('Authorization', 'Bearer ' + managerToken).expect(200);
    expect(team.body.map((r: { id: string }) => r.id)).toEqual([staff]);

    const startsAt = new Date(Date.now() + 96 * 3600 * 1000);
    const body = { venueId: seed.venue1.id, jobRoleId: jobRole.id, startsAt: startsAt.toISOString(), endsAt: new Date(startsAt.getTime() + 5 * 3600 * 1000).toISOString(), staffRequired: 1, staffProfileIds: [staff] };
    await request(app.getHttpServer()).delete('/rest/v1/venue-managers/' + seed.venueManagerProfileId + '/staff/' + staff).set('Authorization', 'Bearer ' + managerToken).expect(204);
    // The id was valid a moment ago; it is not on the team any more, so the request is refused (no existence leak: 404).
    await request(app.getHttpServer()).post('/rest/v1/shifts/request').set('Authorization', 'Bearer ' + vmToken).send(body).expect(404);
    await assign().expect(201);
    await request(app.getHttpServer()).post('/rest/v1/shifts/request').set('Authorization', 'Bearer ' + vmToken).send(body).expect(201);
  });

  it('owner decision: a Venue Manager has no Staff Notes or Email access, even for their own assigned staff and even by direct API call', async () => {
    const seed = await seedOrg();
    const managerToken = await login(seed.manager.email);
    const vmToken = await login(seed.venueManager.email);
    await request(app.getHttpServer()).post('/rest/v1/managers/' + seed.venueManagerProfileId + '/venues')
      .set('Authorization', 'Bearer ' + managerToken).send({ venueId: seed.venue1.id }).expect(204);
    const staff = await createStaff(managerToken, 'Assigned');
    await activateStaff(seed.organisation, seed.manager.userId, staff);
    await request(app.getHttpServer()).post('/rest/v1/venue-managers/' + seed.venueManagerProfileId + '/staff')
      .set('Authorization', 'Bearer ' + managerToken).send({ staffProfileIds: [staff] }).expect(201);
    const vm = (method: 'get' | 'post', path: string, body?: Record<string, unknown>) => {
      const r = request(app.getHttpServer())[method]('/rest/v1' + path).set('Authorization', 'Bearer ' + vmToken);
      return body ? r.send(body) : r;
    };
    for (const [method, path, body] of [
      ['get', '/staff/' + staff + '/notes'], ['post', '/staff/' + staff + '/notes', { body: 'note' }],
      ['get', '/staff/' + staff + '/emails'], ['post', '/staff/bulk-email', { userIds: [staff], subject: 's', message: 'm' }],
      ['get', '/staff/' + staff + '/timeline'],
    ] as const) {
      expect([path, [403, 404].includes((await vm(method, path, body as Record<string, unknown> | undefined)).status)]).toEqual([path, true]);
    }
    // The workspace owner keeps them.
    await request(app.getHttpServer()).get('/rest/v1/staff/' + staff + '/notes').set('Authorization', 'Bearer ' + managerToken).expect(200);
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
    const post = (id:string) => request(app.getHttpServer()).post('/rest/v1/venue-managers/' + a.venueManagerProfileId + '/staff').set('Authorization','Bearer ' + am).send({ staffProfileIds: [id] });
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
    async function seedPendingRequest(requiredCount = 2, individualTimes = false, selectedCount = 2) {
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
      await request(app.getHttpServer()).post(`/rest/v1/venue-managers/${seed.venueManagerProfileId}/staff`).set('Authorization', `Bearer ${managerToken}`).send({ staffProfileIds: [staffA] }).expect(201);
      await request(app.getHttpServer()).post(`/rest/v1/venue-managers/${seed.venueManagerProfileId}/staff`).set('Authorization', `Bearer ${managerToken}`).send({ staffProfileIds: [staffB] }).expect(201);

      const staffIds = [staffA, staffB];
      for (let i=2; i<selectedCount; i++) {
        const staff = await createStaff(managerToken, `Additional${i}`);
        await activateStaff(seed.organisation, seed.manager.userId, staff);
        await request(app.getHttpServer()).post(`/rest/v1/venue-managers/${seed.venueManagerProfileId}/staff`).set('Authorization', `Bearer ${managerToken}`).send({ staffProfileIds: [staff] }).expect(201);
        staffIds.push(staff);
      }
      const startsAt = new Date(Date.now() + 72 * 3600 * 1000);
      if (individualTimes) startsAt.setUTCHours(21, 0, 0, 0);
      const endsAt = new Date(startsAt.getTime() + (individualTimes ? 8 : 5) * 3600 * 1000);
      const submitRes = await request(app.getHttpServer())
        .post('/rest/v1/shifts/request')
        .set('Authorization', `Bearer ${vmToken}`)
        .send({
          venueId: seed.venue1.id,
          jobRoleId: jobRole.id,
          startsAt: startsAt.toISOString(),
          endsAt: endsAt.toISOString(),
          staffRequired: requiredCount,
          staffProfileIds: staffIds,
          ...(individualTimes ? {staffAssignments: [{staffProfileId: staffA, startsAt: new Date(startsAt.getTime()+3*3600*1000).toISOString(), endsAt: new Date(endsAt.getTime()+4*3600*1000).toISOString(), breakMinutes: 60}]} : {}),
        });
      expect(submitRes.status).toBe(201);
      return { ...seed, managerToken, vmToken, shiftId: submitRes.body.id as string, staffA, staffB, staffIds };
    }

    it('preserves an extended overnight window and individual break through approval, pay and reports', async () => {
      const seed = await seedPendingRequest(2, true);
      const auth = { Authorization: `Bearer ${seed.managerToken}` };
      const url = `/rest/v1/shifts/${seed.shiftId}/requested-staff`;
      const before = (await request(app.getHttpServer()).get(url).set(auth).expect(200)).body;
      const row = before.find((r: any) => r.staffProfileId === seed.staffA);
      expect(new Date(row.startsAt).getUTCHours()).toBe(0);
      expect(new Date(row.endsAt).getUTCHours()).toBe(9);
      expect(row.breakMinutes).toBe(60);
      const result = (await request(app.getHttpServer()).post(`/rest/v1/shifts/${seed.shiftId}/approve`).set(auth).send({}).expect(201)).body;
      expect(result.results.every((r: any) => r.ok)).toBe(true);
      const [{ id: workspaceId }] = await adminDataSource.manager.query('SELECT id FROM core.manager_workspace WHERE owner_user_id=$1', [seed.manager.userId]);
      const ctx = { organisationId: seed.organisation.id, workspaceId, userId: seed.manager.userId, role: 'manager' };
      const rows = await tenantContext.runInTenantContext(ctx, m => m.query('SELECT lower(period) AS start, upper(period) AS finish, break_minutes FROM core.shift_assignment WHERE shift_id=$1 AND staff_profile_id=$2', [seed.shiftId, seed.staffA]));
      expect(rows[0].break_minutes).toBe(60);
      expect(rows[0].start.toISOString()).toBe(new Date(row.startsAt).toISOString());
      expect(rows[0].finish.toISOString()).toBe(new Date(row.endsAt).toISOString());
      const [user] = await tenantContext.runInTenantContext(ctx,m=>m.query('SELECT user_id FROM core.staff_profile WHERE id=$1',[seed.staffA]));
      const mine = await app.get(OfferService).listMine({...ctx,userId:user.user_id,role:'staff'},{});
      const offer = mine.find(o=>o.shiftId===seed.shiftId)!;
      expect(offer.startsAt.toISOString()).toBe(new Date(row.startsAt).toISOString());
      expect(offer.endsAt.toISOString()).toBe(new Date(row.endsAt).toISOString());
      await tenantContext.runInTenantContext(ctx, async m => {
        const [shift] = await m.query('SELECT pay_rate_pence,break_minutes,ends_at,default_ends_at FROM core.shift WHERE id=$1',[seed.shiftId]);
        expect(offer.estimatedPayPence).toBe(payForMinutes(Number(shift.pay_rate_pence),540-60));
        await m.query("UPDATE core.shift_assignment SET status='confirmed' WHERE shift_id=$1 AND staff_profile_id=$2",[seed.shiftId,seed.staffA]);
        expect(new Date(shift.default_ends_at).getUTCHours()).toBe(5);
        expect(new Date(shift.ends_at).getUTCHours()).toBe(9);
        const midnight = new Date(row.startsAt).getTime();
        const available = app.get(AvailabilityService);
        expect((await available.findBusyStaffIds(m,[seed.staffA],new Date(midnight-3*3600_000),new Date(midnight-3600_000))).size).toBe(0);
        expect((await available.findBusyStaffIds(m,[seed.staffA],new Date(midnight+7*3600_000),new Date(midnight+8*3600_000))).has(seed.staffA)).toBe(true);
        expect((await available.findBusyStaffIds(m,[seed.staffA],new Date(midnight+30*60_000),new Date(midnight+3*3600_000))).has(seed.staffA)).toBe(true);
      });
      const report = await app.get(ShiftReportService).getReport(ctx,seed.shiftId);
      const scheduled = report.staff.find(r=>r.staffProfileId===seed.staffA)!;
      expect(scheduled.scheduledBreakMinutes).toBe(60);
      expect(new Date(scheduled.scheduledStart).toISOString()).toBe(new Date(row.startsAt).toISOString());
      expect(new Date(scheduled.scheduledEnd).toISOString()).toBe(new Date(row.endsAt).toISOString());

    });

    async function pipelineSeed(count = 2) {
      const seed = await seedPendingRequest(count, false, count);
      const [{ id: workspaceId }] = await adminDataSource.manager.query('SELECT id FROM core.manager_workspace WHERE owner_user_id=$1',[seed.manager.userId]);
      const ctx = { organisationId:seed.organisation.id,workspaceId,userId:seed.manager.userId,role:'manager' };
      const url = `/rest/v1/shifts/${seed.shiftId}/pipeline`;
      return { ...seed,ctx,url };
    }
    async function approvePipeline(seed: Awaited<ReturnType<typeof pipelineSeed>>) {
      return (await request(app.getHttpServer()).post(`/rest/v1/shifts/${seed.shiftId}/approve`).set('Authorization',`Bearer ${seed.managerToken}`).send({}).expect(201)).body.results;
    }
    /** Every staff member is in exactly one lane and every staff counter equals its lane's card count. */
    function expectReconciled(board: any) {
      const lanes: Record<string, string> = {offered:'offered',waiting:'waiting',staff_accepted:'accepted',confirmed:'confirmed',late:'late',checked_in:'checkedIn',
        clocked_in:'clockedIn',pending_review:'pendingReview',clocked_out:'clockedOut',attendance_missing:'attendanceMissing',no_show:'noShow',rejected:'rejected',cancelled:'cancelled',deleted:'deleted'};
      expect(board.stages).toEqual(Object.keys(lanes));
      expect(new Set(board.staff.map((r:any)=>r.staffProfileId)).size).toBe(board.staff.length);
      for (const [stage,key] of Object.entries(lanes)) {
        const cards=board.staff.filter((r:any)=>r.stage===stage).length;
        expect({stage,count:board.summary[key]}).toEqual({stage,count:cards});
        expect(board.stageCounts[stage]).toBe(cards);
      }
      expect(Object.values(lanes).reduce((sum,key)=>sum+board.summary[key],0)).toBe(board.staff.length);
    }
    async function readPipeline(seed: Awaited<ReturnType<typeof pipelineSeed>>) {
      return (await request(app.getHttpServer()).get(seed.url).set('Authorization',`Bearer ${seed.managerToken}`).expect(200)).body;
    }
    async function acceptPipeline(seed: Awaited<ReturnType<typeof pipelineSeed>>, offerId: string, staffId: string) {
      const [user] = await tenantContext.runInTenantContext(seed.ctx,m=>m.query('SELECT user_id FROM core.staff_profile WHERE id=$1',[staffId]));
      await app.get(OfferService).staffAccept({...seed.ctx,userId:user.user_id,role:'staff'},offerId);
    }
    it('Sent Shifts: one request counts once however many staff it went to; All excludes expired, Expired holds them, totals and tabs agree', async () => {
      const seed = await pipelineSeed(5);
      await approvePipeline(seed);
      const auth = { Authorization: `Bearer ${seed.vmToken}` };
      const get = (q = '') => request(app.getHttpServer()).get(`/rest/v1/shifts/sent${q}`).set(auth).expect(200);
      let all = (await get()).body;
      expect(all).toMatchObject({ total: 1, view: 'all' });
      expect(all.counts).toMatchObject({ all: 1, pending: 1, expired: 0, submitted: 1 }); // 5 recipient offers, ONE request
      expect(all.data[0].offerCounts.sent).toBe(5);
      expect((await request(app.getHttpServer()).get('/rest/v1/shifts/sent?view=nope').set(auth)).status).toBe(400);

      // Past the action window: genuinely expired — leaves All, appears under Expired, still one submitted request.
      await adminDataSource.query(`UPDATE core.shift SET starts_at = now() - interval '14 hours', ends_at = now() - interval '6 hours' WHERE id = $1`, [seed.shiftId]);
      all = (await get()).body;
      expect(all.total).toBe(0);
      expect(all.data).toHaveLength(0);
      const expired = (await get('?view=expired')).body;
      expect(expired.total).toBe(1);
      expect(expired.data[0]).toMatchObject({ id: seed.shiftId, statusLabel: 'Expired', actionExpired: true });
      expect(expired.counts).toMatchObject({ all: 0, pending: 0, expired: 1, submitted: 1 });
      // Readable directly, still never actionable: no new offers for it.
      expect((await request(app.getHttpServer()).get(`/rest/v1/shifts/sent/${seed.shiftId}`).set(auth)).status).toBe(200);
    });

    it('Sent Shifts keeps one request for five staff through approval, responses and full confirmation', async()=>{
      const seed = await pipelineSeed(5);
      const auth = {Authorization:`Bearer ${seed.vmToken}`};
      const read = async () => {
        const result = await request(app.getHttpServer()).get('/rest/v1/shifts/sent').set(auth).expect(200);
        expect(result.body.total).toBe(1); expect(result.body.data).toHaveLength(1);
        expect(result.body.data[0].id).toBe(seed.shiftId);
        return result.body.data[0];
      };
      const pending = await read();
      expect(pending.statusLabel).toBe('Waiting for manager approval');
      expect(pending.offerCounts.sent).toBe(0);
      expect(pending.counters).toEqual({sent:false,accepted:false,confirmed:false});
      expect(pending.filters).toContain('pending');
      const offers = await approvePipeline(seed);
      expect(offers).toHaveLength(5); expect(offers.every((o:any)=>o.ok)).toBe(true);
      const offered = await read();
      const legacy = await request(app.getHttpServer()).get('/rest/v1/offers').set(auth).expect(200);
      expect(legacy.body.data.filter((o:any)=>o.shiftId===seed.shiftId)).toHaveLength(5);
      const home = await request(app.getHttpServer()).get('/rest/v1/shifts').set(auth).expect(200);
      expect(home.body.data.filter((s:any)=>s.id===seed.shiftId)).toHaveLength(1);
      expect(offered.statusLabel).toBe('Offers sent');
      expect(offered.offerCounts).toMatchObject({sent:5,pending:5,confirmed:0});
      expect(offered.counters).toEqual({sent:true,accepted:false,confirmed:false});
      const board = await readPipeline(seed);
      expect(board.staff).toHaveLength(5);
      expect(board.staff.map((o:any)=>o.offerId).sort()).toEqual(offers.map((o:any)=>o.offerId).sort());
      for(let i=0;i<offers.length;i++) {
        const [staff] = await tenantContext.runInTenantContext(seed.ctx,m=>m.query('SELECT user_id FROM core.staff_profile WHERE id=$1',[offers[i].staffProfileId]));
        const mine = await app.get(OfferService).listMine({...seed.ctx,userId:staff.user_id,role:'staff'},{});
        const own = mine.filter(o=>o.shiftId===seed.shiftId);
        expect(own).toHaveLength(1); expect(own[0].id).toBe(offers[i].offerId);
        await acceptPipeline(seed,offers[i].offerId,offers[i].staffProfileId);
        const row = await read();
        expect(row.offerCounts.confirmed).toBe(i+1);
        expect(row.counters.accepted).toBe(true);
        expect(row.counters.confirmed).toBe(i===4);
        const board = await readPipeline(seed);
        expect(board.summary.filled).toBe(i+1);
        expect(board.summary.confirmed).toBe(i+1); // the CONFIRMED lane: booked, shift not started
        expectReconciled(board);
      }
      const confirmed = await read();
      expect(confirmed.statusLabel).toBe('Confirmed');
      expect(confirmed.filters).toContain('manager_confirmed');
      expect(confirmed.filters).not.toContain('pending');
      await request(app.getHttpServer()).post(`${seed.url}/offers/${offers[0].offerId}/cancel`).set('Authorization',`Bearer ${seed.managerToken}`).send({}).expect(201);
      const cancelled = await read();
      expect(cancelled.offerCounts.confirmed).toBe(4);
      expect(cancelled.counters.confirmed).toBe(false);
      expect(cancelled.filters).toContain('cancelled');
      expect(cancelled.offerCounts.cancelled).toBe(1);
      const flags = await adminDataSource.query("SELECT relrowsecurity,relforcerowsecurity FROM pg_class JOIN pg_namespace n ON n.oid=relnamespace WHERE n.nspname='core' AND relname IN ('shift','shift_assignment','job_offer')");
      expect(flags).toHaveLength(3); expect(flags.every((r:any)=>r.relrowsecurity&&r.relforcerowsecurity)).toBe(true);
    }, 60_000); // Five staff through approval, responses and full confirmation: measured over the 5 s default on the shared validation DB.
    it('Sent Shifts retains declined responses and denies foreign IDs, even another manager of the same venue', async()=>{
      const seed=await pipelineSeed(); const offers=await approvePipeline(seed);
      const [user] = await tenantContext.runInTenantContext(seed.ctx,m=>m.query('SELECT user_id FROM core.staff_profile WHERE id=$1',[seed.staffA]));
      const offer = offers.find((o:any)=>o.staffProfileId===seed.staffA);
      await app.get(OfferService).decline({...seed.ctx,userId:user.user_id,role:'staff'},offer.offerId,{reason:'Unavailable'});
      const url=`/rest/v1/shifts/sent/${seed.shiftId}`;
      const row=(await request(app.getHttpServer()).get(url).set('Authorization',`Bearer ${seed.vmToken}`).expect(200)).body;
      expect(row.offerCounts.declined).toBe(1); expect(row.filters).toContain('declined');
      for(const foreign of [await seedOrg(),await seedOrg(seed.organisation)]) {
        const token=await login(foreign.venueManager.email);
        const list=await request(app.getHttpServer()).get('/rest/v1/shifts/sent').set('Authorization',`Bearer ${token}`).expect(200);
        expect(list.body.data).toEqual([]);
        await request(app.getHttpServer()).get(url).set('Authorization',`Bearer ${token}`).expect(404);
      }
      const other=await seedOrg(seed.organisation);
      // A bound profile cannot be moved by an ordinary user (binding guard), so this fixture returns the other Venue Manager to an UNBOUND
      // profile (NULL), as a manager.manage holder would. The real first venue assignment below then binds it to the venue's workspace.
      // manager_profile is FORCE RLS: bind the organisation and the manage holder's identity, and assert the row was written.
      await adminDataSource.transaction(async (m)=>{
        await m.query("SELECT set_config('rab.organisation_id',$1,true), set_config('rab.user_id',$2,true)",[seed.organisation.id, seed.manager.userId]);
        const updated=await m.query('UPDATE core.manager_profile SET workspace_id=NULL WHERE id=$1 RETURNING id',[other.venueManagerProfileId]);
        expect((updated[0] as unknown[]).length).toBe(1);
        // An unbound Venue Manager has no active membership yet (one active per user). Suspend the seeded one through the real lifecycle
        // function that WorkspaceMembershipService.suspendForUser calls; the first assignment then writes the new membership.
        await m.query("SELECT set_config('rab.user_id',$1,true)",[other.venueManager.userId]);
        await m.query('SELECT core.suspend_workspace_membership($1)',[other.venueManager.userId]);
      });
      await request(app.getHttpServer()).post(`/rest/v1/managers/${other.venueManagerProfileId}/venues`).set('Authorization',`Bearer ${seed.managerToken}`).send({venueId:seed.venue1.id}).expect(204);
      const token=await login(other.venueManager.email);
      const list=await request(app.getHttpServer()).get('/rest/v1/shifts/sent').set('Authorization',`Bearer ${token}`).expect(200);
      expect(list.body.data).toEqual([]);
      await request(app.getHttpServer()).get(url).set('Authorization',`Bearer ${token}`).expect(404);
      await request(app.getHttpServer()).get('/rest/v1/shifts/sent').set('Authorization',`Bearer ${seed.managerToken}`).expect(403);
    });
    it('pipeline rejects unapproved/foreign/app scope and reconstructs OFFERED then notification-backed WAITING', async()=>{
      const seed=await pipelineSeed();
      await request(app.getHttpServer()).get(seed.url).set('Authorization',`Bearer ${seed.managerToken}`).expect(404);
      const offers=await approvePipeline(seed);
      const first=await readPipeline(seed);expect(first.staff).toHaveLength(2);expect(first.staff.every((r:any)=>r.stage==='offered')).toBe(true);
      expect(first.report.ready).toBe(false);
      await request(app.getHttpServer()).get(seed.url).set('Authorization',`Bearer ${seed.vmToken}`).expect(403);
      const other=await seedOrg();const otherToken=await login(other.manager.email);
      await request(app.getHttpServer()).get(seed.url).set('Authorization',`Bearer ${otherToken}`).expect(404);
      await tenantContext.runInTenantContext(seed.ctx,m=>m.query('UPDATE core.notification SET read_at=now() WHERE related_entity_id=$1 AND type=\'offer_sent\'',[offers[0].offerId]));
      const read=await readPipeline(seed);expect(read.staff.find((r:any)=>r.offerId===offers[0].offerId).stage).toBe('waiting');
      const reloaded=await readPipeline(seed);expect(reloaded.staff.map((r:any)=>r.stage)).toEqual(read.staff.map((r:any)=>r.stage));
    });
    it('pipeline preserves same-workspace private ownership for read, cancel, replace and table rows',async()=>{
      const seed=await pipelineSeed();const offers=await approvePipeline(seed);
      const otherManager=await seedManagerInWorkspace(seed.organisation,seed.ctx.workspaceId!);
      const token=await login(otherManager.email);const auth={Authorization:`Bearer ${token}`};
      await request(app.getHttpServer()).get(seed.url).set(auth).expect(404);
      await request(app.getHttpServer()).post(`${seed.url}/offers/${offers[0].offerId}/cancel`).set(auth).send({reason:'not permitted'}).expect(404);
      await request(app.getHttpServer()).post(`${seed.url}/replacements`).set(auth).send({staffProfileIds:[seed.staffA]}).expect(404);
      const list=await request(app.getHttpServer()).get('/rest/v1/shifts/requests').set(auth).expect(200);expect(list.body.data.some((r:any)=>r.id===seed.shiftId)).toBe(false);
    });
    it('pipeline follows real staff acceptance, decline, late and attendance facts, including verified geofence clock-out',async()=>{
      const seed=await pipelineSeed();const offers=await approvePipeline(seed);const a=offers.find((o:any)=>o.staffProfileId===seed.staffA),b=offers.find((o:any)=>o.staffProfileId===seed.staffB);
      await acceptPipeline(seed,a.offerId,seed.staffA);
      const [staffB]=await tenantContext.runInTenantContext(seed.ctx,m=>m.query('SELECT user_id FROM core.staff_profile WHERE id=$1',[seed.staffB]));
      await app.get(OfferService).decline({...seed.ctx,userId:staffB.user_id,role:'staff'},b.offerId,{reason:'Unavailable'});
      // A Venue-Manager-request offer is confirmed on acceptance (OfferService.staffAccept): shown as Confirmed, not "accepted".
      let board=await readPipeline(seed);expect(board.staff.find((r:any)=>r.offerId===a.offerId)).toMatchObject({stage:'confirmed',assignmentStatus:'confirmed'});expect(board.staff.find((r:any)=>r.offerId===b.offerId)).toMatchObject({stage:'rejected',terminalSource:'Declined by staff',declineReason:'Unavailable'});expect(board.tableStatus).toBe('1 staff rejected');expectReconciled(board);
      await tenantContext.runInTenantContext(seed.ctx,m=>m.query("UPDATE core.shift SET starts_at=now()-interval '20 minutes',ends_at=now()+interval '2 hours' WHERE id=$1",[seed.shiftId]));
      await tenantContext.runInTenantContext(seed.ctx,m=>m.query("UPDATE core.shift_assignment SET period=tstzrange(now()-interval '20 minutes',now()+interval '2 hours','[)') WHERE shift_id=$1",[seed.shiftId]));
      board=await readPipeline(seed);expect(board.staff.find((r:any)=>r.offerId===a.offerId).stage).toBe('late');
      await tenantContext.runInTenantContext(seed.ctx,async m=>{
        const [sa]=await m.query('SELECT id FROM core.shift_assignment WHERE shift_id=$1 AND staff_profile_id=$2',[seed.shiftId,seed.staffA]);
        await m.query(`INSERT INTO core.attendance (organisation_id,workspace_id,shift_id,shift_assignment_id,staff_profile_id,status,clock_in_at) VALUES ($1,$2,$3,$4,$5,'clocked_in',now()-interval '10 minutes')`,[seed.ctx.organisationId,seed.ctx.workspaceId,seed.shiftId,sa.id,seed.staffA]);
      });
      board=await readPipeline(seed);expect(board.staff.find((r:any)=>r.offerId===a.offerId).stage).toBe('clocked_in');expect(board.report.ready).toBe(false);
      expect(board.summary).toMatchObject({clockedIn:1,pendingReview:0});expectReconciled(board);
      // Forgotten clock-out flagged by the monitor: one lane only (Pending Review), never also counted as Clocked In.
      await tenantContext.runInTenantContext(seed.ctx,m=>m.query("UPDATE core.attendance SET status='missing_clock_out' WHERE shift_id=$1",[seed.shiftId]));
      board=await readPipeline(seed);expect(board.staff.find((r:any)=>r.offerId===a.offerId).stage).toBe('pending_review');
      expect(board.summary).toMatchObject({clockedIn:0,pendingReview:1});expectReconciled(board);
      await tenantContext.runInTenantContext(seed.ctx,m=>m.query("UPDATE core.attendance SET status='clocked_out',clock_out_at=now(),clock_out_method='auto_geofence',break_minutes=0,worked_minutes=10,earned_pence=200 WHERE shift_id=$1",[seed.shiftId]));
      board=await readPipeline(seed);expect(board.staff.find((r:any)=>r.offerId===a.offerId)).toMatchObject({stage:'clocked_out',clockOutMethod:'auto_geofence',workedMinutes:10,attendanceReviewed:false});expect(board.report.ready).toBe(true);
      expect(board.summary).toMatchObject({clockedIn:0,pendingReview:0,clockedOut:1});expectReconciled(board);
      await request(app.getHttpServer()).post('/rest/v1/files/previews').set('Authorization',`Bearer ${seed.managerToken}`).send({fileIds:[randomUUID()]}).expect(201).expect(({body})=>expect(body.previews).toEqual({}));
    });

    it('pipeline five duplicate cancellations create exactly one withdrawal, optional normal staff note and audit',async()=>{
      const seed=await pipelineSeed();const offers=await approvePipeline(seed);const id=offers[0].offerId;
      const replies=await Promise.all(Array.from({length:5},()=>request(app.getHttpServer()).post(`${seed.url}/offers/${id}/cancel`).set('Authorization',`Bearer ${seed.managerToken}`).send({reason:'Venue requested replacement'})));
      expect(replies.filter(r=>r.status===201)).toHaveLength(1);expect(replies.filter(r=>r.status===409)).toHaveLength(4);
      const board=await readPipeline(seed);const card=board.staff.find((r:any)=>r.offerId===id);expect(card.stage).toBe('deleted');expect(card.terminalSource).toBe('Cancelled by Internal Manager');expect(card.withdrawnReason).toBe('Venue requested replacement');
      await tenantContext.runInTenantContext(seed.ctx,async m=>{
        const audit=await m.query("SELECT id FROM core.audit_log WHERE entity_id=$1 AND action='offer.withdrawn'",[id]);expect(audit).toHaveLength(1);
        const notes=await m.query("SELECT body FROM core.user_note WHERE organisation_id=$1 AND body LIKE '%Venue requested replacement%'",[seed.organisation.id]);expect(notes).toHaveLength(1);
      });
      await request(app.getHttpServer()).post(`${seed.url}/offers/${offers[1].offerId}/cancel`).set('Authorization',`Bearer ${seed.managerToken}`).send({}).expect(201);
      await tenantContext.runInTenantContext(seed.ctx,async m=>expect(await m.query('SELECT id FROM core.user_note WHERE organisation_id=$1',[seed.organisation.id])).toHaveLength(1));
    });
    it('pipeline cancellation releases confirmed seat and replacement uses canonical send; active mobile projection is cancelled',async()=>{
      const seed=await pipelineSeed();const offers=await approvePipeline(seed);const offer=offers.find((o:any)=>o.staffProfileId===seed.staffA);
      await acceptPipeline(seed,offer.offerId,seed.staffA);expect((await readPipeline(seed)).summary.filled).toBe(1);
      await request(app.getHttpServer()).post(`${seed.url}/offers/${offer.offerId}/cancel`).set('Authorization',`Bearer ${seed.managerToken}`).send({}).expect(201);
      const board=await readPipeline(seed);expect(board.summary.filled).toBe(0);expect(board.replacementPlaces).toBe(1);
      expect(board.staff.find((r:any)=>r.offerId===offer.offerId).stage).toBe('cancelled');expect(board.summary.cancelled).toBe(1);expectReconciled(board);
      const [user]=await tenantContext.runInTenantContext(seed.ctx,m=>m.query('SELECT user_id FROM core.staff_profile WHERE id=$1',[seed.staffA]));
      const mine=await app.get(OfferService).listMine({...seed.ctx,userId:user.user_id,role:'staff'},{});expect(mine.find(o=>o.id===offer.offerId)?.presentation.state).toBe('cancelled');
      const replacement=await createStaff(seed.managerToken,'Replacement');await activateStaff(seed.organisation,seed.manager.userId,replacement);
      const picker=await request(app.getHttpServer()).get(`/rest/v1/shifts/${seed.shiftId}/selectable-staff`).set('Authorization',`Bearer ${seed.managerToken}`).expect(200);expect(picker.body.data.map((r:any)=>r.id)).toEqual([replacement]);
      await request(app.getHttpServer()).post(`${seed.url}/replacements`).set('Authorization',`Bearer ${seed.managerToken}`).send({staffProfileIds:[replacement]}).expect(201);
      await request(app.getHttpServer()).post(`${seed.url}/replacements`).set('Authorization',`Bearer ${seed.managerToken}`).send({staffProfileIds:[replacement]}).expect(409);
      const after=await readPipeline(seed);expect(after.staff).toHaveLength(3);expect(after.replacementPlaces).toBe(0);
    });
    it('pipeline cancellation racing staff acceptance leaves one terminal booking and one cancellation audit',async()=>{
      const seed=await pipelineSeed();const offers=await approvePipeline(seed);const offer=offers.find((o:any)=>o.staffProfileId===seed.staffA);
      const outcomes=await Promise.allSettled([
        acceptPipeline(seed,offer.offerId,seed.staffA),
        request(app.getHttpServer()).post(`${seed.url}/offers/${offer.offerId}/cancel`).set('Authorization',`Bearer ${seed.managerToken}`).send({}).expect(201),
      ]);
      expect(outcomes[1].status).toBe('fulfilled');
      // Cancel first: the pending offer is withdrawn (Deleted Offer). Accept first: the confirmed booking is cancelled.
      const board=await readPipeline(seed);expect(['deleted','cancelled']).toContain(board.staff.find((r:any)=>r.offerId===offer.offerId).stage);expect(board.summary.filled).toBe(0);expectReconciled(board);
      const audits=await tenantContext.runInTenantContext(seed.ctx,m=>m.query("SELECT id FROM core.audit_log WHERE entity_id=$1 AND action='offer.withdrawn'",[offer.offerId]));expect(audits).toHaveLength(1);
    });
    it('pipeline server cancellation cutoff blocks at T-15m and closed shifts; client scope fields are rejected',async()=>{
      const seed=await pipelineSeed();const offers=await approvePipeline(seed);
      await request(app.getHttpServer()).post(`${seed.url}/offers/${offers[0].offerId}/cancel`).set('Authorization',`Bearer ${seed.managerToken}`).send({workspaceId:randomUUID()}).expect(400);
      await tenantContext.runInTenantContext(seed.ctx,m=>m.query("UPDATE core.shift SET starts_at=clock_timestamp()+interval '15 minutes', ends_at=clock_timestamp()+interval '4 hours' WHERE id=$1",[seed.shiftId]));
      await request(app.getHttpServer()).post(`${seed.url}/offers/${offers[0].offerId}/cancel`).set('Authorization',`Bearer ${seed.managerToken}`).send({}).expect(409);
      expect((await readPipeline(seed)).staff.every((r:any)=>!r.canManagerCancel)).toBe(true);
      await tenantContext.runInTenantContext(seed.ctx,m=>m.query("UPDATE core.shift SET starts_at=clock_timestamp()+interval '1 day', ends_at=clock_timestamp()+interval '2 days', status='cancelled' WHERE id=$1",[seed.shiftId]));
      await request(app.getHttpServer()).post(`${seed.url}/offers/${offers[0].offerId}/cancel`).set('Authorization',`Bearer ${seed.managerToken}`).send({}).expect(409);
    });

    async function mutateStaff(seed: Awaited<ReturnType<typeof seedPendingRequest>>, staffId: string, account: string, employment = 'active', owner?: string) {
      const [{ id: workspaceId }] = await adminDataSource.manager.query('SELECT id FROM core.manager_workspace WHERE owner_user_id = $1', [seed.manager.userId]);
      await tenantContext.runInTenantContext({ organisationId: seed.organisation.id, workspaceId, userId: seed.manager.userId, role: 'manager' }, async (m) => {
        await m.query('UPDATE core."user" SET status = $1 WHERE id = (SELECT user_id FROM core.staff_profile WHERE id = $2)', [account, staffId]);
        await m.query('UPDATE core.staff_profile SET employment_status = $1, created_by = COALESCE($3::uuid, created_by) WHERE id = $2', [employment, staffId, owner ?? null]);
      });
    }
    it('atomic selection Confirm persists final staff without offers; Approve sends only that persisted list', async () => {
      const seed = await seedPendingRequest(3);
      const replacement = await createStaff(seed.managerToken, 'Selected'); await activateStaff(seed.organisation, seed.manager.userId, replacement);
      await request(app.getHttpServer()).put(`/rest/v1/shifts/${seed.shiftId}/requested-staff`).set('Authorization', `Bearer ${seed.managerToken}`)
        .send({ expectedStaffProfileIds: [seed.staffA, seed.staffB], staffProfileIds: [seed.staffA, replacement] }).expect(200);
      const persisted = await request(app.getHttpServer()).get(`/rest/v1/shifts/${seed.shiftId}/requested-staff`).set('Authorization', `Bearer ${seed.managerToken}`).expect(200);
      expect(persisted.body.map((r: { staffProfileId: string }) => r.staffProfileId).sort()).toEqual([seed.staffA, replacement].sort());
      const before = await request(app.getHttpServer()).get('/rest/v1/offers').set('Authorization', `Bearer ${seed.managerToken}`).expect(200);
      expect(before.body.data).toHaveLength(0);
      const approved = await request(app.getHttpServer()).post(`/rest/v1/shifts/${seed.shiftId}/approve`).set('Authorization', `Bearer ${seed.managerToken}`).send({}).expect(201);
      expect(approved.body.results.map((r: { staffProfileId: string }) => r.staffProfileId).sort()).toEqual([seed.staffA, replacement].sort());
    });
    it('selection rejects duplicates, overcapacity, stale snapshot and client workspace fields without changing rows', async () => {
      const seed = await seedPendingRequest();
      const replacement = await createStaff(seed.managerToken, 'Capacity'); await activateStaff(seed.organisation, seed.manager.userId, replacement);
      const url = `/rest/v1/shifts/${seed.shiftId}/requested-staff`;
      await request(app.getHttpServer()).post(`${url}/${replacement}`).set('Authorization', `Bearer ${seed.managerToken}`).expect(409);
      for (const staffProfileIds of [[seed.staffA, seed.staffA], [seed.staffA, seed.staffB, replacement]]) {
        await request(app.getHttpServer()).put(url).set('Authorization', `Bearer ${seed.managerToken}`).send({ staffProfileIds, expectedStaffProfileIds: [seed.staffA,seed.staffB] }).expect(400);
      }
      await request(app.getHttpServer()).put(url).set('Authorization', `Bearer ${seed.managerToken}`).send({ staffProfileIds: [seed.staffA], expectedStaffProfileIds: [] }).expect(409);
      await request(app.getHttpServer()).put(url).set('Authorization', `Bearer ${seed.managerToken}`).send({ staffProfileIds: [], expectedStaffProfileIds: [seed.staffA,seed.staffB], workspaceId: randomUUID() }).expect(400);
      const saved = await request(app.getHttpServer()).get(url).set('Authorization', `Bearer ${seed.managerToken}`).expect(200); expect(saved.body).toHaveLength(2);
    });
    it('ACTIVE account and employment filter excludes suspended/invited/inactive records on the server', async () => {
      const seed = await seedPendingRequest();
      for (const [account, employment] of [['suspended','active'],['deactivated','active'],['invited','active'],['invite_expired','active'],['active','inactive']]) {
        await mutateStaff(seed, seed.staffB, account!, employment!);
        const list = await request(app.getHttpServer()).get('/rest/v1/staff?status=active&accountStatus=active&limit=25').set('Authorization', `Bearer ${seed.managerToken}`).expect(200);
        expect(list.body.data.map((r: { id: string }) => r.id)).toEqual([seed.staffA]);
        await request(app.getHttpServer()).put(`/rest/v1/shifts/${seed.shiftId}/requested-staff`).set('Authorization', `Bearer ${seed.managerToken}`).send({ staffProfileIds: [seed.staffB], expectedStaffProfileIds: [seed.staffA,seed.staffB] }).expect(400);
      }
    });
    it('manager-private owner filtering applies even within the same workspace', async () => {
      const seed = await seedPendingRequest();
      const other = await seedOrg(seed.organisation);
      await mutateStaff(seed, seed.staffB, 'active', 'active', other.manager.userId);
      const list = await request(app.getHttpServer()).get('/rest/v1/staff?status=active&accountStatus=active').set('Authorization', `Bearer ${seed.managerToken}`).expect(200);
      expect(list.body.data.map((r: { id: string }) => r.id)).toEqual([seed.staffA]);
      await request(app.getHttpServer()).put(`/rest/v1/shifts/${seed.shiftId}/requested-staff`).set('Authorization', `Bearer ${seed.managerToken}`).send({ staffProfileIds: [seed.staffB], expectedStaffProfileIds: [seed.staffA,seed.staffB] }).expect(400);
    });
    it('wrong-workspace staff and cross-org request IDs fail closed; Venue Manager cannot save', async () => {
      const seed = await seedPendingRequest(); const other = await seedOrg(seed.organisation); const otherToken = await login(other.manager.email);
      const foreign = await createStaff(otherToken, 'Private'); await activateStaff(other.organisation, other.manager.userId, foreign);
      const body = { staffProfileIds: [foreign], expectedStaffProfileIds: [seed.staffA,seed.staffB] };
      await request(app.getHttpServer()).put(`/rest/v1/shifts/${seed.shiftId}/requested-staff`).set('Authorization', `Bearer ${seed.managerToken}`).send(body).expect(400);
      const unrelated = await seedOrg(); const unrelatedToken = await login(unrelated.manager.email);
      await request(app.getHttpServer()).put(`/rest/v1/shifts/${seed.shiftId}/requested-staff`).set('Authorization', `Bearer ${unrelatedToken}`).send(body).expect(404);
      await request(app.getHttpServer()).put(`/rest/v1/shifts/${seed.shiftId}/requested-staff`).set('Authorization', `Bearer ${seed.vmToken}`).send(body).expect(403);
    });
    it('approval revalidates employment after selection without sending an offer to inactive staff', async () => {
      const seed = await seedPendingRequest(); await mutateStaff(seed, seed.staffB, 'active', 'inactive');
      const approved = await request(app.getHttpServer()).post(`/rest/v1/shifts/${seed.shiftId}/approve`).set('Authorization', `Bearer ${seed.managerToken}`).send({}).expect(201);
      expect(approved.body.results.find((r: { staffProfileId: string }) => r.staffProfileId === seed.staffB).ok).toBe(false);
      expect(approved.body.results.find((r: { staffProfileId: string }) => r.staffProfileId === seed.staffA).ok).toBe(true);
    });
    it('concurrent selection saves cannot overwrite the same prior snapshot twice', async () => {
      const seed = await seedPendingRequest(); const url = `/rest/v1/shifts/${seed.shiftId}/requested-staff`;
      const results = await Promise.all([seed.staffA,seed.staffB].map((id) => request(app.getHttpServer()).put(url).set('Authorization', `Bearer ${seed.managerToken}`).send({ staffProfileIds: [id], expectedStaffProfileIds: [seed.staffA,seed.staffB] })));
      expect(results.map((r) => r.status).sort()).toEqual([200,409]);
    });

    it('shift selector returns only minimal ACTIVE private rows, including proposed staff; full-name/email/reference search and pagination work', async () => {
      const seed = await seedPendingRequest(3);
      const url = `/rest/v1/shifts/${seed.shiftId}/selectable-staff`;
      const get = (suffix = '') => request(app.getHttpServer()).get(url + suffix).set('Authorization', `Bearer ${seed.managerToken}`);
      const first = await get('?page=1&limit=1').expect(200);
      expect(first.body.total).toBe(2); expect(first.body.data).toHaveLength(1);
      const a = first.body.data[0]; expect(a.id).toBe(seed.staffA); expect(a.available).toBe(true);
      expect(a.accountStatus).toBe('active'); expect(a.employmentStatus).toBe('active');
      expect(Object.keys(a).sort()).toEqual(['id','firstName','lastName','staffRef','email','phone','defaultPayRatePence','employmentStatus','accountStatus','available','createdAt'].sort());
      const second = await get('?page=2&limit=1').expect(200); expect(second.body.data[0].id).toBe(seed.staffB);
      for (const q of ['Alpha Staff', a.email, a.staffRef]) {
        const found = await get(`?q=${encodeURIComponent(q)}`).expect(200); expect(found.body.data.map((r: { id: string }) => r.id)).toEqual([seed.staffA]);
      }
      for (const key of ['workspaceId','organisationId','managerId','ownerUserId','startsAt','status','accountStatus']) await get(`?${key}=${randomUUID()}`).expect(400);
      expect([400, 404]).toContain((await request(app.getHttpServer()).get('/rest/v1/staff/venue-directory/pool').set('Authorization', `Bearer ${seed.managerToken}`)).status);
      for (const [account, employment] of [['invited','active'],['invite_expired','active'],['suspended','active'],['deactivated','active'],['active','inactive'],['active','suspended'],['active','pending_compliance']]) {
        await mutateStaff(seed, seed.staffB, account!, employment!);
        const active = await get().expect(200); expect(active.body.data.map((r: { id: string }) => r.id)).toEqual([seed.staffA]);
      }
    });
    it('shift selector denies wrong-workspace, cross-org, random and actioned requests and excludes another private owner', async () => {
      const seed = await seedPendingRequest(); const other = await seedOrg(seed.organisation); const otherToken = await login(other.manager.email);
      const foreign = await createStaff(otherToken, 'Foreign'); await activateStaff(other.organisation, other.manager.userId, foreign);
      const url = `/rest/v1/shifts/${seed.shiftId}/selectable-staff`;
      await request(app.getHttpServer()).get(url).set('Authorization', `Bearer ${otherToken}`).expect(404);
      const unrelated = await seedOrg(); const unrelatedToken = await login(unrelated.manager.email);
      await request(app.getHttpServer()).get(url).set('Authorization', `Bearer ${unrelatedToken}`).expect(404);
      await request(app.getHttpServer()).get(`/rest/v1/shifts/${randomUUID()}/selectable-staff`).set('Authorization', `Bearer ${seed.managerToken}`).expect(404);
      await request(app.getHttpServer()).get(url).set('Authorization', `Bearer ${seed.vmToken}`).expect(403);
      await mutateStaff(seed, seed.staffB, 'active','active',other.manager.userId);
      const own = await request(app.getHttpServer()).get(url).set('Authorization', `Bearer ${seed.managerToken}`).expect(200);
      expect(own.body.data.map((r: { id: string }) => r.id)).toEqual([seed.staffA]);
      await request(app.getHttpServer()).post(`/rest/v1/shifts/${seed.shiftId}/decline`).set('Authorization', `Bearer ${seed.managerToken}`).send({}).expect(201);
      await request(app.getHttpServer()).get(url).set('Authorization', `Bearer ${seed.managerToken}`).expect(409);
    });
    it('shift selector marks overlapping confirmed staff unavailable using the saved shift window, and drawer exposes staleness', async () => {
      const seed = await seedPendingRequest(); const auth = { Authorization: `Bearer ${seed.managerToken}` };
      const pending = await request(app.getHttpServer()).get(`/rest/v1/shifts/${seed.shiftId}`).set(auth).expect(200);
      const busy = await request(app.getHttpServer()).post('/rest/v1/shifts').set(auth).send({venueId:seed.venue1.id,jobRoleId:pending.body.jobRoleId,startsAt:pending.body.startsAt,endsAt:pending.body.endsAt,requiredCount:1}).expect(201);
      await request(app.getHttpServer()).post(`/rest/v1/shifts/${busy.body.id}/publish`).set(auth).expect(201);
      await sendOffer(seed.managerToken,busy.body.id,seed.staffB);
      await confirmAssignment(seed.organisation,seed.manager.userId,seed.staffB,busy.body.id);
      const pool = await request(app.getHttpServer()).get(`/rest/v1/shifts/${seed.shiftId}/selectable-staff`).set(auth).expect(200);
      expect(pool.body.data.find((r: { id: string }) => r.id === seed.staffA).available).toBe(true);
      expect(pool.body.data.find((r: { id: string }) => r.id === seed.staffB).available).toBe(false);
      const saved = await request(app.getHttpServer()).get(`/rest/v1/shifts/${seed.shiftId}/requested-staff`).set(auth).expect(200);
      expect(saved.body.find((r: { staffProfileId: string }) => r.staffProfileId === seed.staffB).available).toBe(false);
      await request(app.getHttpServer()).put(`/rest/v1/shifts/${seed.shiftId}/requested-staff`).set(auth).send({staffProfileIds:[seed.staffB],expectedStaffProfileIds:[seed.staffA,seed.staffB]}).expect(409);
    });

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
      const { managerToken, venueManagerProfileId, vmToken, staffId } = await seedBusyStaff(busyStart, busyEnd);
      await request(app.getHttpServer()).post(`/rest/v1/venue-managers/${venueManagerProfileId}/staff`).set('Authorization', `Bearer ${managerToken}`).send({ staffProfileIds: [staffId] }).expect(201);

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
      const { managerToken, venueManagerProfileId, vmToken, staffId } = await seedBusyStaff(busyStart, busyEnd);
      await request(app.getHttpServer()).post(`/rest/v1/venue-managers/${venueManagerProfileId}/staff`).set('Authorization', `Bearer ${managerToken}`).send({ staffProfileIds: [staffId] }).expect(201);

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
      const { managerToken, venueManagerProfileId, vmToken, staffId } = await seedBusyStaff(busyStart, busyEnd);
      await request(app.getHttpServer()).post(`/rest/v1/venue-managers/${venueManagerProfileId}/staff`).set('Authorization', `Bearer ${managerToken}`).send({ staffProfileIds: [staffId] }).expect(201);

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
      const { managerToken, venueManagerProfileId, vmToken, staffId, busyShiftId } = await seedBusyStaff(busyStart, busyEnd);
      await request(app.getHttpServer()).post(`/rest/v1/venue-managers/${venueManagerProfileId}/staff`).set('Authorization', `Bearer ${managerToken}`).send({ staffProfileIds: [staffId] }).expect(201);

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
      const { managerToken, venueManagerProfileId, vmToken, staffId, organisation, venue1 } = await seedBusyStaff(busyStart, busyEnd);
      await request(app.getHttpServer()).post(`/rest/v1/venue-managers/${venueManagerProfileId}/staff`).set('Authorization', `Bearer ${managerToken}`).send({ staffProfileIds: [staffId] }).expect(201);
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

  /**
   * Declared weekday availability on the Venue Manager request → Manager approval flow. The Venue Manager is warned at
   * selection (submit); acknowledging only lets the REQUEST through — it dispatches nothing. Approval is the dispatch
   * boundary: it re-evaluates and the approving manager must acknowledge again. The approval requirement is unchanged.
   */
  describe('staff availability warning — Venue Manager request and approval', () => {
    function nextMonday(): { startsAt: Date; endsAt: Date; date: string } {
      const d = new Date(Date.now() + 3 * 24 * 3600 * 1000);
      d.setUTCHours(10, 0, 0, 0);
      while (new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'long' }).format(d) !== 'Monday') d.setUTCDate(d.getUTCDate() + 1);
      return { startsAt: d, endsAt: new Date(d.getTime() + 5 * 3600 * 1000), date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(d) };
    }

    async function setupRequest() {
      const seed = await seedOrg();
      const managerToken = await login(seed.manager.email);
      const vmToken = await login(seed.venueManager.email);
      await request(app.getHttpServer()).post(`/rest/v1/managers/${seed.venueManagerProfileId}/venues`).set('Authorization', `Bearer ${managerToken}`).send({ venueId: seed.venue1.id }).expect(204);
      const jobRole = await seedJobRole(seed.organisation, seed.manager.userId);
      const john = await createStaff(managerToken, 'John');
      await activateStaff(seed.organisation, seed.manager.userId, john);
      await adminDataSource.manager.query(`UPDATE core.staff_profile SET available_days = $2 WHERE id = $1`, [john, ['Tuesday', 'Sunday']]);
      await request(app.getHttpServer()).post(`/rest/v1/venue-managers/${seed.venueManagerProfileId}/staff`).set('Authorization', `Bearer ${managerToken}`).send({ staffProfileIds: [john] }).expect(201);
      const monday = nextMonday();
      const body = { venueId: seed.venue1.id, jobRoleId: jobRole.id, startsAt: monday.startsAt.toISOString(), endsAt: monday.endsAt.toISOString(), staffRequired: 1, staffProfileIds: [john] };
      return { ...seed, managerToken, vmToken, john, monday, body };
    }

    const offersFor = async (shiftId: string): Promise<number> =>
      (await adminDataSource.manager.query(`SELECT count(*)::int AS n FROM core.job_offer o JOIN core.shift_assignment sa ON sa.id = o.shift_assignment_id WHERE sa.shift_id = $1`, [shiftId]))[0].n;

    it('availability chosen at account creation persists and is returned by the staff read API', async () => {
      const seed = await seedOrg();
      const managerToken = await login(seed.manager.email);
      const created = await request(app.getHttpServer()).post('/rest/v1/staff').set('Authorization', `Bearer ${managerToken}`)
        .send({ email: `staff-john-${randomUUID()}@example.test`, firstName: 'John', lastName: 'Staff', availableDays: ['Tuesday', 'Sunday'] });
      expect(created.status).toBe(201);
      const [row] = await adminDataSource.manager.query(`SELECT available_days FROM core.staff_profile WHERE id = $1`, [created.body.id]);
      expect(row.available_days).toEqual(['Tuesday', 'Sunday']);
      const res = await request(app.getHttpServer()).get(`/rest/v1/staff/${created.body.id}`).set('Authorization', `Bearer ${managerToken}`).expect(200);
      expect(res.body.availableDays).toEqual(['Tuesday', 'Sunday']);
    });

    it('the Venue Manager is warned at submission; nothing is created until they acknowledge', async () => {
      const s = await setupRequest();
      const before = await adminDataSource.manager.query(`SELECT count(*)::int AS n FROM core.shift WHERE venue_id = $1`, [s.venue1.id]);
      const blocked = await request(app.getHttpServer()).post('/rest/v1/shifts/request').set('Authorization', `Bearer ${s.vmToken}`).send(s.body);
      expect(blocked.status).toBe(409);
      expect(blocked.body.code).toBe('STAFF_AVAILABILITY_CONFLICT');
      expect(blocked.body.message).toBe('John Staff has marked themselves as unavailable on Monday. Available days: Tuesday and Sunday.');
      const after = await adminDataSource.manager.query(`SELECT count(*)::int AS n FROM core.shift WHERE venue_id = $1`, [s.venue1.id]);
      expect(after[0].n).toBe(before[0].n);
    });

    it('an acknowledged request still needs Manager approval, and approval re-checks and needs its own acknowledgement', async () => {
      const s = await setupRequest();
      const ack = [{ staffProfileId: s.john, dates: [s.monday.date] }];
      const submitted = await request(app.getHttpServer()).post('/rest/v1/shifts/request').set('Authorization', `Bearer ${s.vmToken}`).send({ ...s.body, acknowledgedAvailabilityConflicts: ack });
      expect(submitted.status).toBe(201);
      expect(submitted.body.status).toBe('pending_manager_approval');
      expect(await offersFor(submitted.body.id)).toBe(0);
      const vmAudit = await adminDataSource.manager.query(`SELECT count(*)::int AS n FROM core.audit_log WHERE action = 'shift.request_availability_conflict_acknowledged' AND entity_id = $1`, [submitted.body.id]);
      expect(vmAudit[0].n).toBe(1);

      const approveUrl = `/rest/v1/shifts/${submitted.body.id}/approve`;
      const unacknowledged = await request(app.getHttpServer()).post(approveUrl).set('Authorization', `Bearer ${s.managerToken}`).send({});
      expect(unacknowledged.status).toBe(409);
      expect(unacknowledged.body.code).toBe('STAFF_AVAILABILITY_CONFLICT');
      const [{ status }] = await adminDataSource.manager.query(`SELECT status FROM core.shift WHERE id = $1`, [submitted.body.id]);
      expect(status).toBe('pending_manager_approval');
      expect(await offersFor(submitted.body.id)).toBe(0);

      const approved = await request(app.getHttpServer()).post(approveUrl).set('Authorization', `Bearer ${s.managerToken}`).send({ acknowledgedAvailabilityConflicts: ack });
      expect(approved.status).toBe(201);
      expect(approved.body.results).toEqual([expect.objectContaining({ staffProfileId: s.john, ok: true })]);
      expect(await offersFor(submitted.body.id)).toBe(1);

      // A second approval of the same request never creates a second offer.
      const again = await request(app.getHttpServer()).post(approveUrl).set('Authorization', `Bearer ${s.managerToken}`).send({ acknowledgedAvailabilityConflicts: ack });
      expect(again.status).toBe(404);
      expect(await offersFor(submitted.body.id)).toBe(1);
    });

    it('a Venue Manager cannot use an acknowledgement to dispatch offers directly', async () => {
      const s = await setupRequest();
      const ack = [{ staffProfileId: s.john, dates: [s.monday.date] }];
      const submitted = await request(app.getHttpServer()).post('/rest/v1/shifts/request').set('Authorization', `Bearer ${s.vmToken}`).send({ ...s.body, acknowledgedAvailabilityConflicts: ack });
      expect(submitted.status).toBe(201);
      const direct = await request(app.getHttpServer()).post(`/rest/v1/shifts/${submitted.body.id}/approve`).set('Authorization', `Bearer ${s.vmToken}`).send({ acknowledgedAvailabilityConflicts: ack });
      expect([403, 404]).toContain(direct.status);
      expect(await offersFor(submitted.body.id)).toBe(0);
    });
  });
  describe('five-hour report lifecycle and expired offer actions (owner decision 2026-10-17)', () => {
    const HOUR = 3_600_000;
    /** Moves a shift (and its assignments' own windows) so it ENDED `endedAgoMs` before DB now, 7h long. */
    async function endShiftAgo(shiftId: string, endedAgoMs: number) {
      await adminDataSource.query(
        `UPDATE core.shift SET starts_at = now() - make_interval(secs => $2::double precision / 1000) - interval '7 hours',
           ends_at = now() - make_interval(secs => $2::double precision / 1000) WHERE id = $1`,
        [shiftId, endedAgoMs],
      );
    }
    const list = (token: string, bucket: string) =>
      request(app.getHttpServer()).get(`/rest/v1/attendance/report/shifts?bucket=${bucket}`).set('Authorization', `Bearer ${token}`);
    const row = (res: request.Response, shiftId: string) => (res.body.data as Array<{ shiftId: string }>).find((r) => r.shiftId === shiftId) as any;

    async function seedStaffedShift() {
      const seed = await seedOrg();
      const managerToken = await login(seed.manager.email);
      const vmToken = await login(seed.venueManager.email);
      await request(app.getHttpServer()).post(`/rest/v1/managers/${seed.venueManagerProfileId}/venues`).set('Authorization', `Bearer ${managerToken}`).send({ venueId: seed.venue1.id });
      const shift1 = await createAndPublishShift(managerToken, seed.organisation, seed.venue1);
      const shift2 = await createAndPublishShift(managerToken, seed.organisation, seed.venue2);
      const staff = await createStaff(managerToken, 'Life');
      await activateStaff(seed.organisation, seed.manager.userId, staff);
      await sendOffer(managerToken, shift1, staff);
      await confirmAssignment(seed.organisation, seed.manager.userId, staff, shift1);
      return { ...seed, managerToken, vmToken, shift1, shift2, staff };
    }

    it('Reports vs History are filtered server-side at the exact five-hour boundary, scoped to the Venue Manager venues', async () => {
      const s = await seedStaffedShift();
      expect((await list(s.vmToken, 'nope')).status).toBe(400);
      expect((await request(app.getHttpServer()).get('/rest/v1/attendance/report/shifts').set('Authorization', `Bearer ${s.vmToken}`)).status).toBe(400);

      await endShiftAgo(s.shift1, 5 * HOUR - 60_000);
      await endShiftAgo(s.shift2, 5 * HOUR - 60_000);
      let current = await list(s.vmToken, 'current');
      expect(current.status).toBe(200);
      expect(row(current, s.shift2)).toBeUndefined(); // other venue: never listed
      const inside = row(current, s.shift1);
      expect(inside.lifecycle).toMatchObject({ displayStatus: 'needs_review', actionExpired: false, inCurrent: true, inHistory: false });
      expect(row(await list(s.vmToken, 'history'), s.shift1)).toBeUndefined();

      await endShiftAgo(s.shift1, 5 * HOUR + 60_000);
      current = await list(s.vmToken, 'current');
      const expired = row(current, s.shift1);
      // The stale "In progress" case: past the window it is never shown as live, and the unresolved attendance is flagged.
      expect(expired.lifecycle).toMatchObject({ displayStatus: 'action_expired', displayLabel: 'Action expired', actionExpired: true, needsAttendanceReview: true, needsAttention: true });
      const history = await list(s.vmToken, 'history');
      expect(row(history, s.shift1).lifecycle).toMatchObject({ inHistory: true });
      expect(row(history, s.shift2)).toBeUndefined();

      const detail = await request(app.getHttpServer()).get(`/rest/v1/attendance/report/shift/${s.shift1}`).set('Authorization', `Bearer ${s.vmToken}`);
      expect(detail.status).toBe(200);
      expect(detail.body.lifecycle).toMatchObject({ displayStatus: 'action_expired', needsAttendanceReview: true });
      // Nothing about the canonical records changed.
      const [{ status }] = await adminDataSource.query(`SELECT status FROM core.shift_assignment WHERE shift_id = $1`, [s.shift1]);
      expect(status).toBe('confirmed');
      expect((await request(app.getHttpServer()).get(`/rest/v1/attendance/report/shift/${s.shift2}`).set('Authorization', `Bearer ${s.vmToken}`)).status).toBe(404);
    });

    it('a delivered report moves to History five hours after the outbox SENT time; a failed delivery stays in Reports', async () => {
      const s = await seedStaffedShift();
      await endShiftAgo(s.shift1, 30 * HOUR);
      const [{ workspace_id: workspaceId }] = await adminDataSource.query(`SELECT workspace_id FROM core.shift WHERE id = $1`, [s.shift1]);
      const [{ id: reportId }] = await adminDataSource.query(
        `INSERT INTO core.shift_report (organisation_id, workspace_id, shift_id, status, finalised_at, final_pdf_sent_at)
           VALUES ($1, $2, $3, 'finalised', now() - interval '6 hours', now() - interval '6 hours') RETURNING id`,
        [s.organisation.id, workspaceId, s.shift1],
      );
      const [{ id: fileId }] = await adminDataSource.query(
        `INSERT INTO core.stored_file (organisation_id, workspace_id, kind, mime_type, object_key, original_filename, resource_type, resource_id, size_bytes, storage_driver, status, sha256)
           VALUES ($1, $2, 'FINAL_TIMESHEET_PDF', 'application/pdf', $3, 'final-timesheet.pdf', 'shift_report', $4, 10, 'LOCAL', 'AVAILABLE', repeat('a', 64)) RETURNING id`,
        [s.organisation.id, workspaceId, `test/${randomUUID()}.pdf`, reportId],
      );
      await adminDataSource.query(`UPDATE core.shift_report SET final_file_id = $2 WHERE id = $1`, [reportId, fileId]);
      const [{ id: outboxId }] = await adminDataSource.query(
        `INSERT INTO core.email_outbox (organisation_id, workspace_id, job_type, recipient_email, rendered_subject, attachment_file_id, status, sent_at)
           VALUES ($1, $2, 'NOTIFICATION', 'vm@example.test', 'Final Timesheet', $3, 'SENT', now() - interval '4 hours 59 minutes') RETURNING id`,
        [s.organisation.id, workspaceId, fileId],
      );

      let sent = row(await list(s.vmToken, 'current'), s.shift1);
      expect(sent.lifecycle).toMatchObject({ displayStatus: 'sent', deliveryState: 'sent', inCurrent: true, inHistory: false });
      expect(row(await list(s.vmToken, 'history'), s.shift1)).toBeUndefined();

      await adminDataSource.query(`UPDATE core.email_outbox SET sent_at = now() - interval '5 hours 1 minute' WHERE id = $1`, [outboxId]);
      expect(row(await list(s.vmToken, 'current'), s.shift1)).toBeUndefined();
      sent = row(await list(s.vmToken, 'history'), s.shift1);
      expect(sent.lifecycle).toMatchObject({ displayStatus: 'sent', inHistory: true });
      // The report and its file are still there and still downloadable by the Venue Manager.
      const download = await request(app.getHttpServer()).get(`/rest/v1/attendance/report/shift/${s.shift1}`).set('Authorization', `Bearer ${s.vmToken}`);
      expect(download.body.finalFile).toEqual({ fileId, filename: 'final-timesheet.pdf' });

      await adminDataSource.query(`UPDATE core.email_outbox SET status = 'FAILED', sent_at = NULL, failed_at = now() WHERE id = $1`, [outboxId]);
      const failed = row(await list(s.vmToken, 'current'), s.shift1);
      expect(failed.lifecycle).toMatchObject({ displayStatus: 'delivery_failed', needsAttention: true, inCurrent: true });
    });

    it('expired offer actions are refused by the API: no new offers, no accept, no confirm; inside the window accept works', async () => {
      const s = await seedStaffedShift();
      const late = await createStaff(s.managerToken, 'Late');
      await activateStaff(s.organisation, s.manager.userId, late);
      const offerId = await sendOffer(s.managerToken, s.shift2, late);
      const [{ user_id: lateUserId, workspace_id: workspaceId }] = await adminDataSource.query(
        `SELECT sp.user_id, s.workspace_id FROM core.staff_profile sp, core.shift s WHERE sp.id = $1 AND s.id = $2`, [late, s.shift2]);
      const staffCtx = { organisationId: s.organisation.id, workspaceId, userId: lateUserId, role: 'staff' };
      const offers = app.get(OfferService);

      await endShiftAgo(s.shift2, 5 * HOUR + 60_000);
      await expect(offers.staffAccept(staffCtx, offerId)).rejects.toThrow('can no longer be accepted');
      const [{ status: offerStatus }] = await adminDataSource.query(`SELECT status FROM core.job_offer WHERE id = $1`, [offerId]);
      expect(offerStatus).toBe('pending');

      const another = await createStaff(s.managerToken, 'Another');
      await activateStaff(s.organisation, s.manager.userId, another);
      const send = await request(app.getHttpServer()).post(`/rest/v1/shifts/${s.shift2}/offers`).set('Authorization', `Bearer ${s.managerToken}`).send({ staffProfileId: another });
      expect({ status: send.status, body: send.body }).toMatchObject({ status: 409 });
      expect(send.body.message).toContain('no new offers');

      // Confirm: put the offer into staff_accepted directly (the accept itself is what was just refused) and try to confirm.
      await adminDataSource.query(`UPDATE core.job_offer SET status = 'staff_accepted', staff_accepted_at = now() WHERE id = $1`, [offerId]);
      await adminDataSource.query(`UPDATE core.shift_assignment SET status = 'staff_accepted' WHERE id = (SELECT shift_assignment_id FROM core.job_offer WHERE id = $1)`, [offerId]);
      const confirm = await request(app.getHttpServer()).post(`/rest/v1/offers/${offerId}/confirm`).set('Authorization', `Bearer ${s.managerToken}`);
      expect(confirm.status).toBe(409);
      expect(confirm.body.message).toContain('can no longer be confirmed');

      // Control: the same kind of offer inside the window (4h59m after the end) is still accepted.
      const third = await createStaff(s.managerToken, 'Third');
      await activateStaff(s.organisation, s.manager.userId, third);
      await endShiftAgo(s.shift2, -HOUR); // back in the future to send
      const okOffer = await sendOffer(s.managerToken, s.shift2, third);
      await endShiftAgo(s.shift2, 5 * HOUR - 60_000);
      const [{ user_id: thirdUserId }] = await adminDataSource.query(`SELECT user_id FROM core.staff_profile WHERE id = $1`, [third]);
      const accepted = await offers.staffAccept({ ...staffCtx, userId: thirdUserId }, okOffer);
      expect(accepted.status).toMatch(/staff_accepted|manager_confirmed/);
    });
  });
  describe('staff reviews and typed timesheet sign-off (1786718300000)', () => {
    const ratings = { grooming: 4, attitude: 3, skills: 5, attendance: 5, timeKeeping: 5 };
    const review = (token: string, shiftId: string, staffId: string) =>
      request(app.getHttpServer()).put(`/rest/v1/attendance/report/shift/${shiftId}/reviews/${staffId}`).set('Authorization', `Bearer ${token}`);

    async function seedReviewable() {
      const seed = await seedOrg();
      const managerToken = await login(seed.manager.email);
      const vmToken = await login(seed.venueManager.email);
      await request(app.getHttpServer()).post(`/rest/v1/managers/${seed.venueManagerProfileId}/venues`).set('Authorization', `Bearer ${managerToken}`).send({ venueId: seed.venue1.id });
      const shift1 = await createAndPublishShift(managerToken, seed.organisation, seed.venue1);
      const shift2 = await createAndPublishShift(managerToken, seed.organisation, seed.venue2);
      const staff = await createStaff(managerToken, 'Rev');
      const outsider = await createStaff(managerToken, 'Out');
      for (const id of [staff, outsider]) await activateStaff(seed.organisation, seed.manager.userId, id);
      await sendOffer(managerToken, shift1, staff);
      await confirmAssignment(seed.organisation, seed.manager.userId, staff, shift1);
      await sendOffer(managerToken, shift2, outsider);
      await confirmAssignment(seed.organisation, seed.manager.userId, outsider, shift2);
      return { ...seed, managerToken, vmToken, shift1, shift2, staff, outsider };
    }

    it('a Venue Manager reviews staff on their own venue shift only; one review per staff per shift; validation is strict', async () => {
      const s = await seedReviewable();
      const first = await review(s.vmToken, s.shift1, s.staff).send({ ...ratings, feedback: '  Great shift  ' });
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({ ...ratings, feedback: 'Great shift', reviewerUserId: s.venueManager.userId });
      const second = await review(s.vmToken, s.shift1, s.staff).send({ ...ratings, grooming: 2 });
      expect(second.body).toMatchObject({ grooming: 2, feedback: null });
      const [{ n }] = await adminDataSource.query(`SELECT count(*)::int AS n FROM core.shift_staff_review WHERE shift_id = $1`, [s.shift1]);
      expect(n).toBe(1);

      const read = await request(app.getHttpServer()).get(`/rest/v1/attendance/report/shift/${s.shift1}/reviews/${s.staff}`).set('Authorization', `Bearer ${s.vmToken}`);
      expect(read.body).toMatchObject({ editable: true, review: { grooming: 2 } });
      const detail = await request(app.getHttpServer()).get(`/rest/v1/attendance/report/shift/${s.shift1}`).set('Authorization', `Bearer ${s.vmToken}`);
      // The performance rating is reported separately from the attendance review.
      const seatRow = detail.body.staff.find((r: { staffProfileId: string }) => r.staffProfileId === s.staff);
      expect(seatRow.performanceReviewed).toBe(true);
      expect(seatRow.attendanceReviewed).toBe(false);

      // Another venue's shift, and a staff member not on this shift: both look like "not found".
      expect((await review(s.vmToken, s.shift2, s.outsider).send(ratings)).status).toBe(404);
      expect((await review(s.vmToken, s.shift1, s.outsider).send(ratings)).status).toBe(404);
      // No invented defaults: every rating required, 1..5 only, no extra fields.
      expect((await review(s.vmToken, s.shift1, s.staff).send({ ...ratings, skills: undefined })).status).toBe(400);
      expect((await review(s.vmToken, s.shift1, s.staff).send({ ...ratings, skills: 6 })).status).toBe(400);
      expect((await review(s.vmToken, s.shift1, s.staff).send({ ...ratings, attitude: 0 })).status).toBe(400);
      expect((await review(s.vmToken, s.shift1, s.staff).send({ ...ratings, reviewerUserId: s.manager.userId })).status).toBe(400);
    });

    it('web Staff Reviews: the owning Initial Manager reads real aggregates, filters change the figures, detail opens; nobody else can enumerate them', async () => {
      const s = await seedReviewable();
      expect((await review(s.vmToken, s.shift1, s.staff).send({ ...ratings, feedback: 'Professional and helpful' })).status).toBe(200);
      const url = `/rest/v1/staff/${s.staff}/reviews`;
      const get = (token: string, path = url) => request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${token}`);

      const all = await get(s.managerToken);
      expect(all.status).toBe(200);
      // Scores 4,3,5,5,5 → 4.4; the one review sits in the 4-star bucket; categories are the real ratings.
      expect(all.body).toMatchObject({ total: 1, reviewerCount: 1, average: 4.4, categories: { grooming: 4, attitude: 3, skills: 5, attendance: 5, timeKeeping: 5 } });
      expect(all.body.distribution.find((d: any) => d.stars === 4)).toMatchObject({ count: 1, percent: 100 });
      expect(all.body.reviewers.find((r: any) => r.userId === s.venueManager.userId)).toMatchObject({ reviews: 1 });
      expect(all.body.history).toHaveLength(1);
      const [item] = all.body.history;
      expect(item).toMatchObject({ reviewerUserId: s.venueManager.userId, score: 4.4, feedback: 'Professional and helpful', venueName: s.venue1.name });

      // Filters change the aggregate itself: another reviewer and a window without the shift both give zero.
      expect((await get(s.managerToken, `${url}?reviewer=${randomUUID()}`)).body).toMatchObject({ total: 0, average: null, history: [] });
      expect((await get(s.managerToken, `${url}?reviewer=${s.venueManager.userId}`)).body).toMatchObject({ total: 1 });
      const [{ day }] = await adminDataSource.query(`SELECT to_char(starts_at AT TIME ZONE coalesce(o.timezone, 'Europe/London'), 'YYYY-MM-DD') AS day FROM core.shift s JOIN core.organisation o ON o.id = s.organisation_id WHERE s.id = $1`, [s.shift1]);
      expect((await get(s.managerToken, `${url}?range=custom&from=${day}&to=${day}`)).body.total).toBe(1);
      expect((await get(s.managerToken, `${url}?range=custom&from=2001-01-01&to=2001-01-31`)).body.total).toBe(0);
      expect((await get(s.managerToken, `${url}?range=bogus`)).status).toBe(400);
      expect((await get(s.managerToken, `${url}?organisationId=${randomUUID()}`)).status).toBe(400);

      const detail = await get(s.managerToken, `${url}/${item.id}`);
      expect(detail.status).toBe(200);
      expect(detail.body).toMatchObject({ id: item.id, score: 4.4, ratings: ratings, feedback: 'Professional and helpful', reviewer: { userId: s.venueManager.userId, role: 'Venue manager' } });
      // The review id under another staff member is not found.
      expect((await get(s.managerToken, `/rest/v1/staff/${s.outsider}/reviews/${item.id}`)).status).toBe(404);

      // Another organisation, another manager in the SAME workspace, and the reviewing Venue Manager: no enumeration.
      const foreign = await seedOrg();
      expect((await get(await login(foreign.manager.email))).status).toBe(404);
      const [{ workspace_id: workspaceId }] = await adminDataSource.query(`SELECT workspace_id FROM core.shift WHERE id = $1`, [s.shift1]);
      const sibling = await seedManagerInWorkspace(s.organisation, workspaceId);
      expect((await get(await login(sibling.email))).status).toBe(404);
      expect((await get(await login(sibling.email), `${url}/${item.id}`)).status).toBe(404);
      const vm = await get(s.vmToken);
      expect([403, 404]).toContain(vm.status);
      expect(vm.body.history).toBeUndefined();
    });

    it('shift_staff_review returns zero rows with no tenant context, and RLS hides a review from a manager outside the shift scope', async () => {
      const s = await seedReviewable();
      expect((await review(s.vmToken, s.shift1, s.staff).send(ratings)).status).toBe(200);
      expect(await dataSource.query(`SELECT id FROM core.shift_staff_review`)).toHaveLength(0);
      const [{ id: workspaceId }] = await adminDataSource.query(`SELECT workspace_id AS id FROM core.shift WHERE id = $1`, [s.shift1]);
      const stranger = await tenantContext.runInTenantContext({ organisationId: s.organisation.id, workspaceId, userId: randomUUID(), role: '' },
        (m) => m.query(`SELECT id FROM core.shift_staff_review WHERE shift_id = $1`, [s.shift1]));
      expect(stranger).toHaveLength(0);
      const ownVm = await tenantContext.runInTenantContext({ organisationId: s.organisation.id, workspaceId, userId: s.venueManager.userId, role: '' },
        (m) => m.query(`SELECT id FROM core.shift_staff_review WHERE shift_id = $1`, [s.shift1]));
      expect(ownVm).toHaveLength(1);
      // RLS WITH CHECK pins the reviewer to the caller even if a service bug tried otherwise.
      await expect(tenantContext.runInTenantContext({ organisationId: s.organisation.id, workspaceId, userId: s.venueManager.userId, role: '' },
        (m) => m.query(`UPDATE core.shift_staff_review SET reviewer_user_id = $2 WHERE shift_id = $1`, [s.shift1, s.manager.userId]))).rejects.toThrow(/row-level security/);
    });

    it('typed sign-off is recorded with the server signer/time, is all-or-nothing, and locks reviews', async () => {
      const s = await seedReviewable();
      await adminDataSource.query(`UPDATE core.shift_assignment SET status = 'no_show' WHERE shift_id = $1`, [s.shift1]);
      const finalise = (body: object) => request(app.getHttpServer()).patch(`/rest/v1/attendance/report/shift/${s.shift1}/finalise`).set('Authorization', `Bearer ${s.vmToken}`).send(body);
      // Never before the shift starts (owner rule 2026-10-17), even when every seat is already resolved.
      const early = await finalise({ signedOffName: 'Venue Mgr', breakConfirmed: true });
      expect(early.status).toBe(409);
      expect(early.body.message).toContain('has not started yet');
      await adminDataSource.query(`UPDATE core.shift SET starts_at = now() - interval '9 hours', ends_at = now() - interval '1 hour' WHERE id = $1`, [s.shift1]);
      // Finalise also needs every seat's attendance reviewed (the no-show here).
      const unreviewed = await finalise({ signedOffName: 'Venue Mgr', breakConfirmed: true });
      expect(unreviewed.status).toBe(409);
      expect(unreviewed.body.message).toContain('attendance review remaining');
      expect((await request(app.getHttpServer()).post(`/rest/v1/attendance/report/shift/${s.shift1}/staff/${s.staff}/attendance-review`).set('Authorization', `Bearer ${s.vmToken}`)).status).toBe(200);
      expect((await finalise({ signedOffName: 'Venue Mgr' })).status).toBe(400);
      expect((await finalise({ signedOffName: 'Venue Mgr', breakConfirmed: false })).status).toBe(400);
      expect((await finalise({ signedOffName: ' ', breakConfirmed: true })).status).toBe(400);
      expect((await finalise({ signedOffName: 'Venue Mgr', breakConfirmed: true, signedBy: s.manager.userId })).status).toBe(400);
      const ok = await finalise({ signedOffName: '  Venue Mgr  ', breakConfirmed: true });
      expect(ok.status).toBe(200);
      expect(ok.body.signOff).toMatchObject({ name: 'Venue Mgr', breakConfirmed: true, signedBy: 'VenueMgr Test' });
      expect(ok.body.signOff.signedAt).toBe(ok.body.finalisedAt);
      // Idempotent: a second finalise never re-stamps the sign-off.
      const again = await finalise({ signedOffName: 'Someone Else', breakConfirmed: true });
      expect(again.body.signOff.name).toBe('Venue Mgr');
      const locked = await review(s.vmToken, s.shift1, s.staff).send(ratings);
      expect(locked.status).toBe(409);
    });
  });
  describe('forgotten clock-out recovery and explicit attendance review (1786718500000)', () => {
    const HOUR = 3_600_000;
    const http2 = () => request(app.getHttpServer());

    /** One confirmed seat on a shift that ENDED `endedAgoMs` ago (7 h long), with an attendance row in `status`. */
    async function seedSeat(opts: { status: string | null; endedAgoMs: number; clockOut?: boolean }) {
      const seed = await seedOrg();
      const managerToken = await login(seed.manager.email);
      const vmToken = await login(seed.venueManager.email);
      await http2().post(`/rest/v1/managers/${seed.venueManagerProfileId}/venues`).set('Authorization', `Bearer ${managerToken}`).send({ venueId: seed.venue1.id });
      const shiftId = await createAndPublishShift(managerToken, seed.organisation, seed.venue1);
      const staff = await createStaff(managerToken, 'Rec');
      await activateStaff(seed.organisation, seed.manager.userId, staff);
      await sendOffer(managerToken, shiftId, staff);
      await confirmAssignment(seed.organisation, seed.manager.userId, staff, shiftId);
      await adminDataSource.query(
        `UPDATE core.shift SET starts_at = now() - make_interval(secs => $2::double precision / 1000) - interval '7 hours',
           ends_at = now() - make_interval(secs => $2::double precision / 1000) WHERE id = $1`,
        [shiftId, opts.endedAgoMs],
      );
      await adminDataSource.query(
        `UPDATE core.shift_assignment SET period = tstzrange((SELECT starts_at FROM core.shift WHERE id = $1), (SELECT ends_at FROM core.shift WHERE id = $1)) WHERE shift_id = $1`,
        [shiftId],
      );
      let attendanceId: string | null = null;
      if (opts.status) {
        const [row] = await adminDataSource.query(
          `INSERT INTO core.attendance (organisation_id, workspace_id, shift_assignment_id, shift_id, staff_profile_id, clock_in_at, clock_out_at, status, break_minutes)
           SELECT sa.organisation_id, sa.workspace_id, sa.id, sa.shift_id, sa.staff_profile_id, s.starts_at + interval '15 minutes',
                  CASE WHEN $2 THEN s.ends_at ELSE NULL END, $3, 30
             FROM core.shift_assignment sa JOIN core.shift s ON s.id = sa.shift_id WHERE sa.shift_id = $1 RETURNING id, clock_in_at`,
          [shiftId, !!opts.clockOut, opts.status],
        );
        attendanceId = row.id;
      }
      return { ...seed, managerToken, vmToken, shiftId, staff, attendanceId };
    }
    const correct = (token: string, id: string, body: object) =>
      http2().post(`/rest/v1/attendance/${id}/correct`).set('Authorization', `Bearer ${token}`).send(body);
    const reviewSeat = (token: string, shiftId: string, staffId: string) =>
      http2().post(`/rest/v1/attendance/report/shift/${shiftId}/staff/${staffId}/attendance-review`).set('Authorization', `Bearer ${token}`);
    const finalise = (token: string, shiftId: string) =>
      http2().patch(`/rest/v1/attendance/report/shift/${shiftId}/finalise`).set('Authorization', `Bearer ${token}`).send({ signedOffName: 'Venue Mgr', breakConfirmed: true });
    const reportOf = async (token: string, shiftId: string) =>
      (await http2().get(`/rest/v1/attendance/report/shift/${shiftId}`).set('Authorization', `Bearer ${token}`)).body;
    const clockOutAt = async (shiftId: string) =>
      (await adminDataSource.query(`SELECT ends_at FROM core.shift WHERE id = $1`, [shiftId]))[0].ends_at.toISOString();

    it('recovers a genuinely forgotten clock-out: saved, recomputed, audited, idempotent, and visible after reload', async () => {
      const s = await seedSeat({ status: 'missing_clock_out', endedAgoMs: 2 * HOUR });
      const out = await clockOutAt(s.shiftId);
      expect((await correct(s.vmToken, s.attendanceId!, { field: 'clockInAt', newValue: out, reason: 'Wrong field for a missing clock-out' })).status).toBe(409);
      expect((await correct(s.vmToken, s.attendanceId!, { field: 'clockOutAt', newValue: out, reason: 'short' })).status).toBe(400);
      expect((await correct(s.vmToken, s.attendanceId!, { field: 'clockOutAt', newValue: new Date(Date.now() + HOUR).toISOString(), reason: 'Staff forgot to clock out; departure confirmed.' })).status).toBe(400);

      const ok = await correct(s.vmToken, s.attendanceId!, { field: 'clockOutAt', newValue: out, reason: 'Staff forgot to clock out; departure confirmed.' });
      expect(ok.status).toBeLessThan(300);
      const [row] = await adminDataSource.query(`SELECT status, clock_out_at, worked_minutes, clock_out_method FROM core.attendance WHERE id = $1`, [s.attendanceId]);
      expect(row).toMatchObject({ status: 'under_review', clock_out_method: 'manager_correction' });
      expect(row.clock_out_at.toISOString()).toBe(out);
      expect(row.worked_minutes).toBe(7 * 60 - 15 - 30); // in 15 min after start, scheduled 30 min break — shared duration rules

      // Same value again (retry / double tap): no second correction, no second audit entry.
      expect((await correct(s.vmToken, s.attendanceId!, { field: 'clockOutAt', newValue: out, reason: 'Staff forgot to clock out; departure confirmed.' })).status).toBeLessThan(300);
      const [{ n }] = await adminDataSource.query(`SELECT count(*)::int AS n FROM core.attendance_correction WHERE attendance_id = $1`, [s.attendanceId]);
      expect(n).toBe(1);

      const report = await reportOf(s.vmToken, s.shiftId);
      const seat = report.staff[0];
      expect(seat.clockOutAt).toBe(out);
      expect(seat.corrected).toBe(true);
      expect(seat.attendanceReviewed).toBe(false); // a saved correction is NOT a completed review
      expect(report.finalisable).toBe(false);
      expect(report.reviewsRemaining).toBe(1);
    });

    it('never force-closes a shift still running: an open attendance before the monitor threshold is refused', async () => {
      const s = await seedSeat({ status: 'clocked_in', endedAgoMs: 10 * 60_000 }); // ended 10 min ago (< 30 min threshold)
      const res = await correct(s.vmToken, s.attendanceId!, { field: 'clockOutAt', newValue: await clockOutAt(s.shiftId), reason: 'Trying to close it early, should fail.' });
      expect(res.status).toBe(409);
      expect(res.body.message).toContain('still on shift');
      const [row] = await adminDataSource.query(`SELECT status, clock_out_at FROM core.attendance WHERE id = $1`, [s.attendanceId]);
      expect(row).toMatchObject({ status: 'clocked_in', clock_out_at: null });
    });

    it('concurrent identical recoveries resolve to one clock-out and one correction row', async () => {
      const s = await seedSeat({ status: 'missing_clock_out', endedAgoMs: 2 * HOUR });
      const out = await clockOutAt(s.shiftId);
      const results = await Promise.all([1, 2, 3].map(() => correct(s.vmToken, s.attendanceId!, { field: 'clockOutAt', newValue: out, reason: 'Staff forgot to clock out; departure confirmed.' })));
      expect(results.every((r) => r.status < 300)).toBe(true);
      const [{ n }] = await adminDataSource.query(`SELECT count(*)::int AS n FROM core.attendance_correction WHERE attendance_id = $1`, [s.attendanceId]);
      expect(n).toBe(1);
    });

    it('Reviewed means a completed attendance review: refused while unresolved, required for finalise, cleared by a later correction', async () => {
      const s = await seedSeat({ status: 'missing_clock_out', endedAgoMs: 2 * HOUR });
      const early = await reviewSeat(s.vmToken, s.shiftId, s.staff);
      expect(early.status).toBe(409);
      expect(early.body.message).toContain('clock-out time is missing');
      const out = await clockOutAt(s.shiftId);
      await correct(s.vmToken, s.attendanceId!, { field: 'clockOutAt', newValue: out, reason: 'Staff forgot to clock out; departure confirmed.' });
      const blocked = await finalise(s.vmToken, s.shiftId);
      expect(blocked.status).toBe(409);
      expect(blocked.body.message).toContain('1 attendance review remaining');

      const reviewed = await reviewSeat(s.vmToken, s.shiftId, s.staff);
      expect(reviewed.status).toBe(200);
      expect(reviewed.body.staff[0]).toMatchObject({ attendanceReviewed: true, attendanceReviewedByName: 'VenueMgr Test' });
      expect(reviewed.body).toMatchObject({ finalisable: true, reviewsRemaining: 0 });
      expect(reviewed.body.actions.finalise).toBe('enabled');
      expect((await reviewSeat(s.vmToken, s.shiftId, s.staff)).status).toBe(200); // idempotent

      // A later correction re-opens the review.
      await correct(s.vmToken, s.attendanceId!, { field: 'breakMinutes', newValue: '45', reason: 'Took a longer break than scheduled.' });
      expect((await reportOf(s.vmToken, s.shiftId)).staff[0].attendanceReviewed).toBe(false);
      await reviewSeat(s.vmToken, s.shiftId, s.staff);
      expect((await finalise(s.vmToken, s.shiftId)).status).toBe(200);
      // Locked after finalisation.
      expect((await reviewSeat(s.vmToken, s.shiftId, s.staff)).status).toBe(409);
      expect((await correct(s.vmToken, s.attendanceId!, { field: 'breakMinutes', newValue: '30', reason: 'Trying to change after finalise.' })).status).toBe(409);
    });

    it('a confirmed no-show is reviewed explicitly (no invented hours); another Venue Manager cannot review it', async () => {
      const s = await seedSeat({ status: null, endedAgoMs: 2 * HOUR });
      expect((await reviewSeat(s.vmToken, s.shiftId, s.staff)).status).toBe(409); // still confirmed, not yet a no-show
      await adminDataSource.query(`UPDATE core.shift_assignment SET status = 'no_show' WHERE shift_id = $1`, [s.shiftId]);
      const other = await seedOrg();
      const otherVm = await login(other.venueManager.email);
      expect((await reviewSeat(otherVm, s.shiftId, s.staff)).status).toBe(404);
      const res = await reviewSeat(s.vmToken, s.shiftId, s.staff);
      expect(res.status).toBe(200);
      expect(res.body.staff[0]).toMatchObject({ assignmentStatus: 'no_show', attendanceReviewed: true, clockInAt: null, clockOutAt: null, workedMinutes: null });
      expect(res.body.finalisable).toBe(true);
    });
  });
});
