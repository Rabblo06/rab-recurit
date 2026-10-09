import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Hyper Workspace Phase 3 — step 3 of the venue_manager_staff composite-FK cutover.
 *
 * Runs only after migration 2 (NOT VALID composite FKs) and after the structural tests passed against the NOT VALID keys.
 *
 * 1. VALIDATE CONSTRAINT scans the existing team rows against the composite keys. It takes SHARE UPDATE EXCLUSIVE, so
 *    concurrent reads and writes continue. If any existing row violates the new keys, the validation fails and this
 *    migration rolls back; no row is repaired automatically.
 * 2. Only after both validations succeed, the OLD single-column staff and manager foreign keys are dropped. The permanent
 *    state keeps only the composite pair, so the same reference is not defined twice and its cascade does not fire twice.
 *
 * Dropping the single-column keys takes a brief ACCESS EXCLUSIVE lock on venue_manager_staff; it is a catalogue-only operation.
 */
export class VenueManagerStaffCompositeFksValidate1786676300000 implements MigrationInterface {
  name = 'VenueManagerStaffCompositeFksValidate1786676300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE core.venue_manager_staff VALIDATE CONSTRAINT venue_manager_staff_staff_org_ws_fkey;`);
    await queryRunner.query(`ALTER TABLE core.venue_manager_staff VALIDATE CONSTRAINT venue_manager_staff_manager_org_ws_fkey;`);
    await queryRunner.query(`ALTER TABLE core.venue_manager_staff DROP CONSTRAINT venue_manager_staff_staff_profile_id_fkey;`);
    await queryRunner.query(`ALTER TABLE core.venue_manager_staff DROP CONSTRAINT venue_manager_staff_manager_profile_id_fkey;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Restore the previous single-column keys exactly (same names, same ON DELETE CASCADE). They are re-added as validated
    // keys, which scans the table once. Migration 2's composite keys are removed by its own down() afterwards.
    await queryRunner.query(`
      ALTER TABLE core.venue_manager_staff
        ADD CONSTRAINT venue_manager_staff_manager_profile_id_fkey
        FOREIGN KEY (manager_profile_id) REFERENCES core.manager_profile (id) ON DELETE CASCADE;
    `);
    await queryRunner.query(`
      ALTER TABLE core.venue_manager_staff
        ADD CONSTRAINT venue_manager_staff_staff_profile_id_fkey
        FOREIGN KEY (staff_profile_id) REFERENCES core.staff_profile (id) ON DELETE CASCADE;
    `);
  }
}
