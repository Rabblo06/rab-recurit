import 'reflect-metadata';
import { HttpException, INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { AuthService } from '../../engine/core-modules/auth/services/auth.service';
import { OrganisationAuthProvidersService } from '../../engine/core-modules/auth/services/organisation-auth-providers.service';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { AccessTokenService } from '../../engine/core-modules/auth/token/services/access-token.service';
import { RefreshTokenService } from '../../engine/core-modules/auth/token/services/refresh-token.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Wave 1 lane A — organisation "password sign-in disabled" (CF-06 / finding D-A2). Complements
 * password-provider-disabled.integration.spec.ts (web/mobile/forgot/reset) with:
 *  - the service layer called directly (CLAUDE.md layer 2 — no controller, no guard);
 *  - "account switching" across organisations: the same email in two organisations, one with password sign-in off —
 *    the other organisation's setting can neither bypass nor be blocked by it;
 *  - finding D-A2, owner decision "log them out": turning password sign-in off revokes the organisation's live password
 *    sessions in the SAME transaction as the setting change (existing revokeFamily/security-version path), audited;
 *    Google sessions, the exempt mobile workforce and other organisations are untouched; a failed revocation rolls the
 *    setting change back.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('wave 1 lane A — password sign-in disabled: enforcement, cross-organisation, revocation hook (integration)', () => {
  jest.setTimeout(180_000);

  let app: INestApplication;
  let owner: DataSource;
  let auth: AuthService;
  let providers: OrganisationAuthProvidersService;
  let refreshTokens: RefreshTokenService;
  let tenantContext: TenantContextService;
  let accessTokens: AccessTokenService;
  let managerA: TestIdentity;
  let staffA: TestIdentity;
  let managerB: TestIdentity;
  let orgA: string;
  let managerAMobile: { accessToken: string; refreshToken: string };
  let staffAMobile: { accessToken: string; refreshToken: string };
  let managerBMobile: { accessToken: string; refreshToken: string };
  let managerAGoogle: { accessToken: string; refreshToken: string };
  let managerC: TestIdentity;
  let orgC: string;

  const http = () => request(app.getHttpServer());
  const refresh = (token: string) => http().post('/rest/v1/auth/refresh').set('x-client-platform', 'mobile').send({ refreshToken: token });
  const serviceLogin = async (email: string, password: string): Promise<number> => {
    try {
      await auth.login({ email, password }, { ip: '203.0.113.50' });
      return 200;
    } catch (error) {
      return error instanceof HttpException ? error.getStatus() : -1;
    }
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    owner = createAdminDataSource();
    await owner.initialize();
    auth = moduleRef.get(AuthService);
    providers = moduleRef.get(OrganisationAuthProvidersService);
    refreshTokens = moduleRef.get(RefreshTokenService);
    tenantContext = moduleRef.get(TenantContextService);
    accessTokens = moduleRef.get(AccessTokenService);
    const infra = { app, dataSource: moduleRef.get(DataSource), adminDataSource: owner, tenantContext, passwordHashing: moduleRef.get(PasswordHashingService) };
    // Two factories ⇒ two different passwords (one per organisation's account).
    const factoryA = new TestIdentityFactory(infra);
    const factoryB = new TestIdentityFactory(infra);
    const seededA = await factoryA.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'w1pwA' });
    const seededB = await factoryB.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'w1pwB' });
    orgA = seededA.organisation.id;
    managerA = seededA.managers[0]!;
    staffA = await factoryA.createStaff(seededA.organisation, { owner: managerA, label: 'w1pwAs' });
    managerB = seededB.managers[0]!;
    const seededC = await factoryA.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'w1pwC' });
    orgC = seededC.organisation.id;
    managerC = seededC.managers[0]!;
    await owner.query(`UPDATE core.organisation SET google_auth_enabled = true WHERE id = ANY($1)`, [[orgA, orgC]]);
    // A Google (SSO) session for managerA, made while the email is still unique (a first link needs exactly one match).
    const google = await auth.signInWithProvider('google', { subject: `w1-pw-${randomUUID()}`, email: managerA.email, emailVerified: true }, { ip: '203.0.113.51' });
    managerAGoogle = { accessToken: google.accessToken, refreshToken: google.refreshToken };
    // Historical cross-organisation duplicate: managerB now has managerA's email (with its own, different password).
    await factoryB.makeHistoricalDuplicateEmail(managerB.userId, managerA.email);
    managerB = { ...managerB, email: managerA.email };

    // Sessions that exist BEFORE password sign-in is turned off.
    managerAMobile = await factoryA.loginTokens(managerA);
    staffAMobile = await factoryA.loginTokens(staffA);
    managerBMobile = await factoryB.loginTokens(managerB);

    // Turn it off through the real service (the Settings → Security path), not raw SQL.
    await providers.update({ organisationId: orgA, workspaceId: managerA.workspaceId, userId: managerA.userId, role: '' }, { passwordAuthEnabled: false, googleAuthEnabled: true });
  });

  afterAll(async () => {
    if (owner?.isInitialized && orgA) await owner.query(`UPDATE core.organisation SET password_auth_enabled = true WHERE id = ANY($1)`, [[orgA, orgC]]);
    await owner?.destroy();
    await app?.close();
  });

  it('normal web sign-in is refused with the uniform wrong-credentials response', async () => {
    const refused = await http().post('/rest/v1/auth/login').send({ email: managerA.email, password: managerA.password });
    const wrong = await http().post('/rest/v1/auth/login').send({ email: managerA.email, password: 'not-the-password' });
    expect(refused.status).toBe(401);
    expect(refused.body).toEqual(wrong.body);
    expect(refused.headers['set-cookie']).toBeUndefined();
  });

  it('a direct API call (no Origin, no browser, explicit manager_web target, mobile header) cannot get around it', async () => {
    const res = await http().post('/rest/v1/auth/login').set('x-client-platform', 'mobile').send({ email: managerA.email, password: managerA.password, applicationTarget: 'manager_web' });
    expect(res.status).toBe(401);
    expect(res.body.refreshToken).toBeUndefined();
  });

  it('the service layer enforces it on its own (no controller, no guard involved)', async () => {
    expect(await serviceLogin(managerA.email, managerA.password)).toBe(401);
  });

  it('account switching across organisations: the same email signs in to the OTHER organisation (password on) with that account\'s password only', async () => {
    const res = await http().post('/rest/v1/auth/login').set('x-client-platform', 'mobile').send({ email: managerB.email, password: managerB.password, applicationTarget: 'manager_web' });
    expect(res.status).toBe(200);
    const claims = accessTokens.verify(res.body.accessToken as string);
    expect(claims.org).toBe(managerB.organisationId);
    expect(claims.sub).toBe(managerB.userId);
    // ...and org B's enabled setting never carries over to org A's account: org A's password is still refused.
    expect(await serviceLogin(managerA.email, managerA.password)).toBe(401);
  });

  it('the mobile workforce exemption is unchanged: org A staff still sign in on their own app', async () => {
    const res = await http().post('/rest/v1/auth/login').set('x-client-platform', 'mobile').send({ email: staffA.email, password: staffA.password });
    expect(res.status).toBe(200);
  });

  it('D-A2 "log them out": the toggle revoked org A manager password sessions — refresh and the outstanding access token both fail', async () => {
    expect((await refresh(managerAMobile.refreshToken)).status).toBe(401);
    expect((await http().get('/rest/v1/auth/me').set('Authorization', `Bearer ${managerAMobile.accessToken}`)).status).toBe(401);
    const [row] = await owner.query(
      `SELECT count(*)::int AS n FROM core.user_session WHERE user_id = $1 AND auth_provider = 'password' AND revoked_reason = 'password_sign_in_disabled'`,
      [managerA.userId],
    );
    expect(row.n).toBeGreaterThanOrEqual(1);
  });

  it('Google (SSO) sessions survive and keep working', async () => {
    expect((await http().get('/rest/v1/auth/me').set('Authorization', `Bearer ${managerAGoogle.accessToken}`)).status).toBe(200);
    expect((await refresh(managerAGoogle.refreshToken)).status).toBe(200);
  });

  it('the exempt mobile workforce and the other organisation are untouched', async () => {
    expect((await refresh(staffAMobile.refreshToken)).status).toBe(200);
    expect((await refresh(managerBMobile.refreshToken)).status).toBe(200);
  });

  it('it is audited, in the same organisation, with the revoked count', async () => {
    const rows = await owner.query(
      `SELECT action, metadata FROM core.audit_log WHERE organisation_id = $1 AND action IN ('organisation.password_sessions_revoked', 'organisation.auth_providers_updated') ORDER BY created_at`,
      [orgA],
    );
    const revokedRow = rows.find((r: { action: string }) => r.action === 'organisation.password_sessions_revoked');
    const updatedRow = rows.find((r: { action: string }) => r.action === 'organisation.auth_providers_updated');
    expect(revokedRow?.metadata).toMatchObject({ reason: 'password_sign_in_disabled' });
    expect(revokedRow.metadata.revoked).toBeGreaterThanOrEqual(1);
    expect(revokedRow.metadata.exempt).toBeGreaterThanOrEqual(1);
    expect(updatedRow.metadata.passwordSessionsRevoked).toBe(revokedRow.metadata.revoked);
  });

  it('same transaction: if a revocation fails, the setting change rolls back too (password stays on, the session stays live)', async () => {
    const tokens = await request(app.getHttpServer())
      .post('/rest/v1/auth/login')
      .set('x-client-platform', 'mobile')
      .send({ email: managerC.email, password: managerC.password, applicationTarget: 'manager_web' });
    expect(tokens.status).toBe(200);
    const spy = jest.spyOn(refreshTokens, 'revokeFamily').mockRejectedValueOnce(new Error('simulated revocation failure'));
    try {
      await expect(
        providers.update({ organisationId: orgC, workspaceId: managerC.workspaceId, userId: managerC.userId, role: '' }, { passwordAuthEnabled: false }),
      ).rejects.toThrow(/simulated revocation failure/);
    } finally {
      spy.mockRestore();
    }
    const [org] = await owner.query(`SELECT password_auth_enabled FROM core.organisation WHERE id = $1`, [orgC]);
    expect(org.password_auth_enabled).toBe(true);
    const [audit] = await owner.query(`SELECT count(*)::int AS n FROM core.audit_log WHERE organisation_id = $1 AND action = 'organisation.password_sessions_revoked'`, [orgC]);
    expect(audit.n).toBe(0);
    expect((await refresh(tokens.body.refreshToken as string)).status).toBe(200);
  });

  it('re-enabling password sign-in revokes nothing', async () => {
    const before = (await owner.query(`SELECT count(*)::int AS n FROM core.user_session WHERE organisation_id = $1 AND revoked_at IS NOT NULL`, [orgA]))[0].n;
    await providers.update({ organisationId: orgA, workspaceId: managerA.workspaceId, userId: managerA.userId, role: '' }, { passwordAuthEnabled: true });
    const after = (await owner.query(`SELECT count(*)::int AS n FROM core.user_session WHERE organisation_id = $1 AND revoked_at IS NOT NULL`, [orgA]))[0].n;
    expect(after).toBe(before);
  });
});
