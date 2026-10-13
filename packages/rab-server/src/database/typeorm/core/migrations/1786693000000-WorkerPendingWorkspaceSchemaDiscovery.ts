import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Worker credential isolation checkpoint, item 1's own standalone-process test found this live:
 * `workspace-provisioning.job.ts`'s candidate query (`SELECT id FROM core.manager_workspace WHERE
 * schema_status IN ('CREATING', 'FAILED') ...`) always returns ZERO rows when run as `crewflow` —
 * the real credential the standalone provisioner actually connects as (`DATABASE_URL_UNPOOLED`).
 *
 * `core.manager_workspace` is owned by `rab_secure_owner` (one of CLAUDE.md's 11 pre-auth-sensitive
 * NOT-FORCEd tables) and `crewflow` is not that owner, so `crewflow` is bound by its RLS regardless
 * of the table's own NOT-FORCE exemption (that exemption only bypasses RLS for the OWNER, never for
 * any other role). `manager_workspace_member`'s USING clause is `id = current_workspace() OR
 * owner_user_id = current_uid()` — never true for an unbound maintenance connection with no tenant
 * context, same root cause `WorkerOrganisationDiscovery1786676700000`/
 * `WorkerRuntimeFunctions1786676500000` already fixed for the OTHER maintenance jobs' own discovery
 * queries. This one was missed at the time because every existing integration test for this job
 * calls it with the disposable test database's SUPERUSER connection (`TEST_DATABASE_URL_UNPOOLED`),
 * which bypasses RLS unconditionally and silently masked the bug — confirmed live by running the
 * real `workspace-provisioner.main.ts` entrypoint as the real `crewflow` credential against a
 * disposable database with a genuine pending workspace: `attempted: 0` every time, despite the row
 * being there and matching.
 *
 * Fix: the same bounded, keyset-paginated SECURITY DEFINER pattern as `worker_list_organisations`/
 * `worker_list_workspaces`, narrowly scoped to exactly what this one job needs — the workspace id
 * only, filtered to the two statuses this job ever acts on, ordered the same way the raw query was.
 * No caller-selected scope, no other columns, EXECUTE granted to `crewflow` only (the provisioner is
 * the only process that ever calls this — `crewflow_app` has no reachable code path to it, so it is
 * deliberately NOT granted here, unlike the two existing functions above which both jobs' owning
 * role already needed).
 */
export class WorkerPendingWorkspaceSchemaDiscovery1786693000000 implements MigrationInterface {
  name = 'WorkerPendingWorkspaceSchemaDiscovery1786693000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION core.worker_list_pending_workspace_schemas(p_limit integer)
      RETURNS TABLE (workspace_id uuid)
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = core, pg_catalog
      AS $function$
        SELECT mw.id
          FROM core.manager_workspace mw
         WHERE mw.schema_status IN ('CREATING', 'FAILED')
         ORDER BY mw.created_at ASC
         LIMIT LEAST(GREATEST(COALESCE(p_limit, 10), 1), 50)
      $function$;
    `);
    await queryRunner.query(`ALTER FUNCTION core.worker_list_pending_workspace_schemas(integer) OWNER TO rab_secure_owner;`);
    await queryRunner.query(`REVOKE ALL ON FUNCTION core.worker_list_pending_workspace_schemas(integer) FROM PUBLIC;`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION core.worker_list_pending_workspace_schemas(integer) TO crewflow;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP FUNCTION IF EXISTS core.worker_list_pending_workspace_schemas(integer);`);
  }
}
