import { DataSource } from 'typeorm';

// Fixed, not environment-overridable: an env var naming the expected role would let a misconfigured deployment redefine what
// "the restricted runtime role" means and pass this check while actually connected as the owner.
// P2/P3 Checkpoint 2 (restricted runtime role): the ordinary application login is `crewflow_app` —
// it owns NOTHING (NOLOGIN was considered and rejected; it must be able to log in to actually serve
// requests). It holds only plain DML (SELECT/INSERT/UPDATE/DELETE, replicated from `crewflow`'s own
// grants, deliberately excluding TRIGGER/REFERENCES/TRUNCATE — see
// `CrewflowAppRestrictedRuntimeRole1786687000000`) plus EXECUTE on the same SECURITY DEFINER
// functions `crewflow` itself can call. Because it owns no table, it structurally cannot
// ALTER/DROP/DISABLE ROW LEVEL SECURITY/CREATE SCHEMA — those require ownership or superuser,
// never a GRANT, in Postgres. `crewflow` (the former sole runtime identity, now demoted to
// migration/bootstrap authority) remains the owner of the 36 ordinary business tables and of
// `provision_workspace_schema`'s one remaining privileged caller path; `crewflow_app` is deliberately
// never granted EXECUTE on `provision_workspace_schema` — only the worker's dedicated, non-pooled
// provisioning connection (authenticated as `crewflow`) may run it. The pre-auth-sensitive NOT_FORCE
// tables (`core.user_session`, `user`, `refresh_token`, ... — see `tools/check-rls-coverage.ts`'s
// `NOT_FORCED_ALLOWLIST`) and their SECURITY DEFINER lookup functions are owned by the separate,
// NOLOGIN `rab_secure_owner`, which neither `crewflow` nor `crewflow_app` is ever a member of or can
// SET ROLE into. `rab_app`/`rab_owner` are retired (NOLOGIN, zero remaining grants).
const RUNTIME_DB_ROLE = 'crewflow_app';

/**
 * A cryptographically valid request/job can still be served against the wrong
 * database role — RLS's non-FORCE'd tables (see `NOT_FORCED_ALLOWLIST` /
 * `PRE_AUTH_EXEMPT_TABLES` in tools/check-rls-coverage.ts, the authoritative
 * list) are fully unscoped for a table-owner connection regardless of tenant
 * context. This mirrors that CI check at boot, catching a misconfigured
 * DATABASE_URL (e.g. accidentally pointed at the migration/owner role) before
 * the process ever serves a request or runs a job, rather than discovering it
 * via a cross-tenant data leak.
 *
 * Shared by the API (`main.ts`) and the worker (`packages/rab-worker/src/main.ts`): the
 * worker's tenant-scoped work runs through the same DataSource, so it needs
 * exactly the same guarantee. (The worker ALSO holds a deliberate, separate
 * owner connection for read-only cross-tenant discovery — that one is never
 * this DataSource.)
 */
export async function assertRuntimeDbRole(dataSource: DataSource, processName: string): Promise<void> {
  const [{ current_user: connectedAs }] = await dataSource.query<[{ current_user: string }]>('SELECT current_user');
  if (connectedAs !== RUNTIME_DB_ROLE) {
    throw new Error(
      `Refusing to start: DATABASE_URL connects as "${connectedAs}", not "${RUNTIME_DB_ROLE}". ` +
        `The ${processName} must never run tenant-scoped work as the migration/owner role — see postgres-init/01-roles.sql.`,
    );
  }
  const [{ rolbypassrls, rolsuper }] = await dataSource.query<[{ rolbypassrls: boolean; rolsuper: boolean }]>(
    'SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user',
  );
  if (rolbypassrls || rolsuper) {
    throw new Error(`Refusing to start: runtime role "${connectedAs}" has BYPASSRLS/SUPERUSER — row-level security would not apply.`);
  }
}
