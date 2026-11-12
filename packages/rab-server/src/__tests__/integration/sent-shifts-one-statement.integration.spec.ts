import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource, EntityManager } from 'typeorm';

import { AppModule } from '../../app.module';
import { Organisation } from '../../modules/identity/entities';
import { Venue } from '../../modules/venue/entities/venue.entity';
import { SentShiftView } from '../../modules/scheduling/dto/list-sent-shifts.dto';
import { SchedulingService } from '../../modules/scheduling/services/scheduling.service';
import { SENT_SHIFT_ROWS_SQL, SENT_SHIFT_VIEW_SQL, sentShiftsPageAndCountsSql } from '../../modules/scheduling/services/sent-shifts-sql';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { decodeOptionalKeysetCursor, keysetBeforeSql, keysetPage } from '../../engine/dto/keyset-cursor';
import { ResourceScopeService } from '../../engine/core-modules/resource-scope/resource-scope.service';
import { AuthContext } from '../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * XP-05 (Phase X Part 2, X4): `GET /shifts/sent` now runs ONE statement for the page rows and the tab counts
 * (`sentShiftsPageAndCountsSql`) instead of running the whole classified CTE twice. Row-set equivalence against the two
 * statements it replaced, rebuilt here verbatim from the same fragments (SENT_SHIFT_ROWS_SQL + SENT_SHIFT_VIEW_SQL), as
 * the Venue Manager under the real runtime login, tenant context and RLS:
 *  - every tab view, page sizes 1 / 4 / 50, every offset page AND every keyset (cursor) page to the end;
 *  - every seeded id (in scope, another venue, another requester, a manager-created shift, an unknown id);
 *  - an empty result (a venue manager with no requests) still returns the tab counts;
 *  - another venue manager's scope.
 * Then through the service and HTTP: one classified statement per call (was two), totals/counts/ids as the legacy pair.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(300_000);

const VIEWS: SentShiftView[] = ['all', 'pending', 'accepted', 'confirmed', 'declined', 'expired'];

type Row = Record<string, unknown>;

