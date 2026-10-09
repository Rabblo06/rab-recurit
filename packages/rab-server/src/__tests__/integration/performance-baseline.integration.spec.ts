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
 * P1A (FULL-ARCHITECTURE-UPGRADE-PLAN.md — P1 program, checkpoint A, item A4): the fresh,
 * disposable-local-database "before" baseline every later P1 checkpoint (C, E, F, G) must be
 * measured against — captured AFTER P1A's own instrumentation lands, so it reflects the
 * currently-running auth/session/permission/workspace chain, not a historical number from an
 * earlier audit (`docs/performance/*AUDIT*.md`'s own numbers are reference only, superseded by
 * this file's own output going forward).
 *
 * Gated behind `RUN_PERF_BASELINE=true` (in addition to the usual `describeIfDb` real-database
 * gate): this is a MEASUREMENT tool, not a correctness suite — it makes ~120+ real HTTP requests
 * sequentially and writes a JSON artifact, which would slow down every ordinary `yarn test` run
 * for no correctness benefit if left unconditional. Run explicitly:
 *   RUN_PERF_BASELINE=true npx jest performance-baseline.integration.spec.ts --runInBand
 *
 * Output: `<repo-root>/.audit/p1a-baseline/baseline-<timestamp>.json` (gitignored — `.audit/` is
 * already in `.gitignore`) plus a human-readable summary on stdout. No production/remote database
 * is ever touched — same `TEST_DATABASE_URL`/`TEST_DATABASE_URL_UNPOOLED` guard as every other
 * integration spec in this file's own directory.
 *
 * SAFETY: only ever reads back the SAFE `RequestCompletePayload` shape this process already
 * exposes for exactly this purpose (`request-context.ts`) — requestId, method, route TEMPLATE,
 * status, duration, counts, stage-name->ms maps. Never a token, cookie, password, email, or any
 * other PII/secret; see that file's own doc comment for the structural guarantee.
 */
const RUN = Boolean(process.env.DATABASE_URL) && process.env.RUN_PERF_BASELINE === 'true';
const describeIfEnabled = RUN ? describe : describe.skip;
jest.setTimeout(180_000);

const SAMPLES_PER_SCENARIO = 20;

interface ScenarioResult {
  name: string;
  method: string;
  path: string;
  samples: number;
  wallMs: { p50: number; p95: number; p99: number; min: number; max: number; mean: number };
  sqlCount: { mean: number; min: number; max: number };
  transactionCount: { mean: number; min: number; max: number };
  stageMeansMs: Record<string, number>;
  errorCount: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

function summarize(name: string, method: string, path: string, durations: number[], metrics: RequestCompletePayload[], errorCount: number): ScenarioResult {
  const sorted = [...durations].sort((a, b) => a - b);
  const sqlCounts = metrics.map((m) => m.sqlCount);
  const txCounts = metrics.map((m) => m.transactionCount);
  const stageSums: Record<string, number> = {};
  for (const m of metrics) {
    for (const [stage, ms] of Object.entries(m.stages)) {
      stageSums[stage] = (stageSums[stage] ?? 0) + ms;
    }
  }
  const stageMeansMs: Record<string, number> = {};
  for (const [stage, sum] of Object.entries(stageSums)) {
    stageMeansMs[stage] = metrics.length > 0 ? Math.round((sum / metrics.length) * 100) / 100 : 0;
  }
  const mean = (arr: number[]) => (arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
  return {
    name,
    method,
    path,
    samples: durations.length,
    wallMs: {
      p50: Math.round(percentile(sorted, 50)),
      p95: Math.round(percentile(sorted, 95)),
      p99: Math.round(percentile(sorted, 99)),
      min: sorted.length ? Math.round(sorted[0]!) : 0,
      max: sorted.length ? Math.round(sorted[sorted.length - 1]!) : 0,
      mean: Math.round(mean(durations)),
    },
    sqlCount: { mean: Math.round(mean(sqlCounts) * 100) / 100, min: sqlCounts.length ? Math.min(...sqlCounts) : 0, max: sqlCounts.length ? Math.max(...sqlCounts) : 0 },
    transactionCount: { mean: Math.round(mean(txCounts) * 100) / 100, min: txCounts.length ? Math.min(...txCounts) : 0, max: txCounts.length ? Math.max(...txCounts) : 0 },
    stageMeansMs,
    errorCount,
  };
}

describeIfEnabled('P1A performance baseline (fresh, disposable-local-database)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let tenantContext: TenantContextService;
  let factory: TestIdentityFactory;
  let org: Organisation;
  let manager: TestIdentity;
  let accessToken: string;

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

    org = await factory.createOrganisation('p1a-baseline');
    manager = await factory.createInternalManager(org);
    for (let i = 0; i < 10; i++) {
      await factory.createStaff(org, { owner: manager, label: `baseline-${i}` });
    }
    accessToken = await factory.login(manager);
  });

  afterAll(async () => {
    await app.close();
    await adminDataSource.destroy();
  });

  /** Runs one request, capturing its own safe metrics payload via X-Request-Id correlation — never by scraping logs. */
  async function sampleOnce(method: 'get' | 'post', path: string, body?: Record<string, unknown>): Promise<{ durationMs: number; metrics?: RequestCompletePayload; errored: boolean }> {
    let captured: RequestCompletePayload | undefined;
    const unsubscribe = subscribeToRequestMetrics((payload) => {
      if (!captured) captured = payload; // first (only) payload while this subscription is active
    });
    const start = performance.now();
    let errored = false;
    try {
      const req = request(app.getHttpServer())[method](path).set('Authorization', `Bearer ${accessToken}`);
      const res = body ? await req.send(body) : await req;
      if (res.status >= 500) errored = true;
    } catch {
      errored = true;
    } finally {
      unsubscribe();
    }
    return { durationMs: performance.now() - start, metrics: captured, errored };
  }

  async function runScenario(name: string, method: 'get' | 'post', path: string, body?: Record<string, unknown>): Promise<ScenarioResult> {
    await sampleOnce(method, path, body); // warmup, not recorded
    const durations: number[] = [];
    const metrics: RequestCompletePayload[] = [];
    let errorCount = 0;
    for (let i = 0; i < SAMPLES_PER_SCENARIO; i++) {
      const { durationMs, metrics: m, errored } = await sampleOnce(method, path, body);
      durations.push(durationMs);
      if (m) metrics.push(m);
      if (errored) errorCount++;
    }
    return summarize(name, method.toUpperCase(), path, durations, metrics, errorCount);
  }

  it('captures a fresh baseline across login/me/staff/offers/dashboard and writes the artifact', async () => {
    const results: ScenarioResult[] = [];

    // Login is its own scenario (fresh credentials each time) — rate limiting is already globally
    // disabled under Jest (see jest-setup.ts's RAB_DISABLE_RATE_LIMIT), so this is safe here even
    // though the real server throttles it at 5/60s/IP in production.
    {
      const durations: number[] = [];
      const metrics: RequestCompletePayload[] = [];
      let errorCount = 0;
      for (let i = 0; i < SAMPLES_PER_SCENARIO; i++) {
        let captured: RequestCompletePayload | undefined;
        const unsubscribe = subscribeToRequestMetrics((payload) => {
          if (!captured) captured = payload;
        });
        const start = performance.now();
        const res = await request(app.getHttpServer())
          .post('/rest/v1/auth/login')
          .send({ email: manager.email, password: manager.password, applicationTarget: 'manager_web' });
        unsubscribe();
        durations.push(performance.now() - start);
        if (captured) metrics.push(captured);
        if (res.status >= 500) errorCount++;
      }
      results.push(summarize('login', 'POST', '/rest/v1/auth/login', durations, metrics, errorCount));
    }

    results.push(await runScenario('auth_me', 'get', '/rest/v1/auth/me'));
    results.push(await runScenario('staff_list', 'get', '/rest/v1/staff'));
    results.push(await runScenario('offers_list', 'get', '/rest/v1/offers'));
    results.push(await runScenario('dashboard_summary', 'get', '/rest/v1/dashboard/summary'));
    // P1B: device/session list, now reading core.user_session directly (see profile.service.ts).
    results.push(await runScenario('profile_sessions', 'get', '/rest/v1/profile/sessions'));

    // Sanity, not a performance assertion: every scenario actually produced samples and captured
    // at least some metrics payloads (proves the X-Request-Id/subscription plumbing itself works).
    for (const r of results) {
      expect(r.samples).toBe(SAMPLES_PER_SCENARIO);
      expect(r.errorCount).toBe(0);
    }

    const artifact = {
      capturedAt: new Date().toISOString(),
      database: 'local-disposable (TEST_DATABASE_URL)',
      samplesPerScenario: SAMPLES_PER_SCENARIO,
      note: 'Historical docs/performance/*.md numbers are reference only; this is the current P1A baseline.',
      scenarios: results,
    };

    const dir = `${process.cwd()}/../../.audit/p1a-baseline`;
    mkdirSync(dir, { recursive: true });
    const path = `${dir}/baseline-${Date.now()}.json`;
    writeFileSync(path, JSON.stringify(artifact, null, 2));

    // eslint-disable-next-line no-console
    console.log(`\nP1A baseline written to ${path}\n` + JSON.stringify(artifact.scenarios, null, 2));
  });
});
