import { createHash } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

import type { AuthSecuritySnapshot } from '../../tenant/auth-context.interface';
import { EnvironmentService } from '../../environment/environment.service';
import type { SecurityVersionVector } from './security-version.service';
import { AuthCacheRedisClientProvider } from './auth-cache-redis-client.provider';

/**
 * P1E — the version-keyed Redis cache for `AuthSecuritySnapshotService.build()`'s own result.
 * PostgreSQL remains the sole authority; this is a read-through accelerator, gated behind
 * `AUTH_CONTEXT_CACHE_ENABLED` (default false — every call here is a guaranteed no-op miss when
 * the flag is off, see `isEnabled()`).
 *
 * THE CENTRAL DESIGN DECISION — the version vector is part of the cache KEY, never a field
 * compared after a GET:
 *
 *   key = crewflow:{env}:authctx:{org}:{sha256(sid)}:{workspaceId}:{sessionV}.{userV}.{roleV}.{membershipV}.{adminV}.{orgV}
 *
 * A security-relevant mutation (revoke, role-permission edit, membership suspend, platform-admin
 * grant/revoke, org config change — see P1D's `SecurityVersionVectors1786683000000`) bumps one of
 * those six numbers in the SAME transaction as the mutation. The OLD key is never explicitly
 * deleted and never needs to be — a request made after that mutation commits reads the CURRENT
 * version vector fresh (via `SecurityVersionService.readVector`, itself one cheap query, called
 * BEFORE any cache lookup) and therefore looks up a DIFFERENT key than the stale entry occupies.
 * The stale entry simply becomes unreachable; a bounded TTL reclaims it eventually, but nothing
 * about correctness depends on that TTL or on any explicit invalidation step firing. This is what
 * closes every race in the owner's own brief (§4.5) by construction rather than by careful
 * ordering of a delete-then-read:
 *   - Race A (revoke vs. cache-fill): the stale fill lands under the PRE-revoke version key; the
 *     next real request reads the POST-revoke version and looks up a different key — miss,
 *     rebuilt from Postgres. The stale entry is never read by anyone again.
 *   - Race B (permission change across replicas): identical reasoning — whichever version was
 *     current at read time is baked into the key that read used.
 *   - Race D (crash between commit and an explicit delete): there IS no explicit delete step to
 *     crash before — correctness never depends on one running.
 *   - Race E (a stale key reintroduced after the version moved): unreachable by any lookup that
 *     reads the version fresh first, which every real call site does.
 * Race C (Redis outage) is handled entirely by `AuthCacheRedisClientProvider`'s own bounded
 * timeouts plus this service's own try/catch: any failure here is just a miss, never an exception
 * that could fail the request.
 *
 * Caches only the minimum needed to reconstruct `AuthSecuritySnapshot` — never a raw cookie,
 * refresh token, password hash, provider token, MFA secret or any payroll/identity field outside
 * this snapshot's own already-narrow shape.
 */
export interface CachedSnapshotData {
  accountStatus: AuthSecuritySnapshot['accountStatus'];
  mustResetPassword: boolean;
  roles: string[];
  isPlatformAdmin: boolean;
  maintenanceModeEnabled: boolean;
  organisationSuspended: boolean;
  effectivePermissions: string[];
}

const TTL_SECONDS = 900; // bounded hygiene backstop only — see this file's own doc comment; correctness never depends on it.

@Injectable()
export class AuthContextCacheService {
  private readonly logger = new Logger(AuthContextCacheService.name);

  constructor(
    private readonly env: EnvironmentService,
    private readonly redis: AuthCacheRedisClientProvider,
  ) {}

  isEnabled(): boolean {
    return this.env.get('AUTH_CONTEXT_CACHE_ENABLED');
  }

  buildKey(params: { sid: string; organisationId: string; workspaceId: string | null; versions: SecurityVersionVector }): string {
    const env = this.env.get('NODE_ENV');
    const sidHash = createHash('sha256').update(params.sid).digest('hex');
    const v = params.versions;
    const versionPart = [
      v.sessionVersion ?? 'x',
      v.userVersion ?? 'x',
      v.rolePermissionVersion,
      v.workspaceMembershipVersion ?? 'x',
      v.platformAdminVersion,
      v.organisationVersion ?? 'x',
    ].join('.');
    return `crewflow:${env}:authctx:${params.organisationId}:${sidHash}:${params.workspaceId ?? 'none'}:${versionPart}`;
  }

  /** Never throws — any Redis failure (timeout, disconnect, malformed payload) is treated as a plain miss. */
  async get(key: string): Promise<CachedSnapshotData | null> {
    if (!this.isEnabled()) return null;
    try {
      const raw = await this.redis.client.get(key);
      if (!raw) return null;
      return JSON.parse(raw) as CachedSnapshotData;
    } catch (error) {
      this.logger.debug(`auth context cache GET failed, treating as miss: ${(error as Error).message}`);
      return null;
    }
  }

  /** Best-effort — never throws, never delays the response the data is already being returned for. */
  async set(key: string, data: CachedSnapshotData): Promise<void> {
    if (!this.isEnabled()) return;
    try {
      await this.redis.client.set(key, JSON.stringify(data), 'EX', TTL_SECONDS);
    } catch (error) {
      this.logger.debug(`auth context cache SET failed, continuing without caching: ${(error as Error).message}`);
    }
  }
}
