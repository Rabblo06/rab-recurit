import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Hyper Workspace Phase 3, Part 9 — mixed-case email is a REAL product defect, fixed at the identity boundary.
 *
 * core."user".email is citext, so a plain `email = p_email` is case-insensitive when `citext`'s operators are
 * visible. These two pre-auth SECURITY DEFINER functions pin `search_path = core, pg_catalog`, which hides the
 * citext operators (they live in `public`). PostgreSQL then falls back to text equality, which is case-SENSITIVE.
 *
 * Observed: an account stored as `mA-…@example.test` could not sign in, because login normalises the typed email to
 * lower case before the lookup, and the lookup then compared it case-sensitively against the stored mixed-case value.
 * Lower-case stored addresses were unaffected, which is why this looked like a fixture quirk at first.
 *
 * Fix: qualify the operator explicitly, OPERATOR(public.=), so the comparison is case-insensitive AND keeps using the
 * citext index. The pinned search_path is unchanged, so no object resolution changes anywhere else.
 *
 * Affected: auth_find_users_by_email (login candidates, forgot-password) and auth_count_recent_login_failures
 * (lockout counter). Both are read-only.
 */
export class PreAuthEmailCitextLookup1786675300000 implements MigrationInterface {
  name = 'PreAuthEmailCitextLookup1786675300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION core.auth_find_users_by_email(p_email citext)
      RETURNS TABLE(id uuid, "organisationId" uuid, email citext, "passwordHash" text, status text, "mustResetPassword" boolean, "firstName" text)
      LANGUAGE sql
      SECURITY DEFINER
      SET search_path = core, pg_catalog
      AS $$
        SELECT id, organisation_id, email, password_hash, status, must_reset_password, first_name
        FROM core."user"
        WHERE email OPERATOR(public.=) p_email AND deleted_at IS NULL;
      $$;
    `);
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION core.auth_count_recent_login_failures(p_email citext, p_since timestamptz)
      RETURNS bigint
      LANGUAGE sql
      SECURITY DEFINER
      SET search_path = core, pg_catalog
      AS $$
        SELECT count(*) FROM core.login_history
        WHERE email::public.citext OPERATOR(public.=) p_email AND success = false AND created_at > p_since;
      $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION core.auth_find_users_by_email(p_email citext)
      RETURNS TABLE(id uuid, "organisationId" uuid, email citext, "passwordHash" text, status text, "mustResetPassword" boolean, "firstName" text)
      LANGUAGE sql
      SECURITY DEFINER
      SET search_path TO 'core', 'pg_catalog'
      AS $$
        SELECT id, organisation_id, email, password_hash, status, must_reset_password, first_name
        FROM core."user"
        WHERE email = p_email AND deleted_at IS NULL;
      $$;
    `);
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION core.auth_count_recent_login_failures(p_email citext, p_since timestamptz)
      RETURNS bigint
      LANGUAGE sql
      SECURITY DEFINER
      SET search_path TO 'core', 'pg_catalog'
      AS $$
        SELECT count(*) FROM core.login_history
        WHERE email = p_email AND success = false AND created_at > p_since;
      $$;
    `);
  }
}
