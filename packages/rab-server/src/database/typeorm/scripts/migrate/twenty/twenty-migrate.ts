/**
 * Owner-login architecture (PR 3): the process entry of the migrate-on-start child (core: ../owner-login/migrate-on-start.ts;
 * the path keeps the name agreed with api-prestart.sh and Agent 5 before the owner-login rename). api-prestart.sh runs
 *   node packages/rab-server/dist/database/typeorm/scripts/migrate/twenty/twenty-migrate.js
 * only when CREWFLOW_MIGRATE_ON_START=true, and execs main.js only on exit 0 (ok) or 70 (OWNER-DB-ULTIMATE Part B3: only an
 * upgrade COMMAND failed, the schema matches the code; the API serves with upgrade:"failed"). Settings come from Agent 2's runtime-db-config.ts (one source of truth); exit codes are its
 * STARTUP_EXIT_CODES. Prints exactly one TWENTY_MIGRATE_RESULT line. Deliberately does NOT import dotenv.
 */
import { checkRuntimeLogin, readRuntimeDbConfig, RuntimeDbConfigError, STARTUP_EXIT_CODES } from '../../../../owner-login/runtime-db-config';
import { installSigtermSelfCancel, migrateChildConfigRefusal, RESULT_LINE_PREFIX, runMigrateOnStart } from '../owner-login/migrate-on-start';

async function main(): Promise<number> {
  const log = (line: string) => console.log(`[migrate-on-start] ${line}`); // eslint-disable-line no-console
  let config: ReturnType<typeof readRuntimeDbConfig>;
  try {
    config = readRuntimeDbConfig(process.env);
    // DB-SETUP (plan §2.2): in production the migrate child connects ONLY as crewflow_owner; any other PG_DATABASE_URL login
    // (e.g. the admin URL, if api-prestart.sh did not swap it) is refused here, before anything connects (exit 64).
    const { warning } = checkRuntimeLogin(process.env, 'migrate');
    if (warning) log(`WARNING: ${warning}`);
  } catch (error) {
    if (error instanceof RuntimeDbConfigError) {
      log(`FAILED (config): ${error.message}`);
      console.log(`${RESULT_LINE_PREFIX} ${JSON.stringify({ state: 'UNKNOWN', applied: [], pending: [], failedMigration: null, exitCode: STARTUP_EXIT_CODES.config, serve: false, reason: 'configuration refused', checks: [] })}`); // eslint-disable-line no-console
      return STARTUP_EXIT_CODES.config;
    }
    throw error;
  }
  const refusal = migrateChildConfigRefusal(config);
  if (refusal) {
    log(`FAILED (config): ${refusal}`);
    console.log(`${RESULT_LINE_PREFIX} ${JSON.stringify({ state: 'UNKNOWN', applied: [], pending: [], failedMigration: null, exitCode: STARTUP_EXIT_CODES.config, serve: false, reason: 'DISABLE_DB_MIGRATIONS=true: the migrate child does not run', checks: [] })}`); // eslint-disable-line no-console
    return STARTUP_EXIT_CODES.config;
  }
  let pid: number | null = null;
  installSigtermSelfCancel(process.env, () => pid, log);
  const result = await runMigrateOnStart(
    { migrationApprovalMode: config.migrationApprovalMode },
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
