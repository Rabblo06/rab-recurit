import 'reflect-metadata';
import { ManagerType, VenueType } from '@rab/shared';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { ThrottlerRedisClientProvider } from '../../engine/core-modules/throttler/throttler-redis-client.provider';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { WORKER_HEARTBEAT_KEY } from '../../engine/worker-shared/heartbeat.constants';
import { OrganisationOnboardingService } from '../../modules/manager/services/organisation-onboarding.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Organisation isolation for Initial Manager onboarding (owner policy, 2026-10-15). Supersedes P2.9C's "a Platform Admin may
 * invite the Initial Manager of ANY organisation": Initial Manager onboarding is strictly same-organisation for every actor.
 * A platform administrator keeps organisation creation + CEO onboarding (a separate, explicitly authorised workflow).
 *
 * Real PostgreSQL with RLS, no mocks. Runs unchanged with `USER_SESSION_CACHE_ENABLED=true AUTH_CONTEXT_CACHE_ENABLED=true`
 * (warm Redis caches must not change any outcome below).
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('organisation isolation: Initial Manager onboarding, login and tenant scope (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let factory: TestIdentityFactory;
  let tenantContext: TenantContextService;
  let onboarding: OrganisationOnboardingService;

  const http = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const IM_PASSWORD = 'InitialMgr1!Iso';

  /** Organisation 1 ("Adolphus") and Organisation 2 ("Example Hospitality") with real operational data in Organisation 2. */
  let org1: { id: string };
  let org2: { id: string };
  let ceo1: TestIdentity;
  let ceo1Token: string;
  let manager2: TestIdentity;
  let manager2Token: string;
  let staff2: TestIdentity;
  let venue2Id: string;
  let org2SystemRoleId: string;
  let org2WorkspaceId: string;

  /** Organisation 1's Initial Manager, invited by CEO 1, activated and logged in. */
  let im1Email: string;
  let im1UserId: string;
  let im1Token: string;
  let im1WorkspaceId: string;

  async function activationToken(userId: string): Promise<string> {
    const [invite] = await adminDataSource.manager.query(`SELECT id FROM core.account_invite WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [userId]);
    const [outbox] = await adminDataSource.manager.query(`SELECT rendered_html FROM core.email_outbox WHERE account_invite_id = $1`, [invite.id]);
    const match = /token=([a-f0-9]+)/.exec(outbox.rendered_html as string);
    if (!match) throw new Error('activation token not found in the rendered invitation email');
    return match[1]!;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    dataSource = moduleRef.get(DataSource);
    tenantContext = moduleRef.get(TenantContextService);
    onboarding = moduleRef.get(OrganisationOnboardingService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = new TestIdentityFactory({ app, dataSource, adminDataSource, tenantContext, passwordHashing: moduleRef.get(PasswordHashingService) });
    await moduleRef.get(ThrottlerRedisClientProvider).client.set(WORKER_HEARTBEAT_KEY, Date.now().toString(), 'EX', 300);

    org1 = await factory.createOrganisation('adolphus');
    org2 = await factory.createOrganisation('example-hospitality');
    ceo1 = await factory.createCeo(org1, { permissions: 'all' });
    ceo1Token = await factory.login(ceo1);
    manager2 = await factory.createInternalManager(org2, { permissions: 'all' });
    manager2Token = await factory.login(manager2);
    staff2 = await factory.createStaff(org2, { owner: manager2 });
    org2WorkspaceId = manager2.workspaceId!;
    const venue = await http().post('/rest/v1/venues').set(bearer(manager2Token)).send({ name: `Org2 venue ${unique()}`, type: Object.values(VenueType)[0] });
    expect(venue.status).toBe(201);
    venue2Id = venue.body.id;
    [{ id: org2SystemRoleId }] = await adminDataSource.manager.query(`SELECT id FROM core.role WHERE organisation_id = $1 AND workspace_id IS NULL LIMIT 1`, [org2.id]);

    // Phase 3: Organisation 1's CEO invites the Initial Manager. The organisation comes from CEO 1's session only.
    im1Email = `initialmanager-${unique()}@example.test`;
    const invited = await http().post('/rest/v1/managers/initial-manager-invite').set(bearer(ceo1Token)).send({ email: im1Email, firstName: 'Ida', lastName: 'Initial' });
    expect(invited.status).toBe(201);
    [{ id: im1UserId }] = await adminDataSource.manager.query(`SELECT id FROM core."user" WHERE email = $1`, [im1Email]);
    const activated = await http().post('/rest/v1/auth/activate-account').send({ token: await activationToken(im1UserId), newPassword: IM_PASSWORD });
    expect(activated.status).toBe(200);
    const login = await http().post('/rest/v1/auth/login').send({ email: im1Email, password: IM_PASSWORD, applicationTarget: 'manager_web' });
    expect(login.status).toBe(200);
    im1Token = login.body.accessToken;
    const ws = await http().post('/rest/v1/manager-workspaces').set(bearer(im1Token)).send({ name: `Adolphus IM ${unique()}`, subdomain: `adolphus-${unique()}` });
    expect(ws.status).toBe(201);
    im1WorkspaceId = ws.body.id;
    // A fresh login binds the new workspace into the session.
    im1Token = (await http().post('/rest/v1/auth/login').send({ email: im1Email, password: IM_PASSWORD, applicationTarget: 'manager_web' })).body.accessToken;
  });

  afterAll(async () => {
    await app.close();
    await adminDataSource.destroy();
  });

  describe('Phase 3: the invitation binds Organisation 1 at every step (database rows)', () => {
    it('user, profile, role, organisation membership, invitation, workspace and workspace membership all belong to Organisation 1', async () => {
      const [row] = await adminDataSource.manager.query(
        `SELECT u.organisation_id AS user_org, u.status, mp.organisation_id AS profile_org, mp.type, mp.is_initial_manager,
                mp.workspace_id AS profile_ws,
                (SELECT array_agg(DISTINCT ur.organisation_id) FROM core.user_role ur WHERE ur.user_id = u.id) AS role_orgs,
                (SELECT array_agg(DISTINCT r.organisation_id) FROM core.user_role ur JOIN core.role r ON r.id = ur.role_id WHERE ur.user_id = u.id) AS role_def_orgs,
                (SELECT array_agg(DISTINCT om.organisation_id) FROM core.organisation_member om WHERE om.user_id = u.id) AS member_orgs,
                (SELECT array_agg(DISTINCT ai.organisation_id) FROM core.account_invite ai WHERE ai.user_id = u.id) AS invite_orgs,
                (SELECT w.organisation_id FROM core.manager_workspace w WHERE w.owner_user_id = u.id) AS workspace_org,
                (SELECT array_agg(DISTINCT m.organisation_id) FROM core.workspace_membership m WHERE m.user_id = u.id) AS ws_member_orgs
           FROM core."user" u JOIN core.manager_profile mp ON mp.user_id = u.id WHERE u.id = $1`,
        [im1UserId],
      );
      expect(row).toMatchObject({ user_org: org1.id, status: 'active', profile_org: org1.id, type: ManagerType.INTERNAL, is_initial_manager: true, workspace_org: org1.id, profile_ws: im1WorkspaceId });
      for (const orgs of [row.role_orgs, row.role_def_orgs, row.member_orgs, row.invite_orgs, row.ws_member_orgs]) expect(orgs).toEqual([org1.id]);
    });

    it('the session resolves Organisation 1 and the Initial Manager workspace (GET /auth/me, /manager-workspaces/me)', async () => {
      const me = await http().get('/rest/v1/auth/me').set(bearer(im1Token));
      expect(me.status).toBe(200);
      expect(me.body.organisationId).toBe(org1.id);
      const mine = await http().get('/rest/v1/manager-workspaces/me').set(bearer(im1Token));
      expect(mine.status).toBe(200);
      expect(mine.body.id).toBe(im1WorkspaceId);
    });
  });

  describe('Phase 4: the Organisation 1 Initial Manager cannot enter Organisation 2', () => {
    it('reads of Organisation 2 records by id are refused exactly like a non-existent id (404, or a categorical 403)', async () => {
      // No existence oracle: an Organisation 2 id must be indistinguishable from a random id. 403 is only acceptable when the
      // route refuses the caller categorically (a missing permission flag), which the random-id probe proves.
      const missing = '00000000-0000-4000-8000-000000000000';
      const probes: Array<[string, string]> = [
        ['/rest/v1/staff/', staff2.profileId!],
        ['/rest/v1/managers/', manager2.profileId!],
        ['/rest/v1/venues/', venue2Id],
        ['/rest/v1/roles/', `${org2SystemRoleId}/definition`],
        ['/rest/v1/manager-workspaces/', org2WorkspaceId],
      ];
      for (const [route, id] of probes) {
        const foreign = await http().get(`${route}${id}`).set(bearer(im1Token));
        const random = await http().get(`${route}${id.replace(/^[0-9a-f-]{36}/, missing)}`).set(bearer(im1Token));
        expect([route, foreign.status]).toEqual([route, random.status]);
        expect([route, [403, 404].includes(foreign.status)]).toEqual([route, true]);
      }
    });

    it('lists never include Organisation 2 rows (staff, managers, venues, members, invitations)', async () => {
      const lists = ['/rest/v1/staff', '/rest/v1/managers', '/rest/v1/venues', '/rest/v1/members', '/rest/v1/member-invitations'];
      const foreign = [staff2.profileId, manager2.profileId, venue2Id, manager2.userId, staff2.userId];
      for (const path of lists) {
        const res = await http().get(path).set(bearer(im1Token));
        expect([path, res.status < 500]).toEqual([path, true]);
        const body = JSON.stringify(res.body);
        for (const id of foreign) expect([path, body.includes(id!)]).toEqual([path, false]);
      }
    });

    it('mutations of Organisation 2 records return 404 and change nothing', async () => {
      const before = await adminDataSource.manager.query(`SELECT first_name FROM core."user" WHERE id = $1`, [manager2.userId]);
      const attempts: Array<[string, () => request.Test]> = [
        ['PATCH manager', () => http().patch(`/rest/v1/managers/${manager2.profileId}`).set(bearer(im1Token)).send({ firstName: 'Hijacked' })],
        ['PATCH venue', () => http().patch(`/rest/v1/venues/${venue2Id}`).set(bearer(im1Token)).send({ name: 'Hijacked' })],
        ['suspend member', () => http().post(`/rest/v1/members/${manager2.userId}/suspend`).set(bearer(im1Token)).send({})],
        ['change member role', () => http().patch(`/rest/v1/members/${manager2.userId}/role`).set(bearer(im1Token)).send({ roleId: org2SystemRoleId })],
      ];
      for (const [label, send] of attempts) {
        const res = await send();
        expect([label, [403, 404].includes(res.status)]).toEqual([label, true]);
      }
      const after = await adminDataSource.manager.query(`SELECT first_name FROM core."user" WHERE id = $1`, [manager2.userId]);
      expect(after).toEqual(before);
      const [venue] = await adminDataSource.manager.query(`SELECT name FROM core.venue WHERE id = $1`, [venue2Id]);
      expect(venue.name).not.toBe('Hijacked');
    });

    it('cannot invite a member into Organisation 2: a foreign role id is 404, an organisationId/workspaceId in the body is 400', async () => {
      const foreignRole = await http().post('/rest/v1/member-invitations').set(bearer(im1Token)).send({ emails: [`x-${unique()}@example.test`], roleId: org2SystemRoleId });
      expect(foreignRole.status).toBe(404);
      for (const extra of [{ organisationId: org2.id }, { workspaceId: org2WorkspaceId }]) {
        const res = await http().post('/rest/v1/member-invitations').set(bearer(im1Token)).send({ emails: [`x-${unique()}@example.test`], roleId: org2SystemRoleId, ...extra });
        expect(res.status).toBe(400);
      }
      const rows = await adminDataSource.manager.query(`SELECT count(*)::int AS n FROM core.member_invitation WHERE invited_by = $1`, [im1UserId]);
      expect(rows[0].n).toBe(0);
    });

    it('a member invitation acceptance cannot be redirected: organisationId/workspaceId in the accept body is 400', async () => {
      for (const extra of [{ organisationId: org2.id }, { workspaceId: org2WorkspaceId }]) {
        const res = await http().post('/rest/v1/invitations/accept').send({ token: 'a'.repeat(64), firstName: 'A', lastName: 'B', newPassword: 'Member1!Pass', ...extra });
        expect(res.status).toBe(400);
      }
    });

    it('cannot create a second workspace, nor one under Organisation 2 (organisationId in the body is 400)', async () => {
      const forged = await http().post('/rest/v1/manager-workspaces').set(bearer(im1Token)).send({ name: 'Forged', subdomain: `forged-${unique()}`, organisationId: org2.id });
      expect(forged.status).toBe(400);
      const second = await http().post('/rest/v1/manager-workspaces').set(bearer(im1Token)).send({ name: 'Second', subdomain: `second-${unique()}` });
      expect(second.status).toBeGreaterThanOrEqual(400);
      const rows = await adminDataSource.manager.query(`SELECT organisation_id FROM core.manager_workspace WHERE owner_user_id = $1`, [im1UserId]);
      expect(rows).toEqual([{ organisation_id: org1.id }]);
    });

    it('forged tenant headers, query parameters and a tampered token never change the session organisation', async () => {
      const me = await http().get('/rest/v1/auth/me').set(bearer(im1Token)).set('x-organisation-id', org2.id).set('x-workspace-id', org2WorkspaceId).set('x-tenant-id', org2.id);
      expect(me.status).toBe(200);
      expect(me.body.organisationId).toBe(org1.id);
      const staffQuery = await http().get(`/rest/v1/staff?organisationId=${org2.id}`).set(bearer(im1Token));
      expect(staffQuery.status).toBe(400);
      const [header, payload, signature] = im1Token.split('.');
      const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString());
      const tampered = `${header}.${Buffer.from(JSON.stringify({ ...claims, org: org2.id })).toString('base64url')}.${signature}`;
      const res = await http().get('/rest/v1/auth/me').set(bearer(tampered));
      expect(res.status).toBe(401);
    });

    it('20 concurrent cross-organisation reads all fail (no racing past the tenant boundary, warm cache or not)', async () => {
      const results = await Promise.all(Array.from({ length: 20 }, (_, i) =>
        http().get(i % 2 ? `/rest/v1/staff/${staff2.profileId}` : `/rest/v1/venues/${venue2Id}`).set(bearer(im1Token))));
      expect(results.map((r) => r.status)).toEqual(Array(20).fill(404));
    });

    it('Organisation 2 managers cannot see the Organisation 1 Initial Manager either', async () => {
      const res = await http().get('/rest/v1/managers').set(bearer(manager2Token));
      expect(JSON.stringify(res.body)).not.toContain(im1Email);
    });
  });

  describe('Platform Admin: organisation + CEO onboarding kept; Initial Manager onboarding same-organisation only', () => {
    let pa: TestIdentity;
    let paToken: string;
    let paOrg: { id: string };

    beforeAll(async () => {
      paOrg = await factory.createOrganisation('crewflow-admin-iso');
      pa = await factory.createCeo(paOrg, { permissions: 'all', platformAdmin: true });
      paToken = await factory.login(pa);
    });

    it('11. can still start a new organisation through the authorised path (email-only CEO invitation; the CEO accepts)', async () => {
      const ceoEmail = `ceo-${unique()}@example.test`;
      const name = `New Org ${unique()}`;
      const sent = await http().post('/rest/v1/admin/organisation-invitations').set(bearer(paToken)).send({ email: ceoEmail });
      expect(sent.body.outcome).toBe('invited');
      const [row] = await adminDataSource.manager.query(`SELECT rendered_text, rendered_html FROM core.email_outbox WHERE recipient_email = $1`, [ceoEmail]);
      const token = decodeURIComponent(/token=([A-Za-z0-9_-]{20,})/.exec(`${row.rendered_text ?? ''} ${row.rendered_html ?? ''}`)![1]!);
      const accepted = await http().post('/rest/v1/invitations/accept').send({ token, firstName: 'C', lastName: 'E', organisationName: name, newPassword: 'CeoActivation1!' });
      expect(accepted.status).toBe(200);
      const [org] = await adminDataSource.manager.query(`SELECT id FROM core.organisation WHERE name = $1`, [name]);
      const [ceo] = await adminDataSource.manager.query(`SELECT mp.type, mp.organisation_id FROM core.manager_profile mp JOIN core."user" u ON u.id = mp.user_id WHERE u.email = $1`, [ceoEmail]);
      expect(ceo).toEqual({ type: ManagerType.CEO, organisation_id: org.id });
    });

    it('12–16. every former cross-organisation Initial Manager route is gone (404) and writes nothing into Organisation 2', async () => {
      const email = `foreign-im-${unique()}@example.test`;
      const body = { email, firstName: 'F', lastName: 'M' };
      for (const suffix of ['', '/resend', '/revoke', '/replace']) {
        const res = await http().post(`/rest/v1/admin/organisations/${org2.id}/initial-manager-invite${suffix}`).set(bearer(paToken))
          .send(suffix === '' ? body : suffix === '/replace' ? { ...body, expectedProfileId: manager2.profileId } : {});
        expect([suffix, res.status]).toEqual([suffix, 404]);
      }
      expect(await adminDataSource.manager.query(`SELECT id FROM core."user" WHERE email = $1`, [email])).toEqual([]);
    });

    it('12. the same-organisation route ignores any client-supplied organisation (organisationId in the body is 400)', async () => {
      const res = await http().post('/rest/v1/managers/initial-manager-invite').set(bearer(paToken)).send({ email: `x-${unique()}@example.test`, firstName: 'X', lastName: 'Y', organisationId: org2.id });
      expect(res.status).toBe(400);
    });

    it('13–16. service layer (jobs/CLIs bypass guards): a forged actor organisation is refused for invite, resend, revoke and replace', async () => {
      const forged = { userId: pa.userId, organisationId: org2.id };
      const dto = { email: `svc-${unique()}@example.test`, firstName: 'S', lastName: 'V' };
      await expect(onboarding.inviteInitialManager(forged, dto)).rejects.toMatchObject({ status: 404 });
      await expect(onboarding.resendInitialManagerInvite(forged)).rejects.toMatchObject({ status: 404 });
      await expect(onboarding.revokeInitialManagerInvite(forged)).rejects.toMatchObject({ status: 404 });
      await expect(onboarding.replaceInitialManager(forged, { ...dto, expectedProfileId: manager2.profileId! })).rejects.toMatchObject({ status: 404 });
      await expect(onboarding.inviteInitialManager({ userId: pa.userId, organisationId: null }, dto)).rejects.toMatchObject({ status: 404 });
      await expect(onboarding.inviteInitialManager({ userId: pa.userId, organisationId: paOrg.id, inspectedBy: pa.userId }, dto)).rejects.toMatchObject({ status: 403 });
      expect(await adminDataSource.manager.query(`SELECT id FROM core."user" WHERE email = $1`, [dto.email])).toEqual([]);
    });

    it('17. a Platform Admin with no leadership role in their own organisation cannot use Initial Manager Add (403)', async () => {
      const bareOrg = await factory.createOrganisation('pa-bare');
      const bare = await factory.createOrgAdmin(bareOrg, { permissions: [], platformAdmin: true });
      const token = await factory.login(bare);
      const res = await http().post('/rest/v1/managers/initial-manager-invite').set(bearer(token)).send({ email: `b-${unique()}@example.test`, firstName: 'B', lastName: 'A' });
      expect(res.status).toBe(403);
      const caps = await http().get('/rest/v1/leadership/capabilities').set(bearer(token));
      expect(caps.body).toEqual({ leadership: { canCreateOrganisation: true, initialManagerScope: 'none' } });
    });

    it('18. a Platform Admin can onboard the Initial Manager of their OWN organisation only, bound to that organisation', async () => {
      const email = `own-im-${unique()}@example.test`;
      const res = await http().post('/rest/v1/managers/initial-manager-invite').set(bearer(paToken)).send({ email, firstName: 'O', lastName: 'M' });
      expect(res.status).toBe(201);
      const [row] = await adminDataSource.manager.query(`SELECT u.organisation_id, mp.is_initial_manager FROM core."user" u JOIN core.manager_profile mp ON mp.user_id = u.id WHERE u.email = $1`, [email]);
      expect(row).toEqual({ organisation_id: paOrg.id, is_initial_manager: true });
      const caps = await http().get('/rest/v1/leadership/capabilities').set(bearer(paToken));
      expect(caps.body).toEqual({ leadership: { canCreateOrganisation: true, initialManagerScope: 'own' } });
    });

    it('platform-level organisation detail no longer exposes another organisation\'s Initial Manager', async () => {
      const res = await http().get(`/rest/v1/admin/organisations/${org1.id}`).set(bearer(paToken));
      expect(res.status).toBe(200);
      expect(res.body.initialManager).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toContain(im1Email);
    });
  });

  describe('CEO: own organisation only', () => {
    it('19/23. CEO capabilities are Initial Manager (own organisation) only; no organisation creation', async () => {
      const caps = await http().get('/rest/v1/leadership/capabilities').set(bearer(ceo1Token));
      expect(caps.body).toEqual({ leadership: { canCreateOrganisation: false, initialManagerScope: 'own' } });
    });

    it('19. a second Initial Manager for the same organisation is refused (409) — one current Initial Manager slot', async () => {
      const res = await http().post('/rest/v1/managers/initial-manager-invite').set(bearer(ceo1Token)).send({ email: `dup-${unique()}@example.test`, firstName: 'D', lastName: 'U' });
      expect(res.status).toBe(409);
    });

    it('20. a CEO cannot target Organisation 2 (former admin route 404; organisation management 403)', async () => {
      const res = await http().post(`/rest/v1/admin/organisations/${org2.id}/initial-manager-invite`).set(bearer(ceo1Token)).send({ email: `c-${unique()}@example.test`, firstName: 'C', lastName: 'X' });
      expect(res.status).toBe(404);
      expect((await http().get('/rest/v1/admin/organisations').set(bearer(ceo1Token))).status).toBe(403);
      expect((await http().post('/rest/v1/admin/organisations').set(bearer(ceo1Token)).send({ name: 'N', ceoEmail: `n-${unique()}@example.test`, ceoFirstName: 'N', ceoLastName: 'N' })).status).toBe(404); // retired route
      expect((await http().post('/rest/v1/admin/organisation-invitations').set(bearer(ceo1Token)).send({ email: `n-${unique()}@example.test` })).status).toBe(403);
    });

    it('21. Initial Manager Add cannot create a CEO (a type field is 400)', async () => {
      const res = await http().post('/rest/v1/managers/initial-manager-invite').set(bearer(ceo1Token)).send({ email: `t-${unique()}@example.test`, firstName: 'T', lastName: 'C', type: ManagerType.CEO });
      expect(res.status).toBe(400);
    });

    it('22. a CEO cannot grant platform administrator authority', async () => {
      const res = await http().post(`/rest/v1/admin/platform-admins/${im1UserId}`).set(bearer(ceo1Token)).send({ currentPassword: ceo1.password });
      expect(res.status).toBe(403);
      const rows = await adminDataSource.manager.query(`SELECT 1 FROM core.platform_admin WHERE user_id = $1`, [im1UserId]);
      expect(rows).toEqual([]);
    });
  });

  describe('Initial Manager: Invite only, workspace-scoped, no leadership', () => {
    it('23. capabilities expose no Add; the Initial Manager routes refuse (403)', async () => {
      const caps = await http().get('/rest/v1/leadership/capabilities').set(bearer(im1Token));
      expect(caps.body).toEqual({ leadership: { canCreateOrganisation: false, initialManagerScope: 'none' } });
      for (const path of ['', '/resend', '/revoke']) {
        const res = await http().post(`/rest/v1/managers/initial-manager-invite${path}`).set(bearer(im1Token)).send(path ? {} : { email: `l-${unique()}@example.test`, firstName: 'L', lastName: 'D' });
        expect([path, [403, 404].includes(res.status)]).toEqual([path, true]);
      }
    });

    it('25–27. assignable roles are only this workspace\'s custom roles; a system (leadership) role id is refused (404)', async () => {
      const assignable = await http().get('/rest/v1/member-invitations/assignable-roles').set(bearer(im1Token));
      expect(assignable.status).toBe(200);
      const ids: string[] = (assignable.body.roles ?? assignable.body).map((r: { id: string }) => r.id);
      const [{ id: ownSystemRole }] = await adminDataSource.manager.query(`SELECT r.id FROM core.user_role ur JOIN core.role r ON r.id = ur.role_id WHERE ur.user_id = $1 LIMIT 1`, [im1UserId]);
      expect(ids).not.toContain(ownSystemRole);
      expect(ids).not.toContain(org2SystemRoleId);
      const leadership = await http().post('/rest/v1/member-invitations').set(bearer(im1Token)).send({ emails: [`lead-${unique()}@example.test`], roleId: ownSystemRole });
      expect(leadership.status).toBe(404);
    });
  });

  describe('Database layer (RLS + constraints): the platform-admin bypass no longer reaches Initial Managers or workspaces', () => {
    let pa: TestIdentity;
    beforeAll(async () => {
      pa = await factory.createCeo(await factory.createOrganisation('pa-rls'), { permissions: 'all', platformAdmin: true });
    });

    it('a platform-admin identity bound to Organisation 2 cannot INSERT an internal (Initial) Manager profile there', async () => {
      // staff2's user belongs to Organisation 2 and has no manager profile: the ONLY thing standing in the way is RLS.
      const attempt = tenantContext.runInTenantContext({ organisationId: org2.id, workspaceId: null, userId: pa.userId, role: '' }, (m) =>
        m.query(`INSERT INTO core.manager_profile (organisation_id, user_id, type, is_initial_manager) VALUES ($1, $2, 'internal', true) RETURNING id`, [org2.id, staff2.userId]));
      await expect(attempt).rejects.toThrow(/row-level security/);
      const rows = await adminDataSource.manager.query(`SELECT count(*)::int AS n FROM core.manager_profile WHERE organisation_id = $1 AND is_initial_manager`, [org2.id]);
      expect(rows[0].n).toBe(0);
    });

    it('a platform-admin identity cannot SELECT or UPDATE another organisation\'s manager workspace', async () => {
      const seen = await tenantContext.runInTenantContext({ organisationId: org2.id, workspaceId: null, userId: pa.userId, role: '' }, (m) =>
        m.query(`SELECT id FROM core.manager_workspace WHERE id = $1`, [org2WorkspaceId]));
      expect(seen).toEqual([]);
      const updated = await tenantContext.runInTenantContext({ organisationId: org2.id, workspaceId: null, userId: pa.userId, role: '' }, (m) =>
        m.query(`UPDATE core.manager_workspace SET name = 'Hijacked' WHERE id = $1 RETURNING id`, [org2WorkspaceId]));
      // TypeORM returns [rows, affectedCount] for UPDATE ... RETURNING: nothing visible, nothing changed.
      expect(updated).toEqual([[], 0]);
      const [ws] = await adminDataSource.manager.query(`SELECT name FROM core.manager_workspace WHERE id = $1`, [org2WorkspaceId]);
      expect(ws.name).not.toBe('Hijacked');
    });

    it('composite organisation keys reject a profile, workspace, role grant or membership pointing at another organisation', async () => {
      // A Manager who has not created a workspace yet (workspace_id NULL), so the workspace-binding trigger is not what refuses it.
      const unbound = await factory.createInternalManager(await factory.createOrganisation('fk-unbound'), { permissions: 'all', workspace: false });
      const cases = [
        [`INSERT INTO core.manager_profile (organisation_id, user_id, type) VALUES ($1, $2, 'internal')`, [org1.id, staff2.userId]],
        [`UPDATE core.manager_profile SET workspace_id = $2 WHERE user_id = $1`, [unbound.userId, org2WorkspaceId]],
        [`INSERT INTO core.manager_workspace (organisation_id, owner_user_id, name, subdomain) VALUES ($1, $2, 'X', $3)`, [org1.id, staff2.userId, `fk-${unique()}`]],
        [`INSERT INTO core.user_role (user_id, role_id, organisation_id) VALUES ($1, $2, $3)`, [im1UserId, org2SystemRoleId, org2.id]],
        [`INSERT INTO core.organisation_member (organisation_id, user_id) VALUES ($1, $2)`, [org2.id, im1UserId]],
      ] as const;
      for (const [sql, params] of cases) {
        await expect([sql, await adminDataSource.manager.query(sql, [...params]).then(() => 'accepted', (e: Error) => e.message)])
          .toEqual([sql, expect.stringMatching(/foreign key|violates/)]);
      }
    });

    it('one current Initial Manager per organisation, and only ever an internal Manager, are database invariants', async () => {
      const org = await factory.createOrganisation('im-invariant');
      const ceo = await factory.createCeo(org, { permissions: 'all' });
      const [first, second] = [
        await factory.createInternalManager(org, { permissions: 'all', workspace: false }),
        await factory.createInternalManager(org, { permissions: 'all', workspace: false }),
      ];
      await adminDataSource.manager.query(`UPDATE core.manager_profile SET is_initial_manager = true WHERE id = $1`, [first!.profileId]);
      await expect(adminDataSource.manager.query(`UPDATE core.manager_profile SET is_initial_manager = true WHERE id = $1`, [second!.profileId]))
        .rejects.toThrow(/manager_profile_one_current_initial_manager/);
      await expect(adminDataSource.manager.query(`UPDATE core.manager_profile SET is_initial_manager = true WHERE id = $1`, [ceo.profileId]))
        .rejects.toThrow(/manager_profile_initial_manager_is_internal/);
    });
  });

  describe('Login resolves exactly one organisation', () => {
    it('the same email with the same password in two organisations is refused as ambiguous, never signed into either silently', async () => {
      // Two real accounts (role, active) in two organisations; the factory gives both the same password. Then give B A's email.
      const a = await factory.createOrgAdmin(await factory.createOrganisation('twin-a'), { permissions: 'all' });
      const b = await factory.createOrgAdmin(await factory.createOrganisation('twin-b'), { permissions: 'all' });
      // New accounts can no longer share an address across organisations, so this is a HISTORICAL (pre-policy) duplicate.
      await factory.makeHistoricalDuplicateEmail(b.userId, a.email);
      const res = await http().post('/rest/v1/auth/login').send({ email: a.email, password: a.password });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('AMBIGUOUS_ACCOUNTS');
      expect(res.body.accessToken).toBeUndefined();
    });
  });
});
