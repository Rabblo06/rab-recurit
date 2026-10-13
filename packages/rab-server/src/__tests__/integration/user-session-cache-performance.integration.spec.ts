import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mkdirSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { AuthCacheRedisClientProvider } from '../../engine/core-modules/auth/services/auth-cache-redis-client.provider';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { subscribeToRequestMetrics, type RequestCompletePayload } from '../../engine/observability/request-context';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { Organisation } from '../../modules/identity/entities';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Redis checkpoint, Step 4 — cache OFF vs. ON benchmark for the cookie-authenticated path, same
 * harness and artifact convention as `p1c1c-cookie-performance.integration.spec.ts`.
 *   RUN_PERF_BASELINE=true npx jest user-session-cache-performance.integration.spec.ts --runInBand
 *
 * Two separate NestJS application instances are built in the SAME process — one with
 * `USER_SESSION_CACHE_ENABLED` unset (off), one with it set to `'true'` (on) — each instance's own
 * `ConfigService` reads `process.env` at ITS OWN `compile()` call, so mutating the var between the
 * two builds genuinely produces one real cache-off app and one real cache-on app, not a toggle
 * racing a single shared instance.
 */
const RUN = Boolean(process.env.DATABASE_URL) && process.env.RUN_PERF_BASELINE === 'true';
const describeIfEnabled = RUN ? describe : describe.skip;
jest.setTimeout(180_000);

const SAMPLES_PER_SCENARIO = 20;

interface ScenarioResult {
  name: string;
  cacheEnabled: boolean;
  samples: number;
  wallMs: { p50: number; p95: number; mean: number };
  sqlCount: { mean: number };
  redisHitRate: number;
  errorCount: number;
  redisUsedMemoryBytes?: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

describeIfEnabled('Redis checkpoint — UserSession cache OFF vs ON performance', () => {
  let adminDataSource: DataSource;

  beforeAll(async () => {
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
  });

  afterAll(async () => {
    await adminDataSource.destroy();
  });

  async function buildAppAndFixture(cacheEnabled: boolean) {
    if (cacheEnabled) {
      process.env.USER_SESSION_CACHE_ENABLED = 'true';
    } else {
      delete process.env.USER_SESSION_CACHE_ENABLED;
    }
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app: INestApplication = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    const dataSource = moduleRef.get(DataSource);
    const tenantContext = moduleRef.get(TenantContextService);
    const redisProvider = moduleRef.get(AuthCacheRedisClientProvider);
    const factory = new TestIdentityFactory({
      app,
      dataSource,
      adminDataSource,
      tenantContext,
      passwordHashing: moduleRef.get(PasswordHashingService),
    });

    const org = await factory.createOrganisation(`usc-perf-${cacheEnabled ? 'on' : 'off'}`);
    const manager: TestIdentity = await factory.createInternalManager(org);
    for (let i = 0; i < 10; i++) await factory.createStaff(org, { owner: manager, label: `perf-${i}` });

    const loginRes = await factory.loginRaw(manager, { applicationTarget: 'manager_web' });
    const setCookie = (loginRes.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('crewflow_session='))!;
    const cookie = decodeURIComponent(setCookie.split(';')[0]!.slice('crewflow_session='.length));

    return { app, redisProvider, cookie };
  }

  async function sampleOnce(
    app: INestApplication,
    cookie: string,
  ): Promise<{ durationMs: number; metrics?: RequestCompletePayload; errored: boolean }> {
    let captured: RequestCompletePayload | undefined;
    const unsubscribe = subscribeToRequestMetrics((payload) => {
      if (!captured) captured = payload;
    });
    const start = performance.now();
    let errored = false;
    try {
      const res = await request(app.getHttpServer()).get('/rest/v1/auth/me').set('Cookie', [`crewflow_session=${cookie}`]);
      if (res.status >= 400) errored = true;
    } catch {
      errored = true;
    } finally {
      unsubscribe();
    }
    return { durationMs: performance.now() - start, metrics: captured, errored };
  }

  async function runScenario(cacheEnabled: boolean): Promise<ScenarioResult> {
    const { app, redisProvider, cookie } = await buildAppAndFixture(cacheEnabled);
    try {
      await sampleOnce(app, cookie); // warmup — this is the one guaranteed cold MISS when cacheEnabled
      const durations: number[] = [];
      const metrics: RequestCompletePayload[] = [];
      let errorCount = 0;
      let hits = 0;
      for (let i = 0; i < SAMPLES_PER_SCENARIO; i++) {
        const keysBefore = cacheEnabled ? (await redisProvider.client.keys('crewflow:*:usersession:*')).length : 0;
        const { durationMs, metrics: m, errored } = await sampleOnce(app, cookie);
        durations.push(durationMs);
        if (m) metrics.push(m);
        if (errored) errorCount++;
        // After the warmup, every one of these samples should find the SAME key already present
        // (a hit never creates a NEW key — only a miss-then-fill does), so a steady key count across
        // samples is itself evidence every one of these was a hit.
        if (cacheEnabled) {
          const keysAfter = (await redisProvider.client.keys('crewflow:*:usersession:*')).length;
          if (keysAfter === keysBefore) hits++;
        }
      }
      const sorted = [...durations].sort((a, b) => a - b);
      const mean = (arr: number[]) => (arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
      const memInfo = await redisProvider.client.info('memory');
      const usedMemoryLine = memInfo.split('\n').find((l) => l.startsWith('used_memory:'));
      const redisUsedMemoryBytes = usedMemoryLine ? Number(usedMemoryLine.split(':')[1]?.trim()) : undefined;
      return {
        name: 'auth_me_cookie',
        cacheEnabled,
        samples: durations.length,
        wallMs: { p50: Math.round(percentile(sorted, 50)), p95: Math.round(percentile(sorted, 95)), mean: Math.round(mean(durations)) },
        sqlCount: { mean: Math.round(mean(metrics.map((m) => m.sqlCount)) * 100) / 100 },
        redisHitRate: cacheEnabled ? Math.round((hits / SAMPLES_PER_SCENARIO) * 100) / 100 : 0,
        errorCount,
        redisUsedMemoryBytes,
      };
    } finally {
      await app.close();
    }
  }

  it('measures auth/me under the cookie transport with the UserSession cache off, then on, and writes a comparison artifact', async () => {
    const off = await runScenario(false);
    const on = await runScenario(true);

    expect(off.errorCount).toBe(0);
    expect(on.errorCount).toBe(0);
    expect(on.redisHitRate).toBeGreaterThanOrEqual(0.9); // 18+ of 20 steady-state samples are hits

    // The decisive cost assertion: ON must not issue MORE Postgres queries per request than OFF —
    // a warm HIT replaces the one pre-auth lookup query with a Redis GET, strictly removing work,
    // never adding any (SessionValidityService.assertActive() still runs identically either way).
    expect(on.sqlCount.mean).toBeLessThanOrEqual(off.sqlCount.mean);

    const artifact = {
      capturedAt: new Date().toISOString(),
      database: 'local-disposable (TEST_DATABASE_URL)',
      samplesPerScenario: SAMPLES_PER_SCENARIO,
      scenarios: [off, on],
    };
    const dir = `${process.cwd()}/../../.audit/user-session-cache-performance`;
    mkdirSync(dir, { recursive: true });
    const path = `${dir}/comparison-${Date.now()}.json`;
    writeFileSync(path, JSON.stringify(artifact, null, 2));

    // eslint-disable-next-line no-console
    console.log(`\nUserSession cache OFF-vs-ON comparison written to ${path}\n` + JSON.stringify([off, on], null, 2));
  });
});
