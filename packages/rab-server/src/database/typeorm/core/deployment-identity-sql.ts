/**
 * SQL of migration DeploymentIdentity1786721230000 (Phase B / B3, P3; renumbered from the never-applied draft
 * 1786721200000 so it sorts after ProvisioningHealth1786721220000). Kept as data so the exact statements can be shown for
 * owner approval, scanned by the post-0b source rules, and asserted by unit tests without a database.
 *
 * Shape (see the migration's own comment for the reasoning):
 *   core.deployment_identity          singleton (boolean PK = true): environment, deployment_id, bound_database, bound_hosts,
 *                                     bound_system_identifier, bound_at, bound_by, reason
 *   core.deployment_identity_history  insert-only record of every bind (previous and new value incl. database and hosts,
 *                                     session login, actor, reason)
 *   core.deployment_identity_check()  SECURITY DEFINER read: (environment, deployment_id, bound_database, bound_hosts,
 *                                     bound_system_identifier, current_system_identifier). EXECUTE: crewflow_app, crewflow.
 *   core.deployment_identity_bind()   SECURITY DEFINER write: singleton + history row, atomically. EXECUTE: nobody but the
 *                                     owner, i.e. only the migration identity (a member of rab_secure_owner) or a superuser.
 *
 * Owner decision A (2026-10-29) + host-binding review (A8b): a restored or cloned database must never silently be treated
 * as the original deployment, yet a legitimate failover, DNS change or direct-vs-proxy split must not break it. The bind
 * therefore records WHERE the deployment lives:
 *   bound_database           current_database() at bind time, recorded by the function itself (never a parameter);
 *   bound_hosts              a SET of 1 to 5 connection host names the operator confirmed (repeated --confirm-host;
 *                            lower-case, validated here, stored sorted and distinct). A deployment whose API connects
 *                            through a session-compatible proxy host name while its Worker and migrations use the direct
 *                            host name binds both. Host NAMES are compared, never resolved addresses: a DNS / IP change
 *                            behind the same name, or a managed failover that keeps the name, still matches;
 *   bound_system_identifier  pg_control_system().system_identifier when the definer may call it, else NULL. Informational
 *                            only: physical copies (PITR, forks, branches) inherit it and logical restores change it, so
 *                            the runtime logs a mismatch as a warning and never uses it as proof.
 * The runtime refuses when current_database() <> bound_database or its own connection host is not in bound_hosts, until
 * the audited rebind (db:bind-identity) records the new location.
 * Both tables: owner rab_secure_owner, ENABLE + FORCE RLS, owner-only permissive policies that also require
 * CURRENT_USER = rab_secure_owner (true only inside the definers), a RESTRICTIVE deny-all for crewflow / crewflow_app, and no
 * table privilege for PUBLIC, crewflow or crewflow_app. The owner itself keeps only what the definers need
 * (singleton: SELECT/INSERT/UPDATE; history: SELECT/INSERT — UPDATE, DELETE and TRUNCATE revoked).
 *
 * BOUNDARY (the history is NOT tamper-proof): the migration identity is a member of rab_secure_owner. With the SET option
 * it can `SET ROLE rab_secure_owner` and then write the singleton directly (bypassing bind() and its history row), or, as
 * the owner, ALTER / DROP both tables or re-grant itself UPDATE / DELETE on the history. The history is an audit aid against
 * accidental or unauthorised RUNTIME changes and operator mistakes only, never a control against the migration identity or
 * a superuser.
 *
 * Definer bodies name only the two marker tables and pg_catalog built-ins, never a crewflow-owned table (R4 list) and
 * never dynamic SQL (secure-owner-invariants.ts), and pin `search_path = pg_catalog, pg_temp`.
 */

export const DEPLOYMENT_ENVIRONMENTS_SQL_LIST = `'production', 'staging', 'development', 'test', 'ci'`;

