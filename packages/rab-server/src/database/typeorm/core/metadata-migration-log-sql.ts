// sql-injection-reviewed-file: SQL definition / check module (database layer). Every interpolation is a code constant of this repository (table, trigger, function, constraint and role names, the closed change-kind list, numeric limits); no request or row data reaches these templates. Reviewed 2026-11-18 (metadata engine M2 phase 1, DRAFT for owner SQL review).
/**
 * Metadata engine M2, phase 1 (docs/plans/phase-x4/M2-PLAN.md §10 S-1, PR-3; OB-1; owner decision 2026-11-18): the runtime
 * data-model change log `core.metadata_migration`. SQL of migration MetadataMigrationLog1786721640000, kept as data so the
 * exact statements can be reviewed, scanned and unit-tested. DRAFT — owner SQL review FIRST; run only on throwaway
 * databases until approved.
 *
 * One row per applied data-model change (release 2: `MetadataChangeRunner`, M2-PLAN §2.2 step 9), written in the SAME
 * transaction as the change, after the M1 version trigger has bumped `core.workspace_metadata_state`. Upgrade-time engine
 * work keeps going to `core.upgrade_migration` (its approved INSERT path needs the upgrade scope, which the request path
 * never has). Twenty keeps no runtime log (twentyhq/twenty @ eedb0a73 has no counterpart table; M0-BACKEND §2.3), so this
 * is a Crewflow addition, not a port.
 *
 * Owner decisions this file encodes (2026-11-18):
 *   - retention: the log belongs to its workspace — `(workspace_id, organisation_id) → core.manager_workspace` ON DELETE
 *     CASCADE: deleting a workspace deletes its data-model history;
 *   - `actor_user_id → core."user"` ON DELETE SET NULL: deleting (erasing) a user is never blocked by the log; the rows stay
 *     and lose only the actor id.
 *
 * What the log is (review #252): an ATTESTED record — who (the bound user), when (the insert time), which version (the
 * version this transaction created), written by the single change runner — NOT a tamper-proof or provably complete one.
 * The guard keeps normal code paths honest; it does not stop the table owner (see ACCESS below).
 *
 * Integrity (in the database, so no normal code path can skip it):
 *   - ENABLE + FORCE RLS, one tenant policy (USING = WITH CHECK on the bound organisation AND workspace), same text as the
 *     five M1 metadata tables; no tenant bound → zero rows;
 *   - insert-only on normal code paths: crewflow_app holds SELECT, INSERT and nothing else; while the guard trigger is
 *     enabled, `core.metadata_migration_guard()` refuses a direct UPDATE / DELETE (trigger depth 1) whoever issues it, a
 *     superuser's plain statement included. The two foreign-key actions above arrive at depth >= 2 and are the only changes
 *     it lets through: a cascade DELETE, and an UPDATE that sets actor_user_id to NULL and changes nothing else. TRUNCATE
 *     (which ignores RLS) is refused to the request path, allowed to crewflow / rab_secure_owner / a superuser (operators,
 *     test teardowns), the M1 rule;
 *   - an INSERT records only a change made in THIS transaction: `metadata_version` must be the workspace's current version
 *     and that version must have been bumped by this transaction (`last_bump_xact = pg_current_xact_id()`, the M1 trigger's
 *     own marker); with `previous_version >= 1 AND metadata_version = previous_version + 1` (CHECK) a log row can never
 *     invent, skip or repeat a version (UNIQUE (workspace_id, metadata_version) on top);
 *   - the actor is the BOUND user (`core.current_uid()`, the request's `rab.user_id`), never a value a writer chooses; a
 *     context with no user bound (a future job) records NULL. `created_at` is the insert time (clock_timestamp), never a
 *     value the writer supplies;
 *   - bounded content: change_kind from a closed list, actions a JSON array of at most 32 objects and 8 KiB, request_id at
 *     most 64 characters of [A-Za-z0-9._:-] (no control characters into logs), executor_version >= 1.
 *
 * RELEASE-2 DEPENDENCY (review #252): a workspace's first-ever metadata change (version 0 → 1, the transaction that creates
 * its `workspace_metadata_state` row) can never be logged — `previous_version >= 1` refuses it (23514). So the E2 standard
 * sync must have seeded every workspace (version >= 1) before the PR-8 change runner writes here; the runner's ready gate
 * (M2-PLAN §2.2 step 4) must check that and fail with a clear error otherwise. Pinned by an integration test.
 *
 * ACCESS: table and guard function owned by crewflow (handed over inside withCrewflowCoreCreate, like the M1 tables: no
 * LOGIN role owns a core object). The guard is SECURITY INVOKER with a pinned search_path and no EXECUTE for PUBLIC
 * (PostgreSQL does not check EXECUTE when it fires a trigger). In the owner-login build the guard trigger is the ONLY layer
 * between the table owner and the rows: the runtime login crewflow_owner inherits crewflow, the owner. BC-01 (accepted, as
 * for M1) — crewflow_owner (through crewflow) can bypass it by DISABLE TRIGGER, CREATE OR REPLACE of the guard function,
 * NO FORCE ROW LEVEL SECURITY / DROP POLICY, SET ROLE crewflow then TRUNCATE (the guard admits crewflow), a trigger of its
 * own that writes at depth 2, or DROP; a superuser additionally by `session_replication_role = replica` (ordinary triggers
 * do not fire). The guard and the grants protect normal code paths, not injected SQL running as the owner.
 */

