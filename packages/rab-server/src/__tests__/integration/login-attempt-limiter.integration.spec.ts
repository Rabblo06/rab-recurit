import 'reflect-metadata';

// Wave 1 lane A (finding D-A1). This file runs the REAL password sign-in limiter (jest-setup.ts disables it, together
// with the route throttler, for every other suite). Small, fast-refilling buckets so "success after the delay" is
// observable in about a second: per (email, IP) a burst of 3 refilling one token per second, a daily tier of 6, and an
// account-wide ceiling of 6 refilling one token per 100 s. Set before AppModule is loaded (ConfigModule validates then);
// restored in afterAll because Jest reuses the worker for the next file.
const ORIGINAL = {
  RAB_DISABLE_RATE_LIMIT: process.env.RAB_DISABLE_RATE_LIMIT,
  AUTH_LOGIN_EMAIL_IP_BURST: process.env.AUTH_LOGIN_EMAIL_IP_BURST,
  AUTH_LOGIN_EMAIL_IP_WINDOW_SECONDS: process.env.AUTH_LOGIN_EMAIL_IP_WINDOW_SECONDS,
  AUTH_LOGIN_EMAIL_IP_DAILY_LIMIT: process.env.AUTH_LOGIN_EMAIL_IP_DAILY_LIMIT,
  AUTH_LOGIN_ACCOUNT_BURST: process.env.AUTH_LOGIN_ACCOUNT_BURST,
  AUTH_LOGIN_ACCOUNT_WINDOW_SECONDS: process.env.AUTH_LOGIN_ACCOUNT_WINDOW_SECONDS,
};
process.env.RAB_DISABLE_RATE_LIMIT = 'false';
process.env.AUTH_LOGIN_EMAIL_IP_BURST = '3';
process.env.AUTH_LOGIN_EMAIL_IP_WINDOW_SECONDS = '3';
process.env.AUTH_LOGIN_EMAIL_IP_DAILY_LIMIT = '6';
process.env.AUTH_LOGIN_ACCOUNT_BURST = '6';
process.env.AUTH_LOGIN_ACCOUNT_WINDOW_SECONDS = '600';

