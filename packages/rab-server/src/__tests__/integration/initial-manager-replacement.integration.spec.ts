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
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentityFactory } from './helpers/test-identities';

/**
 * P2.9 gap review, item 2 (owner-approved, corrected, non-destructive design) — the Initial
 * Manager replacement flow, the Worker-fencing invariant, and the regression the owner's own
 * schema correction exists to prevent (Manager B/C/D must remain unconstrained by the new partial
 * unique index). Real Postgres, RLS on, no mocks.
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
    adminToken: string,
    target: { id: string },
    suffix: string,
  ): Promise<{ profileId: string; userId: string; email: string }> {
    const created = await http()
      .post(`/rest/v1/admin/organisations/${target.id}/initial-manager-invite`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send(inviteBody(suffix));
    expect(created.status).toBe(201);
    const email = `im-${suffix}@example.test`;
    const [user] = await adminDataSource.manager.query(`SELECT id FROM core."user" WHERE organisation_id = $1 AND email = $2`, [target.id, email]);
    const [profile] = await adminDataSource.manager.query(`SELECT id FROM core.manager_profile WHERE user_id = $1`, [user.id]);

    await markLatestOutboxSent(target.id, user.id);
    const r2 = await http().post(`/rest/v1/admin/organisations/${target.id}/initial-manager-invite/resend`).set('Authorization', `Bearer ${adminToken}`);
    expect(r2.status).toBe(201);
    await markLatestOutboxSent(target.id, user.id);
    const r3 = await http().post(`/rest/v1/admin/organisations/${target.id}/initial-manager-invite/resend`).set('Authorization', `Bearer ${adminToken}`);
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
      const admin = await seedPlatformAdmin();
      const adminToken = await factory.loginByEmail(admin.email);
      const target = await factory.createOrganisation();
      const suffix = `${Date.now()}-abc`;
      const stuck = await createExhaustedInitialManager(adminToken, target, suffix);
      await expireLatestInvite(stuck.userId);

      const ceoToken = await factory.loginByEmail(admin.email); // admin stands in as the acting caller for Add Manager via CEO-equivalent route is org-scoped; use CEO instead:
      const ceo = await factory.createInternalManager(target, { permissions: 'all', type: ManagerType.CEO, label: `ceo-${suffix}` });
      const ceoLogin = await factory.loginByEmail(ceo.email);

      const b = await http().post('/rest/v1/managers').set('Authorization', `Bearer ${ceoLogin}`).send({ email: `mgr-b-${suffix}@example.test`, firstName: 'B', lastName: 'Manager', type: 'internal' });
      expect(b.status).toBe(201);
      const c = await http().post('/rest/v1/managers').set('Authorization', `Bearer ${ceoLogin}`).send({ email: `mgr-c-${suffix}@example.test`, firstName: 'C', lastName: 'Manager', type: 'internal' });
      expect(c.status).toBe(201);
      void ceoToken;
    });
  });

  describe('replacement eligibility', () => {
    it('is refused while a resend is still available (RESEND_STILL_AVAILABLE)', async () => {
      const admin = await seedPlatformAdmin();
      const adminToken = await factory.loginByEmail(admin.email);
      const target = await factory.createOrganisation();
      const suffix = `${Date.now()}-live`;
      const created = await http().post(`/rest/v1/admin/organisations/${target.id}/initial-manager-invite`).set('Authorization', `Bearer ${adminToken}`).send(inviteBody(suffix));
      const [user] = await adminDataSource.manager.query(`SELECT id FROM core."user" WHERE organisation_id = $1 AND email = $2`, [target.id, `im-${suffix}@example.test`]);
      const [profile] = await adminDataSource.manager.query(`SELECT id FROM core.manager_profile WHERE user_id = $1`, [user.id]);

      const res = await http()
        .post(`/rest/v1/admin/organisations/${target.id}/initial-manager-invite/replace`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ expectedProfileId: profile.id, ...inviteBody(`${suffix}-new`) });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('RESEND_STILL_AVAILABLE');
      void created;
    });

    it('a cancelled (not naturally expired) final attempt is refused until the 24h cooldown passes (REPLACE_COOLDOWN_ACTIVE), then succeeds', async () => {
      const admin = await seedPlatformAdmin();
      const adminToken = await factory.loginByEmail(admin.email);
      const target = await factory.createOrganisation();
      const suffix = `${Date.now()}-cooldown`;
      const stuck = await createExhaustedInitialManager(adminToken, target, suffix);

      const revoke = await http().post(`/rest/v1/admin/organisations/${target.id}/initial-manager-invite/revoke`).set('Authorization', `Bearer ${adminToken}`);
      expect(revoke.status).toBe(201);

      const tooSoon = await http()
        .post(`/rest/v1/admin/organisations/${target.id}/initial-manager-invite/replace`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ expectedProfileId: stuck.profileId, ...inviteBody(`${suffix}-new`) });
      expect(tooSoon.status).toBe(409);
      expect(tooSoon.body.code).toBe('REPLACE_COOLDOWN_ACTIVE');

      await adminDataSource.manager.query(`UPDATE core.account_invite SET revoked_at = now() - interval '25 hours' WHERE user_id = $1`, [stuck.userId]);

      const ok = await http()
        .post(`/rest/v1/admin/organisations/${target.id}/initial-manager-invite/replace`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ expectedProfileId: stuck.profileId, ...inviteBody(`${suffix}-new`) });
      expect(ok.status).toBe(201);
      expect(ok.body.manager.email).toBe(`im-${suffix}-new@example.test`);
    });

    it('a naturally-expired final attempt needs no extra cooldown', async () => {
      const admin = await seedPlatformAdmin();
      const adminToken = await factory.loginByEmail(admin.email);
      const target = await factory.createOrganisation();
      const suffix = `${Date.now()}-expired`;
      const stuck = await createExhaustedInitialManager(adminToken, target, suffix);
      await expireLatestInvite(stuck.userId);

      const res = await http()
        .post(`/rest/v1/admin/organisations/${target.id}/initial-manager-invite/replace`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ expectedProfileId: stuck.profileId, ...inviteBody(`${suffix}-new`) });
      expect(res.status).toBe(201);
    });

    it('rejects a stale expectedProfileId (STALE_INITIAL_MANAGER)', async () => {
      const admin = await seedPlatformAdmin();
      const adminToken = await factory.loginByEmail(admin.email);
      const target = await factory.createOrganisation();
      const suffix = `${Date.now()}-stale`;
      const stuck = await createExhaustedInitialManager(adminToken, target, suffix);
      await expireLatestInvite(stuck.userId);

      const first = await http()
        .post(`/rest/v1/admin/organisations/${target.id}/initial-manager-invite/replace`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ expectedProfileId: stuck.profileId, ...inviteBody(`${suffix}-new1`) });
      expect(first.status).toBe(201);

      // Same (now superseded) profile id presented again — must be rejected, not silently re-applied.
      const stale = await http()
        .post(`/rest/v1/admin/organisations/${target.id}/initial-manager-invite/replace`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ expectedProfileId: stuck.profileId, ...inviteBody(`${suffix}-new2`) });
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe('STALE_INITIAL_MANAGER');
    });

    it('rejects an already-activated account (ALREADY_ACTIVATED) — activation always wins a race against replacement', async () => {
      const admin = await seedPlatformAdmin();
      const adminToken = await factory.loginByEmail(admin.email);
      const target = await factory.createOrganisation();
      const suffix = `${Date.now()}-active`;
      const stuck = await createExhaustedInitialManager(adminToken, target, suffix);
      await expireLatestInvite(stuck.userId);

      // Simulate the account having activated through the normal flow (direct DB write — exercising
      // the precondition itself, not re-testing the activation endpoint, which has its own suite).
      await adminDataSource.manager.query(`UPDATE core."user" SET status = 'active', password_hash = $2 WHERE id = $1`, [
        stuck.userId,
        await passwordHashing.hash('SomeRealPassword1!'),
      ]);

      const res = await http()
        .post(`/rest/v1/admin/organisations/${target.id}/initial-manager-invite/replace`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ expectedProfileId: stuck.profileId, ...inviteBody(`${suffix}-new`) });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('ALREADY_ACTIVATED');
    });

    it('rejects a workspace that already reached READY (WORKSPACE_ALREADY_PROVISIONED) — never destroys real provisioned data', async () => {
      const admin = await seedPlatformAdmin();
      const adminToken = await factory.loginByEmail(admin.email);
      const target = await factory.createOrganisation();
      const suffix = `${Date.now()}-ready`;
      const stuck = await createExhaustedInitialManager(adminToken, target, suffix);
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
        .post(`/rest/v1/admin/organisations/${target.id}/initial-manager-invite/replace`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ expectedProfileId: stuck.profileId, ...inviteBody(`${suffix}-new`) });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('WORKSPACE_ALREADY_PROVISIONED');

      // The READY workspace itself must be completely untouched.
      const [after] = await adminDataSource.manager.query(`SELECT schema_status FROM core.manager_workspace WHERE id = $1`, [workspace.id]);
      expect(after.schema_status).toBe('READY');
    });

    it('rejects while the organisation is suspended', async () => {
      const admin = await seedPlatformAdmin();
      const adminToken = await factory.loginByEmail(admin.email);
      const target = await factory.createOrganisation();
      const suffix = `${Date.now()}-suspended`;
      const stuck = await createExhaustedInitialManager(adminToken, target, suffix);
      await expireLatestInvite(stuck.userId);

      await http().post(`/rest/v1/admin/organisations/${target.id}/suspend`).set('Authorization', `Bearer ${adminToken}`).send({ reason: 'test', confirmSlug: target.slug, currentPassword: factory.testPassword });

      const res = await http()
        .post(`/rest/v1/admin/organisations/${target.id}/initial-manager-invite/replace`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ expectedProfileId: stuck.profileId, ...inviteBody(`${suffix}-new`) });
      expect(res.status).toBe(403);
    });

    it('a CEO cannot use the Super-Admin-side route to replace a DIFFERENT organisation\'s Initial Manager', async () => {
      const admin = await seedPlatformAdmin();
      const adminToken = await factory.loginByEmail(admin.email);
      const target = await factory.createOrganisation();
      const suffix = `${Date.now()}-crossorg`;
      const stuck = await createExhaustedInitialManager(adminToken, target, suffix);
      await expireLatestInvite(stuck.userId);

      const ceo = await seedCeo();
      const ceoToken = await factory.loginByEmail(ceo.email);
      const res = await http()
        .post(`/rest/v1/admin/organisations/${target.id}/initial-manager-invite/replace`)
        .set('Authorization', `Bearer ${ceoToken}`)
        .send({ expectedProfileId: stuck.profileId, ...inviteBody(`${suffix}-new`) });
      expect(res.status).toBe(403);
    });
  });

  describe('concurrency', () => {
    it('two simultaneous replacement requests for the same profile: exactly one wins', async () => {
      const admin = await seedPlatformAdmin();
      const adminToken = await factory.loginByEmail(admin.email);
      const target = await factory.createOrganisation();
      const suffix = `${Date.now()}-race`;
      const stuck = await createExhaustedInitialManager(adminToken, target, suffix);
      await expireLatestInvite(stuck.userId);

      const [a, b] = await Promise.all([
        http().post(`/rest/v1/admin/organisations/${target.id}/initial-manager-invite/replace`).set('Authorization', `Bearer ${adminToken}`).send({ expectedProfileId: stuck.profileId, ...inviteBody(`${suffix}-a`) }),
        http().post(`/rest/v1/admin/organisations/${target.id}/initial-manager-invite/replace`).set('Authorization', `Bearer ${adminToken}`).send({ expectedProfileId: stuck.profileId, ...inviteBody(`${suffix}-b`) }),
      ]);
      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([201, 409]);
    });
  });

  describe('old identity cannot authenticate after replacement', () => {
    it("the original invitation link can no longer be accepted", async () => {
      const admin = await seedPlatformAdmin();
      const adminToken = await factory.loginByEmail(admin.email);
      const target = await factory.createOrganisation();
      const suffix = `${Date.now()}-oldtoken`;
      const stuck = await createExhaustedInitialManager(adminToken, target, suffix);
      await expireLatestInvite(stuck.userId);

      const [invite] = await adminDataSource.manager.query(`SELECT id FROM core.account_invite WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [stuck.userId]);
      const [outboxRow] = await adminDataSource.manager.query(`SELECT rendered_html FROM core.email_outbox WHERE account_invite_id = $1`, [invite.id]);
      const match = /token=([a-f0-9]+)/.exec(outboxRow.rendered_html);
      if (!match) throw new Error('Could not find activation token in rendered outbox email.');

      const replace = await http()
        .post(`/rest/v1/admin/organisations/${target.id}/initial-manager-invite/replace`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ expectedProfileId: stuck.profileId, ...inviteBody(`${suffix}-new`) });
      expect(replace.status).toBe(201);

      const activate = await http().post('/rest/v1/auth/activate-account').send({ token: match[1], newPassword: 'ShouldNeverWork1!' });
      expect(activate.status).toBe(400);

      const [afterUser] = await adminDataSource.manager.query(`SELECT password_hash, status FROM core."user" WHERE id = $1`, [stuck.userId]);
      expect(afterUser.password_hash).toBeNull();
      expect(afterUser.status).not.toBe('active');
    });
  });

  describe('replacement limits', () => {
    it('a CEO is capped at 3 lifetime replacements per organisation; the Super Admin route is uncapped', async () => {
      const admin = await seedPlatformAdmin();
      const adminToken = await factory.loginByEmail(admin.email);
      const target = await factory.createOrganisation();
      const ceo = await factory.createInternalManager(target, { permissions: 'all', type: ManagerType.CEO, label: `ceo-limit-${Date.now()}` });
      const ceoToken = await factory.loginByEmail(ceo.email);

      let suffix = `${Date.now()}-lim0`;
      let stuck = await createExhaustedInitialManager(adminToken, target, suffix);
      await expireLatestInvite(stuck.userId);

      for (let i = 1; i <= 3; i++) {
        const next = `${Date.now()}-lim${i}`;
        const res = await http()
          .post('/rest/v1/managers/initial-manager-invite/replace')
          .set('Authorization', `Bearer ${ceoToken}`)
          .send({ expectedProfileId: stuck.profileId, ...inviteBody(next) });
        expect(res.status).toBe(201);

        const [user] = await adminDataSource.manager.query(`SELECT id FROM core."user" WHERE organisation_id = $1 AND email = $2`, [target.id, `im-${next}@example.test`]);
        // Exhaust and expire the new one so the NEXT iteration's replace is itself eligible.
        await markLatestOutboxSent(target.id, user.id);
        const r2 = await http().post('/rest/v1/managers/initial-manager-invite/resend').set('Authorization', `Bearer ${ceoToken}`);
        expect(r2.status).toBe(201);
        await markLatestOutboxSent(target.id, user.id);
        const r3 = await http().post('/rest/v1/managers/initial-manager-invite/resend').set('Authorization', `Bearer ${ceoToken}`);
        expect(r3.status).toBe(201);
        await markLatestOutboxSent(target.id, user.id);
        await expireLatestInvite(user.id);
        const [newProfile] = await adminDataSource.manager.query(`SELECT id FROM core.manager_profile WHERE user_id = $1`, [user.id]);
        stuck = { profileId: newProfile.id, userId: user.id, email: `im-${next}@example.test` };
      }

      // The 4th CEO-side replacement is refused — the cap is reached (3 superseded rows so far).
      const capped = await http()
        .post('/rest/v1/managers/initial-manager-invite/replace')
        .set('Authorization', `Bearer ${ceoToken}`)
        .send({ expectedProfileId: stuck.profileId, ...inviteBody(`${Date.now()}-over-cap`) });
      expect(capped.status).toBe(409);
      expect(capped.body.code).toBe('REPLACE_LIMIT_REACHED');

      // The Super Admin route, for the SAME organisation, is uncapped.
      const asAdmin = await http()
        .post(`/rest/v1/admin/organisations/${target.id}/initial-manager-invite/replace`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ expectedProfileId: stuck.profileId, ...inviteBody(`${Date.now()}-admin-recovery`) });
      expect(asAdmin.status).toBe(201);
    }, 60_000);
  });

  describe('audit history survives replacement', () => {
    it('the superseded profile\'s prior audit rows (invite created, resent) remain readable, unchanged', async () => {
      const admin = await seedPlatformAdmin();
      const adminToken = await factory.loginByEmail(admin.email);
      const target = await factory.createOrganisation();
      const suffix = `${Date.now()}-audit`;
      const stuck = await createExhaustedInitialManager(adminToken, target, suffix);
      await expireLatestInvite(stuck.userId);

      const before = await adminDataSource.manager.query(`SELECT action FROM core.audit_log WHERE target_user_id = $1 ORDER BY created_at ASC`, [stuck.userId]);
      expect(before.length).toBeGreaterThan(0);

      const res = await http()
        .post(`/rest/v1/admin/organisations/${target.id}/initial-manager-invite/replace`)
        .set('Authorization', `Bearer ${adminToken}`)
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
      const admin = await seedPlatformAdmin();
      const adminToken = await factory.loginByEmail(admin.email);
      const target = await factory.createOrganisation();
      const suffix = `${Date.now()}-stray-fields`;
      const stuck = await createExhaustedInitialManager(adminToken, target, suffix);
      await expireLatestInvite(stuck.userId);

      const res = await http()
        .post(`/rest/v1/admin/organisations/${target.id}/initial-manager-invite/replace`)
        .set('Authorization', `Bearer ${adminToken}`)
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
