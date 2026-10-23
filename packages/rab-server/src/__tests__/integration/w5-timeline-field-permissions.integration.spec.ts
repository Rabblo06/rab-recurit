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
 * Wave 5 lane DATA — (1) field permissions on attendance read DTOs (money follows payroll.view: the Venue Manager never
 * receives it, cannot filter or sort by it) and (2) the per-entity activity timeline read model over the immutable
 * audit_log (lifecycle, isolation, pagination, no other-organisation rows, no write route). One real lifecycle:
 * shift created → published → offer sent → accepted → confirmed → check in → clock in → clock out → corrected →
 * reviewed → timesheet finalised → payroll approved. Real HTTP, real PostgreSQL with RLS on (crewflow_app).
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('wave 5: field permissions + activity timeline (integration)', () => {
  jest.setTimeout(240_000);

  let app: INestApplication;
  let admin: DataSource;
  let factory: TestIdentityFactory;
  let tenantContext: TenantContextService;
  let attendanceQr: AttendanceQrService;
  let orgId: string;
  let a: TestIdentity;
  let b: TestIdentity;
  let c: TestIdentity;
  let staff: TestIdentity;
  let tokenA: string;
  let tokenB: string;
  let tokenC: string;
  let tokenVm: string;
  let tokenStaff: string;
  let venueId: string;
  let shiftId: string;
  let offerId: string;
  let attendanceId: string;
  let recordId: string;

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const timeline = (token: string, path: string, query: Record<string, unknown> = {}) => http().get(`/rest/v1/timeline/${path}`).query(query).set(auth(token));
  const steps = (res: request.Response) => (res.body.items as Array<{ step: string | null }>).map((i) => i.step).filter(Boolean);

  /** Revokes payroll.view for manager A (user_permission_override) for the duration of `fn` — attendance.view stays. */
  async function withoutPayrollView(fn: () => Promise<void>): Promise<void> {
    await admin.query(
      `INSERT INTO core.user_permission_override (user_id, permission_id, organisation_id, effect)
       SELECT $1, p.id, $2, 'revoke' FROM core.permission p WHERE p.key = 'payroll.view'`,
      [a.userId, orgId],
    );
    try {
      await fn();
    } finally {
      await admin.query(`DELETE FROM core.user_permission_override WHERE user_id = $1`, [a.userId]);
    }
  }

  async function signQr(id: string): Promise<string> {
    return tenantContext.runInTenantContext({ organisationId: orgId, workspaceId: a.workspaceId, userId: a.userId, role: '' }, async (m) =>
      attendanceQr.sign(await m.findOneByOrFail(Shift, { id })));
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    tenantContext = moduleRef.get(TenantContextService);
    attendanceQr = moduleRef.get(AttendanceQrService);
    admin = createAdminDataSource();
    await admin.initialize();
    factory = new TestIdentityFactory({ app, dataSource: moduleRef.get(DataSource), adminDataSource: admin, tenantContext, passwordHashing: moduleRef.get(PasswordHashingService) });

    const seeded = await factory.createOrganisationWithManagers(2, { permissions: 'production', workspace: true, label: 'w5tl' });
    orgId = seeded.organisation.id;
    [a, b] = seeded.managers as [TestIdentity, TestIdentity];
    c = (await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'w5tl-c' })).managers[0]!;
    staff = await factory.createStaff(seeded.organisation, { owner: a, label: 'w5tl-s' });
    await admin.query(`UPDATE core.staff_profile SET employment_status = 'active' WHERE id = $1`, [staff.profileId]);
    [tokenA, tokenB, tokenC, tokenStaff] = [await factory.login(a), await factory.login(b), await factory.login(c), await factory.login(staff)];

    const venue = await http().post('/rest/v1/venues').set(auth(tokenA)).send({ name: `Timeline Venue ${randomUUID().slice(0, 6)}`, type: 'hotel' });
    venueId = venue.body.id;
    const role = await http().post('/rest/v1/job-roles').set(auth(tokenA)).send({ name: `Role-${randomUUID()}`, defaultRatePence: 1337 });
    const vm = await factory.createVenueManager(seeded.organisation, { owner: a, venueIds: [venueId], label: 'w5tl-vm' });
    tokenVm = await factory.login(vm);

    // The lifecycle, through the real endpoints.
    const startsAt = new Date(Date.now() - 5 * 60_000);
    const shift = await http().post('/rest/v1/shifts').set(auth(tokenA))
      .send({ venueId, jobRoleId: role.body.id, startsAt: startsAt.toISOString(), endsAt: new Date(startsAt.getTime() + 8 * 3_600_000).toISOString(), requiredCount: 1 });
    expect(shift.status).toBe(201);
    shiftId = shift.body.id;
    expect((await http().post(`/rest/v1/shifts/${shiftId}/publish`).set(auth(tokenA))).status).toBe(201);
    const offer = await http().post(`/rest/v1/shifts/${shiftId}/offers`).set(auth(tokenA)).send({ staffProfileId: staff.profileId });
    expect(offer.status).toBe(201);
    offerId = offer.body.id;
    expect((await http().post(`/rest/v1/offers/${offerId}/accept`).set(auth(tokenStaff))).status).toBe(201);
    expect((await http().post(`/rest/v1/offers/${offerId}/confirm`).set(auth(tokenA))).status).toBe(201);
    expect((await http().post('/rest/v1/attendance/check-in').set(auth(tokenStaff)).send({ shiftId })).status).toBe(200);
    expect((await http().post('/rest/v1/attendance/clock-in').set(auth(tokenStaff)).send({ shiftId, qrToken: await signQr(shiftId) })).status).toBe(201);
    const out = await http().post('/rest/v1/attendance/clock-out').set(auth(tokenStaff)).send({ qrToken: await signQr(shiftId) });
    expect(out.status).toBe(201);
    attendanceId = out.body.id;
    const corrected = await http().post(`/rest/v1/attendance/${attendanceId}/correct`).set(auth(tokenA))
      .send({ field: 'clockInAt', newValue: new Date(new Date(out.body.clockOutAt).getTime() - 240 * 60_000).toISOString(), reason: 'Timeline test: real worked time' });
    expect(corrected.status).toBe(201);
    expect((await http().post(`/rest/v1/attendance/report/shift/${shiftId}/staff/${staff.profileId}/attendance-review`).set(auth(tokenA))).status).toBe(200);
    expect((await http().patch(`/rest/v1/attendance/report/shift/${shiftId}/finalise`).set(auth(tokenA))).status).toBe(200);
    [{ id: recordId }] = await admin.query(`SELECT id FROM core.payroll_record WHERE attendance_id = $1`, [attendanceId]);
    expect((await http().post(`/rest/v1/payroll/records/${recordId}/approve`).set(auth(tokenA))).status).toBe(200);
  });

  afterAll(async () => {
    await app?.close();
    await admin?.destroy();
  });

  // ─────────────────────────────────────────────── field permissions

  describe('field permissions (money follows payroll.view)', () => {
    it('F1GET /attendance: with payroll.view the row carries earnedPence; without it (attendance.view only) money is ABSENT', async () => {
      const mine = await http().get(`/rest/v1/attendance?staffProfileId=${staff.profileId}`).set(auth(tokenA));
      expect(mine.status).toBe(200);
      expect(mine.body.data[0]).toMatchObject({ id: attendanceId, workedMinutes: 240 });
      expect(typeof mine.body.data[0].earnedPence).toBe('number');
      expect(typeof mine.body.data[0].payrollApprovedPence).toBe('number');
      await withoutPayrollView(async () => {
        const res = await http().get(`/rest/v1/attendance?staffProfileId=${staff.profileId}`).set(auth(tokenA));
        expect(res.status).toBe(200);
        expect(res.body.data[0]).toMatchObject({ id: attendanceId, workedMinutes: 240 });
        expect(res.body.data[0]).not.toHaveProperty('earnedPence');
        expect(res.body.data[0]).not.toHaveProperty('payrollApprovedPence');
      });
    });

    it('F2 a hidden field cannot be probed: without payroll.view the earnedPence filter and sort are ignored; with it the filter applies', async () => {
      await withoutPayrollView(async () => {
        const res = await http().get(`/rest/v1/attendance?staffProfileId=${staff.profileId}&earnedPenceMin=999999999&sort=earnedPence`).set(auth(tokenA));
        expect(res.status).toBe(200);
        expect(res.body.data.map((r: { id: string }) => r.id)).toEqual([attendanceId]);
      });
      const mine = await http().get(`/rest/v1/attendance?staffProfileId=${staff.profileId}&earnedPenceMin=999999999`).set(auth(tokenA));
      expect(mine.body.data).toEqual([]);
    });

    it('F2b the Venue Manager (mobile) never reaches the manager attendance list at all (route default-deny)', async () => {
      expect((await http().get('/rest/v1/attendance').set(auth(tokenVm))).status).toBe(403);
    });

    it('F3 GET shift report: seats carry earnedPence for the manager, never for the Venue Manager', async () => {
      const mine = await http().get(`/rest/v1/attendance/report/shift/${shiftId}`).set(auth(tokenA));
      expect(typeof mine.body.staff[0].earnedPence).toBe('number');
      const vm = await http().get(`/rest/v1/attendance/report/shift/${shiftId}`).set(auth(tokenVm));
      expect(vm.status).toBe(200);
      expect(vm.body.staff[0]).toMatchObject({ staffProfileId: staff.profileId, workedMinutes: 240 });
      expect(vm.body.staff[0]).not.toHaveProperty('earnedPence');
    });

    it('F4 the payroll views stay complete for payroll.view holders and closed to the Venue Manager (403 at the guard)', async () => {
      const list = await http().get('/rest/v1/payroll/records').set(auth(tokenA));
      expect(list.body.data.find((r: { id: string }) => r.id === recordId)).toMatchObject({ amountPence: expect.any(Number), payRatePence: 1337 });
      expect((await http().get('/rest/v1/payroll/records').set(auth(tokenVm))).status).toBe(403);
    });
  });

  // ─────────────────────────────────────────────── timeline

  describe('activity timeline', () => {
    it('T1 shift timeline shows the whole lifecycle, newest first, actor names, no other entity', async () => {
      const res = await timeline(tokenA, `shifts/${shiftId}`, { limit: 100 });
      expect(res.status).toBe(200);
      const seen = steps(res);
      for (const step of ['shift_created', 'shift_published', 'offer_sent', 'offer_accepted', 'offer_approved', 'check_in', 'clock_in', 'clock_out', 'attendance_corrected', 'review', 'timesheet', 'payroll_approved']) {
        expect(seen).toContain(step);
      }
      expect(seen.indexOf('payroll_approved')).toBeLessThan(seen.indexOf('shift_created')); // DESC order
      const created = (res.body.items as Array<{ createdAt: string }>).map((i) => i.createdAt);
      expect([...created].sort().reverse()).toEqual(created);
      const approved = res.body.items.find((i: { step: string }) => i.step === 'payroll_approved');
      expect(approved.metadata.amountPence).toEqual(expect.any(Number)); // payroll-capable caller
      expect(res.body.nextCursor).toBeNull();
    });

    it('T2 without payroll.view the shift timeline has no payroll event and no money in metadata; the VM app is route-denied', async () => {
      await withoutPayrollView(async () => {
        const res = await timeline(tokenA, `shifts/${shiftId}`, { limit: 100 });
        expect(res.status).toBe(200);
        expect(steps(res)).toContain('timesheet');
        expect(steps(res)).not.toContain('payroll_approved');
        for (const item of res.body.items as Array<{ entityType: string; metadata: Record<string, unknown> }>) {
          expect(item.entityType).not.toBe('payroll_record');
          for (const key of Object.keys(item.metadata)) expect(key).not.toMatch(/Pence$/);
        }
      });
      // Timelines are a web-console surface: a venue_manager_app credential is refused on every one (CF-08 default-deny).
      for (const path of [`shifts/${shiftId}`, `attendance/${attendanceId}`]) expect((await timeline(tokenVm, path)).status).toBe(403);
    });

    it('T3 isolation: another workspace and another organisation get 404 on every timeline; staff are refused', async () => {
      for (const path of [`shifts/${shiftId}`, `offers/${offerId}`, `staff/${staff.profileId}`, `attendance/${attendanceId}`, `payroll-records/${recordId}`]) {
        expect({ path, b: (await timeline(tokenB, path)).status }).toEqual({ path, b: 404 });
        expect({ path, c: (await timeline(tokenC, path)).status }).toEqual({ path, c: 404 });
        expect([403, 404]).toContain((await timeline(tokenStaff, path)).status);
      }
      expect((await timeline(tokenA, `shifts/${randomUUID()}`)).status).toBe(404);
      expect([400, 404]).toContain((await timeline(tokenA, 'shifts/not-a-uuid')).status);
    });

    it('T4 attendance timeline needs attendance.view only; the payroll-record timeline needs payroll access (403 without)', async () => {
      await withoutPayrollView(async () => {
        const att = await timeline(tokenA, `attendance/${attendanceId}`);
        expect(att.status).toBe(200);
        expect(steps(att)).toEqual(expect.arrayContaining(['clock_in', 'clock_out']));
        expect(steps(att)).not.toContain('payroll_approved');
        expect((await timeline(tokenA, `payroll-records/${recordId}`)).status).toBe(403);
      });
      const pr = await timeline(tokenA, `payroll-records/${recordId}`);
      expect(pr.status).toBe(200);
      expect(steps(pr)).toContain('payroll_approved');
    });

    it('T5 keyset pagination: small pages walk the whole timeline with no duplicate and no gap', async () => {
      const all = (await timeline(tokenA, `shifts/${shiftId}`, { limit: 100 })).body.items.map((i: { id: string }) => i.id);
      const walked: string[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 50; i++) {
        const res: request.Response = await timeline(tokenA, `shifts/${shiftId}`, cursor ? { limit: 3, cursor } : { limit: 3 });
        expect(res.status).toBe(200);
        walked.push(...res.body.items.map((x: { id: string }) => x.id));
        cursor = res.body.nextCursor;
        if (!cursor) break;
      }
      expect(walked).toEqual(all);
      expect(new Set(walked).size).toBe(walked.length);
    });

    it('T6 a malformed / forged cursor is a 400, never "first page"', async () => {
      for (const cursor of ['garbage', Buffer.from(`2026-01-01T00:00:00.000Z|${randomUUID()}`).toString('base64url'), Buffer.from("x'; DROP TABLE core.audit_log; --").toString('base64url')]) {
        expect((await timeline(tokenA, `shifts/${shiftId}`, { cursor })).status).toBe(400);
      }
      expect((await timeline(tokenA, `shifts/${shiftId}`, { limit: 101 })).status).toBe(400);
    });

    it('T7 an audit row of ANOTHER organisation carrying the same entity id never appears', async () => {
      await admin.query(
        `INSERT INTO core.audit_log (organisation_id, action, entity_type, entity_id, metadata) VALUES ($1, 'shift.cancelled', 'shift', $2, '{"reason":"FOREIGN"}')`,
        [c.organisationId, shiftId],
      );
      const res = await timeline(tokenA, `shifts/${shiftId}`, { limit: 100 });
      expect(JSON.stringify(res.body)).not.toContain('FOREIGN');
      expect(steps(res)).not.toContain('shift_cancelled');
    });

    it('T8 staff timeline: the person\'s offers, attendance and payroll, via the owner only', async () => {
      const res = await timeline(tokenA, `staff/${staff.profileId}`, { limit: 100 });
      expect(res.status).toBe(200);
      expect(steps(res)).toEqual(expect.arrayContaining(['offer_sent', 'offer_accepted', 'clock_in', 'payroll_approved']));
      const offerTl = await timeline(tokenA, `offers/${offerId}`, { limit: 100 });
      expect(steps(offerTl)).toEqual(expect.arrayContaining(['offer_sent', 'offer_accepted', 'offer_approved', 'clock_out']));
    });

    it('T9 read-only: no write / update / delete route exists on the timeline', async () => {
      for (const method of ['post', 'put', 'patch', 'delete'] as const) {
        expect((await http()[method](`/rest/v1/timeline/shifts/${shiftId}`).set(auth(tokenA)).send({})).status).toBe(404);
      }
    });
  });
});
