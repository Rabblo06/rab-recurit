/**
 * Option A (PR #125): the database target file. Atomic write (temp file in the same directory, exclusive create, 0644,
 * fsync, rename), stale-file removal, and the reader's missing / empty / malformed / ready states.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { DEFAULT_DB_TARGET_FILE, type DbTarget, DbTargetError, serializeDbTarget } from './db-target';
import { DB_TARGET_FILE_MODE, dbTargetFilePath, type DbTargetFs, readDbTargetFile, removeDbTargetFile, writeDbTargetFile } from './db-target-file';

const target: DbTarget = { v: 1, host: 'db', port: 5432, database: 'crewflow', params: { sslmode: 'verify-full' } };
const other: DbTarget = { v: 1, host: 'db2', port: 5433, database: 'crewflow2', params: {} };

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-target-spec-'));
  file = path.join(dir, 'target.json');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const entries = () => fs.readdirSync(dir).sort();
const POSIX = process.platform !== 'win32';
const posixIt = POSIX ? it : it.skip;
/** The real calls, as DbTargetFs (a test seam: a short write, a failing rename). */
const realFs = (overrides: Partial<DbTargetFs> = {}): DbTargetFs => ({
  openSync: fs.openSync,
  writeSync: (fd, buffer, offset, length) => fs.writeSync(fd, buffer, offset, length),
  fsyncSync: fs.fsyncSync,
  fchmodSync: fs.fchmodSync,
  closeSync: fs.closeSync,
  renameSync: fs.renameSync,
  unlinkSync: fs.unlinkSync,
  fstatSync: fs.fstatSync,
  readSync: (fd, buffer, offset, length, position) => fs.readSync(fd, buffer, offset, length, position),
  ...overrides,
});

