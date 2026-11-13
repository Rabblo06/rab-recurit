// sql-injection-reviewed-file: SQL definition / check module (database layer). Every interpolation is a code constant of this repository (table, function, role and policy names, numeric limits, patterns); no request or row data reaches these templates. Reviewed 2026-11-12 (Phase X U-2, DRAFT for owner SQL review).
/**
 * Phase X U-2 (DRAFT, owner SQL review first): the release-upgrade attempt ledger, the Crewflow analogue of Twenty's
 * append-only `core."upgradeMigration"` (twenty@96893bec upgrade-migration.entity.ts:16-70; S0-TW §1.3). SQL of migration
 * ReleaseUpgradeLedger1786721460000, kept as data so the exact statements can be shown for review, scanned by the post-0b
 * source rules and asserted by unit tests without a database.
 *
 * WHAT IT RECORDS. One row per EVENT of a migrate-on-start attempt (never one row per migration: the TypeORM ledger
 * core.migrations already records those). Events:
 *   attributed  once, the first time an existing database meets this table: which known release its core.migrations
 *               ledger is (R254 / R256 / fresh / unknown, computed by the migrate child with release-floor.ts
 *               attributeLedger, exactly as U-1a attributes it) — the "initial attribution" of a legacy database;
 *   started     an attempt passed every gate after the migration lock and is about to apply `pending_count` migrations;
 *   completed   the attempt ended with outcome `ok` (served = true);
 *   failed      the attempt ended with any other outcome (config, behind, identity, postCheck, lockTimeout,
 *               migrationFailed, or degradedContinue when C3 served on the previous schema), with the error class and a
 *               redacted, bounded message.
 * A `started` row without a terminal row is an attempt that was killed or crashed. Every attempt is a new attempt_id; the
 * attempt number counts earlier attempts at the SAME target migration set (Twenty's attempt N+1).
 *
 * WHAT IT IS NOT. It is diagnostic and audit data. It never decides anything: the migrate child writes it AFTER the
 * outcome is decided (C3 unchanged), and a failed write is a WARNING, never a change of exit code or of `serve`.
 *
 * SHAPE AND POSTURE (the DeploymentIdentity1786721230000 pattern: a non-tenant table owned by rab_secure_owner, written only
 * by a SECURITY DEFINER function):
 *   - no organisation_id: release history is not tenant data (like core.migrations, core.permission, deployment_identity);
 *   - owner rab_secure_owner; ENABLE + FORCE ROW LEVEL SECURITY; owner-only PERMISSIVE policies (SELECT, INSERT) that also
 *     require CURRENT_USER = rab_secure_owner (true only inside the definer); a RESTRICTIVE deny-all for crewflow /
 *     crewflow_app (the owner login crewflow_owner is a member of crewflow, so its direct queries are denied too);
 *   - INSERT-ONLY: no table privilege for PUBLIC, crewflow or crewflow_app; the owner itself keeps SELECT and INSERT only
 *     (UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER revoked), and no UPDATE / DELETE policy exists, so even a grant would
 *     find no row to change under FORCE;
 *   - writes ONLY through core.release_upgrade_record(...) (SECURITY DEFINER, owner rab_secure_owner, pinned search_path,
 *     no PUBLIC / crewflow / crewflow_app EXECUTE): the session login must be a member of rab_secure_owner and neither
 *     crewflow nor crewflow_app — i.e. the owner login crewflow_owner (through its membership) or a superuser. The
 *     definer stamps recorded_at and session_login itself, validates every argument, redacts connection strings from the
 *     message, and names only this table and pg_catalog built-ins (no crewflow-owned table, no dynamic SQL:
 *     secure-owner-invariants.ts);
 *   - no read function in this item (tests read as the superuser; an admin read path is an open question).
 *
 * BOUNDARY (as for deployment_identity_history): NOT tamper-proof against the migration identity or a superuser — a member
 * of rab_secure_owner can SET ROLE rab_secure_owner and, as the owner, ALTER / DROP the table or re-grant itself UPDATE.
 * In the one-login architecture the API and the Worker run as that same login, so they can call the definer too (they
 * have no reason to; it only appends a validated row). It protects against accidental or unreviewed RUNTIME rewrites
 * (no UPDATE / DELETE path exists for the login on normal paths), not against the owner.
 */

