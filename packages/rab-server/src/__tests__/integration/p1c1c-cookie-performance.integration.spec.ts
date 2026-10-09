import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mkdirSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { subscribeToRequestMetrics, type RequestCompletePayload } from '../../engine/observability/request-context';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { Organisation } from '../../modules/identity/entities';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * P1C.1C-F — the cookie-authenticated counterpart to `performance-baseline.integration.spec.ts`
 * (P1A's own Bearer-JWT baseline, unmodified). Same harness, same metrics plumbing
 * (`subscribeToRequestMetrics`, never scraped logs), run TWICE in the SAME process against the
 * SAME fresh fixtures — once authenticating via `Authorization: Bearer`, once via the
 * `crewflow_session` cookie — so the comparison is apples-to-apples for THIS checkpoint rather
 * than against a possibly-stale historical number. Gated the same way:
 *   RUN_PERF_BASELINE=true npx jest p1c1c-cookie-performance.integration.spec.ts --runInBand
 */
const RUN = Boolean(process.env.DATABASE_URL) && process.env.RUN_PERF_BASELINE === 'true';
const describeIfEnabled = RUN ? describe : describe.skip;
jest.setTimeout(180_000);

const SAMPLES_PER_SCENARIO = 20;

interface ScenarioResult {
  name: string;
  transport: 'bearer' | 'cookie';
  samples: number;
  wallMs: { p50: number; p95: number; mean: number };
  sqlCount: { mean: number };
  transactionCount: { mean: number };
  stageMeansMs: Record<string, number>;
  errorCount: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

function summarize(name: string, transport: 'bearer' | 'cookie', durations: number[], metrics: RequestCompletePayload[], errorCount: number): ScenarioResult {
  const sorted = [...durations].sort((a, b) => a - b);
  const mean = (arr: number[]) => (arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
  const stageSums: Record<string, number> = {};
  for (const m of metrics) for (const [stage, ms] of Object.entries(m.stages)) stageSums[stage] = (stageSums[stage] ?? 0) + ms;
  const stageMeansMs: Record<string, number> = {};
  for (const [stage, sum] of Object.entries(stageSums)) stageMeansMs[stage] = metrics.length > 0 ? Math.round((sum / metrics.length) * 100) / 100 : 0;
  return {
    name,
    transport,
    samples: durations.length,
    wallMs: { p50: Math.round(percentile(sorted, 50)), p95: Math.round(percentile(sorted, 95)), mean: Math.round(mean(durations)) },
    sqlCount: { mean: Math.round(mean(metrics.map((m) => m.sqlCount)) * 100) / 100 },
    transactionCount: { mean: Math.round(mean(metrics.map((m) => m.transactionCount)) * 100) / 100 },
    stageMeansMs,
    errorCount,
  };
}

describeIfEnabled('P1C.1C-F cookie-vs-bearer performance comparison (fresh, disposable-local-database)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let tenantContext: TenantContextService;
  let factory: TestIdentityFactory;
  let org: Organisation;
  let manager: TestIdentity;
  let accessToken: string;
  let cookieValue: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    dataSource = moduleRef.get(DataSource);
    tenantContext = moduleRef.get(TenantContextService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = new TestIdentityFactory({ app, dataSource, adminDataSource, tenantContext, passwordHashing: moduleRef.get(PasswordHashingService) });

    org = await factory.createOrganisation('p1c1c-perf');
    manager = await factory.createInternalManager(org);
    for (let i = 0; i < 10; i++) await factory.createStaff(org, { owner: manager, label: `perf-${i}` });

    const loginRes = await factory.loginRaw(manager, { applicationTarget: 'manager_web' });
    accessToken = loginRes.body.accessToken as string;
    const setCookie = (loginRes.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('crewflow_session='))!;
    cookieValue = decodeURIComponent(setCookie.split(';')[0]!.slice('crewflow_session='.length));
  });

  afterAll(async () => {
    await app.close();
    await adminDataSource.destroy();
  });

  async function sampleOnce(transport: 'bearer' | 'cookie', path: string): Promise<{ durationMs: number; metrics?: RequestCompletePayload; errored: boolean }> {
    let captured: RequestCompletePayload | undefined;
    const unsubscribe = subscribeToRequestMetrics((payload) => {
      if (!captured) captured = payload;
    });
    const start = performance.now();
    let errored = false;
    try {
      const req = request(app.getHttpServer()).get(path);
      const res = transport === 'bearer' ? await req.set('Authorization', `Bearer ${accessToken}`) : await req.set('Cookie', [`crewflow_session=${cookieValue}`]);
      if (res.status >= 400) errored = true;
    } catch {
      errored = true;
    } finally {
      unsubscribe();
    }
    return { durationMs: performance.now() - start, metrics: captured, errored };
  }

  async function runScenario(name: string, transport: 'bearer' | 'cookie', path: string): Promise<ScenarioResult> {
    await sampleOnce(transport, path); // warmup
    const durations: number[] = [];
    const metrics: RequestCompletePayload[] = [];
    let errorCount = 0;
    for (let i = 0; i < SAMPLES_PER_SCENARIO; i++) {
      const { durationMs, metrics: m, errored } = await sampleOnce(transport, path);
      durations.push(durationMs);
      if (m) metrics.push(m);
      if (errored) errorCount++;
    }
    return summarize(name, transport, durations, metrics, errorCount);
  }

  it('measures auth/me and staff list under both transports and writes a comparison artifact', async () => {
    const results: ScenarioResult[] = [];
    results.push(await runScenario('auth_me', 'bearer', '/rest/v1/auth/me'));
    results.push(await runScenario('auth_me', 'cookie', '/rest/v1/auth/me'));
    results.push(await runScenario('staff_list', 'bearer', '/rest/v1/staff'));
    results.push(await runScenario('staff_list', 'cookie', '/rest/v1/staff'));

    for (const r of results) {
      expect(r.samples).toBe(SAMPLES_PER_SCENARIO);
      expect(r.errorCount).toBe(0);
    }

    // The decisive correctness-of-cost assertion: the cookie path must not add extra queries
    // relative to the Bearer path for the SAME endpoint — both resolve through the identical,
    // unmodified AuthSecuritySnapshotService; only the credential-resolution step itself differs
    // (one JWT verify vs. one indexed hash lookup), which should be a wash, not a regression.
    const byName = new Map(results.map((r) => [`${r.name}:${r.transport}`, r]));
    for (const name of ['auth_me', 'staff_list']) {
      const bearer = byName.get(`${name}:bearer`)!;
      const cookie = byName.get(`${name}:cookie`)!;
      expect(cookie.sqlCount.mean).toBeLessThanOrEqual(bearer.sqlCount.mean + 1); // +1 slack for the one extra hash-lookup query itself
      expect(cookie.transactionCount.mean).toBeLessThanOrEqual(bearer.transactionCount.mean);
    }

    const artifact = { capturedAt: new Date().toISOString(), database: 'local-disposable (TEST_DATABASE_URL)', samplesPerScenario: SAMPLES_PER_SCENARIO, scenarios: results };
    const dir = `${process.cwd()}/../../.audit/p1c1c-cookie-performance`;
    mkdirSync(dir, { recursive: true });
    const path = `${dir}/comparison-${Date.now()}.json`;
    writeFileSync(path, JSON.stringify(artifact, null, 2));

    // eslint-disable-next-line no-console
    console.log(`\nP1C.1C-F cookie-vs-bearer comparison written to ${path}\n` + JSON.stringify(results, null, 2));
  });
});
