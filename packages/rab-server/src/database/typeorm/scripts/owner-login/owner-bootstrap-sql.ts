/**
 * DB setup like Twenty (DB-SETUP-PLAN §3): the bootstrap SQL, VERBATIM. Run only by the bootstrap child
 * (bootstrap-owner-login.ts), connected as the database ADMIN named in PG_DATABASE_URL. Fixed text only: no identifier or
 * value from input reaches a statement's text. The two inputs travel as BIND PARAMETERS of OWNER_BOOTSTRAP_Q4B_SET_INPUTS
 * (the SCRAM verifier — never the password — and whether the password must be set); inside the DO block the database
 * name reaches the EXECUTEd GRANT through %I and the verifier through %L.
 *
 * The only change from the plan text: §3.5 marks the advisory key as a placeholder ("the PR fixes the constant"). It is
 * fixed here as OWNER_BOOTSTRAP_LOCK_KEY, the ASCII bytes "crewboot" as one 64-bit integer, the same convention as the
 * migration lock ("crewmigr", migration-lock.ts) and the platform-admin lock ("crewpa01", platform-admin.service.ts);
 * owner-bootstrap.spec.ts asserts it differs from every other advisory key in the repository.
 *
 * Changing ANY of these strings is a security-reviewed change: the plan's §3.6 log/visibility analysis depends on them.
 */

/** "crewboot" (0x63726577626f6f74). Transaction-scoped: one bootstrap at a time per database (two API replicas). */
export const OWNER_BOOTSTRAP_LOCK_KEY = '7165901520526864244';

/** Q0: user-settable; stops a failing statement's parameters being logged. */
export const OWNER_BOOTSTRAP_Q0_SESSION = `SET log_parameter_max_length_on_error = 0;`;

/** Q1: superuser-only settings; a no-op row for a non-superuser admin (same trick as 01-crewflow-owner.sql). */
export const OWNER_BOOTSTRAP_Q1_SUPERUSER_LOGGING = `SELECT pg_catalog.set_config('log_statement', 'none', false),
       pg_catalog.set_config('log_min_error_statement', 'panic', false),
       pg_catalog.set_config('log_parameter_max_length', '0', false)
  FROM pg_catalog.pg_roles WHERE rolname = current_user AND rolsuper;`;

/** Q2: the facts, one read, no writes. (`pg_maintain` exists only on PG17+; naming a missing role in IN (...) is harmless.) */
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
                                                                                  AS o_has_db_grant
  FROM pg_catalog.pg_roles a
  LEFT JOIN pg_catalog.pg_roles o ON o.rolname = 'crewflow_owner'
 WHERE a.rolname = current_user;`;

/** Q3 (the password probe), sent on a SECOND connection as crewflow_owner with the derived password. */
export const OWNER_BOOTSTRAP_Q3_PROBE = `SELECT 1`;

export const OWNER_BOOTSTRAP_BEGIN = `BEGIN;`;

/** Q4a: one bootstrap at a time (two API replicas starting together). */
export const OWNER_BOOTSTRAP_Q4A_LOCK = `SELECT pg_catalog.pg_advisory_xact_lock(${OWNER_BOOTSTRAP_LOCK_KEY});`;

/**
 * Q4b: inputs as transaction-local custom settings, sent as BIND PARAMETERS ($1, $2), so neither value is in any
 * statement text, pg_stat_activity.query, pg_stat_statements or log_statement output.
 */
export const OWNER_BOOTSTRAP_Q4B_SET_INPUTS = `SELECT pg_catalog.set_config('crewflow_bootstrap.verifier', $1, true),
       pg_catalog.set_config('crewflow_bootstrap.need_password', $2, true);`;

/** Q4c */
export const OWNER_BOOTSTRAP_Q4C_DO = `DO $bootstrap$
DECLARE
  v_db       text := pg_catalog.current_database();
  v_verifier text := pg_catalog.current_setting('crewflow_bootstrap.verifier');
  v_set_pw   boolean := pg_catalog.current_setting('crewflow_bootstrap.need_password')::boolean;
  r          record;
BEGIN
  BEGIN
    SELECT oid, rolsuper, rolbypassrls, rolreplication, rolcreatedb, rolcanlogin, rolinherit
      INTO r FROM pg_catalog.pg_roles WHERE rolname = 'crewflow_owner';
    IF NOT FOUND THEN
      EXECUTE pg_catalog.format(
        'CREATE ROLE crewflow_owner LOGIN NOSUPERUSER NOBYPASSRLS NOREPLICATION NOCREATEDB CREATEROLE INHERIT PASSWORD %L',
        v_verifier);
    ELSE
      -- Re-check under the lock: another start may have changed it since Q2.
      IF r.rolsuper OR r.rolbypassrls OR r.rolreplication OR r.rolcreatedb OR NOT r.rolcanlogin OR NOT r.rolinherit THEN
        RAISE EXCEPTION 'crewflow_owner has privileged or wrong attributes' USING ERRCODE = '42501';
      END IF;
      IF v_set_pw THEN
        EXECUTE pg_catalog.format('ALTER ROLE crewflow_owner PASSWORD %L', v_verifier);
      END IF;
    END IF;
    IF NOT (pg_catalog.has_database_privilege('crewflow_owner', v_db, 'CONNECT WITH GRANT OPTION')
        AND pg_catalog.has_database_privilege('crewflow_owner', v_db, 'CREATE WITH GRANT OPTION')
        AND pg_catalog.has_database_privilege('crewflow_owner', v_db, 'TEMPORARY WITH GRANT OPTION')) THEN
      EXECUTE pg_catalog.format('GRANT CONNECT, CREATE, TEMPORARY ON DATABASE %I TO crewflow_owner WITH GRANT OPTION', v_db);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- Re-raise WITHOUT the inner statement: an error's CONTEXT would otherwise quote the EXECUTEd text (the verifier).
    RAISE EXCEPTION 'crewflow_owner bootstrap failed (%)', SQLSTATE USING ERRCODE = SQLSTATE;
  END;
END
$bootstrap$;`;

/** Q4d: re-verify the result exactly (attributes + grant), fail closed if not exact. */
export const OWNER_BOOTSTRAP_Q4D_REVERIFY = `SELECT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls AND NOT rolreplication AND NOT rolcreatedb AND rolinherit
       AND pg_catalog.has_database_privilege(oid, pg_catalog.current_database(), 'CREATE WITH GRANT OPTION') AS ok
  FROM pg_catalog.pg_roles WHERE rolname = 'crewflow_owner';`;

export const OWNER_BOOTSTRAP_COMMIT = `COMMIT;`;
export const OWNER_BOOTSTRAP_ROLLBACK = `ROLLBACK;`;

/** Every statement the admin session may send, in order (the spec checks none of them can carry a secret). */
export const OWNER_BOOTSTRAP_ADMIN_STATEMENTS = [
  OWNER_BOOTSTRAP_Q0_SESSION,
  OWNER_BOOTSTRAP_Q1_SUPERUSER_LOGGING,
  OWNER_BOOTSTRAP_Q2_FACTS,
  OWNER_BOOTSTRAP_BEGIN,
  OWNER_BOOTSTRAP_Q4A_LOCK,
  OWNER_BOOTSTRAP_Q4B_SET_INPUTS,
  OWNER_BOOTSTRAP_Q4C_DO,
  OWNER_BOOTSTRAP_Q4D_REVERIFY,
  OWNER_BOOTSTRAP_COMMIT,
  OWNER_BOOTSTRAP_ROLLBACK,
] as const;