export const METADATA_MIGRATION_TABLE = 'core.metadata_migration';
export const METADATA_MIGRATION_GUARD_FUNCTION = 'core.metadata_migration_guard()';

/**
 * The closed list of change kinds: one per data-model mutation of METADATA-API-CONTRACT §1.3 that M2 ships (option delete
 * is M3, Q5). A frozen literal on purpose: a merged migration's SQL must never change when a constant changes later.
 */
export const METADATA_MIGRATION_CHANGE_KINDS: readonly string[] = Object.freeze([
  'object.create',
  'object.update',
  'object.deactivate',
  'object.activate',
  'field.create',
  'field.update',
  'field.deactivate',
  'field.activate',
  'field.reorder',
  'option.create',
  'option.update',
  'index.create',
  'index.deactivate',
]);
export const METADATA_MIGRATION_ACTIONS_MAX_ITEMS = 32;
export const METADATA_MIGRATION_ACTIONS_MAX_BYTES = 8192;
export const METADATA_MIGRATION_REQUEST_ID_PATTERN = '^[A-Za-z0-9._:-]{1,64}$';

const TENANT_PREDICATE = 'organisation_id = core.current_org() AND workspace_id = core.current_workspace()';
const sqlList = (values: readonly string[]) => values.map((v) => `'${v}'`).join(', ');

export const METADATA_MIGRATION_TABLE_SQL = `CREATE TABLE core.metadata_migration (
  id                uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  organisation_id   uuid NOT NULL,
  workspace_id      uuid NOT NULL,
  previous_version  bigint NOT NULL,
  metadata_version  bigint NOT NULL,
  change_kind       text NOT NULL,
  actions           jsonb NOT NULL,
  actor_user_id     uuid,
  request_id        text,
  executor_version  integer NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT metadata_migration_pkey PRIMARY KEY (id),
  CONSTRAINT metadata_migration_version_step_ck CHECK (previous_version >= 1 AND metadata_version = previous_version + 1),
  CONSTRAINT metadata_migration_change_kind_ck CHECK (change_kind IN (${sqlList(METADATA_MIGRATION_CHANGE_KINDS)})),
  CONSTRAINT metadata_migration_actions_ck CHECK (
    pg_catalog.jsonb_typeof(actions) = 'array'
    AND pg_catalog.jsonb_array_length(actions) <= ${METADATA_MIGRATION_ACTIONS_MAX_ITEMS}
    AND pg_catalog.octet_length(actions::text) <= ${METADATA_MIGRATION_ACTIONS_MAX_BYTES}
    AND NOT pg_catalog.jsonb_path_exists(actions, 'strict $[*] ? (@.type() != "object")', '{}'::jsonb, true)
  ),
  CONSTRAINT metadata_migration_request_id_ck CHECK (request_id IS NULL OR request_id ~ '${METADATA_MIGRATION_REQUEST_ID_PATTERN}'),
  CONSTRAINT metadata_migration_executor_version_ck CHECK (executor_version >= 1),
  CONSTRAINT metadata_migration_version_uq UNIQUE (workspace_id, metadata_version),
  CONSTRAINT metadata_migration_workspace_fkey FOREIGN KEY (workspace_id, organisation_id)
    REFERENCES core.manager_workspace (id, organisation_id) ON DELETE CASCADE,
  CONSTRAINT metadata_migration_actor_fkey FOREIGN KEY (actor_user_id)
    REFERENCES core."user" (id) ON DELETE SET NULL
)`;

