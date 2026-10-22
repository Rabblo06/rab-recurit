import { MigrationInterface, QueryRunner } from 'typeorm';
import { attendanceCheckInSql } from '../../workspace-schema/v1/attendance-check-in';

/**
 * Check In → Clock In → Clock Out and Venue Manager on-behalf punches (see `attendanceCheckInSql`). Additive columns +
 * CHECKs + two reviewer-style FKs to core."user" on shift_assignment / attendance, in core and every provisioned
 * workspace schema (the provisioner applies the same SQL; V1_EXPECTED.foreignKeys 126 -> 128). No new table, so no new
 * RLS policy: both tables keep their existing ENABLE + FORCE row-level policies, which are column-agnostic.
 *
 * Rollout rule (FLAGGED): `check_in_required` is added DEFAULT false — every booking existing at migration time (past,
 * active or future) keeps the old Clock In flow — and the default then flips to true for bookings created afterwards.
 * No row is updated or back-filled; no check-in is ever fabricated.
 */
export class AttendanceCheckIn1786719450000 implements MigrationInterface {
  name = 'AttendanceCheckIn1786719450000';

  private async schemas(runner: QueryRunner): Promise<string[]> {
    const rows: Array<{ schema_name: string }> = await runner.query(`
      SELECT n.nspname AS schema_name FROM pg_namespace n
      JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = 'shift_assignment' AND c.relkind = 'r'
      WHERE n.nspname = 'core' OR n.nspname ~ '^workspace_[0-9a-f]{32}$'
    `);
    return rows.map((row) => row.schema_name);
  }

  async up(runner: QueryRunner): Promise<void> {
    for (const schema of await this.schemas(runner)) await runner.query(attendanceCheckInSql(schema));
  }

  /** Drops the new columns and restores the clock-out method CHECK (fails by design if an on-behalf punch exists). */
  async down(runner: QueryRunner): Promise<void> {
    for (const schema of await this.schemas(runner)) {
      const q = schema === 'core' ? 'core' : `"${schema}"`;
      await runner.query(`ALTER TABLE ${q}.attendance DROP CONSTRAINT IF EXISTS attendance_clock_in_by_fkey,
        DROP CONSTRAINT IF EXISTS attendance_clock_out_by_fkey, DROP CONSTRAINT IF EXISTS attendance_on_behalf_check,
        DROP COLUMN IF EXISTS clock_in_method, DROP COLUMN IF EXISTS clock_in_by, DROP COLUMN IF EXISTS clock_in_reason,
        DROP COLUMN IF EXISTS clock_out_by, DROP COLUMN IF EXISTS clock_out_reason, DROP COLUMN IF EXISTS clock_in_captured_at;`);
      await runner.query(`ALTER TABLE ${q}.attendance DROP CONSTRAINT IF EXISTS attendance_clock_out_method_check;`);
      await runner.query(`ALTER TABLE ${q}.attendance ADD CONSTRAINT attendance_clock_out_method_check
        CHECK (clock_out_method IS NULL OR clock_out_method IN ('manual', 'auto_geofence', 'manager_correction'));`);
      await runner.query(`ALTER TABLE ${q}.shift_assignment DROP CONSTRAINT IF EXISTS shift_assignment_check_in_check,
        DROP COLUMN IF EXISTS check_in_required, DROP COLUMN IF EXISTS checked_in_at, DROP COLUMN IF EXISTS check_in_source,
        DROP COLUMN IF EXISTS check_in_location_verified, DROP COLUMN IF EXISTS check_in_distance_m,
        DROP COLUMN IF EXISTS check_in_accuracy_m, DROP COLUMN IF EXISTS check_in_captured_at;`);
    }
  }
}
