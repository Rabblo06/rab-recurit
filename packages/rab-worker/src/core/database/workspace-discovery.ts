import { DataSource, EntityManager } from 'typeorm';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';

/** Keyset page size for the routing list. Matches the function's own ceiling (core.worker_list_workspaces caps at 100). */
const DISCOVERY_PAGE_SIZE = 100;

/**
 * Workspace discovery for workspace-scoped worker scans (Twenty-style runtime cutover).
 *
 * The routing list comes from core.worker_list_workspaces(after, limit), a SECURITY DEFINER function owned by the narrow NOLOGIN rab_secure_owner, executable
 * only by crewflow. It returns workspace id, organisation id, status and schema version, nothing else: no staff, business or identity
 * columns. The runtime DataSource (crewflow) is the only connection used, so no separate connection is involved.
 *
 * Each scan runs in the trusted, server-derived context of its own workspace: organisation and workspace bound, and the worker actor
 * marker bound (rab.actor_type = 'worker'). The marker is what lets the staff_profile_worker_scan policy show that workspace's Staff
 * rows. It does not set a user id: the scan impersonates no Manager, and no human policy changes.
 *
 * The callback receives only the RLS-bound EntityManager, never a DataSource, and must stay read-only.
 */
export async function discoverInWorkspaces<T>(
  runtime: DataSource,
  tenant: TenantContextService,
  scan: (manager: EntityManager) => Promise<T[]>,
  organisationId?: string,
): Promise<T[]> {
  const result: T[] = [];
  let after: string | null = null;
  for (;;) {
    const page: Array<{ workspace_id: string; organisation_id: string }> = await runtime.transaction(async (manager) => {
      await manager.query('SET TRANSACTION READ ONLY');
      return manager.query(`SELECT workspace_id, organisation_id FROM core.worker_list_workspaces($1::uuid, $2::integer)`, [
        after,
        DISCOVERY_PAGE_SIZE,
      ]);
    });
    if (!page.length) break;
    // Organisation filter is applied to the trusted page, after the function returns. No caller uses it today.
    const scopes = organisationId ? page.filter((row) => row.organisation_id === organisationId) : page;
    // Four read-only scans at a time bound connection use without serialising every empty workspace round trip.
    for (let offset = 0; offset < scopes.length; offset += 4) {
      const batches = await Promise.allSettled(
        scopes.slice(offset, offset + 4).map((scope) =>
          tenant.runInTenantContext(
            { organisationId: scope.organisation_id, workspaceId: scope.workspace_id, userId: '', role: '', actorType: 'worker' },
            async (manager) => {
              await manager.query('SET TRANSACTION READ ONLY');
              return scan(manager);
            },
          ),
        ),
      );
      for (const batch of batches) {
        if (batch.status === 'rejected') throw batch.reason;
        result.push(...batch.value);
      }
    }
    after = page[page.length - 1].workspace_id;
  }
  return result;
}
