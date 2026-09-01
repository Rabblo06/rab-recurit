import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Stage 2A step 6 continued. `manager_profile` is Category A (Workspace-
 * owned) but doesn't fit the generic combined-AND transition every other
 * operational table gets (`OperationalWorkspaceRlsTransition`) — split
 * instead, same reasoning already applied to `user`/`user_role`/
 * `user_permission_override` in `IdentityWorkspaceRls`:
 *
 *  - SELECT: combined org+workspace, the real confidentiality boundary
 *    (which Managers are visible to which Workspace's callers).
 *  - INSERT/UPDATE/DELETE: organisation-scoped only. A new profile is
 *    created BY someone else (CEO/Admin/platform) with `workspace_id`
 *    legitimately NULL — the owning Manager's own workspace is assigned
 *    later, in a separate UPDATE, inside the SAME request transaction that
 *    resolved `current_workspace()` as NULL before that workspace existed
 *    (`ManagerWorkspaceService.create`). A combined WITH CHECK would reject
 *    both the initial INSERT and that completing UPDATE. Real write
 *    authorization is enforced upstream (CeoCreationGuard, PermissionGuard,
 *    the service's own ownership checks), matching every other split policy
 *    in this migration set.
 */
export class ManagerProfileWorkspaceRls1786668150000 implements MigrationInterface {
  name = 'ManagerProfileWorkspaceRls1786668150000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP POLICY manager_profile_tenant ON core.manager_profile;`);
    await queryRunner.query(`
      CREATE POLICY manager_profile_select ON core.manager_profile
        FOR SELECT USING (organisation_id = core.current_org() AND workspace_id = core.current_workspace());
    `);
    await queryRunner.query(`
      CREATE POLICY manager_profile_write ON core.manager_profile
        FOR INSERT WITH CHECK (organisation_id = core.current_org());
    `);
    await queryRunner.query(`
      CREATE POLICY manager_profile_update ON core.manager_profile
        FOR UPDATE USING (organisation_id = core.current_org()) WITH CHECK (organisation_id = core.current_org());
    `);
    await queryRunner.query(`
      CREATE POLICY manager_profile_delete ON core.manager_profile
        FOR DELETE USING (organisation_id = core.current_org());
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP POLICY manager_profile_delete ON core.manager_profile;`);
    await queryRunner.query(`DROP POLICY manager_profile_update ON core.manager_profile;`);
    await queryRunner.query(`DROP POLICY manager_profile_write ON core.manager_profile;`);
    await queryRunner.query(`DROP POLICY manager_profile_select ON core.manager_profile;`);
    await queryRunner.query(`
      CREATE POLICY manager_profile_tenant ON core.manager_profile
        USING (organisation_id = core.current_org())
        WITH CHECK (organisation_id = core.current_org());
    `);
  }
}
