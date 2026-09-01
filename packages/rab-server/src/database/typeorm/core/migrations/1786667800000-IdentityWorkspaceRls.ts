import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Stage 2A step 3 (Revision 3 §1). "Global identity" never meant "globally
 * readable" — `rab_app` is not the table owner, so `ENABLE ROW LEVEL
 * SECURITY` alone already restricts it on every one of these tables
 * regardless of `FORCE`. Dropping RLS entirely (an earlier draft of this
 * migration's own plan) would have handed `rab_app` unrestricted table
 * access the moment any query forgot a `WHERE user_id = ...` — this
 * replaces the legacy `organisation_id`-based predicate with a real
 * `core.current_uid()`-based one on every identity table instead, never
 * "no RLS, trust the service layer."
 *
 * `password_reset_token` gets `USING (false)` — genuinely zero ordinary
 * runtime SELECT capability. A user never lists their own past reset
 * tokens through the app; the only legitimate read path is the pre-auth
 * `auth_find_password_reset_token_org` SECURITY DEFINER function, which
 * bypasses this policy entirely (owner privilege), same as it already does
 * today.
 */
export class IdentityWorkspaceRls1786667800000 implements MigrationInterface {
  name = 'IdentityWorkspaceRls1786667800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Split the same way as user_role/user_permission_override below: a
    // new User row is created BY a Manager/CEO provisioning a Staff/
    // Venue-Manager/Manager account, not by that new user themselves — a
    // self-scoped WITH CHECK would reject every real account-creation
    // INSERT. SELECT is the one that actually needs the narrow rule (a
    // user's own identity, plus identity of people who share their current
    // workspace — the real replacement for the old, much broader
    // organisation-wide visibility).
    await queryRunner.query(`DROP POLICY user_tenant ON core."user";`);
    await queryRunner.query(`
      CREATE POLICY user_select ON core."user"
        FOR SELECT USING (
          id = core.current_uid()
          OR EXISTS (
            SELECT 1 FROM core.staff_profile sp
            WHERE sp.user_id = "user".id AND sp.workspace_id = core.current_workspace()
          )
          OR EXISTS (
            SELECT 1 FROM core.manager_profile mp
            WHERE mp.user_id = "user".id AND mp.workspace_id = core.current_workspace()
          )
        );
    `);
    await queryRunner.query(`
      CREATE POLICY user_write ON core."user"
        FOR INSERT WITH CHECK (true);
    `);
    await queryRunner.query(`
      CREATE POLICY user_update ON core."user"
        FOR UPDATE USING (true) WITH CHECK (true);
    `);
    await queryRunner.query(`
      CREATE POLICY user_delete ON core."user"
        FOR DELETE USING (true);
    `);

    // Split, not a single self-scoped FOR ALL: a role assignment is written
    // by the CREATING Manager/CEO/system (StaffService.create() etc.)
    // during account provisioning, not by the new user themselves — the
    // real confidentiality property worth protecting is that a user can
    // only ever SEE their own authorization state, not that only they can
    // write it. Two command-specific policies, not a FOR ALL + FOR SELECT
    // pair — that combination would OR together on SELECT (multiple
    // permissive policies) and silently defeat the self-scoping entirely,
    // exactly the class of bug this migration's own design review exists
    // to prevent. Real write authorization is enforced upstream by
    // PermissionGuard + the creating service's own checks, matching the
    // existing `login_history_insert`/`login_history_select` split.
    await queryRunner.query(`DROP POLICY user_role_tenant ON core.user_role;`);
    await queryRunner.query(`
      CREATE POLICY user_role_select ON core.user_role
        FOR SELECT USING (user_id = core.current_uid());
    `);
    await queryRunner.query(`
      CREATE POLICY user_role_write ON core.user_role
        FOR INSERT WITH CHECK (true);
    `);
    await queryRunner.query(`
      CREATE POLICY user_role_update ON core.user_role
        FOR UPDATE USING (true) WITH CHECK (true);
    `);
    await queryRunner.query(`
      CREATE POLICY user_role_delete ON core.user_role
        FOR DELETE USING (true);
    `);

    // Same reasoning as user_role above — an override is granted BY an
    // admin/manager TO a user, not self-written. 0 rows in this sandbox
    // today (the feature has no real caller yet), but the same OR-vs-split
    // hazard applies the moment it does.
    await queryRunner.query(`DROP POLICY user_permission_override_tenant ON core.user_permission_override;`);
    await queryRunner.query(`
      CREATE POLICY user_permission_override_select ON core.user_permission_override
        FOR SELECT USING (user_id = core.current_uid());
    `);
    await queryRunner.query(`
      CREATE POLICY user_permission_override_write ON core.user_permission_override
        FOR INSERT WITH CHECK (true);
    `);
    await queryRunner.query(`
      CREATE POLICY user_permission_override_update ON core.user_permission_override
        FOR UPDATE USING (true) WITH CHECK (true);
    `);
    await queryRunner.query(`
      CREATE POLICY user_permission_override_delete ON core.user_permission_override
        FOR DELETE USING (true);
    `);

    await queryRunner.query(`
      ALTER POLICY user_preference_tenant ON core.user_preference
        USING (user_id = core.current_uid())
        WITH CHECK (user_id = core.current_uid());
    `);

    await queryRunner.query(`
      ALTER POLICY refresh_token_tenant ON core.refresh_token
        USING (user_id = core.current_uid())
        WITH CHECK (user_id = core.current_uid());
    `);

    // login_history_insert (FOR INSERT WITH CHECK (true)) is untouched —
    // still pre-auth, still must always be recordable.
    await queryRunner.query(`
      ALTER POLICY login_history_select ON core.login_history
        USING (user_id = core.current_uid());
    `);

    await queryRunner.query(`
      ALTER POLICY password_reset_token_tenant ON core.password_reset_token
        USING (false)
        WITH CHECK (false);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER POLICY password_reset_token_tenant ON core.password_reset_token
        USING (organisation_id = core.current_org())
        WITH CHECK (organisation_id = core.current_org());
    `);
    await queryRunner.query(`
      ALTER POLICY login_history_select ON core.login_history
        USING (organisation_id = core.current_org());
    `);
    await queryRunner.query(`
      ALTER POLICY refresh_token_tenant ON core.refresh_token
        USING (organisation_id = core.current_org())
        WITH CHECK (organisation_id = core.current_org());
    `);
    await queryRunner.query(`
      ALTER POLICY user_preference_tenant ON core.user_preference
        USING (organisation_id = core.current_org())
        WITH CHECK (organisation_id = core.current_org());
    `);
    await queryRunner.query(`DROP POLICY user_permission_override_delete ON core.user_permission_override;`);
    await queryRunner.query(`DROP POLICY user_permission_override_update ON core.user_permission_override;`);
    await queryRunner.query(`DROP POLICY user_permission_override_write ON core.user_permission_override;`);
    await queryRunner.query(`DROP POLICY user_permission_override_select ON core.user_permission_override;`);
    await queryRunner.query(`
      CREATE POLICY user_permission_override_tenant ON core.user_permission_override
        USING (organisation_id = core.current_org())
        WITH CHECK (organisation_id = core.current_org());
    `);

    await queryRunner.query(`DROP POLICY user_role_delete ON core.user_role;`);
    await queryRunner.query(`DROP POLICY user_role_update ON core.user_role;`);
    await queryRunner.query(`DROP POLICY user_role_write ON core.user_role;`);
    await queryRunner.query(`DROP POLICY user_role_select ON core.user_role;`);
    await queryRunner.query(`
      CREATE POLICY user_role_tenant ON core.user_role
        USING (organisation_id = core.current_org())
        WITH CHECK (organisation_id = core.current_org());
    `);

    await queryRunner.query(`DROP POLICY user_delete ON core."user";`);
    await queryRunner.query(`DROP POLICY user_update ON core."user";`);
    await queryRunner.query(`DROP POLICY user_write ON core."user";`);
    await queryRunner.query(`DROP POLICY user_select ON core."user";`);
    await queryRunner.query(`
      CREATE POLICY user_tenant ON core."user"
        USING (organisation_id = core.current_org())
        WITH CHECK (organisation_id = core.current_org());
    `);
  }
}
