/**
 * OWNER-DB-ULTIMATE Part B3: the MANUAL upgrade command, Twenty's `upgrade` with `--force`
 * (twentyhq/twenty @ eedb0a73 `database/commands/run-instance-commands.command.ts:43-50` the option, `:127-133` the skip;
 * re-implemented, not copied). Run by an operator, never by the start path:
 *
 *   docker compose run --rm --no-deps rab-api node packages/rab-server/dist/command upgrade [--force]
 *
 * It is the migrate-on-start run itself (same lock, same classifier, identity, PG / role refusals, post-checks, logbook),
 * with one difference: `--force` skips ONLY the previous-version check, logs it loudly, and every logbook row of the run
 * records forced = true. `force` is reachable only through this argv parser: no environment variable maps to it, and the
 * automatic child (twenty-migrate.ts) never passes it. Deliberately does NOT import dotenv (like the child).
 *
 * Exit codes: the child's STARTUP_EXIT_CODES (0 ok, 64 config, 65 too old, 66 migration failed, 67 identity, 68 post-check,
 * 69 lock timeout, 70 an upgrade command failed). Prints the TWENTY_MIGRATE_RESULT line, then a short status.
 */
import { readRuntimeDbConfig, RuntimeDbConfigError, STARTUP_EXIT_CODES } from '../database/owner-login/runtime-db-config';
import { installSigtermSelfCancel, RESULT_LINE_PREFIX, runMigrateOnStart } from '../database/typeorm/scripts/migrate/owner-login/migrate-on-start';

export class UpgradeCommandUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpgradeCommandUsageError';
  }
}

/** Pure: `upgrade [--force|-f]`; anything else refuses. */
export function parseUpgradeArgs(args: readonly string[]): { force: boolean } {
  let force = false;
  for (const arg of args) {
    if (arg === '--force' || arg === '-f') force = true;
    else throw new UpgradeCommandUsageError(`upgrade: unknown argument ${JSON.stringify(arg.slice(0, 40))}. Usage: upgrade [--force]`);
  }
  return { force };
}

export async function runUpgradeCommand(args: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const log = (line: string) => console.log(`[upgrade] ${line}`); // eslint-disable-line no-console
  let force: boolean;
  try {
    ({ force } = parseUpgradeArgs(args));
  } catch (error) {
    log(error instanceof Error ? error.message : 'bad arguments');
    return STARTUP_EXIT_CODES.config;
  }
  let config: ReturnType<typeof readRuntimeDbConfig>;
  try {
    config = readRuntimeDbConfig(env);
  } catch (error) {
    if (error instanceof RuntimeDbConfigError) {
      log(`FAILED (config): ${error.message}`);
      return STARTUP_EXIT_CODES.config;
    }
    throw error;
  }
  if (force) log('*** --force: the previous-version check will be SKIPPED for this run (not recommended); every logbook row is marked forced ***');
  let pid: number | null = null;
  installSigtermSelfCancel(env, () => pid, log);
  const result = await runMigrateOnStart(
    { migrationApprovalMode: config.migrationApprovalMode },
    { env, log, onSession: (p) => (pid = p), ...(force ? { upgradeForce: true as const } : {}) },
  );
  const exitCode = STARTUP_EXIT_CODES[result.outcome];
  console.log(`${RESULT_LINE_PREFIX} ${JSON.stringify({ ...result, exitCode })}`); // eslint-disable-line no-console
  const u = result.upgrade;
  log(
    u
      ? `code ${u.codeVersion}: ${u.decision ?? 'not checked'}${u.adoptedFrom ? ` (adopted ${u.adoptedFrom})` : ''}; recorded ${u.recorded.map((r) => `${r.name}=${r.status}#${r.attempt}`).join(', ') || 'nothing'}${u.commandFailure ? `; command FAILED: ${u.commandFailure.name}` : ''}`
      : 'the upgrade check did not run',
  );
  return exitCode;
}
