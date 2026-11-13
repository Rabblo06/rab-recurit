import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { type DbTarget, runtimeUrlFromDbTarget } from '../../../owner-login/db-target';
import { writeDbTargetFile } from '../../../owner-login/db-target-file';
import { generateOwnerPassword } from '../../../owner-login/owner-credential';
import { ownerPasswordFilePath, writeOwnerPasswordFile } from '../../../owner-login/owner-password-file';
import { parsePgUrl } from '../../../postgres/pg-url-policy';

import { DERIVE_EXIT, DERIVE_MESSAGES, type DeriveIo, runDeriveRuntimeUrl } from './derive-runtime-url';

/**
 * The Twenty Helm model (OWNER-DB-FINAL.md Part A): the apps' derive step builds the crewflow_owner URL from db-setup's
 * credential-free target file + the crewflow_owner password file (both read-only for the apps). It never connects (never
 * imports pg), never reads APP_SECRET, writes ONLY the runtime URL to fd 4, and prints fixed, value-free lines. Every secret
 * here is a generated test value; no assertion message prints one.
 */
const OWNER_PASSWORD = generateOwnerPassword();
const OTHER_PASSWORD = 'otherSentinel9c2e';
const OWNER_URL = `postgres://crewflow_owner:${OTHER_PASSWORD}@db:5432/crewflow?sslmode=verify-full`;
const ADMIN_URL = `postgres://postgres:${OTHER_PASSWORD}@db:5432/crewflow?sslmode=verify-full`;
const TARGET: DbTarget = { v: 1, host: 'db', port: 5432, database: 'crewflow', params: { sslmode: 'verify-full' } };

function capture(write?: (url: string) => void): { io: DeriveIo; written: string[]; out: string[]; err: string[] } {
  const written: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  return { io: { writeRuntimeUrl: write ?? ((url) => written.push(url)), log: (l) => out.push(l), error: (l) => err.push(l) }, written, out, err };
}

function noSecret(lines: string[]): boolean {
  const text = lines.join('\n');
  return !text.includes(OWNER_PASSWORD) && !text.includes(OTHER_PASSWORD) && !text.includes('postgres://');
}

