import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Stage 2A step 6 correction. `OfferService.list()`'s `OFFER_SUMMARY_SELECT`
 * INNER JOINs `core.staff_profile` (to render `staffName` against each
 * offer) — confirmed live: a Venue Manager's `GET /offers` at their
 * assigned venue came back empty despite the `job_offer` row itself being
 * correctly RLS-visible (per `VenueManagerAssignmentRlsShadowFix`), because
 * the offer's recipient `staff_profile` row — created by, and workspace-
 * stamped to, the actual workspace-owning Manager, never the Venue Manager
 * — fails `staff_profile`'s own combined org+workspace RLS predicate for
 * the Venue Manager's session (`current_workspace()` is NULL; they don't
 * own a workspace), silently dropping the whole joined row.
 *
 * Fix: the same `manager_venue`-based `OR EXISTS` grant already applied to
 * venue/shift/shift_assignment/job_offer/attendance, scoped through the
 * actual relationship that matters here — "this staff member has a shift
 * assignment at a venue I'm assigned to" — not a blanket grant. This does
 * NOT reopen `StaffService.list()`'s own deliberately-out-of-scope Venue
 * Manager gap (that endpoint's app-layer query is untouched); it only lets
 * the Offer/Shift views render the staff identity they already need to
 * display for data the Venue Manager can otherwise legitimately see.
 */
export class StaffProfileVenueManagerVisibility1786668600000 implements MigrationInterface {
  name = 'StaffProfileVenueManagerVisibility1786668600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
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

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER POLICY staff_profile_tenant ON core.staff_profile
        USING (organisation_id = core.current_org() AND workspace_id = core.current_workspace())
        WITH CHECK (organisation_id = core.current_org() AND workspace_id = core.current_workspace());
    `);
  }
}
