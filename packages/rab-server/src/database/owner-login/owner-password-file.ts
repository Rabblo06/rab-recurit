/**
 * Database setup the Twenty Helm way (OWNER-DB-FINAL.md Part A): the crewflow_owner password file on db-setup's volume.
 *
 * Twenty keeps the app user's random password in its own Kubernetes secret and reuses it on every upgrade (`lookup`),
 * twentyhq/twenty@eedb0a73 `packages/twenty-docker/helm/twenty/templates/secret-db-url.yaml:3-8`. Crewflow's equivalent of
 * that secret is this file: `owner-password` beside db-setup's target file (`/run/crewflow/db-target/owner-password`), on
 * the crewflow-db-target named volume that db-setup mounts read-write and rab-api / rab-worker mount read-only. It is never
 * in an environment variable, an env file, the image or a log.
 *
 * Two files (security review L1):
 *   - `owner-password`: the password crewflow_owner logs in with (the one the apps read);
 *   - `owner-password.next`: a NEW password (first start, or A4 after a lost file), stored exclusively BEFORE the transaction
 *     that sets it, and promoted (renamed over `owner-password`) only after the COMMIT and a successful login with it. A run
 *     that fails in between leaves the role and `owner-password` as they were; the next start promotes `.next` if it logs in,
 *     and deletes it otherwise.
 *
 * Writing is ATOMIC and complete: a new temp file in the SAME directory (exclusive create, mode 0400 set on the descriptor,
 * every byte written, fsync), then renamed (or, exclusive, linked) into place, then the directory fsynced; a reader sees the
 * old complete file, the new complete file, or no file — never a partial one; a failure removes the temp file. Nothing here
 * follows a symlink for a permission change.
 *
 * Reading is STRICT (security review L2): opened O_RDONLY|O_NOFOLLOW|O_NONBLOCK (a symlink or a FIFO never blocks or is
 * followed), then fstat on that descriptor: a regular file, at most 4096 bytes, and on POSIX owned by this process's uid with
 * no group/other permission bit; the bytes are read from the same descriptor. Missing (ENOENT) is `missing` (the apps wait,
 * exit 75; db-setup generates a new password only with an admin URL). EVERY other problem — an empty file, a symlink, a
 * FIFO, a wrong owner or mode, a newline or control character, oversized, unreadable — is an OwnerPasswordFileError (exit 64).
 * Errors carry fixed text only, never a value or a path.
 */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { isValidOwnerPassword, OWNER_PASSWORD_MAX_LENGTH } from './owner-credential';

/** The file names, beside the target file (one volume, one directory). */
export const OWNER_PASSWORD_FILE_NAME = 'owner-password';
export const OWNER_PASSWORD_NEXT_SUFFIX = '.next';
export const OWNER_PASSWORD_FILE_MODE = 0o400;
/** A password file is at most this many bytes (1024 characters of up to 4 UTF-8 bytes). */
export const OWNER_PASSWORD_FILE_MAX_BYTES = 4096;

export class OwnerPasswordFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OwnerPasswordFileError';
  }
}

export const OWNER_PASSWORD_FILE_MESSAGES = {
  unreadable: 'The crewflow_owner password file exists but cannot be read. Refusing.',
  notRegular: 'The crewflow_owner password file is not a regular file (a symlink, a FIFO or a directory). Refusing.',
  badOwnerOrMode: 'The crewflow_owner password file is not owned by this process or is readable by group/other (expected mode 0400). Refusing.',
  invalid: `The crewflow_owner password file does not hold a valid password (1-${OWNER_PASSWORD_MAX_LENGTH} characters, no control characters, no newline, not empty). Refusing.`,
  shortWrite: 'Writing the crewflow_owner password file did not complete. Refusing.',
} as const;

/** The password file of a target file path: the same directory, `owner-password`. */
export function ownerPasswordFilePath(targetFilePath: string): string {
  return join(dirname(targetFilePath), OWNER_PASSWORD_FILE_NAME);
}

/** The pending NEW password beside it: `owner-password.next`. */
export function ownerPasswordNextFilePath(passwordFilePath: string): string {
  return `${passwordFilePath}${OWNER_PASSWORD_NEXT_SUFFIX}`;
}

/** The filesystem calls this module uses (a test seam: a short write, a failing fsync). */
export interface OwnerPasswordFs {
  openSync: typeof fs.openSync;
  writeSync: (fd: number, buffer: Buffer, offset: number, length: number) => number;
  fsyncSync: typeof fs.fsyncSync;
  fchmodSync: typeof fs.fchmodSync;
  closeSync: typeof fs.closeSync;
  renameSync: typeof fs.renameSync;
  linkSync: typeof fs.linkSync;
  unlinkSync: typeof fs.unlinkSync;
  fstatSync: typeof fs.fstatSync;
  readSync: (fd: number, buffer: Buffer, offset: number, length: number, position: number | null) => number;
}

const realFs: OwnerPasswordFs = {
  openSync: fs.openSync,
  writeSync: (fd, buffer, offset, length) => fs.writeSync(fd, buffer, offset, length),
  fsyncSync: fs.fsyncSync,
  fchmodSync: fs.fchmodSync,
  closeSync: fs.closeSync,
  renameSync: fs.renameSync,
  linkSync: fs.linkSync,
  unlinkSync: fs.unlinkSync,
  fstatSync: fs.fstatSync,
  readSync: (fd, buffer, offset, length, position) => fs.readSync(fd, buffer, offset, length, position),
};

const WIN = process.platform === 'win32';

/** fsync the directory so a rename/link survives a crash (POSIX; Windows cannot open a directory for this). */
function fsyncDirectory(dir: string, io: OwnerPasswordFs): void {
  if (WIN) return;
  const fd = io.openSync(dir, fs.constants.O_RDONLY);
  try {
    io.fsyncSync(fd);
  } finally {
    io.closeSync(fd);
  }
}

