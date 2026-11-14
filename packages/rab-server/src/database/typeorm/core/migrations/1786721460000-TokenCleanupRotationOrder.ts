import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase X Part 2, XP-09 (SQL owner-review pending; docs/plans/phase-x2/XP-09-SQL.md): the token cleanup can split a rotated
 * chain across a batch boundary and then fail on every run.
 *
 * `core.refresh_token.replaced_by` is a NO ACTION self-FK, predecessor → successor (RefreshTokenService.rotate inserts the
 * successor, then sets the predecessor's revoked_at and replaced_by). The cleanup (WebSessionRetention1786717100000) deleted
 * `WHERE id IN (SELECT id … LIMIT v_batch)` with NO order, i.e. in heap order. Once deletes and (auto)vacuum leave free space in
 * early pages, a new successor is stored before its predecessor, so a batch can take the successor without the predecessor:
 * the DELETE fails with 23503 (refresh_token_replaced_by_fkey), the whole batch rolls back, and the next run picks the same
 * rows again — the cleanup never deletes anything again (reproduced on throwaway PG16 and PG18, XP-09-SQL.md).
 *
 * The new body selects the batch oldest first (`ORDER BY created_at, id`): a successor is always created after its predecessor,
 * and an eligible successor's predecessor is eligible too (it was revoked when the successor was created), so a predecessor is
 * in the same or an earlier batch. A safety net keeps, for this run, any batch row still referenced by a row that is NOT
 * being deleted, and transitively that row's successors; they go in a later run, after their predecessor. Nothing else
 * changes: the same 181-day windows, batch bound (1..10,000), advisory lock, password-reset branch, return shape, SECURITY
 * DEFINER, owner (rab_secure_owner; CREATE OR REPLACE keeps owner and grants) and search_path (`pg_catalog, core, pg_temp`,
 * as DatabaseDefenceInDepth1786717900000 set it). down() restores the previous body verbatim.
 */
const SIGNATURE = 'core.worker_cleanup_auth_tokens(integer)';
const EXPECTED_STATE = 'rab_secure_owner|true|search_path=pg_catalog, core, pg_temp';

export const TOKEN_CLEANUP_ROTATION_ORDER_SQL = `
CREATE OR REPLACE FUNCTION core.worker_cleanup_auth_tokens(p_batch integer)
RETURNS TABLE(refresh_tokens_deleted integer, password_reset_tokens_deleted integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, core, pg_temp
AS $function$
DECLARE
  v_batch integer := LEAST(GREATEST(COALESCE(p_batch, 1000), 1), 10000);
  v_refresh integer;
  v_reset integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('rab_token_cleanup'));

  -- replaced_by is a NO ACTION self-FK (predecessor -> successor): a successor may only be deleted together with, or after,
  -- every row that references it. Oldest first, so an eligible predecessor is in the same or an earlier batch than its
  -- successor. Safety net: a batch row still referenced by a row outside the batch is kept, and so is every successor of a
  -- kept row (transitively); a later run deletes them after their predecessor.
  WITH RECURSIVE batch AS MATERIALIZED (
    SELECT rt.id FROM core.refresh_token rt
     WHERE (rt.revoked_at IS NOT NULL AND rt.revoked_at < now() - interval '181 days')
        OR (rt.expires_at < now() - interval '181 days')
     ORDER BY rt.created_at, rt.id
     LIMIT v_batch
  ), kept(id) AS (
    SELECT b.id FROM batch b
     WHERE EXISTS (SELECT 1 FROM core.refresh_token p
                    WHERE p.replaced_by = b.id
                      AND NOT EXISTS (SELECT 1 FROM batch x WHERE x.id = p.id))
    UNION
    SELECT s.replaced_by FROM kept k JOIN core.refresh_token s ON s.id = k.id
     WHERE s.replaced_by IS NOT NULL
       AND EXISTS (SELECT 1 FROM batch x WHERE x.id = s.replaced_by)
  )
  DELETE FROM core.refresh_token
   WHERE id IN (SELECT id FROM batch EXCEPT SELECT id FROM kept);
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
$function$`;

/** The body WebSessionRetention1786717100000 installed (search_path as DatabaseDefenceInDepth1786717900000 left it). */
export const TOKEN_CLEANUP_PREVIOUS_SQL = `
CREATE OR REPLACE FUNCTION core.worker_cleanup_auth_tokens(p_batch integer)
RETURNS TABLE(refresh_tokens_deleted integer, password_reset_tokens_deleted integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, core, pg_temp
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
      $function$`;

const STATE_SQL = `
SELECT pg_catalog.pg_get_userbyid(p.proowner)::text || '|' || p.prosecdef::text || '|' || COALESCE(pg_catalog.array_to_string(p.proconfig, ';'), '') AS state,
       COALESCE((SELECT pg_catalog.string_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END, '+'
                                             ORDER BY CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END)
                   FROM pg_catalog.aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE'), '') AS execute_grantees
  FROM pg_catalog.pg_proc p WHERE p.oid = '${SIGNATURE}'::pg_catalog.regprocedure`;

export class TokenCleanupRotationOrder1786721460000 implements MigrationInterface {
  name = 'TokenCleanupRotationOrder1786721460000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.replace(queryRunner, TOKEN_CLEANUP_ROTATION_ORDER_SQL);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await this.replace(queryRunner, TOKEN_CLEANUP_PREVIOUS_SQL);
  }

  /** Replaces the body; owner, SECURITY DEFINER, search_path and the EXECUTE grantees must be exactly as before (or it rolls back). */
  private async replace(queryRunner: QueryRunner, sql: string): Promise<void> {
    const [{ ok }] = await queryRunner.query(`SELECT pg_catalog.pg_has_role(current_user, 'rab_secure_owner', 'USAGE') AS ok`);
    if (!ok) throw new Error(`${this.name} must run as the migration identity (a member of rab_secure_owner, which owns ${SIGNATURE})`);
    const [before] = (await queryRunner.query(STATE_SQL)) as Array<{ state: string; execute_grantees: string }>;
    if (before?.state !== EXPECTED_STATE) throw new Error(`${this.name}: unexpected state of ${SIGNATURE} before the change: ${before?.state ?? 'absent'}`);
    await queryRunner.query(sql);
    // P3 (migration-object-ownership.spec.ts): every migration states the owner of each core object it (re)creates. CREATE OR
    // REPLACE already kept rab_secure_owner, so this changes nothing (same owner); it makes the ownership explicit here.
    await queryRunner.query(`ALTER FUNCTION core.worker_cleanup_auth_tokens(integer) OWNER TO rab_secure_owner`);
    const [after] = (await queryRunner.query(STATE_SQL)) as Array<{ state: string; execute_grantees: string }>;
    if (after?.state !== EXPECTED_STATE || after.execute_grantees !== before.execute_grantees) {
      throw new Error(`${this.name}: ${SIGNATURE} changed owner, definer, search_path or grants (rolled back): ${after?.state} / ${after?.execute_grantees}`);
    }
  }
}
