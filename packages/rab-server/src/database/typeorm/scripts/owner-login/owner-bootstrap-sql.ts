/**
 * DB setup like Twenty (DB-SETUP-PLAN §3): the bootstrap SQL, VERBATIM. Run only by the bootstrap child
 * (bootstrap-owner-login.ts), connected as the database ADMIN named in PG_ADMIN_URL. Fixed text only: no identifier or
 * value from input reaches a statement's text. The two inputs travel as BIND PARAMETERS of OWNER_BOOTSTRAP_Q4B_SET_INPUTS
 * (the SCRAM verifier — never the password — and whether the password must be set); inside the DO block the database
 * name reaches the EXECUTEd GRANT through %I and the verifier through %L.
 *
 * A server that refuses PRE-HASHED passwords (owner decision 2026-11-19, option 1: "Create login, you set password";
 * provider-neutral, decided by the server's own refusal): Crewflow NEVER sends a plain-text password. db-setup tries the
 * SCRAM verifier first; when the server refuses its form (owner-bootstrap.ts isPasswordFormRefusal: the SQLSTATE of the
 * CREATE / ALTER ROLE step or of the COMMIT), it creates crewflow_owner WITHOUT a password (OWNER_BOOTSTRAP_Q4C_DO_NO_PASSWORD;
 * an existing role's password is left alone), adds the grant, and stops (64) with fixed steps: the operator sets the
 * password once in the provider's SQL editor. If the server refuses a login role without a password too, nothing is
 * created and the steps print OWNER_MANUAL_ROLE_SQL (the reviewed CREATE ROLE + GRANT with a placeholder).
 *
 * Both DO blocks tag a failure with a fixed HINT, `crewflow-stage=<check|role|grant>` (which step failed: the input shape
 * check, the CREATE / ALTER ROLE, or the GRANT), so owner-bootstrap.ts can tell a server refusing the password form (the role
 * step) from its own shape check (the check step, a bug) without ever reading a server message.
 *
 * The only change from the plan text: §3.5 marks the advisory key as a placeholder ("the PR fixes the constant"). It is
 * fixed here as OWNER_BOOTSTRAP_LOCK_KEY, the ASCII bytes "crewboot" as one 64-bit integer, the same convention as the
 * migration lock ("crewmigr", migration-lock.ts) and the platform-admin lock ("crewpa01", platform-admin.service.ts);
 * owner-bootstrap.spec.ts asserts it differs from every other advisory key in the repository.
 *
 * Changing ANY of these strings is a security-reviewed change: the plan's §3.6 log/visibility analysis depends on them.
 */

import { createRoleMarkColumnsSql, OWNER_CREATEROLE_GRACE_SECONDS, OWNER_CREATEROLE_MARK_PREFIX } from '../../../boot-checks/owner-login-posture';

/**
 * "crewboot" (0x63726577626f6f74). Transaction-scoped: every db-setup write (the role, its password, the grant, the
 * CREATEROLE step) runs in a transaction that takes it first and re-reads the facts under it, so two db-setup runs against
 * one database never interleave. Since owner decision 2026-11-18 it is the ONLY db-setup lock: the former kernel lock on
 * the setup volume (flock) protected the password and target files, which no longer exist.
 */
export const OWNER_BOOTSTRAP_LOCK_KEY = '7165901520526864244';

/**
 * Security re-review R1 of #259 (owner decision 2026-11-19, option 1): the role comment that marks crewflow_owner as created
 * by db-setup WITHOUT a password and NOLOGIN, waiting for the operator's step (OWNER_SET_PASSWORD_SQL). The comment is
 * `<prefix><unix expiry>`, by the SERVER clock (independent review L1 of #259, the same shape as the CREATEROLE mark): only a
 * NOLOGIN crewflow_owner carrying an UNEXPIRED mark is in the awaiting-password state. An expired mark is refused (64) and
 * never written over, so an admin's later NOLOGIN (a kill switch) can never be undone by db-setup; any other NOLOGIN
 * crewflow_owner stays refused. Quote-free constants.
 */
export const OWNER_AWAITING_PASSWORD_MARK = 'crewflow:awaiting-password:';
/** How long the awaiting-password mark is honoured (24 h, like the CREATEROLE mark). */
export const OWNER_AWAITING_PASSWORD_GRACE_SECONDS = 86400;

/** SQL: `comment` is an awaiting-password mark of any expiry (shape only; CASE, so nothing is cast before the shape matches). */
export function awaitingMarkShapeSql(comment: string): string {
  return `COALESCE(${comment} OPERATOR(pg_catalog.~) '^${OWNER_AWAITING_PASSWORD_MARK}[0-9]{1,12}$', false)`;
}
/** SQL: `comment` is an awaiting-password mark that has NOT expired by the server clock. */
export function awaitingMarkValidSql(comment: string): string {
  return `(CASE WHEN ${awaitingMarkShapeSql(comment)}
              THEN pg_catalog.split_part(${comment}, ':', 3)::bigint > pg_catalog.date_part('epoch', pg_catalog.now())::bigint
              ELSE false END)`;
}

/** The transaction-local setting that carries the operator's value into the printed DO blocks (never their text). */
export const OWNER_PASSWORD_STEP_SETTING = 'crewflow.pw';

/** The printed line that puts the operator's value into OWNER_PASSWORD_STEP_SETTING (the ONLY line holding the value). */
const PASSWORD_STEP_SET_LINE = "SELECT pg_catalog.set_config('crewflow.pw', '<PG_DATABASE_APP_PASSWORD>', true);";

