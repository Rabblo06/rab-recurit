/**
 * DB setup like Twenty (DB-SETUP-PLAN §3): the bootstrap SQL, VERBATIM. Run only by the bootstrap child
 * (bootstrap-owner-login.ts), connected as the database ADMIN named in PG_ADMIN_URL. Fixed text only: no identifier or
 * value from input reaches a statement's text. The two inputs travel as BIND PARAMETERS of OWNER_BOOTSTRAP_Q4B_SET_INPUTS
 * (the SCRAM verifier — never the password — and whether the password must be set); inside the DO block the database
 * name reaches the EXECUTEd GRANT through %I and the verifier through %L.
 *
 * The PLAIN-TEXT fallback (owner decision 2026-11-19: provider-neutral, decided by capability at run time, never by provider
 * name): some managed servers refuse a pre-hashed password (they may need the password itself, and may refuse it only at
 * COMMIT). db-setup always tries the SCRAM verifier first; only when the server refuses it (owner-bootstrap.ts
 * isVerifierRefusal: the SQLSTATE of the role statement or of the COMMIT) does it retry ONCE with the plain-text password,
 * and only over a connection that verifies TLS (certificate and host name). The plain text travels as the verifier does (a
 * bind parameter of OWNER_BOOTSTRAP_Q4B_PLAINTEXT_SET_INPUTS, then %L inside OWNER_BOOTSTRAP_Q4C_DO_PLAINTEXT), and only after
 * the log guard (OWNER_BOOTSTRAP_G1_QUIET_LOGS, then OWNER_BOOTSTRAP_G2_LOG_SAFE must say true) and with password_encryption
 * pinned to scram-sha-256 (OWNER_BOOTSTRAP_Q4B3_SCRAM_ONLY).
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
 * the server clock (both false when the role or the mark is missing).
 * TODO(lead, 2026-11-19): switch the privileged-membership list below (o_privileged_memberships) to
 * database/owner-login/privileged-roles.ts once it lands (one constant shared with the boot posture check).
 */
// sql-injection-reviewed: the only interpolation is createRoleMarkColumnsSql over a fixed column expression and quote-free code constants.
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
export const OWNER_BOOTSTRAP_Q4B_SET_INPUTS = `SELECT pg_catalog.set_config('crewflow_bootstrap.verifier', $1, true),
       pg_catalog.set_config('crewflow_bootstrap.need_password', $2, true);`;

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

