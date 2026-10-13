import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Worker credential isolation checkpoint, item 1's standalone-process test: the third and final
 * layer of the same root cause found in `WorkerPendingWorkspaceSchemaDiscovery1786693000000` and
 * `WorkspaceProvisionerLifecycleGrants1786694000000`. `provisionWorkspaceSchema()`'s very first
 * statement — `SELECT organisation_id FROM core.manager_workspace WHERE id = $1`, with no tenant
 * context bound yet, by construction (resolving the organisation id is the whole point; there is
 * nothing to bind it FROM until this query returns) — is a genuine chicken-and-egg problem for
 * `crewflow`: `manager_workspace`'s own RLS (`id = current_workspace() OR owner_user_id =
 * current_uid()`) can never be satisfied with no context bound, and `crewflow` is not the table's
 * owner (`rab_secure_owner` is, and the table is deliberately NOT FORCEd only for that owner).
 * Confirmed live: this line alone made the entrypoint fail before ever reaching the two issues the
 * earlier two migrations fixed — those were masked behind this one until it was fixed first.
 *
 * `provisionWorkspaceSchema()`'s own top-of-file doc comment still says "Runs as `rab_owner` only" —
 * an assumption from before `rab_secure_owner` existed to narrow this exact table away from the
 * general-purpose owner role, never revisited when that narrowing happened.
 *
 * Fix: the same narrow, single-purpose SECURITY DEFINER pattern as the other two fixes in this trio
 * — a function that does exactly this one lookup and nothing else, granted to `crewflow` only.
 * `provisionWorkspaceSchema()`'s own call site is updated to use it instead of the raw SELECT; its
 * public signature (and therefore every existing test's calling convention) is unchanged.
 */
export class WorkerResolveWorkspaceOrganisation1786695000000 implements MigrationInterface {
  name = 'WorkerResolveWorkspaceOrganisation1786695000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION core.worker_resolve_workspace_organisation(p_workspace_id uuid)
      RETURNS uuid
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = core, pg_catalog
      AS $function$
        SELECT organisation_id FROM core.manager_workspace WHERE id = p_workspace_id
      $function$;
    `);
    await queryRunner.query(`ALTER FUNCTION core.worker_resolve_workspace_organisation(uuid) OWNER TO rab_secure_owner;`);
    await queryRunner.query(`REVOKE ALL ON FUNCTION core.worker_resolve_workspace_organisation(uuid) FROM PUBLIC;`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION core.worker_resolve_workspace_organisation(uuid) TO crewflow;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP FUNCTION IF EXISTS core.worker_resolve_workspace_organisation(uuid);`);
  }
}
