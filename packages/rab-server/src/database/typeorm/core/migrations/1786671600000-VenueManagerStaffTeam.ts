import { MigrationInterface, QueryRunner } from 'typeorm';

/** Explicit working team; never creates or changes a shift assignment. */
export class VenueManagerStaffTeam1786671600000 implements MigrationInterface {
  name = 'VenueManagerStaffTeam1786671600000';
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE TABLE core.venue_manager_staff (
      organisation_id uuid NOT NULL REFERENCES core.organisation(id),
      workspace_id uuid NOT NULL REFERENCES core.manager_workspace(id),
      manager_profile_id uuid NOT NULL REFERENCES core.manager_profile(id) ON DELETE CASCADE,
      staff_profile_id uuid NOT NULL REFERENCES core.staff_profile(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (manager_profile_id, staff_profile_id)
    )`);
    await runner.query(`CREATE INDEX venue_manager_staff_org_idx ON core.venue_manager_staff(organisation_id, workspace_id)`);
    await runner.query(`ALTER TABLE core.venue_manager_staff ENABLE ROW LEVEL SECURITY`);
    await runner.query(`ALTER TABLE core.venue_manager_staff FORCE ROW LEVEL SECURITY`);
    const scope = `organisation_id = core.current_org()
      AND EXISTS (SELECT 1 FROM core.manager_profile mp
        JOIN core.manager_venue mv ON mv.manager_profile_id = mp.id
        JOIN core.venue v ON v.id = mv.venue_id
        WHERE mp.id = venue_manager_staff.manager_profile_id
          AND mp.user_id = core.current_uid() AND mp.type = 'venue'
          AND v.organisation_id = venue_manager_staff.organisation_id
          AND v.workspace_id = venue_manager_staff.workspace_id)
      AND EXISTS (SELECT 1 FROM core.staff_profile sp
        WHERE sp.id = venue_manager_staff.staff_profile_id
          AND sp.organisation_id = venue_manager_staff.organisation_id
          AND sp.workspace_id = venue_manager_staff.workspace_id)`;
    await runner.query(`CREATE POLICY venue_manager_staff_scope ON core.venue_manager_staff
      USING (${scope}) WITH CHECK (${scope}
        AND EXISTS (SELECT 1 FROM core.staff_profile sp JOIN core."user" u ON u.id = sp.user_id
          WHERE sp.id = venue_manager_staff.staff_profile_id AND u.status = 'active')
        AND EXISTS (SELECT 1 FROM core.user_role ur JOIN core.role r ON r.id = ur.role_id
          WHERE ur.user_id = core.current_uid() AND r.key = 'venue_manager'))`);
    await runner.query(`GRANT SELECT, INSERT ON core.venue_manager_staff TO rab_app`);
    await runner.query(`REVOKE UPDATE, DELETE ON core.venue_manager_staff FROM rab_app`);
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`DROP TABLE core.venue_manager_staff`);
  }
}
