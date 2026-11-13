/**
 * Database setup the Twenty Helm way (OWNER-DB-FINAL.md Part A): the apps' derive step.
 *
 * In a deployment the API and the Worker get CREWFLOW_DB_TARGET_FILE and NEVER PG_DATABASE_URL. The one-shot db-setup
 * service (the only holder of PG_DATABASE_URL) writes two files on its volume, which the apps mount read-only:
 *   - the credential-free target (host, port, database, TLS parameters; db-target.ts), and
 *   - the crewflow_owner password file beside it (owner-password-file.ts).
 * This step builds the crewflow_owner URL from the two (Twenty: the server and the worker receive only the app user's URL,
 * twentyhq/twenty@eedb0a73 `packages/twenty-docker/helm/twenty/templates/deployment-server.yaml:142-156`,
 * `deployment-worker.yaml:76-90`). APP_SECRET plays no part.
 *
 * PURE: it NEVER connects and never imports `pg` (a spec fails if it does). It writes the runtime URL to file descriptor 4,
 * the command-substitution pattern of api-prestart.sh / worker-start.sh (never a file, never argv, never stdout):
 *
 *   RUNTIME_URL="$(node packages/rab-server/dist/database/typeorm/scripts/owner-login/derive-runtime-url.js 4>&1 1>&2)"
 *
 * Exit codes: 0 written; 75 (EX_TEMPFAIL) the target or the password file is not there yet (db-setup has not finished; the
 * scripts wait, bounded); 64 refusal (a malformed file, any PG_DATABASE_URL beside the target file, no target file and no
 * crewflow_owner PG_DATABASE_URL); 70 unexpected. Output is fixed text only: never the URL, a password, a host or a
 * database name. No trailing newline on fd 4 (the value is exactly the URL).
 *
 * Without CREWFLOW_DB_TARGET_FILE (development only): a crewflow_owner PG_DATABASE_URL is written back unchanged; any other
 * login is refused (there is nothing to build a crewflow_owner password from).
 */
import { readlinkSync, writeSync } from 'node:fs';

import { readPrimaryDatabaseUrl } from '../../../postgres/pg-config';
import { DB_TARGET_FILE_VAR, DbTargetError, runtimeUrlFromDbTarget } from '../../../owner-login/db-target';
import { dbTargetFilePath, readDbTargetFile } from '../../../owner-login/db-target-file';
import { isOwnerLoginUrl, OwnerCredentialError } from '../../../owner-login/owner-credential';
import { OwnerPasswordFileError, ownerPasswordFilePath, readOwnerPasswordFile } from '../../../owner-login/owner-password-file';

/** The descriptor the runtime URL is written to. */
export const RUNTIME_URL_FD = 4;
/** 75 (EX_TEMPFAIL): the db-setup step has not published the target / password file yet; the scripts wait. */
export const DERIVE_EXIT = {
  ok: 0,
  refused: 64,
  unexpected: 70,
  notReady: 75,
} as const;
const PREFIX = 'derive-runtime-url:';

export const DERIVE_MESSAGES = {
  passThrough: `${PREFIX} PG_DATABASE_URL is the crewflow_owner login (development, no target file); the runtime URL is PG_DATABASE_URL unchanged.`,
  fromTarget: `${PREFIX} the crewflow_owner runtime URL was built from the database target and the crewflow_owner password file.`,
  targetNotReady: `${PREFIX} db target not ready: the db-setup step has not published ${DB_TARGET_FILE_VAR} yet (the start script waits).`,
  passwordNotReady: `${PREFIX} the crewflow_owner password file is not there yet: the db-setup step has not finished (the start script waits).`,
  targetWithAdminUrl: `${PREFIX} ${DB_TARGET_FILE_VAR} and PG_DATABASE_URL are both set. The API and the Worker never hold PG_DATABASE_URL (any login): only the db-setup service does. Remove PG_DATABASE_URL from this service. Refusing.`,
  noTargetNoOwnerUrl: `${PREFIX} no ${DB_TARGET_FILE_VAR} and no crewflow_owner PG_DATABASE_URL: there is no crewflow_owner credential to use. Refusing.`,
  fdNotOpen: `${PREFIX} file descriptor ${RUNTIME_URL_FD} is not open. Run it as: RUNTIME_URL="$(node derive-runtime-url.js ${RUNTIME_URL_FD}>&1 1>&2)".`,
  unexpected: `${PREFIX} FAILED: unexpected error (details not shown).`,
} as const;

export interface DeriveIo {
  /** Writes the runtime URL (the secret) to its descriptor. Throws when the descriptor is not open. */
  writeRuntimeUrl: (url: string) => void;
  /** Fixed, value-free lines only. */
  log: (line: string) => void;
  error: (line: string) => void;
}

