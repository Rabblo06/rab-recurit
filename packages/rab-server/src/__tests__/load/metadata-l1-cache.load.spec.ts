// Cache profile is chosen per PROCESS (Nest's ConfigModule freezes env at AppModule import):
//   LOAD_CACHE_PROFILE=off  → every cache off (PostgreSQL only)
//   LOAD_CACHE_PROFILE=l2   → the existing Redis caches on, L1 off
//   LOAD_CACHE_PROFILE=l1   → Redis caches on + in-process L1 (2 s TTL)
const PROFILE = (process.env.LOAD_CACHE_PROFILE ?? 'l1') as 'off' | 'l2' | 'l1';
const on = PROFILE !== 'off' ? 'true' : 'false';
process.env.AUTH_CONTEXT_CACHE_ENABLED = on;
process.env.USER_SESSION_CACHE_ENABLED = on;
process.env.CORE_ENTITY_CACHE_ENABLED = on;
process.env.WORKSPACE_METADATA_CACHE_ENABLED = on;
process.env.METADATA_L1_CACHE_ENABLED = PROFILE === 'l1' ? 'true' : 'false';
process.env.METADATA_L1_CACHE_TTL_MS = '2000';

import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { CoreEntityCacheService } from '../../engine/core-modules/entity-cache/core-entity-cache.service';
import { MetadataL1CacheService } from '../../engine/core-modules/entity-cache/metadata-l1-cache.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { createAdminDataSource } from '../integration/helpers/admin-datasource';
import { TestIdentityFactory } from '../integration/helpers/test-identities';

/**
 * WAVE 5 LANE OPS — L1 metadata cache load test (opt-in; excluded from the default suite):
 *   RAB_LOAD_TEST=1 LOAD_CACHE_PROFILE=off|l2|l1 npx jest --testPathIgnorePatterns=/node_modules/ metadata-l1-cache.load
 *
 * Real: the Nest app listening on a real TCP port, keep-alive HTTP clients, real JWTs, real PostgreSQL (RLS, crewflow_app)
 * and real Redis. Rate limiting is disabled by the Jest setup (RAB_DISABLE_RATE_LIMIT) so the generator's single IP does
 * not measure the throttler. Same-machine numbers (generator, API, PostgreSQL and Redis share one Windows laptop): a
 * relative comparison between profiles, not production latencies. Results: docs/evidence/w5-ops/load/<profile>.json.
 */
const RUN = process.env.RAB_LOAD_TEST === '1' && Boolean(process.env.DATABASE_URL);
const describeIf = RUN ? describe : describe.skip;
jest.setTimeout(20 * 60_000);

const REQUESTS = Number(process.env.LOAD_REQUESTS ?? 3000);
const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY ?? 20);
const MICRO_ITERATIONS = Number(process.env.LOAD_MICRO_ITERATIONS ?? 5000);

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}
function summary(latencies: number[], wallMs: number, statuses: Record<string, number>) {
  const s = [...latencies].sort((a, b) => a - b);
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    requests: latencies.length,
    wallMs: round(wallMs),
    rps: round((latencies.length / wallMs) * 1000),
    p50: round(percentile(s, 50)),
    p95: round(percentile(s, 95)),
    p99: round(percentile(s, 99)),
    max: round(s[s.length - 1]!),
    statuses,
  };
}

describeIf(`metadata L1 load test (profile=${PROFILE})`, () => {
  let app: INestApplication;
  let adminDataSource: DataSource;
  let port: number;
  let token: string;
  const agent = new http.Agent({ keepAlive: true, maxSockets: 256 });

  const get = (pathname: string) =>
    new Promise<{ status: number; ms: number }>((resolve, reject) => {
      const t0 = performance.now();
      const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'GET', agent, headers: { authorization: `Bearer ${token}` } }, (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0, ms: performance.now() - t0 }));
      });
      req.on('error', reject);
      req.end();
    });

  async function run(pathname: string) {
    // Warm-up (fills every cache layer the profile has), then the measured burst.
    for (let i = 0; i < 50; i++) await get(pathname);
    const latencies: number[] = [];
    const statuses: Record<string, number> = {};
    let next = 0;
    const t0 = performance.now();
    await Promise.all(
      Array.from({ length: CONCURRENCY }, async () => {
        while (next < REQUESTS) {
          next += 1;
          const r = await get(pathname);
          latencies.push(r.ms);
          statuses[r.status] = (statuses[r.status] ?? 0) + 1;
        }
      }),
    );
    return summary(latencies, performance.now() - t0, statuses);
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    await app.listen(0, '127.0.0.1');
    port = (app.getHttpServer().address() as AddressInfo).port;
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    const factory = new TestIdentityFactory({
      app,
      dataSource: moduleRef.get(DataSource),
      adminDataSource,
      tenantContext: moduleRef.get(TenantContextService),
      passwordHashing: moduleRef.get(PasswordHashingService),
    });
    const { managers } = await factory.createOrganisationWithManagers(1, { permissions: ['role.view', 'staff.view'] });
    token = await factory.login(managers[0]!);
    const l1 = moduleRef.get(MetadataL1CacheService);
    const start = Date.now();
    while (PROFILE === 'l1' && !l1.isLive() && Date.now() - start < 5000) await new Promise((r) => setTimeout(r, 25));
  });

  afterAll(async () => {
    agent.destroy();
    await app.close();
    await adminDataSource.destroy();
  });

  it('measures HTTP latency for the catalogue endpoint and an auth-only baseline, plus the raw cache primitive', async () => {
    const catalogue = await run('/rest/v1/roles/permissions');
    const me = await run('/rest/v1/auth/me');

    // Primitive: one metadata lookup whose miss path is a real PostgreSQL round trip (registry-read sized).
    const cache = app.get(CoreEntityCacheService);
    const ds = app.get(DataSource);
    const enabled = PROFILE !== 'off';
    const micro: number[] = [];
    for (let i = 0; i < MICRO_ITERATIONS; i++) {
      const t0 = performance.now();
      await cache.getOrFetch('workspace_schema_resolution', 'load-test-workspace', async () => {
        const rows: Array<{ n: string }> = await ds.query(`SELECT 'workspace_' || md5('load-test-workspace') AS n`);
        return { schemaName: rows[0]!.n, schemaVersion: 1 };
      }, enabled);
      micro.push(performance.now() - t0);
    }
    const microSummary = summary(micro, micro.reduce((a, b) => a + b, 0), {});
    const l1Stats = app.get(MetadataL1CacheService).stats();

    const result = {
      profile: PROFILE,
      config: { requests: REQUESTS, concurrency: CONCURRENCY, microIterations: MICRO_ITERATIONS, l1TtlMs: 2000 },
      http: { rolesPermissions: catalogue, authMe: me },
      primitive: { schemaResolutionLookup: { p50: microSummary.p50, p95: microSummary.p95, p99: microSummary.p99, meanMs: Math.round((microSummary.wallMs / MICRO_ITERATIONS) * 1000) / 1000 } },
      l1: { hits: l1Stats.hits, misses: l1Stats.misses, entries: l1Stats.entries, approxBytes: l1Stats.approxBytes, live: l1Stats.live },
      memory: { rssMb: Math.round(process.memoryUsage().rss / 1048576), heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1048576) },
      node: process.version,
      at: new Date().toISOString(),
    };
    const dir = path.resolve(__dirname, '../../../../../docs/evidence/w5-ops/load');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${PROFILE}.json`), JSON.stringify(result, null, 2));
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(result));
    expect(catalogue.statuses['200']).toBe(REQUESTS);
    expect(me.statuses['200']).toBe(REQUESTS);
  });
});
