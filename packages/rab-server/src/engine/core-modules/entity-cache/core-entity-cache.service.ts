import { Injectable, Logger, Optional } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { Organisation, User } from '../../../modules/identity/entities';
import { ManagerProfile } from '../../../modules/manager/entities/manager-profile.entity';
import { ManagerWorkspace } from '../../../modules/manager-workspace/entities/manager-workspace.entity';
import { Venue } from '../../../modules/venue/entities/venue.entity';
import { EnvironmentService } from '../environment/environment.service';
import { AuthCacheRedisClientProvider } from '../auth/services/auth-cache-redis-client.provider';
import { isL1CacheableKind, MetadataL1CacheService } from './metadata-l1-cache.service';

/**
 * Redis checkpoint — Core Entity Cache. Twenty CRM's `CoreEntityCacheService` caches metadata-layer
 * objects (field/object definitions) version-keyed per workspace; this is the equivalent idea
 * applied to this codebase's actual repeated-lookup pattern: a handful of DOMAIN rows (user,
 * organisation, manager profile, manager workspace, venue) re-fetched by id, by their OWN id only,
 * from several unrelated call sites, for nothing but a small, low-sensitivity DISPLAY projection.
 *
 * DESIGN — the same version-in-key idea `AuthContextCacheService` already uses (see that file's
 * own doc comment for the full race-closing argument), adapted to not need a Postgres-sourced
 * version column at all:
 *
 *   epoch key:  crewflow:{env}:entitycache:{kind}:{id}:epoch      (a bare Redis INCR counter)
 *   data key:   crewflow:{env}:entitycache:{kind}:{id}:v{epoch}   (the cached projection, TTL'd)
 *
 * A write calls `invalidate(kind, id)`, which does nothing but `INCR` the epoch key. It never
 * deletes the old data key — that entry simply becomes unreachable (every future read computes a
 * NEW data key from the NEW epoch), and the bounded TTL on data keys reclaims it on its own. This
 * is what "prove concurrent cache fills cannot incorrectly restore stale data" means here: a reader
 * that read the OLD epoch before a concurrent writer's `INCR` can only ever write under the OLD
 * epoch's key — which is already unreachable the moment the `INCR` lands, including if the write
 * side effect of the `INCR` happens before, during, or after that reader's own cache-fill. A reader
 * that reads the epoch AFTER a writer's `INCR` is, by construction, reading AFTER that writer's own
 * database COMMIT too (every real invalidation call site in this codebase calls `invalidate()`
 * after its own transaction commits, never before), so a fresh Postgres read taken at that point
 * can only see the new value. See `core-entity-cache.service.spec.ts`'s own concurrency test for an
 * executable proof of this against a real Redis. THIS specific guarantee — a successful `INCR`
 * closes the race immediately, independent of TTL — is unconditional and does not depend on Redis
 * being reliable; it depends only on the `INCR` itself having succeeded.
 *
 * THE ACTUAL FRESHNESS GUARANTEE, stated precisely (cache safety review, Phase 0A) — do not read
 * the paragraph above as "TTL is irrelevant to correctness" in every case, because it is not:
 *
 *   1. Postgres commits the write.
 *   2. `invalidate()` calls `INCR` on the epoch key. If this succeeds (including after this
 *      method's own bounded retry below), the previously-cached entry is unreachable from that
 *      point on, full stop — no further staleness window, regardless of TTL.
 *   3. If `INCR` fails on every attempt (a sustained, write-path-specific Redis failure — see
 *      `invalidate()`'s own doc comment for when this is realistic), the OLD epoch is still what
 *      every read resolves to, and the OLD, now-stale data key is still there to be served. If
 *      Redis is otherwise healthy enough to keep answering `GET`s, a reader gets the stale
 *      projection — not a thrown error, not a forced miss.
 *   4. That stale projection remains servable for up to `DATA_TTL_SECONDS` after the commit, or
 *      until a LATER `invalidate()` call for the same id succeeds, whichever comes first. This is
 *      the one case in this design where TTL is load-bearing for correctness, not just hygiene —
 *      documented here explicitly rather than glossed over.
 *   5. Once Redis recovers, nothing retroactively shortens an already-open staleness window from
 *      a past failed `INCR` — only a NEW `invalidate()` call (from a NEW write) or the TTL closes it.
 *
 * This is why `DATA_TTL_SECONDS` is deliberately short (5 minutes) and why no field in any
 * projection below may be security-, authorization-, or permission-relevant: a 5-minute worst-case
 * staleness window is acceptable for a display name or logo, never for "is this account currently
 * active." `UserDisplayProjection` therefore does NOT include `status` (removed in this review —
 * nothing consumed it, and leaving an unused, un-invalidated status field in a shared cache is
 * exactly the kind of landmine a future caller could step on without realising this guarantee
 * applies). The equivalent, ALREADY-enforced-live check (`ActiveAccountGuard`, via
 * `AuthSecuritySnapshotService`/`SecurityVersionService` — a completely different, version-vector
 * cache that self-invalidates on every status-changing write) is what actually gates account
 * status on every request; nothing here duplicates or competes with it.
 *
 * `getOrFetch` never caches a `null` ("not found") result — only genuinely-present rows, so a
 * row created moments after a failed lookup is never masked by a stale negative cache entry.
 *
 * Cache keys are the bare entity id, with NO organisation/workspace dimension folded in, because
 * every entity cached here has a globally unique UUID primary key that belongs to exactly one
 * organisation/workspace for its entire life (confirmed against each entity's own schema) — there
 * is structurally no id that could resolve to two different tenants' data. The CALLER remains
 * responsible for having already decided it is allowed to look that specific id up at all (exactly
 * the same responsibility the equivalent uncached `findOne` already carried) — this cache is a
 * read-through accelerator for an already-authorized lookup, never a substitute for authorizing one.
 *
 * NEVER caches: password hashes, token material, MFA secrets, encrypted payroll fields, or any
 * column outside the narrow projection interfaces this file declares.
 */