/** Q4c (REVISED, security re-review N3: the verifier shape check before CREATE / ALTER ROLE). */
export const OWNER_BOOTSTRAP_Q4C_DO = `DO $bootstrap$
DECLARE
  v_db       text := pg_catalog.current_database();
  v_verifier text := pg_catalog.current_setting('crewflow_bootstrap.verifier');
  v_set_pw   boolean := pg_catalog.current_setting('crewflow_bootstrap.need_password')::boolean;
  v_stage    text := 'check';
  v_msg      text;
  r          record;
BEGIN
  BEGIN
    SELECT oid, rolsuper, rolbypassrls, rolreplication, rolcreatedb, rolcanlogin, rolinherit
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
      -- Re-check under the lock: another start may have changed it since Q2.
      IF r.rolsuper OR r.rolbypassrls OR r.rolreplication OR r.rolcreatedb OR NOT r.rolcanlogin OR NOT r.rolinherit THEN
        RAISE EXCEPTION 'crewflow_owner has privileged or wrong attributes' USING ERRCODE = '42501';
      END IF;
      IF v_set_pw THEN
        v_stage := 'role';
        EXECUTE pg_catalog.format('ALTER ROLE crewflow_owner PASSWORD %L', v_verifier);
      END IF;
    END IF;
    v_stage := 'grant';
    IF NOT (pg_catalog.has_database_privilege('crewflow_owner', v_db, 'CONNECT WITH GRANT OPTION')
        AND pg_catalog.has_database_privilege('crewflow_owner', v_db, 'CREATE WITH GRANT OPTION')
        AND pg_catalog.has_database_privilege('crewflow_owner', v_db, 'TEMPORARY WITH GRANT OPTION')) THEN
      EXECUTE pg_catalog.format('GRANT CONNECT, CREATE, TEMPORARY ON DATABASE %I TO crewflow_owner WITH GRANT OPTION', v_db);
    END IF;
  EXCEPTION WHEN OTHERS THEN
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
 * Q4b (plain-text fallback): the plain-text password and "must be set", as transaction-local custom settings sent as BIND
 * PARAMETERS ($1, $2): never in a statement text, pg_stat_activity.query or pg_stat_statements; custom settings are
 * per-backend (no other session can read them) and `true` drops them at the end of the transaction. A bind parameter IS
 * logged with a logged statement, hence G1 / G2 first.
 */
export const OWNER_BOOTSTRAP_Q4B_PLAINTEXT_SET_INPUTS = `SELECT pg_catalog.set_config('crewflow_bootstrap.password', $1, true),
       pg_catalog.set_config('crewflow_bootstrap.need_password', $2, true);`;

/**
 * Q4b3 (plain-text fallback, before Q4c): the server hashes a plain-text password with password_encryption, so it is pinned
 * to scram-sha-256 for this transaction (never md5). User-settable; fixed text; the DO block re-checks it.
 */
export const OWNER_BOOTSTRAP_Q4B3_SCRAM_ONLY = `SELECT pg_catalog.set_config('password_encryption', 'scram-sha-256', true);`;

/**
 * G1 (plain-text fallback, in the write transaction, before the password is sent): switch off, for THIS transaction, every
 * server log path that could record a bind parameter, wherever the admin login may (superuser, or GRANT SET ON PARAMETER,
 * PostgreSQL 15+; a managed-service admin usually cannot). Best effort by design: G2 decides. Only parameters that exist on
 * every supported major are named (has_parameter_privilege errors on an unknown name).
 */
export const OWNER_BOOTSTRAP_G1_QUIET_LOGS = `SELECT pg_catalog.set_config(s.name, s.value, true)
  FROM (VALUES ('log_statement', 'none'),
               ('log_min_duration_statement', '-1'),
               ('log_min_duration_sample', '-1'),
               ('log_transaction_sample_rate', '0'),
               ('log_duration', 'off'),
               ('log_parameter_max_length', '0'),
               ('log_min_error_statement', 'panic')) AS s(name, value)
 WHERE pg_catalog.has_parameter_privilege(s.name, 'SET');`;

/**
 * G2 (plain-text fallback, right after G1): may the plain-text password be sent? True only when no log or statistics view
 * of this session can record it:
 *   - a failing statement's parameters are never logged (log_parameter_max_length_on_error = 0, set by Q0);
 *   - no statement of this session is logged (log_statement is not 'all', log_min_duration_statement = -1, log_duration
 *     off, no sampled statement or transaction), OR parameters are never logged with a logged statement
 *     (log_parameter_max_length = 0);
 *   - auto_explain, when loaded, logs no plan or no parameters;
 *   - pgaudit, when loaded, does not log parameters (it redacts the PASSWORD of CREATE / ALTER ROLE itself);
 *   - pg_stat_statements, when loaded, does not record nested utility statements (track = 'all' with track_utility on would
 *     store the EXECUTEd CREATE ROLE ... PASSWORD text with its literal).
 * A setting that cannot be read is NULL, and anything but true is "unsafe": owner-bootstrap.ts then refuses (64) and the
 * password is never sent. SELECT only; fixed text.
 */
export const OWNER_BOOTSTRAP_G2_LOG_SAFE = `SELECT COALESCE(
         pg_catalog.current_setting('log_parameter_max_length_on_error') = '0'
         AND (   s.max_len = '0'
              OR (    s.stmt <> 'all'
                  AND s.min_dur = '-1'
                  AND s.duration = 'off'
                  AND (s.min_dur_sample = '-1' OR s.sample_rate::float8 = 0)
                  AND s.xact_rate::float8 = 0))
         AND (s.ae_min_dur IS NULL OR s.ae_min_dur = '-1' OR s.ae_max_len = '0')
         AND (s.pga_param IS NULL OR s.pga_param = 'off')
         AND (s.pgss_track IS NULL OR s.pgss_track <> 'all' OR s.pgss_utility = 'off'),
         false) AS safe
  FROM (SELECT pg_catalog.max(setting) FILTER (WHERE name = 'log_parameter_max_length')               AS max_len,
               pg_catalog.max(setting) FILTER (WHERE name = 'log_statement')                          AS stmt,
               pg_catalog.max(setting) FILTER (WHERE name = 'log_min_duration_statement')             AS min_dur,
               pg_catalog.max(setting) FILTER (WHERE name = 'log_duration')                           AS duration,
               pg_catalog.max(setting) FILTER (WHERE name = 'log_min_duration_sample')                AS min_dur_sample,
               pg_catalog.max(setting) FILTER (WHERE name = 'log_statement_sample_rate')              AS sample_rate,
               pg_catalog.max(setting) FILTER (WHERE name = 'log_transaction_sample_rate')            AS xact_rate,
               pg_catalog.max(setting) FILTER (WHERE name = 'auto_explain.log_min_duration')          AS ae_min_dur,
               pg_catalog.max(setting) FILTER (WHERE name = 'auto_explain.log_parameter_max_length')  AS ae_max_len,
               pg_catalog.max(setting) FILTER (WHERE name = 'pgaudit.log_parameter')                  AS pga_param,
               pg_catalog.max(setting) FILTER (WHERE name = 'pg_stat_statements.track')               AS pgss_track,
               pg_catalog.max(setting) FILTER (WHERE name = 'pg_stat_statements.track_utility')       AS pgss_utility
          FROM pg_catalog.pg_settings) AS s;`;

/**
 * Q4c (plain-text fallback): the same role, attributes and grant as OWNER_BOOTSTRAP_Q4C_DO, with the plain-text password.
 * Shape check before CREATE / ALTER ROLE: 32-1024 printable ASCII characters (the strength floor is checked before anything
 * connects), never a string PostgreSQL would store as pre-hashed (a SCRAM-SHA-256 verifier or an md5 hash), and
 * password_encryption must be scram-sha-256; anything else is 22023 at the check step. The same stage HINT and
 * CONTEXT-stripping re-raise as OWNER_BOOTSTRAP_Q4C_DO (the EXECUTEd text holds the password).
 */
export const OWNER_BOOTSTRAP_Q4C_DO_PLAINTEXT = `DO $bootstrap$
DECLARE
  v_db       text := pg_catalog.current_database();
  v_pw       text := pg_catalog.current_setting('crewflow_bootstrap.password');
  v_set_pw   boolean := pg_catalog.current_setting('crewflow_bootstrap.need_password')::boolean;
  v_stage    text := 'check';
  v_msg      text;
  r          record;