/**
 * A printed DO block that runs `body` (statements that read the value as v_pw) with the value from the setting, never from
 * its own text. Re-review N1 of #259: a failing statement is quoted in the server log (log_min_error_statement) and a DO
 * block is kept verbatim in pg_stat_statements, so the value must not be in the DO text; the inner error (a password-check
 * hook, a quote, ...) is re-raised with its SQLSTATE only, so no CONTEXT can quote the EXECUTEd text either. An empty
 * setting means the lines were not run together in one transaction: a clean refusal, nothing changed.
 */
function passwordStepDo(body: string): string {
  // sql-injection-reviewed: PRINTED for the operator, never executed by db-setup; body is one of three fixed code literals in this file.
  return `DO $$
DECLARE
  v_pw text := pg_catalog.current_setting('crewflow.pw', true);
BEGIN
  IF v_pw IS NULL OR v_pw = '' THEN
    RAISE EXCEPTION 'crewflow password step: run all lines together in one go, inside one transaction';
  END IF;
  BEGIN
${body}
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'crewflow password step failed (%)', SQLSTATE;
  END;
END$$;`;
}

/**
 * The step db-setup PRINTS (never executes) for the operator, option 1 (independent review M1 + re-review N1 of #259), as
 * statements to run together in one go, in one session and one transaction. The value appears ONLY in the set_config line
 * (pg_stat_statements stores that SELECT normalised, its constants replaced; it is in the server log only at
 * log_statement = all); the DO block reads it from the setting, makes crewflow_owner LOGIN with it and removes the awaiting
 * mark (review L1). Fixed text; a spec pins it.
 */
export const OWNER_SET_PASSWORD_SQL: readonly string[] = Object.freeze([
  'BEGIN;',
  PASSWORD_STEP_SET_LINE,
  passwordStepDo(`    EXECUTE pg_catalog.format('ALTER ROLE crewflow_owner LOGIN PASSWORD %L', v_pw);
    COMMENT ON ROLE crewflow_owner IS NULL;`),
  'COMMIT;',
]);

/**
 * The step db-setup PRINTS (never executes) when mode c (no admin URL) refuses a weak crewflow_owner password in production
 * (owner-credential.ts weakPasswordProduction): the same safe shape as OWNER_SET_PASSWORD_SQL (the value only in the
 * set_config line), changing the password only: no LOGIN, no comment touched (SQL audit of #259).
 */
export const OWNER_RESET_PASSWORD_SQL: readonly string[] = Object.freeze([
  'BEGIN;',
  PASSWORD_STEP_SET_LINE,
  passwordStepDo(`    EXECUTE pg_catalog.format('ALTER ROLE crewflow_owner PASSWORD %L', v_pw);`),
  'COMMIT;',
]);

/**
 * Q0 (REVISED, security review H1): first pin the session's search_path to pg_catalog (then pg_temp, which is never searched
 * for functions or operators), so no unqualified operator or function in Q1 / Q2 / the DO blocks can resolve to an object
 * a schema owner planted (CVE-2018-1058 class: e.g. a database-level `search_path = x, pg_catalog` and an `x.=` operator).
 * The same pin is also sent as a startup option on every bootstrap connection (BOOTSTRAP_SESSION_STARTUP_OPTIONS), which
 * overrides any role- or database-level search_path default. Then: user-settable; stops a failing statement's parameters
 * being logged. Two statements, one simple-protocol message (no bind parameters).
 */
export const OWNER_BOOTSTRAP_Q0_SESSION = `SET search_path TO pg_catalog, pg_temp; SET log_parameter_max_length_on_error = 0;`;

/**
 * Startup options (libpq `options`) appended to the read-write bootstrap connections: the admin session, the crewflow_owner
 * probe and post-commit login, and the pending-password probe (the owner-URL mode's crewflow_owner session gets
 * OWNER_URL_SESSION_STARTUP_OPTIONS below: the same pin, read-only). They win over
 * ALTER ROLE / ALTER DATABASE ... SET defaults, so a planted search_path or a forced read-only default never applies to
 * these sessions. Fixed text; a spec asserts every driver config carries it.
 */
export const BOOTSTRAP_SESSION_STARTUP_OPTIONS = '-c search_path=pg_catalog,pg_temp -c default_transaction_read_only=off';

/**
 * Security review I1 (owner decision 2026-11-13: approved, read-only): the crewflow_owner session of the owner-URL mode
 * sends only Q0 (SET), O1 and Q2 (SELECT), so it is opened READ-ONLY: even a future code mistake cannot write as
 * crewflow_owner from db-setup (any write fails with 25006). The admin and probe sessions keep BOOTSTRAP_SESSION_STARTUP_OPTIONS.
 */
export const OWNER_URL_SESSION_STARTUP_OPTIONS = '-c search_path=pg_catalog,pg_temp -c default_transaction_read_only=on';

/** Q1: superuser-only settings; a no-op row for a non-superuser admin (same trick as 01-crewflow-owner.sql). */
export const OWNER_BOOTSTRAP_Q1_SUPERUSER_LOGGING = `SELECT pg_catalog.set_config('log_statement', 'none', false),
       pg_catalog.set_config('log_min_error_statement', 'panic', false),
       pg_catalog.set_config('log_parameter_max_length', '0', false)
  FROM pg_catalog.pg_roles WHERE rolname = current_user AND rolsuper;`;

