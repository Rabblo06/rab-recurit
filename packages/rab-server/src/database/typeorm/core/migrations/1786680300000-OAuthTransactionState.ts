import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * P1C.1B, Migration D (FULL-ARCHITECTURE-UPGRADE-PLAN.md §33.7.10, P1C.1B brief §3 Migration D).
 *
 * Server-held, single-use OAuth transaction state (state/PKCE/nonce/return path) for the
 * Google/Microsoft login flows — never inlined into the `state` query parameter the way
 * Twenty's own login flow does (P1C.1A audit finding: Twenty's login OAuth state is unsigned
 * JSON with no PKCE/nonce; Crewflow's design strengthens this).
 *
 * No `organisation_id` — by definition, this row is created and consumed BEFORE any identity is
 * known (that's the whole point of an OAuth redirect round-trip), so there is no tenant to scope
 * to, ever, not even transiently. This is a genuinely global, short-lived table, same
 * no-RLS-at-all justification class as `core.organisation`/`core.platform_admin` but for a
 * different reason (no owning tenant will ever exist for this row, not merely "not yet known").
 *
 * Lifetime: 10 minutes (`expires_at`). Consumption is atomic and one-time via a single
 * `UPDATE ... WHERE id = $1 AND provider = $2 AND consumed_at IS NULL AND expires_at > now()
 * RETURNING *` — a replay (second consume attempt) matches zero rows and is rejected, never
 * silently re-accepted.
 *
 * NO Redis in this checkpoint (owner instruction, P1C.1B brief §3 Migration D) — PostgreSQL is
 * authoritative. Cleanup mirrors the EXISTING worker-runtime maintenance pattern exactly
 * (`core.worker_cleanup_auth_tokens`, WorkerRuntimeFunctions1786676500000): a SECURITY DEFINER
 * function owned by `rab_owner`, executable only by `rab_app`, serialised by its own transaction
 * advisory-lock key, bounded batch size, fixed retention window baked into the function (not
 * caller-supplied). The retention window here is 1 hour past expiry/consumption, not 30 days —
 * this data has zero legitimate use after one callback round-trip, so there is no forensic
 * reason to keep it anywhere near as long as session/token history.
 */
export class OAuthTransactionState1786680300000 implements MigrationInterface {
  name = 'OAuthTransactionState1786680300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE core.oauth_transaction_state (
        id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        provider            text NOT NULL CHECK (provider IN ('google', 'microsoft')),
        pkce_code_verifier  text NOT NULL,
        nonce               text NOT NULL,
        return_to_path      text,
        created_at          timestamptz NOT NULL DEFAULT now(),
        expires_at          timestamptz NOT NULL,
        consumed_at         timestamptz,
        CONSTRAINT oauth_transaction_state_expiry_check CHECK (expires_at > created_at),
        -- Enforced again in application code (same-origin relative path only) — this is a cheap,
        -- structural backstop against an absolute-URL/protocol-relative/javascript:/data: value
        -- ever being persisted in the first place.
        CONSTRAINT oauth_transaction_state_return_to_path_check
          CHECK (return_to_path IS NULL OR (return_to_path LIKE '/%' AND return_to_path NOT LIKE '//%'))
      );
    `);
    await queryRunner.query(`CREATE INDEX oauth_transaction_state_lookup_idx ON core.oauth_transaction_state (id, provider) WHERE consumed_at IS NULL;`);
    await queryRunner.query(`CREATE INDEX oauth_transaction_state_cleanup_idx ON core.oauth_transaction_state (expires_at);`);

    // No RLS — see this migration's own doc comment above for why that's correct here, not an
    // oversight. No blanket grant either: `core.organisation`/`core.platform_admin` are the only
    // other no-RLS tables, and both are column-tightened too (CLAUDE.md's existing allowlist).
    await queryRunner.query(`REVOKE ALL ON core.oauth_transaction_state FROM rab_app;`);
    await queryRunner.query(`
      GRANT INSERT (id, provider, pkce_code_verifier, nonce, return_to_path, created_at, expires_at)
        ON core.oauth_transaction_state TO rab_app;
    `);
    await queryRunner.query(`GRANT UPDATE (consumed_at) ON core.oauth_transaction_state TO rab_app;`);
    await queryRunner.query(`GRANT SELECT ON core.oauth_transaction_state TO rab_app;`);

    await queryRunner.query(`
      CREATE FUNCTION core.worker_cleanup_oauth_transaction_state(p_batch integer)
      RETURNS TABLE (rows_deleted integer)
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = core, pg_catalog
      AS $function$
      DECLARE
        v_batch integer := LEAST(GREATEST(COALESCE(p_batch, 1000), 1), 10000);
        v_deleted integer;
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtext('rab_oauth_transaction_state_cleanup'));

        DELETE FROM core.oauth_transaction_state
         WHERE id IN (
           SELECT id FROM core.oauth_transaction_state
            WHERE expires_at < now() - interval '1 hour'
               OR (consumed_at IS NOT NULL AND consumed_at < now() - interval '1 hour')
            LIMIT v_batch
         );
        GET DIAGNOSTICS v_deleted = ROW_COUNT;

        rows_deleted := v_deleted;
        RETURN NEXT;
      END
      $function$;
    `);
    await queryRunner.query(`REVOKE ALL ON FUNCTION core.worker_cleanup_oauth_transaction_state(integer) FROM PUBLIC;`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION core.worker_cleanup_oauth_transaction_state(integer) TO rab_app;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP FUNCTION IF EXISTS core.worker_cleanup_oauth_transaction_state(integer);`);
    await queryRunner.query(`DROP TABLE IF EXISTS core.oauth_transaction_state;`);
  }
}
