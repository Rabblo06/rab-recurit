import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * P2.9B — fixes a real, confirmed defect found running the new `organisation-onboarding
 * .integration.spec.ts` suite: `core.manager_profile`'s own RLS policy (`manager_profile_tenant`,
 * `FOR ALL`) requires the acting session to ALREADY be a member of the target organisation — its
 * own row (`user_id = current_uid()`), the same workspace, or holding `manager.manage` via a role
 * in THAT org. A Platform Super Admin creating a BRAND NEW organisation's first CEO satisfies
 * none of these: they hold no role in an organisation that, a moment earlier, did not exist.
 *
 * The INSERT's own `WITH CHECK` happens to pass regardless (a CEO profile's `workspace_id` is
 * always NULL, and the WITH CHECK's own `workspace_id IS NULL` branch is unconditionally true) —
 * but `ManagerService.createWithin()`'s `manager.insert(ManagerProfile, ...)` always asks for the
 * inserted row back (TypeORM's default `RETURNING` behaviour), and Postgres enforces the table's
 * SELECT/USING policy against the RETURNED row, not just the WITH CHECK — which fails for exactly
 * the reason above. Confirmed directly: the organisation row and the CEO's own `user`/`role`/
 * `user_role`/`organisation_member` rows all insert successfully first (none of those tables'
 * policies have this "already a member" requirement); only `manager_profile` failed, and only
 * because of the implicit read-back, not the write itself.
 *
 * Fix: add an `OR core.is_active_platform_admin(core.current_uid())` branch to both `USING` and
 * `WITH CHECK`, mirroring the exact exemption pattern already used throughout this codebase for
 * platform-admin-initiated actions outside the ordinary tenant-membership model (e.g.
 * `applicationAllowed()`'s own `if (platformAdmin) return true` short-circuit). Never widens what
 * an ORDINARY (non-admin) caller can see or write — every existing branch is preserved unchanged.
 */
export class ManagerProfilePlatformAdminRls1786708000000 implements MigrationInterface {
  name = 'ManagerProfilePlatformAdminRls1786708000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
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
