import 'reflect-metadata';

// Wave 1 lane A (finding D-C1). Booted with a workspace base domain configured but WITHOUT the opt-in flag (the default);
// the flag is then switched on for one block by wrapping EnvironmentService.get (the config is validated once at load).
// Wave 3 lane H: trust is now REGISTRY-backed — with the flag on, only the canonical origin of a registered READY workspace
// is trusted. The pre-auth registry lookup is an in-memory stand-in here (lane S2's functions are not on the shared test
// database until integration); `acme` is registered, `ghost` is not.
const ORIGINAL = { WORKSPACE_BASE_DOMAIN: process.env.WORKSPACE_BASE_DOMAIN, CORS_ORIGINS: process.env.CORS_ORIGINS };
process.env.WORKSPACE_BASE_DOMAIN = 'rab.test';
process.env.CORS_ORIGINS = 'http://localhost:5173';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { EnvironmentService } from '../../engine/core-modules/environment/environment.service';
import { EnvironmentVariables } from '../../engine/core-modules/environment/environment-variables';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { WorkspaceHostLookupService } from '../../engine/core-modules/workspace-host/workspace-host-lookup.service';
import { buildCorsOriginCallback, WorkspaceOriginTrustService } from '../../engine/core-modules/workspace-host/workspace-origin-trust.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
const TRUSTED = 'http://localhost:5173';

