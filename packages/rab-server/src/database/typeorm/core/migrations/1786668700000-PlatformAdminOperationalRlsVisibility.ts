import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Stage 2A step 6 correction — a real, confirmed architectural gap: the
 * platform admin's app-layer "see everything in my organisation" behaviour
 * (`ResourceScopeService.resolveTx` returning `{kind: 'admin'}` for
 * `PlatformAdminService.isPlatformAdminTx`, then every service's admin
 * branch running a WHERE-clause-less query) has NO corresponding grant at
 * the RLS layer. The combined `organisation_id = current_org() AND
 * workspace_id = current_workspace()` predicate (plus this session's
 * `manager_venue`-based widening) only ever matches the admin's OWN bound
 * workspace — which is usually a single, specific workspace if they happen
 * to own one, or NULL if they don't (§7's platform-admin redesign: "Admin
 * is no longer a Workspace owner by construction"). Either way, a Venue
 * created inside a DIFFERENT Manager's workspace is invisible to the admin
 * at the DB layer, silently defeating the app layer's own unscoped query —
 * confirmed live: `venue-jobrole-ownership-abuse-cases.integration.spec.ts`'s
 * "the platform admin sees every venue regardless of creator" test got back
 * an empty list, not the expected cross-workspace set.
 *
 * Fix: add a third `OR` branch — "the caller is a platform admin for this
 * organisation" — to the same 6 tables already carrying the combined
 * predicate (`staff_profile`, `venue`, `shift`, `shift_assignment`,
 * `job_offer`, `attendance`), via a direct `EXISTS` against
 * `core.platform_admin_claim` (org-scoped, FORCE'd, but readable here
 * because `organisation_id` IS already bound in any authenticated
 * request's session — unlike the pre-auth `resolve_workspace_for_user`
 * case, this isn't a chicken-and-egg problem, so no `NO FORCE` exemption is
 * needed for `platform_admin_claim` itself). `WITH CHECK` (writes) is left
 * untouched everywhere, matching the `manager_venue` widening's own
 * reasoning: the platform admin path here is a read visibility grant, not
 * a new write-authorization surface — every write still goes through the
 * service layer's own explicit checks.
 */
export class PlatformAdminOperationalRlsVisibility1786668700000 implements MigrationInterface {
  name = 'PlatformAdminOperationalRlsVisibility1786668700000';

