import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { type DbTarget } from '../../../owner-login/db-target';
import { writeDbTargetFile } from '../../../owner-login/db-target-file';
import { parsePgUrl } from '../../../postgres/pg-url-policy';

import {
  buildRuntimeDatabaseUrl,
  deriveOwnerPassword,
  OWNER_CREDENTIAL_MESSAGES,
} from '../../../owner-login/owner-credential';

import {
  DERIVE_EXIT,
  DERIVE_MESSAGES,
  type DeriveIo,
  runDeriveRuntimeUrl,
} from './derive-runtime-url';

/**
 * DB-SETUP-PLAN §5.1 / §5.3 / §10 B10: the derive step never connects (never imports pg), writes ONLY the runtime URL to
 * fd 4, and prints fixed, value-free lines. Every secret here is a generated test value; no assertion message prints one.
 */
const APP_SECRET = 'derive-spec-app-secret-0123456789abcdef';
const ADMIN_PASSWORD = 'adminSentinel9c2e';
const ADMIN_URL = `postgres://postgres:${ADMIN_PASSWORD}@db:5432/crewflow?sslmode=verify-full`;
const OWNER_URL = `postgres://crewflow_owner:${ADMIN_PASSWORD}@db:5432/crewflow?sslmode=verify-full`;
const DERIVED = deriveOwnerPassword(APP_SECRET);

function capture(write?: (url: string) => void): {
  io: DeriveIo;
  written: string[];
  out: string[];
  err: string[];
} {
  const written: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      writeRuntimeUrl: write ?? ((url) => written.push(url)),
      log: (l) => out.push(l),
      error: (l) => err.push(l),
    },
    written,
    out,
    err,
  };
}

function noSecret(lines: string[]): boolean {
  const text = lines.join('\n');
  return (
    !text.includes(ADMIN_PASSWORD) &&
    !text.includes(DERIVED) &&
    !text.includes('postgres://')
  );
}

