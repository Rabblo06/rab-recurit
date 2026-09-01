import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Stage 2A step 6 correction — the same `INSERT ... RETURNING` vs SELECT
 * policy defect found and fixed several times already this migration set,
 * confirmed live under `rab_app` (invisible under `rab_owner`, which
 * bypasses `manager_workspace`'s RLS entirely via its own pre-auth `NO
 * FORCE` exemption — see `ManagerWorkspaceRls1786667900000`).
 *
 * `manager_workspace_member`'s `id = current_workspace()` SELECT predicate
 * (built to close a real enumeration vulnerability — see that migration's
 * own comment) makes `ManagerWorkspaceService.create()` permanently
 * uninsertable: at the moment a Manager creates their OWN first workspace,
 * `current_workspace()` is NULL (they don't have one yet — that's the
 * entire point of this endpoint), so the newly-inserted row's `id` can
 * never equal it, and TypeORM's `RETURNING` throws "new row violates
 * row-level security policy for table manager_workspace" on every single
 * creation.
 *
 * Fix: widen the SELECT predicate to ALSO allow `owner_user_id =
 * current_uid()` — a Manager can always see the workspace(s) they own,
 * self-referentially, regardless of whether the session's bound
 * `current_workspace()` happens to already equal it. This does not reopen
 * the enumeration hole `ManagerWorkspaceRls` closed: a caller still can
 * only see a workspace they own or are currently placed in — never an
 * arbitrary other workspace by id.
 */
export class ManagerWorkspaceSelectOwnerVisibility1786669000000 implements MigrationInterface {
  name = 'ManagerWorkspaceSelectOwnerVisibility1786669000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER POLICY manager_workspace_member ON core.manager_workspace
        USING (id = core.current_workspace() OR owner_user_id = core.current_uid());
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER POLICY manager_workspace_member ON core.manager_workspace
        USING (id = core.current_workspace());
    `);
  }
}
