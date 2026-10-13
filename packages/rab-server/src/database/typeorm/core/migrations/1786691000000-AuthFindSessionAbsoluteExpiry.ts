import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Checkpoint 3 (Redis checkpoint) — Twenty-style Redis-first UserSession cache.
 *
 * `core.auth_find_session_by_web_token_hash` (WebSessionCookieAuthentication1786681000000) already
 * resolves a cookie's hash to `{sessionId, userId, organisationId, applicationTarget}` on every
 * cookie-authenticated request — this IS the exact pre-auth lookup Twenty's own "Redis UserSession
 * cache" flow caches. Adding `absoluteExpiresAt` to its output lets `UserSessionCacheService` bound
 * its own cache TTL by the session's real absolute deadline (never serve a cache entry past a
 * session's own expiry), without a second query — `absolute_expires_at` is set once at session
 * creation and never changes afterward, so it is safe to cache alongside the rest of this row for
 * the cache entry's whole life, unlike `idle_expires_at`/`revoked_at` (bumped/set on nearly every
 * request), which this function still deliberately does NOT return — those remain exclusively
 * `SessionValidityService.assertActive()`'s job, which runs UNCONDITIONALLY after this lookup,
 * cache hit or miss, and is never itself cached. This cache can therefore never weaken revocation,
 * idle-expiry, or absolute-expiry enforcement: it only ever shortcuts the IDENTITY lookup, never
 * the LIVENESS decision.
 *
 * Owned by `rab_secure_owner` (pre-auth, no tenant context exists yet) — redefining it needs the
 * same bootstrap privilege every other `rab_secure_owner`-owned redefinition in this program has
 * required, confirmed necessary again here, not assumed.
 */
export class AuthFindSessionAbsoluteExpiry1786691000000 implements MigrationInterface {
  name = 'AuthFindSessionAbsoluteExpiry1786691000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await assertBootstrapPrivilege(queryRunner, this.name);
    // CREATE OR REPLACE cannot change a function's OUT-parameter row shape (Postgres 42P13) — an
    // explicit DROP is required first when adding a return column, confirmed by hitting exactly
    // that error against the disposable database before adding this.
    await queryRunner.query(`DROP FUNCTION IF EXISTS core.auth_find_session_by_web_token_hash(text);`);
    await queryRunner.query(`
      CREATE FUNCTION core.auth_find_session_by_web_token_hash(p_hash text)
      RETURNS TABLE("sessionId" uuid, "userId" uuid, "organisationId" uuid, "applicationTarget" text, "absoluteExpiresAt" timestamptz)
      LANGUAGE sql
      SECURITY DEFINER
      SET search_path TO 'core', 'pg_catalog'
      AS $function$
        SELECT id, user_id, organisation_id, application_target, absolute_expires_at
        FROM core.user_session
        WHERE web_session_token_hash = p_hash;
      $function$;
    `);
    // DROP FUNCTION wipes BOTH the owner and every grant on the old signature — CREATE FUNCTION
    // makes the connecting bootstrap role (superuser/CREATEROLE, never rab_secure_owner itself) the
    // new owner by default. Confirmed empirically against the disposable database: without this
    // ALTER, the function ran owned by the migration-runner, silently breaking the entire reason it
    // is SECURITY DEFINER in the first place (its privilege ceiling must be rab_secure_owner's
    // narrow one, never whichever bootstrap identity happened to apply this migration). Restore
    // both the owner and the grant (only `crewflow` had EXECUTE; `crewflow_app` never did — a
    // pre-existing gap in the paused, not-currently-wired-in Checkpoint 2 restricted-role migration,
    // out of scope here and left for that work to pick up when it resumes).
    await queryRunner.query(`ALTER FUNCTION core.auth_find_session_by_web_token_hash(text) OWNER TO rab_secure_owner;`);
    await queryRunner.query(`REVOKE ALL ON FUNCTION core.auth_find_session_by_web_token_hash(text) FROM PUBLIC;`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION core.auth_find_session_by_web_token_hash(text) TO crewflow;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await assertBootstrapPrivilege(queryRunner, this.name);
    await queryRunner.query(`DROP FUNCTION IF EXISTS core.auth_find_session_by_web_token_hash(text);`);
    await queryRunner.query(`
      CREATE FUNCTION core.auth_find_session_by_web_token_hash(p_hash text)
      RETURNS TABLE("sessionId" uuid, "userId" uuid, "organisationId" uuid, "applicationTarget" text)
      LANGUAGE sql
      SECURITY DEFINER
      SET search_path TO 'core', 'pg_catalog'
      AS $function$
        SELECT id, user_id, organisation_id, application_target
        FROM core.user_session
        WHERE web_session_token_hash = p_hash;
      $function$;
    `);
    await queryRunner.query(`ALTER FUNCTION core.auth_find_session_by_web_token_hash(text) OWNER TO rab_secure_owner;`);
    await queryRunner.query(`REVOKE ALL ON FUNCTION core.auth_find_session_by_web_token_hash(text) FROM PUBLIC;`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION core.auth_find_session_by_web_token_hash(text) TO crewflow;`);
  }
}

async function assertBootstrapPrivilege(queryRunner: QueryRunner, migrationName: string): Promise<void> {
  const rows = (await queryRunner.query(
    `SELECT rolname, rolsuper, rolcreaterole FROM pg_roles WHERE rolname = current_user`,
  )) as Array<{ rolsuper: boolean; rolcreaterole: boolean; rolname: string }>;
  const [row] = rows;
  if (!row || !(row.rolsuper || row.rolcreaterole)) {
    throw new Error(
      `${migrationName} refuses to run as '${row?.rolname ?? 'unknown'}': this migration redefines a function owned by ` +
        `rab_secure_owner, which requires the connecting role to be a superuser or have CREATEROLE. Re-run with ` +
        `DATABASE_URL_UNPOOLED pointed at the privileged bootstrap connection — never the ordinary crewflow runtime credential.`,
    );
  }
}
