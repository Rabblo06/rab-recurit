/**
 * Runs once in the Jest parent process, before any test file, for every rab-server Jest run (unit and integration).
 *
 * Fails the whole run before any fixture is written if NODE_ENV is not `test`, if the TEST_* pair is missing, mismatched,
 * remote without override or the development database, or if an inherited database URL or libpq variable would redirect a
 * connection.
 * Then proves, with read-only identity queries, that the application and admin connections reach the same database in the
 * same cluster. Pooled and direct connections may differ by hostname, so identity, not the string, is compared.
 */
import {
  assertSameDatabaseAtRuntime,
  resolveForJestGlobalSetup,
  routedTestDatabaseLegacyNames,
  TestDatabaseConfigError,
} from './database/typeorm/core/test-database-guard';

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
  // Non-secret evidence line: database name, cluster identifier and endpoint key only.
  // eslint-disable-next-line no-console
  console.log(
    `[test-db-guard] application and admin connections agree: database=${identity.database} cluster=${identity.systemIdentifier} endpoint=${resolved.app.endpointKey} remote=${resolved.app.remote}`,
  );
}