describe('runDeriveRuntimeUrl', () => {
  it('bootstrap mode: writes exactly the runtime URL, prints a fixed line', () => {
    const c = capture();
    expect(
      runDeriveRuntimeUrl({ PG_DATABASE_URL: ADMIN_URL, APP_SECRET }, c.io),
    ).toBe(DERIVE_EXIT.ok);
    expect(c.written).toHaveLength(1);
    expect(c.written[0] === buildRuntimeDatabaseUrl(ADMIN_URL, DERIVED)).toBe(
      true,
    );
    expect(c.out).toEqual([DERIVE_MESSAGES.bootstrap]);
    expect(c.err).toEqual([]);
    expect(noSecret([...c.out, ...c.err])).toBe(true);
  });

  it('pass-through mode: writes PG_DATABASE_URL unchanged, APP_SECRET not needed', () => {
    const c = capture();
    expect(runDeriveRuntimeUrl({ PG_DATABASE_URL: OWNER_URL }, c.io)).toBe(
      DERIVE_EXIT.ok,
    );
    expect(c.written.length === 1 && c.written[0] === OWNER_URL).toBe(true);
    expect(c.out).toEqual([DERIVE_MESSAGES.passThrough]);
  });

  it('reads only PG_DATABASE_URL and APP_SECRET (legacy names and other variables are ignored)', () => {
    const c = capture();
    expect(
      runDeriveRuntimeUrl(
        {
          DATABASE_URL: OWNER_URL,
          PG_DATABASE_PASSWORD: ADMIN_PASSWORD,
          APP_SECRET,
        },
        c.io,
      ),
    ).toBe(DERIVE_EXIT.refused);
    expect(c.err).toEqual([
      `derive-runtime-url: ${OWNER_CREDENTIAL_MESSAGES.databaseUrlMissing}`,
    ]);
  });

  it('ignores the legacy DATABASE_URL in production too, and trims PG_DATABASE_URL like every other reader', () => {
    const legacy = capture();
    expect(
      runDeriveRuntimeUrl(
        { NODE_ENV: 'production', DATABASE_URL: OWNER_URL, APP_SECRET },
        legacy.io,
      ),
    ).toBe(DERIVE_EXIT.refused);
    expect(legacy.written).toEqual([]);
    const padded = capture();
    expect(
      runDeriveRuntimeUrl(
        {
          PG_DATABASE_URL: `  ${OWNER_URL}
`,
        },
        padded.io,
      ),
    ).toBe(DERIVE_EXIT.ok);
    expect(padded.written.length === 1 && padded.written[0] === OWNER_URL).toBe(
      true,
    );
  });

  it.each([
    [
      'missing APP_SECRET',
      { PG_DATABASE_URL: ADMIN_URL },
      OWNER_CREDENTIAL_MESSAGES.appSecretMissing,
    ],
    [
      'short APP_SECRET',
      { PG_DATABASE_URL: ADMIN_URL, APP_SECRET: 'too-short' },
      OWNER_CREDENTIAL_MESSAGES.appSecretShort,
    ],
    [
      'a pooler admin URL',
      {
        PG_DATABASE_URL: ADMIN_URL.replace(
          'db:5432',
          'ep-a-1-pooler.eu.aws.neon.tech',
        ),
        APP_SECRET,
      },
      OWNER_CREDENTIAL_MESSAGES.transactionPooler,
    ],
  ])(
    'refuses %s: exit 64, fixed message, nothing written',
    (_name, env, message) => {
      const c = capture();
      expect(runDeriveRuntimeUrl(env, c.io)).toBe(DERIVE_EXIT.refused);
      expect(c.written).toEqual([]);
      expect(c.err).toEqual([`derive-runtime-url: ${message}`]);
      expect(noSecret([...c.out, ...c.err])).toBe(true);
    },
  );

  it('refuses sslrootcert without echoing the URL', () => {
    const c = capture();
    expect(
      runDeriveRuntimeUrl(
        { PG_DATABASE_URL: `${ADMIN_URL}&sslrootcert=/x.pem`, APP_SECRET },
        c.io,
      ),
    ).toBe(DERIVE_EXIT.refused);
    expect(c.err.join('')).toMatch(/sslrootcert/);
    expect(noSecret(c.err)).toBe(true);
  });

  it('fd 4 not open: exit 64 with the usage line; any other write error: exit 70', () => {
    const ebadf = capture(() => {
      throw Object.assign(new Error('EBADF'), { code: 'EBADF' });
    });
    expect(
      runDeriveRuntimeUrl({ PG_DATABASE_URL: ADMIN_URL, APP_SECRET }, ebadf.io),
    ).toBe(DERIVE_EXIT.refused);
    expect(ebadf.err).toEqual([DERIVE_MESSAGES.fdNotOpen]);
    const other = capture(() => {
      throw Object.assign(new Error('EPIPE'), { code: 'EPIPE' });
    });
    expect(
      runDeriveRuntimeUrl({ PG_DATABASE_URL: ADMIN_URL, APP_SECRET }, other.io),
    ).toBe(DERIVE_EXIT.unexpected);
    expect(other.err).toEqual([DERIVE_MESSAGES.unexpected]);
  });
});

describe('derive-runtime-url never connects', () => {
  it('loading it (and everything it imports) never requires pg', () => {
    jest.isolateModules(() => {
      jest.doMock('pg', () => {
        throw new Error('derive-runtime-url must never load pg');
      });
      jest.doMock('pg-pool', () => {
        throw new Error('derive-runtime-url must never load pg-pool');
      });
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod =
        require('./derive-runtime-url') as typeof import('./derive-runtime-url');
      const c = capture();
      expect(
        mod.runDeriveRuntimeUrl(
          { PG_DATABASE_URL: ADMIN_URL, APP_SECRET },
          c.io,
        ),
      ).toBe(DERIVE_EXIT.ok);
    });
  });
});

