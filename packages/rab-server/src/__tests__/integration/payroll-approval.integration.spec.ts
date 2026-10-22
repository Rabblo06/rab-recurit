import 'reflect-metadata';

import { payForMinutes, PermissionFlag } from '@rab/shared';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { AuthContext } from '../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { AttendanceQrService } from '../../modules/attendance/services/attendance-qr.service';
import { ROLE_DEFS } from '../../modules/manager/services/manager.service';
import { Shift } from '../../modules/scheduling/entities/shift.entity';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Payroll approval (PayrollRecord1786718800000, owner rule 2026-10-20): Clock out -> report finalised (attendance
 * approved) -> payroll_record pending_approval -> a workspace manager holding payroll.approve approves -> only then
 * the staff member's History projection carries payrollStatus approved + payrollApprovedPence. Real HTTP, real
 * PostgreSQL with RLS on (crewflow_app), no mocks. The scenarios below share one world and run in order.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

jest.setTimeout(240_000);

describeIfDb('payroll approval (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let factory: TestIdentityFactory;
  let tenantContext: TenantContextService;
  let attendanceQr: AttendanceQrService;

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const RATE_PENCE = 1337; // odd rate so rounding is exercised
  const WORKED_TARGET_MINUTES = 247;
  // Owner decision 2026-10-20 (ManagerPayrollApproveDefault1786718900000): the production Manager role holds payroll.approve.
  const NO_APPROVE_PERMS = ROLE_DEFS.internal!.permissions.filter((p) => p !== PermissionFlag.PAYROLL_APPROVE);

  // org 1: approver A (own workspace) + manager B (same org & role, own workspace) + Venue Manager + five staff of A.
  let orgId: string;
  let a: TestIdentity;
  let b: TestIdentity;
  let vm: TestIdentity;
  let staff: TestIdentity[];
  let tokenA: string;
  let tokenB: string;
  let tokenVm: string;
  let staffTokens: string[];
  let venueId: string;
  let jobRoleId: string;
  // org 2: a manager holding the production set only (payroll.view, NOT payroll.approve).
  let plain: TestIdentity;
  let tokenPlain: string;

  interface Worked { shiftId: string; attendanceId: string; workedMinutes: number; earnedPence: number }
  const worked: Record<string, Worked> = {};

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    dataSource = moduleRef.get(DataSource);
    tenantContext = moduleRef.get(TenantContextService);
    attendanceQr = moduleRef.get(AttendanceQrService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = new TestIdentityFactory({ app, dataSource, adminDataSource, tenantContext, passwordHashing: moduleRef.get(PasswordHashingService) });

    const seeded = await factory.createOrganisationWithManagers(2, { workspace: true, permissions: 'production', label: 'payroll' });
    orgId = seeded.organisation.id;
    [a, b] = seeded.managers as [TestIdentity, TestIdentity];
    staff = [];
    for (let i = 0; i < 6; i++) staff.push(await factory.createStaff(seeded.organisation, { owner: a, label: `payroll-s${i}` }));
    // Offerable staff (the factory default employment status is not ACTIVE).
    await adminDataSource.query(`UPDATE core.staff_profile SET employment_status = 'active' WHERE id = ANY($1::uuid[])`, [staff.map((s) => s.profileId)]);
    [tokenA, tokenB] = [await factory.login(a), await factory.login(b)];
    staffTokens = [];
    for (const s of staff) staffTokens.push(await factory.login(s));

    const venue = await http().post('/rest/v1/venues').set(auth(tokenA)).send({ name: `Payroll Venue ${randomUUID().slice(0, 6)}`, type: 'hotel' });
    expect(venue.status).toBe(201);
    venueId = venue.body.id;
    const role = await http().post('/rest/v1/job-roles').set(auth(tokenA)).send({ name: `Role-${randomUUID()}`, defaultRatePence: RATE_PENCE });
    expect(role.status).toBe(201);
    jobRoleId = role.body.id;
    vm = await factory.createVenueManager(seeded.organisation, { owner: a, venueIds: [venueId], label: 'payroll-vm' });
    tokenVm = await factory.login(vm);

    const org2 = await factory.createOrganisationWithManagers(1, { workspace: true, permissions: NO_APPROVE_PERMS, label: 'payroll-plain' });
    plain = org2.managers[0]!;
    tokenPlain = await factory.login(plain);
  });

  afterAll(async () => {
    await app?.close();
    await adminDataSource?.destroy();
  });

  // ------------------------------------------------------------------ helpers

  async function signQr(shiftId: string): Promise<string> {
    return tenantContext.runInTenantContext({ organisationId: orgId, workspaceId: a.workspaceId, userId: a.userId, role: '' }, async (m) =>
      attendanceQr.sign(await m.findOneByOrFail(Shift, { id: shiftId })));
  }

  /** Shift started 5 minutes ago -> offer -> accept -> confirm -> clock in -> clock out -> manager corrects clock-in so the worked time is real. */
  async function workShift(staffIndex: number): Promise<Worked> {
    const s = staff[staffIndex]!;
    const token = staffTokens[staffIndex]!;
    const startsAt = new Date(Date.now() - 5 * 60_000);
    const endsAt = new Date(Date.now() + 8 * 3600_000);
    const shift = await http().post('/rest/v1/shifts').set(auth(tokenA))
      .send({ venueId, jobRoleId, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), requiredCount: 1 });
    expect(shift.status).toBe(201);
    const shiftId = shift.body.id as string;
    expect((await http().post(`/rest/v1/shifts/${shiftId}/publish`).set(auth(tokenA))).status).toBe(201);
    const offer = await http().post(`/rest/v1/shifts/${shiftId}/offers`).set(auth(tokenA)).send({ staffProfileId: s.profileId });
    expect({ status: offer.status, body: offer.body }).toMatchObject({ status: 201 });
    expect((await http().post(`/rest/v1/offers/${offer.body.id}/accept`).set(auth(token))).status).toBe(201);
    expect((await http().post(`/rest/v1/offers/${offer.body.id}/confirm`).set(auth(tokenA))).status).toBe(201);
    // Check In (arrival) is required before Clock In for bookings made after 1786719450000.
    expect((await http().post('/rest/v1/attendance/check-in').set(auth(token)).send({ shiftId })).status).toBe(200);
    const inRes = await http().post('/rest/v1/attendance/clock-in').set(auth(token)).send({ shiftId, qrToken: await signQr(shiftId) });
    expect(inRes.status).toBe(201);
    const outRes = await http().post('/rest/v1/attendance/clock-out').set(auth(token)).send({ qrToken: await signQr(shiftId) });
    expect(outRes.status).toBe(201);
    const attendanceId = outRes.body.id as string;
    const clockOutAt = new Date(outRes.body.clockOutAt).getTime();
    const corrected = await http().post(`/rest/v1/attendance/${attendanceId}/correct`).set(auth(tokenA))
      .send({ field: 'clockInAt', newValue: new Date(clockOutAt - WORKED_TARGET_MINUTES * 60_000).toISOString(), reason: 'Payroll test: real worked time' });
    expect(corrected.status).toBe(201);
    return { shiftId, attendanceId, workedMinutes: corrected.body.workedMinutes, earnedPence: corrected.body.earnedPence };
  }

  async function reviewAndFinalise(w: Worked, staffIndex: number, token = tokenA): Promise<void> {
    const reviewed = await http().post(`/rest/v1/attendance/report/shift/${w.shiftId}/staff/${staff[staffIndex]!.profileId}/attendance-review`).set(auth(token));
    expect(reviewed.status).toBe(200);
    const fin = await http().patch(`/rest/v1/attendance/report/shift/${w.shiftId}/finalise`).set(auth(token));
    expect({ status: fin.status, body: fin.body }).toMatchObject({ status: 200, body: { reportStatus: 'finalised' } });
  }

  const recordFor = async (attendanceId: string) =>
    (await adminDataSource.query(`SELECT * FROM core.payroll_record WHERE attendance_id = $1`, [attendanceId]))[0] as Record<string, any> | undefined;

  const historyRow = async (staffIndex: number, attendanceId: string) => {
    const res = await http().get('/rest/v1/attendance/me/history').set(auth(staffTokens[staffIndex]!));
    expect(res.status).toBe(200);
    return (res.body as Array<Record<string, unknown>>).find((r) => r.id === attendanceId);
  };

  const managerCtx = (identity: TestIdentity): AuthContext =>
    ({ organisationId: orgId, workspaceId: identity.workspaceId, userId: identity.userId, role: '' }) as AuthContext;

  // ------------------------------------------------------------------ the flow

  it('(1) clock-out alone creates no payroll: staff projection carries payrollStatus null and payrollApprovedPence null', async () => {
    worked.s0 = await workShift(0);
    expect(worked.s0.workedMinutes).toBeGreaterThan(0);
    expect(await recordFor(worked.s0.attendanceId)).toBeUndefined();
    const row = await historyRow(0, worked.s0.attendanceId);
    expect(row).toMatchObject({ payrollStatus: null, payrollApprovedPence: null });
    const active = await http().get('/rest/v1/attendance/me/active').set(auth(staffTokens[0]!));
    expect(active.status).toBe(200);
    expect(active.body.attendance).toBeNull();
  });

  it('(2) finalising the report creates exactly one pending_approval record with the frozen attendance snapshot', async () => {
    await reviewAndFinalise(worked.s0!, 0);
    const rec = await recordFor(worked.s0!.attendanceId);
    expect(rec).toMatchObject({
      status: 'pending_approval', organisation_id: orgId, workspace_id: a.workspaceId, shift_id: worked.s0!.shiftId,
      staff_profile_id: staff[0]!.profileId, worked_minutes: worked.s0!.workedMinutes, approved_at: null, approved_by: null,
    });
    expect(Number(rec!.amount_pence)).toBe(worked.s0!.earnedPence);
    const row = await historyRow(0, worked.s0!.attendanceId);
    expect(row).toMatchObject({ status: 'approved', payrollStatus: 'pending_approval', payrollApprovedPence: null });
    const list = await http().get('/rest/v1/payroll/records').set(auth(tokenA));
    expect(list.status).toBe(200);
    const listed = list.body.data.find((r: { attendanceId: string }) => r.attendanceId === worked.s0!.attendanceId);
    expect(listed).toMatchObject({ status: 'pending_approval', staffProfileId: staff[0]!.profileId, ownHours: false });
    expect(list.body.counts.pending_approval).toBeGreaterThanOrEqual(1);
    const audit = await adminDataSource.query(
      `SELECT metadata FROM core.audit_log WHERE organisation_id = $1 AND action = 'attendance.report_finalised' AND metadata->>'shiftId' = $2`, [orgId, worked.s0!.shiftId]);
    expect(audit[0].metadata.payrollRecords).toBe(1);
  });

  it('(7) amounts are integer pence: rate snapshot x worked minutes, rounded once (payForMinutes), equal to the attendance figure', async () => {
    const rec = (await recordFor(worked.s0!.attendanceId))!;
    const [{ rate }] = await adminDataSource.query(
      `SELECT sa.pay_rate_snapshot_pence AS rate FROM core.attendance a JOIN core.shift_assignment sa ON sa.id = a.shift_assignment_id WHERE a.id = $1`, [worked.s0!.attendanceId]);
    expect(Number(rate)).toBe(RATE_PENCE);
    expect(Number(rec.pay_rate_pence)).toBe(RATE_PENCE);
    const minutes = Number(rec.worked_minutes);
    // Independent BigInt half-up rounding, then the shared helper: both must agree with the stored bigint.
    const expected = (BigInt(RATE_PENCE) * BigInt(minutes) * 2n + 60n) / 120n;
    expect(BigInt(rec.amount_pence)).toBe(expected);
    expect(Number(rec.amount_pence)).toBe(payForMinutes(RATE_PENCE, minutes));
    expect(Number.isInteger(Number(rec.amount_pence))).toBe(true);
  });

  it('(5) another workspace manager (same org, holds payroll.approve) gets 404 and never sees the record', async () => {
    const id = (await recordFor(worked.s0!.attendanceId))!.id as string;
    expect((await http().post(`/rest/v1/payroll/records/${id}/approve`).set(auth(tokenB))).status).toBe(404);
    expect((await http().post(`/rest/v1/payroll/records/${id}/reject`).set(auth(tokenB)).send({ reason: 'Not mine to reject' })).status).toBe(404);
    const crossBulk = await http().post('/rest/v1/payroll/records/bulk-approve').set(auth(tokenB)).send({ ids: [id] });
    expect(crossBulk.status).toBe(200);
    expect(crossBulk.body).toEqual({ approved: [], blocked: [{ id, reason: 'not_found', message: expect.any(String) }] });
    const list = await http().get('/rest/v1/payroll/records').set(auth(tokenB));
    expect(list.status).toBe(200);
    expect(list.body.data.map((r: { id: string }) => r.id)).not.toContain(id);
    expect((await recordFor(worked.s0!.attendanceId))!.status).toBe('pending_approval');
  });

  it('(5) a manager without payroll.approve is refused (403); staff and Venue Manager sessions are refused (403)', async () => {
    const id = (await recordFor(worked.s0!.attendanceId))!.id as string;
    expect((await http().post(`/rest/v1/payroll/records/${id}/approve`).set(auth(tokenPlain))).status).toBe(403);
    expect((await http().get('/rest/v1/payroll/records').set(auth(tokenPlain))).status).toBe(200); // payroll.view only
    const staffRes = await http().post(`/rest/v1/payroll/records/${id}/approve`).set(auth(staffTokens[0]!));
    expect(staffRes.status).toBe(403);
    expect((await http().get('/rest/v1/payroll/records').set(auth(staffTokens[0]!))).status).toBe(403);
    expect((await http().post(`/rest/v1/payroll/records/${id}/approve`).set(auth(tokenVm))).status).toBe(403);
    expect((await http().get('/rest/v1/payroll/records').set(auth(tokenVm))).status).toBe(403);
    expect((await recordFor(worked.s0!.attendanceId))!.status).toBe('pending_approval');
    const caps = await http().get('/rest/v1/auth/capabilities').set(auth(tokenPlain));
    expect(caps.body).toMatchObject({ 'payroll.view': true, 'payroll.approve': false });
    expect((await http().get('/rest/v1/auth/capabilities').set(auth(tokenA))).body['payroll.approve']).toBe(true);
  });

  it('owner default: the production Manager role (Initial + Internal Managers) holds payroll.approve; Venue Manager and Staff roles do not', async () => {
    expect(ROLE_DEFS.internal!.permissions).toContain(PermissionFlag.PAYROLL_APPROVE);
    expect(ROLE_DEFS.venue!.permissions).not.toContain(PermissionFlag.PAYROLL_APPROVE);
    const held = await adminDataSource.query(
      `SELECT r.key, bool_or(p.key = 'payroll.approve') AS approve FROM core.role r
         LEFT JOIN core.role_permission rp ON rp.role_id = r.id LEFT JOIN core.permission p ON p.id = rp.permission_id
        WHERE r.organisation_id = $1 GROUP BY r.key ORDER BY r.key`, [orgId]);
    expect(held).toEqual([
      { key: 'manager', approve: true },
      { key: 'staff', approve: false },
      { key: 'venue_manager', approve: false },
    ]);
    // A is an ordinary (non-Initial) Internal Manager.
    const [profile] = await adminDataSource.query(`SELECT type, is_initial_manager FROM core.manager_profile WHERE user_id = $1`, [a.userId]);
    expect(profile).toEqual({ type: 'internal', is_initial_manager: false });
    expect((await http().get('/rest/v1/auth/capabilities').set(auth(tokenVm))).body['payroll.approve']).toBe(false);
  });

  it('(3) approve: a non-Initial Internal Manager approves in their own workspace — 200, audited, and only now staff history carries payrollStatus approved + payrollApprovedPence', async () => {
    const id = (await recordFor(worked.s0!.attendanceId))!.id as string;
    const res = await http().post(`/rest/v1/payroll/records/${id}/approve`).set(auth(tokenA));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id, status: 'approved', approvedByName: 'Manager Test', amountPence: worked.s0!.earnedPence });
    const rec = (await recordFor(worked.s0!.attendanceId))!;
    expect(rec).toMatchObject({ status: 'approved', approved_by: a.userId, statement_status: 'pending', statement_file_id: null, statement_notified_at: null });
    expect(res.body.statement).toEqual({ state: 'processing', fileId: null, filename: null, generatedAt: null, notifiedAt: null });
    expect(rec.approved_at).not.toBeNull();
    const row = await historyRow(0, worked.s0!.attendanceId);
    expect(row).toMatchObject({ payrollStatus: 'approved', payrollApprovedPence: worked.s0!.earnedPence });
    expect(typeof row!.payrollApprovedPence).toBe('number');
    const audit = await adminDataSource.query(
      `SELECT actor_user_id, metadata FROM core.audit_log WHERE organisation_id = $1 AND action = 'payroll_record.approved' AND entity_id = $2`, [orgId, id]);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_user_id: a.userId, metadata: expect.objectContaining({ amountPence: worked.s0!.earnedPence, bulk: false }) });
  });

  it('(9) invalid transitions are 409: approve twice, reject an approved record', async () => {
    const id = (await recordFor(worked.s0!.attendanceId))!.id as string;
    expect((await http().post(`/rest/v1/payroll/records/${id}/approve`).set(auth(tokenA))).status).toBe(409);
    expect((await http().post(`/rest/v1/payroll/records/${id}/reject`).set(auth(tokenA)).send({ reason: 'Too late to reject' })).status).toBe(409);
    expect((await recordFor(worked.s0!.attendanceId))!.status).toBe('approved');
    const audits = await adminDataSource.query(`SELECT count(*)::int AS n FROM core.audit_log WHERE entity_id = $1`, [id]);
    expect(audits[0].n).toBe(1);
  });

  it('(4) reject: reason required, audited, never approved in the staff projection; a rejected record cannot be re-rejected or approved', async () => {
    worked.s1 = await workShift(1);
    await reviewAndFinalise(worked.s1, 1);
    const id = (await recordFor(worked.s1.attendanceId))!.id as string;
    expect((await http().post(`/rest/v1/payroll/records/${id}/reject`).set(auth(tokenA)).send({})).status).toBe(400);
    expect((await http().post(`/rest/v1/payroll/records/${id}/reject`).set(auth(tokenA)).send({ reason: 'x' })).status).toBe(400);
    expect((await http().post(`/rest/v1/payroll/records/${id}/reject`).set(auth(tokenA)).send({ reason: 'Hours disputed', status: 'approved' })).status).toBe(400);
    expect((await http().post(`/rest/v1/payroll/records/${id}/reject`).set(auth(tokenA)).send({ reason: 'Hours disputed', organisationId: randomUUID() })).status).toBe(400);
    const res = await http().post(`/rest/v1/payroll/records/${id}/reject`).set(auth(tokenA)).send({ reason: '  Hours disputed by venue  ' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'rejected', rejectionReason: 'Hours disputed by venue', rejectedByName: 'Manager Test' });
    const row = await historyRow(1, worked.s1.attendanceId);
    expect(row).toMatchObject({ payrollStatus: 'rejected', payrollApprovedPence: null });
    expect((await http().post(`/rest/v1/payroll/records/${id}/approve`).set(auth(tokenA))).status).toBe(409);
    expect((await http().post(`/rest/v1/payroll/records/${id}/reject`).set(auth(tokenA)).send({ reason: 'Again' })).status).toBe(409);
    const audit = await adminDataSource.query(`SELECT metadata FROM core.audit_log WHERE action = 'payroll_record.rejected' AND entity_id = $1`, [id]);
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata.reason).toBe('Hours disputed by venue');
  });

  it('(8) approving one record never approves another; bulk approve reports per-id results and never approves an ineligible id', async () => {
    worked.s2 = await workShift(2);
    await reviewAndFinalise(worked.s2, 2);
    // A Venue Manager linked to the venue finalises s3's report: the record is still created (insert-only for them).
    worked.s3 = await workShift(3);
    await reviewAndFinalise(worked.s3, 3, tokenVm);
    const id2 = (await recordFor(worked.s2.attendanceId))!.id as string;
    const id3 = (await recordFor(worked.s3.attendanceId))!.id as string;
    const id0 = (await recordFor(worked.s0!.attendanceId))!.id as string; // approved
    const id1 = (await recordFor(worked.s1!.attendanceId))!.id as string; // rejected
    expect((await recordFor(worked.s3.attendanceId))!.status).toBe('pending_approval');

    // Single approve of s2 leaves s3 pending.
    expect((await http().post(`/rest/v1/payroll/records/${id2}/approve`).set(auth(tokenA))).status).toBe(200);
    expect((await recordFor(worked.s3.attendanceId))!.status).toBe('pending_approval');
    expect((await historyRow(3, worked.s3.attendanceId))).toMatchObject({ payrollStatus: 'pending_approval', payrollApprovedPence: null });

    // Malformed batches are refused outright (DTO) and touch nothing.
    expect((await http().post('/rest/v1/payroll/records/bulk-approve').set(auth(tokenA)).send({ ids: [id3, 'not-a-uuid'] })).status).toBe(400);
    expect((await http().post('/rest/v1/payroll/records/bulk-approve').set(auth(tokenA)).send({ ids: [id3, id3] })).status).toBe(400);
    expect((await http().post('/rest/v1/payroll/records/bulk-approve').set(auth(tokenA)).send({ ids: [] })).status).toBe(400);
    expect((await http().post('/rest/v1/payroll/records/bulk-approve').set(auth(tokenA)).send({ ids: [id3], status: 'approved' })).status).toBe(400);
    expect((await recordFor(worked.s3.attendanceId))!.status).toBe('pending_approval');

    // Mixed selection: each id authorised on its own; only eligible ids are approved, the rest are reported back.
    worked.s4 = await workShift(4);
    await reviewAndFinalise(worked.s4, 4);
    const id4 = (await recordFor(worked.s4.attendanceId))!.id as string;
    const unknown = randomUUID();
    const attendanceIdNotARecord = worked.s2.attendanceId; // an attendance id is never an approvable payroll record id
    const bulk = await http().post('/rest/v1/payroll/records/bulk-approve').set(auth(tokenA)).send({ ids: [id3, unknown, id0, id1, id4, attendanceIdNotARecord] });
    expect(bulk.status).toBe(200);
    expect(bulk.body.approved.map((r: { id: string; status: string; statement: { state: string } }) => [r.id, r.status, r.statement.state]).sort())
      .toEqual([[id3, 'approved', 'processing'], [id4, 'approved', 'processing']].sort());
    const NF = "Payroll can't be approved until verified hours and pay are available.";
    const NR = 'This payroll record is not ready for approval.';
    expect(bulk.body.blocked).toEqual([
      { id: unknown, reason: 'not_found', message: NF },
      { id: id0, reason: 'not_ready', message: NR },
      { id: id1, reason: 'not_ready', message: NR },
      { id: attendanceIdNotARecord, reason: 'not_found', message: NF },
    ]);
    expect((await recordFor(worked.s1!.attendanceId))!.status).toBe('rejected');
    const audits = await adminDataSource.query(
      `SELECT count(*)::int AS n FROM core.audit_log WHERE action = 'payroll_record.approved' AND entity_id::text = ANY($1::text[]) AND (metadata->>'bulk')::boolean`, [[id3, id4]]);
    expect(audits[0].n).toBe(2);
    // Re-sending the same batch approves nothing new.
    const again = await http().post('/rest/v1/payroll/records/bulk-approve').set(auth(tokenA)).send({ ids: [id3, id4] });
    expect(again.body.approved).toEqual([]);
    expect(again.body.blocked.map((b: { reason: string }) => b.reason)).toEqual(['not_ready', 'not_ready']);
    expect(await historyRow(3, worked.s3.attendanceId)).toMatchObject({ payrollStatus: 'approved', payrollApprovedPence: worked.s3.earnedPence });
  });

  it('(6) staff only ever read their OWN payroll record (RLS + API); Venue Managers read none', async () => {
    // API: staff 0's history never contains another staff member's attendance or payroll figures.
    const history0 = await http().get('/rest/v1/attendance/me/history').set(auth(staffTokens[0]!));
    expect(history0.body.map((r: { id: string }) => r.id)).toEqual([worked.s0!.attendanceId]);
    // RLS: bound as staff 0, the payroll table shows exactly their own row.
    const asStaff0 = await tenantContext.runInWorkspaceContext(
      { organisationId: orgId, workspaceId: staff[0]!.workspaceId, userId: staff[0]!.userId, role: '' } as AuthContext,
      (m) => m.query(`SELECT attendance_id FROM payroll_record`));
    expect(asStaff0.map((r: { attendance_id: string }) => r.attendance_id)).toEqual([worked.s0!.attendanceId]);
    // Directly naming another staff member's record id still returns nothing.
    const other = await tenantContext.runInWorkspaceContext(
      { organisationId: orgId, workspaceId: staff[0]!.workspaceId, userId: staff[0]!.userId, role: '' } as AuthContext,
      (m) => m.query(`SELECT id FROM payroll_record WHERE attendance_id = $1`, [worked.s2!.attendanceId]));
    expect(other).toEqual([]);
    const asVm = await tenantContext.runInWorkspaceContext(
      { organisationId: orgId, workspaceId: vm.workspaceId, userId: vm.userId, role: '' } as AuthContext,
      (m) => m.query(`SELECT id FROM payroll_record`));
    expect(asVm).toEqual([]);
    const asManagerB = await tenantContext.runInWorkspaceContext(managerCtx(b), (m) => m.query(`SELECT id FROM payroll_record`));
    expect(asManagerB).toEqual([]);
  });

  it('staff pay statements: GET /payroll/me/statements lists only the caller own approved records; managers and Venue Managers cannot use it', async () => {
    const mine = await http().get('/rest/v1/payroll/me/statements').set(auth(staffTokens[3]!));
    expect(mine.status).toBe(200);
    expect(mine.body).toEqual({
      total: 1,
      data: [{
        payrollRecordId: (await recordFor(worked.s3!.attendanceId))!.id, status: 'approved', attendanceId: worked.s3!.attendanceId, shiftId: worked.s3!.shiftId,
        venueName: expect.any(String), roleName: expect.any(String), startsAt: expect.any(String), endsAt: expect.any(String),
        workedMinutes: worked.s3!.workedMinutes, payRatePence: RATE_PENCE, amountPence: worked.s3!.earnedPence, approvedAt: expect.any(String), payrollPeriod: null, payday: null, allocationStatus: 'unallocated',
        statement: { state: 'processing', fileId: null, filename: null, generatedAt: null, notifiedAt: null },
      }],
    });
    // Rejected (s1) never appears.
    expect((await http().get('/rest/v1/payroll/me/statements').set(auth(staffTokens[1]!))).body).toEqual({ total: 0, data: [] });
    expect((await http().get('/rest/v1/payroll/me/statements').set(auth(tokenA))).status).toBe(403);
    expect((await http().get('/rest/v1/payroll/me/statements').set(auth(tokenVm))).status).toBe(403);
    expect((await http().get('/rest/v1/payroll/me/statements?staffProfileId=' + staff[0]!.profileId).set(auth(staffTokens[3]!))).status).toBe(400);
  });

  it('period read model: this workspace only, verified figures only, stage derived from real rows', async () => {
    const month = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit' }).format(new Date()).slice(0, 7);
    const res = await http().get(`/rest/v1/payroll/period?month=${month}`).set(auth(tokenA));
    expect(res.status).toBe(200);
    const byAttendance = new Map<string, Record<string, unknown>>(res.body.rows.map((r: { attendanceId: string }) => [r.attendanceId, r]));
    expect(byAttendance.get(worked.s0!.attendanceId)).toMatchObject({ stage: 'completed', payrollStatus: 'approved', amountPence: worked.s0!.earnedPence, workedMinutes: worked.s0!.workedMinutes });
    expect(byAttendance.get(worked.s1!.attendanceId)).toMatchObject({ stage: 'rejected' });
    // A clocked-out attendance with no payroll record yet: in progress, no record id, no figures.
    const extra = await workShift(5);
    const again = await http().get(`/rest/v1/payroll/period?month=${month}`).set(auth(tokenA));
    expect(again.body.rows.find((r: { attendanceId: string }) => r.attendanceId === extra.attendanceId))
      .toMatchObject({ stage: 'in_progress', payrollRecordId: null, payrollStatus: null, workedMinutes: null, amountPence: null, payRatePence: null, statement: null });
    // Other workspace manager: empty; Venue Manager refused; bad month 400.
    expect((await http().get(`/rest/v1/payroll/period?month=${month}`).set(auth(tokenB))).body.rows).toEqual([]);
    expect((await http().get(`/rest/v1/payroll/period?month=${month}`).set(auth(tokenVm))).status).toBe(403);
    expect((await http().get('/rest/v1/payroll/period?month=2026-13').set(auth(tokenA))).status).toBe(400);
    // The extra attendance stays unapprovable: its id is not a payroll record.
    const tryIt = await http().post('/rest/v1/payroll/records/bulk-approve').set(auth(tokenA)).send({ ids: [extra.attendanceId] });
    expect(tryIt.body).toMatchObject({ approved: [], blocked: [{ reason: 'not_found' }] });
    expect((await http().post(`/rest/v1/payroll/records/${extra.attendanceId}/approve`).set(auth(tokenA))).status).toBe(404);
  });

  it('humans can never record a generated statement or a notification (RLS)', async () => {
    await expect(tenantContext.runInWorkspaceContext(managerCtx(a), (m) => m.query(
      `UPDATE payroll_record SET statement_status = 'failed' WHERE attendance_id = $1`, [worked.s3!.attendanceId]))).rejects.toMatchObject({ code: '42501' });
    await expect(tenantContext.runInWorkspaceContext(managerCtx(a), (m) => m.query(
      `UPDATE payroll_record SET statement_notified_at = now() WHERE attendance_id = $1`, [worked.s3!.attendanceId]))).rejects.toMatchObject({ code: '42501' });
  });

  it('(10) a query with no tenant context bound returns zero rows', async () => {
    const rows = await dataSource.manager.query(`SELECT * FROM core.payroll_record`);
    expect(rows).toEqual([]);
  });

  it('database backstops: no invented rows, no money edits, no deletes, no own-hours approval', async () => {
    const ctxA = managerCtx(a);
    // INSERT with invented figures for a real approved attendance is refused by the RLS mirror check (before any unique check).
    await expect(tenantContext.runInWorkspaceContext(ctxA, (m) => m.query(
      `INSERT INTO payroll_record (organisation_id, workspace_id, attendance_id, shift_id, staff_profile_id, worked_minutes, pay_rate_pence, amount_pence)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [orgId, a.workspaceId, worked.s4!.attendanceId, worked.s4!.shiftId, staff[4]!.profileId, 600, 999999, 999999]))).rejects.toMatchObject({ code: '42501' });
    // The money snapshot is immutable for the runtime role (column-level UPDATE grant).
    await expect(tenantContext.runInWorkspaceContext(ctxA, (m) => m.query(
      `UPDATE payroll_record SET amount_pence = 1 WHERE attendance_id = $1`, [worked.s4!.attendanceId]))).rejects.toMatchObject({ code: '42501' });
    await expect(tenantContext.runInWorkspaceContext(ctxA, (m) => m.query(
      `DELETE FROM payroll_record WHERE attendance_id = $1`, [worked.s4!.attendanceId]))).rejects.toMatchObject({ code: '42501' });
    // Recording the staff member themselves as approver violates the UPDATE WITH CHECK (segregation of duties).
    await expect(tenantContext.runInWorkspaceContext(ctxA, (m) => m.query(
      `UPDATE payroll_record SET approved_by = $2 WHERE attendance_id = $1`, [worked.s4!.attendanceId, staff[4]!.userId]))).rejects.toMatchObject({ code: '42501' });
    // Staff cannot write their own record either.
    await expect(tenantContext.runInWorkspaceContext(
      { organisationId: orgId, workspaceId: staff[1]!.workspaceId, userId: staff[1]!.userId, role: '' } as AuthContext,
      (m) => m.query(`UPDATE payroll_record SET status = 'approved', approved_at = now(), approved_by = $2 WHERE attendance_id = $1 RETURNING id`, [worked.s1!.attendanceId, a.userId]),
    )).resolves.toEqual([[], 0]);
    expect((await recordFor(worked.s1!.attendanceId))!.status).toBe('rejected');
  });

  it('a correction after finalisation is refused (409) and leaves the payroll record untouched', async () => {
    const before = (await recordFor(worked.s4!.attendanceId))!;
    const res = await http().post(`/rest/v1/attendance/${worked.s4!.attendanceId}/correct`).set(auth(tokenA))
      .send({ field: 'breakMinutes', newValue: '30', reason: 'Late correction attempt after payroll' });
    expect(res.status).toBe(409);
    const after = (await recordFor(worked.s4!.attendanceId))!;
    expect(after).toEqual(before);
  });

  it('finalise stays idempotent: a repeated finalise creates no second record', async () => {
    const fin = await http().patch(`/rest/v1/attendance/report/shift/${worked.s2!.shiftId}/finalise`).set(auth(tokenA));
    expect(fin.status).toBe(200);
    const rows = await adminDataSource.query(`SELECT count(*)::int AS n FROM core.payroll_record WHERE shift_id = $1`, [worked.s2!.shiftId]);
    expect(rows[0].n).toBe(1);
  });
});
