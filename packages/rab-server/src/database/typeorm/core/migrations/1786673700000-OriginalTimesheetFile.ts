import { MigrationInterface, QueryRunner } from 'typeorm';
export class OriginalTimesheetFile1786673700000 implements MigrationInterface {
  name = 'OriginalTimesheetFile1786673700000';
  async up(q: QueryRunner): Promise<void> {
    await q.query(
      'ALTER TABLE core.shift_report ADD COLUMN original_file_id uuid NULL REFERENCES core.stored_file(id) ON DELETE RESTRICT',
    );
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE core.shift_report DROP COLUMN original_file_id');
  }
}