/**
 * Q2 (REVISED, security review H1): the facts, one read, no writes. (`pg_maintain` exists only on PG17+; naming a missing
 * role in IN (...) is harmless.) Two new facts for the admin path's refusal: o_owns_db (crewflow_owner owns the current
 * database, directly or through any role membership: MEMBER, re-review N2) and search_path_default_set (a database-wide or crewflow_owner-level
 * search_path default exists in pg_db_role_setting). And (owner decisions 2026-11-18) o_createrole_pending / o_createrole_mark_expired:
 * crewflow_owner carries a valid "CREATEROLE until the schema is current" mark (owner-login-posture.ts), and it has expired by
 * the server clock (both false when the role or the mark is missing). Security re-review R1 of #259: o_awaiting_password,
 * crewflow_owner is NOLOGIN and carries exactly OWNER_AWAITING_PASSWORD_MARK (db-setup's passwordless role, option 1);
 * o_stale_awaiting_mark, crewflow_owner is LOGIN (the operator's ALTER ROLE ... LOGIN PASSWORD ran) and still carries it.
 * Independent review of #259: o_awaiting_mark_expired (L1: NOLOGIN with an expired mark, refused, never re-enabled) and
 * o_foreign_members (L2: members OF crewflow_owner other than this admin's own ADMIN-only grant, refused before any write).
 * TODO(lead, 2026-11-19): switch the privileged-membership list below (o_privileged_memberships) to
 * database/owner-login/privileged-roles.ts once it lands (one constant shared with the boot posture check).
 */
// o_foreign_members (independent review L2 of #259) reads inherit_option / set_option through to_jsonb(m): those columns
// exist from PostgreSQL 16 only, and naming them directly would make Q2 itself fail (exit 70) on a 15 server instead of the
// clean "PostgreSQL below 16" refusal (64) that assertSupportedServerVersion gives from this same row.
// sql-injection-reviewed: the interpolations are createRoleMarkColumnsSql / awaitingMark*Sql over fixed column expressions and quote-free code constants.
export const OWNER_BOOTSTRAP_Q2_FACTS = `SELECT pg_catalog.current_setting('server_version_num')::int                      AS server_version_num,
       current_user::text                                                         AS admin,
       a.rolsuper                                                                 AS admin_super,
       a.rolcreaterole                                                            AS admin_createrole,
       pg_catalog.has_database_privilege(current_user, pg_catalog.current_database(), 'CONNECT WITH GRANT OPTION')
   AND pg_catalog.has_database_privilege(current_user, pg_catalog.current_database(), 'CREATE WITH GRANT OPTION')
   AND pg_catalog.has_database_privilege(current_user, pg_catalog.current_database(), 'TEMPORARY WITH GRANT OPTION')
                                                                                  AS admin_can_grant_db,
       o.oid IS NOT NULL                                                          AS owner_exists,
       o.rolcanlogin AS o_login, o.rolsuper AS o_super, o.rolbypassrls AS o_bypassrls,
       o.rolreplication AS o_replication, o.rolcreatedb AS o_createdb,
       o.rolcreaterole AS o_createrole, o.rolinherit AS o_inherit,
       o.rolvaliduntil IS NOT NULL AND o.rolvaliduntil <= pg_catalog.now()         AS o_expired,
       CASE WHEN o.oid IS NULL THEN false
            ELSE a.rolsuper OR pg_catalog.pg_has_role(current_user, o.oid, 'MEMBER WITH ADMIN OPTION') END
                                                                                  AS admin_has_admin_option,
       CASE WHEN o.oid IS NULL THEN NULL ELSE (
         WITH RECURSIVE up(oid) AS (
           SELECT o.oid
           UNION
           SELECT m.roleid FROM pg_catalog.pg_auth_members m JOIN up ON m.member = up.oid)
         SELECT pg_catalog.count(*) FROM up JOIN pg_catalog.pg_roles r ON r.oid = up.oid
          WHERE r.oid <> o.oid
            AND (r.rolsuper OR r.rolbypassrls
                 OR r.rolname IN ('pg_read_all_data','pg_write_all_data','pg_execute_server_program',
                                  'pg_read_server_files','pg_write_server_files','pg_create_subscription',
                                  'pg_signal_backend','pg_checkpoint','pg_maintain'))) END
                                                                                  AS o_privileged_memberships,
       (o.oid IS NOT NULL
        AND pg_catalog.has_database_privilege(o.oid, pg_catalog.current_database(), 'CONNECT WITH GRANT OPTION')
        AND pg_catalog.has_database_privilege(o.oid, pg_catalog.current_database(), 'CREATE WITH GRANT OPTION')
        AND pg_catalog.has_database_privilege(o.oid, pg_catalog.current_database(), 'TEMPORARY WITH GRANT OPTION'))
                                                                                  AS o_has_db_grant,
       (o.oid IS NOT NULL AND pg_catalog.pg_has_role(o.oid, d.datdba, 'MEMBER')) AS o_owns_db,
       ${createRoleMarkColumnsSql("pg_catalog.shobj_description(o.oid, 'pg_authid')", 'o_createrole_pending', 'o_createrole_mark_expired')},
       (o.oid IS NOT NULL AND NOT o.rolcanlogin
        AND ${awaitingMarkValidSql("pg_catalog.shobj_description(o.oid, 'pg_authid')")})
                                                                                  AS o_awaiting_password,
       (o.oid IS NOT NULL AND NOT o.rolcanlogin
        AND ${awaitingMarkShapeSql("pg_catalog.shobj_description(o.oid, 'pg_authid')")}
        AND NOT ${awaitingMarkValidSql("pg_catalog.shobj_description(o.oid, 'pg_authid')")})
                                                                                  AS o_awaiting_mark_expired,
       (o.oid IS NOT NULL AND o.rolcanlogin
        AND ${awaitingMarkShapeSql("pg_catalog.shobj_description(o.oid, 'pg_authid')")})
                                                                                  AS o_stale_awaiting_mark,
       CASE WHEN o.oid IS NULL THEN NULL ELSE (
         SELECT pg_catalog.count(*) FROM pg_catalog.pg_auth_members m
          WHERE m.roleid = o.oid
            AND NOT (m.member = a.oid AND m.admin_option
                     AND (pg_catalog.to_jsonb(m) OPERATOR(pg_catalog.->>) 'inherit_option') IS DISTINCT FROM 'true'
                     AND (pg_catalog.to_jsonb(m) OPERATOR(pg_catalog.->>) 'set_option') IS DISTINCT FROM 'true')) END
                                                                                  AS o_foreign_members,
       EXISTS (SELECT 1
                 FROM pg_catalog.pg_db_role_setting s
                 CROSS JOIN LATERAL pg_catalog.unnest(s.setconfig) AS c(setting)
                WHERE ((s.setdatabase = d.oid AND s.setrole = 0) OR (o.oid IS NOT NULL AND s.setrole = o.oid))
                  AND pg_catalog.lower(pg_catalog.split_part(c.setting, '=', 1)) = 'search_path')
                                                                                  AS search_path_default_set
  FROM pg_catalog.pg_roles a
  JOIN pg_catalog.pg_database d ON d.datname = pg_catalog.current_database()
  LEFT JOIN pg_catalog.pg_roles o ON o.rolname = 'crewflow_owner'
 WHERE a.rolname = current_user;`;

