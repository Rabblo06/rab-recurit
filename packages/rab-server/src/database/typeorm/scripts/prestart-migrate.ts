/**
 * Twenty-parity Phase 7 — the PRIVILEGED half of the opt-in api prestart (packages/rab-docker/rab/api-prestart.sh).
 * TEST-ONLY until the owner approves it: no default compose file runs it.
 *
 * Twenty runs `yarn database:migrate:prod` + `upgrade` from its container entrypoint on every server start, swallows
 * failures, and takes no lock (twentyhq/twenty@ea1a68e3, packages/twenty-docker/twenty/entrypoint.sh L5-27;
 * packages/twenty-server/docs/UPGRADE_COMMANDS.md L202). Crewflow keeps the "the api start triggers it" shape but:
 *   - runs ONLY when CREWFLOW_MIGRATION_APPROVED=apply-pending-migrations is set for that deploy (disabled by default);
 *   - receives the one-time migration credential as DATABASE_URL_UNPOOLED from the prestart shell, in a short-lived child
 *     process that exits before main.js starts (the shell scrubs every migration variable before exec'ing main.js);
 *   - serialises replicas with a PostgreSQL session advisory lock, so two api replicas never migrate concurrently (the
 *     second waits, then finds nothing pending);
 *   - applies each migration at most once (TypeORM's ledger `core.migrations`, transaction per migration) and goes through
 *     the existing guards (database-target.ts DB_TARGET/identity probe, migration-identity.ts role rules);
 *   - FAILS CLOSED: any error exits non-zero, so the shell never starts main.js;
 *   - never resets anything: synchronize/dropSchema/migrationsRun must all be off, and nothing here drops or truncates.
 *
 * Deliberately does NOT import dotenv: the credential comes only from the process environment the shell built.
 */
import { Client } from 'pg';

import { coreMigrationDataSource } from '../core/core.datasource';

const APPROVAL = 'apply-pending-migrations';
const LOCK_KEY_SQL = `hashtext('crewflow:prestart-migrations')`;

const log = (message: string) => {
  // eslint-disable-next-line no-console
  console.log(`[prestart-migrate] ${message}`);
};

async function main(): Promise<void> {
  if (process.env.CREWFLOW_MIGRATION_APPROVED !== APPROVAL) {
    log('SKIPPED: CREWFLOW_MIGRATION_APPROVED is not apply-pending-migrations. Nothing was run.');
    return;
  }
  const url = process.env.DATABASE_URL_UNPOOLED?.trim();
  if (!url) throw new Error('the one-time migration connection (DATABASE_URL_UNPOOLED, set by api-prestart.sh) is missing');

  const options = coreMigrationDataSource.options as { synchronize?: boolean; dropSchema?: boolean; migrationsRun?: boolean };
  if (options.synchronize || options.dropSchema || options.migrationsRun) {
    throw new Error('refusing: synchronize, dropSchema and migrationsRun must all be off (this step never resets a database)');
  }

  const lock = new Client({ connectionString: url, application_name: 'crewflow-prestart-migrate' });
  await lock.connect();
  try {
    await lock.query(`SET lock_timeout = '15min'`);
    const waitStart = Date.now();
    await lock.query(`SELECT pg_advisory_lock(${LOCK_KEY_SQL})`);
    log(`advisory lock acquired after ${Date.now() - waitStart} ms (pid ${process.pid})`);

    const dataSource = await coreMigrationDataSource.initialize();
    try {
      const applied = await dataSource.runMigrations();
      log(applied.length === 0 ? 'none pending' : `applied: ${applied.map((m) => m.name).join(', ')}`);
      if (await dataSource.showMigrations()) throw new Error('migrations are still pending after the run');
    } finally {
      await dataSource.destroy();
    }
  } finally {
    await lock.query(`SELECT pg_advisory_unlock(${LOCK_KEY_SQL})`).catch(() => undefined);
    await lock.end().catch(() => undefined);
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    const message = error instanceof Error ? error.message : 'unknown error';
    // Never echo a connection string.
    // eslint-disable-next-line no-console
    console.error(`[prestart-migrate] FAILED: ${message.replace(/postgres(ql)?:\/\/\S+/g, '<url>')}`);
    process.exit(1);
  },
);
