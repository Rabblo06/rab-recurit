import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `core.attendance_correction` — Parts 42-44. `attendance.edit`/`.approve`/
 * `.clock_override` permission keys already existed in the catalogue since
 * `AttendanceSchema1786667000000` (pre-provisioned, never wired to an
 * endpoint until now) — no new `core.permission` rows needed here.
 *
 * RLS mirrors `core.attendance`'s own CURRENT policy (verified live against
 * the running database, not assumed from `AttendanceSchema`'s original
 * migration text — the real shape was updated later by
 * `PlatformAdminGlobalRedesign1786669400000`): org + workspace match, OR a
 * Venue Manager reached via `manager_venue`, joined one hop further here
 * through `attendance_id -> core.attendance.shift_id -> core.shift.venue_id`
 * since this table has no `shift_id` of its own.
 */
export class AttendanceCorrectionSchema1786672300000 implements MigrationInterface {
  name = 'AttendanceCorrectionSchema1786672300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE core.attendance_correction (
        id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organisation_id  uuid NOT NULL REFERENCES core.organisation(id) ON DELETE CASCADE,
        workspace_id     uuid REFERENCES core.manager_workspace(id),
        attendance_id    uuid NOT NULL REFERENCES core.attendance(id) ON DELETE CASCADE,
        field            text NOT NULL CHECK (field IN ('clockInAt', 'clockOutAt', 'breakMinutes')),
        old_value        text NOT NULL,
        new_value        text NOT NULL,
        reason           text NOT NULL,
        corrected_by     uuid NOT NULL REFERENCES core."user"(id),
        created_at       timestamptz NOT NULL DEFAULT now()
      );
    `);
    await queryRunner.query(`CREATE INDEX attendance_correction_attendance_idx ON core.attendance_correction (attendance_id, created_at DESC);`);

    await queryRunner.query(`ALTER TABLE core.attendance_correction ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE core.attendance_correction FORCE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY attendance_correction_tenant ON core.attendance_correction
        USING (
          organisation_id = core.current_org() AND (
            workspace_id = core.current_workspace()
            OR EXISTS (
              SELECT 1 FROM core.attendance a
              JOIN core.shift s ON s.id = a.shift_id
              JOIN core.manager_venue mv ON mv.venue_id = s.venue_id
              JOIN core.manager_profile mp ON mp.id = mv.manager_profile_id
              WHERE a.id = attendance_correction.attendance_id AND mp.user_id = core.current_uid()
            )
          )
        )
        WITH CHECK (organisation_id = core.current_org() AND workspace_id = core.current_workspace());
    `);
    // Insert-only, like audit_log — a correction is itself an audit record;
    // once written it is never edited or deleted, only superseded by a
    // later correction row.
    await queryRunner.query(`REVOKE UPDATE, DELETE ON core.attendance_correction FROM rab_app;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS core.attendance_correction`);
  }
}
