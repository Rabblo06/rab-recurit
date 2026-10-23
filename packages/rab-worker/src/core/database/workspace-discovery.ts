import { DataSource, EntityManager } from 'typeorm';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';

import { isNotYetRoutableWorkspace } from './workspace-routing';

/** Keyset page size for the routing list. Matches the function's own ceiling (core.worker_list_workspaces caps at 100). */
const DISCOVERY_PAGE_SIZE = 100;

/** Four read-only scans at a time — bounds connection-pool use without serialising every empty workspace round trip. See P2.2 note below on why this number, not a higher one, is the safe lever to tune. */
const CONCURRENCY = 4;

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
 *
 * P2.2 — this function's O(workspace count) cost (confirmed empirically: 9,673 workspaces in this
 * dev database, each needing its own transaction) is `docs/architecture/HYPER-WORKSPACE-SCHEMA-
 * AUDIT.md`'s own already-documented blocker B6 ("Worker discovery scans all workspaces... cost
 * and correctness of N-schema scans"), explicitly deferred to a not-yet-started future phase
 * (HWS-5) and separately flagged in that same doc's §10 as "NEEDS PROJECTION LATER (scan cost
 * grows with workspace count)". An earlier attempt in this session to add a cheap owner-connection
 * pre-filter (skip opening a transaction for workspaces that can't match) turned out to be
 * infeasible WITHOUT that projection: `shift`/`shift_assignment`/`attendance` are NOT one shared,
 * RLS-filtered table — each workspace has its OWN physical schema (`workspace_<uuid>`) with its
 * own copy of these tables (confirmed via `pg_class`/`information_schema.tables`), so there is no
 * single cross-workspace query to pre-filter with; building one would mean either iterating every
 * schema anyway (no saving) or a dedicated cross-schema projection table maintained by triggers —
 * exactly the HWS-5 scope, not a same-checkpoint fix. Not attempted here. Two genuinely safe,
 * bounded improvements WERE made instead (see `shift-monitor.job.ts`'s merged reminder/no-show
 * query and this file's own `CONCURRENCY` constant) — neither changes this function's fundamental
 * per-workspace shape, both reduce its constant-factor cost within it.
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
    for (let offset = 0; offset < scopes.length; offset += CONCURRENCY) {
      const batches = await Promise.allSettled(
        scopes.slice(offset, offset + CONCURRENCY).map((scope) =>
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
        if (batch.status === 'rejected') {
          // W6-E2E-07: a workspace still being provisioned (no registry row yet / not READY) has nothing to scan — skip it
          // instead of failing every tenant's cycle. Integrity refusals still throw (see workspace-routing.ts).
          if (isNotYetRoutableWorkspace(batch.reason)) continue;
          throw batch.reason;
        }
        result.push(...batch.value);
      }
    }
    after = page[page.length - 1].workspace_id;
  }
  return result;
}
