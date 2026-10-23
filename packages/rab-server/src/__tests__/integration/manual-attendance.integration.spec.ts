import { insertMembership } from './helpers/test-identities';
import 'reflect-metadata';
import { ManagerType, payForMinutes, PermissionFlag, UserStatus } from '@rab/shared';
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
 * Manual attendance recording vs confirmed no-show (owner rule 2026-10-21: missing attendance is NOT a confirmed
 * no-show). Real Postgres, RLS on, no mocks; every request goes through the real HTTP stack as the real Venue Manager.
 * Fixture shape mirrors venue-manager-scoping's "forgotten clock-out recovery" block (same seeding helpers).
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(120_000);

describeIfDb('manual attendance recording and confirmed no-show (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let passwordHashing: PasswordHashingService;
  let tenantContext: TenantContextService;
  const password = FIXTURE_PASSWORD;
  const HOUR = 3_600_000;
  const MIN = 60_000;

  const MANAGER_PERMS = [
    PermissionFlag.MANAGER_MANAGE,
    PermissionFlag.VENUE_MANAGER_CREATE,
    PermissionFlag.STAFF_CREATE,
    PermissionFlag.STAFF_VIEW,
    PermissionFlag.VENUE_CREATE,
    PermissionFlag.VENUE_VIEW,
    PermissionFlag.SCHEDULE_VIEW,
    PermissionFlag.SCHEDULE_CREATE,
    PermissionFlag.SCHEDULE_PUBLISH,
    PermissionFlag.OFFER_SEND,
    PermissionFlag.OFFER_CONFIRM,
    PermissionFlag.REPORT_VIEW,
    PermissionFlag.REPORT_EXPORT,
  ];
  const VENUE_MANAGER_PERMS = [
    PermissionFlag.VENUE_VIEW, PermissionFlag.SCHEDULE_VIEW, PermissionFlag.STAFF_VIEW, PermissionFlag.REPORT_VIEW,
    PermissionFlag.ATTENDANCE_VIEW, PermissionFlag.REPORT_EXPORT, PermissionFlag.REVIEW_CREATE, PermissionFlag.ATTENDANCE_EDIT,
  ];

  async function ensurePermission(key: string): Promise<Permission> {
    let permission = await dataSource.manager.findOne(Permission, { where: { key } });
    if (!permission) permission = await dataSource.manager.save(Permission, { key, resource: key.split('.')[0]!, action: key.split('.')[1]! });
    return permission;
  }

  /** One org (or a new workspace in an existing org), one Internal Manager, one Venue Manager, two venues. */
  async function seedOrg(existingOrganisation?: Organisation) {
    const slug = `test-${randomUUID()}`;
    const organisation = existingOrganisation ?? (await adminDataSource.manager.save(Organisation, { name: slug, slug }));
    for (const key of [...MANAGER_PERMS, ...VENUE_MANAGER_PERMS]) await ensurePermission(key);
    let manager!: { email: string; userId: string };
    let venueManager!: { email: string; userId: string };
    let venueManagerProfileId!: string;
    let workspaceId!: string;
    await tenantContext.runInTenantContext({ organisationId: organisation.id, workspaceId: null, userId: randomUUID(), role: '' }, async (m) => {
      async function role(key: string, perms: string[]): Promise<string> {
        const existing = await m.findOne(Role, { where: { organisationId: organisation.id, key } });
        if (existing) return existing.id;
        const roleId = (await m.insert(Role, { organisationId: organisation.id, key, name: key, isSystem: true })).identifiers[0]!.id as string;
        for (const permKey of perms) {
          const permission = await dataSource.manager.findOneByOrFail(Permission, { key: permKey });
          await m.insert(RolePermission, { roleId, permissionId: permission.id, organisationId: organisation.id });
        }
        return roleId;
      }
      async function user(roleId: string, firstName: string) {
        const email = `${firstName.toLowerCase()}-${randomUUID()}@example.test`;
        const userId = (await m.insert(User, {
          organisationId: organisation.id, email, passwordHash: await passwordHashing.hash(password), firstName, lastName: 'Test', status: UserStatus.ACTIVE,
        })).identifiers[0]!.id as string;
        await m.insert(UserRole, { userId, roleId, organisationId: organisation.id });
        return { email, userId };
      }
      const managerRoleId = await role('manager', MANAGER_PERMS);
      const vmRoleId = await role('venue_manager', VENUE_MANAGER_PERMS);
      manager = await user(managerRoleId, 'Manager');
      await m.query(`SELECT set_config('rab.user_id', $1, true)`, [manager.userId]);
      const workspace = await m.save(ManagerWorkspace, {
        organisationId: organisation.id, ownerUserId: manager.userId, name: `WS ${manager.userId}`, subdomain: `ma-${manager.userId.slice(0, 8)}`, status: 'active',
      });
      await insertMembership(m, organisation.id, manager.userId, workspace.id);
      await m.query(`INSERT INTO core.manager_profile (organisation_id, user_id, type, workspace_id) VALUES ($1, $2, $3, $4)`, [organisation.id, manager.userId, ManagerType.INTERNAL, workspace.id]);
      venueManager = await user(vmRoleId, 'VenueMgr');
      venueManagerProfileId = (await m.query(
        `INSERT INTO core.manager_profile (organisation_id, user_id, type, workspace_id) VALUES ($1, $2, $3, $4) RETURNING id`,
        [organisation.id, venueManager.userId, ManagerType.VENUE, workspace.id],
      ))[0].id;
      await insertMembership(m, organisation.id, venueManager.userId, workspace.id);
      workspaceId = workspace.id;
    });
    await adminDataSource.query(`INSERT INTO core.platform_admin (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [manager.userId]);
    let venue1!: Venue;
    let venue2!: Venue;
    await tenantContext.runInTenantContext({ organisationId: organisation.id, workspaceId, userId: manager.userId, role: '' }, async (m) => {
      venue1 = await m.save(Venue, { organisationId: organisation.id, name: 'Venue One', workspaceId, createdBy: manager.userId });
      venue2 = await m.save(Venue, { organisationId: organisation.id, name: 'Venue Two', workspaceId, createdBy: manager.userId });
    });
    return { organisation, manager, venueManager, venueManagerProfileId, venue1, venue2, workspaceId };
  }

  async function login(email: string, applicationTarget: string): Promise<string> {
    const res = await request(app.getHttpServer()).post('/rest/v1/auth/login').send({ email, password, applicationTarget });
    expect(res.status).toBe(200);
    return res.body.accessToken as string;
  }

  const http = () => request(app.getHttpServer());

  async function createShift(token: string, organisation: Organisation, venue: Venue, workspaceId: string, createdBy: string): Promise<string> {
    const jobRole = await tenantContext.runInTenantContext({ organisationId: organisation.id, workspaceId, userId: createdBy, role: '' }, (m) =>
      m.save(JobRole, { organisationId: organisation.id, name: `Role-${randomUUID()}`, defaultRatePence: 1200, workspaceId, createdBy }));
    const startsAt = new Date(Date.now() + 48 * HOUR);
    const created = await http().post('/rest/v1/shifts').set('Authorization', `Bearer ${token}`)
      .send({ venueId: venue.id, jobRoleId: jobRole.id, startsAt: startsAt.toISOString(), endsAt: new Date(startsAt.getTime() + 8 * HOUR).toISOString(), requiredCount: 1 });
    expect(created.status).toBe(201);
    expect((await http().post(`/rest/v1/shifts/${created.body.id}/publish`).set('Authorization', `Bearer ${token}`)).status).toBe(201);
    return created.body.id as string;
  }

  /**
   * One confirmed seat on venue1 (or `venue`), moved to the given scheduled window. `status` = an attendance row to
   * insert (clocked in 15 min after start, 30 min break), `assignment` = 'no_show' simulates the worker's provisional mark.
   */
  async function seedSeat(opts: {
    startsAt: Date; endsAt: Date; attendance?: string | null; clockOut?: boolean; assignment?: 'confirmed' | 'no_show'; venue?: 'venue1' | 'venue2'; breakMinutes?: number;
  }) {
    const seed = await seedOrg();
    const managerToken = await login(seed.manager.email, 'manager_web');
    const vmToken = await login(seed.venueManager.email, 'venue_manager_app');
    await http().post(`/rest/v1/managers/${seed.venueManagerProfileId}/venues`).set('Authorization', `Bearer ${managerToken}`).send({ venueId: seed.venue1.id });
    const shiftId = await createShift(managerToken, seed.organisation, opts.venue === 'venue2' ? seed.venue2 : seed.venue1, seed.workspaceId, seed.manager.userId);
    const staffRes = await http().post('/rest/v1/staff').set('Authorization', `Bearer ${managerToken}`)
      .send({ email: `staff-ma-${randomUUID()}@example.test`, firstName: 'Ava', lastName: 'Staff' });
    expect(staffRes.status).toBe(201);
    const staff = staffRes.body.id as string;
    await adminDataSource.query(`UPDATE core."user" SET status = 'active' WHERE id = (SELECT user_id FROM core.staff_profile WHERE id = $1)`, [staff]);
    await adminDataSource.query(`UPDATE core.staff_profile SET employment_status = 'active' WHERE id = $1`, [staff]);
    expect((await http().post(`/rest/v1/shifts/${shiftId}/offers`).set('Authorization', `Bearer ${managerToken}`).send({ staffProfileId: staff })).status).toBe(201);
    await adminDataSource.query(`UPDATE core.shift_assignment SET status = 'confirmed', confirmed_at = now() WHERE shift_id = $1`, [shiftId]);
    await adminDataSource.query(`UPDATE core.shift SET starts_at = $2, ends_at = $3, break_minutes = $4 WHERE id = $1`, [shiftId, opts.startsAt, opts.endsAt, opts.breakMinutes ?? 30]);
    await adminDataSource.query(`UPDATE core.shift_assignment SET period = tstzrange($2, $3, '[)'), break_minutes = NULL WHERE shift_id = $1`, [shiftId, opts.startsAt, opts.endsAt]);
    if (opts.assignment === 'no_show') await adminDataSource.query(`UPDATE core.shift_assignment SET status = 'no_show' WHERE shift_id = $1`, [shiftId]);
    let attendanceId: string | null = null;
    if (opts.attendance) {
      const [row] = await adminDataSource.query(
        `INSERT INTO core.attendance (organisation_id, workspace_id, shift_assignment_id, shift_id, staff_profile_id, clock_in_at, clock_out_at, status, break_minutes)
         SELECT sa.organisation_id, sa.workspace_id, sa.id, sa.shift_id, sa.staff_profile_id, s.starts_at + interval '15 minutes',
                CASE WHEN $2 THEN s.ends_at ELSE NULL END, $3, 30
           FROM core.shift_assignment sa JOIN core.shift s ON s.id = sa.shift_id WHERE sa.shift_id = $1 RETURNING id`,
        [shiftId, !!opts.clockOut, opts.attendance],
      );
      attendanceId = row.id;
      if (opts.clockOut) await adminDataSource.query(`UPDATE core.shift_assignment SET status = 'completed' WHERE shift_id = $1`, [shiftId]);
    }
    const [{ pay_rate_snapshot_pence: rate, id: assignmentId }] = await adminDataSource.query(`SELECT id, pay_rate_snapshot_pence FROM core.shift_assignment WHERE shift_id = $1`, [shiftId]);
    return { ...seed, managerToken, vmToken, shiftId, staff, attendanceId, assignmentId: assignmentId as string, rate: Number(rate) };
  }

  /** A shift that ended `endedAgo` ms ago and lasted 7 hours. */
  const endedAgo = (ms: number) => ({ startsAt: new Date(Date.now() - ms - 7 * HOUR), endsAt: new Date(Date.now() - ms) });
  const at = (base: Date, deltaMs: number) => new Date(base.getTime() + deltaMs).toISOString();

  const record = (token: string, shiftId: string, staffId: string, body: object) =>
    http().post(`/rest/v1/attendance/report/shift/${shiftId}/staff/${staffId}/record-attendance`).set('Authorization', `Bearer ${token}`).send(body);
  const confirmNoShow = (token: string, shiftId: string, staffId: string) =>
    http().post(`/rest/v1/attendance/report/shift/${shiftId}/staff/${staffId}/confirm-no-show`).set('Authorization', `Bearer ${token}`).send({});
  const reopenNoShow = (token: string, shiftId: string, staffId: string, reason: string) =>
    http().post(`/rest/v1/attendance/report/shift/${shiftId}/staff/${staffId}/reopen-no-show`).set('Authorization', `Bearer ${token}`).send({ reason });
  const reviewSeat = (token: string, shiftId: string, staffId: string) =>
    http().post(`/rest/v1/attendance/report/shift/${shiftId}/staff/${staffId}/attendance-review`).set('Authorization', `Bearer ${token}`);
  const finalise = (token: string, shiftId: string) =>
    http().patch(`/rest/v1/attendance/report/shift/${shiftId}/finalise`).set('Authorization', `Bearer ${token}`).send({ signedOffName: 'Venue Mgr', breakConfirmed: true });
  const reportOf = async (token: string, shiftId: string) => (await http().get(`/rest/v1/attendance/report/shift/${shiftId}`).set('Authorization', `Bearer ${token}`)).body;
  const attendanceRows = (shiftId: string) => adminDataSource.query(`SELECT * FROM core.attendance WHERE shift_id = $1`, [shiftId]);
  const corrections = (shiftId: string) =>
    adminDataSource.query(`SELECT ac.* FROM core.attendance_correction ac JOIN core.attendance a ON a.id = ac.attendance_id WHERE a.shift_id = $1 ORDER BY ac.field`, [shiftId]);
  const assignmentOf = async (shiftId: string) => (await adminDataSource.query(`SELECT status, attendance_reviewed_at, attendance_reviewed_by FROM core.shift_assignment WHERE shift_id = $1`, [shiftId]))[0];
  const auditCount = async (orgId: string, action: string) =>
    (await adminDataSource.query(`SELECT count(*)::int AS n FROM core.audit_log WHERE organisation_id = $1 AND action = $2`, [orgId, action]))[0].n as number;

  beforeAll(async () => {
    const bt = new BootstrapTimer('manual-attendance');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    bt.mark('init');
    bt.log();
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

  it('records attendance for a provisional no-show (both punches): manager-entered provenance, shared worked minutes, snapshot pay, correction + audit rows, review NOT completed', async () => {
    const w = endedAgo(2 * HOUR);
    const s = await seedSeat({ ...w, assignment: 'no_show' });
    const before = await reportOf(s.vmToken, s.shiftId);
    expect(before.staff[0]).toMatchObject({ assignmentStatus: 'no_show', noShowConfirmed: false, attendanceId: null, attendanceVersion: null, manuallyEntered: false });
    expect(before.reviewsRemaining).toBe(1);

    const clockIn = at(w.startsAt, 10 * MIN);
    const clockOut = at(w.endsAt, -5 * MIN);
    const res = await record(s.vmToken, s.shiftId, s.staff, { clockInAt: clockIn, clockOutAt: clockOut, breakMinutes: 30, reasonCode: 'forgot_clock_in' });
    expect(res.status).toBe(200);
    const seat = res.body.staff[0];
    const worked = 7 * 60 - 15 - 30; // span 405 min minus the 30 min unpaid break (@rab/shared duration rules)
    expect(seat).toMatchObject({
      assignmentStatus: 'completed', attendanceStatus: 'under_review', clockInAt: clockIn, clockOutAt: clockOut, breakMinutes: 30,
      workedMinutes: worked, manuallyEntered: true, corrected: true,
      attendanceReviewed: false, noShowConfirmed: false, locationVerified: false, clockOutMethod: 'manager_correction',
    });
    expect(typeof seat.attendanceVersion).toBe('string');
    // Wave 5 (owner rule: pay follows payroll.view): the Venue Manager never receives the seat's money — absent, not null.
    expect(seat).not.toHaveProperty('earnedPence');
    // Readiness recalculates from server state: resolved, but the review is still required.
    expect(res.body).toMatchObject({ ready: true, finalisable: false, reviewsRemaining: 1 });

    const [row] = await attendanceRows(s.shiftId);
    expect(Number(row.earned_pence)).toBe(payForMinutes(s.rate, worked));
    expect(row).toMatchObject({ status: 'under_review', clock_in_lat: null, clock_in_lng: null, location_verified: false, clock_out_method: 'manager_correction' });
    const rows = await corrections(s.shiftId);
    expect(rows.map((r: any) => [r.field, r.old_value, r.new_value, r.reason, r.corrected_by])).toEqual([
      ['breakMinutes', '', '30', 'Staff forgot to clock in', s.venueManager.userId],
      ['clockInAt', '', clockIn, 'Staff forgot to clock in', s.venueManager.userId],
      ['clockOutAt', '', clockOut, 'Staff forgot to clock in', s.venueManager.userId],
    ]);
    const [audit] = await adminDataSource.query(`SELECT actor_user_id, entity_id, metadata FROM core.audit_log WHERE organisation_id = $1 AND action = 'attendance.manager_recorded'`, [s.organisation.id]);
    expect(audit.actor_user_id).toBe(s.venueManager.userId);
    expect(audit.entity_id).toBe(row.id);
    expect(audit.metadata).toMatchObject({
      reasonCode: 'forgot_clock_in', supersededProvisionalNoShow: true,
      before: { assignmentStatus: 'no_show', clockInAt: null, clockOutAt: null }, after: { assignmentStatus: 'completed', clockInAt: clockIn, clockOutAt: clockOut, breakMinutes: 30 },
    });
  });

  it('staff forgot to clock in (seat still confirmed, worker not yet run): both times are required; created from confirmed → completed', async () => {
    const w = endedAgo(HOUR);
    const s = await seedSeat(w);
    const onlyOne = await record(s.vmToken, s.shiftId, s.staff, { clockInAt: at(w.startsAt, 0), reasonCode: 'forgot_clock_in' });
    expect(onlyOne.status).toBe(400);
    expect(onlyOne.body.message).toContain('both the clock-in and clock-out');
    const ok = await record(s.vmToken, s.shiftId, s.staff, { clockInAt: at(w.startsAt, 0), clockOutAt: at(w.endsAt, 0), reasonCode: 'app_issue' });
    expect(ok.status).toBe(200);
    // No break sent: the scheduled 30 min applies, and no break correction row is invented.
    expect(ok.body.staff[0]).toMatchObject({ assignmentStatus: 'completed', breakMinutes: null, workedMinutes: 7 * 60 - 30, manuallyEntered: true });
    expect((await corrections(s.shiftId)).map((r: any) => r.field)).toEqual(['clockInAt', 'clockOutAt']);
  });

  it('fills a missing clock-out on a partial record: only the missing field is written, the app clock-in is kept, the review must be redone', async () => {
    const w = endedAgo(2 * HOUR);
    const s = await seedSeat({ ...w, attendance: 'missing_clock_out' });
    const before = (await reportOf(s.vmToken, s.shiftId)).staff[0];
    expect(before).toMatchObject({ attendanceStatus: 'missing_clock_out', clockOutAt: null, manuallyEntered: false });
    const res = await record(s.vmToken, s.shiftId, s.staff, {
      clockInAt: before.clockInAt, clockOutAt: at(w.endsAt, 0), breakMinutes: 30, reasonCode: 'forgot_clock_out', expectedVersion: before.attendanceVersion,
    });
    expect(res.status).toBe(200);
    expect(res.body.staff[0]).toMatchObject({
      attendanceStatus: 'under_review', clockInAt: before.clockInAt, clockOutAt: at(w.endsAt, 0), workedMinutes: 7 * 60 - 15 - 30,
      clockOutMethod: 'manager_correction', manuallyEntered: false, attendanceReviewed: false,
    });
    const rows = await corrections(s.shiftId);
    expect(rows.map((r: any) => [r.field, r.old_value])).toEqual([['clockOutAt', '']]);
    expect(await auditCount(s.organisation.id, 'attendance.corrected')).toBe(1);
    // Without a clock-out the open record cannot be recovered.
    const s2 = await seedSeat({ ...w, attendance: 'missing_clock_out' });
    const v2 = (await reportOf(s2.vmToken, s2.shiftId)).staff[0].attendanceVersion;
    const noOut = await record(s2.vmToken, s2.shiftId, s2.staff, { clockInAt: at(w.startsAt, 5 * MIN), reasonCode: 'app_issue', expectedVersion: v2 });
    expect(noOut.status).toBe(409);
    expect(noOut.body.message).toContain('missing clock-out');
  });

  it('overnight shift: times across midnight are absolute instants', async () => {
    const startsAt = new Date('2026-03-10T22:00:00Z');
    const endsAt = new Date('2026-03-11T06:00:00Z');
    const s = await seedSeat({ startsAt, endsAt, assignment: 'no_show' });
    const res = await record(s.vmToken, s.shiftId, s.staff, { clockInAt: '2026-03-10T21:55:00Z', clockOutAt: '2026-03-11T06:10:00Z', breakMinutes: 30, reasonCode: 'venue_issue' });
    expect(res.status).toBe(200);
    expect(res.body.staff[0]).toMatchObject({ workedMinutes: 495 - 30, clockInAt: '2026-03-10T21:55:00.000Z', clockOutAt: '2026-03-11T06:10:00.000Z' });
  });

  it('Europe/London DST end (last Sunday of October): 22:00 BST → 06:00 GMT is nine real hours, not eight', async () => {
    // 2025-10-26 01:00 UTC: clocks go back. Wall clock 22:00 → 06:00 reads 8 h; elapsed time is 9 h.
    const startsAt = new Date('2025-10-25T21:00:00Z');
    const endsAt = new Date('2025-10-26T06:00:00Z');
    const s = await seedSeat({ startsAt, endsAt, assignment: 'no_show', breakMinutes: 0 });
    const res = await record(s.vmToken, s.shiftId, s.staff, { clockInAt: '2025-10-25T22:00:00+01:00', clockOutAt: '2025-10-26T06:00:00+00:00', breakMinutes: 0, reasonCode: 'app_issue' });
    expect(res.status).toBe(200);
    expect(res.body.staff[0]).toMatchObject({ clockInAt: '2025-10-25T21:00:00.000Z', clockOutAt: '2025-10-26T06:00:00.000Z', workedMinutes: 540 });
    expect(res.body.staff[0]).not.toHaveProperty('earnedPence'); // wave 5: VM has no payroll.view
    expect(Number((await attendanceRows(s.shiftId))[0].earned_pence)).toBe(payForMinutes(s.rate, 540));
  });

  it('rejects invalid times and bodies without writing anything', async () => {
    const w = endedAgo(2 * HOUR);
    const s = await seedSeat({ ...w, assignment: 'no_show' });
    const base = { reasonCode: 'app_issue' };
    const cases: Array<[object, number]> = [
      [{ ...base, clockInAt: at(w.startsAt, 60 * MIN), clockOutAt: at(w.startsAt, 30 * MIN) }, 400], // out before in
      [{ ...base, clockInAt: at(w.startsAt, 0), clockOutAt: at(w.startsAt, 0) }, 400], // zero span
      [{ ...base, clockInAt: at(w.startsAt, 0), clockOutAt: new Date(Date.now() + 10 * MIN).toISOString() }, 400], // future
      [{ ...base, clockInAt: at(w.startsAt, 0), clockOutAt: at(w.endsAt, 0), breakMinutes: -5 }, 400], // negative break
      [{ ...base, clockInAt: at(w.startsAt, 0), clockOutAt: at(w.startsAt, 60 * MIN), breakMinutes: 60 }, 400], // break >= span
      [{ ...base, clockInAt: at(w.startsAt, 0), clockOutAt: at(w.endsAt, 0), breakMinutes: 2000 }, 400], // oversized
      [{ ...base, clockInAt: at(w.startsAt, -16 * MIN), clockOutAt: at(w.endsAt, 0) }, 400], // before start − 15
      [{ ...base, clockInAt: at(w.startsAt, 0), clockOutAt: at(w.endsAt, 121 * MIN) }, 400], // after end + 120 (and future)
      [{ ...base, clockInAt: at(w.startsAt, 0).replace('Z', ''), clockOutAt: at(w.endsAt, 0) }, 400], // no offset
      [{ reasonCode: 'other', clockInAt: at(w.startsAt, 0), clockOutAt: at(w.endsAt, 0) }, 400], // Other without explanation
      [{ reasonCode: 'made_up', clockInAt: at(w.startsAt, 0), clockOutAt: at(w.endsAt, 0) }, 400],
      [{ ...base, clockInAt: at(w.startsAt, 0), clockOutAt: at(w.endsAt, 0), status: 'completed' }, 400], // mass assignment
      [{ ...base, clockInAt: at(w.startsAt, 0), clockOutAt: at(w.endsAt, 0), organisationId: randomUUID() }, 400],
    ];
    for (const [body, status] of cases) {
      const res = await record(s.vmToken, s.shiftId, s.staff, body);
      expect([JSON.stringify(body), res.status]).toEqual([JSON.stringify(body), status]);
    }
    const tooLate = await record(s.vmToken, s.shiftId, s.staff, { ...base, clockInAt: at(w.startsAt, 0), clockOutAt: at(w.endsAt, 121 * MIN) });
    expect(tooLate.body.code ?? tooLate.body.message).toBeTruthy();
    expect(await attendanceRows(s.shiftId)).toHaveLength(0);
    expect((await assignmentOf(s.shiftId)).status).toBe('no_show');
    // Window bound itself (not only "future"): a shift that ended 5 h ago, clock-out 121 min after its end.
    const old = endedAgo(5 * HOUR);
    const s2 = await seedSeat({ ...old, assignment: 'no_show' });
    const outside = await record(s2.vmToken, s2.shiftId, s2.staff, { ...base, clockInAt: at(old.startsAt, 0), clockOutAt: at(old.endsAt, 121 * MIN) });
    expect(outside.status).toBe(400);
    expect(outside.body.message).toContain('after the scheduled end');
    expect(outside.body.code).toBe('INVALID_ATTENDANCE_TIMES');
  });

  it('a duplicate submit is idempotent (sequential and concurrent): one attendance, one set of correction rows, one audit entry', async () => {
    const w = endedAgo(2 * HOUR);
    const s = await seedSeat({ ...w, assignment: 'no_show' });
    const body = { clockInAt: at(w.startsAt, 0), clockOutAt: at(w.endsAt, 0), breakMinutes: 20, reasonCode: 'app_issue' };
    const replies = await Promise.all([1, 2, 3].map(() => record(s.vmToken, s.shiftId, s.staff, body)));
    expect(replies.map((r) => r.status)).toEqual([200, 200, 200]);
    expect((await record(s.vmToken, s.shiftId, s.staff, body)).status).toBe(200);
    expect(await attendanceRows(s.shiftId)).toHaveLength(1);
    expect(await corrections(s.shiftId)).toHaveLength(3);
    expect(await auditCount(s.organisation.id, 'attendance.manager_recorded')).toBe(1);
    expect(await auditCount(s.organisation.id, 'attendance.corrected')).toBe(0);
  });

  it('concurrent different corrections with the same version: one wins, the other gets 409 (no lost update)', async () => {
    const w = endedAgo(2 * HOUR);
    const s = await seedSeat({ ...w, attendance: 'clocked_out', clockOut: true });
    const version = (await reportOf(s.vmToken, s.shiftId)).staff[0].attendanceVersion;
    const [a, b] = await Promise.all([
      record(s.vmToken, s.shiftId, s.staff, { clockOutAt: at(w.endsAt, -20 * MIN), reasonCode: 'venue_issue', expectedVersion: version }),
      record(s.vmToken, s.shiftId, s.staff, { clockOutAt: at(w.endsAt, -40 * MIN), reasonCode: 'venue_issue', expectedVersion: version }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.body.message).toContain('changed by someone else');
    expect(await corrections(s.shiftId)).toHaveLength(1);
    // A stale version is refused even sequentially; the current one is accepted.
    expect((await record(s.vmToken, s.shiftId, s.staff, { breakMinutes: 45, reasonCode: 'venue_issue', expectedVersion: version })).status).toBe(409);
    const fresh = (await reportOf(s.vmToken, s.shiftId)).staff[0].attendanceVersion;
    expect(fresh).not.toBe(version);
    expect((await record(s.vmToken, s.shiftId, s.staff, { breakMinutes: 45, reasonCode: 'venue_issue', expectedVersion: fresh })).status).toBe(200);
  });

  it('race: Record attendance vs Confirm no-show on the same seat — exactly one wins and the state is consistent', async () => {
    const w = endedAgo(2 * HOUR);
    const s = await seedSeat({ ...w, assignment: 'no_show' });
    const [rec, conf] = await Promise.all([
      record(s.vmToken, s.shiftId, s.staff, { clockInAt: at(w.startsAt, 0), clockOutAt: at(w.endsAt, 0), reasonCode: 'app_issue' }),
      confirmNoShow(s.vmToken, s.shiftId, s.staff),
    ]);
    expect([rec.status, conf.status].sort()).toEqual([200, 409]);
    const seat = await assignmentOf(s.shiftId);
    const rows = await attendanceRows(s.shiftId);
    if (rec.status === 200) {
      expect(seat).toMatchObject({ status: 'completed', attendance_reviewed_at: null });
      expect(rows).toHaveLength(1);
      expect(conf.body.message).toContain('Attendance has been recorded');
    } else {
      expect(seat.status).toBe('no_show');
      expect(seat.attendance_reviewed_at).not.toBeNull();
      expect(rows).toHaveLength(0);
      expect(rec.body.message).toContain('Reopen it');
    }
  });

  it('Confirm no-show: not before the grace, never over recorded attendance, idempotent, final (no hours or pay) and reopenable with a reason', async () => {
    // Started 10 minutes ago: too early to confirm.
    const early = await seedSeat({ startsAt: new Date(Date.now() - 10 * MIN), endsAt: new Date(Date.now() + 7 * HOUR) });
    const tooSoon = await confirmNoShow(early.vmToken, early.shiftId, early.staff);
    expect(tooSoon.status).toBe(409);
    expect(tooSoon.body.message).toContain('30 minutes after the scheduled start');

    // Worker has not flagged it yet but the grace passed: the manager's confirmation performs confirmed → no_show.
    const w = endedAgo(2 * HOUR);
    const s = await seedSeat(w);
    const confirmed = await confirmNoShow(s.vmToken, s.shiftId, s.staff);
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.staff[0]).toMatchObject({ assignmentStatus: 'no_show', noShowConfirmed: true, attendanceReviewed: true, workedMinutes: null });
    expect(confirmed.body.staff[0]).not.toHaveProperty('earnedPence');
    expect(confirmed.body).toMatchObject({ finalisable: true, reviewsRemaining: 0 });
    expect((await confirmNoShow(s.vmToken, s.shiftId, s.staff)).status).toBe(200); // idempotent
    expect(await auditCount(s.organisation.id, 'attendance.no_show_confirmed')).toBe(1);

    // A confirmed no-show cannot be overwritten by Record attendance; it must be reopened (reason required) first.
    const body = { clockInAt: at(w.startsAt, 0), clockOutAt: at(w.endsAt, 0), reasonCode: 'app_issue' };
    const blocked = await record(s.vmToken, s.shiftId, s.staff, body);
    expect(blocked.status).toBe(409);
    expect(blocked.body.message).toContain('Reopen it');
    expect((await reopenNoShow(s.vmToken, s.shiftId, s.staff, 'short')).status).toBe(400);
    const reopened = await reopenNoShow(s.vmToken, s.shiftId, s.staff, 'Staff arrived late; the bar manager confirmed it.');
    expect(reopened.status).toBe(200);
    expect(reopened.body.staff[0]).toMatchObject({ assignmentStatus: 'no_show', noShowConfirmed: false, attendanceReviewed: false });
    expect((await reopenNoShow(s.vmToken, s.shiftId, s.staff, 'Staff arrived late; the bar manager confirmed it.')).status).toBe(409); // nothing left to reopen
    const [audit] = await adminDataSource.query(`SELECT actor_user_id, metadata FROM core.audit_log WHERE organisation_id = $1 AND action = 'attendance.no_show_reopened'`, [s.organisation.id]);
    expect(audit).toMatchObject({ actor_user_id: s.venueManager.userId, metadata: expect.objectContaining({ reason: 'Staff arrived late; the bar manager confirmed it.' }) });
    expect((await record(s.vmToken, s.shiftId, s.staff, body)).status).toBe(200);

    // Valid recorded attendance is never overridden by a no-show confirmation.
    const refused = await confirmNoShow(s.vmToken, s.shiftId, s.staff);
    expect(refused.status).toBe(409);
    expect((await assignmentOf(s.shiftId)).status).toBe('completed');
  });

  it('Reopen no-show is refused once a replacement holds the freed seat (never more booked staff than required); allowed again when the seat frees up', async () => {
    const w = endedAgo(2 * HOUR);
    const s = await seedSeat(w);
    expect((await confirmNoShow(s.vmToken, s.shiftId, s.staff)).status).toBe(200);
    // The confirmed no-show freed the only seat; a replacement (another staff member) is now booked on it.
    const repl = await http().post('/rest/v1/staff').set('Authorization', `Bearer ${s.managerToken}`)
      .send({ email: `staff-repl-${randomUUID()}@example.test`, firstName: 'Rae', lastName: 'Replacement' });
    expect(repl.status).toBe(201);
    const [replacement] = await adminDataSource.query(
      `INSERT INTO core.shift_assignment (organisation_id, workspace_id, shift_id, staff_profile_id, status, pay_rate_snapshot_pence, confirmed_at, period)
       SELECT organisation_id, workspace_id, shift_id, $2, 'confirmed', pay_rate_snapshot_pence, now(), period FROM core.shift_assignment WHERE id = $1 RETURNING id`,
      [s.assignmentId, repl.body.id],
    );
    const why = 'Staff arrived late; the bar manager confirmed it.';
    const blocked = await reopenNoShow(s.vmToken, s.shiftId, s.staff, why);
    expect({ status: blocked.status, code: blocked.body.code }).toEqual({ status: 409, code: 'SEAT_TAKEN_BY_REPLACEMENT' });
    const [original] = await adminDataSource.query(`SELECT status, attendance_reviewed_at FROM core.shift_assignment WHERE id = $1`, [s.assignmentId]);
    expect(original.status).toBe('no_show');
    expect(original.attendance_reviewed_at).not.toBeNull();
    expect(await auditCount(s.organisation.id, 'attendance.no_show_reopened')).toBe(0);
    // The replacement booking is cancelled: the seat is free again, so the reopen is allowed.
    await adminDataSource.query(`UPDATE core.shift_assignment SET status = 'cancelled' WHERE id = $1`, [replacement.id]);
    expect((await reopenNoShow(s.vmToken, s.shiftId, s.staff, why)).status).toBe(200);
  });

  it('scope: another workspace\'s Venue Manager, a Venue Manager of another venue, and Staff are all refused without any write', async () => {
    const w = endedAgo(2 * HOUR);
    const s = await seedSeat({ ...w, assignment: 'no_show' });
    const body = { clockInAt: at(w.startsAt, 0), clockOutAt: at(w.endsAt, 0), reasonCode: 'app_issue' };

    // Same organisation, different workspace.
    const otherWs = await seedOrg(s.organisation);
    const otherWsVm = await login(otherWs.venueManager.email, 'venue_manager_app');
    // Another organisation.
    const otherOrg = await seedOrg();
    const otherOrgVm = await login(otherOrg.venueManager.email, 'venue_manager_app');
    for (const token of [otherWsVm, otherOrgVm]) {
      expect((await record(token, s.shiftId, s.staff, body)).status).toBe(404);
      expect((await confirmNoShow(token, s.shiftId, s.staff)).status).toBe(404);
      expect((await reopenNoShow(token, s.shiftId, s.staff, 'Trying to reopen another workspace seat')).status).toBe(404);
    }

    // Same workspace, shift at a venue this Venue Manager is not assigned to.
    const other = await seedSeat({ ...w, assignment: 'no_show', venue: 'venue2' });
    expect((await record(other.vmToken, other.shiftId, other.staff, body)).status).toBe(404);
    expect((await confirmNoShow(other.vmToken, other.shiftId, other.staff)).status).toBe(404);
    // An unknown staff member on an owned shift is also a plain 404.
    expect((await record(s.vmToken, s.shiftId, randomUUID(), body)).status).toBe(404);

    // Staff: their own app is refused by the route (application + permission), never reaching the service.
    await adminDataSource.query(`UPDATE core."user" SET password_hash = $2 WHERE id = (SELECT user_id FROM core.staff_profile WHERE id = $1)`, [s.staff, await passwordHashing.hash(password)]);
    const [{ email: staffEmail }] = await adminDataSource.query(`SELECT u.email FROM core."user" u JOIN core.staff_profile sp ON sp.user_id = u.id WHERE sp.id = $1`, [s.staff]);
    const staffLogin = await http().post('/rest/v1/auth/login').send({ email: staffEmail, password, applicationTarget: 'staff_app' });
    expect(staffLogin.status).toBe(200);
    const staffToken = staffLogin.body.accessToken as string;
    expect([403, 404]).toContain((await record(staffToken, s.shiftId, s.staff, body)).status);
    expect([403, 404]).toContain((await confirmNoShow(staffToken, s.shiftId, s.staff)).status);
    expect([403, 404]).toContain((await reopenNoShow(staffToken, s.shiftId, s.staff, 'Staff trying to reopen their own seat')).status);
    // The Internal Manager's web session is not the Venue Manager app: refused at the application boundary.
    expect([403, 404]).toContain((await record(s.managerToken, s.shiftId, s.staff, body)).status);

    expect(await attendanceRows(s.shiftId)).toHaveLength(0);
    expect(await assignmentOf(s.shiftId)).toMatchObject({ status: 'no_show', attendance_reviewed_at: null });
  });

  it('timesheet readiness and payroll follow server state; finalised reports refuse every attendance change (409)', async () => {
    const w = endedAgo(2 * HOUR);
    const s = await seedSeat({ ...w, assignment: 'no_show' });
    expect((await finalise(s.vmToken, s.shiftId)).status).toBe(409); // provisional no-show is not reviewed
    const recorded = await record(s.vmToken, s.shiftId, s.staff, { clockInAt: at(w.startsAt, 0), clockOutAt: at(w.endsAt, 0), breakMinutes: 30, reasonCode: 'app_issue' });
    expect(recorded.body).toMatchObject({ ready: true, finalisable: false, reviewsRemaining: 1 });
    const blocked = await finalise(s.vmToken, s.shiftId);
    expect(blocked.status).toBe(409);
    expect(blocked.body.message).toContain('1 attendance review remaining');
    const [{ id: attendanceId }] = await attendanceRows(s.shiftId);
    expect(await adminDataSource.query(`SELECT 1 FROM core.payroll_record WHERE attendance_id = $1`, [attendanceId])).toHaveLength(0);

    const reviewed = await reviewSeat(s.vmToken, s.shiftId, s.staff);
    expect(reviewed.body).toMatchObject({ finalisable: true, reviewsRemaining: 0 });
    expect((await finalise(s.vmToken, s.shiftId)).status).toBe(200);
    const [payroll] = await adminDataSource.query(`SELECT status, worked_minutes, amount_pence FROM core.payroll_record WHERE attendance_id = $1`, [attendanceId]);
    expect(payroll).toMatchObject({ status: 'pending_approval', worked_minutes: 7 * 60 - 30 });
    expect(Number(payroll.amount_pence)).toBe(payForMinutes(s.rate, 7 * 60 - 30));

    const version = (await reportOf(s.vmToken, s.shiftId)).staff[0].attendanceVersion;
    const after = await record(s.vmToken, s.shiftId, s.staff, { breakMinutes: 10, reasonCode: 'app_issue', expectedVersion: version });
    expect(after.status).toBe(409);
    expect(after.body.message).toContain('finalised');
    expect((await confirmNoShow(s.vmToken, s.shiftId, s.staff)).status).toBe(409);
    const [row] = await attendanceRows(s.shiftId);
    expect(row).toMatchObject({ status: 'approved', break_minutes: 30 });

    // A confirmed no-show produces no hours and no payroll record.
    const ns = await seedSeat({ ...w, assignment: 'no_show' });
    expect((await confirmNoShow(ns.vmToken, ns.shiftId, ns.staff)).status).toBe(200);
    expect((await finalise(ns.vmToken, ns.shiftId)).status).toBe(200);
    expect(await adminDataSource.query(`SELECT 1 FROM core.payroll_record WHERE shift_id = $1`, [ns.shiftId])).toHaveLength(0);
    expect((await reopenNoShow(ns.vmToken, ns.shiftId, ns.staff, 'Trying to reopen after finalisation')).status).toBe(409);
  });
});
