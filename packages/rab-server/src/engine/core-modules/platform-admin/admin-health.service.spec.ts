import { ForbiddenException } from '@nestjs/common';

import { AuditAction } from '../audit/audit.service';
import { ADMIN_HEALTH_AUDIT_INTERVAL_MS, ADMIN_HEALTH_CACHE_MS, AdminHealthReport, AdminHealthService } from './admin-health.service';
import { DATABASE_INDICATOR_SQL } from './indicators/database.indicator';

/**
 * Phase X Part 2, X2.4: the Health tab service around the indicators — the order (admin check → audit → probes), the
 * 5-minute audit dedupe and the manual-Refresh row, the in-process 10 s cache (no Redis write), and failure isolation (one
 * failing dependency turns its own cards `unavailable`, the report still answers).
 */
const READ_ONLY = new Set(['info', 'get', 'hgetall', 'llen', 'zcard']);

function setup(opts: { redisDown?: boolean; dbDown?: boolean; admin?: boolean; auditFails?: boolean } = {}) {
  const redisCalls: string[] = [];
  const answers: Record<string, (arg: string) => unknown> = {
    info: (section) => (section === 'server' ? 'redis_version:7.2.4\r\n' : 'used_memory:1024\r\nmaxmemory:0\r\n'),
    get: () => String(Date.now()),
    hgetall: () => ({}),
    llen: () => 0,
    zcard: () => 0,
  };
  const client = new Proxy({} as Record<string, unknown>, {
    get(_t, prop: string) {
      if (prop === 'then') return undefined;
      return async (arg: string) => {
        redisCalls.push(prop);
        if (!READ_ONLY.has(prop)) throw new Error(`write-capable Redis member used: ${prop}`);
        if (opts.redisDown) throw new Error('ECONNREFUSED planted-redis-host:6379');
        return answers[prop]!(arg);
      };
    },
  });
  const query = jest.fn(async (sql: string) => {
    if (opts.dbDown) throw new Error('ECONNREFUSED planted-db-host:5432');
    if (sql === DATABASE_INDICATOR_SQL) return [{ connections: 5, max_connections: 100, reserved_connections: 3, server_version_num: 160004 }];
    return [];
  });
  const env: Record<string, unknown> = { APP_VERSION: '2.4.0', REDIS_URL: 'redis://:pw@redis:6379', EMAIL_DRIVER: 'LOGGER', STORAGE_DRIVER: 'LOCAL', NODE_ENV: 'test', WORKER_SCHEDULER: 'interval' };
  const record = jest.fn(async () => {
    if (opts.auditFails) throw new Error('audit insert failed');
  });
  const runInTenantContext = jest.fn(async (_ctx: unknown, fn: (m: unknown) => Promise<unknown>) => fn({}));
  const healthProbe = jest.fn(async () => undefined);
  const service = new AdminHealthService(
    { query, driver: {} } as never,
    { get: (k: string) => env[k] } as never,
    { client } as never,
    { healthProbe } as never,
    { record } as never,
    { runInTenantContext } as never,
    { isPlatformAdmin: async () => opts.admin !== false } as never,
  );
  return { service, query, record, redisCalls, healthProbe };
}

const actor = { userId: '11111111-1111-4111-8111-111111111111', organisationId: '22222222-2222-4222-8222-222222222222', inspectedBy: undefined };
const card = (r: AdminHealthReport, key: string) => r.cards.find((c) => c.key === key)!;

