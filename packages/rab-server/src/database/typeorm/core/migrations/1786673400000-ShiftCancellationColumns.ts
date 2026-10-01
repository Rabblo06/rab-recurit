import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PHASE 5 — `core.shift` already stamps who/when for `approved`/`declined`
 * (`approved_by`/`approved_at`, `declined_by`/`declined_at`); `cancelled`
 * had only `cancelled_reason`, no actor/timestamp, even though cancellation
 * is the one shift-lifecycle transition most likely to need a "who did
 * this and when" audit trail later (payroll disputes, venue complaints).
 * Matches the existing pattern exactly rather than inventing a new shape.
 */
export class ShiftCancellationColumns1786673400000 implements MigrationInterface {
  name = 'ShiftCancellationColumns1786673400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE core.shift ADD COLUMN cancelled_by uuid REFERENCES core."user"(id);`);
    await queryRunner.query(`ALTER TABLE core.shift ADD COLUMN cancelled_at timestamptz;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE core.shift DROP COLUMN cancelled_at;`);
    await queryRunner.query(`ALTER TABLE core.shift DROP COLUMN cancelled_by;`);
  }
}
