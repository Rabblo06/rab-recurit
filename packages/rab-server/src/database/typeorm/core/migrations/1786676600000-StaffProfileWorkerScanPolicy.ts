import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Worker system-context read path for Staff rows (Twenty-style runtime cutover, owner decision: the worker runs as rab_app, with no
 * impersonated user).
 *
 * Adds ONE permissive SELECT policy on core.staff_profile. It is true only when the server has bound rab.actor_type = 'worker' for
 * this transaction AND the row's organisation and workspace equal the bound context. It is additive: the human staff_profile_select
 * policy is unchanged, so a human session (rab.actor_type unset) sees exactly what it saw before.
 *
 * rab.actor_type is set only by trusted server code (TenantContextService, from an AuthContext built by a worker scan). It is never
 * read from a JWT, a request body, a queue payload or Redis. A worker context grants visibility to the bound workspace's Staff rows;
 * it grants no write, no other table, and no cross-workspace or cross-organisation access.
 *
 * Security trade-off (owner review): rab_app is the same PostgreSQL role for the API and the worker, so a future API code path that
 * binds rab.actor_type = 'worker' would gain this read. The control is code discipline plus the single server-side binding site, not
 * a separate database identity.
 */
export class StaffProfileWorkerScanPolicy1786676600000 implements MigrationInterface {
  name = 'StaffProfileWorkerScanPolicy1786676600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE POLICY staff_profile_worker_scan ON core.staff_profile
        FOR SELECT
        USING (
          current_setting('rab.actor_type', true) = 'worker'
          AND organisation_id = core.current_org()
          AND workspace_id = core.current_workspace()
        );
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP POLICY IF EXISTS staff_profile_worker_scan ON core.staff_profile;`);
  }
}