import { HttpException, INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { AuthCacheRedisClientProvider } from '../../engine/core-modules/auth/services/auth-cache-redis-client.provider';
import { AuthService } from '../../engine/core-modules/auth/services/auth.service';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { ThrottlerRedisClientProvider } from '../../engine/core-modules/throttler/throttler-redis-client.provider';
import { createAdminDataSource } from './helpers/admin-datasource';
import { clearLoginLimiterState, clearThrottleState } from './helpers/throttle-state';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

type Outcome = { status: number; body: Record<string, unknown> };

describeIfDb('wave 1 lane A — password sign-in limiter, per (email, IP) with an account-wide ceiling (REAL limiter)', () => {
  jest.setTimeout(180_000);

  let app: INestApplication;
  let owner: DataSource;
  let auth: AuthService;
  let authRedis: AuthCacheRedisClientProvider;
  let throttlerRedis: ThrottlerRedisClientProvider;
  let factory: TestIdentityFactory;
  let organisationId: string;
  const managers: TestIdentity[] = [];
  let next = 0;
  const freshManager = () => managers[next++]!;

  /** Service-level call (CLAUDE.md layer 2): what every transport reaches. Never throws; returns the HTTP outcome. */
  const attempt = async (email: string, password: string, ip: string): Promise<Outcome> => {
    try {
      await auth.login({ email, password }, { ip, userAgent: 'jest-limiter' });
      return { status: 200, body: {} };
    } catch (error) {
      if (error instanceof HttpException) return { status: error.getStatus(), body: error.getResponse() as Record<string, unknown> };
      throw error;
    }
  };
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const sessionsFor = async (userId: string) =>
    (await owner.query(`SELECT count(*)::int AS n FROM core.user_session WHERE user_id = $1`, [userId]))[0].n as number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    owner = createAdminDataSource();
    await owner.initialize();
    auth = moduleRef.get(AuthService);
    authRedis = moduleRef.get(AuthCacheRedisClientProvider);
    throttlerRedis = moduleRef.get(ThrottlerRedisClientProvider);
    await clearLoginLimiterState(authRedis.client);
    await clearThrottleState(throttlerRedis);
    factory = new TestIdentityFactory({
      app,
      dataSource: moduleRef.get(DataSource),
      adminDataSource: owner,
      tenantContext: moduleRef.get(TenantContextService),
      passwordHashing: moduleRef.get(PasswordHashingService),
    });
    const seeded = await factory.createOrganisationWithManagers(10, { permissions: 'production', workspace: true, label: 'w1lim' });
    organisationId = seeded.organisation.id;
    managers.push(...seeded.managers);
  });

  afterAll(async () => {
    if (authRedis?.client.status === 'ready') await clearLoginLimiterState(authRedis.client);
    if (throttlerRedis) await clearThrottleState(throttlerRedis).catch(() => undefined);
    if (owner?.isInitialized && organisationId) {
      await owner.query(`UPDATE core.organisation SET password_auth_enabled = true WHERE id = $1`, [organisationId]);
    }
    await owner?.destroy();
    await app?.close();
    for (const [key, value] of Object.entries(ORIGINAL)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('repeated bad passwords from one address are slowed down after the burst — and the RIGHT password is refused too while slowed (no bypass, no oracle)', async () => {
    const victim = freshManager();
    const ip = '203.0.113.10';
    for (let i = 0; i < 3; i++) expect((await attempt(victim.email, 'wrong-password', ip)).status).toBe(401);
    const slowed = await attempt(victim.email, 'wrong-password', ip);
    expect(slowed.status).toBe(429);
    expect(slowed.body).toMatchObject({ code: 'LOGIN_RATE_LIMITED' });
    expect(Number(slowed.body.retryAfter)).toBeGreaterThanOrEqual(1);
    expect((await attempt(victim.email, victim.password, ip)).status).toBe(429);
  });

  it('success after the delay: one token refills, the correct password then signs in, and that clears the address\'s own counters', async () => {
    const user = freshManager();
    const ip = '203.0.113.11';
    for (let i = 0; i < 3; i++) expect((await attempt(user.email, 'wrong-password', ip)).status).toBe(401);
    expect((await attempt(user.email, user.password, ip)).status).toBe(429);
    await sleep(1_300);
    expect((await attempt(user.email, user.password, ip)).status).toBe(200);
    // Counters for this (email, IP) were cleared by the success: a full burst of mistakes is available again.
    for (let i = 0; i < 3; i++) expect((await attempt(user.email, 'wrong-password', ip)).status).toBe(401);
  });

  it('targeted-lockout abuse case (D-A1): an attacker hammering a victim\'s email from their own address never locks the victim out elsewhere', async () => {
    const victim = freshManager();
    const attackerIp = '198.51.100.66';
    for (let i = 0; i < 12; i++) await attempt(victim.email, `guess-${i}`, attackerIp);
    expect((await attempt(victim.email, 'another-guess', attackerIp)).status).toBe(429);
    // Before wave 1, 10 failures refused EVERY address for 15 minutes. The victim signs in normally from their own address.
    const before = await sessionsFor(victim.userId);
    expect((await attempt(victim.email, victim.password, '192.0.2.20')).status).toBe(200);
    expect(await sessionsFor(victim.userId)).toBe(before + 1);
  });

  it('concurrent failures are counted atomically: of 10 simultaneous bad attempts exactly the burst (3) reach the password check', async () => {
    const user = freshManager();
    const ip = '203.0.113.12';
    const results = await Promise.all(Array.from({ length: 10 }, () => attempt(user.email, 'wrong-password', ip)));
    expect(results.filter((r) => r.status === 401)).toHaveLength(3);
    expect(results.filter((r) => r.status === 429)).toHaveLength(7);
  });

  it('progressive slow-down: after the burst refills a few times the daily tier takes over with a much longer wait', async () => {
    const user = freshManager();
    const ip = '203.0.113.13';
    let admitted = 0;
    // Burst of 3, then one more per second, until the daily tier (6) is spent.
    for (let i = 0; i < 3; i++) if ((await attempt(user.email, 'wrong-password', ip)).status === 401) admitted++;
    for (let round = 0; round < 3; round++) {
      await sleep(1_100);
      if ((await attempt(user.email, 'wrong-password', ip)).status === 401) admitted++;
    }
    expect(admitted).toBe(6);
    await sleep(1_100);
    const daily = await attempt(user.email, 'wrong-password', ip);
    expect(daily.status).toBe(429);
    // 24 h / 6 = 4 h per token: far longer than the burst tier's one second.
    expect(Number(daily.body.retryAfter)).toBeGreaterThan(3_600);
  });

  it('distributed guessing (many IPs, one account) hits the account-wide ceiling for unknown addresses, while the owner\'s known address still signs in', async () => {
    const victim = freshManager();
    // The owner has signed in before from their usual address (marks it known for this account).
    const ownerIp = '192.0.2.30';
    expect((await attempt(victim.email, victim.password, ownerIp)).status).toBe(200);
    // The owner's first (then still unknown) sign-in spent 1 of the 6 account-wide tokens. Five different attacker
    // addresses, one guess each: each is under its own per-address limit and together they spend the account ceiling.
    for (let i = 0; i < 5; i++) expect((await attempt(victim.email, `guess-${i}`, `198.51.100.${100 + i}`)).status).toBe(401);
    // The next new address is slowed by the ACCOUNT-wide ceiling, not by its own (untouched) per-address bucket.
    const ceiling = await attempt(victim.email, 'guess-7', '198.51.100.120');
    expect(ceiling.status).toBe(429);
    expect(ceiling.body).toMatchObject({ code: 'LOGIN_RATE_LIMITED' });
    // The owner's known address is exempt from the account ceiling and signs in.
    expect((await attempt(victim.email, victim.password, ownerIp)).status).toBe(200);
    // Residual (documented): a NEVER-seen address of the real owner is slowed while the distributed attack lasts.
    expect((await attempt(victim.email, victim.password, '192.0.2.31')).status).toBe(429);
  });

  it('uniformity: an unknown email is throttled exactly like a real one (same count, same message, same code)', async () => {
    const real = freshManager();
    const unknown = `nobody-${randomUUID()}@example.test`;
    const ip = '203.0.113.14';
    const realOutcomes = [];
    const unknownOutcomes = [];
    for (let i = 0; i < 4; i++) realOutcomes.push(await attempt(real.email, 'wrong-password', ip));
    for (let i = 0; i < 4; i++) unknownOutcomes.push(await attempt(unknown, 'wrong-password', ip));
    expect(realOutcomes.map((o) => o.status)).toEqual([401, 401, 401, 429]);
    expect(unknownOutcomes.map((o) => o.status)).toEqual([401, 401, 401, 429]);
    expect(unknownOutcomes[0]!.body).toEqual(realOutcomes[0]!.body);
    expect({ ...unknownOutcomes[3]!.body, retryAfter: 0 }).toEqual({ ...realOutcomes[3]!.body, retryAfter: 0 });
  });

  it('a refusal AFTER a correct password (password sign-in disabled) clears nothing, so the 429 behaviour cannot reveal the password was right', async () => {
    const user = freshManager();
    const ip = '203.0.113.15';
    await owner.query(`UPDATE core.organisation SET password_auth_enabled = false, google_auth_enabled = true WHERE id = $1`, [organisationId]);
    try {
      expect((await attempt(user.email, 'wrong-password', ip)).status).toBe(401);
      expect((await attempt(user.email, 'wrong-password', ip)).status).toBe(401);
      const refusedCorrect = await attempt(user.email, user.password, ip);
      expect(refusedCorrect.status).toBe(401);
      // Had the correct-but-refused attempt cleared the counters, this would be 401.
      expect((await attempt(user.email, 'wrong-password', ip)).status).toBe(429);
    } finally {
      await owner.query(`UPDATE core.organisation SET password_auth_enabled = true WHERE id = $1`, [organisationId]);
    }
  });

  it('HTTP: a slowed sign-in returns 429 with a Retry-After header and sets no cookie', async () => {
    await clearThrottleState(throttlerRedis); // the route's own 5/min/IP throttle is also live in this file
    const user = freshManager();
    const http = () => request(app.getHttpServer()).post('/rest/v1/auth/login').send({ email: user.email, password: 'wrong-password' });
    for (let i = 0; i < 3; i++) expect((await http()).status).toBe(401);
    const res = await http();
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('LOGIN_RATE_LIMITED');
    expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  // Last: takes the limiter's Redis away for the rest of this file.
  it('Redis unavailable: sign-in fails closed with 503 RATE_LIMIT_UNAVAILABLE within bounded time, for a real or unknown email, with no login_history row', async () => {
    await clearThrottleState(throttlerRedis);
    const user = freshManager();
    authRedis.client.disconnect(); // manual disconnect: ioredis does not reconnect
    const countHistory = async (email: string) =>
      (await owner.query(`SELECT count(*)::int AS n FROM core.login_history WHERE email = $1`, [email]))[0].n as number;
    const before = await countHistory(user.email);

    const started = Date.now();
    const correct = await attempt(user.email, user.password, '203.0.113.16');
    const unknown = await attempt(`nobody-${randomUUID()}@example.test`, 'x', '203.0.113.16');
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(correct.status).toBe(503);
    expect(correct.body).toMatchObject({ code: 'RATE_LIMIT_UNAVAILABLE' });
    expect(unknown.status).toBe(503);
    expect(await countHistory(user.email)).toBe(before);

    const res = await request(app.getHttpServer()).post('/rest/v1/auth/login').send({ email: user.email, password: user.password });
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('5');
    expect(res.headers['set-cookie']).toBeUndefined();
  });
});