export type EntityCacheKind =
  | 'user'
  | 'organisation'
  | 'manager_profile'
  | 'manager_workspace'
  | 'manager_workspace_by_owner'
  | 'venue'
  // Cache safety review, Phase 0B: WorkspaceMetadataCacheService's own schema-resolution cache now
  // shares this generic epoch mechanism too, rather than its own plain SET/DEL (which had the
  // classic DEL-vs-concurrent-fill race: a reader holding a pre-DEL Postgres snapshot could write a
  // stale value back AFTER the DEL ran, with nothing left to ever clear it before its TTL). Same
  // module, same Redis deployment — this is not a new cache, just the existing one's correctness
  // fix. See WorkspaceMetadataCacheService's own doc comment for the full before/after.
  | 'workspace_schema_resolution'
  // Wave 3 lane H (C13): host label -> routable workspace (WorkspaceHostResolverService). Keyed `<map epoch>:<label>`;
  // `workspace_host_map` is the single global epoch bumped when every label must be dropped at once (organisation
  // suspension/reactivation). Routing context only — never an authorisation input, see that service's doc comment.
  | 'workspace_host_label'
  | 'workspace_host_map'
  // Wave 5 lane OPS: the static, global permission catalogue (`core.permission`, no organisation dimension, rows change
  // only by migration). Keyed by a hash of the code-side flag list, so a deploy that adds a flag reads a new key.
  | 'permission_catalogue';

/** Bounded hygiene backstop only — see this file's own doc comment for why correctness never depends on this TTL. */
const DATA_TTL_SECONDS = 300;

/**
 * Deliberately excludes `status` (cache safety review, Phase 0A/C) — account status is
 * security-relevant (gates login/request access via `ActiveAccountGuard`) and this cache's
 * worst-case staleness window (see this file's own top doc comment) is unsafe for that purpose.
 * The live, version-vector-invalidated path (`AuthSecuritySnapshotService`/`ActiveAccountGuard`)
 * is the only place account status is ever decided from. Do not add it back here without also
 * wiring `invalidate('user', id)` into every status-changing write path AND re-justifying the TTL
 * window against this specific field — see the review's own reasoning before doing either.
 */
export interface UserDisplayProjection {
  id: string;
  organisationId: string;
  firstName: string;
  lastName: string;
  email: string;
  avatarFileId: string | null;
}

