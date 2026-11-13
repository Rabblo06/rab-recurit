/**
 * Database setup the Twenty Helm way (OWNER-DB-FINAL.md Part A): one db-setup run per setup volume (security re-review F1,
 * R1/R2).
 *
 * Two db-setup runs on ONE setup volume must never overlap: run B could settle (delete) run A's in-flight pending password
 * file, or A could promote B's. Twenty runs its `ensure-database-exists` init container once per pod start and never
 * shares the secret's storage with a second writer (twentyhq/twenty@eedb0a73
 * packages/twenty-docker/helm/twenty/templates/deployment-server.yaml:81-130).
 *
 * The lock is the KERNEL's: db-setup.sh opens `<volume>/.db-setup.flock` on fd 9 and takes `flock -n 9` before anything
 * else; the bootstrap child inherits fd 9. The kernel releases it when the last holder dies, however it dies (SIGKILL,
 * OOM, a host reboot), so there is no staleness to guess: no pid, boot-id or age heuristics (re-check R1/R2). db-setup.sh
 * then exports CREWFLOW_DB_SETUP_FLOCK_FD=9; this module checks that fd 9 really is that file (fstat dev/ino against an
 * lstat of the path, which must be a regular file, never a symlink).
 *
 * The lock DIRECTORY `<volume>/.db-setup.lock/` (mkdir, EEXIST when present) is kept as a second layer, and as the only
 * layer for a direct run without db-setup.sh (development and the live harness, where `flock` may not exist):
 *   - under the kernel lock, a lock directory that is already there was left by a run that died: no other db-setup can be
 *     running on this volume, so it is removed and taken;
 *   - without the kernel lock, an existing lock directory is never taken over (no guessing): the run stops (exit 70) and
 *     the message says how to remove it.
 * Released by its holder: this process in a `finally`, or db-setup.sh on exit when it passed its token
 * (CREWFLOW_DB_SETUP_LOCK_TOKEN; it removes the directory only when the owner token is its own). Never logs; errors carry
 * fixed text only (never a path or a value).
 */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { dirname, join } from 'node:path';

export const DB_SETUP_LOCK_NAME = '.db-setup.lock';
export const DB_SETUP_LOCK_OWNER_FILE = 'owner';
/** The kernel lock's file (db-setup.sh: `exec 9>>"$DIR/.db-setup.flock"; flock -n 9`). */
export const DB_SETUP_FLOCK_NAME = '.db-setup.flock';
export const DB_SETUP_FLOCK_FD = 9;
/** Set to "9" by db-setup.sh only after `flock -n 9` succeeded. */
export const DB_SETUP_FLOCK_VAR = 'CREWFLOW_DB_SETUP_FLOCK_FD';
/** db-setup.sh's token (32 hex characters): the shell then owns the lock directory's release, after its own checks. */
export const DB_SETUP_LOCK_TOKEN_VAR = 'CREWFLOW_DB_SETUP_LOCK_TOKEN';
const TOKEN_SHAPE = /^[0-9a-f]{32}$/;

export const DB_SETUP_LOCK_MESSAGES = {
  held:
    'Another db-setup is running on this setup volume; nothing was changed. Start again when it has finished. (A run started without db-setup.sh that was killed leaves the .db-setup.lock directory behind: remove it only when no db-setup is running.)',
  unusable: 'The db-setup lock in the setup volume is not a plain directory. Refusing.',
} as const;

export class DbSetupLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DbSetupLockError';
  }
}

/** The environment this module observes (a test seam). */
export interface DbSetupLockIo {
  /** True when this process holds the volume's kernel lock (fd 9, verified). */
  volumeFlockHeld(targetFilePath: string, env: Record<string, string | undefined>): boolean;
  /** Called between "an existing lock directory is judged left behind" and its removal (a test seam for interleaving). */
  beforeTakeover?(): void;
}

/** fd 9 is the volume's `.db-setup.flock` (same device and inode as the path, a regular file, not a symlink). */
export function volumeFlockHeld(targetFilePath: string, env: Record<string, string | undefined>): boolean {
  if (env[DB_SETUP_FLOCK_VAR] !== String(DB_SETUP_FLOCK_FD)) return false;
  try {
    const path = join(dirname(targetFilePath), DB_SETUP_FLOCK_NAME);
    const byPath = fs.lstatSync(path);
    const byFd = fs.fstatSync(DB_SETUP_FLOCK_FD);
    return byPath.isFile() && !byPath.isSymbolicLink() && byFd.isFile() && byFd.dev === byPath.dev && byFd.ino === byPath.ino;
  } catch {
    return false;
  }
}

const realIo: DbSetupLockIo = { volumeFlockHeld };

/** The lock directory of a target file path: the same directory (one volume). */
export function dbSetupLockPath(targetFilePath: string): string {
  return join(dirname(targetFilePath), DB_SETUP_LOCK_NAME);
}