export const LEDGER_TABLE = 'core.release_upgrade_event';
export const RECORD_FUNCTION_SIGNATURE =
  'core.release_upgrade_record(text, uuid, text, integer, text, text, text, integer, text, integer, integer, text, text, boolean, text, text, text)';

const OWNER_ONLY = `(CURRENT_USER = 'rab_secure_owner'::name)`;

/** The migrate child's StartupOutcome values (migrate-on-start.ts). */
export const LEDGER_OUTCOMES_SQL_LIST = `'ok', 'config', 'behind', 'migrationFailed', 'identity', 'postCheck', 'lockTimeout', 'degradedContinue'`;
export const LEDGER_EVENTS_SQL_LIST = `'attributed', 'started', 'completed', 'failed'`;
/** A release id (release-floor.ts manifest id `R<count>`), or `R<count>-unreleased` for a code set that is no published release yet. */
export const RELEASE_ID_PATTERN = '^R[0-9]{1,5}(-unreleased)?$';
/** What an existing ledger was attributed to. */
export const FROM_RELEASE_PATTERN = '^(R[0-9]{1,5}|fresh|unknown)$';
/** A TypeORM migration class name (release-floor.ts / migrate-on-start.ts codeMigrationNames). */
export const MIGRATION_NAME_PATTERN = '^[A-Za-z][A-Za-z0-9]{0,200}[0-9]{13}$';
export const ERROR_CLASS_PATTERN = '^[A-Za-z][A-Za-z0-9_]{0,99}$';
/** Display-only version text (APP_VERSION / a tag such as rab/v0.5.0): printable ASCII, no spaces. */
export const APP_VERSION_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._/+-]{0,99}$';
export const MAX_ERROR_MESSAGE = 1000;

