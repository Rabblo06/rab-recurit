/**
 * Database setup like Twenty (DB-SETUP-PLAN §2.1, §5.1, §5.3): the derive step.
 *
 * Option A (PR #125): in a deployment the API and the Worker get CREWFLOW_DB_TARGET_FILE and NO PG_DATABASE_URL. The
 * one-shot db-setup service (the only holder of the admin URL) runs the bootstrap child, which publishes the
 * credential-free target there; this step builds the crewflow_owner URL from it plus HKDF(APP_SECRET). Exit 75 while the
 * file is missing or empty (not ready yet), 64 for a malformed one, and 64 when a non-owner PG_DATABASE_URL is ALSO set
 * (the apps must never hold the admin URL). A crewflow_owner PG_DATABASE_URL is still the pass-through mode.
 * PURE: it NEVER connects and never imports
 * `pg` (a spec fails if it does). It reads `PG_DATABASE_URL` + `APP_SECRET` and writes the crewflow_owner runtime URL to
 * file descriptor 4, the existing command-substitution pattern of api-prestart.sh (rab-api is read_only with no tmpfs,
 * so never a file, never argv, never stdout):
 *
 *   RUNTIME_URL="$(node packages/rab-server/dist/database/typeorm/scripts/owner-login/derive-runtime-url.js 4>&1 1>&2)"
 *
 * api-prestart.sh (after the bootstrap child) and worker-start.sh both run it, so both build byte-identical URLs.
 * Pass-through (§7.1): a crewflow_owner `PG_DATABASE_URL` is written back unchanged (byte for byte once surrounding
 * whitespace is trimmed, as every reader of the variable trims it), and APP_SECRET is not
 * read. Exit codes: 0 written, 64 refusal (fixed message on stderr), 70 unexpected. Output is fixed text only: never the
 * URL, a password, a host or a database name. No trailing newline on fd 4 (the value is exactly the URL).
 */
import { writeSync } from 'node:fs';

import { readPrimaryDatabaseUrl } from '../../../postgres/pg-config';
import {
  DB_TARGET_FILE_VAR,
  DbTargetError,
  runtimeUrlFromDbTarget,
} from '../../../owner-login/db-target';
import {
  dbTargetFilePath,
  readDbTargetFile,
} from '../../../owner-login/db-target-file';
import {
  deriveOwnerPassword,
  isOwnerLoginUrl,
  OwnerCredentialError,
  type OwnerLoginPlan,
  planOwnerLogin,
} from '../../../owner-login/owner-credential';

/** The descriptor the runtime URL is written to. */
export const RUNTIME_URL_FD = 4;
/** 75 (EX_TEMPFAIL): the db-setup step has not published the database target yet; the restart policy retries. */
export const DERIVE_EXIT = {
  ok: 0,
  refused: 64,
  unexpected: 70,
  notReady: 75,
} as const;
const PREFIX = 'derive-runtime-url:';

export const DERIVE_MESSAGES = {
  passThrough: `${PREFIX} PG_DATABASE_URL is the crewflow_owner login; the runtime URL is PG_DATABASE_URL unchanged.`,
  bootstrap: `${PREFIX} the crewflow_owner runtime URL was built from the admin PG_DATABASE_URL and APP_SECRET.`,
  fromTarget: `${PREFIX} the crewflow_owner runtime URL was built from the database target and APP_SECRET.`,
  targetNotReady: `${PREFIX} db target not ready: the db-setup step has not published ${DB_TARGET_FILE_VAR} yet (the restart policy retries).`,
  targetWithAdminUrl: `${PREFIX} ${DB_TARGET_FILE_VAR} and a PG_DATABASE_URL that is not the crewflow_owner login are both set. The API and the Worker must never hold the database admin URL: remove PG_DATABASE_URL from this service. Refusing.`,
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

const processIo: DeriveIo = {
  writeRuntimeUrl: (url) => {
    writeSync(RUNTIME_URL_FD, url);
  },
  log: (line) => process.stdout.write(`${line}\n`),
  error: (line) => process.stderr.write(`${line}\n`),
};

/**
 * The whole step, testable: returns the exit code. Reads ONLY PG_DATABASE_URL (through readPrimaryDatabaseUrl, so the value
 * is trimmed), CREWFLOW_DB_TARGET_FILE and APP_SECRET from `env`.
 */
export function runDeriveRuntimeUrl(
  env: Record<string, string | undefined>,
  io: DeriveIo = processIo,
): number {
  // Option A (PR #125): the apps get CREWFLOW_DB_TARGET_FILE (written by the db-setup service) instead of the admin URL.
  const primary = readPrimaryDatabaseUrl(env);
  const databaseUrl =
    primary?.name === 'PG_DATABASE_URL' ? primary.value : undefined;
  if (env[DB_TARGET_FILE_VAR]?.trim()) {
    if (databaseUrl === undefined) return deriveFromTarget(env, io);
    let ownerUrl = false;
    try {
      ownerUrl = isOwnerLoginUrl(databaseUrl);
    } catch {
      ownerUrl = false;
    }
    if (!ownerUrl) {
      io.error(DERIVE_MESSAGES.targetWithAdminUrl);
      return DERIVE_EXIT.refused;
    }
    // A crewflow_owner PG_DATABASE_URL is the pass-through mode below; the target file plays no part.
  }

  let plan: OwnerLoginPlan;
  try {
    // The shared reader (pure: pg-config imports no driver). Only PG_DATABASE_URL counts here: the legacy DATABASE_URL
    // fallback it offers outside production is not a deployment variable, and the shell exports PG_DATABASE_URL only.
    plan = planOwnerLogin({ databaseUrl, appSecret: env.APP_SECRET });
  } catch (error) {
    if (error instanceof OwnerCredentialError) {
      io.error(`${PREFIX} ${error.message}`);
      return DERIVE_EXIT.refused;
    }
    io.error(DERIVE_MESSAGES.unexpected);
    return DERIVE_EXIT.unexpected;
  }
  const failed = writeUrl(plan.runtimeUrl, io);
  if (failed !== null) return failed;
  io.log(
    plan.mode === 'pass-through'
      ? DERIVE_MESSAGES.passThrough
      : DERIVE_MESSAGES.bootstrap,
  );
  return DERIVE_EXIT.ok;
}

function writeUrl(url: string, io: DeriveIo): number | null {
  try {
    io.writeRuntimeUrl(url);
    return null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    io.error(
      code === 'EBADF' ? DERIVE_MESSAGES.fdNotOpen : DERIVE_MESSAGES.unexpected,
    );
    return code === 'EBADF' ? DERIVE_EXIT.refused : DERIVE_EXIT.unexpected;
  }
}

/**
 * Option A: the runtime URL from the credential-free target file plus HKDF(APP_SECRET). Missing or empty file: 75 (not
 * ready). Malformed file, a refused connection shape, a bad APP_SECRET: 64. The URL is built by runtimeUrlFromDbTarget,
 * i.e. buildRuntimeDatabaseUrl's policy, rebuild and round-trip check.
 */
function deriveFromTarget(
  env: Record<string, string | undefined>,
  io: DeriveIo,
): number {
  let url: string;
  try {
    const read = readDbTargetFile(dbTargetFilePath(env));
    if (read.state === 'missing') {
      io.error(DERIVE_MESSAGES.targetNotReady);
      return DERIVE_EXIT.notReady;
    }
    url = runtimeUrlFromDbTarget(read.target, deriveOwnerPassword(env.APP_SECRET));
  } catch (error) {
    if (
      error instanceof DbTargetError ||
      error instanceof OwnerCredentialError
    ) {
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
