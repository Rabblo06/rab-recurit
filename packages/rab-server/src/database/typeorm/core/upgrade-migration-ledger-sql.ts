// sql-injection-reviewed-file: SQL definition / check module (database layer). Every interpolation is a code constant of this repository (table, policy, setting and role names, numeric limits, patterns); no request or row data reaches these templates. Reviewed 2026-11-13 (OWNER-DB-ULTIMATE Part B, DRAFT for owner SQL review).
/**
 * OWNER-DB-ULTIMATE Part B1/B2 (DRAFT, owner SQL review first): the upgrade logbook `core.upgrade_migration`, Twenty's
 * `core."upgradeMigration"` in snake_case (twentyhq/twenty @ eedb0a73 `engine/core-modules/upgrade/upgrade-migration.entity.ts`
 * :14 status, :17-38 the four indexes, :40-69 the columns). Re-implemented, not copied. SQL of migration
 * UpgradeMigrationLedger1786721470000, kept as data so the exact statements can be reviewed, scanned and unit-tested.
 *
 * Differences from Twenty (each owner-directed): `forced` (the manual `upgrade --force` run); no `error_class`; `created_at`
 * = clock_timestamp() (rows of one transaction still order); CHECKs on name / status / version / attempt / message length /
 * is_initial shape; the FK targets core.manager_workspace (Crewflow's workspace); and FORCE RLS (§0.2):
 *
 * ACCESS (B2: no SECURITY DEFINER function; plain queries from the upgrade code): the table is owned by rab_secure_owner,
 * whose SELECT + INSERT the one runtime login crewflow_owner inherits. FORCE RLS admits a transaction only by the
 * transaction-local setting `rab.upgrade_scope`, which only the upgrade code sets:
 *   upgrade         SELECT; INSERT only while THIS backend holds the migration advisory lock; never with a tenant bound
 *                   (the migrate child, `upgrade --force`);
 *   status          SELECT, never with a tenant bound (/healthz, the admin banner);
 *   workspace_init  SELECT + INSERT (is_initial only) of a workspace in the bound organisation (workspace creation).
 * Request handlers never set it: their transactions see no row and insert nothing. crewflow_app (and its member
 * crewflow_worker) is denied outright. Nobody holds UPDATE or TRUNCATE (not even the owner); the owner holds DELETE only so
 * the workspace FK cascade can run (RI actions bypass RLS); no DELETE policy exists, so any other DELETE removes nothing.
 * The workspace FK cascade is the only delete path (Twenty `:61-63`).
 *
 * BOUNDARY (SECURITY TRADE-OFF, UPGRADES-LEDGER-SQL.md "REVISED"): the setting is a code-path convention the database
 * enforces, not an authentication: any code running as crewflow_owner can set it, and crewflow_owner can, through its
 * membership, ALTER or DROP the table. error_message is stored as-is (owner: like Twenty) and can contain whatever a
 * failing step printed, connection strings included; it is never returned by /healthz or the banner.
 */
import { MIGRATION_LOCK_KEY } from '../scripts/migrate/migration-lock';

export const UPGRADE_LEDGER_TABLE = 'core.upgrade_migration';
export const UPGRADE_SCOPE_SETTING = 'rab.upgrade_scope';
export const MAX_ERROR_MESSAGE = 4000;
const VERSION_RE = `(0|[1-9][0-9]{0,3})\\.(0|[1-9][0-9]{0,3})\\.(0|[1-9][0-9]{0,3})`;
export const NAME_PATTERN_SQL = `^${VERSION_RE}_[A-Za-z][A-Za-z0-9]{0,150}(_[0-9]{13})?$`;
export const VERSION_PATTERN_SQL = `^${VERSION_RE}$`;

/** pg_locks spells the single-bigint MIGRATION_LOCK_KEY as classid (high 32 bits) / objid (low 32 bits) / objsubid 1. */
export const LOCK_CLASSID = Number(BigInt.asUintN(64, MIGRATION_LOCK_KEY) >> 32n);
export const LOCK_OBJID = Number(BigInt.asUintN(64, MIGRATION_LOCK_KEY) & 0xffffffffn);

const SCOPE = `pg_catalog.current_setting('${UPGRADE_SCOPE_SETTING}', true)`;
const NO_TENANT = 'core.current_org() IS NULL';
const HOLDS_MIGRATION_LOCK = `EXISTS (
      SELECT 1 FROM pg_catalog.pg_locks l
       WHERE l.locktype = 'advisory' AND l.granted AND l.pid = pg_catalog.pg_backend_pid()
         AND l.database = (SELECT d.oid FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database())
         AND l.classid = ${LOCK_CLASSID}::oid AND l.objid = ${LOCK_OBJID}::oid AND l.objsubid = 1)`;
