/**
 * DB setup like Twenty (DB-SETUP-PLAN §2.1 / §3, area 2): the process entry of the bootstrap child. api-prestart.sh runs
 *   node packages/rab-server/dist/database/typeorm/scripts/owner-login/bootstrap-owner-login.js
 * with the container's PG_DATABASE_URL (the database ADMIN URL, or a crewflow_owner URL = pass-through) and APP_SECRET,
 * BEFORE the derive step and the migrate child. It is the only process that ever connects as the admin. Core:
 * owner-bootstrap.ts.
 *
 * Exit: 0 ok (crewflow_owner ready, or pass-through), 64 refusal, 70 unexpected. Prints fixed `[owner-bootstrap] ...` lines
 * and exactly one `OWNER_BOOTSTRAP_RESULT {...}` line (enums, booleans, a SQLSTATE). Never a URL, a password, a verifier,
 * a host, a database or a login name. Deliberately does NOT import dotenv: the deployment environment is the only source.
 */
import { OWNER_BOOTSTRAP_LOG_PREFIX, resultLine, runOwnerBootstrap } from './owner-bootstrap';

async function main(): Promise<number> {
  const result = await runOwnerBootstrap(process.env, {
    log: (line) => process.stdout.write(`${OWNER_BOOTSTRAP_LOG_PREFIX} ${line}\n`),
  });
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
