import { DataSource } from 'typeorm';

const RUNTIME_DB_ROLE = process.env.RAB_APP_ROLE ?? 'rab_app';

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
 * Shared by the API (`main.ts`) and the worker (`queue-worker/main.ts`): the
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