export const BIND_FUNCTION_SIGNATURE = 'core.deployment_identity_bind(text, uuid, text, text, uuid, text[])';
export const CHECK_FUNCTION_SIGNATURE = 'core.deployment_identity_check()';

const OWNER_ONLY = `(CURRENT_USER = 'rab_secure_owner'::name)`;

/** At most this many host names may be bound at once (direct, session-compatible proxy, a provider alias, ...). */
export const MAX_BOUND_HOSTS = 5;

/**
 * One bound host name, unanchored: letters / digits / dot / hyphen / colon (an IPv6 literal without brackets), starting
 * with a letter, digit or colon and ending with a letter or digit. Never a comma, so a comma-joined list is unambiguous.
 * Its length (1 to 253) is checked separately (a bounded repetition nested in the list repetition would make the
 * compiled regex needlessly large).
 */
const HOST_ELEMENT = '[a-z0-9:]([a-z0-9.:-]*[a-z0-9])?';
/** One host, anchored: what the bind command validates and the runtime compares (pg-url-policy.ts parsePgUrl canonical form). */
export const BOUND_HOST_PATTERN = `^${HOST_ELEMENT}$`;
/** The comma-joined list of 1 to MAX_BOUND_HOSTS hosts. NULL elements are rendered as `*` and therefore never match. */
export const BOUND_HOSTS_LIST_PATTERN = `^${HOST_ELEMENT}(,${HOST_ELEMENT}){0,${MAX_BOUND_HOSTS - 1}}$`;
/**
 * Shape of a host array without a subquery (the table CHECK and the definer's first validation use the same text):
 * one dimension, 1 to MAX_BOUND_HOSTS elements, no element containing a comma (so the comma-joined form below has exactly
 * one part per element), the comma-joined form matching BOUND_HOSTS_LIST_PATTERN (NULL rendered as `*` never matches),
 * and no element longer than 253 characters.
 */
const HOSTS_SHAPE = (column: string) =>
  `pg_catalog.array_ndims(${column}) = 1 AND pg_catalog.cardinality(${column}) BETWEEN 1 AND ${MAX_BOUND_HOSTS}
    AND pg_catalog.strpos(pg_catalog.array_to_string(${column}, '', '*'), ',') = 0
    AND pg_catalog.array_to_string(${column}, ',', '*') ~ '${BOUND_HOSTS_LIST_PATTERN}'
    AND NOT (pg_catalog.array_to_string(${column}, ',', '*') ~ '[^,]{254}')`;

