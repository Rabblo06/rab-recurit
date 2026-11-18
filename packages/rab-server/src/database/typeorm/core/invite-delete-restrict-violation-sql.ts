// sql-injection-reviewed-file: SQL definition / check module (database layer). No interpolation of request or row data: the function text is a literal, and the only templates name code constants of this repository. Reviewed 2026-11-18 (invite cleanup restrict_violation handler).
/**
 * PostgreSQL 18 invite-cleanup audit label (DRAFT, owner SQL review pending): SQL of migration
 * InviteDeleteRestrictViolation1786721580000, kept as data so the exact statement can be reviewed, scanned and
 * unit-tested. InviteCleanupSkipsSoftDeleted1786721520000 (merged, never edited) keeps its own constants; this module only
 * adds.
 *
 * ROOT CAUSE (THREAT-MODEL "Invite cleanup: PostgreSQL 18 RESTRICT refusal keeps the 'referenced' label"; PR #227 follow-up).
 * PostgreSQL 18 reports a RESTRICT foreign key violation as SQLSTATE 23001 (restrict_violation) instead of 23503
 * (foreign_key_violation) (PostgreSQL 18 release notes, "Migration to Version 18"). The definer
 * core.worker_delete_expired_invited_user(uuid) catches only foreign_key_violation around its DELETE, so on 18 a RESTRICT
 * key that still references the invitee (directly, or through a CASCADE, e.g. core."user" → staff_profile → approved
 * payroll_record) is not caught: the error leaves the definer, the Worker rolls the candidate back to its savepoint and
 * retains it under `workspace_referenced:<constraint>` (account-invite-cleanup.job.ts level22RetainReason). Nothing is ever
 * deleted (fail closed); only the audit reason differs from 16 and 17, where the same invitee is audited `referenced`.
 *
 * FIX (the only change, one handler): `EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN RETURN 'referenced';`.
 * restrict_violation (23001) exists on every supported major (16-18); on 16 and 17 a RESTRICT key still raises 23503, so
 * their behaviour is unchanged. Everything else is byte-for-byte the 1786721520000 text.
 *
 * CREATE OR REPLACE keeps the function's OID, its owner rab_secure_owner, SECURITY DEFINER, search_path and its ACL
 * (EXECUTE for crewflow_worker only); the migration re-checks all of that after the replace.
 */
import { INVITE_DELETE_SKIP_SOFT_DELETED_SQL } from './migrations/1786721520000-InviteCleanupSkipsSoftDeleted';

export const INVITE_DELETE_SIGNATURE = 'core.worker_delete_expired_invited_user(uuid)';

/** The fixed handler: a PostgreSQL 18 RESTRICT refusal is the same "still referenced" as any other. */
export const INVITE_DELETE_REFERENCED_HANDLER = "EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN\n    RETURN 'referenced';";

/** The 1786721520000 handler it replaces (23503 only). */
export const INVITE_DELETE_FK_ONLY_HANDLER = "EXCEPTION WHEN foreign_key_violation THEN\n    RETURN 'referenced';";

/** up(): the definer with the widened handler. Verbatim the SQL put to the owner. */
export const INVITE_DELETE_RESTRICT_VIOLATION_SQL = `CREATE OR REPLACE FUNCTION core.worker_delete_expired_invited_user(p_user_id uuid)
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
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN
    RETURN 'referenced';
  END;
  RETURN 'deleted';
END
$fn$`;

/** down(): the body of InviteCleanupSkipsSoftDeleted1786721520000, replaced in place (same OID, owner and ACL). */
export const INVITE_DELETE_RESTORE_SQL = INVITE_DELETE_SKIP_SOFT_DELETED_SQL;

/**
 * Body hash of the installed definer, the same formula as the semantic posture golden (posture-drift/semantic-posture.ts:
 * md5 of `prosrc || '|' || pg_get_function_sqlbody`), so the values below are the ones the goldens carry. NULL when the
 * function does not exist.
 */