export interface OrganisationDisplayProjection {
  id: string;
  name: string;
  slug: string;
  logoFileId: string | null;
  timezone: string;
}

export interface ManagerProfileSummaryProjection {
  id: string;
  userId: string;
  organisationId: string;
  workspaceId: string | null;
  type: string;
}

export interface ManagerWorkspaceDisplayProjection {
  id: string;
  organisationId: string;
  ownerUserId: string;
  name: string;
  subdomain: string;
  logoFileId: string | null;
  status: string;
  /** P2.9C — `core.manager_workspace.schema_status`, invalidated on every write to this row (see this file's own doc comment on why TTL is never load-bearing for correctness here). */
  schemaStatus: string | null;
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601, or null — matches `ManagerWorkspace.onboardingCompletedAt`'s own nullability. */
  onboardingCompletedAt: string | null;
}

export interface VenueSummaryProjection {
  id: string;
  organisationId: string;
  workspaceId: string | null;
  name: string;
}

function toManagerWorkspaceProjection(row: ManagerWorkspace): ManagerWorkspaceDisplayProjection {
  return {
    id: row.id,
    organisationId: row.organisationId,
    ownerUserId: row.ownerUserId,
    name: row.name,
    subdomain: row.subdomain,
    logoFileId: row.logoFileId ?? null,
    status: row.status,
    schemaStatus: row.schemaStatus ?? null,
    createdAt: row.createdAt.toISOString(),
    onboardingCompletedAt: row.onboardingCompletedAt?.toISOString() ?? null,
  };
}

@Injectable()
export class CoreEntityCacheService {
  private readonly logger = new Logger(CoreEntityCacheService.name);

  constructor(
    private readonly env: EnvironmentService,
    private readonly redis: AuthCacheRedisClientProvider,
    // Wave 5 lane OPS: optional in-process L1 (non-authorisation kinds only — see MetadataL1CacheService). Absent or
    // disabled, every path below is byte-for-byte the pre-L1 behaviour.
    @Optional() private readonly l1?: MetadataL1CacheService,
  ) {}

  /** The L1, only for kinds it accepts and only while it is live (its invalidation subscription is confirmed). */
  private l1For(kind: EntityCacheKind): MetadataL1CacheService | null {
    return this.l1 && isL1CacheableKind(kind) && this.l1.isLive() ? this.l1 : null;
  }

  isEnabled(): boolean {
    return this.env.get('CORE_ENTITY_CACHE_ENABLED');
  }

  // ---------------------------------------------------------------- generic mechanism

  private epochKey(kind: EntityCacheKind, id: string): string {
    return `crewflow:${this.env.get('NODE_ENV')}:entitycache:${kind}:${id}:epoch`;
  }

  private dataKey(kind: EntityCacheKind, id: string, epoch: string): string {
    return `crewflow:${this.env.get('NODE_ENV')}:entitycache:${kind}:${id}:v${epoch}`;
  }

  private async readEpoch(kind: EntityCacheKind, id: string): Promise<string> {
    try {
      const raw = await this.redis.client.get(this.epochKey(kind, id));
      return raw ?? '0';
    } catch (error) {
      this.logger.debug(`entity cache epoch read failed for ${kind}:${id}, treating as epoch 0: ${(error as Error).message}`);
      return '0';
    }
  }

  private async readData<T>(kind: EntityCacheKind, id: string, epoch: string): Promise<T | undefined> {
    try {
      const raw = await this.redis.client.get(this.dataKey(kind, id, epoch));
      if (raw === null) return undefined;
      return JSON.parse(raw) as T;
    } catch (error) {
      this.logger.debug(`entity cache GET failed for ${kind}:${id}, treating as miss: ${(error as Error).message}`);
      return undefined;
    }
  }

  private async writeData<T>(kind: EntityCacheKind, id: string, epoch: string, value: T, ttlSeconds: number = DATA_TTL_SECONDS): Promise<void> {
    try {
      await this.redis.client.set(this.dataKey(kind, id, epoch), JSON.stringify(value), 'EX', Math.max(1, Math.min(ttlSeconds, DATA_TTL_SECONDS)));
    } catch (error) {
      this.logger.debug(`entity cache SET failed for ${kind}:${id}, continuing without caching: ${(error as Error).message}`);
    }
  }