export const DEPLOYMENT_IDENTITY_UP_SQL: readonly string[] = [
  `CREATE TABLE core.deployment_identity (
  singleton boolean NOT NULL DEFAULT true,
  environment text NOT NULL,
  deployment_id uuid NOT NULL,
  bound_database text NOT NULL,
  bound_hosts text[] NOT NULL,
  bound_system_identifier bigint,
  bound_at timestamptz NOT NULL,
  bound_by text NOT NULL,
  reason text NOT NULL,
  CONSTRAINT deployment_identity_pkey PRIMARY KEY (singleton),
  CONSTRAINT deployment_identity_singleton CHECK (singleton),
  CONSTRAINT deployment_identity_environment_allowed CHECK (environment IN (${DEPLOYMENT_ENVIRONMENTS_SQL_LIST})),
  CONSTRAINT deployment_identity_bound_database_length CHECK (pg_catalog.char_length(bound_database) BETWEEN 1 AND 63),
  CONSTRAINT deployment_identity_bound_hosts_shape CHECK (
    ${HOSTS_SHAPE('bound_hosts')}
  ),
  CONSTRAINT deployment_identity_bound_by_length CHECK (pg_catalog.char_length(bound_by) BETWEEN 1 AND 200),
  CONSTRAINT deployment_identity_reason_length CHECK (pg_catalog.char_length(reason) BETWEEN 10 AND 500)
)`,
  `CREATE TABLE core.deployment_identity_history (
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  bound_at timestamptz NOT NULL,
  previous_environment text,
  previous_deployment_id uuid,
  previous_bound_database text,
  previous_bound_hosts text[],
  environment text NOT NULL,
  deployment_id uuid NOT NULL,
  bound_database text NOT NULL,
  bound_hosts text[] NOT NULL,
  bound_system_identifier bigint,
  session_login text NOT NULL,
  bound_by text NOT NULL,
  reason text NOT NULL,
  CONSTRAINT deployment_identity_history_pkey PRIMARY KEY (id),
  CONSTRAINT deployment_identity_history_environment_allowed CHECK (environment IN (${DEPLOYMENT_ENVIRONMENTS_SQL_LIST})),
  CONSTRAINT deployment_identity_history_previous_pair CHECK ((previous_environment IS NULL) = (previous_deployment_id IS NULL)),
  CONSTRAINT deployment_identity_history_previous_location CHECK (
    (previous_environment IS NULL) = (previous_bound_database IS NULL) AND (previous_environment IS NULL) = (previous_bound_hosts IS NULL)
  )
)`,
  // Hand both tables to the NOLOGIN owner (Phase 0b: rab_secure_owner owns core, so a member may hand objects to it).
  'ALTER TABLE core.deployment_identity OWNER TO rab_secure_owner',
  'ALTER TABLE core.deployment_identity_history OWNER TO rab_secure_owner',
  // No table privilege for anyone but the owner; the owner keeps only what the definers need. History is insert-only.
  'REVOKE ALL ON TABLE core.deployment_identity, core.deployment_identity_history FROM PUBLIC, crewflow, crewflow_app',
  'REVOKE ALL ON TABLE core.deployment_identity, core.deployment_identity_history FROM rab_secure_owner',
  'GRANT SELECT, INSERT, UPDATE ON TABLE core.deployment_identity TO rab_secure_owner',
  'GRANT SELECT, INSERT ON TABLE core.deployment_identity_history TO rab_secure_owner',
  'ALTER TABLE core.deployment_identity ENABLE ROW LEVEL SECURITY',
  'ALTER TABLE core.deployment_identity FORCE ROW LEVEL SECURITY',
  'ALTER TABLE core.deployment_identity_history ENABLE ROW LEVEL SECURITY',
  'ALTER TABLE core.deployment_identity_history FORCE ROW LEVEL SECURITY',
  `CREATE POLICY deployment_identity_definer_select ON core.deployment_identity AS PERMISSIVE FOR SELECT TO rab_secure_owner USING ${OWNER_ONLY}`,
  `CREATE POLICY deployment_identity_definer_insert ON core.deployment_identity AS PERMISSIVE FOR INSERT TO rab_secure_owner WITH CHECK ${OWNER_ONLY}`,
  `CREATE POLICY deployment_identity_definer_update ON core.deployment_identity AS PERMISSIVE FOR UPDATE TO rab_secure_owner USING ${OWNER_ONLY} WITH CHECK ${OWNER_ONLY}`,
  'CREATE POLICY deployment_identity_runtime_deny ON core.deployment_identity AS RESTRICTIVE FOR ALL TO crewflow, crewflow_app USING (false) WITH CHECK (false)',
  `CREATE POLICY deployment_identity_history_definer_select ON core.deployment_identity_history AS PERMISSIVE FOR SELECT TO rab_secure_owner USING ${OWNER_ONLY}`,
  `CREATE POLICY deployment_identity_history_definer_insert ON core.deployment_identity_history AS PERMISSIVE FOR INSERT TO rab_secure_owner WITH CHECK ${OWNER_ONLY}`,
  'CREATE POLICY deployment_identity_history_runtime_deny ON core.deployment_identity_history AS RESTRICTIVE FOR ALL TO crewflow, crewflow_app USING (false) WITH CHECK (false)',
  `CREATE FUNCTION core.deployment_identity_check()
RETURNS TABLE (
  environment text,
  deployment_id uuid,
  bound_database text,
  bound_hosts text[],
  bound_system_identifier bigint,
  current_system_identifier bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_current_sid bigint;
BEGIN
  -- Informational only (never proof: physical copies inherit it, logical restores change it). NULL where the provider
  -- withholds pg_control_system().
  BEGIN
    SELECT s.system_identifier INTO v_current_sid FROM pg_catalog.pg_control_system() s;
  EXCEPTION WHEN insufficient_privilege OR undefined_function THEN
    v_current_sid := NULL;
  END;
  RETURN QUERY
    SELECT d.environment, d.deployment_id, d.bound_database, d.bound_hosts, d.bound_system_identifier, v_current_sid
      FROM core.deployment_identity d
     WHERE d.singleton;
END
$fn$`,
  `REVOKE ALL ON FUNCTION ${CHECK_FUNCTION_SIGNATURE} FROM PUBLIC`,
  `CREATE FUNCTION core.deployment_identity_bind(
  p_environment text,
  p_deployment_id uuid,
  p_reason text,
  p_actor text,
  p_expected_current_deployment_id uuid,
  p_bound_hosts text[]
)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_login text;
  v_now timestamptz;
  v_database text;
  v_hosts text[];
  v_distinct integer;
  v_lengths_ok boolean;
  v_sid bigint;
  v_prev_environment text;
  v_prev_deployment_id uuid;
  v_prev_database text;
  v_prev_hosts text[];
BEGIN
  v_login := session_user;
  v_now := pg_catalog.clock_timestamp();
  v_database := pg_catalog.current_database();
  IF v_login IN ('crewflow', 'crewflow_app') OR NOT pg_catalog.pg_has_role(session_user, 'rab_secure_owner', 'MEMBER') THEN
    RAISE EXCEPTION 'deployment_identity_bind: the session login % is not the migration identity', v_login
      USING ERRCODE = '42501';
  END IF;
  IF p_environment IS NULL OR p_environment NOT IN (${DEPLOYMENT_ENVIRONMENTS_SQL_LIST}) THEN
    RAISE EXCEPTION 'deployment_identity_bind: environment must be one of production, staging, development, test, ci'
      USING ERRCODE = '22023';
  END IF;
  IF p_deployment_id IS NULL THEN
    RAISE EXCEPTION 'deployment_identity_bind: a deployment id is required' USING ERRCODE = '22023';
  END IF;
  IF p_reason IS NULL OR pg_catalog.char_length(pg_catalog.btrim(p_reason)) NOT BETWEEN 10 AND 500 THEN
    RAISE EXCEPTION 'deployment_identity_bind: a reason of 10 to 500 characters is required' USING ERRCODE = '22023';
  END IF;
  IF p_actor IS NULL OR pg_catalog.char_length(pg_catalog.btrim(p_actor)) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'deployment_identity_bind: an actor of 1 to 200 characters is required' USING ERRCODE = '22023';
  END IF;
  IF p_bound_hosts IS NULL OR (${HOSTS_SHAPE('p_bound_hosts')}) IS NOT TRUE THEN
    RAISE EXCEPTION 'deployment_identity_bind: 1 to ${MAX_BOUND_HOSTS} confirmed connection hosts are required, each a lower-case host name or address'
      USING ERRCODE = '22023';
  END IF;
  -- Duplicates are refused; the set is stored sorted (byte order) so the marker and the history compare deterministically.
  SELECT pg_catalog.array_agg(u.h ORDER BY u.h COLLATE pg_catalog."C"), pg_catalog.count(DISTINCT u.h)::integer,
         pg_catalog.bool_and(pg_catalog.char_length(u.h) BETWEEN 1 AND 253)
    INTO v_hosts, v_distinct, v_lengths_ok
    FROM pg_catalog.unnest(p_bound_hosts) AS u(h);
  IF v_distinct <> pg_catalog.cardinality(p_bound_hosts) OR v_lengths_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'deployment_identity_bind: the confirmed connection hosts must be distinct names of 1 to 253 characters'
      USING ERRCODE = '22023';
  END IF;

  -- Informational only (never proof). NULL where the provider withholds pg_control_system() from this owner.
  BEGIN
    SELECT s.system_identifier INTO v_sid FROM pg_catalog.pg_control_system() s;
  EXCEPTION WHEN insufficient_privilege OR undefined_function THEN
    v_sid := NULL;
  END;

  SELECT d.environment, d.deployment_id, d.bound_database, d.bound_hosts
    INTO v_prev_environment, v_prev_deployment_id, v_prev_database, v_prev_hosts
    FROM core.deployment_identity d WHERE d.singleton FOR UPDATE;

  IF FOUND THEN
    IF p_expected_current_deployment_id IS NULL OR p_expected_current_deployment_id <> v_prev_deployment_id THEN
      RAISE EXCEPTION 'deployment_identity_bind: the confirmed current deployment id does not match the bound one; nothing changed'
        USING ERRCODE = '55000';
    END IF;
    IF p_deployment_id = v_prev_deployment_id THEN
      RAISE EXCEPTION 'deployment_identity_bind: a rebind needs a new deployment id' USING ERRCODE = '22023';
    END IF;
    UPDATE core.deployment_identity d
       SET environment = p_environment, deployment_id = p_deployment_id, bound_database = v_database,
           bound_hosts = v_hosts, bound_system_identifier = v_sid, bound_at = v_now,
           bound_by = pg_catalog.btrim(p_actor), reason = pg_catalog.btrim(p_reason)
     WHERE d.singleton;
  ELSE
    IF p_expected_current_deployment_id IS NOT NULL THEN
      RAISE EXCEPTION 'deployment_identity_bind: the database has no binding yet, so there is no current deployment id to confirm'
        USING ERRCODE = '55000';
    END IF;
    INSERT INTO core.deployment_identity
      (singleton, environment, deployment_id, bound_database, bound_hosts, bound_system_identifier, bound_at, bound_by, reason)
    VALUES
      (true, p_environment, p_deployment_id, v_database, v_hosts, v_sid, v_now, pg_catalog.btrim(p_actor),
       pg_catalog.btrim(p_reason));
  END IF;

  INSERT INTO core.deployment_identity_history
    (bound_at, previous_environment, previous_deployment_id, previous_bound_database, previous_bound_hosts, environment,
     deployment_id, bound_database, bound_hosts, bound_system_identifier, session_login, bound_by, reason)
  VALUES
    (v_now, v_prev_environment, v_prev_deployment_id, v_prev_database, v_prev_hosts, p_environment,
     p_deployment_id, v_database, v_hosts, v_sid, v_login, pg_catalog.btrim(p_actor), pg_catalog.btrim(p_reason));
END
$fn$`,
  `REVOKE ALL ON FUNCTION ${BIND_FUNCTION_SIGNATURE} FROM PUBLIC`,
  // Ownership after the PUBLIC revoke: the creator's ACL entry is rewritten to the new owner, so nothing names the creator.
  `ALTER FUNCTION ${CHECK_FUNCTION_SIGNATURE} OWNER TO rab_secure_owner`,
  `ALTER FUNCTION ${BIND_FUNCTION_SIGNATURE} OWNER TO rab_secure_owner`,
  `REVOKE ALL ON FUNCTION ${CHECK_FUNCTION_SIGNATURE} FROM crewflow, crewflow_app`,
  `REVOKE ALL ON FUNCTION ${BIND_FUNCTION_SIGNATURE} FROM crewflow, crewflow_app`,
  // crewflow_app: API / Worker boot gates. crewflow: operator CLI commands and the provisioner guard read it too.
  `GRANT EXECUTE ON FUNCTION ${CHECK_FUNCTION_SIGNATURE} TO crewflow_app, crewflow`,
];

