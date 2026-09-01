import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Stage 2A step 2. Mirrors `TenantSessionContext1786665700000`'s exact
 * shape for the new Workspace boundary — `core.current_uid()` already
 * exists and is reused as-is (no need for a second "current user" function).
 *
 * `resolve_workspace_for_user` is a pre-auth-style SECURITY DEFINER lookup
 * (same bar as `auth_find_users_by_email` etc. — min columns, parameterized,
 * pinned search_path, schema-qualified, no SELECT *, no dynamic SQL): the
 * three tables it reads (`manager_workspace`, `staff_profile`,
 * `manager_profile`) are all RLS-restricted for `rab_app` even without
 * FORCE (rab_app is not the table owner), so a plain query from
 * `JwtAuthGuard` — which runs before any workspace context can possibly be
 * bound, since resolving that context IS what this function does — would
 * always see zero rows without this. Returns a bare uuid, nothing else.
 */
export class WorkspaceSessionContext1786667700000 implements MigrationInterface {
  name = 'WorkspaceSessionContext1786667700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE FUNCTION core.current_workspace() RETURNS uuid
      LANGUAGE sql STABLE AS $$
        SELECT NULLIF(current_setting('rab.workspace_id', true), '')::uuid
      $$;
    `);

    await queryRunner.query(`
      CREATE FUNCTION core.resolve_workspace_for_user(p_user_id uuid) RETURNS uuid
      LANGUAGE sql SECURITY DEFINER SET search_path = core, pg_catalog AS $$
        SELECT id FROM core.manager_workspace WHERE owner_user_id = p_user_id
        UNION ALL
        SELECT workspace_id FROM core.staff_profile WHERE user_id = p_user_id AND workspace_id IS NOT NULL
        UNION ALL
        SELECT workspace_id FROM core.manager_profile WHERE user_id = p_user_id AND workspace_id IS NOT NULL
        LIMIT 1
      $$;
    `);
    // No PUBLIC EXECUTE — matches every other pre-auth function's grant
    // shape (rab_app only, via the same ALTER DEFAULT PRIVILEGES already
    // covering this schema's SECURITY DEFINER functions).
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP FUNCTION IF EXISTS core.resolve_workspace_for_user(uuid)`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS core.current_workspace()`);
  }
}
