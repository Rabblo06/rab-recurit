import type { DataSource } from 'typeorm';

import { apiIndicator, formatUptime } from './api.indicator';
import { DATABASE_INDICATOR_SQL, databaseIndicator } from './database.indicator';
import type { HealthRedisReader } from './health-redis-reader';
import { formatBytes, parseRedisMemoryInfo, readRedisInfoToken } from './parse-redis-info.util';
import { redisIndicator } from './redis.indicator';
import { schedulerIndicator } from './scheduler.indicator';
import { heartbeatAgeSeconds, workerIndicator } from './worker.indicator';

/**
 * Phase X Part 2, X2.4: the Health tab indicators (pure parts and status rules). The values against a real PostgreSQL and
 * Redis, the audit, the 403 and the "no Redis write" check are in `admin-health-indicators.integration.spec.ts`.
 */

/** An in-memory Redis with ONLY the read commands the indicators may use; any other property access throws. */
function fakeRedis(data: { strings?: Record<string, string>; lists?: Record<string, number>; zsets?: Record<string, number>; hashes?: Record<string, Record<string, string>>; info?: Record<string, string> }) {
  const calls: string[] = [];
  const reader = {
    info: async (section?: string) => {
      calls.push(`info ${section}`);
      return data.info?.[section ?? ''] ?? '';
    },
    get: async (key: string) => {
      calls.push(`get ${key}`);
      return data.strings?.[key] ?? null;
    },
    hgetall: async (key: string) => {
      calls.push(`hgetall ${key}`);
      return data.hashes?.[key] ?? {};
    },
    llen: async (key: string) => {
      calls.push(`llen ${key}`);
      return data.lists?.[key] ?? 0;
    },
    zcard: async (key: string) => {
      calls.push(`zcard ${key}`);
      return data.zsets?.[key] ?? 0;
    },
  };
  const client = new Proxy(reader, {
    get(target, prop) {
      if (prop in target) return target[prop as keyof typeof target];
      if (prop === 'then') return undefined;
      throw new Error(`indicator used a non-read Redis member: ${String(prop)}`);
    },
  }) as unknown as HealthRedisReader;
  return { client, calls };
}

const INFO_MEMORY = '# Memory\r\nused_memory:1048576\r\nused_memory_human:1.00M\r\nused_memory_peak:2097152\r\nmaxmemory:67108864\r\nmaxmemory_human:64.00M\r\nmaxmemory_policy:noeviction\r\n';
const INFO_SERVER = '# Server\r\nredis_version:7.2.4\r\nredis_mode:standalone\r\nexecutable:/data/planted-path/redis-server\r\nconfig_file:/etc/planted.conf\r\n';

describe('parse-redis-info.util (Twenty parse-redis-memory-info.util.ts)', () => {
  it('reads used_memory and maxmemory as integers, line-anchored', () => {
    expect(parseRedisMemoryInfo(INFO_MEMORY)).toEqual({ usedMemoryBytes: 1_048_576, maxMemoryBytes: 67_108_864 });
  });
  it('undefined when either field is missing (never a guessed number)', () => {
    expect(parseRedisMemoryInfo('# Memory\r\nused_memory:1024\r\n')).toBeUndefined();
    expect(parseRedisMemoryInfo('maxmemory:0\r\n')).toBeUndefined();
  });
  it('does not confuse used_memory with used_memory_human / used_memory_peak', () => {
    expect(parseRedisMemoryInfo('used_memory_peak:99\r\nused_memory_human:1.00M\r\nused_memory:5\r\nmaxmemory:0\r\n')).toEqual({ usedMemoryBytes: 5, maxMemoryBytes: 0 });
  });
  it('a token field only matches a short allowlisted value (a path never passes)', () => {
    expect(readRedisInfoToken(INFO_SERVER, 'redis_version')).toBe('7.2.4');
    expect(readRedisInfoToken(INFO_SERVER, 'executable')).toBeUndefined();
  });
  it('formats bytes in binary units', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1_048_576)).toBe('1.0 MB');
    expect(formatBytes(67_108_864)).toBe('64.0 MB');
  });
});