export const RELEASE_UPGRADE_LEDGER_UP_SQL: readonly string[] = [
  `CREATE TABLE core.release_upgrade_event (
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  attempt_id uuid NOT NULL,
  attempt_number integer NOT NULL,
  event text NOT NULL,
  recorded_at timestamptz NOT NULL,
  session_login text NOT NULL,
  target_release text NOT NULL,
  target_migration_count integer NOT NULL,
  target_last_migration text NOT NULL,
  target_set_sha256 text NOT NULL,
  from_release text,
  from_migration_count integer,
  from_last_migration text,
  pending_count integer,
  applied_count integer,
  failed_migration text,
  outcome text,
  served boolean,
  error_class text,
  error_message text,
  app_version text,
  CONSTRAINT release_upgrade_event_pkey PRIMARY KEY (id),
  CONSTRAINT release_upgrade_event_one_per_attempt UNIQUE (attempt_id, event),
  CONSTRAINT release_upgrade_event_event_allowed CHECK (event IN (${LEDGER_EVENTS_SQL_LIST})),
  CONSTRAINT release_upgrade_event_attempt_number CHECK (attempt_number BETWEEN 1 AND 1000000),
  CONSTRAINT release_upgrade_event_session_login CHECK (pg_catalog.char_length(session_login) BETWEEN 1 AND 63),
  CONSTRAINT release_upgrade_event_target_release CHECK (target_release ~ '${RELEASE_ID_PATTERN}'),
  CONSTRAINT release_upgrade_event_target_count CHECK (target_migration_count BETWEEN 1 AND 100000),
  CONSTRAINT release_upgrade_event_target_last CHECK (target_last_migration ~ '${MIGRATION_NAME_PATTERN}'),
  CONSTRAINT release_upgrade_event_target_sha CHECK (target_set_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT release_upgrade_event_from_release CHECK (from_release IS NULL OR from_release ~ '${FROM_RELEASE_PATTERN}'),
  CONSTRAINT release_upgrade_event_from_count CHECK (from_migration_count IS NULL OR from_migration_count BETWEEN 0 AND 100000),
  CONSTRAINT release_upgrade_event_from_last CHECK (from_last_migration IS NULL OR from_last_migration ~ '${MIGRATION_NAME_PATTERN}'),
  CONSTRAINT release_upgrade_event_pending CHECK (pending_count IS NULL OR pending_count BETWEEN 0 AND 100000),
  CONSTRAINT release_upgrade_event_applied CHECK (applied_count IS NULL OR applied_count BETWEEN 0 AND 100000),
  CONSTRAINT release_upgrade_event_failed_migration CHECK (failed_migration IS NULL OR failed_migration ~ '${MIGRATION_NAME_PATTERN}'),
  CONSTRAINT release_upgrade_event_outcome CHECK (outcome IS NULL OR outcome IN (${LEDGER_OUTCOMES_SQL_LIST})),
  CONSTRAINT release_upgrade_event_error_class CHECK (error_class IS NULL OR error_class ~ '${ERROR_CLASS_PATTERN}'),
  CONSTRAINT release_upgrade_event_error_message CHECK (error_message IS NULL OR pg_catalog.char_length(error_message) BETWEEN 1 AND ${MAX_ERROR_MESSAGE}),
  CONSTRAINT release_upgrade_event_app_version CHECK (app_version IS NULL OR app_version ~ '${APP_VERSION_PATTERN}'),
  -- IS TRUE: a CHECK passes on NULL, so a missing outcome / served must not slip through the CASE.
  CONSTRAINT release_upgrade_event_shape CHECK ((
    CASE event
      WHEN 'attributed' THEN from_release IS NOT NULL AND from_migration_count IS NOT NULL
        AND pending_count IS NULL AND applied_count IS NULL AND failed_migration IS NULL AND outcome IS NULL AND served IS NULL
        AND error_class IS NULL AND error_message IS NULL
      WHEN 'started' THEN from_release IS NOT NULL AND from_migration_count IS NOT NULL AND pending_count IS NOT NULL
        AND applied_count IS NULL AND failed_migration IS NULL AND outcome IS NULL AND served IS NULL
        AND error_class IS NULL AND error_message IS NULL
      WHEN 'completed' THEN outcome = 'ok' AND served IS TRUE AND applied_count IS NOT NULL
        AND failed_migration IS NULL AND error_class IS NULL AND error_message IS NULL
      WHEN 'failed' THEN outcome IS NOT NULL AND outcome <> 'ok' AND served IS NOT NULL AND error_class IS NOT NULL
        AND (served = (outcome = 'degradedContinue'))
      ELSE false
    END
  ) IS TRUE)
)`,
  'CREATE INDEX release_upgrade_event_recorded_at_idx ON core.release_upgrade_event (recorded_at)',
  'CREATE INDEX release_upgrade_event_target_idx ON core.release_upgrade_event (target_set_sha256, attempt_id)',
  // Hand the table to the NOLOGIN owner (Phase 0b: rab_secure_owner owns core, so a member may hand objects to it).
  'ALTER TABLE core.release_upgrade_event OWNER TO rab_secure_owner',
  // Insert-only: no table privilege for anyone but the owner, and the owner keeps only what the definer needs.
  'REVOKE ALL ON TABLE core.release_upgrade_event FROM PUBLIC, crewflow, crewflow_app',
  'REVOKE ALL ON TABLE core.release_upgrade_event FROM rab_secure_owner',
  'GRANT SELECT, INSERT ON TABLE core.release_upgrade_event TO rab_secure_owner',
  'ALTER TABLE core.release_upgrade_event ENABLE ROW LEVEL SECURITY',
  'ALTER TABLE core.release_upgrade_event FORCE ROW LEVEL SECURITY',
  `CREATE POLICY release_upgrade_event_definer_select ON core.release_upgrade_event AS PERMISSIVE FOR SELECT TO rab_secure_owner USING ${OWNER_ONLY}`,
  `CREATE POLICY release_upgrade_event_definer_insert ON core.release_upgrade_event AS PERMISSIVE FOR INSERT TO rab_secure_owner WITH CHECK ${OWNER_ONLY}`,
  'CREATE POLICY release_upgrade_event_runtime_deny ON core.release_upgrade_event AS RESTRICTIVE FOR ALL TO crewflow, crewflow_app USING (false) WITH CHECK (false)',
  `CREATE FUNCTION core.release_upgrade_record(
  p_event text,
  p_attempt_id uuid,
  p_target_release text,
  p_target_migration_count integer,
  p_target_last_migration text,
  p_target_set_sha256 text,
  p_from_release text,
  p_from_migration_count integer,
  p_from_last_migration text,
  p_pending_count integer,
  p_applied_count integer,
  p_failed_migration text,
  p_outcome text,
  p_served boolean,
  p_error_class text,
  p_error_message text,
  p_app_version text
)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_login text;
  v_attempt integer;
  v_message text;
BEGIN
  v_login := session_user;
  IF v_login IN ('crewflow', 'crewflow_app') OR NOT pg_catalog.pg_has_role(session_user, 'rab_secure_owner', 'MEMBER') THEN
    RAISE EXCEPTION 'release_upgrade_record: the session login % may not write the release-upgrade ledger', v_login
      USING ERRCODE = '42501';
  END IF;
  IF p_event IS NULL OR p_event NOT IN (${LEDGER_EVENTS_SQL_LIST}) THEN
    RAISE EXCEPTION 'release_upgrade_record: unknown event' USING ERRCODE = '22023';
  END IF;
  IF p_attempt_id IS NULL THEN
    RAISE EXCEPTION 'release_upgrade_record: an attempt id is required' USING ERRCODE = '22023';
  END IF;
  -- One baseline only: the initial attribution is written while the ledger is still empty, never later.
  IF p_event = 'attributed' AND EXISTS (SELECT 1 FROM core.release_upgrade_event) THEN
    RAISE EXCEPTION 'release_upgrade_record: the initial attribution is already recorded' USING ERRCODE = '55000';
  END IF;
  -- Connection strings never reach the table, whatever the caller passed; the CHECK bounds the length.
  v_message := pg_catalog.regexp_replace(p_error_message, '(postgres(ql)?|rediss?)://[^[:space:]]+', '<url>', 'gi');
  IF v_message IS NOT NULL THEN
    v_message := pg_catalog.left(v_message, ${MAX_ERROR_MESSAGE});
  END IF;
  -- The attempt number: copied from this attempt's earlier row, else 1 + the earlier attempts at the same target set.
  SELECT e.attempt_number INTO v_attempt
    FROM core.release_upgrade_event e
   WHERE e.attempt_id = p_attempt_id AND e.event IN ('started', 'completed', 'failed')
   ORDER BY e.recorded_at LIMIT 1;
  IF v_attempt IS NULL THEN
    SELECT pg_catalog.count(DISTINCT e.attempt_id)::integer + 1 INTO v_attempt
      FROM core.release_upgrade_event e
     WHERE e.target_set_sha256 = p_target_set_sha256 AND e.event IN ('started', 'completed', 'failed');
  END IF;
  INSERT INTO core.release_upgrade_event
    (attempt_id, attempt_number, event, recorded_at, session_login, target_release, target_migration_count,
     target_last_migration, target_set_sha256, from_release, from_migration_count, from_last_migration, pending_count,
     applied_count, failed_migration, outcome, served, error_class, error_message, app_version)
  VALUES
    (p_attempt_id, v_attempt, p_event, pg_catalog.clock_timestamp(), v_login, p_target_release, p_target_migration_count,
     p_target_last_migration, p_target_set_sha256, p_from_release, p_from_migration_count, p_from_last_migration,
     p_pending_count, p_applied_count, p_failed_migration, p_outcome, p_served, p_error_class, v_message, p_app_version);
  RETURN v_attempt;
END
$fn$`,
  `REVOKE ALL ON FUNCTION ${RECORD_FUNCTION_SIGNATURE} FROM PUBLIC`,
  // Ownership after the PUBLIC revoke: the creator's ACL entry is rewritten to the new owner, so nothing names the creator.
  `ALTER FUNCTION ${RECORD_FUNCTION_SIGNATURE} OWNER TO rab_secure_owner`,
  `REVOKE ALL ON FUNCTION ${RECORD_FUNCTION_SIGNATURE} FROM crewflow, crewflow_app`,
];

