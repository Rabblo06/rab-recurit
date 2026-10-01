import 'reflect-metadata';

// PHASE 11 / EDGE-01 — this suite deliberately does NOT set
// TRUSTED_PROXY_CIDRS, proving the default (unconfigured) posture: a direct
// caller cannot choose its own rate-limit/audit identity via ANY forwarding
// header, full stop. `rate-limiting.integration.spec.ts`'s own "trust proxy
// (SEC-03)" block covers the OPPOSITE, trusted-proxy topology.
const ORIGINAL_RATE_LIMIT_FLAG = process.env.RAB_DISABLE_RATE_LIMIT;
const ORIGINAL_TRUSTED_PROXY_CIDRS = process.env.TRUSTED_PROXY_CIDRS;
process.env.RAB_DISABLE_RATE_LIMIT = 'false';
delete process.env.TRUSTED_PROXY_CIDRS;

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { EnvironmentService } from '../../engine/core-modules/environment/environment.service';
import { ThrottlerRedisClientProvider } from '../../engine/core-modules/throttler/throttler-redis-client.provider';
import { buildTrustProxyPredicate } from '../../engine/utils/trusted-proxy.util';
import { createAdminDataSource } from './helpers/admin-datasource';
import { clearThrottleState } from './helpers/throttle-state';

const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('client IP trust — untrusted-by-default topology (Phase 11 / EDGE-01)', () => {
  let app: INestApplication;
  let adminDataSource: DataSource;
  let redis: ThrottlerRedisClientProvider;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    redis = moduleRef.get(ThrottlerRedisClientProvider);
    await clearThrottleState(redis);
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    const environmentService = moduleRef.get(EnvironmentService);
    // Mirrors main.ts's bootstrap() with the SAME (empty, default) config —
    // proves the shipped default, not a test-only relaxation.
    expect(environmentService.trustedProxyCidrs).toEqual([]);
    app
      .getHttpAdapter()
      .getInstance()
      .set('trust proxy', buildTrustProxyPredicate(environmentService.trustedProxyCidrs));
    await app.init();
  });

  afterAll(async () => {
    await clearThrottleState(redis);
    await app.close();
    await adminDataSource.destroy();
    process.env.RAB_DISABLE_RATE_LIMIT = ORIGINAL_RATE_LIMIT_FLAG;
    process.env.TRUSTED_PROXY_CIDRS = ORIGINAL_TRUSTED_PROXY_CIDRS;
  });

  const attempt = (email: string, headers: Record<string, string> = {}) => {
    let req = request(app.getHttpServer()).post('/rest/v1/auth/forgot-password');
    for (const [key, value] of Object.entries(headers)) req = req.set(key, value);
    return req.send({ email });
  };

  it('1/2/3/4/5: a direct client cannot choose its own rate-limit bucket via any single or combined forwarding header', async () => {
    // Five different SPOOFED identities, all from the same real (untrusted)
    // supertest connection — if any header were honoured, these would land
    // in five different buckets and none would ever trip the limit.
    const spoofedHeaderSets: Record<string, string>[] = [
      {},
      { 'CF-Connecting-IP': '203.0.113.10' },
      { 'X-Forwarded-For': '203.0.113.20' },
      { 'X-Real-IP': '203.0.113.30' },
      { 'CF-Connecting-IP': '203.0.113.40', 'X-Forwarded-For': '203.0.113.41', 'X-Real-IP': '203.0.113.42' },
    ];

    for (const headers of spoofedHeaderSets) {
      const res = await attempt(`edge01-${randomUUID()}@example.test`, headers);
      expect(res.status).toBe(204);
    }
    // The 6th request total (across all 5 "identities" above, which must
    // all share ONE real bucket) trips the limit.
    const sixth = await attempt(`edge01-${randomUUID()}@example.test`, { 'CF-Connecting-IP': '203.0.113.99' });
    expect(sixth.status).toBe(429);
  });

  it('12: spoofed direct requests cannot rotate the IP bucket by changing the header value between requests', async () => {
    await clearThrottleState(redis);
    for (let i = 0; i < 5; i++) {
      const res = await attempt(`edge01-rotate-${randomUUID()}@example.test`, {
        'CF-Connecting-IP': `203.0.113.${50 + i}`, // a DIFFERENT spoofed value every single request
      });
      expect(res.status).toBe(204);
    }
    const sixth = await attempt(`edge01-rotate-${randomUUID()}@example.test`, { 'CF-Connecting-IP': '203.0.113.200' });
    expect(sixth.status).toBe(429);
  });

  it('13: audit IP (login_history) uses the SAME canonical resolver as the rate limiter — a spoofed CF-Connecting-IP never reaches the audit log', async () => {
    const email = `edge01-audit-${randomUUID()}@example.test`;
    const spoofed = '198.51.100.123';
    await request(app.getHttpServer())
      .post('/rest/v1/auth/login')
      .set('CF-Connecting-IP', spoofed)
      .send({ email, password: 'wrong-password-doesnt-matter' });

    const [row] = await adminDataSource.query<{ ip: string | null }[]>(
      `SELECT ip::text as ip FROM core.login_history WHERE email = $1 ORDER BY created_at DESC LIMIT 1`,
      [email],
    );
    expect(row).toBeTruthy();
    expect(row.ip).not.toBe(spoofed);
  });

  it('14/15: auth-endpoint and global throttles both still function under the untrusted-default topology', async () => {
    await clearThrottleState(redis);
    for (let i = 0; i < 5; i++) {
      const res = await attempt(`edge01-authlimit-${randomUUID()}@example.test`);
      expect(res.status).toBe(204);
    }
    expect((await attempt(`edge01-authlimit-${randomUUID()}@example.test`)).status).toBe(429);

    for (let i = 0; i < 6; i++) {
      const res = await request(app.getHttpServer()).get('/healthz');
      expect(res.status).toBe(200);
    }
  });
});
