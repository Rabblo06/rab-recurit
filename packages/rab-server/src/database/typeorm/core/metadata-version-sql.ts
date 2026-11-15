// sql-injection-reviewed-file: SQL definition / check module (database layer). Every interpolation is a code constant of this repository (table, trigger, function and role names); no request or row data reaches these templates. Reviewed 2026-11-15 (metadata engine M1 E5, DRAFT for owner SQL review).
/**
 * Metadata engine M1 / E5 (OWNER-METADATA-ENGINE.md §1 E5; DRAFT — owner SQL review FIRST, run only on throwaway databases
 * until approved): the metadata version authority of the per-workspace metadata cache. SQL of migration
 * MetadataVersionState1786721560000, kept as data so the exact statements can be reviewed, scanned and unit-tested.
 * Review text: docs/plans/phase-x4/M1-SQL-FOR-OWNER.md § M1-cache.
 *
 * `core.workspace_metadata_state.metadata_version` is what the cache (engine/metadata/cache) keys every entry on. It must
 *   1. move in the SAME transaction as every change to the cached metadata tables — enforced by an AFTER ROW trigger on the
 *      five E1 tables (`core.metadata_version_bump()`), so no code path (service, E2 sync, M2 executor, psql) can forget it;
 *   2. move at most ONCE per transaction and workspace (`last_bump_xact` = the top-level transaction id; savepoint-safe,
 *      and the E2 runner's per-table write counts rely on "each row at most once per transaction");
 *   3. never go backwards, and the row be written ONLY by that trigger (INSERT at 1, UPDATE by exactly +1) or removed only
 *      by the workspace FK cascade (`core.workspace_metadata_state_guard()`, which refuses any direct statement). The cache identity also carries the bump time (`updated_at`), so even a
 *      row that is recreated (TRUNCATE by an operator or a test fixture, a restored backup) gets a new identity and can
 *      never make an old cached entry current again — which is why TRUNCATE is not trigger-guarded (an existing
 *      disposable-database fixture runs `TRUNCATE core.organisation CASCADE`).
 *
 * Twenty bumps the version AFTER commit, read-then-write on another connection (twentyhq/twenty @ eedb0a73
 * `packages/twenty-server/src/engine/metadata-modules/workspace-metadata-version/services/workspace-metadata-version.service.ts:25-58`),
 * which leaves a window where committed metadata and the published version disagree and lets a crash between the two lose
 * the bump. Behaviour re-implemented, never copied (AGPL); the in-transaction trigger is the deliberate difference.
 *
 * ACCESS: table and functions owned by crewflow (handed over inside withCrewflowCoreCreate, like the E1 tables);
 * crewflow_app holds SELECT, INSERT, UPDATE (no DELETE: the workspace FK cascade runs as the table owner); nothing for
 * PUBLIC. ENABLE + FORCE RLS with the tenant policy, same predicate as the E1 tables. Both functions are SECURITY INVOKER:
 * the bump runs under the caller's tenant policy, so for a normal write it can only touch the caller's own workspace row
 * (the metadata row it reacts to has already passed the same WITH CHECK). FK cascades run as the table owner without
 * row security; the bump then only addresses OLD.workspace_id of the row being cascaded. A future rab_secure_owner
 * SECURITY DEFINER writing E1 rows would get "permission denied" from the bump (no grant): fails closed, by design until
 * such a definer is reviewed. BC-01 (accepted): crewflow_owner can, through crewflow,
 * DISABLE TRIGGER or DROP these; the triggers guard normal code paths, not injected SQL.
 */

/** The five cached E1 tables (MetadataEngineTables1786721550000) that bump the version. */
export const METADATA_VERSIONED_TABLES = ['object_metadata', 'field_metadata', 'field_metadata_option', 'index_metadata', 'index_field_metadata'] as const;

export const METADATA_VERSION_BUMP_FUNCTION = 'core.metadata_version_bump()';
export const METADATA_STATE_GUARD_FUNCTION = 'core.workspace_metadata_state_guard()';
const TENANT_PREDICATE = 'organisation_id = core.current_org() AND workspace_id = core.current_workspace()';

