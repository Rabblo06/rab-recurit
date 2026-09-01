import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Stage 2A step 6 correction. `job_role` carried the plain combined
 * `organisation_id = current_org() AND workspace_id = current_workspace()`
 * predicate from `OperationalWorkspaceRlsTransition` and was never extended
 * alongside `venue`/`shift`/`shift_assignment`/`job_offer`/`attendance`/
 * `staff_profile` — a real gap, confirmed live: `OFFER_SUMMARY_SELECT`
 * (`OfferService.list`) INNER JOINs `core.job_role`, and a platform admin's
 * (or Venue Manager's) own `GET /offers`/`GET /shifts` silently dropped
 * every row whose shift referenced a job role created in a DIFFERENT
 * Manager's workspace, for the exact same reason `venue`/`staff_profile`
 * did before their own fixes earlier in this migration set.
 *
 * `job_role` gets a DIFFERENT shape than the other 5 tables, not the same
 * `manager_venue`-join widening — because the already-shipped, already-
 * approved app-layer decision (`SchedulingService.listJobRoles`,
 * "Piece 3" earlier this session) is that EVERY Venue Manager sees EVERY
 * org job role unconditionally ("low-sensitivity reference data, not
 * private business data" — a job role is a name + a default rate, not tied
 * to one venue), not scoped to their specific venue assignments. The RLS
 * grant here matches that decision exactly: workspace match (the owning
 * Manager) OR platform admin OR "the caller holds ANY `venue`-type
 * ManagerProfile in this organisation."
 */
export class JobRoleVenueManagerAndAdminVisibility1786668800000 implements MigrationInterface {
  name = 'JobRoleVenueManagerAndAdminVisibility1786668800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER POLICY job_role_tenant ON core.job_role
        USING (
          organisation_id = core.current_org() AND (
            workspace_id = core.current_workspace()
            OR EXISTS (
              SELECT 1 FROM core.platform_admin_claim pac
              WHERE pac.organisation_id = core.current_org() AND pac.user_id = core.current_uid() AND pac.revoked_at IS NULL
            )
            OR EXISTS (
              SELECT 1 FROM core.manager_profile mp
              WHERE mp.user_id = core.current_uid() AND mp.organisation_id = core.current_org() AND mp.type = 'venue'
            )
          )
        )
        WITH CHECK (organisation_id = core.current_org() AND workspace_id = core.current_workspace());
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER POLICY job_role_tenant ON core.job_role
        USING (organisation_id = core.current_org() AND workspace_id = core.current_workspace())
        WITH CHECK (organisation_id = core.current_org() AND workspace_id = core.current_workspace());
    `);
  }
}
