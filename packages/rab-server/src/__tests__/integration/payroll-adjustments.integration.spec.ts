import 'reflect-metadata';
import './helpers/use-local-storage-env'; // MUST be imported before AppModule — see that file's own doc comment

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
 * Payroll adjustments (owner decision 3, PayrollAdjustmentSchema1786723100000). Real HTTP + PostgreSQL with RLS as the
 * runtime login (crewflow_app), no mocks. One world, scenarios in order:
 *  - add (corrections / bonuses / expenses), approve and reject as named actions; the approver is never the creator
 *    (decision 5's rule) and needs a recent step-up of the session; Venue Managers, staff and another organisation get
 *    403 / 404; a body carrying organisationId / status / createdBy is a 400;
 *  - the database layers on their own: zero rows without tenant context, RLS per role, CHECK constraints for the
 *    segregation rule, the guard trigger (state machine, immutable figures, payroll lock), no DELETE;
 *  - payroll runs: approved lines join the run of their period, show in totals, the CSV export and the staff payslip
 *    timeline, are locked when the run is finalised, and a line approved after that sits on the next period.
 *
 * Calendar: a 4-period agency calendar built around today (Europe/London), so the suite never depends on the machine date.
 * People: A (Internal Manager, workspace owner: prepares, adds adjustments), C (a second non-venue manager of A's workspace:
 * approves), a Venue Manager of A's workspace, staff s0..s3 (s3 only holds an unapproved record), and a manager of another organisation.
 */
const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;

jest.setTimeout(300_000);

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const sidOf = (token: string) => (JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as { sid: string }).sid;
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

describeIfDb('payroll adjustments (integration, owner decision 3)', () => {
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
  let tokenOther: string;
  let otherManager: TestIdentity;
  let staffTokens: string[];
  let venueId: string;
  let jobRoleId: string;
  let periods: Array<{ start: string; end: string; payday: string }>;

  const ctxOf = (userId: string): AuthContext => ({ organisationId: orgId, workspaceId: a.workspaceId, userId, role: '' }) as AuthContext;
  const asUser = <T>(userId: string, sql: string, params: unknown[] = []) => tenantContext.runInTenantContext(ctxOf(userId), (m) => m.query(sql, params) as Promise<T>);
  const row = async (id: string) => (await adminDataSource.query(`SELECT * FROM core.payroll_adjustment WHERE id = $1`, [id]))[0];
  /** A fresh sign-in records a step-up grant for its session (OIDC max_age semantics). */
  const freshToken = (who: TestIdentity) => factory.login(who);
  const staleToken = async (who: TestIdentity) => {
    const token = await factory.login(who);
    await authRedis.client.del(`crewflow:test:step-up:${sha256(sidOf(token))}`);
    return token;
  };

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
    const seeded = await factory.createOrganisationWithManagers(1, { workspace: true, permissions: 'production', label: 'adj' });
    orgId = seeded.organisation.id;
    a = seeded.managers[0]!;
    await adminDataSource.query(`UPDATE core.manager_profile SET is_initial_manager = true WHERE user_id = $1`, [a.userId]);
    // C: a second non-venue manager working in A's workspace (the approver; never the person who added the line).
    const colleague = await factory.createInternalManager(seeded.organisation, { workspace: false, permissions: 'production', label: 'adj-approver' });
    await adminDataSource.query(`UPDATE core.manager_profile SET workspace_id = $2 WHERE user_id = $1`, [colleague.userId, a.workspaceId]);
    await adminDataSource.transaction((m) => insertMembership(m, orgId, colleague.userId, a.workspaceId!));
    c = { ...colleague, workspaceId: a.workspaceId };
    staff = [];
    for (let i = 0; i < 4; i++) staff.push(await factory.createStaff(seeded.organisation, { owner: a, label: `adj-s${i}` }));
    await adminDataSource.query(`UPDATE ${businessTable(a.workspaceId!, 'staff_profile')} SET employment_status = 'active' WHERE id = ANY($1::uuid[])`, [staff.map((s) => s.profileId)]);
    tokenA = await factory.login(a);
    staffTokens = [];
    for (const s of staff) staffTokens.push(await factory.login(s));
    venueId = (await http().post('/rest/v1/venues').set(auth(tokenA)).send({ name: `Adj Venue ${randomUUID().slice(0, 6)}`, type: 'hotel' })).body.id;
    jobRoleId = (await http().post('/rest/v1/job-roles').set(auth(tokenA)).send({ name: `Role-${randomUUID()}`, defaultRatePence: 1500 })).body.id;
    tokenVm = await factory.login(await factory.createVenueManager(seeded.organisation, { owner: a, venueIds: [venueId], label: 'adj-vm' }));
    const other = await factory.createOrganisationWithManagers(1, { workspace: true, permissions: 'production', label: 'adj-other' });
    otherManager = other.managers[0]!;
    tokenOther = await factory.login(otherManager);

    // Agency calendar around today: P0 (past), P1 (contains today), P2, P3.
    const today = payrollDate(new Date());
    periods = [0, 1, 2, 3].map((k) => {
      const start = addDays(today, -21 + 14 * k);
      return { start, end: addDays(start, 13), payday: addDays(start, 23) };
    });
    const cal = await http().post('/rest/v1/payroll/calendar/import').set(auth(tokenA)).send({ year: Number(today.slice(0, 4)), source: 'Adjustments test calendar', periods });
    expect(cal.status).toBe(200);
  });

  afterAll(async () => {
    await app?.close();
    await adminDataSource?.destroy();
  });

  async function signQr(shiftId: string): Promise<string> {
    return tenantContext.runInTenantContext({ organisationId: orgId, workspaceId: a.workspaceId, userId: a.userId, role: '' }, async (m) =>
      attendanceQr.sign(await m.findOneByOrFail(Shift, { id: shiftId })));
  }

  /** Work → finalise (A) → approve (C, a different person) one shift for staff[i]; returns the payroll record id and its amount. */
  async function approvedRecordFor(i: number, approve = true): Promise<{ id: string; amountPence: number }> {
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
      .send({ field: 'clockInAt', newValue: new Date(new Date(out.body.clockOutAt).getTime() - 240 * 60_000).toISOString(), reason: 'Adjustments test worked time', confirmUnusualClockIn: true })).status).toBe(201);
    expect((await http().post(`/rest/v1/attendance/report/shift/${shiftId}/staff/${s.profileId}/attendance-review`).set(auth(tokenA))).status).toBe(200);
    expect((await http().patch(`/rest/v1/attendance/report/shift/${shiftId}/finalise`).set(auth(tokenA))).status).toBe(200);
    const [rec] = await adminDataSource.query(`SELECT id, amount_pence FROM ${businessTable(a.workspaceId!, 'payroll_record')} WHERE attendance_id = $1`, [out.body.id]);
    if (approve) expect((await http().post(`/rest/v1/payroll/records/${rec.id}/approve`).set(auth(await freshToken(c)))).status).toBe(200);
    return { id: rec.id as string, amountPence: Number(rec.amount_pence) };
  }

  const ids: Record<string, string> = {};
  let s1Record: { id: string; amountPence: number };

  it('with no tenant context bound, the table returns zero rows (runtime login, before and after rows exist)', async () => {
    const before = await dataSource.query(`SELECT count(*)::int AS n FROM core.payroll_adjustment`);
    expect(before[0].n).toBe(0);
    const [{ who, bypass }] = await dataSource.query(`SELECT current_user AS who, (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass`);
    expect({ who, bypass }).toEqual({ who: 'crewflow_app', bypass: false });
  });

  it('add a bonus and an expense: named actions, pending, audited; mass-assignment and wrong callers refused', async () => {
    const bonus = await http().post('/rest/v1/payroll/adjustments/bonuses').set(auth(tokenA)).send({ staffProfileId: staff[0]!.profileId, amountPence: 2500, reason: 'Covered a late shift' });
    expect(bonus.status).toBe(201);
    expect(bonus.body).toMatchObject({ kind: 'bonus', status: 'pending_approval', amountPence: 2500, staffProfileId: staff[0]!.profileId, createdByMe: true, runId: null, locked: false });
    ids.bonus = bonus.body.id;
    const expense = await http().post('/rest/v1/payroll/adjustments/expenses').set(auth(tokenA)).send({ staffProfileId: staff[2]!.profileId, amountPence: 1234, reason: 'Taxi home after a 2am finish' });
    expect(expense.status).toBe(201);
    ids.expense = expense.body.id;
    expect((await row(ids.bonus)).created_by).toBe(a.userId);
    expect((await row(ids.bonus)).staff_user_id).toBe(staff[0]!.userId);

    for (const extra of [{ organisationId: randomUUID() }, { status: 'approved' }, { createdBy: c.userId }, { staffUserId: a.userId }, { workspaceId: randomUUID() }]) {
      const r = await http().post('/rest/v1/payroll/adjustments/bonuses').set(auth(tokenA)).send({ staffProfileId: staff[0]!.profileId, amountPence: 100, reason: 'Mass assignment', ...extra });
      expect(r.status).toBe(400);
    }
    // No deduction route, and no negative bonus / expense.
    expect((await http().post('/rest/v1/payroll/adjustments/deductions').set(auth(tokenA)).send({ staffProfileId: staff[0]!.profileId, amountPence: 100, reason: 'Uniform' })).status).toBe(404);
    expect((await http().post('/rest/v1/payroll/adjustments/bonuses').set(auth(tokenA)).send({ staffProfileId: staff[0]!.profileId, amountPence: -100, reason: 'Negative' })).status).toBe(400);
    expect((await http().post('/rest/v1/payroll/adjustments/expenses').set(auth(tokenA)).send({ staffProfileId: staff[0]!.profileId, amountPence: 0, reason: 'Zero' })).status).toBe(400);
    // Venue Manager: 403 at the route; staff (mobile session) refused; another organisation: the staff member is a 404.
    expect((await http().post('/rest/v1/payroll/adjustments/bonuses').set(auth(tokenVm)).send({ staffProfileId: staff[0]!.profileId, amountPence: 100, reason: 'VM bonus' })).status).toBe(403);
    expect((await http().post('/rest/v1/payroll/adjustments/bonuses').set(auth(staffTokens[1]!)).send({ staffProfileId: staff[1]!.profileId, amountPence: 100, reason: 'Self bonus' })).status).toBe(403);
    expect((await http().post('/rest/v1/payroll/adjustments/bonuses').set(auth(tokenOther)).send({ staffProfileId: staff[0]!.profileId, amountPence: 100, reason: 'Cross org' })).status).toBe(404);
    expect((await adminDataSource.query(`SELECT count(*)::int AS n FROM core.payroll_adjustment WHERE organisation_id = $1`, [orgId]))[0].n).toBe(2);
    const audit = await adminDataSource.query(`SELECT target_user_id, metadata FROM core.audit_log WHERE action = 'payroll_adjustment.created' AND entity_id = $1`, [ids.bonus]);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ target_user_id: staff[0]!.userId, metadata: { kind: 'bonus', amountPence: 2500 } });
  });

  it('approval: never the creator; needs a recent step-up; a second person approves once; a decision never changes', async () => {
    // Fresh sessions where the step-up is not what is being tested (approve checks the step-up first).
    const own = await http().post(`/rest/v1/payroll/adjustments/${ids.bonus}/approve`).set(auth(await freshToken(a)));
    expect(own.status).toBe(403);
    expect(own.body.code).toBe('PAYROLL_ADJUSTMENT_SAME_PERSON');
    expect((await http().post(`/rest/v1/payroll/adjustments/${ids.bonus}/approve`).set(auth(tokenVm))).status).toBe(403);
    expect((await http().post(`/rest/v1/payroll/adjustments/${ids.bonus}/approve`).set(auth(await freshToken(otherManager)))).status).toBe(404);
    expect((await http().post(`/rest/v1/payroll/adjustments/${randomUUID()}/approve`).set(auth(await freshToken(c)))).status).toBe(404);

    const stale = await http().post(`/rest/v1/payroll/adjustments/${ids.bonus}/approve`).set(auth(await staleToken(c)));
    expect(stale.status).toBe(403);
    expect(stale.body.code).toBe('STEP_UP_REQUIRED');
    expect((await row(ids.bonus)).status).toBe('pending_approval');
    const refusals = await adminDataSource.query(`SELECT count(*)::int AS n FROM core.audit_log WHERE actor_user_id = $1 AND action = 'auth.step_up_failed' AND metadata->>'action' = 'payroll.adjustment.approve'`, [c.userId]);
    expect(refusals[0].n).toBeGreaterThanOrEqual(1);

    const ok = await http().post(`/rest/v1/payroll/adjustments/${ids.bonus}/approve`).set(auth(await freshToken(c)));
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'approved', createdByMe: false });
    expect(ok.body.payrollPeriod).toMatchObject({ start: periods[1]!.start, end: periods[1]!.end });
    const r = await row(ids.bonus);
    expect({ status: r.status, decided_by: r.decided_by }).toEqual({ status: 'approved', decided_by: c.userId });
    expect((await http().post(`/rest/v1/payroll/adjustments/${ids.bonus}/approve`).set(auth(await freshToken(c)))).status).toBe(409);
    expect((await http().post(`/rest/v1/payroll/adjustments/${ids.bonus}/reject`).set(auth(await freshToken(c))).send({ reason: 'Too late' })).status).toBe(409);
    expect((await http().post(`/rest/v1/payroll/adjustments/${ids.expense}/approve`).set(auth(await freshToken(c)))).status).toBe(200);
  });

  it('rejection: a reason is required, never by the creator, then terminal', async () => {
    const dup = await http().post('/rest/v1/payroll/adjustments/bonuses').set(auth(tokenA)).send({ staffProfileId: staff[0]!.profileId, amountPence: 2500, reason: 'Duplicate entry' });
    ids.rejected = dup.body.id;
    expect((await http().post(`/rest/v1/payroll/adjustments/${ids.rejected}/reject`).set(auth(await freshToken(c))).send({})).status).toBe(400);
    expect((await http().post(`/rest/v1/payroll/adjustments/${ids.rejected}/reject`).set(auth(tokenA)).send({ reason: 'Mine' })).status).toBe(403);
    const rej = await http().post(`/rest/v1/payroll/adjustments/${ids.rejected}/reject`).set(auth(await freshToken(c))).send({ reason: 'Duplicate of the earlier bonus' });
    expect(rej.status).toBe(200);
    expect(rej.body).toMatchObject({ status: 'rejected', rejectionReason: 'Duplicate of the earlier bonus' });
    expect((await http().post(`/rest/v1/payroll/adjustments/${ids.rejected}/approve`).set(auth(await freshToken(c)))).status).toBe(409);
  });

  it('corrections: linked to the original APPROVED record; plus or minus; a reduction never exceeds what the shift paid', async () => {
    const pending = await approvedRecordFor(3, false); // another person: two overlapping shifts for one person cannot be booked
    expect((await http().post('/rest/v1/payroll/adjustments/corrections').set(auth(tokenA)).send({ payrollRecordId: pending.id, amountPence: 100, reason: 'Not approved yet' })).status).toBe(409);
    s1Record = await approvedRecordFor(1);
    expect(s1Record.amountPence).toBeGreaterThan(0);
    expect((await http().post('/rest/v1/payroll/adjustments/corrections').set(auth(tokenA)).send({ payrollRecordId: s1Record.id, amountPence: 0, reason: 'Zero' })).status).toBe(400);
    expect((await http().post('/rest/v1/payroll/adjustments/corrections').set(auth(tokenA)).send({ payrollRecordId: s1Record.id, amountPence: -(s1Record.amountPence + 1), reason: 'Too much' })).status).toBe(409);
    expect((await http().post('/rest/v1/payroll/adjustments/corrections').set(auth(tokenOther)).send({ payrollRecordId: s1Record.id, amountPence: 100, reason: 'Cross org' })).status).toBe(404);
    // The staff member always comes from the record; a body staffProfileId is a 400.
    expect((await http().post('/rest/v1/payroll/adjustments/corrections').set(auth(tokenA)).send({ payrollRecordId: s1Record.id, amountPence: 100, reason: 'x', staffProfileId: staff[0]!.profileId })).status).toBe(400);
    const minus = await http().post('/rest/v1/payroll/adjustments/corrections').set(auth(tokenA)).send({ payrollRecordId: s1Record.id, amountPence: -150, reason: 'Overpaid by 6 minutes' });
    expect(minus.status).toBe(201);
    expect(minus.body).toMatchObject({ kind: 'correction', amountPence: -150, correctsPayrollRecordId: s1Record.id, staffProfileId: staff[1]!.profileId });
    ids.minus = minus.body.id;
    expect((await http().post(`/rest/v1/payroll/adjustments/${ids.minus}/approve`).set(auth(await freshToken(c)))).status).toBe(200);
    // The approved original is never edited.
    const [orig] = await adminDataSource.query(`SELECT status, amount_pence FROM ${businessTable(a.workspaceId!, 'payroll_record')} WHERE id = $1`, [s1Record.id]);
    expect({ status: orig.status, amount: Number(orig.amount_pence) }).toEqual({ status: 'approved', amount: s1Record.amountPence });
  });

  it('RLS: managers of the workspace see all; staff see only their OWN APPROVED lines; Venue Managers and other organisations see nothing', async () => {
    const all = await asUser<Array<{ id: string }>>(a.userId, `SELECT id FROM core.payroll_adjustment`);
    expect(all.map((r) => r.id).sort()).toEqual([ids.bonus, ids.expense, ids.rejected, ids.minus].sort());
    const s0 = await asUser<Array<{ id: string }>>(staff[0]!.userId, `SELECT id FROM core.payroll_adjustment`);
    expect(s0.map((r) => r.id)).toEqual([ids.bonus]); // the rejected duplicate is invisible to them
    const s1 = await asUser<Array<{ id: string }>>(staff[1]!.userId, `SELECT id FROM core.payroll_adjustment`);
    expect(s1.map((r) => r.id)).toEqual([ids.minus]);
    const [vmUser] = await adminDataSource.query(`SELECT user_id FROM core.manager_profile WHERE workspace_id = $1 AND type = 'venue' LIMIT 1`, [a.workspaceId]);
    expect(await asUser(vmUser.user_id, `SELECT id FROM core.payroll_adjustment`)).toEqual([]);
    // Another organisation bound: nothing (tenant predicate).
    expect(await tenantContext.runInTenantContext({ organisationId: randomUUID(), workspaceId: a.workspaceId, userId: a.userId, role: '' } as AuthContext,
      (m) => m.query(`SELECT id FROM core.payroll_adjustment`))).toEqual([]);
    // HTTP list: payroll.view only; Venue Manager refused.
    const list = await http().get('/rest/v1/payroll/adjustments?status=approved').set(auth(tokenA));
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(3);
    expect((await http().get('/rest/v1/payroll/adjustments').set(auth(tokenVm))).status).toBe(403);
    expect((await http().get('/rest/v1/payroll/adjustments').set(auth(tokenOther))).body.total).toBe(0);
  });

  it('database layers without the service: segregation CHECKs, insert predicate, guard trigger, no DELETE', async () => {
    const insert = (who: string, over: Record<string, unknown> = {}) => {
      const v = { staff_profile_id: staff[0]!.profileId, staff_user_id: staff[0]!.userId, kind: 'bonus', amount_pence: 100, reason: 'Direct insert', created_by: who, status: 'pending_approval', ...over };
      return asUser(who, `INSERT INTO core.payroll_adjustment (organisation_id, workspace_id, staff_profile_id, staff_user_id, kind, amount_pence, reason, created_by, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [orgId, a.workspaceId, v.staff_profile_id, v.staff_user_id, v.kind, v.amount_pence, v.reason, v.created_by, v.status]);
    };
    await expect(insert(a.userId, { created_by: c.userId })).rejects.toMatchObject({ code: '42501' }); // names another author
    await expect(insert(a.userId, { status: 'approved' })).rejects.toMatchObject({ code: '42501' }); // born approved
    await expect(insert(staff[0]!.userId)).rejects.toMatchObject({ code: '42501' }); // staff cannot write
    await expect(insert(a.userId, { staff_user_id: a.userId })).rejects.toMatchObject({ code: '23514' }); // own pay
    await expect(insert(a.userId, { kind: 'deduction' })).rejects.toMatchObject({ code: '23514' });
    await expect(insert(a.userId, { amount_pence: -100 })).rejects.toMatchObject({ code: '23514' }); // only a correction may be negative
    await expect(insert(a.userId, { kind: 'correction' })).rejects.toMatchObject({ code: '23514' }); // a correction names its record

    const [{ id: pendingId }] = await adminDataSource.query(
      `INSERT INTO core.payroll_adjustment (organisation_id, workspace_id, staff_profile_id, staff_user_id, kind, amount_pence, reason, created_by)
       VALUES ($1, $2, $3, $4, 'bonus', 300, 'Guard test', $5) RETURNING id`, [orgId, a.workspaceId, staff[0]!.profileId, staff[0]!.userId, a.userId]);
    // The creator approving directly: the CHECK refuses (decided_by <> created_by).
    await expect(asUser(a.userId, `UPDATE core.payroll_adjustment SET status = 'approved', decided_by = $2, decided_at = now() WHERE id = $1`, [pendingId, a.userId])).rejects.toMatchObject({ code: '23514' });
    // A decision naming someone other than the session: the guard refuses.
    await expect(asUser(c.userId, `UPDATE core.payroll_adjustment SET status = 'approved', decided_by = $2, decided_at = now() WHERE id = $1`, [pendingId, staff[2]!.userId])).rejects.toMatchObject({ code: '42501' });
    // The figures: no column grant for the runtime login.
    await expect(asUser(c.userId, `UPDATE core.payroll_adjustment SET amount_pence = 999999 WHERE id = $1`, [ids.bonus])).rejects.toMatchObject({ code: '42501' });
    // approved -> pending: the state machine refuses.
    await expect(asUser(c.userId, `UPDATE core.payroll_adjustment SET status = 'pending_approval', decided_by = NULL, decided_at = NULL WHERE id = $1`, [ids.bonus])).rejects.toMatchObject({ code: '23514' });
    // A pending line cannot join a run.
    await expect(asUser(c.userId, `UPDATE core.payroll_adjustment SET run_id = $2, included_at = now() WHERE id = $1`, [pendingId, randomUUID()])).rejects.toMatchObject({ code: '23514' });
    // No DELETE for anyone at runtime (financial record).
    await expect(asUser(a.userId, `DELETE FROM core.payroll_adjustment WHERE id = $1`, [pendingId])).rejects.toMatchObject({ code: '42501' });
    // The Venue Manager cannot update any line (RLS hides them: zero rows changed).
    const [vmUser] = await adminDataSource.query(`SELECT user_id FROM core.manager_profile WHERE workspace_id = $1 AND type = 'venue' LIMIT 1`, [a.workspaceId]);
    await tenantContext.runInTenantContext(ctxOf(vmUser.user_id), async (m) => {
      const res = await m.query(`UPDATE core.payroll_adjustment SET updated_at = now() WHERE id = $1`, [pendingId]);
      expect(res[1]).toBe(0);
    });
    // Reject the guard-test line so it stays out of the run (decided by C, a different person).
    expect((await http().post(`/rest/v1/payroll/adjustments/${pendingId}/reject`).set(auth(await freshToken(c))).send({ reason: 'Guard test line' })).status).toBe(200);
  });

  it('runs: approved lines join the run of their period, appear in totals and the CSV, and are locked at finalise', async () => {
    const [p1] = (await http().get('/rest/v1/payroll/runs').set(auth(tokenA))).body.periods.filter((p: { period: { start: string } }) => p.period.start === periods[1]!.start);
    const prepared = await http().post('/rest/v1/payroll/runs/prepare').set(auth(tokenA)).send({ periodId: p1.period.id });
    expect(prepared.status).toBe(200);
    const runId = prepared.body.id as string;
    ids.run = runId;
    for (const id of [ids.bonus, ids.expense, ids.minus]) expect((await row(id)).run_id).toBe(runId);
    expect((await row(ids.rejected)).run_id).toBeNull();
    const byStaff = (sp: string) => prepared.body.staff.find((s: { staffProfileId: string }) => s.staffProfileId === sp);
    expect(byStaff(staff[0]!.profileId)).toMatchObject({ records: 0, grossPence: 0, bonusesPence: 2500, adjustmentsPence: 2500, totalPence: 2500 });
    expect(byStaff(staff[2]!.profileId)).toMatchObject({ records: 0, expensesPence: 1234, totalPence: 1234 }); // adjustment-only staff still get a row
    expect(byStaff(staff[1]!.profileId)).toMatchObject({ records: 1, grossPence: s1Record.amountPence, correctionsPence: -150, totalPence: s1Record.amountPence - 150 });
    expect(prepared.body.totals).toMatchObject({ adjustmentsPence: 2500 + 1234 - 150, totalPence: prepared.body.totals.grossPence + 2500 + 1234 - 150 });
    const included = await adminDataSource.query(`SELECT metadata FROM core.audit_log WHERE action = 'payroll_run.adjustments_included' AND entity_id = $1`, [runId]);
    expect(included[0].metadata).toMatchObject({ adjustments: 3, carriedForward: 0 });

    const csv = await http().get(`/rest/v1/payroll/runs/${runId}/export`).set(auth(tokenA));
    expect(csv.status).toBe(200);
    const lines = (csv.text as string).split('\n');
    expect(lines[0]).toContain('Gross (GBP),Corrections (GBP),Bonuses (GBP),Expenses (GBP),Total (GBP)');
    expect(csv.text).toContain(',-1.50,0.00,0.00,'); // a negative correction stays a number

    const fin = await http().post(`/rest/v1/payroll/runs/${runId}/finalise`).set(auth(await freshToken(c)));
    expect(fin.status).toBe(200);
    for (const id of [ids.bonus, ids.expense, ids.minus]) expect((await row(id)).locked_at).not.toBeNull();
    // Locked: the database refuses ANY change, even of a column the runtime login may update.
    await expect(asUser(c.userId, `UPDATE core.payroll_adjustment SET updated_at = now() WHERE id = $1`, [ids.bonus])).rejects.toMatchObject({ code: '42501' });
    await expect(adminDataSource.query(`UPDATE core.payroll_adjustment SET updated_at = now() WHERE id = $1`, [ids.bonus])).rejects.toMatchObject({ code: '42501' });
    // Payslips exist for every paid person, adjustment-only staff included.
    const slips = await adminDataSource.query(`SELECT staff_profile_id FROM ${businessTable(a.workspaceId!, 'payslip')} WHERE run_id = $1`, [runId]);
    expect(slips.map((s: { staff_profile_id: string }) => s.staff_profile_id).sort()).toEqual(staff.slice(0, 3).map((s) => s.profileId).sort());
  });

  it('a line approved after the run is finalised sits on the next period (carried forward), never in the finalised run', async () => {
    const late = await http().post('/rest/v1/payroll/adjustments/bonuses').set(auth(tokenA)).send({ staffProfileId: staff[0]!.profileId, amountPence: 500, reason: 'Late bonus' });
    const approved = await http().post(`/rest/v1/payroll/adjustments/${late.body.id}/approve`).set(auth(await freshToken(c)));
    expect(approved.body.payrollPeriod).toMatchObject({ start: periods[2]!.start });
    expect((await http().post('/rest/v1/payroll/runs/prepare').set(auth(tokenA)).send({ periodId: (await http().get('/rest/v1/payroll/runs').set(auth(tokenA))).body.periods.find((p: { period: { start: string } }) => p.period.start === periods[1]!.start).period.id })).status).toBe(409);
    const p2 = (await http().get('/rest/v1/payroll/runs').set(auth(tokenA))).body.periods.find((p: { period: { start: string } }) => p.period.start === periods[2]!.start);
    const next = await http().post('/rest/v1/payroll/runs/prepare').set(auth(tokenA)).send({ periodId: p2.period.id });
    expect(next.status).toBe(200);
    expect((await row(late.body.id)).run_id).toBe(next.body.id);
    const included = await adminDataSource.query(`SELECT metadata FROM core.audit_log WHERE action = 'payroll_run.adjustments_included' AND entity_id = $1`, [next.body.id]);
    expect(included[0].metadata).toMatchObject({ adjustments: 1, carriedForward: 1 });
    ids.late = late.body.id;
  });

  it('staff payslip timeline: own approved adjustments only, with totals; nobody sees another person\'s', async () => {
    const mine = await http().get('/rest/v1/payroll/me/payslips').set(auth(staffTokens[0]!));
    expect(mine.status).toBe(200);
    const p1 = mine.body.data.find((e: { period: { start: string } }) => e.period.start === periods[1]!.start);
    expect(p1).toMatchObject({ shiftCount: 0, grossPence: 0, adjustmentsPence: 2500, totalPence: 2500 });
    expect(p1.adjustments).toEqual([{ id: ids.bonus, kind: 'bonus', amountPence: 2500, correctsPayrollRecordId: null }]);
    expect(JSON.stringify(mine.body)).not.toContain('Covered a late shift'); // the reason is never shown to staff
    const p2 = mine.body.data.find((e: { period: { start: string } }) => e.period.start === periods[2]!.start);
    expect(p2).toMatchObject({ adjustmentsPence: 500, totalPence: 500 });
    const other = await http().get('/rest/v1/payroll/me/payslips').set(auth(staffTokens[1]!));
    const o1 = other.body.data.find((e: { period: { start: string } }) => e.period.start === periods[1]!.start);
    expect(o1).toMatchObject({ shiftCount: 1, adjustmentsPence: -150, totalPence: s1Record.amountPence - 150 });
    expect(JSON.stringify(other.body)).not.toContain(ids.bonus);
  });

  it('audit trail: created, approved, rejected and included are all recorded; still zero rows without tenant context', async () => {
    const actions = await adminDataSource.query(
      `SELECT action, count(*)::int AS n FROM core.audit_log WHERE organisation_id = $1 AND action LIKE 'payroll_adjustment.%' GROUP BY action ORDER BY action`, [orgId]);
    expect(Object.fromEntries(actions.map((r: { action: string; n: number }) => [r.action, r.n]))).toEqual({
      'payroll_adjustment.approved': 4, 'payroll_adjustment.created': 5, 'payroll_adjustment.rejected': 2,
    });
    expect((await dataSource.query(`SELECT count(*)::int AS n FROM core.payroll_adjustment`))[0].n).toBe(0);
  });
});
