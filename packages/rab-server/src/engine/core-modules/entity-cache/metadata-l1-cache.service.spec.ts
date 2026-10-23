import { fork } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import Redis from 'ioredis';

import { AuthCacheRedisClientProvider } from '../auth/services/auth-cache-redis-client.provider';
import { EnvironmentService } from '../environment/environment.service';
import { CoreEntityCacheService } from './core-entity-cache.service';
import { MetadataL1CacheService } from './metadata-l1-cache.service';

/**
 * Wave 5 lane OPS — L1 behaviour against a REAL Redis (REDIS_URL / TEST_REDIS_URL; the lane's private container).
 * "Two processes" is proven twice: two service instances with independent Redis connections (exactly what two API
 * replicas are at the protocol level), and a genuinely separate forked Node process publishing / receiving on the
 * same channel.
 */
const REDIS_URL = process.env.TEST_REDIS_URL ?? process.env.REDIS_URL;
const describeIfRedis = REDIS_URL ? describe : describe.skip;
jest.setTimeout(30_000);

function envFor(overrides: Record<string, unknown> = {}): EnvironmentService {
  const values: Record<string, unknown> = {
    NODE_ENV: 'test',
    REDIS_URL,
    METADATA_L1_CACHE_ENABLED: true,
    METADATA_L1_CACHE_TTL_MS: 5000,
    METADATA_L1_CACHE_MAX_ENTRIES: 1000,
    METADATA_L1_CACHE_MAX_BYTES: 8 * 1024 * 1024,
    CORE_ENTITY_CACHE_ENABLED: true,
    ...overrides,
  };
  return { get: (key: string) => values[key] } as unknown as EnvironmentService;
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describeIfRedis('MetadataL1CacheService (real Redis)', () => {
  const cleanups: Array<() => Promise<void>> = [];
  const make = (overrides: Record<string, unknown> = {}) => {
    const env = envFor(overrides);
    const redis = new AuthCacheRedisClientProvider(env);
    const l1 = new MetadataL1CacheService(env, redis);
    cleanups.push(async () => {
      await l1.onModuleDestroy();
      await redis.onModuleDestroy();
    });
    return { env, redis, l1 };
  };

  afterAll(async () => {
    for (const c of cleanups.reverse()) await c();
  });

  it('disabled: never live, never serves, no subscriber', async () => {
    const { l1 } = make({ METADATA_L1_CACHE_ENABLED: false });
    expect(l1.isLive()).toBe(false);
    expect(l1.ticket('workspace_schema_resolution', 'w')).toBeNull();
    l1.set(l1.ticket('workspace_schema_resolution', 'w'), { schemaName: 'x', schemaVersion: 1 });
    expect(l1.get('workspace_schema_resolution', 'w')).toBeUndefined();
  });

  it('an invalidation in one instance drops the entry in another instance (pub/sub), and the local one at once', async () => {
    const a = make();
    const b = make();
    await waitFor(() => a.l1.isLive() && b.l1.isLive());
    for (const svc of [a.l1, b.l1]) svc.set(svc.ticket('workspace_schema_resolution', 'ws-1'), { schemaName: 'workspace_1', schemaVersion: 1 });
    expect(b.l1.get('workspace_schema_resolution', 'ws-1')).toEqual({ schemaName: 'workspace_1', schemaVersion: 1 });

    await a.l1.invalidate('workspace_schema_resolution', 'ws-1');
    expect(a.l1.get('workspace_schema_resolution', 'ws-1')).toBeUndefined(); // local: synchronous
    await waitFor(() => b.l1.get('workspace_schema_resolution', 'ws-1') === undefined, 2000); // peer: one pub/sub hop
    expect(b.l1.stats().invalidationsReceived).toBeGreaterThan(0);
  });

  it('cached values are frozen (a caller cannot mutate another caller\'s view)', async () => {
    const { l1 } = make();
    await waitFor(() => l1.isLive());
    const value = { schemaName: 'workspace_f', schemaVersion: 1 };
    l1.set(l1.ticket('workspace_schema_resolution', 'ws-f'), value);
    const got = l1.get<{ schemaName: string }>('workspace_schema_resolution', 'ws-f')!;
    expect(Object.isFrozen(got)).toBe(true);
    expect(() => {
      (got as { schemaName: string }).schemaName = 'evil';
    }).toThrow();
  });

  it('ignores malformed messages and kinds outside the allowlist (forged message = at most an extra miss)', async () => {
    const { l1 } = make();
    await waitFor(() => l1.isLive());
    l1.set(l1.ticket('permission_catalogue', 'v'), [{ key: 'a' }]);
    const pub = new Redis(REDIS_URL!);
    try {
      await pub.publish(l1.invalidationChannel, 'not json');
      await pub.publish(l1.invalidationChannel, JSON.stringify({ v: 1, k: 'auth_context', id: 'v', o: 'x' }));
      await pub.publish(l1.invalidationChannel, JSON.stringify({ v: 2, k: 'permission_catalogue', id: 'v', o: 'x' }));
      await waitFor(() => l1.stats().malformedMessages >= 3, 2000);
      expect(l1.get('permission_catalogue', 'v')).toEqual([{ key: 'a' }]);
    } finally {
      pub.disconnect();
    }
  });

  it('a genuinely separate process: its publish drops our entry, and our invalidation reaches it', async () => {
    const { l1 } = make();
    await waitFor(() => l1.isLive());
    l1.set(l1.ticket('workspace_host_label', '0:acme'), { r: { kind: 'unknown' } });

    const dir = mkdtempSync(path.join(tmpdir(), 'l1-child-'));
    const script = path.join(dir, 'child.cjs');
    writeFileSync(
      script,
      `const Redis = require(${JSON.stringify(require.resolve('ioredis'))});
       const [url, channel] = process.argv.slice(2);
       const sub = new Redis(url); const pub = new Redis(url);
       sub.on('message', (_c, raw) => { process.send({ got: JSON.parse(raw) }); });
       sub.subscribe(channel).then(() => process.send({ ready: true }));
       process.on('message', async (m) => {
         if (m.publish) { await pub.publish(channel, JSON.stringify(m.publish)); process.send({ published: true }); }
         if (m.exit) { sub.disconnect(); pub.disconnect(); process.exit(0); }
       });`,
    );
    const child = fork(script, [REDIS_URL!, l1.invalidationChannel], { stdio: 'ignore' });
    const messages: Array<Record<string, unknown>> = [];
    child.on('message', (m) => messages.push(m as Record<string, unknown>));
    try {
      await waitFor(() => messages.some((m) => m.ready));
      child.send({ publish: { v: 1, k: 'workspace_host_label', id: '0:acme', o: 'child-process' } });
      await waitFor(() => l1.get('workspace_host_label', '0:acme') === undefined, 3000);

      await l1.invalidate('workspace_schema_resolution', 'ws-from-parent');
      await waitFor(() => messages.some((m) => (m.got as { id?: string } | undefined)?.id === 'ws-from-parent'), 3000);
      const received = messages.find((m) => (m.got as { id?: string } | undefined)?.id === 'ws-from-parent')!.got as Record<string, unknown>;
      expect(received).toEqual({ v: 1, k: 'workspace_schema_resolution', id: 'ws-from-parent', o: l1.instanceId });
    } finally {
      child.send({ exit: true });
    }
  });

  it('losing the subscription disables the L1 until re-subscribed, and re-subscribing clears it (lost messages)', async () => {
    const { l1 } = make();
    await waitFor(() => l1.isLive());
    l1.set(l1.ticket('workspace_schema_resolution', 'ws-k'), { schemaName: 'k', schemaVersion: 1 });
    const clearsBefore = l1.stats().resubscribeClears;
    const admin = new Redis(REDIS_URL!);
    try {
      await admin.client('KILL', 'TYPE', 'pubsub');
      // Deaf: must not serve (an invalidation published now would be lost).
      await waitFor(() => !l1.isLive() || l1.stats().resubscribeClears > clearsBefore, 3000);
      await waitFor(() => l1.isLive() && l1.stats().resubscribeClears > clearsBefore, 10_000);
      expect(l1.get('workspace_schema_resolution', 'ws-k')).toBeUndefined();
    } finally {
      admin.disconnect();
    }
  });

  it('Redis unreachable: never live, so behaviour is exactly the pre-L1 path', async () => {
    const { l1 } = make({ REDIS_URL: 'redis://127.0.0.1:1' });
    await new Promise((r) => setTimeout(r, 300));
    expect(l1.isLive()).toBe(false);
    expect(l1.ticket('workspace_schema_resolution', 'x')).toBeNull();
    await expect(l1.invalidate('workspace_schema_resolution', 'x')).resolves.toBeUndefined(); // never throws
  });
});

describeIfRedis('CoreEntityCacheService + L1 (real Redis)', () => {
  const cleanups: Array<() => Promise<void>> = [];
  const make = (overrides: Record<string, unknown> = {}) => {
    const env = envFor(overrides);
    const redis = new AuthCacheRedisClientProvider(env);
    const l1 = new MetadataL1CacheService(env, redis);
    const cache = new CoreEntityCacheService(env, redis, l1);
    cleanups.push(async () => {
      await l1.onModuleDestroy();
      await redis.onModuleDestroy();
    });
    return { cache, l1, redis };
  };
  afterAll(async () => {
    for (const c of cleanups.reverse()) await c();
  });

  it('an L1 hit costs no Redis round trip and no fetch; invalidate on one replica forces a fresh fetch on the other', async () => {
    const a = make();
    const b = make();
    await waitFor(() => a.l1.isLive() && b.l1.isLive());
    const id = `ws-${Date.now()}`;
    let fetches = 0;
    let value = { schemaName: 'workspace_v1', schemaVersion: 1 };
    const fetch = async () => {
      fetches += 1;
      return value;
    };
    expect(await b.cache.getOrFetch('workspace_schema_resolution', id, fetch, true)).toEqual(value);
    expect(fetches).toBe(1);
    const getSpy = jest.spyOn(b.redis.client, 'get');
    expect(await b.cache.getOrFetch('workspace_schema_resolution', id, fetch, true)).toEqual(value);
    expect(getSpy).not.toHaveBeenCalled(); // served from L1
    getSpy.mockRestore();

    value = { schemaName: 'workspace_v2', schemaVersion: 1 };
    await a.cache.invalidate('workspace_schema_resolution', id, true);
    await waitFor(() => b.l1.get('workspace_schema_resolution', id) === undefined, 2000);
    expect(await b.cache.getOrFetch('workspace_schema_resolution', id, fetch, true)).toEqual(value);
    expect(fetches).toBe(2);
  });

  it('kinds outside the L1 allowlist (user display) never enter the L1', async () => {
    const { cache, l1 } = make();
    await waitFor(() => l1.isLive());
    const before = l1.stats().sets;
    await cache.getOrFetch('user', `u-${Date.now()}`, async () => ({ id: 'u' }), true);
    expect(l1.stats().sets).toBe(before);
  });

  it('with the Redis cache flag OFF for a kind, the L1 is bypassed too (fetch every time)', async () => {
    const { cache, l1 } = make();
    await waitFor(() => l1.isLive());
    let fetches = 0;
    for (let i = 0; i < 3; i++) await cache.getOrFetch('workspace_schema_resolution', 'off', async () => ({ n: ++fetches }), false);
    expect(fetches).toBe(3);
  });

  it('bumping the host map epoch drops every cached host label at once (suspension path)', async () => {
    const { cache, l1 } = make();
    await waitFor(() => l1.isLive());
    const epoch = await cache.currentEpoch('workspace_host_map', 'all', true);
    await cache.getOrFetch('workspace_host_label', `${epoch}:acme`, async () => ({ r: { kind: 'workspace' } }), true);
    expect(l1.get('workspace_host_label', `${epoch}:acme`)).toBeDefined();
    await cache.invalidate('workspace_host_map', 'all', true);
    expect(l1.get('workspace_host_label', `${epoch}:acme`)).toBeUndefined();
    expect(await cache.currentEpoch('workspace_host_map', 'all', true)).not.toBe(epoch);
  });

  it('Redis down: every read falls through to the fetch (PostgreSQL), unchanged', async () => {
    const { cache } = make({ REDIS_URL: 'redis://127.0.0.1:1' });
    let fetches = 0;
    for (let i = 0; i < 3; i++) {
      expect(await cache.getOrFetch('workspace_schema_resolution', 'down', async () => ({ n: ++fetches }), true)).toEqual({ n: i + 1 });
    }
    expect(fetches).toBe(3);
  });
});
