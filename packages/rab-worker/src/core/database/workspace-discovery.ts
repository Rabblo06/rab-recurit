import { DataSource, EntityManager } from 'typeorm';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';

/** Privilege boundary: fixed, read-only scope IDs from the existing pre-auth
 * workspace catalogue. No business rows, writes, dynamic SQL or RLS changes.
 * The callback receives only the RLS-bound application manager, never owner.
 * Keyset pages bound catalogue memory; candidate limits remain per workspace.
 */
export async function discoverInWorkspaces<T>(
  owner: DataSource,
  tenant: TenantContextService,
  scan: (manager: EntityManager) => Promise<T[]>,
  organisationId?: string,
): Promise<T[]> {
  const result: T[] = [];
  let after: string | null = null;
  for (;;) {
    const scopes: Array<{ id: string; organisation_id: string }> = await owner.transaction(async manager => {
      await manager.query('SET TRANSACTION READ ONLY');
      return manager.query(`SELECT id, organisation_id FROM core.manager_workspace
        WHERE ($1::uuid IS NULL OR id > $1) AND ($2::uuid IS NULL OR organisation_id = $2)
        ORDER BY id LIMIT 100`, [after, organisationId ?? null]);
    });
    if (!scopes.length) break;
    // Four read-only scans at a time bound connection use without serialising
    // every empty workspace round trip. Preserve deterministic page order.
    for (let offset = 0; offset < scopes.length; offset += 4) {
      const batches = await Promise.allSettled(scopes.slice(offset, offset + 4).map(scope => tenant.runInTenantContext(
        { organisationId: scope.organisation_id, workspaceId: scope.id, userId: '', role: '' },
        async manager => {
          await manager.query('SET TRANSACTION READ ONLY');
          return scan(manager);
        },
      )));
      for (const batch of batches) {
        if (batch.status === 'rejected') throw batch.reason;
        result.push(...batch.value);
      }
    }
    after = scopes[scopes.length - 1].id;
  }
  return result;
}
