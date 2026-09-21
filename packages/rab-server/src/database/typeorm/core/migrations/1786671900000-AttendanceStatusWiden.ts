import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `core.attendance.status` has carried no CHECK constraint since it was
 * created (`AttendanceSchema1786667000000` — plain `text default 'active'`),
 * and the application only ever wrote two values (`active`/`completed`) via
 * a small local enum in `modules/attendance/constants/attendance-status.ts`.
 * A richer, already-designed `AttendanceStatus`/`ATTENDANCE_TRANSITIONS` pair
 * has sat unused in `@rab/shared` since before this table existed (matching
 * `rab-ui`'s `statusColor` tokens, which already cover all ten values) — this
 * migration adopts it as the one real status model, replacing the local enum
 * (see `AttendanceService`/`attendance-monitor.job.ts`, updated alongside).
 *
 * Data remap: `'active' -> 'clocked_in'` (an attendance in progress — exact
 * same meaning). `'completed' -> 'clocked_out'`, deliberately NOT
 * `'approved'` — the transition table only ever allows clock-out to land on
 * `clocked_out`; `approved` is reachable solely through the new Venue
 * Manager finalisation step this feature adds. Mapping historical rows
 * straight to `approved` would fabricate a review that never took place, so
 * every pre-existing "completed" shift now surfaces as `clocked_out` — an
 * honest "never reviewed under the old system", not a silently-invented
 * approval. No `approvedAt`/`approvedBy` is backfilled for these rows.
 *
 * `attendance_one_active_per_staff` (the real race-condition backstop for
 * double clock-in) widens from `WHERE status = 'active'` to
 * `WHERE status IN ('clocked_in','on_break')` — a staff member on a break
 * still holds their one open attendance slot. `on_break` is not written by
 * any code path this feature ships (no staff-facing break button — see
 * `attendance.service.ts`), but the index covers it regardless so the
 * invariant holds if a future feature ever does set it.
 */
export class AttendanceStatusWiden1786671900000 implements MigrationInterface {
  name = 'AttendanceStatusWiden1786671900000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Same "migration connection binds no tenant context, so a FORCE-RLS'd
    // table's rows are invisible to a plain UPDATE" reasoning as
    // OfferConfirmationSchema1786666100000 — disable/re-enable RLS around
    // the cross-tenant remap only, restored before the transaction commits.
    await queryRunner.query(`ALTER TABLE core.attendance DISABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`UPDATE core.attendance SET status = 'clocked_in' WHERE status = 'active';`);
    await queryRunner.query(`UPDATE core.attendance SET status = 'clocked_out' WHERE status = 'completed';`);
    await queryRunner.query(`ALTER TABLE core.attendance ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE core.attendance FORCE ROW LEVEL SECURITY;`);

    await queryRunner.query(`
      ALTER TABLE core.attendance
        ADD CONSTRAINT attendance_status_check
        CHECK (status IN ('scheduled','clocked_in','on_break','clocked_out','late',
                           'missing_clock_out','absent','under_review','approved','disputed'));
    `);

    await queryRunner.query(`DROP INDEX core.attendance_one_active_per_staff;`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX attendance_one_active_per_staff ON core.attendance (staff_profile_id)
        WHERE status IN ('clocked_in', 'on_break');
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX core.attendance_one_active_per_staff;`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX attendance_one_active_per_staff ON core.attendance (staff_profile_id)
        WHERE status = 'active';
    `);

    await queryRunner.query(`ALTER TABLE core.attendance DROP CONSTRAINT attendance_status_check;`);

    await queryRunner.query(`ALTER TABLE core.attendance DISABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`UPDATE core.attendance SET status = 'active' WHERE status = 'clocked_in';`);
    await queryRunner.query(`UPDATE core.attendance SET status = 'completed' WHERE status = 'clocked_out';`);
    await queryRunner.query(`ALTER TABLE core.attendance ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE core.attendance FORCE ROW LEVEL SECURITY;`);
  }
}
