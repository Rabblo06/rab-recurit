import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { AdminHealthReport, AdminHealthService } from '../../engine/core-modules/platform-admin/admin-health.service';
import { DATABASE_INDICATOR_SQL, databaseIndicator } from '../../engine/core-modules/platform-admin/indicators/database.indicator';
import { parseRedisMemoryInfo, readRedisInfoToken } from '../../engine/core-modules/platform-admin/indicators/parse-redis-info.util';
import { redisIndicator } from '../../engine/core-modules/platform-admin/indicators/redis.indicator';
import { schedulerIndicator } from '../../engine/core-modules/platform-admin/indicators/scheduler.indicator';
import { workerIndicator } from '../../engine/core-modules/platform-admin/indicators/worker.indicator';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { ThrottlerRedisClientProvider } from '../../engine/core-modules/throttler/throttler-redis-client.provider';
import { applyGlobalValidationPipe } from '../../engine/utils/global-validation-pipe';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';
import { integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';

/**
 * Phase X Part 2, X2.4 — the Health tab indicators against a REAL PostgreSQL and Redis (the disposable test cluster):
 *  - each indicator's numbers equal what the server itself reports (pg_stat_database / max_connections, INFO, LLEN/ZCARD);
 *  - the route is platform-admin only (403 like every Admin Panel route, PlatformAdminGuard) and writes no audit row then;
 *  - access is audited (`admin.health_viewed`): once per admin per 5 minutes, plus every manual Refresh (`?refresh=1`);
 *  - a Redis or database failure turns only that indicator `unavailable`, the page still answers 200;
 *  - NO write command reaches Redis: every command the health read sends (seen with MONITOR, filtered to the API's own
 *    connection) is checked against the server's `COMMAND INFO` flags.
 * Planted keys use a per-run prefix (`crewflow:test:x24-<run>`) and are deleted by exact name afterwards (no pattern delete).
 */
const RUN = integrationTestDatabaseReady() && Boolean(process.env.REDIS_URL);
const describeIfDb = RUN ? describe : describe.skip;
const RUN_ID = randomUUID().slice(0, 8);

describeIfDb('admin health indicators (X2.4, integration)', () => {
  jest.setTimeout(300_000);
  let app: INestApplication;
  let owner: DataSource;
  let appDataSource: DataSource;
  let factory: TestIdentityFactory;
  let throttlerRedis: ThrottlerRedisClientProvider;
  let side: Redis;
  let admin: TestIdentity;
  let nonAdmin: TestIdentity;
  let adminToken: string;
  let nonAdminToken: string;
  const planted: string[] = [];
  const http = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const card = (r: AdminHealthReport, key: string) => r.cards.find((c) => c.key === key)!;
  /** A Refresh re-probes only a report >= 5 s old (review R2); tests that need a live probe drop the process cache first. */
  const dropCache = () => {
    (app.get(AdminHealthService) as unknown as { cache: unknown }).cache = null;
  };
  const auditCount = async (userId: string) =>
    (await owner.query(`SELECT count(*)::int AS n FROM core.audit_log WHERE actor_user_id = $1 AND action = 'admin.health_viewed'`, [userId]))[0].n as number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = applyGlobalValidationPipe(moduleRef.createNestApplication());
    await app.init();
    owner = createAdminDataSource();
    await owner.initialize();
    appDataSource = moduleRef.get(DataSource);
    throttlerRedis = moduleRef.get(ThrottlerRedisClientProvider);
    side = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: 1 });
    factory = new TestIdentityFactory({ app, dataSource: appDataSource, adminDataSource: owner, tenantContext: moduleRef.get(TenantContextService), passwordHashing: moduleRef.get(PasswordHashingService) });
    const org = await factory.createOrganisation('x24-health');
    admin = await factory.createInternalManager(org, { permissions: 'all', label: 'x24adm', platformAdmin: true });
    nonAdmin = await factory.createInternalManager(org, { permissions: 'all', label: 'x24mgr' });
    adminToken = await factory.login(admin, { applicationTarget: 'manager_web' });
    nonAdminToken = await factory.login(nonAdmin, { applicationTarget: 'manager_web' });
  });

  afterAll(async () => {
    if (planted.length) await side?.del(...planted);
    side?.disconnect();
    await owner?.destroy();
    await app?.close();
  });

  it('database: connections and max_connections equal the server statistics (one read-only SELECT)', async () => {
    const result = await databaseIndicator(appDataSource);
    const [direct] = await owner.query(
      `SELECT (SELECT sum(numbackends) FROM pg_stat_database)::int AS n, current_setting('max_connections')::int AS max,
              current_setting('superuser_reserved_connections')::int AS sr, current_setting('reserved_connections')::int AS r,
              current_setting('server_version_num')::int AS v`,
    );
    const connections = result.facts!.find((f) => f.label === 'Connections')!.value;
    const [, used, usable] = /^(\d+) of (\d+) usable \(\d+%\)$/.exec(connections)!;
    expect(Number(usable)).toBe(direct.max - direct.sr - direct.r);
    expect(result.facts).toContainEqual({ label: 'max_connections', value: String(direct.max) });
    // Backends come and go between two reads (pool connections of this very suite): equal within a small margin.
    expect(Math.abs(Number(used) - direct.n)).toBeLessThanOrEqual(5);
    expect(result.facts).toContainEqual({ label: 'Version', value: `PostgreSQL ${Math.floor(direct.v / 10_000)}` });
    expect(result.status === 'healthy' || result.status === 'warning').toBe(true);
    // The statement is read-only by construction: it also runs inside a READ ONLY transaction.
    await owner.transaction(async (m) => {
      await m.query('SET TRANSACTION READ ONLY');
      await expect(m.query(DATABASE_INDICATOR_SQL)).resolves.toHaveLength(1);
    });
  });

  it('redis: version and memory equal INFO server / INFO memory read on a separate connection', async () => {
    const result = await redisIndicator(throttlerRedis.client, true);
    const version = readRedisInfoToken(await side.info('server'), 'redis_version');
    const memory = parseRedisMemoryInfo(await side.info('memory'))!;
    expect(result.facts).toContainEqual({ label: 'Version', value: version });
    expect(result.detail).toContain(`Redis ${version}`);
    const maxFact = result.facts!.find((f) => f.label === 'maxmemory')!.value;
    if (memory.maxMemoryBytes === 0) expect(maxFact).toBe('Not set (no limit)');
    else expect(maxFact).not.toBe('Not set (no limit)');
  });

  it('worker: heartbeat age and per-queue failed / waiting (wait + paused) / prioritized / active / delayed equal the planted BullMQ keys', async () => {
    const prefix = `crewflow:test:x24-${RUN_ID}`;
    const q = `x24-queue-${RUN_ID}`;
    const k = (s: string) => `${prefix}:${q}:${s}`;
    const beat = `${prefix}:heartbeat`;
    planted.push(k('wait'), k('paused'), k('active'), k('prioritized'), k('delayed'), k('failed'), beat);
    await side.rpush(k('wait'), 'j1', 'j2', 'j3');
    await side.rpush(k('paused'), 'j8');
    await side.rpush(k('active'), 'j4');
    await side.zadd(k('prioritized'), 1, 'j5');
    await side.zadd(k('delayed'), 1, 'j6', 2, 'j7');
    await side.zadd(k('failed'), 1, 'f1', 2, 'f2', 3, 'f3', 4, 'f4');
    await side.set(beat, String(Date.now() - 3_000), 'EX', 60);
    const result = await workerIndicator(throttlerRedis.client, { heartbeatKey: beat, heartbeatTtlSeconds: 30, queues: [{ name: q, prefix }] });
    expect(result.status).toBe('healthy');
    expect(result.facts).toContainEqual({ label: q, value: '4 failed · 4 waiting · 1 prioritized · 1 active · 2 delayed' });
    expect(result.detail).toMatch(/^Heartbeat [3-5] s ago · 4 failed · 4 waiting across 1 queue$/);
  });

  it('scheduler: the count is ZCARD of each scan queue\'s repeat set and is compared with the Worker report', async () => {
    const prefix = `crewflow:test:x24-${RUN_ID}-bull`;
    const statusKey = `crewflow:test:x24-${RUN_ID}:scheduler`;
    const queues = [`x24-scan-a-${RUN_ID}`, `x24-scan-b-${RUN_ID}`];
    planted.push(`${prefix}:${queues[0]}:repeat`, `${prefix}:${queues[1]}:repeat`, statusKey);
    await side.zadd(`${prefix}:${queues[0]}:repeat`, 1, 's1', 2, 's2');
    await side.zadd(`${prefix}:${queues[1]}:repeat`, 1, 's3');
    await side.hset(statusKey, { mode: 'bullmq', prefix, schedulers: '3', missing: '0', reconciledAt: String(Date.now()), registration: 'worker' });
    const ok = await schedulerIndicator(throttlerRedis.client, { configuredMode: 'bullmq', statusKey, fallbackPrefix: 'unused', scanQueues: queues });
    expect(ok).toMatchObject({ status: 'healthy' });
    expect(ok.facts).toContainEqual({ label: 'Schedulers in Redis', value: '3' });
    await side.hset(statusKey, { schedulers: '4' });
    expect((await schedulerIndicator(throttlerRedis.client, { configuredMode: 'bullmq', statusKey, fallbackPrefix: 'unused', scanQueues: queues })).status).toBe('degraded');
  });

  it('ABUSE: a non-platform-admin gets 403 (PlatformAdminGuard, as every Admin Panel route) with and without ?refresh=1, and no audit row', async () => {
    const before = await auditCount(nonAdmin.userId);
    expect((await http().get('/rest/v1/admin/health/report').set(bearer(nonAdminToken))).status).toBe(403);
    expect((await http().get('/rest/v1/admin/health/report?refresh=1').set(bearer(nonAdminToken))).status).toBe(403);
    expect((await http().get('/rest/v1/admin/health/report')).status).toBe(401);
    expect(await auditCount(nonAdmin.userId)).toBe(before);
  });

  it('ABUSE: unknown query keys and a bad refresh value are 400 (forbidNonWhitelisted)', async () => {
    expect((await http().get('/rest/v1/admin/health/report?refresh=true').set(bearer(adminToken))).status).toBe(400);
    expect((await http().get(`/rest/v1/admin/health/report?organisationId=${randomUUID()}`).set(bearer(adminToken))).status).toBe(400);
  });

  it('the page renders every indicator and access is audited: once per 5 minutes per admin, plus every manual Refresh', async () => {
    const start = await auditCount(admin.userId);
    const first = await http().get('/rest/v1/admin/health/report').set(bearer(adminToken));
    expect(first.status).toBe(200);
    expect((first.body as AdminHealthReport).cards.map((c) => c.key)).toEqual(expect.arrayContaining(['api', 'database', 'redis', 'worker', 'scheduler']));
    expect(await auditCount(admin.userId)).toBe(start + 1);
    // Polling inside the 5 minutes writes nothing more.
    expect((await http().get('/rest/v1/admin/health/report').set(bearer(adminToken))).status).toBe(200);
    expect(await auditCount(admin.userId)).toBe(start + 1);
    // Refresh always writes a row, with metadata.refresh = true, in the admin's own organisation.
    expect((await http().get('/rest/v1/admin/health/report?refresh=1').set(bearer(adminToken))).status).toBe(200);
    expect(await auditCount(admin.userId)).toBe(start + 2);
    const [row] = await owner.query(`SELECT organisation_id, metadata FROM core.audit_log WHERE actor_user_id = $1 AND action = 'admin.health_viewed' ORDER BY created_at DESC LIMIT 1`, [admin.userId]);
    expect(row.organisation_id).toBe(admin.organisationId);
    expect(row.metadata).toEqual({ refresh: true });
  });

  it('a Redis failure turns the Redis-backed indicators unavailable; a database failure turns the database indicator unavailable; the page still answers', async () => {
    const health = app.get(AdminHealthService);
    const actor = { userId: admin.userId, organisationId: admin.organisationId, inspectedBy: undefined };
    dropCache();
    const redisDown = jest.spyOn(throttlerRedis.client, 'info').mockRejectedValue(new Error('ECONNREFUSED planted-redis:6379'));
    let res = await http().get('/rest/v1/admin/health/report?refresh=1').set(bearer(adminToken));
    redisDown.mockRestore();
    expect(res.status).toBe(200);
    expect(card(res.body, 'redis')).toMatchObject({ status: 'unavailable', detail: 'Not reachable.' });
    expect(card(res.body, 'database').status).not.toBe('unavailable');
    expect(JSON.stringify(res.body)).not.toMatch(/planted|ECONNREFUSED/);

    dropCache();
    const realQuery = appDataSource.query.bind(appDataSource);
    // Every other caller (the guards, the audit write) passes through with ALL its arguments (a query runner included).
    const dbDown = jest.spyOn(appDataSource, 'query').mockImplementation(((...args: Parameters<DataSource['query']>) =>
      args[0] === DATABASE_INDICATOR_SQL ? Promise.reject(new Error('ECONNREFUSED planted-db:5432')) : realQuery(...args)) as DataSource['query']);
    res = await http().get('/rest/v1/admin/health/report?refresh=1').set(bearer(adminToken));
    dbDown.mockRestore();
    expect(res.status).toBe(200);
    expect(card(res.body, 'database')).toMatchObject({ status: 'unavailable', detail: 'Not reachable.' });
    expect(card(res.body, 'redis').status).not.toBe('unavailable');
    expect(JSON.stringify(res.body)).not.toMatch(/planted|ECONNREFUSED/);
    // The service directly (layer 2 callers) behaves the same.
    dropCache();
    await expect(health.report(actor, { refresh: true })).resolves.toMatchObject({ cards: expect.any(Array) });
  });

  it('NO write command reaches Redis: every command of a live health read, and every command from ANY connection in that window, is checked against COMMAND INFO (no "write" flag)', async () => {
    const health = app.get(AdminHealthService);
    const actor = { userId: admin.userId, organisationId: admin.organisationId, inspectedBy: undefined };
    const info = String(await throttlerRedis.client.client('INFO'));
    const addr = /(?:^|\s)addr=(\S+)/.exec(info)?.[1];
    expect(addr).toBeTruthy();
    const monitor = await side.monitor();
    const seen: Array<{ source: string; args: string[] }> = [];
    monitor.on('monitor', (_time: string, args: string[], source: string) => seen.push({ source, args }));
    try {
      await new Promise((r) => setTimeout(r, 100));
      dropCache();
      const report = await health.report(actor, { refresh: true });
      expect(card(report, 'redis').status).not.toBe('unavailable');
      await new Promise((r) => setTimeout(r, 300));
    } finally {
      monitor.disconnect();
    }
    const mine = seen.filter((s) => s.source === addr || s.source === 'lua');
    const names = [...new Set(mine.map((s) => s.args[0]!.toLowerCase()))].sort();
    // The indicators' read set (no SET for the cache, no EVAL, no MULTI any more).
    expect(names).toEqual(expect.arrayContaining(['get', 'hgetall', 'info', 'llen', 'zcard']));
    for (const name of names) {
      const [spec] = (await side.command('INFO', name)) as Array<[string, number, string[]]>;
      expect({ name, write: spec[2].includes('write') }).toEqual({ name, write: false });
    }
    expect(mine.filter((s) => s.source === 'lua')).toEqual([]);
    // Review item 4: nothing else wrote to Redis in that window either (this test's own `side` connection was idle,
    // and the MONITOR connection issues nothing after MONITOR).
    const everyName = [...new Set(seen.map((s) => s.args[0]!.toLowerCase()))].sort();
    for (const name of everyName) {
      const [spec] = (await side.command('INFO', name)) as Array<[string, number, string[]]>;
      expect({ name, write: spec[2].includes('write'), sources: [...new Set(seen.filter((s) => s.args[0]!.toLowerCase() === name).map((s) => s.source))] }).toMatchObject({ name, write: false });
    }
  });
});
