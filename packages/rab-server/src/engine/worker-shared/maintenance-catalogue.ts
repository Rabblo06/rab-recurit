import { DataSource } from 'typeorm';

/**
 * Organisation routing list for worker dispatch and storage maintenance. Reads core.worker_list_organisations, a bounded SECURITY
 * DEFINER function that returns organisation ids only. core.organisation is RLS-hidden from the runtime role, so a plain SELECT through
 * rab_app returns nothing. The parameter is a DataSource only so callers pass the runtime connection; nothing here needs owner privileges.
 */
export async function* organisationIds(
  dataSource: DataSource,
): AsyncGenerator<string> {
  let after: string | null = null;
  for (;;) {
    const rows: Array<{ organisation_id: string }> = await dataSource.query(
      'SELECT organisation_id FROM core.worker_list_organisations($1::uuid, 100)',
      [after],
    );
    if (!rows.length) return;
    for (const row of rows) yield row.organisation_id;
    after = rows[rows.length - 1]!.organisation_id;
  }
}

export interface MaintenanceScope {
  organisationId: string;
  workspaceId: string | null;
}

/**
 * Worker credential isolation checkpoint — the workspace half of this used to run a raw
 * `SELECT id FROM core.manager_workspace WHERE organisation_id = $1` with no tenant context
 * bound. `manager_workspace` is one of the 11 `rab_secure_owner`-owned, NOT-FORCE'd tables, and
 * its RLS policy requires `id = current_workspace()` OR `owner_user_id = current_uid()` — neither
 * ever true for an unbound maintenance connection. Confirmed empirically before this fix (against
 * a disposable database, as either `crewflow` or `crewflow_app`): that query always returned ZERO
 * rows. This was a genuine pre-existing correctness bug, not something either credential's
 * privilege level could have fixed — the workspace half of storage cleanup has never actually
 * discovered anything. Fixed by using `core.worker_list_workspaces()`, the SECURITY DEFINER
 * function already built and granted for exactly this (same pattern as `worker_list_organisations`
 * above) — it enumerates ALL workspaces globally with no per-organisation filter parameter, so
 * this now does one global paginated pass instead of nesting per-organisation queries, and derives
 * each row's organisation from the function's own `organisation_id` column rather than the loop
 * variable.
 */
export async function* storageScopes(
  owner: DataSource,
): AsyncGenerator<MaintenanceScope> {
  for await (const organisationId of organisationIds(owner)) {
    yield { organisationId, workspaceId: null };
  }

  let after: string | null = null;
  for (;;) {
    const rows: Array<{ workspace_id: string; organisation_id: string }> = await owner.query(
      'SELECT workspace_id, organisation_id FROM core.worker_list_workspaces($1::uuid, 100)',
      [after],
    );
    if (!rows.length) return;
    for (const row of rows) yield { organisationId: row.organisation_id, workspaceId: row.workspace_id };
    after = rows[rows.length - 1]!.workspace_id;
  }
}