const OWN_WORKSPACE = `EXISTS (SELECT 1 FROM core.manager_workspace w
                 WHERE w.id = upgrade_migration.workspace_id AND w.organisation_id = core.current_org())`;

export const UPGRADE_LEDGER_TABLE_COMMENT_SQL =
  "'OWNER-DB-ULTIMATE Part B: upgrade logbook shaped like Twenty''s core.\"upgradeMigration\". One row when a step ends (completed | failed; attempt = previous + 1 under the migration lock). Plain queries from the upgrade code only, chosen per transaction by rab.upgrade_scope (upgrade | status | workspace_init); request handlers see and write nothing. No UPDATE or TRUNCATE privilege and no DELETE policy (the owner holds DELETE only for the cascade); rows leave only through the workspace FK cascade. error_message is stored as-is (length-capped) and may contain what the failing step printed.'";

export const UPGRADE_LEDGER_UP_SQL: readonly string[] = [
  `CREATE TABLE core.upgrade_migration (
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  name text NOT NULL,
  status text NOT NULL,
  attempt integer NOT NULL DEFAULT 1,
  executed_by_version text NOT NULL,
  error_message text,
  is_initial boolean NOT NULL DEFAULT false,
  workspace_id uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  forced boolean NOT NULL DEFAULT false,
  CONSTRAINT upgrade_migration_pkey PRIMARY KEY (id),
  CONSTRAINT upgrade_migration_workspace_fkey FOREIGN KEY (workspace_id)
    REFERENCES core.manager_workspace (id) ON DELETE CASCADE,
  CONSTRAINT upgrade_migration_name_ck CHECK (name ~ '${NAME_PATTERN_SQL}'),
  CONSTRAINT upgrade_migration_status_ck CHECK (status IN ('completed', 'failed')),
  CONSTRAINT upgrade_migration_attempt_ck CHECK (attempt >= 1),
  CONSTRAINT upgrade_migration_version_ck CHECK (executed_by_version ~ '${VERSION_PATTERN_SQL}'),
  CONSTRAINT upgrade_migration_error_message_ck CHECK (
    error_message IS NULL OR (status = 'failed' AND pg_catalog.char_length(error_message) <= ${MAX_ERROR_MESSAGE})),
  CONSTRAINT upgrade_migration_initial_ck CHECK (NOT is_initial OR (attempt = 1 AND NOT forced))
)`,
  'CREATE UNIQUE INDEX upgrade_migration_instance_uq ON core.upgrade_migration (name, attempt) WHERE workspace_id IS NULL',
  'CREATE UNIQUE INDEX upgrade_migration_workspace_uq ON core.upgrade_migration (name, attempt, workspace_id) WHERE workspace_id IS NOT NULL',
  'CREATE INDEX upgrade_migration_workspace_name_attempt_idx ON core.upgrade_migration (workspace_id, name, attempt) WHERE workspace_id IS NOT NULL',
  'CREATE INDEX upgrade_migration_workspace_created_at_idx ON core.upgrade_migration (workspace_id, created_at) WHERE workspace_id IS NOT NULL',
  'ALTER TABLE core.upgrade_migration OWNER TO rab_secure_owner',
  'REVOKE ALL ON TABLE core.upgrade_migration FROM PUBLIC, crewflow, crewflow_app',
  'REVOKE ALL ON TABLE core.upgrade_migration FROM rab_secure_owner',
  // DELETE for the OWNER only, and only so the workspace FK cascade can run: PostgreSQL executes an ON DELETE CASCADE as
  // the owner of the referencing table and checks that owner's DELETE privilege (without it every core.manager_workspace
  // delete fails 42501). The cascade bypasses RLS (RI actions are not subject to FORCE); every other DELETE, by the owner
  // role too, meets FORCE RLS with no DELETE policy and removes nothing. Still no UPDATE or TRUNCATE for anyone.
  'GRANT SELECT, INSERT, DELETE ON TABLE core.upgrade_migration TO rab_secure_owner',
  'ALTER TABLE core.upgrade_migration ENABLE ROW LEVEL SECURITY',
  'ALTER TABLE core.upgrade_migration FORCE ROW LEVEL SECURITY',
  `CREATE POLICY upgrade_migration_upgrade_select ON core.upgrade_migration
  AS PERMISSIVE FOR SELECT TO PUBLIC
  USING (${SCOPE} IN ('upgrade', 'status') AND ${NO_TENANT})`,
  `CREATE POLICY upgrade_migration_upgrade_insert ON core.upgrade_migration
  AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK (
    ${SCOPE} = 'upgrade'
    AND ${NO_TENANT}
    AND ${HOLDS_MIGRATION_LOCK})`,
  `CREATE POLICY upgrade_migration_workspace_select ON core.upgrade_migration
  AS PERMISSIVE FOR SELECT TO PUBLIC
  USING (
    ${SCOPE} = 'workspace_init'
    AND workspace_id IS NOT NULL
    AND ${OWN_WORKSPACE})`,
  `CREATE POLICY upgrade_migration_workspace_insert ON core.upgrade_migration
  AS PERMISSIVE FOR INSERT TO PUBLIC
  WITH CHECK (
    ${SCOPE} = 'workspace_init'
    AND is_initial
    AND workspace_id IS NOT NULL
    AND ${OWN_WORKSPACE})`,
  `CREATE POLICY upgrade_migration_legacy_deny ON core.upgrade_migration
  AS RESTRICTIVE FOR ALL TO crewflow_app
  USING (false) WITH CHECK (false)`,
  `COMMENT ON TABLE core.upgrade_migration IS ${UPGRADE_LEDGER_TABLE_COMMENT_SQL}`,
];