BEGIN
  BEGIN
    SELECT oid, rolsuper, rolbypassrls, rolreplication, rolcreatedb, rolcanlogin, rolinherit
      INTO r FROM pg_catalog.pg_roles WHERE rolname = 'crewflow_owner';
    IF (NOT FOUND OR v_set_pw)
       AND (v_pw IS NULL
            OR NOT (v_pw OPERATOR(pg_catalog.~) '^[ -~]{32,1024}$')
            OR v_pw OPERATOR(pg_catalog.~*) '^(scram-sha-256[$]|md5[0-9a-f]{32}$)'
            OR pg_catalog.current_setting('password_encryption') OPERATOR(pg_catalog.<>) 'scram-sha-256') THEN
      RAISE EXCEPTION 'not an acceptable plain-text password' USING ERRCODE = '22023';
    END IF;
    IF NOT FOUND THEN
      v_stage := 'role';
      EXECUTE pg_catalog.format(
        'CREATE ROLE crewflow_owner LOGIN NOSUPERUSER NOBYPASSRLS NOREPLICATION NOCREATEDB CREATEROLE INHERIT PASSWORD %L',
        v_pw);
    ELSE
      IF r.rolsuper OR r.rolbypassrls OR r.rolreplication OR r.rolcreatedb OR NOT r.rolcanlogin OR NOT r.rolinherit THEN
        RAISE EXCEPTION 'crewflow_owner has privileged or wrong attributes' USING ERRCODE = '42501';
      END IF;
      IF v_set_pw THEN
        v_stage := 'role';
        EXECUTE pg_catalog.format('ALTER ROLE crewflow_owner PASSWORD %L', v_pw);
      END IF;
    END IF;
    v_stage := 'grant';
    IF NOT (pg_catalog.has_database_privilege('crewflow_owner', v_db, 'CONNECT WITH GRANT OPTION')
        AND pg_catalog.has_database_privilege('crewflow_owner', v_db, 'CREATE WITH GRANT OPTION')
        AND pg_catalog.has_database_privilege('crewflow_owner', v_db, 'TEMPORARY WITH GRANT OPTION')) THEN
      EXECUTE pg_catalog.format('GRANT CONNECT, CREATE, TEMPORARY ON DATABASE %I TO crewflow_owner WITH GRANT OPTION', v_db);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF SQLSTATE = 'XX000' AND v_msg = 'tuple concurrently updated' THEN
      RAISE EXCEPTION 'tuple concurrently updated' USING ERRCODE = 'XX000', HINT = 'crewflow-stage=' || v_stage;
    END IF;
    -- Re-raise WITHOUT the inner statement: an error's CONTEXT would otherwise quote the EXECUTEd text (the password).
    RAISE EXCEPTION 'crewflow_owner bootstrap failed (%)', SQLSTATE USING ERRCODE = SQLSTATE, HINT = 'crewflow-stage=' || v_stage;
  END;
END
$bootstrap$;`;

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
  OWNER_BOOTSTRAP_Q4C_DO,
  OWNER_BOOTSTRAP_Q4D_REVERIFY,
  OWNER_BOOTSTRAP_COMMIT,
  OWNER_BOOTSTRAP_ROLLBACK,
] as const;

/** The statements the plain-text fallback adds to the admin session, in order (the spec checks none carries a secret). */
export const OWNER_BOOTSTRAP_PLAINTEXT_STATEMENTS = [
  OWNER_BOOTSTRAP_G1_QUIET_LOGS,
  OWNER_BOOTSTRAP_G2_LOG_SAFE,
  OWNER_BOOTSTRAP_Q4B3_SCRAM_ONLY,
  OWNER_BOOTSTRAP_Q4B_PLAINTEXT_SET_INPUTS,
  OWNER_BOOTSTRAP_Q4C_DO_PLAINTEXT,
] as const;
