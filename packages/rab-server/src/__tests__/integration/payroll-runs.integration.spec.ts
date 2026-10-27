import 'reflect-metadata';
import './helpers/use-local-storage-env'; // MUST be imported before AppModule — see that file's own doc comment

import { PermissionFlag } from '@rab/shared';
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
import { OFFICIAL_CALENDAR_2026 } from '../../modules/payroll/constants/official-calendar-2026';
import { periodForInstant } from '../../modules/payroll/services/payroll-allocation';
import { Shift } from '../../modules/scheduling/entities/shift.entity';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Agency payment calendar, allocation, payroll runs and official payslips (PayrollCalendarRunsPayslips1786719200000).
 * Real HTTP + PostgreSQL with RLS (crewflow_app), no mocks. Scenarios share one world and run in order.
 *
 * Dates: a shift is worked through the real flow (Check In and Clock In need it to be happening now), then its SCHEDULED
 * time is pinned to a fixed instant (`scheduleAt`), the way manual-attendance.integration.spec.ts does. Allocation reads
 * the scheduled start live; worked minutes and pay come from the attendance record and are not touched. So every record
 * lands in a known period of the official 2026 calendar whatever the machine date (default: Tue 20 Oct 2026 10:00 BST,
 * period 12 Oct – 25 Oct 2026, payday 4 Nov 2026).
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

jest.setTimeout(300_000);

