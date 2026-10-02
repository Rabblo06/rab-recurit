import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Same class of fix as `JobRoleWorkspaceScopedUniqueness1786674400000`, for
 * `staff_profile`: `UNIQUE (organisation_id, staff_ref)` (from
 * `OperationalSchema1786665900000`) predates `workspace_id` (added later for
 * the Private Workspace model) and never caught up to it.
 *
 * Staff belong to their creating Manager's private Workspace — the same
 * ownership model `job_role` already follows. Organisation-wide uniqueness on
 * `staff_ref` means one Manager's Staff Reference silently "reserves" that
 * reference for every OTHER Manager's private Workspace in the same
 * organisation too, with no way for them to see why. Staff Reference is also
 * becoming server-generated and workspace-scoped as of this change (see
 * `StaffService.generateStaffRef`) — the DB constraint must match the scope
 * the generator actually serializes against, or the generator's own
 * workspace-scoped "next number" scan could still collide with a sibling
 * workspace's existing reference under the old constraint.
 *
 * `workspace_id` is nullable (rows predating the Private Workspace migration,
 * or with no resolvable creator — see `WorkspaceBackfill1786668000000`'s own
 * doc comment: "never guessed"). As with the `job_role` migration, Postgres
 * treats NULL as distinct from NULL in a UNIQUE constraint, so that
 * already-quarantined legacy population is no longer deduplicated against
 * itself by this constraint — an accepted, narrow trade-off, unchanged in
 * kind from the one already shipped for `job_role`.
 */
export class StaffReferenceWorkspaceScopedUniqueness1786674500000 implements MigrationInterface {
  name = 'StaffReferenceWorkspaceScopedUniqueness1786674500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE core.staff_profile DROP CONSTRAINT staff_profile_organisation_id_staff_ref_key;`);
    await queryRunner.query(`
      ALTER TABLE core.staff_profile
        ADD CONSTRAINT staff_profile_organisation_id_workspace_id_staff_ref_key UNIQUE (organisation_id, workspace_id, staff_ref);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE core.staff_profile DROP CONSTRAINT staff_profile_organisation_id_workspace_id_staff_ref_key;`);
    await queryRunner.query(`
      ALTER TABLE core.staff_profile
        ADD CONSTRAINT staff_profile_organisation_id_staff_ref_key UNIQUE (organisation_id, staff_ref);
    `);
  }
}