/**
 * Q2b, security review L4 (owner decision 2026-11-13: approved, read-only; SELECT only, fixed text, no parameters). Sent by
 * the admin session only before an A4 reset (the password file is missing and crewflow_owner exists), before anything is
 * stored or written. True when crewflow_owner owns objects in, is named in an ACL / policy / initial privilege of, another
 * database (`pg_shdepend` rows of that database), or owns / holds an ACL entry on another database itself (`pg_shdepend`
 * shared rows, `dbid = 0`, class pg_database): "one Crewflow deployment per PostgreSQL cluster when using an admin URL".
 * Roles are cluster-wide: resetting the password here would break the other deployment.
 */
export const OWNER_BOOTSTRAP_Q2B_OTHER_DATABASES = `SELECT EXISTS (
         SELECT 1
           FROM pg_catalog.pg_shdepend s
           JOIN pg_catalog.pg_roles o ON o.rolname = 'crewflow_owner' AND s.refobjid = o.oid
          CROSS JOIN (SELECT d.oid FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database()) cur
          WHERE s.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
            AND (   (s.dbid <> 0 AND s.dbid <> cur.oid)
                 OR (s.dbid = 0 AND s.classid = 'pg_catalog.pg_database'::pg_catalog.regclass AND s.objid <> cur.oid))
       ) AS o_other_database;`;

/** Q3 (the password probe), sent on a SECOND connection as crewflow_owner with the stored (or pending) password. */
export const OWNER_BOOTSTRAP_Q3_PROBE = `SELECT 1`;

export const OWNER_BOOTSTRAP_BEGIN = `BEGIN;`;

/** Q4a: one bootstrap at a time (two API replicas starting together). */
// sql-injection-reviewed: OWNER_BOOTSTRAP_LOCK_KEY is the module's own numeric string constant (7165901520526864244), never input.
export const OWNER_BOOTSTRAP_Q4A_LOCK = `SELECT pg_catalog.pg_advisory_xact_lock(${OWNER_BOOTSTRAP_LOCK_KEY});`;

/**
 * Q4b: inputs as transaction-local custom settings, sent as BIND PARAMETERS ($1, $2), so neither value is in any
 * statement text, pg_stat_activity.query, pg_stat_statements or log_statement output.
 */
export const OWNER_BOOTSTRAP_Q4B_SET_INPUTS = `SELECT pg_catalog.set_config('crewflow_bootstrap.verifier', $1, true) IS NOT NULL
       AND pg_catalog.set_config('crewflow_bootstrap.need_password', $2, true) IS NOT NULL AS done;`;

/**
 * Q4b2 (lead review of PR #226's own-login script, 2026-11-17): `createrole_self_grant` (PostgreSQL 16+, user-settable) makes
 * a NON-superuser CREATEROLE login that runs CREATE ROLE also grant ITSELF the new role with the listed options; a provider
 * that defaults it to `set, inherit` would let the admin login act as crewflow_owner (SET ROLE, or inherit its privileges).
 * Pinned to the empty string (no self-grant, the PostgreSQL default) for this transaction only, before Q4c's CREATE ROLE.
 * The creator still gets the ADMIN OPTION PostgreSQL 16 always records for a non-superuser creator (needed for the A4
 * password reset), never INHERIT or SET. The boot posture check (owner-login posture shape) refuses an inheriting admin
 * membership as well: this keeps db-setup from creating one. Fixed text, no input.
 */
export const OWNER_BOOTSTRAP_Q4B2_NO_SELF_GRANT = `SELECT pg_catalog.set_config('createrole_self_grant', '', true);`;

/**
 * Q4c (REVISED, security re-review N3: the verifier shape check before CREATE / ALTER ROLE). Security re-review R1 of #259:
 * an existing NOLOGIN crewflow_owner is accepted ONLY in the awaiting-password state, and then becomes LOGIN with the
 * verifier and loses the mark in the same statement pair.
 */
