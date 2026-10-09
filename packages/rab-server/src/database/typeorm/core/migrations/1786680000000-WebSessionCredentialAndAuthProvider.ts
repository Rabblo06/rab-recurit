import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * P1C.1B, Migration A (FULL-ARCHITECTURE-UPGRADE-PLAN.md §33.7.4/§33.7.5).
 *
 * Two additive changes to `core.user_session`, both schema-only this checkpoint:
 *
 * 1. `web_session_token_hash` — the Twenty-style opaque web session credential's hash. OWNER
 *    DECISION (P1C.1B brief §1): this checkpoint creates the column but does NOT populate it —
 *    no code path generates or writes a raw credential yet. It stays NULL for every session
 *    created by P1C.1B; P1C.1C is what starts issuing the real value. This is deliberate, not an
 *    oversight: generating a bearer-strength secret with no corresponding browser cookie and no
 *    validation consumer would be a secret with no purpose and no way to prove it was ever
 *    handled correctly.
 *
 * 2. `auth_provider` closes to a real set (`password`/`google`/`microsoft`) via CHECK, and — unlike
 *    the credential hash — IS populated starting now: `RefreshTokenService.issue()` is updated in
 *    this same checkpoint to write it for every new session (password login writes 'password';
 *    P1C.1B's Google/Microsoft flows write their own). The column existed since P1B
 *    (UserSession1786678000000) but no INSERT path has ever populated it until this migration's
 *    accompanying code change — confirmed by reading every call site, not assumed (P1C.1A audit,
 *    FULL-ARCHITECTURE-UPGRADE-PLAN.md §33.7.2). Historical rows predating this migration keep
 *    their existing NULL value — no backfill, no guessing which provider a historical row used.
 *
 * Both new columns join the EXISTING `user_session_mutation_guard` trigger's immutable-column
 * list (UserSessionColumnPrivilegeTightening1786679000000) — a session's own provider and
 * credential hash are identity facts fixed at creation, never legitimately rewritten afterward.
 * Neither is added to the UPDATE column grant.
 *
 * `core.login_history.provider` is the minor addendum named in the same audit (§33.7.5) — nullable,
 * same closed vocabulary, populated going forward, NULL for every historical row.
 */
export class WebSessionCredentialAndAuthProvider1786680000000 implements MigrationInterface {
  name = 'WebSessionCredentialAndAuthProvider1786680000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE core.user_session ADD COLUMN web_session_token_hash text;`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX user_session_web_token_hash_uq
        ON core.user_session (web_session_token_hash)
        WHERE web_session_token_hash IS NOT NULL;
    `);
    await queryRunner.query(`
      ALTER TABLE core.user_session
        ADD CONSTRAINT user_session_auth_provider_closed
        CHECK (auth_provider IS NULL OR auth_provider IN ('password', 'google', 'microsoft'));
    `);

    // Extend the P1B.1 mutation-invariant trigger function in place — same function, same
    // trigger, one more clause in the existing "identity/expiry columns are immutable after
    // creation" IF block. Re-`CREATE OR REPLACE`, not a new function/trigger.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION core.enforce_user_session_mutation_invariants() RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = core, pg_catalog
      AS $$
      BEGIN
        IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
          RAISE EXCEPTION 'user_session: revoked_at is immutable once set (session %)', OLD.id;
        END IF;
        IF OLD.revoked_at IS NOT NULL AND NEW.revoked_reason IS DISTINCT FROM OLD.revoked_reason THEN
          RAISE EXCEPTION 'user_session: revoked_reason is immutable once set (session %)', OLD.id;
        END IF;
        IF NEW.security_version IS DISTINCT FROM OLD.security_version THEN
          IF NEW.security_version IS DISTINCT FROM OLD.security_version + 1 THEN
            RAISE EXCEPTION 'user_session: security_version may only move by exactly +1 per update (session %)', OLD.id;
          END IF;
          IF NOT (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL) THEN
            RAISE EXCEPTION 'user_session: security_version may only change alongside a revocation transition (session %)', OLD.id;
          END IF;
        END IF;
        IF NEW.id IS DISTINCT FROM OLD.id
           OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id
           OR NEW.user_id IS DISTINCT FROM OLD.user_id
           OR NEW.application_target IS DISTINCT FROM OLD.application_target
           OR NEW.absolute_expires_at IS DISTINCT FROM OLD.absolute_expires_at
           OR NEW.created_at IS DISTINCT FROM OLD.created_at
           OR NEW.web_session_token_hash IS DISTINCT FROM OLD.web_session_token_hash
           OR NEW.auth_provider IS DISTINCT FROM OLD.auth_provider
        THEN
          RAISE EXCEPTION 'user_session: this column is immutable after creation (session %)', OLD.id;
        END IF;
        RETURN NEW;
      END;
      $$;
    `);

    // Extend the explicit INSERT column grant (P1B.1) to the two new columns. The UPDATE grant
    // (last_seen_at, revoked_at, revoked_reason, security_version) is untouched — a credential
    // hash or provider that could be rewritten post-creation is a session-fixation vector.
    await queryRunner.query(`REVOKE INSERT ON core.user_session FROM rab_app;`);
    await queryRunner.query(`
      GRANT INSERT (
        id, organisation_id, user_id, workspace_id, application_target,
        device_id, user_agent, ip_address, created_at, last_seen_at,
        absolute_expires_at, web_session_token_hash, auth_provider
      ) ON core.user_session TO rab_app;
    `);

    await queryRunner.query(`ALTER TABLE core.login_history ADD COLUMN provider text;`);
    await queryRunner.query(`
      ALTER TABLE core.login_history
        ADD CONSTRAINT login_history_provider_closed
        CHECK (provider IS NULL OR provider IN ('password', 'google', 'microsoft'));
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE core.login_history DROP CONSTRAINT IF EXISTS login_history_provider_closed;`);
    await queryRunner.query(`ALTER TABLE core.login_history DROP COLUMN IF EXISTS provider;`);

    await queryRunner.query(`REVOKE INSERT ON core.user_session FROM rab_app;`);
    await queryRunner.query(`
      GRANT INSERT (
        id, organisation_id, user_id, workspace_id, application_target,
        device_id, user_agent, ip_address, created_at, last_seen_at, absolute_expires_at
      ) ON core.user_session TO rab_app;
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION core.enforce_user_session_mutation_invariants() RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = core, pg_catalog
      AS $$
      BEGIN
        IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
          RAISE EXCEPTION 'user_session: revoked_at is immutable once set (session %)', OLD.id;
        END IF;
        IF OLD.revoked_at IS NOT NULL AND NEW.revoked_reason IS DISTINCT FROM OLD.revoked_reason THEN
          RAISE EXCEPTION 'user_session: revoked_reason is immutable once set (session %)', OLD.id;
        END IF;
        IF NEW.security_version IS DISTINCT FROM OLD.security_version THEN
          IF NEW.security_version IS DISTINCT FROM OLD.security_version + 1 THEN
            RAISE EXCEPTION 'user_session: security_version may only move by exactly +1 per update (session %)', OLD.id;
          END IF;
          IF NOT (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL) THEN
            RAISE EXCEPTION 'user_session: security_version may only change alongside a revocation transition (session %)', OLD.id;
          END IF;
        END IF;
        IF NEW.id IS DISTINCT FROM OLD.id
           OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id
           OR NEW.user_id IS DISTINCT FROM OLD.user_id
           OR NEW.application_target IS DISTINCT FROM OLD.application_target
           OR NEW.absolute_expires_at IS DISTINCT FROM OLD.absolute_expires_at
           OR NEW.created_at IS DISTINCT FROM OLD.created_at
        THEN
          RAISE EXCEPTION 'user_session: this column is immutable after creation (session %)', OLD.id;
        END IF;
        RETURN NEW;
      END;
      $$;
    `);

    await queryRunner.query(`ALTER TABLE core.user_session DROP CONSTRAINT IF EXISTS user_session_auth_provider_closed;`);
    await queryRunner.query(`DROP INDEX IF EXISTS core.user_session_web_token_hash_uq;`);
    await queryRunner.query(`ALTER TABLE core.user_session DROP COLUMN IF EXISTS web_session_token_hash;`);
  }
}
