import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';

import { AuthCacheRedisClientProvider } from '../auth/services/auth-cache-redis-client.provider';
import { EnvironmentService } from '../environment/environment.service';
import { BoundedLruCache, LruStats, LruTicket } from './bounded-lru-cache';

/**
 * Wave 5 lane OPS — the in-process L1 in front of the EXISTING Redis epoch caches, for NON-AUTHORISATION metadata only.
 *
 * WHAT MAY ENTER (closed list, `L1_CACHEABLE_KINDS`):
 *  - `workspace_schema_resolution` — workspace id -> physical schema name/version (`SchemaResolverService`, READY rows
 *    only; every failure path is never cached, exactly as in L2);
 *  - `workspace_host_label` / `workspace_host_map` — host label -> routable workspace (wave 3 lane H; routing context,
 *    never authorisation — the wrong-host check can only REFUSE);
 *  - `permission_catalogue` — the static, global `core.permission` flag list (no organisation dimension, changes only
 *    by migration).
 *
 * WHAT NEVER ENTERS: sessions, auth contexts, security versions, per-user / per-role permissions, platform-admin status,
 * membership, account status, organisation suspension state. Those stay on their own Redis caches (version-vector keyed,
 * PostgreSQL-authoritative per request) with no local layer, so a revocation is visible on the very next request. The
 * type of `get`/`set` makes adding a kind a deliberate, reviewed change to `L1_CACHEABLE_KINDS`.
 *
 * FRESHNESS:
 *  - TTL 1–5 s (`METADATA_L1_CACHE_TTL_MS`, default 2000): the worst case for any change nobody invalidated explicitly.
 *  - Explicit invalidation (`CoreEntityCacheService.invalidate`) drops the local entry at once and PUBLISHes on
 *    `crewflow:<env>:cache-invalidation:v1` (the same Redis deployment and the same pub/sub mechanism the realtime
 *    gateway uses), so every other API/worker process drops it within one pub/sub delivery.
 *  - The L1 serves ONLY while this process holds a live SUBSCRIBE on that channel. Before the subscription is confirmed,
 *    after the connection drops, and until it is re-established, `get` always misses and `set` stores nothing — and the
 *    whole L1 is cleared on every (re)subscribe, because invalidations published while we were deaf were lost. So when
 *    Redis is down the behaviour is exactly the pre-L1 behaviour (L2 read fails -> PostgreSQL), never "L1 serving
 *    unverified data indefinitely".
 *  - Fill-after-invalidate race: closed by the ticket fence in `BoundedLruCache`.
 *
 * Messages carry only a kind and an id (UUIDs / host labels — never a name, email, token or row content). A forged
 * message on the channel (anyone with Redis write access) can only cause an extra miss, never serve a value.
 */
export const L1_CACHEABLE_KINDS = ['workspace_schema_resolution', 'workspace_host_label', 'workspace_host_map', 'permission_catalogue'] as const;
export type L1CacheableKind = (typeof L1_CACHEABLE_KINDS)[number];

const CACHEABLE = new Set<string>(L1_CACHEABLE_KINDS);
const MAX_ID_LENGTH = 300;
const MAX_ENTRY_BYTES = 64 * 1024;

/** Invalidating a kind on the left also drops every entry of the kinds on the right (a global epoch folded into their keys). */
const DEPENDENT_GROUPS: Readonly<Record<string, readonly L1CacheableKind[]>> = {
  workspace_host_map: ['workspace_host_label', 'workspace_host_map'],
};

interface InvalidationMessage {
  v: 1;
  k: L1CacheableKind;
  id: string;
  /** Publishing instance — informational only (a process also applies its own messages; that is idempotent). */
  o: string;
}

export function isL1CacheableKind(kind: string): kind is L1CacheableKind {
  return CACHEABLE.has(kind);
}

export interface MetadataL1Stats extends LruStats {
  enabled: boolean;
  live: boolean;
  ttlMs: number;
  maxEntries: number;
  maxBytes: number;
  invalidationsPublished: number;
  invalidationsReceived: number;
  invalidationPublishFailures: number;
  malformedMessages: number;
  resubscribeClears: number;
}

@Injectable()
export class MetadataL1CacheService implements OnModuleDestroy {
  private readonly logger = new Logger(MetadataL1CacheService.name);
  readonly instanceId = randomUUID();
  private readonly enabled: boolean;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly channel: string;
  private readonly cache: BoundedLruCache;
  private subscriber: Redis | null = null;
  private live = false;
  private closed = false;
  private readonly busCounters = {
    invalidationsPublished: 0,
    invalidationsReceived: 0,
    invalidationPublishFailures: 0,
    malformedMessages: 0,
    resubscribeClears: 0,
  };

  constructor(
    private readonly env: EnvironmentService,
    private readonly redis: AuthCacheRedisClientProvider,
  ) {
    this.enabled = env.get('METADATA_L1_CACHE_ENABLED') === true;
    this.ttlMs = env.get('METADATA_L1_CACHE_TTL_MS');
    this.maxEntries = env.get('METADATA_L1_CACHE_MAX_ENTRIES');
    this.maxBytes = env.get('METADATA_L1_CACHE_MAX_BYTES');
    this.channel = `crewflow:${env.get('NODE_ENV')}:cache-invalidation:v1`;
    this.cache = new BoundedLruCache({ maxEntries: this.maxEntries, maxBytes: this.maxBytes, maxEntryBytes: MAX_ENTRY_BYTES });
    if (this.enabled) this.startSubscriber();
  }

