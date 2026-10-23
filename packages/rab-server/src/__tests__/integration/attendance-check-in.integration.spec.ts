import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { AttendanceQrService } from '../../modules/attendance/services/attendance-qr.service';
import { Shift } from '../../modules/scheduling/entities/shift.entity';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Check In → Clock In → Clock Out, the geofence on all three, Venue Manager on-behalf punches and the pipeline stages
 * (owner brief 2026-10-21). Real Postgres (disposable test DB), RLS on, real HTTP stack, production roles; no mocks.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(180_000);

const MIN = 60_000;
const HOUR = 60 * MIN;
const REASON = 'Staff phone battery died at the door so I am clocking them in now';
const OUT_REASON = 'Staff phone battery died before the end so I am clocking them out now';
// Venue at Trafalgar Square; INSIDE ~11 m away, OUTSIDE ~1.1 km away.
const VENUE = { lat: 51.508, lng: -0.128, radius: 150 };
const INSIDE = { lat: 51.5081, lng: -0.128 };
const OUTSIDE = { lat: 51.518, lng: -0.128 };

describeIfDb('attendance check-in, geofence and on-behalf punches (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let tenantContext: TenantContextService;
  let attendanceQr: AttendanceQrService;
  let factory: TestIdentityFactory;
  let orgId: string;
  let a: TestIdentity; // owning manager
  let b: TestIdentity; // another workspace in the same organisation
  let tokenA: string;
  let vm: TestIdentity; // venue manager assigned to venue1
  let vmOther: TestIdentity; // venue manager of the same workspace, assigned to venue2 only
  let vmB: TestIdentity; // venue manager in workspace B
  let tokenVm: string;
  let tokenVmOther: string;
  let tokenVmB: string;
  let staff: TestIdentity[];
  let staffTokens: string[];
  let venue1: string;
  let venue2: string;
  let jobRoleId: string;

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const fix = (p: { lat: number; lng: number }, ageMs = 5_000, accuracyM = 15) => ({ ...p, accuracyM, capturedAt: new Date(Date.now() - ageMs).toISOString() });

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

    const seeded = await factory.createOrganisationWithManagers(2, { workspace: true, permissions: 'production', label: 'checkin' });
    orgId = seeded.organisation.id;
    [a, b] = seeded.managers as [TestIdentity, TestIdentity];
    tokenA = await factory.login(a);
    staff = [];
    for (let i = 0; i < 18; i++) staff.push(await factory.createStaff(seeded.organisation, { owner: a, label: `checkin-s${i}` }));
    await adminDataSource.query(`UPDATE core.staff_profile SET employment_status = 'active' WHERE id = ANY($1::uuid[])`, [staff.map((s) => s.profileId)]);
    staffTokens = [];
    for (const s of staff) staffTokens.push(await factory.login(s));

    for (const name of ['One', 'Two']) {
      const v = await http().post('/rest/v1/venues').set(auth(tokenA)).send({ name: `Check-in Venue ${name} ${randomUUID().slice(0, 6)}`, type: 'hotel' });
      expect(v.status).toBe(201);
      if (name === 'One') venue1 = v.body.id;
      else venue2 = v.body.id;
    }
    const role = await http().post('/rest/v1/job-roles').set(auth(tokenA)).send({ name: `Role-${randomUUID()}`, defaultRatePence: 1500 });
    expect(role.status).toBe(201);
    jobRoleId = role.body.id;
    vm = await factory.createVenueManager(seeded.organisation, { owner: a, venueIds: [venue1], label: 'checkin-vm' });
    vmOther = await factory.createVenueManager(seeded.organisation, { owner: a, venueIds: [venue2], label: 'checkin-vm2' });
    vmB = await factory.createVenueManager(seeded.organisation, { owner: b, label: 'checkin-vmb' });
    tokenVm = await factory.login(vm);
    tokenVmOther = await factory.login(vmOther);
    tokenVmB = await factory.login(vmB);
  });

  afterAll(async () => {
    await app?.close();
    await adminDataSource?.destroy();
  });

  // ------------------------------------------------------------------ helpers

  async function setGeofence(venueId: string, opts: { enforce: boolean; configured?: boolean }) {
    const configured = opts.configured ?? true;
    await adminDataSource.query(`UPDATE core.venue SET enforce_geofence = $2, lat = $3, lng = $4, geofence_radius_m = $5 WHERE id = $1`, [
      venueId, opts.enforce, configured ? VENUE.lat : null, configured ? VENUE.lng : null, VENUE.radius,
    ]);
  }

  async function signQr(shiftId: string): Promise<string> {
    return tenantContext.runInTenantContext({ organisationId: orgId, workspaceId: a.workspaceId, userId: a.userId, role: '' }, async (m) =>
      attendanceQr.sign(await m.findOneByOrFail(Shift, { id: shiftId })));
  }

  /** A real VM-requested shift (pipeline-visible), offered/accepted/confirmed through the API for the given staff. */
  async function bookShift(staffIdx: number[], opts: { startOffsetMin?: number; durationMin?: number; venueId?: string } = {}) {
    const startsAt = new Date(Date.now() + (opts.startOffsetMin ?? -5) * MIN);
    const endsAt = new Date(startsAt.getTime() + (opts.durationMin ?? 8 * 60) * MIN);
    const created = await http().post('/rest/v1/shifts').set(auth(tokenA))
      .send({ venueId: opts.venueId ?? venue1, jobRoleId, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), requiredCount: staffIdx.length });
    expect(created.status).toBe(201);
    const shiftId = created.body.id as string;
    expect((await http().post(`/rest/v1/shifts/${shiftId}/publish`).set(auth(tokenA))).status).toBe(201);
    for (const i of staffIdx) {
      const offer = await http().post(`/rest/v1/shifts/${shiftId}/offers`).set(auth(tokenA)).send({ staffProfileId: staff[i]!.profileId });
      expect({ status: offer.status, body: offer.body }).toMatchObject({ status: 201 });
      expect((await http().post(`/rest/v1/offers/${offer.body.id}/accept`).set(auth(staffTokens[i]!))).status).toBe(201);
      const confirmed = await http().post(`/rest/v1/offers/${offer.body.id}/confirm`).set(auth(tokenA));
      expect([201, 409]).toContain(confirmed.status); // 409 only when the shift auto-confirmed on accept
    }
    await adminDataSource.query(`UPDATE core.shift SET requested_by = $2 WHERE id = $1`, [shiftId, vm.userId]);
    const seats = await adminDataSource.query(`SELECT status, check_in_required FROM core.shift_assignment WHERE shift_id = $1`, [shiftId]);
    expect(seats.every((r: any) => r.status === 'confirmed' && r.check_in_required === true)).toBe(true);
    return shiftId;
  }

  const checkIn = (i: number, body: object) => http().post('/rest/v1/attendance/check-in').set(auth(staffTokens[i]!)).send(body);
  const clockIn = async (i: number, shiftId: string, extra: object = {}) =>
    http().post('/rest/v1/attendance/clock-in').set(auth(staffTokens[i]!)).send({ shiftId, qrToken: await signQr(shiftId), ...extra });
  const clockOut = async (i: number, shiftId: string, extra: object = {}) =>
    http().post('/rest/v1/attendance/clock-out').set(auth(staffTokens[i]!)).send({ qrToken: await signQr(shiftId), ...extra });
  const onBehalf = (token: string, kind: 'in' | 'out', shiftId: string, staffProfileId: string, reason: string) =>
    http().post(`/rest/v1/attendance/report/shift/${shiftId}/staff/${staffProfileId}/clock-${kind}-on-behalf`).set(auth(token)).send({ reason });
  const seat = async (shiftId: string, i: number) =>
    (await adminDataSource.query(`SELECT * FROM core.shift_assignment WHERE shift_id = $1 AND staff_profile_id = $2`, [shiftId, staff[i]!.profileId]))[0];
  const attendanceOf = async (shiftId: string, i: number) =>
    (await adminDataSource.query(`SELECT * FROM core.attendance WHERE shift_id = $1 AND staff_profile_id = $2`, [shiftId, staff[i]!.profileId]))[0];
  const audits = (action: string, entityId: string) =>
    adminDataSource.query(`SELECT actor_user_id, metadata FROM core.audit_log WHERE organisation_id = $1 AND action = $2 AND entity_id = $3`, [orgId, action, entityId]);
  const pipeline = async (shiftId: string) => (await http().get(`/rest/v1/shifts/${shiftId}/pipeline`).set(auth(tokenA)).expect(200)).body;

  // ------------------------------------------------------------------ staff check-in

  it('geofence off: check-in needs no location, records server time + source, is idempotent (no new timestamp, one audit row)', async () => {
    await setGeofence(venue1, { enforce: false });
    const shiftId = await bookShift([0]);
    const first = await checkIn(0, { shiftId });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ shiftId, checkInRequired: true, checkInSource: 'staff', locationVerified: false, geofenceEnforced: false, clockedIn: false, alreadyCheckedIn: false });
    expect(first.body.checkedInAt).toBeTruthy();
    const repeat = await checkIn(0, { shiftId, ...fix(OUTSIDE) });
    expect(repeat.status).toBe(200);
    expect(repeat.body).toMatchObject({ checkedInAt: first.body.checkedInAt, alreadyCheckedIn: true, checkInSource: 'staff' });
    const row = await seat(shiftId, 0);
    expect(row).toMatchObject({ check_in_source: 'staff', check_in_location_verified: false, check_in_distance_m: null, check_in_captured_at: null });
    expect(await audits('attendance.checked_in', row.id)).toHaveLength(1);
    // GET mirror + offers/mine projection
    const got = await http().get(`/rest/v1/attendance/me/shift/${shiftId}/check-in`).set(auth(staffTokens[0]!));
    expect(got.body).toMatchObject({ checkedInAt: first.body.checkedInAt, alreadyCheckedIn: true });
    const mine = await http().get('/rest/v1/offers/mine').set(auth(staffTokens[0]!));
    const offer = (Array.isArray(mine.body) ? mine.body : mine.body.data).find((o: any) => o.shiftId === shiftId);
    expect(offer).toMatchObject({ checkInRequired: true, checkInSource: 'staff', geofenceEnforced: false });
    expect(new Date(offer.checkedInAt).toISOString()).toBe(first.body.checkedInAt);
  });

  it('Clock In is refused before Check In (a valid Shift QR cannot bypass it); clock-out without clock-in is refused; then the full flow works', async () => {
    await setGeofence(venue1, { enforce: false });
    const shiftId = await bookShift([1]);
    const early = await clockIn(1, shiftId);
    expect({ status: early.status, code: early.body.code }).toEqual({ status: 409, code: 'CHECK_IN_REQUIRED' });
    const out = await clockOut(1, shiftId);
    expect(out.status).toBe(404);
    expect((await checkIn(1, { shiftId, qrToken: await signQr(shiftId) })).body).toMatchObject({ checkInSource: 'qr' });
    const inRes = await clockIn(1, shiftId);
    expect(inRes.status).toBe(201);
    expect(inRes.body).toMatchObject({ clockInMethod: 'staff', checkInRequired: true, checkInSource: 'qr' });
    const again = await clockIn(1, shiftId);
    expect({ status: again.status, code: again.body.code }).toEqual({ status: 409, code: 'ALREADY_CLOCKED_IN' });
    const outRes = await clockOut(1, shiftId);
    expect(outRes.status).toBe(201);
    expect(outRes.body.clockOutMethod).toBe('manual');
  });

  it('geofence on: missing / outside / stale / future / inaccurate evidence get clear codes; inside is verified and stores no coordinates; replayed fixes are refused at clock-in and clock-out', async () => {
    await setGeofence(venue1, { enforce: true });
    const shiftId = await bookShift([2]);
    const code = async (body: object) => (await checkIn(2, { shiftId, ...body })).body.code;
    expect(await code({})).toBe('LOCATION_REQUIRED');
    expect(await code({ lat: INSIDE.lat, lng: INSIDE.lng })).toBe('LOCATION_REQUIRED'); // strict: accuracy + capture time needed
    expect(await code(fix(OUTSIDE))).toBe('OUTSIDE_GEOFENCE');
    expect((await checkIn(2, { shiftId, ...fix(OUTSIDE) })).body.message).toBe("You're outside the venue's permitted check-in area.");
    expect(await code(fix(INSIDE, 10 * MIN))).toBe('LOCATION_STALE');
    expect(await code(fix(INSIDE, -5 * MIN))).toBe('LOCATION_STALE');
    expect(await code(fix(INSIDE, 5_000, 500))).toBe('LOCATION_ACCURACY_TOO_LOW');
    expect((await seat(shiftId, 2)).checked_in_at).toBeNull();

    const evidence = fix(INSIDE);
    const ok = await checkIn(2, { shiftId, ...evidence });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ locationVerified: true, geofenceEnforced: true, accuracyM: 15 });
    expect(ok.body.distanceM).toBeLessThan(20);
    const row = await seat(shiftId, 2);
    expect(new Date(row.check_in_captured_at).toISOString()).toBe(evidence.capturedAt);
    expect(Object.keys(row).filter((k) => k.startsWith('check_in_') && /lat|lng/.test(k))).toEqual([]);
    const audit = (await audits('attendance.checked_in', row.id))[0];
    expect(JSON.stringify(audit.metadata)).not.toMatch(/51\.50/);

    const replay = await clockIn(2, shiftId, evidence);
    expect({ status: replay.status, code: replay.body.code }).toEqual({ status: 409, code: 'LOCATION_STALE' });
    expect((await clockIn(2, shiftId, {})).body.code).toBe('LOCATION_REQUIRED');
    const inFix = fix(INSIDE, 1_000);
    const inRes = await clockIn(2, shiftId, inFix);
    expect(inRes.status).toBe(201);
    expect(inRes.body.locationVerified).toBe(true);
    expect((await clockOut(2, shiftId, inFix)).body.code).toBe('LOCATION_STALE');
    expect((await clockOut(2, shiftId, fix(OUTSIDE, 0))).body.code).toBe('OUTSIDE_GEOFENCE');
    const outRes = await clockOut(2, shiftId, fix(INSIDE, 0));
    expect(outRes.status).toBe(201);
  });

  it('geofence enforced but the venue has no coordinates: refused (GEOFENCE_MISCONFIGURED), never silently allowed', async () => {
    const shiftId = await bookShift([3], { venueId: venue2 });
    await setGeofence(venue2, { enforce: true, configured: false });
    const res = await checkIn(3, { shiftId, ...fix(INSIDE) });
    expect({ status: res.status, code: res.body.code }).toEqual({ status: 409, code: 'GEOFENCE_MISCONFIGURED' });
    expect((await seat(shiftId, 3)).checked_in_at).toBeNull();
    await setGeofence(venue2, { enforce: false });
  });

  it('scope and state: someone else\'s shift and unknown shifts are 404; too early, cancelled bookings and provisional no-shows are refused', async () => {
    await setGeofence(venue1, { enforce: false });
    const shiftId = await bookShift([4]);
    expect((await checkIn(5, { shiftId })).status).toBe(404);
    expect((await checkIn(5, { shiftId: randomUUID() })).status).toBe(404);
    expect((await http().get(`/rest/v1/attendance/me/shift/${shiftId}/check-in`).set(auth(staffTokens[5]!))).status).toBe(404);
    // organisationId / status in the body are a 400 (forbidNonWhitelisted), not hints
    expect((await checkIn(4, { shiftId, organisationId: orgId })).status).toBe(400);
    expect((await checkIn(4, { shiftId, checkedInAt: new Date().toISOString() })).status).toBe(400);

    const later = await bookShift([5], { startOffsetMin: 180 });
    const early = await checkIn(5, { shiftId: later });
    expect({ status: early.status, code: early.body.code }).toEqual({ status: 409, code: 'CHECK_IN_TOO_EARLY' });

    await adminDataSource.query(`UPDATE core.shift_assignment SET status = 'cancelled' WHERE shift_id = $1`, [shiftId]);
    const cancelled = await checkIn(4, { shiftId });
    expect({ status: cancelled.status, code: cancelled.body.code }).toEqual({ status: 409, code: 'SHIFT_NOT_CONFIRMED' });
    await adminDataSource.query(`UPDATE core.shift_assignment SET status = 'no_show' WHERE shift_id = $1`, [shiftId]);
    const flagged = await checkIn(4, { shiftId });
    expect({ status: flagged.status, code: flagged.body.code }).toEqual({ status: 409, code: 'ATTENDANCE_FLAGGED_MISSING' });
  });

  // ------------------------------------------------------------------ venue manager on behalf

  it('VM clock-in on behalf: blocked before the staff check-in, needs a 10-word reason, then records manager + reason + provenance + server time', async () => {
    await setGeofence(venue1, { enforce: false });
    const shiftId = await bookShift([6]);
    const sp = staff[6]!.profileId!;
    const before = await onBehalf(tokenVm, 'in', shiftId, sp, REASON);
    expect({ status: before.status, code: before.body.code }).toEqual({ status: 409, code: 'STAFF_NOT_CHECKED_IN' });
    expect(before.body.message).toMatch(/must check in before you can clock them in/);
    expect(await attendanceOf(shiftId, 6)).toBeUndefined();

    await checkIn(6, { shiftId });
    const short = await onBehalf(tokenVm, 'in', shiftId, sp, 'one two three four five six seven eight nine');
    expect({ status: short.status, code: short.body.code }).toEqual({ status: 400, code: 'REASON_TOO_SHORT' });
    const padded = await onBehalf(tokenVm, 'in', shiftId, sp, '- - - - - - - - - - - - word');
    expect(padded.status).toBe(400);
    const t0 = Date.now();
    const ok = await onBehalf(tokenVm, 'in', shiftId, sp, REASON);
    expect(ok.status).toBe(200);
    const row = await attendanceOf(shiftId, 6);
    expect(row).toMatchObject({ status: 'clocked_in', clock_in_method: 'manager_on_behalf', clock_in_by: vm.userId, clock_in_reason: REASON, location_verified: false });
    expect(Math.abs(new Date(row.clock_in_at).getTime() - t0)).toBeLessThan(30_000);
    const [audit] = await audits('attendance.clocked_in_on_behalf', row.id);
    expect(audit.actor_user_id).toBe(vm.userId);
    expect(audit.metadata).toMatchObject({ reason: REASON, method: 'manager_on_behalf', staffProfileId: sp });
    const reportRow = ok.body.staff.find((r: any) => r.staffProfileId === sp);
    expect(reportRow).toMatchObject({ clockInMethod: 'manager_on_behalf', clockInReason: REASON, checkInSource: 'staff', checkInRequired: true });
    expect(reportRow.clockInByName).toBeTruthy();
    expect(reportRow.checkedInAt).toBeTruthy();
    expect(ok.body.attendancePolicy).toEqual({ geofenceEnforced: false, onBehalfClockOutAllowed: true, onBehalfReasonMinWords: 10 });
    const twice = await onBehalf(tokenVm, 'in', shiftId, sp, REASON);
    expect({ status: twice.status, code: twice.body.code }).toEqual({ status: 409, code: 'ALREADY_CLOCKED_IN' });

    // clock-out on behalf (geofence off): allowed, provenance recorded
    const outOk = await onBehalf(tokenVm, 'out', shiftId, sp, OUT_REASON);
    expect(outOk.status).toBe(200);
    expect(await attendanceOf(shiftId, 6)).toMatchObject({ status: 'clocked_out', clock_out_method: 'manager_on_behalf', clock_out_by: vm.userId, clock_out_reason: OUT_REASON });
    expect(await audits('attendance.clocked_out_on_behalf', row.id)).toHaveLength(1);
    const outAgain = await onBehalf(tokenVm, 'out', shiftId, sp, OUT_REASON);
    expect({ status: outAgain.status, code: outAgain.body.code }).toEqual({ status: 409, code: 'NOT_CLOCKED_IN' });
  });

  it('geofence + manager: on-behalf clock-in needs a location-verified check-in; on-behalf clock-out is refused (PRESENCE_EVIDENCE_REQUIRED); clock-out before clock-in is NOT_CLOCKED_IN', async () => {
    await setGeofence(venue1, { enforce: false });
    const shiftId = await bookShift([8, 9]);
    const [s7, s0] = [staff[8]!.profileId!, staff[9]!.profileId!];
    expect((await onBehalf(tokenVm, 'out', shiftId, s7, OUT_REASON)).body.code).toBe('NOT_CLOCKED_IN');
    await checkIn(8, { shiftId }); // unverified: geofence was off
    await setGeofence(venue1, { enforce: true });
    const unverified = await onBehalf(tokenVm, 'in', shiftId, s7, REASON);
    expect({ status: unverified.status, code: unverified.body.code }).toEqual({ status: 409, code: 'PRESENCE_NOT_VERIFIED' });
    await checkIn(9, { shiftId, ...fix(INSIDE) });
    const verified = await onBehalf(tokenVm, 'in', shiftId, s0, REASON);
    expect(verified.status).toBe(200);
    expect(verified.body.attendancePolicy).toMatchObject({ geofenceEnforced: true, onBehalfClockOutAllowed: false });
    const refused = await onBehalf(tokenVm, 'out', shiftId, s0, OUT_REASON);
    expect({ status: refused.status, code: refused.body.code }).toEqual({ status: 409, code: 'PRESENCE_EVIDENCE_REQUIRED' });
    // the staff member's own fresh, newer, inside fix still closes it
    const own = await clockOut(9, shiftId, fix(INSIDE, 0));
    expect(own.status).toBe(201);
    await setGeofence(venue1, { enforce: false });
  });

  it('on-behalf scope: other-venue VM 404, other-workspace VM 404, staff token denied, unknown staff 404', async () => {
    await setGeofence(venue1, { enforce: false });
    const shiftId = await bookShift([10]);
    await checkIn(10, { shiftId });
    const sp = staff[10]!.profileId!;
    expect((await onBehalf(tokenVmOther, 'in', shiftId, sp, REASON)).status).toBe(404);
    expect((await onBehalf(tokenVmB, 'in', shiftId, sp, REASON)).status).toBe(404);
    expect((await onBehalf(tokenVmB, 'out', shiftId, sp, OUT_REASON)).status).toBe(404);
    expect((await onBehalf(staffTokens[10]!, 'in', shiftId, sp, REASON)).status).toBe(403);
    expect((await onBehalf(tokenVm, 'in', shiftId, staff[2]!.profileId!, REASON)).status).toBe(404);
    expect((await http().post(`/rest/v1/attendance/report/shift/${shiftId}/staff/${sp}/clock-in-on-behalf`).set(auth(tokenVm)).send({ reason: REASON, organisationId: orgId })).status).toBe(400);
    expect(await attendanceOf(shiftId, 10)).toBeUndefined();
    // and the VM token cannot use the staff check-in route
    expect((await http().post('/rest/v1/attendance/check-in').set(auth(tokenVm)).send({ shiftId })).status).toBe(403);
  });

  it('concurrent staff clock-in and manager clock-in on behalf: exactly one wins, one attendance row', async () => {
    await setGeofence(venue1, { enforce: false });
    const shiftId = await bookShift([11]);
    await checkIn(11, { shiftId });
    const qrToken = await signQr(shiftId);
    const [staffRes, vmRes] = await Promise.all([
      http().post('/rest/v1/attendance/clock-in').set(auth(staffTokens[11]!)).send({ shiftId, qrToken }),
      onBehalf(tokenVm, 'in', shiftId, staff[11]!.profileId!, REASON),
    ]);
    const statuses = [staffRes.status, vmRes.status].sort();
    expect(statuses.filter((s) => s === 201 || s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(1);
    expect((await adminDataSource.query(`SELECT count(*)::int AS n FROM core.attendance WHERE shift_id = $1`, [shiftId]))[0].n).toBe(1);

    // concurrent clock-out: staff + manager, exactly one wins
    const [o1, o2] = await Promise.all([
      http().post('/rest/v1/attendance/clock-out').set(auth(staffTokens[11]!)).send({ qrToken }),
      onBehalf(tokenVm, 'out', shiftId, staff[11]!.profileId!, OUT_REASON),
    ]);
    expect([o1.status, o2.status].filter((s) => s === 201 || s === 200)).toHaveLength(1);
    expect([o1.status, o2.status].filter((s) => s === 409)).toHaveLength(1);
    expect((await attendanceOf(shiftId, 11)).status).toBe('clocked_out');
  });

  // ------------------------------------------------------------------ rollout rule (historical / active attendance)

  it('bookings made before Check In shipped keep the old flow: clock-in without check-in, legacy geofence payload, active attendance closes', async () => {
    await setGeofence(venue1, { enforce: false });
    const shiftId = await bookShift([12]);
    await adminDataSource.query(`UPDATE core.shift_assignment SET check_in_required = false WHERE shift_id = $1`, [shiftId]);
    await setGeofence(venue1, { enforce: true });
    // the pre-Check-In mobile payload: lat/lng only, no accuracy/capturedAt
    const inRes = await clockIn(12, shiftId, { lat: INSIDE.lat, lng: INSIDE.lng });
    expect(inRes.status).toBe(201);
    expect(inRes.body).toMatchObject({ checkInRequired: false, checkedInAt: null, locationVerified: true });
    await setGeofence(venue1, { enforce: true, configured: false }); // legacy: misconfigured venue fails soft
    const outRes = await clockOut(12, shiftId, {});
    expect(outRes.status).toBe(201);
    await setGeofence(venue1, { enforce: false });
  });

  // ------------------------------------------------------------------ pipeline stages + analytics

  it('pipeline: 3 checked in / 2 not → checked_in 3 (others truthful, not no_show); 2 clock in → checked_in 1, clocked_in 2; provisional vs confirmed no-show; filled from bookings', async () => {
    await setGeofence(venue1, { enforce: false });
    const idx = [13, 14, 15, 16, 17];
    const shiftId = await bookShift(idx);
    for (const i of [13, 14, 15]) expect((await checkIn(i, { shiftId })).status).toBe(200);
    let board = await pipeline(shiftId);
    expect(board.stages).toEqual(['offered', 'waiting', 'staff_accepted', 'confirmed', 'late', 'checked_in', 'clocked_in', 'pending_review', 'clocked_out', 'attendance_missing', 'no_show', 'rejected', 'cancelled', 'deleted']);
    expect(board.stageGroups.attendance).toEqual(['late', 'checked_in', 'clocked_in', 'pending_review', 'clocked_out', 'attendance_missing', 'no_show']);
    expect(board.stageCounts).toMatchObject({ checked_in: 3, confirmed: 2, clocked_in: 0, no_show: 0, attendance_missing: 0 });
    expect(board.summary).toMatchObject({ required: 5, filled: 5, open: 0, checkedIn: 3, attendanceMissing: 0, confirmedNoShow: 0, noShow: 0 });
    expect(board.staff.filter((r: any) => r.stage === 'checked_in').every((r: any) => r.checkedInAt)).toBe(true);

    for (const i of [13, 14]) expect((await clockIn(i, shiftId)).status).toBe(201);
    board = await pipeline(shiftId);
    expect(board.stageCounts).toMatchObject({ checked_in: 1, clocked_in: 2, confirmed: 2 });
    expect(board.summary).toMatchObject({ checkedIn: 1, clockedIn: 2, filled: 5 });

    // worker's provisional mark → attendance_missing (still filled); manager-confirmed → no_show (seat freed)
    await adminDataSource.query(`UPDATE core.shift_assignment SET status = 'no_show' WHERE shift_id = $1 AND staff_profile_id = $2`, [shiftId, staff[16]!.profileId]);
    board = await pipeline(shiftId);
    expect(board.stageCounts).toMatchObject({ attendance_missing: 1, no_show: 0, confirmed: 1 });
    expect(board.summary).toMatchObject({ attendanceMissing: 1, confirmedNoShow: 0, filled: 5 });
    await adminDataSource.query(`UPDATE core.shift_assignment SET attendance_reviewed_at = now(), attendance_reviewed_by = $3 WHERE shift_id = $1 AND staff_profile_id = $2`, [shiftId, staff[16]!.profileId, vm.userId]);
    board = await pipeline(shiftId);
    expect(board.stageCounts).toMatchObject({ attendance_missing: 0, no_show: 1 });
    expect(board.summary).toMatchObject({ confirmedNoShow: 1, noShow: 1, filled: 4 });
    const total = Object.values(board.stageCounts as Record<string, number>).reduce((s, n) => s + n, 0);
    expect(total).toBe(board.staff.length);
  });
});
