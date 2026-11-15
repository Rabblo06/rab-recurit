import { MigrationInterface, QueryRunner } from 'typeorm';

import { secureOwnerInvariantViolations } from '../secure-owner-invariants';
import { INVITE_CLEANUP_EXPECTED, INVITE_CLEANUP_STATE_SQL } from '../worker-dispatch-pointer-sql';

/**
 * Owner decision 0g (user deletion the Twenty way), security review L2 — owner-approved 2026-11-15 as USER-DELETION.md
 * "Draft D". The Worker's account-invite cleanup must never hard-delete an account the product SOFT-deleted on purpose (a
 * soft delete keeps the row because history references it, or because the owner chose to keep it). A soft-deleted account
 * normally leaves the cleanup's reach by itself (status → deactivated, every invite revoked), but an `invite_expired`
 * account keeps that terminal status when it is soft-deleted, and the candidate query does not read `revoked_at`; this
 * closes that corner in the definers themselves, under the user's row lock.
 *
 * Exactly one predicate is added to each of the two phase-2 definers of AccountInviteCleanupDefiner1786721340000:
 *   - core.worker_account_invite_cleanup_candidates: `AND u.deleted_at IS NULL`
 *   - core.worker_delete_expired_invited_user:        `AND u.deleted_at IS NULL` (in the row-locked eligibility SELECT; a
 *     soft-deleted user therefore answers 'not_eligible' and is never deleted)
 * Everything else is byte-for-byte the 1786721340000 text: same signatures, return shapes, SECURITY DEFINER, owner
 * (rab_secure_owner — CREATE OR REPLACE keeps it; stated again explicitly for the ownership check), search_path
 * (pg_catalog, pg_temp) and EXECUTE grantees (crewflow_worker); both are verified before and after, and the transaction
 * rolls back on any difference. The bodies are frozen here (never derived from a constant that could change later).
 * worker_expire_account_invites is untouched (it already requires an unrevoked invite of an 'invited' account).
 *
 * Posture: the semantic goldens' body hashes of the two functions change (PG16/17/18, updated in the same commit); grants and
 * ownership (security-posture.golden.txt) do not. down() restores the 1786721340000 bodies verbatim.
 */
const CANDIDATES_SIGNATURE = 'core.worker_account_invite_cleanup_candidates(integer, timestamp with time zone, uuid)';
const DELETE_SIGNATURE = 'core.worker_delete_expired_invited_user(uuid)';

export const INVITE_CANDIDATES_SKIP_SOFT_DELETED_SQL = `CREATE OR REPLACE FUNCTION core.worker_account_invite_cleanup_candidates(p_limit integer, p_after_cleanup_at timestamptz, p_after_user_id uuid)
RETURNS TABLE (user_id uuid, organisation_id uuid, cleanup_at timestamptz, blocking_reason text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT u.id, u.organisation_id, ai.cleanup_at,
         CASE
           WHEN EXISTS (SELECT 1 FROM core.manager_workspace mw WHERE mw.owner_user_id = u.id) THEN 'manager_workspace'
           WHEN EXISTS (SELECT 1 FROM core.platform_admin pa WHERE pa.user_id = u.id) THEN 'platform_admin'
           WHEN u.last_login_at IS NOT NULL THEN 'signed_in'
           WHEN EXISTS (SELECT 1 FROM core.refresh_token rt WHERE rt.user_id = u.id)
             OR EXISTS (SELECT 1 FROM core.user_session us WHERE us.user_id = u.id) THEN 'had_session'
           ELSE NULL
         END
    FROM core."user" u
    JOIN core.account_invite ai ON ai.user_id = u.id
   WHERE u.status = 'invite_expired'
     AND u.deleted_at IS NULL
     AND ai.send_number = 3
     AND ai.cleanup_at IS NOT NULL
     AND ai.cleanup_at < pg_catalog.now()
     AND (p_after_cleanup_at IS NULL OR ai.cleanup_at > p_after_cleanup_at
          OR (ai.cleanup_at = p_after_cleanup_at AND p_after_user_id IS NOT NULL AND u.id > p_after_user_id))
   ORDER BY ai.cleanup_at, u.id
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 50)
$fn$`;

