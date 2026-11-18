import 'reflect-metadata';
import { ManagerType, PermissionFlag } from '@rab/shared';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { AuthContext } from '../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { ROLE_DEFS } from '../../modules/manager/services/manager.service';
import { SchedulingService } from '../../modules/scheduling/services/scheduling.service';
import { SearchService } from '../../modules/search/services/search.service';
import { StaffService } from '../../modules/staff/services/staff.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';
import { applyGlobalValidationPipe } from '../../engine/utils/global-validation-pipe';
import { integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';
import { businessTable } from './helpers/hws-fixtures';

/**
 * SF-6 abuse cases: global search returns only rows the caller's own LISTS return. Before SF-6 the owner branches keyed
 * on `workspace_id` alone, so a row in the caller's workspace created by another manager (two owner-scope managers
 * sharing a workspace — nothing DB-enforces one manager per workspace) was found by search although every list hid it;
 * a Venue Manager's staff search ignored their team; and `searchManagers` had no organisation predicate. Real PostgreSQL
 * with RLS on (crewflow_app), real HTTP (and a direct service call for the Venue Manager, whose app cannot reach the
 * web console's search route). The "impostor" rows are a FIXTURE step (created_by rewritten as the owner role), never a
 * product path.
 */
const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;
const MIN = 60_000;

describeIfDb('SF-6: search uses the same scope as the lists (integration)', () => {
  jest.setTimeout(240_000);

  let app: INestApplication;
  let admin: DataSource;
  let factory: TestIdentityFactory;
  let searchService: SearchService;
  let staffService: StaffService;
  let schedulingService: SchedulingService;
  let orgId: string;
  let a: TestIdentity;
  let b: TestIdentity;
  let other: TestIdentity;
  let tokenA: string;
  let tokenB: string;
  const tag = randomUUID().replace(/-/g, '').slice(0, 6);

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const search = (token: string, q: string) => http().get('/rest/v1/search').query({ q, limit: 20 }).set(auth(token));
  const hits = (res: request.Response, type?: string) => {
    expect(res.status).toBe(200);
    return (res.body as Array<{ id: string; name: string; type: string }>).filter((r) => !type || r.type === type);
  };
  const ids = (res: request.Response, type?: string) => hits(res, type).map((r) => r.id);

  async function staff(owner: TestIdentity, first: string, last: string): Promise<TestIdentity> {
    const s = await factory.createStaff({ id: owner.organisationId }, { owner, label: 'sf6s' });
    await admin.query(`UPDATE core."user" SET first_name = $2, last_name = $3 WHERE id = $1`, [s.userId, first, last]);
    // Offer-eligible (an offer is only sent to an active employee), as the other offer suites set it.
    await admin.query(`UPDATE ${businessTable(owner.workspaceId!, 'staff_profile')} SET employment_status = 'active' WHERE id = $1`, [s.profileId]);
    return s;
  }

  /** The impostor shape: the row stays in `owner`'s workspace, but its creator becomes `creator`. */
  async function reassignCreator(owner: TestIdentity, table: string, id: string, creator: TestIdentity): Promise<void> {
    await admin.query(`UPDATE ${businessTable(owner.workspaceId!, table)} SET created_by = $2 WHERE id = $1`, [id, creator.userId]);
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = applyGlobalValidationPipe(moduleRef.createNestApplication());
    await app.init();
    admin = createAdminDataSource();
    await admin.initialize();
    searchService = moduleRef.get(SearchService);
    staffService = moduleRef.get(StaffService);
    schedulingService = moduleRef.get(SchedulingService);
    factory = new TestIdentityFactory({
      app, dataSource: moduleRef.get(DataSource), adminDataSource: admin,
      tenantContext: moduleRef.get(TenantContextService), passwordHashing: moduleRef.get(PasswordHashingService),
    });
    // Production Internal Manager permissions plus MANAGER_MANAGE (the manager search needs it).
    const permissions = [...ROLE_DEFS[ManagerType.INTERNAL]!.permissions, PermissionFlag.MANAGER_MANAGE];
    const seeded = await factory.createOrganisationWithManagers(2, { permissions, workspace: true, label: 'sf6' });
    orgId = seeded.organisation.id;
    [a, b] = seeded.managers as [TestIdentity, TestIdentity];
    other = (await factory.createOrganisationWithManagers(1, { permissions, workspace: true, label: 'sf6-other' })).managers[0]!;
    [tokenA, tokenB] = [await factory.login(a), await factory.login(b)];
  });

  afterAll(async () => {
    await app?.close();
    await admin?.destroy();
  });

  it('staff: a staff row in the caller\'s workspace created by another manager is hidden from search, as it is from the list', async () => {
    const s = await staff(b, `Imp${tag}`, `Staffer${tag}`);
    // Control: B's own staff member is found by search and listed.
    expect(ids(await search(tokenB, `imp${tag}`), 'Staff')).toEqual([s.profileId]);

    await reassignCreator(b, 'staff_profile', s.profileId!, a);

    const list = await http().get('/rest/v1/staff').query({ q: `Imp${tag}` }).set(auth(tokenB));
    expect(list.status).toBe(200);
    expect(list.body.data.map((r: { id: string }) => r.id)).not.toContain(s.profileId);
    expect(ids(await search(tokenB, `imp${tag}`), 'Staff')).toEqual([]); // SF-6: was [s.profileId]
    expect(ids(await search(tokenA, `imp${tag}`), 'Staff')).toEqual([]); // A created it, but it is not in A's workspace
  });

  it('venues, shifts and offers: rows in the caller\'s workspace created by another manager are hidden from search, as they are from the lists', async () => {
    const venueName = `Sfsix Venue ${tag}`;
    const venue = await http().post('/rest/v1/venues').set(auth(tokenB)).send({ name: venueName, type: 'hotel' });
    expect(venue.status).toBe(201);
    const role = await http().post('/rest/v1/job-roles').set(auth(tokenB)).send({ name: `Sf6 Role ${tag}`, defaultRatePence: 1500 });
    expect(role.status).toBe(201);
    const startsAt = new Date(Date.now() + 3 * 60 * MIN);
    const shift = await http().post('/rest/v1/shifts').set(auth(tokenB)).send({
      venueId: venue.body.id, jobRoleId: role.body.id, startsAt: startsAt.toISOString(),
      endsAt: new Date(startsAt.getTime() + 6 * 60 * MIN).toISOString(), requiredCount: 1,
    });
    expect(shift.status).toBe(201);
    expect((await http().post(`/rest/v1/shifts/${shift.body.id}/publish`).set(auth(tokenB))).status).toBe(201);
    const worker = await staff(b, `Offeree${tag}`, 'Person');
    const offer = await http().post(`/rest/v1/shifts/${shift.body.id}/offers`).set(auth(tokenB)).send({ staffProfileId: worker.profileId });
    expect({ status: offer.status, body: offer.body }).toMatchObject({ status: 201 });

    // Control: B finds all three by the venue name.
    const before = await search(tokenB, `sfsix venue ${tag}`);
    expect(ids(before, 'Venue')).toEqual([venue.body.id]);
    expect(ids(before, 'Shift')).toEqual([shift.body.id]);
    expect(ids(before, 'Offer')).toEqual([offer.body.id]);

    await reassignCreator(b, 'venue', venue.body.id, a);
    await reassignCreator(b, 'shift', shift.body.id, a);
    await reassignCreator(b, 'job_offer', offer.body.id, a);

    // The lists hide all three from B...
    const listed = async (path: string) => {
      const res = await http().get(path).query({ q: venueName }).set(auth(tokenB));
      expect(res.status).toBe(200);
      return res.body.data.map((r: { id: string }) => r.id);
    };
    expect(await listed('/rest/v1/venues')).not.toContain(venue.body.id);
    expect(await listed('/rest/v1/shifts')).not.toContain(shift.body.id);
    expect(await listed('/rest/v1/offers')).not.toContain(offer.body.id);

    // ...so search must too (SF-6: before the fix all three were still found by workspace_id alone).
    const after = await search(tokenB, `sfsix venue ${tag}`);
    expect(ids(after, 'Venue')).toEqual([]);
    expect(ids(after, 'Shift')).toEqual([]);
    expect(ids(after, 'Offer')).toEqual([]);
    // A created them, but they live in B's workspace: A finds none of them either.
    expect(ids(await search(tokenA, `sfsix venue ${tag}`))).toEqual([]);
  });

  it('Venue Manager staff search returns only their own team (venueDirectory), never other staff in the workspace', async () => {
    const venue = await http().post('/rest/v1/venues').set(auth(tokenB)).send({ name: `Sf6 VM Venue ${tag}`, type: 'hotel' });
    expect(venue.status).toBe(201);
    const vm = await factory.createVenueManager({ id: orgId }, { owner: b, venueIds: [venue.body.id], label: 'sf6-vm' });
    const teamMember = await staff(b, `Crew${tag}`, `Teammate${tag}`);
    const outsider = await staff(b, `Crew${tag}`, `Outsider${tag}`);
    await admin.query(
      `INSERT INTO ${businessTable(b.workspaceId!, 'venue_manager_staff')} (manager_profile_id, staff_profile_id, organisation_id, workspace_id) VALUES ($1, $2, $3, $4)`,
      [vm.profileId, teamMember.profileId, orgId, b.workspaceId],
    );
    const vmCtx: AuthContext = { organisationId: orgId, workspaceId: b.workspaceId, userId: vm.userId, role: '' } as AuthContext;

    // The Venue Manager's own staff lists: their team only.
    const directory = await staffService.venueDirectory(vmCtx, { q: `Crew${tag}` });
    expect(directory.data.map((r: { id: string }) => r.id)).toEqual([teamMember.profileId]);
    const list = await staffService.list(vmCtx, { q: `Crew${tag}` });
    expect(list.data.map((r) => r.id)).toEqual([]);

    const found = await searchService.search(vmCtx, { q: `crew${tag}` });
    const staffIds = found.filter((r) => r.type === 'Staff').map((r) => r.id);
    expect(staffIds).toEqual([teamMember.profileId]);
    expect(staffIds).not.toContain(outsider.profileId); // SF-6: was found (workspace_id alone)
  });

  it("no over-narrowing: an owner-scope manager still finds a Venue Manager's pending-approval request in their workspace, as list() shows it", async () => {
    const venueName = `Sfsix Request ${tag}`;
    const venue = await http().post('/rest/v1/venues').set(auth(tokenB)).send({ name: venueName, type: 'hotel' });
    expect(venue.status).toBe(201);
    const role = await http().post('/rest/v1/job-roles').set(auth(tokenB)).send({ name: `Sf6 Request Role ${tag}`, defaultRatePence: 1500 });
    expect(role.status).toBe(201);
    const vm = await factory.createVenueManager({ id: orgId }, { owner: b, venueIds: [venue.body.id], label: 'sf6-req-vm' });
    const teamMember = await staff(b, `Requested${tag}`, 'Staffer');
    await admin.query(
      `INSERT INTO ${businessTable(b.workspaceId!, 'venue_manager_staff')} (manager_profile_id, staff_profile_id, organisation_id, workspace_id) VALUES ($1, $2, $3, $4)`,
      [vm.profileId, teamMember.profileId, orgId, b.workspaceId],
    );
    const startsAt = new Date(Date.now() + 30 * 24 * 60 * MIN);
    const vmCtx = { organisationId: orgId, workspaceId: b.workspaceId, userId: vm.userId, role: '' } as AuthContext;
    // The real Venue Manager request path: created_by is the Venue Manager, status pending_manager_approval.
    const requested = await schedulingService.submitRequest(vmCtx, {
      venueId: venue.body.id, jobRoleId: role.body.id, startsAt: startsAt.toISOString(),
      endsAt: new Date(startsAt.getTime() + 5 * 60 * MIN).toISOString(), staffRequired: 1, staffProfileIds: [teamMember.profileId!],
    } as never);
    expect(requested.status).toBe('pending_manager_approval');

    const list = await http().get('/rest/v1/shifts').query({ q: venueName }).set(auth(tokenB));
    expect(list.status).toBe(200);
    expect(list.body.data.map((r: { id: string }) => r.id)).toContain(requested.id);
    expect(ids(await search(tokenB, `sfsix request ${tag}`), 'Shift')).toEqual([requested.id]);
    // Another workspace's manager in the same organisation still does not find it (workspace pin).
    expect(ids(await search(tokenA, `sfsix request ${tag}`), 'Shift')).toEqual([]);
  });

  it('managers: search is organisation-pinned like ManagerService.list() — another organisation\'s manager is never found', async () => {
    await admin.query(`UPDATE core."user" SET first_name = $2, last_name = 'Mgr' WHERE id = $1`, [b.userId, `Peer${tag}`]);
    await admin.query(`UPDATE core."user" SET first_name = $2, last_name = 'Mgr' WHERE id = $1`, [other.userId, `Peer${tag}`]);

    const res = await search(tokenA, `peer${tag}`);
    const managerIds = ids(res, 'Manager');
    expect(managerIds).toEqual([b.profileId]); // same organisation: listed, so searchable
    expect(managerIds).not.toContain(other.profileId);
  });
});
