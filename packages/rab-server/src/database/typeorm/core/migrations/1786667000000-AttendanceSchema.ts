import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `core.attendance` — one row per clock-in, driving the real Clock In/Out
 * feature. `UNIQUE(shift_assignment_id)`: an assignment can be attended at
 * most once, ever. The partial unique index on `(staff_profile_id) WHERE
 * status = 'active'` is the actual race-condition backstop for "two
 * simultaneous clock-in requests" — the service catches the resulting
 * unique-violation and returns 409, mirroring `shift_assignment_no_double_
 * booking`'s exclusion-constraint precedent (SchedulingSchema) and
 * `admin_inspect_session_active_idx`'s partial-index precedent (Piece 4,
 * earlier this session) — never relying on a bare SELECT-then-INSERT alone.
 *
 * Also backfills the one missing permission-catalogue piece: `attendance.
 * clock` (self-service clock in/out) didn't exist before this migration —
 * `attendance.view`/`.edit`/`.approve`/`.clock_override` (manager-facing)
 * already did, already wired into every manager `ROLE_DEFS`. Every already-
 * existing `staff` role across every org gets it granted here — `ensureStaffRole()`'s
 * lazy-create path only grants `STAFF_ROLE_PERMISSIONS` to a role it creates
 * fresh, never syncs an already-existing role's permission set.
 */
export class AttendanceSchema1786667000000 implements MigrationInterface {
  name = 'AttendanceSchema1786667000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE core.attendance (
        id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organisation_id     uuid NOT NULL REFERENCES core.organisation(id) ON DELETE CASCADE,
        shift_assignment_id uuid NOT NULL UNIQUE REFERENCES core.shift_assignment(id) ON DELETE CASCADE,
        shift_id            uuid NOT NULL REFERENCES core.shift(id) ON DELETE CASCADE,
        staff_profile_id    uuid NOT NULL REFERENCES core.staff_profile(id) ON DELETE CASCADE,
        clock_in_at         timestamptz NOT NULL,
        clock_out_at        timestamptz,
        status              text NOT NULL DEFAULT 'active',
        worked_minutes      integer,
        earned_pence        bigint,
        created_at          timestamptz NOT NULL DEFAULT now(),
        updated_at          timestamptz NOT NULL DEFAULT now()
      );
    `);
    // The race-condition backstop: at most one 'active' row per staff member.
    await queryRunner.query(`
      CREATE UNIQUE INDEX attendance_one_active_per_staff ON core.attendance (staff_profile_id)
        WHERE status = 'active';
    `);
    await queryRunner.query(`CREATE INDEX attendance_staff_history_idx ON core.attendance (staff_profile_id, created_at DESC);`);
    await queryRunner.query(`CREATE INDEX attendance_shift_idx ON core.attendance (shift_id);`);

    await queryRunner.query(`ALTER TABLE core.attendance ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE core.attendance FORCE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY attendance_tenant ON core.attendance
        USING (organisation_id = core.current_org())
        WITH CHECK (organisation_id = core.current_org());
    `);

    await queryRunner.query(`
      INSERT INTO core.permission (key, resource, action)
      VALUES ('attendance.clock', 'attendance', 'clock')
      ON CONFLICT (key) DO NOTHING;
    `);

    // Both core.role (read side of this backfill's CROSS JOIN) and
    // core.role_permission (write side) are FORCE-RLS'd; a migration
    // connection binds no tenant context, so core.current_org() is NULL and
    // every FORCE-RLS'd row is invisible unless RLS is disabled first —
    // same standard bracket already used for cross-org backfills this
    // session (e.g. ResourceOwnershipSchema1786666700000), just needed on
    // both tables here since one is read from and the other written to.
    await queryRunner.query(`ALTER TABLE core.role DISABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE core.role_permission DISABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      INSERT INTO core.role_permission (organisation_id, role_id, permission_id)
      SELECT r.organisation_id, r.id, p.id
      FROM core.role r
      CROSS JOIN core.permission p
      WHERE r.key = 'staff' AND p.key = 'attendance.clock'
      ON CONFLICT DO NOTHING;
    `);
    await queryRunner.query(`ALTER TABLE core.role_permission ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE core.role_permission FORCE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE core.role ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE core.role FORCE ROW LEVEL SECURITY;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS core.attendance`);
  }
}