export const INVITE_DELETE_BODY_HASH_SQL = `SELECT pg_catalog.md5(coalesce(p.prosrc, '') || '|' || coalesce(pg_catalog.pg_get_function_sqlbody(p.oid), '')) AS body_hash
  FROM pg_catalog.pg_proc p
 WHERE p.oid = pg_catalog.to_regprocedure('${INVITE_DELETE_SIGNATURE}')`;

/** Body hash of the 1786721520000 definer (foreign_key_violation only); pinned by the spec against the SQL. */
export const INVITE_DELETE_BODY_HASH_FK_ONLY = '002c07848d97692d1529ce71de7e383c';
/** Body hash of this fix (foreign_key_violation OR restrict_violation); pinned by the spec against the SQL and the goldens. */
export const INVITE_DELETE_BODY_HASH_RESTRICT = '0f7179d7055c07696a3733b1c911151f';

/**
 * The only bodies the migration replaces: up() replaces the 1786721520000 body, or re-installs its own (an idempotent
 * re-run); down() replaces its own body, or re-installs the 1786721520000 one. Any other body (hand-altered, a later fix,
 * a trojaned definer) is refused BEFORE the replace, so the migration never silently overwrites it.
 */
export const INVITE_DELETE_REPLACEABLE_BODY_HASHES: Readonly<Record<'up' | 'down', readonly string[]>> = Object.freeze({
  up: Object.freeze([INVITE_DELETE_BODY_HASH_FK_ONLY, INVITE_DELETE_BODY_HASH_RESTRICT]),
  down: Object.freeze([INVITE_DELETE_BODY_HASH_RESTRICT, INVITE_DELETE_BODY_HASH_FK_ONLY]),
});

/**
 * Everything about the definer except its body, in one line: owner, SECURITY DEFINER, language, volatility, return type,
 * strictness, leakproof, pinned search_path, EXECUTE grantees, and how many triggers call it (none: it is not a trigger
 * function, and a trigger attached to it would be an anomaly). Must equal INVITE_DELETE_EXPECTED_STATE before and after.
 */
export const INVITE_DELETE_STATE_SQL = `SELECT pg_catalog.pg_get_userbyid(p.proowner)
       || '|definer=' || p.prosecdef::text
       || '|lang=' || l.lanname
       || '|vol=' || p.provolatile::text
       || '|returns=' || pg_catalog.format_type(p.prorettype, NULL)
       || '|strict=' || p.proisstrict::text
       || '|leakproof=' || p.proleakproof::text
       || '|config=' || COALESCE(pg_catalog.array_to_string(p.proconfig, ';'), '')
       || '|execute=' || COALESCE((SELECT pg_catalog.string_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END, '+'
                                                                ORDER BY CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END)
                                     FROM pg_catalog.aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE'), '')
       || '|triggers=' || (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger t WHERE t.tgfoid = p.oid)::text AS state
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_language l ON l.oid = p.prolang
 WHERE p.oid = pg_catalog.to_regprocedure('${INVITE_DELETE_SIGNATURE}')`;

/** The state 1786721340000 / 1786721520000 left, which this migration preserves exactly. */
export const INVITE_DELETE_EXPECTED_STATE =
  'rab_secure_owner|definer=true|lang=plpgsql|vol=v|returns=text|strict=false|leakproof=false|config=search_path=pg_catalog, pg_temp|execute=crewflow_worker+rab_secure_owner|triggers=0';

/** Who is migrating: superuser, or able to act as rab_secure_owner (the definer's owner, required to replace it). */
export const INVITE_DELETE_PREFLIGHT_SQL = `SELECT current_user::text AS who,
       (SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user) AS su,
       pg_catalog.pg_has_role(current_user, 'rab_secure_owner', 'USAGE') AS can_act_secure,
       pg_catalog.current_setting('server_version_num')::int >= 160000 AS pg16_or_later`;

/** The source text PostgreSQL stores in pg_proc.prosrc for one of the CREATE statements above (between the $fn$ tags). */
export function inviteDeleteBodyOf(createSql: string): string {
  const m = /AS \$fn\$([\s\S]*)\$fn\$$/.exec(createSql);
  if (!m) throw new Error('inviteDeleteBodyOf: no $fn$ body');
  return m[1]!;
}
