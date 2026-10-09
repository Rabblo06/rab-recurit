/**
 * Runs once in the Jest parent process, before any test file, for every rab-server Jest run (unit and integration).
 *
 * Fails the whole run before any fixture is written if the TEST_* pair is missing, mismatched, or remote without override.
 * Then proves, with read-only identity queries, that the application and admin connections reach the same database in the
 * same cluster. Pooled and direct connections may differ by hostname, so identity, not the string, is compared.
 */
import { assertSameDatabaseAtRuntime, resolveIntegrationTestDatabase } from './database/typeorm/core/test-database-guard';

export default async function globalSetup(): Promise<void> {
  const resolved = resolveIntegrationTestDatabase(process.env);
  const identity = await assertSameDatabaseAtRuntime(resolved);
  // Non-secret evidence line: database name, cluster identifier and endpoint key only.
  // eslint-disable-next-line no-console
  console.log(
    `[test-db-guard] application and admin connections agree: database=${identity.database} cluster=${identity.systemIdentifier} endpoint=${resolved.app.endpointKey} remote=${resolved.app.remote}`,
  );
}
