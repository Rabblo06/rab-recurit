import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  acquireDbSetupLock,
  DB_SETUP_LOCK_MESSAGES,
  DB_SETUP_LOCK_NAME,
  DB_SETUP_LOCK_OWNER_FILE,
  DB_SETUP_LOCK_STALE_MS,
  DB_SETUP_LOCK_TOKEN_VAR,
  DbSetupLockError,
  type DbSetupLockIo,
  dbSetupLockPath,
  isStaleLock,
  removeLeftoverTempFiles,
} from './db-setup-lock';

/**
 * Security re-review F1: one db-setup run per setup volume (an exclusive lock directory in the volume). The denial cases:
 * a held lock stops the second run (exit 70 upstream); only a stale lock is taken over; a run never removes another run's
 * lock.
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

const io = (o: Partial<DbSetupLockIo> = {}): DbSetupLockIo => ({
  now: () => 1_000_000_000,
  pid: () => 4242,
  host: () => 'container-a',
  bootId: () => '11111111-1111-1111-1111-111111111111',
  pidAlive: () => true,
  ...o,
});
const owner = () => JSON.parse(fs.readFileSync(path.join(lock, DB_SETUP_LOCK_OWNER_FILE), 'utf8')) as Record<string, unknown>;
const heldBy = (o: Record<string, unknown>) => {
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, DB_SETUP_LOCK_OWNER_FILE), JSON.stringify({ v: 1, token: 'f'.repeat(32), host: 'container-b', pid: 7, boot: '11111111-1111-1111-1111-111111111111', started: 1_000_000_000, ...o }));
};

describe('db-setup lock', () => {
  it('lives in the setup volume beside the target; the holder records who it is; release removes it', () => {
    expect(lock).toBe(path.join(dir, DB_SETUP_LOCK_NAME));
    const held = acquireDbSetupLock(target, {}, io());
    expect(fs.statSync(lock).isDirectory()).toBe(true);
    expect(owner()).toMatchObject({ v: 1, host: 'container-a', pid: 4242, boot: '11111111-1111-1111-1111-111111111111' });
    expect(String(owner().token)).toMatch(/^[0-9a-f]{32}$/);
    expect(held.releasedByShell).toBe(false);
    held.release();
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('DENIAL: a second run while the lock is held stops with fixed text (another host, live, recent); the lock stays', () => {
    const first = acquireDbSetupLock(target, {}, io());
    let error: unknown = null;
    try {
      acquireDbSetupLock(target, {}, io({ host: () => 'container-b', pid: () => 9 }));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(DbSetupLockError);
    expect((error as Error).message).toBe(DB_SETUP_LOCK_MESSAGES.held);
    expect(fs.existsSync(lock)).toBe(true);
    first.release();
  });

  it('db-setup.sh token: used as the owner token, and release by this process is left to the shell', () => {
    const token = 'a'.repeat(32);
    const held = acquireDbSetupLock(target, { [DB_SETUP_LOCK_TOKEN_VAR]: token }, io());
    expect(owner().token).toBe(token);
    expect(held.releasedByShell).toBe(true);
    const ignored = acquireDbSetupLock(path.join(fs.mkdtempSync(path.join(dir, 'x')), 'target.json'), { [DB_SETUP_LOCK_TOKEN_VAR]: 'not-a-token' }, io());
    expect(ignored.releasedByShell).toBe(false);
    ignored.release();
  });

  it('never removes another run\'s lock: release checks the owner token', () => {
    const held = acquireDbSetupLock(target, {}, io());
    fs.writeFileSync(path.join(lock, DB_SETUP_LOCK_OWNER_FILE), JSON.stringify({ ...owner(), token: 'b'.repeat(32) }));
    held.release();
    expect(fs.existsSync(lock)).toBe(true);
  });

  it('stale: another boot; a dead pid (or this pid) on the same host; older than the bound; an unreadable owner by age only', () => {
    heldBy({ boot: '22222222-2222-2222-2222-222222222222' });
    expect(isStaleLock(lock, io())).toBe(true);
    fs.rmSync(lock, { recursive: true });
    heldBy({ host: 'container-a', pid: 7 });
    expect(isStaleLock(lock, io({ pidAlive: () => false }))).toBe(true);
    expect(isStaleLock(lock, io({ pidAlive: () => true }))).toBe(false);
    expect(isStaleLock(lock, io({ pid: () => 7 }))).toBe(true);
    fs.rmSync(lock, { recursive: true });
    heldBy({});
    expect(isStaleLock(lock, io())).toBe(false); // another host, recent: never taken over
    expect(isStaleLock(lock, io({ now: () => 1_000_000_000 + DB_SETUP_LOCK_STALE_MS + 1 }))).toBe(true);
    fs.writeFileSync(path.join(lock, DB_SETUP_LOCK_OWNER_FILE), 'garbage');
    expect(isStaleLock(lock, io({ now: () => Date.now() }))).toBe(false);
    expect(isStaleLock(lock, io({ now: () => Date.now() + DB_SETUP_LOCK_STALE_MS + 60_000 }))).toBe(true);
  });

  it('a stale lock is taken over once (the new owner is this run)', () => {
    heldBy({ boot: '22222222-2222-2222-2222-222222222222' });
    const held = acquireDbSetupLock(target, {}, io());
    expect(owner()).toMatchObject({ host: 'container-a', pid: 4242 });
    held.release();
  });

  it('DENIAL: a lock path that is not a plain directory (a file, or a symlink to a directory) is refused, never followed', () => {
    fs.writeFileSync(lock, 'x');
    expect(() => acquireDbSetupLock(target, {}, io())).toThrow(DB_SETUP_LOCK_MESSAGES.unusable);
    fs.rmSync(lock);
    if (process.platform !== 'win32') {
      const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'db-setup-lock-elsewhere-'));
      try {
        fs.symlinkSync(elsewhere, lock);
        expect(() => acquireDbSetupLock(target, {}, io())).toThrow(DB_SETUP_LOCK_MESSAGES.unusable);
        expect(fs.readdirSync(elsewhere)).toEqual([]);
      } finally {
        fs.rmSync(elsewhere, { recursive: true, force: true });
      }
    }
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
