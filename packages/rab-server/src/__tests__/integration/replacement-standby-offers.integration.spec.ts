import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { Organisation } from '../../modules/identity/entities';
import { Venue } from '../../modules/venue/entities/venue.entity';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Replacement & standby offers on the ORIGINAL shift (2026-10-21). Real Postgres, RLS on (runtime role), no mocks; every
 * action goes through the real HTTP stack as the real Initial Manager / staff member / Venue Manager.
 *
 * Owner workflow: an N-seat shift, every seat booked, one seat becomes a manager-CONFIRMED no-show → one vacancy. The
 * manager opens "Send replacement offer" for that shift → offers on the SAME shift id → staff accepts → waits for the
 * manager → manager approves → booked on the original shift. A PROVISIONAL (worker-flagged) no-show frees nothing:
 * offers sent then are standby, which can be accepted but never approved without a real vacancy.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(180_000);

const MIN = 60_000;
const HOUR = 60 * MIN;

describeIfDb('replacement & standby offers on the original shift (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let tenantContext: TenantContextService;
  let factory: TestIdentityFactory;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    dataSource = moduleRef.get(DataSource);
    tenantContext = moduleRef.get(TenantContextService);
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

  type Staff = TestIdentity & { profileId: string };
  async function activeStaff(org: Organisation, owner: TestIdentity, label: string): Promise<Staff> {
    const staff = await factory.createStaff(org, { owner, label });
    await adminDataSource.query(`UPDATE core.staff_profile SET employment_status = 'active' WHERE id = $1`, [staff.profileId]);
    return { ...staff, profileId: staff.profileId! };
  }

  async function seedWorkspace(label = 'repl') {
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

  /**
   * A shift with `required` seats, every seat booked (confirmed), moved so it started `startedAgoMin` ago and lasts
   * `durationH` hours. `noShow` marks the FIRST booked staff member: 'provisional' = the worker's mark only,
   * 'confirmed' = the manager's confirmation (the same columns `ShiftReportService.confirmNoShow` writes).
   */
  async function seedBookedShift(opts: { required?: number; noShow?: 'none' | 'provisional' | 'confirmed'; startedAgoMin?: number; durationH?: number; status?: string; requestedBy?: boolean } = {}) {
    const ws = await seedWorkspace();
    const required = opts.required ?? 2;
    const booked: Staff[] = [];
    for (let i = 0; i < required; i++) booked.push(await activeStaff(ws.org, ws.manager, `booked${i}`));
    const futureStart = new Date(Date.now() + 72 * HOUR);
    const created = await http().post('/rest/v1/shifts/with-offers').set(auth(ws.managerToken)).send({
      venueId: ws.venue.id,
      jobRoleId: ws.jobRoleId,
      startsAt: futureStart.toISOString(),
      endsAt: new Date(futureStart.getTime() + 8 * HOUR).toISOString(),
      breakMinutes: 30,
      requiredCount: required,
      address: '1 Original Street, London',
      notes: 'Original shift notes',
      staffProfileIds: booked.map((s) => s.profileId),
    });
    expect(created.status).toBe(201);
    const shiftId = created.body.shiftId as string;
    const startsAt = new Date(Date.now() - (opts.startedAgoMin ?? 60) * MIN);
    const endsAt = new Date(startsAt.getTime() + (opts.durationH ?? 8) * HOUR);
    await adminDataSource.query(`UPDATE core.job_offer SET status = 'manager_confirmed', staff_accepted_at = now(), manager_confirmed_at = now(), confirmed_by = $2
      WHERE shift_assignment_id IN (SELECT id FROM core.shift_assignment WHERE shift_id = $1)`, [shiftId, ws.manager.userId]);
    await adminDataSource.query(`UPDATE core.shift_assignment SET status = 'confirmed', confirmed_at = now(), period = tstzrange($2, $3, '[)') WHERE shift_id = $1`, [shiftId, startsAt, endsAt]);
    await adminDataSource.query(
      `UPDATE core.shift SET starts_at = $2, ends_at = $3, default_starts_at = $2, default_ends_at = $3, filled_count = required_count, status = $4, requested_by = $5 WHERE id = $1`,
      [shiftId, startsAt, endsAt, opts.status ?? 'fully_filled', opts.requestedBy ? ws.manager.userId : null],
    );
    const absent = booked[0]!;
    const [{ id: absentAssignmentId }] = await adminDataSource.query(`SELECT id FROM core.shift_assignment WHERE shift_id = $1 AND staff_profile_id = $2`, [shiftId, absent.profileId]);
    if (opts.noShow === 'provisional' || opts.noShow === 'confirmed') {
      await adminDataSource.query(`UPDATE core.shift_assignment SET status = 'no_show' WHERE id = $1`, [absentAssignmentId]);
    }
    if (opts.noShow === 'confirmed') {
      await adminDataSource.query(`UPDATE core.shift_assignment SET attendance_reviewed_at = now(), attendance_reviewed_by = $2 WHERE id = $1`, [absentAssignmentId, ws.manager.userId]);
    }
    return { ...ws, shiftId, booked, absent, absentAssignmentId: absentAssignmentId as string, startsAt, endsAt };
  }

  const context = (token: string, shiftId: string) => http().get(`/rest/v1/shifts/${shiftId}/replacement-context`).set(auth(token));
  const sendReplacement = (token: string, shiftId: string, staffProfileIds: string[]) =>
    http().post(`/rest/v1/shifts/${shiftId}/offers/bulk`).set(auth(token)).send({ staffProfileIds, mode: 'replacement' });
  const offerFor = async (shiftId: string, staffProfileId: string) =>
    (await adminDataSource.query(`SELECT o.*, sa.status AS assignment_status, sa.shift_id, lower(sa.period) AS period_start, upper(sa.period) AS period_end
       FROM core.job_offer o JOIN core.shift_assignment sa ON sa.id = o.shift_assignment_id WHERE sa.shift_id = $1 AND o.staff_profile_id = $2`, [shiftId, staffProfileId]))[0];
  const shiftRow = async (shiftId: string) => (await adminDataSource.query(`SELECT * FROM core.shift WHERE id = $1`, [shiftId]))[0];
  const shiftCount = async (orgId: string) => Number((await adminDataSource.query(`SELECT count(*)::int AS n FROM core.shift WHERE organisation_id = $1`, [orgId]))[0].n);
  const accept = (token: string, offerId: string) => http().post(`/rest/v1/offers/${offerId}/accept`).set(auth(token));
  const confirm = (token: string, offerId: string) => http().post(`/rest/v1/offers/${offerId}/confirm`).set(auth(token));
  const occupied = async (shiftId: string) => Number((await adminDataSource.query(
    `SELECT count(*)::int AS n FROM core.shift_assignment WHERE shift_id = $1 AND (status IN ('confirmed','completed') OR (status = 'no_show' AND attendance_reviewed_at IS NULL))`, [shiftId]))[0].n);

  describe('prefill and vacancy', () => {
    it('R1: the replacement form reads the ORIGINAL shift; a confirmed no-show frees exactly one seat', async () => {
      const fx = await seedBookedShift({ noShow: 'confirmed' });
      const res = await context(fx.managerToken, fx.shiftId);
      expect(res.status).toBe(200);
      expect(res.body.shift).toMatchObject({
        id: fx.shiftId,
        venueId: fx.venue.id,
        jobRoleId: fx.jobRoleId,
        venueName: fx.venue.name,
        address: '1 Original Street, London',
        notes: 'Original shift notes',
        breakMinutes: 30,
        payRatePence: 1500,
      });
      expect(new Date(res.body.shift.startsAt).getTime()).toBe(fx.startsAt.getTime());
      expect(new Date(res.body.shift.endsAt).getTime()).toBe(fx.endsAt.getTime());
      expect(res.body.vacancy).toMatchObject({ requiredCount: 2, occupied: 1, confirmedNoShows: 1, provisionalNoShows: 0, vacancy: 1 });
      expect(res.body.offerKind).toBe('replacement');
      expect(res.body.canSend).toBe(true);
      // The shift already started: a replacement would be booked from "now", never from the original start.
      expect(new Date(res.body.replacementWindow.startsAt).getTime()).toBeGreaterThan(fx.startsAt.getTime());
    });

    it('R2: a PROVISIONAL no-show does not free a seat — the form says standby, vacancy 0', async () => {
      const fx = await seedBookedShift({ noShow: 'provisional' });
      const res = await context(fx.managerToken, fx.shiftId);
      expect(res.status).toBe(200);
      expect(res.body.vacancy).toMatchObject({ occupied: 2, confirmedNoShows: 0, provisionalNoShows: 1, vacancy: 0 });
      expect(res.body.offerKind).toBe('standby');
    });

    it('R3: a shift that has ended cannot receive replacements (context canSend=false, send 409)', async () => {
      const fx = await seedBookedShift({ noShow: 'confirmed', startedAgoMin: 9 * 60, durationH: 8 });
      const ctxRes = await context(fx.managerToken, fx.shiftId);
      expect(ctxRes.status).toBe(200);
      expect(ctxRes.body.canSend).toBe(false);
      expect(ctxRes.body.blockedReason).toMatch(/ended/);
      const candidate = await activeStaff(fx.org, fx.manager, 'late');
      const send = await sendReplacement(fx.managerToken, fx.shiftId, [candidate.profileId]);
      expect(send.status).toBe(409);
      expect(await offerFor(fx.shiftId, candidate.profileId)).toBeUndefined();
    });
  });

  describe('send on the same shift', () => {
    it('R4: creates offers on the SAME shift id (no new shift, original shift row untouched), kind replacement, window from send time', async () => {
      const fx = await seedBookedShift({ noShow: 'confirmed', status: 'in_progress' });
      const before = await shiftRow(fx.shiftId);
      const shiftsBefore = await shiftCount(fx.org.id);
      const c1 = await activeStaff(fx.org, fx.manager, 'cand1');
      const c2 = await activeStaff(fx.org, fx.manager, 'cand2');
      const res = await sendReplacement(fx.managerToken, fx.shiftId, [c1.profileId, c2.profileId]);
      expect(res.status).toBe(201);
      expect(res.body.shiftId).toBe(fx.shiftId);
      expect(res.body.offerKind).toBe('replacement');
      expect(res.body.results.every((r: { ok: boolean }) => r.ok)).toBe(true);
      expect(await shiftCount(fx.org.id)).toBe(shiftsBefore);
      const after = await shiftRow(fx.shiftId);
      for (const col of ['venue_id', 'job_role_id', 'address', 'notes', 'break_minutes', 'pay_rate_pence', 'required_count', 'status', 'filled_count']) {
        expect(after[col]).toEqual(before[col]);
      }
      expect(new Date(after.starts_at).getTime()).toBe(new Date(before.starts_at).getTime());
      expect(new Date(after.ends_at).getTime()).toBe(new Date(before.ends_at).getTime());
      for (const c of [c1, c2]) {
        const offer = await offerFor(fx.shiftId, c.profileId);
        expect(offer.shift_id).toBe(fx.shiftId);
        expect(offer.status).toBe('pending');
        expect(offer.offer_kind).toBe('replacement');
        expect(offer.assignment_status).toBe('offered'); // no auto-assignment on send
        expect(new Date(offer.period_start).getTime()).toBeGreaterThan(fx.startsAt.getTime());
        expect(new Date(offer.period_end).getTime()).toBe(fx.endsAt.getTime());
      }
      // The no-show seat's history is untouched.
      const [absent] = await adminDataSource.query(`SELECT status, attendance_reviewed_at, attendance_reviewed_by FROM core.shift_assignment WHERE id = $1`, [fx.absentAssignmentId]);
      expect(absent.status).toBe('no_show');
      expect(absent.attendance_reviewed_by).toBe(fx.manager.userId);
      const audits = await adminDataSource.query(`SELECT metadata FROM core.audit_log WHERE organisation_id = $1 AND action = 'offer.sent' AND metadata->>'offerKind' = 'replacement'`, [fx.org.id]);
      expect(audits).toHaveLength(2);
    });

    it('R5: duplicate send is idempotent — the second submit creates no second offer for the same staff and shift', async () => {
      const fx = await seedBookedShift({ noShow: 'confirmed' });
      const c1 = await activeStaff(fx.org, fx.manager, 'dup');
      const [first, second] = await Promise.all([
        sendReplacement(fx.managerToken, fx.shiftId, [c1.profileId]),
        sendReplacement(fx.managerToken, fx.shiftId, [c1.profileId]),
      ]);
      expect([first.status, second.status]).toEqual([201, 201]);
      const oks = [...first.body.results, ...second.body.results].filter((r: { ok: boolean }) => r.ok);
      expect(oks).toHaveLength(1);
      const rows = await adminDataSource.query(`SELECT o.id FROM core.job_offer o JOIN core.shift_assignment sa ON sa.id = o.shift_assignment_id WHERE sa.shift_id = $1 AND o.staff_profile_id = $2`, [fx.shiftId, c1.profileId]);
      expect(rows).toHaveLength(1);
      const notes = await adminDataSource.query(`SELECT 1 FROM core.notification WHERE user_id = $1 AND type = 'offer_sent'`, [c1.userId]);
      expect(notes).toHaveLength(1);
    });

    it('R6: normal mode is unchanged — a plain bulk send on the full shift is still refused, ordinary offers stay standard', async () => {
      const fx = await seedBookedShift({ noShow: 'confirmed' });
      const c1 = await activeStaff(fx.org, fx.manager, 'plain');
      const res = await http().post(`/rest/v1/shifts/${fx.shiftId}/offers/bulk`).set(auth(fx.managerToken)).send({ staffProfileIds: [c1.profileId] });
      expect(res.status).toBe(409);
      const kinds = await adminDataSource.query(`SELECT DISTINCT o.offer_kind FROM core.job_offer o JOIN core.shift_assignment sa ON sa.id = o.shift_assignment_id WHERE sa.shift_id = $1`, [fx.shiftId]);
      expect(kinds).toEqual([{ offer_kind: 'standard' }]);
      // Client-supplied kinds / unknown modes are rejected at the DTO (anti mass-assignment).
      const bad = await http().post(`/rest/v1/shifts/${fx.shiftId}/offers/bulk`).set(auth(fx.managerToken)).send({ staffProfileIds: [c1.profileId], mode: 'standby' });
      expect(bad.status).toBe(400);
      const injected = await http().post(`/rest/v1/shifts/${fx.shiftId}/offers/bulk`).set(auth(fx.managerToken)).send({ staffProfileIds: [c1.profileId], mode: 'replacement', offerKind: 'replacement' });
      expect(injected.status).toBe(400);
    });
  });

  describe('lifecycle and capacity', () => {
    it('R7: accept → waiting for the manager (never auto-confirmed, even on a request-born shift) → approve → booked on the original shift', async () => {
      const fx = await seedBookedShift({ noShow: 'confirmed', requestedBy: true });
      const c1 = await activeStaff(fx.org, fx.manager, 'life');
      expect((await sendReplacement(fx.managerToken, fx.shiftId, [c1.profileId])).status).toBe(201);
      const staffToken = await factory.login(c1);
      const mine = await http().get('/rest/v1/offers/mine').set(auth(staffToken));
      expect(mine.status).toBe(200);
      const listed = mine.body.find((o: { shiftId: string }) => o.shiftId === fx.shiftId);
      expect(listed).toMatchObject({ offerKind: 'replacement', venueName: fx.venue.name, venueAddress: '1 Original Street, London' });
      expect(new Date(listed.originalStartsAt).getTime()).toBe(fx.startsAt.getTime());
      expect(new Date(listed.originalEndsAt).getTime()).toBe(fx.endsAt.getTime());

      const offer = await offerFor(fx.shiftId, c1.profileId);
      expect((await accept(staffToken, offer.id)).status).toBe(201);
      const waiting = await offerFor(fx.shiftId, c1.profileId);
      expect(waiting.status).toBe('staff_accepted');
      expect(waiting.assignment_status).toBe('staff_accepted');

      // Staff can never approve their own offer.
      expect([401, 403]).toContain((await confirm(staffToken, offer.id)).status);
      expect((await offerFor(fx.shiftId, c1.profileId)).status).toBe('staff_accepted');

      const ok = await confirm(fx.managerToken, offer.id);
      expect(ok.status).toBe(201);
      const booked = await offerFor(fx.shiftId, c1.profileId);
      expect(booked.status).toBe('manager_confirmed');
      expect(booked.assignment_status).toBe('confirmed');
      expect(booked.shift_id).toBe(fx.shiftId);
      // Booked window starts no earlier than the approval; no attendance until their real clock-in.
      expect(new Date(booked.period_start).getTime()).toBeGreaterThan(fx.startsAt.getTime());
      expect(await adminDataSource.query(`SELECT 1 FROM core.attendance WHERE shift_assignment_id = $1`, [booked.shift_assignment_id])).toHaveLength(0);
      expect(await occupied(fx.shiftId)).toBe(2);
      const shift = await shiftRow(fx.shiftId);
      expect(Number(shift.filled_count)).toBe(2);
      const [absent] = await adminDataSource.query(`SELECT status, attendance_reviewed_by FROM core.shift_assignment WHERE id = $1`, [fx.absentAssignmentId]);
      expect(absent).toEqual({ status: 'no_show', attendance_reviewed_by: fx.manager.userId });
      const audit = await adminDataSource.query(`SELECT metadata FROM core.audit_log WHERE action = 'offer.confirmed' AND entity_id = $1`, [offer.id]);
      expect(audit[0].metadata).toMatchObject({ offerKind: 'replacement', shiftId: fx.shiftId });
    });

    it('R8: two accepted replacements for ONE vacancy, approved concurrently — exactly one is booked, no overstaffing', async () => {
      const fx = await seedBookedShift({ noShow: 'confirmed', required: 3 });
      const c1 = await activeStaff(fx.org, fx.manager, 'race1');
      const c2 = await activeStaff(fx.org, fx.manager, 'race2');
      expect((await sendReplacement(fx.managerToken, fx.shiftId, [c1.profileId, c2.profileId])).status).toBe(201);
      const o1 = await offerFor(fx.shiftId, c1.profileId);
      const o2 = await offerFor(fx.shiftId, c2.profileId);
      expect((await accept(await factory.login(c1), o1.id)).status).toBe(201);
      expect((await accept(await factory.login(c2), o2.id)).status).toBe(201);
      const results = await Promise.all([confirm(fx.managerToken, o1.id), confirm(fx.managerToken, o2.id)]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(await occupied(fx.shiftId)).toBe(3);
      expect(Number((await shiftRow(fx.shiftId)).filled_count)).toBe(3);
      const loser = results[0]!.status === 409 ? o1 : o2;
      expect((await adminDataSource.query(`SELECT status FROM core.job_offer WHERE id = $1`, [loser.id]))[0].status).toBe('staff_accepted');
    });

    it('R9: standby — accepted while the original still holds the seat, approval refused (409 NO_VACANCY); allowed once the no-show is confirmed', async () => {
      const fx = await seedBookedShift({ noShow: 'provisional' });
      const c1 = await activeStaff(fx.org, fx.manager, 'standby');
      const sent = await sendReplacement(fx.managerToken, fx.shiftId, [c1.profileId]);
      expect(sent.status).toBe(201);
      expect(sent.body.offerKind).toBe('standby');
      const offer = await offerFor(fx.shiftId, c1.profileId);
      expect(offer.offer_kind).toBe('standby');
      const staffToken = await factory.login(c1);
      expect((await accept(staffToken, offer.id)).status).toBe(201);
      const refused = await confirm(fx.managerToken, offer.id);
      expect(refused.status).toBe(409);
      expect(JSON.stringify(refused.body)).toMatch(/No vacancy — the original staff member is still assigned/);
      expect((await offerFor(fx.shiftId, c1.profileId)).status).toBe('staff_accepted');
      expect(await occupied(fx.shiftId)).toBe(2);
      // No timeout pointer is scheduled for a standby acceptance.
      expect(await adminDataSource.query(`SELECT 1 FROM core.worker_due_work WHERE subject_id = $1`, [offer.id])).toHaveLength(0);

      await adminDataSource.query(`UPDATE core.shift_assignment SET attendance_reviewed_at = now(), attendance_reviewed_by = $2 WHERE id = $1`, [fx.absentAssignmentId, fx.manager.userId]);
      expect((await confirm(fx.managerToken, offer.id)).status).toBe(201);
      expect(await occupied(fx.shiftId)).toBe(2);
    });

    it('R10: expired / declined standby offers are safe — never booked, vacancy unchanged', async () => {
      const fx = await seedBookedShift({ noShow: 'provisional' });
      const c1 = await activeStaff(fx.org, fx.manager, 'exp');
      const c2 = await activeStaff(fx.org, fx.manager, 'dec');
      expect((await sendReplacement(fx.managerToken, fx.shiftId, [c1.profileId, c2.profileId])).status).toBe(201);
      const o1 = await offerFor(fx.shiftId, c1.profileId);
      const o2 = await offerFor(fx.shiftId, c2.profileId);
      await adminDataSource.query(`UPDATE core.job_offer SET expires_at = now() - interval '1 minute' WHERE id = $1`, [o1.id]);
      const expired = await accept(await factory.login(c1), o1.id);
      expect(expired.status).toBe(409);
      expect((await offerFor(fx.shiftId, c1.profileId)).status).toBe('expired');
      const declined = await http().post(`/rest/v1/offers/${o2.id}/decline`).set(auth(await factory.login(c2))).send({ reason: 'Busy' });
      expect(declined.status).toBe(201);
      expect((await confirm(fx.managerToken, o1.id)).status).toBe(409);
      expect((await confirm(fx.managerToken, o2.id)).status).toBe(409);
      expect(await occupied(fx.shiftId)).toBe(2);
    });
  });

  describe('scope and capability', () => {
    it('R11: another workspace\'s manager (same org) and another org\'s manager get 404 — context and send', async () => {
      const fx = await seedBookedShift({ noShow: 'confirmed' });
      const sameOrgOther = await factory.createInternalManager(fx.org, { permissions: 'production', label: 'other' });
      const otherOrg = await seedWorkspace('foreign');
      for (const token of [await factory.login(sameOrgOther), otherOrg.managerToken]) {
        expect((await context(token, fx.shiftId)).status).toBe(404);
        const candidate = await activeStaff(fx.org, fx.manager, 'x');
        expect((await sendReplacement(token, fx.shiftId, [candidate.profileId])).status).toBe(404);
        expect(await offerFor(fx.shiftId, candidate.profileId)).toBeUndefined();
      }
    });

    it('R12: a staff member from another workspace is rejected per recipient — no offer, no notification', async () => {
      const fx = await seedBookedShift({ noShow: 'confirmed' });
      const otherManager = await factory.createInternalManager(fx.org, { permissions: 'production', label: 'other' });
      const foreignStaff = await activeStaff(fx.org, otherManager, 'foreign');
      const own = await activeStaff(fx.org, fx.manager, 'own');
      const res = await sendReplacement(fx.managerToken, fx.shiftId, [foreignStaff.profileId, own.profileId]);
      expect(res.status).toBe(201);
      const byId = Object.fromEntries(res.body.results.map((r: { staffProfileId: string; ok: boolean }) => [r.staffProfileId, r.ok]));
      expect(byId).toEqual({ [foreignStaff.profileId]: false, [own.profileId]: true });
      expect(await offerFor(fx.shiftId, foreignStaff.profileId)).toBeUndefined();
      expect(await adminDataSource.query(`SELECT 1 FROM core.notification WHERE user_id = $1`, [foreignStaff.userId])).toHaveLength(0);
    });

    it('R13: a Venue Manager cannot open or submit the replacement form (no capability escalation)', async () => {
      const fx = await seedBookedShift({ noShow: 'confirmed' });
      const vm = await factory.createVenueManager(fx.org, { owner: fx.manager, venueIds: [fx.venue.id] });
      const vmToken = await factory.login(vm);
      const candidate = await activeStaff(fx.org, fx.manager, 'vm');
      expect([401, 403]).toContain((await context(vmToken, fx.shiftId)).status);
      expect([401, 403]).toContain((await sendReplacement(vmToken, fx.shiftId, [candidate.profileId])).status);
      expect(await offerFor(fx.shiftId, candidate.profileId)).toBeUndefined();
    });

    it('R14: a malformed shift id is refused as not found (UuidPathParamsInterceptor convention), never a 500', async () => {
      const fx = await seedWorkspace('uuid');
      expect((await context(fx.managerToken, 'not-a-uuid')).status).toBe(404);
      expect((await sendReplacement(fx.managerToken, 'not-a-uuid', [randomUUID()])).status).toBe(404);
    });
  });
});