describeIfDb('payroll calendar, runs and payslips (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let factory: TestIdentityFactory;
  let tenantContext: TenantContextService;
  let attendanceQr: AttendanceQrService;
  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  let orgId: string;
  let a: TestIdentity;
  let b: TestIdentity;
  let staff: TestIdentity[];
  let tokenA: string;
  let tokenB: string;
  let tokenVm: string;
  let tokenPlain: string;
  let staffTokens: string[];
  let venueId: string;
  let jobRoleId: string;
  const rec: Record<string, { recordId: string; attendanceId: string }> = {};

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
    const seeded = await factory.createOrganisationWithManagers(2, { workspace: true, permissions: 'production', label: 'runs' });
    orgId = seeded.organisation.id;
    [a, b] = seeded.managers as [TestIdentity, TestIdentity];
    // B is the organisation's Initial Manager (the only one who may import the agency calendar); A is an ordinary Internal Manager.
    await adminDataSource.query(`UPDATE core.manager_profile SET is_initial_manager = true WHERE user_id = $1`, [b.userId]);
    staff = [];
    for (let i = 0; i < 6; i++) staff.push(await factory.createStaff(seeded.organisation, { owner: a, label: `runs-s${i}` }));
    await adminDataSource.query(`UPDATE core.staff_profile SET employment_status = 'active' WHERE id = ANY($1::uuid[])`, [staff.map((s) => s.profileId)]);
    [tokenA, tokenB] = [await factory.login(a), await factory.login(b)];
    staffTokens = [];
    for (const s of staff) staffTokens.push(await factory.login(s));
    const venue = await http().post('/rest/v1/venues').set(auth(tokenA)).send({ name: `Runs Venue ${randomUUID().slice(0, 6)}`, type: 'hotel' });
    venueId = venue.body.id;
    jobRoleId = (await http().post('/rest/v1/job-roles').set(auth(tokenA)).send({ name: `Role-${randomUUID()}`, defaultRatePence: 1500 })).body.id;
    const vm = await factory.createVenueManager(seeded.organisation, { owner: a, venueIds: [venueId], label: 'runs-vm' });
    tokenVm = await factory.login(vm);
    const org2 = await factory.createOrganisationWithManagers(1, { workspace: true, permissions: 'production', label: 'runs-plain' });
    tokenPlain = await factory.login(org2.managers[0]!);
  });

  afterAll(async () => {
    await app?.close();
    await adminDataSource?.destroy();
  });

  async function signQr(shiftId: string): Promise<string> {
    return tenantContext.runInTenantContext({ organisationId: orgId, workspaceId: a.workspaceId, userId: a.userId, role: '' }, async (m) =>
      attendanceQr.sign(await m.findOneByOrFail(Shift, { id: shiftId })));
  }

  /** Inside the 12 Oct – 25 Oct 2026 period (payday 4 Nov 2026): Tuesday 20 October, 10:00 BST. */
  const IN_OCTOBER_PERIOD = '2026-10-20T09:00:00Z';

  /** Pins a shift's scheduled time (shift + its assignments) to start at `instant`, keeping its scheduled length. */
  async function scheduleAt(shiftId: string, instant: string): Promise<void> {
    await adminDataSource.query(`UPDATE core.shift SET starts_at = $2::timestamptz, ends_at = $2::timestamptz + (ends_at - starts_at) WHERE id = $1`, [shiftId, instant]);
    await adminDataSource.query(
      `UPDATE core.shift_assignment SET period = tstzrange($2::timestamptz, $2::timestamptz + (upper(period) - lower(period)), '[)') WHERE shift_id = $1 AND period IS NOT NULL`,
      [shiftId, instant],
    );
  }

  /** Work → finalise → pin the scheduled start → (optionally) approve a shift for staff[i]; returns the payroll record id. */
  async function recordFor(i: number, approve = true, scheduledAt: string = IN_OCTOBER_PERIOD): Promise<string> {
    const s = staff[i]!;
    const shift = await http().post('/rest/v1/shifts').set(auth(tokenA)).send({
      venueId, jobRoleId, startsAt: new Date(Date.now() - 5 * 60_000).toISOString(), endsAt: new Date(Date.now() + 8 * 3600_000).toISOString(), requiredCount: 1 });
    const shiftId = shift.body.id as string;
    expect((await http().post(`/rest/v1/shifts/${shiftId}/publish`).set(auth(tokenA))).status).toBe(201);
    const offer = await http().post(`/rest/v1/shifts/${shiftId}/offers`).set(auth(tokenA)).send({ staffProfileId: s.profileId });
    expect(offer.status).toBe(201);
    expect((await http().post(`/rest/v1/offers/${offer.body.id}/accept`).set(auth(staffTokens[i]!))).status).toBe(201);
    expect((await http().post(`/rest/v1/offers/${offer.body.id}/confirm`).set(auth(tokenA))).status).toBe(201);
    // Check In (arrival) is required before Clock In for bookings made after 1786719450000.
    expect((await http().post('/rest/v1/attendance/check-in').set(auth(staffTokens[i]!)).send({ shiftId })).status).toBe(200);
    expect((await http().post('/rest/v1/attendance/clock-in').set(auth(staffTokens[i]!)).send({ shiftId, qrToken: await signQr(shiftId) })).status).toBe(201);
    const out = await http().post('/rest/v1/attendance/clock-out').set(auth(staffTokens[i]!)).send({ qrToken: await signQr(shiftId) });
    expect((await http().post(`/rest/v1/attendance/${out.body.id}/correct`).set(auth(tokenA))
      .send({ field: 'clockInAt', newValue: new Date(new Date(out.body.clockOutAt).getTime() - 300 * 60_000).toISOString(), reason: 'Runs test worked time' })).status).toBe(201);
    expect((await http().post(`/rest/v1/attendance/report/shift/${shiftId}/staff/${s.profileId}/attendance-review`).set(auth(tokenA))).status).toBe(200);
    expect((await http().patch(`/rest/v1/attendance/report/shift/${shiftId}/finalise`).set(auth(tokenA))).status).toBe(200);
    await scheduleAt(shiftId, scheduledAt);
    const [row] = await adminDataSource.query(`SELECT id FROM core.payroll_record WHERE attendance_id = $1`, [out.body.id]);
    if (approve) expect((await http().post(`/rest/v1/payroll/records/${row.id}/approve`).set(auth(tokenA))).status).toBe(200);
    rec[`s${i}`] = { recordId: row.id, attendanceId: out.body.id };
    return row.id as string;
  }

  const officialBody = (over: Record<string, unknown> = {}) => ({
    year: OFFICIAL_CALENDAR_2026.year, source: OFFICIAL_CALENDAR_2026.source, notes: OFFICIAL_CALENDAR_2026.notes,
    periods: OFFICIAL_CALENDAR_2026.periods.map((p) => ({ start: p.start, end: p.end, payday: p.payday, ...(p.note ? { note: p.note } : {}), needsConfirmation: false })),
    ...over,
  });
  const ctxOf = (who: TestIdentity): AuthContext => ({ organisationId: orgId, workspaceId: who.workspaceId, userId: who.userId, role: '' }) as AuthContext;

  it('before any calendar exists, an approved shift is unallocated (never invented)', async () => {
    await recordFor(5);
    const mine = await http().get('/rest/v1/payroll/me/statements').set(auth(staffTokens[5]!));
    expect(mine.body.data[0]).toMatchObject({ payrollPeriod: null, payday: null, allocationStatus: 'unallocated' });
    const payslips = await http().get('/rest/v1/payroll/me/payslips').set(auth(staffTokens[5]!));
    expect(payslips.body).toMatchObject({ data: [], unallocated: { shiftCount: 1 } });
  });

  it('calendar import: validation report, overlap refused, dry run, official 2026 as published, versioning and authorisation', async () => {
    const overlapping = await http().post('/rest/v1/payroll/calendar/import').set(auth(tokenB))
      .send(officialBody({ periods: [{ start: '2026-01-05', end: '2026-01-18', payday: '2026-01-28' }, { start: '2026-01-18', end: '2026-01-31', payday: '2026-02-11' }] }));
    expect(overlapping.status).toBe(409);
    expect(overlapping.body.report.overlaps).toHaveLength(1);
    expect((await http().post('/rest/v1/payroll/calendar/import').set(auth(tokenB)).send(officialBody({ organisationId: randomUUID() }))).status).toBe(400);
    expect((await http().post('/rest/v1/payroll/calendar/import').set(auth(tokenVm)).send(officialBody())).status).toBe(403);
    // An ordinary Internal Manager (holds payroll.calculate) is no longer enough: Initial Manager only (owner decision).
    const internal = await http().post('/rest/v1/payroll/calendar/import').set(auth(tokenA)).send(officialBody({ dryRun: true }));
    expect(internal.status).toBe(403);
    expect((await http().get('/rest/v1/payroll/calendar').set(auth(tokenA))).body.canManage).toBe(false);
    expect((await http().get('/rest/v1/payroll/calendar').set(auth(tokenB))).body.canManage).toBe(true);
    // RLS backstop: an Internal Manager writing calendar rows directly is refused.
    await expect(tenantContext.runInTenantContext(ctxOf(a), (m) => m.query(
      `INSERT INTO core.payroll_calendar (organisation_id, year, version, source, created_by) VALUES ($1, 2030, 1, 'x', $2)`, [orgId, a.userId]))).rejects.toMatchObject({ code: '42501' });
    expect((await http().post('/rest/v1/payroll/calendar/import').set(auth(staffTokens[0]!)).send(officialBody())).status).toBe(403);
    const dry = await http().post('/rest/v1/payroll/calendar/import').set(auth(tokenB)).send(officialBody({ dryRun: true }));
    expect(dry.status).toBe(200);
    expect(dry.body).toMatchObject({ applied: false, calendar: null, report: { periodCount: 28, errors: [], overlaps: [], gaps: [] } });
    expect(dry.body.report.nonStandardLengths).toEqual([{ start: '2026-02-02', end: '2026-02-16', days: 15 }, { start: '2026-02-17', end: '2026-03-01', days: 13 }]);
    expect(await adminDataSource.query(`SELECT 1 FROM core.payroll_calendar WHERE organisation_id = $1`, [orgId])).toEqual([]);
    const v1 = await http().post('/rest/v1/payroll/calendar/import').set(auth(tokenB)).send(officialBody());
    expect(v1.status).toBe(200);
    expect(v1.body.calendar).toMatchObject({ year: 2026, version: 1, status: 'active', timezone: 'Europe/London', source: 'Adolphus Recruitment Calendar of Payment 2026' });
    expect(v1.body.calendar.notes).toMatch(/Guidance only/);
    const feb = v1.body.calendar.periods.find((p: { start: string }) => p.start === '2026-02-02');
    expect(feb).toMatchObject({ end: '2026-02-16', payday: '2026-02-25', days: 15, needsConfirmation: false, note: expect.stringMatching(/used as published/) });
    const v2 = await http().post('/rest/v1/payroll/calendar/import').set(auth(tokenB)).send(officialBody());
    expect(v2.body.calendar.version).toBe(2);
    const history = await adminDataSource.query(`SELECT version, status FROM core.payroll_calendar WHERE organisation_id = $1 ORDER BY version`, [orgId]);
    expect(history).toEqual([{ version: 1, status: 'inactive' }, { version: 2, status: 'active' }]);
    const list = await http().get('/rest/v1/payroll/calendar').set(auth(tokenA));
    expect(list.body.calendars).toHaveLength(1);
    expect(list.body.calendars[0].periods).toHaveLength(28);
    // Another year overlapping the active 2026 periods (21 Dec 2026 – 3 Jan 2027) is refused by the DB exclusion.
    const clash = await http().post('/rest/v1/payroll/calendar/import').set(auth(tokenB))
      .send({ year: 2027, source: 'Overlap test', periods: [{ start: '2027-01-01', end: '2027-01-14', payday: '2027-01-27' }] });
    expect(clash.status).toBe(409);
    const audits = await adminDataSource.query(`SELECT count(*)::int AS n FROM core.audit_log WHERE organisation_id = $1 AND action = 'payroll_calendar.imported'`, [orgId]);
    expect(audits[0].n).toBe(2);
  });

  it('allocation by scheduled start date in Europe/London (owner examples, February as published, DST, outside the schedule)', async () => {
    const payday = async (instant: string) => (await tenantContext.runInTenantContext(ctxOf(a), (m) => periodForInstant(m, orgId, instant)))?.payday ?? null;
    expect(await payday('2026-10-20T12:00:00Z')).toBe('2026-11-04');
    expect(await payday('2026-10-26T09:00:00Z')).toBe('2026-11-18');
    expect(await payday('2026-10-10T12:00:00Z')).toBe('2026-10-21');
    expect(await payday('2026-12-25T12:00:00Z')).toBe('2027-01-13');
    expect(await payday('2026-02-16T12:00:00Z')).toBe('2026-02-25');
    expect(await payday('2026-02-17T12:00:00Z')).toBe('2026-03-11');
    expect(await payday('2026-10-11T23:30:00Z')).toBe('2026-11-04'); // 00:30 BST on 12 Oct
    expect(await payday('2026-10-25T23:30:00Z')).toBe('2026-11-04'); // 23:30 GMT on 25 Oct (after the clock change)
    // Period boundaries on both 2026 clock changes (each falls on a period's last day), in London time.
    expect(await payday('2026-10-11T22:59:59Z')).toBe('2026-10-21'); // 23:59:59 BST on 11 Oct: still the earlier period
    expect(await payday('2026-10-25T00:30:00Z')).toBe('2026-11-04'); // 01:30 BST on 25 Oct, before clocks go back at 01:00 UTC
    expect(await payday('2026-10-25T23:59:59Z')).toBe('2026-11-04'); // 23:59:59 GMT on 25 Oct: last second of the period
    expect(await payday('2026-10-26T00:00:00Z')).toBe('2026-11-18'); // 00:00 GMT on 26 Oct: first instant of the next
    expect(await payday('2026-03-15T23:30:00Z')).toBe('2026-03-25'); // 23:30 GMT on 15 Mar: London = UTC before BST
    expect(await payday('2026-03-29T00:30:00Z')).toBe('2026-04-08'); // 00:30 GMT on 29 Mar, before clocks go forward
    expect(await payday('2026-03-29T22:59:59Z')).toBe('2026-04-08'); // 23:59:59 BST on 29 Mar: last second of the period
    expect(await payday('2026-03-29T23:00:00Z')).toBe('2026-04-22'); // 00:00 BST on 30 Mar: first instant of the next
    expect(await payday('2027-02-01T12:00:00Z')).toBeNull();
    expect(await payday('2025-12-01T12:00:00Z')).toBeNull();
    // The earlier unallocated record now has a period (allocation is evaluated against the active calendar).
    const mine = await http().get('/rest/v1/payroll/me/statements').set(auth(staffTokens[5]!));
    expect(mine.body.data[0]).toMatchObject({ allocationStatus: 'allocated', payday: '2026-11-04', payrollPeriod: { start: '2026-10-12', end: '2026-10-25' } });
  });

  let runId: string;
  let periodId: string;
  let nextPeriodId: string;

  it('concurrent approval of the same record: exactly one 200, one 409', async () => {
    const id = await recordFor(0, false);
    const [r1, r2] = await Promise.all([
      http().post(`/rest/v1/payroll/records/${id}/approve`).set(auth(tokenA)),
      http().post(`/rest/v1/payroll/records/${id}/approve`).set(auth(tokenA)),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
  });

  it('prepare a run: snapshot of the approved records of the period; idempotent; a record can be in one run only (DB constraint)', async () => {
    await recordFor(1);
    const periods = await http().get('/rest/v1/payroll/runs').set(auth(tokenA));
    expect(periods.status).toBe(200);
    periodId = periods.body.periods.find((p: { period: { start: string } }) => p.period.start === '2026-10-12').period.id;
    nextPeriodId = periods.body.periods.find((p: { period: { start: string } }) => p.period.start === '2026-10-26').period.id;
    expect((await http().post('/rest/v1/payroll/runs/prepare').set(auth(tokenVm)).send({ periodId })).status).toBe(403);
    expect((await http().post('/rest/v1/payroll/runs/prepare').set(auth(staffTokens[0]!)).send({ periodId })).status).toBe(403);
    const prepared = await http().post('/rest/v1/payroll/runs/prepare').set(auth(tokenA)).send({ periodId });
    expect(prepared.status).toBe(200);
    runId = prepared.body.id;
    expect(prepared.body).toMatchObject({ status: 'prepared', period: { start: '2026-10-12', end: '2026-10-25', payday: '2026-11-04' }, totals: { records: 3, staff: 3, lateCount: 0 } });
    const again = await http().post('/rest/v1/payroll/runs/prepare').set(auth(tokenA)).send({ periodId });
    expect(again.body.totals.records).toBe(3);
    await expect(tenantContext.runInWorkspaceContext(ctxOf(a), (m) => m.query(
      `INSERT INTO payroll_run_line (organisation_id, workspace_id, run_id, payroll_record_id, staff_profile_id, work_date, worked_minutes, pay_rate_pence, amount_pence)
       SELECT organisation_id, workspace_id, run_id, payroll_record_id, staff_profile_id, work_date, worked_minutes, pay_rate_pence, amount_pence FROM payroll_run_line WHERE run_id = $1 LIMIT 1`,
      [runId]))).rejects.toMatchObject({ code: '23505' });
    const csv = await http().get(`/rest/v1/payroll/runs/${runId}/export`).set(auth(tokenA));
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text.split('\n')[0]).toBe('Staff reference,Staff name,Period start,Period end,Payday,Shifts,Hours,Gross (GBP),Late approvals,Run status');
    expect(csv.text.split('\n')).toHaveLength(4);
  });

  it('another workspace manager (same org) gets 404 on every run action; Venue Manager / staff are refused', async () => {
    expect((await http().get(`/rest/v1/payroll/runs/${runId}`).set(auth(tokenB))).status).toBe(404);
    expect((await http().post(`/rest/v1/payroll/runs/${runId}/finalise`).set(auth(tokenB))).status).toBe(404);
    expect((await http().get(`/rest/v1/payroll/runs/${runId}/export`).set(auth(tokenB))).status).toBe(404);
    expect((await http().post(`/rest/v1/payroll/runs/${runId}/payslips/${staff[0]!.profileId}/mark-paid`).set(auth(tokenB)).send({})).status).toBe(404);
    expect((await http().get(`/rest/v1/payroll/runs/${runId}`).set(auth(tokenVm))).status).toBe(403);
    expect((await http().get(`/rest/v1/payroll/runs/${runId}`).set(auth(staffTokens[0]!))).status).toBe(403);
    const asB = await tenantContext.runInWorkspaceContext(ctxOf(b), (m) => m.query(`SELECT id FROM payroll_run_line`));
    expect(asB).toEqual([]);
  });

  it('upload before finalise is refused; finalise locks the run, moves records to processing and creates payslips', async () => {
    const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(200, 0x20)]);
    expect((await http().post(`/rest/v1/payroll/runs/${runId}/payslips/${staff[0]!.profileId}/document`).set(auth(tokenA)).attach('file', pdf, { filename: 'p.pdf', contentType: 'application/pdf' })).status).toBe(409);
    const fin = await http().post(`/rest/v1/payroll/runs/${runId}/finalise`).set(auth(tokenA));
    expect(fin.status).toBe(200);
    expect(fin.body.status).toBe('finalised');
    expect(fin.body.staff.every((s: { payslip: { status: string } }) => s.payslip.status === 'processing')).toBe(true);
    expect((await adminDataSource.query(`SELECT status FROM core.payroll_record WHERE id = $1`, [rec.s1!.recordId]))[0].status).toBe('processing');
    const history = await http().get('/rest/v1/attendance/me/history').set(auth(staffTokens[1]!));
    expect(history.body.find((h: { id: string }) => h.id === rec.s1!.attendanceId)).toMatchObject({ payrollStatus: 'processing' });
    expect((await http().post(`/rest/v1/payroll/runs/${runId}/finalise`).set(auth(tokenA))).status).toBe(409);
    expect((await http().post('/rest/v1/payroll/runs/prepare').set(auth(tokenA)).send({ periodId })).status).toBe(409);
    const mine = await http().get('/rest/v1/payroll/me/payslips').set(auth(staffTokens[1]!));
    expect(mine.body.data[0]).toMatchObject({ runId, status: 'processing', payday: '2026-11-04', document: null, netPence: null, paidAt: null });
  });

  it('late approval after the run was finalised is carried forward to the next open period, flagged and audited', async () => {
    await recordFor(2);
    const mine = await http().get('/rest/v1/payroll/me/statements').set(auth(staffTokens[2]!));
    expect(mine.body.data[0]).toMatchObject({ allocationStatus: 'carried_forward', payday: '2026-11-18', payrollPeriod: { start: '2026-10-26' } });
    const next = await http().post('/rest/v1/payroll/runs/prepare').set(auth(tokenA)).send({ periodId: nextPeriodId });
    expect(next.body.totals).toMatchObject({ records: 1, lateCount: 1 });
    const [line] = await adminDataSource.query(`SELECT late_approval, original_period_id, work_date::text AS work_date FROM core.payroll_run_line WHERE payroll_record_id = $1`, [rec.s2!.recordId]);
    expect(line).toMatchObject({ late_approval: true, original_period_id: periodId });
    const audits = await adminDataSource.query(`SELECT metadata FROM core.audit_log WHERE action = 'payroll_run.late_carried_forward' AND entity_id::text = $1`, [rec.s2!.recordId]);
    expect(audits).toHaveLength(1);
    expect(audits[0].metadata).toMatchObject({ originalPeriodId: periodId, workDate: line.work_date });
  });

  let fileV1: string;
  let fileV2: string;

  it('payslip upload: PDF only, size limit, no extra fields, idempotent on identical bytes, versioned on replace; staff notified', async () => {
    const url = `/rest/v1/payroll/runs/${runId}/payslips/${staff[1]!.profileId}/document`;
    const pdf1 = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('provider payslip v1'), Buffer.alloc(100, 0x20)]);
    const pdf2 = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('provider payslip v2'), Buffer.alloc(100, 0x20)]);
    expect((await http().post(url).set(auth(tokenA)).attach('file', Buffer.from('not a pdf at all'), { filename: 'x.pdf', contentType: 'application/pdf' })).status).toBe(400);
    expect((await http().post(url).set(auth(tokenA)).attach('file', Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(10 * 1024 * 1024 + 10)]), { filename: 'big.pdf', contentType: 'application/pdf' })).status).toBe(413);
    expect((await http().post(url).set(auth(tokenA)).field('organisationId', orgId).attach('file', pdf1, { filename: 'p.pdf', contentType: 'application/pdf' })).status).toBe(400);
    expect((await http().put(`/rest/v1/payroll/runs/${runId}/payslips/${staff[1]!.profileId}/net`).set(auth(tokenA)).send({ netPence: 9000 })).status).toBe(409);
    const v1 = await http().post(url).set(auth(tokenA)).attach('file', pdf1, { filename: 'p.pdf', contentType: 'application/pdf' });
    expect(v1.status).toBe(200);
    const slip1 = v1.body.staff.find((s: { staffProfileId: string }) => s.staffProfileId === staff[1]!.profileId).payslip;
    expect(slip1).toMatchObject({ status: 'available', version: 1 });
    fileV1 = slip1.document.fileId;
    const same = await http().post(url).set(auth(tokenA)).attach('file', pdf1, { filename: 'p.pdf', contentType: 'application/pdf' });
    expect(same.body.staff.find((s: { staffProfileId: string }) => s.staffProfileId === staff[1]!.profileId).payslip.version).toBe(1);
    const v2 = await http().post(url).set(auth(tokenA)).attach('file', pdf2, { filename: 'p.pdf', contentType: 'application/pdf' });
    const slip2 = v2.body.staff.find((s: { staffProfileId: string }) => s.staffProfileId === staff[1]!.profileId).payslip;
    expect(slip2.version).toBe(2);
    fileV2 = slip2.document.fileId;
    const notes = await adminDataSource.query(`SELECT title FROM core.notification WHERE user_id = $1 AND type = 'payslip_available' ORDER BY created_at`, [staff[1]!.userId]);
    expect(notes.map((n: { title: string }) => n.title)).toEqual(['Your payslip is available', 'Your payslip was updated']);
    const docs = await adminDataSource.query(`SELECT d.version FROM core.payslip_document d JOIN core.payslip p ON p.id = d.payslip_id WHERE p.staff_profile_id = $1 ORDER BY d.version`, [staff[1]!.profileId]);
    expect(docs).toEqual([{ version: 1 }, { version: 2 }]);
    const audits = await adminDataSource.query(`SELECT count(*)::int AS n FROM core.audit_log WHERE action = 'payslip.uploaded' AND organisation_id = $1`, [orgId]);
    expect(audits[0].n).toBe(2);
  });

  it('payslip documents: staff read only their own CURRENT version; other staff, other workspace and Venue Managers get 404', async () => {
    expect((await http().get(`/rest/v1/files/${fileV2}/download`).set(auth(staffTokens[1]!))).status).toBe(200);
    expect((await http().get(`/rest/v1/files/${fileV1}/download`).set(auth(staffTokens[1]!))).status).toBe(404);
    expect((await http().get(`/rest/v1/files/${fileV1}/download`).set(auth(tokenA))).status).toBe(200);
    expect((await http().get(`/rest/v1/files/${fileV2}/download`).set(auth(staffTokens[0]!))).status).toBe(404);
    expect((await http().get(`/rest/v1/files/${fileV2}/download`).set(auth(tokenB))).status).toBe(404);
    expect((await http().get(`/rest/v1/files/${fileV2}/download`).set(auth(tokenVm))).status).toBe(404);
    const asStaff0 = await tenantContext.runInWorkspaceContext(ctxOf(staff[0]!), (m) => m.query(`SELECT staff_profile_id FROM payslip`));
    expect(asStaff0.map((r: { staff_profile_id: string }) => r.staff_profile_id)).toEqual([staff[0]!.profileId]);
    const mine0 = await http().get('/rest/v1/payroll/me/payslips').set(auth(staffTokens[0]!));
    expect(mine0.body.data.every((d: { document: unknown }) => d.document === null)).toBe(true);
  });

  it('net pay is provider-supplied only; paid ONLY via explicit payroll.mark_paid confirmation by an Internal Manager of the workspace', async () => {
    const held = await adminDataSource.query(
      `SELECT r.key FROM core.role r JOIN core.role_permission rp ON rp.role_id = r.id JOIN core.permission p ON p.id = rp.permission_id
        WHERE r.organisation_id = $1 AND p.key = 'payroll.mark_paid' ORDER BY r.key`, [orgId]);
    expect(held).toEqual([{ key: 'manager' }]);
    expect(ROLE_DEFS.internal!.permissions).toContain(PermissionFlag.PAYROLL_MARK_PAID);
    expect(ROLE_DEFS.venue!.permissions).not.toContain(PermissionFlag.PAYROLL_MARK_PAID);
    const net = await http().put(`/rest/v1/payroll/runs/${runId}/payslips/${staff[1]!.profileId}/net`).set(auth(tokenA)).send({ netPence: 9000 });
    expect(net.status).toBe(200);
    let mine = await http().get('/rest/v1/payroll/me/payslips').set(auth(staffTokens[1]!));
    expect(mine.body.data[0]).toMatchObject({ status: 'available', netPence: 9000, netSource: 'provider_document', paidAt: null, document: { version: 2 } });
    expect((await http().post(`/rest/v1/payroll/runs/${runId}/payslips/${staff[1]!.profileId}/mark-paid`).set(auth(tokenPlain)).send({})).status).toBe(404); // other organisation
    expect((await http().post(`/rest/v1/payroll/runs/${runId}/payslips/${staff[1]!.profileId}/mark-paid`).set(auth(tokenVm)).send({})).status).toBe(403);
    expect((await http().post(`/rest/v1/payroll/runs/${runId}/payslips/${staff[1]!.profileId}/mark-paid`).set(auth(staffTokens[1]!)).send({})).status).toBe(403);
    const paid = await http().post(`/rest/v1/payroll/runs/${runId}/payslips/${staff[1]!.profileId}/mark-paid`).set(auth(tokenA)).send({ paymentReference: 'BACS-123' });
    expect(paid.status).toBe(200);
    mine = await http().get('/rest/v1/payroll/me/payslips').set(auth(staffTokens[1]!));
    expect(mine.body.data[0]).toMatchObject({ status: 'paid', paidAt: expect.any(String) });
    expect((await adminDataSource.query(`SELECT status FROM core.payroll_record WHERE id = $1`, [rec.s1!.recordId]))[0].status).toBe('paid');
    const history = await http().get('/rest/v1/attendance/me/history').set(auth(staffTokens[1]!));
    expect(history.body.find((h: { id: string }) => h.id === rec.s1!.attendanceId)).toMatchObject({ payrollStatus: 'paid' });
    expect((await http().post(`/rest/v1/payroll/runs/${runId}/payslips/${staff[1]!.profileId}/mark-paid`).set(auth(tokenA)).send({})).status).toBe(409);
    const audit = await adminDataSource.query(`SELECT metadata FROM core.audit_log WHERE action = 'payslip.marked_paid' AND organisation_id = $1`, [orgId]);
    expect(audit[0].metadata).toMatchObject({ paymentReference: 'BACS-123' });
    // Staff 0's payslip in the same run is untouched (not paid without its own confirmation).
    expect((await http().get('/rest/v1/payroll/me/payslips').set(auth(staffTokens[0]!))).body.data[0].status).toBe('processing');
  });

  it('a manager can never confirm payment of their own pay (service 403 + RLS)', async () => {
    // Staff 0 is also made a manager of this workspace (manager role + internal manager profile) — the own-hours case.
    const [role] = await adminDataSource.query(`SELECT id FROM core.role WHERE organisation_id = $1 AND key = 'manager'`, [orgId]);
    await adminDataSource.query(`INSERT INTO core.user_role (user_id, role_id, organisation_id) VALUES ($1, $2, $3)`, [staff[0]!.userId, role.id, orgId]);
    await adminDataSource.query(`INSERT INTO core.manager_profile (organisation_id, user_id, type, workspace_id) VALUES ($1, $2, 'internal', $3)`, [orgId, staff[0]!.userId, a.workspaceId]);
    const asManager = await factory.login(staff[0]!, { applicationTarget: 'manager_web' });
    const own = await http().post(`/rest/v1/payroll/runs/${runId}/payslips/${staff[0]!.profileId}/mark-paid`).set(auth(asManager)).send({});
    expect(own.status).toBe(403);
    expect((await http().get('/rest/v1/payroll/me/payslips').set(auth(staffTokens[0]!))).body.data[0].status).toBe('processing');
    await expect(tenantContext.runInWorkspaceContext(ctxOf(staff[0]!), (m) => m.query(
      `UPDATE payslip SET paid_at = now(), paid_by = $2 WHERE staff_profile_id = $1`, [staff[0]!.profileId, staff[0]!.userId]))).rejects.toMatchObject({ code: '42501' });
  });

  it('failed statement retry: re-queued through the same durable path, audited; humans cannot forge statement state or skip the state machine', async () => {
    const id = rec.s0!.recordId;
    await adminDataSource.query(`ALTER TABLE core.payroll_record DISABLE TRIGGER payroll_record_guard`);
    try {
      await adminDataSource.query(`UPDATE core.payroll_record SET statement_status = 'failed', statement_attempts = 5, statement_error = 'generation_failed' WHERE id = $1`, [id]);
    } finally {
      await adminDataSource.query(`ALTER TABLE core.payroll_record ENABLE TRIGGER payroll_record_guard`);
    }
    expect((await http().post(`/rest/v1/payroll/records/${id}/statement/retry`).set(auth(tokenB))).status).toBe(404);
    const retry = await http().post(`/rest/v1/payroll/records/${id}/statement/retry`).set(auth(tokenA));
    expect(retry.status).toBe(200);
    expect(retry.body.statement.state).toBe('processing');
    expect((await adminDataSource.query(`SELECT statement_status, statement_attempts, statement_error FROM core.payroll_record WHERE id = $1`, [id]))[0])
      .toEqual({ statement_status: 'pending', statement_attempts: 0, statement_error: null });
    expect((await http().post(`/rest/v1/payroll/records/${id}/statement/retry`).set(auth(tokenA))).status).toBe(409);
    const audits = await adminDataSource.query(`SELECT count(*)::int AS n FROM core.audit_log WHERE action = 'payroll_record.shift_statement_retry_requested' AND entity_id::text = $1`, [id]);
    expect(audits[0].n).toBe(1);
    await expect(tenantContext.runInWorkspaceContext(ctxOf(a), (m) => m.query(`UPDATE payroll_record SET statement_status = 'generated' WHERE id = $1`, [id]))).rejects.toMatchObject({ code: '42501' });
    await expect(tenantContext.runInWorkspaceContext(ctxOf(a), (m) => m.query(`UPDATE payroll_record SET status = 'pending_approval' WHERE id = $1`, [id]))).rejects.toMatchObject({ code: '23514' });
  });

  it('new tables return zero rows with no tenant context; lines and documents are insert-only', async () => {
    for (const t of ['payroll_calendar', 'payroll_calendar_period', 'payroll_run', 'payroll_run_line', 'payslip', 'payslip_document']) {
      expect(await dataSource.manager.query(`SELECT * FROM core.${t}`)).toEqual([]);
    }
    await expect(tenantContext.runInWorkspaceContext(ctxOf(a), (m) => m.query(`DELETE FROM payroll_run_line WHERE run_id = $1`, [runId]))).rejects.toMatchObject({ code: '42501' });
    await expect(tenantContext.runInWorkspaceContext(ctxOf(a), (m) => m.query(`UPDATE payroll_run_line SET amount_pence = 1 WHERE run_id = $1`, [runId]))).rejects.toMatchObject({ code: '42501' });
    await expect(tenantContext.runInWorkspaceContext(ctxOf(a), (m) => m.query(`UPDATE payslip_document SET version = 9`))).rejects.toMatchObject({ code: '42501' });
    await expect(tenantContext.runInTenantContext(ctxOf(a), (m) => m.query(`DELETE FROM core.payroll_calendar_period`))).rejects.toMatchObject({ code: '42501' });
  });

  it('real records either side of a period boundary and both clock changes are allocated by their London scheduled date; pay is unchanged', async () => {
    const statementOf = async (i: number) => (await http().get('/rest/v1/payroll/me/statements').set(auth(staffTokens[i]!))).body.data[0];
    // Spring: the 16 Mar – 29 Mar period ends on the day clocks go forward (01:00 UTC); no run exists for either period.
    const lastOfPeriod = await recordFor(3, true, '2026-03-29T22:30:00Z'); // 23:30 BST on Sunday 29 Mar
    expect(await statementOf(3)).toMatchObject({ allocationStatus: 'allocated', payday: '2026-04-08', payrollPeriod: { start: '2026-03-16', end: '2026-03-29' } });
    const firstOfNext = await recordFor(4, true, '2026-03-29T23:30:00Z'); // 00:30 BST on Monday 30 Mar
    expect(await statementOf(4)).toMatchObject({ allocationStatus: 'allocated', payday: '2026-04-22', payrollPeriod: { start: '2026-03-30', end: '2026-04-12' } });
    // Autumn: the 12 Oct – 25 Oct period ends on the day clocks go back; 00:30 GMT on 26 Oct is already the next period.
    const afterAutumn = await recordFor(3, true, '2026-10-26T00:30:00Z');
    expect(await statementOf(3)).toMatchObject({ payday: '2026-11-18', payrollPeriod: { start: '2026-10-26', end: '2026-11-08' } });

    // Pinning the scheduled date never touches the pay calculation: same worked minutes, rate and amount as a record
    // made by the same flow in the default period.
    const pay = await adminDataSource.query(
      `SELECT id, worked_minutes, pay_rate_pence::text AS rate, amount_pence::text AS amount FROM core.payroll_record WHERE id = ANY($1::uuid[])`,
      [[rec.s1!.recordId, lastOfPeriod, firstOfNext, afterAutumn]],
    );
    const reference = pay.find((p: { id: string }) => p.id === rec.s1!.recordId);
    expect(reference.worked_minutes).toBeGreaterThan(0);
    for (const p of pay) expect({ worked_minutes: p.worked_minutes, rate: p.rate, amount: p.amount }).toEqual({ worked_minutes: reference.worked_minutes, rate: reference.rate, amount: reference.amount });
  });
});
