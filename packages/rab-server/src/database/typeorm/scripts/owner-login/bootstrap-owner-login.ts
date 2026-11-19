/**
 * Database setup the Twenty way (owner decision 2026-11-18): the process entry of the bootstrap child.
 *   node packages/rab-server/dist/database/typeorm/scripts/owner-login/bootstrap-owner-login.js
 * Run ONLY by the one-shot `db-setup` service (db-setup.sh), the only holder of PG_ADMIN_URL (the bundled db's superuser or
 * your database's admin URL). It reads PG_DATABASE_URL (always the crewflow_owner URL, the very one rab-api and rab-worker
 * use) and, in modes a and b, PG_ADMIN_URL (owner-credential.ts selectDbSetupInput). It does NOT read APP_SECRET (Twenty:
 * APP_SECRET is never part of any database credential). Core: owner-bootstrap.ts.
 *
 * It writes NO file: the former credential-free target file, the crewflow_owner password file and the setup-volume lock are
 * gone (rab-api and rab-worker read PG_DATABASE_URL from their environment, like Twenty's server and worker). Concurrent runs
 * against one database are serialised by the transaction-scoped advisory lock every write takes (owner-bootstrap-sql.ts
 * OWNER_BOOTSTRAP_LOCK_KEY).
 *
 * Exit: 0 ok, 64 refusal, 70 unexpected. Prints fixed `[owner-bootstrap] ...` lines and exactly one `OWNER_BOOTSTRAP_RESULT
 * {...}` line (enums, booleans, a SQLSTATE). Never a URL, a password, a verifier, a host, a database, a login name or a
 * file path. Deliberately does NOT import dotenv: the deployment environment is the only source.
 */
import { OWNER_BOOTSTRAP_LOG_PREFIX, resultLine, runOwnerBootstrap, runOwnerHarden } from './owner-bootstrap';

/**
 * Arguments: none (db-setup) or exactly `--harden` (db-harden, owner decision M1: wait read-only until the schema is complete,
 * then remove CREATEROLE and the mark; `db-setup.sh harden`). Anything else is refused (64) before anything runs.
 */
async function main(): Promise<number> {
  const log = (line: string) => process.stdout.write(`${OWNER_BOOTSTRAP_LOG_PREFIX} ${line}\n`);
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--harden')) {
    log('The bootstrap child takes no argument, or exactly --harden. Refusing.');
    return 64;
  }
  const result = args[0] === '--harden' ? await runOwnerHarden(process.env, { log }) : await runOwnerBootstrap(process.env, { log });
  process.stdout.write(`${resultLine(result)}\n`);
  return result.exitCode;
}

main().then(
  (code) => process.exit(code),
  () => {
    // runOwnerBootstrap never throws; this is a last resort. Fixed text only: an error message can quote a value.
    process.stdout.write(`${OWNER_BOOTSTRAP_LOG_PREFIX} FAILED: unexpected error (details not shown).\n`);
    process.exit(70);
  },
);
