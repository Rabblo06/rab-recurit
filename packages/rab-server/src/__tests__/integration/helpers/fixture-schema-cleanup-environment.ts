import NodeEnvironment from 'jest-environment-node';
import { Client } from 'pg';

import { DISPOSABLE_TEST_DATABASE_SETTING, resolveIntegrationTestDatabase } from '../../../database/typeorm/core/test-database-guard';

/**
 * Part C1 (C1b, CI scale; C1-STATUS.md §7 and the C1b section): the Jest test environment of the integration suites. After a
 * test file has finished (every hook included), it drops the workspace schemas of the workspaces and organisations that
 * file's fixtures created (fixture-workspace-tracker.ts), so one shared in-band database (CI's model) does not accumulate
 * hundreds of 121-relation schemas.
 *
 * Test-side only, never product code: the superuser fixture connection (TEST_DATABASE_ADMIN_URL, the same identity the
 * suites already use for fixtures) runs `DROP SCHEMA ... CASCADE` and deletes the registry row (its RESTRICT foreign key to
 * core.manager_workspace), exactly as the existing test helpers dropWorkspaceSchema / dropFixtureWorkspaceSchema do. The
 * core rows (organisation, workspace, users) stay; the append-only migration ledger keeps its rows.
 *
 * Fail-safe: runs only on a database that carries the disposable-test marker (ALTER DATABASE ... SET
 * crewflow.disposable_test_database = 'true', read from the catalogue like test-database-guard.ts does); only schema names
 * derived from tracked UUIDs (workspace_<32 hex>); a cleanup error is reported and never fails or hides the file's results.
 * CREWFLOW_TEST_KEEP_FIXTURE_SCHEMAS=true keeps every schema (debugging a failed run).
 */
/** schema-resolver.service.ts workspaceSchemaName, without loading the Nest service graph into the environment. */
function workspaceSchemaName(workspaceId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(workspaceId)) throw new Error('not a UUID');
  return `workspace_${workspaceId.replace(/-/g, '').toLowerCase()}`;
}

interface TrackerGlobal {
  __crewflowFixtureWorkspaces?: Set<string>;
  __crewflowFixtureOrganisations?: Set<string>;
}

export default class FixtureSchemaCleanupEnvironment extends NodeEnvironment {
  override async teardown(): Promise<void> {
    try {
      await this.dropFixtureSchemas();
    } catch (error) {
      const code = (error as { code?: string }).code ?? (error instanceof Error ? error.name : 'unknown');
      // Never the driver message verbatim: it can echo connection details.
      process.stderr.write(`[fixture-schema-cleanup] skipped: ${code}\n`);
    } finally {
      await super.teardown();
    }
  }

  private async dropFixtureSchemas(): Promise<void> {
    if (process.env.CREWFLOW_TEST_KEEP_FIXTURE_SCHEMAS === 'true') return;
    const g = this.global as unknown as TrackerGlobal;
    const workspaces = [...(g.__crewflowFixtureWorkspaces ?? [])];
    const organisations = [...(g.__crewflowFixtureOrganisations ?? [])];
    if (workspaces.length === 0 && organisations.length === 0) return;
    if (!process.env.TEST_DATABASE_URL) return;

    const { adminUrl } = resolveIntegrationTestDatabase(process.env);
    const client = new Client({ connectionString: adminUrl, connectionTimeoutMillis: 10_000, statement_timeout: 120_000 });
    await client.connect();
    try {
      const marker = await client.query<{ marker: string | null }>(
        `SELECT (SELECT split_part(cfg, '=', 2) FROM pg_db_role_setting s JOIN pg_database d ON d.oid = s.setdatabase, unnest(s.setconfig) cfg
                  WHERE d.datname = current_database() AND s.setrole = 0 AND split_part(cfg, '=', 1) = $1 LIMIT 1) AS marker`,
        [DISPOSABLE_TEST_DATABASE_SETTING],
      );
      if (marker.rows[0]?.marker !== 'true') return;

      const rows = await client.query<{ id: string }>(
        `SELECT id::text AS id FROM core.manager_workspace WHERE id = ANY($1::uuid[]) OR organisation_id = ANY($2::uuid[])`,
        [workspaces, organisations],
      );
      const ids = new Set([...workspaces, ...rows.rows.map((r) => r.id)]);
      for (const id of ids) {
        const schema = workspaceSchemaName(id);
        if (!/^workspace_[0-9a-f]{32}$/.test(schema)) continue;
        await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await client.query(`DELETE FROM core.workspace_schema_registry WHERE workspace_id = $1`, [id]);
      }
    } finally {
      await client.end().catch(() => undefined);
    }
  }
}
