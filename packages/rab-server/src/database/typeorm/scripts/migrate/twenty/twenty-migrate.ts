/**
 * Owner-login architecture (PR 3): the process entry of the migrate-on-start child (core: ../owner-login/migrate-on-start.ts;
 * the path keeps the name agreed with api-prestart.sh and Agent 5 before the owner-login rename). api-prestart.sh runs
 *   node packages/rab-server/dist/database/typeorm/scripts/migrate/twenty/twenty-migrate.js
 * only when CREWFLOW_MIGRATE_ON_START=true, and execs main.js only on exit 0 (ok) or 70 (an upgrade migration failed and
 * CREWFLOW_UPGRADE_FAILURE=continue, owner decision C3: an ERROR, the API starts anyway; still logged as a
 * failure). Settings come from Agent 2's runtime-db-config.ts (one source of truth); exit codes are its
 * STARTUP_EXIT_CODES. Prints exactly one TWENTY_MIGRATE_RESULT line. Deliberately does NOT import dotenv.
 */
import { readRuntimeDbConfig, RuntimeDbConfigError, STARTUP_EXIT_CODES } from '../../../../owner-login/runtime-db-config';
import { installSigtermSelfCancel, migrateChildConfigRefusal, RESULT_LINE_PREFIX, runMigrateOnStart } from '../owner-login/migrate-on-start';

async function main(): Promise<number> {
  const log = (line: string) => console.log(`[migrate-on-start] ${line}`); // eslint-disable-line no-console
  let config: ReturnType<typeof readRuntimeDbConfig>;
  try {
    config = readRuntimeDbConfig(process.env);
  } catch (error) {
    if (error instanceof RuntimeDbConfigError) {
      log(`FAILED (config): ${error.message}`);
      console.log(`${RESULT_LINE_PREFIX} ${JSON.stringify({ state: 'UNKNOWN', applied: [], pending: [], failedMigration: null, exitCode: STARTUP_EXIT_CODES.config, serve: false, policy: 'refuse', reason: 'configuration refused', checks: [] })}`); // eslint-disable-line no-console
      return STARTUP_EXIT_CODES.config;
    }
    throw error;
  }
  const refusal = migrateChildConfigRefusal(config);
  if (refusal) {
    log(`FAILED (config): ${refusal}`);
    console.log(`${RESULT_LINE_PREFIX} ${JSON.stringify({ state: 'UNKNOWN', applied: [], pending: [], failedMigration: null, exitCode: STARTUP_EXIT_CODES.config, serve: false, policy: config.upgradeFailurePolicy, reason: 'DISABLE_DB_MIGRATIONS=true: the migrate child does not run', checks: [] })}`); // eslint-disable-line no-console
    return STARTUP_EXIT_CODES.config;
  }
  let pid: number | null = null;
  installSigtermSelfCancel(process.env, () => pid, log);
  const result = await runMigrateOnStart(
    { migrationApprovalMode: config.migrationApprovalMode, upgradeFailurePolicy: config.upgradeFailurePolicy },
    { env: process.env, log, onSession: (p) => (pid = p) },
  );
  const exitCode = STARTUP_EXIT_CODES[result.outcome];
  console.log(`${RESULT_LINE_PREFIX} ${JSON.stringify({ ...result, exitCode })}`); // eslint-disable-line no-console
  return exitCode;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error';
    console.error(`[migrate-on-start] FAILED: ${message.replace(/postgres(ql)?:\/\/\S+/gi, '<url>')}`); // eslint-disable-line no-console
    process.exit(66);
  },
);
