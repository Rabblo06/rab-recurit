/**
 * DB setup, option A: the file I/O of the database target (db-target.ts holds the format). Used by the bootstrap child
 * (write on success, remove on refusal/failure) and the apps' derive step (read). Never logs; errors carry fixed text or
 * a Node error code only.
 *
 * Writing is ATOMIC: the text goes to a new temp file in the SAME directory (exclusive create, mode 0644 set on the
 * descriptor, every byte written, fsync), which is then renamed over the target and the directory fsynced, so a reader sees
 * either the old complete file, the new complete file, or no file — never a partial one. A failure removes the temp file.
 *
 * Reading is STRICT (the same pattern as owner-password-file.ts; security re-review, info): opened
 * O_RDONLY|O_NOFOLLOW|O_NONBLOCK, then fstat on that descriptor: a regular file of at most DB_TARGET_MAX_BYTES, and on
 * POSIX not writable by group/other; the bytes are read from the same descriptor. The file holds no secret; this keeps a
 * symlink or a FIFO from redirecting or hanging the apps' derive step.
 */
import { randomBytes } from 'node:crypto';
import * as nodeFs from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';

import { DB_TARGET_FILE_VAR, DB_TARGET_MAX_BYTES, DEFAULT_DB_TARGET_FILE, type DbTarget, DbTargetError, parseDbTarget, serializeDbTarget } from './db-target';

export const DB_TARGET_FILE_MODE = 0o644;

export const DB_TARGET_FILE_MESSAGES = {
  notAbsolute: `${DB_TARGET_FILE_VAR} must be an absolute path. Refusing.`,
  unreadable: 'The database target file exists but cannot be read. Refusing.',
  notRegular: 'The database target file is not a regular file (a symlink, a FIFO or a directory), or is writable by group/other. Refusing.',
  shortWrite: 'Writing the database target file did not complete. Refusing.',
} as const;

/** The configured path: CREWFLOW_DB_TARGET_FILE (trimmed) or the default. Refuses a relative path. */
export function dbTargetFilePath(env: Record<string, string | undefined>): string {
  const raw = env[DB_TARGET_FILE_VAR]?.trim();
  const path = raw ? raw : DEFAULT_DB_TARGET_FILE;
  if (!isAbsolute(path) && !path.startsWith('/')) throw new DbTargetError(DB_TARGET_FILE_MESSAGES.notAbsolute);
  return path;
}

export interface DbTargetFs {
  openSync: typeof nodeFs.openSync;
  writeSync: (fd: number, buffer: Buffer, offset: number, length: number) => number;
  fsyncSync: typeof nodeFs.fsyncSync;
  fchmodSync: typeof nodeFs.fchmodSync;
  closeSync: typeof nodeFs.closeSync;
  renameSync: typeof nodeFs.renameSync;
  unlinkSync: typeof nodeFs.unlinkSync;
  fstatSync: typeof nodeFs.fstatSync;
  readSync: (fd: number, buffer: Buffer, offset: number, length: number, position: number | null) => number;
}

const realFs: DbTargetFs = {
  openSync: nodeFs.openSync,
  writeSync: (fd, buffer, offset, length) => nodeFs.writeSync(fd, buffer, offset, length),
  fsyncSync: nodeFs.fsyncSync,
  fchmodSync: nodeFs.fchmodSync,
  closeSync: nodeFs.closeSync,
  renameSync: nodeFs.renameSync,
  unlinkSync: nodeFs.unlinkSync,
  fstatSync: nodeFs.fstatSync,
  readSync: (fd, buffer, offset, length, position) => nodeFs.readSync(fd, buffer, offset, length, position),
};

const WIN = process.platform === 'win32';

/** fsync the directory so a rename survives a crash (POSIX; Windows cannot open a directory for this). */
function fsyncDirectory(dir: string, fs: DbTargetFs): void {
  if (WIN) return;
  const fd = fs.openSync(dir, nodeFs.constants.O_RDONLY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Atomically replaces `path` with the target's canonical text (mode 0644). Throws on any failure; no temp file is left. */
export function writeDbTargetFile(path: string, target: DbTarget, fs: DbTargetFs = realFs): void {
  const bytes = Buffer.from(serializeDbTarget(target), 'utf8');
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  let fd: number | null = null;
  let tmpExists = false;
  try {
    fd = fs.openSync(tmp, 'wx', DB_TARGET_FILE_MODE);
    tmpExists = true;
    // On the descriptor (never a path, never a symlink): the umask must not narrow it, the apps read it.
    fs.fchmodSync(fd, DB_TARGET_FILE_MODE);
    let written = 0;
    while (written < bytes.length) {
      const n = fs.writeSync(fd, bytes, written, bytes.length - written);
      if (!(n > 0)) throw new DbTargetError(DB_TARGET_FILE_MESSAGES.shortWrite);
      written += n;
    }
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, path);
    tmpExists = false;
    fsyncDirectory(dirname(path), fs);
  } catch (error) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
    }
    if (tmpExists) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* already gone */
      }
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
 * Reads the target (strict, see the header). A missing or empty (whitespace-only) file is `missing` (the db-setup step has
 * not finished: the caller exits 75 and the restart policy retries). Unreadable, not a regular file, group/other-writable,
 * oversized or malformed: DbTargetError (exit 64).
 */
export function readDbTargetFile(path: string, fs: DbTargetFs = realFs): DbTargetRead {
  const flags = nodeFs.constants.O_RDONLY | (nodeFs.constants.O_NOFOLLOW ?? 0) | (nodeFs.constants.O_NONBLOCK ?? 0);
  let fd: number;
  try {
    fd = fs.openSync(path, flags);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === 'ENOENT') return { state: 'missing' };
    if (code === 'ELOOP' || code === 'EMLINK') throw new DbTargetError(DB_TARGET_FILE_MESSAGES.notRegular);
    throw new DbTargetError(DB_TARGET_FILE_MESSAGES.unreadable);
  }
  let text: string;
  try {
    let st: nodeFs.Stats;
    try {
      st = fs.fstatSync(fd);
    } catch {
      throw new DbTargetError(DB_TARGET_FILE_MESSAGES.unreadable);
    }
    if (!st.isFile() || (!WIN && (st.mode & 0o022) !== 0)) throw new DbTargetError(DB_TARGET_FILE_MESSAGES.notRegular);
    // One byte over the bound is enough for parseDbTarget to refuse an oversized file.
    const size = Math.min(st.size, DB_TARGET_MAX_BYTES + 1);
    const buffer = Buffer.alloc(size);
    let read = 0;
    while (read < size) {
      const n = fs.readSync(fd, buffer, read, size - read, read);
      if (!(n > 0)) break;
      read += n;
    }
    if (read !== size) throw new DbTargetError(DB_TARGET_FILE_MESSAGES.unreadable);
    text = buffer.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
  if (text.trim() === '') return { state: 'missing' };
  return { state: 'ready', target: parseDbTarget(text) };
}
