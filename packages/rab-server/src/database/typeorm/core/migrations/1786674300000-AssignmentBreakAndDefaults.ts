import { MigrationInterface, QueryRunner } from 'typeorm';
export class AssignmentBreakAndDefaults1786674300000 implements MigrationInterface {
  name = 'AssignmentBreakAndDefaults1786674300000';
  async up(q: QueryRunner): Promise<void> {
    for (const table of ['shift_request_staff', 'shift_assignment']) {
      await q.query(`ALTER TABLE core.${table} ADD COLUMN break_minutes integer NULL CHECK (break_minutes IS NULL OR break_minutes >= 0)`);
    }
    await q.query(`ALTER TABLE core.shift ADD COLUMN default_starts_at timestamptz NULL, ADD COLUMN default_ends_at timestamptz NULL,
      ADD CONSTRAINT shift_default_window CHECK ((default_starts_at IS NULL AND default_ends_at IS NULL) OR (default_starts_at IS NOT NULL AND default_ends_at IS NOT NULL AND default_starts_at < default_ends_at))`);
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE core.shift DROP CONSTRAINT shift_default_window, DROP COLUMN default_starts_at, DROP COLUMN default_ends_at`);
    for (const table of ['shift_request_staff', 'shift_assignment']) await q.query(`ALTER TABLE core.${table} DROP COLUMN break_minutes`);
  }
}