describe('db target file: write', () => {
  it('writes the canonical text, mode 0644, and leaves no temp file', () => {
    writeDbTargetFile(file, target);
    expect(fs.readFileSync(file, 'utf8')).toBe(serializeDbTarget(target));
    expect(entries()).toEqual(['target.json']);
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o644);
  });

  it('replaces an existing target', () => {
    writeDbTargetFile(file, other);
    writeDbTargetFile(file, target);
    expect(fs.readFileSync(file, 'utf8')).toBe(serializeDbTarget(target));
    expect(entries()).toEqual(['target.json']);
  });

  it('is atomic: exclusive temp file in the SAME directory, mode on the descriptor, every byte, fsync, rename, directory fsync', () => {
    const calls: string[] = [];
    let tmp = '';
    const spy = realFs({
      openSync: ((p: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
        if (flags === 'wx') {
          tmp = String(p);
          calls.push(`open ${flags} ${Number(mode).toString(8)}`);
        } else calls.push(`open-dir ${String(p) === dir}`);
        return fs.openSync(p, flags, mode);
      }) as typeof fs.openSync,
      fchmodSync: (fd, m) => {
        calls.push(`fchmod ${Number(m).toString(8)}`);
        fs.fchmodSync(fd, m);
      },
      // At most 7 bytes per call: the loop must complete the file.
      writeSync: (fd, b, o, l) => {
        if (!calls.includes('write')) calls.push('write');
        return fs.writeSync(fd, b, o, Math.min(l, 7));
      },
      fsyncSync: (fd) => {
        calls.push('fsync');
        fs.fsyncSync(fd);
      },
      closeSync: (fd) => {
        calls.push('close');
        fs.closeSync(fd);
      },
      renameSync: (a, b) => {
        calls.push(`rename ${path.dirname(String(a)) === path.dirname(String(b))} ${String(b) === file}`);
        fs.renameSync(a, b);
      },
    });
    writeDbTargetFile(file, target, spy);
    expect(path.dirname(tmp)).toBe(dir);
    expect(tmp).not.toBe(file);
    const head = ['open wx 644', `fchmod ${DB_TARGET_FILE_MODE.toString(8)}`, 'write', 'fsync', 'close', 'rename true true'];
    expect(calls).toEqual(POSIX ? [...head, 'open-dir true', 'fsync', 'close'] : head);
    expect(fs.readFileSync(file, 'utf8')).toBe(serializeDbTarget(target));
    const source = fs.readFileSync(path.join(__dirname, 'db-target-file.ts'), 'utf8');
    expect(source).not.toMatch(/(^|[^f])chmodSync\(/m); // never a path-based chmod
  });

  it('a write that makes no progress throws and leaves no temp file and no target', () => {
    const stuck = realFs({ writeSync: () => 0 });
    expect(() => writeDbTargetFile(file, target, stuck)).toThrow(DbTargetError);
    expect(entries()).toEqual([]);
  });

  it('a failed rename keeps the previous target intact and removes the temp file', () => {
    writeDbTargetFile(file, other);
    const failing = realFs({
      renameSync: () => {
        throw Object.assign(new Error('rename failed'), { code: 'EXDEV' });
      },
    });
    expect(() => writeDbTargetFile(file, target, failing)).toThrow('rename failed');
    expect(fs.readFileSync(file, 'utf8')).toBe(serializeDbTarget(other));
    expect(entries()).toEqual(['target.json']);
  });

  it('a failed write leaves no temp file and no target', () => {
    const failing = realFs({
      writeSync: () => {
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      },
    });
    expect(() => writeDbTargetFile(file, target, failing)).toThrow('disk full');
    expect(entries()).toEqual([]);
  });

  it('refuses to write an invalid target (no partial file)', () => {
    expect(() => writeDbTargetFile(file, { ...target, host: 'evil@db' })).toThrow(DbTargetError);
    expect(entries()).toEqual([]);
  });

  it('the file holds no credential-shaped key or value', () => {
    writeDbTargetFile(file, target);
    const text = fs.readFileSync(file, 'utf8');
    expect(text).not.toMatch(/user|password|@|postgres:\/\//i);
    expect(Object.keys(JSON.parse(text))).toEqual(['v', 'host', 'port', 'database', 'params']);
  });
});

describe('db target file: stale removal', () => {
  it('removes an existing target, and a missing one is fine', () => {
    writeDbTargetFile(file, target);
    removeDbTargetFile(file);
    expect(entries()).toEqual([]);
    expect(() => removeDbTargetFile(file)).not.toThrow();
  });

  it('any other failure is thrown (the caller reports it)', () => {
    const failing = realFs({
      unlinkSync: () => {
        throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      },
    });
    expect(() => removeDbTargetFile(file, failing)).toThrow('busy');
  });
});

describe('db target file: read', () => {
  it('missing or empty (whitespace) is "missing": not ready yet', () => {
    expect(readDbTargetFile(file)).toEqual({ state: 'missing' });
    fs.writeFileSync(file, '');
    expect(readDbTargetFile(file)).toEqual({ state: 'missing' });
    fs.writeFileSync(file, ' \n');
    expect(readDbTargetFile(file)).toEqual({ state: 'missing' });
  });

  it('a written target reads back', () => {
    writeDbTargetFile(file, target);
    expect(readDbTargetFile(file)).toEqual({ state: 'ready', target });
  });

  it('malformed or unreadable is a DbTargetError (exit 64), not "missing"', () => {
    fs.writeFileSync(file, '{"v":1}');
    expect(() => readDbTargetFile(file)).toThrow(DbTargetError);
    fs.rmSync(file);
    fs.mkdirSync(file); // a directory where the file should be
    expect(() => readDbTargetFile(file)).toThrow(DbTargetError);
    fs.rmdirSync(file);
    fs.writeFileSync(file, 'x'.repeat(5000), { mode: 0o644 }); // oversized
    expect(() => readDbTargetFile(file)).toThrow(DbTargetError);
  });

  posixIt('strict: a symlink (even to a valid target), a FIFO (without blocking) or a group/other-writable file is refused', () => {
    const real = path.join(dir, 'elsewhere.json');
    fs.writeFileSync(real, serializeDbTarget(target), { mode: 0o644 });
    fs.symlinkSync(real, file);
    expect(() => readDbTargetFile(file)).toThrow(DbTargetError);
    fs.rmSync(file);
    execFileSync('mkfifo', ['-m', '644', file]);
    const started = Date.now();
    expect(() => readDbTargetFile(file)).toThrow(DbTargetError);
    expect(Date.now() - started).toBeLessThan(2_000);
    fs.rmSync(file);
    fs.writeFileSync(file, serializeDbTarget(target));
    fs.chmodSync(file, 0o666);
    expect(() => readDbTargetFile(file)).toThrow(DbTargetError);
    fs.chmodSync(file, 0o644);
    expect(readDbTargetFile(file)).toEqual({ state: 'ready', target });
  });
});

describe('db target file: path', () => {
  it('default, configured (trimmed), and a relative path is refused', () => {
    expect(dbTargetFilePath({})).toBe(DEFAULT_DB_TARGET_FILE);
    expect(dbTargetFilePath({ CREWFLOW_DB_TARGET_FILE: '' })).toBe(DEFAULT_DB_TARGET_FILE);
    expect(dbTargetFilePath({ CREWFLOW_DB_TARGET_FILE: ' /run/x/target.json ' })).toBe('/run/x/target.json');
    expect(() => dbTargetFilePath({ CREWFLOW_DB_TARGET_FILE: 'relative/target.json' })).toThrow(DbTargetError);
  });
});