describe('AdminHealthService (X2.4)', () => {
  let now = 1_800_000_000_000;
  beforeEach(() => {
    now = 1_800_000_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
  });
  afterEach(() => jest.restoreAllMocks());

  it('every indicator is in the report, in order: api, database, redis, worker, scheduler, provisioner, email, storage', async () => {
    const { service } = setup();
    const report = await service.report(actor);
    expect(report.cards.map((c) => c.key)).toEqual(['api', 'database', 'redis', 'worker', 'scheduler', 'provisioner', 'email', 'storage']);
    expect(card(report, 'database').detail).toContain('5 of 100 connections (5%)');
    expect(card(report, 'redis').detail).toContain('Redis 7.2.4');
  });

  it('read-only on Redis: only info/get/hgetall/llen/zcard are ever called (no cache SET any more)', async () => {
    const { service, redisCalls } = setup();
    const report = await service.report(actor, { refresh: true });
    expect(report.cards.filter((c) => ['redis', 'worker', 'scheduler', 'provisioner'].includes(c.key)).every((c) => c.status !== 'unavailable')).toBe(true);
    expect(redisCalls.length).toBeGreaterThan(0);
    expect(redisCalls.filter((c) => !READ_ONLY.has(c))).toEqual([]);
  });

  it('cache: a second read within 10 s is served from process memory (no probe); after 10 s it probes again', async () => {
    const { service, query, healthProbe } = setup();
    const first = await service.report(actor);
    now += ADMIN_HEALTH_CACHE_MS - 1;
    expect(await service.report(actor)).toBe(first);
    expect(query).toHaveBeenCalledTimes(1);
    now += 2;
    await service.report(actor);
    expect(query).toHaveBeenCalledTimes(2);
    expect(healthProbe).toHaveBeenCalledTimes(2);
  });

  it('audit dedupe: one admin.health_viewed row per admin per process at most every 5 minutes', async () => {
    const { service, record } = setup();
    await service.report(actor);
    now += 60_000;
    await service.report(actor);
    now += ADMIN_HEALTH_AUDIT_INTERVAL_MS - 60_000 - 1;
    await service.report(actor);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith({}, actor, AuditAction.ADMIN_HEALTH_VIEWED, { metadata: { refresh: false } });
    now += 1;
    await service.report(actor);
    expect(record).toHaveBeenCalledTimes(2);
    // Another admin is not deduped by the first one.
    await service.report({ ...actor, userId: '33333333-3333-4333-8333-333333333333' });
    expect(record).toHaveBeenCalledTimes(3);
  });

  it('a manual Refresh always writes a row (even inside the 5 minutes) and skips the cache', async () => {
    const { service, record, query } = setup();
    await service.report(actor);
    await service.report(actor, { refresh: true });
    await service.report(actor, { refresh: true });
    expect(record).toHaveBeenCalledTimes(3);
    expect(record).toHaveBeenLastCalledWith({}, actor, AuditAction.ADMIN_HEALTH_VIEWED, { metadata: { refresh: true } });
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('the audit write fails closed (the request fails, nothing probed) and the dedupe is not marked', async () => {
    const failing = setup({ auditFails: true });
    await expect(failing.service.report(actor)).rejects.toThrow('audit insert failed');
    expect(failing.query).not.toHaveBeenCalled();
    await expect(failing.service.report(actor)).rejects.toThrow();
    expect(failing.record).toHaveBeenCalledTimes(2);
  });

  it('a non-platform-admin is refused (403) before any audit row or probe', async () => {
    const { service, record, query, redisCalls } = setup({ admin: false });
    await expect(service.report(actor)).rejects.toBeInstanceOf(ForbiddenException);
    expect(record).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(redisCalls).toEqual([]);
  });

  it('Redis down: the Redis, Worker, scheduler and provisioner cards are unavailable with fixed text; the report still answers', async () => {
    const { service } = setup({ redisDown: true });
    const report = await service.report(actor);
    for (const key of ['redis', 'worker', 'scheduler', 'provisioner']) expect(card(report, key)).toMatchObject({ status: 'unavailable', detail: 'Not reachable.' });
    expect(card(report, 'database').status).toBe('healthy');
    expect(card(report, 'api').status).toBe('healthy');
    expect(JSON.stringify(report)).not.toMatch(/planted|ECONNREFUSED/);
  });

  it('database down: only the database card is unavailable; the report still answers', async () => {
    const { service } = setup({ dbDown: true });
    const report = await service.report(actor);
    expect(card(report, 'database')).toMatchObject({ status: 'unavailable', detail: 'Not reachable.' });
    expect(card(report, 'redis').status).toBe('healthy');
    expect(JSON.stringify(report)).not.toMatch(/planted|ECONNREFUSED/);
  });
});
