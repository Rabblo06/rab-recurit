/**
 * The read-only pending-migration check of the API start (packages/rab-docker/rab/api-prestart.sh). Runs as the API's own
 * restricted runtime role (`crewflow_app`, PG_DATABASE_URL through the shared factory, src/database/postgres) before
 * main.js and exits non-zero when the schema is behind the code, so the API fails closed instead of serving against it. It
 * never migrates and holds no migration credential: since Phase B (P7) only the one-off `rab-migrate` process
 * (deploy-prepare.ts) applies migrations. Deliberately does NOT import dotenv.
 *
 * Security review N-3: this script runs BEFORE main.js, so before the API's own runtime guard. It therefore applies that
 * guard's pure resolution first (runtime-database-guard.ts resolveRuntimeDatabase, process 'api': the never-in-runtime
 * list, the production / runtime environment rules, the URL policy and the interim unmarked-production deny list) and
 * opens NO connection when it refuses. The live deployment-identity probe stays with main.js's boot guard.
 *
 * Phase B schema compatibility: the same assessment as the API's boot gate 7 (src/database/boot-checks/
 * schema-compatibility.ts, process 'api'): exit 1 on a refusal (pending, interleaved unknown ledger names, an incompatible
 * provision function), and a printed WARNING for what the API tolerates (a ledger ahead of the code: an image rollback).
 */
import type { DataSource } from 'typeorm';

import { readRuntimeDotenvValues, resolveRuntimeDatabase } from '../core/runtime-database-guard';
import { redactConnectionStrings } from './migrate/locked-migration-runner';

/** Opens the check's DataSource. The default loads TypeORM and the core migrations lazily, only after the guard passed. */
export type OpenCheckDataSource = () => Promise<DataSource>;

const openCoreDataSource: OpenCheckDataSource = async () => {
  const { DataSource: TypeOrmDataSource } = await import('typeorm');
  const { coreDataSourceOptions } = await import('../core/core.datasource');
  const dataSource = new TypeOrmDataSource({ ...coreDataSourceOptions, name: 'check-pending-migrations' });
  await dataSource.initialize();
  return dataSource;
};

export async function checkPendingMigrations(
  env: Record<string, string | undefined> = process.env,
  dotenvValues: Record<string, string> = readRuntimeDotenvValues(),
  openDataSource: OpenCheckDataSource = openCoreDataSource,
): Promise<void> {
  // N-3: the API runtime guard's pure rules, before any connection. Throws RuntimeDbError (never a URL or credential).
  resolveRuntimeDatabase({ processName: 'api', env, dotenvValues });

  const { assertNoPendingMigrations } = await import('../../../engine/utils/assert-no-pending-migrations');
  const { assertRuntimeDbRole } = await import('../../../engine/utils/assert-runtime-db-role');
  const { isProductionProcess } = await import('../../boot-checks/database-boot-gate-rules');
  const dataSource = await openDataSource();
  try {
    await assertRuntimeDbRole(dataSource, 'api prestart check');
    const assessment = await assertNoPendingMigrations(dataSource, 'API server', { process: 'api', production: isProductionProcess('api', env) });
    // eslint-disable-next-line no-console
    for (const warning of assessment.warnings) console.warn(`[migration-guard] WARNING: ${warning}`);
    // eslint-disable-next-line no-console
    console.log(
      `[migration-guard] schema is ${assessment.warnings.length ? 'compatible' : 'current'} (${dataSource.migrations.length} migrations applied); restricted runtime role ok`,
    );
  } finally {
    await dataSource.destroy();
  }
}

if (require.main === module) {
  checkPendingMigrations().then(
    () => process.exit(0),
    (error: unknown) => {
      // eslint-disable-next-line no-console
      console.error(`[migration-guard] ${redactConnectionStrings(error instanceof Error ? error.message : 'unknown error')}`);
      process.exit(1);
    },
  );
}