let dir: string;
let file: string;
let pwFile: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'derive-spec-'));
  file = path.join(dir, 'target.json');
  pwFile = ownerPasswordFilePath(file);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('derive-runtime-url from the target file + the password file', () => {
  it('both ready: writes exactly the crewflow_owner URL for the target and the stored password, exit 0, no APP_SECRET', () => {
    writeDbTargetFile(file, TARGET);
    writeOwnerPasswordFile(pwFile, OWNER_PASSWORD);
    const c = capture();
    expect(runDeriveRuntimeUrl({ CREWFLOW_DB_TARGET_FILE: file }, c.io)).toBe(DERIVE_EXIT.ok);
    expect(c.written).toHaveLength(1);
    expect(c.written[0] === runtimeUrlFromDbTarget(TARGET, OWNER_PASSWORD)).toBe(true);
    const parsed = parsePgUrl(c.written[0] as string, 't');
    expect(parsed.user).toBe('crewflow_owner');
    expect(parsed.password === OWNER_PASSWORD).toBe(true);
    expect(c.out).toEqual([DERIVE_MESSAGES.fromTarget]);
    expect(noSecret([...c.out, ...c.err])).toBe(true);
  });

  it('an APP_SECRET in the environment plays no part (same URL with or without it, or with another one)', () => {
    writeDbTargetFile(file, TARGET);
    writeOwnerPasswordFile(pwFile, OWNER_PASSWORD);
    const urls = [{}, { APP_SECRET: 'a'.repeat(40) }, { APP_SECRET: 'b'.repeat(40) }].map((extra) => {
      const c = capture();
      expect(runDeriveRuntimeUrl({ CREWFLOW_DB_TARGET_FILE: file, ...extra }, c.io)).toBe(DERIVE_EXIT.ok);
      return c.written[0];
    });
    expect(new Set(urls).size).toBe(1);
  });

  it('target missing or empty: exit 75 "db target not ready", nothing written', () => {
    writeOwnerPasswordFile(pwFile, OWNER_PASSWORD);
    for (const prepare of [() => undefined, () => fs.writeFileSync(file, '  \n')]) {
      prepare();
      const c = capture();
      expect(runDeriveRuntimeUrl({ CREWFLOW_DB_TARGET_FILE: file }, c.io)).toBe(DERIVE_EXIT.notReady);
      expect(c.written).toEqual([]);
      expect(c.err).toEqual([DERIVE_MESSAGES.targetNotReady]);
    }
  });

  it('password file missing or empty: exit 75 "password file not there yet", nothing written', () => {
    writeDbTargetFile(file, TARGET);
    for (const prepare of [() => undefined, () => fs.writeFileSync(pwFile, '')]) {
      prepare();
      const c = capture();
      expect(runDeriveRuntimeUrl({ CREWFLOW_DB_TARGET_FILE: file }, c.io)).toBe(DERIVE_EXIT.notReady);
      expect(c.written).toEqual([]);
      expect(c.err).toEqual([DERIVE_MESSAGES.passwordNotReady]);
    }
  });

  it('a malformed password file (newline, control character, oversized): exit 64, nothing written, value never echoed', () => {
    writeDbTargetFile(file, TARGET);
    for (const bad of [`${OWNER_PASSWORD}\n`, `a\u0001b`, 'x'.repeat(5000)]) {
      fs.rmSync(pwFile, { force: true });
      fs.writeFileSync(pwFile, bad);
      const c = capture();
      expect(runDeriveRuntimeUrl({ CREWFLOW_DB_TARGET_FILE: file }, c.io)).toBe(DERIVE_EXIT.refused);
      expect(c.written).toEqual([]);
      expect(noSecret(c.err)).toBe(true);
    }
  });

  it('a malformed target (unknown key, not JSON): exit 64, nothing written', () => {
    writeOwnerPasswordFile(pwFile, OWNER_PASSWORD);
    for (const text of ['{"v":1,"host":"db","port":5432,"database":"crewflow","params":{},"user":"x"}\n', 'not json']) {
      fs.writeFileSync(file, text);
      const c = capture();
      expect(runDeriveRuntimeUrl({ CREWFLOW_DB_TARGET_FILE: file }, c.io)).toBe(DERIVE_EXIT.refused);
      expect(c.written).toEqual([]);
    }
  });

  it('the target file AND any PG_DATABASE_URL (admin or crewflow_owner): exit 64, nothing written', () => {
    writeDbTargetFile(file, TARGET);
    writeOwnerPasswordFile(pwFile, OWNER_PASSWORD);
    for (const url of [ADMIN_URL, OWNER_URL]) {
      const c = capture();
      expect(runDeriveRuntimeUrl({ CREWFLOW_DB_TARGET_FILE: file, PG_DATABASE_URL: url }, c.io)).toBe(DERIVE_EXIT.refused);
      expect(c.written).toEqual([]);
      expect(c.err).toEqual([DERIVE_MESSAGES.targetWithAdminUrl]);
    }
  });

  it('a relative CREWFLOW_DB_TARGET_FILE is refused (64)', () => {
    const c = capture();
    expect(runDeriveRuntimeUrl({ CREWFLOW_DB_TARGET_FILE: 'relative/target.json' }, c.io)).toBe(DERIVE_EXIT.refused);
  });

  it('fd 4 not open: exit 64 with the usage line; any other write error: exit 70', () => {
    writeDbTargetFile(file, TARGET);
    writeOwnerPasswordFile(pwFile, OWNER_PASSWORD);
    const ebadf = capture(() => {
      throw Object.assign(new Error('EBADF'), { code: 'EBADF' });
    });
    expect(runDeriveRuntimeUrl({ CREWFLOW_DB_TARGET_FILE: file }, ebadf.io)).toBe(DERIVE_EXIT.refused);
    expect(ebadf.err).toEqual([DERIVE_MESSAGES.fdNotOpen]);
    const other = capture(() => {
      throw Object.assign(new Error('EIO'), { code: 'EIO' });
    });
    expect(runDeriveRuntimeUrl({ CREWFLOW_DB_TARGET_FILE: file }, other.io)).toBe(DERIVE_EXIT.unexpected);
  });
});

