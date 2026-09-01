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
import { JobRole } from '../../modules/scheduling/entities/job-role.entity';
import { Venue } from '../../modules/venue/entities/venue.entity';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { createAdminDataSource } from './helpers/admin-datasource';

/**
 * Real Clock In/Out attendance abuse-case suite. Real Postgres, RLS on, no
 * mocks. Every timestamp is server-authoritative; `staffProfileId` is always
 * resolved from the caller's own verified JWT, never a client-supplied id —
 * see `AttendanceService`'s own class doc comment.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('attendance abuse cases (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let passwordHashing: PasswordHashingService;
  let tenantContext: TenantContextService;

  const password = 'correct horse battery staple 1!';

  const MANAGER_PERMS = [
    PermissionFlag.SCHEDULE_VIEW,
    PermissionFlag.SCHEDULE_CREATE,
    PermissionFlag.SCHEDULE_PUBLISH,
    PermissionFlag.OFFER_SEND,
    PermissionFlag.OFFER_CONFIRM,
    PermissionFlag.ATTENDANCE_VIEW,
  ];
  const STAFF_PERMS = [PermissionFlag.OFFER_RESPOND, PermissionFlag.ATTENDANCE_CLOCK];

  async function ensurePermission(key: string, resource: string, action: string): Promise<Permission> {
    let permission = await dataSource.manager.findOne(Permission, { where: { key } });
    if (!permission) permission = await dataSource.manager.save(Permission, { key, resource, action });
    return permission;
  }

  /** One org, one manager (platform admin — first claimed), one venue. */
  async function seedOrg(): Promise<{ organisation: Organisation; managerEmail: string; managerUserId: string; venue: Venue }> {
    const slug = `test-${randomUUID()}`;
    const managerEmail = `mgr-${randomUUID()}@example.test`;
    const orgInsert = await adminDataSource.manager.insert(Organisation, { name: slug, slug });
    const organisation = await adminDataSource.manager.findOneByOrFail(Organisation, { id: orgInsert.identifiers[0]!.id as string });

    let venue!: Venue;
    let managerUserId!: string;
    let workspaceId!: string;
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
      // current_uid() — rebind it to the real new manager, not this
      // transaction's throwaway bootstrap identity.
      await manager.query(`SELECT set_config('rab.user_id', $1, true)`, [managerUserId]);
      const workspace = await manager.save(ManagerWorkspace, {
        organisationId: organisation.id,
        ownerUserId: managerUserId,
        name: `Test Workspace ${managerUserId}`,
        subdomain: `test-${managerUserId.slice(0, 8)}`,
        status: 'active',
      });
      workspaceId = workspace.id;
    });
    await adminDataSource.manager.query(`INSERT INTO core.platform_admin (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [
      managerUserId,
    ]);
    // A fresh context, bound with the real workspace id now that it exists
    // — the Venue insert's own WITH CHECK needs current_workspace() to
    // actually match, which the bootstrap context above (workspaceId: null,
    // since the workspace didn't exist yet) can't provide.
    await tenantContext.runInTenantContext(
      { organisationId: organisation.id, workspaceId, userId: managerUserId, role: '' },
      async (manager) => {
        venue = await manager.save(Venue, { organisationId: organisation.id, workspaceId, name: 'Test Venue', createdBy: managerUserId });
      },
    );

    return { organisation, managerEmail, managerUserId, venue };
  }

  /** A second, non-admin manager in the same org — for Manager A / Manager B private-scope tests. */
  async function seedSecondManager(organisation: Organisation): Promise<string> {
    const email = `mgr2-${randomUUID()}@example.test`;
    await tenantContext.runInTenantContext({ organisationId: organisation.id, workspaceId: null, userId: randomUUID(), role: '' }, async (manager) => {
      const roleResult = await manager.insert(Role, { organisationId: organisation.id, key: `manager2-${randomUUID()}`, name: 'Manager2', isSystem: true });
      const roleId = roleResult.identifiers[0]!.id as string;
      for (const key of MANAGER_PERMS) {
        const permission = await ensurePermission(key, key.split('.')[0]!, key.split('.')[1]!);
        await manager.insert(RolePermission, { roleId, permissionId: permission.id, organisationId: organisation.id });
      }
      const passwordHash = await passwordHashing.hash(password);
      const userResult = await manager.insert(User, {
        organisationId: organisation.id,
        email,
        passwordHash,
        firstName: 'ManagerB',
        lastName: 'Test',
        status: UserStatus.ACTIVE,
      });
      await manager.insert(UserRole, { userId: userResult.identifiers[0]!.id as string, roleId, organisationId: organisation.id });
    });
    return email;
  }

  async function seedStaff(organisation: Organisation, createdByUserId: string): Promise<{ email: string; staffProfileId: string; userId: string }> {
    const email = `staff-${randomUUID()}@example.test`;
    let staffProfileId!: string;
    let staffUserId!: string;
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
        for (const key of STAFF_PERMS) {
          const permission = await ensurePermission(key, key.split('.')[0]!, key.split('.')[1]!);
          await manager.insert(RolePermission, { roleId: role.id, permissionId: permission.id, organisationId: organisation.id });
        }
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
      const userId = userResult.identifiers[0]!.id as string;
      staffUserId = userId;
      await manager.insert(UserRole, { userId, roleId: role.id, organisationId: organisation.id });

      const profile = await manager.query(
        `INSERT INTO core.staff_profile (organisation_id, user_id, staff_ref, created_by, workspace_id) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [organisation.id, userId, `STF-${randomUUID().slice(0, 8)}`, createdByUserId, creatorWorkspaceId],
      );
      staffProfileId = profile[0].id as string;
    });
    return { email, staffProfileId, userId: staffUserId };
  }

  async function login(email: string): Promise<string> {
    const res = await request(app.getHttpServer()).post('/rest/v1/auth/login').send({ email, password });
    expect(res.status).toBe(200);
    return res.body.accessToken as string;
  }

  async function seedJobRole(organisation: Organisation, workspaceId: string | null, createdBy: string): Promise<JobRole> {
    return tenantContext.runInTenantContext(
      { organisationId: organisation.id, workspaceId, userId: createdBy, role: '' },
      (manager) =>
        manager.save(JobRole, { organisationId: organisation.id, workspaceId: workspaceId ?? undefined, name: `Role-${randomUUID()}`, defaultRatePence: 1200, createdBy }),
    );
  }

  /** Creates + publishes a shift starting NOW (not the future) so a clock-in test doesn't need to fast-forward the clock. */
  async function makeAndPublishShift(organisation: Organisation, venue: Venue, managerToken: string): Promise<string> {
    const jobRole = await seedJobRole(organisation, venue.workspaceId ?? null, venue.createdBy!);
    const startsAt = new Date(Date.now() - 5 * 60 * 1000);
    const endsAt = new Date(Date.now() + 8 * 3600 * 1000);
    const createRes = await request(app.getHttpServer())
      .post('/rest/v1/shifts')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ venueId: venue.id, jobRoleId: jobRole.id, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), requiredCount: 1 });
    expect(createRes.status).toBe(201);
    const publishRes = await request(app.getHttpServer())
      .post(`/rest/v1/shifts/${createRes.body.id}/publish`)
      .set('Authorization', `Bearer ${managerToken}`);
    expect(publishRes.status).toBe(201);
    return createRes.body.id as string;
  }

  /** Full send -> accept -> confirm pipeline, leaving a real CONFIRMED ShiftAssignment for this staff. */
  async function confirmShiftForStaff(managerToken: string, staffToken: string, staffProfileId: string, shiftId: string): Promise<void> {
    const offerRes = await request(app.getHttpServer())
      .post(`/rest/v1/shifts/${shiftId}/offers`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ staffProfileId });
    expect(offerRes.status).toBe(201);

    const acceptRes = await request(app.getHttpServer())
      .post(`/rest/v1/offers/${offerRes.body.id}/accept`)
      .set('Authorization', `Bearer ${staffToken}`);
    expect(acceptRes.status).toBe(201);

    const confirmRes = await request(app.getHttpServer())
      .post(`/rest/v1/offers/${offerRes.body.id}/confirm`)
      .set('Authorization', `Bearer ${managerToken}`);
    expect(confirmRes.status).toBe(201);
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

  it('Staff A clocks into their own confirmed shift — SUCCESS, and the shift moves to in_progress', async () => {
    const { organisation, managerEmail, managerUserId, venue } = await seedOrg();
    const managerToken = await login(managerEmail);
    const staffA = await seedStaff(organisation, managerUserId);
    const staffAToken = await login(staffA.email);
    const shiftId = await makeAndPublishShift(organisation, venue, managerToken);
    await confirmShiftForStaff(managerToken, staffAToken, staffA.staffProfileId, shiftId);

    const res = await request(app.getHttpServer())
      .post('/rest/v1/attendance/clock-in')
      .set('Authorization', `Bearer ${staffAToken}`)
      .send({ shiftId });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('active');
    expect(res.body.clockOutAt).toBeNull();

    const shiftRes = await request(app.getHttpServer()).get(`/rest/v1/shifts/${shiftId}`).set('Authorization', `Bearer ${managerToken}`);
    expect(shiftRes.body.status).toBe('in_progress');
  });

  it('Staff A cannot clock into Shift B, assigned only to Staff B — DENIED (404, not found)', async () => {
    const { organisation, managerEmail, managerUserId, venue } = await seedOrg();
    const managerToken = await login(managerEmail);
    const staffA = await seedStaff(organisation, managerUserId);
    const staffB = await seedStaff(organisation, managerUserId);
    const staffAToken = await login(staffA.email);
    const staffBToken = await login(staffB.email);
    const shiftIdForB = await makeAndPublishShift(organisation, venue, managerToken);
    await confirmShiftForStaff(managerToken, staffBToken, staffB.staffProfileId, shiftIdForB);

    const res = await request(app.getHttpServer())
      .post('/rest/v1/attendance/clock-in')
      .set('Authorization', `Bearer ${staffAToken}`)
      .send({ shiftId: shiftIdForB });
    expect(res.status).toBe(404);
  });

  it('a manipulated staffProfileId in the clock-in body is rejected outright (DTO whitelist)', async () => {
    const { organisation, managerEmail, managerUserId, venue } = await seedOrg();
    const managerToken = await login(managerEmail);
    const staffA = await seedStaff(organisation, managerUserId);
    const staffAToken = await login(staffA.email);
    const shiftId = await makeAndPublishShift(organisation, venue, managerToken);
    await confirmShiftForStaff(managerToken, staffAToken, staffA.staffProfileId, shiftId);

    const res = await request(app.getHttpServer())
      .post('/rest/v1/attendance/clock-in')
      .set('Authorization', `Bearer ${staffAToken}`)
      .send({ shiftId, staffProfileId: randomUUID(), organisationId: randomUUID() });
    expect(res.status).toBe(400);
  });

  it('clocking in twice is rejected, not a duplicate row', async () => {
    const { organisation, managerEmail, managerUserId, venue } = await seedOrg();
    const managerToken = await login(managerEmail);
    const staffA = await seedStaff(organisation, managerUserId);
    const staffAToken = await login(staffA.email);
    const shiftId = await makeAndPublishShift(organisation, venue, managerToken);
    await confirmShiftForStaff(managerToken, staffAToken, staffA.staffProfileId, shiftId);

    const first = await request(app.getHttpServer()).post('/rest/v1/attendance/clock-in').set('Authorization', `Bearer ${staffAToken}`).send({ shiftId });
    expect(first.status).toBe(201);

    const second = await request(app.getHttpServer()).post('/rest/v1/attendance/clock-in').set('Authorization', `Bearer ${staffAToken}`).send({ shiftId });
    expect(second.status).toBe(409);

    // Bound to the real workspace, not null — `attendance`'s RLS no longer
    // has a platform-admin bypass branch (Stage 2A Phase 2 retired it), so
    // `workspace_id = current_workspace()` must actually match for this
    // verification query to see the row at all.
    const count = await tenantContext.runInTenantContext(
      { organisationId: organisation.id, workspaceId: venue.workspaceId!, userId: managerUserId, role: '' },
      (manager) => manager.query(`SELECT count(*) FROM core.attendance WHERE staff_profile_id = $1`, [staffA.staffProfileId]),
    );
    expect(Number(count[0].count)).toBe(1);
  });

  it('race condition: two simultaneous clock-in requests produce exactly one active attendance row', async () => {
    const { organisation, managerEmail, managerUserId, venue } = await seedOrg();
    const managerToken = await login(managerEmail);
    const staffA = await seedStaff(organisation, managerUserId);
    const staffAToken = await login(staffA.email);
    const shiftId = await makeAndPublishShift(organisation, venue, managerToken);
    await confirmShiftForStaff(managerToken, staffAToken, staffA.staffProfileId, shiftId);

    const [r1, r2] = await Promise.all([
      request(app.getHttpServer()).post('/rest/v1/attendance/clock-in').set('Authorization', `Bearer ${staffAToken}`).send({ shiftId }),
      request(app.getHttpServer()).post('/rest/v1/attendance/clock-in').set('Authorization', `Bearer ${staffAToken}`).send({ shiftId }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([201, 409]);

    const rows = await tenantContext.runInTenantContext(
      { organisationId: organisation.id, workspaceId: venue.workspaceId!, userId: managerUserId, role: '' },
      (manager) => manager.query(`SELECT status FROM core.attendance WHERE staff_profile_id = $1`, [staffA.staffProfileId]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('active');
  });

  it('clocking into a cancelled shift is rejected', async () => {
    const { organisation, managerEmail, managerUserId, venue } = await seedOrg();
    const managerToken = await login(managerEmail);
    const staffA = await seedStaff(organisation, managerUserId);
    const staffAToken = await login(staffA.email);
    const shiftId = await makeAndPublishShift(organisation, venue, managerToken);
    await confirmShiftForStaff(managerToken, staffAToken, staffA.staffProfileId, shiftId);

    const cancelRes = await request(app.getHttpServer())
      .post(`/rest/v1/shifts/${shiftId}/cancel`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ reason: 'test' });
    expect(cancelRes.status).toBe(201);

    const res = await request(app.getHttpServer()).post('/rest/v1/attendance/clock-in').set('Authorization', `Bearer ${staffAToken}`).send({ shiftId });
    expect(res.status).toBe(409);
  });

  it('clocking into a nonexistent shift 404s', async () => {
    const { organisation, managerUserId } = await seedOrg();
    const staffA = await seedStaff(organisation, managerUserId);
    const staffAToken = await login(staffA.email);

    const res = await request(app.getHttpServer())
      .post('/rest/v1/attendance/clock-in')
      .set('Authorization', `Bearer ${staffAToken}`)
      .send({ shiftId: randomUUID() });
    expect(res.status).toBe(404);
  });

  it('clock-out succeeds and produces correct worked minutes and earned pence', async () => {
    const { organisation, managerEmail, managerUserId, venue } = await seedOrg();
    const managerToken = await login(managerEmail);
    const staffA = await seedStaff(organisation, managerUserId);
    const staffAToken = await login(staffA.email);
    const shiftId = await makeAndPublishShift(organisation, venue, managerToken);
    await confirmShiftForStaff(managerToken, staffAToken, staffA.staffProfileId, shiftId);
    await request(app.getHttpServer()).post('/rest/v1/attendance/clock-in').set('Authorization', `Bearer ${staffAToken}`).send({ shiftId });

    const res = await request(app.getHttpServer()).post('/rest/v1/attendance/clock-out').set('Authorization', `Bearer ${staffAToken}`);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('completed');
    expect(res.body.clockOutAt).not.toBeNull();
    expect(typeof res.body.workedMinutes).toBe('number');
    expect(res.body.workedMinutes).toBeGreaterThanOrEqual(0);
    expect(typeof res.body.earnedPence).toBe('number');

    const shiftRes = await request(app.getHttpServer()).get(`/rest/v1/shifts/${shiftId}`).set('Authorization', `Bearer ${managerToken}`);
    // Sole assignment on this shift is now COMPLETED, so the shift rolls up to completed too.
    expect(shiftRes.body.status).toBe('completed');
  });

  it('clocking out twice is a safe denial, not a crash or double-processing', async () => {
    const { organisation, managerEmail, managerUserId, venue } = await seedOrg();
    const managerToken = await login(managerEmail);
    const staffA = await seedStaff(organisation, managerUserId);
    const staffAToken = await login(staffA.email);
    const shiftId = await makeAndPublishShift(organisation, venue, managerToken);
    await confirmShiftForStaff(managerToken, staffAToken, staffA.staffProfileId, shiftId);
    await request(app.getHttpServer()).post('/rest/v1/attendance/clock-in').set('Authorization', `Bearer ${staffAToken}`).send({ shiftId });

    const first = await request(app.getHttpServer()).post('/rest/v1/attendance/clock-out').set('Authorization', `Bearer ${staffAToken}`);
    expect(first.status).toBe(201);

    const second = await request(app.getHttpServer()).post('/rest/v1/attendance/clock-out').set('Authorization', `Bearer ${staffAToken}`);
    expect(second.status).toBe(404);
  });

  it('Staff B cannot clock out Staff A — there is no active attendance for B to close, by construction', async () => {
    const { organisation, managerEmail, managerUserId, venue } = await seedOrg();
    const managerToken = await login(managerEmail);
    const staffA = await seedStaff(organisation, managerUserId);
    const staffB = await seedStaff(organisation, managerUserId);
    const staffAToken = await login(staffA.email);
    const staffBToken = await login(staffB.email);
    const shiftId = await makeAndPublishShift(organisation, venue, managerToken);
    await confirmShiftForStaff(managerToken, staffAToken, staffA.staffProfileId, shiftId);
    await request(app.getHttpServer()).post('/rest/v1/attendance/clock-in').set('Authorization', `Bearer ${staffAToken}`).send({ shiftId });

    const res = await request(app.getHttpServer()).post('/rest/v1/attendance/clock-out').set('Authorization', `Bearer ${staffBToken}`);
    expect(res.status).toBe(404);

    const activeRes = await request(app.getHttpServer()).get('/rest/v1/attendance/me/active').set('Authorization', `Bearer ${staffAToken}`);
    expect(activeRes.body.attendance.status).toBe('active');
  });

  describe('manager/admin scoping', () => {
    it('Manager A sees only their own Staff attendance; a second Manager sees none of it', async () => {
      const { organisation, managerEmail, managerUserId, venue } = await seedOrg();
      const managerAToken = await login(managerEmail);
      const managerBEmail = await seedSecondManager(organisation);
      const managerBToken = await login(managerBEmail);

      const staffA = await seedStaff(organisation, managerUserId);
      const staffAToken = await login(staffA.email);
      const shiftId = await makeAndPublishShift(organisation, venue, managerAToken);
      await confirmShiftForStaff(managerAToken, staffAToken, staffA.staffProfileId, shiftId);
      await request(app.getHttpServer()).post('/rest/v1/attendance/clock-in').set('Authorization', `Bearer ${staffAToken}`).send({ shiftId });

      const adminList = await request(app.getHttpServer()).get('/rest/v1/attendance').set('Authorization', `Bearer ${managerAToken}`);
      expect(adminList.status).toBe(200);
      expect(adminList.body.map((a: { staffProfileId: string }) => a.staffProfileId)).toContain(staffA.staffProfileId);

      const managerBList = await request(app.getHttpServer()).get('/rest/v1/attendance').set('Authorization', `Bearer ${managerBToken}`);
      expect(managerBList.status).toBe(200);
      expect(managerBList.body).toEqual([]);
    });
  });

  it('a query with no tenant context bound returns zero rows', async () => {
    const rows = await dataSource.manager.query(`SELECT * FROM core.attendance`);
    expect(rows).toEqual([]);
  });

  it('clock-in and clock-out both write an audit entry attributing the real actor', async () => {
    const { organisation, managerEmail, managerUserId, venue } = await seedOrg();
    const managerToken = await login(managerEmail);
    const staffA = await seedStaff(organisation, managerUserId);
    const staffAToken = await login(staffA.email);
    const shiftId = await makeAndPublishShift(organisation, venue, managerToken);
    await confirmShiftForStaff(managerToken, staffAToken, staffA.staffProfileId, shiftId);
    await request(app.getHttpServer()).post('/rest/v1/attendance/clock-in').set('Authorization', `Bearer ${staffAToken}`).send({ shiftId });
    await request(app.getHttpServer()).post('/rest/v1/attendance/clock-out').set('Authorization', `Bearer ${staffAToken}`);

    const rows = await tenantContext.runInTenantContext({ organisationId: organisation.id, workspaceId: null, userId: staffA.userId, role: '' }, (manager) =>
      manager.query(
        `SELECT action, actor_user_id FROM core.audit_log WHERE organisation_id = $1 AND action IN ('attendance.clocked_in', 'attendance.clocked_out') ORDER BY created_at ASC`,
        [organisation.id],
      ),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].action).toBe('attendance.clocked_in');
    expect(rows[0].actor_user_id).toBe(staffA.userId);
    expect(rows[1].action).toBe('attendance.clocked_out');
    expect(rows[1].actor_user_id).toBe(staffA.userId);
  });
});