export const METADATA_STATE_TABLE_SQL = `CREATE TABLE core.workspace_metadata_state (
  workspace_id      uuid PRIMARY KEY,
  organisation_id   uuid NOT NULL,
  metadata_version  bigint NOT NULL DEFAULT 1,
  last_bump_xact    xid8,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspace_metadata_state_version_ck CHECK (metadata_version >= 1),
  CONSTRAINT workspace_metadata_state_workspace_fkey FOREIGN KEY (workspace_id, organisation_id)
    REFERENCES core.manager_workspace (id, organisation_id) ON DELETE CASCADE
)`;

export const METADATA_VERSION_BUMP_FUNCTION_SQL = `CREATE FUNCTION core.metadata_version_bump()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_workspace uuid;
  v_organisation uuid;
  v_xact xid8 := pg_catalog.pg_current_xact_id();
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_workspace := OLD.workspace_id;
    v_organisation := OLD.organisation_id;
  ELSE
    IF TG_OP = 'UPDATE' AND (NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id) THEN
      RAISE EXCEPTION 'metadata rows never move between workspaces' USING ERRCODE = '42501';
    END IF;
    v_workspace := NEW.workspace_id;
    v_organisation := NEW.organisation_id;
  END IF;

  -- First change of this transaction for this workspace: one step. Later changes in the same transaction match nothing.
  UPDATE core.workspace_metadata_state s
     SET metadata_version = s.metadata_version + 1, last_bump_xact = v_xact, updated_at = pg_catalog.now()
   WHERE s.workspace_id = v_workspace AND s.organisation_id = v_organisation AND s.last_bump_xact IS DISTINCT FROM v_xact;
  IF FOUND THEN
    RETURN NULL;
  END IF;
  -- A DELETE never creates the row: a workspace being deleted cascades its metadata, and re-inserting its version row
  -- would fail the foreign key and block the deletion. Without a row the cache reads through uncached.
  IF TG_OP = 'DELETE' THEN
    RETURN NULL;
  END IF;
  -- Already bumped by this transaction?
  PERFORM 1 FROM core.workspace_metadata_state s WHERE s.workspace_id = v_workspace AND s.organisation_id = v_organisation;
  IF FOUND THEN
    RETURN NULL;
  END IF;
  -- First metadata of this workspace.
  INSERT INTO core.workspace_metadata_state (workspace_id, organisation_id, metadata_version, last_bump_xact)
  VALUES (v_workspace, v_organisation, 1, v_xact)
  ON CONFLICT (workspace_id) DO NOTHING;
  IF FOUND THEN
    RETURN NULL;
  END IF;
  -- A concurrent transaction created it and committed while we waited on the key: step on top of its version.
  UPDATE core.workspace_metadata_state s
     SET metadata_version = s.metadata_version + 1, last_bump_xact = v_xact, updated_at = pg_catalog.now()
   WHERE s.workspace_id = v_workspace AND s.organisation_id = v_organisation AND s.last_bump_xact IS DISTINCT FROM v_xact;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'metadata version row is not visible to this transaction' USING ERRCODE = '42501';
  END IF;
  RETURN NULL;
END
$fn$`;

export const METADATA_STATE_GUARD_FUNCTION_SQL = `CREATE FUNCTION core.workspace_metadata_state_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  -- Every legitimate write arrives from inside another trigger (depth >= 2): INSERT / UPDATE only from
  -- core.metadata_version_bump(), DELETE only from the workspace FK cascade. A direct statement runs this guard at depth 1
  -- and is refused, so a caller holding the table grants (crewflow_app, or crewflow_owner through crewflow) cannot suppress
  -- a bump (pre-setting last_bump_xact), jump the version, or re-insert a pre-restore (version, stamp). Operator repair:
  -- DISABLE TRIGGER as the owner (BC-01 class, visible in the posture goldens).
  IF pg_catalog.pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'core.workspace_metadata_state is written only by the metadata version trigger' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.metadata_version <> 1 THEN
      RAISE EXCEPTION 'a metadata version row starts at 1' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id THEN
    RAISE EXCEPTION 'workspace_metadata_state identity is immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.metadata_version <> OLD.metadata_version + 1 THEN
    RAISE EXCEPTION 'metadata_version moves by exactly one step' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$fn$`;

