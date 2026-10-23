import { Injectable } from '@nestjs/common';
import { PermissionFlag } from '@rab/shared';
import { createHash } from 'node:crypto';
import { EntityManager } from 'typeorm';

import { CoreEntityCacheService } from './core-entity-cache.service';

export interface PermissionCatalogueRow {
  id: string;
  key: string;
  resource: string;
  action: string;
  description: string | null;
}

/**
 * Cache key: a hash of the CODE-side flag list. A deploy that ships a new flag (always together with the migration that
 * inserts its catalogue row) reads a brand-new key, so a catalogue cached by the previous release is never served to it.
 */
export const PERMISSION_CATALOGUE_CACHE_VERSION = createHash('sha256')
  .update([...new Set(Object.values(PermissionFlag) as string[])].sort().join('\n'))
  .digest('hex')
  .slice(0, 16);

/**
 * Wave 5 lane OPS — the permission CATALOGUE (`core.permission`: the static, global list of flags with their
 * descriptions), read through the existing Redis epoch cache (`CORE_ENTITY_CACHE_ENABLED`) and the in-process L1
 * (`METADATA_L1_CACHE_ENABLED`).
 *
 * NOT AUTHORISATION DATA. The catalogue says which flags EXIST; it never says who HOLDS one. Whether a caller may read it
 * (ROLE_VIEW) and every grant decision stay on the live per-request path (`PermissionsService.userHasPermissionTx`,
 * `AuthSecuritySnapshotService`), which has no local layer. `core.permission` has no organisation column and no RLS, so
 * a cached copy is identical for every tenant; rows change only by migration (see the version key above).
 *
 * Callers must not mutate the returned rows (they may be shared, frozen L1 values); map them into new objects.
 */
@Injectable()
export class PermissionCatalogueCacheService {
  constructor(private readonly cache: CoreEntityCacheService) {}

  async list(manager: EntityManager): Promise<readonly PermissionCatalogueRow[]> {
    const rows = await this.cache.getOrFetch<PermissionCatalogueRow[]>('permission_catalogue', PERMISSION_CATALOGUE_CACHE_VERSION, async () => {
      const result: Array<{ id: string; key: string; resource: string; action: string; description: string | null }> = await manager.query(
        'SELECT id, key, resource, action, description FROM core.permission ORDER BY resource ASC, action ASC',
      );
      // An empty catalogue is a broken database (see PermissionCatalogueAndSystemRoleDefaults1786718000000): never cache it.
      return result.length > 0 ? result.map((r) => ({ id: r.id, key: r.key, resource: r.resource, action: r.action, description: r.description ?? null })) : null;
    });
    return rows ?? [];
  }

  /** Operator hook (e.g. after an out-of-band catalogue repair). Never throws. */
  async invalidate(): Promise<void> {
    await this.cache.invalidate('permission_catalogue', PERMISSION_CATALOGUE_CACHE_VERSION);
  }
}
