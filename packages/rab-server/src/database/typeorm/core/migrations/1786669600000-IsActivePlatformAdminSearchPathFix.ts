import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Stage 2A Phase 5 — SECURITY DEFINER function audit found
 * `core.is_active_platform_admin` (added by `PlatformAdminGlobalRedesign
 * 1786669400000`) set `search_path = core, pg_temp`, inconsistent with
 * every other SECURITY DEFINER function in this schema (`core.current_org`,
 * `resolve_workspace_for_user`, `auth_find_users_by_email`, etc.), all of
 * which use `core, pg_catalog`. `pg_temp` is redundant here — Postgres
 * always consults the session's temp-object schema first regardless of
 * whether it's named in `search_path` — while `pg_catalog` is the
 * meaningful entry (guarantees built-in functions/operators resolve
 * predictably rather than depending on their position, explicit or
 * implicit, in the path). Not a live vulnerability (no attacker-controlled
 * schema was ever reachable either way), but worth correcting for
 * consistency with the established, already-audited pattern rather than
 * leaving two different conventions in the same schema.
 */
export class IsActivePlatformAdminSearchPathFix1786669600000 implements MigrationInterface {
  name = 'IsActivePlatformAdminSearchPathFix1786669600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION core.is_active_platform_admin(check_user_id uuid DEFAULT NULL)
      RETURNS boolean
      LANGUAGE sql
      STABLE
      SECURITY DEFINER
      SET search_path = core, pg_catalog
      AS $$
        SELECT EXISTS (
          SELECT 1 FROM core.platform_admin
          WHERE user_id = COALESCE(check_user_id, core.current_uid())
            AND revoked_at IS NULL
        );
      $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION core.is_active_platform_admin(check_user_id uuid DEFAULT NULL)
      RETURNS boolean
      LANGUAGE sql
      STABLE
      SECURITY DEFINER
      SET search_path = core, pg_temp
      AS $$
        SELECT EXISTS (
          SELECT 1 FROM core.platform_admin
          WHERE user_id = COALESCE(check_user_id, core.current_uid())
            AND revoked_at IS NULL
        );
      $$;
    `);
  }
}