export const METADATA_VERSION_UP_SQL: readonly string[] = [
  METADATA_STATE_TABLE_SQL,
  'CREATE INDEX workspace_metadata_state_organisation_workspace_idx ON core.workspace_metadata_state (organisation_id, workspace_id)',
  METADATA_STATE_GUARD_FUNCTION_SQL,
  `REVOKE ALL ON FUNCTION ${METADATA_STATE_GUARD_FUNCTION} FROM PUBLIC`,
  `CREATE TRIGGER workspace_metadata_state_guard BEFORE INSERT OR UPDATE OR DELETE ON core.workspace_metadata_state FOR EACH ROW EXECUTE FUNCTION ${METADATA_STATE_GUARD_FUNCTION}`,
  'ALTER TABLE core.workspace_metadata_state ENABLE ROW LEVEL SECURITY',
  'ALTER TABLE core.workspace_metadata_state FORCE ROW LEVEL SECURITY',
  `CREATE POLICY workspace_metadata_state_tenant ON core.workspace_metadata_state AS PERMISSIVE FOR ALL TO PUBLIC
  USING (${TENANT_PREDICATE})
  WITH CHECK (${TENANT_PREDICATE})`,
  'REVOKE ALL ON TABLE core.workspace_metadata_state FROM PUBLIC',
  'GRANT SELECT, INSERT, UPDATE ON TABLE core.workspace_metadata_state TO crewflow_app',
  METADATA_VERSION_BUMP_FUNCTION_SQL,
  `REVOKE ALL ON FUNCTION ${METADATA_VERSION_BUMP_FUNCTION} FROM PUBLIC`,
  ...METADATA_VERSIONED_TABLES.map(
    (t) => `CREATE TRIGGER ${t}_version_bump AFTER INSERT OR UPDATE OR DELETE ON core.${t} FOR EACH ROW EXECUTE FUNCTION ${METADATA_VERSION_BUMP_FUNCTION}`,
  ),
];

/** Run inside withCrewflowCoreCreate after METADATA_VERSION_UP_SQL: no LOGIN role may own a core object. */
export const METADATA_VERSION_OWNERSHIP_SQL: readonly string[] = [
  'ALTER TABLE core.workspace_metadata_state OWNER TO crewflow',
  `ALTER FUNCTION ${METADATA_STATE_GUARD_FUNCTION} OWNER TO crewflow`,
  `ALTER FUNCTION ${METADATA_VERSION_BUMP_FUNCTION} OWNER TO crewflow`,
];

export const METADATA_VERSION_DOWN_SQL: readonly string[] = [
  ...METADATA_VERSIONED_TABLES.map((t) => `DROP TRIGGER ${t}_version_bump ON core.${t}`),
  `DROP FUNCTION ${METADATA_VERSION_BUMP_FUNCTION}`,
  'DROP TABLE core.workspace_metadata_state',
  `DROP FUNCTION ${METADATA_STATE_GUARD_FUNCTION}`,
];

/**
 * Preflight: the identity can act as crewflow and rab_secure_owner (the hand-over), Phase 0b applied, the roles, the E1
 * tables and the tenant functions present, PostgreSQL 16+ (pg_current_xact_id / xid8 need 13+), and whether the state
 * table already exists.
 */
export const METADATA_VERSION_PREFLIGHT_SQL = `
SELECT current_user::text AS who,
       r.rolsuper AS su,
       pg_catalog.pg_has_role(current_user, 'rab_secure_owner'::name, 'USAGE') AS can_act_secure,
       pg_catalog.pg_has_role(current_user, 'crewflow'::name, 'USAGE') AS can_act_crewflow,
       (SELECT pg_catalog.count(*) FROM pg_catalog.pg_roles x WHERE x.rolname IN ('crewflow', 'crewflow_app'))::int AS roles,
       (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'core')::text AS core_owner,
       (pg_catalog.to_regprocedure('core.current_org()') IS NOT NULL AND pg_catalog.to_regprocedure('core.current_workspace()') IS NOT NULL) AS tenant_functions,
       (pg_catalog.current_setting('server_version_num')::int >= 160000) AS pg16_or_later,
       (SELECT pg_catalog.count(*) FROM pg_catalog.unnest(ARRAY['object_metadata', 'field_metadata', 'field_metadata_option', 'index_metadata', 'index_field_metadata']) t(n)
         WHERE pg_catalog.to_regclass('core.' || t.n) IS NOT NULL)::int AS versioned_tables,
       (pg_catalog.to_regclass('core.workspace_metadata_state') IS NOT NULL) AS state_present
  FROM pg_catalog.pg_roles r WHERE r.rolname = current_user`;

