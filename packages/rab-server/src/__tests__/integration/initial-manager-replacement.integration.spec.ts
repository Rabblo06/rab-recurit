import 'reflect-metadata';
import { ManagerType } from '@rab/shared';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { ThrottlerRedisClientProvider } from '../../engine/core-modules/throttler/throttler-redis-client.provider';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { WORKER_HEARTBEAT_KEY } from '../../engine/worker-shared/heartbeat.constants';
import { OrganisationOnboardingService } from '../../modules/manager/services/organisation-onboarding.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentityFactory } from './helpers/test-identities';

/**
 * P2.9 gap review, item 2 (owner-approved, corrected, non-destructive design) — the Initial
 * Manager replacement flow, the Worker-fencing invariant, and the regression the owner's own
 * schema correction exists to prevent (Manager B/C/D must remain unconstrained by the new partial
 * unique index). Real Postgres, RLS on, no mocks.
 *
 * Organisation isolation (owner policy, 2026-10-15): Initial Manager onboarding is same-organisation only, so every flow below
 * runs as the TARGET organisation's own CEO on `/managers/initial-manager-invite*`. The former Super-Admin routes
 * (`/admin/organisations/:id/initial-manager-invite*`) are removed; the tests that relied on them now assert the denial and the
 * uniform replacement cap (see `organisation-isolation.integration.spec.ts` for the full cross-organisation matrix).
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('initial manager replacement (integration)', () => {
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

  async function markLatestOutboxSent(organisationId: string, userId: string): Promise<void> {
    await tenantContext.runInTenantContext({ organisationId, workspaceId: null, userId, role: '' }, (manager) =>
      manager.query(
        `UPDATE core.email_outbox SET status = 'SENT', sent_at = now() WHERE target_user_id = $1 AND status IN ('PENDING','QUEUED','PROCESSING','RETRY')`,
        [userId],
      ),
    );
  }

  /** Exhausts all 3 real send attempts (each marked SENT so the next prepare() call counts it) — the shared precondition for every replacement test below. Returns the stuck profile/user ids. */
  async function createExhaustedInitialManager(
    actorToken: string,
    target: { id: string },
    suffix: string,
  ): Promise<{ profileId: string; userId: string; email: string }> {
    const created = await http()
      .post(`/rest/v1/managers/initial-manager-invite`)
      .set('Authorization', `Bearer ${actorToken}`)
      .send(inviteBody(suffix));
    expect(created.status).toBe(201);
    const email = `im-${suffix}@example.test`;
    const [user] = await adminDataSource.manager.query(`SELECT id FROM core."user" WHERE organisation_id = $1 AND email = $2`, [target.id, email]);
    const [profile] = await adminDataSource.manager.query(`SELECT id FROM core.manager_profile WHERE user_id = $1`, [user.id]);

    await markLatestOutboxSent(target.id, user.id);
    const r2 = await http().post(`/rest/v1/managers/initial-manager-invite/resend`).set('Authorization', `Bearer ${actorToken}`);
    expect(r2.status).toBe(201);
    await markLatestOutboxSent(target.id, user.id);
    const r3 = await http().post(`/rest/v1/managers/initial-manager-invite/resend`).set('Authorization', `Bearer ${actorToken}`);
    expect(r3.status).toBe(201);
    await markLatestOutboxSent(target.id, user.id);

    return { profileId: profile.id, userId: user.id, email };
  }

  /** Simulates a naturally-expired final attempt (no cooldown should apply) by moving its expiry into the past. */
  async function expireLatestInvite(userId: string): Promise<void> {
    await adminDataSource.manager.query(
      `UPDATE core.account_invite SET expires_at = now() - interval '1 hour' WHERE user_id = $1 AND revoked_at IS NULL AND accepted_at IS NULL`,
      [userId],
    );
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

  describe('schema correction regression — ordinary additional Managers remain unconstrained', () => {
    it('Manager B and C can be added via the ordinary Add Manager flow for an organisation that already has its Initial Manager', async () => {
      const { target, actorToken } = await seedTargetWithCeo();
      const suffix = `${Date.now()}-abc`;
      const stuck = await createExhaustedInitialManager(actorToken, target, suffix);
      await expireLatestInvite(stuck.userId);

      // The same CEO adds ordinary Managers through the unmodified Add Manager flow.
      const b = await http().post('/rest/v1/managers').set('Authorization', `Bearer ${actorToken}`).send({ email: `mgr-b-${suffix}@example.test`, firstName: 'B', lastName: 'Manager', type: 'internal' });
      expect(b.status).toBe(201);
      const c = await http().post('/rest/v1/managers').set('Authorization', `Bearer ${actorToken}`).send({ email: `mgr-c-${suffix}@example.test`, firstName: 'C', lastName: 'Manager', type: 'internal' });
      expect(c.status).toBe(201);
    });
  });

  describe('replacement eligibility', () => {
    it('is refused while a resend is still available (RESEND_STILL_AVAILABLE)', async () => {
      const { target, actorToken } = await seedTargetWithCeo();
      const suffix = `${Date.now()}-live`;
      const created = await http().post(`/rest/v1/managers/initial-manager-invite`).set('Authorization', `Bearer ${actorToken}`).send(inviteBody(suffix));
      const [user] = await adminDataSource.manager.query(`SELECT id FROM core."user" WHERE organisation_id = $1 AND email = $2`, [target.id, `im-${suffix}@example.test`]);
      const [profile] = await adminDataSource.manager.query(`SELECT id FROM core.manager_profile WHERE user_id = $1`, [user.id]);

      const res = await http()
        .post(`/rest/v1/managers/initial-manager-invite/replace`)
        .set('Authorization', `Bearer ${actorToken}`)
        .send({ expectedProfileId: profile.id, ...inviteBody(`${suffix}-new`) });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('RESEND_STILL_AVAILABLE');
      void created;
    });

    it('a cancelled (not naturally expired) final attempt is refused until the 24h cooldown passes (REPLACE_COOLDOWN_ACTIVE), then succeeds', async () => {
      const { target, actorToken } = await seedTargetWithCeo();
      const suffix = `${Date.now()}-cooldown`;
      const stuck = await createExhaustedInitialManager(actorToken, target, suffix);

      const revoke = await http().post(`/rest/v1/managers/initial-manager-invite/revoke`).set('Authorization', `Bearer ${actorToken}`);
      expect(revoke.status).toBe(201);

      const tooSoon = await http()
        .post(`/rest/v1/managers/initial-manager-invite/replace`)
        .set('Authorization', `Bearer ${actorToken}`)
        .send({ expectedProfileId: stuck.profileId, ...inviteBody(`${suffix}-new`) });
      expect(tooSoon.status).toBe(409);
      expect(tooSoon.body.code).toBe('REPLACE_COOLDOWN_ACTIVE');

      await adminDataSource.manager.query(`UPDATE core.account_invite SET revoked_at = now() - interval '25 hours' WHERE user_id = $1`, [stuck.userId]);

      const ok = await http()
        .post(`/rest/v1/managers/initial-manager-invite/replace`)
        .set('Authorization', `Bearer ${actorToken}`)
        .send({ expectedProfileId: stuck.profileId, ...inviteBody(`${suffix}-new`) });
      expect(ok.status).toBe(201);
      expect(ok.body.manager.email).toBe(`im-${suffix}-new@example.test`);
    });

    it('a naturally-expired final attempt needs no extra cooldown', async () => {
      const { target, actorToken } = await seedTargetWithCeo();
      const suffix = `${Date.now()}-expired`;
      const stuck = await createExhaustedInitialManager(actorToken, target, suffix);
      await expireLatestInvite(stuck.userId);

      const res = await http()
        .post(`/rest/v1/managers/initial-manager-invite/replace`)
        .set('Authorization', `Bearer ${actorToken}`)
        .send({ expectedProfileId: stuck.profileId, ...inviteBody(`${suffix}-new`) });
      expect(res.status).toBe(201);
    });

    it('rejects a stale expectedProfileId (STALE_INITIAL_MANAGER)', async () => {
      const { target, actorToken } = await seedTargetWithCeo();
      const suffix = `${Date.now()}-stale`;
      const stuck = await createExhaustedInitialManager(actorToken, target, suffix);
      await expireLatestInvite(stuck.userId);

      const first = await http()
        .post(`/rest/v1/managers/initial-manager-invite/replace`)
        .set('Authorization', `Bearer ${actorToken}`)
        .send({ expectedProfileId: stuck.profileId, ...inviteBody(`${suffix}-new1`) });
      expect(first.status).toBe(201);

      // Same (now superseded) profile id presented again — must be rejected, not silently re-applied.
      const stale = await http()
        .post(`/rest/v1/managers/initial-manager-invite/replace`)
        .set('Authorization', `Bearer ${actorToken}`)
        .send({ expectedProfileId: stuck.profileId, ...inviteBody(`${suffix}-new2`) });
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe('STALE_INITIAL_MANAGER');
    });

    it('rejects an already-activated account (ALREADY_ACTIVATED) — activation always wins a race against replacement', async () => {
      const { target, actorToken } = await seedTargetWithCeo();
      const suffix = `${Date.now()}-active`;
      const stuck = await createExhaustedInitialManager(actorToken, target, suffix);
      await expireLatestInvite(stuck.userId);

      // Simulate the account having activated through the normal flow (direct DB write — exercising
      // the precondition itself, not re-testing the activation endpoint, which has its own suite).
      await adminDataSource.manager.query(`UPDATE core."user" SET status = 'active', password_hash = $2 WHERE id = $1`, [
        stuck.userId,
        await passwordHashing.hash('SomeRealPassword1!'),
      ]);

      const res = await http()
        .post(`/rest/v1/managers/initial-manager-invite/replace`)
        .set('Authorization', `Bearer ${actorToken}`)
        .send({ expectedProfileId: stuck.profileId, ...inviteBody(`${suffix}-new`) });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('ALREADY_ACTIVATED');
    });

    it('rejects a workspace that already reached READY (WORKSPACE_ALREADY_PROVISIONED) — never destroys real provisioned data', async () => {
      const { target, actorToken } = await seedTargetWithCeo();
      const suffix = `${Date.now()}-ready`;
      const stuck = await createExhaustedInitialManager(actorToken, target, suffix);
      await expireLatestInvite(stuck.userId);

      // Universal-self-service-onboarding checkpoint: a FRESH invite no longer pre-creates a
      // workspace, so `fenceWorkspaceForReplacement` would simply no-op for one. This scenario —
      // the record this fencing actually guards — is an invitation that predates that checkpoint
      // and already had a workspace provisioned to READY before anyone tried to replace it.
      // Simulated directly here rather than through the (now workspace-less) invite endpoint.
      const [workspace] = await adminDataSource.manager.query(
        `INSERT INTO core.manager_workspace (organisation_id, owner_user_id, name, subdomain, schema_status) VALUES ($1, $2, $3, $4, 'READY') RETURNING id`,
        [target.id, stuck.userId, 'Pre-existing Workspace', `ready-${suffix}`],
      );
      await adminDataSource.manager.query(`UPDATE core.manager_profile SET workspace_id = $1 WHERE id = $2`, [workspace.id, stuck.profileId]);

      const res = await http()
        .post(`/rest/v1/managers/initial-manager-invite/replace`)
        .set('Authorization', `Bearer ${actorToken}`)
        .send({ expectedProfileId: stuck.profileId, ...inviteBody(`${suffix}-new`) });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('WORKSPACE_ALREADY_PROVISIONED');

      // The READY workspace itself must be completely untouched.
      const [after] = await adminDataSource.manager.query(`SELECT schema_status FROM core.manager_workspace WHERE id = $1`, [workspace.id]);
      expect(after.schema_status).toBe('READY');
    });

    it('rejects while the organisation is suspended', async () => {
      const { target, actorToken, actor } = await seedTargetWithCeo();
      const suffix = `${Date.now()}-suspended`;
      const stuck = await createExhaustedInitialManager(actorToken, target, suffix);
      await expireLatestInvite(stuck.userId);

      // Suspension stays a platform-level action (unchanged) — performed by a platform admin of another organisation.
      const admin = await seedPlatformAdmin();
      const adminToken = await factory.loginByEmail(admin.email);
      const suspended = await http().post(`/rest/v1/admin/organisations/${target.id}/suspend`).set('Authorization', `Bearer ${adminToken}`).send({ reason: 'test', confirmSlug: target.slug, currentPassword: factory.testPassword });
      expect(suspended.status).toBeLessThan(300);

      const res = await http()
        .post(`/rest/v1/managers/initial-manager-invite/replace`)
        .set('Authorization', `Bearer ${actorToken}`)
        .send({ expectedProfileId: stuck.profileId, ...inviteBody(`${suffix}-new`) });
      // Organisation isolation: the actor is the organisation's OWN CEO, whose sessions P2.8 suspension revokes — refused before
      // any service runs (401; formerly a foreign admin's 403). The service's own suspension check still refuses (403).
      expect(res.status).toBe(401);
      await expect(onboarding.replaceInitialManager(actor, { expectedProfileId: stuck.profileId, ...inviteBody(`${suffix}-svc`) }))
        .rejects.toMatchObject({ status: 403 });
      const [profile] = await adminDataSource.manager.query(`SELECT superseded_at FROM core.manager_profile WHERE id = $1`, [stuck.profileId]);
      expect(profile.superseded_at).toBeNull();
    });

    it('another organisation\'s CEO — or a platform admin of another organisation — cannot replace this organisation\'s Initial Manager', async () => {
      const { target, actorToken } = await seedTargetWithCeo();
      const suffix = `${Date.now()}-crossorg`;
      const stuck = await createExhaustedInitialManager(actorToken, target, suffix);
      await expireLatestInvite(stuck.userId);
      const body = { expectedProfileId: stuck.profileId, ...inviteBody(`${suffix}-new`) };

      const ceo = await seedCeo();
      const ceoToken = await factory.loginByEmail(ceo.email);
      const admin = await seedPlatformAdmin();
      const adminToken = await factory.loginByEmail(admin.email);
      // The former Super-Admin-side route for an arbitrary organisation no longer exists, for anyone.
      for (const token of [ceoToken, adminToken]) {
        const viaRemovedRoute = await http().post(`/rest/v1/admin/organisations/${target.id}/initial-manager-invite/replace`).set('Authorization', `Bearer ${token}`).send(body);
        expect(viaRemovedRoute.status).toBe(404);
      }
      // Their own same-organisation route only ever reaches their OWN organisation: the target's profile id is not found there.
      // (The platform admin here holds no CEO profile in their own organisation either; either refusal leaves the target untouched.)
      const viaOwnRoute = await http().post('/rest/v1/managers/initial-manager-invite/replace').set('Authorization', `Bearer ${ceoToken}`).send(body);
      expect(viaOwnRoute.status).toBe(404);
      const [profile] = await adminDataSource.manager.query(`SELECT superseded_at FROM core.manager_profile WHERE id = $1`, [stuck.profileId]);
      expect(profile.superseded_at).toBeNull();
    });
  });

  describe('concurrency', () => {
    it('two simultaneous replacement requests for the same profile: exactly one wins', async () => {
      const { target, actorToken } = await seedTargetWithCeo();
      const suffix = `${Date.now()}-race`;
      const stuck = await createExhaustedInitialManager(actorToken, target, suffix);
      await expireLatestInvite(stuck.userId);

      const [a, b] = await Promise.all([
        http().post(`/rest/v1/managers/initial-manager-invite/replace`).set('Authorization', `Bearer ${actorToken}`).send({ expectedProfileId: stuck.profileId, ...inviteBody(`${suffix}-a`) }),
        http().post(`/rest/v1/managers/initial-manager-invite/replace`).set('Authorization', `Bearer ${actorToken}`).send({ expectedProfileId: stuck.profileId, ...inviteBody(`${suffix}-b`) }),
      ]);
      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([201, 409]);
    });
  });

  describe('old identity cannot authenticate after replacement', () => {
    it("the original invitation link can no longer be accepted", async () => {
      const { target, actorToken } = await seedTargetWithCeo();
      const suffix = `${Date.now()}-oldtoken`;
      const stuck = await createExhaustedInitialManager(actorToken, target, suffix);
      await expireLatestInvite(stuck.userId);

      const [invite] = await adminDataSource.manager.query(`SELECT id FROM core.account_invite WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [stuck.userId]);
      const [outboxRow] = await adminDataSource.manager.query(`SELECT rendered_html FROM core.email_outbox WHERE account_invite_id = $1`, [invite.id]);
      const match = /token=([a-f0-9]+)/.exec(outboxRow.rendered_html);
      if (!match) throw new Error('Could not find activation token in rendered outbox email.');

      const replace = await http()
        .post(`/rest/v1/managers/initial-manager-invite/replace`)
        .set('Authorization', `Bearer ${actorToken}`)
        .send({ expectedProfileId: stuck.profileId, ...inviteBody(`${suffix}-new`) });
      expect(replace.status).toBe(201);

      const activate = await http().post('/rest/v1/auth/activate-account').send({ token: match[1], newPassword: 'ShouldNeverWork1!' });
      expect(activate.status).toBe(400);

      const [afterUser] = await adminDataSource.manager.query(`SELECT password_hash, status FROM core."user" WHERE id = $1`, [stuck.userId]);
      expect(afterUser.password_hash).toBeNull();
      expect(afterUser.status).not.toBe('active');
    });
  });

  /**
   * Owner decision (2026-10-15, later): Initial Manager replacements are UNLIMITED. Superseded: the 3-replacement cap ("REPLACE_LIMIT_
   * REACHED") and, before that, the uncapped cross-organisation Super-Admin route. What stays bounded: the invitation lifecycle,
   * one current Initial Manager per organisation, same-organisation authority, and ordinary request throttling.
   */
  describe('unlimited replacements (owner decision 2026-10-15)', () => {
    /** Exhausts all 3 sends of the CURRENT Initial Manager invitation and lets the last one expire, so it is replaceable. */
    async function exhaustAndExpire(target: { id: string }, userId: string, token: string): Promise<void> {
      await markLatestOutboxSent(target.id, userId);
      for (let send = 2; send <= 3; send++) {
        const res = await http().post('/rest/v1/managers/initial-manager-invite/resend').set('Authorization', `Bearer ${token}`);
        expect([`resend ${send}`, res.status]).toEqual([`resend ${send}`, 201]);
        await markLatestOutboxSent(target.id, userId);
      }
      await expireLatestInvite(userId);
    }

    it('20 consecutive replacements all succeed (checkpoints 1, 2, 3, 4, 5, 10, 20) — the CEO for 1–10, a same-organisation platform admin for 11–20', async () => {
      const { target, actorToken: ceoToken } = await seedTargetWithCeo();
      const sameOrgAdmin = await factory.createOrgAdmin(target, { permissions: 'all', platformAdmin: true });
      const adminToken = await factory.login(sameOrgAdmin);

      let stuck = await createExhaustedInitialManager(ceoToken, target, `${Date.now()}-u0`);
      await expireLatestInvite(stuck.userId);
      const retired: Array<{ userId: string; securityVersionBefore: number }> = [];
      const succeededAt: number[] = [];

      for (let i = 1; i <= 20; i++) {
        const token = i <= 10 ? ceoToken : adminToken;
        const [{ security_version: securityVersionBefore }] = await adminDataSource.manager.query(`SELECT security_version FROM core."user" WHERE id = $1`, [stuck.userId]);
        const next = `${Date.now()}-u${i}`;
        const res = await http().post('/rest/v1/managers/initial-manager-invite/replace').set('Authorization', `Bearer ${token}`)
          .send({ expectedProfileId: stuck.profileId, ...inviteBody(next) });
        expect([`replacement ${i}`, res.status, res.body.code]).toEqual([`replacement ${i}`, 201, undefined]);
        succeededAt.push(i);
        retired.push({ userId: stuck.userId, securityVersionBefore: Number(securityVersionBefore) });

        const [user] = await adminDataSource.manager.query(`SELECT id FROM core."user" WHERE organisation_id = $1 AND email = $2`, [target.id, `im-${next}@example.test`]);
        const [profile] = await adminDataSource.manager.query(`SELECT id FROM core.manager_profile WHERE user_id = $1`, [user.id]);
        stuck = { profileId: profile.id, userId: user.id, email: `im-${next}@example.test` };
        if (i < 20) await exhaustAndExpire(target, user.id, token);
      }
      for (const checkpoint of [1, 2, 3, 4, 5, 10, 20]) expect(succeededAt).toContain(checkpoint);

      // Exactly one CURRENT Initial Manager; every earlier one is superseded history, never deleted.
      const [{ current, superseded }] = await adminDataSource.manager.query(
        `SELECT count(*) FILTER (WHERE superseded_at IS NULL)::int AS current, count(*) FILTER (WHERE superseded_at IS NOT NULL)::int AS superseded
           FROM core.manager_profile WHERE organisation_id = $1 AND is_initial_manager`, [target.id]);
      expect({ current, superseded }).toEqual({ current: 1, superseded: 20 });

      // Every retired identity is fully retired: no password, never active, no live credential, security version bumped.
      for (const old of retired) {
        const [row] = await adminDataSource.manager.query(
          `SELECT u.password_hash IS NULL AS no_password, u.status, u.security_version,
                  (SELECT count(*)::int FROM core.user_session s WHERE s.user_id = u.id AND s.revoked_at IS NULL) AS live_sessions,
                  (SELECT count(*)::int FROM core.refresh_token t WHERE t.user_id = u.id AND t.revoked_at IS NULL) AS live_refresh,
                  (SELECT count(*)::int FROM core.account_invite ai WHERE ai.user_id = u.id AND ai.revoked_at IS NULL AND ai.accepted_at IS NULL AND ai.expires_at > now()) AS usable_invites
             FROM core."user" u WHERE u.id = $1`, [old.userId]);
        expect(row).toMatchObject({ no_password: true, live_sessions: 0, live_refresh: 0, usable_invites: 0 });
        expect(row.status).not.toBe('active');
        expect(Number(row.security_version)).toBeGreaterThan(old.securityVersionBefore);
      }

      const audits = await adminDataSource.manager.query(`SELECT count(*)::int AS n FROM core.audit_log WHERE organisation_id = $1 AND action = 'manager.initial_manager_replaced'`, [target.id]);
      expect(audits[0].n).toBe(20);
      // And still no cross-organisation route for anyone.
      const viaRemovedRoute = await http().post(`/rest/v1/admin/organisations/${target.id}/initial-manager-invite/replace`).set('Authorization', `Bearer ${adminToken}`)
        .send({ expectedProfileId: stuck.profileId, ...inviteBody(`${Date.now()}-x`) });
      expect(viaRemovedRoute.status).toBe(404);
    }, 240_000);

    it('roles without leadership authority cannot replace: a non-CEO manager.manage holder (403), Staff and a Venue Manager (refused by the route)', async () => {
      const target = await factory.createOrganisation();
      const ceo = await factory.createInternalManager(target, { permissions: 'all', type: ManagerType.CEO, label: `ceo-noauth-${Date.now()}` });
      const ceoToken = await factory.login(ceo);
      const stuck = await createExhaustedInitialManager(ceoToken, target, `${Date.now()}-noauth`);
      await expireLatestInvite(stuck.userId);
      const body = { expectedProfileId: stuck.profileId, ...inviteBody(`${Date.now()}-noauth-new`) };

      // Holds MANAGER_MANAGE (passes the route guard) but is neither this organisation's CEO nor a platform admin.
      const manager = await factory.createOrgAdmin(target, { permissions: ['manager.manage'] });
      const staff = await factory.createStaff(target, { owner: ceo });
      const venueManager = await factory.createVenueManager(target, { owner: ceo });
      const plain = await http().post('/rest/v1/managers/initial-manager-invite/replace').set('Authorization', `Bearer ${await factory.login(manager)}`).send(body);
      expect(plain.status).toBe(403);
      for (const identity of [staff, venueManager]) {
        const token = await factory.login(identity).catch(() => null);
        if (!token) continue; // a mobile-only identity is refused the manager web app entirely — even stronger
        const res = await http().post('/rest/v1/managers/initial-manager-invite/replace').set('Authorization', `Bearer ${token}`).send(body);
        expect([identity.kind, [401, 403].includes(res.status)]).toEqual([identity.kind, true]);
      }
      const [profile] = await adminDataSource.manager.query(`SELECT superseded_at FROM core.manager_profile WHERE id = $1`, [stuck.profileId]);
      expect(profile.superseded_at).toBeNull();
    });

    it('races: replace vs resend, replace vs revoke, replace vs a second invite, replace vs activation — one consistent result, never two current Initial Managers', async () => {
      // Replace vs resend / revoke / invite, on a replaceable (expired, exhausted) invitation.
      const { target, actorToken } = await seedTargetWithCeo();
      const stuck = await createExhaustedInitialManager(actorToken, target, `${Date.now()}-race`);
      await expireLatestInvite(stuck.userId);
      const [replace, resend, revoke, invite] = await Promise.all([
        http().post('/rest/v1/managers/initial-manager-invite/replace').set('Authorization', `Bearer ${actorToken}`).send({ expectedProfileId: stuck.profileId, ...inviteBody(`${Date.now()}-race-new`) }),
        http().post('/rest/v1/managers/initial-manager-invite/resend').set('Authorization', `Bearer ${actorToken}`),
        http().post('/rest/v1/managers/initial-manager-invite/revoke').set('Authorization', `Bearer ${actorToken}`),
        http().post('/rest/v1/managers/initial-manager-invite').set('Authorization', `Bearer ${actorToken}`).send(inviteBody(`${Date.now()}-race-dup`)),
      ]);
      expect([replace.status, resend.status, revoke.status, invite.status].every((s) => s < 500)).toBe(true);
      expect(invite.status).toBe(409); // a current Initial Manager always exists — never a second one
      const [{ current }] = await adminDataSource.manager.query(`SELECT count(*)::int AS current FROM core.manager_profile WHERE organisation_id = $1 AND is_initial_manager AND superseded_at IS NULL`, [target.id]);
      expect(current).toBe(1);

      // Replace vs activation: an invitation that can still be ACTIVATED is never replaceable, so both can never win.
      const second = await seedTargetWithCeo();
      const live = await createExhaustedInitialManager(second.actorToken, second.target, `${Date.now()}-activate`);
      const [inv] = await adminDataSource.manager.query(`SELECT id FROM core.account_invite WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [live.userId]);
      const [outbox] = await adminDataSource.manager.query(`SELECT rendered_html FROM core.email_outbox WHERE account_invite_id = $1`, [inv.id]);
      const token = /token=([a-f0-9]+)/.exec(outbox.rendered_html)![1];
      const [activate, replaceLive] = await Promise.all([
        http().post('/rest/v1/auth/activate-account').send({ token, newPassword: 'ActivatedFirst1!' }),
        http().post('/rest/v1/managers/initial-manager-invite/replace').set('Authorization', `Bearer ${second.actorToken}`).send({ expectedProfileId: live.profileId, ...inviteBody(`${Date.now()}-activate-new`) }),
      ]);
      expect(activate.status).toBe(200);
      expect(replaceLive.status).toBe(409);
      const [row] = await adminDataSource.manager.query(`SELECT mp.superseded_at, u.password_hash IS NOT NULL AS has_password FROM core.manager_profile mp JOIN core."user" u ON u.id = mp.user_id WHERE mp.id = $1`, [live.profileId]);
      expect(row).toEqual({ superseded_at: null, has_password: true });
    }, 120_000);
  });

  describe('audit history survives replacement', () => {
    it('the superseded profile\'s prior audit rows (invite created, resent) remain readable, unchanged', async () => {
      const { target, actorToken } = await seedTargetWithCeo();
      const suffix = `${Date.now()}-audit`;
      const stuck = await createExhaustedInitialManager(actorToken, target, suffix);
      await expireLatestInvite(stuck.userId);

      const before = await adminDataSource.manager.query(`SELECT action FROM core.audit_log WHERE target_user_id = $1 ORDER BY created_at ASC`, [stuck.userId]);
      expect(before.length).toBeGreaterThan(0);

      const res = await http()
        .post(`/rest/v1/managers/initial-manager-invite/replace`)
        .set('Authorization', `Bearer ${actorToken}`)
        .send({ expectedProfileId: stuck.profileId, ...inviteBody(`${suffix}-new`) });
      expect(res.status).toBe(201);

      const after = await adminDataSource.manager.query(`SELECT action FROM core.audit_log WHERE target_user_id = $1 ORDER BY created_at ASC`, [stuck.userId]);
      // Compared as a multiset, not an exact sequence — two rows written within the same
      // millisecond (invite_queued/invite_resent during the same resend) have no stable tiebreak
      // in `created_at` alone, which is all this assertion needs to care about: every PRIOR
      // audit row for this user must still exist afterward, none lost, none mutated.
      const sortedBefore = [...before.map((r: { action: string }) => r.action)].sort();
      const sortedAfterPrefix = [...after.slice(0, before.length).map((r: { action: string }) => r.action)].sort();
      expect(sortedAfterPrefix).toEqual(sortedBefore);

      const [oldProfile] = await adminDataSource.manager.query(`SELECT id, superseded_at, is_initial_manager FROM core.manager_profile WHERE id = $1`, [stuck.profileId]);
      expect(oldProfile).toBeDefined();
      expect(oldProfile.superseded_at).not.toBeNull();
      expect(oldProfile.is_initial_manager).toBe(true);

      const replacementAudit = await adminDataSource.manager.query(`SELECT metadata FROM core.audit_log WHERE action = 'manager.initial_manager_replaced' AND metadata->>'oldProfileId' = $1`, [stuck.profileId]);
      expect(replacementAudit.length).toBe(1);
    });
  });

  describe('replace request contract', () => {
    it('rejects a replace body carrying unexpected workspace fields (subdomain/workspaceName are no longer part of this contract)', async () => {
      const { target, actorToken } = await seedTargetWithCeo();
      const suffix = `${Date.now()}-stray-fields`;
      const stuck = await createExhaustedInitialManager(actorToken, target, suffix);
      await expireLatestInvite(stuck.userId);

      const res = await http()
        .post(`/rest/v1/managers/initial-manager-invite/replace`)
        .set('Authorization', `Bearer ${actorToken}`)
        .send({ expectedProfileId: stuck.profileId, ...inviteBody(`${suffix}-new`), workspaceName: 'Should be rejected', subdomain: 'should-be-rejected' });
      expect(res.status).toBe(400);
    });
  });
});

