/**
 * Runs once in the Jest parent process before any worker test file. Fails the run before any fixture is written if NODE_ENV
 * is not `test`, if the TEST_* pair is missing, mismatched, remote without override or the development database, or if an
 * inherited database URL or libpq variable would redirect a connection, then proves with read-only queries that the application
 * and admin connections reach the same database. Shared logic lives in rab-server (test-database-guard.ts).
 */
import {
  assertSameDatabaseAtRuntime,
  resolveForJestGlobalSetup,
} from '@rab/server/database/typeorm/core/test-database-guard';

export default async function globalSetup(): Promise<void> {
  // X1.2: NODE_ENV=test, the TEST pair, and no inherited database URL / libpq variable that would redirect a connection.
  const resolved = resolveForJestGlobalSetup(process.env);
  const identity = await assertSameDatabaseAtRuntime(resolved);
  // eslint-disable-next-line no-console
  console.log(
    `[test-db-guard] worker: application and admin connections agree: database=${identity.database} cluster=${identity.systemIdentifier} endpoint=${resolved.app.endpointKey} remote=${resolved.app.remote}`,
  );
}
