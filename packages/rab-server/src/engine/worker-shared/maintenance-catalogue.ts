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

/** Include org-owned files exactly once, even for organisations without workspaces. */
export async function* storageScopes(
  owner: DataSource,
): AsyncGenerator<MaintenanceScope> {
  for await (const organisationId of organisationIds(owner)) {
    yield { organisationId, workspaceId: null };
    let after: string | null = null;
    for (;;) {
      const rows: Array<{ id: string }> = await owner.transaction(
        async (manager) => {
          await manager.query('SET TRANSACTION READ ONLY');
          return manager.query(
            `SELECT id FROM core.manager_workspace
          WHERE organisation_id = $1 AND ($2::uuid IS NULL OR id > $2) ORDER BY id LIMIT 100`,
            [organisationId, after],
          );
        },
      );
      if (!rows.length) break;
      for (const row of rows) yield { organisationId, workspaceId: row.id };
      after = rows[rows.length - 1].id;
    }
  }
}
