import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Hyper Workspace Phase 3, Part 1 — core.staff_profile: FORCE ROW LEVEL SECURITY.
 *
 * Staff profiles are workspace business data (staff_profile_tenant: organisation + current_workspace, or the Venue Manager
 * assignment branch). They were NOT FORCE only because the retired pre-auth resolver (resolve_workspace_for_user) read them
 * as the table owner. No definer function and no authentication path reads them now.
 *
 * Owner-run code that reads staff profiles binds the organisation and each workspace scope itself. The account-invite
 * cleanup job's findBlockingDependency does this for every workspace of the user's organisation.
 * The one residual is a staff profile with NULL workspace_id: under FORCE it is invisible to every scope, which is already
 * true for rab_app. No such row can be created, because staff creation requires a workspace (RequireWorkspaceGuard).
 *
 * No policy semantics change: only the FORCE flag. down() restores NOT FORCE, the state before this migration.
 */
export class StaffProfileForceRls1786675800000 implements MigrationInterface {
  name = 'StaffProfileForceRls1786675800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE core.staff_profile ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE core.staff_profile FORCE ROW LEVEL SECURITY;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE core.staff_profile NO FORCE ROW LEVEL SECURITY;`);
  }
}