/**
 * Atomically replaces `path` with `password` (mode 0400). With `exclusive` the file is linked into place instead, and the
 * call fails with EEXIST when the file already exists (never overwriting it). Throws on any failure; no temp file is left.
 * Never logs.
 */
export function writeOwnerPasswordFile(path: string, password: string, options: { exclusive?: boolean } = {}, io: OwnerPasswordFs = realFs): void {
  if (!isValidOwnerPassword(password)) throw new OwnerPasswordFileError(OWNER_PASSWORD_FILE_MESSAGES.invalid);
  const bytes = Buffer.from(password, 'utf8');
  const dir = dirname(path);
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  let fd: number | null = null;
  let tmpExists = false;
  try {
    fd = io.openSync(tmp, 'wx', OWNER_PASSWORD_FILE_MODE);
    tmpExists = true;
    io.fchmodSync(fd, OWNER_PASSWORD_FILE_MODE); // on the descriptor: never follows a path, the umask cannot widen it
    let written = 0;
    while (written < bytes.length) {
      const n = io.writeSync(fd, bytes, written, bytes.length - written);
      if (!(n > 0)) throw new OwnerPasswordFileError(OWNER_PASSWORD_FILE_MESSAGES.shortWrite);
      written += n;
    }
    io.fsyncSync(fd);
    io.closeSync(fd);
    fd = null;
    if (options.exclusive) {
      io.linkSync(tmp, path);
      io.unlinkSync(tmp);
      tmpExists = false;
    } else {
      try {
        io.renameSync(tmp, path);
      } catch (error) {
        // Windows test hosts only: rename refuses to replace a read-only (0400) file. Linux renames over it atomically.
        if (!(WIN && (error as NodeJS.ErrnoException).code === 'EPERM')) throw error;
        io.unlinkSync(path);
        io.renameSync(tmp, path);
      }
      tmpExists = false;
    }
    fsyncDirectory(dir, io);
  } catch (error) {
    if (fd !== null) {
      try {
        io.closeSync(fd);
      } catch {
        /* already closed */
      }
    }
    if (tmpExists) {
      try {
        io.unlinkSync(tmp);
      } catch {
        /* already gone */
      }
    }
    throw error;
  }
}

/** Renames `from` over `to` (the `.next` promotion) and fsyncs the directory. */
export function promoteOwnerPasswordFile(from: string, to: string, io: OwnerPasswordFs = realFs): void {
  try {
    io.renameSync(from, to);
  } catch (error) {
    if (!(WIN && (error as NodeJS.ErrnoException).code === 'EPERM')) throw error;
    io.unlinkSync(to);
    io.renameSync(from, to);
  }
  fsyncDirectory(dirname(to), io);
}

/** Removes a file if it exists (a stale `.next`). Any error but ENOENT is thrown. */
export function removeOwnerPasswordFile(path: string, io: OwnerPasswordFs = realFs): void {
  try {
    io.unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error;
  }
}

export type OwnerPasswordRead = { state: 'missing' } | { state: 'ready'; readonly password: string };

/** Reads the password (see the header). Missing: `missing`. Anything else wrong: OwnerPasswordFileError. Non-enumerable value. */
export function readOwnerPasswordFile(path: string, io: OwnerPasswordFs = realFs): OwnerPasswordRead {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
  let fd: number;
  try {
    fd = io.openSync(path, flags);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === 'ENOENT') return { state: 'missing' };
    // O_NOFOLLOW on a symlink fails with ELOOP (Linux) / EMLINK (BSD).
    if (code === 'ELOOP' || code === 'EMLINK') throw new OwnerPasswordFileError(OWNER_PASSWORD_FILE_MESSAGES.notRegular);
    throw new OwnerPasswordFileError(OWNER_PASSWORD_FILE_MESSAGES.unreadable);
  }
  try {
    let st: fs.Stats;
    try {
      st = io.fstatSync(fd);
    } catch {
      throw new OwnerPasswordFileError(OWNER_PASSWORD_FILE_MESSAGES.unreadable);
    }
    if (!st.isFile()) throw new OwnerPasswordFileError(OWNER_PASSWORD_FILE_MESSAGES.notRegular);
    if (st.size === 0 || st.size > OWNER_PASSWORD_FILE_MAX_BYTES) throw new OwnerPasswordFileError(OWNER_PASSWORD_FILE_MESSAGES.invalid);
    if (!WIN) {
      const uid = typeof process.getuid === 'function' ? process.getuid() : null;
      if ((uid !== null && st.uid !== uid) || (st.mode & 0o077) !== 0) throw new OwnerPasswordFileError(OWNER_PASSWORD_FILE_MESSAGES.badOwnerOrMode);
    }
    const buffer = Buffer.alloc(st.size);
    let read = 0;
    while (read < st.size) {
      const n = io.readSync(fd, buffer, read, st.size - read, read);
      if (!(n > 0)) break;
      read += n;
    }
    if (read !== st.size) throw new OwnerPasswordFileError(OWNER_PASSWORD_FILE_MESSAGES.unreadable);
    const password = buffer.toString('utf8');
    if (!isValidOwnerPassword(password) || Buffer.from(password, 'utf8').compare(buffer) !== 0) throw new OwnerPasswordFileError(OWNER_PASSWORD_FILE_MESSAGES.invalid);
    const out = { state: 'ready' as const } as Extract<OwnerPasswordRead, { state: 'ready' }>;
    Object.defineProperty(out, 'password', { value: password, enumerable: false, writable: false, configurable: false });
    return out;
  } finally {
    io.closeSync(fd);
  }
}
