/**
 * Runs once in the Jest parent process before any worker test file. Fails the run before any fixture is written if the
 * TEST_* pair is missing, mismatched or remote without override, then proves with read-only queries that the application
 * and admin connections reach the same database. Shared logic lives in rab-server (test-database-guard.ts).
 */
import {
  assertSameDatabaseAtRuntime,
  resolveIntegrationTestDatabase,
} from '@rab/server/database/typeorm/core/test-database-guard';

export default async function globalSetup(): Promise<void> {
  const resolved = resolveIntegrationTestDatabase(process.env);
  const identity = await assertSameDatabaseAtRuntime(resolved);
  // eslint-disable-next-line no-console
  console.log(
    `[test-db-guard] worker: application and admin connections agree: database=${identity.database} cluster=${identity.systemIdentifier} endpoint=${resolved.app.endpointKey} remote=${resolved.app.remote}`,
  );
}