/**
 * Worker-fencing proof (P2.9 gap review, item 2) — a separate, SQL-level suite proving
 * `core.mark_workspace_schema_superseded`'s allow-list guard and the `mark_workspace_schema_
 * failed` stomp-back fix directly, rather than relying on a flaky real-concurrency simulation of
 * the actual Node.js provisioner process. These exercise the exact invariant the owner asked to
 * be proven: a queued, active, failed, or retried Worker job cannot turn a SUPERSEDED workspace
 * back into CREATING, FAILED or READY.
 */
describeIfDb('workspace schema SUPERSEDED fencing (SQL-level, integration)', () => {
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let factory: TestIdentityFactory;
  let tenantContext: TenantContextService;
  let app: INestApplication;

  async function createWorkspace(): Promise<{ workspaceId: string; organisationId: string; userId: string }> {
    const organisation = await factory.createOrganisation();
    const manager = await factory.createInternalManager(organisation, { permissions: 'all', label: `ws-fence-${Date.now()}`, workspace: false });
    const [workspace] = await adminDataSource.manager.query(
      `INSERT INTO core.manager_workspace (organisation_id, owner_user_id, name, subdomain, schema_status) VALUES ($1, $2, $3, $4, 'CREATING') RETURNING id`,
      [organisation.id, manager.userId, 'Fence Test', `fence-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`],
    );
    return { workspaceId: workspace.id, organisationId: organisation.id, userId: manager.userId };
  }

  async function run<T>(organisationId: string, userId: string, sql: string, params: unknown[]): Promise<T> {
    return tenantContext.runInTenantContext({ organisationId, workspaceId: null, userId, role: '' }, (manager) => manager.query(sql, params));
  }

  /**
   * `begin_workspace_schema_attempt`/`mark_workspace_schema_ready`/`mark_workspace_schema_failed`
   * are granted ONLY to `crewflow`/`rab_secure_owner` (confirmed by live grant inspection this
   * session) — never to the ordinary app runtime, so the real provisioner's own calls to them
   * can't be faithfully exercised through `tenantContext`/the app's own pooled connection (which
   * this harness resolves to a DIFFERENT, narrower effective role — it gets a permission-denied
   * error for these three, itself a valid, even stronger proof that the ordinary runtime can
   * never touch workspace-schema lifecycle state directly, but not a test of the functions' OWN
   * allow-list guard). `process.env.DATABASE_URL` in this test environment is the literal
   * `crewflow` credential (`TEST_DATABASE_URL`, mapped by `applyIntegrationTestDatabaseEnv`) — a
   * fresh raw connection with it, with no ORM/tenant-context layer in between, is what actually
   * runs these three exactly the way the real standalone provisioner process does.
   */
  async function asProvisioner<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    dataSource = moduleRef.get(DataSource);
    const passwordHashing = moduleRef.get(PasswordHashingService);
    tenantContext = moduleRef.get(TenantContextService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = new TestIdentityFactory({ app, dataSource, adminDataSource, tenantContext, passwordHashing });
  });

  afterAll(async () => {
    await app.close();
    await adminDataSource.destroy();
  });

  it('a SUPERSEDED workspace refuses begin_workspace_schema_attempt (a queued or retried job cannot restart it)', async () => {
    const ws = await createWorkspace();
    await run(ws.organisationId, ws.userId, 'SELECT core.mark_workspace_schema_superseded($1, $2)', [ws.workspaceId, 'test supersede']);

    await expect(asProvisioner((client) => client.query('SELECT core.begin_workspace_schema_attempt($1)', [ws.workspaceId]))).rejects.toThrow();

    const [row] = await adminDataSource.manager.query(`SELECT schema_status FROM core.manager_workspace WHERE id = $1`, [ws.workspaceId]);
    expect(row.schema_status).toBe('SUPERSEDED');
  });

  it('a SUPERSEDED workspace refuses mark_workspace_schema_ready (a Worker already mid-apply cannot complete to READY after supersede)', async () => {
    const ws = await createWorkspace();
    await run(ws.organisationId, ws.userId, 'SELECT core.mark_workspace_schema_superseded($1, $2)', [ws.workspaceId, 'test supersede']);

    await expect(asProvisioner((client) => client.query('SELECT core.mark_workspace_schema_ready($1, $2)', [ws.workspaceId, 1]))).rejects.toThrow();

    const [row] = await adminDataSource.manager.query(`SELECT schema_status FROM core.manager_workspace WHERE id = $1`, [ws.workspaceId]);
    expect(row.schema_status).toBe('SUPERSEDED');
  });

  it('a SUPERSEDED workspace refuses mark_workspace_schema_failed (the Worker\'s own failure handler cannot stomp SUPERSEDED back to FAILED)', async () => {
    const ws = await createWorkspace();
    await run(ws.organisationId, ws.userId, 'SELECT core.mark_workspace_schema_superseded($1, $2)', [ws.workspaceId, 'test supersede']);

    await expect(asProvisioner((client) => client.query('SELECT core.mark_workspace_schema_failed($1, $2)', [ws.workspaceId, 'simulated worker failure']))).rejects.toThrow();

    const [row] = await adminDataSource.manager.query(`SELECT schema_status FROM core.manager_workspace WHERE id = $1`, [ws.workspaceId]);
    expect(row.schema_status).toBe('SUPERSEDED');
  });

  it('the ordinary app runtime cannot call the provisioner-only functions AT ALL — a second, independent layer on top of the allow-list guard', async () => {
    const ws = await createWorkspace();
    await expect(run(ws.organisationId, ws.userId, 'SELECT core.begin_workspace_schema_attempt($1)', [ws.workspaceId])).rejects.toThrow(/permission denied/i);
    await expect(run(ws.organisationId, ws.userId, 'SELECT core.mark_workspace_schema_ready($1, $2)', [ws.workspaceId, 1])).rejects.toThrow(/permission denied/i);
    await expect(run(ws.organisationId, ws.userId, 'SELECT core.mark_workspace_schema_failed($1, $2)', [ws.workspaceId, 'x'])).rejects.toThrow(/permission denied/i);
  });

  it('mark_workspace_schema_superseded itself refuses READY (never destroys real provisioned data) and MIGRATING', async () => {
    const readyWs = await createWorkspace();
    await adminDataSource.manager.query(`UPDATE core.manager_workspace SET schema_status = 'READY' WHERE id = $1`, [readyWs.workspaceId]);
    await expect(run(readyWs.organisationId, readyWs.userId, 'SELECT core.mark_workspace_schema_superseded($1, $2)', [readyWs.workspaceId, 'should be refused'])).rejects.toThrow();
    const [afterReady] = await adminDataSource.manager.query(`SELECT schema_status FROM core.manager_workspace WHERE id = $1`, [readyWs.workspaceId]);
    expect(afterReady.schema_status).toBe('READY');

    const migratingWs = await createWorkspace();
    await adminDataSource.manager.query(`UPDATE core.manager_workspace SET schema_status = 'MIGRATING' WHERE id = $1`, [migratingWs.workspaceId]);
    await expect(run(migratingWs.organisationId, migratingWs.userId, 'SELECT core.mark_workspace_schema_superseded($1, $2)', [migratingWs.workspaceId, 'should be refused'])).rejects.toThrow();
    const [afterMigrating] = await adminDataSource.manager.query(`SELECT schema_status FROM core.manager_workspace WHERE id = $1`, [migratingWs.workspaceId]);
    expect(afterMigrating.schema_status).toBe('MIGRATING');
  });

  it('mark_workspace_schema_superseded is idempotent on an already-SUPERSEDED workspace (safe for a retried replace request)', async () => {
    const ws = await createWorkspace();
    await run(ws.organisationId, ws.userId, 'SELECT core.mark_workspace_schema_superseded($1, $2)', [ws.workspaceId, 'first']);
    await expect(run(ws.organisationId, ws.userId, 'SELECT core.mark_workspace_schema_superseded($1, $2)', [ws.workspaceId, 'second'])).resolves.toBeDefined();
    const [row] = await adminDataSource.manager.query(`SELECT schema_status FROM core.manager_workspace WHERE id = $1`, [ws.workspaceId]);
    expect(row.schema_status).toBe('SUPERSEDED');
  });

  it('handles an absent registry row safely (no registration has run yet — pre-Worker, or dev with HWS_RUNTIME_ENABLED=false)', async () => {
    const ws = await createWorkspace();
    const [registryBefore] = await adminDataSource.manager.query(`SELECT 1 FROM core.workspace_schema_registry WHERE workspace_id = $1`, [ws.workspaceId]);
    expect(registryBefore).toBeUndefined();

    await expect(run(ws.organisationId, ws.userId, 'SELECT core.mark_workspace_schema_superseded($1, $2)', [ws.workspaceId, 'no registry yet'])).resolves.toBeDefined();
    const [row] = await adminDataSource.manager.query(`SELECT schema_status FROM core.manager_workspace WHERE id = $1`, [ws.workspaceId]);
    expect(row.schema_status).toBe('SUPERSEDED');
  });
});