  /**
   * Read-through: a HIT returns the cached projection with zero Postgres round trips; a MISS (cache
   * disabled, Redis unreachable, or genuinely not-yet-cached) calls `fetch` and, if it returns a
   * non-null value, caches it under the epoch that was current at lookup time. `fetch`'s own result
   * is always what's returned — this method never changes the shape or meaning of a miss.
   */
  /**
   * `enabled` defaults to this service's OWN flag (`CORE_ENTITY_CACHE_ENABLED`) — every typed
   * wrapper below (`getUserDisplay`, etc.) relies on that default. A caller gating on a DIFFERENT
   * flag (`WorkspaceMetadataCacheService`, which must stay independently toggleable from this
   * service — see that file's own doc comment) passes its own flag's current value explicitly;
   * the underlying epoch/data mechanism is shared, the on/off switch is not.
   */
  /**
   * `ttlSeconds` (wave 3 lane H): an optional, value-dependent TTL, clamped to 1..DATA_TTL_SECONDS — the host-label cache
   * keeps positive answers ≤60 s and negative ones ≤10 s. Omitted, every existing caller keeps DATA_TTL_SECONDS.
   */
  async getOrFetch<T>(
    kind: EntityCacheKind,
    id: string,
    fetch: () => Promise<T | null>,
    enabled: boolean = this.isEnabled(),
    ttlSeconds?: (value: T) => number,
  ): Promise<T | null> {
    if (!enabled) return fetch();
    const l1 = this.l1For(kind);
    if (l1 && isL1CacheableKind(kind)) {
      const local = l1.get<T>(kind, id);
      if (local !== undefined) return local;
    }
    // Ticket BEFORE the slow reads: an invalidation that lands while we read L2/Postgres fences this fill out of L1.
    const ticket = l1 && isL1CacheableKind(kind) ? l1.ticket(kind, id) : null;
    const epoch = await this.readEpoch(kind, id);
    const cached = await this.readData<T>(kind, id, epoch);
    if (cached !== undefined) {
      l1?.set(ticket, cached, ttlSeconds ? ttlSeconds(cached) * 1000 : undefined);
      return cached;
    }
    const value = await fetch();
    if (value !== null) {
      await this.writeData(kind, id, epoch, value, ttlSeconds ? ttlSeconds(value) : DATA_TTL_SECONDS);
      l1?.set(ticket, value, ttlSeconds ? ttlSeconds(value) * 1000 : undefined);
    }
    return value;
  }

  /** The current epoch of `kind:id` ('0' when unset, disabled or Redis is unreachable). Used to fold a global epoch into another kind's key. */
  async currentEpoch(kind: EntityCacheKind, id: string, enabled: boolean = this.isEnabled()): Promise<string> {
    if (!enabled) return '0';
    const l1 = this.l1For(kind);
    if (!l1 || !isL1CacheableKind(kind)) return this.readEpoch(kind, id);
    const epochId = `#epoch:${id}`;
    const local = l1.get<string>(kind, epochId);
    if (local !== undefined) return local;
    const ticket = l1.ticket(kind, epochId);
    const epoch = await this.readEpoch(kind, id);
    l1.set(ticket, epoch);
    return epoch;
  }

