import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  acquireDbSetupLock,
  DB_SETUP_FLOCK_NAME,
  DB_SETUP_FLOCK_VAR,
  DB_SETUP_LOCK_MESSAGES,
  DB_SETUP_LOCK_NAME,
  DB_SETUP_LOCK_OWNER_FILE,
  DB_SETUP_LOCK_TOKEN_VAR,
  DbSetupLockError,
  type DbSetupLockIo,
  dbSetupLockPath,
  removeLeftoverTempFiles,
  volumeFlockHeld,
} from './db-setup-lock';

/**
 * Security re-review F1 / R1 / R2: one db-setup run per setup volume. The kernel lock (flock on fd 9, taken by db-setup.sh)
 * is the authority; the lock directory is a second layer and the only one for a direct run. Denials: a held lock stops the
 * second run; without the kernel lock a leftover directory is never taken over (no pid / boot-id / age guessing); with it,
 * of two interleaved takers exactly one wins; a run never removes another run's lock.
 */
let dir: string;
let target: string;
let lock: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-setup-lock-spec-'));
  target = path.join(dir, 'target.json');
  lock = dbSetupLockPath(target);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const io = (kernel: boolean, extra: Partial<DbSetupLockIo> = {}): DbSetupLockIo => ({ volumeFlockHeld: () => kernel, ...extra });
const ownerOf = () => JSON.parse(fs.readFileSync(path.join(lock, DB_SETUP_LOCK_OWNER_FILE), 'utf8')) as { v: number; token: string };
const leftBehind = () => {
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, DB_SETUP_LOCK_OWNER_FILE), JSON.stringify({ v: 1, token: 'f'.repeat(32) }));
};
const outcome = (f: () => unknown): string => {
  try {
    f();
    return 'ok';
  } catch (error) {
    return error instanceof DbSetupLockError && error.message === DB_SETUP_LOCK_MESSAGES.held ? 'held' : String((error as Error).message);
  }
};