describeIfDb('XP-05 /shifts/sent: one statement for rows + tab counts, row-set equivalent to the two it replaced (integration)', () => {
  let app: INestApplication;
  let adminDataSource: DataSource;
  let tenantContext: TenantContextService;
  let factory: TestIdentityFactory;

  interface Fixture {
    org: Organisation;
    manager: TestIdentity;
    venueA: string;
    venueB: string;
    jobRoleId: string;
    vm: TestIdentity & { token: string };
    vm2: TestIdentity & { token: string };
    idle: TestIdentity & { token: string };
    staff: string[];
    ids: string[];
  }
  let fx: Fixture;

  const sql = <T = Row>(text: string, params: unknown[] = []) => adminDataSource.query(text, params) as Promise<T[]>;
  const ctxOf = (who: TestIdentity): AuthContext => ({ organisationId: who.organisationId, workspaceId: who.workspaceId, userId: who.userId, role: who.roleKey });

  let day = 0;
  /** One request by `requestedBy` at `venueId` with the given offers (one seat and one offer per recipient). */
  async function request_(o: {
    requestedBy: string | null; venueId: string; status: string; required?: number; createdAt?: string; past?: boolean;
    offers?: Array<{ staff: number; offer: string; seat: string; sentAt?: string; rejection?: string }>;
  }): Promise<string> {
    const d = ++day;
    const [s] = await sql<{ id: string }>(
      `INSERT INTO core.shift (organisation_id, venue_id, job_role_id, starts_at, ends_at, required_count, pay_rate_pence, created_by, workspace_id, status, requested_by, created_at)
       VALUES ($1, $2, $3, now() + make_interval(days => $4::int), now() + make_interval(days => $4::int) + interval '4 hours', $5, 1500, $6, $7, $8, $9, $10::timestamptz)
       RETURNING id`,
      [fx.org.id, o.venueId, fx.jobRoleId, o.past ? -40 - d : d, o.required ?? 2, o.requestedBy ?? fx.manager.userId, fx.manager.workspaceId, o.status, o.requestedBy,
        o.createdAt ?? new Date(Date.now() - d * 60_000).toISOString()],
    );
    for (const off of o.offers ?? []) {
      const [a] = await sql<{ id: string }>(
        `INSERT INTO core.shift_assignment (organisation_id, shift_id, staff_profile_id, status, pay_rate_snapshot_pence, period, workspace_id)
         SELECT $1, s.id, $2, $3, 1500, tstzrange(s.starts_at, s.ends_at, '[)'), $4 FROM core.shift s WHERE s.id = $5 RETURNING id`,
        [fx.org.id, fx.staff[off.staff], off.seat, fx.manager.workspaceId, s!.id],
      );
      const seat = a!.id;
      await sql(
        `INSERT INTO core.job_offer (organisation_id, shift_assignment_id, staff_profile_id, status, sent_at, expires_at, estimated_pay_pence, created_by, workspace_id, rejection_reason)
         VALUES ($1, $2, $3, $4, $5::timestamptz, $5::timestamptz + interval '1 day', 6000, $6, $7, $8)`,
        [fx.org.id, seat, fx.staff[off.staff], off.offer, off.sentAt ?? new Date(Date.now() - d * 60_000).toISOString(), fx.manager.userId, fx.manager.workspaceId, off.rejection ?? null],
      );
    }
    return s!.id;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    tenantContext = moduleRef.get(TenantContextService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = new TestIdentityFactory({ app, dataSource: moduleRef.get(DataSource), adminDataSource, tenantContext, passwordHashing: moduleRef.get(PasswordHashingService) });

    const org = await factory.createOrganisation('xp05-sent');
    const manager = await factory.createInternalManager(org, { permissions: 'production' });
    const venue = (name: string) => tenantContext.runInTenantContext(
      { organisationId: org.id, workspaceId: manager.workspaceId, userId: manager.userId, role: '' },
      (m) => m.save(Venue, { organisationId: org.id, name, workspaceId: manager.workspaceId!, createdBy: manager.userId }),
    );
    const venueA = (await venue('XP05 Venue A')).id;
    const venueB = (await venue('XP05 Venue B')).id;
    const [role] = await sql<{ id: string }>(
      `INSERT INTO core.job_role (organisation_id, name, default_rate_pence, created_by, workspace_id) VALUES ($1, $2, 1500, $3, $4) RETURNING id`,
      [org.id, `Role-${randomUUID().slice(0, 8)}`, manager.userId, manager.workspaceId],
    );
    const withToken = async (who: TestIdentity) => ({ ...who, token: await factory.login(who) });
    const vm = await withToken(await factory.createVenueManager(org, { owner: manager, venueIds: [venueA] }));
    const vm2 = await withToken(await factory.createVenueManager(org, { owner: manager, venueIds: [venueA, venueB] }));
    const idle = await withToken(await factory.createVenueManager(org, { owner: manager, venueIds: [venueA] }));
    const staff: string[] = [];
    for (let i = 0; i < 6; i++) staff.push((await factory.createStaff(org, { owner: manager, label: `xp05-${i}` })).profileId!);
    fx = { org, manager, venueA, venueB, jobRoleId: role!.id, vm, vm2, idle, staff, ids: [] };

    const V = fx.vm.userId;
    const tie = '2026-06-01T10:00:00.123456Z';
    const ids = fx.ids;
    // Every classification branch of SENT_SHIFT_ROWS_SQL / SENT_SHIFT_VIEW_SQL, plus out-of-scope rows.
    ids.push(await request_({ requestedBy: V, venueId: venueA, status: 'pending_manager_approval' }));
    ids.push(await request_({ requestedBy: V, venueId: venueA, status: 'pending_manager_approval', createdAt: tie }));
    ids.push(await request_({ requestedBy: V, venueId: venueA, status: 'pending_manager_approval', createdAt: tie }));
    ids.push(await request_({ requestedBy: V, venueId: venueA, status: 'offered', createdAt: tie, offers: [{ staff: 0, offer: 'pending', seat: 'offered' }, { staff: 1, offer: 'pending', seat: 'offered' }] }));
    ids.push(await request_({ requestedBy: V, venueId: venueA, status: 'offered', offers: [{ staff: 0, offer: 'staff_accepted', seat: 'staff_accepted' }, { staff: 2, offer: 'declined', seat: 'declined' }] }));
    ids.push(await request_({ requestedBy: V, venueId: venueA, status: 'confirmed', required: 2, offers: [{ staff: 1, offer: 'manager_confirmed', seat: 'confirmed' }, { staff: 3, offer: 'manager_confirmed', seat: 'confirmed' }] }));
    ids.push(await request_({ requestedBy: V, venueId: venueA, status: 'partially_filled', required: 3, offers: [{ staff: 2, offer: 'manager_confirmed', seat: 'confirmed' }, { staff: 4, offer: 'pending', seat: 'offered' }] }));
    ids.push(await request_({ requestedBy: V, venueId: venueA, status: 'declined' }));
    ids.push(await request_({ requestedBy: V, venueId: venueA, status: 'cancelled', offers: [{ staff: 5, offer: 'withdrawn', seat: 'cancelled' }] }));
    ids.push(await request_({ requestedBy: V, venueId: venueA, status: 'completed', past: true, offers: [{ staff: 0, offer: 'manager_confirmed', seat: 'completed' }, { staff: 1, offer: 'manager_confirmed', seat: 'no_show' }] }));
    // Expired: past the action window (non-terminal), and every latest offer expired.
    ids.push(await request_({ requestedBy: V, venueId: venueA, status: 'offered', past: true, offers: [{ staff: 3, offer: 'pending', seat: 'offered' }] }));
    ids.push(await request_({ requestedBy: V, venueId: venueA, status: 'offered', offers: [{ staff: 4, offer: 'expired', seat: 'withdrawn' }, { staff: 5, offer: 'expired', seat: 'withdrawn' }] }));
    // Mixed recipients: one pending, one withdrawn at the confirmation deadline (not_confirmed_in_time). (One offer per seat:
    // job_offer_shift_assignment_id_key, and one seat per recipient and shift.)
    ids.push(await request_({ requestedBy: V, venueId: venueA, status: 'offered', offers: [
      { staff: 2, offer: 'pending', seat: 'offered', sentAt: '2026-05-02T08:00:00Z' },
      { staff: 3, offer: 'manager_rejected', seat: 'rejected', rejection: 'confirmation_deadline_passed' }] }));
    ids.push(await request_({ requestedBy: V, venueId: venueA, status: 'offered', required: 1, offers: [{ staff: 5, offer: 'declined', seat: 'declined' }] }));
    // Out of the venue manager's scope: another venue, another requester, a manager-created shift.
    ids.push(await request_({ requestedBy: V, venueId: venueB, status: 'pending_manager_approval' }));
    ids.push(await request_({ requestedBy: fx.vm2.userId, venueId: venueA, status: 'offered', offers: [{ staff: 4, offer: 'pending', seat: 'offered' }] }));
    ids.push(await request_({ requestedBy: fx.vm2.userId, venueId: venueB, status: 'pending_manager_approval' }));
    ids.push(await request_({ requestedBy: null, venueId: venueA, status: 'offered' }));
  });

  afterAll(async () => {
    await app?.close();
    await adminDataSource?.destroy();
  });

  /** One page through the new single statement and through the legacy pair, in ONE tenant transaction (same snapshot data). */
  async function both(who: TestIdentity, q: { view?: SentShiftView; id?: string; take: number; skip: number; cursor?: string | null }) {
    return tenantContext.runInWorkspaceContext(ctxOf(who), async (m: EntityManager) => {
      const scope = await app.get(ResourceScopeService).resolveTx(m, ctxOf(who));
      expect(scope.kind).toBe('venue');
      const venueIds = scope.kind === 'venue' ? scope.venueIds : [];
      const after = decodeOptionalKeysetCursor(q.cursor ?? undefined);
      const params = [who.organisationId, who.userId, venueIds, q.id ?? null];
      const pageParams: unknown[] = [...params, q.take + 1, q.skip];
      const bound = after ? `WHERE ${keysetBeforeSql('"submittedAt"', 'id', '$7', '$8')}` : '';
      if (after) pageParams.push(after.t, after.i);
      const viewSql = q.id ? 'TRUE' : SENT_SHIFT_VIEW_SQL[q.view ?? 'all'];
      // The two statements XP-05 replaced, verbatim.
      const legacyRows: Row[] = await m.query(
        `${SENT_SHIFT_ROWS_SQL} SELECT * FROM (SELECT *, count(*) OVER () AS view_total FROM classified WHERE ${viewSql}) v ${bound}
          ORDER BY "submittedAt" DESC, id DESC LIMIT $5 OFFSET $6`,
        pageParams,
      );
      const [legacyTabs] = await m.query(
        `${SENT_SHIFT_ROWS_SQL} SELECT ${Object.entries(SENT_SHIFT_VIEW_SQL).map(([k, w]) => `count(*) FILTER (WHERE ${w})::int AS "${k}"`).join(', ')},
          count(*)::int AS submitted FROM classified`,
        params,
      );
      const result: Row[] = await m.query(sentShiftsPageAndCountsSql(viewSql, bound), pageParams);
      return { legacyRows, legacyTabs: legacyTabs as Row, result };
    });
  }

  function expectEquivalent({ legacyRows, legacyTabs, result }: Awaited<ReturnType<typeof both>>) {
    expect(result.length).toBeGreaterThanOrEqual(1);
    for (const r of result) expect(r.tab_counts).toEqual(legacyTabs);
    const rows = result.filter((r) => r.id !== null).map(({ tab_counts: _t, ...r }) => r);
    if (!legacyRows.length) {
      expect(result).toHaveLength(1);
      expect(Object.entries(result[0]!).filter(([k, v]) => k !== 'tab_counts' && v !== null)).toEqual([]);
    }
    expect(rows).toEqual(legacyRows);
    return rows;
  }

  it('every view, page size and offset page: identical rows, order, view_total and tab counts', async () => {
    let compared = 0;
    for (const view of VIEWS) {
      for (const take of [1, 4, 50]) {
        for (let skip = 0; ; skip += take) {
          const r = await both(fx.vm, { view, take, skip });
          const rows = expectEquivalent(r);
          compared++;
          if (rows.length <= take) break;
        }
      }
    }
    expect(compared).toBeGreaterThan(30);
  });

  it('every keyset (cursor) page to the end, every view: identical pages; the walk covers the whole view once', async () => {
    for (const view of VIEWS) {
      for (const take of [1, 3]) {
        let cursor: string | null = null;
        const walked: string[] = [];
        for (let pageNo = 0; pageNo < 100; pageNo++) {
          const r = await both(fx.vm, { view, take, skip: 0, cursor });
          const rows = expectEquivalent(r);
          const page = keysetPage(rows, take, (row: Row) => ({ t: row.keyset_ts as string, i: row.id as string }));
          walked.push(...page.data.map((row: Row) => row.id as string));
          cursor = page.nextCursor;
          if (!cursor) break;
        }
        const full = expectEquivalent(await both(fx.vm, { view, take: 500, skip: 0 }));
        expect(walked).toEqual(full.map((row) => row.id));
        expect(Number(full[0]?.view_total ?? 0)).toBe(walked.length);
      }
    }
  });

  it('by id: every seeded id (in scope, other venue, other requester, manager-created) and an unknown id', async () => {
    for (const id of [...fx.ids, randomUUID()]) expectEquivalent(await both(fx.vm, { id, take: 50, skip: 0 }));
  });

  it('an empty result still returns the tab counts (one row, page columns all NULL); another venue manager\'s scope is equivalent too', async () => {
    for (const view of VIEWS) {
      const r = await both(fx.idle, { view, take: 50, skip: 0 });
      expectEquivalent(r);
      expect(r.legacyRows).toEqual([]);
      expect(r.result[0]!.tab_counts).toEqual({ all: 0, pending: 0, accepted: 0, confirmed: 0, declined: 0, expired: 0, submitted: 0 });
      expectEquivalent(await both(fx.vm2, { view, take: 2, skip: 0 }));
    }
  });

  it('the seed reaches every tab (so the comparisons above are not vacuous)', async () => {
    const { legacyTabs } = await both(fx.vm, { take: 1, skip: 0 });
    for (const view of VIEWS) expect(Number(legacyTabs[view])).toBeGreaterThan(0);
    expect(legacyTabs.submitted).toBe(14);
  });

  it('service + HTTP: one classified statement per call (was two); total, counts and ids equal the legacy pair', async () => {
    const service = app.get(SchedulingService);
    const spy = jest.spyOn(EntityManager.prototype, 'query');
    try {
      for (const view of VIEWS) {
        spy.mockClear();
        const res = await service.listSentShifts(ctxOf(fx.vm), { view, limit: 4 } as never);
        const classified = spy.mock.calls.filter(([text]) => typeof text === 'string' && text.includes('classified AS ('));
        expect(classified).toHaveLength(1);
        const legacy = await both(fx.vm, { view, take: 4, skip: 0 });
        expect(res.counts).toEqual(legacy.legacyTabs);
        expect(res.total).toBe(legacy.legacyRows[0] ? Number(legacy.legacyRows[0].view_total) : 0);
        expect(res.data.map((d: { id: string }) => d.id)).toEqual(legacy.legacyRows.slice(0, 4).map((row) => row.id));
      }
    } finally {
      spy.mockRestore();
    }
    const http = (path: string, token: string) => request(app.getHttpServer()).get(path).set({ Authorization: `Bearer ${token}` });
    const empty = await http('/rest/v1/shifts/sent', fx.idle.token);
    expect(empty.status).toBe(200);
    expect(empty.body).toMatchObject({ data: [], total: 0, view: 'all', nextCursor: null, counts: { all: 0, submitted: 0 } });
    // Out of scope / unknown stays 404 (one statement now decides it).
    expect((await http(`/rest/v1/shifts/sent/${fx.ids[14]}`, fx.vm.token)).status).toBe(404);
    expect((await http(`/rest/v1/shifts/sent/${randomUUID()}`, fx.vm.token)).status).toBe(404);
    expect((await http(`/rest/v1/shifts/sent/${fx.ids[0]}`, fx.vm.token)).status).toBe(200);
  });
});
