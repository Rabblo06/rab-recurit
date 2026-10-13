import { Injectable, Logger } from '@nestjs/common';

import { EnvironmentService } from '../../environment/environment.service';
import { AuthCacheRedisClientProvider } from './auth-cache-redis-client.provider';

/**
 * Redis checkpoint — Twenty-style Redis-first UserSession cache ("Cache 1"), deliberately SEPARATE
 * from `AuthContextCacheService` ("Cache 2", the P1E AuthSecuritySnapshot cache) — different
 * namespace, different env flag (`USER_SESSION_CACHE_ENABLED`), different Redis key prefix, never
 * merged into one unversioned object. Reuses `AuthCacheRedisClientProvider`'s existing fail-fast
 * client (same Redis deployment, same `REDIS_URL`) — no new Redis client.
 *
 * What this caches: `core.auth_find_session_by_web_token_hash`'s result — the opaque
 * `crewflow_session` cookie's hash resolved to `{sessionId, userId, organisationId,
 * applicationTarget, absoluteExpiresAt}`. This is a PURE IDENTITY lookup, never an authorization
 * decision: the function it shortcuts has never filtered by `revoked_at`/`idle_expires_at` (a
 * revoked session's row still exists and still matches its hash) — the real liveness decision
 * happens entirely in `SessionValidityService.assertActive()`, which runs UNCONDITIONALLY on every
 * request, cache hit or miss, and is never itself cached by this service. A cache HIT here can
 * therefore never let a revoked/idle-expired session authenticate — it only ever saves the ONE
 * Postgres round trip this specific lookup would otherwise cost, not the round trip that actually
 * enforces liveness. This is the concrete answer to "versioned keys alone don't close every
 * revocation race": this cache doesn't rely on versioning OR invalidation for that race at all —
 * it structurally cannot decide revocation either way, because it was never asked to.
 *
 * Never caches: `revoked_at`, `idle_expires_at`, the raw cookie value, any refresh-token material,
 * or a password. `absoluteExpiresAt` is cached because it is set once at session creation and never
 * changes afterward (unlike `idle_expires_at`, bumped on nearly every request) — safe to treat as
 * static for this cache entry's whole life.
 */
export interface CachedSessionProjection {
  sessionId: string;
  userId: string;
  organisationId: string;
  applicationTarget: string;
  /** ISO 8601 — the session's fixed, never-changing absolute deadline. */
  absoluteExpiresAt: string;
}

const MAX_TTL_SECONDS = 60;

@Injectable()
export class UserSessionCacheService {
  private readonly logger = new Logger(UserSessionCacheService.name);

  constructor(
    private readonly env: EnvironmentService,
    private readonly redis: AuthCacheRedisClientProvider,
  ) {}

  isEnabled(): boolean {
    return this.env.get('USER_SESSION_CACHE_ENABLED');
  }

  private buildKey(hash: string): string {
    const envName = this.env.get('NODE_ENV');
    // `hash` is ALREADY a sha256 hex digest of the raw cookie token, computed by the caller before
    // this method is ever reached — the raw token itself never appears in this class, in Redis, or
    // in any log line this class could produce.
    return `crewflow:${envName}:usersession:${hash}`;
  }

  /**
   * Never throws — any Redis failure (timeout, disconnect, malformed payload) is treated as a
   * plain miss, same contract as `AuthContextCacheService.get()`. Also returns a miss (never a
   * stale hit) for an entry whose `absoluteExpiresAt` has passed, even if Redis's own TTL hasn't
   * expired it yet — the hard upper bound this checkpoint requires ("never serve a session after
   * its absolute expiry") enforced here independently of Redis's own clock.
   */
  async get(hash: string): Promise<CachedSessionProjection | null> {
    if (!this.isEnabled()) return null;
    try {
      const raw = await this.redis.client.get(this.buildKey(hash));
      if (!raw) return null;
      const data = JSON.parse(raw) as CachedSessionProjection;
      if (new Date(data.absoluteExpiresAt).getTime() <= Date.now()) return null;
      return data;
    } catch (error) {
      this.logger.debug(`user session cache GET failed, treating as miss: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * Best-effort — never throws, never delays the response already being served. TTL is
   * `min(60s, time remaining until absoluteExpiresAt)` — the explicit dual bound this checkpoint
   * requires. A session already past its absolute deadline, or one expiring in under a second, is
   * not cached at all (nothing meaningful to save).
   */
  async set(hash: string, data: CachedSessionProjection): Promise<void> {
    if (!this.isEnabled()) return;
    const msUntilExpiry = new Date(data.absoluteExpiresAt).getTime() - Date.now();
    if (msUntilExpiry <= 0) return;
    const ttlSeconds = Math.min(MAX_TTL_SECONDS, Math.floor(msUntilExpiry / 1000));
    if (ttlSeconds <= 0) return;
    try {
      await this.redis.client.set(this.buildKey(hash), JSON.stringify(data), 'EX', ttlSeconds);
    } catch (error) {
      this.logger.debug(`user session cache SET failed, continuing without caching: ${(error as Error).message}`);
    }
  }
}
