import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Twenty-style worker runtime cutover (owner decision): the worker process authenticates as rab_app, exactly like the API. It no
 * longer uses rab_owner for discovery or cleanup. These two functions are the only database operations the worker needs that
 * used to need the owner connection. Each is owned by rab_owner (this migration runs as rab_owner), has a fixed search_path,
 * revokes PUBLIC EXECUTE and grants EXECUTE to rab_app only. Neither accepts a schema name, SQL, a user id, or an organisation or
 * workspace scope from the caller.
 *
 * core.worker_list_workspaces(after, limit)
 *   Bounded, keyset-paginated routing list: workspace id, organisation id, status, schema version. No staff, business or identity
 *   columns. Source is core.manager_workspace, the canonical workspace list until the physical ws_<id> split populates
 *   core.workspace_schema_registry (that table is empty today, so reading it now would silently process zero workspaces).
 *
 * core.worker_cleanup_auth_tokens(batch)
 *   Deletes at most `batch` refresh tokens and password-reset tokens matching exactly the predicates the owner-side job used
 *   (revoked or expired more than 30 days ago). The 30-day window is fixed here, not caller-supplied. Serialised by a transaction
 *   advisory lock with the same key the job used.
 */
export class WorkerRuntimeFunctions1786676500000 implements MigrationInterface {
  name = 'WorkerRuntimeFunctions1786676500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION core.worker_list_workspaces(p_after uuid, p_limit integer)
      RETURNS TABLE (workspace_id uuid, organisation_id uuid, status text, schema_version integer)
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = core, pg_catalog
      AS $function$
        SELECT mw.id, mw.organisation_id, mw.status, mw.schema_version
          FROM core.manager_workspace mw
         WHERE (p_after IS NULL OR mw.id > p_after)
         ORDER BY mw.id
         LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 100)
      $function$;
    `);
    await queryRunner.query(`REVOKE ALL ON FUNCTION core.worker_list_workspaces(uuid, integer) FROM PUBLIC;`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION core.worker_list_workspaces(uuid, integer) TO rab_app;`);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION core.worker_cleanup_auth_tokens(p_batch integer)
      RETURNS TABLE (refresh_tokens_deleted integer, password_reset_tokens_deleted integer)
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = core, pg_catalog
      AS $function$
      DECLARE
        v_batch integer := LEAST(GREATEST(COALESCE(p_batch, 1000), 1), 10000);
        v_refresh integer;
        v_reset integer;
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtext('rab_token_cleanup'));

        DELETE FROM core.refresh_token
         WHERE id IN (
           SELECT id FROM core.refresh_token
            WHERE (revoked_at IS NOT NULL AND revoked_at < now() - interval '30 days')
               OR (expires_at < now() - interval '30 days')
            LIMIT v_batch
         );
        GET DIAGNOSTICS v_refresh = ROW_COUNT;

        DELETE FROM core.password_reset_token
         WHERE id IN (
           SELECT id FROM core.password_reset_token
            WHERE (used_at IS NOT NULL AND used_at < now() - interval '30 days')
               OR (expires_at < now() - interval '30 days')
            LIMIT v_batch
         );
        GET DIAGNOSTICS v_reset = ROW_COUNT;

        refresh_tokens_deleted := v_refresh;
        password_reset_tokens_deleted := v_reset;
        RETURN NEXT;
      END
      $function$;
    `);
    await queryRunner.query(`REVOKE ALL ON FUNCTION core.worker_cleanup_auth_tokens(integer) FROM PUBLIC;`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION core.worker_cleanup_auth_tokens(integer) TO rab_app;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP FUNCTION IF EXISTS core.worker_cleanup_auth_tokens(integer);`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS core.worker_list_workspaces(uuid, integer);`);
  }
}
