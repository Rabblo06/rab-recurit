import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Hyper Workspace Phase 3, Part 2 — the CEO/admin flow may choose a TARGET workspace only after the server has checked
 * it against the core registry. This function is that check, and returns a BOOLEAN only, never a row of another
 * organisation's workspace.
 *
 * Why a definer function: a workspace-less CEO has no workspace context, and manager_workspace's ordinary RLS only shows
 * a Manager their own row. The organisation passed in must be the CALLER's server-verified organisation
 * (ctx.organisationId from the session); the function returns true only if that workspace belongs to it and is active.
 *
 * SECURITY DEFINER with a fixed search_path, PUBLIC revoked, EXECUTE only for rab_app, no dynamic SQL.
 */
export class AdminWorkspaceInOrgLookup1786675600000 implements MigrationInterface {
  name = 'AdminWorkspaceInOrgLookup1786675600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE FUNCTION core.admin_workspace_in_org(p_workspace_id uuid, p_organisation_id uuid)
      RETURNS boolean
      LANGUAGE sql
      SECURITY DEFINER
      SET search_path = core, pg_catalog
      STABLE
      AS $$
        SELECT EXISTS (
          SELECT 1 FROM core.manager_workspace w
           WHERE w.id = p_workspace_id AND w.organisation_id = p_organisation_id AND w.status = 'active'
        );
      $$;
    `);
    await queryRunner.query(`REVOKE ALL ON FUNCTION core.admin_workspace_in_org(uuid, uuid) FROM PUBLIC;`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION core.admin_workspace_in_org(uuid, uuid) TO rab_app;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP FUNCTION IF EXISTS core.admin_workspace_in_org(uuid, uuid);`);
  }
}