describeIfDb('wave 1 lane A — credentialed origin trust: CORS, cookie CSRF, login provenance, /auth/refresh (integration)', () => {
  jest.setTimeout(180_000);

  let app: INestApplication;
  let owner: DataSource;
  let env: EnvironmentService;
  let manager: TestIdentity;
  let flagOn = false;
  let cookies: string[] = [];

  const http = () => request(app.getHttpServer());
  const cookieHeader = (names: string[]) => cookies.filter((c) => names.some((n) => c.startsWith(`${n}=`))).map((c) => c.split(';')[0]).join('; ');

  beforeAll(async () => {
    const lookup = {
      lookup: async (label: string) =>
        label === 'acme'
          ? { kind: 'workspace' as const, workspaceId: '00000000-0000-4000-8000-0000000000ac', organisationId: '00000000-0000-4000-8000-0000000000a0', canonicalLabel: 'acme', displayName: null }
          : { kind: 'unknown' as const },
    };
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(WorkspaceHostLookupService).useValue(lookup).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    env = moduleRef.get(EnvironmentService);
    const realGet = env.get.bind(env);
    jest.spyOn(env, 'get').mockImplementation(((key: keyof EnvironmentVariables) =>
      key === 'WORKSPACE_SUBDOMAIN_ORIGIN_TRUST_ENABLED' || key === 'WORKSPACE_HOST_ROUTING_ENABLED' ? flagOn : realGet(key)) as EnvironmentService['get']);
    // Mirrors main.ts (Test.createTestingModule never runs bootstrap()): cookie parsing and the CORS predicate.
    app.use(cookieParser());
    app.enableCors({ origin: buildCorsOriginCallback(moduleRef.get(WorkspaceOriginTrustService)), credentials: true });
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
    manager = (await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'w1origin' })).managers[0]!;
    const login = await http().post('/rest/v1/auth/login').set('Origin', TRUSTED).send({ email: manager.email, password: manager.password });
    expect(login.status).toBe(200);
    cookies = ([] as string[]).concat(login.headers['set-cookie'] ?? []);
    expect(cookieHeader(['crewflow_session'])).not.toBe('');
  });

  afterAll(async () => {
    await owner?.destroy();
    await app?.close();
    for (const [key, value] of Object.entries(ORIGINAL)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const preflight = (origin: string) =>
    http().options('/rest/v1/auth/login').set('Origin', origin).set('Access-Control-Request-Method', 'POST').set('Access-Control-Request-Headers', 'content-type');

  describe('flag OFF (default)', () => {
    beforeAll(() => {
      flagOn = false;
    });

    it('CORS: the exact allowlisted origin gets ACAO; a workspace subdomain and a reserved sibling get none', async () => {
      expect((await preflight(TRUSTED)).headers['access-control-allow-origin']).toBe(TRUSTED);
      expect((await preflight('http://acme.rab.test')).headers['access-control-allow-origin']).toBeUndefined();
      expect((await preflight('http://api.rab.test')).headers['access-control-allow-origin']).toBeUndefined();
    });

    it('login provenance: a workspace-subdomain Origin is refused with 403 before any credential work', async () => {
      const res = await http().post('/rest/v1/auth/login').set('Origin', 'http://acme.rab.test').send({ email: manager.email, password: manager.password });
      expect(res.status).toBe(403);
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('cookie CSRF: a cookie-authenticated unsafe request from a workspace subdomain is refused (403)', async () => {
      const bad = await http().post('/rest/v1/auth/logout').set('Origin', 'http://acme.rab.test').set('Cookie', cookieHeader(['crewflow_session'])).send({});
      expect(bad.status).toBe(403);
    });

    it('/auth/refresh duplicate check: a cookie refresh from a workspace subdomain or with no Origin is refused (403)', async () => {
      const rt = cookieHeader(['rab_rt']);
      expect((await http().post('/rest/v1/auth/refresh').set('Origin', 'http://acme.rab.test').set('Cookie', rt)).status).toBe(403);
      expect((await http().post('/rest/v1/auth/refresh').set('Cookie', rt)).status).toBe(403);
    });
  });

  describe('flag ON', () => {
    beforeAll(() => {
      flagOn = true;
    });
    afterAll(() => {
      flagOn = false;
    });

    it('CORS: a REGISTERED READY workspace origin gets ACAO; unregistered, reserved, IDN labels and other ports never do', async () => {
      expect((await preflight('http://acme.rab.test')).headers['access-control-allow-origin']).toBe('http://acme.rab.test');
      for (const origin of ['http://ghost.rab.test', 'http://api.rab.test', 'http://admin.rab.test', 'http://mail.rab.test', 'http://xn--pple-43d.rab.test', 'http://acme.rab.test:8080', 'http://acme.rab.test.evil.example']) {
        expect((await preflight(origin)).headers['access-control-allow-origin']).toBeUndefined();
      }
    });

    it('login provenance: reserved sibling hosts are refused with 403', async () => {
      for (const origin of ['http://api.rab.test', 'http://admin.rab.test']) {
        const res = await http().post('/rest/v1/auth/login').set('Origin', origin).send({ email: manager.email, password: manager.password });
        expect(res.status).toBe(403);
      }
    });

    it('cookie CSRF: a credentialed POST from api.<base> is refused (403)', async () => {
      const res = await http().post('/rest/v1/auth/logout').set('Origin', 'http://api.rab.test').set('Cookie', cookieHeader(['crewflow_session'])).send({});
      expect(res.status).toBe(403);
    });

    it('/auth/refresh duplicate check: refused from a reserved or unregistered label, but a registered workspace origin passes the origin check (then fails only on the bogus token)', async () => {
      expect((await http().post('/rest/v1/auth/refresh').set('Origin', 'http://api.rab.test').set('Cookie', 'rab_rt=not-a-real-token')).status).toBe(403);
      expect((await http().post('/rest/v1/auth/refresh').set('Origin', 'http://ghost.rab.test').set('Cookie', 'rab_rt=not-a-real-token')).status).toBe(403);
      expect((await http().post('/rest/v1/auth/refresh').set('Origin', 'http://acme.rab.test').set('Cookie', 'rab_rt=not-a-real-token')).status).toBe(401);
    });
  });

  it('mobile Bearer path is unchanged: a body refresh with no Origin works, and the Bearer token authenticates', async () => {
    const login = await http().post('/rest/v1/auth/login').set('x-client-platform', 'mobile').send({ email: manager.email, password: manager.password, applicationTarget: 'manager_web' });
    expect(login.status).toBe(200);
    const refreshed = await http().post('/rest/v1/auth/refresh').set('x-client-platform', 'mobile').send({ refreshToken: login.body.refreshToken });
    expect(refreshed.status).toBe(200);
    expect((await http().get('/rest/v1/auth/me').set('Authorization', `Bearer ${refreshed.body.accessToken}`)).status).toBe(200);
  });
});
