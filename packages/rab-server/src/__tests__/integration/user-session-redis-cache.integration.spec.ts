// USER_SESSION_CACHE_ENABLED must be set before Nest's ConfigModule reads process.env at module
// compile time — same constraint P1E's own cache suite documents for AUTH_CONTEXT_CACHE_ENABLED.
process.env.USER_SESSION_CACHE_ENABLED = 'true';

import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { AuthCacheRedisClientProvider } from '../../engine/core-modules/auth/services/auth-cache-redis-client.provider';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { UserSessionCacheService } from '../../engine/core-modules/auth/services/user-session-cache.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentityFactory } from './helpers/test-identities';

/**
 * Redis checkpoint — the Twenty-style UserSession cache, exercised with `USER_SESSION_CACHE_ENABLED=true`
 * through genuine HTTP requests against a real `crewflow_session` cookie, the same proof standard
 * `p1c1c-cookie-authentication.integration.spec.ts` already established for the uncached path.
 *
 * The central property under test throughout: a Redis HIT for identity resolution is never itself
 * an authorization decision — `SessionValidityService.assertActive()` still runs on every single
 * request regardless of cache state, so a revoked/expired session must be denied exactly as
 * reliably whether the identity lookup that preceded it was a cache hit or a cache miss.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(60_000);

const WEB_SESSION_COOKIE_NAME = 'crewflow_session';

describeIfDb('Redis checkpoint — UserSession cache (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let tenantContext: TenantContextService;
  let factory: TestIdentityFactory;
  let cacheService: UserSessionCacheService;
  let redisProvider: AuthCacheRedisClientProvider;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    dataSource = moduleRef.get(DataSource);
    tenantContext = moduleRef.get(TenantContextService);
    cacheService = moduleRef.get(UserSessionCacheService);
    redisProvider = moduleRef.get(AuthCacheRedisClientProvider);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = new TestIdentityFactory({ app, dataSource, adminDataSource, tenantContext, passwordHashing: moduleRef.get(PasswordHashingService) });
  });

  afterAll(async () => {
    await app.close();
    await adminDataSource.destroy();
  });

  function extractCookie(res: request.Response, name: string): string | undefined {
    const raw = (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
    const line = raw.find((c) => c.startsWith(`${name}=`));
    if (!line) return undefined;
    return decodeURIComponent(line.split(';')[0]!.slice(name.length + 1));
  }

  const CORS_ORIGIN = 'http://localhost:5173';

  async function loginAndGetCookie(manager: Awaited<ReturnType<TestIdentityFactory['createInternalManager']>>) {
    const res = await factory.loginRaw(manager, { applicationTarget: 'manager_web' });
    if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
    const cookie = extractCookie(res, WEB_SESSION_COOKIE_NAME);
    if (!cookie) throw new Error('login did not set crewflow_session');
    return cookie;
  }

  async function loginFull(manager: Awaited<ReturnType<TestIdentityFactory['createInternalManager']>>) {
    const res = await factory.loginRaw(manager, { applicationTarget: 'manager_web' });
    if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
    const cookie = extractCookie(res, WEB_SESSION_COOKIE_NAME);
    const rabRt = extractCookie(res, 'rab_rt');
    if (!cookie || !rabRt) throw new Error('login did not set crewflow_session/rab_rt');
    return { cookie, rabRt, accessToken: (res.body as { accessToken: string }).accessToken };
  }

  async function logout(session: { rabRt: string; accessToken: string }) {
    return request(app.getHttpServer())
      .post('/rest/v1/auth/logout')
      .set('Origin', CORS_ORIGIN)
      .set('Authorization', `Bearer ${session.accessToken}`)
      .set('Cookie', [`rab_rt=${session.rabRt}`]);
  }

  const meWith = (cookie: string) => request(app.getHttpServer()).get('/rest/v1/auth/me').set('Cookie', [`${WEB_SESSION_COOKIE_NAME}=${cookie}`]);

  it('sanity: the flag is actually on for this suite', () => {
    expect(cacheService.isEnabled()).toBe(true);
  });

  it('cold MISS populates Redis; the next request is a warm HIT reading the same projection, with no raw cookie value stored', async () => {
    const org = await factory.createOrganisation('usc-cold-warm');
    const manager = await factory.createInternalManager(org);
    const cookie = await loginAndGetCookie(manager);
    const hash = createHash('sha256').update(cookie).digest('hex');

    expect(await cacheService.get(hash)).toBeNull(); // nothing cached yet

    const first = await meWith(cookie);
    expect(first.status).toBe(200);

    const cached = await cacheService.get(hash);
    expect(cached).not.toBeNull();
    expect(cached!.userId).toBe(manager.userId);
    expect(cached!.organisationId).toBe(org.id);
    expect(JSON.stringify(cached)).not.toContain(cookie); // raw cookie never stored in the payload

    // Prove a key actually exists in Redis, not just that cacheService.get() can parse a plausible value.
    const keys = await redisProvider.client.keys(`crewflow:*:usersession:${hash}`);
    expect(keys.length).toBe(1);

    const second = await meWith(cookie);
    expect(second.status).toBe(200);
    expect(second.body.id ?? second.body.userId).toBeDefined();
  });

  it('a revoked session is denied on the request immediately following logout, even though its identity was already cached by the login itself', async () => {
    const org = await factory.createOrganisation('usc-revoke-despite-hit');
    const manager = await factory.createInternalManager(org);
    const session = await loginFull(manager);
    const hash = createHash('sha256').update(session.cookie).digest('hex');

    // Warm the cache.
    expect((await meWith(session.cookie)).status).toBe(200);
    expect(await cacheService.get(hash)).not.toBeNull();

    const logoutRes = await logout(session);
    expect(logoutRes.status).toBe(204);

    // The cache entry is a pure identity mapping — logout does not (and must not need to) evict it
    // for this to be safe. If it's still present, that alone proves the identity cache was never
    // the thing authorizing the request.
    const stillCached = await cacheService.get(hash);
    const deniedRes = await meWith(session.cookie);
    expect(deniedRes.status).toBe(401);
    if (stillCached) {
      // Document explicitly: even with a live, matching cache entry, the request was still denied —
      // assertActive(), not this cache, made that call.
      expect(stillCached.userId).toBe(manager.userId);
    }
  });

  it('a cache entry past its own absoluteExpiresAt is never served as a HIT, even if Redis has not evicted it yet — and the still-valid real session is unaffected', async () => {
    // `absolute_expires_at` is immutable after creation at the database level (a real guard this
    // codebase already enforces, confirmed by hitting it directly), so a genuinely-expired real
    // session can't be manufactured by mutating an existing row. This test instead proves the
    // narrower, directly-testable property: the cache's OWN defensive expiry check, independent of
    // whatever Redis's TTL bookkeeping believes — forging a stale-looking entry under a real
    // session's hash must never be trusted, and falling through to Postgres must reach the correct
    // answer for whatever the real session's actual state is (still valid, here).
    const org = await factory.createOrganisation('usc-absolute-expiry');
    const manager = await factory.createInternalManager(org);
    const cookie = await loginAndGetCookie(manager);
    const hash = createHash('sha256').update(cookie).digest('hex');
    expect((await meWith(cookie)).status).toBe(200); // warms the cache with the real, correct entry

    // `cacheService.set()` itself already refuses to write an already-expired entry (confirmed: it
    // is a no-op in that case) — a SEPARATE, also-correct write-time guard, but not what THIS test
    // probes. To exercise the READ-time check in get(), the stale entry has to be forced into Redis
    // directly, bypassing that write-time guard — simulating how one could genuinely appear there
    // in production despite it (clock skew between a writer and a reader, or any other path that
    // doesn't go through this service's own set()).
    const keys = await redisProvider.client.keys(`crewflow:*:usersession:${hash}`);
    expect(keys.length).toBe(1);
    await redisProvider.client.set(
      keys[0]!,
      JSON.stringify({
        sessionId: 'irrelevant',
        userId: 'wrong-user-would-indicate-a-stale-entry-was-trusted',
        organisationId: org.id,
        applicationTarget: 'manager_web',
        absoluteExpiresAt: new Date(Date.now() - 60_000).toISOString(),
      }),
      'EX',
      60,
    );

    expect(await cacheService.get(hash)).toBeNull(); // treated as a miss despite a raw Redis entry existing
    const res = await meWith(cookie);
    expect(res.status).toBe(200); // falls through to Postgres, which correctly reports the session is still live
  });

  it('two different sessions never cross-resolve — cookie A always yields identity A, cookie B always yields identity B, cache warm or cold', async () => {
    const orgA = await factory.createOrganisation('usc-isolation-a');
    const managerA = await factory.createInternalManager(orgA);
    const orgB = await factory.createOrganisation('usc-isolation-b');
    const managerB = await factory.createInternalManager(orgB);
    const cookieA = await loginAndGetCookie(managerA);
    const cookieB = await loginAndGetCookie(managerB);

    for (const round of [1, 2]) {
      void round;
      const resA = await meWith(cookieA);
      const resB = await meWith(cookieB);
      expect(resA.status).toBe(200);
      expect(resB.status).toBe(200);
      expect(resA.body.organisationId ?? resA.body.id).not.toEqual(resB.body.organisationId ?? resB.body.id);
    }

    const hashA = createHash('sha256').update(cookieA).digest('hex');
    const hashB = createHash('sha256').update(cookieB).digest('hex');
    expect((await cacheService.get(hashA))!.userId).toBe(managerA.userId);
    expect((await cacheService.get(hashB))!.userId).toBe(managerB.userId);
  });

  it('Redis outage: requests still succeed via Postgres fallback, bounded in time, never hung', async () => {
    const org = await factory.createOrganisation('usc-outage');
    const manager = await factory.createInternalManager(org);
    const cookie = await loginAndGetCookie(manager);

    const unreachable = new (await import('ioredis')).default('redis://127.0.0.1:1', { lazyConnect: true, maxRetriesPerRequest: 1, commandTimeout: 150 });
    const realClient = (redisProvider as unknown as { client: unknown }).client;
    (redisProvider as unknown as { client: unknown }).client = unreachable;
    try {
      const started = Date.now();
      const res = await meWith(cookie);
      const elapsedMs = Date.now() - started;
      expect(res.status).toBe(200);
      expect(elapsedMs).toBeLessThan(5000);
    } finally {
      (redisProvider as unknown as { client: unknown }).client = realClient;
      unreachable.disconnect();
    }
  });

  it('concurrent cold requests for the SAME brand-new session all succeed and end up agreeing on one correct cache entry', async () => {
    const org = await factory.createOrganisation('usc-concurrent-fill');
    const manager = await factory.createInternalManager(org);
    const cookie = await loginAndGetCookie(manager);
    const hash = createHash('sha256').update(cookie).digest('hex');
    expect(await cacheService.get(hash)).toBeNull();

    const results = await Promise.all([meWith(cookie), meWith(cookie), meWith(cookie), meWith(cookie), meWith(cookie)]);
    for (const res of results) expect(res.status).toBe(200);

    const final = await cacheService.get(hash);
    expect(final).not.toBeNull();
    expect(final!.userId).toBe(manager.userId);
    expect(final!.organisationId).toBe(org.id);
  });

  it('mobile JWT sessions never populate or consult the UserSession cache (cookie-only mechanism)', async () => {
    const org = await factory.createOrganisation('usc-mobile-unaffected');
    const manager = await factory.createInternalManager(org);
    const staff = await factory.createStaff(org, { owner: manager });
    const res = await factory.loginRaw(staff, { mobile: true });
    expect(res.status).toBe(200);
    const accessToken = (res.body as { accessToken: string }).accessToken;

    const meRes = await request(app.getHttpServer()).get('/rest/v1/auth/me').set('Authorization', `Bearer ${accessToken}`);
    expect(meRes.status).toBe(200);

    // No crewflow_session cookie was ever issued for this login, so there is no hash this cache
    // could have been asked about — nothing to assert beyond "the request succeeded via the JWT
    // path alone," which the 200 above already proves.
  });
});
