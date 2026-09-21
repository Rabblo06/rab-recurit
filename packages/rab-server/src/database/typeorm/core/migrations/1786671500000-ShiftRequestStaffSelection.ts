import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Venue Manager / Shift Approval workflow, revision 2 — the Venue Manager
 * now names the Staff they want at REQUEST time (`POST /shifts/request`),
 * not the Internal Manager at approval time. No offer/assignment exists yet
 * at that point (offers are still only ever created on approve), so this is
 * a lightweight join table recording pure *intent*, not `ShiftAssignment` —
 * reusing `ShiftAssignment` for this would mean inventing a new status
 * (e.g. "requested") in its shared state machine purely to represent "not
 * an offer yet," rippling into every existing `ShiftAssignment`-consuming
 * query/report that assumes a row there means a real offer was sent.
 *
 * RLS mirrors `shift_assignment_tenant`'s own shape exactly (org + workspace
 * OR the Venue-Manager-via-manager_venue branch, joined through the parent
 * shift) — see PlatformAdminGlobalRedesign1786669400000 for the precedent
 * this copies.
 */
export class ShiftRequestStaffSelection1786671500000 implements MigrationInterface {
  name = 'ShiftRequestStaffSelection1786671500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE core.shift_request_staff (
        organisation_id   uuid NOT NULL REFERENCES core.organisation(id) ON DELETE CASCADE,
        workspace_id      uuid,
        shift_id          uuid NOT NULL REFERENCES core.shift(id) ON DELETE CASCADE,
        staff_profile_id  uuid NOT NULL REFERENCES core.staff_profile(id) ON DELETE CASCADE,
        created_at        timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (shift_id, staff_profile_id)
      );
    `);
    await queryRunner.query(`CREATE INDEX shift_request_staff_shift_idx ON core.shift_request_staff (shift_id);`);
    await queryRunner.query(`CREATE INDEX shift_request_staff_staff_idx ON core.shift_request_staff (staff_profile_id);`);

    await queryRunner.query(`ALTER TABLE core.shift_request_staff ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE core.shift_request_staff FORCE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY shift_request_staff_tenant ON core.shift_request_staff
        USING (
          organisation_id = core.current_org() AND (
            workspace_id = core.current_workspace()
            OR EXISTS (
              SELECT 1 FROM core.shift s
              JOIN core.manager_venue mv ON mv.venue_id = s.venue_id
              JOIN core.manager_profile mp ON mp.id = mv.manager_profile_id
              WHERE s.id = shift_request_staff.shift_id AND mp.user_id = core.current_uid()
            )
          )
        )
        WITH CHECK (organisation_id = core.current_org() AND workspace_id = core.current_workspace());
    `);
    await queryRunner.query(`REVOKE UPDATE ON core.shift_request_staff FROM rab_app;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS core.shift_request_staff;`);
  }
}