// sql-injection-reviewed: the only interpolation is awaitingMarkValidSql over a fixed expression (quote-free code constants).
export const OWNER_BOOTSTRAP_Q4C_DO = `DO $bootstrap$
DECLARE
  v_db       text := pg_catalog.current_database();
  v_verifier text := pg_catalog.current_setting('crewflow_bootstrap.verifier');
  v_set_pw   boolean := pg_catalog.current_setting('crewflow_bootstrap.need_password')::boolean;
  v_stage    text := 'check';
  v_msg      text;
  v_awaiting boolean := false;
  r          record;
BEGIN
  BEGIN
    SELECT oid, rolsuper, rolbypassrls, rolreplication, rolcreatedb, rolcanlogin, rolinherit,
           ${awaitingMarkValidSql("pg_catalog.shobj_description(oid, 'pg_authid')")} AS awaiting
      INTO r FROM pg_catalog.pg_roles WHERE rolname = 'crewflow_owner';
    -- REVISED (security re-review N3): a password is only ever set from the exact pre-hashed SCRAM-SHA-256 shape (the same
    -- pattern as OWNER_SELF_O4C_DO; dollar signs spelled [$]); anything else is 22023 before CREATE / ALTER ROLE.
    IF (NOT FOUND OR v_set_pw)
       AND (v_verifier IS NULL OR NOT (v_verifier OPERATOR(pg_catalog.~) '^SCRAM-SHA-256[$][1-9][0-9]{0,9}:[A-Za-z0-9+/]+={0,2}[$][A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$')) THEN
      RAISE EXCEPTION 'not a pre-hashed verifier' USING ERRCODE = '22023';
    END IF;
    IF NOT FOUND THEN
      v_stage := 'role';
      EXECUTE pg_catalog.format(
        'CREATE ROLE crewflow_owner LOGIN NOSUPERUSER NOBYPASSRLS NOREPLICATION NOCREATEDB CREATEROLE INHERIT PASSWORD %L',
        v_verifier);
    ELSE
      -- Re-check under the lock: another start may have changed it since Q2. NOLOGIN only in the awaiting-password state
      -- (security re-review R1 of #259: db-setup's own passwordless role, OWNER_AWAITING_PASSWORD_MARK).
      v_awaiting := NOT r.rolcanlogin AND r.awaiting;
      IF r.rolsuper OR r.rolbypassrls OR r.rolreplication OR r.rolcreatedb OR (NOT r.rolcanlogin AND NOT v_awaiting) OR NOT r.rolinherit THEN
        RAISE EXCEPTION 'crewflow_owner has privileged or wrong attributes' USING ERRCODE = '42501';
      END IF;
      IF v_awaiting AND NOT v_set_pw THEN
        RAISE EXCEPTION 'crewflow_owner is waiting for its password' USING ERRCODE = '55000';
      END IF;
      IF v_set_pw THEN
        v_stage := 'role';
        IF v_awaiting THEN
          EXECUTE pg_catalog.format('ALTER ROLE crewflow_owner LOGIN PASSWORD %L', v_verifier);
          COMMENT ON ROLE crewflow_owner IS NULL;
        ELSE
          EXECUTE pg_catalog.format('ALTER ROLE crewflow_owner PASSWORD %L', v_verifier);
        END IF;
      END IF;
    END IF;
    v_stage := 'grant';
    IF NOT (pg_catalog.has_database_privilege('crewflow_owner', v_db, 'CONNECT WITH GRANT OPTION')
        AND pg_catalog.has_database_privilege('crewflow_owner', v_db, 'CREATE WITH GRANT OPTION')
        AND pg_catalog.has_database_privilege('crewflow_owner', v_db, 'TEMPORARY WITH GRANT OPTION')) THEN
      EXECUTE pg_catalog.format('GRANT CONNECT, CREATE, TEMPORARY ON DATABASE %I TO crewflow_owner WITH GRANT OPTION', v_db);
    END IF;
  EXCEPTION WHEN OTHERS OR query_canceled THEN
    -- Owner decision 2026-11-19: exactly ONE inner message is kept, PostgreSQL's fixed "tuple concurrently updated" (XX000:
    -- a concurrent ALTER ROLE / GRANT on the same catalog row from another database of the cluster), so the genuine race is
    -- told apart from any other XX000; every other error keeps only its SQLSTATE. The HINT names the failing step (fixed text).
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF SQLSTATE = 'XX000' AND v_msg = 'tuple concurrently updated' THEN
      RAISE EXCEPTION 'tuple concurrently updated' USING ERRCODE = 'XX000', HINT = 'crewflow-stage=' || v_stage;
    END IF;
    -- Re-raise WITHOUT the inner statement: an error's CONTEXT would otherwise quote the EXECUTEd text (the verifier).
    RAISE EXCEPTION 'crewflow_owner bootstrap failed (%)', SQLSTATE USING ERRCODE = SQLSTATE, HINT = 'crewflow-stage=' || v_stage;
  END;
END
$bootstrap$;`;

/**
 * Q4c (no password; owner decision 2026-11-19, option 1): the server refused the pre-hashed password, so crewflow_owner is
 * created WITHOUT one and NOLOGIN (security re-review R1 of #259: a pg_hba trust / peer / cert / ldap rule must never let
 * anyone in as a passwordless CREATEROLE login), marked OWNER_AWAITING_PASSWORD_MARK; otherwise OWNER_BOOTSTRAP_Q4C_DO's
 * attributes. The operator's `ALTER ROLE crewflow_owner LOGIN PASSWORD ...` makes it a login. When it exists it is left
 * exactly as it is (its password and LOGIN are never touched here; NOLOGIN accepted only with the mark); then the same
 * database grant. No input at all: fixed text, no EXECUTE of a value. The
 * same stage HINT and CONTEXT-stripping re-raise as OWNER_BOOTSTRAP_Q4C_DO, so a refusal of the passwordless (NOLOGIN) role
 * itself (the role step, or its COMMIT) is told apart.
 */
