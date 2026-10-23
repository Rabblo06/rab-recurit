/**
 * Twenty-parity Phase 7 — the RESTRICTED half of the opt-in api prestart (packages/rab-docker/rab/api-prestart.sh).
 * Runs as the ordinary runtime role (`crewflow_app`, DATABASE_URL) after any approved migration step and before main.js,
 * and exits non-zero when the schema is behind the code, so the API fails closed instead of serving against it. Read-only:
 * it never migrates and holds no migration credential. Deliberately does NOT import dotenv.
 */
import { DataSource } from 'typeorm';

import { assertNoPendingMigrations } from '../../../engine/utils/assert-no-pending-migrations';
import { assertRuntimeDbRole } from '../../../engine/utils/assert-runtime-db-role';
import { coreDataSourceOptions } from '../core/core.datasource';

async function main(): Promise<void> {
  const dataSource = new DataSource({ ...coreDataSourceOptions, name: 'check-pending-migrations' });
  await dataSource.initialize();
  try {
    await assertRuntimeDbRole(dataSource, 'api prestart check');
    await assertNoPendingMigrations(dataSource, 'API server');
    // eslint-disable-next-line no-console
    console.log(`[migration-guard] schema is current (${dataSource.migrations.length} migrations applied); restricted runtime role ok`);
  } finally {
    await dataSource.destroy();
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    // eslint-disable-next-line no-console
    console.error(`[migration-guard] ${(error instanceof Error ? error.message : 'unknown error').replace(/postgres(ql)?:\/\/\S+/g, '<url>')}`);
    process.exit(1);
  },
);
