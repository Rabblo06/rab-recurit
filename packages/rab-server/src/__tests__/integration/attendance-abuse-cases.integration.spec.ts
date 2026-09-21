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
import { AttendanceQrService } from '../../modules/attendance/services/attendance-qr.service';
import { JobRole } from '../../modules/scheduling/entities/job-role.entity';
import { Shift } from '../../modules/scheduling/entities/shift.entity';
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
  let attendanceQr: AttendanceQrService;

  const password = 'correct horse battery staple 1!';

  const MANAGER_PERMS = [
    PermissionFlag.SCHEDULE_VIEW,
    PermissionFlag.SCHEDULE_CREATE,
    PermissionFlag.SCHEDULE_PUBLISH,
    PermissionFlag.OFFER_SEND,
    PermissionFlag.OFFER_CONFIRM,
    PermissionFlag.ATTENDANCE_VIEW,
    PermissionFlag.ATTENDANCE_EDIT,
    PermissionFlag.REPORT_VIEW,
    PermissionFlag.REPORT_EXPORT,
    PermissionFlag.VENUE_VIEW,
    PermissionFlag.VENUE_CREATE,
    PermissionFlag.VENUE_EDIT,
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

  /**
   * A second, non-admin manager in the same org — for Manager A / Manager B
   * private-scope tests. Role key is literally `'manager'`, not a
   * randomized `manager2-<uuid>` string — `applicationAllowed()`
   * (`engine/core-modules/auth/application-access.ts`) checks
   * `roles.includes('manager')` by exact string match, and this Manager is
   * deliberately NOT a platform admin (unlike `seedOrg`'s manager), so it
   * has no other path to `manager_web` access. Safe to hardcode: `core.role`
   * is `UNIQUE (organisation_id, key)`, and `organisation` here is always a
   * fresh org from its own `seedOrg()` call, so this never collides with
   * that org's own `manager-<uuid>`-keyed primary manager role.
   */
  async function seedSecondManager(organisation: Organisation): Promise<string> {
    const email = `mgr2-${randomUUID()}@example.test`;
    await tenantContext.runInTenantContext({ organisationId: organisation.id, workspaceId: null, userId: randomUUID(), role: '' }, async (manager) => {
      const roleResult = await manager.insert(Role, { organisationId: organisation.id, key: 'manager', name: 'Manager2', isSystem: true });
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

  /**
   * `mobile: true` sends `x-client-platform: mobile` (`CLIENT_PLATFORM_HEADER`/
   * `MOBILE_PLATFORM_VALUE` in `refresh-cookie.constants.ts`), which is what
   * resolves the login's `applicationTarget` to `staff_app` — a plain Staff
   * account (no platform-admin/manager role) is denied `manager_web` (the
   * default with no header), matching `applicationAllowed`'s real,
   * restrictive rule (`engine/core-modules/auth/application-access.ts`).
   * Every Staff login in this suite must go through the same two-step
   * application-target flow the real mobile app uses — this is the test
   * helper matching current auth behaviour, not a workaround for it.
   */
  async function login(email: string, mobile = false): Promise<string> {
    const req = request(app.getHttpServer()).post('/rest/v1/auth/login');
    if (mobile) req.set('x-client-platform', 'mobile');
    const res = await req.send({ email, password });
    expect(res.status).toBe(200);
    return res.body.accessToken as string;
  }

  /** Real Trafalgar Square coordinates, arbitrary but fixed — enables geofence enforcement on an existing test venue. */
  const VENUE_LAT = 51.5080;
  const VENUE_LNG = -0.1281;
  async function enableGeofence(organisation: Organisation, venue: Venue, radiusM = 100): Promise<void> {
    await tenantContext.runInTenantContext(
      { organisationId: organisation.id, workspaceId: venue.workspaceId!, userId: venue.createdBy!, role: '' },
      (manager) => manager.update(Venue, venue.id, { lat: VENUE_LAT, lng: VENUE_LNG, geofenceRadiusM: radiusM, enforceGeofence: true }),
    );
  }

  async function seedJobRole(organisation: Organisation, workspaceId: string | null, createdBy: string): Promise<JobRole> {
    return tenantContext.runInTenantContext(
      { organisationId: organisation.id, workspaceId, userId: createdBy, role: '' },
      (manager) =>
        manager.save(JobRole, { organisationId: organisation.id, workspaceId: workspaceId ?? undefined, name: `Role-${randomUUID()}`, defaultRatePence: 1200, createdBy }),
    );
  }

  /** Creates + publishes a shift with an explicit start/end — for the clock-in-window boundary tests. */
  async function makeAndPublishShiftAt(organisation: Organisation, venue: Venue, managerToken: string, startsAt: Date, endsAt: Date): Promise<string> {
    const jobRole = await seedJobRole(organisation, venue.workspaceId ?? null, venue.createdBy!);
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

  /** Creates + publishes a shift starting NOW (not the future) so a clock-in test doesn't need to fast-forward the clock. */
  async function makeAndPublishShift(organisation: Organisation, venue: Venue, managerToken: string): Promise<string> {
    return makeAndPublishShiftAt(organisation, venue, managerToken, new Date(Date.now() - 5 * 60 * 1000), new Date(Date.now() + 8 * 3600 * 1000));
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
    attendanceQr = moduleRef.get(AttendanceQrService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
  });

  /** Signs a real, valid QR for this shift — the same code path `AttendanceService` itself validates against, never a test-only shortcut. */
  async function signQr(organisation: Organisation, workspaceId: string | null, managerUserId: string, shiftId: string): Promise<string> {
    return tenantContext.runInTenantContext(
      { organisationId: organisation.id, workspaceId, userId: managerUserId, role: '' },
      async (manager) => attendanceQr.sign(await manager.findOneByOrFail(Shift, { id: shiftId })),
    );
  }

  /** `clock-in`, auto-signing a real QR for `shiftId` unless the caller supplies its own `qrToken` override (e.g. to test a bad/cross-shift one). */
  async function clockIn(
    staffToken: string,
    organisation: Organisation,
    venue: Venue,
    managerUserId: string,
    shiftId: string,
    overrides: Record<string, unknown> = {},
  ) {
    const qrToken = overrides.qrToken ?? (await signQr(organisation, venue.workspaceId ?? null, managerUserId, shiftId));
    return request(app.getHttpServer())
      .post('/rest/v1/attendance/clock-in')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ shiftId, ...overrides, qrToken });
  }

  /** `clock-out` — resolves the caller's own open attendance server-side, so only the QR (for the SAME shift they're clocked into) needs signing here. */
  async function clockOut(staffToken: string, organisation: Organisation, venue: Venue, managerUserId: string, shiftId: string, overrides: Record<string, unknown> = {}) {
    const qrToken = overrides.qrToken ?? (await signQr(organisation, venue.workspaceId ?? null, managerUserId, shiftId));
    return request(app.getHttpServer())
      .post('/rest/v1/attendance/clock-out')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ ...overrides, qrToken });
  }

  afterAll(async () => {
    await app.close();
    await adminDataSource.destroy();
  });

  it('Staff A clocks into their own confirmed shift — SUCCESS, and the shift moves to in_progress', async () => {
    const { organisation, managerEmail, managerUserId, venue } = await seedOrg();
    const managerToken = await login(managerEmail);
    const staffA = await seedStaff(organisation, managerUserId);
    const staffAToken = await login(staffA.email, true);
    const shiftId = await makeAndPublishShift(organisation, venue, managerToken);
    await confirmShiftForStaff(managerToken, staffAToken, staffA.staffProfileId, shiftId);

    const res = await clockIn(staffAToken, organisation, venue, managerUserId, shiftId);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('clocked_in');
    expect(res.body.clockOutAt).toBeNull();

    const shiftRes = await request(app.getHttpServer()).get(`/rest/v1/shifts/${shiftId}`).set('Authorization', `Bearer ${managerToken}`);
    expect(shiftRes.body.status).toBe('in_progress');
  });

  it('Staff A cannot clock into Shift B, assigned only to Staff B — DENIED (404, not found)', async () => {
    const { organisation, managerEmail, managerUserId, venue } = await seedOrg();
    const managerToken = await login(managerEmail);
    const staffA = await seedStaff(organisation, managerUserId);
    const staffB = await seedStaff(organisation, managerUserId);
    const staffAToken = await login(staffA.email, true);
    const staffBToken = await login(staffB.email, true);
    const shiftIdForB = await makeAndPublishShift(organisation, venue, managerToken);
    await confirmShiftForStaff(managerToken, staffBToken, staffB.staffProfileId, shiftIdForB);

    const res = await clockIn(staffAToken, organisation, venue, managerUserId, shiftIdForB);
    expect(res.status).toBe(404);
  });

  it('a manipulated staffProfileId in the clock-in body is rejected outright (DTO whitelist)', async () => {
    const { organisation, managerEmail, managerUserId, venue } = await seedOrg();
    const managerToken = await login(managerEmail);
    const staffA = await seedStaff(organisation, managerUserId);
    const staffAToken = await login(staffA.email, true);
    const shiftId = await makeAndPublishShift(organisation, venue, managerToken);
    await confirmShiftForStaff(managerToken, staffAToken, staffA.staffProfileId, shiftId);

    const res = await clockIn(staffAToken, organisation, venue, managerUserId, shiftId, {
      staffProfileId: randomUUID(),
      organisationId: randomUUID(),
    });
    expect(res.status).toBe(400);
  });

  it('clocking in twice is rejected, not a duplicate row', async () => {
    const { organisation, managerEmail, managerUserId, venue } = await seedOrg();
    const managerToken = await login(managerEmail);
    const staffA = await seedStaff(organisation, managerUserId);
    const staffAToken = await login(staffA.email, true);
    const shiftId = await makeAndPublishShift(organisation, venue, managerToken);
    await confirmShiftForStaff(managerToken, staffAToken, staffA.staffProfileId, shiftId);

    const first = await clockIn(staffAToken, organisation, venue, managerUserId, shiftId);
    expect(first.status).toBe(201);

    const second = await clockIn(staffAToken, organisation, venue, managerUserId, shiftId);
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
    const staffAToken = await login(staffA.email, true);
    const shiftId = await makeAndPublishShift(organisation, venue, managerToken);
    await confirmShiftForStaff(managerToken, staffAToken, staffA.staffProfileId, shiftId);
    // Sign once, reuse for both concurrent requests — this test is about the
    // DB-level race backstop, not QR signing.
    const qrToken = await signQr(organisation, venue.workspaceId ?? null, managerUserId, shiftId);

    const [r1, r2] = await Promise.all([
      clockIn(staffAToken, organisation, venue, managerUserId, shiftId, { qrToken }),
      clockIn(staffAToken, organisation, venue, managerUserId, shiftId, { qrToken }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([201, 409]);

    const rows = await tenantContext.runInTenantContext(
      { organisationId: organisation.id, workspaceId: venue.workspaceId!, userId: managerUserId, role: '' },
      (manager) => manager.query(`SELECT status FROM core.attendance WHERE staff_profile_id = $1`, [staffA.staffProfileId]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('clocked_in');
  });

  it('clocking into a cancelled shift is rejected', async () => {
    const { organisation, managerEmail, managerUserId, venue } = await seedOrg();
    const managerToken = await login(managerEmail);
    const staffA = await seedStaff(organisation, managerUserId);
    const staffAToken = await login(staffA.email, true);
    const shiftId = await makeAndPublishShift(organisation, venue, managerToken);
    await confirmShiftForStaff(managerToken, staffAToken, staffA.staffProfileId, shiftId);

    const cancelRes = await request(app.getHttpServer())
      .post(`/rest/v1/shifts/${shiftId}/cancel`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ reason: 'test' });
    expect(cancelRes.status).toBe(201);

    const res = await clockIn(staffAToken, organisation, venue, managerUserId, shiftId);
    expect(res.status).toBe(409);
  });

  it('clocking into a nonexistent shift 404s', async () => {
    const { organisation, managerUserId, venue } = await seedOrg();
    const staffA = await seedStaff(organisation, managerUserId);
    const staffAToken = await login(staffA.email, true);

    // The shift genuinely doesn't exist, so there's nothing real to sign a
    // QR for — the assignment lookup 404s before QR validation ever runs
    // (see AttendanceService.clockIn's check order), so any string here is
    // fine; this deliberately exercises that ordering.
    const res = await clockIn(staffAToken, organisation, venue, managerUserId, randomUUID(), { qrToken: 'irrelevant-assignment-404s-first' });
    expect(res.status).toBe(404);
  });

  describe('QR security', () => {
    it('a QR signed for a different shift is rejected', async () => {
      const { organisation, managerEmail, managerUserId, venue } = await seedOrg();
      const managerToken = await login(managerEmail);
      const staffA = await seedStaff(organisation, managerUserId);
      const staffAToken = await login(staffA.email, true);
      const shiftId = await makeAndPublishShift(organisation, venue, managerToken);
      await confirmShiftForStaff(managerToken, staffAToken, staffA.staffProfileId, shiftId);
      const otherShiftId = await makeAndPublishShift(organisation, venue, managerToken);
      const wrongQr = await signQr(organisation, venue.workspaceId ?? null, managerUserId, otherShiftId);

      const res = await clockIn(staffAToken, organisation, venue, managerUserId, shiftId, { qrToken: wrongQr });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('INVALID_QR');
      expect(res.body.reason).toBe('shift_mismatch');
    });

    it('a tampered QR signature is rejected, not a 500', async () => {
      const { organisation, managerEmail, managerUserId, venue } = await seedOrg();
      const managerToken = await login(managerEmail);
      const staffA = await seedStaff(organisation, managerUserId);
      const staffAToken = await login(staffA.email, true);
      const shiftId = await makeAndPublishShift(organisation, venue, managerToken);
      await confirmShiftForStaff(managerToken, staffAToken, staffA.staffProfileId, shiftId);
      const realQr = await signQr(organisation, venue.workspaceId ?? null, managerUserId, shiftId);
      const tampered = `${realQr.slice(0, -4)}${realQr.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA'}`;

      const res = await clockIn(staffAToken, organisation, venue, managerUserId, shiftId, { qrToken: tampered });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('INVALID_QR');
    });

    it('a malformed QR string is rejected, not a 500', async () => {
      const { organisation, managerEmail, managerUserId, venue } = await seedOrg();
      const managerToken = await login(managerEmail);
      const staffA = await seedStaff(organisation, managerUserId);
      const staffAToken = await login(staffA.email, true);
      const shiftId = await makeAndPublishShift(organisation, venue, managerToken);
      await confirmShiftForStaff(managerToken, staffAToken, staffA.staffProfileId, shiftId);

      const res = await clockIn(staffAToken, organisation, venue, managerUserId, shiftId, { qrToken: 'not-a-jwt-at-all' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('INVALID_QR');
    });

    it('a missing qrToken is rejected by DTO validation (400), never silently accepted', async () => {
      const { organisation, managerEmail, managerUserId, venue } = await seedOrg();
      const managerToken = await login(managerEmail);
      const staffA = await seedStaff(organisation, managerUserId);
      const staffAToken = await login(staffA.email, true);
      const shiftId = await makeAndPublishShift(organisation, venue, managerToken);
      await confirmShiftForStaff(managerToken, staffAToken, staffA.staffProfileId, shiftId);

      const res = await request(app.getHttpServer()).post('/rest/v1/attendance/clock-in').set('Authorization', `Bearer ${staffAToken}`).send({ shiftId });
      expect(res.status).toBe(400);
    });

    it('a QR that is valid but whose assignment was removed after printing is still blocked (assignment is always re-checked fresh)', async () => {
      const { organisation, managerEmail, managerUserId, venue } = await seedOrg();
      const managerToken = await login(managerEmail);
      const staffA = await seedStaff(organisation, managerUserId);
      const staffAToken = await login(staffA.email, true);
      const shiftId = await makeAndPublishShift(organisation, venue, managerToken);
      await confirmShiftForStaff(managerToken, staffAToken, staffA.staffProfileId, shiftId);
      const validQr = await signQr(organisation, venue.workspaceId ?? null, managerUserId, shiftId);

      const cancelRes = await request(app.getHttpServer())
        .post(`/rest/v1/shifts/${shiftId}/cancel`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ reason: 'staffing changed' });
      expect(cancelRes.status).toBe(201);

      const res = await clockIn(staffAToken, organisation, venue, managerUserId, shiftId, { qrToken: validQr });
      expect(res.status).toBe(409);
      expect(res.body.code).not.toBe('INVALID_QR'); // rejected for the shift being closed, not the QR itself
    });
  });

  describe('geofence enforcement', () => {
    it('a venue with enforceGeofence=false never requires location, even with none supplied', async () => {
      const { organisation, managerEmail, managerUserId, venue } = await seedOrg();
      const managerToken = await login(managerEmail);
      const staffA = await seedStaff(organisation, managerUserId);
      const staffAToken = await login(staffA.email, true);
      const shiftId = await makeAndPublishShift(organisation, venue, managerToken);
      await confirmShiftForStaff(managerToken, staffAToken, staffA.staffProfileId, shiftId);

      const res = await clockIn(staffAToken, organisation, venue, managerUserId, shiftId);
      expect(res.status).toBe(201);
      expect(res.body.locationVerified).toBe(false);
    });

    it('clocking in from exactly the venue coordinates succeeds when geofence is enforced', async () => {
      const { organisation, managerEmail, managerUserId, venue } = await seedOrg();
      await enableGeofence(organisation, venue, 100);
      const managerToken = await login(managerEmail);
      const staffA = await seedStaff(organisation, managerUserId);
      const staffAToken = await login(staffA.email, true);
      const shiftId = await makeAndPublishShift(organisation, venue, managerToken);
      await confirmShiftForStaff(managerToken, staffAToken, staffA.staffProfileId, shiftId);

      const res = await clockIn(staffAToken, organisation, venue, managerUserId, shiftId, { lat: VENUE_LAT, lng: VENUE_LNG, accuracyM: 10 });
      expect(res.status).toBe(201);
      expect(res.body.locationVerified).toBe(true);
    });

    it('clocking in from well outside the venue radius is blocked (OUTSIDE_VENUE)', async () => {
      const { organisation, managerEmail, managerUserId, venue } = await seedOrg();
      await enableGeofence(organisation, venue, 100);
      const managerToken = await login(managerEmail);
      const staffA = await seedStaff(organisation, managerUserId);
      const staffAToken = await login(staffA.email, true);
      const shiftId = await makeAndPublishShift(organisation, venue, managerToken);
      await confirmShiftForStaff(managerToken, staffAToken, staffA.staffProfileId, shiftId);

      // ~1.1km north — far outside a 100m radius.
      const res = await clockIn(staffAToken, organisation, venue, managerUserId, shiftId, { lat: VENUE_LAT + 0.01, lng: VENUE_LNG, accuracyM: 10 });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('OUTSIDE_VENUE');
    });

    it('clocking in with no location supplied is blocked when the venue enforces geofencing (LOCATION_REQUIRED)', async () => {
      const { organisation, managerEmail, managerUserId, venue } = await seedOrg();
      await enableGeofence(organisation, venue, 100);
      const managerToken = await login(managerEmail);
      const staffA = await seedStaff(organisation, managerUserId);
      const staffAToken = await login(staffA.email, true);
      const shiftId = await makeAndPublishShift(organisation, venue, managerToken);
      await confirmShiftForStaff(managerToken, staffAToken, staffA.staffProfileId, shiftId);

      const res = await clockIn(staffAToken, organisation, venue, managerUserId, shiftId);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('LOCATION_REQUIRED');
    });

    it('a location fix with unacceptably poor accuracy is rejected (LOCATION_ACCURACY_TOO_LOW)', async () => {
      const { organisation, managerEmail, managerUserId, venue } = await seedOrg();
      await enableGeofence(organisation, venue, 100);
      const managerToken = await login(managerEmail);
      const staffA = await seedStaff(organisation, managerUserId);
      const staffAToken = await login(staffA.email, true);
      const shiftId = await makeAndPublishShift(organisation, venue, managerToken);
      await confirmShiftForStaff(managerToken, staffAToken, staffA.staffProfileId, shiftId);

      const res = await clockIn(staffAToken, organisation, venue, managerUserId, shiftId, { lat: VENUE_LAT, lng: VENUE_LNG, accuracyM: 500 });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('LOCATION_ACCURACY_TOO_LOW');
    });

    it('rejects non-finite/out-of-range coordinates at the DTO layer (400)', async () => {
      const { organisation, managerEmail, managerUserId, venue } = await seedOrg();
      await enableGeofence(organisation, venue, 100);
      const managerToken = await login(managerEmail);
      const staffA = await seedStaff(organisation, managerUserId);
      const staffAToken = await login(staffA.email, true);
      const shiftId = await makeAndPublishShift(organisation, venue, managerToken);
      await confirmShiftForStaff(managerToken, staffAToken, staffA.staffProfileId, shiftId);

      const res = await clockIn(staffAToken, organisation, venue, managerUserId, shiftId, { lat: 999, lng: VENUE_LNG, accuracyM: 10 });
      expect(res.status).toBe(400);
    });
  });

  describe('geofence-exit auto clock-out', () => {
    it('a genuinely out-of-radius geofence-exit report auto-clocks-out the staff member', async () => {
      const { organisation, managerEmail, managerUserId, venue } = await seedOrg();
      await enableGeofence(organisation, venue, 100);
      const managerToken = await login(managerEmail);
      const staffA = await seedStaff(organisation, managerUserId);
      const staffAToken = await login(staffA.email, true);
      const shiftId = await makeAndPublishShift(organisation, venue, managerToken);
      await confirmShiftForStaff(managerToken, staffAToken, staffA.staffProfileId, shiftId);
      await clockIn(staffAToken, organisation, venue, managerUserId, shiftId, { lat: VENUE_LAT, lng: VENUE_LNG, accuracyM: 10 });

      const res = await request(app.getHttpServer())
        .post('/rest/v1/attendance/geofence-exit')
        .set('Authorization', `Bearer ${staffAToken}`)
        .send({ lat: VENUE_LAT + 0.01, lng: VENUE_LNG, accuracyM: 10 });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('clocked_out');
      expect(res.body.clockOutAt).not.toBeNull();

      const rows = await tenantContext.runInTenantContext(
        { organisationId: organisation.id, workspaceId: venue.workspaceId!, userId: managerUserId, role: '' },
        (manager) => manager.query(`SELECT clock_out_method FROM core.attendance WHERE staff_profile_id = $1`, [staffA.staffProfileId]),
      );
      expect(rows[0].clock_out_method).toBe('auto_geofence');
    });

    it('a geofence-exit report claiming "outside" while server-recomputed position is still inside is rejected — no state change', async () => {
      const { organisation, managerEmail, managerUserId, venue } = await seedOrg();
      await enableGeofence(organisation, venue, 100);
      const managerToken = await login(managerEmail);
      const staffA = await seedStaff(organisation, managerUserId);
      const staffAToken = await login(staffA.email, true);
      const shiftId = await makeAndPublishShift(organisation, venue, managerToken);
      await confirmShiftForStaff(managerToken, staffAToken, staffA.staffProfileId, shiftId);
      await clockIn(staffAToken, organisation, venue, managerUserId, shiftId, { lat: VENUE_LAT, lng: VENUE_LNG, accuracyM: 10 });

      const res = await request(app.getHttpServer())
        .post('/rest/v1/attendance/geofence-exit')
        .set('Authorization', `Bearer ${staffAToken}`)
        .send({ lat: VENUE_LAT, lng: VENUE_LNG, accuracyM: 10 }); // still at the venue
      expect(res.status).toBe(409);

      const activeRes = await request(app.getHttpServer()).get('/rest/v1/attendance/me/active').set('Authorization', `Bearer ${staffAToken}`);
      expect(activeRes.body.attendance.status).toBe('clocked_in');
    });
  });

  describe('server-authoritative clock-in/out window (CLOCK_IN_EARLY_MINUTES=15, QR_POST_SHIFT_GRACE_MINUTES=120 defaults)', () => {
    it('clocking in more than 15 minutes before shift start is blocked with a structured too-early error', async () => {
      const { organisation, managerEmail, managerUserId, venue } = await seedOrg();
      const managerToken = await login(managerEmail);
      const staffA = await seedStaff(organisation, managerUserId);
      const staffAToken = await login(staffA.email, true);
      const startsAt = new Date(Date.now() + 20 * 60 * 1000);
      const shiftId = await makeAndPublishShiftAt(organisation, venue, managerToken, startsAt, new Date(startsAt.getTime() + 8 * 3600 * 1000));
      await confirmShiftForStaff(managerToken, staffAToken, staffA.staffProfileId, shiftId);

      const res = await clockIn(staffAToken, organisation, venue, managerUserId, shiftId);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('CLOCK_IN_TOO_EARLY');
      expect(res.body.shiftStart).toBe(startsAt.toISOString());
    });

    it('clocking in exactly at shift-start-minus-15-minutes succeeds', async () => {
      const { organisation, managerEmail, managerUserId, venue } = await seedOrg();
      const managerToken = await login(managerEmail);
      const staffA = await seedStaff(organisation, managerUserId);
      const staffAToken = await login(staffA.email, true);
      // A few seconds' slack for the request's own travel time — the shift
      // starts ~14m55s from now, safely inside the 15-minute window opened
      // at request time, without racing the boundary itself.
      const startsAt = new Date(Date.now() + 14 * 60 * 1000 + 55 * 1000);
      const shiftId = await makeAndPublishShiftAt(organisation, venue, managerToken, startsAt, new Date(startsAt.getTime() + 8 * 3600 * 1000));
      await confirmShiftForStaff(managerToken, staffAToken, staffA.staffProfileId, shiftId);

      const res = await clockIn(staffAToken, organisation, venue, managerUserId, shiftId);
      expect(res.status).toBe(201);
    });

    it('clocking in within the post-shift-end grace period succeeds (e.g. a very late clock-in)', async () => {
      const { organisation, managerEmail, managerUserId, venue } = await seedOrg();
      const managerToken = await login(managerEmail);
      const staffA = await seedStaff(organisation, managerUserId);
      const staffAToken = await login(staffA.email, true);
      const startsAt = new Date(Date.now() - 6 * 3600 * 1000);
      const endsAt = new Date(Date.now() - 30 * 60 * 1000);
      const shiftId = await makeAndPublishShiftAt(organisation, venue, managerToken, startsAt, endsAt);
      await confirmShiftForStaff(managerToken, staffAToken, staffA.staffProfileId, shiftId);

      const res = await clockIn(staffAToken, organisation, venue, managerUserId, shiftId);
      expect(res.status).toBe(201);
    });

    it('clocking in beyond shift-end-plus-120-minutes is blocked', async () => {
      const { organisation, managerEmail, managerUserId, venue } = await seedOrg();
      const managerToken = await login(managerEmail);
      const staffA = await seedStaff(organisation, managerUserId);
      const staffAToken = await login(staffA.email, true);
      const startsAt = new Date(Date.now() - 10 * 3600 * 1000);
      const endsAt = new Date(Date.now() - 3 * 3600 * 1000);
      const shiftId = await makeAndPublishShiftAt(organisation, venue, managerToken, startsAt, endsAt);
      await confirmShiftForStaff(managerToken, staffAToken, staffA.staffProfileId, shiftId);

      const res = await clockIn(staffAToken, organisation, venue, managerUserId, shiftId);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('CLOCK_WINDOW_CLOSED');
    });
  });

  it('clock-out succeeds and produces correct worked minutes and earned pence', async () => {
    const { organisation, managerEmail, managerUserId, venue } = await seedOrg();
    const managerToken = await login(managerEmail);
    const staffA = await seedStaff(organisation, managerUserId);
    const staffAToken = await login(staffA.email, true);
    const shiftId = await makeAndPublishShift(organisation, venue, managerToken);
    await confirmShiftForStaff(managerToken, staffAToken, staffA.staffProfileId, shiftId);
    await clockIn(staffAToken, organisation, venue, managerUserId, shiftId);

    const res = await clockOut(staffAToken, organisation, venue, managerUserId, shiftId);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('clocked_out');
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
    const staffAToken = await login(staffA.email, true);
    const shiftId = await makeAndPublishShift(organisation, venue, managerToken);
    await confirmShiftForStaff(managerToken, staffAToken, staffA.staffProfileId, shiftId);
    await clockIn(staffAToken, organisation, venue, managerUserId, shiftId);

    const first = await clockOut(staffAToken, organisation, venue, managerUserId, shiftId);
    expect(first.status).toBe(201);

    const second = await clockOut(staffAToken, organisation, venue, managerUserId, shiftId);
    expect(second.status).toBe(404);
  });

  it('Staff B cannot clock out Staff A — there is no active attendance for B to close, by construction', async () => {
    const { organisation, managerEmail, managerUserId, venue } = await seedOrg();
    const managerToken = await login(managerEmail);
    const staffA = await seedStaff(organisation, managerUserId);
    const staffB = await seedStaff(organisation, managerUserId);
    const staffAToken = await login(staffA.email, true);
    const staffBToken = await login(staffB.email, true);
    const shiftId = await makeAndPublishShift(organisation, venue, managerToken);
    await confirmShiftForStaff(managerToken, staffAToken, staffA.staffProfileId, shiftId);
    await clockIn(staffAToken, organisation, venue, managerUserId, shiftId);

    const res = await clockOut(staffBToken, organisation, venue, managerUserId, shiftId);
    expect(res.status).toBe(404);

    const activeRes = await request(app.getHttpServer()).get('/rest/v1/attendance/me/active').set('Authorization', `Bearer ${staffAToken}`);
    expect(activeRes.body.attendance.status).toBe('clocked_in');
  });

  describe('manager/admin scoping', () => {
    it('Manager A sees only their own Staff attendance; a second Manager sees none of it', async () => {
      const { organisation, managerEmail, managerUserId, venue } = await seedOrg();
      const managerAToken = await login(managerEmail);
      const managerBEmail = await seedSecondManager(organisation);
      const managerBToken = await login(managerBEmail);

      const staffA = await seedStaff(organisation, managerUserId);
      const staffAToken = await login(staffA.email, true);
      const shiftId = await makeAndPublishShift(organisation, venue, managerAToken);
      await confirmShiftForStaff(managerAToken, staffAToken, staffA.staffProfileId, shiftId);
      await clockIn(staffAToken, organisation, venue, managerUserId, shiftId);

      const adminList = await request(app.getHttpServer()).get('/rest/v1/attendance').set('Authorization', `Bearer ${managerAToken}`);
      expect(adminList.status).toBe(200);
      expect(adminList.body.data.map((a: { staffProfileId: string }) => a.staffProfileId)).toContain(staffA.staffProfileId);

      const managerBList = await request(app.getHttpServer()).get('/rest/v1/attendance').set('Authorization', `Bearer ${managerBToken}`);
      expect(managerBList.status).toBe(200);
      expect(managerBList.body.data).toEqual([]);
      expect(managerBList.body.total).toBe(0);
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
    const staffAToken = await login(staffA.email, true);
    const shiftId = await makeAndPublishShift(organisation, venue, managerToken);
    await confirmShiftForStaff(managerToken, staffAToken, staffA.staffProfileId, shiftId);
    await clockIn(staffAToken, organisation, venue, managerUserId, shiftId);
    await clockOut(staffAToken, organisation, venue, managerUserId, shiftId);

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

  describe('manager corrections', () => {
    it('correcting clockOutAt without a reason is rejected by DTO validation (400)', async () => {
      const { organisation, managerEmail, managerUserId, venue } = await seedOrg();
      const managerToken = await login(managerEmail);
      const staffA = await seedStaff(organisation, managerUserId);
      const staffAToken = await login(staffA.email, true);
      const shiftId = await makeAndPublishShift(organisation, venue, managerToken);
      await confirmShiftForStaff(managerToken, staffAToken, staffA.staffProfileId, shiftId);
      await clockIn(staffAToken, organisation, venue, managerUserId, shiftId);
      const clockOutRes = await clockOut(staffAToken, organisation, venue, managerUserId, shiftId);

      const res = await request(app.getHttpServer())
        .post(`/rest/v1/attendance/${clockOutRes.body.id}/correct`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ field: 'breakMinutes', newValue: '30' });
      expect(res.status).toBe(400);
    });

    it('a manager corrects breakMinutes with a reason — recomputes workedMinutes, records the correction, and requires review', async () => {
      const { organisation, managerEmail, managerUserId, venue } = await seedOrg();
      const managerToken = await login(managerEmail);
      const staffA = await seedStaff(organisation, managerUserId);
      const staffAToken = await login(staffA.email, true);
      const shiftId = await makeAndPublishShift(organisation, venue, managerToken);
      await confirmShiftForStaff(managerToken, staffAToken, staffA.staffProfileId, shiftId);
      await clockIn(staffAToken, organisation, venue, managerUserId, shiftId);
      const clockOutRes = await clockOut(staffAToken, organisation, venue, managerUserId, shiftId);
      const workedBeforeCorrection = clockOutRes.body.workedMinutes as number;

      const res = await request(app.getHttpServer())
        .post(`/rest/v1/attendance/${clockOutRes.body.id}/correct`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ field: 'breakMinutes', newValue: '30', reason: '30 minute meal break confirmed with venue' });
      expect(res.status).toBe(201);
      expect(res.body.breakMinutes).toBe(30);
      expect(res.body.status).toBe('under_review');
      expect(res.body.workedMinutes).toBe(Math.max(0, workedBeforeCorrection - 30));

      const corrections = await tenantContext.runInTenantContext(
        { organisationId: organisation.id, workspaceId: venue.workspaceId!, userId: managerUserId, role: '' },
        (manager) => manager.query(`SELECT field, old_value, new_value, reason FROM core.attendance_correction WHERE attendance_id = $1`, [clockOutRes.body.id]),
      );
      expect(corrections).toHaveLength(1);
      expect(corrections[0].field).toBe('breakMinutes');
      expect(corrections[0].new_value).toBe('30');
    });

    it('a Manager cannot correct another Manager\'s Staff attendance — 404, not 403', async () => {
      const { organisation, managerEmail, managerUserId, venue } = await seedOrg();
      const managerAToken = await login(managerEmail);
      const managerBEmail = await seedSecondManager(organisation);
      const managerBToken = await login(managerBEmail);
      const staffA = await seedStaff(organisation, managerUserId);
      const staffAToken = await login(staffA.email, true);
      const shiftId = await makeAndPublishShift(organisation, venue, managerAToken);
      await confirmShiftForStaff(managerAToken, staffAToken, staffA.staffProfileId, shiftId);
      await clockIn(staffAToken, organisation, venue, managerUserId, shiftId);
      const clockOutRes = await clockOut(staffAToken, organisation, venue, managerUserId, shiftId);

      const res = await request(app.getHttpServer())
        .post(`/rest/v1/attendance/${clockOutRes.body.id}/correct`)
        .set('Authorization', `Bearer ${managerBToken}`)
        .send({ field: 'breakMinutes', newValue: '30', reason: 'attempted cross-manager correction' });
      expect(res.status).toBe(404);
    });
  });

  describe('report finalisation', () => {
    it('finalising a report while a staff member is still clocked in is rejected', async () => {
      const { organisation, managerEmail, managerUserId, venue } = await seedOrg();
      const managerToken = await login(managerEmail);
      const staffA = await seedStaff(organisation, managerUserId);
      const staffAToken = await login(staffA.email, true);
      const shiftId = await makeAndPublishShift(organisation, venue, managerToken);
      await confirmShiftForStaff(managerToken, staffAToken, staffA.staffProfileId, shiftId);
      await clockIn(staffAToken, organisation, venue, managerUserId, shiftId);

      const res = await request(app.getHttpServer())
        .patch(`/rest/v1/attendance/report/shift/${shiftId}/finalise`)
        .set('Authorization', `Bearer ${managerToken}`);
      expect(res.status).toBe(409);
    });

    it('finalising after everyone has clocked out succeeds and approves every attendance row', async () => {
      const { organisation, managerEmail, managerUserId, venue } = await seedOrg();
      const managerToken = await login(managerEmail);
      const staffA = await seedStaff(organisation, managerUserId);
      const staffAToken = await login(staffA.email, true);
      const shiftId = await makeAndPublishShift(organisation, venue, managerToken);
      await confirmShiftForStaff(managerToken, staffAToken, staffA.staffProfileId, shiftId);
      await clockIn(staffAToken, organisation, venue, managerUserId, shiftId);
      await clockOut(staffAToken, organisation, venue, managerUserId, shiftId);

      const res = await request(app.getHttpServer())
        .patch(`/rest/v1/attendance/report/shift/${shiftId}/finalise`)
        .set('Authorization', `Bearer ${managerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.reportStatus).toBe('finalised');
      expect(res.body.staff).toHaveLength(1);
      expect(res.body.staff[0].attendanceStatus).toBe('approved');
    });

    it('a Venue Manager sees the report for their assigned venue via GET /attendance/report/shift/:shiftId', async () => {
      const { organisation, managerEmail, managerUserId, venue } = await seedOrg();
      const managerToken = await login(managerEmail);
      const staffA = await seedStaff(organisation, managerUserId);
      const staffAToken = await login(staffA.email, true);
      const shiftId = await makeAndPublishShift(organisation, venue, managerToken);
      await confirmShiftForStaff(managerToken, staffAToken, staffA.staffProfileId, shiftId);
      await clockIn(staffAToken, organisation, venue, managerUserId, shiftId);

      const res = await request(app.getHttpServer())
        .get(`/rest/v1/attendance/report/shift/${shiftId}`)
        .set('Authorization', `Bearer ${managerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.staff).toHaveLength(1);
      expect(res.body.staff[0].attendanceStatus).toBe('clocked_in');
    });
  });

  describe('venue geofence configuration drives attendance (configured through the real Venue API, not the DB)', () => {
    /** Internal Manager creates the venue through POST /venues with a real location, radius and enforcement, then reloads it — the same Venue row attendance will read. */
    async function createConfiguredVenue(organisation: Organisation, managerToken: string, managerUserId: string, extra: Record<string, unknown> = {}): Promise<Venue> {
      const res = await request(app.getHttpServer())
        .post('/rest/v1/venues')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ name: `Geo Venue ${randomUUID().slice(0, 6)}`, type: 'hotel', lat: VENUE_LAT, lng: VENUE_LNG, geofenceRadiusM: 100, enforceGeofence: true, ...extra });
      expect(res.status).toBe(201);
      return tenantContext.runInTenantContext(
        { organisationId: organisation.id, workspaceId: res.body.workspaceId, userId: managerUserId, role: '' },
        (manager) => manager.findOneByOrFail(Venue, { id: res.body.id }),
      );
    }
    const patchVenue = (managerToken: string, venueId: string, body: object) =>
      request(app.getHttpServer()).patch(`/rest/v1/venues/${venueId}`).set('Authorization', `Bearer ${managerToken}`).send(body);
    // ~1.1 km north of the venue — far outside a 100m radius.
    const OUTSIDE = { lat: VENUE_LAT + 0.01, lng: VENUE_LNG, accuracyM: 5 };
    const INSIDE = { lat: VENUE_LAT, lng: VENUE_LNG, accuracyM: 5 };

    async function setup() {
      const { organisation, managerEmail, managerUserId } = await seedOrg();
      const managerToken = await login(managerEmail);
      const venue = await createConfiguredVenue(organisation, managerToken, managerUserId);
      const staffA = await seedStaff(organisation, managerUserId);
      const staffAToken = await login(staffA.email, true);
      const shiftId = await makeAndPublishShift(organisation, venue, managerToken);
      await confirmShiftForStaff(managerToken, staffAToken, staffA.staffProfileId, shiftId);
      return { organisation, managerToken, managerUserId, venue, staffAToken, shiftId };
    }

    it('Staff outside the saved radius is rejected (OUTSIDE_VENUE); the same Staff inside the radius is accepted and marked location-verified', async () => {
      const { organisation, managerUserId, venue, staffAToken, shiftId } = await setup();

      const outside = await clockIn(staffAToken, organisation, venue, managerUserId, shiftId, OUTSIDE);
      expect(outside.status).toBe(409);
      expect(outside.body.code).toBe('OUTSIDE_VENUE');

      const inside = await clockIn(staffAToken, organisation, venue, managerUserId, shiftId, INSIDE);
      expect(inside.status).toBe(201);
      expect(inside.body.locationVerified).toBe(true);
    });

    it('the Manager editing the radius through the Venue API changes what attendance accepts (100m -> 5km lets the 1.1km-away point in)', async () => {
      const { organisation, managerToken, managerUserId, venue, staffAToken, shiftId } = await setup();
      expect((await clockIn(staffAToken, organisation, venue, managerUserId, shiftId, OUTSIDE)).status).toBe(409);

      expect((await patchVenue(managerToken, venue.id, { geofenceRadiusM: 5000 })).status).toBe(200);

      const res = await clockIn(staffAToken, organisation, venue, managerUserId, shiftId, OUTSIDE);
      expect(res.status).toBe(201);
      expect(res.body.locationVerified).toBe(true);
    });

    it('the Manager disabling enforcement through the Venue API makes attendance skip the location check (no location needed, not marked verified)', async () => {
      const { organisation, managerToken, managerUserId, venue, staffAToken, shiftId } = await setup();
      expect((await clockIn(staffAToken, organisation, venue, managerUserId, shiftId, OUTSIDE)).status).toBe(409);

      expect((await patchVenue(managerToken, venue.id, { enforceGeofence: false })).status).toBe(200);

      // Not even a location is required any more — the check is skipped, QR/time/assignment checks still apply.
      const res = await clockIn(staffAToken, organisation, venue, managerUserId, shiftId);
      expect(res.status).toBe(201);
      expect(res.body.locationVerified).toBe(false);
    });

    it('Staff cannot supply their own venue coordinates/radius — venueLat/venueLng/venueRadius are rejected outright', async () => {
      const { organisation, managerUserId, venue, staffAToken, shiftId } = await setup();
      const res = await clockIn(staffAToken, organisation, venue, managerUserId, shiftId, { ...OUTSIDE, venueLat: OUTSIDE.lat, venueLng: OUTSIDE.lng, venueRadius: 999999 });
      expect(res.status).toBe(400);
    });
  });

  describe('per-user rate limiting on clock actions', () => {
    it('an 11th clock action from the same Staff account within a minute is throttled (429), independent of the global per-IP limit', async () => {
      // Mirrors rate-limiting.integration.spec.ts's own pattern: flips the
      // Jest-only rate-limit bypass off for just this one test, restored
      // immediately after — every other test in this file keeps running
      // with rate limiting disabled, matching every other suite.
      const originalFlag = process.env.RAB_DISABLE_RATE_LIMIT;
      process.env.RAB_DISABLE_RATE_LIMIT = 'false';
      try {
        const { organisation, managerUserId } = await seedOrg();
        const staffA = await seedStaff(organisation, managerUserId);
        const staffAToken = await login(staffA.email, true);

        // No active attendance exists, so every call 404s from the service
        // — irrelevant here: AttendancePerUserThrottleGuard runs (and
        // counts) BEFORE the controller method, regardless of what the
        // business logic would eventually return.
        const attempt = () =>
          request(app.getHttpServer())
            .post('/rest/v1/attendance/geofence-exit')
            .set('Authorization', `Bearer ${staffAToken}`)
            .send({ lat: VENUE_LAT, lng: VENUE_LNG, accuracyM: 5 });

        for (let i = 0; i < 10; i++) {
          const res = await attempt();
          expect(res.status).not.toBe(429);
        }
        const eleventh = await attempt();
        expect(eleventh.status).toBe(429);
      } finally {
        process.env.RAB_DISABLE_RATE_LIMIT = originalFlag;
      }
    }, 30_000);
  });
});
