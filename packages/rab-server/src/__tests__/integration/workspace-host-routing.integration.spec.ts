import 'reflect-metadata';

// Wave 3 lane H — workspace host routing through the REAL HTTP stack (middleware → guards → interceptor), real sessions,
// real Postgres (RLS) and real Redis (host-label cache). Booted with a base domain but every wave-3 flag OFF (the config is
// validated once at load); flags are switched per block by wrapping EnvironmentService.get, like origin-trust.integration.
//
// The pre-auth registry lookup (`WorkspaceHostLookupService` → lane S2's `core.resolve_workspace_by_host_label` /
// `core.resolve_released_host_label`) is replaced by an in-memory registry here, because lane S2's migration is not on the
// shared test database until integration. Everything else is real. `host-label-registry-contract.integration.spec.ts`
// exercises the real functions against a database that has S2's migration.
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
import { WorkspaceHostResolverService } from '../../engine/core-modules/workspace-host/workspace-host-resolver.service';
import { HostLabelResolution, WORKSPACE_HOST_MISMATCH } from '../../engine/core-modules/workspace-host/workspace-host.types';
import { buildCorsOptionsDelegate, WorkspaceOriginTrustService } from '../../engine/core-modules/workspace-host/workspace-origin-trust.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
const DEFAULT_ORIGIN = 'http://localhost:5173';

