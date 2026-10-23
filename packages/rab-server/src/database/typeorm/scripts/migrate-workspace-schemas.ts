/**
 * Wave 2 lane S2 (B3): run the per-workspace schema migrator on demand — resume after a failed workspace, adopt a
 * pre-ledger workspace created by an older image, or roll pending modules forward. Normally the core migration that ships
 * a module does this itself; this CLI is the operator's resume tool.
 *
 *   DB_TARGET=local|test DATABASE_URL=… DATABASE_URL_UNPOOLED=<migration identity> \
 *     ts-node --transpile-only -P packages/rab-server/tsconfig.app.json \
 *     packages/rab-server/src/database/typeorm/scripts/migrate-workspace-schemas.ts [--through=<version>]
 *
 * Connects ONLY through the guarded migration DataSource (DATABASE_URL_UNPOOLED, DB_TARGET guard, read-only identity probe)
 * and the migrator itself refuses the runtime role. Exit 1 when any workspace FAILED or was REFUSED (each is rolled back
 * and recorded in core.workspace_schema_migration; the others are migrated).
 */
import 'dotenv/config';

import { coreMigrationDataSource } from '../core/core.datasource';
import { WorkspaceSchemaMigrator } from '../workspace-schema/workspace-schema-migrator';
import { LATEST_WORKSPACE_MODULE_VERSION } from '../workspace-schema/workspace-schema-modules';

async function main(): Promise<void> {
  const arg = process.argv.find((a) => a.startsWith('--through='));
  const through = arg ? Number(arg.slice('--through='.length)) : LATEST_WORKSPACE_MODULE_VERSION;
  const dataSource = await coreMigrationDataSource.initialize();
  const runner = dataSource.createQueryRunner();
  try {
    await runner.connect();
    const outcomes = await new WorkspaceSchemaMigrator(runner).migrateAll({ throughVersion: through, txMode: 'own', appVersion: 'cli:migrate-workspace-schemas' });
    for (const o of outcomes) {
      // eslint-disable-next-line no-console
      console.log(`${o.schemaName} ${o.status} ${o.fromVersion}->${o.toVersion}${o.errorClass ? ` ${o.errorClass} at ${o.moduleId}` : ''}`);
    }
    const bad = outcomes.filter((o) => o.status === 'FAILED' || o.status === 'REFUSED');
    // eslint-disable-next-line no-console
    console.log(`workspace schemas: ${outcomes.length} checked, ${bad.length} failed/refused, target module ${through}`);
    if (bad.length) process.exitCode = 1;
  } finally {
    await runner.release();
    await dataSource.destroy();
  }
}

main().catch((error: Error) => {
  // eslint-disable-next-line no-console
  console.error(`migrate-workspace-schemas failed: ${error.message.replace(/postgres(ql)?:\/\/\S+/g, '<url>')}`);
  process.exit(2);
});
