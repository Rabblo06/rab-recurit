import { spawnSync } from 'child_process';
import * as path from 'path';

import { OWNER_LOGIN_ROLE } from '../boot-checks/owner-login-posture';
import { assertRuntimeDatabaseIdentity, resolveRuntimeDatabase, RuntimeDbError } from '../typeorm/core/runtime-database-guard';
import { buildRuntimeDatabaseUrl, deriveOwnerPassword, OWNER_LOGIN } from './owner-credential';
import { checkRuntimeLogin, readRuntimeDbConfig, RuntimeDbConfigError, STARTUP_EXIT_CODES } from './runtime-db-config';

/**
 * DB-SETUP (plan §2.2 / §5.2 / §7.1): the runtime-login rule. In production a runtime process (API, Worker, migrate child)
 * refuses any PG_DATABASE_URL login other than crewflow_owner BEFORE connecting; a crewflow_owner URL passes through unchanged
 * (owner decision D5); every existing guard keeps its own message and order. Fake credentials only; every refusal is checked
 * for the secret, the admin login and the URL.
 */
const SECRET = 'S3cret-PW-do-not-print';
const ADMIN_LOGIN = 'doadmin_sentinel';
const APP_SECRET = 'app-secret-for-unit-tests-only-0123456789abcdef';
const HOST = 'db-sentinel.example.internal';
const ADMIN_URL = `postgres://${ADMIN_LOGIN}:${SECRET}@${HOST}:5432/crewflow?sslmode=verify-full`;
const OWNER_URL = `postgres://crewflow_owner:${SECRET}@${HOST}:5432/crewflow?sslmode=verify-full`;
/** Loopback port 1: nothing listens, so a process that got past the rule would fail with a connect error instead. */
const ADMIN_URL_UNREACHABLE = `postgres://${ADMIN_LOGIN}:${SECRET}@127.0.0.1:1/crewflow?sslmode=require`;
const OWNER_URL_UNREACHABLE = `postgres://crewflow_owner:${SECRET}@127.0.0.1:1/crewflow?sslmode=require`;
const PROD = { NODE_ENV: 'production', RAB_RUNTIME_ENV: 'production' } as const;
const PROCESSES = ['api', 'worker', 'migrate'] as const;
const LOGIN_REFUSAL = /^The (api|worker|migrate) process: PG_DATABASE_URL does not log in as crewflow_owner\. In production a runtime process connects ONLY as crewflow_owner; .*Refusing to start before connecting\.$/;

function expectValueFree(message: string): void {
  expect(message).not.toContain(SECRET);
  expect(message).not.toContain(ADMIN_LOGIN);
  expect(message).not.toContain(HOST);
  expect(message).not.toMatch(/postgres(ql)?:\/\//);
}

function refusalOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected a refusal');
}

