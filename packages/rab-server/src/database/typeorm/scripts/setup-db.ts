/**
 * Runs pending migrations against DATABASE_URL. Invoked by render.yaml's
 * dockerCommand before `main` boots, and locally via `nx run rab-server:migration:run`.
 *
 * Uses the migration-only DataSource (longer timeouts, see core.datasource.ts). Failure exits non-zero so start.sh
 * (`set -e`) never starts the application on a partially migrated schema. Policy: docs/architecture/MIGRATION-EXECUTION-POLICY.md.
 */
import 'dotenv/config';

import { coreMigrationDataSource as coreDataSource } from '../core/core.datasource';

async function main(): Promise<void> {
  const dataSource = await coreDataSource.initialize();
  try {
    const pending = await dataSource.showMigrations();
    if (pending) {
      // eslint-disable-next-line no-console
      console.log('Running pending migrations...');
    }
    const applied = await dataSource.runMigrations();
    // eslint-disable-next-line no-console
    console.log(`Migrations applied: ${applied.length === 0 ? 'none pending' : applied.map((m) => m.name).join(', ')}`);
  } finally {
    await dataSource.destroy();
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('Migration run failed:', error);
  process.exit(1);
});