export const METADATA_MIGRATION_GUARD_FUNCTION_SQL = `CREATE FUNCTION core.metadata_migration_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  -- Operators and test teardowns (crewflow, rab_secure_owner, a superuser) may TRUNCATE; the request path never does.
  v_privileged boolean := current_user IN ('crewflow'::name, 'rab_secure_owner'::name)
    OR coalesce((SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user), false);
BEGIN
  -- TRUNCATE ignores RLS: never from the request path (a workspace's rows leave through the foreign-key cascade).
  IF TG_OP = 'TRUNCATE' THEN
    IF NOT v_privileged THEN
      RAISE EXCEPTION 'core.metadata_migration is never truncated by the request path' USING ERRCODE = '42501';
    END IF;
    RETURN NULL;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- The actor is the bound user, never a value the writer picks (NULL only when no user is bound).
    IF NEW.actor_user_id IS DISTINCT FROM core.current_uid() THEN
      RAISE EXCEPTION 'metadata_migration.actor_user_id must be the bound user' USING ERRCODE = '42501';
    END IF;
    -- A row records only a change made in THIS transaction: the workspace's current version, bumped by this transaction.
    PERFORM 1 FROM core.workspace_metadata_state s
     WHERE s.workspace_id = NEW.workspace_id AND s.organisation_id = NEW.organisation_id
       AND s.metadata_version = NEW.metadata_version
       AND s.last_bump_xact = pg_catalog.pg_current_xact_id();
    IF NOT FOUND THEN
      RAISE EXCEPTION 'metadata_migration records only the version this transaction created' USING ERRCODE = '42501';
    END IF;
    NEW.created_at := pg_catalog.clock_timestamp();
    RETURN NEW;
  END IF;

  -- Insert-only while this trigger is enabled: a direct UPDATE or DELETE runs it at trigger depth 1 and is refused; the two
  -- foreign-key actions (workspace ON DELETE CASCADE, actor ON DELETE SET NULL) arrive at depth 2 or more.
  IF pg_catalog.pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'core.metadata_migration is insert-only' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  -- The only UPDATE ever applied: the actor's ON DELETE SET NULL, which changes nothing else.
  IF NEW.actor_user_id IS NOT NULL
     OR (pg_catalog.to_jsonb(NEW) - 'actor_user_id') IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - 'actor_user_id') THEN
    RAISE EXCEPTION 'core.metadata_migration rows change only by the actor foreign key setting actor_user_id to NULL' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$fn$`;

export const METADATA_MIGRATION_UP_SQL: readonly string[] = [
  METADATA_MIGRATION_TABLE_SQL,
  'CREATE INDEX metadata_migration_organisation_workspace_idx ON core.metadata_migration (organisation_id, workspace_id, created_at DESC)',
  // The actor foreign key's ON DELETE SET NULL looks rows up by actor: without this a user deletion scans the whole table.
  'CREATE INDEX metadata_migration_actor_idx ON core.metadata_migration (actor_user_id) WHERE actor_user_id IS NOT NULL',
  METADATA_MIGRATION_GUARD_FUNCTION_SQL,
  `REVOKE ALL ON FUNCTION ${METADATA_MIGRATION_GUARD_FUNCTION} FROM PUBLIC`,
  `CREATE TRIGGER metadata_migration_guard BEFORE INSERT OR UPDATE OR DELETE ON core.metadata_migration FOR EACH ROW EXECUTE FUNCTION ${METADATA_MIGRATION_GUARD_FUNCTION}`,
  `CREATE TRIGGER metadata_migration_truncate_guard BEFORE TRUNCATE ON core.metadata_migration FOR EACH STATEMENT EXECUTE FUNCTION ${METADATA_MIGRATION_GUARD_FUNCTION}`,
  'ALTER TABLE core.metadata_migration ENABLE ROW LEVEL SECURITY',
  'ALTER TABLE core.metadata_migration FORCE ROW LEVEL SECURITY',
  `CREATE POLICY metadata_migration_tenant ON core.metadata_migration AS PERMISSIVE FOR ALL TO PUBLIC
  USING (${TENANT_PREDICATE})
  WITH CHECK (${TENANT_PREDICATE})`,
  'REVOKE ALL ON TABLE core.metadata_migration FROM PUBLIC',
  'GRANT SELECT, INSERT ON TABLE core.metadata_migration TO crewflow_app',
];

