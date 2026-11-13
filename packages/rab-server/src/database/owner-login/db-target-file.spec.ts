/**
 * Option A (PR #125): the database target file. Atomic write (temp file in the same directory, exclusive create, 0644,
 * fsync, rename), stale-file removal, and the reader's missing / empty / malformed / ready states.
 */
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

  it('is atomic: exclusive temp file in the SAME directory, fsync before rename, rename onto the target', () => {
    const calls: string[] = [];
    let tmp = '';
    const spy: DbTargetFs = {
      ...fs,
      openSync: ((p: fs.PathLike, flags: string, mode: number) => {
        tmp = String(p);
        calls.push(`open ${flags} ${mode.toString(8)}`);
        return fs.openSync(p, flags, mode);
      }) as typeof fs.openSync,
      writeSync: ((fd: number, data: string) => {
        calls.push('write');
        return fs.writeSync(fd, data);
      }) as typeof fs.writeSync,
      fsyncSync: (fd) => {
        calls.push('fsync');
        fs.fsyncSync(fd);
      },
      closeSync: (fd) => {
        calls.push('close');
        fs.closeSync(fd);
      },
      chmodSync: (p, m) => {
        calls.push(`chmod ${Number(m).toString(8)}`);
        fs.chmodSync(p, m);
      },
      renameSync: (a, b) => {
        calls.push(`rename ${path.dirname(String(a)) === path.dirname(String(b))} ${String(b) === file}`);
        fs.renameSync(a, b);
      },
    };
    writeDbTargetFile(file, target, spy);
    expect(path.dirname(tmp)).toBe(dir);
    expect(tmp).not.toBe(file);
    expect(calls).toEqual(['open wx 644', 'write', 'fsync', 'close', `chmod ${DB_TARGET_FILE_MODE.toString(8)}`, 'rename true true']);
  });

  it('a failed rename keeps the previous target intact and removes the temp file', () => {
    writeDbTargetFile(file, other);
    const failing: DbTargetFs = {
      ...fs,
      renameSync: () => {
        throw Object.assign(new Error('rename failed'), { code: 'EXDEV' });
      },
    };
    expect(() => writeDbTargetFile(file, target, failing)).toThrow('rename failed');
    expect(fs.readFileSync(file, 'utf8')).toBe(serializeDbTarget(other));
    expect(entries()).toEqual(['target.json']);
  });

  it('a failed write leaves no temp file and no target', () => {
    const failing: DbTargetFs = {
      ...fs,
      writeSync: (() => {
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      }) as typeof fs.writeSync,
    };
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
    const failing: DbTargetFs = {
      ...fs,
      unlinkSync: () => {
        throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      },
    };
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
