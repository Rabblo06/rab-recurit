import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Stage 2A step 3 continued (Revision 3 §2). `manager_workspace` is
 * becoming the AUTHORITATIVE private-tenant boundary — its old
 * `manager_workspace_select FOR SELECT USING (true)` policy (built for one
 * narrow need, subdomain-availability checking) let ANY authenticated user
 * enumerate every workspace's id/owner/name/subdomain/logo/status. Removed
 * entirely. Subdomain availability moves behind a new SECURITY DEFINER
 * function returning a bare boolean — same pre-auth-function bar as
 * `organisation_slug_taken`/`auth_find_users_by_email` (min columns,
 * parameterized, pinned search_path, no enumeration).
 */
export class ManagerWorkspaceRls1786667900000 implements MigrationInterface {
  name = 'ManagerWorkspaceRls1786667900000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // SECURITY TRADE-OFF: `manager_workspace` was FORCE-protected (it never
    // needed the pre-auth exemption before this migration). A `SECURITY
    // DEFINER` function is owned by `rab_owner` and executes with its
    // privileges — but FORCE means even the owner is restricted by RLS,
    // so `workspace_subdomain_taken` (below) would see zero rows without
    // this. `rab_app` (the actual runtime role) is NEVER exempted by FORCE
    // either way, since it isn't the table owner — dropping FORCE only
    // changes what `rab_owner`-privileged code (migrations, this function)
    // can see, joining `organisation`/`user`/`login_history`/
    // `refresh_token`/`password_reset_token` as the sixth documented
    // pre-auth-lookup exemption in this schema.
    await queryRunner.query(`ALTER TABLE core.manager_workspace NO FORCE ROW LEVEL SECURITY;`);

    await queryRunner.query(`DROP POLICY manager_workspace_select ON core.manager_workspace;`);

    await queryRunner.query(`
      ALTER POLICY manager_workspace_write ON core.manager_workspace
        USING (owner_user_id = core.current_uid())
        WITH CHECK (owner_user_id = core.current_uid());
    `);

    await queryRunner.query(`
      CREATE POLICY manager_workspace_member ON core.manager_workspace
        FOR SELECT USING (id = core.current_workspace());
    `);

    // Matches organisation_slug_taken's own exclude-current-row shape
    // exactly — needed so a workspace re-checking its own current
    // subdomain (e.g. re-submitting an unchanged value during an update)
    // doesn't see itself as "taken".
    await queryRunner.query(`
      CREATE FUNCTION core.workspace_subdomain_taken(p_subdomain citext, p_exclude_workspace_id uuid DEFAULT NULL)
      RETURNS boolean
      LANGUAGE sql SECURITY DEFINER SET search_path = core, pg_catalog AS $$
        SELECT EXISTS(
          SELECT 1 FROM core.manager_workspace
          WHERE subdomain = p_subdomain AND (p_exclude_workspace_id IS NULL OR id != p_exclude_workspace_id)
        )
      $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP FUNCTION IF EXISTS core.workspace_subdomain_taken(citext, uuid)`);
    await queryRunner.query(`DROP POLICY manager_workspace_member ON core.manager_workspace;`);
    await queryRunner.query(`
      ALTER POLICY manager_workspace_write ON core.manager_workspace
        USING (organisation_id = core.current_org())
        WITH CHECK (organisation_id = core.current_org());
    `);
    await queryRunner.query(`
      CREATE POLICY manager_workspace_select ON core.manager_workspace
        FOR SELECT USING (true);
    `);
    await queryRunner.query(`ALTER TABLE core.manager_workspace FORCE ROW LEVEL SECURITY;`);
  }
}