export const DEPLOYMENT_IDENTITY_DOWN_SQL: readonly string[] = [
  `DROP FUNCTION ${BIND_FUNCTION_SIGNATURE}`,
  `DROP FUNCTION ${CHECK_FUNCTION_SIGNATURE}`,
  'DROP TABLE core.deployment_identity_history',
  'DROP TABLE core.deployment_identity',
];

/**
 * Preflight: the CF-41 / Phase 0b bootstrap identity (a superuser, or a member that can act as rab_secure_owner), Phase 0b
 * applied (rab_secure_owner owns core and is NOLOGIN / NOSUPERUSER / NOBYPASSRLS), and no marker object exists yet.
 */
export const DEPLOYMENT_IDENTITY_PREFLIGHT_SQL = `
SELECT current_user::text AS who, r.rolsuper AS su,
       (pg_catalog.pg_has_role(current_user, 'rab_secure_owner', 'USAGE')) AS can_act,
       (SELECT s.rolcanlogin OR s.rolsuper OR s.rolbypassrls FROM pg_catalog.pg_roles s WHERE s.rolname = 'rab_secure_owner') AS secure_bad,
       (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'core')::text AS core_owner,
       (pg_catalog.to_regclass('core.deployment_identity') IS NOT NULL
        OR pg_catalog.to_regclass('core.deployment_identity_history') IS NOT NULL
        OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
                    WHERE p.pronamespace = 'core'::regnamespace
                      AND p.proname IN ('deployment_identity_check', 'deployment_identity_bind'))) AS exists_already
  FROM pg_catalog.pg_roles r WHERE r.rolname = current_user`;

