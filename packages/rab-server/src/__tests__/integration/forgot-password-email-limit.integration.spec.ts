import 'reflect-metadata';

// Phase X Part 2, X1.4 (XA-04): the forgot-password limit per ADDRESS (3 per 15 minutes, Twenty's
// `password-reset-email:<email>` bucket), end to end over HTTP against the real Redis token bucket. jest-setup.ts disables
// every limiter for the suite; this file turns them back on (the route's per-IP limit too, which is why each request
// below comes from its own client IP). Loopback is a trusted proxy here, so X-Forwarded-For names the client IP, the
// same way rate-limiting.integration.spec.ts simulates distinct clients. Both set before AppModule loads; restored in
// afterAll because Jest reuses the worker for the next file.
const ORIGINAL = {
  RAB_DISABLE_RATE_LIMIT: process.env.RAB_DISABLE_RATE_LIMIT,
  TRUSTED_PROXY_CIDRS: process.env.TRUSTED_PROXY_CIDRS,
};
process.env.RAB_DISABLE_RATE_LIMIT = 'false';
process.env.TRUSTED_PROXY_CIDRS = '127.0.0.1/32,::1/128,::ffff:127.0.0.1/128';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { AuthCacheRedisClientProvider } from '../../engine/core-modules/auth/services/auth-cache-redis-client.provider';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { PasswordResetEmailLimiterService } from '../../engine/core-modules/auth/services/password-reset-email-limiter.service';
import { EnvironmentService } from '../../engine/core-modules/environment/environment.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { ThrottlerRedisClientProvider } from '../../engine/core-modules/throttler/throttler-redis-client.provider';
import { buildTrustProxyPredicate } from '../../engine/utils/trusted-proxy.util';
import { createAdminDataSource } from './helpers/admin-datasource';
import { clearThrottleState } from './helpers/throttle-state';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('X1.4 forgot-password limit per address (REAL limiter, integration)', () => {
  jest.setTimeout(180_000);

  let app: INestApplication;
  let owner: DataSource;
  let limiter: PasswordResetEmailLimiterService;
  let authRedis: AuthCacheRedisClientProvider;
  let throttlerRedis: ThrottlerRedisClientProvider;
  const managers: TestIdentity[] = [];
  let next = 0;
  const freshManager = () => managers[next++]!;
  const usedAddresses: string[] = [];
  // Every request gets its own client IP, so the per-IP route limit (5/min) never decides an outcome here.
  let ipSeq = 0;
  const nextIp = () => {
    ipSeq++;
    return `198.51.${100 + Math.floor(ipSeq / 250)}.${(ipSeq % 250) + 1}`;
  };

  const forgot = (email: string, ip = nextIp()) => {
    usedAddresses.push(email);
    return request(app.getHttpServer()).post('/rest/v1/auth/forgot-password').set('X-Forwarded-For', ip).send({ email });
  };
  const resetEmailsFor = async (userId: string): Promise<number> =>
    (await owner.query(`SELECT count(*)::int AS n FROM core.email_outbox WHERE target_user_id = $1 AND job_type = 'PASSWORD_RESET'`, [userId]))[0].n;
  const resetTokensFor = async (userId: string): Promise<number> =>
    (await owner.query(`SELECT count(*)::int AS n FROM core.password_reset_token WHERE user_id = $1`, [userId]))[0].n;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    // Mirrors main.ts (Test.createTestingModule never runs bootstrap()): the same trusted-proxy predicate.
    app.getHttpAdapter().getInstance().set('trust proxy', buildTrustProxyPredicate(moduleRef.get(EnvironmentService).trustedProxyCidrs));
    await app.init();
    owner = createAdminDataSource();
    await owner.initialize();
    limiter = moduleRef.get(PasswordResetEmailLimiterService);
    authRedis = moduleRef.get(AuthCacheRedisClientProvider);
    throttlerRedis = moduleRef.get(ThrottlerRedisClientProvider);
    await clearThrottleState(throttlerRedis);
    const factory = new TestIdentityFactory({
      app,
      dataSource: moduleRef.get(DataSource),
      adminDataSource: owner,
      tenantContext: moduleRef.get(TenantContextService),
      passwordHashing: moduleRef.get(PasswordHashingService),
    });
    const seeded = await factory.createOrganisationWithManagers(4, { permissions: 'production', workspace: true, label: 'x14' });
    managers.push(...seeded.managers);
  });

  afterAll(async () => {
    // Only this file's own bucket keys (exact keys, never a pattern) and the per-IP throttle counters.
    if (authRedis?.client.status === 'ready' && usedAddresses.length) {
      await authRedis.client.del(...new Set(usedAddresses.map((email) => limiter.keyFor(email)))).catch(() => undefined);
    }
    if (throttlerRedis) await clearThrottleState(throttlerRedis).catch(() => undefined);
    await owner?.destroy();
    await app?.close();
    for (const [key, value] of Object.entries(ORIGINAL)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('4 requests from 4 different IPs for one address: 3 reset emails, then 429 (the per-IP limit never tripped)', async () => {
    const victim = freshManager();
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await forgot(victim.email)).status);
    expect(statuses).toEqual([204, 204, 204, 429]);
    expect(await resetEmailsFor(victim.userId)).toBe(3);
    expect(await resetTokensFor(victim.userId)).toBe(3);
  });

  it('the address is normalised (case and surrounding spaces) before keying: variants share one bucket', async () => {
    const victim = freshManager();
    const [local, domain] = victim.email.split('@') as [string, string];
    const variants = [victim.email, `  ${victim.email.toUpperCase()}  `, `${local.toUpperCase()}@${domain}`, ` ${victim.email}`];
    const statuses: number[] = [];
    for (const v of variants) statuses.push((await forgot(v)).status);
    expect(statuses).toEqual([204, 204, 204, 429]);
    expect(await resetEmailsFor(victim.userId)).toBe(3);
  });

  it('20 concurrent requests for one address (20 IPs): at most 3 emails, every other request 429 (one atomic Lua step)', async () => {
    const victim = freshManager();
    const results = await Promise.all(Array.from({ length: 20 }, () => forgot(victim.email)));
    const admitted = results.filter((r) => r.status === 204).length;
    const refused = results.filter((r) => r.status === 429).length;
    expect(admitted + refused).toBe(20);
    expect(admitted).toBeLessThanOrEqual(3);
    expect(await resetEmailsFor(victim.userId)).toBeLessThanOrEqual(3);
    expect(await resetEmailsFor(victim.userId)).toBe(admitted);
  });

  it('a known and an unknown address get an identical status and body, both while admitted and once exhausted', async () => {
    const known = freshManager().email;
    const unknown = `x14-absent-${randomUUID()}@example.test`;
    for (let i = 0; i < 3; i++) {
      const [k, u] = [await forgot(known), await forgot(unknown)];
      expect({ status: k.status, body: k.body }).toEqual({ status: 204, body: {} });
      expect({ status: u.status, body: u.body }).toEqual({ status: k.status, body: k.body });
    }
    const [k, u] = [await forgot(known), await forgot(unknown)];
    expect(k.status).toBe(429);
    expect(u.status).toBe(429);
    expect(u.body).toEqual(k.body);
    expect(k.body).toEqual({
      statusCode: 429,
      code: 'PASSWORD_RESET_RATE_LIMITED',
      message: 'Too many password reset requests for this address. Please wait a few minutes, then try again.',
    });
  });

  it('the per-IP route limit stays: 6 different addresses from one IP, the 6th is refused by the route throttler', async () => {
    const ip = nextIp();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await forgot(`x14-perip-${randomUUID()}@example.test`, ip)).status);
    expect(statuses).toEqual([204, 204, 204, 204, 204, 429]);
  });
});
