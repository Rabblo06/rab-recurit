import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * SECURITY TRADE-OFF — fixes a real, confirmed-live regression surfaced by
 * this same remediation pass: `organisation`, `user`, `refresh_token`, and
 * `password_reset_token` are ENABLEd-but-not-FORCEd RLS specifically so a
 * pre-auth lookup (identifying which org a request belongs to, before any
 * tenant context exists) can work. That reasoning assumed the app's own
 * connection role would still see these rows without a bound context — but
 * `ENABLE ROW LEVEL SECURITY` restricts every role except the table OWNER,
 * regardless of FORCE; only FORCE extends enforcement to the owner too. The
 * intended runtime role `rab_app` is deliberately not the owner and has
 * `NOBYPASSRLS` — so it was ALREADY fully blocked from these pre-auth reads
 * even without FORCE. This was masked for the entire life of this design by
 * an unrelated bug (the local dev stack accidentally connecting as the
 * owner role) — fixing that bug (see the docker-compose change in this same
 * remediation) unmasked this one: with the app correctly connecting as
 * `rab_app`, login/refresh/reset-password/forgot-password all silently
 * returned "not found" for every request.
 *
 * Fix: a small number of narrow, single-purpose, injection-safe SQL
 * functions, each returning only the specific columns its one caller needs
 * (never `SELECT *`, never a bulk listing) — never a broad, table-wide
 * `USING (true)` SELECT policy, which would have undone RLS as a defense
 * layer for the whole table (including every already-correctly-scoped read
 * everywhere else in the app), not just the one pre-auth path that needs it.
 *
 * `SECURITY DEFINER` makes each function execute with its owner's (the
 * migration role, `rab_owner` — also these tables' owner) privileges,
 * which is exempt from RLS by the same table-owner rule that made this bug
 * possible in the first place — deliberately reused here as the intended
 * mechanism, not an accident. `SET search_path` pins schema resolution so a
 * function can't be tricked by a shadowing object in another schema (the
 * standard SECURITY DEFINER hardening) — `rab_app` has no CREATE grant on
 * `core` (see postgres-init/01-roles.sql), so this is defense-in-depth, not
 * the only thing preventing it. `EXECUTE` on new functions in `core` is
 * already auto-granted to `rab_app` by the existing
 * `ALTER DEFAULT PRIVILEGES ... GRANT EXECUTE ON FUNCTIONS` in that same
 * init script — no additional grant needed here.
 *
 * Every function below is read-only by design — the actual mutations these
 * flows need (revoking a refresh token, marking a reset token used, writing
 * `lastLoginAt`) still go through the normal, already-audited
 * `runInTenantContext`/RLS-enforced path, once the caller has used one of
 * these functions to learn which organisation to bind context to. See the
 * corresponding `auth.service.ts`/`workspace.service.ts` changes in this
 * same commit for how each one is actually used.
 */
export class PreAuthLookupFunctions1786667400000 implements MigrationInterface {
  name = 'PreAuthLookupFunctions1786667400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // login()'s candidate lookup (an email can match more than one org by
    // design) and forgotPassword()'s lookup — both need exactly these 6
    // fields, never the rest of the row.
    await queryRunner.query(`
      CREATE FUNCTION core.auth_find_users_by_email(p_email citext)
      RETURNS TABLE (
        id uuid,
        "organisationId" uuid,
        email citext,
        "passwordHash" text,
        status text,
        "mustResetPassword" boolean,
        "firstName" text
      )
      LANGUAGE sql SECURITY DEFINER SET search_path = core, pg_catalog
      AS $$
        SELECT id, organisation_id, email, password_hash, status, must_reset_password, first_name
        FROM core."user"
        WHERE email = p_email AND deleted_at IS NULL;
      $$;
    `);

    // login()'s brute-force lockout counter — cross-org by design (the
    // lockout is per email, not per org, since the org isn't known yet).
    await queryRunner.query(`
      CREATE FUNCTION core.auth_count_recent_login_failures(p_email citext, p_since timestamptz)
      RETURNS bigint
      LANGUAGE sql SECURITY DEFINER SET search_path = core, pg_catalog
      AS $$
        SELECT count(*) FROM core.login_history
        WHERE email = p_email AND success = false AND created_at > p_since;
      $$;
    `);

    // refresh()/resetPassword() only need to learn WHICH organisation/user a
    // presented token belongs to — everything else (validity, expiry,
    // revocation, the actual rotate/consume mutation) runs afterward inside
    // runInTenantContext for that org, through the normal RLS-enforced path.
    // Matches even a revoked/expired token (deliberately) — the caller still
    // needs an org to bind context to before it can correctly reject it.
    await queryRunner.query(`
      CREATE FUNCTION core.auth_find_refresh_token_org(p_token_hash text)
      RETURNS TABLE ("organisationId" uuid, "userId" uuid)
      LANGUAGE sql SECURITY DEFINER SET search_path = core, pg_catalog
      AS $$
        SELECT organisation_id, user_id FROM core.refresh_token WHERE token_hash = p_token_hash;
      $$;
    `);

    await queryRunner.query(`
      CREATE FUNCTION core.auth_find_password_reset_token_org(p_token_hash text)
      RETURNS TABLE ("organisationId" uuid, "userId" uuid)
      LANGUAGE sql SECURITY DEFINER SET search_path = core, pg_catalog
      AS $$
        SELECT organisation_id, user_id FROM core.password_reset_token WHERE token_hash = p_token_hash;
      $$;
    `);

    // WorkspaceService.updateSubdomain()'s cross-org uniqueness check — the
    // same class of bug (an unscoped `organisation` read, silently seeing
    // zero rows under the intended rab_app role), confirmed live during
    // this same remediation pass. Returns only a boolean, never the other
    // organisation's row.
    await queryRunner.query(`
      CREATE FUNCTION core.organisation_slug_taken(p_slug citext, p_exclude_org_id uuid)
      RETURNS boolean
      LANGUAGE sql SECURITY DEFINER SET search_path = core, pg_catalog
      AS $$
        SELECT EXISTS (SELECT 1 FROM core.organisation WHERE slug = p_slug AND id <> p_exclude_org_id);
      $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP FUNCTION IF EXISTS core.organisation_slug_taken(citext, uuid);`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS core.auth_find_password_reset_token_org(text);`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS core.auth_find_refresh_token_org(text);`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS core.auth_count_recent_login_failures(citext, timestamptz);`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS core.auth_find_users_by_email(citext);`);
  }
}