/** Post-condition: one row; every column compared exactly with DEPLOYMENT_IDENTITY_EXPECTED_STATE. */
export const DEPLOYMENT_IDENTITY_STATE_SQL = `
WITH t AS (
  SELECT c.oid, c.relname FROM pg_catalog.pg_class c
   WHERE c.relnamespace = 'core'::regnamespace AND c.relname IN ('deployment_identity', 'deployment_identity_history')
), f AS (
  SELECT p.oid, p.proname FROM pg_catalog.pg_proc p
   WHERE p.pronamespace = 'core'::regnamespace AND p.proname IN ('deployment_identity_check', 'deployment_identity_bind')
)
SELECT
  (SELECT pg_catalog.string_agg(x.v, ',' ORDER BY x.v) FROM (
     SELECT t.relname || ':' || pg_catalog.pg_get_userbyid(c.relowner) || ':' || c.relkind::text || ':' || c.relrowsecurity::text
            || ':' || c.relforcerowsecurity::text AS v
       FROM t JOIN pg_catalog.pg_class c ON c.oid = t.oid) x) AS tables,
  (SELECT pg_catalog.string_agg(x.v, ',' ORDER BY x.v) FROM (
     SELECT t.relname || ':' || CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END
            || ':' || a.privilege_type || ':' || a.is_grantable::text AS v
       FROM t JOIN pg_catalog.pg_class c ON c.oid = t.oid CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a) x) AS table_acl,
  (SELECT pg_catalog.string_agg(x.v, ',' ORDER BY x.v) FROM (
     SELECT pg_catalog.format('%s:%s:%s:%s:%s', f.proname, pg_catalog.pg_get_userbyid(p.proowner), p.prosecdef::text,
                              p.provolatile::text, COALESCE(pg_catalog.array_to_string(p.proconfig, ';'), '')) AS v
       FROM f JOIN pg_catalog.pg_proc p ON p.oid = f.oid) x) AS functions,
  (SELECT pg_catalog.string_agg(x.v, ',' ORDER BY x.v) FROM (
     SELECT f.proname || ':' || CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END
            || ':' || a.privilege_type || ':' || a.is_grantable::text AS v
       FROM f JOIN pg_catalog.pg_proc p ON p.oid = f.oid CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) a) x) AS function_acl,
  (SELECT pg_catalog.string_agg(x.v, ',' ORDER BY x.v) FROM (
     SELECT t.relname || ':' || pol.polname || ':' || pol.polcmd::text || ':' || pol.polpermissive::text || ':'
            || COALESCE((SELECT pg_catalog.string_agg(g.n, '+' ORDER BY g.n)
                           FROM (SELECT CASE WHEN r = 0 THEN 'public' ELSE pg_catalog.pg_get_userbyid(r)::text END AS n
                                   FROM pg_catalog.unnest(pol.polroles) r) g), '') AS v
       FROM t JOIN pg_catalog.pg_policy pol ON pol.polrelid = t.oid) x) AS policies,
  (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger g JOIN t ON t.oid = g.tgrelid WHERE NOT g.tgisinternal)::int AS triggers,
  (SELECT pg_catalog.string_agg(x.v, ',' ORDER BY x.v) FROM (
     SELECT t.relname || '.' || a.attname || ':' || pg_catalog.format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull::text AS v
       FROM t JOIN pg_catalog.pg_attribute a ON a.attrelid = t.oid AND a.attnum > 0 AND NOT a.attisdropped
      WHERE a.attname IN ('bound_database', 'bound_hosts', 'bound_system_identifier', 'previous_bound_hosts')) x) AS location_columns`;