export const INVITE_DELETE_SKIP_SOFT_DELETED_SQL = `CREATE OR REPLACE FUNCTION core.worker_delete_expired_invited_user(p_user_id uuid)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_uid uuid;
  v_reason text;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN 'not_eligible';
  END IF;
  SELECT u.id, CASE
           WHEN EXISTS (SELECT 1 FROM core.manager_workspace mw WHERE mw.owner_user_id = u.id) THEN 'manager_workspace'
           WHEN EXISTS (SELECT 1 FROM core.platform_admin pa WHERE pa.user_id = u.id) THEN 'platform_admin'
           WHEN u.last_login_at IS NOT NULL THEN 'signed_in'
           WHEN EXISTS (SELECT 1 FROM core.refresh_token rt WHERE rt.user_id = u.id)
             OR EXISTS (SELECT 1 FROM core.user_session us WHERE us.user_id = u.id) THEN 'had_session'
           ELSE NULL
         END INTO v_uid, v_reason
    FROM core."user" u
    JOIN core.account_invite ai ON ai.user_id = u.id
   WHERE u.id = p_user_id
     AND u.status = 'invite_expired'
     AND u.deleted_at IS NULL
     AND ai.send_number = 3
     AND ai.cleanup_at IS NOT NULL
     AND ai.cleanup_at < pg_catalog.now()
   FOR UPDATE OF u;
  IF v_uid IS NULL THEN
    RETURN 'not_eligible';
  END IF;
  IF v_reason IS NOT NULL THEN
    RETURN v_reason;
  END IF;
  BEGIN
    DELETE FROM core."user" u WHERE u.id = v_uid AND u.status = 'invite_expired'
       AND u.last_login_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM core.refresh_token rt WHERE rt.user_id = u.id)
     AND NOT EXISTS (SELECT 1 FROM core.user_session us WHERE us.user_id = u.id);
  EXCEPTION WHEN foreign_key_violation THEN
    RETURN 'referenced';
  END;
  RETURN 'deleted';
END
$fn$`;

/** The bodies AccountInviteCleanupDefiner1786721340000 installed (as CREATE OR REPLACE), for down(). */
export const INVITE_CANDIDATES_PREVIOUS_SQL = `CREATE OR REPLACE FUNCTION core.worker_account_invite_cleanup_candidates(p_limit integer, p_after_cleanup_at timestamptz, p_after_user_id uuid)
RETURNS TABLE (user_id uuid, organisation_id uuid, cleanup_at timestamptz, blocking_reason text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT u.id, u.organisation_id, ai.cleanup_at,
         CASE
           WHEN EXISTS (SELECT 1 FROM core.manager_workspace mw WHERE mw.owner_user_id = u.id) THEN 'manager_workspace'
           WHEN EXISTS (SELECT 1 FROM core.platform_admin pa WHERE pa.user_id = u.id) THEN 'platform_admin'
           WHEN u.last_login_at IS NOT NULL THEN 'signed_in'
           WHEN EXISTS (SELECT 1 FROM core.refresh_token rt WHERE rt.user_id = u.id)
             OR EXISTS (SELECT 1 FROM core.user_session us WHERE us.user_id = u.id) THEN 'had_session'
           ELSE NULL
         END
    FROM core."user" u
    JOIN core.account_invite ai ON ai.user_id = u.id
   WHERE u.status = 'invite_expired'
     AND ai.send_number = 3
     AND ai.cleanup_at IS NOT NULL
     AND ai.cleanup_at < pg_catalog.now()
     AND (p_after_cleanup_at IS NULL OR ai.cleanup_at > p_after_cleanup_at
          OR (ai.cleanup_at = p_after_cleanup_at AND p_after_user_id IS NOT NULL AND u.id > p_after_user_id))
   ORDER BY ai.cleanup_at, u.id
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 50)
$fn$`;

export const INVITE_DELETE_PREVIOUS_SQL = `CREATE OR REPLACE FUNCTION core.worker_delete_expired_invited_user(p_user_id uuid)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_uid uuid;
  v_reason text;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN 'not_eligible';
  END IF;
  SELECT u.id, CASE
           WHEN EXISTS (SELECT 1 FROM core.manager_workspace mw WHERE mw.owner_user_id = u.id) THEN 'manager_workspace'
           WHEN EXISTS (SELECT 1 FROM core.platform_admin pa WHERE pa.user_id = u.id) THEN 'platform_admin'
           WHEN u.last_login_at IS NOT NULL THEN 'signed_in'
           WHEN EXISTS (SELECT 1 FROM core.refresh_token rt WHERE rt.user_id = u.id)
             OR EXISTS (SELECT 1 FROM core.user_session us WHERE us.user_id = u.id) THEN 'had_session'
           ELSE NULL
         END INTO v_uid, v_reason
    FROM core."user" u
    JOIN core.account_invite ai ON ai.user_id = u.id
   WHERE u.id = p_user_id
     AND u.status = 'invite_expired'
     AND ai.send_number = 3
     AND ai.cleanup_at IS NOT NULL
     AND ai.cleanup_at < pg_catalog.now()
   FOR UPDATE OF u;
  IF v_uid IS NULL THEN
    RETURN 'not_eligible';
  END IF;
  IF v_reason IS NOT NULL THEN
    RETURN v_reason;
  END IF;
  BEGIN
    DELETE FROM core."user" u WHERE u.id = v_uid AND u.status = 'invite_expired'
       AND u.last_login_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM core.refresh_token rt WHERE rt.user_id = u.id)
     AND NOT EXISTS (SELECT 1 FROM core.user_session us WHERE us.user_id = u.id);
  EXCEPTION WHEN foreign_key_violation THEN
    RETURN 'referenced';
  END;
  RETURN 'deleted';
END
$fn$`;

