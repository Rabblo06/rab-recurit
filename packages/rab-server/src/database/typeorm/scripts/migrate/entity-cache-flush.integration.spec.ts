/**
 * Phase B (P7) `cache:flush` against a REAL Redis (TEST_REDIS_URL / REDIS_URL; a disposable test container). Proves the
 * flush makes every entity-cache entry unreachable through the cache's own key scheme, and that every key outside the
 * allow-listed `entitycache` namespace (sessions, auth context, limiters, MFA/step-up, AI budget and cancel flags,
 * realtime, BullMQ, and the entity cache of ANOTHER environment) survives byte-for-byte with its TTL.
 *
 * Keys are written under a unique per-run environment name, so the test never reads or changes anything it did not write.
 */
import { randomBytes } from 'node:crypto';

import Redis from 'ioredis';

import { flushEntityCache } from './entity-cache-flush';

const REDIS_URL = process.env.TEST_REDIS_URL ?? process.env.REDIS_URL;
const describeIfRedis = REDIS_URL ? describe : describe.skip;
jest.setTimeout(30_000);

describeIfRedis('flushEntityCache (real Redis)', () => {
  const env = `a5flush${randomBytes(4).toString('hex')}`;
  const otherEnv = `${env}other`;
  let redis: Redis;
  const p = (rest: string, e = env) => `crewflow:${e}:${rest}`;

  // Every family that must survive, as the services name them.
  const survivors: Record<string, string> = {
    [p('authctx:org1:sidhash:ws1:1.2.3.4.5.6')]: 'hmac-bound-ctx',
    [p('usersession:hash1')]: 'session',
    [p('login-rate:email:digest')]: '3',
    [p('invite-rate:org:digest')]: '2',
    [p('clock-rate:user:digest')]: '1',
    [p('mfa-challenge:tokenhash')]: 'challenge',
    [p('step-up:sidhash')]: 'stepup',
    [p('ai:cost:org1:user:abc:20261029')]: '1200',
    [p('ai:conv:c1:cancel')]: '1',
    [p('ai:budget:org1')]: '5000',
    [p('rt:user:u1')]: 'rt',
    [p('bull:queue:id')]: 'job',
    [p('cache-invalidation:v1')]: 'x',
    [p('entitycache:user:u9:epoch', otherEnv)]: '4',
    [p('entitycache:user:u9:v4', otherEnv)]: '{"other":true}',
  };

  beforeAll(async () => {
    redis = new Redis(REDIS_URL as string, { lazyConnect: true, maxRetriesPerRequest: 1 });
    await redis.connect();
  });

  afterAll(async () => {
    for (const e of [env, otherEnv]) {
      let cursor = '0';
      do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', `crewflow:${e}:*`, 'COUNT', 500);
        cursor = next;
        if (keys.length) await redis.del(...keys);
      } while (cursor !== '0');
    }
    redis.disconnect();
  });

  it('bumps every entity epoch (existing or implicit 0), deletes nothing, and leaves every other key and TTL intact', async () => {
    // Entity cache as CoreEntityCacheService writes it: an invalidated entity (epoch 2), a never-invalidated one (data at v0,
    // no epoch key), a host label whose id contains ':', and a global epoch only.
    await redis.set(p('entitycache:user:u1:epoch'), '2');
    await redis.set(p('entitycache:user:u1:v2'), '{"firstName":"A"}', 'EX', 300);
    await redis.set(p('entitycache:organisation:o1:v0'), '{"name":"Org"}', 'EX', 300);
    await redis.set(p('entitycache:workspace_host_label:7:acme:v0'), '{"ws":"w1"}', 'EX', 300);
    await redis.set(p('entitycache:workspace_host_map:global:epoch'), '7');
    await redis.set(p('entitycache:user:weird'), 'not an entity-cache shape');
    for (const [k, v] of Object.entries(survivors)) await redis.set(k, v, 'EX', 900);
    const ttlBefore = Object.fromEntries(await Promise.all(Object.keys(survivors).map(async (k) => [k, await redis.ttl(k)] as const)));

    const result = await flushEntityCache(redis, env, 2); // tiny COUNT: several SCAN pages

    expect(result).toEqual({ scannedKeys: 6, bumpedEntities: 4, ignoredKeys: 1 });
    // The cache's own read path now resolves to keys that do not exist: every old entry is unreachable.
    expect(await redis.get(p('entitycache:user:u1:epoch'))).toBe('3');
    expect(await redis.exists(p('entitycache:user:u1:v3'))).toBe(0);
    expect(await redis.get(p('entitycache:organisation:o1:epoch'))).toBe('1');
    expect(await redis.get(p('entitycache:workspace_host_label:7:acme:epoch'))).toBe('1');
    expect(await redis.get(p('entitycache:workspace_host_map:global:epoch'))).toBe('8');
    // Nothing deleted: the old data keys are still there, just unreachable, and expire on their TTL.
    expect(await redis.get(p('entitycache:user:u1:v2'))).toBe('{"firstName":"A"}');
    expect(await redis.get(p('entitycache:organisation:o1:v0'))).toBe('{"name":"Org"}');
    expect(await redis.get(p('entitycache:user:weird'))).toBe('not an entity-cache shape');
    // Every non-allow-listed key survives with its value, and its TTL was not reset or removed.
    for (const [k, v] of Object.entries(survivors)) {
      expect(await redis.get(k)).toBe(v);
      const ttl = await redis.ttl(k);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(ttlBefore[k]);
    }
    // A second flush bumps again (idempotent in effect, never destructive).
    expect((await flushEntityCache(redis, env)).bumpedEntities).toBe(4);
    expect(await redis.get(p('entitycache:user:u1:epoch'))).toBe('4');
  });
});
