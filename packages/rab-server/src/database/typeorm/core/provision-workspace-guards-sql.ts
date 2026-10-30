import { EXPECTED_WORKSPACE_FINGERPRINTS } from '../workspace-schema/v1/expected-fingerprints';
import { ProvisionLedgerModule, provisionWorkspaceFunctionV2Sql } from '../workspace-schema/v1/provision-workspace-function-v2';
import { composeServerPathTemplateV1VenueTeamAdmin } from '../workspace-schema/v1/server-path-template-venue-team-admin';
import { moduleChecksum, modulesThrough } from '../workspace-schema/workspace-schema-modules';

/**
 * SQL of migration ProvisionWorkspaceGuards1786721210000 (core/migrations/) — Phase B P8 (E6 gates 3, 4 and 8). Owner
 * decision B (2026-10-29): approved for disposable databases (rendered in scratchpad/phaseB/a6/ProvisionWorkspaceGuards1786721210000.sql).
 *
 * `core.provision_workspace(uuid)` v3 = the v2 body exactly as VenueTeamOrgAdmin1786721090000 created it (module v18
 * composition, ledger rows, frozen v18 fingerprint) plus three insertions, nothing else:
 *   1. E6 gate 8 — ONE advisory-lock keyspace shared with the worker provisioner: before its per-workspace lock the function
 *      takes a SHARED transaction lock on the very key the worker provisioner's cycle holds EXCLUSIVELY as a session lock
 *      (`pg_try_advisory_lock(hashtext('rab_workspace_provisioning'))`, workspace-provisioning.job.ts). hashtext() is int4;
 *      both sides widen it to the same bigint key, so the two paths now exclude each other: API calls never block each other
 *      (shared + shared), an API call waits while a worker cycle runs (bounded by the function's own lock_timeout 30s →
 *      SQLSTATE 55P03 → DEFERRED, the owner's retry resumes), and the worker's non-blocking try-lock skips its tick while
 *      any API provisioning is in flight. The per-workspace lock is unchanged. No deadlock: the API transaction holds no
 *      row lock when it reaches this statement, and the worker never blocks on an advisory lock.
 *   2. E6 gate 3 / inv-security F3 — the caller's organisation must not be suspended (read as crewflow under the
 *      organisation RLS with the bound GUCs; not visible counts as suspended): SQLSTATE CWP01.
 *   3. E6 gate 4 / F3 — the caller's account (the workspace owner, already proven equal to the bound user) must have
 *      `status = 'active'`: SQLSTATE CWP02.
 *   2 and 3 run AFTER the existing ownership check, so a foreign or unknown id is still P0002 (404) and never discloses a
 *   suspension. WorkspaceProvisioningService maps CWP01/CWP02 to the same 403s as its own layer-2 check.
 * Deliberately NOT added — an in-function rate guard: `manager_workspace` / `workspace_schema_registry` carry no
 * last-attempt timestamp (a FAILED attempt rolls everything back except the FAILED marker), so spacing retries in the
 * database needs a new column and changes to the frozen lifecycle functions — a separate reviewed change. Retries are bounded
 * by the per-route throttle on POST /manager-workspaces (WORKSPACE_CREATE_THROTTLE) and serialised per workspace here.
 *
 * Owner, SECURITY DEFINER, `search_path = pg_catalog, pg_temp`, `lock_timeout = '30s'` and the ACL (EXECUTE crewflow +
 * crewflow_app, never PUBLIC) are unchanged: CREATE OR REPLACE keeps them, and the migration re-verifies them.
 */

export const GUARDS_THROUGH_VERSION = 18;
export const GUARDS_MIGRATION_NAME = 'ProvisionWorkspaceGuards1786721210000';
/** The function body this draft replaces (and down() restores), identified by its frozen app_version literal. */
export const PREVIOUS_PROVISION_APP_VERSION = 'db:provision_workspace@VenueTeamOrgAdmin1786721090000';
export const GUARDS_PROVISION_APP_VERSION = `db:provision_workspace@${GUARDS_MIGRATION_NAME}`;

export const SHARED_PROVISIONING_LOCK_SQL =
  "      PERFORM pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtext('rab_workspace_provisioning')::bigint);\n";

const LOCK_ANCHOR =
  "      PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('rab_workspace_provisioning'), pg_catalog.hashtext(p_workspace_id::text));\n";
const ACTIVE_ANCHOR = `      IF v_ws_status IS DISTINCT FROM 'active' THEN
        RAISE EXCEPTION 'workspace is not active' USING ERRCODE = '55000';
      END IF;
`;

const LOCK_INSERT = `      -- Phase B P8 (E6 gate 8): one advisory-lock keyspace with the worker provisioner, which holds this key EXCLUSIVELY
      -- for a whole provisioning cycle. Shared here: API calls never block each other; an API call and a worker cycle
      -- never build at the same time.
${SHARED_PROVISIONING_LOCK_SQL}`;