/** The real process, as api-prestart.sh / worker-start.sh run it: the URL on fd 4, fixed text on stdout/stderr. */
describe('derive-runtime-url as a process', () => {
  const SCRIPT = path.join(__dirname, 'derive-runtime-url.ts');
  const TSCONFIG = path.resolve(__dirname, '../../../../../tsconfig.app.json');

  function run(
    env: Record<string, string>,
    fd4: boolean,
  ): { status: number | null; stdout: string; stderr: string; fd4: string } {
    const result = spawnSync(
      process.execPath,
      ['-r', 'ts-node/register/transpile-only', SCRIPT],
      {
        env: {
          PATH: process.env.PATH ?? '',
          SYSTEMROOT: process.env.SYSTEMROOT ?? '',
          TS_NODE_PROJECT: TSCONFIG,
          ...env,
        },
        stdio: fd4
          ? ['ignore', 'pipe', 'pipe', 'ignore', 'pipe']
          : ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
        timeout: 60_000,
      },
    );
    return {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      fd4: (result.output[4] as string | null) ?? '',
    };
  }

  it('writes the runtime URL on fd 4 only, exit 0', () => {
    const r = run({ PG_DATABASE_URL: ADMIN_URL, APP_SECRET }, true);
    expect(r.status).toBe(0);
    expect(r.fd4 === buildRuntimeDatabaseUrl(ADMIN_URL, DERIVED)).toBe(true);
    expect(r.stdout).toBe(`${DERIVE_MESSAGES.bootstrap}\n`);
    expect(noSecret([r.stdout, r.stderr])).toBe(true);
  }, 90_000);

  it('refuses with exit 64 when fd 4 is not open', () => {
    const r = run({ PG_DATABASE_URL: ADMIN_URL, APP_SECRET }, false);
    expect(r.status).toBe(64);
    expect(r.stderr).toBe(`${DERIVE_MESSAGES.fdNotOpen}\n`);
    expect(noSecret([r.stdout, r.stderr])).toBe(true);
  }, 90_000);

  it('refuses with exit 64 and writes nothing for a missing APP_SECRET', () => {
    const r = run({ PG_DATABASE_URL: ADMIN_URL }, true);
    expect(r.status).toBe(64);
    expect(r.fd4).toBe('');
    expect(r.stderr).toBe(
      `derive-runtime-url: ${OWNER_CREDENTIAL_MESSAGES.appSecretMissing}\n`,
    );
  }, 90_000);
});