  /** The pub/sub channel name (tests and the ops report read it; it carries no secret). */
  get invalidationChannel(): string {
    return this.channel;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** True only while the invalidation subscription is confirmed. The L1 never serves otherwise. */
  isLive(): boolean {
    return this.enabled && this.live && !this.closed;
  }

  get<T>(kind: L1CacheableKind, id: string): T | undefined {
    if (!this.isLive() || !isL1CacheableKind(kind)) return undefined;
    return this.cache.get(this.key(kind, id)) as T | undefined;
  }

  /** Take BEFORE the slow read; pass to `set`. Null when the L1 is off or not live (then `set` is a no-op). */
  ticket(kind: L1CacheableKind, id: string): LruTicket | null {
    if (!this.isLive() || !isL1CacheableKind(kind)) return null;
    return this.cache.ticket(this.key(kind, id), kind);
  }

  set<T>(ticket: LruTicket | null, value: T, maxTtlMs?: number): void {
    if (!ticket || !this.isLive()) return;
    const ttl = Math.min(this.ttlMs, maxTtlMs ?? this.ttlMs);
    // Shared by every later caller in this process: frozen so no caller can mutate another's view.
    this.cache.set(ticket, deepFreeze(value), ttl);
  }

  /** Local drop + cross-process publish. Never throws; call after the write committed (and after the L2 epoch INCR). */
  async invalidate(kind: L1CacheableKind, id: string): Promise<void> {
    if (!this.enabled || !isL1CacheableKind(kind)) return;
    this.applyLocal(kind, id);
    const message: InvalidationMessage = { v: 1, k: kind, id: id.slice(0, MAX_ID_LENGTH), o: this.instanceId };
    try {
      await this.redis.client.publish(this.channel, JSON.stringify(message));
      this.busCounters.invalidationsPublished += 1;
    } catch (error) {
      // Peers keep serving their entry for at most ttlMs (≤5 s). Logged, never thrown into the caller's write path.
      this.busCounters.invalidationPublishFailures += 1;
      this.logger.warn(`L1 invalidation publish failed for ${kind} (peers converge within ${this.ttlMs} ms): ${(error as Error).message}`);
    }
  }

  stats(): MetadataL1Stats {
    return {
      enabled: this.enabled,
      live: this.isLive(),
      ttlMs: this.ttlMs,
      maxEntries: this.maxEntries,
      maxBytes: this.maxBytes,
      ...this.cache.stats(),
      ...this.busCounters,
    };
  }

  /** Drops everything (tests, operator tooling). */
  clear(): void {
    this.cache.clear();
  }

  async onModuleDestroy(): Promise<void> {
    this.closed = true;
    this.live = false;
    const sub = this.subscriber;
    this.subscriber = null;
    if (!sub) return;
    try {
      await sub.quit();
    } catch {
      sub.disconnect();
    }
  }

  // ------------------------------------------------------------------------------------------------ internals

  private key(kind: L1CacheableKind, id: string): string {
    return `${kind}\u0000${id}`;
  }

  private applyLocal(kind: L1CacheableKind, id: string): void {
    const dependents = DEPENDENT_GROUPS[kind];
    if (dependents) {
      for (const group of dependents) this.cache.invalidateGroup(group);
      return;
    }
    this.cache.invalidate(this.key(kind, id));
  }

  private startSubscriber(): void {
    // Same construction as RealtimeSubscriber: a duplicated connection (subscriber mode refuses ordinary commands) that
    // queues while connecting instead of failing fast like the hot-path cache client it is cloned from.
    const sub = this.redis.client.duplicate({ enableOfflineQueue: true, commandTimeout: undefined, maxRetriesPerRequest: null });
    this.subscriber = sub;
    sub.on('error', () => undefined);
    const goDeaf = () => {
      if (this.live) this.logger.warn('L1 invalidation subscription lost — L1 disabled until re-subscribed');
      this.live = false;
    };
    sub.on('close', goDeaf);
    sub.on('end', goDeaf);
    sub.on('reconnecting', goDeaf);
    sub.on('message', (channel: string, raw: string) => {
      if (channel === this.channel) this.onMessage(raw);
    });
    // ioredis re-issues SUBSCRIBE itself after a reconnect (autoResubscribe) and then emits 'ready'; we confirm with our
    // own SUBSCRIBE reply so `live` only flips once the server has acknowledged the channel.
    const subscribe = () => {
      if (this.closed) return;
      sub
        .subscribe(this.channel)
        .then(() => {
          if (this.closed) return;
          // Anything published while we were not subscribed is lost: start from empty.
          this.cache.clear();
          this.busCounters.resubscribeClears += 1;
          this.live = true;
        })
        .catch((error: Error) => {
          this.live = false;
          this.logger.debug(`L1 invalidation subscribe failed: ${error.message}`);
        });
    };
    sub.on('ready', subscribe);
  }

  private onMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.busCounters.malformedMessages += 1;
      return;
    }
    const m = parsed as Partial<InvalidationMessage> | null;
    if (!m || m.v !== 1 || typeof m.k !== 'string' || !isL1CacheableKind(m.k) || typeof m.id !== 'string' || m.id.length > MAX_ID_LENGTH) {
      this.busCounters.malformedMessages += 1;
      return;
    }
    this.busCounters.invalidationsReceived += 1;
    this.applyLocal(m.k, m.id);
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
