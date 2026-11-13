/**
 * Database setup the Twenty Helm way (OWNER-DB-FINAL.md Part A): the crewflow_owner password file on db-setup's volume.
 *
 * Twenty keeps the app user's random password in its own Kubernetes secret and reuses it on every upgrade (`lookup`),
 * twentyhq/twenty@eedb0a73 `packages/twenty-docker/helm/twenty/templates/secret-db-url.yaml:3-8`. Crewflow's equivalent of
 * that secret is this file: `owner-password` beside db-setup's target file (`/run/crewflow/db-target/owner-password`), on
 * the crewflow-db-target named volume that db-setup mounts read-write and rab-api / rab-worker mount read-only. It is never
 * in an environment variable, an env file, the image or a log.
 *
 * The file holds exactly the password (no newline, no other byte). Writing is ATOMIC: a new temp file in the SAME directory
 * (exclusive create, mode 0400, fsync), then renamed over the file, so a reader sees the old complete file, the new complete
 * file, or no file — never a partial one; a failure removes the temp file. 0400 owned by the writing uid (db-setup runs as
 * 1000:1000, the same uid as rab-api and rab-worker, which only read it).
 *
 * Reading is STRICT: a missing (or empty) file is `missing` (the apps wait, exit 75; db-setup generates a new password only
 * with an admin URL); anything else that is not a valid password (oversized, a control character, unreadable) is an
 * OwnerPasswordFileError (exit 64). Errors carry fixed text or a Node error code only, never a value or a path.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, fsyncSync, linkSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { isValidOwnerPassword, OWNER_PASSWORD_MAX_LENGTH } from './owner-credential';

/** The file name, beside the target file (one volume, one directory). */
export const OWNER_PASSWORD_FILE_NAME = 'owner-password';
export const OWNER_PASSWORD_FILE_MODE = 0o400;

export class OwnerPasswordFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OwnerPasswordFileError';
  }
}

export const OWNER_PASSWORD_FILE_MESSAGES = {
  unreadable: 'The crewflow_owner password file exists but cannot be read. Refusing.',
  invalid: `The crewflow_owner password file does not hold a valid password (1-${OWNER_PASSWORD_MAX_LENGTH} characters, no control characters, no newline). Refusing.`,
} as const;

/** The password file of a target file path: the same directory, `owner-password`. */
export function ownerPasswordFilePath(targetFilePath: string): string {
  return join(dirname(targetFilePath), OWNER_PASSWORD_FILE_NAME);
}

export interface OwnerPasswordFs {
  openSync: typeof openSync;
  writeSync: typeof writeSync;
  fsyncSync: typeof fsyncSync;
  closeSync: typeof closeSync;
  chmodSync: typeof chmodSync;
  renameSync: typeof renameSync;
  linkSync: typeof linkSync;
  unlinkSync: typeof unlinkSync;
  readFileSync: typeof readFileSync;
}

const realFs: OwnerPasswordFs = { openSync, writeSync, fsyncSync, closeSync, chmodSync, renameSync, linkSync, unlinkSync, readFileSync };

/**
 * Atomically replaces `path` with `password` (mode 0400). With `exclusive` (a NEW password, the file was missing) the file
 * is linked into place instead and the call fails with EEXIST when another run created it first (never overwriting a
 * password another db-setup may already have used). Throws on any failure; no temp file is left. Never logs.
 */
export function writeOwnerPasswordFile(path: string, password: string, options: { exclusive?: boolean } = {}, fs: OwnerPasswordFs = realFs): void {
  if (!isValidOwnerPassword(password)) throw new OwnerPasswordFileError(OWNER_PASSWORD_FILE_MESSAGES.invalid);
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  let fd: number | null = null;
  try {
    fd = fs.openSync(tmp, 'wx', OWNER_PASSWORD_FILE_MODE);
    fs.writeSync(fd, password);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.chmodSync(tmp, OWNER_PASSWORD_FILE_MODE);
    if (options.exclusive) {
      fs.linkSync(tmp, path);
      fs.unlinkSync(tmp);
    } else {
      // Replacing a 0400 file: make the old one writable first (Windows refuses to rename over a read-only file; on Linux
      // this is a no-op for the result). A missing old file is fine.
      try {
        fs.chmodSync(path, 0o600);
      } catch {
        /* no previous file */
      }
      fs.renameSync(tmp, path);
    }
  } catch (error) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* never created, or already renamed */
    }
    throw error;
  }
}

export type OwnerPasswordRead = { state: 'missing' } | { state: 'ready'; readonly password: string };

/** Reads the password. Missing or empty: `missing`. Unreadable or invalid: OwnerPasswordFileError. The value is non-enumerable. */
export function readOwnerPasswordFile(path: string, fs: OwnerPasswordFs = realFs): OwnerPasswordRead {
  let raw: Buffer;
  try {
    raw = fs.readFileSync(path) as Buffer;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return { state: 'missing' };
    throw new OwnerPasswordFileError(OWNER_PASSWORD_FILE_MESSAGES.unreadable);
  }
  if (raw.length === 0) return { state: 'missing' };
  if (raw.length > OWNER_PASSWORD_MAX_LENGTH * 4) throw new OwnerPasswordFileError(OWNER_PASSWORD_FILE_MESSAGES.invalid);
  const password = raw.toString('utf8');
  if (!isValidOwnerPassword(password) || Buffer.from(password, 'utf8').compare(raw) !== 0) throw new OwnerPasswordFileError(OWNER_PASSWORD_FILE_MESSAGES.invalid);
  const read = { state: 'ready' as const } as Extract<OwnerPasswordRead, { state: 'ready' }>;
  Object.defineProperty(read, 'password', { value: password, enumerable: false, writable: false, configurable: false });
  return read;
}