/** Run inside withCrewflowCoreCreate after METADATA_MIGRATION_UP_SQL: no LOGIN role may own a core object. */
export const METADATA_MIGRATION_OWNERSHIP_SQL: readonly string[] = [
  'ALTER TABLE core.metadata_migration OWNER TO crewflow',
  `ALTER FUNCTION ${METADATA_MIGRATION_GUARD_FUNCTION} OWNER TO crewflow`,
];

/**
 * down() refuses while any row exists. A migration binds no tenant, so under FORCE RLS a plain count would see zero rows and
 * down() would drop real history. The count therefore runs after NO FORCE inside down()'s own transaction (the migration
 * identity acts as the owner crewflow, so the owner exemption applies); a refusal rolls the whole transaction back, FORCE
 * included. Same pattern as MetadataEngineTables1786721550000.
 */
export const METADATA_MIGRATION_DOWN_UNFORCE_SQL = 'ALTER TABLE core.metadata_migration NO FORCE ROW LEVEL SECURITY';
export const METADATA_MIGRATION_ROWS_SQL = 'SELECT pg_catalog.count(*)::int AS n FROM core.metadata_migration';

export const METADATA_MIGRATION_DOWN_SQL: readonly string[] = [
  'DROP TABLE core.metadata_migration',
  `DROP FUNCTION ${METADATA_MIGRATION_GUARD_FUNCTION}`,
];

export const METADATA_MIGRATION_GONE_SQL = `SELECT
  pg_catalog.to_regclass('core.metadata_migration') IS NULL
  AND pg_catalog.to_regprocedure('core.metadata_migration_guard()') IS NULL AS gone`;

/**
 * Preflight: an identity that can act as crewflow AND rab_secure_owner (withCrewflowCoreCreate + the hand-over), Phase 0b
 * applied (core owned by rab_secure_owner), the roles, the FK targets, the tenant functions and the M1 version table
 * present, PostgreSQL 16+, and whether the table already exists.
 */
export const METADATA_MIGRATION_PREFLIGHT_SQL = `
SELECT current_user::text AS who,
       r.rolsuper AS su,
       pg_catalog.pg_has_role(current_user, 'rab_secure_owner'::name, 'USAGE') AS can_act_secure,
       pg_catalog.pg_has_role(current_user, 'crewflow'::name, 'USAGE') AS can_act_crewflow,
       (SELECT pg_catalog.count(*) FROM pg_catalog.pg_roles x WHERE x.rolname IN ('crewflow', 'crewflow_app'))::int AS roles,
       (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'core')::text AS core_owner,
       (pg_catalog.to_regprocedure('core.current_org()') IS NOT NULL AND pg_catalog.to_regprocedure('core.current_workspace()') IS NOT NULL
        AND pg_catalog.to_regprocedure('core.current_uid()') IS NOT NULL) AS tenant_functions,
       (pg_catalog.to_regclass('core.manager_workspace') IS NOT NULL AND pg_catalog.to_regclass('core."user"') IS NOT NULL) AS fk_targets,
       (pg_catalog.to_regclass('core.workspace_metadata_state') IS NOT NULL) AS version_state,
       (pg_catalog.current_setting('server_version_num')::int >= 160000) AS pg16_or_later,
       (pg_catalog.to_regclass('core.metadata_migration') IS NOT NULL) AS table_present,
       (pg_catalog.to_regprocedure('core.metadata_migration_guard()') IS NOT NULL) AS guard_present
  FROM pg_catalog.pg_roles r WHERE r.rolname = current_user`;