export const RELEASE_UPGRADE_LEDGER_DOWN_SQL: readonly string[] = [
  `DROP FUNCTION ${RECORD_FUNCTION_SIGNATURE}`,
  'DROP TABLE core.release_upgrade_event',
];

/**
 * Preflight: the migration identity (a superuser, or a member that can act as rab_secure_owner: the owner login
 * crewflow_owner in phase B, or the restricted migrator), Phase 0b applied (rab_secure_owner owns core and is NOLOGIN /
 * NOSUPERUSER / NOBYPASSRLS), and (up) no ledger object exists yet.
 */
export const RELEASE_UPGRADE_LEDGER_PREFLIGHT_SQL = `
SELECT current_user::text AS who, r.rolsuper AS su,
       (pg_catalog.pg_has_role(current_user, 'rab_secure_owner', 'USAGE')) AS can_act,
       (SELECT s.rolcanlogin OR s.rolsuper OR s.rolbypassrls FROM pg_catalog.pg_roles s WHERE s.rolname = 'rab_secure_owner') AS secure_bad,
       (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'core')::text AS core_owner,
       (pg_catalog.to_regclass('core.release_upgrade_event') IS NOT NULL
        OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
                    WHERE p.pronamespace = 'core'::regnamespace AND p.proname = 'release_upgrade_record')) AS exists_already
  FROM pg_catalog.pg_roles r WHERE r.rolname = current_user`;

