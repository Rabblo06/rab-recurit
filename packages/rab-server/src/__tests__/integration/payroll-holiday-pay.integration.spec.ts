import 'reflect-metadata';
import './helpers/use-local-storage-env'; // MUST be imported before AppModule — see that file's own doc comment

import { rolledUpHolidayPayPence } from '@rab/shared';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';
import { AuthCacheRedisClientProvider } from '../../engine/core-modules/auth/services/auth-cache-redis-client.provider';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { AuthContext } from '../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { applyGlobalValidationPipe } from '../../engine/utils/global-validation-pipe';
import { AttendanceQrService } from '../../modules/attendance/services/attendance-qr.service';
import { payrollDate } from '../../modules/payroll/services/payroll-allocation';
import { Shift } from '../../modules/scheduling/entities/shift.entity';
import { createAdminDataSource } from './helpers/admin-datasource';
import { bookBeforeDeadline } from './helpers/book-before-deadline';
import { businessTable } from './helpers/hws-fixtures';
import { insertMembership, TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Rolled-up holiday pay (owner decision 4, assumption A3; PayrollHolidayPay1786723110000). Real HTTP + PostgreSQL with RLS
 * as the runtime login, no mocks. One world, in order:
 *  - the per-organisation setting: default rolled-up 12.07%; only the CURRENT Initial Manager changes it, with a recent
 *    step-up; Venue Managers, other managers and other organisations are refused; mass assignment is a 400;
 *  - the snapshot at approval: rolled-up pence = @rab/shared rolledUpHolidayPayPence (nearest penny, half up), or a zero
 *    "provider" line; insert-only (no UPDATE / DELETE), the database re-checks the rounding; RLS per role; zero rows
 *    without tenant context;
 *  - runs: the run shows and exports each line's frozen holiday pay, back-fills a record that has none at prepare, and a
 *    finalised run never changes when the setting changes later; the staff payslip timeline shows their own.
 */
const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;

jest.setTimeout(300_000);

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const sidOf = (token: string) => (JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as { sid: string }).sid;
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

describeIfDb('rolled-up holiday pay (integration, owner decision 4)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let factory: TestIdentityFactory;
  let tenantContext: TenantContextService;
  let attendanceQr: AttendanceQrService;
  let authRedis: AuthCacheRedisClientProvider;
  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  let orgId: string;
  let a: TestIdentity;
  let c: TestIdentity;
  let staff: TestIdentity[];
  let tokenA: string;
  let tokenVm: string;
  let otherManager: TestIdentity;
  let staffTokens: string[];
  let venueId: string;
  let jobRoleId: string;
  let periodStart: string;

  const ctxOf = (userId: string): AuthContext => ({ organisationId: orgId, workspaceId: a.workspaceId, userId, role: '' }) as AuthContext;
  const asUser = <T>(userId: string, sql: string, params: unknown[] = []) => tenantContext.runInTenantContext(ctxOf(userId), (m) => m.query(sql, params) as Promise<T>);
  const fresh = (who: TestIdentity) => factory.login(who);
  const stale = async (who: TestIdentity) => {
    const token = await factory.login(who);
    await authRedis.client.del(`crewflow:test:step-up:${sha256(sidOf(token))}`);
    return token;
  };
  const snapshot = async (recordId: string) => (await adminDataSource.query(`SELECT * FROM core.payroll_record_holiday_pay WHERE payroll_record_id = $1`, [recordId]))[0];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = applyGlobalValidationPipe(moduleRef.createNestApplication());
    await app.init();
    dataSource = moduleRef.get(DataSource);
    tenantContext = moduleRef.get(TenantContextService);
    attendanceQr = moduleRef.get(AttendanceQrService);
    authRedis = moduleRef.get(AuthCacheRedisClientProvider);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = new TestIdentityFactory({ app, dataSource, adminDataSource, tenantContext, passwordHashing: moduleRef.get(PasswordHashingService) });
    const seeded = await factory.createOrganisationWithManagers(1, { workspace: true, permissions: 'production', label: 'hol' });
    orgId = seeded.organisation.id;
    a = seeded.managers[0]!;
    await adminDataSource.query(`UPDATE core.manager_profile SET is_initial_manager = true WHERE user_id = $1`, [a.userId]);
    const colleague = await factory.createInternalManager(seeded.organisation, { workspace: false, permissions: 'production', label: 'hol-approver' });
    await adminDataSource.query(`UPDATE core.manager_profile SET workspace_id = $2 WHERE user_id = $1`, [colleague.userId, a.workspaceId]);
    await adminDataSource.transaction((m) => insertMembership(m, orgId, colleague.userId, a.workspaceId!));
    c = { ...colleague, workspaceId: a.workspaceId };
    staff = [];
    for (let i = 0; i < 3; i++) staff.push(await factory.createStaff(seeded.organisation, { owner: a, label: `hol-s${i}` }));
    await adminDataSource.query(`UPDATE ${businessTable(a.workspaceId!, 'staff_profile')} SET employment_status = 'active' WHERE id = ANY($1::uuid[])`, [staff.map((s) => s.profileId)]);
    tokenA = await factory.login(a);
    staffTokens = [];
    for (const s of staff) staffTokens.push(await factory.login(s));
    venueId = (await http().post('/rest/v1/venues').set(auth(tokenA)).send({ name: `Hol Venue ${randomUUID().slice(0, 6)}`, type: 'hotel' })).body.id;
    jobRoleId = (await http().post('/rest/v1/job-roles').set(auth(tokenA)).send({ name: `Role-${randomUUID()}`, defaultRatePence: 1500 })).body.id;
    tokenVm = await factory.login(await factory.createVenueManager(seeded.organisation, { owner: a, venueIds: [venueId], label: 'hol-vm' }));
    otherManager = (await factory.createOrganisationWithManagers(1, { workspace: true, permissions: 'production', label: 'hol-other' })).managers[0]!;
    const today = payrollDate(new Date());
    periodStart = addDays(today, -7);
    const periods = [0, 1, 2].map((k) => ({ start: addDays(periodStart, 14 * k), end: addDays(periodStart, 14 * k + 13), payday: addDays(periodStart, 14 * k + 23) }));
    expect((await http().post('/rest/v1/payroll/calendar/import').set(auth(tokenA)).send({ year: Number(today.slice(0, 4)), source: 'Holiday pay test calendar', periods })).status).toBe(200);
  });

  afterAll(async () => {
    await app?.close();
    await adminDataSource?.destroy();
  });

  async function signQr(shiftId: string): Promise<string> {
    return tenantContext.runInTenantContext({ organisationId: orgId, workspaceId: a.workspaceId, userId: a.userId, role: '' }, async (m) =>
      attendanceQr.sign(await m.findOneByOrFail(Shift, { id: shiftId })));
  }

  /** Work → finalise (A) → approve (C) one shift for staff[i]; returns the payroll record id and its approved gross. */
  async function approvedRecordFor(i: number): Promise<{ id: string; amountPence: number }> {
    const s = staff[i]!;
    const shift = await http().post('/rest/v1/shifts').set(auth(tokenA)).send({
      venueId, jobRoleId, startsAt: new Date(Date.now() - 5 * 60_000).toISOString(), endsAt: new Date(Date.now() + 8 * 3600_000).toISOString(), requiredCount: 1 });
    const shiftId = shift.body.id as string;
    expect((await http().post(`/rest/v1/shifts/${shiftId}/publish`).set(auth(tokenA))).status).toBe(201);
    await bookBeforeDeadline(adminDataSource, shiftId, async () => {
      const offer = await http().post(`/rest/v1/shifts/${shiftId}/offers`).set(auth(tokenA)).send({ staffProfileId: s.profileId });
      expect(offer.status).toBe(201);
      expect((await http().post(`/rest/v1/offers/${offer.body.id}/accept`).set(auth(staffTokens[i]!))).status).toBe(201);
      expect((await http().post(`/rest/v1/offers/${offer.body.id}/confirm`).set(auth(tokenA))).status).toBe(201);
    });
    expect((await http().post('/rest/v1/attendance/check-in').set(auth(staffTokens[i]!)).send({ shiftId })).status).toBe(200);
    expect((await http().post('/rest/v1/attendance/clock-in').set(auth(staffTokens[i]!)).send({ shiftId, qrToken: await signQr(shiftId) })).status).toBe(201);
    const out = await http().post('/rest/v1/attendance/clock-out').set(auth(staffTokens[i]!)).send({ qrToken: await signQr(shiftId) });
    expect((await http().post(`/rest/v1/attendance/${out.body.id}/correct`).set(auth(tokenA))
      .send({ field: 'clockInAt', newValue: new Date(new Date(out.body.clockOutAt).getTime() - (200 + 17 * i) * 60_000).toISOString(), reason: 'Holiday pay test worked time', confirmUnusualClockIn: true })).status).toBe(201);
    expect((await http().post(`/rest/v1/attendance/report/shift/${shiftId}/staff/${s.profileId}/attendance-review`).set(auth(tokenA))).status).toBe(200);
    expect((await http().patch(`/rest/v1/attendance/report/shift/${shiftId}/finalise`).set(auth(tokenA))).status).toBe(200);
    const [rec] = await adminDataSource.query(`SELECT id, amount_pence FROM ${businessTable(a.workspaceId!, 'payroll_record')} WHERE attendance_id = $1`, [out.body.id]);
    expect((await http().post(`/rest/v1/payroll/records/${rec.id}/approve`).set(auth(await fresh(c)))).status).toBe(200);
    return { id: rec.id as string, amountPence: Number(rec.amount_pence) };
  }

  const recs: Array<{ id: string; amountPence: number }> = [];

  it('with no tenant context bound, both tables return zero rows (runtime login)', async () => {
    for (const t of ['organisation_payroll_setting', 'payroll_record_holiday_pay']) {
      expect((await dataSource.query(`SELECT count(*)::int AS n FROM core.${t}`))[0].n).toBe(0);
    }
  });

  it('the setting: default rolled-up 12.07%; only the current Initial Manager changes it, with a recent step-up', async () => {
    const def = await http().get('/rest/v1/payroll/settings/holiday-pay').set(auth(tokenA));
    expect(def.status).toBe(200);
    expect(def.body).toMatchObject({ mode: 'rolled_up', rateBps: 1207, isDefault: true, canManage: true });
    expect((await http().get('/rest/v1/payroll/settings/holiday-pay').set(auth(await fresh(c)))).body.canManage).toBe(false);
    expect((await http().get('/rest/v1/payroll/settings/holiday-pay').set(auth(tokenVm))).status).toBe(403);

    // Not the Initial Manager (fresh session, holds payroll.calculate): 403. Venue Manager: 403 at the route.
    expect((await http().post('/rest/v1/payroll/settings/holiday-pay/use-provider').set(auth(await fresh(c)))).status).toBe(403);
    expect((await http().post('/rest/v1/payroll/settings/holiday-pay/use-provider').set(auth(tokenVm))).status).toBe(403);
    // Stale session of the Initial Manager: STEP_UP_REQUIRED, nothing written, refusal audited.
    const staleRes = await http().post('/rest/v1/payroll/settings/holiday-pay/use-provider').set(auth(await stale(a)));
    expect({ status: staleRes.status, code: staleRes.body.code }).toEqual({ status: 403, code: 'STEP_UP_REQUIRED' });
    expect(await adminDataSource.query(`SELECT 1 FROM core.organisation_payroll_setting WHERE organisation_id = $1`, [orgId])).toEqual([]);
    // Mass assignment and bad rates: 400.
    for (const body of [{ rateBps: 1207, organisationId: randomUUID() }, { rateBps: 1207, mode: 'provider' }, { rateBps: 0 }, { rateBps: 10001 }, { rateBps: 12.07 }, {}]) {
      expect((await http().post('/rest/v1/payroll/settings/holiday-pay/use-rolled-up-rate').set(auth(await fresh(a))).send(body)).status).toBe(400);
    }
    // Another organisation's Initial-less manager changes only... nothing here: their own organisation, refused (not Initial).
    expect((await http().post('/rest/v1/payroll/settings/holiday-pay/use-provider').set(auth(await fresh(otherManager)))).status).toBe(403);
    // RLS backstop: a non-Initial manager writing the row directly is refused.
    await expect(asUser(c.userId, `INSERT INTO core.organisation_payroll_setting (organisation_id, holiday_pay_mode, updated_by) VALUES ($1, 'provider', $2)`, [orgId, c.userId]))
      .rejects.toMatchObject({ code: '42501' });
    // The Initial Manager naming someone else as the author: refused.
    await expect(asUser(a.userId, `INSERT INTO core.organisation_payroll_setting (organisation_id, holiday_pay_mode, updated_by) VALUES ($1, 'provider', $2)`, [orgId, c.userId]))
      .rejects.toMatchObject({ code: '42501' });
  });

  it('approval freezes rolled-up holiday pay with the shared rounding rule; insert-only; RLS per role', async () => {
    recs.push(await approvedRecordFor(0));
    const s0 = await snapshot(recs[0]!.id);
    expect({ mode: s0.mode, rate: s0.rate_bps, base: Number(s0.base_pence), pay: Number(s0.holiday_pay_pence), by: s0.created_by, user: s0.staff_user_id }).toEqual({
      mode: 'rolled_up', rate: 1207, base: recs[0]!.amountPence, pay: rolledUpHolidayPayPence(recs[0]!.amountPence, 1207), by: c.userId, user: staff[0]!.userId,
    });
    // Insert-only: no UPDATE / DELETE for the runtime login, even for a payroll manager.
    await expect(asUser(c.userId, `UPDATE core.payroll_record_holiday_pay SET holiday_pay_pence = 0 WHERE payroll_record_id = $1`, [recs[0]!.id])).rejects.toMatchObject({ code: '42501' });
    await expect(asUser(c.userId, `DELETE FROM core.payroll_record_holiday_pay WHERE payroll_record_id = $1`, [recs[0]!.id])).rejects.toMatchObject({ code: '42501' });
    // The database re-derives the rounding: a figure that does not follow it cannot be stored, by anyone.
    await expect(adminDataSource.query(
      `INSERT INTO core.payroll_record_holiday_pay (organisation_id, workspace_id, payroll_record_id, staff_profile_id, staff_user_id, mode, rate_bps, base_pence, holiday_pay_pence, created_by)
       VALUES ($1, $2, $3, $4, $5, 'rolled_up', 1207, 4142, 499, $6)`, [orgId, a.workspaceId, randomUUID(), staff[0]!.profileId, staff[0]!.userId, c.userId])).rejects.toMatchObject({ code: '23514' });
    // A Venue Manager or staff member cannot insert a snapshot.
    await expect(asUser(staff[0]!.userId, `INSERT INTO core.payroll_record_holiday_pay (organisation_id, workspace_id, payroll_record_id, staff_profile_id, staff_user_id, mode, base_pence, holiday_pay_pence, created_by)
       VALUES ($1, $2, $3, $4, $5, 'provider', 0, 0, $5)`, [orgId, a.workspaceId, randomUUID(), staff[0]!.profileId, staff[0]!.userId])).rejects.toMatchObject({ code: '42501' });
    // Reads: the staff member sees their own; another staff member and the Venue Manager see none; another organisation none.
    expect(await asUser<unknown[]>(staff[0]!.userId, `SELECT 1 FROM core.payroll_record_holiday_pay`)).toHaveLength(1);
    expect(await asUser<unknown[]>(staff[1]!.userId, `SELECT 1 FROM core.payroll_record_holiday_pay`)).toHaveLength(0);
    const [vmUser] = await adminDataSource.query(`SELECT user_id FROM core.manager_profile WHERE workspace_id = $1 AND type = 'venue' LIMIT 1`, [a.workspaceId]);
    expect(await asUser<unknown[]>(vmUser.user_id, `SELECT 1 FROM core.payroll_record_holiday_pay`)).toHaveLength(0);
    expect(await tenantContext.runInTenantContext({ organisationId: randomUUID(), workspaceId: a.workspaceId, userId: c.userId, role: '' } as AuthContext,
      (m) => m.query(`SELECT 1 FROM core.payroll_record_holiday_pay`))).toEqual([]);
  });

  it('"payroll provider handles it": later approvals freeze a zero line; earlier records keep their figure (never recalculated)', async () => {
    const set = await http().post('/rest/v1/payroll/settings/holiday-pay/use-provider').set(auth(await fresh(a)));
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ mode: 'provider', rateBps: null, isDefault: false });
    const audit = await adminDataSource.query(`SELECT metadata FROM core.audit_log WHERE action = 'payroll_setting.holiday_pay_changed' AND organisation_id = $1`, [orgId]);
    expect(audit[0].metadata).toMatchObject({ before: { mode: 'rolled_up', rateBps: 1207, isDefault: true }, after: { mode: 'provider', rateBps: null } });
    recs.push(await approvedRecordFor(1));
    const s1 = await snapshot(recs[1]!.id);
    expect({ mode: s1.mode, rate: s1.rate_bps, pay: Number(s1.holiday_pay_pence) }).toEqual({ mode: 'provider', rate: null, pay: 0 });
    expect(Number((await snapshot(recs[0]!.id)).holiday_pay_pence)).toBe(rolledUpHolidayPayPence(recs[0]!.amountPence, 1207));
  });

  it('runs: prepare back-fills a record with no snapshot at the CURRENT setting; view and CSV show each line; a finalised run never changes', async () => {
    expect((await http().post('/rest/v1/payroll/settings/holiday-pay/use-rolled-up-rate').set(auth(await fresh(a))).send({ rateBps: 1250 })).status).toBe(200);
    recs.push(await approvedRecordFor(2));
    // Simulate a record approved before holiday pay existed: remove its snapshot (fixture write, superuser).
    await adminDataSource.query(`DELETE FROM core.payroll_record_holiday_pay WHERE payroll_record_id = $1`, [recs[2]!.id]);
    expect((await http().post('/rest/v1/payroll/settings/holiday-pay/use-rolled-up-rate').set(auth(await fresh(a))).send({ rateBps: 1000 })).status).toBe(200);

    const list = (await http().get('/rest/v1/payroll/runs').set(auth(tokenA))).body.periods;
    const period = list.find((p: { period: { start: string } }) => p.period.start === periodStart).period;
    const prepared = await http().post('/rest/v1/payroll/runs/prepare').set(auth(tokenA)).send({ periodId: period.id });
    expect(prepared.status).toBe(200);
    const expected = [rolledUpHolidayPayPence(recs[0]!.amountPence, 1207), 0, rolledUpHolidayPayPence(recs[2]!.amountPence, 1000)];
    const s2 = await snapshot(recs[2]!.id);
    expect({ rate: s2.rate_bps, pay: Number(s2.holiday_pay_pence), by: s2.created_by }).toEqual({ rate: 1000, pay: expected[2], by: a.userId });
    const row = (i: number) => prepared.body.staff.find((s: { staffProfileId: string }) => s.staffProfileId === staff[i]!.profileId);
    for (let i = 0; i < 3; i++) {
      expect(row(i)).toMatchObject({ grossPence: recs[i]!.amountPence, holidayPayPence: expected[i], totalPence: recs[i]!.amountPence + expected[i]! });
    }
    expect(prepared.body.totals.holidayPayPence).toBe(expected.reduce((x, y) => x + y, 0));
    const csv = await http().get(`/rest/v1/payroll/runs/${prepared.body.id}/export`).set(auth(tokenA));
    expect((csv.text as string).split('\n')[0]).toContain('Gross (GBP),Holiday pay (GBP)');
    expect(csv.text).toContain(`,${(expected[0]! / 100).toFixed(2)},`);

    expect((await http().post(`/rest/v1/payroll/runs/${prepared.body.id}/finalise`).set(auth(await fresh(c)))).status).toBe(200);
    const before = (await http().get(`/rest/v1/payroll/runs/${prepared.body.id}`).set(auth(tokenA))).body;
    expect((await http().post('/rest/v1/payroll/settings/holiday-pay/use-rolled-up-rate').set(auth(await fresh(a))).send({ rateBps: 1207 })).status).toBe(200);
    const after = (await http().get(`/rest/v1/payroll/runs/${prepared.body.id}`).set(auth(tokenA))).body;
    expect(after.totals).toEqual(before.totals);
    expect(after.staff.map((s: { holidayPayPence: number }) => s.holidayPayPence)).toEqual(before.staff.map((s: { holidayPayPence: number }) => s.holidayPayPence));
  });

  it('staff payslip timeline: their own holiday pay line and total; never another person\'s', async () => {
    const mine = await http().get('/rest/v1/payroll/me/payslips').set(auth(staffTokens[0]!));
    expect(mine.status).toBe(200);
    const entry = mine.body.data.find((e: { period: { start: string } }) => e.period.start === periodStart);
    const hp = rolledUpHolidayPayPence(recs[0]!.amountPence, 1207);
    expect(entry).toMatchObject({ grossPence: recs[0]!.amountPence, holidayPayPence: hp, totalPence: recs[0]!.amountPence + hp });
    const provider = await http().get('/rest/v1/payroll/me/payslips').set(auth(staffTokens[1]!));
    expect(provider.body.data.find((e: { period: { start: string } }) => e.period.start === periodStart)).toMatchObject({ holidayPayPence: 0 });
    expect((await dataSource.query(`SELECT count(*)::int AS n FROM core.payroll_record_holiday_pay`))[0].n).toBe(0);
  });
});
