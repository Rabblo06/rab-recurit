import { EntityManager } from 'typeorm';

import { CoreEntityCacheService } from '../../../engine/core-modules/entity-cache/core-entity-cache.service';
import { Venue } from '../entities/venue.entity';

/**
 * A venue's cached display summary (notification text only, never an authorisation input). Moved here from engine/'s
 * CoreEntityCacheService.getVenueSummary (engine/ never imports modules/, and this read needs the Venue entity): same cache
 * kind ('venue'), same key (the venue id), same projection, filled through the generic `getOrFetch`, so entries written
 * before the move are read back unchanged and `invalidate('venue', id)` still reaches them. See CoreEntityCacheService's doc
 * comment for why nothing security-relevant may be added here.
 */
export interface VenueSummaryProjection {
  id: string;
  organisationId: string;
  workspaceId: string | null;
  name: string;
}

/** `manager` must already be bound to the caller's own tenant context: this is the same RLS-scoped read as the uncached one. */
export function venueSummaryCached(
  cache: CoreEntityCacheService,
  manager: EntityManager,
  venueId: string,
): Promise<VenueSummaryProjection | null> {
  return cache.getOrFetch('venue', venueId, async () => {
    const row = await manager.findOne(Venue, { where: { id: venueId } });
    if (!row) return null;
    return { id: row.id, organisationId: row.organisationId, workspaceId: row.workspaceId ?? null, name: row.name };
  });
}