/** Post-condition: one row; every column compared exactly with RELEASE_UPGRADE_LEDGER_EXPECTED_STATE. */
export const RELEASE_UPGRADE_LEDGER_STATE_SQL = `
WITH t AS (
  SELECT c.oid, c.relname FROM pg_catalog.pg_class c
   WHERE c.relnamespace = 'core'::regnamespace AND c.relname = 'release_upgrade_event'
), f AS (
  SELECT p.oid, p.proname FROM pg_catalog.pg_proc p
   WHERE p.pronamespace = 'core'::regnamespace AND p.proname = 'release_upgrade_record'
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
  (SELECT pg_catalog.count(*) FROM t JOIN pg_catalog.pg_attribute a ON a.attrelid = t.oid
     WHERE a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL)::int AS column_acls,
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
  (SELECT pg_catalog.count(*) FROM t JOIN pg_catalog.pg_attribute a ON a.attrelid = t.oid
     WHERE a.attname = 'organisation_id' AND NOT a.attisdropped)::int AS organisation_id_columns`;

export const RELEASE_UPGRADE_LEDGER_EXPECTED_STATE = {
  tables: 'release_upgrade_event:rab_secure_owner:r:true:true',
  table_acl: ['release_upgrade_event:rab_secure_owner:INSERT:false', 'release_upgrade_event:rab_secure_owner:SELECT:false'].join(','),
  column_acls: 0,
  functions: 'release_upgrade_record:rab_secure_owner:true:v:search_path=pg_catalog, pg_temp',
  function_acl: 'release_upgrade_record:rab_secure_owner:EXECUTE:false',
  policies: [
    'release_upgrade_event:release_upgrade_event_definer_insert:a:true:rab_secure_owner',
    'release_upgrade_event:release_upgrade_event_definer_select:r:true:rab_secure_owner',
    'release_upgrade_event:release_upgrade_event_runtime_deny:*:false:crewflow+crewflow_app',
  ].join(','),
  triggers: 0,
  organisation_id_columns: 0,
} as const;

/** Nothing of the ledger remains after down(). */
export const RELEASE_UPGRADE_LEDGER_GONE_SQL = `
SELECT (pg_catalog.to_regclass('core.release_upgrade_event') IS NULL
        AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
                         WHERE p.pronamespace = 'core'::regnamespace AND p.proname = 'release_upgrade_record')) AS gone`;
