import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { generateOwnerPassword } from './owner-credential';
import {
  OWNER_PASSWORD_FILE_MESSAGES,
  OWNER_PASSWORD_FILE_MODE,
  OWNER_PASSWORD_FILE_NAME,
  OwnerPasswordFileError,
  type OwnerPasswordFs,
  OwnerPasswordMismatchError,
  ownerPasswordFilePath,
  ownerPasswordNextFilePath,
  promoteOwnerPasswordFile,
  readOwnerPasswordFile,
  removeOwnerPasswordFile,
  writeOwnerPasswordFile,
} from './owner-password-file';

/**
 * The crewflow_owner password file (Twenty Helm model: the app user's own secret, secret-db-url.yaml:3-8). Generated test
 * values only; no assertion message prints one. The POSIX-only cases (FIFO, symlink, group/other mode, owner) run on Linux
 * CI and in the image; a Windows test host skips them (it has no FIFOs and no POSIX modes).
 */
const POSIX = process.platform !== 'win32';
const posixIt = POSIX ? it : it.skip;

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-pw-spec-'));
  file = path.join(dir, OWNER_PASSWORD_FILE_NAME);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** Writes raw bytes the way an operator (or an attacker) could: mode 0600, so only the content is under test. */
function plant(content: string | Buffer): void {
  fs.writeFileSync(file, content, { mode: 0o600 });
  if (POSIX) fs.chmodSync(file, 0o600);
}

function refusal(read: () => unknown): string {
  try {
    read();
  } catch (error) {
    expect(error).toBeInstanceOf(OwnerPasswordFileError);
    return (error as Error).message;
  }
  return '(no error)';
}

function fsWith(overrides: Partial<OwnerPasswordFs>): OwnerPasswordFs {
  return {
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
    ...overrides,
  };
}

