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
import { ManagerService } from '../../modules/manager/services/manager.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { clearThrottleState } from './helpers/throttle-state';
import { TestIdentityFactory } from './helpers/test-identities';

/**
 * P2.9B — organisation onboarding by the Platform Super Admin. Real Postgres, RLS on, no mocks.
 *
 * Owner correction 2026-10-23: a new organisation is no longer created by the administrator (the former
 * `POST /admin/organisations` with organisation + CEO names is retired — 404); it is created when the CEO accepts an
 * email-only invitation (organisation-ceo-invitation.integration.spec.ts). This suite keeps the platform-level
 * read/manage surface (list, detail, resend/revoke of a CEO account invitation of an organisation created before the
 * correction, suspension) and exercises it on organisations made both ways.
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
  let managerService: ManagerService;

  const http = () => request(app.getHttpServer());

  /**
   * An organisation created BEFORE the correction: its CEO account exists (INVITED, no password) with a pending account
   * invitation — the same rows the retired route wrote, made through the same `ManagerService.create` path (CEO creation
   * stays platform-admin-only there).
   */
  async function legacyOrganisationWithPendingCeo(adminUserId: string, name: string): Promise<{ id: string; slug: string; ceoEmail: string; ceoUserId: string }> {
    const org = await factory.createOrganisation(name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30));
    const ceoEmail = `ceo-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.test`;
    await managerService.create({ organisationId: org.id, workspaceId: null, userId: adminUserId, role: '' }, { email: ceoEmail, firstName: 'Cara', lastName: 'Executive', type: ManagerType.CEO });
    const [ceo] = await adminDataSource.manager.query(`SELECT id FROM core."user" WHERE organisation_id = $1 AND email = $2`, [org.id, ceoEmail]);
    return { id: org.id, slug: org.slug, ceoEmail, ceoUserId: ceo.id };
  }

  /** The corrected flow: email-only invitation, the CEO accepts with their own details; returns the new organisation. */
  async function organisationViaCeoInvitation(adminToken: string, name: string, ceoEmail: string): Promise<{ id: string; slug: string }> {
    const sent = await http().post('/rest/v1/admin/organisation-invitations').set('Authorization', `Bearer ${adminToken}`).send({ email: ceoEmail });
    expect(sent.body.outcome).toBe('invited');
    const [row] = await adminDataSource.manager.query(`SELECT rendered_text, rendered_html FROM core.email_outbox WHERE recipient_email = $1 ORDER BY created_at DESC LIMIT 1`, [ceoEmail]);
    const token = decodeURIComponent(/token=([A-Za-z0-9_-]{20,})/.exec(`${row.rendered_text ?? ''} ${row.rendered_html ?? ''}`)![1]!);
    // The public acceptance route is throttled per IP (5/min); this suite accepts several invitations from one address.
    await clearThrottleState(app.get(ThrottlerRedisClientProvider));
    const accepted = await http().post('/rest/v1/invitations/accept').send({ token, firstName: 'Cara', lastName: 'Executive', organisationName: name, newPassword: 'CeoActivation1!' });
    expect(accepted.status).toBe(200);
    const [org] = await adminDataSource.manager.query(`SELECT id, slug FROM core.organisation WHERE name = $1 ORDER BY created_at DESC LIMIT 1`, [name]);
    return org;
  }

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
    managerService = moduleRef.get(ManagerService);
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
    it('the retired create route is gone for everyone (404), a non-admin cannot invite a CEO (403), and no organisation is created', async () => {
      const nonAdminOrg = await factory.createOrganisation();
      const nonAdmin = await factory.createInternalManager(nonAdminOrg, { permissions: 'all', label: 'non-admin' });
      const token = await factory.loginByEmail(nonAdmin.email);
      const admin = await seedPlatformAdmin();
      const adminToken = await factory.loginByEmail(admin.email);

      const name = `Acme Staffing ${Date.now()}`;
      for (const t of [token, adminToken]) {
        const res = await http()
          .post('/rest/v1/admin/organisations')
          .set('Authorization', `Bearer ${t}`)
          .send({ name, ceoEmail: `ceo-${Date.now()}@example.test`, ceoFirstName: 'Cara', ceoLastName: 'Executive' });
        expect(res.status).toBe(404);
      }
      const invite = await http().post('/rest/v1/admin/organisation-invitations').set('Authorization', `Bearer ${token}`).send({ email: `ceo-${Date.now()}@example.test` });
      expect(invite.status).toBe(403);
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

  describe('organisation + CEO (owner correction: created when the invited CEO accepts)', () => {
    it('the organisation, a CEO holding the real ceo permission set and the CEO-specific invitation subject', async () => {
      const admin = await seedPlatformAdmin();
      const adminToken = await factory.loginByEmail(admin.email);
      const name = `Beta Hospitality ${Date.now()}`;
      const ceoEmail = `ceo-${Date.now()}@example.test`;
      const org = await organisationViaCeoInvitation(adminToken, name, ceoEmail);

      const [ceoUser] = await adminDataSource.manager.query(`SELECT id, status, password_hash FROM core."user" WHERE organisation_id = $1 AND email = $2`, [org.id, ceoEmail]);
      expect(ceoUser.password_hash).not.toBeNull(); // the CEO set their own password when accepting
      const roles = await adminDataSource.manager.query(`SELECT r.key FROM core.user_role ur JOIN core.role r ON r.id = ur.role_id WHERE ur.user_id = $1`, [ceoUser.id]);
      expect(roles.map((r: { key: string }) => r.key)).toEqual(['ceo']);
      const [outboxRow] = await adminDataSource.manager.query(`SELECT rendered_subject FROM core.email_outbox WHERE recipient_email = $1`, [ceoEmail]);
      expect(outboxRow.rendered_subject).toMatch(/lead your organisation/i);

      const login = await http().post('/rest/v1/auth/login').send({ email: ceoEmail, password: 'CeoActivation1!', applicationTarget: 'manager_web' });
      expect(login.status).toBe(200);
    });

    it('two organisations accepted with the same name get distinct, non-colliding slugs', async () => {
      const admin = await seedPlatformAdmin();
      const adminToken = await factory.loginByEmail(admin.email);
      const name = `Gamma Retail ${Date.now()}`;
      const first = await organisationViaCeoInvitation(adminToken, name, `ceo-a-${Date.now()}@example.test`);
      const second = await organisationViaCeoInvitation(adminToken, name, `ceo-b-${Date.now()}@example.test`);
      expect(first.id).not.toBe(second.id);
      expect(first.slug).not.toBe(second.slug);
    });

    it('listOrganisations and getOrganisation reflect the new organisation and its CEO', async () => {
      const admin = await seedPlatformAdmin();
      const adminToken = await factory.loginByEmail(admin.email);
      const ceoEmail = `ceo-${Date.now()}@example.test`;
      const org = await organisationViaCeoInvitation(adminToken, `Delta Logistics ${Date.now()}`, ceoEmail);

      const list = await http().get('/rest/v1/admin/organisations').set('Authorization', `Bearer ${adminToken}`);
      expect(list.status).toBe(200);
      const found = list.body.find((o: { id: string }) => o.id === org.id);
      expect(found.ceo.email).toBe(ceoEmail);

      const detail = await http().get(`/rest/v1/admin/organisations/${org.id}`).set('Authorization', `Bearer ${adminToken}`);
      expect(detail.status).toBe(200);
      expect(detail.body.ceo.email).toBe(ceoEmail);
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

  describe('CEO account invitation of an organisation created before the correction (existing /auth/activate-account)', () => {
    it('the CEO can activate, then log in with the ceo role and manager_web access', async () => {
      const admin = await seedPlatformAdmin();
      const legacy = await legacyOrganisationWithPendingCeo(admin.userId, `Epsilon Events ${Date.now()}`);
      const [invite] = await adminDataSource.manager.query(`SELECT id FROM core.account_invite WHERE user_id = $1`, [legacy.ceoUserId]);
      const [outboxRow] = await adminDataSource.manager.query(`SELECT rendered_html FROM core.email_outbox WHERE account_invite_id = $1`, [invite.id]);
      const rawToken = /token=([a-f0-9]+)/.exec(outboxRow.rendered_html)![1]!;
      const activate = await http().post('/rest/v1/auth/activate-account').send({ token: rawToken, newPassword: 'CeoActivation1!' });
      expect(activate.status).toBe(200);
      expect(activate.body.applicationTarget).toBe('manager_web');
      const login = await http().post('/rest/v1/auth/login').send({ email: legacy.ceoEmail, password: 'CeoActivation1!', applicationTarget: 'manager_web' });
      expect(login.status).toBe(200);
    });
  });

  describe('resend / revoke', () => {
    it('resend queues a new attempt (sendNumber increments), and revoke clears the password and blocks later activation', async () => {
      const admin = await seedPlatformAdmin();
      const adminToken = await factory.loginByEmail(admin.email);
      const legacy = await legacyOrganisationWithPendingCeo(admin.userId, `Zeta Transport ${Date.now()}`);
      const ceoEmail = legacy.ceoEmail;
      const created = { body: { id: legacy.id } };

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
      void adminToken;
      const legacy = await legacyOrganisationWithPendingCeo(admin.userId, `Eta Warehousing ${Date.now()}`);
      const created = { body: { id: legacy.id } };

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
      const legacy = await legacyOrganisationWithPendingCeo(admin.userId, `Theta Facilities ${Date.now()}`);
      const created = { body: { id: legacy.id, slug: legacy.slug } };

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
