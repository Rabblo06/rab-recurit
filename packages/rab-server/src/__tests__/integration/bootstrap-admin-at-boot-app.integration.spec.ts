import 'reflect-metadata';
import { INestApplication, Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { EnvironmentService } from '../../engine/core-modules/environment/environment.service';
import { EnvironmentVariables } from '../../engine/core-modules/environment/environment-variables';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { applyGlobalValidationPipe } from '../../engine/utils/global-validation-pipe';
import { integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';
import {
  PLATFORM_ADMIN_BOOT_LOG,
  PlatformAdminBootstrapOnBoot,
} from '../../modules/identity/platform-admin-bootstrap/services/platform-admin-bootstrap-on-boot.service';
import { PlatformAdminBootstrapService } from '../../modules/identity/platform-admin-bootstrap/services/platform-admin-bootstrap.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

const describeIfDb = integrationTestDatabaseReady() ? describe : describe.skip;
const ORIGIN = 'http://localhost:5173';
const DOMAIN = 'boot-at-boot-app.example.test';

/**
 * First platform administrator at API boot, end to end through the real HTTP app (security review of #264):
 *   - F1: with AUTH_MFA_ENFORCE_PLATFORM_ADMIN=true (the boot path refuses without it), the admin it creates activates and
 *     then gets the MFA ENROLMENT challenge at sign-in, never a session.
 *   - F2 (defence in depth): a tenant-side manager can never resend / cancel / delete the platform admin's account (404),
 *     whether it is the pending bootstrap admin or an existing account the boot granted.
 *   - F3: an existing staff-only email gets the named refusal; nothing is granted.
 * Bootstrap is global state: each case clears core.platform_admin (ci-server runs --runInBand; see the hygiene note in
 * bootstrap-admin-at-boot.integration.spec.ts); afterAll removes this suite's own rows.
 */
describeIfDb('first platform admin at API boot, through the HTTP app (integration)', () => {
  jest.setTimeout(180_000);

  let app: INestApplication;
  let moduleRef: TestingModule;
  let owner: DataSource;
  let env: EnvironmentService;
  let factory: TestIdentityFactory;
  const grantedUserIds: string[] = [];
  const overrides: Partial<Record<keyof EnvironmentVariables, unknown>> = { AUTH_MFA_ENFORCE_PLATFORM_ADMIN: true };
  const http = () => request(app.getHttpServer());
  const mail = (local: string) => `${local}-${randomUUID().slice(0, 8)}@${DOMAIN}`;
  const boot = () => new PlatformAdminBootstrapOnBoot(moduleRef.get(PlatformAdminBootstrapService), env);
  const loginWeb = (email: string, password: string) => http().post('/rest/v1/auth/login').set('Origin', ORIGIN).send({ email, password });

  async function accessToken(who: TestIdentity): Promise<string> {
    const res = await loginWeb(who.email, who.password);
    if (res.status !== 200) throw new Error(`setup login returned ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.accessToken as string;
  }

  async function activationToken(userId: string): Promise<string> {
    const [invite] = await owner.query(`SELECT id FROM core.account_invite WHERE user_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL`, [userId]);
    const [row] = await owner.query(`SELECT rendered_html FROM core.email_outbox WHERE account_invite_id = $1`, [invite.id]);
    const match = /token=([a-f0-9]+)/.exec(row.rendered_html as string);
    if (!match) throw new Error('no activation token in the rendered outbox email');
    return match[1]!;
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = applyGlobalValidationPipe(moduleRef.createNestApplication());
    env = moduleRef.get(EnvironmentService);
    const realGet = env.get.bind(env);
    jest.spyOn(env, 'get').mockImplementation(((key: keyof EnvironmentVariables) => (key in overrides ? overrides[key] : realGet(key))) as EnvironmentService['get']);
    await app.init(); // the app's own boot hook runs here with BOOTSTRAP_ADMIN_EMAIL unset: a no-op
    owner = createAdminDataSource();
    await owner.initialize();
    factory = new TestIdentityFactory({
      app,
      dataSource: moduleRef.get(DataSource),
      adminDataSource: owner,
      tenantContext: moduleRef.get(TenantContextService),
      passwordHashing: moduleRef.get(PasswordHashingService),
    });
  });

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await owner.query(`DELETE FROM core.platform_admin`);
  });

  afterEach(() => {
    jest.mocked(Logger.prototype.log).mockRestore?.();
    jest.mocked(Logger.prototype.warn).mockRestore?.();
    jest.mocked(Logger.prototype.error).mockRestore?.();
  });

  afterAll(async () => {
    await owner?.query(`DELETE FROM core.platform_admin WHERE user_id = ANY($1::uuid[]) OR user_id IN (SELECT id FROM core."user" WHERE email::text LIKE $2)`, [
      grantedUserIds,
      `%@${DOMAIN}`,
    ]);
    await owner?.destroy();
    await app?.close();
  });

  it('F1: the boot-created admin activates, then sign-in returns the MFA ENROLMENT challenge, not a session', async () => {
    const email = mail('mfa');
    expect(await boot().runOnce({ BOOTSTRAP_ADMIN_EMAIL: email, BOOTSTRAP_ADMIN_ORG_SLUG: `boot-app-${randomUUID().slice(0, 8)}` })).toBe('CREATED_INVITED');
    const [{ user_id: adminId }] = await owner.query(`SELECT user_id FROM core.platform_admin WHERE revoked_at IS NULL`);

    const password = 'Boot-Admin-Pass-2026!';
    const activate = await http().post('/rest/v1/auth/activate-account').send({ token: await activationToken(adminId), newPassword: password });
    expect(activate.status).toBe(200);

    const sessionsBefore = (await owner.query(`SELECT count(*)::int AS n FROM core.user_session WHERE user_id = $1`, [adminId]))[0].n as number;
    const res = await loginWeb(email, password);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'SECOND_FACTOR_REQUIRED', requirement: 'enroll' });
    expect(res.body.challengeToken).toMatch(/^mfc_/);
    expect(res.body.accessToken).toBeUndefined();
    expect(res.headers['set-cookie']).toBeUndefined();
    expect((await owner.query(`SELECT count(*)::int AS n FROM core.user_session WHERE user_id = $1`, [adminId]))[0].n).toBe(sessionsBefore);
  });

  it('F2 DENIAL: a tenant CEO cannot resend or cancel the PENDING bootstrap admin\'s invitation (404); no new invite, no email', async () => {
    const { organisation } = await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'bootf2p' });
    const ceo = await factory.createCeo(organisation, { permissions: 'production' });
    const token = await accessToken(ceo);
    expect(await boot().runOnce({ BOOTSTRAP_ADMIN_EMAIL: mail('pending'), BOOTSTRAP_ADMIN_ORG_SLUG: organisation.slug })).toBe('CREATED_INVITED');
    const [{ user_id: adminId }] = await owner.query(`SELECT user_id FROM core.platform_admin WHERE revoked_at IS NULL`);
    const [{ id: profileId }] = await owner.query(`SELECT id FROM core.manager_profile WHERE user_id = $1`, [adminId]);
    const [{ n: invitesBefore }] = await owner.query(`SELECT count(*)::int AS n FROM core.account_invite WHERE user_id = $1`, [adminId]);

    const resend = await http().post(`/rest/v1/managers/${profileId}/resend-invite`).set('Authorization', `Bearer ${token}`).send({});
    expect(resend.status).toBe(404);
    const cancel = await http().post(`/rest/v1/managers/${profileId}/cancel-invite`).set('Authorization', `Bearer ${token}`).send({});
    expect(cancel.status).toBe(404);
    const [{ n: invitesAfter }] = await owner.query(`SELECT count(*)::int AS n FROM core.account_invite WHERE user_id = $1`, [adminId]);
    expect(invitesAfter).toBe(invitesBefore);
    const [{ status }] = await owner.query(`SELECT status FROM core."user" WHERE id = $1`, [adminId]);
    expect(status).toBe('invited');
  });

  it('F2: an ACTIVE, email-verified manager is granted; afterwards a tenant CEO\'s resend or delete on that account is refused (404)', async () => {
    const { organisation, managers } = await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'bootf2g' });
    const target = managers[0]!;
    const ceo = await factory.createCeo(organisation, { permissions: 'production' });
    const token = await accessToken(ceo);
    await owner.query(`UPDATE core."user" SET email_verified_at = now() WHERE id = $1`, [target.userId]);

    expect(await boot().runOnce({ BOOTSTRAP_ADMIN_EMAIL: target.email })).toBe('GRANTED_EXISTING');
    grantedUserIds.push(target.userId);
    expect(await owner.query(`SELECT user_id FROM core.platform_admin WHERE revoked_at IS NULL`)).toEqual([{ user_id: target.userId }]);

    const resend = await http().post(`/rest/v1/managers/${target.profileId}/resend-invite`).set('Authorization', `Bearer ${token}`).send({});
    expect(resend.status).toBe(404); // before #264 F2: 409 "not a pending invitation", which confirmed the account
    const del = await http().delete(`/rest/v1/managers/${target.profileId}`).set('Authorization', `Bearer ${token}`).send({ currentPassword: ceo.password });
    expect(del.status).toBe(404);
    const [{ deleted_at }] = await owner.query(`SELECT deleted_at FROM core."user" WHERE id = $1`, [target.userId]);
    expect(deleted_at).toBeNull();
  });

  it('F3 DENIAL: an existing staff-only email -> REFUSED_EXISTING_ACCOUNT_NOT_MANAGER, nothing granted, no email', async () => {
    const { organisation, managers } = await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'bootf3' });
    const staff = await factory.createStaff(organisation, { owner: managers[0]!, label: 'bootf3s' });
    await owner.query(`UPDATE core."user" SET email_verified_at = now() WHERE id = $1`, [staff.userId]);
    const errors: string[] = [];
    jest.mocked(Logger.prototype.error).mockImplementation((...args: unknown[]) => void errors.push(String(args[0])));

    expect(await boot().runOnce({ BOOTSTRAP_ADMIN_EMAIL: staff.email })).toBe('REFUSED_EXISTING_ACCOUNT_NOT_MANAGER');
    expect(errors).toContain(PLATFORM_ADMIN_BOOT_LOG.existingNotManager);
    expect(await owner.query(`SELECT user_id FROM core.platform_admin`)).toHaveLength(0);
    expect(await owner.query(`SELECT id FROM core.manager_profile WHERE user_id = $1`, [staff.userId])).toHaveLength(0);
    expect(await owner.query(`SELECT id FROM core.account_invite WHERE user_id = $1 AND created_at > now() - interval '1 minute'`, [staff.userId])).toHaveLength(0);
  });

  it('N1 DENIAL: a tenant actor\'s reset-password, profile update and member suspend on an ACTIVE platform admin each return 404, rows unchanged', async () => {
    const { organisation, managers } = await factory.createOrganisationWithManagers(1, { permissions: 'all', workspace: true, label: 'bootn1' });
    const workspaceOwner = managers[0]!;
    const ceo = await factory.createCeo(organisation, { permissions: 'production' });
    const target = await factory.createInternalManager(organisation, { permissions: 'production', platformAdmin: true, label: 'bootn1pa' });
    grantedUserIds.push(target.userId);
    await owner.query(
      `INSERT INTO core.workspace_membership (organisation_id, user_id, workspace_id, status, source) VALUES ($1, $2, $3, 'active', 'write_path') ON CONFLICT DO NOTHING`,
      [organisation.id, target.userId, workspaceOwner.workspaceId],
    );
    const [before] = await owner.query(`SELECT first_name, password_hash, security_version FROM core."user" WHERE id = $1`, [target.userId]);
    const ceoToken = await accessToken(ceo);
    const ownerToken = await accessToken(workspaceOwner);

    const reset = await http().post(`/rest/v1/managers/${target.profileId}/reset-password`).set('Authorization', `Bearer ${ceoToken}`).send({});
    expect(reset.status).toBe(404);
    const patch = await http().patch(`/rest/v1/managers/${target.profileId}`).set('Authorization', `Bearer ${ceoToken}`).send({ firstName: 'Renamed' });
    expect(patch.status).toBe(404);
    const suspend = await http().post(`/rest/v1/members/${target.userId}/suspend`).set('Authorization', `Bearer ${ownerToken}`).send({});
    expect(suspend.status).toBe(404);

    const [after] = await owner.query(`SELECT first_name, password_hash, security_version FROM core."user" WHERE id = $1`, [target.userId]);
    expect(after).toEqual(before);
    const [membership] = await owner.query(`SELECT status FROM core.workspace_membership WHERE user_id = $1 AND workspace_id = $2`, [target.userId, workspaceOwner.workspaceId]);
    expect(membership.status).toBe('active');
    expect(await owner.query(`SELECT id FROM core.password_reset_token WHERE user_id = $1`, [target.userId])).toHaveLength(0);
  });
});
