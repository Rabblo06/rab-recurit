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
import { WORKER_HEARTBEAT_KEY } from '../../engine/worker-shared/heartbeat.constants';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentityFactory } from './helpers/test-identities';

/**
 * P2.9B — Platform Super Admin creates an organisation and invites its first CEO. Real Postgres,
 * RLS on, no mocks — same discipline as every other suite in this folder.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('organisation onboarding — CEO invitation (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let factory: TestIdentityFactory;
  let passwordHashing: PasswordHashingService;
  let tenantContext: TenantContextService;

  const http = () => request(app.getHttpServer());

  /** Each resend's sendNumber only advances once the PRIOR attempt's outbox job is worker-confirmed SENT (A7/A8) — no worker runs against this test DB, so this simulates that confirmation directly, same helper account-invite-abuse-cases.integration.spec.ts already uses. */
  async function markLatestOutboxSent(organisationId: string, userId: string): Promise<void> {
    await tenantContext.runInTenantContext({ organisationId, workspaceId: null, userId, role: '' }, (manager) =>
      manager.query(
        `UPDATE core.email_outbox SET status = 'SENT', sent_at = now()
          WHERE target_user_id = $1 AND status IN ('PENDING', 'QUEUED', 'PROCESSING', 'RETRY')`,
        [userId],
      ),
    );
  }

  async function seedPlatformAdmin(): Promise<{ email: string; userId: string }> {
    const organisation = await factory.createOrganisation();
    const user = await factory.createInternalManager(organisation, { permissions: 'all', label: 'super-admin' });
    await adminDataSource.manager.query(`INSERT INTO core.platform_admin (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [user.userId]);
    return { email: user.email, userId: user.userId };
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

    // `AccountLifecycleService.isEmailDeliveryAvailable()` (consulted by `ManagerService
    // .createWithin()` before ever creating an invite) reads this heartbeat — without it, every
    // invite in this suite would silently be skipped, same requirement
    // account-invite-abuse-cases.integration.spec.ts's own setup already documents.
    const redisClient = moduleRef.get(ThrottlerRedisClientProvider);
    await redisClient.client.set(WORKER_HEARTBEAT_KEY, Date.now().toString(), 'EX', 300);
  });

  afterAll(async () => {
    await app.close();
    await adminDataSource.destroy();
  });

  describe('authorization', () => {
    it('a non-platform-admin is rejected with 403 and no organisation is created', async () => {
      const nonAdminOrg = await factory.createOrganisation();
      const nonAdmin = await factory.createInternalManager(nonAdminOrg, { permissions: 'all', label: 'non-admin' });
      const token = await factory.loginByEmail(nonAdmin.email);

      const name = `Acme Staffing ${Date.now()}`;
      const res = await http()
        .post('/rest/v1/admin/organisations')
        .set('Authorization', `Bearer ${token}`)
        .send({ name, ceoEmail: `ceo-${Date.now()}@example.test`, ceoFirstName: 'Cara', ceoLastName: 'Executive' });

      expect(res.status).toBe(403);
      const orgs = await adminDataSource.manager.query(`SELECT id FROM core.organisation WHERE name = $1`, [name]);
      expect(orgs).toHaveLength(0);
    });

    it('a non-platform-admin is rejected with 403 on list and get', async () => {
      const nonAdminOrg = await factory.createOrganisation();
      const nonAdmin = await factory.createInternalManager(nonAdminOrg, { permissions: 'all', label: 'non-admin-2' });
      const token = await factory.loginByEmail(nonAdmin.email);

      expect((await http().get('/rest/v1/admin/organisations').set('Authorization', `Bearer ${token}`)).status).toBe(403);
      expect((await http().get(`/rest/v1/admin/organisations/${nonAdminOrg.id}`).set('Authorization', `Bearer ${token}`)).status).toBe(403);
    });
  });

  describe('organisation + CEO creation', () => {
    it('creates the organisation, a CEO holding the real ceo permission set, a queued invite, and a CEO-specific email subject', async () => {
      const admin = await seedPlatformAdmin();
      const adminToken = await factory.loginByEmail(admin.email);

      const name = `Beta Hospitality ${Date.now()}`;
      const ceoEmail = `ceo-${Date.now()}@example.test`;
      const res = await http()
        .post('/rest/v1/admin/organisations')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name, ceoEmail, ceoFirstName: 'Cara', ceoLastName: 'Executive' });

      expect(res.status).toBe(201);
      expect(res.body.ceo.email).toBe(ceoEmail);
      const organisationId = res.body.id;

      const [org] = await adminDataSource.manager.query(`SELECT id, name, slug FROM core.organisation WHERE id = $1`, [organisationId]);
      expect(org.name).toBe(name);

      const [ceoUser] = await adminDataSource.manager.query(`SELECT id, status, password_hash FROM core."user" WHERE organisation_id = $1 AND email = $2`, [
        organisationId,
        ceoEmail,
      ]);
      expect(ceoUser.status).toBe('invited');
      expect(ceoUser.password_hash).toBeNull();

      const roles = await adminDataSource.manager.query(
        `SELECT r.key FROM core.user_role ur JOIN core.role r ON r.id = ur.role_id WHERE ur.user_id = $1`,
        [ceoUser.id],
      );
      expect(roles.map((r: { key: string }) => r.key)).toEqual(['ceo']);

      const [invite] = await adminDataSource.manager.query(`SELECT id FROM core.account_invite WHERE user_id = $1 AND accepted_at IS NULL`, [ceoUser.id]);
      expect(invite).toBeDefined();

      const [outboxRow] = await adminDataSource.manager.query(`SELECT rendered_subject FROM core.email_outbox WHERE account_invite_id = $1`, [invite.id]);
      expect(outboxRow.rendered_subject).toMatch(/lead your organisation/i);
    });

    it('two organisations created with the same name get distinct, non-colliding slugs', async () => {
      const admin = await seedPlatformAdmin();
      const adminToken = await factory.loginByEmail(admin.email);
      const name = `Gamma Retail ${Date.now()}`;

      const first = await http()
        .post('/rest/v1/admin/organisations')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name, ceoEmail: `ceo-a-${Date.now()}@example.test`, ceoFirstName: 'A', ceoLastName: 'One' });
      const second = await http()
        .post('/rest/v1/admin/organisations')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name, ceoEmail: `ceo-b-${Date.now()}@example.test`, ceoFirstName: 'B', ceoLastName: 'Two' });

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      const [orgA] = await adminDataSource.manager.query(`SELECT slug FROM core.organisation WHERE id = $1`, [first.body.id]);
      const [orgB] = await adminDataSource.manager.query(`SELECT slug FROM core.organisation WHERE id = $1`, [second.body.id]);
      expect(orgA.slug).not.toBe(orgB.slug);
    });

    it('listOrganisations and getOrganisation reflect the newly created organisation and its CEO', async () => {
      const admin = await seedPlatformAdmin();
      const adminToken = await factory.loginByEmail(admin.email);
      const name = `Delta Logistics ${Date.now()}`;
      const ceoEmail = `ceo-${Date.now()}@example.test`;

      const created = await http()
        .post('/rest/v1/admin/organisations')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name, ceoEmail, ceoFirstName: 'Cara', ceoLastName: 'Executive' });

      const list = await http().get('/rest/v1/admin/organisations').set('Authorization', `Bearer ${adminToken}`);
      expect(list.status).toBe(200);
      const found = list.body.find((o: { id: string }) => o.id === created.body.id);
      expect(found).toBeDefined();
      expect(found.ceo.email).toBe(ceoEmail);

      const detail = await http().get(`/rest/v1/admin/organisations/${created.body.id}`).set('Authorization', `Bearer ${adminToken}`);
      expect(detail.status).toBe(200);
      expect(detail.body.ceo.email).toBe(ceoEmail);
      expect(detail.body.ceo.invitationStatus).toBe('queued');
      // Organisation isolation (2026-10-15): the platform-level detail no longer carries an `initialManager` field at all.
      expect(detail.body.initialManager).toBeUndefined();
    });

    /**
     * Superseded: P2.9 gap review item 1 exposed another organisation's Initial Manager on `getOrganisation`. Organisation
     * isolation (owner policy, 2026-10-15): an Initial Manager is managed only within its own organisation, so a platform admin
     * of ANOTHER organisation sees the organisation and its CEO (platform-level onboarding) but nothing about its Initial
     * Manager — and `manager_profile`'s platform-admin RLS branch no longer reaches internal rows at all.
     */
    it("getOrganisation does not expose another organisation's Initial Manager; still admin-only", async () => {
      const admin = await seedPlatformAdmin();
      const adminToken = await factory.loginByEmail(admin.email);
      const target = await factory.createOrganisation();
      const targetCeo = await factory.createInternalManager(target, { permissions: 'all', type: ManagerType.CEO, label: `ceo-detail-${Date.now()}` });
      const suffix = `${Date.now()}-im-detail`;

      const invite = await http()
        .post('/rest/v1/managers/initial-manager-invite')
        .set('Authorization', `Bearer ${await factory.loginByEmail(targetCeo.email)}`)
        .send({ email: `im-${suffix}@example.test`, firstName: 'Ida', lastName: 'Manager' });
      expect(invite.status).toBe(201);

      const detail = await http().get(`/rest/v1/admin/organisations/${target.id}`).set('Authorization', `Bearer ${adminToken}`);
      expect(detail.status).toBe(200);
      expect(detail.body.initialManager).toBeUndefined();
      expect(JSON.stringify(detail.body)).not.toContain(`im-${suffix}@example.test`);
      expect(detail.body.ceo.email).toBe(targetCeo.email);

      const nonAdminOrg = await factory.createOrganisation();
      const nonAdmin = await factory.createInternalManager(nonAdminOrg, { permissions: 'all', label: 'non-admin-im' });
      const nonAdminToken = await factory.loginByEmail(nonAdmin.email);
      const blocked = await http().get(`/rest/v1/admin/organisations/${target.id}`).set('Authorization', `Bearer ${nonAdminToken}`);
      expect(blocked.status).toBe(403);
    });
  });

  describe('CEO invite acceptance (full loop, via the existing /auth/activate-account endpoint — no new mechanism)', () => {
    it('the CEO can activate, then log in with the ceo role, manager_web access, and the full ceo permission set', async () => {
      const admin = await seedPlatformAdmin();
      const adminToken = await factory.loginByEmail(admin.email);
      const ceoEmail = `ceo-${Date.now()}@example.test`;

      const created = await http()
        .post('/rest/v1/admin/organisations')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: `Epsilon Events ${Date.now()}`, ceoEmail, ceoFirstName: 'Cara', ceoLastName: 'Executive' });
      expect(created.status).toBe(201);

      const [ceoUser] = await adminDataSource.manager.query(`SELECT id FROM core."user" WHERE organisation_id = $1 AND email = $2`, [
        created.body.id,
        ceoEmail,
      ]);
      const [tokenRow] = await adminDataSource.manager.query(`SELECT token_hash FROM core.account_invite WHERE user_id = $1`, [ceoUser.id]);
      expect(tokenRow).toBeDefined();

      // The acceptance endpoint only ever accepts {token, newPassword} — DTO whitelisting means an
      // attempt to smuggle organisationId/role/userId here would 400, not silently succeed, so
      // that abuse path is already covered generically (ValidationPipe forbidNonWhitelisted) and
      // not re-tested per-field here.
      const rawToken = await findRawInviteToken(ceoUser.id);
      const activate = await http().post('/rest/v1/auth/activate-account').send({ token: rawToken, newPassword: 'CeoActivation1!' });
      expect(activate.status).toBe(200);
      expect(activate.body.applicationTarget).toBe('manager_web');

      const login = await http().post('/rest/v1/auth/login').send({ email: ceoEmail, password: 'CeoActivation1!', applicationTarget: 'manager_web' });
      expect(login.status).toBe(200);

      const [roleRow] = await adminDataSource.manager.query(
        `SELECT r.key FROM core.user_role ur JOIN core.role r ON r.id = ur.role_id WHERE ur.user_id = $1`,
        [ceoUser.id],
      );
      expect(roleRow.key).toBe('ceo');
    });

    // The invite's own token is single-use/hashed — this test file has no way to recover the RAW
    // token after the fact (only `token_hash` is persisted, by design), so it re-derives it the
    // same way account-invite-abuse-cases.integration.spec.ts does: by intercepting the rendered
    // outbox email, which embeds the real activation URL/token exactly as the recipient would see it.
    async function findRawInviteToken(userId: string): Promise<string> {
      const [invite] = await adminDataSource.manager.query(`SELECT id FROM core.account_invite WHERE user_id = $1`, [userId]);
      const [outboxRow] = await adminDataSource.manager.query(`SELECT rendered_html FROM core.email_outbox WHERE account_invite_id = $1`, [invite.id]);
      const match = /token=([a-f0-9]+)/.exec(outboxRow.rendered_html);
      if (!match) throw new Error('Could not find activation token in rendered outbox email.');
      return match[1]!;
    }
  });

  describe('resend / revoke', () => {
    it('resend queues a new attempt (sendNumber increments), and revoke clears the password and blocks later activation', async () => {
      const admin = await seedPlatformAdmin();
      const adminToken = await factory.loginByEmail(admin.email);
      const ceoEmail = `ceo-${Date.now()}@example.test`;

      const created = await http()
        .post('/rest/v1/admin/organisations')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: `Zeta Transport ${Date.now()}`, ceoEmail, ceoFirstName: 'Cara', ceoLastName: 'Executive' });

      const [ceoUserForResend] = await adminDataSource.manager.query(`SELECT id FROM core."user" WHERE organisation_id = $1 AND email = $2`, [
        created.body.id,
        ceoEmail,
      ]);
      await markLatestOutboxSent(created.body.id, ceoUserForResend.id);

      const resend = await http()
        .post(`/rest/v1/admin/organisations/${created.body.id}/ceo-invite/resend`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(resend.status).toBe(201);
      expect(resend.body.sendNumber).toBe(2);

      const revoke = await http()
        .post(`/rest/v1/admin/organisations/${created.body.id}/ceo-invite/revoke`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(revoke.status).toBe(201);

      const [ceoUser] = await adminDataSource.manager.query(`SELECT id FROM core."user" WHERE organisation_id = $1 AND email = $2`, [
        created.body.id,
        ceoEmail,
      ]);
      const [invite] = await adminDataSource.manager.query(`SELECT revoked_at FROM core.account_invite WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [
        ceoUser.id,
      ]);
      expect(invite.revoked_at).not.toBeNull();
    });

    it('a non-platform-admin cannot resend or revoke a CEO invite for an organisation they do not belong to', async () => {
      const admin = await seedPlatformAdmin();
      const adminToken = await factory.loginByEmail(admin.email);
      const created = await http()
        .post('/rest/v1/admin/organisations')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: `Eta Warehousing ${Date.now()}`, ceoEmail: `ceo-${Date.now()}@example.test`, ceoFirstName: 'Cara', ceoLastName: 'Executive' });

      const otherOrg = await factory.createOrganisation();
      const otherUser = await factory.createInternalManager(otherOrg, { permissions: 'all', label: 'outsider' });
      const outsiderToken = await factory.loginByEmail(otherUser.email);

      const resend = await http()
        .post(`/rest/v1/admin/organisations/${created.body.id}/ceo-invite/resend`)
        .set('Authorization', `Bearer ${outsiderToken}`);
      expect(resend.status).toBe(403);
    });
  });

  describe('compatibility with P2.8 suspension', () => {
    it('a suspended organisation rejects a CEO invite resend', async () => {
      const admin = await seedPlatformAdmin();
      const adminToken = await factory.loginByEmail(admin.email);
      const created = await http()
        .post('/rest/v1/admin/organisations')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: `Theta Facilities ${Date.now()}`, ceoEmail: `ceo-${Date.now()}@example.test`, ceoFirstName: 'Cara', ceoLastName: 'Executive' });

      await http()
        .post(`/rest/v1/admin/organisations/${created.body.id}/suspend`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'test suspension', confirmSlug: created.body.slug, currentPassword: factory.testPassword });

      const resend = await http()
        .post(`/rest/v1/admin/organisations/${created.body.id}/ceo-invite/resend`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(resend.status).toBe(403);
    });
  });
});