function ownerToken(lock: string): string | null {
  try {
    const raw = JSON.parse(fs.readFileSync(join(lock, DB_SETUP_LOCK_OWNER_FILE), 'utf8')) as { v?: unknown; token?: unknown };
    return raw?.v === 1 && typeof raw.token === 'string' ? raw.token : null;
  } catch {
    return null;
  }
}

/** The lock path must be a real directory (never a symlink): lstat, so nothing is followed. */
function assertPlainDirectory(lock: string): fs.Stats {
  const st = fs.lstatSync(lock);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new DbSetupLockError(DB_SETUP_LOCK_MESSAGES.unusable);
  return st;
}

function removeLockDirectory(lock: string): void {
  try {
    fs.unlinkSync(join(lock, DB_SETUP_LOCK_OWNER_FILE));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  fs.rmdirSync(lock);
}

export interface DbSetupLock {
  /** Releases the lock directory if (and only if) it is still this run's. Never throws. */
  release(): void;
  /** True when db-setup.sh owns the release (its token was used). */
  readonly releasedByShell: boolean;
  /** True when the volume's kernel lock is held too (always, under db-setup.sh). */
  readonly kernelLock: boolean;
}

/**
 * Takes the lock of the volume that holds `targetFilePath` (see the header). Throws DbSetupLockError (held / unusable). The
 * token is db-setup.sh's (CREWFLOW_DB_SETUP_LOCK_TOKEN, when well-formed) or a new random one.
 */
export function acquireDbSetupLock(targetFilePath: string, env: Record<string, string | undefined> = process.env, io: DbSetupLockIo = realIo): DbSetupLock {
  const lock = dbSetupLockPath(targetFilePath);
  const shellToken = env[DB_SETUP_LOCK_TOKEN_VAR];
  const releasedByShell = typeof shellToken === 'string' && TOKEN_SHAPE.test(shellToken);
  const token = releasedByShell ? (shellToken as string) : randomBytes(16).toString('hex');
  const kernelLock = io.volumeFlockHeld(targetFilePath, env);
  try {
    fs.mkdirSync(lock, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const judged = assertPlainDirectory(lock);
    const judgedToken = ownerToken(lock);
    // Without the kernel lock nothing proves the directory's owner is gone: never taken over.
    if (!kernelLock) throw new DbSetupLockError(DB_SETUP_LOCK_MESSAGES.held);
    // Under the kernel lock no other db-setup runs on this volume: the directory was left by a run that died. Even so the
    // takeover is atomic: the directory is renamed to this run's tombstone, and only when the tombstone is the SAME
    // directory that was judged (device + inode AND the same owner token: a file system may reuse a freed inode number at
    // once) is it removed; otherwise it is put back and this run stops (exactly one of two interleaved takers wins).
    io.beforeTakeover?.();
    const tombstone = `${lock}.stale-${token}`;
    try {
      fs.renameSync(lock, tombstone);
    } catch (moveError) {
      if ((moveError as NodeJS.ErrnoException).code === 'ENOENT') throw new DbSetupLockError(DB_SETUP_LOCK_MESSAGES.held);
      throw moveError;
    }
    const moved = fs.lstatSync(tombstone);
    if (moved.dev !== judged.dev || moved.ino !== judged.ino || ownerToken(tombstone) !== judgedToken) {
      try {
        fs.renameSync(tombstone, lock);
      } catch {
        /* the path was taken again meanwhile: leave the tombstone, never another run's lock */
      }
      throw new DbSetupLockError(DB_SETUP_LOCK_MESSAGES.held);
    }
    removeLockDirectory(tombstone);
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
    } catch (again) {
      if ((again as NodeJS.ErrnoException).code === 'EEXIST') throw new DbSetupLockError(DB_SETUP_LOCK_MESSAGES.held);
      throw again;
    }
  }
  try {
    fs.writeFileSync(join(lock, DB_SETUP_LOCK_OWNER_FILE), JSON.stringify({ v: 1, token }), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    try {
      fs.rmdirSync(lock);
    } catch {
      /* best effort */
    }
    throw error;
  }
  return {
    releasedByShell,
    kernelLock,
    release() {
      try {
        assertPlainDirectory(lock);
        if (ownerToken(lock) === token) removeLockDirectory(lock);
      } catch {
        /* already gone, or not ours: never remove another run's lock */
      }
    },
  };
}

/** The temp-file names owner-password-file.ts and db-target-file.ts create: `.<file>.<pid>.<12 hex>.tmp`. */
const TEMP_FILE = /^\.(owner-password|owner-password\.next|target\.json)\.\d+\.[0-9a-f]{12}\.tmp$/;

/**
 * Removes the temp files a killed earlier run left in the setup volume (call only while holding the lock: a running
 * writer's temp file is never touched). The pending `owner-password.next` is NOT a temp file: it is settled by the
 * bootstrap. Returns how many were removed. Never follows a link (unlink removes the name only).
 */
export function removeLeftoverTempFiles(targetFilePath: string): number {
  const dir = dirname(targetFilePath);
  let removed = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!TEMP_FILE.test(name)) continue;
    try {
      fs.unlinkSync(join(dir, name));
      removed += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return removed;
}