export class InviteCleanupSkipsSoftDeleted1786721520000 implements MigrationInterface {
  name = 'InviteCleanupSkipsSoftDeleted1786721520000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.replace(queryRunner, [INVITE_CANDIDATES_SKIP_SOFT_DELETED_SQL, INVITE_DELETE_SKIP_SOFT_DELETED_SQL], true);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await this.replace(queryRunner, [INVITE_CANDIDATES_PREVIOUS_SQL, INVITE_DELETE_PREVIOUS_SQL], false);
  }

  /** Replaces both bodies; owner, SECURITY DEFINER, search_path and the EXECUTE grantees must be exactly as before (or it rolls back). */
  private async replace(queryRunner: QueryRunner, statements: readonly string[], skipsSoftDeleted: boolean): Promise<void> {
    await queryRunner.query(`SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true)`);
    const [{ ok }] = (await queryRunner.query(`SELECT pg_catalog.pg_has_role(current_user, 'rab_secure_owner', 'USAGE') AS ok`)) as Array<{ ok: boolean }>;
    if (!ok) throw new Error(`${this.name} must run as the migration identity (a member of rab_secure_owner, which owns ${CANDIDATES_SIGNATURE} and ${DELETE_SIGNATURE})`);
    const [before] = (await queryRunner.query(INVITE_CLEANUP_STATE_SQL)) as Array<{ functions: string | null }>;
    if (before?.functions !== INVITE_CLEANUP_EXPECTED) {
      throw new Error(`${this.name}: unexpected state of the invite-cleanup definers before the change: ${before?.functions ?? 'absent'}`);
    }
    for (const sql of statements) await queryRunner.query(sql);
    // migration-object-ownership: state the owner of each object this migration (re)creates (unchanged: CREATE OR REPLACE kept it).
    await queryRunner.query(`ALTER FUNCTION core.worker_account_invite_cleanup_candidates(integer, timestamp with time zone, uuid) OWNER TO rab_secure_owner`);
    await queryRunner.query(`ALTER FUNCTION core.worker_delete_expired_invited_user(uuid) OWNER TO rab_secure_owner`);
    const [after] = (await queryRunner.query(INVITE_CLEANUP_STATE_SQL)) as Array<{ functions: string | null }>;
    if (after?.functions !== INVITE_CLEANUP_EXPECTED) {
      throw new Error(`${this.name}: the invite-cleanup definers changed owner, definer, search_path or grants (rolled back): ${after?.functions ?? 'absent'}`);
    }
    const [body] = (await queryRunner.query(
      `SELECT pg_catalog.strpos(c.prosrc, 'u.deleted_at IS NULL') > 0 AS candidates, pg_catalog.strpos(d.prosrc, 'u.deleted_at IS NULL') > 0 AS del
         FROM pg_catalog.pg_proc c, pg_catalog.pg_proc d
        WHERE c.oid = '${CANDIDATES_SIGNATURE}'::pg_catalog.regprocedure AND d.oid = '${DELETE_SIGNATURE}'::pg_catalog.regprocedure`,
    )) as Array<{ candidates: boolean; del: boolean }>;
    if (body?.candidates !== skipsSoftDeleted || body?.del !== skipsSoftDeleted) {
      throw new Error(`${this.name}: the definer bodies are not the expected ones after the change (rolled back)`);
    }
    const violations = await secureOwnerInvariantViolations((sql) => queryRunner.query(sql));
    if (violations.length) throw new Error(`${this.name}: secure-owner invariants violated (rolled back):\n  ${violations.join('\n  ')}`);
  }
}
