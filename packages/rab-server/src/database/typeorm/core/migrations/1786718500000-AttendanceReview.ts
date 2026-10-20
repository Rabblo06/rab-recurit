import { MigrationInterface, QueryRunner } from 'typeorm';
import { attendanceReviewSql } from '../../workspace-schema/v1/attendance-review';

/**
 * Explicit per-seat attendance review (see `attendanceReviewSql`). Additive: two nullable columns + a pair CHECK + a
 * reviewer FK on shift_assignment in core and every provisioned workspace schema. No row is changed or back-filled.
 */
export class AttendanceReview1786718500000 implements MigrationInterface {
  name = 'AttendanceReview1786718500000';

  private async schemas(runner: QueryRunner): Promise<string[]> {
    const rows: Array<{ schema_name: string }> = await runner.query(`
      SELECT n.nspname AS schema_name FROM pg_namespace n
      JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = 'shift_assignment' AND c.relkind = 'r'
      WHERE n.nspname = 'core' OR n.nspname ~ '^workspace_[0-9a-f]{32}$'
    `);
    return rows.map((row) => row.schema_name);
  }

  async up(runner: QueryRunner): Promise<void> {
    for (const schema of await this.schemas(runner)) await runner.query(attendanceReviewSql(schema));
  }

  /** Drops the review columns (review completions are lost — down is for a failed rollout only). */
  async down(runner: QueryRunner): Promise<void> {
    for (const schema of await this.schemas(runner)) {
      const t = `${schema === 'core' ? 'core' : `"${schema}"`}.shift_assignment`;
      await runner.query(`ALTER TABLE ${t} DROP CONSTRAINT IF EXISTS shift_assignment_attendance_reviewed_by_fkey,
        DROP CONSTRAINT IF EXISTS shift_assignment_attendance_review_pair_check,
        DROP COLUMN IF EXISTS attendance_reviewed_by, DROP COLUMN IF EXISTS attendance_reviewed_at;`);
    }
  }
}
