import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * P1C.1B, Migration C (FULL-ARCHITECTURE-UPGRADE-PLAN.md §33.7.5, P1C.1B brief §3).
 *
 * Durable provider-identity -> Crewflow-user mapping for Google/Microsoft sign-in. Needed
 * because email alone is not a safe durable linking key (a provider's own stable subject
 * claim is); email is used only for the FIRST-LINK discovery step against an EXISTING,
 * already-invited Crewflow account — never to auto-create one (invite-only signup is
 * preserved, confirmed unchanged by the P1C.1A audit).
 *
 * `provider_subject` for Google is the validated OIDC `sub` claim. For Microsoft it is a
 * normalised `<tenantId>:<objectId>` string (never the bare `sub`/UPN/email) — see
 * `microsoft-identity.util.ts` — specifically so the same value can never collide across two
 * different Azure AD tenants even if Microsoft ever reused a raw object id (it doesn't in
 * practice, but the normalised form costs nothing and removes the assumption).
 *
 * `UNIQUE (provider, provider_subject)`: one external identity resolves to exactly one Crewflow
 * user — the core takeover-prevention control. `UNIQUE (user_id, provider)`: one link per
 * provider per user — prevents silent accumulation of stale links.
 *
 * SECURITY TRADE-OFF — RLS is ENABLEd but deliberately NOT FORCEd, the same exemption already
 * applied to `refresh_token`/`password_reset_token`/`account_invite` (PreAuthLookupFunctions
 * 1786667400000, AccountInviteSchema1786670100000) and documented in CLAUDE.md's own
 * NOT_FORCED_ALLOWLIST. First attempt at this migration tried to keep FORCE on the theory that
 * the SECURITY DEFINER lookup function below would be enough on its own — that was WRONG, caught
 * by this table's own integration test (`p1c1b-auth-providers.integration.spec.ts`), not assumed
 * safe: FORCE extends RLS enforcement to the table OWNER too, including a SECURITY DEFINER
 * function executing AS that owner — exactly the lesson `core.user_session`'s own
 * `count_user_session_backfill_status()` already taught this codebase once
 * (`UserSession1786678000000`'s own doc comment: "a plain unbound ... function therefore sees
 * ZERO rows"). A SECURITY DEFINER function is not a FORCE bypass by itself; only NOT FORCE is.
 * `rab_app` (the runtime role, never the owner) is fully bound by the policies below regardless —
 * this exemption only ever affects the owner connection's own pre-auth lookup path. Self-scoped
 * INSERT (the linking write only ever happens for the currently-resolving identity, never on
 * another user's behalf) and organisation-scoped SELECT/UPDATE (an org's own admin-visible
 * "linked accounts" list, if ever built, is a later concern — not built this checkpoint).
 *
 * Grants start column-tightened from creation (never a retrofit like P1B.1 had to do for
 * `user_session`): no DELETE at all (unlinking a provider identity is not a feature this
 * checkpoint builds); UPDATE restricted to `last_used_at` only (every other column is an
 * identity fact, fixed at link time).
 */
export class UserAuthIdentity1786680200000 implements MigrationInterface {
  name = 'UserAuthIdentity1786680200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE core.user_auth_identity (
        id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organisation_id         uuid NOT NULL REFERENCES core.organisation(id) ON DELETE CASCADE,
        user_id                 uuid NOT NULL REFERENCES core."user"(id) ON DELETE CASCADE,
        provider                text NOT NULL CHECK (provider IN ('google', 'microsoft')),
        provider_subject        text NOT NULL CHECK (char_length(provider_subject) BETWEEN 1 AND 256),
        verified_email_snapshot citext NOT NULL,
        created_at              timestamptz NOT NULL DEFAULT now(),
        last_used_at            timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT user_auth_identity_provider_subject_uq UNIQUE (provider, provider_subject),
        CONSTRAINT user_auth_identity_user_provider_uq UNIQUE (user_id, provider)
      );
    `);
    await queryRunner.query(`CREATE INDEX user_auth_identity_org_idx ON core.user_auth_identity (organisation_id);`);
    await queryRunner.query(`CREATE INDEX user_auth_identity_user_idx ON core.user_auth_identity (user_id);`);

    await queryRunner.query(`ALTER TABLE core.user_auth_identity ENABLE ROW LEVEL SECURITY;`);
    // NOT FORCEd — see this migration's own doc comment (SECURITY TRADE-OFF) above.
    await queryRunner.query(`
      CREATE POLICY user_auth_identity_select ON core.user_auth_identity
        FOR SELECT USING (organisation_id = core.current_org());
    `);
    await queryRunner.query(`
      CREATE POLICY user_auth_identity_insert ON core.user_auth_identity
        FOR INSERT WITH CHECK (organisation_id = core.current_org() AND user_id = core.current_uid());
    `);
    await queryRunner.query(`
      CREATE POLICY user_auth_identity_update ON core.user_auth_identity
        FOR UPDATE USING (organisation_id = core.current_org()) WITH CHECK (organisation_id = core.current_org());
    `);

    await queryRunner.query(`REVOKE ALL ON core.user_auth_identity FROM rab_app;`);
    await queryRunner.query(`GRANT SELECT ON core.user_auth_identity TO rab_app;`);
    await queryRunner.query(`
      GRANT INSERT (
        id, organisation_id, user_id, provider, provider_subject, verified_email_snapshot, created_at, last_used_at
      ) ON core.user_auth_identity TO rab_app;
    `);
    await queryRunner.query(`GRANT UPDATE (last_used_at) ON core.user_auth_identity TO rab_app;`);

    // Pre-auth lookup: resolve WHICH Crewflow user+org a validated provider identity belongs to,
    // before any tenant context exists — exactly the pattern PreAuthLookupFunctions1786667400000
    // already established for refresh_token/password_reset_token/account_invite. Bounded input
    // (provider is checked against the closed set before this function is ever reached, but the
    // CHECK on the underlying column is the real backstop), no SELECT *, no arbitrary user lookup
    // — returns nothing for an unknown pair rather than throwing, matching
    // `auth_find_account_invite_org`'s own miss behaviour.
    await queryRunner.query(`
      CREATE FUNCTION core.auth_find_user_by_provider_identity(p_provider text, p_subject text)
      RETURNS TABLE ("userId" uuid, "organisationId" uuid)
      LANGUAGE sql SECURITY DEFINER SET search_path = core, pg_catalog
      AS $$
        SELECT user_id, organisation_id FROM core.user_auth_identity
        WHERE provider = p_provider AND provider_subject = p_subject;
      $$;
    `);
    await queryRunner.query(`REVOKE ALL ON FUNCTION core.auth_find_user_by_provider_identity(text, text) FROM PUBLIC;`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION core.auth_find_user_by_provider_identity(text, text) TO rab_app;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP FUNCTION IF EXISTS core.auth_find_user_by_provider_identity(text, text);`);
    await queryRunner.query(`DROP TABLE IF EXISTS core.user_auth_identity;`);
  }
}
