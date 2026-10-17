import 'reflect-metadata';
import { ManagerType, PermissionFlag } from '@rab/shared';
import { ForbiddenException, INestApplication, ValidationPipe } from '@nestjs/common';
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
 * Workspace-scoped Venue Manager → Venue assignment (POST /rest/v1/venue-managers/:id/venues). The normal Manager's
 * counterpart to the CEO-only POST /managers/:id/venues: a Manager links a Venue Manager of their OWN workspace to a
 * Venue of their OWN workspace. Real Postgres, RLS on, real HTTP. Every cross-workspace attempt must be a 404 that
 * writes nothing.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('Venue Manager venue assignment inside the Manager\'s own workspace (integration)', () => {
  jest.setTimeout(180_000);

  let app: INestApplication;
  let owner: DataSource;
  let factory: TestIdentityFactory;
  let org: Organisation;
  let managerA: TestIdentity;
  let managerB: TestIdentity;
  let vmA: TestIdentity;
  let vmB: TestIdentity;
  let venueA: string;
  let venueB: string;

  const http = () => request(app.getHttpServer());
  const assign = (token: string, profileId: string, body: Record<string, unknown>) =>
    http().post(`/rest/v1/venue-managers/${profileId}/venues`).set('Authorization', `Bearer ${token}`).send(body);

  async function createVenue(manager: TestIdentity, name: string): Promise<string> {
    const token = await factory.login(manager);
    const res = await http().post('/rest/v1/venues').set('Authorization', `Bearer ${token}`).send({ name, type: 'other' });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  /** manager_venue rows for a profile in one workspace, read as the owner (explicit predicate: the admin connection is not narrowed by the workspace GUC). */
  async function linksOf(profileId: string, workspaceId: string): Promise<Array<{ venue_id: string; workspace_id: string }>> {
    return owner.transaction(async (m) => {
      await m.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true)`, [org.id, workspaceId]);
      return m.query(`SELECT venue_id, workspace_id FROM core.manager_venue WHERE manager_profile_id = $1 AND workspace_id = $2`, [profileId, workspaceId]);
    });
  }

  async function allLinks(profileId: string): Promise<number> {
    return (await linksOf(profileId, managerA.workspaceId!)).length + (await linksOf(profileId, managerB.workspaceId!)).length;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    owner = createAdminDataSource();
    await owner.initialize();
    factory = new TestIdentityFactory({
      app,
      dataSource: moduleRef.get(DataSource),
      adminDataSource: owner,
      tenantContext: moduleRef.get(TenantContextService),
      passwordHashing: moduleRef.get(PasswordHashingService),
    });
    const seeded = await factory.createOrganisationWithManagers(2, { permissions: 'production', workspace: true, label: 'vmva' });
    org = seeded.organisation;
    managerA = seeded.managers[0]!;
    managerB = seeded.managers[1]!;
    vmA = await factory.createVenueManager(org, { owner: managerA, label: 'vmvaA' });
    vmB = await factory.createVenueManager(org, { owner: managerB, label: 'vmvaB' });
    venueA = await createVenue(managerA, 'Assign Venue A');
    venueB = await createVenue(managerB, 'Assign Venue B');
  });

  afterAll(async () => {
    await owner?.destroy();
    await app?.close();
  });

  it('Manager A links their own Venue Manager to their own Venue (204), in Workspace A, and the Venue Manager now sees it', async () => {
    const token = await factory.login(managerA);
    expect((await assign(token, vmA.profileId!, { venueId: venueA })).status).toBe(204);
    expect(await linksOf(vmA.profileId!, managerA.workspaceId!)).toEqual([{ venue_id: venueA, workspace_id: managerA.workspaceId }]);

    const vmToken = await factory.login(vmA);
    const venues = await http().get('/rest/v1/venues').set('Authorization', `Bearer ${vmToken}`);
    expect(venues.status).toBe(200);
    const ids = (Array.isArray(venues.body) ? venues.body : venues.body.data).map((v: { id: string }) => v.id);
    expect(ids).toEqual([venueA]);
  });

  it('repeating the assignment is idempotent (204, still one row)', async () => {
    const token = await factory.login(managerA);
    expect((await assign(token, vmA.profileId!, { venueId: venueA })).status).toBe(204);
    expect(await linksOf(vmA.profileId!, managerA.workspaceId!)).toHaveLength(1);
  });

  it('the assignment is audited with the actor, the Venue Manager and the venue, and no secret', async () => {
    const rows: Array<{ action: string; actor_user_id: string; entity_id: string; metadata: Record<string, unknown> }> = await owner.transaction(async (m) => {
      await m.query(`SELECT set_config('rab.organisation_id', $1, true)`, [org.id]);
      return m.query(
        `SELECT action, actor_user_id, entity_id, metadata FROM core.audit_log WHERE organisation_id = $1 AND action = 'manager.venue_assigned' AND entity_id = $2`,
        [org.id, vmA.profileId],
      );
    });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]).toMatchObject({ actor_user_id: managerA.userId, metadata: { venueId: venueA, workspaceId: managerA.workspaceId, flow: 'workspace_manager' } });
    expect(JSON.stringify(rows)).not.toMatch(/password|token/i);
  });

  it('Manager A cannot link a Venue Manager of Workspace B, even to their own venue: 404, nothing written', async () => {
    const token = await factory.login(managerA);
    const res = await assign(token, vmB.profileId!, { venueId: venueA });
    expect(res.status).toBe(404);
    expect(await allLinks(vmB.profileId!)).toBe(0);
  });

  it('Manager A cannot link their own Venue Manager to a Venue of Workspace B: 404, nothing written', async () => {
    const token = await factory.login(managerA);
    const res = await assign(token, vmA.profileId!, { venueId: venueB });
    expect(res.status).toBe(404);
    expect((await linksOf(vmA.profileId!, managerA.workspaceId!)).map((r) => r.venue_id)).toEqual([venueA]);
    expect(await linksOf(vmA.profileId!, managerB.workspaceId!)).toEqual([]);
  });

  it('Manager B cannot link Workspace A\'s Venue Manager to Workspace A\'s Venue: 404', async () => {
    const token = await factory.login(managerB);
    expect((await assign(token, vmA.profileId!, { venueId: venueA })).status).toBe(404);
  });

  it('an unknown Venue Manager or venue id is 404 (no existence oracle)', async () => {
    const token = await factory.login(managerA);
    expect((await assign(token, '00000000-0000-4000-8000-000000000000', { venueId: venueA })).status).toBe(404);
    expect((await assign(token, vmA.profileId!, { venueId: '00000000-0000-4000-8000-000000000000' })).status).toBe(404);
  });

  it('a profile that is not a Venue Manager (an Internal Manager) cannot be given a venue: 404', async () => {
    const token = await factory.login(managerA);
    expect((await assign(token, managerA.profileId!, { venueId: venueA })).status).toBe(404);
  });

  it('a body carrying organisationId or workspaceId is refused (400): neither is tenancy authority', async () => {
    const token = await factory.login(managerA);
    expect((await assign(token, vmA.profileId!, { venueId: venueA, workspaceId: managerB.workspaceId })).status).toBe(400);
    expect((await assign(token, vmA.profileId!, { venueId: venueA, organisationId: org.id })).status).toBe(400);
  });

  it('a Manager without VENUE_MANAGER_CREATE is denied (403)', async () => {
    const limitedOrg = await factory.createOrganisation('vmva-lim');
    const limited = await factory.createInternalManager(limitedOrg, {
      permissions: ROLE_DEFS[ManagerType.INTERNAL]!.permissions.filter((p) => p !== PermissionFlag.VENUE_MANAGER_CREATE),
      label: 'vmvaLim',
    });
    const token = await factory.login(limited);
    expect((await assign(token, vmA.profileId!, { venueId: venueA })).status).toBe(403);
  });

  it('a Venue Manager\'s own mobile session cannot call the Manager route (refused, nothing written)', async () => {
    const vmToken = await factory.login(vmB);
    const res = await assign(vmToken, vmB.profileId!, { venueId: venueB });
    expect([403, 404]).toContain(res.status);
    expect(await allLinks(vmB.profileId!)).toBe(0);
  });

  it('the service re-checks the permission itself (layer 2): a caller context without VENUE_MANAGER_CREATE is refused without a guard', async () => {
    const service = app.get(VenueManagerService);
    await expect(
      service.assignVenueInOwnWorkspace({ organisationId: org.id, workspaceId: managerA.workspaceId!, userId: vmA.userId, role: '' }, vmA.profileId!, venueA),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  // ---------------------------------------------------------------- GET /venue-managers (own workspace list)

  const listVms = (token: string, query = '') =>
    http().get(`/rest/v1/venue-managers${query}`).set('Authorization', `Bearer ${token}`);

  it('Manager A lists only the Venue Managers of Workspace A, each with its own-workspace venues', async () => {
    const res = await listVms(await factory.login(managerA));
    expect(res.status).toBe(200);
    const rows = res.body.data as Array<{ id: string; type: string; venues: Array<{ id: string }> }>;
    expect(rows.map((r) => r.id)).toEqual([vmA.profileId]);
    expect(rows[0]).toMatchObject({ type: 'venue', venues: [{ id: venueA }] });
    expect(res.body.total).toBe(1);
  });

  it('Manager B lists only the Venue Manager of Workspace B (never Workspace A), and Internal Managers are never listed', async () => {
    const res = await listVms(await factory.login(managerB));
    expect(res.status).toBe(200);
    const ids = (res.body.data as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toEqual([vmB.profileId]);
    expect(ids).not.toContain(managerB.profileId);
  });

  it('the list cannot be widened from the query: workspaceId / organisationId / type are refused (400)', async () => {
    const token = await factory.login(managerA);
    expect((await listVms(token, `?workspaceId=${managerB.workspaceId}`)).status).toBe(400);
    expect((await listVms(token, `?organisationId=${org.id}`)).status).toBe(400);
    expect((await listVms(token, '?type=internal')).status).toBe(400);
  });

  it('listing needs VENUE_MANAGER_CREATE (403 without it) and is refused to the mobile session of a Venue Manager', async () => {
    const limitedOrg = await factory.createOrganisation('vmva-lim2');
    const limited = await factory.createInternalManager(limitedOrg, {
      permissions: ROLE_DEFS[ManagerType.INTERNAL]!.permissions.filter((p) => p !== PermissionFlag.VENUE_MANAGER_CREATE),
      label: 'vmvaLim2',
    });
    expect((await listVms(await factory.login(limited))).status).toBe(403);
    expect([403, 404]).toContain((await listVms(await factory.login(vmA))).status);
  });

  it('the list service re-checks the permission itself (layer 2)', async () => {
    const service = app.get(VenueManagerService);
    await expect(
      service.listInOwnWorkspace({ organisationId: org.id, workspaceId: managerA.workspaceId!, userId: vmA.userId, role: '' }, {}),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('GET /venue-managers/:id returns the own-workspace Venue Manager with its venues; another workspace, an Internal Manager or an unknown id is 404', async () => {
    const tokenA = await factory.login(managerA);
    const get = (token: string, id: string) => http().get(`/rest/v1/venue-managers/${id}`).set('Authorization', `Bearer ${token}`);
    const own = await get(tokenA, vmA.profileId!);
    expect(own.status).toBe(200);
    expect(own.body).toMatchObject({ id: vmA.profileId, type: 'venue', venues: [{ id: venueA }] });
    expect((await get(tokenA, vmB.profileId!)).status).toBe(404);
    expect((await get(tokenA, managerA.profileId!)).status).toBe(404);
    expect((await get(tokenA, '00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await get(await factory.login(managerB), vmA.profileId!)).status).toBe(404);
  });

  it('the single-record service re-checks the permission itself (layer 2)', async () => {
    const service = app.get(VenueManagerService);
    await expect(
      service.getInOwnWorkspace({ organisationId: org.id, workspaceId: managerA.workspaceId!, userId: vmA.userId, role: '' }, vmA.profileId!),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  // ------------------------------------------- per-record account actions on own-workspace Venue Managers

  const call = (method: 'get' | 'post' | 'patch' | 'delete', token: string, path: string, body?: Record<string, unknown>) => {
    const r = http()[method](`/rest/v1/venue-managers${path}`).set('Authorization', `Bearer ${token}`);
    return body ? r.send(body) : r;
  };

  it('Manager A uses the full panel on their own Venue Manager: timeline, notes, emails, edit, deactivate/reactivate', async () => {
    const t = await factory.login(managerA);
    expect((await call('get', t, `/${vmA.profileId}/timeline`)).status).toBe(200);
    expect((await call('post', t, `/${vmA.profileId}/notes`, { body: 'Checked in with the venue.' })).status).toBe(201);
    const notes = await call('get', t, `/${vmA.profileId}/notes`);
    expect(notes.status).toBe(200);
    expect(JSON.stringify(notes.body)).toContain('Checked in with the venue.');
    expect((await call('get', t, `/${vmA.profileId}/emails`)).status).toBe(200);
    const edited = await call('patch', t, `/${vmA.profileId}`, { jobTitle: 'Floor lead' });
    expect(edited.status).toBe(200);
    expect(edited.body.jobTitle).toBe('Floor lead');
    expect((await call('post', t, `/${vmA.profileId}/deactivate`)).status).toBeLessThan(300);
    expect((await call('post', t, `/${vmA.profileId}/reactivate`)).status).toBeLessThan(300);
  });

  it('every account action on another workspace\u2019s Venue Manager, or on an Internal Manager, is 404 and changes nothing', async () => {
    const t = await factory.login(managerA);
    for (const target of [vmB.profileId!, managerB.profileId!, managerA.profileId!]) {
      expect((await call('get', t, `/${target}/timeline`)).status).toBe(404);
      expect((await call('get', t, `/${target}/notes`)).status).toBe(404);
      expect((await call('post', t, `/${target}/notes`, { body: 'should not be written' })).status).toBe(404);
      expect((await call('get', t, `/${target}/emails`)).status).toBe(404);
      expect((await call('patch', t, `/${target}`, { jobTitle: 'Hijacked' })).status).toBe(404);
      expect((await call('post', t, `/${target}/deactivate`)).status).toBe(404);
      expect((await call('post', t, `/${target}/reset-password`)).status).toBe(404);
      expect((await call('post', t, `/${target}/resend-invite`)).status).toBe(404);
      expect((await call('delete', t, `/${target}`, { currentPassword: managerA.password })).status).toBe(404);
    }
    const tb = await factory.login(managerB);
    const own = await call('get', tb, `/${vmB.profileId}`);
    expect(own.body.jobTitle).not.toBe('Hijacked');
    expect(own.body.accountStatus).toBe('active');
  });

  it('a body carrying type / workspaceId on edit is refused (400): the role and tenancy are not editable', async () => {
    const t = await factory.login(managerA);
    expect((await call('patch', t, `/${vmA.profileId}`, { type: 'internal' })).status).toBe(400);
    expect((await call('patch', t, `/${vmA.profileId}`, { workspaceId: managerB.workspaceId })).status).toBe(400);
  });

  it('delete needs the caller\u2019s own password (step-up): missing is 400, wrong is refused, correct removes only that Venue Manager', async () => {
    const victim = await factory.createVenueManager(org, { owner: managerA, label: 'vmvaDel' });
    const t = await factory.login(managerA);
    expect((await call('delete', t, `/${victim.profileId}`)).status).toBe(400);
    expect([401, 403]).toContain((await call('delete', t, `/${victim.profileId}`, { currentPassword: 'not-the-password-1A' })).status);
    expect((await call('get', t, `/${victim.profileId}`)).status).toBe(200);
    expect((await call('delete', t, `/${victim.profileId}`, { currentPassword: managerA.password })).status).toBeLessThan(300);
    expect((await call('get', t, `/${victim.profileId}`)).status).toBe(404);
    expect((await call('get', t, `/${vmA.profileId}`)).status).toBe(200);
  });

  it('bulk email only reaches own-workspace Venue Managers; a foreign id is dropped, never emailed', async () => {
    const t = await factory.login(managerA);
    const res = await call('post', t, '/bulk-email', { userIds: [vmA.profileId, vmB.profileId], subject: 'Rota', message: 'See the new rota.' });
    expect(res.status).toBeLessThan(300);
    expect(res.body).toMatchObject({ queued: 1, skipped: 1 });
  });

  it('without VENUE_MANAGER_CREATE every account action is 403, and a Manager still cannot use the CEO /managers actions', async () => {
    const limitedOrg = await factory.createOrganisation('vmva-lim3');
    const limited = await factory.createInternalManager(limitedOrg, {
      permissions: ROLE_DEFS[ManagerType.INTERNAL]!.permissions.filter((p) => p !== PermissionFlag.VENUE_MANAGER_CREATE),
      label: 'vmvaLim3',
    });
    const tl = await factory.login(limited);
    expect((await call('get', tl, `/${vmA.profileId}/timeline`)).status).toBe(403);
    expect((await call('post', tl, `/${vmA.profileId}/deactivate`)).status).toBe(403);
    const t = await factory.login(managerA);
    expect((await http().post(`/rest/v1/managers/${vmA.profileId}/deactivate`).set('Authorization', `Bearer ${t}`)).status).toBe(403);
  });

  it('the account-action gate re-checks the permission in the service (layer 2)', async () => {
    const service = app.get(VenueManagerService);
    await expect(
      service.setActive({ organisationId: org.id, workspaceId: managerA.workspaceId!, userId: vmA.userId, role: '' }, vmA.profileId!, false),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  // ------------------------------------------------------------- owner-assigned Venue Manager teams

  it('Manager A assigns their own staff to Venue Manager A; another workspace\u2019s or organisation\u2019s manager cannot assign or read that team', async () => {
    const staffA = await factory.createStaff(org, { owner: managerA, label: 'teamA' });
    const staffB = await factory.createStaff(org, { owner: managerB, label: 'teamB' });
    const ta = await factory.login(managerA);
    const tb = await factory.login(managerB);
    const team = (token: string, vm: string) => http().get(`/rest/v1/venue-managers/${vm}/staff`).set('Authorization', `Bearer ${token}`);
    const assign = (token: string, vm: string, ids: string[]) =>
      http().post(`/rest/v1/venue-managers/${vm}/staff`).set('Authorization', `Bearer ${token}`).send({ staffProfileIds: ids });

    expect((await assign(ta, vmA.profileId!, [staffA.profileId!])).status).toBe(201);
    expect((await assign(ta, vmA.profileId!, [staffB.profileId!])).status).toBe(404); // Workspace B's staff
    expect((await assign(tb, vmA.profileId!, [staffB.profileId!])).status).toBe(404); // Workspace A's Venue Manager
    expect((await team(tb, vmA.profileId!)).status).toBe(404);
    expect((await assign(ta, vmA.profileId!, [staffA.profileId!])).body).toEqual({ added: [], alreadyAssigned: [staffA.profileId] });
    expect((await assign(ta, vmA.profileId!, [staffA.profileId!, staffA.profileId!])).status).toBe(400); // duplicates in one request
    expect((await http().post(`/rest/v1/venue-managers/${vmA.profileId}/staff`).set('Authorization', `Bearer ${ta}`).send({ staffProfileIds: [staffA.profileId], workspaceId: managerB.workspaceId })).status).toBe(400);

    const other = await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'vmvaX' });
    const tx = await factory.login(other.managers[0]!);
    expect((await assign(tx, vmA.profileId!, [staffA.profileId!])).status).toBe(404);
    expect((await team(tx, vmA.profileId!)).status).toBe(404);

    const listed = await team(ta, vmA.profileId!);
    expect(listed.status).toBe(200);
    expect(listed.body.map((r: { id: string }) => r.id)).toEqual([staffA.profileId]);
    expect((await team(ta, vmB.profileId!)).status).toBe(404);

    // Venue Manager A now sees exactly that staff member; Venue Manager B does not.
    const dirA = await http().get('/rest/v1/staff/venue-directory').set('Authorization', `Bearer ${await factory.login(vmA)}`);
    expect(dirA.body.data.map((r: { id: string }) => r.id)).toEqual([staffA.profileId]);
    const dirB = await http().get('/rest/v1/staff/venue-directory').set('Authorization', `Bearer ${await factory.login(vmB)}`);
    expect(dirB.body.data.map((r: { id: string }) => r.id)).not.toContain(staffA.profileId);

    // Removal: owner only, audited, account untouched.
    expect((await http().delete(`/rest/v1/venue-managers/${vmA.profileId}/staff/${staffA.profileId}`).set('Authorization', `Bearer ${tb}`)).status).toBe(404);
    expect((await http().delete(`/rest/v1/venue-managers/${vmA.profileId}/staff/${staffA.profileId}`).set('Authorization', `Bearer ${ta}`)).status).toBe(204);
    const audit = await owner.transaction(async (m) => {
      await m.query(`SELECT set_config('rab.organisation_id', $1, true)`, [org.id]);
      return m.query(`SELECT action FROM core.audit_log WHERE organisation_id = $1 AND entity_id = $2 AND action LIKE 'venue_team.%' ORDER BY created_at`, [org.id, vmA.profileId]);
    });
    expect(audit.map((r: { action: string }) => r.action)).toEqual(['venue_team.staff_assigned', 'venue_team.staff_unassigned']);
    expect((await http().get(`/rest/v1/staff/${staffA.profileId}`).set('Authorization', `Bearer ${ta}`)).status).toBe(200);
  });

  it('assignment needs VENUE_MANAGER_CREATE and the service re-checks it (layer 2)', async () => {
    const service = app.get(VenueManagerService);
    await expect(
      service.assignTeamStaff({ organisationId: org.id, workspaceId: managerA.workspaceId!, userId: vmA.userId, role: '' }, vmA.profileId!, { staffProfileIds: [vmA.profileId!] }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('profile photo: Manager A sets and removes their own Venue Manager\u2019s photo; another workspace\u2019s Venue Manager is 404; a non-image is refused', async () => {
    // 1x1 PNG
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const t = await factory.login(managerA);
    const up = await http().post(`/rest/v1/venue-managers/${vmA.profileId}/avatar`).set('Authorization', `Bearer ${t}`).attach('file', png, { filename: 'a.png', contentType: 'image/png' });
    expect(up.status).toBe(201);
    expect(typeof up.body.avatarKey).toBe('string');
    expect((await http().get(`/rest/v1/venue-managers/${vmA.profileId}`).set('Authorization', `Bearer ${t}`)).body.avatarKey).toBe(up.body.avatarKey);
    const foreign = await http().post(`/rest/v1/venue-managers/${vmB.profileId}/avatar`).set('Authorization', `Bearer ${t}`).attach('file', png, { filename: 'a.png', contentType: 'image/png' });
    expect(foreign.status).toBe(404);
    const notImage = await http().post(`/rest/v1/venue-managers/${vmA.profileId}/avatar`).set('Authorization', `Bearer ${t}`).attach('file', Buffer.from('not an image'), { filename: 'a.txt', contentType: 'text/plain' });
    expect(notImage.status).toBeGreaterThanOrEqual(400);
    const removed = await http().delete(`/rest/v1/venue-managers/${vmA.profileId}/avatar`).set('Authorization', `Bearer ${t}`);
    expect(removed.status).toBe(200);
    expect(removed.body).toEqual({ avatarKey: null });
  });

  it('the CEO-only manager roster is unchanged: Manager A still gets 403 on GET /managers', async () => {
    expect((await http().get('/rest/v1/managers').set('Authorization', `Bearer ${await factory.login(managerA)}`)).status).toBe(403);
  });

  it('the CEO-only route is unchanged: Manager A still gets 403 on POST /managers/:id/venues', async () => {
    const token = await factory.login(managerA);
    const res = await http().post(`/rest/v1/managers/${vmA.profileId}/venues`).set('Authorization', `Bearer ${token}`).send({ venueId: venueA });
    expect(res.status).toBe(403);
  });
});
