// sql-injection-reviewed-file: SQL definition / check module (database layer). Every interpolation is a code constant of this repository (table, function, role and policy names, numeric limits) or a validated identifier; no request or row data reaches these templates. Reviewed 2026-11-04 (owner-login SQL-injection lint).
/**
 * M-T2 (Twenty Mode Option A; owner-approved as a new forward migration, M0 §5.3 / D9):
 * WorkspaceRegistryGuardAllowList1786721410000. The exact SQL, shared by the migration and its spec.
 *
 * WHY. core.workspace_schema_registry_versioning_guard() (WorkspaceSchemaMigrationLedger1786719800000,
 * workspace-schema-ledger-sql.ts) keeps the workspace versioning / drift columns (module_version, expected_fingerprint,
 * observed_fingerprint, fingerprint_checked_at, drift_status, drift_detail) writable by the migration / provisioner
 * identities only. It was a DENY-list — `IF current_user <> 'crewflow_app' THEN RETURN NEW` — so every role except
 * crewflow_app passed. Under Option A the runtime login is crewflow_owner, which is not crewflow_app: every API / Worker
 * request could rewrite a workspace's recorded version and drift state (G-10). M-T2 makes it an ALLOW-list: only
 * `crewflow` (the provisioner / migrator role), `rab_secure_owner` (its SECURITY DEFINER registry functions) and a
 * superuser pass; everyone else — crewflow_app as before, and now crewflow_owner and any other login — gets the existing
 * checks (INSERT with non-initial values, or UPDATE changing any of the six columns → 42501).
 *
 * The migration / provisioning code that legitimately writes those columns as crewflow_owner (or as the separated
 * migration identity acting as itself) takes `SET LOCAL ROLE crewflow` first (workspace-schema-migrator.ts
 * actAsMigrationRole). provision_workspace (SECURITY DEFINER, owner crewflow) and the rab_secure_owner registry definers
 * already run as an allowed role.
 *
 * WHAT IT DOES NOT DO. It is an accident guard on normal paths. An injected statement as crewflow_owner can `SET ROLE
 * crewflow`, `DISABLE TRIGGER` or replace the function (G-02/G-10, owner-accepted); the semantic posture monitor detects
 * the last two afterwards.
 *
 * Owner, ACL and the trigger are unchanged: CREATE OR REPLACE keeps the function's owner (crewflow) and its ACL (EXECUTE
 * revoked from PUBLIC); only the first IF changes. down() restores the deny-list body byte for byte.
 */

const GUARD_HEAD = `CREATE OR REPLACE FUNCTION core.workspace_schema_registry_versioning_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $guard$
BEGIN
`;

/** The checks every non-allowed role gets — identical in both bodies. */
const GUARD_CHECKS = `  IF TG_OP = 'INSERT' THEN
    IF NEW.module_version <> 0 OR NEW.expected_fingerprint IS NOT NULL OR NEW.observed_fingerprint IS NOT NULL
       OR NEW.drift_status <> 'UNCHECKED' OR NEW.drift_detail IS NOT NULL OR NEW.fingerprint_checked_at IS NOT NULL THEN
      RAISE EXCEPTION 'workspace schema versioning and drift columns are written by the migration identity only' USING ERRCODE = '42501';
    END IF;
  ELSIF (NEW.module_version, NEW.expected_fingerprint, NEW.observed_fingerprint, NEW.fingerprint_checked_at, NEW.drift_status, NEW.drift_detail)
        IS DISTINCT FROM
        (OLD.module_version, OLD.expected_fingerprint, OLD.observed_fingerprint, OLD.fingerprint_checked_at, OLD.drift_status, OLD.drift_detail) THEN
    RAISE EXCEPTION 'workspace schema versioning and drift columns are written by the migration identity only' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$guard$`;

/** M-T2 up(): allow-list. */
export const REGISTRY_GUARD_ALLOWLIST_SQL = `${GUARD_HEAD}  IF current_user IN ('crewflow'::name, 'rab_secure_owner'::name)
     OR coalesce((SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user), false) THEN
    RETURN NEW;
  END IF;
${GUARD_CHECKS}`;

/** M-T2 down(): the previous deny-list body (WorkspaceSchemaMigrationLedger1786719800000), byte for byte. */
export const REGISTRY_GUARD_DENYLIST_SQL = `${GUARD_HEAD}  IF current_user <> 'crewflow_app' THEN
    RETURN NEW;
  END IF;
${GUARD_CHECKS}`;

/** The live guard: owner, SECURITY, body markers, trigger state. */
export const REGISTRY_GUARD_STATE_SQL = `
SELECT pg_catalog.pg_get_userbyid(p.proowner)::text AS owner, p.prosecdef AS definer, p.proconfig::text[] AS config,
       pg_catalog.strpos(p.prosrc, 'current_user IN (''crewflow''::name, ''rab_secure_owner''::name)') > 0 AS allow_list,
       pg_catalog.strpos(p.prosrc, 'current_user <> ''crewflow_app''') > 0 AS deny_list,
       (SELECT t.tgenabled::text FROM pg_catalog.pg_trigger t
         WHERE t.tgrelid = 'core.workspace_schema_registry'::regclass AND t.tgname = 'workspace_schema_registry_versioning_guard') AS trigger_enabled,
       (p.proacl IS NULL OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(p.proacl) x WHERE x.grantee = 0)) AS public_execute
  FROM pg_catalog.pg_proc p
 WHERE p.oid = 'core.workspace_schema_registry_versioning_guard()'::regprocedure`;

export interface RegistryGuardState {
  owner: string;
  definer: boolean;
  config: string[] | null;
  allow_list: boolean;
  deny_list: boolean;
  trigger_enabled: string | null;
  public_execute: boolean;
}

export function registryGuardProblems(f: RegistryGuardState | undefined, expect: 'allow' | 'deny'): string[] {
  if (!f) return ['core.workspace_schema_registry_versioning_guard() is missing'];
  const p: string[] = [];
  if (f.owner !== 'crewflow') p.push(`owned by ${f.owner}, expected crewflow`);
  if (f.definer) p.push('is SECURITY DEFINER (expected INVOKER)');
  if (!f.config?.includes('search_path=pg_catalog, pg_temp')) p.push(`search_path is ${JSON.stringify(f.config)}`);
  if (expect === 'allow' && (!f.allow_list || f.deny_list)) p.push('body is not the M-T2 allow-list');
  if (expect === 'deny' && (!f.deny_list || f.allow_list)) p.push('body is not the previous deny-list');
  if (f.trigger_enabled !== 'O') p.push(`trigger workspace_schema_registry_versioning_guard enabled=${f.trigger_enabled ?? 'missing'} (expected O)`);
  if (f.public_execute) p.push('EXECUTE is granted to PUBLIC');
  return p;
}
