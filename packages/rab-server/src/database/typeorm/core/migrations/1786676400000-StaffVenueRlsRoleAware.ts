import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Staff / Venue Manager RLS redesign (Hyper Workspace Phase 3, sub-phase after the composite-FK cutover).
 *
 * Replaces:
 *   staff_profile_tenant           (one ALL policy: organisation, plus the whole workspace, plus shift-assignment visibility)
 *   venue_manager_staff_scope      (read staff_profile to prove staff organisation and workspace, and staff ACTIVE status)
 *
 * With role-aware policies. The RLS boundary answers "which rows may this caller address?". Field minimisation and business
 * rules stay in the service layer (see docs/architecture/HYPER-WORKSPACE-PHASE3-FOUNDATION.md, STAFF / VENUE MANAGER RLS REDESIGN).
 *
 * Classification of the predicates removed from venue_manager_staff:
 *   STRUCTURAL -> now enforced by the composite FKs (staff and manager organisation and workspace must match the row).
 *   SERVICE    -> staff ACTIVE eligibility: addVenueTeamMember and venueStaffPool already filter u.status = 'active'.
 * Kept in RLS: caller organisation and workspace, the Venue Manager profile, the venue relationship inside the caller's workspace,
 * and the venue_manager role (WITH CHECK).
 *
 * Recursion. The new staff_profile policies read only manager_profile and the current_* helpers. venue_manager_staff reads
 * manager_profile, manager_venue, venue, user_role and role, and never staff_profile. No cycle exists, so an access to either
 * table can never re-enter its own policy.
 *
 * Staff visibility (product rule):
 *   STAFF          -> own profile only (user_id = current_uid()).
 *   MANAGER        -> any Staff in the manager's own workspace (the service applies ownership and permissions).
 *   VENUE MANAGER  -> the Staff pool of its own workspace (the service applies ACTIVE eligibility and the projection).
 *   Writes         -> Staff may update their own row only. Managers (type <> 'venue') may insert, update and delete in their
 *                     own workspace. Venue Managers cannot write Staff profiles.
 *   Every rule     -> the row's organisation and workspace must equal the caller's context, so a wrong or missing context yields zero rows.
 *
 * FORCE RLS stays on both tables; this migration does not toggle RLS and does not change any column.
 */
export class StaffVenueRlsRoleAware1786676400000 implements MigrationInterface {
  name = 'StaffVenueRlsRoleAware1786676400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP POLICY IF EXISTS staff_profile_tenant ON core.staff_profile;`);

    await queryRunner.query(`
      CREATE POLICY staff_profile_select ON core.staff_profile
        FOR SELECT
        USING (
          organisation_id = core.current_org()
          AND workspace_id = core.current_workspace()
          AND (
            user_id = core.current_uid()
            OR workspace_id IN (
              SELECT mp.workspace_id FROM core.manager_profile mp
               WHERE mp.user_id = core.current_uid() AND mp.organisation_id = core.current_org()
            )
          )
        );
    `);

    await queryRunner.query(`
      CREATE POLICY staff_profile_insert ON core.staff_profile
        FOR INSERT
        WITH CHECK (
          organisation_id = core.current_org()
          AND workspace_id = core.current_workspace()
          AND workspace_id IN (
            SELECT mp.workspace_id FROM core.manager_profile mp
             WHERE mp.user_id = core.current_uid() AND mp.organisation_id = core.current_org() AND mp.type <> 'venue'
          )
        );
    `);

    await queryRunner.query(`
      CREATE POLICY staff_profile_update ON core.staff_profile
        FOR UPDATE
        USING (
          organisation_id = core.current_org()
          AND workspace_id = core.current_workspace()
          AND (
            user_id = core.current_uid()
            OR workspace_id IN (
              SELECT mp.workspace_id FROM core.manager_profile mp
               WHERE mp.user_id = core.current_uid() AND mp.organisation_id = core.current_org() AND mp.type <> 'venue'
            )
          )
        )
        WITH CHECK (
          organisation_id = core.current_org()
          AND workspace_id = core.current_workspace()
          AND (
            user_id = core.current_uid()
            OR workspace_id IN (
              SELECT mp.workspace_id FROM core.manager_profile mp
               WHERE mp.user_id = core.current_uid() AND mp.organisation_id = core.current_org() AND mp.type <> 'venue'
            )
          )
        );
    `);

    await queryRunner.query(`
      CREATE POLICY staff_profile_delete ON core.staff_profile
        FOR DELETE
        USING (
          organisation_id = core.current_org()
          AND workspace_id = core.current_workspace()
          AND workspace_id IN (
            SELECT mp.workspace_id FROM core.manager_profile mp
             WHERE mp.user_id = core.current_uid() AND mp.organisation_id = core.current_org() AND mp.type <> 'venue'
          )
        );
    `);

