/**
 * Phase B (P7) `cache:flush`: makes every entry of the core entity cache unreachable, and touches nothing else in Redis.
 *
 * The entity cache (engine/core-modules/entity-cache/core-entity-cache.service.ts) keys every entry by a per-entity epoch:
 *   crewflow:{env}:entitycache:{kind}:{id}:epoch     INCR counter (absent = epoch 0)
 *   crewflow:{env}:entitycache:{kind}:{id}:v{epoch}  data, TTL <= 300 s
 * and its own invalidate() is exactly one INCR of the epoch key. This flush does that same INCR for every {kind}:{id} that
 * has an epoch key or a data key (a data key with no epoch key is epoch 0, so its INCR creates the counter at 1), found by
 * SCAN over the one allow-listed prefix. It deletes nothing and never reads a value: an old data key just becomes
 * unreachable and expires on its TTL, the same race-free mechanism the service relies on (a reader that fills under the old
 * epoch after the bump writes to a key nobody reads). In-process L1 copies of epochs expire within METADATA_L1_CACHE_TTL_MS
 * (<= 5 s).
 *
 * ALLOW-LIST: the `entitycache` namespace only. Never matched, so never touched: authctx, usersession, login-rate,
 * invite-rate, clock limiters, mfa-challenge, step-up, ai:* (budgets, cost meters, cancel flags, streams), rt:* (realtime),
 * cache-invalidation, BullMQ, and every key of another NODE_ENV. A key under the prefix that does not have the exact
 * `...:epoch` / `...:v<digits>` shape is counted and left alone.
 */
import type Redis from 'ioredis';

export const FLUSHABLE_CACHE_NAMESPACES = ['entitycache'] as const;
export type FlushableCacheNamespace = (typeof FLUSHABLE_CACHE_NAMESPACES)[number];

export class CacheFlushError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CacheFlushError';
  }
}

export function assertFlushableNamespace(value: string): FlushableCacheNamespace {
  if (!(FLUSHABLE_CACHE_NAMESPACES as readonly string[]).includes(value)) {
    throw new CacheFlushError(`cache namespace "${value}" is not flushable. Allowed: ${FLUSHABLE_CACHE_NAMESPACES.join(', ')}.`);
  }
  return value as FlushableCacheNamespace;
}

/** NODE_ENV is part of every key; it must be a plain name so it can never act as a SCAN glob. */
export function assertCacheEnvName(value: string | undefined): string {
  if (!value || !/^[a-z][a-z0-9_-]{0,31}$/.test(value)) {
    throw new CacheFlushError('NODE_ENV must be set to a plain lower-case name (it prefixes every cache key). Refusing.');
  }
  return value;
}

export function entityCachePrefix(envName: string): string {
  return `crewflow:${assertCacheEnvName(envName)}:entitycache:`;
}

/** The `crewflow:{env}:entitycache:{kind}:{id}` base of an entity-cache key, or null when the key is not one. Pure. */
export function entityCacheBaseOf(key: string, envName: string): string | null {
  const prefix = entityCachePrefix(envName);
  if (!key.startsWith(prefix)) return null;
  const match = /^(.+):(?:epoch|v\d+)$/.exec(key.slice(prefix.length));
  // {kind}:{id} — both non-empty (an id may itself contain ':', e.g. workspace_host_label's `<map epoch>:<label>`).
  if (!match || !/^[a-z_]+:.+$/.test(match[1])) return null;
  return `${prefix}${match[1]}`;
}

export interface EntityCacheFlushResult {
  scannedKeys: number;
  bumpedEntities: number;
  ignoredKeys: number;
}

export async function flushEntityCache(redis: Redis, envName: string, scanCount = 500): Promise<EntityCacheFlushResult> {
  const prefix = entityCachePrefix(envName);
  const bases = new Set<string>();
  let scannedKeys = 0;
  let ignoredKeys = 0;
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', scanCount);
    cursor = next;
    for (const key of keys) {
      scannedKeys += 1;
      const base = entityCacheBaseOf(key, envName);
      if (base) bases.add(base);
      else ignoredKeys += 1;
    }
  } while (cursor !== '0');

  const all = [...bases];
  for (let i = 0; i < all.length; i += 500) {
    const pipeline = redis.pipeline();
    for (const base of all.slice(i, i + 500)) pipeline.incr(`${base}:epoch`);
    const results = (await pipeline.exec()) ?? [];
    const failed = results.filter(([error]) => error);
    if (failed.length) throw new CacheFlushError(`${failed.length} epoch bump(s) failed; the entity cache may still serve entries for up to 300 s.`);
  }
  return { scannedKeys, bumpedEntities: all.length, ignoredKeys };
}
