import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * P2.9C — the same class of defect `ManagerProfilePlatformAdminRlsFix1786711000000` already fixed
 * for `core.manager_profile`, now found in `core.manager_workspace`: `manager_workspace_write`'s
 * policy (`FOR ALL`, no `organisation_id` anchor at all) is strictly `owner_user_id =
 * core.current_uid()` — correct for the existing self-service flow (the caller always creates
 * their OWN workspace), but P2.9C's Initial Manager invitation creates a workspace OWNED BY THE
 * INVITEE, acted on by a DIFFERENT person (a Platform Admin or the organisation's own CEO).
 * Confirmed directly: both the Super-Admin-side AND the CEO-side integration tests failed with
 * "new row violates row-level security policy for table manager_workspace" before this fix.
 *
 * Fix: OR in two exemptions, same shape as `manager_profile_tenant`'s own (already-fixed)
 * structure — hoisted to the TOP level, never nested behind the `owner_user_id` check:
 *   - `core.is_active_platform_admin(core.current_uid())` — the Super-Admin-side invite.
 *   - An EXISTS check for `manager.manage` held in THIS SPECIFIC organisation (explicitly scoped
 *     to `manager_workspace.organisation_id`, not merely "holds it somewhere") — the CEO-side
 *     invite; a CEO holds this permission in their own organisation by default.
 * Every existing self-service caller (`owner_user_id = current_uid()`) is unchanged.
 */
export class ManagerWorkspacePlatformAdminRls1786712000000 implements MigrationInterface {
  name = 'ManagerWorkspacePlatformAdminRls1786712000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP POLICY manager_workspace_write ON core.manager_workspace;`);
    await queryRunner.query(`
      CREATE POLICY manager_workspace_write ON core.manager_workspace
        FOR ALL
        USING (
          core.is_active_platform_admin(core.current_uid())
          OR owner_user_id = core.current_uid()
          OR EXISTS (
            SELECT 1
              FROM core.user_role ur
              JOIN core.role_permission rp ON rp.role_id = ur.role_id
              JOIN core.permission p ON p.id = rp.permission_id
             WHERE ur.user_id = core.current_uid()
               AND ur.organisation_id = manager_workspace.organisation_id
               AND p.key = 'manager.manage'
          )
        )
        WITH CHECK (
          core.is_active_platform_admin(core.current_uid())
          OR owner_user_id = core.current_uid()
          OR EXISTS (
            SELECT 1
              FROM core.user_role ur
              JOIN core.role_permission rp ON rp.role_id = ur.role_id
              JOIN core.permission p ON p.id = rp.permission_id
             WHERE ur.user_id = core.current_uid()
               AND ur.organisation_id = manager_workspace.organisation_id
               AND p.key = 'manager.manage'
          )
        );
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP POLICY manager_workspace_write ON core.manager_workspace;`);
    await queryRunner.query(`
      CREATE POLICY manager_workspace_write ON core.manager_workspace
        FOR ALL
        USING (owner_user_id = core.current_uid())
        WITH CHECK (owner_user_id = core.current_uid());
    `);
  }
}