// sql-injection-reviewed: the interpolations are OWNER_AWAITING_PASSWORD_MARK / _GRACE_SECONDS and awaitingMarkValidSql (quote-free code constants).
export const OWNER_BOOTSTRAP_Q4C_DO_NO_PASSWORD = `DO $bootstrap$
DECLARE
  v_db       text := pg_catalog.current_database();
  v_stage    text := 'check';
  v_msg      text;
  r          record;
BEGIN
  BEGIN
    SELECT oid, rolsuper, rolbypassrls, rolreplication, rolcreatedb, rolcanlogin, rolinherit,
           ${awaitingMarkValidSql("pg_catalog.shobj_description(oid, 'pg_authid')")} AS awaiting
      INTO r FROM pg_catalog.pg_roles WHERE rolname = 'crewflow_owner';
    IF NOT FOUND THEN
      v_stage := 'role';
      CREATE ROLE crewflow_owner NOLOGIN NOSUPERUSER NOBYPASSRLS NOREPLICATION NOCREATEDB CREATEROLE INHERIT;
      EXECUTE pg_catalog.format('COMMENT ON ROLE crewflow_owner IS %L',
        '${OWNER_AWAITING_PASSWORD_MARK}' || (pg_catalog.date_part('epoch', pg_catalog.now())::bigint + ${OWNER_AWAITING_PASSWORD_GRACE_SECONDS})::text);
    ELSIF r.rolsuper OR r.rolbypassrls OR r.rolreplication OR r.rolcreatedb OR (NOT r.rolcanlogin AND NOT r.awaiting) OR NOT r.rolinherit THEN
      RAISE EXCEPTION 'crewflow_owner has privileged or wrong attributes' USING ERRCODE = '42501';
    END IF;
    v_stage := 'grant';
    IF NOT (pg_catalog.has_database_privilege('crewflow_owner', v_db, 'CONNECT WITH GRANT OPTION')
        AND pg_catalog.has_database_privilege('crewflow_owner', v_db, 'CREATE WITH GRANT OPTION')
        AND pg_catalog.has_database_privilege('crewflow_owner', v_db, 'TEMPORARY WITH GRANT OPTION')) THEN
      EXECUTE pg_catalog.format('GRANT CONNECT, CREATE, TEMPORARY ON DATABASE %I TO crewflow_owner WITH GRANT OPTION', v_db);
    END IF;
  EXCEPTION WHEN OTHERS OR query_canceled THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF SQLSTATE = 'XX000' AND v_msg = 'tuple concurrently updated' THEN
      RAISE EXCEPTION 'tuple concurrently updated' USING ERRCODE = 'XX000', HINT = 'crewflow-stage=' || v_stage;
    END IF;
    RAISE EXCEPTION 'crewflow_owner bootstrap failed (%)', SQLSTATE USING ERRCODE = SQLSTATE, HINT = 'crewflow-stage=' || v_stage;
  END;
END
$bootstrap$;`;

/**
 * The SQL db-setup PRINTS (never executes) when the server refuses both the pre-hashed password and a login role without a
 * password (owner decision 2026-11-19, option 2 steps): the reviewed statements of own-database-app-login.sql, steps 5 and
 * 6 (the same attributes and grant as OWNER_BOOTSTRAP_Q4C_DO), with the password as a placeholder the operator replaces with
 * PG_DATABASE_APP_PASSWORD in the provider's SQL editor, connected to this database as the admin login. No value, no host,
 * no database name: the grant names the database through current_database(). The value only in the set_config line, the
 * same way as OWNER_SET_PASSWORD_SQL (re-review N1). Statements, run together in one go. Fixed text; a spec pins it.
 */
export const OWNER_MANUAL_ROLE_SQL: readonly string[] = Object.freeze([
  'BEGIN;',
  "SET LOCAL createrole_self_grant = '';",
  PASSWORD_STEP_SET_LINE,
  passwordStepDo(`    EXECUTE pg_catalog.format('CREATE ROLE crewflow_owner LOGIN NOSUPERUSER NOBYPASSRLS NOREPLICATION NOCREATEDB CREATEROLE INHERIT PASSWORD %L', v_pw);`),
  "DO $grant$ BEGIN EXECUTE pg_catalog.format('GRANT CONNECT, CREATE, TEMPORARY ON DATABASE %I TO crewflow_owner WITH GRANT OPTION', pg_catalog.current_database()); END $grant$;",
  'COMMIT;',
]);

/**
 * Q4d (no-password path): the same exact re-check, LOGIN or the awaiting-password state (NOLOGIN with the mark).
 */
// sql-injection-reviewed: the only interpolation is awaitingMarkValidSql over a fixed expression (quote-free code constants).
export const OWNER_BOOTSTRAP_Q4D_NO_PASSWORD_REVERIFY = `SELECT (rolcanlogin OR ${awaitingMarkValidSql("pg_catalog.shobj_description(oid, 'pg_authid')")})
       AND NOT rolsuper AND NOT rolbypassrls AND NOT rolreplication AND NOT rolcreatedb AND rolinherit
       AND pg_catalog.has_database_privilege(oid, pg_catalog.current_database(), 'CREATE WITH GRANT OPTION') AS ok
  FROM pg_catalog.pg_roles WHERE rolname = 'crewflow_owner';`;

/**
 * L1 (security re-review of #259, F1 remainder; before the verifier DO block whenever it sets a password): log_lock_waits
 * reports a backend waiting longer than deadlock_timeout WITH its context stack, which would quote the EXECUTEd
 * ALTER ROLE ... PASSWORD '<verifier>' text. The transaction's lock_timeout is set to half of deadlock_timeout (at least 1 ms),
 * so a blocked statement fails with 55P03 (caught by the DO block, re-raised without context) first. User-settable; one
 * boolean, never a value.
 */
export const OWNER_BOOTSTRAP_L1_LOCK_TIMEOUT = `SELECT pg_catalog.set_config('lock_timeout', GREATEST(1, s.setting::bigint / 2)::text || 'ms', true) IS NOT NULL AS done
  FROM pg_catalog.pg_settings s WHERE s.name = 'deadlock_timeout';`;