describe('api indicator (Twenty app.health.ts)', () => {
  it('healthy; version, short commit, Node version and uptime; an unexpected version string is not echoed', () => {
    const card = apiIndicator({ version: '2.4.0', commit: 'abcdef1234567890abcdef', nodeVersion: 'v24.1.0', uptimeSeconds: 3_725 });
    expect(card).toMatchObject({ key: 'api', status: 'healthy', detail: 'Version 2.4.0 · Node v24.1.0 · up 1 h 2 min' });
    expect(card.facts).toContainEqual({ label: 'Commit', value: 'abcdef123456' });
    expect(apiIndicator({ version: '<script>', commit: null, nodeVersion: 'v24', uptimeSeconds: 1 }).detail).toContain('Version unknown');
    expect(formatUptime(90_000)).toBe('1 d 1 h');
  });
});

describe('database indicator (Twenty database.health.ts)', () => {
  it('connections vs max_connections from ONE read-only statistics SELECT', async () => {
    const query = jest.fn().mockResolvedValue([{ connections: 12, max_connections: '100', superuser_reserved_connections: 3, reserved_connections: '0', server_version_num: '160004' }]);
    const card = await databaseIndicator({ query, driver: {} } as unknown as DataSource);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(DATABASE_INDICATOR_SQL);
    expect(DATABASE_INDICATOR_SQL).toMatch(/^SELECT\b/);
    expect(DATABASE_INDICATOR_SQL).not.toMatch(/\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|GRANT|SET\s)/i);
    expect(card.status).toBe('healthy');
    // Utilisation against the slots an ordinary role can use: 100 − 3 superuser-reserved − 0 reserved = 97.
    expect(card.detail).toMatch(/^PostgreSQL 16 · \d+ ms · 12 of 97 usable connections \(12%\)$/);
    expect(card.facts).toEqual(
      expect.arrayContaining([
        { label: 'Connections', value: '12 of 97 usable (12%)' },
        { label: 'max_connections', value: '100' },
        { label: 'Reserved slots', value: '3 superuser · 0 reserved' },
      ]),
    );
  });
  it('PostgreSQL 16 reserved_connections are taken out of the usable slots too', async () => {
    const query = jest.fn().mockResolvedValue([{ connections: 45, max_connections: 100, superuser_reserved_connections: 3, reserved_connections: 7, server_version_num: 160004 }]);
    const card = await databaseIndicator({ query, driver: {} } as unknown as DataSource);
    expect(card.facts).toContainEqual({ label: 'Connections', value: '45 of 90 usable (50%)' });
  });
  it('an unexpected row throws (the probe wrapper turns it into a fixed "unavailable" card)', async () => {
    await expect(databaseIndicator({ query: jest.fn().mockResolvedValue([{}]), driver: {} } as unknown as DataSource)).rejects.toThrow();
  });
});