    await queryRunner.query(`DROP POLICY IF EXISTS venue_manager_staff_scope ON core.venue_manager_staff;`);
    await queryRunner.query(`
      CREATE POLICY venue_manager_staff_scope ON core.venue_manager_staff
        USING (
          organisation_id = core.current_org()
          AND workspace_id = core.current_workspace()
          AND EXISTS (
            SELECT 1 FROM core.manager_profile mp
              JOIN core.manager_venue mv ON mv.manager_profile_id = mp.id
              JOIN core.venue v ON v.id = mv.venue_id
             WHERE mp.id = venue_manager_staff.manager_profile_id
               AND mp.user_id = core.current_uid()
               AND mp.type = 'venue'
               AND v.organisation_id = venue_manager_staff.organisation_id
               AND v.workspace_id = venue_manager_staff.workspace_id
          )
        )
        WITH CHECK (
          organisation_id = core.current_org()
          AND workspace_id = core.current_workspace()
          AND EXISTS (
            SELECT 1 FROM core.manager_profile mp
              JOIN core.manager_venue mv ON mv.manager_profile_id = mp.id
              JOIN core.venue v ON v.id = mv.venue_id
             WHERE mp.id = venue_manager_staff.manager_profile_id
               AND mp.user_id = core.current_uid()
               AND mp.type = 'venue'
               AND v.organisation_id = venue_manager_staff.organisation_id
               AND v.workspace_id = venue_manager_staff.workspace_id
          )
          AND EXISTS (
            SELECT 1 FROM core.user_role ur
              JOIN core.role r ON r.id = ur.role_id
             WHERE ur.user_id = core.current_uid() AND r.key = 'venue_manager'
          )
        );
    `);
  }

  /** Restores the previous definitions exactly as they were before this migration. */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP POLICY IF EXISTS venue_manager_staff_scope ON core.venue_manager_staff;`);
    await queryRunner.query(`
      CREATE POLICY venue_manager_staff_scope ON core.venue_manager_staff
        USING (
          organisation_id = core.current_org()
          AND EXISTS (
            SELECT 1 FROM core.manager_profile mp
              JOIN core.manager_venue mv ON mv.manager_profile_id = mp.id
              JOIN core.venue v ON v.id = mv.venue_id
             WHERE mp.id = venue_manager_staff.manager_profile_id
               AND mp.user_id = core.current_uid()
               AND mp.type = 'venue'
               AND v.organisation_id = venue_manager_staff.organisation_id
               AND v.workspace_id = venue_manager_staff.workspace_id
          )
          AND EXISTS (
            SELECT 1 FROM core.staff_profile sp
             WHERE sp.id = venue_manager_staff.staff_profile_id
               AND sp.organisation_id = venue_manager_staff.organisation_id
               AND sp.workspace_id = venue_manager_staff.workspace_id
          )
        )
        WITH CHECK (
          organisation_id = core.current_org()
          AND EXISTS (
            SELECT 1 FROM core.manager_profile mp
              JOIN core.manager_venue mv ON mv.manager_profile_id = mp.id
              JOIN core.venue v ON v.id = mv.venue_id
             WHERE mp.id = venue_manager_staff.manager_profile_id
               AND mp.user_id = core.current_uid()
               AND mp.type = 'venue'
               AND v.organisation_id = venue_manager_staff.organisation_id
               AND v.workspace_id = venue_manager_staff.workspace_id
          )
          AND EXISTS (
            SELECT 1 FROM core.staff_profile sp
             WHERE sp.id = venue_manager_staff.staff_profile_id
               AND sp.organisation_id = venue_manager_staff.organisation_id
               AND sp.workspace_id = venue_manager_staff.workspace_id
          )
          AND EXISTS (
            SELECT 1 FROM core.staff_profile sp
              JOIN core."user" u ON u.id = sp.user_id
             WHERE sp.id = venue_manager_staff.staff_profile_id AND u.status = 'active'
          )
          AND EXISTS (
            SELECT 1 FROM core.user_role ur
              JOIN core.role r ON r.id = ur.role_id
             WHERE ur.user_id = core.current_uid() AND r.key = 'venue_manager'
          )
        );
    `);

    await queryRunner.query(`DROP POLICY IF EXISTS staff_profile_delete ON core.staff_profile;`);
    await queryRunner.query(`DROP POLICY IF EXISTS staff_profile_update ON core.staff_profile;`);
    await queryRunner.query(`DROP POLICY IF EXISTS staff_profile_insert ON core.staff_profile;`);
    await queryRunner.query(`DROP POLICY IF EXISTS staff_profile_select ON core.staff_profile;`);
    await queryRunner.query(`
      CREATE POLICY staff_profile_tenant ON core.staff_profile
        USING (
          organisation_id = core.current_org()
          AND (
            workspace_id = core.current_workspace()
            OR EXISTS (
              SELECT 1 FROM core.shift_assignment sa
                JOIN core.shift s ON s.id = sa.shift_id
                JOIN core.manager_venue mv ON mv.venue_id = s.venue_id
                JOIN core.manager_profile mp ON mp.id = mv.manager_profile_id
               WHERE sa.staff_profile_id = staff_profile.id AND mp.user_id = core.current_uid()
            )
          )
        )
        WITH CHECK (
          organisation_id = core.current_org()
          AND workspace_id = core.current_workspace()
        );
    `);
  }
}
