/**
 * Runs once in the Jest parent process before any worker test file. Fails the run before any fixture is written if NODE_ENV
 * is not `test`, if the TEST_* pair is missing, mismatched, remote without override or the development database, or if an
 * inherited database URL or libpq variable would redirect a connection, then proves with read-only queries that the application
 * and admin connections reach the same database. Shared logic lives in rab-server (test-database-guard.ts).
 */
import {
  assertSameDatabaseAtRuntime,
  assertWorkerLoginNotPrivilegedAtRuntime,
  resolveForJestGlobalSetup,
  routedTestDatabaseLegacyNames,
  TestDatabaseConfigError,
} from '@rab/server/database/typeorm/core/test-database-guard';

export default async function globalSetup(): Promise<void> {
  // X1.2: NODE_ENV=test, the TEST pair, and no inherited database URL / libpq variable that would redirect a connection.
  // X3.5-S8: a legacy connection name or the old admin name TEST_DATABASE_URL_UNPOOLED (inherited or in .env) is refused here.
  const resolved = resolveForJestGlobalSetup(process.env);
  // X3.5-S6 (DBR-08): setupFiles route every test file through PG_DATABASE_URL only; the routing itself must leave no legacy
  // name behind (a regression guard on the routing; names only, never values).
  const legacy = routedTestDatabaseLegacyNames(process.env);
  if (legacy.length > 0) {
    throw new TestDatabaseConfigError(`the routed test environment still holds the legacy name(s) ${legacy.join(', ')}; it must use PG_DATABASE_URL only. Refusing to start.`);
  }
  const identity = await assertSameDatabaseAtRuntime(resolved);
  // X1.8: when the Phase D worker-login switch is on (PHASE_D_SQL_APPROVED=true + TEST_DATABASE_WORKER_URL), that login
  // must pass the static rules and, live, be neither a superuser nor BYPASSRLS before any spec routes the Worker to it.
  await assertWorkerLoginNotPrivilegedAtRuntime(process.env);
  // eslint-disable-next-line no-console
  console.log(
    `[test-db-guard] worker: application and admin connections agree: database=${identity.database} cluster=${identity.systemIdentifier} endpoint=${resolved.app.endpointKey} remote=${resolved.app.remote}`,
  );
}