export const DEPLOYMENT_IDENTITY_EXPECTED_STATE = {
  tables: 'deployment_identity:rab_secure_owner:r:true:true,deployment_identity_history:rab_secure_owner:r:true:true',
  table_acl: [
    'deployment_identity:rab_secure_owner:INSERT:false',
    'deployment_identity:rab_secure_owner:SELECT:false',
    'deployment_identity:rab_secure_owner:UPDATE:false',
    'deployment_identity_history:rab_secure_owner:INSERT:false',
    'deployment_identity_history:rab_secure_owner:SELECT:false',
  ].join(','),
  functions: [
    'deployment_identity_bind:rab_secure_owner:true:v:search_path=pg_catalog, pg_temp',
    'deployment_identity_check:rab_secure_owner:true:s:search_path=pg_catalog, pg_temp',
  ].join(','),
  function_acl: [
    'deployment_identity_bind:rab_secure_owner:EXECUTE:false',
    'deployment_identity_check:crewflow:EXECUTE:false',
    'deployment_identity_check:crewflow_app:EXECUTE:false',
    'deployment_identity_check:rab_secure_owner:EXECUTE:false',
  ].join(','),
  policies: [
    'deployment_identity:deployment_identity_definer_insert:a:true:rab_secure_owner',
    'deployment_identity:deployment_identity_definer_select:r:true:rab_secure_owner',
    'deployment_identity:deployment_identity_definer_update:w:true:rab_secure_owner',
    'deployment_identity:deployment_identity_runtime_deny:*:false:crewflow+crewflow_app',
    'deployment_identity_history:deployment_identity_history_definer_insert:a:true:rab_secure_owner',
    'deployment_identity_history:deployment_identity_history_definer_select:r:true:rab_secure_owner',
    'deployment_identity_history:deployment_identity_history_runtime_deny:*:false:crewflow+crewflow_app',
  ].join(','),
  triggers: 0,
  location_columns: [
    'deployment_identity.bound_database:text:true',
    'deployment_identity.bound_hosts:text[]:true',
    'deployment_identity.bound_system_identifier:bigint:false',
    'deployment_identity_history.bound_database:text:true',
    'deployment_identity_history.bound_hosts:text[]:true',
    'deployment_identity_history.bound_system_identifier:bigint:false',
    'deployment_identity_history.previous_bound_hosts:text[]:false',
  ].join(','),
} as const;

/** Nothing of the marker remains after down(). */
export const DEPLOYMENT_IDENTITY_GONE_SQL = `
SELECT (pg_catalog.to_regclass('core.deployment_identity') IS NULL
        AND pg_catalog.to_regclass('core.deployment_identity_history') IS NULL
        AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
                         WHERE p.pronamespace = 'core'::regnamespace
                           AND p.proname IN ('deployment_identity_check', 'deployment_identity_bind'))) AS gone`;
