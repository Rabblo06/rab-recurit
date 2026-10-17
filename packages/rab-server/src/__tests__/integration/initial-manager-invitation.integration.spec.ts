import 'reflect-metadata';
import { ManagerType } from '@rab/shared';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { ThrottlerRedisClientProvider } from '../../engine/core-modules/throttler/throttler-redis-client.provider';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { EnvironmentService } from '../../engine/core-modules/environment/environment.service';
import { WORKER_HEARTBEAT_KEY } from '../../engine/worker-shared/heartbeat.constants';
import { OrganisationOnboardingService } from '../../modules/manager/services/organisation-onboarding.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentityFactory } from './helpers/test-identities';

/**
 * P2.9C, reversed by the universal-self-service-onboarding checkpoint (docs/HANDOFF.md): the
 * inviter no longer names the workspace — the Initial Manager self-services their own workspace
 * name/subdomain after activating, through the same path an ordinary Add-Manager account already
 * uses. Real Postgres, RLS on, no mocks.
 *
 * Organisation isolation (owner policy, 2026-10-15) supersedes P2.9C's "Super Admin side, any organisation": Initial Manager
 * onboarding is same-organisation only. The flows below run as the target organisation's OWN CEO on
 * `/managers/initial-manager-invite*`; the former `/admin/organisations/:id/initial-manager-invite*` routes are removed and their
 * tests now assert that denial (full matrix: `organisation-isolation.integration.spec.ts`).
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('initial manager invitation (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let factory: TestIdentityFactory;
  let passwordHashing: PasswordHashingService;
  let tenantContext: TenantContextService;
  let onboarding: OrganisationOnboardingService;

  const http = () => request(app.getHttpServer());

  async function seedPlatformAdmin(): Promise<{ email: string; userId: string }> {
    const organisation = await factory.createOrganisation();
    const user = await factory.createInternalManager(organisation, { permissions: 'all', label: 'super-admin' });
    await adminDataSource.manager.query(`INSERT INTO core.platform_admin (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [user.userId]);
    return { email: user.email, userId: user.userId };
  }

  async function seedCeo(): Promise<{ email: string; organisationId: string }> {
    const organisation = await factory.createOrganisation();
    const ceo = await factory.createInternalManager(organisation, { permissions: 'all', type: ManagerType.CEO, label: 'ceo' });
    return { email: ceo.email, organisationId: organisation.id };
  }

  /** The organisation under test plus its OWN CEO — the only kind of actor that may onboard its Initial Manager. */
  async function seedTargetWithCeo(): Promise<{ target: { id: string; slug: string }; actorToken: string; actor: { userId: string; organisationId: string } }> {
    const target = await factory.createOrganisation();
    const ceo = await factory.createInternalManager(target, { permissions: 'all', type: ManagerType.CEO, label: `ceo-${Date.now()}` });
    return { target, actorToken: await factory.loginByEmail(ceo.email), actor: { userId: ceo.userId, organisationId: target.id } };
  }

  function inviteBody(suffix: string) {
    return { email: `im-${suffix}@example.test`, firstName: 'Ida', lastName: 'Manager' };
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    dataSource = moduleRef.get(DataSource);
    passwordHashing = moduleRef.get(PasswordHashingService);
    tenantContext = moduleRef.get(TenantContextService);
    onboarding = moduleRef.get(OrganisationOnboardingService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = new TestIdentityFactory({ app, dataSource, adminDataSource, tenantContext, passwordHashing });

    const redisClient = moduleRef.get(ThrottlerRedisClientProvider);
    await redisClient.client.set(WORKER_HEARTBEAT_KEY, Date.now().toString(), 'EX', 300);
  });

  afterAll(async () => {
    await app.close();
    await adminDataSource.destroy();
  });

  describe('same-organisation actor (the organisation\'s own CEO) — formerly "platform admin side"', () => {
    it('a platform admin of ANOTHER organisation can no longer invite this organisation\'s Initial Manager: the former route is gone and nothing is written', async () => {
      const admin = await seedPlatformAdmin();
      const adminToken = await factory.loginByEmail(admin.email);
      const target = await factory.createOrganisation();
      const suffix = `${Date.now()}-foreign-admin`;
      for (const path of ['', '/resend', '/revoke']) {
        const res = await http().post(`/rest/v1/admin/organisations/${target.id}/initial-manager-invite${path}`).set('Authorization', `Bearer ${adminToken}`).send(path ? {} : inviteBody(suffix));
        expect([path, res.status]).toEqual([path, 404]);
      }
      const rows = await adminDataSource.manager.query(`SELECT id FROM core."user" WHERE email = $1`, [`im-${suffix}@example.test`]);
      expect(rows).toEqual([]);
    });

    it('creates the Initial Manager and a queued invite, with no workspace yet — the recipient self-services one after activating', async () => {
      const { target, actorToken } = await seedTargetWithCeo();
      const suffix = `${Date.now()}`;

      const res = await http()
        .post(`/rest/v1/managers/initial-manager-invite`)
        .set('Authorization', `Bearer ${actorToken}`)
        .send(inviteBody(suffix));

      expect(res.status).toBe(201);
      expect(res.body.workspace).toBeUndefined();

      const [user] = await adminDataSource.manager.query(`SELECT id, status, password_hash FROM core."user" WHERE organisation_id = $1 AND email = $2`, [
        target.id,
        `im-${suffix}@example.test`,
      ]);
      expect(user.status).toBe('invited');
      expect(user.password_hash).toBeNull();

      const [profile] = await adminDataSource.manager.query(`SELECT workspace_id, type, is_initial_manager FROM core.manager_profile WHERE user_id = $1`, [user.id]);
      expect(profile.type).toBe('internal');
      expect(profile.is_initial_manager).toBe(true);
      expect(profile.workspace_id).toBeNull();

      const workspaceRows = await adminDataSource.manager.query(`SELECT id FROM core.manager_workspace WHERE owner_user_id = $1`, [user.id]);
      expect(workspaceRows).toHaveLength(0);

      const [invite] = await adminDataSource.manager.query(`SELECT id FROM core.account_invite WHERE user_id = $1 AND accepted_at IS NULL`, [user.id]);
      expect(invite).toBeDefined();
      const [outboxRow] = await adminDataSource.manager.query(`SELECT rendered_subject FROM core.email_outbox WHERE account_invite_id = $1`, [invite.id]);
      expect(outboxRow.rendered_subject).toMatch(/manage your organisation/i);
    });

    it('a second Initial Manager invite for the same organisation is rejected (409) once one already exists', async () => {
      const { target, actorToken } = await seedTargetWithCeo();
      const suffix = `${Date.now()}-dup`;

      await http()
        .post(`/rest/v1/managers/initial-manager-invite`)
        .set('Authorization', `Bearer ${actorToken}`)
        .send(inviteBody(suffix));

      const second = await http()
        .post(`/rest/v1/managers/initial-manager-invite`)
        .set('Authorization', `Bearer ${actorToken}`)
        .send(inviteBody(`${suffix}-second`));
      expect(second.status).toBe(409);
    });

    it('rejects an invite body carrying unexpected workspace fields (subdomain/workspaceName are no longer part of this contract)', async () => {
      const { target, actorToken } = await seedTargetWithCeo();
      const suffix = `${Date.now()}-stray-fields`;

      const res = await http()
        .post(`/rest/v1/managers/initial-manager-invite`)
        .set('Authorization', `Bearer ${actorToken}`)
        .send({ ...inviteBody(suffix), workspaceName: 'Should be rejected', subdomain: 'should-be-rejected' });
      expect(res.status).toBe(400);
    });

    it('resend advances sendNumber; revoke clears the password', async () => {
      const { target, actorToken } = await seedTargetWithCeo();
      const suffix = `${Date.now()}-rr`;

      await http()
        .post(`/rest/v1/managers/initial-manager-invite`)
        .set('Authorization', `Bearer ${actorToken}`)
        .send(inviteBody(suffix));

      const [user] = await adminDataSource.manager.query(`SELECT id FROM core."user" WHERE organisation_id = $1 AND email = $2`, [
        target.id,
        `im-${suffix}@example.test`,
      ]);
      await tenantContext.runInTenantContext({ organisationId: target.id, workspaceId: null, userId: user.id, role: '' }, (manager) =>
        manager.query(`UPDATE core.email_outbox SET status = 'SENT', sent_at = now() WHERE target_user_id = $1 AND status IN ('PENDING','QUEUED','PROCESSING','RETRY')`, [
          user.id,
        ]),
      );

      const resend = await http()
        .post(`/rest/v1/managers/initial-manager-invite/resend`)
        .set('Authorization', `Bearer ${actorToken}`);
      expect(resend.status).toBe(201);
      expect(resend.body.sendNumber).toBe(2);

      const revoke = await http()
        .post(`/rest/v1/managers/initial-manager-invite/revoke`)
        .set('Authorization', `Bearer ${actorToken}`);
      expect(revoke.status).toBe(201);

      const [afterRevoke] = await adminDataSource.manager.query(`SELECT password_hash FROM core."user" WHERE id = $1`, [user.id]);
      expect(afterRevoke.password_hash).toBeNull();
    });
  });

  describe('CEO side', () => {
    it("a CEO can invite their own organisation's Initial Manager", async () => {
      const ceo = await seedCeo();
      const ceoToken = await factory.loginByEmail(ceo.email);
      const suffix = `${Date.now()}-ceo`;

      const res = await http().post('/rest/v1/managers/initial-manager-invite').set('Authorization', `Bearer ${ceoToken}`).send(inviteBody(suffix));
      expect(res.status).toBe(201);

      const [user] = await adminDataSource.manager.query(`SELECT id FROM core."user" WHERE organisation_id = $1 AND email = $2`, [
        ceo.organisationId,
        `im-${suffix}@example.test`,
      ]);
      expect(user).toBeDefined();
    });

    it('an ordinary (non-CEO) Internal Manager holding MANAGER_MANAGE cannot invite an Initial Manager', async () => {
      const organisation = await factory.createOrganisation();
      const mgr = await factory.createInternalManager(organisation, { permissions: 'all', label: 'plain-mgr' });
      const mgrToken = await factory.loginByEmail(mgr.email);

      const res = await http()
        .post('/rest/v1/managers/initial-manager-invite')
        .set('Authorization', `Bearer ${mgrToken}`)
        .send(inviteBody(`${Date.now()}-blocked`));
      expect(res.status).toBe(403);
    });

    it("a CEO cannot invite an Initial Manager for a DIFFERENT organisation (the former Super-Admin-side route is gone: 404)", async () => {
      const ceo = await seedCeo();
      const ceoToken = await factory.loginByEmail(ceo.email);
      const otherOrg = await factory.createOrganisation();

      const res = await http()
        .post(`/rest/v1/admin/organisations/${otherOrg.id}/initial-manager-invite`)
        .set('Authorization', `Bearer ${ceoToken}`)
        .send(inviteBody(`${Date.now()}-crossorg`));
      // Superseded: 403 from PlatformAdminGuard. The route no longer exists for anyone.
      expect(res.status).toBe(404);
    });
  });

  describe('full acceptance loop and self-service workspace creation', () => {
    it('the Initial Manager can activate, log in, has no workspace yet, then self-services one through the ordinary POST /manager-workspaces path', async () => {
      const { target, actorToken } = await seedTargetWithCeo();
      const suffix = `${Date.now()}-activate`;
      const email = `im-${suffix}@example.test`;

      const created = await http()
        .post(`/rest/v1/managers/initial-manager-invite`)
        .set('Authorization', `Bearer ${actorToken}`)
        .send(inviteBody(suffix));
      expect(created.status).toBe(201);

      const [user] = await adminDataSource.manager.query(`SELECT id FROM core."user" WHERE organisation_id = $1 AND email = $2`, [target.id, email]);
      const [invite] = await adminDataSource.manager.query(`SELECT id FROM core.account_invite WHERE user_id = $1`, [user.id]);
      const [outboxRow] = await adminDataSource.manager.query(`SELECT rendered_html FROM core.email_outbox WHERE account_invite_id = $1`, [invite.id]);
      const match = /token=([a-f0-9]+)/.exec(outboxRow.rendered_html);
      if (!match) throw new Error('Could not find activation token in rendered outbox email.');

      const activate = await http().post('/rest/v1/auth/activate-account').send({ token: match[1], newPassword: 'InitialMgr1!' });
      expect(activate.status).toBe(200);

      const login = await http().post('/rest/v1/auth/login').send({ email, password: 'InitialMgr1!', applicationTarget: 'manager_web' });
      expect(login.status).toBe(200);

      // No workspace was pre-created at invite time — a genuinely absent workspace, not a loading state.
      const mineBefore = await http().get('/rest/v1/manager-workspaces/me').set('Authorization', `Bearer ${login.body.accessToken}`);
      expect(mineBefore.status).toBe(404);

      // The same self-service path an ordinary Add-Manager account already uses.
      const createdWorkspace = await http()
        .post('/rest/v1/manager-workspaces')
        .set('Authorization', `Bearer ${login.body.accessToken}`)
        .send({ name: `Workspace ${suffix}`, subdomain: `ws-${suffix}` });
      expect(createdWorkspace.status).toBe(201);
      expect(createdWorkspace.body.schemaStatus).toBe('CREATING');

      const mineAfter = await http().get('/rest/v1/manager-workspaces/me').set('Authorization', `Bearer ${login.body.accessToken}`);
      expect(mineAfter.status).toBe(200);
      expect(mineAfter.body.id).toBe(createdWorkspace.body.id);
    });
  });

  describe('activation → web sign-in → reload (2026-10-15 activation/reload report)', () => {
    it('reports the Initial Manager and "accepted" before first sign-in, then a cookie-only reload and second tab keep the same session', async () => {
      const { target, actorToken } = await seedTargetWithCeo();
      const suffix = `${Date.now()}-reload`;
      const email = `im-${suffix}@example.test`;
      expect((await http().post('/rest/v1/managers/initial-manager-invite').set('Authorization', `Bearer ${actorToken}`).send(inviteBody(suffix))).status).toBe(201);

      const [user] = await adminDataSource.manager.query(`SELECT id FROM core."user" WHERE organisation_id = $1 AND email = $2`, [target.id, email]);
      const [invite] = await adminDataSource.manager.query(`SELECT id FROM core.account_invite WHERE user_id = $1`, [user.id]);
      const [outboxRow] = await adminDataSource.manager.query(`SELECT rendered_html FROM core.email_outbox WHERE account_invite_id = $1`, [invite.id]);
      const token = /token=([a-f0-9]+)/.exec(outboxRow.rendered_html)![1]!;

      const activate = await http().post('/rest/v1/auth/activate-account').send({ token, newPassword: 'InitialMgr1!' });
      expect(activate.status).toBe(200);
      // The Initial Manager is a WEB user: the success screen must send them to the Manager Portal, never the mobile app.
      expect(activate.body.applicationTarget).toBe('manager_web');
      expect(activate.body.managerLoginUrl).toMatch(/\/login$/);

      const managersBefore = await http().get('/rest/v1/managers').set('Authorization', `Bearer ${actorToken}`);
      const rowBefore = (managersBefore.body.data as Array<Record<string, unknown>>).find((m) => m.email === email)!;
      expect(rowBefore).toMatchObject({ type: 'internal', isInitialManager: true, accountStatus: 'invited', invitationStatus: 'accepted' });

      // A replayed activation link is refused (single use).
      expect((await http().post('/rest/v1/auth/activate-account').send({ token, newPassword: 'Another1!pass' })).status).toBe(400);

      const origin = app.get(EnvironmentService).corsOrigins[0]!;
      const login = await http().post('/rest/v1/auth/login').set('Origin', origin).send({ email, password: 'InitialMgr1!' });
      expect(login.status).toBe(200);
      const cookie = String(login.headers['set-cookie']).match(/crewflow_session=([^;]+)/)![1]!;

      // Reload = a fresh page load with only the browser's cookie (no in-memory token); a second tab is the same cookie jar.
      const meReload = await http().get('/rest/v1/auth/me').set('Cookie', `crewflow_session=${cookie}`);
      expect(meReload.status).toBe(200);
      expect(meReload.body).toMatchObject({ email, organisationId: target.id, applicationTarget: 'manager_web' });
      const meSecondTab = await http().get('/rest/v1/auth/me').set('Cookie', `crewflow_session=${cookie}`);
      expect(meSecondTab.status).toBe(200);
      expect(meSecondTab.body.sessionId).toBe(meReload.body.sessionId);

      const managersAfter = await http().get('/rest/v1/managers').set('Authorization', `Bearer ${actorToken}`);
      const rowAfter = (managersAfter.body.data as Array<Record<string, unknown>>).find((m) => m.email === email)!;
      expect(rowAfter).toMatchObject({ isInitialManager: true, accountStatus: 'active', invitationStatus: null });
    });
  });

  describe('attempt exhaustion — no longer a dead end for a fresh invite', () => {
    /**
     * P2.9 gap review originally found this a confirmed dead end: once `sendNumber` reached
     * `MAX_SEND_ATTEMPTS` (3), resend was refused (expected) AND the never-activated row could not
     * be deleted either, because `UserDeletionService.assertCanDelete`'s `MANAGER_OWNS_WORKSPACE`
     * check fired for ANY manager who owned a `manager_workspace` row — and the OLD invite-time
     * model created that workspace the moment the invite was sent, long before acceptance. The
     * universal-self-service-onboarding checkpoint (docs/HANDOFF.md) incidentally resolves this
     * for every NEW invitation going forward: no workspace exists until the recipient self-services
     * one after activating, so a never-activated, maxed-out Initial Manager invite now has no
     * `manager_workspace` row to collide with deletion at all. The elaborate
     * `replaceInitialManager` machinery (cooldown, replacement caps, `SUPERSEDED` fencing) remains
     * in place as the recovery path for OLD, pre-existing invites that DO still have a
     * pre-provisioned workspace (see `initial-manager-replacement.integration.spec.ts`) — this test
     * now proves the simpler, already-existing `DELETE /managers/:id` path is sufficient for a
     * fresh one.
     *
     * Deletes as the organisation's own CEO (same-org), not the cross-org Platform Admin the
     * earlier `MANAGER_OWNS_WORKSPACE` version of this test used — deliberately. Investigating the
     * 404 this produced under a cross-org admin actor surfaced a SEPARATE, pre-existing gap:
     * `core.user`'s RLS SELECT policy has no platform-admin cross-org bypass branch (unlike
     * `manager_profile`'s own, added by `ManagerProfilePlatformAdminRls`) — a cross-org admin
     * delete was always latently broken here, it simply never reached `UserDeletionService` before
     * now, because `assertCanDelete`'s `MANAGER_OWNS_WORKSPACE` check always threw first for any
     * Initial Manager under the old invite-time-workspace model. Out of scope for this checkpoint
     * (a separate RLS gap, not something this reconciliation introduced or is positioned to fix
     * safely here) — flagged in the exit report, not silently patched. The CEO-actor version below
     * is also the more realistic recovery path in practice: an organisation's own CEO cleaning up
     * their own stuck invitation, not a platform admin reaching into another org via the generic
     * (same-org-scoped by RLS) manager route.
     */
    it('a maxed-out invite with no workspace yet can be deleted directly by the organisation\'s own CEO — ordinary recovery, no replacement needed', async () => {
      const { target, actorToken } = await seedTargetWithCeo();
      const ceoToken = actorToken;
      const suffix = `${Date.now()}-exhausted`;

      const created = await http()
        .post(`/rest/v1/managers/initial-manager-invite`)
        .set('Authorization', `Bearer ${actorToken}`)
        .send(inviteBody(suffix));
      expect(created.status).toBe(201);

      const [user] = await adminDataSource.manager.query(`SELECT id FROM core."user" WHERE organisation_id = $1 AND email = $2`, [
        target.id,
        `im-${suffix}@example.test`,
      ]);
      const [profile] = await adminDataSource.manager.query(`SELECT id FROM core.manager_profile WHERE user_id = $1`, [user.id]);

      async function markLatestSent() {
        await tenantContext.runInTenantContext({ organisationId: target.id, workspaceId: null, userId: user.id, role: '' }, (manager) =>
          manager.query(`UPDATE core.email_outbox SET status = 'SENT', sent_at = now() WHERE target_user_id = $1 AND status IN ('PENDING','QUEUED','PROCESSING','RETRY')`, [
            user.id,
          ]),
        );
      }

      // sendNumber: 1 (initial invite, marked SENT above) -> 2 -> 3, each resend marked SENT so
      // the next `prepare()` call counts it — exhausting all 3 real attempts.
      await markLatestSent();
      const resend2 = await http().post(`/rest/v1/managers/initial-manager-invite/resend`).set('Authorization', `Bearer ${actorToken}`);
      expect(resend2.status).toBe(201);
      expect(resend2.body.sendNumber).toBe(2);

      await markLatestSent();
      const resend3 = await http().post(`/rest/v1/managers/initial-manager-invite/resend`).set('Authorization', `Bearer ${actorToken}`);
      expect(resend3.status).toBe(201);
      expect(resend3.body.sendNumber).toBe(3);

      await markLatestSent();
      const resend4 = await http().post(`/rest/v1/managers/initial-manager-invite/resend`).set('Authorization', `Bearer ${actorToken}`);
      expect(resend4.status).toBe(409);

      // No pre-created workspace to collide with — deletion now succeeds, no MANAGER_OWNS_WORKSPACE.
      const del = await http()
        .delete(`/rest/v1/managers/${profile.id}`)
        .set('Authorization', `Bearer ${ceoToken}`)
        .send({ currentPassword: factory.testPassword });
      expect(del.status).toBe(204);

      // With the maxed-out profile actually gone, a fresh invite for the same organisation succeeds.
      const freshInvite = await http()
        .post(`/rest/v1/managers/initial-manager-invite`)
        .set('Authorization', `Bearer ${actorToken}`)
        .send(inviteBody(`${suffix}-replacement`));
      expect(freshInvite.status).toBe(201);
    });
  });

  describe('compatibility with P2.8 suspension', () => {
    it('a suspended organisation rejects an Initial Manager invite resend', async () => {
      const { target, actorToken, actor } = await seedTargetWithCeo();
      const admin = await seedPlatformAdmin();
      const adminToken = await factory.loginByEmail(admin.email);
      const suffix = `${Date.now()}-suspended`;

      const created = await http().post('/rest/v1/managers/initial-manager-invite').set('Authorization', `Bearer ${actorToken}`).send(inviteBody(suffix));
      expect(created.status).toBe(201);

      // Suspension stays a platform-level action (unchanged).
      const suspended = await http()
        .post(`/rest/v1/admin/organisations/${target.id}/suspend`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'test', confirmSlug: target.slug, currentPassword: factory.testPassword });
      expect(suspended.status).toBeLessThan(300);

      // Organisation isolation: the actor is now the organisation's OWN CEO, whose sessions P2.8 suspension revokes outright —
      // the HTTP request is refused before any service runs (401, session ended; formerly a foreign admin's 403). The service's
      // own suspension check (layer 2, reached by jobs/CLIs) still refuses with 403, and no further invitation is sent.
      const resend = await http().post('/rest/v1/managers/initial-manager-invite/resend').set('Authorization', `Bearer ${actorToken}`);
      expect(resend.status).toBe(401);
      await expect(onboarding.resendInitialManagerInvite(actor)).rejects.toMatchObject({ status: 403 });
      const sends = await adminDataSource.manager.query(`SELECT max(send_number)::int AS n FROM core.account_invite ai JOIN core."user" u ON u.id = ai.user_id WHERE u.email = $1`, [`im-${suffix}@example.test`]);
      expect(sends[0].n).toBe(1);
    });
  });
});
