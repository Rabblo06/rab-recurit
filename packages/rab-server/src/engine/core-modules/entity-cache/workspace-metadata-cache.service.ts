import { Injectable } from '@nestjs/common';

import { EnvironmentService } from '../environment/environment.service';
import { CoreEntityCacheService } from './core-entity-cache.service';

/**
 * Redis checkpoint — Workspace Metadata Cache. Twenty CRM's `WorkspaceCacheService` caches a
 * workspace's own metadata (object/field definitions, feature flags) scoped to that workspace;
 * this codebase's closest real equivalent is `SchemaResolverService.resolve()`'s own result — the
 * physical schema name and version a workspace routes to, re-derived from
 * `core.workspace_schema_registry` on every single HWS-mode request via `TenantContextService`.
 *
 * NON-AUTHORITATIVE, exactly as required: this cache is consulted ONLY from inside
 * `SchemaResolverService.resolve()`, strictly AFTER the caller has already bound its own
 * organisation/session context (`TenantContextService.bindGucs` runs first, unconditionally, cache
 * hit or miss) — it never decides whether a caller may access a workspace, only which already-
 * authorised schema name to route to. It caches ONLY the successful, `READY` outcome; every
 * failure path (`missing-context`, `registry-missing`, `name-mismatch`, `not-ready`,
 * `unsupported-version`) is untouched by this cache and always re-evaluated against Postgres —
 * a cache HIT can therefore never let a request route to a workspace that isn't (or is no longer)
 * actually ready. Workspace suspension/deletion does not change this analysis: confirmed by direct
 * investigation (cache safety review, Phase 0B) that no code path currently changes
 * `manager_workspace.status`, and — independently of whether one ever does — the actual
 * "is this session currently allowed to use this workspace" decision is enforced entirely by
 * `core.resolve_membership_for_session`/`resolve_membership_for_user`, called live against
 * Postgres on every single request with no cache of its own (`AuthSecuritySnapshotService.
 * resolveMembership()`), structurally outside and before this cache is ever consulted. A workspace
 * this cache still happily routes schema queries for is not the same thing as a workspace a given
 * session is still allowed to reach — those are two different questions, and only the second one
 * is a security decision; this cache only ever answers the first.
 *
 * MECHANISM (cache safety review, Phase 0B — changed from this file's original plain `SET`/`DEL`):
 * delegates to `CoreEntityCacheService`'s shared epoch-keyed mechanism (kind
 * `'workspace_schema_resolution'`), not a bespoke `SET`/`DEL` pair. The original plain-`DEL`
 * design had exactly the classic cache-aside race the epoch design exists to close: a reader
 * holding a Postgres snapshot taken BEFORE a (hypothetical future) re-provisioning write could
 * still be mid-flight when that write's `DEL` ran, and then write its OWN now-stale value back
 * into Redis immediately after — with nothing left to ever invalidate it again before its TTL.
 * Sharing the epoch mechanism closes that race the same way it's closed for every other cached
 * kind (see `CoreEntityCacheService`'s own top doc comment for the full argument), for free.
 * `isEnabled()` stays this service's OWN, independently-toggleable flag
 * (`WORKSPACE_METADATA_CACHE_ENABLED`) — passed explicitly into the shared mechanism rather than
 * relying on `CoreEntityCacheService`'s own `CORE_ENTITY_CACHE_ENABLED` flag, which must remain
 * free to be on or off independently of this one.
 */
export interface CachedResolvedSchema {
  schemaName: string;
  schemaVersion: number;
  /**
   * Phase B: the registry's `module_version` at fetch time. Optional in the type because a value written by an older
   * image lacks it; SchemaResolverService refetches from Postgres when it is missing or below its floor.
   */
  moduleVersion?: number;
}

@Injectable()
export class WorkspaceMetadataCacheService {
  constructor(
    private readonly env: EnvironmentService,
    private readonly coreEntityCache: CoreEntityCacheService,
  ) {}

  isEnabled(): boolean {
    return this.env.get('WORKSPACE_METADATA_CACHE_ENABLED');
  }

  /**
   * Read-through, exactly like `CoreEntityCacheService.getOrFetch` — `fetch` runs on a MISS and is
   * expected to throw (never return a sentinel) for every non-`READY` outcome; `resolve()`'s own
   * `WorkspaceRoutingError` propagates through this method completely unchanged, and is never
   * itself cached (`getOrFetch` only ever caches a value `fetch` actually returned).
   */
  async resolveSchema(workspaceId: string, fetch: () => Promise<CachedResolvedSchema>): Promise<CachedResolvedSchema> {
    const result = await this.coreEntityCache.getOrFetch('workspace_schema_resolution', workspaceId, fetch, this.isEnabled());
    // fetch() here never legitimately returns null (it throws instead on every failure path), so a
    // null result would only mean fetch() itself returned null in violation of its own contract —
    // surfacing that loudly is safer than silently asserting past it.
    if (result === null) throw new Error('WorkspaceMetadataCacheService.resolveSchema: fetch() returned null, which violates its contract.');
    return result;
  }

  /** Forward-compatibility hook — see this file's own doc comment. Best-effort, never throws (inherited from the shared mechanism). */
  async invalidate(workspaceId: string): Promise<void> {
    await this.coreEntityCache.invalidate('workspace_schema_resolution', workspaceId, this.isEnabled());
  }
}
