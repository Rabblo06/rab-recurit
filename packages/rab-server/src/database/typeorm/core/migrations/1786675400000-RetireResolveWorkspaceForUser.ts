import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Hyper Workspace Phase 3, Part 15 — retire the legacy workspace-discovery resolver.
 *
 * core.resolve_workspace_for_user(uuid) derived a user's workspace from manager_workspace.owner_user_id, then
 * staff_profile.workspace_id, then manager_profile.workspace_id (LIMIT 1, so an ambiguous user silently got one).
 * That was authority held by business profile tables, not by identity metadata.
 *
 * Retirement is allowed only because every live caller now uses core.workspace_membership:
 *   - JwtAuthGuard          → WorkspaceResolverService.resolveForSession (session family → membership)
 *   - AuthService (5 sites) → WorkspaceResolverService.resolveForUser    (verified user → membership)
 *   - guard inspect target  → WorkspaceResolverService.resolveForUser    (already-authorised target)
 * A grep of src/ for resolve_workspace_for_user finds no application call. The only remaining references are
 * historical migrations and comments, which are updated in the same change.
 *
 * The DROP fails if any object still depends on the function (fail closed), so a hidden caller cannot survive.
 * down() restores the exact definition that was live immediately before retirement.
 */
export class RetireResolveWorkspaceForUser1786675400000 implements MigrationInterface {
  name = 'RetireResolveWorkspaceForUser1786675400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP FUNCTION core.resolve_workspace_for_user(uuid);`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION core.resolve_workspace_for_user(p_user_id uuid)
      RETURNS uuid
      LANGUAGE sql
      SECURITY DEFINER
      SET search_path TO 'core', 'pg_catalog'
      AS $function$
        SELECT id FROM core.manager_workspace WHERE owner_user_id = p_user_id
        UNION ALL
        SELECT workspace_id FROM core.staff_profile WHERE user_id = p_user_id AND workspace_id IS NOT NULL
        UNION ALL
        SELECT workspace_id FROM core.manager_profile WHERE user_id = p_user_id AND workspace_id IS NOT NULL
        LIMIT 1
      $function$;
    `);
    await queryRunner.query(`REVOKE ALL ON FUNCTION core.resolve_workspace_for_user(uuid) FROM PUBLIC;`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION core.resolve_workspace_for_user(uuid) TO rab_app;`);
  }
}
