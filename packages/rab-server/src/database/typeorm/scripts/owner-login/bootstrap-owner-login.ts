/**
 * DB setup like Twenty (DB-SETUP-PLAN §2.1 / §3, area 2): the process entry of the bootstrap child.
 *   node packages/rab-server/dist/database/typeorm/scripts/owner-login/bootstrap-owner-login.js
 * with PG_DATABASE_URL (the database ADMIN URL, or a crewflow_owner URL = pass-through) and APP_SECRET. It is the only
 * process that ever connects as the admin. Core: owner-bootstrap.ts.
 *
 * Option A (PR #125): run by the one-shot `db-setup` service, the ONLY holder of the admin URL. On success it writes the
 * credential-free database target (owner-login/db-target.ts) to CREWFLOW_DB_TARGET_FILE (default
 * /run/crewflow/db-target/target.json; atomic rename, mode 0644); after a refusal or failure it removes any stale one, so
 * the apps' derive step keeps waiting (exit 75). Pass-through (a crewflow_owner URL) writes nothing.
 *
 * Exit: 0 ok (crewflow_owner ready, or pass-through), 64 refusal, 70 unexpected. Prints fixed `[owner-bootstrap] ...` lines
 * and exactly one `OWNER_BOOTSTRAP_RESULT {...}` line (enums, booleans, a SQLSTATE). Never a URL, a password, a verifier,
 * a host, a database, a login name or the target file's path. Deliberately does NOT import dotenv: the deployment
 * environment is the only source.
 */
import { DbTargetError } from '../../../owner-login/db-target';
import { dbTargetFilePath, removeDbTargetFile, writeDbTargetFile } from '../../../owner-login/db-target-file';
import { failureResult, OWNER_BOOTSTRAP_LOG_PREFIX, OwnerBootstrapRefusal, resultLine, runOwnerBootstrap } from './owner-bootstrap';

async function main(): Promise<number> {
  const log = (line: string) => process.stdout.write(`${OWNER_BOOTSTRAP_LOG_PREFIX} ${line}\n`);
  let targetFile: string;
  try {
    targetFile = dbTargetFilePath(process.env);
  } catch (error) {
    const message = error instanceof DbTargetError ? error.message : 'CREWFLOW_DB_TARGET_FILE is not usable. Refusing.';
    log(message);
    const refused = failureResult(new OwnerBootstrapRefusal(message));
    process.stdout.write(`${resultLine(refused)}\n`);
    return refused.exitCode;
  }
  const result = await runOwnerBootstrap(process.env, {
    log,
    publishTarget: (target) => writeDbTargetFile(targetFile, target),
    withdrawTarget: () => removeDbTargetFile(targetFile),
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