/** down(): ledger_rows must be 0 (rows are kept: no delete path), then the table goes with its policies, indexes and FK. */
export const UPGRADE_LEDGER_ROWS_SQL = `SELECT pg_catalog.count(*)::int AS ledger_rows FROM core.upgrade_migration`;
export const UPGRADE_LEDGER_DOWN_SQL: readonly string[] = ['DROP TABLE core.upgrade_migration'];
export const UPGRADE_LEDGER_GONE_SQL = `SELECT pg_catalog.to_regclass('core.upgrade_migration') IS NULL AS gone`;

/**
 * Preflight (up / down): the migration identity (a superuser, or a login that can act as rab_secure_owner), Phase 0b
 * applied, the roles named here present, core.manager_workspace owned by rab_secure_owner with FORCE (the FK target and the
 * workspace policies' subquery), core.current_org() present, PostgreSQL 16+, and (up) no ledger yet.
 */
export const UPGRADE_LEDGER_PREFLIGHT_SQL = `
SELECT current_user::text AS who,
       r.rolsuper AS su,
       pg_catalog.pg_has_role(current_user, 'rab_secure_owner'::name, 'USAGE') AS can_act,
       (SELECT s.rolcanlogin OR s.rolsuper OR s.rolbypassrls FROM pg_catalog.pg_roles s WHERE s.rolname = 'rab_secure_owner') AS secure_bad,
       (SELECT pg_catalog.count(*) FROM pg_catalog.pg_roles x WHERE x.rolname IN ('crewflow', 'crewflow_app'))::int AS legacy_roles,
       (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'core')::text AS core_owner,
       (SELECT pg_catalog.pg_get_userbyid(c.relowner)::text || ':' || c.relforcerowsecurity::text
          FROM pg_catalog.pg_class c WHERE c.relnamespace = 'core'::regnamespace AND c.relname = 'manager_workspace') AS manager_workspace,
       (pg_catalog.to_regprocedure('core.current_org()') IS NOT NULL) AS current_org,
       (pg_catalog.current_setting('server_version_num')::int >= 160000) AS pg16_or_later,
       (pg_catalog.to_regclass('core.upgrade_migration') IS NOT NULL) AS exists_already
  FROM pg_catalog.pg_roles r WHERE r.rolname = current_user`;

