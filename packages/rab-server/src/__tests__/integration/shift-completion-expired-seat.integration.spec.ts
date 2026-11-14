import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { DataSource, EntityManager } from 'typeorm';

import { AppModule } from '../../app.module';
import { ShiftCompleteSettledCommand } from '../../command/shift-complete-settled.command';
import { AuditService } from '../../engine/core-modules/audit/audit.service';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { AttendanceQrService } from '../../modules/attendance/services/attendance-qr.service';
import { Organisation } from '../../modules/identity/entities';
import { claimExpiredOffer } from '../../modules/offer/services/claim-expired-offer';
import { Shift } from '../../modules/scheduling/entities/shift.entity';
import { parseRepairIds, ShiftCompletionRepair } from '../../modules/scheduling/services/shift-completion-repair';
import { Venue } from '../../modules/venue/entities/venue.entity';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';
import { applyGlobalValidationPipe } from '../../engine/utils/global-validation-pipe';
import { integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';
import { businessTable, businessTableOf, siblingTable } from './helpers/hws-fixtures';

/**
 * Owner decisions 2026-11-06 on fix/shift-completion-after-withdrawal (branch fix/shift-completion-expired-seat):
 *  Q1 — an `offered` seat whose offer has EXPIRED counts as closed for shift completion (a read of the seat only; no new
 *       state or transition), and the expiry itself (`claimExpiredOffer`: Worker scan, timer trigger, the staff accept's
 *       lazy expiry) re-runs the completion roll-up;
 *  Q3 — a ONE-OFF repair command, `shift:complete-settled`: `--list` (default, read-only) and `--apply --ids <file>`.
 * Q2 (a shift where nobody clocked in never completes) is unchanged and pinned here too.
 * Real Postgres, RLS on, the real HTTP stack for clock-in / clock-out / accept; the expiry runs the real `claimExpiredOffer`
 * in a Worker-shaped tenant context, exactly as `offer-expiry.job.ts` does. Fixture SQL only places offers / shifts in time.
 */
const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(180_000);

const MIN = 60_000;
const HOUR = 60 * MIN;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describeIfDb('shift completion: an expired offer closes its seat; the one-off repair command (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let tenantContext: TenantContextService;
  let attendanceQr: AttendanceQrService;
  let auditService: AuditService;
  let factory: TestIdentityFactory;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = applyGlobalValidationPipe(moduleRef.createNestApplication());
    await app.init();
    dataSource = moduleRef.get(DataSource);
    tenantContext = moduleRef.get(TenantContextService);
    attendanceQr = moduleRef.get(AttendanceQrService);
    auditService = moduleRef.get(AuditService);
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
   * A `required`-seat shift that started an hour ago: `booked` staff hold confirmed seats (check_in_required = false),
   * `pending` staff hold still-pending standard offers. `started = false` keeps it in the future and never clocked into.
   */
  async function seedShift(label: string, opts: { required: number; booked: number; pending?: number; started?: boolean }, existing?: Ws) {
    const ws = existing ?? (await seedWorkspace(label));
    const booked: Staff[] = [];
    const pending: Staff[] = [];
    for (let i = 0; i < opts.booked; i++) booked.push(await activeStaff(ws.org, ws.manager, `${label}-booked${i}`));
    for (let i = 0; i < (opts.pending ?? 0); i++) pending.push(await activeStaff(ws.org, ws.manager, `${label}-pending${i}`));
    const futureStart = new Date(Date.now() + 72 * HOUR);
    const created = await http().post('/rest/v1/shifts/with-offers').set(auth(ws.managerToken)).send({
      venueId: ws.venue.id,
      jobRoleId: ws.jobRoleId,
      startsAt: futureStart.toISOString(),
      endsAt: new Date(futureStart.getTime() + 8 * HOUR).toISOString(),
      requiredCount: opts.required,
      staffProfileIds: [...booked, ...pending].map((s) => s.profileId),
    });
    expect(created.status).toBe(201);
    const shiftId = created.body.shiftId as string;
    const startsAt = opts.started === false ? futureStart : new Date(Date.now() - HOUR);
    const endsAt = new Date(startsAt.getTime() + 8 * HOUR);
    const status = booked.length === 0 ? 'offered' : booked.length >= opts.required ? 'fully_filled' : 'partially_filled';
    await adminDataSource.query(
      `UPDATE ${businessTable(ws.manager.workspaceId!, 'shift')} SET starts_at = $2, ends_at = $3, default_starts_at = $2, default_ends_at = $3, filled_count = $4, status = $5 WHERE id = $1`,
      [shiftId, startsAt, endsAt, booked.length, status],
    );
    await adminDataSource.query(`UPDATE ${businessTable(ws.manager.workspaceId!, 'shift_assignment')} SET period = tstzrange($2, $3, '[)'), check_in_required = false WHERE shift_id = $1`, [shiftId, startsAt, endsAt]);
    for (const s of booked) {
      await adminDataSource.query(
        `UPDATE ${businessTable(ws.manager.workspaceId!, 'job_offer')} SET status = 'manager_confirmed', staff_accepted_at = now(), manager_confirmed_at = now(), confirmed_by = $3
          WHERE shift_assignment_id IN (SELECT id FROM ${businessTable(ws.manager.workspaceId!, 'shift_assignment')} WHERE shift_id = $1 AND staff_profile_id = $2)`,
        [shiftId, s.profileId, ws.manager.userId],
      );
      await adminDataSource.query(`UPDATE ${businessTable(ws.manager.workspaceId!, 'shift_assignment')} SET status = 'confirmed', confirmed_at = now() WHERE shift_id = $1 AND staff_profile_id = $2`, [shiftId, s.profileId]);
    }
    return { ...ws, shiftId, booked, pending };
  }
  type Fx = Awaited<ReturnType<typeof seedShift>>;

  const signQr = (fx: Fx) =>
    tenantContext.runInTenantContext({ organisationId: fx.org.id, workspaceId: fx.manager.workspaceId, userId: fx.manager.userId, role: '' }, async (m) =>
      attendanceQr.sign(await m.findOneByOrFail(Shift, { id: fx.shiftId })),
    );
  async function clockIn(fx: Fx, staff: Staff) {
    expect((await http().post('/rest/v1/attendance/clock-in').set(auth(staff.token)).send({ shiftId: fx.shiftId, qrToken: await signQr(fx) })).status).toBe(201);
  }
  async function startClockOut(fx: Fx, staff: Staff): Promise<{ response: Promise<request.Response> }> {
    const qrToken = await signQr(fx);
    return { response: http().post('/rest/v1/attendance/clock-out').set(auth(staff.token)).send({ qrToken }).then((r) => r) };
  }
  const clockOut = async (fx: Fx, staff: Staff) => (await startClockOut(fx, staff)).response;

  const offerIdOf = async (fx: Fx, staff: Staff): Promise<string> =>
    (await adminDataSource.query(`SELECT o.id FROM ${businessTable(fx.manager.workspaceId!, 'job_offer')} o JOIN ${businessTable(fx.manager.workspaceId!, 'shift_assignment')} sa ON sa.id = o.shift_assignment_id WHERE sa.shift_id = $1 AND o.staff_profile_id = $2`, [fx.shiftId, staff.profileId]))[0].id;
  /** FIXTURE (time only): the offer's expiry is in the past (the Worker has not swept it yet). */
  const lapse = async (offerId: string) => adminDataSource.query(`UPDATE ${await businessTableOf(adminDataSource, 'job_offer', offerId)} SET expires_at = now() - interval '1 minute' WHERE id = $1`, [offerId]);
  const workerContext = (fx: Fx) => ({ organisationId: fx.org.id, workspaceId: fx.manager.workspaceId, userId: '', role: '', actorType: 'worker' as const });
  /** The Worker's expiry (offer-expiry.job.ts expireOfferCandidate → claimExpiredOffer) in a Worker-shaped context. */
  const workerExpire = (fx: Fx, offerId: string) => tenantContext.runInTenantContext(workerContext(fx), (m) => claimExpiredOffer(m, offerId));
  const shiftStatus = async (shiftId: string): Promise<string> => (await adminDataSource.query(`SELECT status FROM ${await businessTableOf(adminDataSource, 'shift', shiftId)} WHERE id = $1`, [shiftId]))[0].status;
  const seatOf = async (offerId: string) => (await adminDataSource.query(`SELECT o.status, sa.status AS assignment_status FROM ${await businessTableOf(adminDataSource, 'job_offer', offerId)} o JOIN ${siblingTable(await businessTableOf(adminDataSource, 'job_offer', offerId), 'shift_assignment')} sa ON sa.id = o.shift_assignment_id WHERE o.id = $1`, [offerId]))[0];

  describe('Q1: an expired offer closes its seat for completion', () => {
    it('E1 (the soak’s 24 rows): a shift with only expired offers that never started is NOT completed; the seats stay offered', async () => {
      const ws = await seedWorkspace('fseE1');
      for (let i = 0; i < 2; i++) {
        const fx = await seedShift(`fseE1s${i}`, { required: 2, booked: 0, pending: 2 }, ws);
        for (const s of fx.pending) {
          const offerId = await offerIdOf(fx, s);
          await lapse(offerId);
          expect(await workerExpire(fx, offerId)).not.toBeNull();
          expect(await seatOf(offerId)).toEqual({ status: 'expired', assignment_status: 'offered' }); // the seat row is never written
        }
        expect(await shiftStatus(fx.shiftId)).toBe('offered'); // never started: never completed (Q2 unchanged)
      }
    });

    it('E2: the confirmed staff clocked out, the last open seat is a pending offer; its expiry completes the shift', async () => {
      const fx = await seedShift('fseE2', { required: 2, booked: 1, pending: 1 });
      await clockIn(fx, fx.booked[0]!);
      expect((await clockOut(fx, fx.booked[0]!)).status).toBe(201);
      expect(await shiftStatus(fx.shiftId)).toBe('in_progress'); // the pending offer is an open seat
      const offerId = await offerIdOf(fx, fx.pending[0]!);
      await lapse(offerId);
      expect(await workerExpire(fx, offerId)).not.toBeNull();
      expect(await shiftStatus(fx.shiftId)).toBe('completed');
      expect(await workerExpire(fx, offerId)).toBeNull(); // the CAS: a second expiry does nothing
    });

    it('E3: an offer that already expired does not hold the shift open at the clock-out', async () => {
      const fx = await seedShift('fseE3', { required: 2, booked: 1, pending: 1 });
      const offerId = await offerIdOf(fx, fx.pending[0]!);
      await lapse(offerId);
      expect(await workerExpire(fx, offerId)).not.toBeNull();
      await clockIn(fx, fx.booked[0]!);
      expect((await clockOut(fx, fx.booked[0]!)).status).toBe(201);
      expect(await shiftStatus(fx.shiftId)).toBe('completed');
    });

    it('E4: the staff accept’s lazy expiry (accept after expiry → 409) completes the shift too', async () => {
      const fx = await seedShift('fseE4', { required: 2, booked: 1, pending: 1 });
      await clockIn(fx, fx.booked[0]!);
      expect((await clockOut(fx, fx.booked[0]!)).status).toBe(201);
      const offerId = await offerIdOf(fx, fx.pending[0]!);
      await lapse(offerId);
      const res = await http().post(`/rest/v1/offers/${offerId}/accept`).set(auth(fx.pending[0]!.token));
      expect(res.status).toBe(409);
      expect((await seatOf(offerId)).status).toBe('expired');
      expect(await shiftStatus(fx.shiftId)).toBe('completed');
    });

    it('E5 race: an expiry holding its transaction open while the last clock-out runs — the clock-out waits, then completes the shift', async () => {
      const fx = await seedShift('fseE5', { required: 2, booked: 1, pending: 1 });
      await clockIn(fx, fx.booked[0]!);
      const offerId = await offerIdOf(fx, fx.pending[0]!);
      await lapse(offerId);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let entered!: () => void;
      const inside = new Promise<void>((resolve) => (entered = resolve));
      const expiry = tenantContext.runInTenantContext(workerContext(fx), async (m: EntityManager) => {
        const claimed = await claimExpiredOffer(m, offerId);
        entered();
        await gate; // expired, NOT committed
        return claimed;
      });
      await inside;
      const { response } = await startClockOut(fx, fx.booked[0]!);
      expect(await Promise.race([response.then(() => 'finished'), sleep(1500).then(() => 'waiting')])).toBe('waiting');
      release();
      expect(await expiry).not.toBeNull();
      expect((await response).status).toBe(201);
      expect(await shiftStatus(fx.shiftId)).toBe('completed');
    });

    it('E6 race: expiry and clock-out fired together, several times — every shift completes', async () => {
      const ws = await seedWorkspace('fseE6');
      for (let i = 0; i < 4; i++) {
        const fx = await seedShift(`fseE6r${i}`, { required: 2, booked: 1, pending: 1 }, ws);
        await clockIn(fx, fx.booked[0]!);
        const offerId = await offerIdOf(fx, fx.pending[0]!);
        await lapse(offerId);
        const qrToken = await signQr(fx);
        const [out, claimed] = await Promise.all([
          http().post('/rest/v1/attendance/clock-out').set(auth(fx.booked[0]!.token)).send({ qrToken }).then((r) => r),
          workerExpire(fx, offerId),
        ]);
        expect(out.status).toBe(201);
        expect(claimed).not.toBeNull();
        expect(await shiftStatus(fx.shiftId)).toBe('completed');
      }
    }, 400_000);

    it('E7: a still-PENDING (unexpired) offer keeps the shift open — only the expiry closes the seat', async () => {
      const fx = await seedShift('fseE7', { required: 2, booked: 1, pending: 1 });
      await clockIn(fx, fx.booked[0]!);
      expect((await clockOut(fx, fx.booked[0]!)).status).toBe(201);
      expect(await shiftStatus(fx.shiftId)).toBe('in_progress');
      // Past expires_at but not swept: still `pending`, still open (the persisted expiry is what counts).
      await lapse(await offerIdOf(fx, fx.pending[0]!));
      const repair = new ShiftCompletionRepair(dataSource, tenantContext, auditService);
      expect((await repair.list({ organisationId: fx.org.id })).map((r) => r.shiftId)).not.toContain(fx.shiftId);
    });
  });

  describe('Q3: the one-off repair command shift:complete-settled', () => {
    /** A shift in the state the soak left 12 shifts in: in_progress, every seat closed, never completed. */
    async function stuckShift(label: string, existing?: Ws): Promise<Fx> {
      const fx = await seedShift(label, { required: 1, booked: 1 }, existing);
      await clockIn(fx, fx.booked[0]!);
      // FIXTURE: the clock-out as it was written before the fix (attendance closed, seat completed, shift left running).
      await adminDataSource.query(
        `UPDATE ${businessTable(fx.manager.workspaceId!, 'attendance')} SET status = 'clocked_out', clock_out_at = now(), worked_minutes = 60, earned_pence = 1500 WHERE shift_id = $1`,
        [fx.shiftId],
      );
      await adminDataSource.query(`UPDATE ${businessTable(fx.manager.workspaceId!, 'shift_assignment')} SET status = 'completed' WHERE shift_id = $1`, [fx.shiftId]);
      expect(await shiftStatus(fx.shiftId)).toBe('in_progress');
      return fx;
    }
    // Part C1: the shifts and seats of these organisations live in their workspaces' schemas with HWS on (and the core
    // copies with HWS off): one snapshot per schema that holds them, all compared together.
    const snapshot = async (orgIds: string[]) => {
      const workspaces = (await adminDataSource.query(`SELECT id FROM core.manager_workspace WHERE organisation_id = ANY($1::uuid[]) ORDER BY id`, [orgIds])) as Array<{ id: string }>;
      const perSchema = [];
      for (const { id } of workspaces) {
        perSchema.push(
          ...(await adminDataSource.query(
            `SELECT (SELECT jsonb_agg(jsonb_build_array(id, status, updated_at) ORDER BY id) FROM ${businessTable(id, 'shift')} WHERE organisation_id = ANY($1::uuid[]) AND workspace_id = $2) AS shifts,
                    (SELECT jsonb_agg(jsonb_build_array(id, status) ORDER BY id) FROM ${businessTable(id, 'shift_assignment')} WHERE organisation_id = ANY($1::uuid[]) AND workspace_id = $2) AS seats`,
            [orgIds, id],
          )),
        );
      }
      const [{ audits }] = await adminDataSource.query(`SELECT count(*)::int AS audits FROM core.audit_log WHERE organisation_id = ANY($1::uuid[])`, [orgIds]);
      return { perSchema, audits };
    };
    const idsFile = (ids: string[]) => {
      const dir = mkdtempSync(join(tmpdir(), 'fse-ids-'));
      const file = join(dir, 'ids.txt');
      writeFileSync(file, `# reviewed list\n${ids.join('\n')}\n`);
      return file;
    };

    it('C1 --list (default) is READ-ONLY: lists the settled in_progress shifts of every tenant, with venue, times and seats; changes nothing', async () => {
      const a = await stuckShift('fseC1a');
      const notSettled = await seedShift('fseC1n', { required: 2, booked: 1, pending: 1 }, a);
      await clockIn(notSettled, notSettled.booked[0]!);
      const b = await stuckShift('fseC1b');
      const before = await snapshot([a.org.id, b.org.id]);

      const repair = new ShiftCompletionRepair(dataSource, tenantContext, auditService);
      const rows = await repair.list();
      const ours = rows.filter((r) => [a.shiftId, b.shiftId, notSettled.shiftId].includes(r.shiftId));
      expect(ours.map((r) => r.shiftId).sort()).toEqual([a.shiftId, b.shiftId].sort());
      expect(ours.find((r) => r.shiftId === a.shiftId)).toMatchObject({ organisationId: a.org.id, workspaceId: a.manager.workspaceId, venueName: 'Venue fseC1a', seats: { completed: 1 } });

      // Through the command (no flag = --list): the same rows printed, then the count.
      const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
      try {
        await new ShiftCompleteSettledCommand(dataSource, tenantContext, auditService).run([], { organisation: a.org.id });
        const lines = log.mock.calls.map((c) => String(c[0]));
        expect(lines.some((l) => l.includes(`shift=${a.shiftId}`) && l.includes('would-complete'))).toBe(true);
        expect(lines.some((l) => l.includes(notSettled.shiftId))).toBe(false);
        expect(lines.at(-1)).toMatch(/list \(read-only\): 1 shift\(s\) would complete; nothing was changed/);
      } finally {
        log.mockRestore();
      }
      expect(await snapshot([a.org.id, b.org.id])).toEqual(before);
    });

    it('C2 --apply completes ONLY the listed settled ids, refuses a not-settled id, reports a made-up id; idempotent and audited once', async () => {
      const a = await stuckShift('fseC2a');
      const notSettled = await seedShift('fseC2n', { required: 2, booked: 1, pending: 1 }, a);
      await clockIn(notSettled, notSettled.booked[0]!);
      const untouched = await stuckShift('fseC2u', a); // settled too, but NOT in the ids file
      const admin = await factory.createInternalManager(await factory.createOrganisation('fseC2admin'), { permissions: 'production', platformAdmin: true });
      const ghost = randomUUID();
      const file = idsFile([a.shiftId, notSettled.shiftId, ghost]);

      const run = async () => {
        const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
        try {
          process.exitCode = 0;
          await new ShiftCompleteSettledCommand(dataSource, tenantContext, auditService).run([], { apply: true, ids: file, actorEmail: admin.email, changeRef: 'OPS-fsc-test' });
          return { lines: log.mock.calls.map((c) => String(c[0])), exitCode: process.exitCode };
        } finally {
          log.mockRestore();
          process.exitCode = 0;
        }
      };
      const first = await run();
      expect(first.lines).toEqual(expect.arrayContaining([
        `[shift:complete-settled] shift=${a.shiftId} organisation=${a.org.id} result=completed`,
        `[shift:complete-settled] shift=${notSettled.shiftId} organisation=${a.org.id} result=not_settled`,
        `[shift:complete-settled] shift=${ghost} organisation=- result=not_found`,
      ]));
      expect(first.exitCode).toBe(1); // not every id was applied
      expect(await shiftStatus(a.shiftId)).toBe('completed');
      expect(await shiftStatus(notSettled.shiftId)).toBe('in_progress');
      expect(await shiftStatus(untouched.shiftId)).toBe('in_progress'); // never listed, never touched
      const audits = await adminDataSource.query(`SELECT actor_user_id, metadata FROM core.audit_log WHERE entity_id = $1 AND action = 'shift.completed_by_repair'`, [a.shiftId]);
      expect(audits).toEqual([{ actor_user_id: admin.userId, metadata: { source: 'cli:shift:complete-settled', previousStatus: 'in_progress', changeRef: 'OPS-fsc-test' } }]);

      const second = await run();
      expect(second.lines).toContain(`[shift:complete-settled] shift=${a.shiftId} organisation=${a.org.id} result=already_completed`);
      expect(await adminDataSource.query(`SELECT 1 FROM core.audit_log WHERE entity_id = $1 AND action = 'shift.completed_by_repair'`, [a.shiftId])).toHaveLength(1);
    });

    it('C3 --apply with --organisation on another tenant’s id: not_found, that shift untouched, no audit', async () => {
      const a = await stuckShift('fseC3a');
      const b = await stuckShift('fseC3b');
      const admin = await factory.createInternalManager(await factory.createOrganisation('fseC3admin'), { permissions: 'production', platformAdmin: true });
      const repair = new ShiftCompletionRepair(dataSource, tenantContext, auditService);
      expect(await repair.applyCompletion([b.shiftId], { userId: admin.userId }, { organisationId: a.org.id })).toEqual([{ shiftId: b.shiftId, outcome: 'not_found' }]);
      expect(await shiftStatus(b.shiftId)).toBe('in_progress');
      expect(await adminDataSource.query(`SELECT 1 FROM core.audit_log WHERE entity_id = $1 AND action = 'shift.completed_by_repair'`, [b.shiftId])).toHaveLength(0);
    });

    it('C4 refusals: --apply without a platform-admin actor, a non-admin actor, a malformed ids file, --list with --apply', async () => {
      const a = await stuckShift('fseC4a');
      const file = idsFile([a.shiftId]);
      const cmd = () => new ShiftCompleteSettledCommand(dataSource, tenantContext, auditService);
      await expect(cmd().run([], { apply: true, ids: file })).rejects.toThrow(/--actor-email/);
      await expect(cmd().run([], { apply: true, actorEmail: a.manager.email })).rejects.toThrow(/--ids/);
      await expect(cmd().run([], { apply: true, list: true, ids: file, actorEmail: a.manager.email })).rejects.toThrow(/not both/);
      const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        await cmd().run([], { apply: true, ids: file, actorEmail: a.manager.email }); // an ordinary manager, not a platform admin
        expect(process.exitCode).toBe(1);
      } finally {
        err.mockRestore();
        process.exitCode = 0;
      }
      expect(await shiftStatus(a.shiftId)).toBe('in_progress');
      expect(() => parseRepairIds('not-a-uuid\n')).toThrow(/line 1/);
      expect(() => parseRepairIds('# only a comment\n')).toThrow(/no shift id/);
      expect(parseRepairIds(`${a.shiftId}\n${a.shiftId.toUpperCase()}\n`)).toEqual([a.shiftId]);
    });

    it('C5 fail closed: the repair refuses a superuser session', async () => {
      // The superuser fixture connection: the repair refuses to run on it (layer 2 of "no superuser").
      const asSuperuser = new ShiftCompletionRepair(adminDataSource, tenantContext, auditService);
      await expect(asSuperuser.list()).rejects.toThrow(/never a superuser/);
    });
  });
});
