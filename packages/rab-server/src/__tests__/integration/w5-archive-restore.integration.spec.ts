import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Wave 5 lane DATA — named archive / restore actions (venue, job role, staff leaver, manager profile, draft shift).
 * Real HTTP, real PostgreSQL with RLS on (crewflow_app), no mocks. Every control is asserted on its DENIAL path:
 * another workspace's / organisation's record is a 404 (never 403), a repeated archive or restore is a 409
 * (`assertTransition`), preconditions refuse, archived rows leave the default lists but stay readable in history reads,
 * and every action leaves an audit row in the same transaction.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('wave 5: archive / restore (integration)', () => {
  jest.setTimeout(240_000);

  let app: INestApplication;
  let admin: DataSource;
  let factory: TestIdentityFactory;
  let orgId: string;
  let a: TestIdentity; // owner of everything below
  let b: TestIdentity; // same organisation, other workspace
  let c: TestIdentity; // other organisation
  let ceo: TestIdentity;
  let tokenA: string;
  let tokenB: string;
  let tokenC: string;
  let tokenCeo: string;
  let tokenVm: string;
  let jobRoleId: string;

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const uniq = (label: string) => `${label} ${randomUUID().slice(0, 8)}`;
  const audit = async (action: string, entityId: string) =>
    (await admin.query(`SELECT actor_user_id, entity_type, target_user_id, metadata FROM core.audit_log WHERE organisation_id = $1 AND action = $2 AND entity_id = $3`, [orgId, action, entityId])) as Array<Record<string, any>>;

  async function createVenue(token: string, name = uniq('Archive Venue')): Promise<string> {
    const res = await http().post('/rest/v1/venues').set(auth(token)).send({ name, type: 'hotel' });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  async function createShift(token: string, venueId: string, roleId = jobRoleId): Promise<request.Response> {
    const start = new Date(Date.now() + 5 * 86_400_000);
    return http().post('/rest/v1/shifts').set(auth(token)).send({
      venueId, jobRoleId: roleId, startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 4 * 3_600_000).toISOString(), requiredCount: 1,
    });
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    admin = createAdminDataSource();
    await admin.initialize();
    factory = new TestIdentityFactory({
      app, dataSource: moduleRef.get(DataSource), adminDataSource: admin,
      tenantContext: moduleRef.get(TenantContextService), passwordHashing: moduleRef.get(PasswordHashingService),
    });
    const seeded = await factory.createOrganisationWithManagers(2, { permissions: 'production', workspace: true, label: 'w5arch' });
    orgId = seeded.organisation.id;
    [a, b] = seeded.managers as [TestIdentity, TestIdentity];
    ceo = await factory.createCeo(seeded.organisation, { permissions: 'production' });
    const other = await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'w5arch-c' });
    c = other.managers[0]!;
    [tokenA, tokenB, tokenC, tokenCeo] = [await factory.login(a), await factory.login(b), await factory.login(c), await factory.login(ceo)];
    const role = await http().post('/rest/v1/job-roles').set(auth(tokenA)).send({ name: uniq('Archive Role'), defaultRatePence: 1200 });
    expect(role.status).toBe(201);
    jobRoleId = role.body.id;
  });

  afterAll(async () => {
    await app?.close();
    await admin?.destroy();
  });

  // ─────────────────────────────────────────────── venue

  describe('venue', () => {
    let venueId: string;
    let venueName: string;

    beforeAll(async () => {
      venueName = uniq('Archived Venue');
      venueId = await createVenue(tokenA, venueName);
      const vm = await factory.createVenueManager({ id: orgId }, { owner: a, venueIds: [venueId], label: 'w5arch-vm' });
      tokenVm = await factory.login(vm);
    });

    it('V1 a Venue Manager (no venue.edit) is refused at the guard — 403, the categorical permission case', async () => {
      expect((await http().post(`/rest/v1/venues/${venueId}/archive`).set(auth(tokenVm))).status).toBe(403);
    });

    it('V2 another workspace (same org) and another organisation get 404, never 403, and the venue is unchanged', async () => {
      expect((await http().post(`/rest/v1/venues/${venueId}/archive`).set(auth(tokenB))).status).toBe(404);
      expect((await http().post(`/rest/v1/venues/${venueId}/archive`).set(auth(tokenC))).status).toBe(404);
      const [row] = await admin.query(`SELECT status, archived_at FROM core.venue WHERE id = $1`, [venueId]);
      expect(row).toMatchObject({ status: 'active', archived_at: null });
    });

    it('V3 archiveVenue: 200, status + archived_at/by move together, audited in the same transaction', async () => {
      const res = await http().post(`/rest/v1/venues/${venueId}/archive`).set(auth(tokenA));
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ id: venueId, status: 'archived', archivedBy: a.userId });
      expect(res.body.archivedAt).toEqual(expect.any(String));
      const rows = await audit('venue.archived', venueId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actor_user_id: a.userId, entity_type: 'venue', metadata: { name: venueName } });
    });

    it('V4 archiving again is a 409 (transition refused), not a silent no-op; no second audit row', async () => {
      expect((await http().post(`/rest/v1/venues/${venueId}/archive`).set(auth(tokenA))).status).toBe(409);
      expect(await audit('venue.archived', venueId)).toHaveLength(1);
    });

    it('V5 hidden from the default list; "Show archived" and status=archived bring it back; GET by id (history) still resolves', async () => {
      const ids = (res: request.Response) => (res.body.data as Array<{ id: string }>).map((v) => v.id);
      expect(ids(await http().get('/rest/v1/venues').set(auth(tokenA)))).not.toContain(venueId);
      expect(ids(await http().get('/rest/v1/venues?includeArchived=true').set(auth(tokenA)))).toContain(venueId);
      expect(ids(await http().get('/rest/v1/venues?status=archived').set(auth(tokenA)))).toContain(venueId);
      const one = await http().get(`/rest/v1/venues/${venueId}`).set(auth(tokenA));
      expect(one.status).toBe(200);
      expect(one.body.name).toBe(venueName);
      // includeArchived accepts only true/false — anything else is a 400, never a guess.
      expect((await http().get('/rest/v1/venues?includeArchived=yes').set(auth(tokenA))).status).toBe(400);
    });

    it('V6 no new shift at an archived venue (409 VENUE_ARCHIVED)', async () => {
      const res = await createShift(tokenA, venueId);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('VENUE_ARCHIVED');
    });

    it('V7 a client can never write the archive columns or status directly (mass assignment → 400)', async () => {
      for (const body of [{ archivedAt: null }, { archivedBy: a.userId }, { status: 'active' }]) {
        expect((await http().patch(`/rest/v1/venues/${venueId}`).set(auth(tokenA)).send(body)).status).toBe(400);
      }
    });

    it('V8 restore: cross-tenant 404, then 200 + audit; restoring again is 409', async () => {
      expect((await http().post(`/rest/v1/venues/${venueId}/restore`).set(auth(tokenB))).status).toBe(404);
      expect((await http().post(`/rest/v1/venues/${venueId}/restore`).set(auth(tokenC))).status).toBe(404);
      const res = await http().post(`/rest/v1/venues/${venueId}/restore`).set(auth(tokenA));
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ status: 'active', archivedAt: null, archivedBy: null });
      expect(await audit('venue.restored', venueId)).toHaveLength(1);
      expect((await http().post(`/rest/v1/venues/${venueId}/restore`).set(auth(tokenA))).status).toBe(409);
    });

    it('V9 a venue archived before wave 5 (status only, archived_at NULL) is hidden and restorable', async () => {
      const legacy = await createVenue(tokenA);
      await admin.query(`UPDATE core.venue SET status = 'archived' WHERE id = $1`, [legacy]);
      const list = await http().get('/rest/v1/venues').set(auth(tokenA));
      expect((list.body.data as Array<{ id: string }>).map((v) => v.id)).not.toContain(legacy);
      expect((await http().post(`/rest/v1/venues/${legacy}/restore`).set(auth(tokenA))).status).toBe(201);
    });
  });

  // ─────────────────────────────────────────────── job role

  describe('job role', () => {
    let roleId: string;
    let roleName: string;
    let venueId: string;

    beforeAll(async () => {
      roleName = uniq('Archived Role');
      roleId = (await http().post('/rest/v1/job-roles').set(auth(tokenA)).send({ name: roleName, defaultRatePence: 1100 })).body.id;
      venueId = await createVenue(tokenA);
    });

    it('J1 other workspace / other organisation: 404; owner: 200 + audit; again: 409', async () => {
      expect((await http().post(`/rest/v1/job-roles/${roleId}/archive`).set(auth(tokenB))).status).toBe(404);
      expect((await http().post(`/rest/v1/job-roles/${roleId}/archive`).set(auth(tokenC))).status).toBe(404);
      const res = await http().post(`/rest/v1/job-roles/${roleId}/archive`).set(auth(tokenA));
      expect(res.status).toBe(201);
      expect(res.body.archivedAt).toEqual(expect.any(String));
      expect(await audit('job_role.archived', roleId)).toHaveLength(1);
      expect((await http().post(`/rest/v1/job-roles/${roleId}/archive`).set(auth(tokenA))).status).toBe(409);
    });

    it('J2 still in GET /job-roles (FK/name reference read for historical shifts), flagged archivedAt', async () => {
      const list = await http().get('/rest/v1/job-roles').set(auth(tokenA));
      const found = (list.body as Array<{ id: string; archivedAt: string | null }>).find((r) => r.id === roleId);
      expect(found?.archivedAt).toEqual(expect.any(String));
    });

    it('J3 no new shift with an archived role (409 JOB_ROLE_ARCHIVED); re-creating its name is a 409 that says restore', async () => {
      const shift = await createShift(tokenA, venueId, roleId);
      expect(shift.status).toBe(409);
      expect(shift.body.code).toBe('JOB_ROLE_ARCHIVED');
      const dup = await http().post('/rest/v1/job-roles').set(auth(tokenA)).send({ name: roleName });
      expect(dup.status).toBe(409);
      expect(dup.body.code).toBe('JOB_ROLE_ARCHIVED_NAME');
    });

    it('J4 restore: 200 (cannot conflict — the archived role kept its name), then the role is usable again', async () => {
      expect((await http().post(`/rest/v1/job-roles/${roleId}/restore`).set(auth(tokenB))).status).toBe(404);
      expect((await http().post(`/rest/v1/job-roles/${roleId}/restore`).set(auth(tokenA))).status).toBe(201);
      expect((await http().post(`/rest/v1/job-roles/${roleId}/restore`).set(auth(tokenA))).status).toBe(409);
      expect((await createShift(tokenA, venueId, roleId)).status).toBe(201);
    });
  });

  // ─────────────────────────────────────────────── draft shift

  describe('draft shift', () => {
    let venueId: string;
    let draftId: string;

    beforeAll(async () => {
      venueId = await createVenue(tokenA);
      const res = await createShift(tokenA, venueId);
      expect(res.status).toBe(201);
      draftId = res.body.id;
    });

    it('S1 shift.created is audited at creation (timeline step 1)', async () => {
      expect(await audit('shift.created', draftId)).toHaveLength(1);
    });

    it('S2 cross-tenant 404; owner archives the draft; hidden from the list unless includeArchived; GET by id still works', async () => {
      expect((await http().post(`/rest/v1/shifts/${draftId}/archive`).set(auth(tokenB))).status).toBe(404);
      expect((await http().post(`/rest/v1/shifts/${draftId}/archive`).set(auth(tokenC))).status).toBe(404);
      const res = await http().post(`/rest/v1/shifts/${draftId}/archive`).set(auth(tokenA));
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ status: 'draft', archivedBy: a.userId });
      expect(await audit('shift.archived', draftId)).toHaveLength(1);
      const ids = (r: request.Response) => (r.body.data as Array<{ id: string }>).map((s) => s.id);
      expect(ids(await http().get(`/rest/v1/shifts?venueId=${venueId}`).set(auth(tokenA)))).not.toContain(draftId);
      expect(ids(await http().get(`/rest/v1/shifts?venueId=${venueId}&includeArchived=true`).set(auth(tokenA)))).toContain(draftId);
      expect((await http().get(`/rest/v1/shifts/${draftId}`).set(auth(tokenA))).status).toBe(200);
    });

    it('S3 an archived draft cannot be published (409) — restore first; the DB CHECK is the backstop for any other writer', async () => {
      const pub = await http().post(`/rest/v1/shifts/${draftId}/publish`).set(auth(tokenA));
      expect(pub.status).toBe(409);
      await expect(admin.query(`UPDATE core.shift SET status = 'open' WHERE id = $1`, [draftId])).rejects.toMatchObject({ code: '23514' });
    });

    it('S4 restore → publish works; a PUBLISHED shift can never be archived (409 SHIFT_NOT_DRAFT, cancel instead)', async () => {
      expect((await http().post(`/rest/v1/shifts/${draftId}/restore`).set(auth(tokenA))).status).toBe(201);
      expect((await http().post(`/rest/v1/shifts/${draftId}/restore`).set(auth(tokenA))).status).toBe(409);
      expect((await http().post(`/rest/v1/shifts/${draftId}/publish`).set(auth(tokenA))).status).toBe(201);
      expect(await audit('shift.published', draftId)).toHaveLength(1);
      const res = await http().post(`/rest/v1/shifts/${draftId}/archive`).set(auth(tokenA));
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('SHIFT_NOT_DRAFT');
    });
  });

  // ─────────────────────────────────────────────── staff (leaver)

  describe('staff leaver', () => {
    let staff: TestIdentity;
    let busy: TestIdentity;
    let venueId: string;
    let pastShiftId: string;

    beforeAll(async () => {
      staff = await factory.createStaff({ id: orgId }, { owner: a, label: 'w5arch-leaver' });
      busy = await factory.createStaff({ id: orgId }, { owner: a, label: 'w5arch-busy' });
      await admin.query(`UPDATE core.staff_profile SET employment_status = 'active' WHERE id = ANY($1::uuid[])`, [[staff.profileId, busy.profileId]]);
      venueId = await createVenue(tokenA, uniq('History Venue'));
      // A finished, worked shift for `staff` (history that must survive archiving).
      const shift = await createShift(tokenA, venueId);
      pastShiftId = shift.body.id;
      expect((await http().post(`/rest/v1/shifts/${pastShiftId}/publish`).set(auth(tokenA))).status).toBe(201);
      expect((await http().post(`/rest/v1/shifts/${pastShiftId}/offers`).set(auth(tokenA)).send({ staffProfileId: staff.profileId })).status).toBe(201);
      const past = { s: new Date(Date.now() - 30 * 3_600_000), e: new Date(Date.now() - 26 * 3_600_000) };
      await admin.query(`UPDATE core.shift SET starts_at = $2, ends_at = $3 WHERE id = $1`, [pastShiftId, past.s, past.e]);
      await admin.query(`UPDATE core.shift_assignment SET status = 'completed', confirmed_at = now(), period = tstzrange($2, $3, '[)') WHERE shift_id = $1`, [pastShiftId, past.s, past.e]);
      await admin.query(
        `INSERT INTO core.attendance (organisation_id, workspace_id, shift_assignment_id, shift_id, staff_profile_id, clock_in_at, clock_out_at, status, break_minutes, worked_minutes, earned_pence)
         SELECT sa.organisation_id, sa.workspace_id, sa.id, sa.shift_id, sa.staff_profile_id, $2, $3, 'approved', 0, 240, 4800
           FROM core.shift_assignment sa WHERE sa.shift_id = $1`,
        [pastShiftId, past.s, past.e],
      );
      // An UPCOMING booking for `busy`.
      const upcoming = await createShift(tokenA, venueId);
      expect((await http().post(`/rest/v1/shifts/${upcoming.body.id}/publish`).set(auth(tokenA))).status).toBe(201);
      expect((await http().post(`/rest/v1/shifts/${upcoming.body.id}/offers`).set(auth(tokenA)).send({ staffProfileId: busy.profileId })).status).toBe(201);
    });

    it('L1 an active member cannot be archived: deactivate first (409 STAFF_NOT_DEACTIVATED)', async () => {
      const res = await http().post(`/rest/v1/staff/${staff.profileId}/archive`).set(auth(tokenA));
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('STAFF_NOT_DEACTIVATED');
    });

    it('L2 a deactivated member with an upcoming booking cannot be archived (409 STAFF_HAS_UPCOMING_WORK)', async () => {
      expect((await http().post(`/rest/v1/staff/${busy.profileId}/deactivate`).set(auth(tokenA))).status).toBe(201);
      const res = await http().post(`/rest/v1/staff/${busy.profileId}/archive`).set(auth(tokenA));
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('STAFF_HAS_UPCOMING_WORK');
    });

    it('L3 cross-tenant 404; owner archives the deactivated leaver: 200 + audit (entity + target user)', async () => {
      expect((await http().post(`/rest/v1/staff/${staff.profileId}/deactivate`).set(auth(tokenA))).status).toBe(201);
      expect((await http().post(`/rest/v1/staff/${staff.profileId}/archive`).set(auth(tokenB))).status).toBe(404);
      expect((await http().post(`/rest/v1/staff/${staff.profileId}/archive`).set(auth(tokenC))).status).toBe(404);
      const res = await http().post(`/rest/v1/staff/${staff.profileId}/archive`).set(auth(tokenA));
      expect(res.status).toBe(201);
      expect(res.body.archivedAt).toEqual(expect.any(String));
      const rows = await audit('staff.archived', staff.profileId!);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ entity_type: 'staff_profile', target_user_id: staff.userId, actor_user_id: a.userId });
      expect((await http().post(`/rest/v1/staff/${staff.profileId}/archive`).set(auth(tokenA))).status).toBe(409);
    });

    it('L4 hidden from GET /staff unless includeArchived; GET /staff/:id still resolves', async () => {
      const ids = (r: request.Response) => (r.body.data as Array<{ id: string }>).map((s) => s.id);
      expect(ids(await http().get('/rest/v1/staff').set(auth(tokenA)))).not.toContain(staff.profileId);
      expect(ids(await http().get('/rest/v1/staff?includeArchived=true').set(auth(tokenA)))).toContain(staff.profileId);
      expect((await http().get(`/rest/v1/staff/${staff.profileId}`).set(auth(tokenA))).status).toBe(200);
    });

    it('L5 history reads still show the archived leaver AND an archived venue by name (attendance list, shift report)', async () => {
      expect((await http().post(`/rest/v1/venues/${venueId}/archive`).set(auth(tokenA))).status).toBe(201);
      const list = await http().get(`/rest/v1/attendance?staffProfileId=${staff.profileId}`).set(auth(tokenA));
      expect(list.status).toBe(200);
      expect(list.body.data).toHaveLength(1);
      expect(list.body.data[0]).toMatchObject({ staffProfileId: staff.profileId, staffName: 'Staff Member', venueName: expect.stringContaining('History Venue') });
      const report = await http().get(`/rest/v1/attendance/report/shift/${pastShiftId}`).set(auth(tokenA));
      expect(report.status).toBe(200);
      expect(report.body.venueName).toContain('History Venue');
      expect((report.body.staff as Array<{ staffProfileId: string }>).map((r) => r.staffProfileId)).toContain(staff.profileId);
      expect((await http().get(`/rest/v1/shifts/${pastShiftId}`).set(auth(tokenA))).status).toBe(200);
    });

    it('L6 reactivating an archived leaver is refused (restore first); restore: 200, audited, still deactivated', async () => {
      const re = await http().post(`/rest/v1/staff/${staff.profileId}/reactivate`).set(auth(tokenA));
      expect(re.status).toBe(409);
      expect(re.body.code).toBe('STAFF_ARCHIVED');
      expect((await http().post(`/rest/v1/staff/${staff.profileId}/restore`).set(auth(tokenB))).status).toBe(404);
      const res = await http().post(`/rest/v1/staff/${staff.profileId}/restore`).set(auth(tokenA));
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ archivedAt: null, employmentStatus: 'inactive' });
      expect(await audit('staff.restored', staff.profileId!)).toHaveLength(1);
      expect((await http().post(`/rest/v1/staff/${staff.profileId}/restore`).set(auth(tokenA))).status).toBe(409);
    });

    it('L7 payroll, payslip, attendance and audit have NO archive/delete route', async () => {
      const [att] = await admin.query(`SELECT id FROM core.attendance WHERE shift_id = $1`, [pastShiftId]);
      for (const path of [`/rest/v1/attendance/${att.id}/archive`, `/rest/v1/payroll/records/${randomUUID()}/archive`, `/rest/v1/audit-logs/${randomUUID()}/archive`]) {
        expect((await http().post(path).set(auth(tokenA))).status).toBe(404);
      }
      for (const path of [`/rest/v1/attendance/${att.id}`, `/rest/v1/payroll/records/${randomUUID()}`, `/rest/v1/audit-logs/${randomUUID()}`]) {
        expect((await http().delete(path).set(auth(tokenA))).status).toBe(404);
      }
    });
  });

  // ─────────────────────────────────────────────── manager profile

  describe('manager profile', () => {
    let target: TestIdentity;

    beforeAll(async () => {
      target = await factory.createInternalManager({ id: orgId }, { permissions: 'production', label: 'w5arch-target' });
    });

    it('M1 a plain manager (no manager.manage) is refused at the guard (403)', async () => {
      expect((await http().post(`/rest/v1/managers/${target.profileId}/archive`).set(auth(tokenA))).status).toBe(403);
    });

    it('M2 an active manager cannot be archived (deactivate first); yourself never', async () => {
      const res = await http().post(`/rest/v1/managers/${target.profileId}/archive`).set(auth(tokenCeo));
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('MANAGER_NOT_DEACTIVATED');
      const self = await http().post(`/rest/v1/managers/${ceo.profileId}/archive`).set(auth(tokenCeo));
      expect([403, 409]).toContain(self.status); // a CEO profile needs the platform-admin claim first (403), else self → 409
    });

    it('M3 the current Initial Manager is never archived (owner decision pending → refused)', async () => {
      const im = await factory.createInternalManager({ id: orgId }, { permissions: 'production', label: 'w5arch-im' });
      await admin.query(`UPDATE core.manager_profile SET is_initial_manager = true WHERE id = $1`, [im.profileId]);
      await admin.query(`UPDATE core."user" SET status = 'suspended' WHERE id = $1`, [im.userId]);
      const res = await http().post(`/rest/v1/managers/${im.profileId}/archive`).set(auth(tokenCeo));
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('MANAGER_ARCHIVE_INITIAL_MANAGER');
    });

    it('M4 deactivated → archived (200, audit), hidden from the list, other organisation 404, reactivate refused, restore', async () => {
      expect((await http().post(`/rest/v1/managers/${target.profileId}/deactivate`).set(auth(tokenCeo))).status).toBe(201);
      const otherCeo = await factory.createCeo({ id: c.organisationId }, { permissions: 'production' });
      const tokenOtherCeo = await factory.login(otherCeo);
      expect((await http().post(`/rest/v1/managers/${target.profileId}/archive`).set(auth(tokenOtherCeo))).status).toBe(404);
      const res = await http().post(`/rest/v1/managers/${target.profileId}/archive`).set(auth(tokenCeo));
      expect(res.status).toBe(201);
      expect(res.body.archivedAt).toEqual(expect.any(String));
      expect(await audit('manager.archived', target.profileId!)).toHaveLength(1);
      const ids = (r: request.Response) => (r.body.data as Array<{ id: string }>).map((m) => m.id);
      expect(ids(await http().get('/rest/v1/managers?limit=200').set(auth(tokenCeo)))).not.toContain(target.profileId);
      expect(ids(await http().get('/rest/v1/managers?limit=200&includeArchived=true').set(auth(tokenCeo)))).toContain(target.profileId);
      const re = await http().post(`/rest/v1/managers/${target.profileId}/reactivate`).set(auth(tokenCeo));
      expect(re.status).toBe(409);
      expect((await http().post(`/rest/v1/managers/${target.profileId}/restore`).set(auth(tokenOtherCeo))).status).toBe(404);
      const restored = await http().post(`/rest/v1/managers/${target.profileId}/restore`).set(auth(tokenCeo));
      expect(restored.status).toBe(201);
      expect(restored.body).toMatchObject({ archivedAt: null, accountStatus: 'suspended' });
      expect(await audit('manager.restored', target.profileId!)).toHaveLength(1);
    });
  });
});