/** Post-condition: compared exactly with METADATA_VERSION_EXPECTED_STATE. */
export const METADATA_VERSION_STATE_SQL = `
SELECT pg_catalog.pg_get_userbyid(c.relowner)::text AS owner,
       c.relrowsecurity AS rls,
       c.relforcerowsecurity AS force,
       (SELECT pg_catalog.string_agg(x.v, ',' ORDER BY x.v) FROM (
          SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END
                 || ':' || a.privilege_type || ':' || a.is_grantable::text AS v
            FROM pg_catalog.aclexplode(c.relacl) a
           WHERE a.grantee <> c.relowner) x) AS acl,
       (SELECT pg_catalog.string_agg(p.polname || ':' || p.polcmd::text || ':' || p.polpermissive::text || ':' || p.polroles::text
                                     || ':' || (pg_catalog.pg_get_expr(p.polqual, p.polrelid) = pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid))::text,
                                     ';' ORDER BY p.polname)
          FROM pg_catalog.pg_policy p WHERE p.polrelid = c.oid) AS policies,
       (SELECT pg_catalog.string_agg(t.tgname || ':' || t.tgenabled::text || ':' || t.tgfoid::regprocedure::text, ';' ORDER BY t.tgname)
          FROM pg_catalog.pg_trigger t WHERE t.tgrelid = c.oid AND NOT t.tgisinternal) AS triggers,
       (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger t
         WHERE NOT t.tgisinternal AND t.tgenabled = 'O' AND t.tgname LIKE '%\\_version\\_bump'
           AND t.tgfoid = pg_catalog.to_regprocedure('core.metadata_version_bump()')
           AND t.tgrelid = ANY (ARRAY['core.object_metadata', 'core.field_metadata', 'core.field_metadata_option', 'core.index_metadata', 'core.index_field_metadata']::regclass[])
           AND t.tgtype = 29)::int AS bump_triggers,
       (SELECT pg_catalog.string_agg(pg_catalog.pg_get_userbyid(p.proowner) || ':' || p.prosecdef::text || ':' || pg_catalog.array_to_string(p.proconfig, ';')
                                     || ':' || pg_catalog.has_function_privilege('crewflow_app', p.oid, 'EXECUTE')::text, ',' ORDER BY p.proname)
          FROM pg_catalog.pg_proc p
         WHERE p.oid IN (pg_catalog.to_regprocedure('core.metadata_version_bump()'), pg_catalog.to_regprocedure('core.workspace_metadata_state_guard()'))) AS functions
  FROM pg_catalog.pg_class c
 WHERE c.oid = pg_catalog.to_regclass('core.workspace_metadata_state')`;

/**
 * `tgtype` 29 = ROW (1) + INSERT (4) + DELETE (8) + UPDATE (16), AFTER (no BEFORE bit). Five bump triggers, one per table.
 * Functions sorted by name: metadata_version_bump, workspace_metadata_state_guard.
 */
export const METADATA_VERSION_EXPECTED_STATE: Readonly<Record<string, unknown>> = Object.freeze({
  owner: 'crewflow',
  rls: true,
  force: true,
  acl: ['crewflow_app:INSERT:false', 'crewflow_app:SELECT:false', 'crewflow_app:UPDATE:false'].join(','),
  policies: 'workspace_metadata_state_tenant:*:true:{0}:true',
  triggers: `workspace_metadata_state_guard:O:${METADATA_STATE_GUARD_FUNCTION}`,
  bump_triggers: 5,
  functions: ['crewflow:false:search_path=pg_catalog, pg_temp:false', 'crewflow:false:search_path=pg_catalog, pg_temp:false'].join(','),
});

export function metadataVersionStateProblems(state: Record<string, unknown> | undefined): string[] {
  if (!state) return ['core.workspace_metadata_state: missing'];
  return Object.entries(METADATA_VERSION_EXPECTED_STATE)
    .filter(([key, want]) => String(state[key]) !== String(want))
    .map(([key, want]) => `${key}: expected ${JSON.stringify(want)}, found ${JSON.stringify(state[key])}`);
}

export const METADATA_VERSION_GONE_SQL = `SELECT
  pg_catalog.to_regclass('core.workspace_metadata_state') IS NULL
  AND pg_catalog.to_regprocedure('core.metadata_version_bump()') IS NULL
  AND pg_catalog.to_regprocedure('core.workspace_metadata_state_guard()') IS NULL AS gone`;
