import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource, EntityManager } from 'typeorm';

import { AppModule } from '../../app.module';
import { AuditService } from '../../engine/core-modules/audit/audit.service';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { RealtimeEventService } from '../../engine/core-modules/realtime/realtime-event.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { AttendanceQrService } from '../../modules/attendance/services/attendance-qr.service';
import { Organisation } from '../../modules/identity/entities';
import { NotificationService } from '../../modules/notification/services/notification.service';
import { withdrawUnconfirmedOffer, WithdrawnOffer } from '../../modules/offer/services/withdraw-unconfirmed-offer';
import { Shift } from '../../modules/scheduling/entities/shift.entity';
import { completeShiftIfSettled } from '../../modules/scheduling/utils/complete-shift-if-settled';
import { Venue } from '../../modules/venue/entities/venue.entity';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';
import { applyGlobalValidationPipe } from '../../engine/utils/global-validation-pipe';
import { integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';
import { businessTable, businessTableOf, siblingTable } from './helpers/hws-fixtures';

/**
 * Shift completion after an offer close (shadow-run finding 2026-11-06, `fix/shift-completion-after-withdrawal`).
 *
 * Before: the shift roll-up ("an in_progress shift completes once no seat is still open") ran only at a clock-out (and a
 * manager-recorded attendance). A seat held by an unconfirmed acceptance (standby / replacement / late standard) is
 * open, so when the confirmed staff member clocked out first and that acceptance was withdrawn at its deadline later
 * (owner rule #82), nothing re-ran the roll-up: all 12 such shifts of the soak stayed `in_progress` for ever.
 *
 * After: every offer close re-runs the SAME roll-up (`completeShiftIfSettled`) under the shift row lock. Real Postgres,
 * RLS on, the real HTTP stack for clock-in / clock-out / accept / confirm / reject / decline / withdraw, and the real
 * `withdrawUnconfirmedOffer` the Worker runs, in a Worker-shaped tenant context (`actorType: 'worker'`, as runScopedForOrg).
 * Fixture SQL (the superuser connection) only places shifts and windows in time, as the neighbouring suites do.
 */
const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(180_000);

const MIN = 60_000;
const HOUR = 60 * MIN;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describeIfDb('shift completion after an offer close (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let tenantContext: TenantContextService;
  let attendanceQr: AttendanceQrService;
  let factory: TestIdentityFactory;
  let deps: { auditService: AuditService; notificationService: NotificationService; realtimeEventService: RealtimeEventService };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = applyGlobalValidationPipe(moduleRef.createNestApplication());
    await app.init();
    dataSource = moduleRef.get(DataSource);
    tenantContext = moduleRef.get(TenantContextService);
    attendanceQr = moduleRef.get(AttendanceQrService);
    deps = { auditService: moduleRef.get(AuditService), notificationService: moduleRef.get(NotificationService), realtimeEventService: moduleRef.get(RealtimeEventService) };
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = new TestIdentityFactory({ app, dataSource, adminDataSource, tenantContext, passwordHashing: moduleRef.get(PasswordHashingService) });
  });

  afterAll(async () => {
    await app.close();
    await adminDataSource.destroy();
  });

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  type Staff = TestIdentity & { profileId: string; token: string };
  async function activeStaff(org: Organisation, owner: TestIdentity, label: string): Promise<Staff> {
    const staff = await factory.createStaff(org, { owner, label });
    await adminDataSource.query(`UPDATE ${businessTable(owner.workspaceId!, 'staff_profile')} SET employment_status = 'active' WHERE id = $1`, [staff.profileId]);
    return { ...staff, profileId: staff.profileId!, token: await factory.login(staff) };
  }

  async function seedWorkspace(label: string) {
    const org = await factory.createOrganisation(label);
    const manager = await factory.createInternalManager(org, { permissions: 'production' });
    const managerToken = await factory.login(manager);
    const venue = await tenantContext.runInTenantContext(
      { organisationId: org.id, workspaceId: manager.workspaceId, userId: manager.userId, role: '' },
      (m) => m.save(Venue, { organisationId: org.id, name: `Venue ${label}`, workspaceId: manager.workspaceId!, createdBy: manager.userId }),
    );
    const role = await http().post('/rest/v1/job-roles').set(auth(managerToken)).send({ name: `Role-${randomUUID().slice(0, 8)}`, defaultRatePence: 1500 });
    expect(role.status).toBe(201);
    return { org, manager, managerToken, venue, jobRoleId: role.body.id as string };
  }
  type Ws = Awaited<ReturnType<typeof seedWorkspace>>;

  /**
   * A `required`-seat shift that started an hour ago (8 h long). `booked` staff hold confirmed seats; `accepted` staff
   * hold STANDARD acceptances still awaiting the manager (their own individual window starts `acceptedStartsInMin`
   * from now, so their deadline is start − 30 min). Bookings predate Check In (check_in_required = false), as in
   * attendance-abuse-cases.
   */
  async function seedRunningShift(label: string, opts: { required: number; booked: number; accepted?: number; acceptedStartsInMin?: number }, existing?: Ws) {
    const ws = existing ?? (await seedWorkspace(label));
    const booked: Staff[] = [];
    const accepted: Staff[] = [];
    for (let i = 0; i < opts.booked; i++) booked.push(await activeStaff(ws.org, ws.manager, `${label}-booked${i}`));
    for (let i = 0; i < (opts.accepted ?? 0); i++) accepted.push(await activeStaff(ws.org, ws.manager, `${label}-accepted${i}`));
    const futureStart = new Date(Date.now() + 72 * HOUR);
    const created = await http().post('/rest/v1/shifts/with-offers').set(auth(ws.managerToken)).send({
      venueId: ws.venue.id,
      jobRoleId: ws.jobRoleId,
      startsAt: futureStart.toISOString(),
      endsAt: new Date(futureStart.getTime() + 8 * HOUR).toISOString(),
      requiredCount: opts.required,
      staffProfileIds: [...booked, ...accepted].map((s) => s.profileId),
    });
    expect(created.status).toBe(201);
    const shiftId = created.body.shiftId as string;
    const startsAt = new Date(Date.now() - HOUR);
    const endsAt = new Date(startsAt.getTime() + 8 * HOUR);
    await adminDataSource.query(
      `UPDATE ${businessTable(ws.manager.workspaceId!, 'shift')} SET starts_at = $2, ends_at = $3, default_starts_at = $2, default_ends_at = $3, filled_count = $4, status = $5 WHERE id = $1`,
      [shiftId, startsAt, endsAt, booked.length, booked.length >= opts.required ? 'fully_filled' : 'partially_filled'],
    );
    for (const s of booked) {
      await adminDataSource.query(
        `UPDATE ${businessTable(ws.manager.workspaceId!, 'job_offer')} SET status = 'manager_confirmed', staff_accepted_at = now(), manager_confirmed_at = now(), confirmed_by = $3
          WHERE shift_assignment_id IN (SELECT id FROM ${businessTable(ws.manager.workspaceId!, 'shift_assignment')} WHERE shift_id = $1 AND staff_profile_id = $2)`,
        [shiftId, s.profileId, ws.manager.userId],
      );
      await adminDataSource.query(
        `UPDATE ${businessTable(ws.manager.workspaceId!, 'shift_assignment')} SET status = 'confirmed', confirmed_at = now(), check_in_required = false, period = tstzrange($3, $4, '[)')
          WHERE shift_id = $1 AND staff_profile_id = $2`,
        [shiftId, s.profileId, startsAt, endsAt],
      );
    }
    const acceptedStart = new Date(Date.now() + (opts.acceptedStartsInMin ?? 120) * MIN);
    for (const s of accepted) {
      await adminDataSource.query(
        `UPDATE ${businessTable(ws.manager.workspaceId!, 'job_offer')} SET status = 'staff_accepted', staff_accepted_at = now()
          WHERE shift_assignment_id IN (SELECT id FROM ${businessTable(ws.manager.workspaceId!, 'shift_assignment')} WHERE shift_id = $1 AND staff_profile_id = $2)`,
        [shiftId, s.profileId],
      );
      await adminDataSource.query(
        `UPDATE ${businessTable(ws.manager.workspaceId!, 'shift_assignment')} SET status = 'staff_accepted', check_in_required = false, period = tstzrange($3, $4, '[)')
          WHERE shift_id = $1 AND staff_profile_id = $2`,
        [shiftId, s.profileId, acceptedStart, endsAt],
      );
    }
    return { ...ws, shiftId, booked, accepted };
  }
  type Fx = Awaited<ReturnType<typeof seedRunningShift>>;

  const signQr = (fx: Fx) =>
    tenantContext.runInTenantContext({ organisationId: fx.org.id, workspaceId: fx.manager.workspaceId, userId: fx.manager.userId, role: '' }, async (m) =>
      attendanceQr.sign(await m.findOneByOrFail(Shift, { id: fx.shiftId })),
    );
  async function clockIn(fx: Fx, staff: Staff) {
    const res = await http().post('/rest/v1/attendance/clock-in').set(auth(staff.token)).send({ shiftId: fx.shiftId, qrToken: await signQr(fx) });
    expect(res.status).toBe(201);
  }
  /** Signs the QR, then STARTS the clock-out request; `response` is still pending (wrapped so `await` does not wait for it). */
  async function startClockOut(fx: Fx, staff: Staff): Promise<{ response: Promise<request.Response> }> {
    const qrToken = await signQr(fx);
    return { response: http().post('/rest/v1/attendance/clock-out').set(auth(staff.token)).send({ qrToken }).then((r) => r) };
  }
  const clockOut = async (fx: Fx, staff: Staff) => (await startClockOut(fx, staff)).response;

  /** A standby offer to `staff` on the (fully booked) shift, accepted by them. Returns the offer id. */
  async function acceptedReplacementOffer(fx: Fx, staff: Staff, expectedKind: 'standby' | 'replacement'): Promise<string> {
    const sent = await http().post(`/rest/v1/shifts/${fx.shiftId}/offers/bulk`).set(auth(fx.managerToken)).send({ staffProfileIds: [staff.profileId], mode: 'replacement' });
    expect(sent.status).toBe(201);
    expect(sent.body.offerKind).toBe(expectedKind);
    const offerId = sent.body.results[0].offerId as string;
    expect((await http().post(`/rest/v1/offers/${offerId}/accept`).set(auth(staff.token))).status).toBe(201);
    await adminDataSource.query(`UPDATE ${businessTable(fx.manager.workspaceId!, 'shift_assignment')} sa SET check_in_required = false FROM ${businessTable(fx.manager.workspaceId!, 'job_offer')} o WHERE o.id = $1 AND sa.id = o.shift_assignment_id`, [offerId]);
    return offerId;
  }

  const offerIdOf = async (fx: Fx, staff: Staff): Promise<string> =>
    (await adminDataSource.query(`SELECT o.id FROM ${businessTable(fx.manager.workspaceId!, 'job_offer')} o JOIN ${businessTable(fx.manager.workspaceId!, 'shift_assignment')} sa ON sa.id = o.shift_assignment_id WHERE sa.shift_id = $1 AND o.staff_profile_id = $2`, [fx.shiftId, staff.profileId]))[0].id;

  /** FIXTURE (time only): a replacement / standby window that already ended (its deadline is its window end). */
  const endWindow = async (offerId: string) =>
    adminDataSource.query(
      `UPDATE ${siblingTable(await businessTableOf(adminDataSource, 'job_offer', offerId), 'shift_assignment')} sa SET period = tstzrange(now() - interval '50 minutes', now() - interval '1 minute', '[)') FROM ${await businessTableOf(adminDataSource, 'job_offer', offerId)} o WHERE o.id = $1 AND sa.id = o.shift_assignment_id`,
      [offerId],
    );
  /** FIXTURE (time only): a STANDARD acceptance whose individual start is 20 min away (deadline = start − 30 min, passed). */
  const passStandardDeadline = async (offerId: string) =>
    adminDataSource.query(
      `UPDATE ${siblingTable(await businessTableOf(adminDataSource, 'job_offer', offerId), 'shift_assignment')} sa SET period = tstzrange(now() + interval '20 minutes', now() + interval '6 hours', '[)') FROM ${await businessTableOf(adminDataSource, 'job_offer', offerId)} o WHERE o.id = $1 AND sa.id = o.shift_assignment_id`,
      [offerId],
    );

  /** The Worker's withdrawal (pointer / backstop scan / timer all call this) in a Worker-shaped tenant context. */
  const workerContext = (fx: Fx) => ({ organisationId: fx.org.id, workspaceId: fx.manager.workspaceId, userId: '', role: '', actorType: 'worker' as const });
  const workerWithdraw = (fx: Fx, offerId: string, orgId = fx.org.id) =>
    tenantContext.runInTenantContext({ ...workerContext(fx), organisationId: orgId }, (m) => withdrawUnconfirmedOffer(m, deps, orgId, offerId, 'worker_scan'));

  const shiftRow = async (shiftId: string) => (await adminDataSource.query(`SELECT status, updated_at, filled_count FROM ${await businessTableOf(adminDataSource, 'shift', shiftId)} WHERE id = $1`, [shiftId]))[0];
  const offerRow = async (offerId: string) =>
    (await adminDataSource.query(`SELECT o.status, o.rejected_by, o.rejection_reason, sa.status AS assignment_status, sa.id AS assignment_id FROM ${await businessTableOf(adminDataSource, 'job_offer', offerId)} o JOIN ${siblingTable(await businessTableOf(adminDataSource, 'job_offer', offerId), 'shift_assignment')} sa ON sa.id = o.shift_assignment_id WHERE o.id = $1`, [offerId]))[0];
  const attendanceRows = async (shiftId: string) =>
    adminDataSource.query(`SELECT shift_assignment_id, status, clock_in_at, clock_out_at, worked_minutes, earned_pence FROM ${siblingTable(await businessTableOf(adminDataSource, 'shift', shiftId), 'attendance')} WHERE shift_id = $1 ORDER BY id`, [shiftId]);
  const payrollRows = async (shiftId: string) => adminDataSource.query(`SELECT id FROM ${siblingTable(await businessTableOf(adminDataSource, 'shift', shiftId), 'payroll_record')} WHERE shift_id = $1`, [shiftId]);

  describe('the 12-shift soak scenario: confirmed staff clocked out, a standby still accepted, the standby withdrawn at its window end', () => {
    it('S1: the shift completes exactly once, at the withdrawal; the withdrawn standby gets no attendance, payroll or seat', async () => {
      const fx = await seedRunningShift('fscS1', { required: 1, booked: 1 });
      const [worker] = fx.booked;
      const standby = await activeStaff(fx.org, fx.manager, 'fscS1-standby');
      await clockIn(fx, worker!);
      const standbyOffer = await acceptedReplacementOffer(fx, standby, 'standby');

      const out = await clockOut(fx, worker!);
      expect(out.status).toBe(201);
      // The standby acceptance is an open seat, so the clock-out alone does not complete the shift (unchanged rule).
      expect((await shiftRow(fx.shiftId)).status).toBe('in_progress');
      const attendanceBefore = await attendanceRows(fx.shiftId);
      expect(attendanceBefore).toHaveLength(1);

      await endWindow(standbyOffer);
      const withdrawn = await workerWithdraw(fx, standbyOffer);
      expect(withdrawn).toMatchObject({ offerId: standbyOffer, shiftId: fx.shiftId, shiftCompleted: true });

      const shift = await shiftRow(fx.shiftId);
      expect(shift.status).toBe('completed');
      expect(await offerRow(standbyOffer)).toMatchObject({ status: 'manager_rejected', rejected_by: null, rejection_reason: 'confirmation_deadline_passed', assignment_status: 'rejected' });
      // No money or attendance moves: the worked attendance is byte-for-byte unchanged, the standby has none, no payroll.
      expect(await attendanceRows(fx.shiftId)).toEqual(attendanceBefore);
      expect(shift.filled_count).toBe(1);
      expect(await payrollRows(fx.shiftId)).toEqual([]);

      // Exactly once: a repeated withdrawal and a repeated roll-up change nothing (not even updated_at).
      expect(await workerWithdraw(fx, standbyOffer)).toBeNull();
      expect(await tenantContext.runInTenantContext(workerContext(fx), (m) => completeShiftIfSettled(m, fx.org.id, fx.shiftId))).toBe(false);
      const again = await shiftRow(fx.shiftId);
      expect(again.status).toBe('completed');
      expect(new Date(again.updated_at).getTime()).toBe(new Date(shift.updated_at).getTime());
      expect(await adminDataSource.query(`SELECT 1 FROM core.audit_log WHERE entity_id = $1 AND action = 'offer.rejected_by_worker'`, [standbyOffer])).toHaveLength(1);
    });

    it('S2: twelve such shifts (the soak wave) all complete; each exactly once', async () => {
      const shifts: Array<{ fx: Fx; offerId: string }> = [];
      const ws = await seedWorkspace('fscS2');
      for (let i = 0; i < 12; i++) {
        const fx = await seedRunningShift(`fscS2w${i}`, { required: 1, booked: 1 }, ws);
        const standby = await activeStaff(fx.org, fx.manager, `fscS2w${i}-standby`);
        await clockIn(fx, fx.booked[0]!);
        const offerId = await acceptedReplacementOffer(fx, standby, 'standby');
        expect((await clockOut(fx, fx.booked[0]!)).status).toBe(201);
        await endWindow(offerId);
        shifts.push({ fx, offerId });
      }
      const results = await Promise.all(shifts.map(({ fx, offerId }) => workerWithdraw(fx, offerId)));
      expect(results.map((r) => r?.shiftCompleted)).toEqual(Array(12).fill(true));
      for (const { fx } of shifts) expect((await shiftRow(fx.shiftId)).status).toBe('completed');
    }, 400_000);
  });

  describe('the same gap on the other close paths', () => {
    it('P1: a REPLACEMENT acceptance withdrawn at its window end through the API lazy path (a confirm after the deadline) completes the shift', async () => {
      const fx = await seedRunningShift('fscP1', { required: 2, booked: 2 });
      const [absent, worker] = fx.booked;
      // The first booked seat is a manager-CONFIRMED no-show: one real vacancy, so the next offer is a replacement.
      await adminDataSource.query(`UPDATE ${businessTable(fx.manager.workspaceId!, 'shift_assignment')} SET status = 'no_show', attendance_reviewed_at = now(), attendance_reviewed_by = $3 WHERE shift_id = $1 AND staff_profile_id = $2`, [fx.shiftId, absent!.profileId, fx.manager.userId]);
      const replacement = await activeStaff(fx.org, fx.manager, 'fscP1-repl');
      await clockIn(fx, worker!);
      const offerId = await acceptedReplacementOffer(fx, replacement, 'replacement');
      expect((await clockOut(fx, worker!)).status).toBe(201);
      expect((await shiftRow(fx.shiftId)).status).toBe('in_progress');

      await endWindow(offerId);
      const late = await http().post(`/rest/v1/offers/${offerId}/confirm`).set(auth(fx.managerToken));
      expect(late.status).toBe(409);
      expect(late.body.code).toBe('CONFIRMATION_DEADLINE_PASSED');
      expect(await offerRow(offerId)).toMatchObject({ status: 'manager_rejected', rejected_by: null, assignment_status: 'rejected' });
      expect((await shiftRow(fx.shiftId)).status).toBe('completed');
      expect(await attendanceRows(fx.shiftId)).toHaveLength(1);
    });

    it('P2: a STANDARD acceptance withdrawn at its individual start − 30 min, after every booked staff member clocked out, completes the shift', async () => {
      const fx = await seedRunningShift('fscP2', { required: 2, booked: 1, accepted: 1 });
      const [worker] = fx.booked;
      const late = fx.accepted[0]!;
      await clockIn(fx, worker!);
      expect((await clockOut(fx, worker!)).status).toBe(201);
      expect((await shiftRow(fx.shiftId)).status).toBe('in_progress');

      const offerId = await offerIdOf(fx, late);
      await passStandardDeadline(offerId);
      expect(await workerWithdraw(fx, offerId)).toMatchObject({ shiftCompleted: true });
      expect((await shiftRow(fx.shiftId)).status).toBe('completed');
    });

    it('P3: a manager REJECT of the last accepted standby after the clock-out completes the shift', async () => {
      const fx = await seedRunningShift('fscP3', { required: 1, booked: 1 });
      const standby = await activeStaff(fx.org, fx.manager, 'fscP3-standby');
      await clockIn(fx, fx.booked[0]!);
      const offerId = await acceptedReplacementOffer(fx, standby, 'standby');
      expect((await clockOut(fx, fx.booked[0]!)).status).toBe(201);
      const rejected = await http().post(`/rest/v1/offers/${offerId}/reject`).set(auth(fx.managerToken)).send({ reason: 'Not needed' });
      expect(rejected.status).toBe(201);
      expect((await shiftRow(fx.shiftId)).status).toBe('completed');
    });

    it('P4: a staff DECLINE of the last pending standby offer after the clock-out completes the shift', async () => {
      const fx = await seedRunningShift('fscP4', { required: 1, booked: 1 });
      const standby = await activeStaff(fx.org, fx.manager, 'fscP4-standby');
      await clockIn(fx, fx.booked[0]!);
      const sent = await http().post(`/rest/v1/shifts/${fx.shiftId}/offers/bulk`).set(auth(fx.managerToken)).send({ staffProfileIds: [standby.profileId], mode: 'replacement' });
      expect(sent.status).toBe(201);
      expect((await clockOut(fx, fx.booked[0]!)).status).toBe(201);
      expect((await shiftRow(fx.shiftId)).status).toBe('in_progress');
      const declined = await http().post(`/rest/v1/offers/${sent.body.results[0].offerId}/decline`).set(auth(standby.token)).send({ reason: 'Busy' });
      expect(declined.status).toBe(201);
      expect((await shiftRow(fx.shiftId)).status).toBe('completed');
    });

    it('P5: the sender WITHDRAWING the last pending standby offer after the clock-out completes the shift', async () => {
      const fx = await seedRunningShift('fscP5', { required: 1, booked: 1 });
      const standby = await activeStaff(fx.org, fx.manager, 'fscP5-standby');
      await clockIn(fx, fx.booked[0]!);
      const sent = await http().post(`/rest/v1/shifts/${fx.shiftId}/offers/bulk`).set(auth(fx.managerToken)).send({ staffProfileIds: [standby.profileId], mode: 'replacement' });
      expect(sent.status).toBe(201);
      expect((await clockOut(fx, fx.booked[0]!)).status).toBe(201);
      const withdrawn = await http().post(`/rest/v1/offers/${sent.body.results[0].offerId}/withdraw`).set(auth(fx.managerToken));
      expect(withdrawn.status).toBe(201);
      expect((await shiftRow(fx.shiftId)).status).toBe('completed');
    });
  });

  describe('races (each transaction used to see the other one’s seat still open)', () => {
    it('R1: a withdrawal that holds its transaction open while the last clock-out runs: the clock-out waits on the shift lock, then completes the shift', async () => {
      const fx = await seedRunningShift('fscR1', { required: 1, booked: 1 });
      const standby = await activeStaff(fx.org, fx.manager, 'fscR1-standby');
      await clockIn(fx, fx.booked[0]!);
      const offerId = await acceptedReplacementOffer(fx, standby, 'standby');
      await endWindow(offerId);

      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let entered!: () => void;
      const inside = new Promise<void>((resolve) => (entered = resolve));
      const withdrawal = tenantContext.runInTenantContext(workerContext(fx), async (m: EntityManager) => {
        const result = await withdrawUnconfirmedOffer(m, deps, fx.org.id, offerId, 'worker_scan');
        entered();
        await gate; // the withdrawal is done but NOT committed
        return result;
      });
      await inside;
      const { response: out } = await startClockOut(fx, fx.booked[0]!);
      // Blocked on the shift row lock the uncommitted withdrawal holds (before the fix it did not wait, saw the standby
      // still accepted and left the shift in_progress; the withdrawal saw the staff member still confirmed: neither completed).
      expect(await Promise.race([out.then(() => 'finished'), sleep(1500).then(() => 'waiting')])).toBe('waiting');
      release();
      const withdrawn: WithdrawnOffer | null = await withdrawal;
      expect(withdrawn?.shiftCompleted).toBe(false); // the staff member was still clocked in when it evaluated
      expect((await out).status).toBe(201);
      expect((await shiftRow(fx.shiftId)).status).toBe('completed');
    });

    it('R2: clock-out and withdrawal fired together (no ordering imposed), several times: every shift completes', async () => {
      const ws = await seedWorkspace('fscR2');
      for (let i = 0; i < 4; i++) {
        const fx = await seedRunningShift(`fscR2r${i}`, { required: 1, booked: 1 }, ws);
        const standby = await activeStaff(fx.org, fx.manager, `fscR2r${i}-standby`);
        await clockIn(fx, fx.booked[0]!);
        const offerId = await acceptedReplacementOffer(fx, standby, 'standby');
        await endWindow(offerId);
        const qrToken = await signQr(fx);
        const [out, withdrawn] = await Promise.all([
          http().post('/rest/v1/attendance/clock-out').set(auth(fx.booked[0]!.token)).send({ qrToken }).then((r) => r),
          workerWithdraw(fx, offerId),
        ]);
        expect(out.status).toBe(201);
        expect(withdrawn).not.toBeNull();
        expect((await shiftRow(fx.shiftId)).status).toBe('completed');
        expect(await offerRow(offerId)).toMatchObject({ assignment_status: 'rejected' });
      }
    }, 400_000);

    it('R3: the last two staff clocking out at the same time complete the shift (they used to each see the other still confirmed)', async () => {
      const ws = await seedWorkspace('fscR3');
      for (let i = 0; i < 3; i++) {
        const fx = await seedRunningShift(`fscR3r${i}`, { required: 2, booked: 2 }, ws);
        const [a, b] = fx.booked;
        await clockIn(fx, a!);
        await clockIn(fx, b!);
        const [qrA, qrB] = [await signQr(fx), await signQr(fx)];
        const [outA, outB] = await Promise.all([
          http().post('/rest/v1/attendance/clock-out').set(auth(a!.token)).send({ qrToken: qrA }).then((r) => r),
          http().post('/rest/v1/attendance/clock-out').set(auth(b!.token)).send({ qrToken: qrB }).then((r) => r),
        ]);
        expect([outA.status, outB.status]).toEqual([201, 201]);
        expect((await shiftRow(fx.shiftId)).status).toBe('completed');
      }
    }, 400_000);
  });

  describe('abuse cases: no completion the existing rule does not allow, no reach outside the tenant', () => {
    it('A1: withdrawing a standby while the confirmed staff member is still clocked in leaves the shift in_progress', async () => {
      const fx = await seedRunningShift('fscA1', { required: 1, booked: 1 });
      const standby = await activeStaff(fx.org, fx.manager, 'fscA1-standby');
      await clockIn(fx, fx.booked[0]!);
      const offerId = await acceptedReplacementOffer(fx, standby, 'standby');
      await endWindow(offerId);
      expect(await workerWithdraw(fx, offerId)).toMatchObject({ shiftCompleted: false });
      expect((await shiftRow(fx.shiftId)).status).toBe('in_progress');
    });

    it('A2: a shift that never started (no clock-in) is never completed by a withdrawal — that rule question stays with the owner', async () => {
      const fx = await seedRunningShift('fscA2', { required: 2, booked: 1, accepted: 1 });
      // The only booked staff member is a provisional no-show; nobody clocked in, so the shift is not in_progress.
      await adminDataSource.query(`UPDATE ${businessTable(fx.manager.workspaceId!, 'shift_assignment')} SET status = 'no_show' WHERE shift_id = $1 AND staff_profile_id = $2`, [fx.shiftId, fx.booked[0]!.profileId]);
      const offerId = await offerIdOf(fx, fx.accepted[0]!);
      await passStandardDeadline(offerId);
      expect(await workerWithdraw(fx, offerId)).toMatchObject({ shiftCompleted: false });
      expect((await shiftRow(fx.shiftId)).status).toBe('partially_filled');
    });

    it('A3: another organisation’s context cannot withdraw the offer or complete the shift; no tenant context completes nothing', async () => {
      const fx = await seedRunningShift('fscA3', { required: 1, booked: 1 });
      const other = await seedRunningShift('fscA3other', { required: 1, booked: 1 });
      const standby = await activeStaff(fx.org, fx.manager, 'fscA3-standby');
      await clockIn(fx, fx.booked[0]!);
      const offerId = await acceptedReplacementOffer(fx, standby, 'standby');
      expect((await clockOut(fx, fx.booked[0]!)).status).toBe(201);
      await endWindow(offerId);

      // Another tenant's Worker context, naming its own organisation, with this offer id: RLS + the org filter read nothing.
      const foreign = await tenantContext.runInTenantContext(workerContext(other), (m) => withdrawUnconfirmedOffer(m, deps, other.org.id, offerId, 'worker_scan'));
      expect(foreign).toBeNull();
      // ... or naming THIS organisation from the other workspace's context: still nothing (FORCE RLS on the workspace).
      const spoofed = await tenantContext.runInTenantContext(workerContext(other), (m) => withdrawUnconfirmedOffer(m, deps, fx.org.id, offerId, 'worker_scan'));
      expect(spoofed).toBeNull();
      expect(await offerRow(offerId)).toMatchObject({ status: 'staff_accepted', assignment_status: 'staff_accepted' });
      expect((await shiftRow(fx.shiftId)).status).toBe('in_progress');

      // Fail closed with no tenant context at all: the roll-up cannot even resolve the workspace table (no search_path, no
      // SET LOCAL) — it errors or reads nothing, and changes nothing, even for a shift that is settled (the standby closed
      // by fixture: the state the 12 soak shifts are left in today).
      await adminDataSource.query(`UPDATE ${siblingTable(await businessTableOf(adminDataSource, 'job_offer', offerId), 'shift_assignment')} SET status = 'rejected' WHERE id = $1`, [(await offerRow(offerId)).assignment_id]);
      const noContext = await dataSource.transaction((m) => completeShiftIfSettled(m, fx.org.id, fx.shiftId)).catch(() => 'refused');
      expect([false, 'refused']).toContain(noContext);
      expect((await shiftRow(fx.shiftId)).status).toBe('in_progress');
      // ... and in the right tenant context the same roll-up completes it (how a one-off repair would run — owner approval).
      expect(await tenantContext.runInTenantContext(workerContext(fx), (m) => completeShiftIfSettled(m, fx.org.id, fx.shiftId))).toBe(true);
      expect((await shiftRow(fx.shiftId)).status).toBe('completed');
    });

    it('A4: the roll-up takes no client input — an offer close carrying status/organisationId in the body is a 400 and completes nothing', async () => {
      const fx = await seedRunningShift('fscA4', { required: 1, booked: 1 });
      const standby = await activeStaff(fx.org, fx.manager, 'fscA4-standby');
      await clockIn(fx, fx.booked[0]!);
      const offerId = await acceptedReplacementOffer(fx, standby, 'standby');
      expect((await clockOut(fx, fx.booked[0]!)).status).toBe(201);
      for (const body of [{ reason: 'x', status: 'completed' }, { reason: 'x', organisationId: fx.org.id }]) {
        expect((await http().post(`/rest/v1/offers/${offerId}/reject`).set(auth(fx.managerToken)).send(body)).status).toBe(400);
      }
      expect((await shiftRow(fx.shiftId)).status).toBe('in_progress');
      expect(await offerRow(offerId)).toMatchObject({ status: 'staff_accepted' });
    });
  });
});
