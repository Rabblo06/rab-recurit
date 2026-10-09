import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Runtime-visible organisation routing for the worker (HWS Phase 3 runtime checkpoint).
 *
 * core.organisation is RLS-protected: the runtime role (rab_app) sees ZERO organisations without a tenant context, while the owner
 * sees all of them. The email dispatcher enumerates organisations through the runtime connection, so without this function it found
 * nothing and sent nothing. This is the same pattern as core.worker_list_workspaces: a bounded, keyset-paginated SECURITY DEFINER
 * function owned by rab_owner, with a fixed search_path, PUBLIC EXECUTE revoked, EXECUTE granted to rab_app only.
 *
 * It returns organisation ids and nothing else: no name, status, owner or identity column, and no caller-selected scope.
 */
export class WorkerOrganisationDiscovery1786676700000 implements MigrationInterface {
  name = 'WorkerOrganisationDiscovery1786676700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION core.worker_list_organisations(p_after uuid, p_limit integer)
      RETURNS TABLE (organisation_id uuid)
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = core, pg_catalog
      AS $function$
        SELECT o.id
          FROM core.organisation o
         WHERE (p_after IS NULL OR o.id > p_after)
         ORDER BY o.id
         LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 100)
      $function$;
    `);
    await queryRunner.query(`REVOKE ALL ON FUNCTION core.worker_list_organisations(uuid, integer) FROM PUBLIC;`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION core.worker_list_organisations(uuid, integer) TO rab_app;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP FUNCTION IF EXISTS core.worker_list_organisations(uuid, integer);`);
  }
}
