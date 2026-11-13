/**
 * Database setup the Twenty Helm way (OWNER-DB-FINAL.md Part A): the process entry of the bootstrap child.
 *   node packages/rab-server/dist/database/typeorm/scripts/owner-login/bootstrap-owner-login.js
 * Run ONLY by the one-shot `db-setup` service (db-setup.sh), the only holder of PG_DATABASE_URL (the bundled db's superuser,
 * a client's admin URL, or an existing crewflow_owner URL). It does NOT read APP_SECRET (Twenty: APP_SECRET is never part
 * of any database credential). Core: owner-bootstrap.ts.
 *
 * Files, on db-setup's volume (rab-api and rab-worker mount it read-only):
 *   - CREWFLOW_DB_TARGET_FILE (default /run/crewflow/db-target/target.json): the credential-free target, written on
 *     success (atomic rename, 0644) and removed after a refusal or failure, so the apps keep waiting (exit 75);
 *   - `owner-password` beside it: the crewflow_owner password (owner-password-file.ts; atomic rename, 0400). Twenty's
 *     equivalent is the app user's own secret (twentyhq/twenty@eedb0a73 helm/twenty/templates/secret-db-url.yaml:3-8). It is
 *     NEVER removed by this process;
 *   - `owner-password.next`: a NEW password, stored exclusively before any database change and renamed over
 *     `owner-password` only after the COMMIT and a login with it; a later start promotes it if it logs in and deletes it
 *     otherwise (security review L1).
 *
 * Exit: 0 ok, 64 refusal, 70 unexpected. Prints fixed `[owner-bootstrap] ...` lines and exactly one `OWNER_BOOTSTRAP_RESULT
 * {...}` line (enums, booleans, a SQLSTATE). Never a URL, a password, a verifier, a host, a database, a login name or a
 * file path. Deliberately does NOT import dotenv: the deployment environment is the only source.
 */
import { DbTargetError } from '../../../owner-login/db-target';
import { dbTargetFilePath, removeDbTargetFile, writeDbTargetFile } from '../../../owner-login/db-target-file';
import {
  ownerPasswordFilePath,
  ownerPasswordNextFilePath,
  promoteOwnerPasswordFile,
  readOwnerPasswordFile,
  removeOwnerPasswordFile,
  writeOwnerPasswordFile,
} from '../../../owner-login/owner-password-file';
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
  const passwordFile = ownerPasswordFilePath(targetFile);
  const nextFile = ownerPasswordNextFilePath(passwordFile);
  const result = await runOwnerBootstrap(process.env, {
    log,
    passwordFiles: {
      readMain: () => readOwnerPasswordFile(passwordFile),
      readNext: () => readOwnerPasswordFile(nextFile),
      writeMain: (password) => writeOwnerPasswordFile(passwordFile, password),
      writeNextExclusive: (password) => writeOwnerPasswordFile(nextFile, password, { exclusive: true }),
      promoteNext: () => promoteOwnerPasswordFile(nextFile, passwordFile),
      removeNext: () => removeOwnerPasswordFile(nextFile),
    },
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
