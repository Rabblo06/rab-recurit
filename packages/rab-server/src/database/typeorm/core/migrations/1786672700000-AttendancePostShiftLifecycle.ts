import { MigrationInterface, QueryRunner } from 'typeorm';

/** Milestones are orthogonal to payroll review/approval; existing RLS is retained. */
export class AttendancePostShiftLifecycle1786672700000 implements MigrationInterface {
  name = 'AttendancePostShiftLifecycle1786672700000';
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`ALTER TABLE core.attendance
      ADD COLUMN post_shift_completed_at timestamptz,
      ADD COLUMN post_shift_expired_at timestamptz,
      ADD CONSTRAINT attendance_post_shift_order CHECK (
        (post_shift_completed_at IS NULL OR (clock_out_at IS NOT NULL AND post_shift_completed_at = clock_out_at + interval '2 hours'))
        AND (post_shift_expired_at IS NULL OR (post_shift_completed_at IS NOT NULL AND post_shift_expired_at = clock_out_at + interval '6 hours'))
      )`);
    await runner.query(`CREATE FUNCTION core.reset_attendance_post_shift() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.clock_out_at IS DISTINCT FROM OLD.clock_out_at THEN
          NEW.post_shift_completed_at := NULL;
          NEW.post_shift_expired_at := NULL;
        END IF;
        RETURN NEW;
      END $$`);
    await runner.query(`CREATE TRIGGER attendance_post_shift_reset BEFORE UPDATE OF clock_out_at ON core.attendance
      FOR EACH ROW EXECUTE FUNCTION core.reset_attendance_post_shift()`);
    await runner.query(`CREATE INDEX attendance_post_shift_due ON core.attendance(clock_out_at)
      WHERE clock_out_at IS NOT NULL AND post_shift_expired_at IS NULL`);
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query(
      'DROP TRIGGER attendance_post_shift_reset ON core.attendance',
    );
    await runner.query('DROP FUNCTION core.reset_attendance_post_shift()');
    await runner.query('DROP INDEX core.attendance_post_shift_due');
    await runner.query(`ALTER TABLE core.attendance DROP CONSTRAINT attendance_post_shift_order,
      DROP COLUMN post_shift_expired_at, DROP COLUMN post_shift_completed_at`);
  }
}
