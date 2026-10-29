import 'reflect-metadata';
import { ManagerType, PermissionFlag } from '@rab/shared';
import { ForbiddenException, INestApplication, NotFoundException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { Organisation } from '../../modules/identity/entities';
import { ROLE_DEFS } from '../../modules/manager/services/manager.service';
import { VenueManagerService } from '../../modules/manager/services/venue-manager.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Owner decision 2026-10-28: the EXISTING Assigned Staff feature (venue_manager_staff) extended to organisation
 * administrators — effective `manager.manage` (overrides honoured): the CEO across every workspace of their organisation,
 * a platform admin only in their own organisation through that permission. The workspace owner's path is unchanged
 * (venue-manager-venue-assignment.integration.spec.ts stays the regression for it). Real Postgres, RLS on, real HTTP.
 *
 * Abuse cases first: every cross-organisation / cross-workspace / unauthorised attempt must be refused and write nothing;
 * a revoke override must win at the route, in the service AND in the database; Admin Inspect stays read-only.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
const ADMIN_BASE = '/rest/v1/org-admin/venue-managers';

describeIfDb('Assigned Staff for organisation administrators (CEO / platform admin, own organisation)', () => {
  jest.setTimeout(240_000);

  let app: INestApplication;
  let owner: DataSource;
  let appDataSource: DataSource;
  let tenant: TenantContextService;
  let factory: TestIdentityFactory;
  let org: Organisation;
  let managerA: TestIdentity;
  let managerB: TestIdentity;
  let vmA: TestIdentity;
  let vmB: TestIdentity;
  let staffA: TestIdentity;
  let staffA2: TestIdentity;
  let staffB: TestIdentity;
  let ceo: TestIdentity;
  let ceoToken: string;

  const http = () => request(app.getHttpServer());
  const asAdmin = (token: string) => ({
    team: (vm: string) => http().get(`${ADMIN_BASE}/${vm}/staff`).set('Authorization', `Bearer ${token}`),
    assignable: (vm: string, q?: string) => http().get(`${ADMIN_BASE}/${vm}/assignable-staff`).query(q ? { q } : {}).set('Authorization', `Bearer ${token}`),
    assign: (vm: string, body: Record<string, unknown>) => http().post(`${ADMIN_BASE}/${vm}/staff`).set('Authorization', `Bearer ${token}`).send(body),
    remove: (vm: string, staff: string) => http().delete(`${ADMIN_BASE}/${vm}/staff/${staff}`).set('Authorization', `Bearer ${token}`),
  });

  /** venue_manager_staff rows of one Venue Manager, read as the bootstrap superuser (not narrowed by RLS). */
  async function teamRows(vmProfileId: string): Promise<string[]> {
    const rows = await owner.query(`SELECT staff_profile_id FROM core.venue_manager_staff WHERE manager_profile_id = $1 ORDER BY 1`, [vmProfileId]);
    return rows.map((r: { staff_profile_id: string }) => r.staff_profile_id);
  }

  async function overridePermission(userId: string, organisationId: string, effect: 'grant' | 'revoke'): Promise<void> {
    await owner.query(
      `INSERT INTO core.user_permission_override (user_id, permission_id, organisation_id, effect)
       SELECT $1, id, $2, $3 FROM core.permission WHERE key = $4`,
      [userId, organisationId, effect, PermissionFlag.MANAGER_MANAGE],
    );
  }

  async function auditOf(vmProfileId: string): Promise<Array<{ action: string; user_id: string; metadata: Record<string, unknown> }>> {
    return owner.query(
      `SELECT action, actor_user_id AS user_id, metadata FROM core.audit_log WHERE organisation_id = $1 AND entity_id = $2 AND action LIKE 'venue_team.%' ORDER BY created_at, id`,
      [org.id, vmProfileId],
    );
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    owner = createAdminDataSource();
    await owner.initialize();
    appDataSource = moduleRef.get(DataSource);
    tenant = moduleRef.get(TenantContextService);
    factory = new TestIdentityFactory({
      app,
      dataSource: appDataSource,
      adminDataSource: owner,
      tenantContext: tenant,
      passwordHashing: moduleRef.get(PasswordHashingService),
    });
    const seeded = await factory.createOrganisationWithManagers(2, { permissions: 'production', workspace: true, label: 'vtoa' });
    org = seeded.organisation;
    managerA = seeded.managers[0]!;
    managerB = seeded.managers[1]!;
    vmA = await factory.createVenueManager(org, { owner: managerA, label: 'vtoaA' });
    vmB = await factory.createVenueManager(org, { owner: managerB, label: 'vtoaB' });
    staffA = await factory.createStaff(org, { owner: managerA, label: 'vtoaSA' });
    staffA2 = await factory.createStaff(org, { owner: managerA, label: 'vtoaSA2' });
    staffB = await factory.createStaff(org, { owner: managerB, label: 'vtoaSB' });
    // A Venue Manager reads their own team rows only through a venue they are linked to (venue_manager_staff_vm_select,
    // unchanged): link Venue Manager A to a Workspace A venue, as the product does.
    const venueRes = await http().post('/rest/v1/venues').set('Authorization', `Bearer ${await factory.login(managerA)}`).send({ name: 'Org admin team venue', type: 'other' });
    expect(venueRes.status).toBe(201);
    await factory.assignVenue(org, managerA, vmA.profileId!, venueRes.body.id as string);
    ceo = await factory.createCeo(org, { permissions: 'production' });
    ceoToken = await factory.login(ceo);
  });

  afterAll(async () => {
    await owner?.destroy();
    await app?.close();
  });

  it('the production CEO role carries manager.manage (the rule this feature relies on)', () => {
    expect(ROLE_DEFS[ManagerType.CEO]!.permissions).toContain(PermissionFlag.MANAGER_MANAGE);
  });

  it('CEO views, adds and removes Assigned Staff for Venue Managers in BOTH workspaces; the Venue Manager sees the change', async () => {
    const admin = asAdmin(ceoToken);
    expect((await admin.team(vmA.profileId!)).body).toEqual([]);
    const added = await admin.assign(vmA.profileId!, { staffProfileIds: [staffA.profileId] });
    expect(added.status).toBe(201);
    expect(added.body).toEqual({ added: [staffA.profileId], alreadyAssigned: [] });
    expect((await admin.assign(vmB.profileId!, { staffProfileIds: [staffB.profileId] })).status).toBe(201);
    expect(await teamRows(vmA.profileId!)).toEqual([staffA.profileId]);
    expect(await teamRows(vmB.profileId!)).toEqual([staffB.profileId]);

    const listed = await admin.team(vmA.profileId!);
    expect(listed.status).toBe(200);
    expect(listed.body.map((r: { id: string }) => r.id)).toEqual([staffA.profileId]);

    // The Venue Manager's own app reflects it (same table, same read path as the owner flow).
    const dirA = await http().get('/rest/v1/staff/venue-directory').set('Authorization', `Bearer ${await factory.login(vmA)}`);
    expect(dirA.body.data.map((r: { id: string }) => r.id)).toEqual([staffA.profileId]);

    // Idempotent re-add, then removal; the Staff account itself is untouched.
    expect((await admin.assign(vmA.profileId!, { staffProfileIds: [staffA.profileId] })).body).toEqual({ added: [], alreadyAssigned: [staffA.profileId] });
    expect((await admin.remove(vmA.profileId!, staffA.profileId!)).status).toBe(204);
    expect(await teamRows(vmA.profileId!)).toEqual([]);
    expect((await admin.remove(vmA.profileId!, staffA.profileId!)).status).toBe(404);
    expect((await owner.query(`SELECT count(*)::int AS n FROM core.staff_profile WHERE id = $1`, [staffA.profileId]))[0].n).toBe(1);
  });

  it('org-admin changes reuse the existing audit actions, with the CEO as actor and flow org_admin', async () => {
    const rows = await auditOf(vmA.profileId!);
    expect(rows.map((r) => r.action)).toEqual(['venue_team.staff_assigned', 'venue_team.staff_unassigned']);
    for (const r of rows) {
      expect(r.user_id).toBe(ceo.userId);
      expect(r.metadata).toMatchObject({ workspaceId: managerA.workspaceId, flow: 'org_admin' });
    }
  });

  it('the workspace owner path is unchanged: Manager A still assigns their own staff, audited exactly as before (no flow key)', async () => {
    const token = await factory.login(managerA);
    const res = await http().post(`/rest/v1/venue-managers/${vmA.profileId}/staff`).set('Authorization', `Bearer ${token}`).send({ staffProfileIds: [staffA2.profileId] });
    expect(res.status).toBe(201);
    const last = (await auditOf(vmA.profileId!)).at(-1)!;
    expect(last).toMatchObject({ action: 'venue_team.staff_assigned', user_id: managerA.userId });
    expect(last.metadata).toEqual({ staffProfileIds: [staffA2.profileId], workspaceId: managerA.workspaceId });
    // ... and the CEO sees the owner's assignment through the same table.
    expect((await asAdmin(ceoToken).team(vmA.profileId!)).body.map((r: { id: string }) => r.id)).toEqual([staffA2.profileId]);
  });

  it('the picker lists only assignable Staff of the Venue Manager’s own workspace (never another workspace’s)', async () => {
    const suspended = await factory.createStaff(org, { owner: managerA, label: 'vtoaSusp', status: 'suspended' });
    const res = await asAdmin(ceoToken).assignable(vmA.profileId!);
    expect(res.status).toBe(200);
    const ids = res.body.data.map((r: { id: string }) => r.id);
    expect(ids).toEqual(expect.arrayContaining([staffA.profileId, staffA2.profileId]));
    expect(ids).not.toContain(staffB.profileId);
    expect(ids).not.toContain(suspended.profileId);
    expect(res.body.total).toBe(ids.length);
    expect(Object.keys(res.body.data[0]).sort()).toEqual(
      ['accountStatus', 'createdAt', 'email', 'employmentStatus', 'firstName', 'id', 'lastName', 'phone', 'staffRef'].sort(),
    );
    const other = (await asAdmin(ceoToken).assignable(vmB.profileId!)).body.data.map((r: { id: string }) => r.id);
    expect(other).toContain(staffB.profileId);
    expect(other).not.toContain(staffA.profileId);
  });

  it('all-or-nothing: another workspace’s or an ineligible Staff id refuses the whole request (404) and writes nothing', async () => {
    const before = await teamRows(vmA.profileId!);
    expect((await asAdmin(ceoToken).assign(vmA.profileId!, { staffProfileIds: [staffA.profileId, staffB.profileId] })).status).toBe(404);
    const suspended = await factory.createStaff(org, { owner: managerA, label: 'vtoaSusp2', status: 'suspended' });
    expect((await asAdmin(ceoToken).assign(vmA.profileId!, { staffProfileIds: [suspended.profileId] })).status).toBe(404);
    expect(await teamRows(vmA.profileId!)).toEqual(before);
  });

  it('tenancy can never come from the request: organisationId / workspaceId in the body or query is refused (400)', async () => {
    const admin = asAdmin(ceoToken);
    expect((await admin.assign(vmA.profileId!, { staffProfileIds: [staffA.profileId], workspaceId: managerB.workspaceId })).status).toBe(400);
    expect((await admin.assign(vmA.profileId!, { staffProfileIds: [staffA.profileId], organisationId: org.id })).status).toBe(400);
    const q = await http().get(`${ADMIN_BASE}/${vmA.profileId}/assignable-staff`).query({ workspaceId: managerB.workspaceId }).set('Authorization', `Bearer ${ceoToken}`);
    expect(q.status).toBe(400);
  });

  it('a target that is not a Venue Manager of this organisation is 404 (no existence oracle)', async () => {
    const admin = asAdmin(ceoToken);
    expect((await admin.team(managerA.profileId!)).status).toBe(404); // an Internal Manager, not a Venue Manager
    expect((await admin.team('00000000-0000-4000-8000-000000000000')).status).toBe(404);
    const other = await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'vtoaX' });
    const vmX = await factory.createVenueManager(other.organisation, { owner: other.managers[0]!, label: 'vtoaXvm' });
    for (const res of [await admin.team(vmX.profileId!), await admin.assignable(vmX.profileId!), await admin.assign(vmX.profileId!, { staffProfileIds: [staffA.profileId] })]) {
      expect(res.status).toBe(404);
    }
    expect(await teamRows(vmX.profileId!)).toEqual([]);
  });

  it('another organisation’s CEO cannot read or change this organisation’s Assigned Staff (404, nothing written)', async () => {
    const other = await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'vtoaY' });
    const ceoY = await factory.createCeo(other.organisation, { permissions: 'production' });
    const admin = asAdmin(await factory.login(ceoY));
    const before = await teamRows(vmA.profileId!);
    expect((await admin.team(vmA.profileId!)).status).toBe(404);
    expect((await admin.assignable(vmA.profileId!)).status).toBe(404);
    expect((await admin.assign(vmA.profileId!, { staffProfileIds: [staffA.profileId] })).status).toBe(404);
    expect((await admin.remove(vmA.profileId!, staffA2.profileId!)).status).toBe(404);
    expect(await teamRows(vmA.profileId!)).toEqual(before);
  });

  it('a Manager without manager.manage (even the owner) is 403 on the org-admin routes; a Venue Manager session is refused', async () => {
    const before = await teamRows(vmA.profileId!);
    expect(before).toEqual([staffA2.profileId]);
    for (const token of [await factory.login(managerA), await factory.login(managerB)]) {
      expect((await asAdmin(token).team(vmA.profileId!)).status).toBe(403);
      expect((await asAdmin(token).assign(vmB.profileId!, { staffProfileIds: [staffB.profileId] })).status).toBe(403);
      expect((await asAdmin(token).remove(vmA.profileId!, staffA2.profileId!)).status).toBe(403);
    }
    expect(await teamRows(vmA.profileId!)).toEqual(before);
    const vmRes = await asAdmin(await factory.login(vmA)).team(vmA.profileId!);
    expect([401, 403]).toContain(vmRes.status);
  });

  it('a REVOKE override wins: route 403, service (layer 2) refuses, and the database policy denies even with the scope bound', async () => {
    const revoked = await factory.createCeo(org, { permissions: 'production' });
    await overridePermission(revoked.userId, org.id, 'revoke');
    const admin = asAdmin(await factory.login(revoked));
    expect((await admin.team(vmA.profileId!)).status).toBe(403);
    expect((await admin.assign(vmA.profileId!, { staffProfileIds: [staffA.profileId] })).status).toBe(403);

    const service = app.get(VenueManagerService);
    const ctx = { organisationId: org.id, workspaceId: null, userId: revoked.userId, role: '' };
    await expect(service.assignTeamStaffAsOrgAdmin(ctx, vmA.profileId!, { staffProfileIds: [staffA.profileId!] })).rejects.toBeInstanceOf(ForbiddenException);

    // Layer 4: bound to Workspace A with the admin scope set, the revoked CEO's runtime connection sees no staff and
    // cannot write a team row.
    await tenant.runInWorkspaceContext({ organisationId: org.id, workspaceId: managerA.workspaceId!, userId: revoked.userId, role: '' }, async (m) => {
      await m.query(`SELECT set_config('rab.admin_scope', 'venue_team', true)`);
      expect((await m.query(`SELECT count(*)::int AS n FROM staff_profile`))[0].n).toBe(0);
      expect((await m.query(`SELECT count(*)::int AS n FROM venue_manager_staff`))[0].n).toBe(0);
      await m.query('SAVEPOINT w');
      await expect(
        m.query(`INSERT INTO venue_manager_staff (organisation_id, workspace_id, manager_profile_id, staff_profile_id) VALUES ($1, $2, $3, $4)`, [
          org.id, managerA.workspaceId, vmA.profileId, staffA.profileId,
        ]),
      ).rejects.toMatchObject({ code: '42501' });
      await m.query('ROLLBACK TO SAVEPOINT w');
    });
  });

  it('a GRANT override is honoured by the route, the service permission check and the new database policies', async () => {
    const granted = await factory.createOrgAdmin(org, { permissions: [PermissionFlag.STAFF_VIEW] });
    const noGrant = await factory.createOrgAdmin(org, { permissions: [PermissionFlag.STAFF_VIEW] });
    await overridePermission(granted.userId, org.id, 'grant');
    expect((await asAdmin(await factory.login(noGrant)).team(vmB.profileId!)).status).toBe(403);
    // Route (PermissionGuard) and service permission check pass for the grant: never a 403. The request then stops at the
    // Venue Manager lookup, because the PRE-EXISTING manager_profile_tenant org-wide branch (1786717300000) checks roles
    // only — documented in THREAT-MODEL.md; changing that policy is an open owner decision, not part of this change.
    const res = await asAdmin(await factory.login(granted)).team(vmB.profileId!);
    expect(res.status).not.toBe(403);
    // Layer 4: the module-18 policies themselves honour the grant (and deny the same user without it).
    for (const [user, expected] of [[granted, true], [noGrant, false]] as const) {
      await tenant.runInWorkspaceContext({ organisationId: org.id, workspaceId: managerB.workspaceId!, userId: user.userId, role: '' }, async (m) => {
        await m.query(`SELECT set_config('rab.admin_scope', 'venue_team', true)`);
        const n = (await m.query(`SELECT count(*)::int AS n FROM staff_profile WHERE id = $1`, [staffB.profileId]))[0].n;
        expect(n > 0).toBe(expected);
      });
    }
  });

  it('a platform admin acts only through manager.manage in their OWN organisation, never another one', async () => {
    // manager.manage through the organisation's CEO role (production set); without it through a role that lacks it.
    const paWith = await factory.createCeo(org, { permissions: 'production', platformAdmin: true });
    const paWithout = await factory.createOrgAdmin(org, { permissions: [PermissionFlag.STAFF_VIEW], platformAdmin: true });
    expect((await asAdmin(await factory.login(paWith)).team(vmA.profileId!)).status).toBe(200);
    expect((await asAdmin(await factory.login(paWithout)).team(vmA.profileId!)).status).toBe(403);
    const other = await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'vtoaZ' });
    const paElsewhere = await factory.createCeo(other.organisation, { permissions: 'production', platformAdmin: true });
    const before = await teamRows(vmA.profileId!);
    expect((await asAdmin(await factory.login(paElsewhere)).assign(vmA.profileId!, { staffProfileIds: [staffA.profileId] })).status).toBe(404);
    expect(await teamRows(vmA.profileId!)).toEqual(before);
  });

  it('Admin Inspect stays read-only: an org-admin write carrying an inspect header is refused before any handler runs', async () => {
    const before = await teamRows(vmA.profileId!);
    const res = await http()
      .post(`${ADMIN_BASE}/${vmA.profileId}/staff`)
      .set('Authorization', `Bearer ${ceoToken}`)
      .set('x-inspect-session-id', '00000000-0000-4000-8000-000000000000')
      .send({ staffProfileIds: [staffA.profileId] });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('INSPECT_READ_ONLY');
    expect(await teamRows(vmA.profileId!)).toEqual(before);
  });

  it('the service re-checks the permission itself (layer 2) and derives the workspace on the server', async () => {
    const service = app.get(VenueManagerService);
    const managerCtx = { organisationId: org.id, workspaceId: managerA.workspaceId!, userId: managerA.userId, role: '' };
    await expect(service.listTeamAsOrgAdmin(managerCtx, vmA.profileId!)).rejects.toBeInstanceOf(ForbiddenException);
    // A CEO context bound to Workspace B still acts on Venue Manager A's own workspace (A), never on B.
    const ceoCtxOnB = { organisationId: org.id, workspaceId: managerB.workspaceId!, userId: ceo.userId, role: '' };
    const listed = await service.listTeamAsOrgAdmin(ceoCtxOnB, vmA.profileId!);
    expect((listed as Array<{ id: string }>).every((r) => r.id !== staffB.profileId)).toBe(true);
    await expect(service.listTeamAsOrgAdmin({ ...ceoCtxOnB, organisationId: null }, vmA.profileId!)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('without the admin scope the CEO’s ordinary database visibility is unchanged (picker-only widening)', async () => {
    await tenant.runInWorkspaceContext({ organisationId: org.id, workspaceId: managerA.workspaceId!, userId: ceo.userId, role: '' }, async (m) => {
      expect((await m.query(`SELECT count(*)::int AS n FROM staff_profile`))[0].n).toBe(0);
      expect((await m.query(`SELECT count(*)::int AS n FROM venue_manager_staff`))[0].n).toBe(0);
      await m.query(`SELECT set_config('rab.admin_scope', 'venue_team', true)`);
      expect((await m.query(`SELECT count(*)::int AS n FROM staff_profile`))[0].n).toBeGreaterThan(0);
    });
  });

  it('removing a Staff member who is not on that team, or is another workspace’s, is 404 and deletes nothing', async () => {
    const admin = asAdmin(ceoToken);
    const beforeA = await teamRows(vmA.profileId!);
    const beforeB = await teamRows(vmB.profileId!);
    expect(beforeA).toContain(staffA2.profileId);
    expect(beforeB).toContain(staffB.profileId);
    expect((await admin.remove(vmA.profileId!, staffA.profileId!)).status).toBe(404); // own workspace, not on the team
    expect((await admin.remove(vmA.profileId!, staffB.profileId!)).status).toBe(404); // Workspace B's Staff, on B's team
    expect((await admin.remove(vmB.profileId!, staffA2.profileId!)).status).toBe(404); // on A's team, not B's
    expect(await teamRows(vmA.profileId!)).toEqual(beforeA);
    expect(await teamRows(vmB.profileId!)).toEqual(beforeB);
  });

  it('an archived Staff member is not assignable on either path (404, nothing written), as the picker already excludes them', async () => {
    const archived = await factory.createStaff(org, { owner: managerA, label: 'vtoaArch' });
    await owner.query(`UPDATE core.staff_profile SET archived_at = now(), archived_by = $2 WHERE id = $1`, [archived.profileId, managerA.userId]);
    expect((await asAdmin(ceoToken).assignable(vmA.profileId!)).body.data.map((r: { id: string }) => r.id)).not.toContain(archived.profileId);
    const before = await teamRows(vmA.profileId!);
    expect((await asAdmin(ceoToken).assign(vmA.profileId!, { staffProfileIds: [archived.profileId] })).status).toBe(404);
    // Workspace-owner path: the same rule (behaviour change 2026-10-29: previously assignable there by a direct POST).
    const ownerRes = await http()
      .post(`/rest/v1/venue-managers/${vmA.profileId}/staff`)
      .set('Authorization', `Bearer ${await factory.login(managerA)}`)
      .send({ staffProfileIds: [archived.profileId] });
    expect(ownerRes.status).toBe(404);
    expect(await teamRows(vmA.profileId!)).toEqual(before);
  });

  it('the write re-checks its target: a suspended Venue Manager gets no row (404)', async () => {
    const vmS = await factory.createVenueManager(org, { owner: managerA, label: 'vtoaSuspVm' });
    await owner.query(`UPDATE core."user" SET status = 'suspended' WHERE id = $1`, [vmS.userId]);
    expect((await asAdmin(ceoToken).assign(vmS.profileId!, { staffProfileIds: [staffA.profileId] })).status).toBe(404);
    expect(await teamRows(vmS.profileId!)).toEqual([]);
  });

  it('the write re-checks its target: a workspace archived after the scope check and before the write gets no row (404)', async () => {
    const service = app.get(VenueManagerService);
    const target = service as unknown as { orgAdminTeamScope: (...args: unknown[]) => Promise<unknown> };
    const resolveScope = target.orgAdminTeamScope.bind(service);
    // The race, made deterministic: the workspace is archived right after orgAdminTeamScope has confirmed it is active.
    const spy = jest.spyOn(target, 'orgAdminTeamScope').mockImplementationOnce(async (...args: unknown[]) => {
      const scope = await resolveScope(...args);
      await owner.query(`UPDATE core.manager_workspace SET status = 'archived' WHERE id = $1`, [managerA.workspaceId]);
      return scope;
    });
    const before = await teamRows(vmA.profileId!);
    try {
      const ctx = { organisationId: org.id, workspaceId: null, userId: ceo.userId, role: '' };
      await expect(service.assignTeamStaffAsOrgAdmin(ctx, vmA.profileId!, { staffProfileIds: [staffA.profileId!] })).rejects.toBeInstanceOf(NotFoundException);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
      await owner.query(`UPDATE core.manager_workspace SET status = 'active' WHERE id = $1`, [managerA.workspaceId]);
    }
    expect(await teamRows(vmA.profileId!)).toEqual(before);
  });

  it('the picker validates paging (limit above 1000 is 400) and searches `%` / `_` literally, never as wildcards', async () => {
    const tooMany = await http().get(`${ADMIN_BASE}/${vmA.profileId}/assignable-staff`).query({ limit: 1001 }).set('Authorization', `Bearer ${ceoToken}`);
    expect(tooMany.status).toBe(400);
    const pct = await factory.createStaff(org, { owner: managerA, label: 'vtoaPct' });
    await owner.query(`UPDATE core."user" SET first_name = '100%' WHERE id = $1`, [pct.userId]);
    const percent = await asAdmin(ceoToken).assignable(vmA.profileId!, '%');
    expect(percent.status).toBe(200);
    expect(percent.body.data.map((r: { id: string }) => r.id)).toEqual([pct.profileId]);
    expect(percent.body.total).toBe(1);
    const underscore = await asAdmin(ceoToken).assignable(vmA.profileId!, '_');
    expect(underscore.body).toEqual({ data: [], total: 0 });
  });

  it('no tenant context bound: the new policies return zero rows', async () => {
    await appDataSource.transaction(async (m) => {
      await m.query(`SELECT set_config('rab.admin_scope', 'venue_team', true)`);
      expect((await m.query(`SELECT count(*)::int AS n FROM core.venue_manager_staff`))[0].n).toBe(0);
      expect((await m.query(`SELECT count(*)::int AS n FROM core.staff_profile`))[0].n).toBe(0);
    });
  });
});
