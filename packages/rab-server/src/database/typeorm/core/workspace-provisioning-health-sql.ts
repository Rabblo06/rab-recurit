/**
 * SQL of migration ProvisioningHealth1786721220000 — Phase B P8 (E6 gates 10 and 14). Owner decision C (2026-10-29):
 * APPROVED for the counts-only health definer ONLY. The status-only drift wrapper `core.worker_record_workspace_schema_drift`
 * drafted alongside it is DEFERRED (an HWS prerequisite, parked outside the build) and is not created here.
 *
 *   core.worker_workspace_provisioning_health()  -> (creating_over_10_min integer, failed integer)
 *     COUNTS ONLY: no workspace id, organisation, name, subdomain, e-mail or error text ever leaves the function.
 *     `manager_workspace` is ENABLE + NOT FORCE and owned by rab_secure_owner, so this rab_secure_owner-owned definer counts
 *     across organisations (crewflow_app alone sees zero rows without a tenant context — fail closed). Active workspaces
 *     only; NULL (legacy, core-routed), READY, MIGRATING and SUPERSEDED rows are never counted. Age uses `created_at`
 *     (`updated_at` is not maintained by the raw-SQL lifecycle functions). Same owner / search_path / grant shape as the
 *     other worker_* definers (golden: worker_list_workspaces, worker_claim_due_work); body names only pg_catalog
 *     built-ins and the rab_secure_owner-owned `core.manager_workspace`, so the Phase 0b reachability invariant and the
 *     frozen R4 list are unchanged.
 *
 * WHY A CROSS-ORGANISATION COUNT IS ACCEPTABLE HERE (justification for the independent review):
 *   - Purpose: the daily stuck-workspace alert of the ORDINARY Worker, which runs with no tenant context. Its only question
 *     is "is any workspace stuck, platform-wide?" — an operator page, not a tenant feature. A per-organisation variant
 *     would need the Worker to enumerate organisations and bind each one (N queries, and a list of every organisation id in
 *     the Worker's hands) to compute the same two numbers; it discloses more, not less.
 *   - Output: exactly two integers. No identifier, name, subdomain, e-mail, error text, timestamp or per-organisation
 *     breakdown can be returned: the RETURNS TABLE has no other column and the body has no parameter, so no caller input
 *     can select or filter rows (no probing one organisation's state by varying an argument).
 *   - Callers: EXECUTE crewflow_app only (never PUBLIC, never crewflow). Any crewflow_app session (API as well as Worker)
 *     can call it; the most it learns is the platform-wide number of CREATING-for-over-10-minutes and FAILED workspaces.
 *   - Abuse cases considered: (1) a tenant user cannot reach it — no route calls it, and resolvers/controllers never take
 *     SQL; (2) a compromised API process could poll it to observe platform-wide provisioning activity (a coarse signal of
 *     sign-up volume) — accepted: two counts, no identities, and that process already holds far more; (3) timing/inference
 *     on a single tenant — not possible without a filter argument; (4) the definer cannot be redirected — pinned
 *     search_path, fully qualified names, no dynamic SQL, STABLE (no writes).
 */

export const HEALTH_FUNCTION_SIGNATURE = 'core.worker_workspace_provisioning_health()';

/** Created by the migration identity; handed to rab_secure_owner. */
export const PROVISIONING_HEALTH_UP_SQL: readonly string[] = [
  `CREATE FUNCTION core.worker_workspace_provisioning_health()
RETURNS TABLE (creating_over_10_min integer, failed integer)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $health$
  SELECT (pg_catalog.count(*) FILTER (WHERE w.schema_status = 'CREATING'
                                        AND w.created_at < pg_catalog.now() - interval '10 minutes'))::integer,
         (pg_catalog.count(*) FILTER (WHERE w.schema_status = 'FAILED'))::integer
    FROM core.manager_workspace w
   WHERE w.status = 'active'
$health$`,
  `REVOKE ALL ON FUNCTION ${HEALTH_FUNCTION_SIGNATURE} FROM PUBLIC`,
  `ALTER FUNCTION ${HEALTH_FUNCTION_SIGNATURE} OWNER TO rab_secure_owner`,
  `REVOKE ALL ON FUNCTION ${HEALTH_FUNCTION_SIGNATURE} FROM PUBLIC, crewflow, crewflow_app`,
  `GRANT EXECUTE ON FUNCTION ${HEALTH_FUNCTION_SIGNATURE} TO crewflow_app`,
];

export const PROVISIONING_HEALTH_DOWN_SQL: readonly string[] = [`DROP FUNCTION IF EXISTS ${HEALTH_FUNCTION_SIGNATURE}`];

/** One row per function: owner, definer, search_path, EXECUTE holders (PUBLIC included), volatility. Read-only catalog query. */
export const PROVISIONING_HEALTH_STATE_SQL = `
SELECT p.proname AS name,
       pg_catalog.pg_get_userbyid(p.proowner) AS owner,
       p.prosecdef AS definer,
       p.provolatile::text AS volatility,
       coalesce((SELECT c FROM pg_catalog.unnest(p.proconfig) c WHERE c LIKE 'search_path=%'), '<unset>') AS search_path,
       coalesce((SELECT pg_catalog.string_agg(x.g, ',' ORDER BY x.g)
                   FROM (SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END AS g
                           FROM pg_catalog.aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE') x), '') AS executors
  FROM pg_catalog.pg_proc p
 WHERE p.pronamespace = 'core'::pg_catalog.regnamespace
   AND p.proname = 'worker_workspace_provisioning_health'
 ORDER BY 1`;

export const PROVISIONING_HEALTH_EXPECTED_STATE: ReadonlyArray<Record<string, unknown>> = [
  {
    name: 'worker_workspace_provisioning_health',
    owner: 'rab_secure_owner',
    definer: true,
    volatility: 's',
    search_path: 'search_path=pg_catalog, pg_temp',
    executors: 'crewflow_app,rab_secure_owner',
  },
];

export const PROVISIONING_HEALTH_GONE_SQL = `
SELECT NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
                    WHERE p.pronamespace = 'core'::pg_catalog.regnamespace
                      AND p.proname = 'worker_workspace_provisioning_health') AS gone`;

/** Golden posture lines (security-posture.golden.txt format) the migration adds, for the coordinator's golden update. */
export const PROVISIONING_HEALTH_GOLDEN_LINES: readonly string[] = [
  'execute|worker_workspace_provisioning_health()|PUBLIC|false',
  'execute|worker_workspace_provisioning_health()|crewflow_app|true',
  'execute|worker_workspace_provisioning_health()|crewflow|false',
  'owner|function|worker_workspace_provisioning_health()|rab_secure_owner|definer=true|search_path=pg_catalog, pg_temp',
];