  /**
   * Best-effort, never throws. Call AFTER the mutating transaction commits — see this file's own
   * doc comment for why ordering matters, and for the precise freshness guarantee this retry
   * exists to tighten (cache safety review, Phase 0A): a single transient `INCR` failure (a GC
   * pause, a brief network blip under this hot-path client's intentionally tight timeouts — see
   * `AuthCacheRedisClientProvider`) is the realistic failure mode, not a sustained outage (which
   * would also make reads fail-open to Postgres, so carries no staleness risk at all). Three quick
   * attempts, not the request-blocking caller's own latency budget, is enough to absorb that case
   * without meaningfully delaying the write path. If all three fail, the method still returns
   * normally — it never fails the caller's mutation — and the resulting staleness window is bounded
   * by `DATA_TTL_SECONDS`, exactly as documented above.
   */
  async invalidate(kind: EntityCacheKind, id: string, enabled: boolean = this.isEnabled()): Promise<void> {
    if (!enabled) return;
    const key = this.epochKey(kind, id);
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await this.redis.client.incr(key);
        break;
      } catch (error) {
        if (attempt === 3) {
          this.logger.warn(`entity cache INVALIDATE failed for ${kind}:${id} after 3 attempts — stale data may be served for up to ${DATA_TTL_SECONDS}s: ${(error as Error).message}`);
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20 * attempt));
      }
    }
    // Wave 5 lane OPS: AFTER the epoch INCR, so a peer that drops its L1 entry and re-reads L2 sees the new epoch. Runs
    // even when the INCR failed (the local L1 drop still helps this process). Never throws.
    if (this.l1 && isL1CacheableKind(kind)) await this.l1.invalidate(kind, id);
  }

  // ---------------------------------------------------------------- typed, safe-projection wrappers

  /** `manager` must already be bound to the caller's own tenant context — this performs the exact same RLS-scoped read the uncached call site already did. */
  async getUserDisplay(manager: EntityManager, userId: string): Promise<UserDisplayProjection | null> {
    return this.getOrFetch('user', userId, async () => {
      const row = await manager.findOne(User, { where: { id: userId } });
      if (!row) return null;
      return {
        id: row.id,
        organisationId: row.organisationId,
        firstName: row.firstName,
        lastName: row.lastName,
        email: row.email,
        avatarFileId: row.avatarFileId ?? null,
      };
    });
  }

  async getOrganisationDisplay(manager: EntityManager, organisationId: string): Promise<OrganisationDisplayProjection | null> {
    return this.getOrFetch('organisation', organisationId, async () => {
      const row = await manager.findOne(Organisation, { where: { id: organisationId } });
      if (!row) return null;
      return { id: row.id, name: row.name, slug: row.slug, logoFileId: row.logoFileId ?? null, timezone: row.timezone };
    });
  }

  async getManagerProfileSummary(manager: EntityManager, managerProfileId: string): Promise<ManagerProfileSummaryProjection | null> {
    return this.getOrFetch('manager_profile', managerProfileId, async () => {
      const row = await manager.findOne(ManagerProfile, { where: { id: managerProfileId } });
      if (!row) return null;
      return { id: row.id, userId: row.userId, organisationId: row.organisationId, workspaceId: row.workspaceId ?? null, type: row.type };
    });
  }

  async getManagerWorkspaceDisplay(manager: EntityManager, workspaceId: string): Promise<ManagerWorkspaceDisplayProjection | null> {
    return this.getOrFetch('manager_workspace', workspaceId, async () => {
      const row = await manager.findOne(ManagerWorkspace, { where: { id: workspaceId } });
      return row ? toManagerWorkspaceProjection(row) : null;
    });
  }

  /**
   * `ManagerWorkspace` has a second unique access path — `ownerUserId` (every Manager owns at
   * most one workspace; `manager_workspace_owner_user_id_key` is a UNIQUE constraint) — used by
   * `ManagerWorkspaceService.ownWorkspace()`/`getMine()`, which never has the workspace's own id
   * in hand until after this lookup. A distinct cache `kind` keyed by `ownerUserId`, not a second
   * dimension bolted onto `getManagerWorkspaceDisplay`'s id-keyed cache — callers that mutate the
   * row must invalidate both kinds (see `ManagerWorkspaceService`'s own invalidation calls).
   */
  async getManagerWorkspaceByOwner(manager: EntityManager, ownerUserId: string): Promise<ManagerWorkspaceDisplayProjection | null> {
    return this.getOrFetch('manager_workspace_by_owner', ownerUserId, async () => {
      const row = await manager.findOne(ManagerWorkspace, { where: { ownerUserId } });
      return row ? toManagerWorkspaceProjection(row) : null;
    });
  }

  async getVenueSummary(manager: EntityManager, venueId: string): Promise<VenueSummaryProjection | null> {
    return this.getOrFetch('venue', venueId, async () => {
      const row = await manager.findOne(Venue, { where: { id: venueId } });
      if (!row) return null;
      return { id: row.id, organisationId: row.organisationId, workspaceId: row.workspaceId ?? null, name: row.name };
    });
  }
}