/** Option A (PR #125): the apps derive the crewflow_owner URL from the credential-free target file + HKDF(APP_SECRET). */
describe('derive-runtime-url from CREWFLOW_DB_TARGET_FILE', () => {
  const TARGET: DbTarget = {
    v: 1,
    host: 'db',
    port: 5432,
    database: 'crewflow',
    params: { sslmode: 'verify-full' },
  };
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'derive-target-spec-'));
    file = path.join(dir, 'target.json');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('ready: writes the crewflow_owner URL for the target and the derived password, exit 0', () => {
    writeDbTargetFile(file, TARGET);
    const c = capture();
    expect(
      runDeriveRuntimeUrl(
        { CREWFLOW_DB_TARGET_FILE: file, APP_SECRET },
        c.io,
      ),
    ).toBe(DERIVE_EXIT.ok);
    expect(c.written).toHaveLength(1);
    const built = parsePgUrl(c.written[0] as string, 'built');
    const direct = parsePgUrl(buildRuntimeDatabaseUrl(ADMIN_URL, DERIVED), 'direct');
    expect(built.canonicalKey).toBe(direct.canonicalKey);
    expect(built.password === DERIVED).toBe(true);
    expect(built.sslmode).toBe('verify-full');
    expect(c.out).toEqual([DERIVE_MESSAGES.fromTarget]);
    expect(noSecret([...c.out, ...c.err])).toBe(true);
  });

  it('missing or empty file: exit 75, fixed "db target not ready", nothing written', () => {
    for (const prepare of [() => undefined, () => fs.writeFileSync(file, ''), () => fs.writeFileSync(file, '\n')]) {
      prepare();
      const c = capture();
      expect(
        runDeriveRuntimeUrl(
          { CREWFLOW_DB_TARGET_FILE: file, APP_SECRET },
          c.io,
        ),
      ).toBe(DERIVE_EXIT.notReady);
      expect(DERIVE_EXIT.notReady).toBe(75);
      expect(c.err).toEqual([DERIVE_MESSAGES.targetNotReady]);
      expect(c.written).toEqual([]);
    }
  });

  it('malformed file (unknown key, unknown param, not JSON, refused by the URL policy): exit 64, nothing written', () => {
    for (const text of [
      JSON.stringify({ ...TARGET, user: 'postgres' }),
      JSON.stringify({ ...TARGET, params: { sslrootcert: '/etc/x' } }),
      '{not json',
      `${JSON.stringify({ ...TARGET, params: { sslmode: 'bogus' } })}\n`,
    ]) {
      fs.writeFileSync(file, text);
      const c = capture();
      expect(
        runDeriveRuntimeUrl(
          { CREWFLOW_DB_TARGET_FILE: file, APP_SECRET },
          c.io,
        ),
      ).toBe(DERIVE_EXIT.refused);
      expect(c.written).toEqual([]);
      expect(c.err).toHaveLength(1);
      expect(c.err[0]).not.toContain('/etc/x');
      expect(c.err[0]).not.toContain('bogus');
    }
  });

  it('target file AND a non-owner PG_DATABASE_URL: exit 64 (the apps never hold the admin URL), nothing written', () => {
    writeDbTargetFile(file, TARGET);
    for (const url of [ADMIN_URL, 'not a url']) {
      const c = capture();
      expect(
        runDeriveRuntimeUrl(
          { CREWFLOW_DB_TARGET_FILE: file, PG_DATABASE_URL: url, APP_SECRET },
          c.io,
        ),
      ).toBe(DERIVE_EXIT.refused);
      expect(c.err).toEqual([DERIVE_MESSAGES.targetWithAdminUrl]);
      expect(c.written).toEqual([]);
      expect(noSecret(c.err)).toBe(true);
    }
  });

  it('target file AND a crewflow_owner PG_DATABASE_URL: the unchanged pass-through', () => {
    const c = capture();
    expect(
      runDeriveRuntimeUrl(
        { CREWFLOW_DB_TARGET_FILE: file, PG_DATABASE_URL: OWNER_URL },
        c.io,
      ),
    ).toBe(DERIVE_EXIT.ok);
    expect(c.written).toEqual([OWNER_URL]);
    expect(c.out).toEqual([DERIVE_MESSAGES.passThrough]);
  });

  it('ready target but a missing APP_SECRET: exit 64 with the credential message', () => {
    writeDbTargetFile(file, TARGET);
    const c = capture();
    expect(
      runDeriveRuntimeUrl({ CREWFLOW_DB_TARGET_FILE: file }, c.io),
    ).toBe(DERIVE_EXIT.refused);
    expect(c.err).toEqual([
      `derive-runtime-url: ${OWNER_CREDENTIAL_MESSAGES.appSecretMissing}`,
    ]);
  });

  it('a relative CREWFLOW_DB_TARGET_FILE is refused (64)', () => {
    const c = capture();
    expect(
      runDeriveRuntimeUrl(
        { CREWFLOW_DB_TARGET_FILE: 'relative/target.json', APP_SECRET },
        c.io,
      ),
    ).toBe(DERIVE_EXIT.refused);
  });

  it('as a process: the URL on fd 4 (exit 0); exit 75 while the file is missing', () => {
    const SCRIPT = path.join(__dirname, 'derive-runtime-url.ts');
    const TSCONFIG = path.resolve(__dirname, '../../../../../tsconfig.app.json');
    const run = () =>
      spawnSync(process.execPath, ['-r', 'ts-node/register/transpile-only', SCRIPT], {
        env: {
          PATH: process.env.PATH ?? '',
          SYSTEMROOT: process.env.SYSTEMROOT ?? '',
          TS_NODE_PROJECT: TSCONFIG,
          CREWFLOW_DB_TARGET_FILE: file,
          APP_SECRET,
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ignore', 'pipe'],
        encoding: 'utf8',
        timeout: 60_000,
      });
    const missing = run();
    expect(missing.status).toBe(75);
    expect(missing.stderr).toBe(`${DERIVE_MESSAGES.targetNotReady}\n`);
    expect((missing.output[4] as string | null) ?? '').toBe('');
    writeDbTargetFile(file, TARGET);
    const ready = run();
    expect(ready.status).toBe(0);
    const built = parsePgUrl((ready.output[4] as string | null) ?? '', 'fd4');
    expect(built.user).toBe('crewflow_owner');
    expect(built.password === DERIVED).toBe(true);
    expect(noSecret([ready.stdout, ready.stderr])).toBe(true);
  }, 120_000);
});
