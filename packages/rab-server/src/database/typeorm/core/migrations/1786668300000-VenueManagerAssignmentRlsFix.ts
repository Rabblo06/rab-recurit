import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Stage 2A step 6 correction. `OperationalWorkspaceRlsTransition`'s blanket
 * combined `organisation_id = current_org() AND workspace_id =
 * current_workspace()` READ predicate is incompatible with the already-shipped
 * Venue Manager assignment feature (`manager_venue`, built earlier this
 * session): a Venue Manager is deliberately granted read access to specific
 * venues (and, transitively, those venues' shifts/shift-assignments/
 * offers/attendance) OWNED BY ANOTHER MANAGER'S WORKSPACE — that's the whole
 * point of the assignment. A Venue Manager's own `current_workspace()` is
 * NULL (they don't own a workspace), so the blanket predicate silently
 * hides every one of these rows from them, breaking a real, previously
 * working, tested feature (`venue-manager-scoping.integration.spec.ts`'s own
 * "previously always empty" regression test — reproduced live against this
 * migration's own predecessor).
 *
 * Fix: widen the READ (`USING`) side only, on the 6 affected tables, with an
 * `OR EXISTS` grant via `manager_venue` — "this row's venue is one I'm
 * assigned to" — chained through the same FK path each table's own service
 * layer already joins through (`ResourceScopeService`'s `venue` scope kind).
 * `WITH CHECK` (writes) is UNCHANGED on every table here: a Venue Manager
 * never creates/updates any of these rows directly (`VENUE_MANAGER_PERMS`
 * grants only `*_VIEW` flags) — real write authorization stays exactly
 * where it already was (the workspace-owning actor, service-layer-checked).
 *
 * `manager_venue` itself needs the identical widening — under the plain
 * combined-AND predicate a Venue Manager can't even read their OWN
 * assignment rows (those rows carry the ASSIGNING workspace-owner's
 * `workspace_id`, not the Venue Manager's), which would silently defeat
 * `ResourceScopeService.resolveTx`'s own query for "which venues am I
 * assigned to."
 */
export class VenueManagerAssignmentRlsFix1786668300000 implements MigrationInterface {
  name = 'VenueManagerAssignmentRlsFix1786668300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
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
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER POLICY attendance_tenant ON core.attendance
        USING (organisation_id = core.current_org() AND workspace_id = core.current_workspace())
        WITH CHECK (organisation_id = core.current_org() AND workspace_id = core.current_workspace());
    `);
    await queryRunner.query(`
      ALTER POLICY job_offer_tenant ON core.job_offer
        USING (organisation_id = core.current_org() AND workspace_id = core.current_workspace())
        WITH CHECK (organisation_id = core.current_org() AND workspace_id = core.current_workspace());
    `);
    await queryRunner.query(`
      ALTER POLICY shift_assignment_tenant ON core.shift_assignment
        USING (organisation_id = core.current_org() AND workspace_id = core.current_workspace())
        WITH CHECK (organisation_id = core.current_org() AND workspace_id = core.current_workspace());
    `);
    await queryRunner.query(`
      ALTER POLICY shift_tenant ON core.shift
        USING (organisation_id = core.current_org() AND workspace_id = core.current_workspace())
        WITH CHECK (organisation_id = core.current_org() AND workspace_id = core.current_workspace());
    `);
    await queryRunner.query(`
      ALTER POLICY venue_tenant ON core.venue
        USING (organisation_id = core.current_org() AND workspace_id = core.current_workspace())
        WITH CHECK (organisation_id = core.current_org() AND workspace_id = core.current_workspace());
    `);
    await queryRunner.query(`
      ALTER POLICY manager_venue_tenant ON core.manager_venue
        USING (organisation_id = core.current_org() AND workspace_id = core.current_workspace())
        WITH CHECK (organisation_id = core.current_org() AND workspace_id = core.current_workspace());
    `);
  }
}