describe('owner password file', () => {
  it('lives beside the target file, in the same directory (one volume); the pending file is `owner-password.next`', () => {
    const main = ownerPasswordFilePath('/run/crewflow/db-target/target.json');
    expect(main).toBe(path.join('/run/crewflow/db-target', 'owner-password'));
    expect(ownerPasswordNextFilePath(main)).toBe(path.join('/run/crewflow/db-target', 'owner-password.next'));
  });

  it('round-trips the exact password (no newline), mode 0400 on POSIX; the value is non-enumerable', () => {
    const pw = generateOwnerPassword();
    writeOwnerPasswordFile(file, pw);
    expect(fs.readFileSync(file, 'utf8') === pw).toBe(true);
    if (POSIX) expect(fs.statSync(file).mode & 0o777).toBe(OWNER_PASSWORD_FILE_MODE);
    const read = readOwnerPasswordFile(file);
    expect(read.state).toBe('ready');
    expect(read.state === 'ready' && read.password === pw).toBe(true);
    expect(JSON.stringify(read)).not.toContain(pw);
  });

  it('replaces atomically (rename) and leaves no temp file', () => {
    writeOwnerPasswordFile(file, 'first-password');
    writeOwnerPasswordFile(file, 'second-password');
    const read = readOwnerPasswordFile(file);
    expect(read.state === 'ready' && read.password === 'second-password').toBe(true);
    expect(fs.readdirSync(dir)).toEqual([OWNER_PASSWORD_FILE_NAME]);
  });

  it('exclusive (the pending NEW password): fails with EEXIST when a file is already there, never overwriting it; no temp file left', () => {
    writeOwnerPasswordFile(file, 'already-stored');
    let code: unknown = null;
    try {
      writeOwnerPasswordFile(file, generateOwnerPassword(), { exclusive: true });
    } catch (error) {
      code = (error as NodeJS.ErrnoException).code;
    }
    expect(code).toBe('EEXIST');
    expect(fs.readFileSync(file, 'utf8')).toBe('already-stored');
    expect(fs.readdirSync(dir)).toEqual([OWNER_PASSWORD_FILE_NAME]);
    fs.rmSync(file, { force: true });
    writeOwnerPasswordFile(file, 'new-one', { exclusive: true });
    expect(fs.readFileSync(file, 'utf8')).toBe('new-one');
    expect(fs.readdirSync(dir)).toEqual([OWNER_PASSWORD_FILE_NAME]);
  });

  it('promote renames the pending file over owner-password; remove deletes it (and is quiet when it is gone)', () => {
    const next = ownerPasswordNextFilePath(file);
    writeOwnerPasswordFile(file, 'old-password');
    writeOwnerPasswordFile(next, 'new-password', { exclusive: true });
    promoteOwnerPasswordFile(next, file);
    const read = readOwnerPasswordFile(file);
    expect(read.state === 'ready' && read.password === 'new-password').toBe(true);
    expect(fs.readdirSync(dir)).toEqual([OWNER_PASSWORD_FILE_NAME]);
    writeOwnerPasswordFile(next, 'other-password', { exclusive: true });
    removeOwnerPasswordFile(next);
    removeOwnerPasswordFile(next);
    expect(fs.readdirSync(dir)).toEqual([OWNER_PASSWORD_FILE_NAME]);
  });

  it('F1: promotion with `expected` renames only when the pending file holds exactly that password; otherwise nothing moves', () => {
    const next = ownerPasswordNextFilePath(file);
    writeOwnerPasswordFile(file, 'old-password');
    writeOwnerPasswordFile(next, 'another-runs-password', { exclusive: true });
    expect(() => promoteOwnerPasswordFile(next, file, { expected: 'this-runs-password' })).toThrow(OwnerPasswordMismatchError);
    let read = readOwnerPasswordFile(file);
    expect(read.state === 'ready' && read.password === 'old-password').toBe(true);
    expect(fs.existsSync(next)).toBe(true);
    fs.rmSync(next, { force: true });
    expect(() => promoteOwnerPasswordFile(next, file, { expected: 'this-runs-password' })).toThrow(OwnerPasswordMismatchError);
    writeOwnerPasswordFile(next, 'this-runs-password', { exclusive: true });
    promoteOwnerPasswordFile(next, file, { expected: 'this-runs-password' });
    read = readOwnerPasswordFile(file);
    expect(read.state === 'ready' && read.password === 'this-runs-password').toBe(true);
    const source = fs.readFileSync(path.join(__dirname, 'owner-password-file.ts'), 'utf8');
    expect(source).toMatch(/timingSafeEqual\(/);
  });

  it('missing is `missing`; an EMPTY file, a newline, a control character or an oversized file is refused with fixed text', () => {
    expect(readOwnerPasswordFile(file).state).toBe('missing');
    for (const bad of ['', 'secret\n', 'a\u0000b', 'x'.repeat(5000)]) {
      fs.rmSync(file, { force: true });
      plant(bad);
      expect(refusal(() => readOwnerPasswordFile(file))).toBe(OWNER_PASSWORD_FILE_MESSAGES.invalid);
    }
  });

  it('a directory is never read as a password', () => {
    fs.mkdirSync(file);
    expect([OWNER_PASSWORD_FILE_MESSAGES.notRegular, OWNER_PASSWORD_FILE_MESSAGES.unreadable]).toContain(refusal(() => readOwnerPasswordFile(file)));
  });

  posixIt('a FIFO is refused without blocking (O_NONBLOCK, fstat: not a regular file)', () => {
    execFileSync('mkfifo', ['-m', '600', file]);
    const started = Date.now();
    expect(refusal(() => readOwnerPasswordFile(file))).toBe(OWNER_PASSWORD_FILE_MESSAGES.notRegular);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  posixIt('a symlink is never followed (O_NOFOLLOW), even to a valid password file', () => {
    const real = path.join(dir, 'elsewhere');
    fs.writeFileSync(real, 'a-valid-password', { mode: 0o400 });
    fs.symlinkSync(real, file);
    expect(refusal(() => readOwnerPasswordFile(file))).toBe(OWNER_PASSWORD_FILE_MESSAGES.notRegular);
  });

  posixIt('a file readable by group/other (0644, 0640, 0604) is refused', () => {
    for (const mode of [0o644, 0o640, 0o604]) {
      fs.rmSync(file, { force: true });
      fs.writeFileSync(file, 'a-valid-password');
      fs.chmodSync(file, mode);
      expect(refusal(() => readOwnerPasswordFile(file))).toBe(OWNER_PASSWORD_FILE_MESSAGES.badOwnerOrMode);
    }
    fs.chmodSync(file, 0o400);
    expect(readOwnerPasswordFile(file).state).toBe('ready');
  });

  posixIt('a file owned by another uid is refused (fstat uid)', () => {
    plant('a-valid-password');
    const io = fsWith({
      fstatSync: ((fd: number) => Object.assign(fs.fstatSync(fd), { uid: (process.getuid?.() ?? 0) + 1 })) as OwnerPasswordFs['fstatSync'],
    });
    expect(refusal(() => readOwnerPasswordFile(file, io))).toBe(OWNER_PASSWORD_FILE_MESSAGES.badOwnerOrMode);
  });

  it('a short write is completed by looping; a write that makes no progress throws and leaves no file and no temp file', () => {
    // At most 3 bytes per call: the loop completes it.
    writeOwnerPasswordFile(file, 'a-valid-password', {}, fsWith({ writeSync: (fd, b, o, l) => fs.writeSync(fd, b, o, Math.min(l, 3)) }));
    const read = readOwnerPasswordFile(file);
    expect(read.state === 'ready' && read.password === 'a-valid-password').toBe(true);
    fs.rmSync(file, { force: true });
    // Two bytes, then no progress: refused.
    let calls = 0;
    const stuck = fsWith({ writeSync: (fd, b, o, l) => (calls++ === 0 ? fs.writeSync(fd, b, o, Math.min(l, 2)) : 0) });
    expect(refusal(() => writeOwnerPasswordFile(file, 'a-valid-password', {}, stuck))).toBe(OWNER_PASSWORD_FILE_MESSAGES.shortWrite);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('the mode is set on the descriptor (fchmod), and on POSIX the directory is fsynced after the rename / link', () => {
    const opened: string[] = [];
    const fsynced: number[] = [];
    const io = fsWith({
      openSync: ((p: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
        opened.push(String(p));
        return fs.openSync(p, flags, mode);
      }) as OwnerPasswordFs['openSync'],
      fsyncSync: (fd: number) => {
        fsynced.push(fd);
        fs.fsyncSync(fd);
      },
    });
    writeOwnerPasswordFile(file, 'a-valid-password', {}, io);
    if (POSIX) {
      expect(opened[opened.length - 1]).toBe(dir);
      expect(fsynced).toHaveLength(2); // the temp file, then the directory
    } else {
      expect(fsynced).toHaveLength(1);
    }
    const source = fs.readFileSync(path.join(__dirname, 'owner-password-file.ts'), 'utf8');
    expect(source).not.toMatch(/(^|[^f])chmodSync\(/m); // never a path-based chmod (it would follow a symlink)
  });

  it('refuses to write an invalid password (no file is created)', () => {
    for (const bad of ['', 'a\nb', 'x'.repeat(1025)]) expect(() => writeOwnerPasswordFile(file, bad)).toThrow(OwnerPasswordFileError);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('the module never logs and never puts the password in an error', () => {
    const source = fs.readFileSync(path.join(__dirname, 'owner-password-file.ts'), 'utf8');
    expect(source).not.toMatch(/console\.|process\.(stdout|stderr)/);
  });
});
