import { EntityManager } from 'typeorm';

import { CoreEntityCacheService } from '../../../engine/core-modules/entity-cache/core-entity-cache.service';
import { ManagerWorkspace } from '../entities/manager-workspace.entity';

/**
 * The cached display projection of a Manager's workspace. Moved here from engine/'s CoreEntityCacheService (engine/ never
 * imports modules/, and this read needs the ManagerWorkspace entity): same cache kind ('manager_workspace_by_owner'),
 * same key, same projection, filled through the generic `getOrFetch`, so entries written
 * before the move are read back unchanged. Every field is display data; see CoreEntityCacheService's doc comment for why
 * nothing security-relevant may be added here.
 */
export interface ManagerWorkspaceDisplayProjection {
  id: string;
  organisationId: string;
  ownerUserId: string;
  name: string;
  subdomain: string;
  logoFileId: string | null;
  status: string;
  /** P2.9C — `core.manager_workspace.schema_status`, invalidated on every write to this row (see CoreEntityCacheService's doc comment on why TTL is never load-bearing for correctness here). */
  schemaStatus: string | null;
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601, or null — matches `ManagerWorkspace.onboardingCompletedAt`'s own nullability. */
  onboardingCompletedAt: string | null;
}

export function toManagerWorkspaceProjection(row: ManagerWorkspace): ManagerWorkspaceDisplayProjection {
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

/**
 * `ManagerWorkspace` has a second unique access path — `ownerUserId` (every Manager owns at most one workspace;
 * `manager_workspace_owner_user_id_key` is a UNIQUE constraint) — used by `ManagerWorkspaceService.getMine()`, which never
 * has the workspace's own id in hand until after this lookup. A distinct cache `kind` keyed by `ownerUserId`, not a second
 * dimension bolted onto the id-keyed cache: callers that mutate the row must invalidate both kinds (see
 * `ManagerWorkspaceService`'s own invalidation calls). `manager` must already be bound to the caller's own tenant context:
 * this is the same RLS-scoped read as the uncached one.
 */
export function managerWorkspaceByOwnerCached(
  cache: CoreEntityCacheService,
  manager: EntityManager,
  ownerUserId: string,
): Promise<ManagerWorkspaceDisplayProjection | null> {
  return cache.getOrFetch('manager_workspace_by_owner', ownerUserId, async () => {
    const row = await manager.findOne(ManagerWorkspace, { where: { ownerUserId } });
    return row ? toManagerWorkspaceProjection(row) : null;
  });
}
