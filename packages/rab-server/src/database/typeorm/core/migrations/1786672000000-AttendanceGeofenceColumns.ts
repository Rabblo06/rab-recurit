import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `Venue.lat`/`lng`/`geofenceRadiusM`/`enforceGeofence` have existed since
 * the very first migration — this only adds the columns `Attendance` itself
 * needs to record what was actually checked at clock-in/out time, and how
 * (`clockOutMethod` — Part 37: a geofence-triggered auto-clock-out commits
 * synchronously in the same request as a manual one, distinguished only by
 * this column + a distinct audit action, never by a separate code path).
 */
export class AttendanceGeofenceColumns1786672000000 implements MigrationInterface {
  name = 'AttendanceGeofenceColumns1786672000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE core.attendance
        ADD COLUMN clock_in_lat        numeric(9,6),
        ADD COLUMN clock_in_lng        numeric(9,6),
        ADD COLUMN clock_in_accuracy_m integer,
        ADD COLUMN clock_out_lat       numeric(9,6),
        ADD COLUMN clock_out_lng       numeric(9,6),
        ADD COLUMN clock_out_accuracy_m integer,
        ADD COLUMN location_verified   boolean NOT NULL DEFAULT false,
        ADD COLUMN clock_out_method    text,
        -- Manager-confirmed actual break (Part 42) — no staff-facing break
        -- feature exists; this is settable only via the correction endpoint
        -- (AttendanceCorrectionSchema), added here alongside the entity's
        -- other new nullable columns rather than a separate migration.
        ADD COLUMN break_minutes       integer CHECK (break_minutes IS NULL OR break_minutes >= 0);
    `);
    await queryRunner.query(`
      ALTER TABLE core.attendance
        ADD CONSTRAINT attendance_clock_out_method_check
        CHECK (clock_out_method IS NULL OR clock_out_method IN ('manual', 'auto_geofence', 'manager_correction'));
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE core.attendance DROP CONSTRAINT attendance_clock_out_method_check;`);
    await queryRunner.query(`
      ALTER TABLE core.attendance
        DROP COLUMN clock_in_lat,
        DROP COLUMN clock_in_lng,
        DROP COLUMN clock_in_accuracy_m,
        DROP COLUMN clock_out_lat,
        DROP COLUMN clock_out_lng,
        DROP COLUMN clock_out_accuracy_m,
        DROP COLUMN location_verified,
        DROP COLUMN clock_out_method,
        DROP COLUMN break_minutes;
    `);
  }
}
