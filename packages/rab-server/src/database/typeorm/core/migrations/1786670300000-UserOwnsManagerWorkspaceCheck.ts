import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * SECURITY FINDING (HIGH), found while writing `UserDeletionService`'s own
 * abuse-case tests — fixed here, not just flagged.
 *
 * Actor -> action -> consequence: any Manager holding `MANAGER_MANAGE` calls
 * `DELETE /rest/v1/managers/:id` targeting a DIFFERENT Manager who privately
 * owns a `ManagerWorkspace`. `UserDeletionService.assertCanDelete`'s
 * `MANAGER_OWNS_WORKSPACE` guard ran a raw
 * `SELECT 1 FROM core.manager_workspace WHERE owner_user_id = $1` over the
 * CALLER's own `rab_app` tenant context — but `manager_workspace`'s SELECT
 * policy (`manager_workspace_member`, tightened by `ManagerWorkspaceRls
 * 1786667900000` + `ManagerWorkspaceSelectOwnerVisibility1786669000000`) only
 * ever shows a caller a workspace they themselves own or are currently
 * placed in. Since the caller is (structurally, after `CANNOT_DELETE_SELF`)
 * never the target, that SELECT always resolved to zero rows regardless of
 * whether the target's workspace was real — the guard was silently
 * non-functional for the one case it exists to catch, letting a Workspace
 * be orphaned exactly as CLAUDE.md's "never silently transfer or delete
 * `manager_workspace.owner_user_id`" rule forbids.
 *
 * Root cause: reading another user's row through a per-viewer RLS policy
 * that was never designed to answer "does an ARBITRARY user own a
 * workspace" — the same class of bug `PlatformAdminService`'s own doc
 * comment already documents and fixes via `core.is_active_platform_admin`.
 *
 * Fix: same pattern — a narrow, SECURITY DEFINER, boolean-only function
 * (never returns the row itself), fixed `search_path`, EXECUTE restricted to
 * `rab_app` only. `UserDeletionService.assertCanDelete` is updated in this
 * same change to call it instead of the raw SELECT.
 *
 * Regression test: `user-deletion-abuse-cases.integration.spec.ts`'s
 * "a Manager who owns a private Workspace is blocked with
 * MANAGER_OWNS_WORKSPACE" test.
 */
export class UserOwnsManagerWorkspaceCheck1786670300000 implements MigrationInterface {
  name = 'UserOwnsManagerWorkspaceCheck1786670300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE FUNCTION core.user_owns_manager_workspace(check_user_id uuid)
      RETURNS boolean
      LANGUAGE sql
      STABLE
      SECURITY DEFINER
      SET search_path = core, pg_catalog
      AS $$
        SELECT EXISTS (
          SELECT 1 FROM core.manager_workspace WHERE owner_user_id = check_user_id
        );
      $$;
    `);
    await queryRunner.query(`REVOKE ALL ON FUNCTION core.user_owns_manager_workspace(uuid) FROM PUBLIC;`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION core.user_owns_manager_workspace(uuid) TO rab_app;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP FUNCTION IF EXISTS core.user_owns_manager_workspace(uuid);`);
  }
}
