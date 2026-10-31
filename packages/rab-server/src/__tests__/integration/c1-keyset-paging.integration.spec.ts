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
 * Phase C1 (contract §1-§3, decisions D1/D2): bounded default pages, the two legacy unpaged staff endpoints, and opaque
 * keyset cursors on `/offers/mine`, `/attendance/me/history`, `/shifts/sent` and `/shifts/requests`; plus the pipeline's
 * cancellation LATERAL matching only offer audit rows. Real Postgres, RLS on (runtime role), no mocks; every read goes
 * through the real HTTP stack as the real staff member / Venue Manager / Internal Manager. Rows are seeded directly
 * (owner connection) so timestamps can be tied to the microsecond — the case a millisecond cursor would get wrong.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(180_000);

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describeIfDb('C1 paging: bounded defaults, legacy staff endpoints and keyset cursors (integration)', () => {
  let app: INestApplication;
  let adminDataSource: DataSource;
  let tenantContext: TenantContextService;
  let factory: TestIdentityFactory;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    tenantContext = moduleRef.get(TenantContextService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = new TestIdentityFactory({ app, dataSource: moduleRef.get(DataSource), adminDataSource, tenantContext, passwordHashing: moduleRef.get(PasswordHashingService) });
  });

  afterAll(async () => {
    await app.close();
    await adminDataSource.destroy();
  });

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const sql = <T = Record<string, unknown>>(text: string, params: unknown[] = []) => adminDataSource.query(text, params) as Promise<T[]>;

  interface Fixture {
    org: Organisation;
    manager: TestIdentity;
    managerToken: string;
    venueId: string;
    jobRoleId: string;
  }

  async function seedWorkspace(label: string): Promise<Fixture> {
    const org = await factory.createOrganisation(label);
    const manager = await factory.createInternalManager(org, { permissions: 'production' });
    const managerToken = await factory.login(manager);
    const venue = await tenantContext.runInTenantContext(
      { organisationId: org.id, workspaceId: manager.workspaceId, userId: manager.userId, role: '' },
      (m) => m.save(Venue, { organisationId: org.id, name: `Venue ${label}`, workspaceId: manager.workspaceId!, createdBy: manager.userId }),
    );
    const [role] = await sql<{ id: string }>(
      `INSERT INTO core.job_role (organisation_id, name, default_rate_pence, created_by, workspace_id) VALUES ($1, $2, 1500, $3, $4) RETURNING id`,
      [org.id, `Role-${randomUUID().slice(0, 8)}`, manager.userId, manager.workspaceId],
    );
    return { org, manager, managerToken, venueId: venue.id, jobRoleId: role!.id };
  }

  async function staffOf(fx: Fixture, label: string) {
    const staff = await factory.createStaff(fx.org, { owner: fx.manager, label });
    return { ...staff, profileId: staff.profileId!, token: await factory.login(staff) };
  }

  /** One shift + seat + offer for `staffProfileId`; `sentAt` exact (ties on purpose), the seat window `[start, end)`. */
  async function seedOffer(fx: Fixture, staffProfileId: string, o: { sentAt: Date | string; start: Date; end: Date }): Promise<string> {
    const [row] = await sql<{ id: string }>(
      `WITH s AS (
         INSERT INTO core.shift (organisation_id, venue_id, job_role_id, starts_at, ends_at, required_count, pay_rate_pence, created_by, workspace_id, status)
         VALUES ($1, $2, $3, $4, $5, 1, 1500, $6, $7, 'offered') RETURNING id),
       a AS (
         INSERT INTO core.shift_assignment (organisation_id, shift_id, staff_profile_id, status, pay_rate_snapshot_pence, period, workspace_id)
         SELECT $1, s.id, $8, 'offered', 1500, tstzrange($4, $5, '[)'), $7 FROM s RETURNING id)
       INSERT INTO core.job_offer (organisation_id, shift_assignment_id, staff_profile_id, status, sent_at, expires_at, estimated_pay_pence, created_by, workspace_id)
       SELECT $1, a.id, $8, 'pending', $9::timestamptz, $9::timestamptz + interval '1 day', 12000, $6, $7 FROM a RETURNING id`,
      [fx.org.id, fx.venueId, fx.jobRoleId, o.start, o.end, fx.manager.userId, fx.manager.workspaceId, staffProfileId, o.sentAt],
    );
    return row!.id;
  }

  /**
   * A past shift the staff member worked: completed seat + clocked-out attendance, `clockInAt` exact. Each seat gets its
   * own day (`seatSlot`) so tied clock-ins never trip the double-booking exclusion; only `clock_in_at` is under test.
   */
  let seatSlot = 0;
  async function seedAttendance(fx: Fixture, staffProfileId: string, clockInAt: Date | string): Promise<string> {
    const [row] = await sql<{ id: string }>(
      `WITH s AS (
         INSERT INTO core.shift (organisation_id, venue_id, job_role_id, starts_at, ends_at, required_count, filled_count, pay_rate_pence, created_by, workspace_id, status)
         VALUES ($1, $2, $3, now() - make_interval(days => 400 + $8::int), now() - make_interval(days => 400 + $8::int) + interval '4 hours', 1, 1, 1500, $5, $6, 'completed')
         RETURNING id, starts_at, ends_at),
       a AS (
         INSERT INTO core.shift_assignment (organisation_id, shift_id, staff_profile_id, status, pay_rate_snapshot_pence, period, workspace_id)
         SELECT $1, s.id, $7, 'completed', 1500, tstzrange(s.starts_at, s.ends_at, '[)'), $6 FROM s RETURNING id, shift_id)
       INSERT INTO core.attendance (organisation_id, shift_assignment_id, shift_id, staff_profile_id, clock_in_at, clock_out_at, status, worked_minutes, earned_pence, workspace_id)
       SELECT $1, a.id, a.shift_id, $7, $4::timestamptz, $4::timestamptz + interval '4 hours', 'clocked_out', 240, 6000, $6 FROM a RETURNING id`,
      [fx.org.id, fx.venueId, fx.jobRoleId, clockInAt, fx.manager.userId, fx.manager.workspaceId, staffProfileId, seatSlot++],
    );
    return row!.id;
  }

  /** Expected keyset order straight from the database: timestamp DESC, id DESC (ids compared as uuid, not as JS strings). */
  async function expectedOrder(table: 'job_offer' | 'attendance' | 'shift', tsColumn: string, ids: string[]): Promise<string[]> {
    const rows = await sql<{ id: string }>(`SELECT id FROM core.${table} WHERE id = ANY($1::uuid[]) ORDER BY ${tsColumn} DESC, id DESC`, [ids]);
    return rows.map((r) => r.id);
  }

  /** Walks a cursor endpoint to the end; fails on a cycle instead of looping forever. */
  async function walk(path: string, token: string, query: Record<string, unknown>, between?: (page: number) => Promise<void>) {
    const ids: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 100; page++) {
      const res: request.Response = await http().get(path).query({ ...query, ...(cursor ? { cursor } : {}) }).set(auth(token));
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      ids.push(...res.body.data.map((r: { id: string }) => r.id));
      cursor = res.body.nextCursor;
      if (cursor === null) return { ids, pages: page + 1, last: res.body };
      expect(typeof cursor).toBe('string');
      if (between) await between(page);
    }
    throw new Error(`cursor walk on ${path} did not terminate`);
  }

  const cursorOf = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

  // ------------------------------------------------------------------------------------------------- /offers/mine

  describe('GET /offers/mine', () => {
    it('LEGACY: no limit/cursor/scope keeps the pre-C1 response exactly — a bare array of up to 500 rows, newest sent first, no window', async () => {
      const fx = await seedWorkspace('c1-legacy-offers');
      const staff = await staffOf(fx, 'c1legacy');
      const ids: string[] = [];
      // 60 > the new default page of 50, and every one of them is OUTSIDE the `current` window (sent 40+ days ago, shift
      // long over) — the legacy call must still return all 60.
      for (let i = 0; i < 60; i++) {
        const start = new Date(Date.now() - (60 + i) * DAY);
        ids.push(await seedOffer(fx, staff.profileId, { sentAt: new Date(Date.now() - (40 + i) * DAY), start, end: new Date(start.getTime() + 4 * HOUR) }));
      }
      const res = await http().get('/rest/v1/offers/mine').set(auth(staff.token));
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(60);
      expect(res.body.map((o: { id: string }) => o.id)).toEqual(await expectedOrder('job_offer', 'sent_at', ids));
      // Offset paging without a size is still the legacy call (500 per page): page 2 is empty here.
      const page2 = await http().get('/rest/v1/offers/mine').query({ page: 2 }).set(auth(staff.token));
      expect(page2.status).toBe(200);
      expect(page2.body).toEqual([]);
    });

    it('sending limit switches to { data, nextCursor } with the bounded page; limit above 200 is 400', async () => {
      const fx = await seedWorkspace('c1-shape-offers');
      const staff = await staffOf(fx, 'c1shape');
      for (let i = 0; i < 12; i++) {
        const start = new Date(Date.now() + (i + 1) * DAY);
        await seedOffer(fx, staff.profileId, { sentAt: new Date(Date.now() - i * HOUR), start, end: new Date(start.getTime() + 4 * HOUR) });
      }
      const res = await http().get('/rest/v1/offers/mine').query({ limit: 5 }).set(auth(staff.token));
      expect(res.status).toBe(200);
      expect(Object.keys(res.body).sort()).toEqual(['data', 'nextCursor']);
      expect(res.body.data).toHaveLength(5);
      expect(typeof res.body.nextCursor).toBe('string');
      expect(res.body.data[0]).toMatchObject({ staffProfileId: staff.profileId, presentation: expect.any(Object) });
      expect((await http().get('/rest/v1/offers/mine').query({ limit: 201 }).set(auth(staff.token))).status).toBe(400);
      expect((await http().get('/rest/v1/offers/mine').query({ limit: 200 }).set(auth(staff.token))).status).toBe(200);
      expect((await http().get('/rest/v1/offers/mine').query({ scope: 'everything' }).set(auth(staff.token))).status).toBe(400);
      // scope alone also opts in (default size 50).
      const scoped = await http().get('/rest/v1/offers/mine').query({ scope: 'all' }).set(auth(staff.token));
      expect(scoped.status).toBe(200);
      expect(scoped.body).toMatchObject({ data: expect.any(Array), nextCursor: null });
      expect(scoped.body.data).toHaveLength(12);
    });

    it('a scope=all cursor walk returns every offer exactly once in sent_at DESC, id DESC order, across microsecond ties', async () => {
      const fx = await seedWorkspace('c1-walk-offers');
      const staff = await staffOf(fx, 'c1walk');
      const ids: string[] = [];
      // Three groups of 7 offers sharing one exact timestamp (microseconds), so page boundaries fall inside ties.
      const tied = ['2026-01-10T09:00:00.123456Z', '2026-01-10T09:00:00.123457Z', '2026-01-09T09:00:00.000001Z'];
      for (const t of tied) {
        for (let i = 0; i < 7; i++) {
          const start = new Date(Date.parse(t) + DAY);
          ids.push(await seedOffer(fx, staff.profileId, { sentAt: t, start, end: new Date(start.getTime() + 4 * HOUR) }));
        }
      }
      const { ids: walked, pages } = await walk('/rest/v1/offers/mine', staff.token, { scope: 'all', limit: 4 });
      expect(pages).toBe(6);
      expect(new Set(walked).size).toBe(walked.length);
      expect(walked).toEqual(await expectedOrder('job_offer', 'sent_at', ids));
    });

    it('concurrent inserts during a walk neither duplicate nor skip any row that existed when the walk began', async () => {
      const fx = await seedWorkspace('c1-concurrent-offers');
      const staff = await staffOf(fx, 'c1conc');
      const ids: string[] = [];
      for (let i = 0; i < 15; i++) {
        const start = new Date(Date.now() + (i + 1) * DAY);
        // Pairs of ties: i and i+1 share a timestamp.
        ids.push(await seedOffer(fx, staff.profileId, { sentAt: new Date(Date.now() - Math.floor(i / 2) * HOUR), start, end: new Date(start.getTime() + 4 * HOUR) }));
      }
      const inserted: string[] = [];
      const { ids: walked } = await walk('/rest/v1/offers/mine', staff.token, { scope: 'all', limit: 4 }, async () => {
        // Newer offers arrive between pages (what a polling client sees in production).
        const start = new Date(Date.now() + 30 * DAY);
        inserted.push(await seedOffer(fx, staff.profileId, { sentAt: new Date(), start, end: new Date(start.getTime() + 4 * HOUR) }));
      });
      expect(inserted.length).toBeGreaterThan(0);
      expect(new Set(walked).size).toBe(walked.length);
      expect(walked).toEqual(await expectedOrder('job_offer', 'sent_at', ids));
    });

    it('scope=current (the default with limit) = shift not ended OR sent in the last 30 days; scope=all is everything', async () => {
      const fx = await seedWorkspace('c1-window-offers');
      const staff = await staffOf(fx, 'c1window');
      const old = Date.now() - 45 * DAY;
      const oldEnded = await seedOffer(fx, staff.profileId, { sentAt: new Date(old), start: new Date(old + DAY), end: new Date(old + DAY + 4 * HOUR) });
      const oldUpcoming = await seedOffer(fx, staff.profileId, { sentAt: new Date(old), start: new Date(Date.now() + 2 * DAY), end: new Date(Date.now() + 2 * DAY + 4 * HOUR) });
      const oldRunning = await seedOffer(fx, staff.profileId, { sentAt: new Date(old), start: new Date(Date.now() - HOUR), end: new Date(Date.now() + HOUR) });
      const recentEnded = await seedOffer(fx, staff.profileId, { sentAt: new Date(Date.now() - 5 * DAY), start: new Date(Date.now() - 4 * DAY), end: new Date(Date.now() - 4 * DAY + 4 * HOUR) });
      const boundary = await seedOffer(fx, staff.profileId, { sentAt: new Date(Date.now() - 31 * DAY), start: new Date(Date.now() - 30 * DAY), end: new Date(Date.now() - 30 * DAY + 4 * HOUR) });

      const current = await http().get('/rest/v1/offers/mine').query({ limit: 50 }).set(auth(staff.token));
      expect(current.status).toBe(200);
      expect(new Set(current.body.data.map((o: { id: string }) => o.id))).toEqual(new Set([oldUpcoming, oldRunning, recentEnded]));
      const explicitCurrent = await http().get('/rest/v1/offers/mine').query({ scope: 'current' }).set(auth(staff.token));
      expect(explicitCurrent.body.data.map((o: { id: string }) => o.id)).toEqual(current.body.data.map((o: { id: string }) => o.id));
      const all = await http().get('/rest/v1/offers/mine').query({ scope: 'all', limit: 50 }).set(auth(staff.token));
      expect(new Set(all.body.data.map((o: { id: string }) => o.id))).toEqual(new Set([oldEnded, oldUpcoming, oldRunning, recentEnded, boundary]));
    });

    it('a malformed cursor is 400 (never ignored), and page>1 cannot be combined with a cursor', async () => {
      const fx = await seedWorkspace('c1-badcursor');
      const staff = await staffOf(fx, 'c1bad');
      const start = new Date(Date.now() + DAY);
      const offerId = await seedOffer(fx, staff.profileId, { sentAt: new Date(), start, end: new Date(start.getTime() + HOUR) });
      const good = cursorOf({ v: 1, t: '2026-01-01T00:00:00.000000Z', i: offerId });
      expect((await http().get('/rest/v1/offers/mine').query({ cursor: good }).set(auth(staff.token))).status).toBe(200);
      const bad = [
        'not a cursor',
        '%%%%',
        'x'.repeat(161),
        Buffer.from('not json').toString('base64url'),
        cursorOf([1, 2, 3]),
        cursorOf({ v: 2, t: '2026-01-01T00:00:00.000000Z', i: offerId }),
        cursorOf({ v: 1, t: '2026-01-01T00:00:00.000Z', i: offerId }),
        cursorOf({ v: 1, t: '2026-02-30T00:00:00.000000Z', i: offerId }),
        cursorOf({ v: 1, t: '2026-01-01T00:00:00.000000+01:00', i: offerId }),
        cursorOf({ v: 1, t: '2026-01-01T00:00:00.000000Z', i: 'not-a-uuid' }),
        cursorOf({ v: 1, t: '2026-01-01T00:00:00.000000Z', i: offerId, organisationId: fx.org.id }),
        cursorOf({ v: 1, t: 1767225600000, i: offerId }),
        `${good}A`,
      ];
      for (const cursor of bad) {
        const res = await http().get('/rest/v1/offers/mine').query({ cursor }).set(auth(staff.token));
        expect({ cursor, status: res.status }).toEqual({ cursor, status: 400 });
      }
      expect((await http().get('/rest/v1/offers/mine').query({ cursor: good, page: 2 }).set(auth(staff.token))).status).toBe(400);
      expect((await http().get('/rest/v1/offers/mine').query({ cursor: good, page: 1 }).set(auth(staff.token))).status).toBe(200);
    });

    it("another tenant's cursor is only an ordering bound: it never yields that tenant's rows", async () => {
      const a = await seedWorkspace('c1-tenant-a');
      const b = await seedWorkspace('c1-tenant-b');
      const staffA = await staffOf(a, 'c1ta');
      const staffB = await staffOf(b, 'c1tb');
      const start = new Date(Date.now() + DAY);
      const aIds: string[] = [];
      for (let i = 0; i < 3; i++) aIds.push(await seedOffer(a, staffA.profileId, { sentAt: new Date(Date.now() - i * HOUR), start, end: new Date(start.getTime() + HOUR) }));
      const bIds: string[] = [];
      for (let i = 0; i < 3; i++) bIds.push(await seedOffer(b, staffB.profileId, { sentAt: new Date(Date.now() - i * HOUR), start, end: new Date(start.getTime() + HOUR) }));
      // A real cursor issued to A, replayed by B (and a forged one pointing at A's id far in the future).
      const pageA = await http().get('/rest/v1/offers/mine').query({ scope: 'all', limit: 1 }).set(auth(staffA.token));
      const forged = cursorOf({ v: 1, t: '2999-01-01T00:00:00.000000Z', i: aIds[0] });
      for (const cursor of [pageA.body.nextCursor as string, forged]) {
        const res = await http().get('/rest/v1/offers/mine').query({ scope: 'all', cursor }).set(auth(staffB.token));
        expect(res.status).toBe(200);
        const seen: string[] = res.body.data.map((o: { id: string }) => o.id);
        expect(seen.filter((id) => aIds.includes(id))).toEqual([]);
        expect(seen.every((id) => bIds.includes(id))).toBe(true);
      }
    });
  });

  // ------------------------------------------------------------------------------------------- /attendance/me/history

  describe('GET /attendance/me/history', () => {
    it('LEGACY: no limit/cursor keeps the bare array of up to 500 rows; limit opts into { data, nextCursor }', async () => {
      const fx = await seedWorkspace('c1-legacy-history');
      const staff = await staffOf(fx, 'c1hist');
      const ids: string[] = [];
      for (let i = 0; i < 55; i++) ids.push(await seedAttendance(fx, staff.profileId, new Date(Date.now() - (i + 2) * DAY)));
      const legacy = await http().get('/rest/v1/attendance/me/history').set(auth(staff.token));
      expect(legacy.status).toBe(200);
      expect(Array.isArray(legacy.body)).toBe(true);
      expect(legacy.body).toHaveLength(55);
      expect(legacy.body.map((r: { id: string }) => r.id)).toEqual(await expectedOrder('attendance', 'clock_in_at', ids));
      const paged = await http().get('/rest/v1/attendance/me/history').query({ limit: 10 }).set(auth(staff.token));
      expect(paged.status).toBe(200);
      expect(Object.keys(paged.body).sort()).toEqual(['data', 'nextCursor']);
      expect(paged.body.data).toHaveLength(10);
      expect((await http().get('/rest/v1/attendance/me/history').query({ cursor: 'garbage!' }).set(auth(staff.token))).status).toBe(400);
      expect((await http().get('/rest/v1/attendance/me/history').query({ scope: 'all' }).set(auth(staff.token))).status).toBe(400);
    });

    it('a cursor walk returns every row once in clock_in_at DESC, id DESC order across ties', async () => {
      const fx = await seedWorkspace('c1-walk-history');
      const staff = await staffOf(fx, 'c1histwalk');
      const ids: string[] = [];
      for (const t of ['2026-03-01T08:00:00.654321Z', '2026-02-01T08:00:00.654321Z']) {
        for (let i = 0; i < 5; i++) ids.push(await seedAttendance(fx, staff.profileId, t));
      }
      const { ids: walked } = await walk('/rest/v1/attendance/me/history', staff.token, { limit: 3 });
      expect(walked).toEqual(await expectedOrder('attendance', 'clock_in_at', ids));
    });
  });

  // ------------------------------------------------------------------------------------- /shifts/sent, /shifts/requests

  /** `count` Venue-Manager requests at the fixture venue, all created at the SAME instant (`createdAt`). */
  async function seedRequests(fx: Fixture, vmUserId: string, count: number, createdAt: string, status = 'pending_manager_approval'): Promise<string[]> {
    const rows = await sql<{ id: string }>(
      `INSERT INTO core.shift (organisation_id, venue_id, job_role_id, starts_at, ends_at, required_count, pay_rate_pence, created_by, workspace_id, status, requested_by, created_at)
       SELECT $1, $2, $3, now() + (g || ' days')::interval, now() + (g || ' days')::interval + interval '4 hours', 1, 1500, $4, $5, $7, $6, $8::timestamptz
         FROM generate_series(1, $9::int) g RETURNING id`,
      [fx.org.id, fx.venueId, fx.jobRoleId, fx.manager.userId, fx.manager.workspaceId, vmUserId, status, createdAt, count],
    );
    return rows.map((r) => r.id);
  }

  async function venueManagerOf(fx: Fixture) {
    const vm = await factory.createVenueManager(fx.org, { owner: fx.manager, venueIds: [fx.venueId] });
    return { ...vm, token: await factory.login(vm) };
  }

  describe('GET /shifts/sent', () => {
    it('cursor walk = the offset pages, every request once in created_at DESC, id DESC; total/view/counts unchanged on every page', async () => {
      const fx = await seedWorkspace('c1-sent');
      const vm = await venueManagerOf(fx);
      const ids = [
        ...(await seedRequests(fx, vm.userId, 4, '2026-04-01T10:00:00.111111Z')),
        ...(await seedRequests(fx, vm.userId, 4, '2026-04-01T10:00:00.111112Z')),
        ...(await seedRequests(fx, vm.userId, 3, '2026-03-01T10:00:00.000000Z')),
      ];
      const first = await http().get('/rest/v1/shifts/sent').query({ limit: 3 }).set(auth(vm.token));
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({ total: 11, view: 'all', counts: expect.objectContaining({ all: 11, submitted: 11 }), nextCursor: expect.any(String) });
      const expected = await expectedOrder('shift', 'created_at', ids);
      const { ids: walked, last } = await walk('/rest/v1/shifts/sent', vm.token, { limit: 3 });
      expect(walked).toEqual(expected);
      expect(last).toMatchObject({ total: 11, view: 'all', counts: first.body.counts, nextCursor: null });
      for (const row of last.data) expect(row).not.toHaveProperty('keyset_ts');
      // Offset paging still works and agrees with the cursor order now that the order is total.
      const offset: string[] = [];
      for (let page = 1; page <= 4; page++) {
        const res = await http().get('/rest/v1/shifts/sent').query({ limit: 3, page }).set(auth(vm.token));
        offset.push(...res.body.data.map((r: { id: string }) => r.id));
      }
      expect(offset).toEqual(expected);
      expect((await http().get('/rest/v1/shifts/sent').query({ cursor: 'AAAA' }).set(auth(vm.token))).status).toBe(400);
    });
  });

  describe('GET /shifts/requests', () => {
    it('adds the id tie-breaker: offset pages over identical created_at are disjoint and deterministic; cursor walk matches; total unchanged', async () => {
      const fx = await seedWorkspace('c1-requests');
      const vm = await venueManagerOf(fx);
      const ids = await seedRequests(fx, vm.userId, 9, '2026-05-05T05:05:05.050505Z');
      const expected = await expectedOrder('shift', 'created_at', ids);
      const offset: string[] = [];
      for (let page = 1; page <= 3; page++) {
        const res = await http().get('/rest/v1/shifts/requests').query({ limit: 4, page }).set(auth(fx.managerToken));
        expect(res.status).toBe(200);
        expect(res.body.total).toBe(9);
        offset.push(...res.body.data.map((r: { id: string }) => r.id));
      }
      expect(offset).toEqual(expected);
      const { ids: walked, last } = await walk('/rest/v1/shifts/requests', fx.managerToken, { limit: 4 });
      expect(walked).toEqual(expected);
      expect(last.total).toBe(9);
      for (const row of last.data) expect(row).not.toHaveProperty('keysetTs');
    });
  });

  // ------------------------------------------------------------------------------------------------- default limits

  it('offset pages walked by fetchAllPages (/shifts, /offers, /attendance) break sort ties by id: every row exactly once', async () => {
    const fx = await seedWorkspace('c1-ties');
    const staff = await staffOf(fx, 'c1-ties');
    const tie = '2027-03-03T03:03:03.030303Z';
    const shiftIds: string[] = [];
    for (let i = 0; i < 7; i++) {
      const [s] = await sql<{ id: string }>(
        `INSERT INTO core.shift (organisation_id, venue_id, job_role_id, starts_at, ends_at, required_count, pay_rate_pence, created_by, workspace_id, status)
         VALUES ($1, $2, $3, $4::timestamptz, $4::timestamptz + interval '4 hours', 1, 1500, $5, $6, 'offered') RETURNING id`,
        [fx.org.id, fx.venueId, fx.jobRoleId, tie, fx.manager.userId, fx.manager.workspaceId],
      );
      shiftIds.push(s!.id);
    }
    const offerIds: string[] = [];
    const attendanceIds: string[] = [];
    for (let i = 0; i < 7; i++) {
      const start = new Date(Date.parse('2027-04-01T09:00:00Z') + i * DAY);
      offerIds.push(await seedOffer(fx, staff.profileId, { sentAt: tie, start, end: new Date(start.getTime() + 4 * HOUR) }));
      attendanceIds.push(await seedAttendance(fx, staff.profileId, tie));
    }
    // Walks limit=3 offset pages to the end and keeps only the 7 tied rows of interest (other rows only shift them).
    const pages = async (path: string, keep: string[]) => {
      const ids: string[] = [];
      for (let page = 1; page <= 20; page++) {
        const res = await http().get(path).query({ limit: 3, page }).set(auth(fx.managerToken));
        expect(res.status).toBe(200);
        ids.push(...res.body.data.map((r: { id: string }) => r.id).filter((id: string) => keep.includes(id)));
        if (page * 3 >= res.body.total) break;
      }
      return ids;
    };
    const idOrder = async (table: string, direction: 'ASC' | 'DESC', ids: string[]) =>
      (await sql<{ id: string }>(`SELECT id FROM core.${table} WHERE id = ANY($1::uuid[]) ORDER BY id ${direction}`, [ids])).map((r) => r.id);

    // Default sorts: /shifts startsAt ASC, /offers sentAt DESC, /attendance clockInAt DESC; the 7 seeded rows tie on it.
    expect(await pages('/rest/v1/shifts', shiftIds)).toEqual(await idOrder('shift', 'ASC', shiftIds));
    expect(await pages('/rest/v1/offers', offerIds)).toEqual(await idOrder('job_offer', 'DESC', offerIds));
    expect(await pages('/rest/v1/attendance', attendanceIds)).toEqual(await idOrder('attendance', 'DESC', attendanceIds));
  });

  it('default page size is 50 and the maximum is 200 on an ordinary list endpoint', async () => {
    const fx = await seedWorkspace('c1-default');
    const vm = await venueManagerOf(fx);
    await seedRequests(fx, vm.userId, 55, '2026-06-06T06:06:06.060606Z');
    const res = await http().get('/rest/v1/shifts/requests').set(auth(fx.managerToken));
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(55);
    expect(res.body.data).toHaveLength(50);
    expect((await http().get('/rest/v1/shifts/requests').query({ limit: 200 }).set(auth(fx.managerToken))).body.data).toHaveLength(55);
    expect((await http().get('/rest/v1/shifts/requests').query({ limit: 201 }).set(auth(fx.managerToken))).status).toBe(400);
    // An endpoint without cursor paging rejects `cursor` instead of silently serving page one forever.
    expect((await http().get('/rest/v1/shifts').query({ cursor: 'AAAA' }).set(auth(fx.managerToken))).status).toBe(400);
  });

  // ------------------------------------------------------------------------------------------------- pipeline LATERAL

  it('pipeline: only an OFFER audit row marks a card as cancelled by the Internal Manager; a non-offer row with the same entity id and action does not', async () => {
    const fx = await seedWorkspace('c1-pipeline');
    const vm = await venueManagerOf(fx);
    const [shiftId] = await seedRequests(fx, vm.userId, 1, new Date().toISOString(), 'offered');
    const staff = await staffOf(fx, 'c1pipe');
    const [{ id: assignmentId }] = await sql<{ id: string }>(
      `INSERT INTO core.shift_assignment (organisation_id, shift_id, staff_profile_id, status, pay_rate_snapshot_pence, period, workspace_id)
       SELECT organisation_id, id, $2, 'withdrawn', 1500, tstzrange(starts_at, ends_at, '[)'), workspace_id FROM core.shift WHERE id = $1 RETURNING id`,
      [shiftId, staff.profileId],
    );
    const [{ id: offerId }] = await sql<{ id: string }>(
      `INSERT INTO core.job_offer (organisation_id, shift_assignment_id, staff_profile_id, status, sent_at, expires_at, estimated_pay_pence, created_by, workspace_id)
       VALUES ($1, $2, $3, 'withdrawn', now(), now() + interval '1 day', 6000, $4, $5) RETURNING id`,
      [fx.org.id, assignmentId, staff.profileId, fx.manager.userId, fx.manager.workspaceId],
    );
    const audit = (entityType: string, reason: string) =>
      sql(
        `INSERT INTO core.audit_log (organisation_id, action, entity_type, entity_id, metadata) VALUES ($1, 'offer.withdrawn', $2, $3, $4::jsonb)`,
        [fx.org.id, entityType, offerId, JSON.stringify({ source: 'manager_pipeline_cancellation', reason })],
      );
    const card = async () => {
      const res = await http().get(`/rest/v1/shifts/${shiftId}/pipeline`).set(auth(fx.managerToken));
      expect(res.status).toBe(200);
      return res.body.staff.find((r: { offerId: string }) => r.offerId === offerId);
    };
    await audit('shift', 'not an offer row');
    expect(await card()).toMatchObject({ withdrawnReason: null, cancelledAt: null, terminalSource: 'Offer withdrawn' });
    await audit('offer', 'real cancellation');
    expect(await card()).toMatchObject({ withdrawnReason: 'real cancellation', terminalSource: 'Cancelled by Internal Manager' });
  });
});
