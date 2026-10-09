import { DataSource } from 'typeorm';
import { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';

import { coreDataSourceOptions } from '../../../database/typeorm/core/core.datasource';
import { resolveIntegrationTestDatabase } from '../../../database/typeorm/core/test-database-guard';

/**
 * A SEPARATE, `rab_owner`-connected DataSource for test bootstrap only —
 * creating a fresh `Organisation` row, seeding global `Permission` reference
 * data. Neither is something the running app ever does over its own
 * connection: `organisation`'s RLS policy (`id = current_org()`, no FORCE
 * exemption for `rab_app`) makes a brand-new org's own row structurally
 * uninsertable with no tenant context yet bound — in real life this only
 * ever happens via the CLI seed script (`rab_owner`), never `rab_app`. This
 * mirrors that split for tests, so the app's own DataSource
 * (`moduleRef.get(DataSource)`) can be `rab_app` — the real runtime role —
 * for everything that actually exercises RLS/auth, while this connection
 * covers the "owner/migration-style" setup a real seed script would do.
 *
 * The URL comes ONLY from TEST_DATABASE_URL_UNPOOLED, validated by the same
 * guard as the application connection (same logical database, same endpoint,
 * no remote host without ALLOW_REMOTE_TEST_DATABASE=true). It never falls back
 * to DATABASE_URL_UNPOOLED: that name is read from the developer's .env, which
 * can point at a remote database. An unset value throws here, before any
 * fixture is written. Incident: docs/architecture/HYPER-WORKSPACE-PHASE3-FOUNDATION.md.
 *
 * HWS runtime cutover, Part 2 consequence (found while writing the backfill/provisioning
 * integration tests): `coreDataSourceOptions` no longer carries a static `schema: 'core'`
 * default — every schema-less (workspace) entity now resolves purely through whatever
 * `search_path` the current transaction has bound, which `TenantContextService` sets, but this
 * helper's whole purpose is ordinary ADMIN/FIXTURE setup that deliberately bypasses
 * `TenantContextService` (see above). Without an explicit default here, any fixture helper that
 * manages its own `dataSource.transaction()` and writes a workspace entity (`JobRole`, `Venue`,
 * `StaffProfile`, ...) — a long-established pattern across this test suite — fails with
 * "relation ... does not exist", not an RLS error, because the connection's search_path is the
 * Postgres default, which never includes `core`. The `-c search_path=core` connection option
 * below restores exactly the behaviour this helper always had before Part 2, for this
 * admin/fixture connection only — it does NOT touch `coreDataSourceOptions` itself, and does not
 * re-introduce any fallback into production code or into the app's own runtime DataSource
 * (`app.get(DataSource)`), which still resolves search_path per-transaction via
 * `TenantContextService` exactly as the cutover intends.
 */
export function createAdminDataSource(): DataSource {
  const { adminUrl } = resolveIntegrationTestDatabase(process.env);
  const baseOptions = coreDataSourceOptions as PostgresConnectionOptions;
  return new DataSource({
    ...baseOptions,
    url: adminUrl,
    name: `admin-${Math.random().toString(36).slice(2)}`,
    extra: { ...(baseOptions.extra as object | undefined), options: '-c search_path=core' },
  });
}

/**
 * P2.1 — a SEPARATE connection from `createAdminDataSource()` above, for exactly one narrow purpose: proving
 * "FORCE ROW LEVEL SECURITY binds even the table owner" (e.g. `staff_profile`/`manager_profile`/`audit_log`, all
 * owned by `crewflow` post-P1C.2, none on the NOT_FORCED_ALLOWLIST). `createAdminDataSource()`'s connection
 * (`TEST_DATABASE_URL_UNPOOLED`) is the Postgres superuser bootstrap identity locally — superusers bypass RLS
 * unconditionally, for a completely different reason than table ownership, so a "the owner sees zero rows" assertion
 * run over THAT connection is vacuously true-or-false depending on bypass, never actually exercising FORCE. Found
 * live, reproducibly, in two separate suites (`staff-profile-rls-abuse-cases`, `audit-log-abuse-cases`): both
 * returned every row instead of zero. Confirmed by testing the alternative directly: pointing the shared admin
 * connection at `crewflow` instead of the superuser fixes this one assertion but breaks ordinary fixture creation
 * suite-wide (`crewflow` cannot bypass `organisation`'s own RLS the way `createAdminDataSource()`'s connection can)
 * — so this needs its OWN connection, reusing `TEST_DATABASE_URL` (the same identity the app's own DataSource
 * already uses) rather than replacing the shared admin connection for every other test in a file.
 */
export function createCrewflowOwnerProbeDataSource(): DataSource {
  const { appUrl } = resolveIntegrationTestDatabase(process.env);
  const baseOptions = coreDataSourceOptions as PostgresConnectionOptions;
  return new DataSource({
    ...baseOptions,
    url: appUrl,
    name: `crewflow-owner-probe-${Math.random().toString(36).slice(2)}`,
    extra: { ...(baseOptions.extra as object | undefined), options: '-c search_path=core' },
  });
}