describeIfDb('wave 3 lane H — workspace host routing, wrong-host 404, registry-backed origin trust (integration)', () => {
  jest.setTimeout(240_000);

  let app: INestApplication;
  let owner: DataSource;
  let env: EnvironmentService;
  let resolver: WorkspaceHostResolverService;
  let a: TestIdentity;
  let b: TestIdentity;
  let labelA: string;
  let labelB: string;
  let originA: string;
  let originB: string;
  let cookiesA: string[] = [];
  const flags: Partial<Record<keyof EnvironmentVariables, boolean>> = {};
  const registry = new Map<string, HostLabelResolution>();
  const lookup = { lookup: jest.fn(async (label: string) => registry.get(label) ?? ({ kind: 'unknown' } as const)) };

  const http = () => request(app.getHttpServer());
  const sessionCookie = () => cookiesA.filter((c) => c.startsWith('crewflow_session=')).map((c) => c.split(';')[0]).join('; ');
  const setFlags = (next: Partial<Record<keyof EnvironmentVariables, boolean>>) => {
    for (const key of Object.keys(flags) as (keyof EnvironmentVariables)[]) delete flags[key];
    Object.assign(flags, next);
  };
  const ROUTING = { WORKSPACE_HOST_ROUTING_ENABLED: true, WORKSPACE_SUBDOMAIN_ORIGIN_TRUST_ENABLED: true };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(WorkspaceHostLookupService)
      .useValue(lookup)
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    env = moduleRef.get(EnvironmentService);
    resolver = moduleRef.get(WorkspaceHostResolverService);
    const realGet = env.get.bind(env);
    jest.spyOn(env, 'get').mockImplementation(((key: keyof EnvironmentVariables) => (key in flags ? flags[key] : realGet(key))) as EnvironmentService['get']);
    // Mirrors main.ts (Test.createTestingModule never runs bootstrap()).
    app.use(cookieParser());
    app.enableCors(buildCorsOptionsDelegate(moduleRef.get(WorkspaceOriginTrustService), resolver, { credentials: true }));
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
    a = (await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'w3hosta' })).managers[0]!;
    b = (await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'w3hostb' })).managers[0]!;
    const rows = await owner.query(`SELECT id, subdomain FROM core.manager_workspace WHERE id = ANY($1::uuid[])`, [[a.workspaceId, b.workspaceId]]);
    labelA = rows.find((r: { id: string }) => r.id === a.workspaceId).subdomain;
    labelB = rows.find((r: { id: string }) => r.id === b.workspaceId).subdomain;
    originA = `http://${labelA}.rab.test`;
    originB = `http://${labelB}.rab.test`;
    registry.set(labelA, { kind: 'workspace', workspaceId: a.workspaceId!, organisationId: a.organisationId, canonicalLabel: labelA, displayName: null });
    registry.set(labelB, { kind: 'workspace', workspaceId: b.workspaceId!, organisationId: b.organisationId, canonicalLabel: labelB, displayName: null });
    registry.set('w3oldname', { kind: 'renamed', workspaceId: a.workspaceId!, organisationId: a.organisationId, canonicalLabel: labelA, reservedUntil: '2099-01-01T00:00:00.000Z' });

    const login = await http().post('/rest/v1/auth/login').set('Origin', DEFAULT_ORIGIN).send({ email: a.email, password: a.password });
    expect(login.status).toBe(200);
    cookiesA = ([] as string[]).concat(login.headers['set-cookie'] ?? []);
    expect(sessionCookie()).not.toBe('');
  });

  afterAll(async () => {
    await resolver?.invalidateLabels(labelA, labelB, 'w3oldname', 'w3ghost');
    await owner?.destroy();
    await app?.close();
    for (const [key, value] of Object.entries(ORIGINAL)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  describe('flags OFF (default): behaviour exactly as before wave 3', () => {
    beforeAll(() => setFlags({}));

    it('the public resolver says default for every host, and the registry is never consulted', async () => {
      lookup.lookup.mockClear();
      const res = await http().get('/rest/v1/public/workspace-host').set('Origin', originA);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ state: 'default', defaultUrl: 'http://localhost:5173', workspaceBaseDomain: null });
      expect(lookup.lookup).not.toHaveBeenCalled();
    });

    it('a session works from any host (no wrong-host check), and workspace origins get no CORS headers', async () => {
      expect((await http().get('/rest/v1/auth/me').set('Cookie', sessionCookie())).status).toBe(200);
      const preflight = await http().options('/rest/v1/auth/me').set('Origin', originA).set('Access-Control-Request-Method', 'GET');
      expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe.each([
    ['cache ON', true],
    ['cache OFF', false],
  ])('routing + registry trust ON, %s', (_name, cacheOn) => {
    beforeAll(() => setFlags({ ...ROUTING, CORE_ENTITY_CACHE_ENABLED: cacheOn }));

    describe('public resolver', () => {
      it('workspace host via the browser Origin (fixed API host topology)', async () => {
        const res = await http().get('/rest/v1/public/workspace-host').set('Origin', originA);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({
          state: 'workspace',
          defaultUrl: 'http://localhost:5173',
          workspaceBaseDomain: 'rab.test',
          canonicalUrl: originA,
          workspace: { subdomain: labelA, displayName: null },
        });
        // Public branding only: no ids, no owner, no email.
        expect(JSON.stringify(res.body)).not.toContain(a.workspaceId!);
        expect(JSON.stringify(res.body)).not.toContain(a.email);
      });

      it('workspace host via the Host header (same-origin proxied topology)', async () => {
        const res = await http().get('/rest/v1/public/workspace-host').set('Host', `${labelB}.rab.test`);
        expect(res.body).toMatchObject({ state: 'workspace', canonicalUrl: originB });
      });

      it('ABUSE: unknown label → not-found (no fallback to any workspace)', async () => {
        const res = await http().get('/rest/v1/public/workspace-host').set('Origin', 'http://w3ghost.rab.test');
        expect(res.body).toEqual({ state: 'not-found', defaultUrl: 'http://localhost:5173', workspaceBaseDomain: 'rab.test' });
      });

      it('ABUSE: reserved label → not-found', async () => {
        for (const origin of ['http://admin.rab.test', 'http://api-eu.rab.test', 'http://crewflow-support.rab.test']) {
          expect((await http().get('/rest/v1/public/workspace-host').set('Origin', origin)).body.state).toBe('not-found');
        }
      });

      it('ABUSE: released (quarantined) label → renamed, redirect target is the DB canonical host only', async () => {
        const res = await http().get('/rest/v1/public/workspace-host').set('Host', 'w3oldname.rab.test');
        expect(res.body).toEqual({ state: 'renamed', defaultUrl: 'http://localhost:5173', workspaceBaseDomain: 'rab.test', canonicalUrl: originA });
      });

      it('ABUSE: malformed hosts → not-found', async () => {
        for (const host of [`x.${labelA}.rab.test`, `${labelA}.rab.test:8443`, `${labelA}..rab.test`]) {
          expect((await http().get('/rest/v1/public/workspace-host').set('Host', host)).body.state).toBe('not-found');
        }
      });

      it('ABUSE: spoofed X-Forwarded-Host from an untrusted peer is ignored (TRUSTED_PROXY_CIDRS empty)', async () => {
        const res = await http().get('/rest/v1/public/workspace-host').set('X-Forwarded-Host', `${labelA}.rab.test`);
        expect(res.body.state).toBe('default');
      });

      it('there is no way to name a host by query string', async () => {
        const res = await http().get(`/rest/v1/public/workspace-host?host=${labelA}.rab.test`);
        expect(res.body.state).toBe('default');
      });
    });

    describe('CORS / cookie CSRF (registry-backed trust)', () => {
      const preflight = (origin: string) =>
        http().options('/rest/v1/manager-workspaces/me').set('Origin', origin).set('Access-Control-Request-Method', 'PATCH').set('Access-Control-Request-Headers', 'content-type');

      it('the canonical origin of a READY workspace gets ACAO; unknown, reserved, renamed, other-port and https-in-dev do not', async () => {
        expect((await preflight(originA)).headers['access-control-allow-origin']).toBe(originA);
        for (const origin of ['http://w3ghost.rab.test', 'http://admin.rab.test', 'http://w3oldname.rab.test', `${originA}:8080`, `https://${labelA}.rab.test`]) {
          expect((await preflight(origin)).headers['access-control-allow-origin']).toBeUndefined();
        }
      });

      it("W6-E2E-03: on a workspace HOST only that host's own origin and the configured console may read; another workspace's origin may not", async () => {
        const preflightOn = (host: string, origin: string) =>
          http().options('/rest/v1/auth/me').set('Host', host).set('Origin', origin).set('Access-Control-Request-Method', 'GET');
        expect((await preflightOn(`${labelA}.rab.test`, originA)).headers['access-control-allow-origin']).toBe(originA);
        expect((await preflightOn(`${labelA}.rab.test`, DEFAULT_ORIGIN)).headers['access-control-allow-origin']).toBe(DEFAULT_ORIGIN);
        expect((await preflightOn(`${labelA}.rab.test`, originB)).headers['access-control-allow-origin']).toBeUndefined();
        expect((await preflightOn(`${labelB}.rab.test`, originA)).headers['access-control-allow-origin']).toBeUndefined();
        // The API's own host (fixed-API-host topology) still admits every READY workspace origin.
        expect((await preflight(originB)).headers['access-control-allow-origin']).toBe(originB);
      });

      it('ABUSE: a cookie-authenticated unsafe request from a renamed or unknown workspace origin is refused (403, CSRF)', async () => {
        for (const origin of ['http://w3oldname.rab.test', 'http://w3ghost.rab.test']) {
          const res = await http().patch('/rest/v1/manager-workspaces/me').set('Origin', origin).set('Cookie', sessionCookie()).send({ name: 'pwned' });
          expect(res.status).toBe(403);
        }
      });
    });

    describe('the wrong-host check (session of workspace A)', () => {
      it("A's own host: allowed", async () => {
        expect((await http().get('/rest/v1/auth/me').set('Origin', originA).set('Cookie', sessionCookie())).status).toBe(200);
        expect((await http().get('/rest/v1/manager-workspaces/me').set('Host', `${labelA}.rab.test`).set('Cookie', sessionCookie())).status).toBe(200);
      });

      it("ABUSE: B's host with A's cookie (same-origin, B's own page) → 404 WORKSPACE_HOST_MISMATCH, no data, A's own canonical URL only", async () => {
        const res = await http().get('/rest/v1/manager-workspaces/me').set('Host', `${labelB}.rab.test`).set('Cookie', sessionCookie());
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ code: WORKSPACE_HOST_MISMATCH, message: 'Not found.', canonicalUrl: originA });
        expect(JSON.stringify(res.body)).not.toContain(labelB);
      });

      it("W6-E2E-03 ABUSE: a CROSS-origin wrong-host reader (B's origin, API host) learns only the default URL, never A's address", async () => {
        const res = await http().get('/rest/v1/manager-workspaces/me').set('Origin', originB).set('Cookie', sessionCookie());
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ code: WORKSPACE_HOST_MISMATCH, message: 'Not found.', canonicalUrl: DEFAULT_ORIGIN });
        expect(JSON.stringify(res.body)).not.toContain(labelA);
      });

      it("W6-E2E-03 ABUSE: a script on B's origin calling A's HOST with A's cookie: refused, default URL only, and CORS does not let B read it", async () => {
        const res = await http().get('/rest/v1/auth/me').set('Host', `${labelA}.rab.test`).set('Origin', originB).set('Cookie', sessionCookie());
        expect(res.status).toBe(404);
        expect(res.body.canonicalUrl).toBe(DEFAULT_ORIGIN);
        expect(JSON.stringify(res.body)).not.toContain(labelA);
        expect(res.headers['access-control-allow-origin']).toBeUndefined();
      });

      it('ABUSE: the 404 is identical for another workspace, an unknown, a reserved and a renamed host (no disclosure)', async () => {
        const bodies = [];
        for (const origin of [originB, 'http://w3ghost.rab.test', 'http://admin.rab.test', 'http://w3oldname.rab.test']) {
          const res = await http().get('/rest/v1/auth/me').set('Origin', origin).set('Cookie', sessionCookie());
          expect(res.status).toBe(404);
          bodies.push(res.body);
        }
        for (const body of bodies) expect(body).toEqual(bodies[0]);
      });

      it("ABUSE: cross-workspace credentialed write from B's (trusted) origin with A's cookie is refused before the handler", async () => {
        const before = await owner.query('SELECT name FROM core.manager_workspace WHERE id = $1', [a.workspaceId]);
        const res = await http().patch('/rest/v1/manager-workspaces/me').set('Origin', originB).set('Cookie', sessionCookie()).send({ name: 'cross-host write' });
        expect(res.status).toBe(404);
        const after = await owner.query('SELECT name FROM core.manager_workspace WHERE id = $1', [a.workspaceId]);
        expect(after[0].name).toBe(before[0].name);
      });

      it('ABUSE: a Bearer token presented with a wrong-host Origin is refused the same way', async () => {
        const mobile = await http().post('/rest/v1/auth/login').set('x-client-platform', 'mobile').send({ email: a.email, password: a.password, applicationTarget: 'manager_web' });
        expect(mobile.status).toBe(200);
        const res = await http().get('/rest/v1/auth/me').set('Origin', originB).set('Authorization', `Bearer ${mobile.body.accessToken}`);
        expect(res.status).toBe(404);
      });

      it('mobile path unchanged: Bearer on the API host with no Origin works', async () => {
        const mobile = await http().post('/rest/v1/auth/login').set('x-client-platform', 'mobile').send({ email: a.email, password: a.password, applicationTarget: 'manager_web' });
        expect(mobile.status).toBe(200);
        expect((await http().get('/rest/v1/auth/me').set('Authorization', `Bearer ${mobile.body.accessToken}`)).status).toBe(200);
      });

      it('default app host: unchanged', async () => {
        expect((await http().get('/rest/v1/auth/me').set('Origin', DEFAULT_ORIGIN).set('Cookie', sessionCookie())).status).toBe(200);
      });
    });

    describe("W6-E2E-02: signing in on ANOTHER workspace's host", () => {
      const sessionsOf = async (userId: string) =>
        Number((await owner.query('SELECT count(*)::int AS n FROM core.user_session WHERE user_id = $1', [userId]))[0].n);

      it('is refused before any session exists: 404 WORKSPACE_HOST_SIGN_IN_REFUSED, default URL only, no cookie, no session row', async () => {
        const before = await sessionsOf(a.userId);
        const res = await http().post('/rest/v1/auth/login').set('Host', `${labelB}.rab.test`).set('Origin', originB).send({ email: a.email, password: a.password });
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ code: 'WORKSPACE_HOST_SIGN_IN_REFUSED', message: 'Not found.', canonicalUrl: DEFAULT_ORIGIN });
        expect(JSON.stringify(res.body)).not.toContain(labelA);
        expect(([] as string[]).concat(res.headers['set-cookie'] ?? []).filter((c) => /crewflow_session=|rab_rt=/.test(c) && !/Max-Age=0|Expires=Thu, 01 Jan 1970/.test(c))).toEqual([]);
        expect(await sessionsOf(a.userId)).toBe(before);
      });

      it('a wrong password there is still the uniform 401 (the host refusal never answers for bad credentials)', async () => {
        const res = await http().post('/rest/v1/auth/login').set('Host', `${labelB}.rab.test`).set('Origin', originB).send({ email: a.email, password: `${a.password}-wrong` });
        expect(res.status).toBe(401);
      });

      it("an unknown workspace host refuses the same way; the account's OWN host and the default host sign in", async () => {
        const unknown = await http().post('/rest/v1/auth/login').set('Host', 'w3ghost.rab.test').set('Origin', 'http://w3ghost.rab.test').send({ email: a.email, password: a.password });
        expect(unknown.status).not.toBe(200);
        const own = await http().post('/rest/v1/auth/login').set('Host', `${labelA}.rab.test`).set('Origin', originA).send({ email: a.email, password: a.password });
        expect(own.status).toBe(200);
        const dflt = await http().post('/rest/v1/auth/login').set('Origin', DEFAULT_ORIGIN).send({ email: a.email, password: a.password });
        expect(dflt.status).toBe(200);
      });
    });

    it('ABUSE: stale cache after rename — the old host stops routing and stops being trusted at once', async () => {
      const newLabel = `${labelA}-r`;
      expect((await http().get('/rest/v1/public/workspace-host').set('Origin', originA)).body.state).toBe('workspace');
      // Simulate the committed rename in the registry (S2's trigger quarantines the old label), then the service's own
      // post-commit invalidation.
      registry.set(labelA, { kind: 'renamed', workspaceId: a.workspaceId!, organisationId: a.organisationId, canonicalLabel: newLabel, reservedUntil: '2099-01-01T00:00:00.000Z' });
      registry.set(newLabel, { kind: 'workspace', workspaceId: a.workspaceId!, organisationId: a.organisationId, canonicalLabel: newLabel, displayName: null });
      try {
        await resolver.invalidateLabels(labelA, newLabel);
        expect((await http().get('/rest/v1/public/workspace-host').set('Origin', originA)).body).toMatchObject({ state: 'renamed', canonicalUrl: `http://${newLabel}.rab.test` });
        const preflight = await http().options('/rest/v1/auth/me').set('Origin', originA).set('Access-Control-Request-Method', 'GET');
        expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
        expect((await http().get('/rest/v1/auth/me').set('Origin', originA).set('Cookie', sessionCookie())).status).toBe(404);
      } finally {
        registry.set(labelA, { kind: 'workspace', workspaceId: a.workspaceId!, organisationId: a.organisationId, canonicalLabel: labelA, displayName: null });
        registry.delete(newLabel);
        await resolver.invalidateLabels(labelA, newLabel);
      }
      expect((await http().get('/rest/v1/public/workspace-host').set('Origin', originA)).body.state).toBe('workspace');
    });
  });

  describe('real rename through the API invalidates the host cache (old and new label)', () => {
    beforeAll(() => setFlags({ ...ROUTING, CORE_ENTITY_CACHE_ENABLED: true }));

    it('PATCH /manager-workspaces/me/subdomain → invalidateLabels(old, new) after the commit, audit carries old/new', async () => {
      const spy = jest.spyOn(resolver, 'invalidateLabels');
      const renamedTo = `${labelB}-x`;
      const login = await http().post('/rest/v1/auth/login').set('Origin', DEFAULT_ORIGIN).send({ email: b.email, password: b.password });
      const cookieB = ([] as string[]).concat(login.headers['set-cookie'] ?? []).filter((c) => c.startsWith('crewflow_session=')).map((c) => c.split(';')[0]).join('; ');
      const res = await http().patch('/rest/v1/manager-workspaces/me/subdomain').set('Origin', DEFAULT_ORIGIN).set('Cookie', cookieB).send({ subdomain: renamedTo });
      expect(res.status).toBe(200);
      expect(res.body.subdomain).toBe(renamedTo);
      expect(spy).toHaveBeenCalledWith(labelB, renamedTo);
      const audit = await owner.query(
        `SELECT metadata FROM core.audit_log WHERE entity_id = $1 AND action = 'manager_workspace.subdomain_changed' ORDER BY created_at DESC LIMIT 1`,
        [b.workspaceId],
      );
      expect(audit[0]?.metadata).toMatchObject({ oldSubdomain: labelB, newSubdomain: renamedTo });
      spy.mockRestore();
    });

    it('the availability check excludes the caller\'s own workspace (its current label reads available)', async () => {
      const login = await http().post('/rest/v1/auth/login').set('Origin', DEFAULT_ORIGIN).send({ email: a.email, password: a.password });
      const cookie = ([] as string[]).concat(login.headers['set-cookie'] ?? []).filter((c) => c.startsWith('crewflow_session=')).map((c) => c.split(';')[0]).join('; ');
      const own = await http().post('/rest/v1/manager-workspaces/subdomain/check').set('Origin', DEFAULT_ORIGIN).set('Cookie', cookie).send({ candidate: labelA });
      expect(own.body).toMatchObject({ available: true, normalized: labelA });
      const suggestions = await http().post('/rest/v1/manager-workspaces/subdomain/suggestions').set('Origin', DEFAULT_ORIGIN).set('Cookie', cookie).send({ name: 'Night Crew Events' });
      expect(suggestions.status).toBe(200);
      expect(Array.isArray(suggestions.body.suggestions)).toBe(true);
      expect(suggestions.body.suggestions.length).toBeGreaterThan(0);
      expect(suggestions.body.suggestions.length).toBeLessThanOrEqual(3);
    });
  });
});
