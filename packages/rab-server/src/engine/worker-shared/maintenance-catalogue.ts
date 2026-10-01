import { DataSource } from 'typeorm';

/** Trusted worker/CLI catalogue only. Never exposes an owner manager to business work. */
export async function* organisationIds(
  owner: DataSource,
): AsyncGenerator<string> {
  let after: string | null = null;
  for (;;) {
    const rows: Array<{ id: string }> = await owner.transaction(
      async (manager) => {
        await manager.query('SET TRANSACTION READ ONLY');
        return manager.query(
          'SELECT id FROM core.organisation WHERE ($1::uuid IS NULL OR id > $1) ORDER BY id LIMIT 100',
          [after],
        );
      },
    );
    if (!rows.length) return;
    for (const row of rows) yield row.id;
    after = rows[rows.length - 1].id;
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