/** Q4d: re-verify the result exactly (attributes + grant), fail closed if not exact. */
export const OWNER_BOOTSTRAP_Q4D_REVERIFY = `SELECT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls AND NOT rolreplication AND NOT rolcreatedb AND rolinherit
       AND pg_catalog.has_database_privilege(oid, pg_catalog.current_database(), 'CREATE WITH GRANT OPTION') AS ok
  FROM pg_catalog.pg_roles WHERE rolname = 'crewflow_owner';`;

export const OWNER_BOOTSTRAP_COMMIT = `COMMIT;`;
export const OWNER_BOOTSTRAP_ROLLBACK = `ROLLBACK;`;

/*
 * ----------------------------------------------------------------------------------------------------------------------
 * CREATEROLE after the schema bootstrap (owner decision 2026-11-18). crewflow_owner is created CREATEROLE: the first start
 * (the migrate child's role bootstrap and the chain) creates the schema roles. Once the schema is complete for this image
 * (every migration file of this image is in the ledger: CURRENT, or AHEAD after a rollback), db-setup, AS THE ADMIN, removes
 * it. While the schema is not complete yet, it marks the role with OWNER_CREATEROLE_PENDING_COMMENT, so the API / Worker /
 * CLI boot gate (production) accepts CREATEROLE for that first start only; any other CREATEROLE is refused at boot.
 * db-setup never GRANTS CREATEROLE: it only keeps an existing one (marked) or removes it.
 * ----------------------------------------------------------------------------------------------------------------------
 */

/** S1 (read-only, on the crewflow_owner session): does the migration ledger exist? (core.migrations cannot be named in a statement when it may be absent: 42P01 at planning time.) */
export const OWNER_SCHEMA_S1_HAS_LEDGER = `SELECT pg_catalog.to_regclass('core.migrations') IS NOT NULL AS has_ledger;`;

/** S2 (read-only, on the crewflow_owner session, only when S1 is true): the migration names in the ledger (as install-state.ts reads them). */
export const OWNER_SCHEMA_S2_LEDGER = `SELECT name FROM core.migrations;`;

/**
 * The migration lock ("crewmigr", migration-lock.ts MIGRATION_LOCK_KEY, the same 64-bit value): the CREATEROLE removal runs only
 * while NO migrate child holds it. Fresh-install race found in review: after the ledger is complete, the migrate child still
 * runs disableLegacyLogins (ALTER ROLE crewflow NOLOGIN PASSWORD NULL ...), which needs crewflow_owner's CREATEROLE; a removal
 * in that gap would leave the legacy logins LOGIN (BC-17) with only a warning. Session-level try-lock (never blocks), taken
 * right before the removal transaction and released after it; owner-bootstrap.spec.ts proves the value equals
 * MIGRATION_LOCK_KEY.
 */
export const MIGRATION_LOCK_KEY_DECIMAL = '7165901520711018354';
// sql-injection-reviewed: MIGRATION_LOCK_KEY_DECIMAL is this module's numeric string constant, never input.
export const OWNER_HARDEN_M1_TRY_MIGRATION_LOCK = `SELECT pg_catalog.pg_try_advisory_lock(${MIGRATION_LOCK_KEY_DECIMAL}) AS got;`;
// sql-injection-reviewed: MIGRATION_LOCK_KEY_DECIMAL is this module's numeric string constant, never input.
export const OWNER_HARDEN_M2_RELEASE_MIGRATION_LOCK = `SELECT pg_catalog.pg_advisory_unlock(${MIGRATION_LOCK_KEY_DECIMAL}) AS released;`;

/**
 * Re-review R1 (admin, in the removal transaction, under the lock, before H1): the legacy logins that are still LOGIN. The
 * migrate child makes crewflow and crewflow_app NOLOGIN after a fresh install (legacy-logins.ts, BC-17), using crewflow_owner's
 * CREATEROLE; once CREATEROLE is gone it no longer can. So the removal first makes them NOLOGIN itself, AS THE ADMIN, with the
 * same reviewed statements (LEGACY_NOLOGIN_SQL), in the same transaction; an admin that cannot (42501) rolls everything back
 * and CREATEROLE stays.
 */
export const OWNER_HARDEN_R1_LEGACY_LOGINS = `SELECT r.rolname::text AS name FROM pg_catalog.pg_roles r
 WHERE r.rolname IN ('crewflow', 'crewflow_app') AND r.rolcanlogin ORDER BY 1;`;

/**
 * H4 (security re-review N2 of #259; admin, in the CREATEROLE step's transaction under the lock): a LOGIN crewflow_owner never
 * keeps OWNER_AWAITING_PASSWORD_MARK (after the operator's ALTER ROLE ... LOGIN PASSWORD), so a later NOLOGIN can never count
 * as "awaiting its password". Only that exact comment is removed (a CREATEROLE mark is never touched here).
 */
// sql-injection-reviewed: the only interpolation is awaitingMarkShapeSql over a fixed expression (quote-free code constants).
export const OWNER_HARDEN_H4_CLEAR_STALE_AWAITING_MARK = `DO $clear$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles r
              WHERE r.rolname = 'crewflow_owner' AND r.rolcanlogin
                AND ${awaitingMarkShapeSql("pg_catalog.shobj_description(r.oid, 'pg_authid')")}) THEN
    COMMENT ON ROLE crewflow_owner IS NULL;
  END IF;
END
$clear$;`;

/** H1 (admin, in a transaction under OWNER_BOOTSTRAP_Q4A_LOCK): the hardening itself. */
export const OWNER_HARDEN_H1_NOCREATEROLE = `ALTER ROLE crewflow_owner NOCREATEROLE;`;

/** H2 (admin, same transaction): the pending mark is removed with the attribute (only when it is there). */
export const OWNER_HARDEN_H2_CLEAR_MARK = `COMMENT ON ROLE crewflow_owner IS NULL;`;

