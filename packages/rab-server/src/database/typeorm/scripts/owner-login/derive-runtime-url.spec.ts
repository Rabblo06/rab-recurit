import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

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