describe('redis indicator (Twenty redis.health.ts + parse-redis-memory-info)', () => {
  it('version and memory from INFO server + INFO memory only', async () => {
    const { client, calls } = fakeRedis({ info: { server: INFO_SERVER, memory: INFO_MEMORY } });
    const card = await redisIndicator(client, true);
    expect(calls.sort()).toEqual(['info memory', 'info server']);
    expect(card.status).toBe('healthy');
    expect(card.detail).toMatch(/^Redis 7\.2\.4 · 1\.0 MB of 64\.0 MB \(2%\) · \d+ ms$/);
    expect(card.facts).toEqual(expect.arrayContaining([{ label: 'Eviction policy', value: 'noeviction' }, { label: 'Peak memory', value: '2.0 MB' }]));
    expect(JSON.stringify(card)).not.toMatch(/planted/);
  });
  it('INFO memory without used_memory/maxmemory: warning "memory not reported", version kept (Redis answered: never "Not reachable")', async () => {
    const { client } = fakeRedis({ info: { server: INFO_SERVER, memory: '# Memory\r\nused_memory_human:1.00M\r\n' } });
    const card = await redisIndicator(client, true);
    expect(card.status).toBe('warning');
    expect(card.detail).toMatch(/^Redis 7\.2\.4 · memory not reported · \d+ ms$/);
    expect(card.facts).toContainEqual({ label: 'Version', value: '7.2.4' });
  });
  it('no maxmemory limit is said in words; no password keeps the existing warning', async () => {
    const { client } = fakeRedis({ info: { server: INFO_SERVER, memory: 'used_memory:2048\r\nmaxmemory:0\r\n' } });
    const card = await redisIndicator(client, false);
    expect(card.status).toBe('warning');
    expect(card.detail).toContain('2.0 KB · no maxmemory limit');
    expect(card.detail).toContain('no password set');
  });
});

describe('worker indicator (Twenty worker.health.ts)', () => {
  const queues = [
    { name: 'rab-email', prefix: 'bull' },
    { name: 'crewflow-scan-offers', prefix: 'crewflow:test:bull' },
  ];
  const data = {
    strings: { 'rab:worker:heartbeat': String(1_000_000 - 4_000) },
    lists: { 'bull:rab-email:wait': 3, 'bull:rab-email:paused': 1, 'bull:rab-email:active': 2, 'crewflow:test:bull:crewflow-scan-offers:wait': 1 },
    zsets: { 'bull:rab-email:prioritized': 1, 'bull:rab-email:delayed': 4, 'bull:rab-email:failed': 7, 'crewflow:test:bull:crewflow-scan-offers:failed': 2 },
  };
  it('heartbeat + per-queue failed / waiting (wait + paused, as BullMQ) / prioritized / active / delayed, read with LLEN/ZCARD/GET only', async () => {
    const { client, calls } = fakeRedis(data);
    const card = await workerIndicator(client, { heartbeatKey: 'rab:worker:heartbeat', heartbeatTtlSeconds: 30, queues, nowMs: () => 1_000_000 });
    expect(card).toMatchObject({ key: 'worker', status: 'healthy', detail: 'Heartbeat 4 s ago · 9 failed · 5 waiting across 2 queues' });
    expect(card.facts).toEqual([
      { label: 'Heartbeat', value: '4 s ago' },
      { label: 'rab-email', value: '7 failed · 4 waiting · 1 prioritized · 2 active · 4 delayed' },
      { label: 'crewflow-scan-offers', value: '2 failed · 1 waiting · 0 prioritized · 0 active · 0 delayed' },
    ]);
    expect(new Set(calls.map((c) => c.split(' ')[0]))).toEqual(new Set(['get', 'llen', 'zcard']));
  });
  it('stale heartbeat = degraded, missing heartbeat = unavailable (existing rule); counts never change the status', async () => {
    const stale = await workerIndicator(fakeRedis(data).client, { heartbeatKey: 'rab:worker:heartbeat', heartbeatTtlSeconds: 3, queues, nowMs: () => 1_000_000 });
    expect(stale.status).toBe('degraded');
    const none = await workerIndicator(fakeRedis({}).client, { heartbeatKey: 'rab:worker:heartbeat', heartbeatTtlSeconds: 30, queues, nowMs: () => 1_000_000 });
    expect(none).toMatchObject({ status: 'unavailable', detail: 'No worker heartbeat seen. · 0 failed · 0 waiting across 2 queues' });
    expect(heartbeatAgeSeconds('not-a-number', 1)).toBeNull();
  });
});

