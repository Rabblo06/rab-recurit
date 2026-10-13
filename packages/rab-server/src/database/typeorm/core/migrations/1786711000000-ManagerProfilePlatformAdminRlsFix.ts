import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * P2.9B — fixes a real, confirmed defect in `ManagerProfilePlatformAdminRls1786708000000`'s own
 * fix: that migration added `OR core.is_active_platform_admin(core.current_uid())` as one of the
 * INNER disjuncts inside `(organisation_id = current_org()) AND (... OR is_active_platform_admin
 * (...) OR ...)`. The outer `AND` means the platform-admin branch is still gated by
 * `organisation_id = current_org()` — which is exactly what a genuinely cross-tenant read (a
 * platform admin listing EVERY organisation, with no single org bound at all) can never satisfy.
 * Confirmed directly via psql: `is_active_platform_admin(current_uid())` evaluated `true` in
 * isolation, yet the row stayed invisible, because `current_org()` was null and `null AND true`
 * is null, not true.
 *
 * Fix: hoist the platform-admin check to the TOP level, OR'd with the entire previous expression,
 * so a platform admin bypasses org-scoping entirely (same shape as `applicationAllowed()`'s own
 * `if (platformAdmin) return true` short-circuit) while an ordinary caller's access is completely
 * unchanged — every pre-existing branch is preserved, just no longer gated behind
 * `organisation_id = current_org()` for this one case.
 */
export class ManagerProfilePlatformAdminRlsFix1786711000000 implements MigrationInterface {
  name = 'ManagerProfilePlatformAdminRlsFix1786711000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP POLICY manager_profile_tenant ON core.manager_profile;`);
    await queryRunner.query(`
      CREATE POLICY manager_profile_tenant ON core.manager_profile
        FOR ALL
        USING (
          core.is_active_platform_admin(core.current_uid())
          OR (
            organisation_id = core.current_org()
            AND (
              user_id = core.current_uid()
              OR workspace_id = core.current_workspace()
              OR EXISTS (
                SELECT 1
                  FROM core.user_role ur
                  JOIN core.role_permission rp ON rp.role_id = ur.role_id
                  JOIN core.permission p ON p.id = rp.permission_id
                 WHERE ur.user_id = core.current_uid() AND p.key = 'manager.manage'
              )
            )
          )
        )
        WITH CHECK (
          core.is_active_platform_admin(core.current_uid())
          OR (
            organisation_id = core.current_org()
            AND (
              workspace_id IS NULL
              OR workspace_id = core.current_workspace()
              OR EXISTS (
                SELECT 1
                  FROM core.user_role ur
                  JOIN core.role_permission rp ON rp.role_id = ur.role_id
                  JOIN core.permission p ON p.id = rp.permission_id
                 WHERE ur.user_id = core.current_uid() AND p.key = 'manager.manage'
              )
            )
          )
        );
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP POLICY manager_profile_tenant ON core.manager_profile;`);
    await queryRunner.query(`
      CREATE POLICY manager_profile_tenant ON core.manager_profile
        FOR ALL
        USING (
          organisation_id = core.current_org()
          AND (
            user_id = core.current_uid()
            OR workspace_id = core.current_workspace()
            OR core.is_active_platform_admin(core.current_uid())
            OR EXISTS (
              SELECT 1
                FROM core.user_role ur
                JOIN core.role_permission rp ON rp.role_id = ur.role_id
                JOIN core.permission p ON p.id = rp.permission_id
               WHERE ur.user_id = core.current_uid() AND p.key = 'manager.manage'
            )
          )
        )
        WITH CHECK (
          organisation_id = core.current_org()
          AND (
            workspace_id IS NULL
            OR workspace_id = core.current_workspace()
            OR core.is_active_platform_admin(core.current_uid())
            OR EXISTS (
              SELECT 1
                FROM core.user_role ur
                JOIN core.role_permission rp ON rp.role_id = ur.role_id
                JOIN core.permission p ON p.id = rp.permission_id
               WHERE ur.user_id = core.current_uid() AND p.key = 'manager.manage'
            )
          )
        );
    `);
  }
}
