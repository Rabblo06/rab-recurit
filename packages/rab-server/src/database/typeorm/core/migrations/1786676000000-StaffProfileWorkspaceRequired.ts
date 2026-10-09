import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Hyper Workspace Phase 3, GO/NO-GO closure — the NULL-workspace staff residual.
 *
 * Audit result: no product creation path can write a staff_profile with workspace_id NULL. Staff creation calls
 * ResourceScopeService.assertHasWorkspace before its insert (staff.service.ts), and RequireWorkspaceGuard rejects the
 * route first. The only NULL rows in existence are test-planted legacy fixtures.
 *
 * The invariant is enforced by the database for every NEW row, as a CHECK constraint added NOT VALID. NOT VALID means the
 * constraint is checked on every insert and update from now on, but existing rows are not scanned, so a database that holds
 * legacy NULL-workspace rows still migrates. Those rows are NOT assigned a workspace here. They are listed by
 * src/database/typeorm/scripts/audit-null-workspace-staff.sql for manual review before any production migration.
 *
 * Making the column NOT NULL outright is deliberately not done: it would fail on any legacy row and is unsafe to run unreviewed.
 */
export class StaffProfileWorkspaceRequired1786676000000 implements MigrationInterface {
  name = 'StaffProfileWorkspaceRequired1786676000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE core.staff_profile
        ADD CONSTRAINT staff_profile_workspace_required CHECK (workspace_id IS NOT NULL) NOT VALID;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE core.staff_profile DROP CONSTRAINT IF EXISTS staff_profile_workspace_required;`);
  }
}