describe('derive-runtime-url without a target file (development only)', () => {
  it('a crewflow_owner PG_DATABASE_URL is written back unchanged', () => {
    const c = capture();
    expect(runDeriveRuntimeUrl({ PG_DATABASE_URL: OWNER_URL }, c.io)).toBe(DERIVE_EXIT.ok);
    expect(c.written).toEqual([OWNER_URL]);
    expect(c.out).toEqual([DERIVE_MESSAGES.passThrough]);
  });

  it('an admin URL, or nothing at all, is refused (64): there is no crewflow_owner credential to build', () => {
    for (const env of [{ PG_DATABASE_URL: ADMIN_URL }, {}, { DATABASE_URL: OWNER_URL, NODE_ENV: 'production' }]) {
      const c = capture();
      expect(runDeriveRuntimeUrl(env, c.io)).toBe(DERIVE_EXIT.refused);
      expect(c.written).toEqual([]);
      expect(c.err).toEqual([DERIVE_MESSAGES.noTargetNoOwnerUrl]);
      expect(noSecret(c.err)).toBe(true);
    }
  });

  it('refuses a policy-invalid URL without echoing it', () => {
    const c = capture();
    expect(runDeriveRuntimeUrl({ PG_DATABASE_URL: `${OWNER_URL}&sslrootcert=/x` }, c.io)).toBe(DERIVE_EXIT.refused);
    expect(noSecret(c.err)).toBe(true);
  });
});

describe('derive-runtime-url never connects and never reads APP_SECRET', () => {
  it('loading it (and everything it imports) never requires pg', () => {
    jest.isolateModules(() => {
      jest.doMock('pg', () => {
        throw new Error('derive-runtime-url must never load pg');
      });
      jest.doMock('pg-pool', () => {
        throw new Error('derive-runtime-url must never load pg-pool');
      });
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('./derive-runtime-url') as typeof import('./derive-runtime-url');
      writeDbTargetFile(file, TARGET);
      writeOwnerPasswordFile(pwFile, OWNER_PASSWORD);
      const c = capture();
      expect(mod.runDeriveRuntimeUrl({ CREWFLOW_DB_TARGET_FILE: file }, c.io)).toBe(DERIVE_EXIT.ok);
    });
  });

  it('the source never mentions APP_SECRET or an HKDF derivation', () => {
    const source = fs.readFileSync(path.join(__dirname, 'derive-runtime-url.ts'), 'utf8');
    expect(source).not.toMatch(/env\.APP_SECRET|hkdf|deriveOwnerPassword/i);
  });
});

/** The real process, as api-prestart.sh / worker-start.sh run it: the URL on fd 4, fixed text on stdout/stderr. */
describe('derive-runtime-url as a process', () => {
  const SCRIPT = path.join(__dirname, 'derive-runtime-url.ts');
  const TSCONFIG = path.resolve(__dirname, '../../../../../tsconfig.app.json');
  const run = (env: Record<string, string>, fd4: boolean) => {
    const result = spawnSync(process.execPath, ['-r', 'ts-node/register/transpile-only', SCRIPT], {
      env: { PATH: process.env.PATH ?? '', SYSTEMROOT: process.env.SYSTEMROOT ?? '', TS_NODE_PROJECT: TSCONFIG, ...env },
      stdio: fd4 ? ['ignore', 'pipe', 'pipe', 'ignore', 'pipe'] : ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: 60_000,
    });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', fd4: (result.output[4] as string | null) ?? '' };
  };

  it('exit 75 while a file is missing; then the URL on fd 4 only (exit 0); exit 64 when fd 4 is not open', () => {
    const missing = run({ CREWFLOW_DB_TARGET_FILE: file }, true);
    expect(missing.status).toBe(75);
    expect(missing.stderr).toBe(`${DERIVE_MESSAGES.targetNotReady}\n`);
    expect(missing.fd4).toBe('');
    writeDbTargetFile(file, TARGET);
    const noPw = run({ CREWFLOW_DB_TARGET_FILE: file }, true);
    expect(noPw.status).toBe(75);
    expect(noPw.stderr).toBe(`${DERIVE_MESSAGES.passwordNotReady}\n`);
    writeOwnerPasswordFile(pwFile, OWNER_PASSWORD);
    const ready = run({ CREWFLOW_DB_TARGET_FILE: file }, true);
    expect(ready.status).toBe(0);
    const built = parsePgUrl(ready.fd4, 'fd4');
    expect(built.user).toBe('crewflow_owner');
    expect(built.password === OWNER_PASSWORD).toBe(true);
    expect(ready.stdout).toBe(`${DERIVE_MESSAGES.fromTarget}\n`);
    expect(noSecret([ready.stdout, ready.stderr])).toBe(true);
    const noFd = run({ CREWFLOW_DB_TARGET_FILE: file }, false);
    expect(noFd.status).toBe(64);
    expect(noFd.stderr).toBe(`${DERIVE_MESSAGES.fdNotOpen}\n`);
  }, 180_000);
});
