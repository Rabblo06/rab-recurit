import { MigrationInterface, QueryRunner } from 'typeorm';

/** Venue-level default break duration a Shift can inherit — pairs with the existing `break_paid` boolean (paid/unpaid stays separate from duration). Nullable: existing venues have no default until a Manager sets one. */
export class VenueDefaultBreakMinutes1786671200000 implements MigrationInterface {
  name = 'VenueDefaultBreakMinutes1786671200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE core.venue
        ADD COLUMN default_break_minutes integer CHECK (default_break_minutes IS NULL OR default_break_minutes >= 0);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE core.venue
        DROP COLUMN IF EXISTS default_break_minutes;
    `);
  }
}
