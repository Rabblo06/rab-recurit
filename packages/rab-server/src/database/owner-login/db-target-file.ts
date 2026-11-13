/**
 * DB setup, option A: the file I/O of the database target (db-target.ts holds the format). Used by the bootstrap child
 * (write on success, remove on refusal/failure) and the apps' derive step (read). Never logs; errors carry fixed text or
 * a Node error code only.
 *
 * Writing is ATOMIC: the text goes to a new temp file in the SAME directory (exclusive create, mode 0644, fsync), which is
 * then renamed over the target, so a reader sees either the old complete file, the new complete file, or no file — never
 * a partial one. A failure removes the temp file.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';

import { DB_TARGET_FILE_VAR, DEFAULT_DB_TARGET_FILE, type DbTarget, DbTargetError, parseDbTarget, serializeDbTarget } from './db-target';

export const DB_TARGET_FILE_MODE = 0o644;

export const DB_TARGET_FILE_MESSAGES = {
  notAbsolute: `${DB_TARGET_FILE_VAR} must be an absolute path. Refusing.`,
  unreadable: 'The database target file exists but cannot be read. Refusing.',
} as const;

/** The configured path: CREWFLOW_DB_TARGET_FILE (trimmed) or the default. Refuses a relative path. */
export function dbTargetFilePath(env: Record<string, string | undefined>): string {
  const raw = env[DB_TARGET_FILE_VAR]?.trim();
  const path = raw ? raw : DEFAULT_DB_TARGET_FILE;
  if (!isAbsolute(path) && !path.startsWith('/')) throw new DbTargetError(DB_TARGET_FILE_MESSAGES.notAbsolute);
  return path;
}

export interface DbTargetFs {
  openSync: typeof openSync;
  writeSync: typeof writeSync;
  fsyncSync: typeof fsyncSync;
  closeSync: typeof closeSync;
  chmodSync: typeof chmodSync;
  renameSync: typeof renameSync;
  unlinkSync: typeof unlinkSync;
  readFileSync: typeof readFileSync;
}

const realFs: DbTargetFs = { openSync, writeSync, fsyncSync, closeSync, chmodSync, renameSync, unlinkSync, readFileSync };

/** Atomically replaces `path` with the target's canonical text (mode 0644). Throws on any failure; no temp file is left. */
export function writeDbTargetFile(path: string, target: DbTarget, fs: DbTargetFs = realFs): void {
  const text = serializeDbTarget(target);
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  let fd: number | null = null;
  try {
    fd = fs.openSync(tmp, 'wx', DB_TARGET_FILE_MODE);
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.chmodSync(tmp, DB_TARGET_FILE_MODE); // the process umask must not narrow it: the apps run as another user
    fs.renameSync(tmp, path);
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

/** Removes a stale target so the apps keep waiting. A missing file is fine; any other failure is thrown. */
export function removeDbTargetFile(path: string, fs: DbTargetFs = realFs): void {
  try {
    fs.unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error;
  }
}

export type DbTargetRead = { state: 'missing' } | { state: 'ready'; target: DbTarget };

/**
 * Reads the target. A missing or empty (whitespace-only) file is `missing` (the db-setup step has not finished: the
 * caller exits 75 and the restart policy retries). Unreadable, oversized or malformed: DbTargetError (exit 64).
 */
export function readDbTargetFile(path: string, fs: DbTargetFs = realFs): DbTargetRead {
  let text: string;
  try {
    text = fs.readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return { state: 'missing' };
    throw new DbTargetError(DB_TARGET_FILE_MESSAGES.unreadable);
  }
  if (text.trim() === '') return { state: 'missing' };
  return { state: 'ready', target: parseDbTarget(text) };
}