  private readonly adminExists = `
    EXISTS (
      SELECT 1 FROM core.platform_admin_claim pac
      WHERE pac.organisation_id = core.current_org() AND pac.user_id = core.current_uid() AND pac.revoked_at IS NULL
    )
  `;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER POLICY staff_profile_tenant ON core.staff_profile
        USING (
          organisation_id = core.current_org() AND (
            workspace_id = core.current_workspace()
            OR ${this.adminExists}
            OR EXISTS (
              SELECT 1 FROM core.shift_assignment sa
              JOIN core.shift s ON s.id = sa.shift_id
              JOIN core.manager_venue mv ON mv.venue_id = s.venue_id
              JOIN core.manager_profile mp ON mp.id = mv.manager_profile_id
              WHERE sa.staff_profile_id = staff_profile.id AND mp.user_id = core.current_uid()
            )
          )
        )
        WITH CHECK (organisation_id = core.current_org() AND workspace_id = core.current_workspace());
    `);

    await queryRunner.query(`
      ALTER POLICY venue_tenant ON core.venue
        USING (
          organisation_id = core.current_org() AND (
            workspace_id = core.current_workspace()
            OR ${this.adminExists}
            OR EXISTS (
              SELECT 1 FROM core.manager_venue mv
              JOIN core.manager_profile mp ON mp.id = mv.manager_profile_id
              WHERE mv.venue_id = venue.id AND mp.user_id = core.current_uid()
            )
          )
        )
        WITH CHECK (organisation_id = core.current_org() AND workspace_id = core.current_workspace());
    `);

    await queryRunner.query(`
      ALTER POLICY shift_tenant ON core.shift
        USING (
          organisation_id = core.current_org() AND (
            workspace_id = core.current_workspace()
            OR ${this.adminExists}
            OR EXISTS (
              SELECT 1 FROM core.manager_venue mv
              JOIN core.manager_profile mp ON mp.id = mv.manager_profile_id
              WHERE mv.venue_id = shift.venue_id AND mp.user_id = core.current_uid()
            )
          )
        )
        WITH CHECK (organisation_id = core.current_org() AND workspace_id = core.current_workspace());
    `);

    await queryRunner.query(`
      ALTER POLICY shift_assignment_tenant ON core.shift_assignment
        USING (
          organisation_id = core.current_org() AND (
            workspace_id = core.current_workspace()
            OR ${this.adminExists}
            OR EXISTS (
              SELECT 1 FROM core.shift s
              JOIN core.manager_venue mv ON mv.venue_id = s.venue_id
              JOIN core.manager_profile mp ON mp.id = mv.manager_profile_id
              WHERE s.id = shift_assignment.shift_id AND mp.user_id = core.current_uid()
            )
          )
        )
        WITH CHECK (organisation_id = core.current_org() AND workspace_id = core.current_workspace());
    `);

    await queryRunner.query(`
      ALTER POLICY job_offer_tenant ON core.job_offer
        USING (
          organisation_id = core.current_org() AND (
            workspace_id = core.current_workspace()
            OR ${this.adminExists}
            OR EXISTS (
              SELECT 1 FROM core.shift_assignment sa
              JOIN core.shift s ON s.id = sa.shift_id
              JOIN core.manager_venue mv ON mv.venue_id = s.venue_id
              JOIN core.manager_profile mp ON mp.id = mv.manager_profile_id
              WHERE sa.id = job_offer.shift_assignment_id AND mp.user_id = core.current_uid()
            )
          )
        )
        WITH CHECK (organisation_id = core.current_org() AND workspace_id = core.current_workspace());
    `);

    await queryRunner.query(`
      ALTER POLICY attendance_tenant ON core.attendance
        USING (
          organisation_id = core.current_org() AND (
            workspace_id = core.current_workspace()
            OR ${this.adminExists}
            OR EXISTS (
              SELECT 1 FROM core.shift s
              JOIN core.manager_venue mv ON mv.venue_id = s.venue_id
              JOIN core.manager_profile mp ON mp.id = mv.manager_profile_id
              WHERE s.id = attendance.shift_id AND mp.user_id = core.current_uid()
            )
          )
        )
        WITH CHECK (organisation_id = core.current_org() AND workspace_id = core.current_workspace());
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reverts to the pre-admin-grant (manager_venue-only) shapes from
    // VenueManagerAssignmentRlsShadowFix1786668500000 /
    // StaffProfileVenueManagerVisibility1786668600000.
    await queryRunner.query(`
      ALTER POLICY attendance_tenant ON core.attendance
        USING (
          organisation_id = core.current_org() AND (
            workspace_id = core.current_workspace()
            OR EXISTS (
              SELECT 1 FROM core.shift s
              JOIN core.manager_venue mv ON mv.venue_id = s.venue_id
              JOIN core.manager_profile mp ON mp.id = mv.manager_profile_id
              WHERE s.id = attendance.shift_id AND mp.user_id = core.current_uid()
            )
          )
        )
        WITH CHECK (organisation_id = core.current_org() AND workspace_id = core.current_workspace());
    `);
    await queryRunner.query(`
      ALTER POLICY job_offer_tenant ON core.job_offer
        USING (
          organisation_id = core.current_org() AND (
            workspace_id = core.current_workspace()
            OR EXISTS (
              SELECT 1 FROM core.shift_assignment sa
              JOIN core.shift s ON s.id = sa.shift_id
              JOIN core.manager_venue mv ON mv.venue_id = s.venue_id
              JOIN core.manager_profile mp ON mp.id = mv.manager_profile_id
              WHERE sa.id = job_offer.shift_assignment_id AND mp.user_id = core.current_uid()
            )
          )
        )
        WITH CHECK (organisation_id = core.current_org() AND workspace_id = core.current_workspace());
    `);
    await queryRunner.query(`
      ALTER POLICY shift_assignment_tenant ON core.shift_assignment
        USING (
          organisation_id = core.current_org() AND (
            workspace_id = core.current_workspace()
            OR EXISTS (
              SELECT 1 FROM core.shift s
              JOIN core.manager_venue mv ON mv.venue_id = s.venue_id
              JOIN core.manager_profile mp ON mp.id = mv.manager_profile_id
              WHERE s.id = shift_assignment.shift_id AND mp.user_id = core.current_uid()
            )
          )
        )
        WITH CHECK (organisation_id = core.current_org() AND workspace_id = core.current_workspace());
    `);
    await queryRunner.query(`
      ALTER POLICY shift_tenant ON core.shift
        USING (
          organisation_id = core.current_org() AND (
            workspace_id = core.current_workspace()
            OR EXISTS (
              SELECT 1 FROM core.manager_venue mv
              JOIN core.manager_profile mp ON mp.id = mv.manager_profile_id
              WHERE mv.venue_id = shift.venue_id AND mp.user_id = core.current_uid()
            )
          )
        )
        WITH CHECK (organisation_id = core.current_org() AND workspace_id = core.current_workspace());
    `);
    await queryRunner.query(`
      ALTER POLICY venue_tenant ON core.venue
        USING (
          organisation_id = core.current_org() AND (
            workspace_id = core.current_workspace()
            OR EXISTS (
              SELECT 1 FROM core.manager_venue mv
              JOIN core.manager_profile mp ON mp.id = mv.manager_profile_id
              WHERE mv.venue_id = venue.id AND mp.user_id = core.current_uid()
            )
          )
        )
        WITH CHECK (organisation_id = core.current_org() AND workspace_id = core.current_workspace());
    `);
    await queryRunner.query(`
      ALTER POLICY staff_profile_tenant ON core.staff_profile
        USING (
          organisation_id = core.current_org() AND (
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
        WITH CHECK (organisation_id = core.current_org() AND workspace_id = core.current_workspace());
    `);
  }
}
