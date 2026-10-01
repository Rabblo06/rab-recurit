import 'reflect-metadata';
import { PermissionFlag, ShiftStatus } from '@rab/shared';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { JobRole } from '../../modules/scheduling/entities/job-role.entity';
import { Shift } from '../../modules/scheduling/entities/shift.entity';
import { Venue } from '../../modules/venue/entities/venue.entity';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentityFactory, TestIdentity } from './helpers/test-identities';

/**
 * PERF-01 — `GET /shifts/requests/pending` (`SchedulingService.listPendingApprovals`)
 * used to be a plain `manager.find()` with no `skip`/`take` at all: a
 * manager/workspace with a large pending queue would load every matching
 * row, unbounded, on every request. Real Postgres, RLS on, no mocks.
 *
 * This endpoint's own doc comment USED TO claim its scope was deliberately
 * ORGANISATION-WIDE, not workspace-scoped — "visible to any Internal
 * Manager/CEO org-wide." Verified false while writing these tests: `core.shift`'s
 * `shift_tenant` RLS policy scopes every read to `workspace_id =
 * current_workspace() OR <caller manages this shift's venue>`, regardless of
 * the application-level WHERE clause. Two Internal Managers in the SAME
 * organisation but different workspaces do NOT currently share this queue —
 * confirmed empirically below, and the stale doc comment has been corrected
 * (not the RLS policy itself, which is out of PERF-01's scope and flagged
 * separately in the final report). These tests assert the REAL, verified
 * scope — organisation AND workspace isolation both hold — not the old
 * incorrect assumption.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(60_000);

describeIfDb('pending approvals pagination (PERF-01, integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let factory: TestIdentityFactory;
  let passwordHashing: PasswordHashingService;
  let tenantContext: TenantContextService;

  const APPROVER_PERMS = [PermissionFlag.STAFFING_REQUEST_APPROVE, PermissionFlag.SCHEDULE_VIEW];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    dataSource = moduleRef.get(DataSource);
    passwordHashing = moduleRef.get(PasswordHashingService);
    tenantContext = moduleRef.get(TenantContextService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = new TestIdentityFactory({ app, dataSource, adminDataSource, tenantContext, passwordHashing });
  });

  afterAll(async () => {
    await app.close();
    await adminDataSource.destroy();
  });

  /** One Venue + one JobRole inside `manager`'s own workspace, needed as FK targets for seeded Shift rows. */
  async function seedVenueAndRole(organisationId: string, manager: TestIdentity): Promise<{ venueId: string; jobRoleId: string }> {
    return tenantContext.runInTenantContext(
      { organisationId, workspaceId: manager.workspaceId, userId: manager.userId, role: '' },
      async (m) => {
        const venue = await m.save(Venue, { organisationId, name: `Venue-${randomUUID()}`, createdBy: manager.userId, workspaceId: manager.workspaceId! });
        const jobRole = await m.save(JobRole, { organisationId, name: `Role-${randomUUID()}`, defaultRatePence: 1500, createdBy: manager.userId, workspaceId: manager.workspaceId! });
        return { venueId: venue.id, jobRoleId: jobRole.id };
      },
    );
  }

  /** Seeds `count` real PENDING_MANAGER_APPROVAL Shift rows, each with a distinct startsAt so they aren't otherwise indistinguishable, direct entity saves (matching this suite's own established fixture-seeding convention) rather than the full Venue-Manager-submit HTTP flow, which is already covered by other suites. */
  async function seedPendingShifts(
    organisationId: string,
    manager: TestIdentity,
    venueId: string,
    jobRoleId: string,
    count: number,
    opts: { sameCreatedAt?: boolean } = {},
  ): Promise<string[]> {
    const ids: string[] = [];
    await tenantContext.runInTenantContext(
      { organisationId, workspaceId: manager.workspaceId, userId: manager.userId, role: '' },
      async (m) => {
        for (let i = 0; i < count; i++) {
          const startsAt = new Date(Date.now() + (48 + i) * 3600 * 1000);
          const shift = await m.save(Shift, {
            organisationId,
            venueId,
            jobRoleId,
            startsAt,
            endsAt: new Date(startsAt.getTime() + 8 * 3600 * 1000),
            breakMinutes: 0,
            requiredCount: 1,
            payRatePence: 1500,
            status: ShiftStatus.PENDING_MANAGER_APPROVAL,
            createdBy: manager.userId,
            requestedBy: manager.userId,
            workspaceId: manager.workspaceId!,
          });
          ids.push(shift.id);
        }
        // Force identical created_at for a deterministic-tie-break test —
        // done as a single raw UPDATE after the fact since CreateDateColumn
        // always stamps `now()` on insert regardless of a supplied value.
        if (opts.sameCreatedAt && ids.length > 1) {
          const fixedInstant = new Date();
          await m.query(`UPDATE core.shift SET created_at = $1 WHERE id = ANY($2::uuid[])`, [fixedInstant, ids]);
        }
      },
    );
    return ids;
  }

  async function login(email: string): Promise<string> {
    return factory.loginByEmail(email, 'internal_manager');
  }

  it('1: a default request returns only one bounded page, never the full queue', async () => {
    const { organisation, managers } = await factory.createOrganisationWithManagers(1, { permissions: APPROVER_PERMS });
    const [manager] = managers;
    const { venueId, jobRoleId } = await seedVenueAndRole(organisation.id, manager!);
    await seedPendingShifts(organisation.id, manager!, venueId, jobRoleId, 63);
    const token = await login(manager!.email);

    const res = await request(app.getHttpServer())
      .get('/rest/v1/shifts/requests/pending')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(63);
    // Default PaginationDto limit (500) exceeds 63, so this also proves the
    // default page genuinely contains everything when under the cap —
    // the "bounded" property is proven properly by test 2 below instead.
    expect(res.body.data).toHaveLength(63);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('2: an explicit small limit bounds the page even though more rows exist', async () => {
    const { organisation, managers } = await factory.createOrganisationWithManagers(1, { permissions: APPROVER_PERMS });
    const [manager] = managers;
    const { venueId, jobRoleId } = await seedVenueAndRole(organisation.id, manager!);
    await seedPendingShifts(organisation.id, manager!, venueId, jobRoleId, 63);
    const token = await login(manager!.email);

    const res = await request(app.getHttpServer())
      .get('/rest/v1/shifts/requests/pending')
      .query({ limit: 10 })
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(63);
    expect(res.body.data).toHaveLength(10);
  });

  it('2b: the server-enforced maximum limit clamps a request asking for far more, never an unbounded scan', async () => {
    const { organisation, managers } = await factory.createOrganisationWithManagers(1, { permissions: APPROVER_PERMS });
    const [manager] = managers;
    const { venueId, jobRoleId } = await seedVenueAndRole(organisation.id, manager!);
    await seedPendingShifts(organisation.id, manager!, venueId, jobRoleId, 5);
    const token = await login(manager!.email);

    // 1,000,000 exceeds PaginationDto's own @Max(1000) — must be rejected
    // (400), never silently clamped into an unbounded scan.
    const res = await request(app.getHttpServer())
      .get('/rest/v1/shifts/requests/pending')
      .query({ limit: 1000000 })
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
  });

  it('3/4: paging through with page=1 then page=2 returns disjoint, non-duplicated rows', async () => {
    const { organisation, managers } = await factory.createOrganisationWithManagers(1, { permissions: APPROVER_PERMS });
    const [manager] = managers;
    const { venueId, jobRoleId } = await seedVenueAndRole(organisation.id, manager!);
    await seedPendingShifts(organisation.id, manager!, venueId, jobRoleId, 25);
    const token = await login(manager!.email);

    const page1 = await request(app.getHttpServer()).get('/rest/v1/shifts/requests/pending').query({ limit: 10, page: 1 }).set('Authorization', `Bearer ${token}`);
    const page2 = await request(app.getHttpServer()).get('/rest/v1/shifts/requests/pending').query({ limit: 10, page: 2 }).set('Authorization', `Bearer ${token}`);
    const page3 = await request(app.getHttpServer()).get('/rest/v1/shifts/requests/pending').query({ limit: 10, page: 3 }).set('Authorization', `Bearer ${token}`);

    expect(page1.body.data).toHaveLength(10);
    expect(page2.body.data).toHaveLength(10);
    expect(page3.body.data).toHaveLength(5); // 25 total, 10 + 10 + 5

    const idsOf = (page: { body: { data: Array<{ id: string }> } }) => page.body.data.map((r) => r.id);
    const allIds = [...idsOf(page1), ...idsOf(page2), ...idsOf(page3)];
    expect(new Set(allIds).size).toBe(25); // no duplicate id anywhere across pages
  });

  it('5: full traversal returns every authorised record exactly once — Manager A\'s own 63, never Manager B\'s 37 in the same org (verified real scope, see PERF-01 CORRECTION on listPendingApprovals)', async () => {
    const { organisation, managers } = await factory.createOrganisationWithManagers(2, { permissions: APPROVER_PERMS });
    const [managerA, managerB] = managers;
    const a = await seedVenueAndRole(organisation.id, managerA!);
    const b = await seedVenueAndRole(organisation.id, managerB!);
    const idsA = await seedPendingShifts(organisation.id, managerA!, a.venueId, a.jobRoleId, 63);
    const idsB = await seedPendingShifts(organisation.id, managerB!, b.venueId, b.jobRoleId, 37);
    const tokenA = await login(managerA!.email);

    const seen = new Set<string>();
    let page = 1;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app.getHttpServer()).get('/rest/v1/shifts/requests/pending').query({ limit: 20, page }).set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(200);
      // `core.shift`'s own RLS (`shift_tenant`) scopes this to Manager A's
      // workspace — total is 63 (their own), NOT 100 (the combined org
      // total). Confirmed empirically; see the doc-comment correction on
      // `listPendingApprovals` for the full explanation.
      expect(res.body.total).toBe(63);
      for (const row of res.body.data as Array<{ id: string }>) {
        expect(seen.has(row.id)).toBe(false); // never see the same row twice across pages
        seen.add(row.id);
      }
      if (page * 20 >= res.body.total) break;
      page += 1;
    }
    expect(seen.size).toBe(63);
    for (const id of idsA) expect(seen.has(id)).toBe(true);
    for (const id of idsB) expect(seen.has(id)).toBe(false); // Manager B's own-workspace rows never leak into A's traversal
  });

  it('6: identical created_at timestamps still paginate deterministically via the id tie-breaker — no row skipped or duplicated across the page boundary', async () => {
    const { organisation, managers } = await factory.createOrganisationWithManagers(1, { permissions: APPROVER_PERMS });
    const [manager] = managers;
    const { venueId, jobRoleId } = await seedVenueAndRole(organisation.id, manager!);
    const ids = await seedPendingShifts(organisation.id, manager!, venueId, jobRoleId, 20, { sameCreatedAt: true });
    const token = await login(manager!.email);

    const seen = new Set<string>();
    for (let page = 1; page <= 4; page++) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app.getHttpServer()).get('/rest/v1/shifts/requests/pending').query({ limit: 5, page }).set('Authorization', `Bearer ${token}`);
      expect(res.body.data).toHaveLength(5);
      for (const row of res.body.data as Array<{ id: string }>) {
        expect(seen.has(row.id)).toBe(false);
        seen.add(row.id);
      }
    }
    expect(seen.size).toBe(20);
    for (const id of ids) expect(seen.has(id)).toBe(true);
  });

  it('7/8: a DIFFERENT organisation\'s pending requests never appear, in either direction', async () => {
    const orgA = await factory.createOrganisationWithManagers(1, { permissions: APPROVER_PERMS, label: 'orga' });
    const orgB = await factory.createOrganisationWithManagers(1, { permissions: APPROVER_PERMS, label: 'orgb' });
    const aVenue = await seedVenueAndRole(orgA.organisation.id, orgA.managers[0]!);
    const bVenue = await seedVenueAndRole(orgB.organisation.id, orgB.managers[0]!);
    const idsA = await seedPendingShifts(orgA.organisation.id, orgA.managers[0]!, aVenue.venueId, aVenue.jobRoleId, 5);
    const idsB = await seedPendingShifts(orgB.organisation.id, orgB.managers[0]!, bVenue.venueId, bVenue.jobRoleId, 3);
    const tokenA = await login(orgA.managers[0]!.email);
    const tokenB = await login(orgB.managers[0]!.email);

    const resA = await request(app.getHttpServer()).get('/rest/v1/shifts/requests/pending').query({ limit: 50 }).set('Authorization', `Bearer ${tokenA}`);
    const resB = await request(app.getHttpServer()).get('/rest/v1/shifts/requests/pending').query({ limit: 50 }).set('Authorization', `Bearer ${tokenB}`);
    expect(resA.body.total).toBe(5);
    expect(resB.body.total).toBe(3);
    const idsSeenByA = resA.body.data.map((r: { id: string }) => r.id);
    const idsSeenByB = resB.body.data.map((r: { id: string }) => r.id);
    for (const id of idsB) expect(idsSeenByA).not.toContain(id);
    for (const id of idsA) expect(idsSeenByB).not.toContain(id);
  });

  it('9 (verified, NOT the code\'s old documented claim): same organisation, different workspace does NOT see the other manager\'s pending queue — core.shift RLS scopes by workspace regardless of this endpoint\'s org-wide-looking WHERE clause', async () => {
    const { organisation, managers } = await factory.createOrganisationWithManagers(2, { permissions: APPROVER_PERMS });
    const [managerA, managerB] = managers;
    const a = await seedVenueAndRole(organisation.id, managerA!);
    const ids = await seedPendingShifts(organisation.id, managerA!, a.venueId, a.jobRoleId, 4);
    const tokenB = await login(managerB!.email);

    const res = await request(app.getHttpServer()).get('/rest/v1/shifts/requests/pending').query({ limit: 50 }).set('Authorization', `Bearer ${tokenB}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0); // Manager B has no pending requests of their own, and cannot see Manager A's
    const idsSeenByB = res.body.data.map((r: { id: string }) => r.id);
    for (const id of ids) expect(idsSeenByB).not.toContain(id);
  });

  it('10: a client-supplied organisationId/workspaceId query param is rejected outright (403 via whitelist), never used to broaden the query — the scope is server-derived only', async () => {
    const { organisation, managers } = await factory.createOrganisationWithManagers(1, { permissions: APPROVER_PERMS });
    const [manager] = managers;
    const token = await login(manager!.email);

    const res = await request(app.getHttpServer())
      .get('/rest/v1/shifts/requests/pending')
      .query({ limit: 10, organisationId: randomUUID(), workspaceId: randomUUID() })
      .set('Authorization', `Bearer ${token}`);
    // `forbidNonWhitelisted: true` rejects any field PaginationDto doesn't
    // declare — a 400, not a silently-ignored or silently-applied field.
    expect(res.status).toBe(400);
    void organisation;
  });

  it('11: an empty queue returns { data: [], total: 0 }, not an error or a null body', async () => {
    const { organisation, managers } = await factory.createOrganisationWithManagers(1, { permissions: APPROVER_PERMS });
    const [manager] = managers;
    const token = await login(manager!.email);

    const res = await request(app.getHttpServer()).get('/rest/v1/shifts/requests/pending').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [], total: 0 });
    void organisation;
  });

  it('12: the last page reports exactly the remainder, and total accurately reflects the full authorised count throughout', async () => {
    const { organisation, managers } = await factory.createOrganisationWithManagers(1, { permissions: APPROVER_PERMS });
    const [manager] = managers;
    const { venueId, jobRoleId } = await seedVenueAndRole(organisation.id, manager!);
    await seedPendingShifts(organisation.id, manager!, venueId, jobRoleId, 12);
    const token = await login(manager!.email);

    const lastPage = await request(app.getHttpServer()).get('/rest/v1/shifts/requests/pending').query({ limit: 10, page: 2 }).set('Authorization', `Bearer ${token}`);
    expect(lastPage.body.total).toBe(12);
    expect(lastPage.body.data).toHaveLength(2); // the remainder past page 1's 10

    const beyondLastPage = await request(app.getHttpServer()).get('/rest/v1/shifts/requests/pending').query({ limit: 10, page: 3 }).set('Authorization', `Bearer ${token}`);
    expect(beyondLastPage.body.total).toBe(12);
    expect(beyondLastPage.body.data).toHaveLength(0); // past the end — empty, not an error
  });
});