describe('runtime-login rule (DB-SETUP plan §2.2): production connects only as crewflow_owner', () => {
  it('the one runtime login is the posture gate\'s login (owner-credential OWNER_LOGIN = owner-login-posture OWNER_LOGIN_ROLE)', () => {
    expect(OWNER_LOGIN).toBe('crewflow_owner');
    expect(OWNER_LOGIN).toBe(OWNER_LOGIN_ROLE);
  });

  it.each(PROCESSES)('production %s: any login other than crewflow_owner is refused (exit 64), value-free', (processName) => {
    for (const url of [
      ADMIN_URL,
      `postgres://postgres:${SECRET}@${HOST}/crewflow?sslmode=verify-full`,
      `postgres://crewflow_app:${SECRET}@${HOST}/crewflow?sslmode=verify-full`,
      // Case and look-alikes are other logins: PostgreSQL compares role names exactly.
      `postgres://Crewflow_Owner:${SECRET}@${HOST}/crewflow?sslmode=verify-full`,
      `postgres://crewflow_owner2:${SECRET}@${HOST}/crewflow?sslmode=verify-full`,
    ]) {
      let thrown: unknown;
      try {
        checkRuntimeLogin({ ...PROD, PG_DATABASE_URL: url }, processName);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(RuntimeDbConfigError);
      expect((thrown as RuntimeDbConfigError).exitCode).toBe(STARTUP_EXIT_CODES.config);
      expect((thrown as Error).message).toMatch(LOGIN_REFUSAL);
      expect((thrown as Error).message.startsWith(`The ${processName} process:`)).toBe(true);
      expectValueFree((thrown as Error).message);
    }
  });

  it('production is detected fail-closed: NODE_ENV, RAB_RUNTIME_ENV or DB_TARGET, any case, padded', () => {
    for (const env of [
      { NODE_ENV: 'production' },
      { RAB_RUNTIME_ENV: 'production' },
      { DB_TARGET: 'production' },
      { NODE_ENV: ' Production ' },
      { RAB_RUNTIME_ENV: 'PRODUCTION' },
    ]) {
      expect(() => checkRuntimeLogin({ ...env, PG_DATABASE_URL: ADMIN_URL }, 'api')).toThrow(LOGIN_REFUSAL);
    }
  });

  it('D5: a crewflow_owner URL passes in production, unchanged — including the byte-identical pass-through of buildRuntimeDatabaseUrl', () => {
    const passThrough = buildRuntimeDatabaseUrl(OWNER_URL, deriveOwnerPassword(APP_SECRET));
    expect(passThrough).toBe(OWNER_URL);
    for (const processName of PROCESSES) {
      const env = { ...PROD, PG_DATABASE_URL: passThrough };
      expect(checkRuntimeLogin(env, processName)).toEqual({ warning: null });
      expect(env.PG_DATABASE_URL).toBe(OWNER_URL); // never rewritten
    }
  });

  it('the runtime URL derived from an admin URL (area 1 buildRuntimeDatabaseUrl) passes in production', () => {
    const runtimeUrl = buildRuntimeDatabaseUrl(ADMIN_URL, deriveOwnerPassword(APP_SECRET));
    for (const processName of PROCESSES) {
      expect(checkRuntimeLogin({ ...PROD, PG_DATABASE_URL: runtimeUrl }, processName)).toEqual({ warning: null });
    }
  });

  it('production: a present but unparseable or policy-refused URL is refused (fail closed), value-free', () => {
    for (const url of [`not-a-url-${SECRET}`, `postgres://${ADMIN_LOGIN}:${SECRET}@${HOST}/crewflow?sslrootcert=/x`, `postgres://crewflow_owner:${SECRET}@${HOST}/crewflow?host=elsewhere`]) {
      const message = refusalOf(() => checkRuntimeLogin({ ...PROD, PG_DATABASE_URL: url }, 'worker'));
      expect(message).toMatch(/^The worker process: PG_DATABASE_URL /);
      // The parser's own message names the accepted schemes literally ("postgres://"), never the value.
      for (const leak of [SECRET, ADMIN_LOGIN, HOST, 'elsewhere', '/x']) expect(message).not.toContain(leak);
    }
  });

  it('an absent PG_DATABASE_URL is not this rule\'s business (pg-config refuses it in production with its own message)', () => {
    expect(checkRuntimeLogin({ ...PROD }, 'api')).toEqual({ warning: null });
    expect(checkRuntimeLogin({ ...PROD, PG_DATABASE_URL: '  ' }, 'api')).toEqual({ warning: null });
  });

  it('outside production: another login is allowed with a value-free warning; crewflow_owner and an unparseable URL give none', () => {
    for (const env of [{}, { NODE_ENV: 'development' }, { NODE_ENV: 'test' }, { NODE_ENV: 'development', RAB_RUNTIME_ENV: 'development' }]) {
      for (const processName of PROCESSES) {
        const { warning } = checkRuntimeLogin({ ...env, PG_DATABASE_URL: ADMIN_URL }, processName);
        expect(warning).toMatch(new RegExp(`^The ${processName} process: PG_DATABASE_URL does not log in as crewflow_owner \\(login not shown\\)\\. Allowed outside production only`));
        expectValueFree(warning!);
        expect(checkRuntimeLogin({ ...env, PG_DATABASE_URL: OWNER_URL }, processName)).toEqual({ warning: null });
        expect(checkRuntimeLogin({ ...env, PG_DATABASE_URL: 'garbage' }, processName)).toEqual({ warning: null });
      }
    }
  });

  it('the rule is NOT part of readRuntimeDbConfig (the prestart shell copy and the bootstrap child hold the admin URL by design)', () => {
    expect(readRuntimeDbConfig({ ...PROD, CREWFLOW_MIGRATE_ON_START: 'true', PG_DATABASE_URL: ADMIN_URL }, { requireMigrateOnStart: true })).toEqual({
      disableDbMigrations: false,
      migrateOnStart: true,
      migrationApprovalMode: 'none',
      upgradeFailurePolicy: 'continue',
    });
  });
});

describe('runtime-login rule in the in-process runtime guard (API, Worker; also check-pending-migrations)', () => {
  const PROD_ENV = (url: string, extra: Record<string, string | undefined> = {}) => ({ ...PROD, PG_DATABASE_URL: url, ...extra });

  it.each(['api', 'worker'] as const)('production %s: the admin URL is refused by resolveRuntimeDatabase (pure, no connection)', (processName) => {
    let thrown: unknown;
    try {
      resolveRuntimeDatabase({ processName, env: PROD_ENV(ADMIN_URL), dotenvValues: {} });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RuntimeDbError);
    expect((thrown as Error).message).toMatch(LOGIN_REFUSAL);
    expectValueFree((thrown as Error).message);
    // D5: the crewflow_owner URL on the same target resolves as before.
    expect(resolveRuntimeDatabase({ processName, env: PROD_ENV(OWNER_URL), dotenvValues: {} }).classification).toBe('PRODUCTION');
  });

  it.each(['api', 'worker'] as const)('production %s: the full boot guard refuses BEFORE any connection (control: crewflow_owner on the same dead port reaches the probe)', async (processName) => {
    const refused = await assertRuntimeDatabaseIdentity(processName, PROD_ENV(ADMIN_URL_UNREACHABLE), {}).then(
      () => 'accepted',
      (error: Error) => error.message,
    );
    expect(refused).toMatch(LOGIN_REFUSAL);
    expect(refused).not.toMatch(/Cannot reach/);
    expectValueFree(refused);
    const control = await assertRuntimeDatabaseIdentity(processName, PROD_ENV(OWNER_URL_UNREACHABLE), {}).then(
      () => 'accepted',
      (error: Error) => error.message,
    );
    expect(control).toMatch(/Cannot reach the PG_DATABASE_URL database for the read-only identity probe/);
  });

  it('every existing guard keeps its own message and runs first (the new rule is added after them, not instead of them)', () => {
    const refuse = (processName: 'api' | 'worker', env: Record<string, string | undefined>) =>
      refusalOf(() => resolveRuntimeDatabase({ processName, env, dotenvValues: {} }));
    // Production declaration consistency.
    expect(refuse('api', { NODE_ENV: 'production', PG_DATABASE_URL: ADMIN_URL })).toMatch(/requires RAB_RUNTIME_ENV=production/);
    // Forbidden names (never-in-runtime-env), including the new PG_DATABASE_PASSWORD.
    expect(refuse('worker', PROD_ENV(ADMIN_URL, { PG_DATABASE_PASSWORD: SECRET }))).toMatch(/^PG_DATABASE_PASSWORD is present in the worker process's environment/);
    expect(refuse('api', PROD_ENV(ADMIN_URL, { DATABASE_URL_UNPOOLED: ADMIN_URL }))).toMatch(/only the provisioner process may hold it/);
    // URL policy and TLS.
    expect(refuse('api', PROD_ENV(ADMIN_URL.replace('verify-full', 'disable')))).toMatch(/sslmode=disable, which production refuses/);
    // Worker: transaction pooler refused (session locks), even for crewflow_owner.
    expect(refuse('worker', PROD_ENV(`postgres://crewflow_owner:${SECRET}@ep-x-pooler.c-2.us-east-2.aws.neon.tech/neondb?sslmode=verify-full`))).toMatch(/transaction-pooler shape/);
    // Deployment identity declaration.
    expect(refuse('api', PROD_ENV(OWNER_URL, { CREWFLOW_DEPLOYMENT_ENVIRONMENT: 'staging', CREWFLOW_DEPLOYMENT_ID: '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f' }))).toMatch(/must declare production/);
    // Production values from a .env file.
    expect(
      refuseWithDotenv('api', PROD_ENV(OWNER_URL), { RAB_RUNTIME_ENV: 'production' }),
    ).toMatch(/present in a \.env file/);
  });

  it('outside production the guard resolves another login unchanged (dev and test suites)', () => {
    const local = `postgres://crewflow_app:${SECRET}@127.0.0.1:55462/rab_test`;
    expect(resolveRuntimeDatabase({ processName: 'api', env: { NODE_ENV: 'development', PG_DATABASE_URL: local }, dotenvValues: {} }).classification).toBe('LOCAL');
    expect(resolveRuntimeDatabase({ processName: 'worker', env: { NODE_ENV: 'test', PG_DATABASE_URL: local }, dotenvValues: {} }).classification).toBe('LOCAL');
  });

  it('the superseded provisioner process is left as it was (its own credential still resolves in production)', () => {
    const provisioner = `postgres://crewflow:${SECRET}@${HOST}/crewflow?sslmode=verify-full`;
    expect(resolveRuntimeDatabase({ processName: 'provisioner', env: PROD_ENV(provisioner), dotenvValues: {} }).classification).toBe('PRODUCTION');
  });
});

function refuseWithDotenv(processName: 'api' | 'worker', env: Record<string, string | undefined>, dotenvValues: Record<string, string>): string {
  return refusalOf(() => resolveRuntimeDatabase({ processName, env, dotenvValues }));
}

describe('runtime-login rule in the migrate child (twenty-migrate.ts), refused before connecting', () => {
  const ENTRY = path.resolve(__dirname, '../typeorm/scripts/migrate/twenty/twenty-migrate.ts');
  const TSCONFIG = path.resolve(__dirname, '../../../tsconfig.app.json');
  const run = (url: string) =>
    spawnSync(process.execPath, [require.resolve('ts-node/dist/bin.js'), '--transpile-only', '-P', TSCONFIG, ENTRY], {
      encoding: 'utf8',
      timeout: 120_000,
      env: { PATH: process.env.PATH ?? '', ...PROD, CREWFLOW_MIGRATE_ON_START: 'true', PG_DATABASE_URL: url },
    });

  it('production + admin URL: exit 64, configuration refused, value-free; control: crewflow_owner on the same dead port tries to connect', () => {
    const refused = run(ADMIN_URL_UNREACHABLE);
    const out = `${refused.stdout}\n${refused.stderr}`;
    expect(refused.status).toBe(STARTUP_EXIT_CODES.config);
    expect(out).toMatch(/\[migrate-on-start\] FAILED \(config\): The migrate process: PG_DATABASE_URL does not log in as crewflow_owner\./);
    expect(out).toMatch(/TWENTY_MIGRATE_RESULT .*"exitCode":64.*"reason":"configuration refused"/);
    expect(out).not.toMatch(/ECONNREFUSED/);
    expectValueFree(out);

    const control = run(OWNER_URL_UNREACHABLE);
    expect(control.status).not.toBe(STARTUP_EXIT_CODES.config);
    expect(`${control.stdout}\n${control.stderr}`).toMatch(/ECONNREFUSED/);
  }, 240_000);
});
