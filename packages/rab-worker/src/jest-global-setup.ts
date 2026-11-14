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
  testDatabaseAdminNameNotice,
} from '@rab/server/database/typeorm/core/test-database-guard';

export default async function globalSetup(): Promise<void> {
  // X1.2: NODE_ENV=test, the TEST pair, and no inherited database URL / libpq variable that would redirect a connection.
  const resolved = resolveForJestGlobalSetup(process.env);
  // X3.5-S7: one name-only line when the admin URL came from the deprecated TEST_DATABASE_URL_UNPOOLED.
  const notice = testDatabaseAdminNameNotice(resolved);
  // eslint-disable-next-line no-console
  if (notice) console.warn(notice);
  const identity = await assertSameDatabaseAtRuntime(resolved);
  // X1.8: when the Phase D worker-login switch is on (PHASE_D_SQL_APPROVED=true + TEST_DATABASE_WORKER_URL), that login
  // must pass the static rules and, live, be neither a superuser nor BYPASSRLS before any spec routes the Worker to it.
  await assertWorkerLoginNotPrivilegedAtRuntime(process.env);
  // eslint-disable-next-line no-console
  console.log(
    `[test-db-guard] worker: application and admin connections agree: database=${identity.database} cluster=${identity.systemIdentifier} endpoint=${resolved.app.endpointKey} remote=${resolved.app.remote}`,
  );
}
