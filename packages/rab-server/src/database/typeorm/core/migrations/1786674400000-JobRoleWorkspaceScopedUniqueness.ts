import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Fixes a real production incident: `core.job_role`'s uniqueness
 * (`UNIQUE (organisation_id, name)`, from `SchedulingSchema1786666000000`)
 * predates `workspace_id`/`created_by` (added later by
 * `WorkspaceIdExpand1786667600000` /
 * `VenueJobRoleOwnershipSchema1786667200000`) and was never updated to
 * match the Private Workspace model those introduced.
 *
 * `SchedulingService.listJobRoles` already scopes visibility per Manager
 * (`WHERE created_by = ctx.userId` for an 'owner'-scope caller — see that
 * method's own doc comment) — job roles are intentionally private per
 * Manager workspace, the same way a Manager's own staff/venues are. But the
 * org-wide uniqueness constraint didn't agree: a role named "Waiter"
 * created in one Manager's private workspace silently blocked every OTHER
 * Manager in the same organisation from ever creating their own "Waiter",
 * even though they could never see, select, or know about the first one —
 * confirmed in production as an unhandled 500 on the resulting unique-
 * violation (see `SchedulingService.createJobRole`'s now-added 23505-to-409
 * handling, which surfaced this).
 *
 * The fix scopes uniqueness down to match the existing privacy boundary —
 * per workspace, not per organisation — rather than loosening visibility to
 * match uniqueness (which would actually leak one Manager's private job
 * roles into another's view).
 *
 * `workspace_id` is nullable (rows predating the Private Workspace
 * migration, or with no resolvable creator — see `WorkspaceBackfill
 * 1786668000000`'s own doc comment: "never guessed"). Postgres treats NULL
 * as distinct from NULL in a UNIQUE constraint, so legacy/unresolved rows
 * are no longer deduplicated against each other by this constraint — an
 * accepted, narrow trade-off for that one quarantined legacy population,
 * consistent with how the rest of the Private Workspace migration already
 * treats unresolved `workspace_id = NULL` rows (left alone, never guessed,
 * never force-merged).
 */
export class JobRoleWorkspaceScopedUniqueness1786674400000 implements MigrationInterface {
  name = 'JobRoleWorkspaceScopedUniqueness1786674400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE core.job_role DROP CONSTRAINT job_role_organisation_id_name_key;`);
    await queryRunner.query(`
      ALTER TABLE core.job_role
        ADD CONSTRAINT job_role_organisation_id_workspace_id_name_key UNIQUE (organisation_id, workspace_id, name);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE core.job_role DROP CONSTRAINT job_role_organisation_id_workspace_id_name_key;`);
    await queryRunner.query(`
      ALTER TABLE core.job_role
        ADD CONSTRAINT job_role_organisation_id_name_key UNIQUE (organisation_id, name);
    `);
  }
}