describe('scheduler indicator (BullMQ getJobSchedulersCount = ZCARD <prefix>:<queue>:repeat)', () => {
  const scanQueues = ['crewflow-scan-a', 'crewflow-scan-b'];
  const base = { statusKey: 'rab:worker:scheduler', fallbackPrefix: 'crewflow:test:bull', scanQueues, nowMs: () => 1_000_000 };
  const zsets = { 'crewflow:prod:bull:crewflow-scan-a:repeat': 3, 'crewflow:prod:bull:crewflow-scan-b:repeat': 2 };

  it('interval mode with no bullmq report: healthy, count shown', async () => {
    const { client, calls } = fakeRedis({});
    const card = await schedulerIndicator(client, { ...base, configuredMode: 'interval' });
    expect(card).toMatchObject({ key: 'scheduler', status: 'healthy', detail: 'Interval mode: scans run on Worker timers · 0 BullMQ schedulers in Redis' });
    expect(calls).toEqual(['hgetall rab:worker:scheduler', 'zcard crewflow:test:bull:crewflow-scan-a:repeat', 'zcard crewflow:test:bull:crewflow-scan-b:repeat']);
  });
  it('bullmq: counts under the reported prefix and matches the last report → healthy', async () => {
    const { client } = fakeRedis({ zsets, hashes: { 'rab:worker:scheduler': { mode: 'bullmq', prefix: 'crewflow:prod:bull', schedulers: '5', missing: '0', reconciledAt: String(1_000_000 - 20_000), registration: 'api' } } });
    const card = await schedulerIndicator(client, { ...base, configuredMode: 'bullmq' });
    expect(card).toMatchObject({ status: 'healthy', detail: '5 BullMQ schedulers · last report 20 s ago' });
    expect(card.facts).toEqual(expect.arrayContaining([{ label: 'crewflow-scan-a', value: '3 schedulers' }, { label: 'Expected (last report)', value: '5' }, { label: 'Last report', value: '20 s ago · registered by the API' }]));
  });
  it('bullmq: fewer schedulers than reported, or a reported missing one → degraded', async () => {
    const fewer = await schedulerIndicator(fakeRedis({ zsets, hashes: { 'rab:worker:scheduler': { mode: 'bullmq', prefix: 'crewflow:prod:bull', schedulers: '7', missing: '0' } } }).client, { ...base, configuredMode: 'bullmq' });
    expect(fewer).toMatchObject({ status: 'degraded', detail: '5 of 7 BullMQ schedulers in Redis: some scans are not being triggered.' });
    const missing = await schedulerIndicator(fakeRedis({ zsets, hashes: { 'rab:worker:scheduler': { mode: 'bullmq', prefix: 'crewflow:prod:bull', schedulers: '5', missing: '1' } } }).client, { ...base, configuredMode: 'bullmq' });
    expect(missing.status).toBe('degraded');
  });
  it('bullmq: zero schedulers in Redis → degraded (Redis lost its schedules); no recent report but schedulers present → warning', async () => {
    const lost = await schedulerIndicator(fakeRedis({}).client, { ...base, configuredMode: 'bullmq' });
    expect(lost).toMatchObject({ status: 'degraded', detail: 'No BullMQ schedulers in Redis: scans are not being triggered.' });
    const unreported = await schedulerIndicator(fakeRedis({ zsets: { 'crewflow:test:bull:crewflow-scan-a:repeat': 2 } }).client, { ...base, configuredMode: 'bullmq' });
    expect(unreported).toMatchObject({ status: 'warning', detail: '2 BullMQ schedulers in Redis · no recent reconcile report from a Worker' });
  });
  it('a malformed report prefix is ignored (falls back to the API prefix, never builds a key from it)', async () => {
    const { client, calls } = fakeRedis({ hashes: { 'rab:worker:scheduler': { mode: 'bullmq', prefix: 'bad prefix*', schedulers: '5' } } });
    await schedulerIndicator(client, { ...base, configuredMode: 'interval' });
    expect(calls.some((c) => c.includes('bad prefix'))).toBe(false);
  });
});
