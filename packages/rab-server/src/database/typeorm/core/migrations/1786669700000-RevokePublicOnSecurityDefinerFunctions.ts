import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Stage 2A Phase 5 — SECURITY DEFINER function audit. Postgres grants
 * EXECUTE to PUBLIC by default on every newly created function unless
 * explicitly revoked; `IsActivePlatformAdminGlobalRedesign1786669400000`'s
 * `core.is_active_platform_admin` got this right (explicit `REVOKE ALL ...
 * FROM PUBLIC` before granting `rab_app`), but the 7 SECURITY DEFINER
 * functions from earlier in this migration set
 * (`PreAuthLookupFunctions1786667400000` and
 * `ResolveWorkspaceForUserPreAuthExemption1786668400000`) never had PUBLIC's
 * default grant revoked. Not exploitable today — this database's only
 * non-superuser roles are `rab_owner`/`rab_app`, both already explicitly
 * granted — but a defense-in-depth gap all the same: restricting EXECUTE to
 * exactly the roles that need it, rather than relying on "no other role
 * happens to exist yet," is the correct fail-closed posture for a pre-auth,
 * owner-privileged function per CLAUDE.md's own rule.
 */
export class RevokePublicOnSecurityDefinerFunctions1786669700000 implements MigrationInterface {
  name = 'RevokePublicOnSecurityDefinerFunctions1786669700000';

  private readonly functions = [
    'core.auth_count_recent_login_failures(citext, timestamptz)',
    'core.auth_find_password_reset_token_org(text)',
    'core.auth_find_refresh_token_org(text)',
    'core.auth_find_users_by_email(citext)',
    'core.organisation_slug_taken(citext, uuid)',
    'core.resolve_workspace_for_user(uuid)',
    'core.workspace_subdomain_taken(citext, uuid)',
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const fn of this.functions) {
      await queryRunner.query(`REVOKE ALL ON FUNCTION ${fn} FROM PUBLIC;`);
      await queryRunner.query(`GRANT EXECUTE ON FUNCTION ${fn} TO rab_app;`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const fn of this.functions) {
      await queryRunner.query(`GRANT EXECUTE ON FUNCTION ${fn} TO PUBLIC;`);
    }
  }
}