/**
 * H3 (admin, in a transaction under the lock): the schema is not complete yet and crewflow_owner is CREATEROLE, unmarked or with
 * an expired mark: mark it until now + the grace period, by the SERVER clock (COMMENT takes only a literal, hence the DO block;
 * the text is fixed: the prefix and an integer, no input).
 */
// sql-injection-reviewed: the only interpolations are OWNER_CREATEROLE_MARK_PREFIX (a quote-free code constant) and OWNER_CREATEROLE_GRACE_SECONDS (a code integer).
export const OWNER_HARDEN_H3_MARK_PENDING = `DO $mark$
BEGIN
  EXECUTE pg_catalog.format('COMMENT ON ROLE crewflow_owner IS %L',
    '${OWNER_CREATEROLE_MARK_PREFIX}' || (pg_catalog.date_part('epoch', pg_catalog.now())::bigint + ${OWNER_CREATEROLE_GRACE_SECONDS})::text);
END
$mark$;`;

/** Every statement the CREATEROLE step's admin session may send, in order (the spec checks none can carry a secret). */
export const OWNER_HARDEN_ADMIN_STATEMENTS = [
  OWNER_HARDEN_M1_TRY_MIGRATION_LOCK,
  OWNER_BOOTSTRAP_BEGIN,
  OWNER_BOOTSTRAP_Q4A_LOCK,
  OWNER_BOOTSTRAP_Q2_FACTS,
  OWNER_BOOTSTRAP_Q2B_OTHER_DATABASES,
  OWNER_HARDEN_R1_LEGACY_LOGINS,
  'ALTER ROLE crewflow NOLOGIN PASSWORD NULL',
  'ALTER ROLE crewflow_app NOLOGIN PASSWORD NULL',
  OWNER_HARDEN_H1_NOCREATEROLE,
  OWNER_HARDEN_H2_CLEAR_MARK,
  OWNER_HARDEN_H3_MARK_PENDING,
  OWNER_HARDEN_H4_CLEAR_STALE_AWAITING_MARK,
  OWNER_BOOTSTRAP_COMMIT,
  OWNER_BOOTSTRAP_ROLLBACK,
  OWNER_HARDEN_M2_RELEASE_MIGRATION_LOCK,
] as const;

/*
 * ----------------------------------------------------------------------------------------------------------------------
 * The owner-URL session (mode c, PG_DATABASE_URL only; and, in modes a and b, the READ-ONLY session that reads the
 * migration ledger for the CREATEROLE step): logged in as crewflow_owner with the password inside PG_DATABASE_URL, it runs
 * ONLY read-only statements: OWNER_BOOTSTRAP_Q0_SESSION (the session pin), OWNER_SELF_O1_SESSION, OWNER_BOOTSTRAP_Q2_FACTS
 * and OWNER_SCHEMA_S1 / S2, then the refusals. It never writes to the database and never changes the password (Twenty: an
 * external database gets no setup step at all, twentyhq/twenty@eedb0a73 helm/twenty/templates/secret-db-url.yaml:24-45).
 * ----------------------------------------------------------------------------------------------------------------------
 */

/** O1: which login this session is. Login names only (never a secret). Must be crewflow_owner and equal. */
export const OWNER_SELF_O1_SESSION = `SELECT session_user::text AS session_login, current_user::text AS current_login;`;

/** Every statement the crewflow_owner session of the owner-URL mode may send (all read-only), for the secret-free spec. */
export const OWNER_SELF_STATEMENTS = [
  OWNER_BOOTSTRAP_Q0_SESSION,
  OWNER_SELF_O1_SESSION,
  OWNER_BOOTSTRAP_Q2_FACTS,
  OWNER_SCHEMA_S1_HAS_LEDGER,
  OWNER_SCHEMA_S2_LEDGER,
] as const;

/** Every statement the admin session may send, in order (the spec checks none of them can carry a secret). */
export const OWNER_BOOTSTRAP_ADMIN_STATEMENTS = [
  OWNER_BOOTSTRAP_Q0_SESSION,
  OWNER_BOOTSTRAP_Q1_SUPERUSER_LOGGING,
  OWNER_BOOTSTRAP_Q2_FACTS,
  OWNER_BOOTSTRAP_Q2B_OTHER_DATABASES,
  OWNER_BOOTSTRAP_BEGIN,
  OWNER_BOOTSTRAP_Q4A_LOCK,
  OWNER_BOOTSTRAP_Q4B_SET_INPUTS,
  OWNER_BOOTSTRAP_Q4B2_NO_SELF_GRANT,
  OWNER_BOOTSTRAP_L1_LOCK_TIMEOUT,
  OWNER_BOOTSTRAP_Q4C_DO,
  OWNER_BOOTSTRAP_Q4D_REVERIFY,
  OWNER_BOOTSTRAP_COMMIT,
  OWNER_BOOTSTRAP_ROLLBACK,
] as const;

/** The statements the no-password path sends on the admin session, in order (the spec checks none carries a secret). */
export const OWNER_BOOTSTRAP_NO_PASSWORD_STATEMENTS = [
  OWNER_BOOTSTRAP_BEGIN,
  OWNER_BOOTSTRAP_Q4A_LOCK,
  OWNER_BOOTSTRAP_Q2_FACTS,
  OWNER_BOOTSTRAP_Q4B2_NO_SELF_GRANT,
  OWNER_BOOTSTRAP_Q4C_DO_NO_PASSWORD,
  OWNER_BOOTSTRAP_Q4D_NO_PASSWORD_REVERIFY,
  OWNER_BOOTSTRAP_COMMIT,
  OWNER_BOOTSTRAP_ROLLBACK,
] as const;
