import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * P0 finalization (FULL-ARCHITECTURE-UPGRADE-PLAN.md §8.3 / §29 P0.3-sibling finding): the
 * cleanup window inside `core.worker_cleanup_auth_tokens` (added by
 * `WorkerRuntimeFunctions1786676500000`) deleted a revoked/expired `refresh_token` row 30 days
 * after it went dead, while `session-policy.ts`'s own `ABSOLUTE_SESSION_TTL_MS` allows a
 * `staff_app`/`venue_manager_app` family to stay LIVE for up to 90 days. A token rotated away
 * early in such a family's life (e.g. on day 5) was deleted on day 35 — more than 50 days before
 * that family's own absolute deadline — destroying the one row `RefreshTokenService.rotate()`'s
 * reuse-detection check depends on (`findOne(RefreshToken, {where:{tokenHash}})`): once the row
 * is gone, a replay of that old token returns a generic "Invalid refresh token" instead of
 * detecting reuse and revoking the still-live family. This is the exact gap: destroying security
 * evidence (reuse-detection capability) before the thing it protects (the session family) has
 * even ended.
 *
 * Fix: both predicates inside the function body — `revoked_at < now() - interval '30 days'` and
 * `expires_at < now() - interval '30 days'` — are bumped to `interval '91 days'`, one day beyond
 * the longest ABSOLUTE_SESSION_TTL_MS this codebase currently supports (90 days). Retention now
 * always exceeds the longest live family, for every application target, by construction — see
 * `rab-server/src/engine/core-modules/auth/token/retention-policy.ts` (new, this migration's
 * TypeScript-side companion) for the regression guard that keeps this true if the 90-day constant
 * is ever raised without this migration being revisited.
 *
 * Nothing else about the function changes: same `SECURITY DEFINER`, same `search_path`, same
 * `LANGUAGE plpgsql`, same advisory-lock serialization, same batch bound (`LEAST(GREATEST(...,
 * 1), 10000)`), same grants (unaffected by `CREATE OR REPLACE FUNCTION`, confirmed — a
 * `CREATE OR REPLACE` never touches existing grants). Opaque token design, SHA-256 hashing,
 * rotation, family semantics, and reuse-detection logic itself (`rotate()`, `RefreshTokenReuseError`)
 * are all untouched — this migration only changes WHEN a dead row is deleted, never whether a
 * live row is ever retained forever (rows are still deleted, just later).
 *
 * down() restores the exact original 30-day function body verbatim.
 */
export class RefreshReuseRetentionExtension1786677900000 implements MigrationInterface {
  name = 'RefreshReuseRetentionExtension1786677900000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION core.worker_cleanup_auth_tokens(p_batch integer)
      RETURNS TABLE (refresh_tokens_deleted integer, password_reset_tokens_deleted integer)
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = core, pg_catalog
      AS $function$
      DECLARE
        v_batch integer := LEAST(GREATEST(COALESCE(p_batch, 1000), 1), 10000);
        v_refresh integer;
        v_reset integer;
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtext('rab_token_cleanup'));

        DELETE FROM core.refresh_token
         WHERE id IN (
           SELECT id FROM core.refresh_token
            WHERE (revoked_at IS NOT NULL AND revoked_at < now() - interval '91 days')
               OR (expires_at < now() - interval '91 days')
            LIMIT v_batch
         );
        GET DIAGNOSTICS v_refresh = ROW_COUNT;

        DELETE FROM core.password_reset_token
         WHERE id IN (
           SELECT id FROM core.password_reset_token
            WHERE (used_at IS NOT NULL AND used_at < now() - interval '91 days')
               OR (expires_at < now() - interval '91 days')
            LIMIT v_batch
         );
        GET DIAGNOSTICS v_reset = ROW_COUNT;

        refresh_tokens_deleted := v_refresh;
        password_reset_tokens_deleted := v_reset;
        RETURN NEXT;
      END
      $function$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION core.worker_cleanup_auth_tokens(p_batch integer)
      RETURNS TABLE (refresh_tokens_deleted integer, password_reset_tokens_deleted integer)
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = core, pg_catalog
      AS $function$
      DECLARE
        v_batch integer := LEAST(GREATEST(COALESCE(p_batch, 1000), 1), 10000);
        v_refresh integer;
        v_reset integer;
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtext('rab_token_cleanup'));

        DELETE FROM core.refresh_token
         WHERE id IN (
           SELECT id FROM core.refresh_token
            WHERE (revoked_at IS NOT NULL AND revoked_at < now() - interval '30 days')
               OR (expires_at < now() - interval '30 days')
            LIMIT v_batch
         );
        GET DIAGNOSTICS v_refresh = ROW_COUNT;

        DELETE FROM core.password_reset_token
         WHERE id IN (
           SELECT id FROM core.password_reset_token
            WHERE (used_at IS NOT NULL AND used_at < now() - interval '30 days')
               OR (expires_at < now() - interval '30 days')
            LIMIT v_batch
         );
        GET DIAGNOSTICS v_reset = ROW_COUNT;

        refresh_tokens_deleted := v_refresh;
        password_reset_tokens_deleted := v_reset;
        RETURN NEXT;
      END
      $function$;
    `);
  }
}
