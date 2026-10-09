import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Hyper Workspace Phase 3 — step 2 of the venue_manager_staff composite-FK cutover.
 *
 * Adds the two COMPOSITE foreign keys as NOT VALID. From this point every new or updated team row is checked against
 * (id, organisation_id, workspace_id) on the parent: a team row cannot name a staff or manager profile from another
 * organisation or another workspace, and cannot reference a manager profile whose workspace is NULL. Existing rows are not
 * scanned yet (NOT VALID), so this migration takes only a brief lock and does not validate the 453 rows.
 *
 * ON DELETE CASCADE is preserved. ON UPDATE is NO ACTION (the PostgreSQL default, and the same as the existing single-column
 * keys). Both keys are NOT DEFERRABLE, matching the existing constraints.
 *
 * The old single-column keys are still present. They are removed only by migration 3, after validation.
 */
export class VenueManagerStaffCompositeFksNotValid1786676200000 implements MigrationInterface {
  name = 'VenueManagerStaffCompositeFksNotValid1786676200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE core.venue_manager_staff
        ADD CONSTRAINT venue_manager_staff_staff_org_ws_fkey
        FOREIGN KEY (staff_profile_id, organisation_id, workspace_id)
        REFERENCES core.staff_profile (id, organisation_id, workspace_id)
        ON DELETE CASCADE NOT VALID;
    `);
    await queryRunner.query(`
      ALTER TABLE core.venue_manager_staff
        ADD CONSTRAINT venue_manager_staff_manager_org_ws_fkey
        FOREIGN KEY (manager_profile_id, organisation_id, workspace_id)
        REFERENCES core.manager_profile (id, organisation_id, workspace_id)
        ON DELETE CASCADE NOT VALID;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE core.venue_manager_staff DROP CONSTRAINT IF EXISTS venue_manager_staff_manager_org_ws_fkey;`);
    await queryRunner.query(`ALTER TABLE core.venue_manager_staff DROP CONSTRAINT IF EXISTS venue_manager_staff_staff_org_ws_fkey;`);
  }
}
