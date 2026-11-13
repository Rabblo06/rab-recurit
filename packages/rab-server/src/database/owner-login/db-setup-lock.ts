/**
 * Database setup the Twenty Helm way (OWNER-DB-FINAL.md Part A): the per-volume run lock (security re-review F1).
 *
 * Two db-setup runs on ONE setup volume must never overlap: run B could settle (delete) run A's in-flight pending password
 * file, or A could promote B's. Twenty runs its `ensure-database-exists` init container once per pod start and never
 * shares the secret's storage with a second writer (twentyhq/twenty@eedb0a73
 * packages/twenty-docker/helm/twenty/templates/deployment-server.yaml:81-130); Crewflow's equivalent of "one writer" is an
 * exclusive lock DIRECTORY in the volume itself, so it holds for any number of containers sharing the volume and needs no
 * database (no new SQL).
 *
 *   `<volume>/.db-setup.lock/`        created with mkdir (atomic, EEXIST when held), mode 0700;
 *   `<volume>/.db-setup.lock/owner`   {"v":1,"token","host","pid","boot","started"}: who holds it.
 *
 * Released by the holder: by this process in a `finally`, or, when db-setup.sh passed its token
 * (CREWFLOW_DB_SETUP_LOCK_TOKEN), by db-setup.sh on exit (it removes the lock only when the owner token is its own). A lock
 * left by a run that was killed is STALE, and taken over, when: the host's boot id differs (a reboot); or it was taken on
 * this host (same container hostname) by a pid that is gone or is this process; or it is older than
 * DB_SETUP_LOCK_STALE_MS (a db-setup run is bounded far below that). Otherwise the run stops (exit 70, fixed text).
 * Never logs; errors carry fixed text only (never a path or a value).
 */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';

export const DB_SETUP_LOCK_NAME = '.db-setup.lock';
export const DB_SETUP_LOCK_OWNER_FILE = 'owner';
/** A lock older than this is stale: a db-setup run is bounded (60 s connect window, 30-35 s statements, 3 attempts). */
export const DB_SETUP_LOCK_STALE_MS = 15 * 60_000;
/** db-setup.sh's token (32 hex characters): the shell then owns the lock's release, after its own checks. */
export const DB_SETUP_LOCK_TOKEN_VAR = 'CREWFLOW_DB_SETUP_LOCK_TOKEN';
const TOKEN_SHAPE = /^[0-9a-f]{32}$/;

export const DB_SETUP_LOCK_MESSAGES = {
  held:
    'Another db-setup is running on this setup volume (or one stopped less than 15 minutes ago without cleaning up); nothing was changed. Start again when it has finished. If no db-setup is running, remove the .db-setup.lock directory from the setup volume.',
  unusable: 'The db-setup lock in the setup volume is not a plain directory. Refusing.',
} as const;

export class DbSetupLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DbSetupLockError';
  }
}

interface LockOwner {
  v: 1;
  token: string;
  host: string;
  pid: number;
  boot: string | null;
  started: number;
}

/** The environment this module observes (a test seam). */
export interface DbSetupLockIo {
  now(): number;
  pid(): number;
  host(): string;
  bootId(): string | null;
  pidAlive(pid: number): boolean;
}

const realIo: DbSetupLockIo = {
  now: () => Date.now(),
  pid: () => process.pid,
  host: () => hostname(),
  bootId: () => {
    try {
      const id = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      return /^[0-9a-f-]{36}$/.test(id) ? id : null;
    } catch {
      return null;
    }
  },
  pidAlive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  },
};

/** The lock directory of a target file path: the same directory (one volume). */
export function dbSetupLockPath(targetFilePath: string): string {
  return join(dirname(targetFilePath), DB_SETUP_LOCK_NAME);
}

function readOwner(lock: string): LockOwner | null {
  try {
    const raw = JSON.parse(fs.readFileSync(join(lock, DB_SETUP_LOCK_OWNER_FILE), 'utf8')) as Partial<LockOwner>;
    if (raw?.v !== 1 || typeof raw.token !== 'string' || typeof raw.host !== 'string' || !Number.isInteger(raw.pid) || !Number.isFinite(raw.started)) return null;
    return { v: 1, token: raw.token, host: raw.host, pid: raw.pid as number, boot: typeof raw.boot === 'string' ? raw.boot : null, started: raw.started as number };
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

/** Exported for the unit tests. */
export function isStaleLock(lock: string, io: DbSetupLockIo = realIo): boolean {
  const st = assertPlainDirectory(lock);
  const owner = readOwner(lock);
  const now = io.now();
  // A lock with no readable owner (a run killed between mkdir and the owner write): only its age decides.
  if (!owner) return now - st.mtimeMs > DB_SETUP_LOCK_STALE_MS;
  const boot = io.bootId();
  if (owner.boot && boot && owner.boot !== boot) return true;
  if (owner.host === io.host() && (owner.pid === io.pid() || !io.pidAlive(owner.pid))) return true;
  return now - owner.started > DB_SETUP_LOCK_STALE_MS;
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
  /** Releases the lock if (and only if) it is still this run's. Never throws. */
  release(): void;
  /** True when db-setup.sh owns the release (its token was used). */
  readonly releasedByShell: boolean;
}

/**
 * Takes the lock of the volume that holds `targetFilePath`. Throws DbSetupLockError (held / unusable). The token is
 * db-setup.sh's (CREWFLOW_DB_SETUP_LOCK_TOKEN, when well-formed) or a new random one.
 */
export function acquireDbSetupLock(targetFilePath: string, env: Record<string, string | undefined> = process.env, io: DbSetupLockIo = realIo): DbSetupLock {
  const lock = dbSetupLockPath(targetFilePath);
  const shellToken = env[DB_SETUP_LOCK_TOKEN_VAR];
  const releasedByShell = typeof shellToken === 'string' && TOKEN_SHAPE.test(shellToken);
  const token = releasedByShell ? (shellToken as string) : randomBytes(16).toString('hex');
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (attempt === 0 && isStaleLock(lock, io)) {
        removeLockDirectory(lock);
        continue;
      }
      throw new DbSetupLockError(DB_SETUP_LOCK_MESSAGES.held);
    }
  }
  const owner: LockOwner = { v: 1, token, host: io.host(), pid: io.pid(), boot: io.bootId(), started: io.now() };
  try {
    fs.writeFileSync(join(lock, DB_SETUP_LOCK_OWNER_FILE), JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
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
    release() {
      try {
        assertPlainDirectory(lock);
        if (readOwner(lock)?.token === token) removeLockDirectory(lock);
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
