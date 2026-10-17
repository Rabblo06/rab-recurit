import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { createAdminDataSource } from './helpers/admin-datasource';
import { MockOidcProvider } from './helpers/mock-oidc-provider';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Cutover safety: with AUTH_OAUTH_HANDOFF_ENABLED unset (the default), the ORIGINAL direct-cookie callback keeps
 * working exactly as before — plus the protections that apply in both modes (browser binding, failure handling).
 * Invitation acceptance with Google exists only in handoff mode and is refused here.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('Google sign-in, legacy direct-cookie mode (cutover default)', () => {
  jest.setTimeout(120_000);
  const google = new MockOidcProvider('legacy-client', 'legacy-secret');
  let app: INestApplication;
  let owner: DataSource;
  let manager: TestIdentity;

  const http = () => request(app.getHttpServer());
  const cookieValue = (res: request.Response, name: string) =>
    ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1).split(';')[0] || undefined;

  beforeAll(async () => {
    process.env.AUTH_GOOGLE_ISSUER_URL = await google.start();
    process.env.AUTH_GOOGLE_CLIENT_ID = 'legacy-client';
    process.env.AUTH_GOOGLE_CLIENT_SECRET = 'legacy-secret';
    delete process.env.AUTH_OAUTH_HANDOFF_ENABLED;
    const { AppModule } = await import('../../app.module');
    const { TenantContextService } = await import('../../engine/core-modules/tenant/tenant-context.service');
    const { PasswordHashingService } = await import('../../engine/core-modules/auth/services/password-hashing.service');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    owner = createAdminDataSource();
    await owner.initialize();
    const factory = new TestIdentityFactory({
      app,
      dataSource: moduleRef.get(DataSource),
      adminDataSource: owner,
      tenantContext: moduleRef.get(TenantContextService),
      passwordHashing: moduleRef.get(PasswordHashingService),
    });
    manager = (await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'legacy' })).managers[0]!;
  });

  afterAll(async () => {
    await app?.close();
    await owner?.destroy();
    await google.stop();
  });

  it('(runs first, before discovery is cached) a provider discovery failure becomes the normal error page (no raw 500), and recovers once the provider is back', async () => {
    await google.stop();
    const down = await http().get('/rest/v1/auth/google');
    expect(down.status).toBe(302);
    expect(down.headers.location).toBe('http://localhost:5173/login?oauthError=1');
    void (await google.start(Number(new URL(process.env.AUTH_GOOGLE_ISSUER_URL!).port)));
    const up = await http().get('/rest/v1/auth/google');
    expect(up.status).toBe(302);
    expect(up.headers.location).toContain('/authorize');
  });

  it('the callback sets the session cookies itself and redirects without any credential in the URL', async () => {
    const startRes = await http().get('/rest/v1/auth/google').query({ returnTo: '/venues' });
    const tx = cookieValue(startRes, 'crewflow_oauth_tx')!;
    const { code, state } = google.issueCode(startRes.headers.location as string, { sub: `g-${randomUUID()}`, email: manager.email });
    const cb = await http().get('/rest/v1/auth/google/callback').query({ code, state }).set('Cookie', `crewflow_oauth_tx=${tx}`);
    expect(cb.status).toBe(302);
    expect(cb.headers.location).toBe('http://localhost:5173/oauth/callback-complete?mustResetPassword=false&returnTo=%2Fvenues');
    const session = cookieValue(cb, 'crewflow_session');
    expect(session).toMatch(/^crewflow_sess_/);
    expect(cookieValue(cb, 'crewflow_oauth_handoff')).toBeUndefined();
    expect((await http().get('/rest/v1/auth/me').set('Cookie', `crewflow_session=${session}`)).status).toBe(200);
  });

  it('browser binding applies in legacy mode too (login CSRF closed)', async () => {
    const startRes = await http().get('/rest/v1/auth/google');
    const { code, state } = google.issueCode(startRes.headers.location as string, { sub: `g-${randomUUID()}`, email: manager.email });
    const cb = await http().get('/rest/v1/auth/google/callback').query({ code, state });
    expect(cb.headers.location).toBe('http://localhost:5173/login?oauthError=1');
    expect(cookieValue(cb, 'crewflow_session')).toBeUndefined();
  });

  it('Google invitation acceptance and the handoff endpoints are unavailable', async () => {
    const res = await http().post('/rest/v1/auth/google/invitation').type('form').send({ token: 'x'.repeat(43) });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('http://localhost:5173/accept-invitation?oauthError=1');
    expect((await http().post('/rest/v1/auth/oauth/complete').set('Origin', 'http://localhost:5173').send({})).status).toBe(401);
  });

});