const CALLER_STATE_INSERT = `
      -- Phase B P8 (E6 gates 3-4, five-layer rule): a suspended organisation or an account that is not active never
      -- provisions, whoever calls. After the ownership check above, so a foreign id is still 'not found'.
      IF NOT EXISTS (SELECT 1 FROM core.organisation o WHERE o.id = v_org AND o.suspended_at IS NULL) THEN
        RAISE EXCEPTION 'organisation is suspended' USING ERRCODE = 'CWP01';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM core."user" u WHERE u.id = v_owner AND u.status = 'active') THEN
        RAISE EXCEPTION 'account is not active' USING ERRCODE = 'CWP02';
      END IF;
`;

/** v3 = v2 + the three insertions above. Refuses unless each anchor occurs exactly once (never a silent no-op). */
export function provisionWorkspaceFunctionV3Sql(
  template: string,
  modules: readonly ProvisionLedgerModule[],
  expectedFingerprint: string,
  appVersion: string,
): string {
  const v2 = provisionWorkspaceFunctionV2Sql(template, 'CREATE OR REPLACE', modules, expectedFingerprint, appVersion);
  for (const anchor of [LOCK_ANCHOR, ACTIVE_ANCHOR]) {
    if (v2.split(anchor).length !== 2) throw new Error('provision_workspace v2 anchor not found exactly once; refusing to compose v3');
  }
  return v2.replace(LOCK_ANCHOR, LOCK_INSERT + LOCK_ANCHOR).replace(ACTIVE_ANCHOR, ACTIVE_ANCHOR + CALLER_STATE_INSERT);
}

function v18Modules(): ProvisionLedgerModule[] {
  return modulesThrough(GUARDS_THROUGH_VERSION).map((m) => ({ id: m.id, version: m.version, checksum: moduleChecksum(m) }));
}

function v18Fingerprint(): string {
  const fp = EXPECTED_WORKSPACE_FINGERPRINTS[GUARDS_THROUGH_VERSION];
  if (!fp) throw new Error(`no expected fingerprint for module version ${GUARDS_THROUGH_VERSION}`);
  return fp;
}

/** up(): the guarded v3 body over the UNCHANGED module-v18 composition. */
export function provisionWorkspaceGuardsUpSql(): string {
  return provisionWorkspaceFunctionV3Sql(composeServerPathTemplateV1VenueTeamAdmin(), v18Modules(), v18Fingerprint(), GUARDS_PROVISION_APP_VERSION);
}

/** down(): byte-for-byte the statement VenueTeamOrgAdmin1786721090000 ran (same composition, same app_version). */
export function provisionWorkspaceGuardsDownSql(): string {
  return provisionWorkspaceFunctionV2Sql(composeServerPathTemplateV1VenueTeamAdmin(), 'CREATE OR REPLACE', v18Modules(), v18Fingerprint(), PREVIOUS_PROVISION_APP_VERSION);
}

/** One row describing core.provision_workspace(uuid): privilege shape + which body is installed. Read-only catalog query. */
export const PROVISION_WORKSPACE_STATE_SQL = `
SELECT pg_catalog.pg_get_userbyid(p.proowner) AS owner,
       p.prosecdef AS definer,
       'search_path=pg_catalog, pg_temp' = ANY (coalesce(p.proconfig, ARRAY[]::text[])) AS path_ok,
       'lock_timeout=30s' = ANY (coalesce(p.proconfig, ARRAY[]::text[])) AS lock_timeout_ok,
       coalesce((SELECT pg_catalog.string_agg(x.g, ',' ORDER BY x.g)
                   FROM (SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END AS g
                           FROM pg_catalog.aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE') x), '') AS executors,
       pg_catalog.strpos(p.prosrc, '${PREVIOUS_PROVISION_APP_VERSION}') > 0 AS is_previous_body,
       pg_catalog.strpos(p.prosrc, '${GUARDS_PROVISION_APP_VERSION}') > 0 AS is_guarded_body,
       pg_catalog.strpos(p.prosrc, 'CWP01') > 0 AND pg_catalog.strpos(p.prosrc, 'CWP02') > 0
         AND pg_catalog.strpos(p.prosrc, 'pg_advisory_xact_lock_shared') > 0 AS has_guards
  FROM pg_catalog.pg_proc p
 WHERE p.oid = 'core.provision_workspace(uuid)'::pg_catalog.regprocedure`;

export const PROVISION_WORKSPACE_PRIVILEGE_SHAPE = {
  owner: 'crewflow',
  definer: true,
  path_ok: true,
  lock_timeout_ok: true,
  executors: 'crewflow,crewflow_app',
} as const;