/** Post-condition: compared exactly with METADATA_MIGRATION_EXPECTED_STATE. */
export const METADATA_MIGRATION_STATE_SQL = `
SELECT pg_catalog.pg_get_userbyid(c.relowner)::text AS owner,
       c.relrowsecurity AS rls,
       c.relforcerowsecurity AS force,
       (SELECT pg_catalog.string_agg(x.v, ',' ORDER BY x.v) FROM (
          SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END
                 || ':' || a.privilege_type || ':' || a.is_grantable::text AS v
            FROM pg_catalog.aclexplode(c.relacl) a
           WHERE a.grantee <> c.relowner) x) AS acl,
       (SELECT pg_catalog.count(*) FROM pg_catalog.pg_attribute a
         WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL)::int AS column_acls,
       (SELECT pg_catalog.string_agg(p.polname || ':' || p.polcmd::text || ':' || p.polpermissive::text || ':' || p.polroles::text
                                     || ':' || (pg_catalog.pg_get_expr(p.polqual, p.polrelid) = pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid))::text,
                                     ';' ORDER BY p.polname)
          FROM pg_catalog.pg_policy p WHERE p.polrelid = c.oid) AS policies,
       (SELECT pg_catalog.string_agg(t.tgname || ':' || t.tgenabled::text || ':' || t.tgtype::text || ':' || t.tgfoid::regprocedure::text, ';' ORDER BY t.tgname)
          FROM pg_catalog.pg_trigger t WHERE t.tgrelid = c.oid AND NOT t.tgisinternal) AS triggers,
       (SELECT pg_catalog.string_agg(k.conname || ':' || k.confrelid::regclass::text || ':' || k.confdeltype::text, ';' ORDER BY k.conname)
          FROM pg_catalog.pg_constraint k WHERE k.conrelid = c.oid AND k.contype = 'f') AS foreign_keys,
       (SELECT pg_catalog.count(*) FROM pg_catalog.pg_attribute a
         WHERE a.attrelid = c.oid AND a.attname IN ('organisation_id', 'workspace_id') AND a.attnotnull AND NOT a.attisdropped)::int AS tenant_columns,
       (SELECT pg_catalog.count(*) FROM pg_catalog.pg_rewrite w WHERE w.ev_class = c.oid)::int AS rules,
       (SELECT pg_catalog.pg_get_userbyid(p.proowner) || ':' || p.prosecdef::text || ':' || pg_catalog.array_to_string(p.proconfig, ';')
               || ':' || pg_catalog.has_function_privilege('crewflow_app', p.oid, 'EXECUTE')::text
               || ':' || (p.proacl IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_catalog.aclexplode(p.proacl) x WHERE x.grantee = 0))::text
          FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure('core.metadata_migration_guard()')) AS guard
  FROM pg_catalog.pg_class c
 WHERE c.oid = pg_catalog.to_regclass('core.metadata_migration')`;

/**
 * `tgtype` 31 = ROW (1) + BEFORE (2) + INSERT (4) + DELETE (8) + UPDATE (16); 34 = STATEMENT (0) + BEFORE (2) + TRUNCATE
 * (32). `confdeltype` c = CASCADE, n = SET NULL. Guard: owner crewflow, SECURITY INVOKER, pinned search_path, no EXECUTE
 * for crewflow_app, PUBLIC revoked.
 */
export const METADATA_MIGRATION_EXPECTED_STATE: Readonly<Record<string, unknown>> = Object.freeze({
  owner: 'crewflow',
  rls: true,
  force: true,
  acl: ['crewflow_app:INSERT:false', 'crewflow_app:SELECT:false'].join(','),
  column_acls: 0,
  policies: 'metadata_migration_tenant:*:true:{0}:true',
  triggers: [
    `metadata_migration_guard:O:31:${METADATA_MIGRATION_GUARD_FUNCTION}`,
    `metadata_migration_truncate_guard:O:34:${METADATA_MIGRATION_GUARD_FUNCTION}`,
  ].join(';'),
  foreign_keys: ['metadata_migration_actor_fkey:core."user":n', 'metadata_migration_workspace_fkey:core.manager_workspace:c'].join(';'),
  tenant_columns: 2,
  rules: 0,
  guard: 'crewflow:false:search_path=pg_catalog, pg_temp:false:true',
});

export function metadataMigrationStateProblems(state: Record<string, unknown> | undefined): string[] {
  if (!state) return ['core.metadata_migration: missing'];
  return Object.entries(METADATA_MIGRATION_EXPECTED_STATE)
    .filter(([key, want]) => String(state[key]) !== String(want))
    .map(([key, want]) => `${key}: expected ${JSON.stringify(want)}, found ${JSON.stringify(state[key])}`);
}
