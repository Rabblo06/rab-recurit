import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `shift.address` — the location text shown to staff for this specific
 * shift, snapshotted at creation from the venue's address (front-end
 * convenience only, not enforced here) and freely editable afterward
 * without touching `venue.address` itself. Historical shifts keep whatever
 * address was true for them even if the venue's own address changes later.
 * Nullable — older shifts predate this column and have no address on file.
 * `shift` already has RLS enabled+forced from SchedulingSchema1786666000000;
 * a nullable column on an already-covered table needs no new policy.
 */
export class ShiftAddressColumn1786666400000 implements MigrationInterface {
  name = 'ShiftAddressColumn1786666400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE core.shift ADD COLUMN address text;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE core.shift DROP COLUMN address;`);
  }
}