describe('db-setup lock', () => {
  it('lives in the setup volume beside the target; the holder records its token; release removes it', () => {
    expect(lock).toBe(path.join(dir, DB_SETUP_LOCK_NAME));
    const held = acquireDbSetupLock(target, {}, io(false));
    expect(ownerOf().v).toBe(1);
    expect(ownerOf().token).toMatch(/^[0-9a-f]{32}$/);
    expect(held.releasedByShell).toBe(false);
    expect(held.kernelLock).toBe(false);
    held.release();
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('DENIAL: a second run while the lock is held stops with fixed text; the first lock stays', () => {
    const first = acquireDbSetupLock(target, {}, io(false));
    const token = ownerOf().token;
    expect(outcome(() => acquireDbSetupLock(target, {}, io(false)))).toBe('held');
    expect(ownerOf().token).toBe(token);
    first.release();
  });

  it('R1/R2 DENIAL: without the kernel lock a leftover directory is NEVER taken over (no pid, boot-id or age heuristics)', () => {
    leftBehind();
    expect(outcome(() => acquireDbSetupLock(target, {}, io(false)))).toBe('held');
    expect(ownerOf().token).toBe('f'.repeat(32));
    const source = fs.readFileSync(path.join(__dirname, 'db-setup-lock.ts'), 'utf8');
    expect(source).not.toMatch(/boot_id|pidAlive|process\.kill|STALE_MS/);
  });

  it('under the kernel lock a leftover directory (a run that died) is taken over, through a tombstone that is removed', () => {
    leftBehind();
    const held = acquireDbSetupLock(target, {}, io(true));
    expect(held.kernelLock).toBe(true);
    expect(ownerOf().token).not.toBe('f'.repeat(32));
    expect(fs.readdirSync(dir).filter((n) => n.includes('.stale-'))).toEqual([]);
    held.release();
  });

  it('R2: two takers interleaved between judging the leftover directory and taking it over -> exactly one wins', () => {
    leftBehind();
    let inner = '';
    const outer = outcome(() =>
      acquireDbSetupLock(target, {}, io(true, { beforeTakeover: () => void (inner = outcome(() => acquireDbSetupLock(target, {}, io(true)))) })),
    );
    expect([outer, inner].sort()).toEqual(['held', 'ok']);
    expect(fs.statSync(lock).isDirectory()).toBe(true);
    expect(ownerOf().token).not.toBe('f'.repeat(32)); // the winner's lock is in place, never removed by the loser
  });

  it('db-setup.sh token: used as the owner token, and release by this process is left to the shell', () => {
    const token = 'a'.repeat(32);
    const held = acquireDbSetupLock(target, { [DB_SETUP_LOCK_TOKEN_VAR]: token }, io(false));
    expect(ownerOf().token).toBe(token);
    expect(held.releasedByShell).toBe(true);
    held.release();
    const other = path.join(fs.mkdtempSync(path.join(dir, 'x')), 'target.json');
    const ignored = acquireDbSetupLock(other, { [DB_SETUP_LOCK_TOKEN_VAR]: 'not-a-token' }, io(false));
    expect(ignored.releasedByShell).toBe(false);
    ignored.release();
  });

  it("never removes another run's lock: release checks the owner token", () => {
    const held = acquireDbSetupLock(target, {}, io(false));
    fs.writeFileSync(path.join(lock, DB_SETUP_LOCK_OWNER_FILE), JSON.stringify({ v: 1, token: 'b'.repeat(32) }));
    held.release();
    expect(fs.existsSync(lock)).toBe(true);
  });

  it('DENIAL: a lock path that is not a plain directory (a file, or a symlink to a directory) is refused, never followed', () => {
    fs.writeFileSync(lock, 'x');
    expect(outcome(() => acquireDbSetupLock(target, {}, io(true)))).toBe(DB_SETUP_LOCK_MESSAGES.unusable);
    fs.rmSync(lock);
    if (process.platform !== 'win32') {
      const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'db-setup-lock-elsewhere-'));
      try {
        fs.symlinkSync(elsewhere, lock);
        expect(outcome(() => acquireDbSetupLock(target, {}, io(true)))).toBe(DB_SETUP_LOCK_MESSAGES.unusable);
        expect(fs.readdirSync(elsewhere)).toEqual([]);
      } finally {
        fs.rmSync(elsewhere, { recursive: true, force: true });
      }
    }
  });

  it("the kernel-lock proof needs the marker AND fd 9 being the volume's .db-setup.flock", () => {
    expect(volumeFlockHeld(target, {})).toBe(false);
    fs.writeFileSync(path.join(dir, DB_SETUP_FLOCK_NAME), '');
    // The marker alone proves nothing: fd 9 of this test process is not that file.
    expect(volumeFlockHeld(target, { [DB_SETUP_FLOCK_VAR]: '9' })).toBe(false);
    expect(volumeFlockHeld(target, { [DB_SETUP_FLOCK_VAR]: '8' })).toBe(false);
  });

  it('leftover temp files of a killed run are removed; the pending file, the password file and the target are not', () => {
    const keep = ['owner-password', 'owner-password.next', 'target.json', '.owner-password.tmp', 'notes.tmp'];
    const temps = ['.owner-password.12.abcdef012345.tmp', '.owner-password.next.13.abcdef012345.tmp', '.target.json.14.abcdef012345.tmp'];
    for (const n of [...keep, ...temps]) fs.writeFileSync(path.join(dir, n), 'x');
    expect(removeLeftoverTempFiles(target)).toBe(3);
    expect(fs.readdirSync(dir).sort()).toEqual([...keep].sort());
  });

  it('the module never logs', () => {
    const source = fs.readFileSync(path.join(__dirname, 'db-setup-lock.ts'), 'utf8');
    expect(source).not.toMatch(/console\.|process\.(stdout|stderr)/);
  });
});