/** Post-condition: one row; every column compared exactly with UPGRADE_LEDGER_EXPECTED_STATE. */
export const UPGRADE_LEDGER_STATE_SQL = `
WITH t AS (
  SELECT c.oid, c.relname FROM pg_catalog.pg_class c
   WHERE c.relnamespace = 'core'::regnamespace AND c.relname = 'upgrade_migration'
)
SELECT
  (SELECT t.relname || ':' || pg_catalog.pg_get_userbyid(c.relowner) || ':' || c.relkind::text || ':'
          || c.relrowsecurity::text || ':' || c.relforcerowsecurity::text
     FROM t JOIN pg_catalog.pg_class c ON c.oid = t.oid) AS tables,
  (SELECT pg_catalog.string_agg(x.v, ',' ORDER BY x.v) FROM (
     SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END
            || ':' || a.privilege_type || ':' || a.is_grantable::text AS v
       FROM t JOIN pg_catalog.pg_class c ON c.oid = t.oid CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a) x) AS table_acl,
  (SELECT pg_catalog.count(*) FROM t JOIN pg_catalog.pg_attribute a ON a.attrelid = t.oid
     WHERE a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL)::int AS column_acls,
  (SELECT pg_catalog.string_agg(a.attname || ':' || pg_catalog.format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull::text,
                                ',' ORDER BY a.attnum)
     FROM t JOIN pg_catalog.pg_attribute a ON a.attrelid = t.oid WHERE a.attnum > 0 AND NOT a.attisdropped) AS columns,
  (SELECT pg_catalog.string_agg(k.conname || ':' || k.contype::text
            || CASE WHEN k.contype = 'f' THEN ':' || k.confrelid::regclass::text || ':' || k.confdeltype::text ELSE '' END,
          ',' ORDER BY k.conname)
     FROM t JOIN pg_catalog.pg_constraint k ON k.conrelid = t.oid
    WHERE k.contype <> 'n') AS constraints,
  (SELECT pg_catalog.string_agg(i.relname || ':' || x.indisunique::text, ',' ORDER BY i.relname)
     FROM t JOIN pg_catalog.pg_index x ON x.indrelid = t.oid JOIN pg_catalog.pg_class i ON i.oid = x.indexrelid) AS indexes,
  (SELECT pg_catalog.string_agg(x.v, ',' ORDER BY x.v) FROM (
     SELECT pol.polname || ':' || pol.polcmd::text || ':' || pol.polpermissive::text || ':'
            || COALESCE((SELECT pg_catalog.string_agg(g.n, '+' ORDER BY g.n)
                           FROM (SELECT CASE WHEN r = 0 THEN 'public' ELSE pg_catalog.pg_get_userbyid(r)::text END AS n
                                   FROM pg_catalog.unnest(pol.polroles) r) g), '') AS v
       FROM t JOIN pg_catalog.pg_policy pol ON pol.polrelid = t.oid) x) AS policies,
  (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger g JOIN t ON t.oid = g.tgrelid WHERE NOT g.tgisinternal)::int AS triggers,
  (SELECT pg_catalog.count(*) FROM pg_catalog.pg_rewrite w JOIN t ON t.oid = w.ev_class)::int AS rules,
  (SELECT pg_catalog.count(*) FROM t JOIN pg_catalog.pg_attribute a ON a.attrelid = t.oid
     WHERE a.attname = 'organisation_id' AND NOT a.attisdropped)::int AS organisation_id_columns,
  (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc p
    WHERE p.pronamespace = 'core'::regnamespace AND p.proname LIKE 'upgrade_migration%')::int AS functions`;

export const UPGRADE_LEDGER_EXPECTED_STATE = {
  tables: 'upgrade_migration:rab_secure_owner:r:true:true',
  table_acl: ['rab_secure_owner:DELETE:false', 'rab_secure_owner:INSERT:false', 'rab_secure_owner:SELECT:false'].join(','),
  column_acls: 0,
  columns: [
    'id:uuid:true',
    'name:text:true',
    'status:text:true',
    'attempt:integer:true',
    'executed_by_version:text:true',
    'error_message:text:false',
    'is_initial:boolean:true',
    'workspace_id:uuid:false',
    'created_at:timestamp with time zone:true',
    'forced:boolean:true',
  ].join(','),
  constraints: [
    'upgrade_migration_attempt_ck:c',
    'upgrade_migration_error_message_ck:c',
    'upgrade_migration_initial_ck:c',
    'upgrade_migration_name_ck:c',
    'upgrade_migration_pkey:p',
    'upgrade_migration_status_ck:c',
    'upgrade_migration_version_ck:c',
    'upgrade_migration_workspace_fkey:f:core.manager_workspace:c',
  ].join(','),
  indexes: [
    'upgrade_migration_instance_uq:true',
    'upgrade_migration_pkey:true',
    'upgrade_migration_workspace_created_at_idx:false',
    'upgrade_migration_workspace_name_attempt_idx:false',
    'upgrade_migration_workspace_uq:true',
  ].join(','),
  policies: [
    'upgrade_migration_legacy_deny:*:false:crewflow_app',
    'upgrade_migration_upgrade_insert:a:true:public',
    'upgrade_migration_upgrade_select:r:true:public',
    'upgrade_migration_workspace_insert:a:true:public',
    'upgrade_migration_workspace_select:r:true:public',
  ].join(','),
  triggers: 0,
  rules: 0,
  organisation_id_columns: 0,
  functions: 0,
} as const;