/**
 * Linux: fd 4 must be one the CALLER opened. When the caller opened none, the runtime may already use descriptor 4 for
 * itself (libuv's epoll / eventfd / io_uring descriptors, `anon_inode:[...]`): writing the URL there would neither reach
 * the caller nor fail cleanly. Such a descriptor counts as "not open" (EBADF -> exit 64 with the usage line).
 */
function assertCallerOpenedRuntimeUrlFd(): void {
  if (process.platform !== 'linux') return;
  let target: string;
  try {
    target = readlinkSync(`/proc/self/fd/${RUNTIME_URL_FD}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') throw Object.assign(new Error('fd not open'), { code: 'EBADF' });
    return; // no /proc: the write below decides
  }
  if (target.startsWith('anon_inode:')) throw Object.assign(new Error('fd not open'), { code: 'EBADF' });
}

const processIo: DeriveIo = {
  writeRuntimeUrl: (url) => {
    assertCallerOpenedRuntimeUrlFd();
    writeSync(RUNTIME_URL_FD, url);
  },
  log: (line) => process.stdout.write(`${line}\n`),
  error: (line) => process.stderr.write(`${line}\n`),
};

/** The whole step, testable: returns the exit code. Reads ONLY PG_DATABASE_URL and CREWFLOW_DB_TARGET_FILE from `env`. */
export function runDeriveRuntimeUrl(env: Record<string, string | undefined>, io: DeriveIo = processIo): number {
  const primary = readPrimaryDatabaseUrl(env);
  const databaseUrl = primary?.name === 'PG_DATABASE_URL' ? primary.value : undefined;
  if (env[DB_TARGET_FILE_VAR]?.trim()) {
    // The apps NEVER hold PG_DATABASE_URL (any login, crewflow_owner included): only db-setup does.
    if (databaseUrl !== undefined) {
      io.error(DERIVE_MESSAGES.targetWithAdminUrl);
      return DERIVE_EXIT.refused;
    }
    return deriveFromFiles(env, io);
  }
  // Development only: a crewflow_owner URL passes through unchanged.
  let owner = false;
  try {
    owner = databaseUrl !== undefined && isOwnerLoginUrl(databaseUrl);
  } catch (error) {
    if (error instanceof OwnerCredentialError) {
      io.error(`${PREFIX} ${error.message}`);
      return DERIVE_EXIT.refused;
    }
    io.error(DERIVE_MESSAGES.unexpected);
    return DERIVE_EXIT.unexpected;
  }
  if (!owner || databaseUrl === undefined) {
    io.error(DERIVE_MESSAGES.noTargetNoOwnerUrl);
    return DERIVE_EXIT.refused;
  }
  const failed = writeUrl(databaseUrl, io);
  if (failed !== null) return failed;
  io.log(DERIVE_MESSAGES.passThrough);
  return DERIVE_EXIT.ok;
}

function writeUrl(url: string, io: DeriveIo): number | null {
  try {
    io.writeRuntimeUrl(url);
    return null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    io.error(code === 'EBADF' ? DERIVE_MESSAGES.fdNotOpen : DERIVE_MESSAGES.unexpected);
    return code === 'EBADF' ? DERIVE_EXIT.refused : DERIVE_EXIT.unexpected;
  }
}

/**
 * The runtime URL from the credential-free target file plus the crewflow_owner password file (both written by db-setup).
 * The target missing or empty, or the password file missing: 75 (not ready). Malformed (an EMPTY password file included,
 * security review L2; a symlink, a FIFO, a wrong owner or mode): 64. Only `owner-password` is read, never the pending
 * `owner-password.next`. The URL is built by runtimeUrlFromDbTarget, i.e.
 * buildRuntimeDatabaseUrl's policy, rebuild and round-trip check.
 */
function deriveFromFiles(env: Record<string, string | undefined>, io: DeriveIo): number {
  let url: string;
  try {
    const targetPath = dbTargetFilePath(env);
    const target = readDbTargetFile(targetPath);
    if (target.state === 'missing') {
      io.error(DERIVE_MESSAGES.targetNotReady);
      return DERIVE_EXIT.notReady;
    }
    const password = readOwnerPasswordFile(ownerPasswordFilePath(targetPath));
    if (password.state === 'missing') {
      io.error(DERIVE_MESSAGES.passwordNotReady);
      return DERIVE_EXIT.notReady;
    }
    url = runtimeUrlFromDbTarget(target.target, password.password);
  } catch (error) {
    if (error instanceof DbTargetError || error instanceof OwnerCredentialError || error instanceof OwnerPasswordFileError) {
      io.error(`${PREFIX} ${error.message}`);
      return DERIVE_EXIT.refused;
    }
    io.error(DERIVE_MESSAGES.unexpected);
    return DERIVE_EXIT.unexpected;
  }
  const failed = writeUrl(url, io);
  if (failed !== null) return failed;
  io.log(DERIVE_MESSAGES.fromTarget);
  return DERIVE_EXIT.ok;
}

if (require.main === module) {
  process.exitCode = runDeriveRuntimeUrl(process.env);
}
