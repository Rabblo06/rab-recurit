import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Stage 2A step 6 correction — a real bug in
 * `VenueManagerAssignmentRlsFix1786668300000`'s own `EXISTS` subqueries,
 * found via direct reproduction (a Venue Manager's `GET /venues` returning
 * empty despite a real, correctly-stamped `manager_venue` assignment row).
 *
 * That migration's `venue_tenant` clause wrote `WHERE mv.venue_id = id`,
 * intending the bare `id` to correlate to the outer `venue` row being
 * checked. It doesn't: `core.manager_profile` (joined into the same
 * subquery as `mp`) also has a column named `id`, and Postgres resolves an
 * unqualified column name against the NEAREST enclosing scope first — the
 * subquery's own FROM list, not the outer correlated row. The clause
 * silently became `mv.venue_id = mp.id`, which is never true for real data,
 * so the whole grant silently failed (under-permissive — breaks the
 * feature, not a security hole).
 *
 * `shift_tenant`'s equivalent clause, `WHERE mv.venue_id = venue_id`, has
 * the OPPOSITE, more serious problem: `core.manager_venue` (`mv`) itself
 * has a column named `venue_id`, so the bare right-hand `venue_id` resolved
 * to `mv.venue_id` — making the clause `mv.venue_id = mv.venue_id`, a
 * tautology, completely disconnected from the outer `shift` row. This is
 * OVER-permissive: confirmed by direct reproduction, it means the `EXISTS`
 * branch evaluates true for ANY shift in the organisation the instant a
 * Venue Manager has ANY `manager_venue` assignment at all — a real, live
 * cross-venue data leak for every Venue Manager account, not merely a
 * broken feature. `shift_assignment_tenant`/`job_offer_tenant`/
 * `attendance_tenant`'s equivalent clauses were checked against every
 * column name in their own subqueries and confirmed NOT to collide — but
 * are re-qualified here anyway, defensively, using the same explicit
 * table-name-as-correlation-qualifier fix, so no clause in this whole
 * migration set relies on implicit/bare-name scoping ever again.
 *
 * The fix, for every clause: qualify every correlated outer-table column
 * reference with the outer table's own name (Postgres implicitly makes a
 * table's own name a valid range-variable inside its own RLS policy
 * expression — confirmed directly against this database before writing
 * this migration) — never a bare column name that a joined subquery table
 * could also own.
 */
export class VenueManagerAssignmentRlsShadowFix1786668500000 implements MigrationInterface {
  name = 'VenueManagerAssignmentRlsShadowFix1786668500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER POLICY manager_venue_tenant ON core.manager_venue
        USING (
          organisation_id = core.current_org() AND (
            workspace_id = core.current_workspace()
            OR EXISTS (
              SELECT 1 FROM core.manager_profile mp
              WHERE mp.id = manager_venue.manager_profile_id AND mp.user_id = core.current_uid()
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
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reverts to VenueManagerAssignmentRlsFix1786668300000's (buggy) shapes
    // — this migration is a pure predicate correction, not a new grant, so
    // its own down() restores the prior (broken) state for symmetry rather
    // than re-deriving a third shape.
    await queryRunner.query(`
      ALTER POLICY attendance_tenant ON core.attendance
        USING (
          organisation_id = core.current_org() AND (
            workspace_id = core.current_workspace()
            OR EXISTS (
              SELECT 1 FROM core.shift s
              JOIN core.manager_venue mv ON mv.venue_id = s.venue_id
              JOIN core.manager_profile mp ON mp.id = mv.manager_profile_id
              WHERE s.id = shift_id AND mp.user_id = core.current_uid()
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
              WHERE sa.id = shift_assignment_id AND mp.user_id = core.current_uid()
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
              WHERE s.id = shift_id AND mp.user_id = core.current_uid()
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
              WHERE mv.venue_id = venue_id AND mp.user_id = core.current_uid()
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
              WHERE mv.venue_id = id AND mp.user_id = core.current_uid()
            )
          )
        )
        WITH CHECK (organisation_id = core.current_org() AND workspace_id = core.current_workspace());
    `);
    await queryRunner.query(`
      ALTER POLICY manager_venue_tenant ON core.manager_venue
        USING (
          organisation_id = core.current_org() AND (
            workspace_id = core.current_workspace()
            OR EXISTS (
              SELECT 1 FROM core.manager_profile mp
              WHERE mp.id = manager_profile_id AND mp.user_id = core.current_uid()
            )
          )
        )
        WITH CHECK (organisation_id = core.current_org() AND workspace_id = core.current_workspace());
    `);
  }
}
