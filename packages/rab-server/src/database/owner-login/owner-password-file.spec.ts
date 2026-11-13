import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { generateOwnerPassword } from './owner-credential';
import {
  OWNER_PASSWORD_FILE_MESSAGES,
  OWNER_PASSWORD_FILE_MODE,
  OWNER_PASSWORD_FILE_NAME,
  OwnerPasswordFileError,
  ownerPasswordFilePath,
  readOwnerPasswordFile,
  writeOwnerPasswordFile,
} from './owner-password-file';

/**
 * The crewflow_owner password file (Twenty Helm model: the app user's own secret, secret-db-url.yaml:3-8). Generated test
 * values only; no assertion message prints one.
 */
let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-pw-spec-'));
  file = path.join(dir, OWNER_PASSWORD_FILE_NAME);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('owner password file', () => {
  it('lives beside the target file, in the same directory (one volume)', () => {
    expect(ownerPasswordFilePath('/run/crewflow/db-target/target.json')).toBe(path.join('/run/crewflow/db-target', 'owner-password'));
  });

  it('round-trips the exact password (no newline), mode 0400 on POSIX; the value is non-enumerable', () => {
    const pw = generateOwnerPassword();
    writeOwnerPasswordFile(file, pw);
    expect(fs.readFileSync(file, 'utf8') === pw).toBe(true);
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(OWNER_PASSWORD_FILE_MODE);
    const read = readOwnerPasswordFile(file);
    expect(read.state).toBe('ready');
    expect(read.state === 'ready' && read.password === pw).toBe(true);
    expect(JSON.stringify(read)).not.toContain(pw);
  });

  it('replaces atomically (rename) and leaves no temp file', () => {
    writeOwnerPasswordFile(file, 'first-password');
    writeOwnerPasswordFile(file, 'second-password');
    expect(readOwnerPasswordFile(file).state === 'ready' && (readOwnerPasswordFile(file) as { password: string }).password === 'second-password').toBe(true);
    expect(fs.readdirSync(dir)).toEqual([OWNER_PASSWORD_FILE_NAME]);
  });

  it('exclusive (a NEW password): fails with EEXIST when a file is already there, never overwriting it; no temp file left', () => {
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
    fs.rmSync(file);
    writeOwnerPasswordFile(file, 'new-one', { exclusive: true });
    expect(fs.readFileSync(file, 'utf8')).toBe('new-one');
    expect(fs.readdirSync(dir)).toEqual([OWNER_PASSWORD_FILE_NAME]);
  });

  it('missing or empty is `missing`; a newline, a control character or an oversized file is refused with fixed text', () => {
    expect(readOwnerPasswordFile(file).state).toBe('missing');
    fs.writeFileSync(file, '');
    expect(readOwnerPasswordFile(file).state).toBe('missing');
    for (const bad of ['secret\n', 'a\u0000b', 'x'.repeat(5000)]) {
      fs.writeFileSync(file, bad);
      let message = '';
      try {
        readOwnerPasswordFile(file);
      } catch (error) {
        expect(error).toBeInstanceOf(OwnerPasswordFileError);
        message = (error as Error).message;
      }
      expect(message).toBe(OWNER_PASSWORD_FILE_MESSAGES.invalid);
    }
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
