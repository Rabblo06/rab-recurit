import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * P1C.1C (FULL-ARCHITECTURE-UPGRADE-PLAN.md §33.8/§33.9) — genuine cookie-first browser
 * authentication. The web frontend stops attaching a JS-held Bearer JWT for ordinary requests;
 * `JwtAuthGuard` instead resolves the `crewflow_session` HttpOnly cookie (hash already stored in
 * `core.user_session.web_session_token_hash` since P1C.1B, but never populated or validated until
 * now) to the canonical `{sid, sub, org}` triple and feeds it into the SAME, unmodified
 * `AuthSecuritySnapshotService.build()` the JWT path already uses.
 *
 * SECURITY TRADE-OFF — `core.user_session` drops FORCE ROW LEVEL SECURITY, joining the established
 * NOT_FORCED_ALLOWLIST (`refresh_token`, `password_reset_token`, `account_invite`,
 * `user_auth_identity`). This is the SAME lesson P1C.1B already re-learned once for
 * `user_auth_identity` in this same program, applied correctly this time from the start: resolving
 * an opaque cookie to a session identity is, by definition, a PRE-AUTH lookup — no tenant context
 * can exist yet, because establishing that context is literally what this lookup is for. FORCE RLS
 * binds the table OWNER too, including inside SECURITY DEFINER function execution (confirmed
 * directly, not assumed — `UserSession1786678000000`'s own `count_user_session_backfill_status()`
 * doc comment already documents this exact mechanism), so a FORCE'd `core.user_session` makes any
 * owner-executed pre-auth lookup function return zero rows, always. `rab_app` — the role every real
 * request actually runs as, and the role every existing RLS-dependent read/write in this codebase
 * already goes through — is NEVER the table owner and remains FULLY bound by every USING/WITH CHECK
 * predicate on this table regardless of the FORCE flag (CLAUDE.md's own standing invariant, and
 * `tools/check-rls-coverage.ts` asserts `rab_app` has `rolbypassrls = false` and connects as itself,
 * never the owner, specifically to catch any drift from this). The only privilege this migration
 * changes is which role's SECURITY DEFINER functions may read this table unscoped — owner-only,
 * exercised solely by the one narrow lookup function below, which returns only the three columns a
 * pre-auth identity resolution needs (never a full row, never a cross-user listing).
 *
 * The new function, `core.auth_find_session_by_web_token_hash`, is intentionally NOT a second
 * authority: it is the cookie-path's exact analogue of "extract the JWT's sid/sub/org claims" —
 * a bounded lookup, not a liveness/authorization decision. Liveness, revocation, roles, permissions
 * and every other security input remain the sole responsibility of the UNMODIFIED
 * `AuthSecuritySnapshotService.build()` → `SessionValidityService.assertActive()` chain, called
 * identically for both the Bearer-JWT and the cookie path.
 */
export class WebSessionCookieAuthentication1786681000000 implements MigrationInterface {
  name = 'WebSessionCookieAuthentication1786681000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE core.user_session NO FORCE ROW LEVEL SECURITY;`);

    // Pre-auth lookup: resolve a validated opaque cookie's hash to the session identity needed to
    // call AuthSecuritySnapshotService.build({sid, sub, org}) — the EXACT three inputs the JWT path
    // already extracts from signed claims. Bounded input (a hash is a fixed-length hex string, but
    // no length/shape assumption is encoded here — the caller validates shape before hashing, same
    // division of responsibility PreAuthLookupFunctions1786667400000 already uses), no SELECT *, no
    // arbitrary user lookup, returns nothing for an unknown hash rather than throwing (matching
    // every other pre-auth function's own miss behaviour). Deliberately does NOT filter on
    // revoked_at/absolute_expires_at here — liveness stays the sole responsibility of
    // SessionValidityService.assertActive (called downstream, unconditionally, on every request
    // regardless of credential transport) so there is exactly one liveness authority, never two
    // that could silently disagree.
    await queryRunner.query(`
      CREATE FUNCTION core.auth_find_session_by_web_token_hash(p_hash text)
      RETURNS TABLE ("sessionId" uuid, "userId" uuid, "organisationId" uuid, "applicationTarget" text)
      LANGUAGE sql SECURITY DEFINER SET search_path = core, pg_catalog
      AS $$
        SELECT id, user_id, organisation_id, application_target
        FROM core.user_session
        WHERE web_session_token_hash = p_hash;
      $$;
    `);
    await queryRunner.query(`REVOKE ALL ON FUNCTION core.auth_find_session_by_web_token_hash(text) FROM PUBLIC;`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION core.auth_find_session_by_web_token_hash(text) TO rab_app;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP FUNCTION IF EXISTS core.auth_find_session_by_web_token_hash(text);`);
    await queryRunner.query(`ALTER TABLE core.user_session FORCE ROW LEVEL SECURITY;`);
  }
}
