import { MigrationInterface, QueryRunner } from 'typeorm';

/** Request intent only; approved assignment uses its existing period. No historical backfill or RLS changes. */
export class RequestAssignmentTimes1786674200000 implements MigrationInterface {
  name = 'RequestAssignmentTimes1786674200000';
  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE core.shift_request_staff ADD COLUMN starts_at timestamptz, ADD COLUMN ends_at timestamptz,
      ADD CONSTRAINT request_staff_window CHECK ((starts_at IS NULL AND ends_at IS NULL) OR (starts_at IS NOT NULL AND ends_at IS NOT NULL AND starts_at < ends_at))`);
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE core.shift_request_staff DROP CONSTRAINT request_staff_window, DROP COLUMN ends_at, DROP COLUMN starts_at`);
  }
}
