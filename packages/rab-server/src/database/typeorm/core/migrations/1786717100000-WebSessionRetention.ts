import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Twenty-parity web sessions (owner decision 2026-10-14): `session-policy.ts` now lets a manager-tier web session live
 * 180 days. `core.worker_cleanup_auth_tokens` deleted dead refresh-token rows 91 days after expiry/revocation. A cookie
 * session never rotates its refresh row (the row's own `expires_at` is clamped to 30 days), and per-request liveness
 * requires a non-revoked row of the family with `family_expires_at > now()` — so with 91 days the row was deleted at
 * day 121 and a still-valid 180-day session would be logged out early. Retention becomes 181 days, one day beyond the
 * longest absolute session (the same invariant `token/retention-policy.ts` asserts in CI).
 *
 * Only the four interval literals change; SECURITY DEFINER, owner, search_path, lock, batch bound and grants are
 * untouched (CREATE OR REPLACE keeps the existing owner and grants). down() restores the 91-day body verbatim.
 */
export class WebSessionRetention1786717100000 implements MigrationInterface {
  name = 'WebSessionRetention1786717100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION core.worker_cleanup_auth_tokens(p_batch integer)
      RETURNS TABLE(refresh_tokens_deleted integer, password_reset_tokens_deleted integer)
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path TO 'core', 'pg_catalog'
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
            WHERE (revoked_at IS NOT NULL AND revoked_at < now() - interval '181 days')
               OR (expires_at < now() - interval '181 days')
            LIMIT v_batch
         );
        GET DIAGNOSTICS v_refresh = ROW_COUNT;

        DELETE FROM core.password_reset_token
         WHERE id IN (
           SELECT id FROM core.password_reset_token
            WHERE (used_at IS NOT NULL AND used_at < now() - interval '181 days')
               OR (expires_at < now() - interval '181 days')
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
      RETURNS TABLE(refresh_tokens_deleted integer, password_reset_tokens_deleted integer)
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path TO 'core', 'pg_catalog'
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
}
