import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { PasswordResetTokenService } from '../../engine/core-modules/auth/token/services/password-reset-token.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { PasswordResetTokenPurpose } from '@rab/shared';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * CF-06 (owner decision 2026-10-15): an organisation that turns password sign-in off gets it enforced by the backend for
 * web/manager sign-in, forgot-password and reset-password, while its mobile workforce (identities whose roles are
 * exclusively staff and/or venue_manager, signing in to their own mobile app) keeps password sign-in and recovery. A
 * spoofed mobile header never lets a manager-tier account bypass the setting. Before: no check anywhere.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
const NEW_PASSWORD = 'Correct-Horse-42-battery-staple'; // gitleaks:allow (test-only fixture password)

describeIfDb('CF-06 organisation password sign-in disabled (integration)', () => {
  jest.setTimeout(180_000);

  let app: INestApplication;
  let owner: DataSource;
  let factory: TestIdentityFactory;
  let tenantContext: TenantContextService;
  let resetTokens: PasswordResetTokenService;
  let manager: TestIdentity;
  let staff: TestIdentity;
  let venueManager: TestIdentity;
  let organisationId: string;

  const http = () => request(app.getHttpServer());
  const login = (identity: TestIdentity, opts: { mobile?: boolean; applicationTarget?: string } = {}) => {
    const req = http().post('/rest/v1/auth/login');
    if (opts.mobile) req.set('x-client-platform', 'mobile');
    return req.send({ email: identity.email, password: identity.password, ...(opts.applicationTarget ? { applicationTarget: opts.applicationTarget } : {}) });
  };
  const setPasswordEnabled = (enabled: boolean) =>
    owner.query(`UPDATE core.organisation SET password_auth_enabled = $2, google_auth_enabled = true WHERE id = $1`, [organisationId, enabled]);
  const resetTokenCount = async (userId: string) =>
    (await owner.query(`SELECT count(*)::int AS n FROM core.password_reset_token WHERE user_id = $1`, [userId]))[0].n as number;
  const issueToken = (identity: TestIdentity) =>
    tenantContext.runInTenantContext({ organisationId, workspaceId: null, userId: identity.userId, role: '' }, (m) =>
      resetTokens.issue(m, { organisationId, userId: identity.userId, purpose: PasswordResetTokenPurpose.FORGOT_PASSWORD, ttlMs: 3_600_000 }),
    );

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    owner = createAdminDataSource();
    await owner.initialize();
    tenantContext = moduleRef.get(TenantContextService);
    resetTokens = moduleRef.get(PasswordResetTokenService);
    factory = new TestIdentityFactory({ app, dataSource: moduleRef.get(DataSource), adminDataSource: owner, tenantContext, passwordHashing: moduleRef.get(PasswordHashingService) });
    const seeded = await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'cf06' });
    manager = seeded.managers[0]!;
    organisationId = seeded.organisation.id;
    staff = await factory.createStaff(seeded.organisation, { owner: manager, label: 'cf06s' });
    venueManager = await factory.createVenueManager(seeded.organisation, { owner: manager, label: 'cf06v' });
    await setPasswordEnabled(false);
  });

  afterAll(async () => {
    // Always restore: a password-off organisation is valid only while another provider is enabled deployment-wide.
    if (owner?.isInitialized && organisationId) await setPasswordEnabled(true);
    await owner?.destroy();
    await app?.close();
  });

  it('web / manager password sign-in is refused with the uniform message, and audited', async () => {
    const res = await login(manager);
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Invalid email or password.');
    expect(res.headers['set-cookie']).toBeUndefined();
    const [row] = await owner.query(
      `SELECT count(*)::int AS n FROM core.audit_log WHERE action = 'auth.password_sign_in_provider_disabled' AND target_user_id = $1`,
      [manager.userId],
    );
    expect(row.n).toBeGreaterThanOrEqual(1);
  });

  it('a spoofed mobile header, or an explicit mobile target, does not let a manager-tier account through', async () => {
    expect((await login(manager, { mobile: true })).status).toBe(401);
    expect((await login(manager, { mobile: true, applicationTarget: 'staff_app' })).status).toBe(401);
    expect((await login(manager, { applicationTarget: 'staff_app' })).status).toBe(401);
  });

  it('mobile Staff and Venue Manager keep password sign-in on their own app', async () => {
    const s = await login(staff, { mobile: true });
    expect(s.status).toBe(200);
    expect(s.body.accessToken).toEqual(expect.any(String));
    const v = await login(venueManager, { mobile: true });
    expect(v.status).toBe(200);
  });

  it('the exemption needs EXCLUSIVELY workforce roles: a manager who also holds the staff role is refused on mobile', async () => {
    await owner.query(
      `INSERT INTO core.user_role (user_id, role_id, organisation_id)
       SELECT $1, r.id, r.organisation_id FROM core.role r WHERE r.organisation_id = $2 AND r.key = 'staff' ON CONFLICT DO NOTHING`,
      [manager.userId, organisationId],
    );
    expect((await login(manager, { mobile: true })).status).toBe(401);
  });

  it('forgot-password issues no reset link for a manager, but does for exempt Staff (response identical either way)', async () => {
    const mBefore = await resetTokenCount(manager.userId);
    const sBefore = await resetTokenCount(staff.userId);
    const a = await http().post('/rest/v1/auth/forgot-password').send({ email: manager.email });
    const b = await http().post('/rest/v1/auth/forgot-password').set('x-client-platform', 'mobile').send({ email: staff.email });
    expect([a.status, b.status]).toEqual([b.status, a.status]);
    expect(a.body).toEqual(b.body);
    expect(await resetTokenCount(manager.userId)).toBe(mBefore);
    expect(await resetTokenCount(staff.userId)).toBe(sBefore + 1);
  });

  it('a recovery link cannot set a manager password while password sign-in is off (token not consumed); Staff recovery works', async () => {
    const managerToken = await issueToken(manager);
    const refused = await http().post('/rest/v1/auth/reset-password').send({ token: managerToken.token, newPassword: NEW_PASSWORD });
    expect(refused.status).toBe(400);
    const [unconsumed] = await owner.query(`SELECT used_at FROM core.password_reset_token WHERE id = $1`, [managerToken.id]);
    expect(unconsumed.used_at).toBeNull();

    const staffToken = await issueToken(staff);
    const ok = await http().post('/rest/v1/auth/reset-password').send({ token: staffToken.token, newPassword: NEW_PASSWORD });
    expect(ok.status).toBeLessThan(300);
  });

  it('turning password sign-in back on restores manager sign-in', async () => {
    await owner.query(`DELETE FROM core.user_role ur USING core.role r WHERE ur.role_id = r.id AND ur.user_id = $1 AND r.key = 'staff'`, [manager.userId]);
    await setPasswordEnabled(true);
    expect((await login(manager)).status).toBe(200);
    await setPasswordEnabled(false);
  });
});
