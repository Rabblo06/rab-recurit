import {
  ALLOW_REMOTE_TEST_DATABASE,
  TEST_DATABASE_ADMIN_URL,
  TEST_DATABASE_ADMIN_URL_NAMES,
  TEST_DATABASE_URL,
  TEST_DATABASE_URL_UNPOOLED,
  TEST_DATABASE_WORKER_URL,
  TestDatabaseConfigError,
  WORKER_LOGIN_FORBIDDEN_LOGIN_SOURCES,
  applyIntegrationTestDatabaseEnv,
  applyWorkerLoginTestDatabaseEnv,
  assertWorkerLoginNotPrivilegedAtRuntime,
  isLoopbackAlias,
  laterDotenvValues,
  resolveForJestGlobalSetup,
  resolveIntegrationTestDatabase,
  resolveTestDatabaseAdminUrl,
  testDatabaseAdminNameNotice,
} from './test-database-guard';

// Obviously fake credentials. The abuse tests assert these never appear in any error message.
const SECRET = 'S3cret-PW-do-not-print';
const LOCAL_APP = `postgres://rab_app:${SECRET}@127.0.0.1:55462/rab_test_a`;
const LOCAL_ADMIN = `postgres://rab_owner:${SECRET}@127.0.0.1:55462/rab_test_a`;
const LOCAL_OTHER_DB_ADMIN = `postgres://rab_owner:${SECRET}@127.0.0.1:55462/rab_test_b`;
const NEON_POOLED = `postgres://rab_app:${SECRET}@ep-round-rain-aess0njf-pooler.c-2.us-east-2.aws.neon.tech/neondb?sslmode=require`;
const NEON_DIRECT = `postgres://rab_owner:${SECRET}@ep-round-rain-aess0njf.c-2.us-east-2.aws.neon.tech/neondb?sslmode=require`;

function expectRefused(env: Record<string, string | undefined>, pattern: RegExp): string {
  let message = '';
  try {
    resolveIntegrationTestDatabase(env);
  } catch (error) {
    expect(error).toBeInstanceOf(TestDatabaseConfigError);
    message = (error as Error).message;
  }
  expect(message).toMatch(pattern);
  expect(message).not.toContain(SECRET);
  return message;
}

describe('integration test database guard', () => {
  it('1. refuses when TEST_DATABASE_URL is missing, and names the variable', () => {
    expectRefused({ [TEST_DATABASE_URL_UNPOOLED]: LOCAL_ADMIN }, /TEST_DATABASE_URL is required/);
  });

  it('2. refuses when the admin URL is missing under both names, and names the variables', () => {
    expectRefused({ [TEST_DATABASE_URL]: LOCAL_APP }, /TEST_DATABASE_ADMIN_URL is required .*deprecated name TEST_DATABASE_URL_UNPOOLED/);
  });

  it('3. refuses a local application URL paired with a Neon admin URL, before any fixture setup', () => {
    expectRefused(
      { [TEST_DATABASE_URL]: LOCAL_APP, [TEST_DATABASE_URL_UNPOOLED]: NEON_DIRECT },
      /(different databases|different endpoints|Remote test database)/,
    );
  });

  it('4. refuses an application URL and an admin URL that name different local databases', () => {
    expectRefused(
      { [TEST_DATABASE_URL]: LOCAL_APP, [TEST_DATABASE_URL_UNPOOLED]: LOCAL_OTHER_DB_ADMIN },
      /different databases \("rab_test_a" vs "rab_test_b"\)/,
    );
  });

  it('5. accepts a matching local test database, and it resolves only from the TEST_* pair', () => {
    const resolved = resolveIntegrationTestDatabase({ [TEST_DATABASE_URL]: LOCAL_APP, [TEST_DATABASE_URL_UNPOOLED]: LOCAL_ADMIN });
    expect(resolved.app.database).toBe('rab_test_a');
    expect(resolved.admin.database).toBe('rab_test_a');
    expect(resolved.app.remote).toBe(false);
  });

  it('6a. refuses a remote (Neon) test database without the explicit override', () => {
    expectRefused(
      { [TEST_DATABASE_URL]: NEON_POOLED, [TEST_DATABASE_URL_UNPOOLED]: NEON_DIRECT },
      /Remote test database "ep-round-rain-aess0njf-pooler.c-2.us-east-2.aws.neon.tech" refused/,
    );
  });

  it('6b. accepts pooled and direct Neon URLs of the same endpoint when the override is explicit', () => {
    const resolved = resolveIntegrationTestDatabase({
      [TEST_DATABASE_URL]: NEON_POOLED,
      [TEST_DATABASE_URL_UNPOOLED]: NEON_DIRECT,
      [ALLOW_REMOTE_TEST_DATABASE]: 'true',
    });
    expect(resolved.app.pooled).toBe(true);
    expect(resolved.admin.pooled).toBe(false);
    expect(resolved.app.endpointKey).toBe(resolved.admin.endpointKey);
  });

  it('6c. does not treat the override as enough when the explicit TEST pair is missing', () => {
    expectRefused({ [ALLOW_REMOTE_TEST_DATABASE]: 'true', [TEST_DATABASE_URL]: NEON_POOLED }, /TEST_DATABASE_ADMIN_URL is required/);
  });

  it('7. production-looking normal .env values are never consumed by Jest', () => {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      DATABASE_URL: NEON_POOLED,
      DATABASE_URL_UNPOOLED: NEON_DIRECT,
    };
    expect(() => applyIntegrationTestDatabaseEnv(env)).toThrow(/TEST_DATABASE_URL is required/);
    // Even when the TEST pair is valid, the normal values are overwritten, not kept.
    const valid: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      DATABASE_URL: NEON_POOLED,
      DATABASE_URL_UNPOOLED: NEON_DIRECT,
      [TEST_DATABASE_URL]: LOCAL_APP,
      [TEST_DATABASE_URL_UNPOOLED]: LOCAL_ADMIN,
    };
    applyIntegrationTestDatabaseEnv(valid);
    expect(valid.DATABASE_URL).toBe(LOCAL_APP);
    expect(valid.DATABASE_URL_UNPOOLED).toBe(LOCAL_ADMIN);
  });

  it('8. error messages never contain credentials, including for a malformed URL', () => {
    expectRefused({ [TEST_DATABASE_URL]: `not a url ${SECRET}`, [TEST_DATABASE_URL_UNPOOLED]: LOCAL_ADMIN }, /not a parseable postgres URL/);
    expectRefused(
      { [TEST_DATABASE_URL]: LOCAL_APP, [TEST_DATABASE_URL_UNPOOLED]: LOCAL_OTHER_DB_ADMIN },
      /different databases/,
    );
    expectRefused(
      { [TEST_DATABASE_URL]: NEON_POOLED, [TEST_DATABASE_URL_UNPOOLED]: NEON_DIRECT },
      /refused/,
    );
  });

  it('is inert outside NODE_ENV=test, so the runtime and CLI are unaffected', () => {
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'production', DATABASE_URL: NEON_POOLED };
    expect(applyIntegrationTestDatabaseEnv(env)).toBeNull();
    expect(env.DATABASE_URL).toBe(NEON_POOLED);
  });

  // ---- X1.2 (audit DBT-01, DBT-02, DBT-10): fail closed for the wrong NODE_ENV, the development database, redirecting
  // inherited database URLs, libpq target variables, URLs without a login and test logins on another database. Every refusal
  // is checked for the planted secret and for leaving DATABASE_URL untouched (nothing routed half-way).
  describe('X1.2 fail-closed process rules', () => {
    const DEV_DB = `postgres://crewflow_app:${SECRET}@127.0.0.1:15432/rab`;
    const OTHER_LOCAL = `postgres://crewflow_app:${SECRET}@127.0.0.1:55499/rab_dev_other`;
    const jestEnv = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
      NODE_ENV: 'test',
      JEST_WORKER_ID: '1',
      [TEST_DATABASE_URL]: LOCAL_APP,
      [TEST_DATABASE_URL_UNPOOLED]: LOCAL_ADMIN,
      ...over,
    });
    function expectApplyRefused(env: NodeJS.ProcessEnv, pattern: RegExp): void {
      const before = env.DATABASE_URL;
      let message = '';
      try {
        applyIntegrationTestDatabaseEnv(env);
      } catch (error) {
        expect(error).toBeInstanceOf(TestDatabaseConfigError);
        message = (error as Error).message;
      }
      expect(message).toMatch(pattern);
      expect(message).not.toContain(SECRET);
      expect(message).not.toMatch(/postgres(ql)?:\/\//);
      expect(env.DATABASE_URL).toBe(before);
    }

    it('DBT-01 reproduction: under Jest, NODE_ENV=development (an Nx-loaded .env) is refused instead of skipping the routing', () => {
      // Before X1.2 this returned null and left DATABASE_URL on the .env value while the fixtures used the TEST admin URL.
      expectApplyRefused(jestEnv({ NODE_ENV: 'development', DATABASE_URL: DEV_DB }), /Jest is running with NODE_ENV="development", not "test"/);
    });

    it('under Jest, an unset or unrecognised NODE_ENV is refused too, without echoing an unrecognised value', () => {
      expectApplyRefused(jestEnv({ NODE_ENV: undefined }), /NODE_ENV=unset/);
      expectApplyRefused(jestEnv({ NODE_ENV: `weird-${SECRET}` }), /NODE_ENV=an unrecognised value \(not shown\)/);
    });

    it('globalSetup (the Jest parent, no JEST_WORKER_ID) refuses a NODE_ENV other than test before any probe', () => {
      const pair = { [TEST_DATABASE_URL]: LOCAL_APP, [TEST_DATABASE_URL_UNPOOLED]: LOCAL_ADMIN };
      expect(() => resolveForJestGlobalSetup({ NODE_ENV: 'development', ...pair })).toThrow(/Jest is running with NODE_ENV="development"/);
      expect(() => resolveForJestGlobalSetup({ NODE_ENV: 'test', ...pair, PG_DATABASE_URL: DEV_DB })).toThrow(/PG_DATABASE_URL is set/);
      expect(resolveForJestGlobalSetup({ NODE_ENV: 'test', ...pair }).app.database).toBe('rab_test_a');
    });

    it('outside Jest a non-test NODE_ENV still leaves the runtime and CLI untouched', () => {
      const env: NodeJS.ProcessEnv = { NODE_ENV: 'development', DATABASE_URL: DEV_DB };
      expect(applyIntegrationTestDatabaseEnv(env)).toBeNull();
      expect(env.DATABASE_URL).toBe(DEV_DB);
    });

    it('refuses the development database (rab-devdb 127.0.0.1:15432, compose host devdb, or the DEVDB_URL database)', () => {
      expectRefused(
        { [TEST_DATABASE_URL]: DEV_DB, [TEST_DATABASE_URL_UNPOOLED]: `postgres://rab:${SECRET}@127.0.0.1:15432/rab` },
        /development database \(rab-devdb\)/,
      );
      expectRefused(
        {
          [TEST_DATABASE_URL]: `postgres://crewflow_app:${SECRET}@devdb:5432/rab`,
          [TEST_DATABASE_URL_UNPOOLED]: `postgres://rab:${SECRET}@devdb:5432/rab`,
          [ALLOW_REMOTE_TEST_DATABASE]: 'true',
        },
        /development database host "devdb"/,
      );
      expectRefused(
        { [TEST_DATABASE_URL]: LOCAL_APP, [TEST_DATABASE_URL_UNPOOLED]: LOCAL_ADMIN, DEVDB_URL: `postgres://crewflow_app:${SECRET}@127.0.0.1:55462/rab_test_a` },
        /same database and endpoint as DEVDB_URL/,
      );
      // A DEVDB_URL naming another database does not block the test database.
      expect(resolveIntegrationTestDatabase({ [TEST_DATABASE_URL]: LOCAL_APP, [TEST_DATABASE_URL_UNPOOLED]: LOCAL_ADMIN, DEVDB_URL: DEV_DB }).app.database).toBe(
        'rab_test_a',
      );
    });

    it('DBT-02: an inherited PG_DATABASE_URL naming another database is refused (never silently kept or overwritten)', () => {
      expectApplyRefused(
        jestEnv({ PG_DATABASE_URL: DEV_DB }),
        /PG_DATABASE_URL is set \(inherited.*names "rab" on 127\.0\.0\.1:15432, not the test database "rab_test_a"/,
      );
      expectApplyRefused(jestEnv({ PG_DATABASE_URL: NEON_POOLED }), /PG_DATABASE_URL is set/);
    });

    it.each([
      'DATABASE_DIRECT_URL',
      'PG_DATABASE_REPLICA_URL',
      'PG_OPS_APP_DATABASE_URL',
      'CREWFLOW_MIGRATION_DATABASE_URL',
      'CREWFLOW_PRESTART_MIGRATION_DATABASE_URL',
      'CREWFLOW_PROVISIONER_DATABASE_URL',
    ])('an inherited %s naming another database is refused', (name) => {
      expectApplyRefused(jestEnv({ [name]: OTHER_LOCAL }), new RegExp(`${name} is set \\(inherited`));
    });

    it('an inherited database URL that is not a URL is refused without echoing it', () => {
      expectApplyRefused(jestEnv({ PG_DATABASE_URL: `garbage ${SECRET}` }), /PG_DATABASE_URL is set and is not a valid postgres URL \(value not shown\)/);
    });

    it('an empty inherited value counts as unset, and one naming the test database is allowed (and kept)', () => {
      const empty = jestEnv({ PG_DATABASE_URL: '', DATABASE_DIRECT_URL: '  ' });
      expect(applyIntegrationTestDatabaseEnv(empty)?.app.database).toBe('rab_test_a');
      expect(empty.DATABASE_URL).toBe(LOCAL_APP);
      const same = jestEnv({ PG_DATABASE_URL: LOCAL_APP });
      expect(applyIntegrationTestDatabaseEnv(same)?.app.database).toBe('rab_test_a');
      expect(same.PG_DATABASE_URL).toBe(LOCAL_APP);
    });

    it('legacy DATABASE_URL / DATABASE_URL_UNPOOLED inherited from .env cannot redirect: they are replaced by the validated pair', () => {
      const env = jestEnv({ DATABASE_URL: DEV_DB, DATABASE_URL_UNPOOLED: OTHER_LOCAL });
      applyIntegrationTestDatabaseEnv(env);
      expect(env.DATABASE_URL).toBe(LOCAL_APP);
      expect(env.DATABASE_URL_UNPOOLED).toBe(LOCAL_ADMIN);
    });

    it.each(['PGHOST', 'PGPORT', 'PGUSER', 'PGDATABASE', 'PGHOSTADDR', 'PGSERVICE', 'PGOPTIONS'])('a target-changing libpq variable (%s) is refused', (name) => {
      expectApplyRefused(jestEnv({ [name]: 'x' }), new RegExp(`libpq variable\\(s\\) ${name} are set`));
    });

    it('refuses a TEST URL that does not name its login (the driver would fall back to PGUSER / the OS user)', () => {
      expectRefused({ [TEST_DATABASE_URL]: 'postgres://127.0.0.1:55462/rab_test_a', [TEST_DATABASE_URL_UNPOOLED]: LOCAL_ADMIN }, /TEST_DATABASE_URL must name its login/);
      expectRefused(
        { [TEST_DATABASE_URL]: LOCAL_APP, [TEST_DATABASE_URL_UNPOOLED]: `postgres://:${SECRET}@127.0.0.1:55462/rab_test_a` },
        /TEST_DATABASE_URL_UNPOOLED must name its login/,
      );
    });

    it('DBT-10: TEST_DATABASE_WORKER_URL / TEST_DATABASE_CREWFLOW_URL on another database are refused; on the test database accepted', () => {
      expectRefused(
        { [TEST_DATABASE_URL]: LOCAL_APP, [TEST_DATABASE_URL_UNPOOLED]: LOCAL_ADMIN, [TEST_DATABASE_WORKER_URL]: OTHER_LOCAL },
        /TEST_DATABASE_WORKER_URL names "rab_dev_other"/,
      );
      expectRefused({ [TEST_DATABASE_URL]: LOCAL_APP, [TEST_DATABASE_URL_UNPOOLED]: LOCAL_ADMIN, TEST_DATABASE_CREWFLOW_URL: DEV_DB }, /TEST_DATABASE_CREWFLOW_URL names "rab"/);
      expect(
        resolveIntegrationTestDatabase({
          [TEST_DATABASE_URL]: LOCAL_APP,
          [TEST_DATABASE_URL_UNPOOLED]: LOCAL_ADMIN,
          [TEST_DATABASE_WORKER_URL]: `postgres://crewflow_worker:${SECRET}@127.0.0.1:55462/rab_test_a`,
        }).app.database,
      ).toBe('rab_test_a');
    });

    // ---- X1.9 independent review follow-ups (findings 1-3). Written failing-first against the X1.2 guard.
    describe('X1.9 review follow-ups', () => {
      const SUPERUSER_ON_TEST_DB = `postgres://rab_owner:${SECRET}@127.0.0.1:55462/rab_test_a`;

      it.each(['DATABASE_DIRECT_URL', 'PG_DATABASE_REPLICA_URL'])(
        'finding 1: an inherited %s is refused even when it names the test database (a test process never uses it)',
        (name) => {
          expectApplyRefused(jestEnv({ [name]: LOCAL_APP }), new RegExp(`${name} is set \\(inherited.*never uses it`));
          expectApplyRefused(jestEnv({ [name]: SUPERUSER_ON_TEST_DB }), new RegExp(`${name} is set`));
        },
      );

      it.each(['PG_DATABASE_URL', 'PG_OPS_APP_DATABASE_URL', 'CREWFLOW_PROVISIONER_DATABASE_URL'])(
        'finding 1: an inherited %s on the test database with ANOTHER login (e.g. the bootstrap superuser) is refused, without naming the login',
        (name) => {
          let message = '';
          try {
            applyIntegrationTestDatabaseEnv(jestEnv({ [name]: SUPERUSER_ON_TEST_DB }));
          } catch (error) {
            message = (error as Error).message;
          }
          expect(message).toMatch(new RegExp(`${name} is set .*names the test database "rab_test_a" with a different login`));
          expect(message).not.toContain('rab_owner');
          expect(message).not.toContain(SECRET);
        },
      );

      it('finding 2: names present only in the working directory .env (loaded later by @nestjs/config) are checked too', () => {
        const files: Record<string, string> = {
          [require('path').resolve('/w', '.env')]: `PG_DATABASE_REPLICA_URL=${DEV_DB}\nPGHOST=elsewhere\nPG_DATABASE_URL=${LOCAL_APP}\nUNRELATED=1\n`,
        };
        const read = (file: string) => files[file] ?? null;
        // Only checked names, only those process.env does not already hold (dotenv never overrides them).
        expect(laterDotenvValues({ PGHOST: '' }, '/w', read)).toEqual({ PG_DATABASE_REPLICA_URL: DEV_DB, PG_DATABASE_URL: LOCAL_APP });
        expect(laterDotenvValues({}, '/w', read)).toEqual({ PG_DATABASE_REPLICA_URL: DEV_DB, PGHOST: 'elsewhere', PG_DATABASE_URL: LOCAL_APP });
        // DOTENV_CONFIG_PATH's file is read too.
        files[require('path').resolve('/w', 'custom.env')] = 'DATABASE_DIRECT_URL=x\n';
        expect(laterDotenvValues({ DOTENV_CONFIG_PATH: 'custom.env' }, '/w', read)).toMatchObject({ DATABASE_DIRECT_URL: 'x' });
        expect(laterDotenvValues({}, '/nowhere', () => null)).toEqual({});
      });

      it('finding 2: a real .env in the working directory is refused through applyIntegrationTestDatabaseEnv (value not echoed)', () => {
        const fs = require('fs') as typeof import('fs');
        const os = require('os') as typeof import('os');
        const path = require('path') as typeof import('path');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x1-guard-dotenv-'));
        const cwd = process.cwd();
        try {
          fs.writeFileSync(path.join(dir, '.env'), `PG_DATABASE_REPLICA_URL=${DEV_DB}\n`);
          process.chdir(dir);
          expectApplyRefused(jestEnv(), /PG_DATABASE_REPLICA_URL is set/);
          fs.writeFileSync(path.join(dir, '.env'), 'PGPORT=15432\n');
          expectApplyRefused(jestEnv(), /libpq variable\(s\) PGPORT are set/);
          // An empty process.env value wins over .env (dotenv never overrides): not refused.
          fs.writeFileSync(path.join(dir, '.env'), `PG_DATABASE_REPLICA_URL=${DEV_DB}\n`);
          expect(applyIntegrationTestDatabaseEnv(jestEnv({ PG_DATABASE_REPLICA_URL: '' }))?.app.database).toBe('rab_test_a');
        } finally {
          process.chdir(cwd);
          fs.rmSync(dir, { recursive: true, force: true });
        }
      });

      it.each(['localhost', '127.0.0.1', '127.1.2.3', '[::1]', '[0:0:0:0:0:0:0:1]', '0.0.0.0', '[::]', '[::ffff:127.0.0.1]', 'LOCALHOST'])(
        'finding 3: loopback alias %s on port 15432 is the development database',
        (host) => {
          expectRefused(
            {
              [TEST_DATABASE_URL]: `postgres://crewflow_app:${SECRET}@${host}:15432/rab`,
              [TEST_DATABASE_URL_UNPOOLED]: `postgres://rab:${SECRET}@${host}:15432/rab`,
              [ALLOW_REMOTE_TEST_DATABASE]: 'true',
            },
            /the development database \(rab-devdb\)/,
          );
        },
      );

      it('finding 3: DEVDB_URL on 127.0.0.1 matches a TEST URL on localhost (same port and database)', () => {
        expectRefused(
          {
            [TEST_DATABASE_URL]: `postgres://crewflow_app:${SECRET}@localhost:5433/rab`,
            [TEST_DATABASE_URL_UNPOOLED]: `postgres://rab:${SECRET}@localhost:5433/rab`,
            DEVDB_URL: `postgres://crewflow_app:${SECRET}@127.0.0.1:5433/rab`,
          },
          /same database and endpoint as DEVDB_URL/,
        );
      });

      it('finding 3: a percent-encoded host is refused (the driver decodes it, this parser does not)', () => {
        expectRefused(
          {
            [TEST_DATABASE_URL]: `postgres://crewflow_app:${SECRET}@local%68ost:15432/rab`,
            [TEST_DATABASE_URL_UNPOOLED]: `postgres://rab:${SECRET}@local%68ost:15432/rab`,
            [ALLOW_REMOTE_TEST_DATABASE]: 'true',
          },
          /percent-encoded host/,
        );
      });

      it('finding 3: the alias list is not over-broad', () => {
        for (const host of ['10.0.0.1', '128.0.0.1', 'localhost.example.com', 'db', '::2', 'ep-x.neon.tech']) expect(isLoopbackAlias(host)).toBe(false);
      });
    });

    // ---- X1.8 (audit XD-03): the guard does not depend on NODE_ENV=test to refuse a non-test database.
    describe('X1.8 NODE_ENV-independent refusal', () => {
      const NODE_ENVS: Array<string | undefined> = [undefined, '', 'development', 'production', 'staging'];

      // The database rules themselves never read NODE_ENV: the development database is refused BY THE DEVELOPMENT-DATABASE
      // RULE whatever NODE_ENV says (review finding 5: asserted on the rule's own message, not on the NODE_ENV refusal).
      it.each(NODE_ENVS)('with NODE_ENV=%p the database rules refuse the development database by the development-database rule', (nodeEnv) => {
        const message = expectRefused(
          { NODE_ENV: nodeEnv, [TEST_DATABASE_URL]: DEV_DB, [TEST_DATABASE_URL_UNPOOLED]: `postgres://rab:${SECRET}@127.0.0.1:15432/rab` },
          /development database \(rab-devdb\)/,
        );
        expect(message).not.toMatch(/NODE_ENV/);
      });

      it.each(NODE_ENVS)('under Jest with NODE_ENV=%p the development database is refused (here first by the NODE_ENV rule), nothing routed', (nodeEnv) => {
        expectApplyRefused(
          jestEnv({ NODE_ENV: nodeEnv, [TEST_DATABASE_URL]: DEV_DB, [TEST_DATABASE_URL_UNPOOLED]: `postgres://rab:${SECRET}@127.0.0.1:15432/rab`, DATABASE_URL: DEV_DB }),
          /Refusing to start/,
        );
      });

      it.each(NODE_ENVS)('globalSetup with NODE_ENV=%p refuses the development database before any probe', (nodeEnv) => {
        expect(() =>
          resolveForJestGlobalSetup({ NODE_ENV: nodeEnv, [TEST_DATABASE_URL]: DEV_DB, [TEST_DATABASE_URL_UNPOOLED]: `postgres://rab:${SECRET}@127.0.0.1:15432/rab` }),
        ).toThrow(TestDatabaseConfigError);
      });
    });

    // ---- X1.8 (audit XD-03): worker-login-env.ts used to copy TEST_DATABASE_WORKER_URL into DATABASE_URL unchecked.
    describe('X1.8 Worker-login switch (applyWorkerLoginTestDatabaseEnv)', () => {
      const WORKER_ON_TEST_DB = `postgres://crewflow_worker:${SECRET}@127.0.0.1:55462/rab_test_a`;
      const workerEnv = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
        PHASE_D_SQL_APPROVED: 'true',
        [TEST_DATABASE_URL]: LOCAL_APP,
        [TEST_DATABASE_URL_UNPOOLED]: LOCAL_ADMIN,
        [TEST_DATABASE_WORKER_URL]: WORKER_ON_TEST_DB,
        DATABASE_URL: LOCAL_APP,
        ...over,
      });
      function expectWorkerRefused(env: NodeJS.ProcessEnv, pattern: RegExp): void {
        const before = { url: env.DATABASE_URL, mode: env.WORKER_CLAIM_MODE };
        let message = '';
        try {
          applyWorkerLoginTestDatabaseEnv(env);
        } catch (error) {
          expect(error).toBeInstanceOf(TestDatabaseConfigError);
          message = (error as Error).message;
        }
        expect(message).toMatch(pattern);
        expect(message).not.toContain(SECRET);
        expect(message).not.toMatch(/postgres(ql)?:\/\//);
        expect({ url: env.DATABASE_URL, mode: env.WORKER_CLAIM_MODE }).toEqual(before);
      }

      it('is off (returns false, changes nothing) without the Phase D opt-in or without a worker URL', () => {
        for (const env of [workerEnv({ PHASE_D_SQL_APPROVED: undefined }), workerEnv({ PHASE_D_SQL_APPROVED: 'yes' }), workerEnv({ [TEST_DATABASE_WORKER_URL]: '  ' })]) {
          expect(applyWorkerLoginTestDatabaseEnv(env)).toBe(false);
          expect(env.DATABASE_URL).toBe(LOCAL_APP);
          expect(env.WORKER_CLAIM_MODE).toBeUndefined();
        }
      });

      it.each([undefined, 'development', 'test'])('accepts a worker login on the TEST database (NODE_ENV=%p) and routes DATABASE_URL to it', (nodeEnv) => {
        const env = workerEnv({ NODE_ENV: nodeEnv });
        expect(applyWorkerLoginTestDatabaseEnv(env)).toBe(true);
        expect(env.DATABASE_URL).toBe(WORKER_ON_TEST_DB);
        expect(env.WORKER_CLAIM_MODE).toBe('global');
      });

      it.each([undefined, 'development', 'production'])(
        'with NODE_ENV=%p, a worker URL on the development database or another database is refused, nothing routed',
        (nodeEnv) => {
          expectWorkerRefused(workerEnv({ NODE_ENV: nodeEnv, [TEST_DATABASE_WORKER_URL]: DEV_DB }), /TEST_DATABASE_WORKER_URL names "rab"/);
          expectWorkerRefused(workerEnv({ NODE_ENV: nodeEnv, [TEST_DATABASE_WORKER_URL]: OTHER_LOCAL }), /TEST_DATABASE_WORKER_URL names "rab_dev_other"/);
        },
      );

      it('refuses when the TEST pair itself is missing or the development database (the worker URL alone is never trusted)', () => {
        expectWorkerRefused(workerEnv({ [TEST_DATABASE_URL]: undefined }), /TEST_DATABASE_URL is required/);
        expectWorkerRefused(
          workerEnv({
            [TEST_DATABASE_URL]: DEV_DB,
            [TEST_DATABASE_URL_UNPOOLED]: `postgres://rab:${SECRET}@127.0.0.1:15432/rab`,
            [TEST_DATABASE_WORKER_URL]: `postgres://crewflow_worker:${SECRET}@127.0.0.1:15432/rab`,
          }),
          /development database \(rab-devdb\)/,
        );
      });

      it('refuses a remote worker database without the explicit override', () => {
        expectWorkerRefused(
          workerEnv({ [TEST_DATABASE_URL]: NEON_POOLED, [TEST_DATABASE_URL_UNPOOLED]: NEON_DIRECT, [TEST_DATABASE_WORKER_URL]: NEON_POOLED }),
          /Remote test database/,
        );
      });

      it('refuses a worker URL without a login, and the test admin (bootstrap superuser) login, without naming the login', () => {
        expectWorkerRefused(workerEnv({ [TEST_DATABASE_WORKER_URL]: 'postgres://127.0.0.1:55462/rab_test_a' }), /TEST_DATABASE_WORKER_URL must name its login/);
        let message = '';
        try {
          applyWorkerLoginTestDatabaseEnv(workerEnv({ [TEST_DATABASE_WORKER_URL]: LOCAL_ADMIN }));
        } catch (error) {
          message = (error as Error).message;
        }
        expect(message).toMatch(/same login as TEST_DATABASE_URL_UNPOOLED/);
        expect(message).not.toContain('rab_owner');
        expectWorkerRefused(workerEnv({ [TEST_DATABASE_WORKER_URL]: LOCAL_ADMIN }), /same login as TEST_DATABASE_URL_UNPOOLED/);
      });

      it('review finding 4: refuses the MIGRATION_SECURITY_ADMIN_URL and TEST_DATABASE_CREWFLOW_URL logins too (and an unparseable admin URL)', () => {
        const migrationAdmin = `postgres://postgres:${SECRET}@127.0.0.1:55462/postgres`;
        expectWorkerRefused(
          workerEnv({ MIGRATION_SECURITY_ADMIN_URL: migrationAdmin, [TEST_DATABASE_WORKER_URL]: `postgres://postgres:${SECRET}@127.0.0.1:55462/rab_test_a` }),
          /same login as MIGRATION_SECURITY_ADMIN_URL/,
        );
        const crewflow = `postgres://crewflow:${SECRET}@127.0.0.1:55462/rab_test_a`;
        expectWorkerRefused(workerEnv({ TEST_DATABASE_CREWFLOW_URL: crewflow, [TEST_DATABASE_WORKER_URL]: crewflow }), /same login as TEST_DATABASE_CREWFLOW_URL/);
        expectWorkerRefused(workerEnv({ MIGRATION_SECURITY_ADMIN_URL: `not a url ${SECRET}` }), /MIGRATION_SECURITY_ADMIN_URL is set and is not a valid postgres URL/);
        // Other logins on the same cluster do not block a distinct worker login.
        expect(applyWorkerLoginTestDatabaseEnv(workerEnv({ MIGRATION_SECURITY_ADMIN_URL: migrationAdmin, TEST_DATABASE_CREWFLOW_URL: crewflow }))).toBe(true);
      });

      it('refuses a redirecting inherited URL or libpq variable, as the setupFiles guard does', () => {
        expectWorkerRefused(workerEnv({ PG_DATABASE_URL: DEV_DB }), /PG_DATABASE_URL is set/);
        expectWorkerRefused(workerEnv({ PGHOST: 'elsewhere' }), /libpq variable\(s\) PGHOST are set/);
        expectWorkerRefused(workerEnv({ DATABASE_DIRECT_URL: LOCAL_ADMIN }), /DATABASE_DIRECT_URL is set/);
      });
    });
  });

  // ---- X3.5-S7 (audit DBT-08), release 1: TEST_DATABASE_URL_UNPOOLED -> TEST_DATABASE_ADMIN_URL, both names accepted, two
  // different values refused, every existing check applied to whichever name supplied the admin URL.
  describe('X3.5-S7 TEST_DATABASE_ADMIN_URL rename (release 1, dual name)', () => {
    const OTHER_PASSWORD_ADMIN = `postgres://rab_owner:${SECRET}-2@127.0.0.1:55462/rab_test_a`;
    const s7Env = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ NODE_ENV: 'test', JEST_WORKER_ID: '1', [TEST_DATABASE_URL]: LOCAL_APP, ...over });
    function expectNoValue(message: string): void {
      expect(message).not.toContain(SECRET);
      expect(message).not.toMatch(/postgres(ql)?:\/\//);
      expect(message).not.toContain('rab_owner');
    }

    it('the new name alone works, labels the admin identity with it, and prints no deprecation notice', () => {
      const resolved = resolveIntegrationTestDatabase({ [TEST_DATABASE_URL]: LOCAL_APP, [TEST_DATABASE_ADMIN_URL]: LOCAL_ADMIN });
      expect(resolved.adminUrl).toBe(LOCAL_ADMIN);
      expect(resolved.admin.label).toBe(TEST_DATABASE_ADMIN_URL);
      expect(resolved.adminFromDeprecatedName).toBe(false);
      expect(testDatabaseAdminNameNotice(resolved)).toBeNull();
    });

    it('the old name alone still works, is labelled with the old name, and gives one name-only deprecation notice', () => {
      const resolved = resolveIntegrationTestDatabase({ [TEST_DATABASE_URL]: LOCAL_APP, [TEST_DATABASE_URL_UNPOOLED]: LOCAL_ADMIN });
      expect(resolved.adminUrl).toBe(LOCAL_ADMIN);
      expect(resolved.admin.label).toBe(TEST_DATABASE_URL_UNPOOLED);
      expect(resolved.adminFromDeprecatedName).toBe(true);
      const notice = testDatabaseAdminNameNotice(resolved) as string;
      expect(notice).toMatch(/TEST_DATABASE_URL_UNPOOLED is deprecated: rename it to TEST_DATABASE_ADMIN_URL/);
      expectNoValue(notice);
    });

    it('both names with the same value (after trimming) work, under the new name, without a notice', () => {
      const resolved = resolveIntegrationTestDatabase({
        [TEST_DATABASE_URL]: LOCAL_APP,
        [TEST_DATABASE_ADMIN_URL]: ` ${LOCAL_ADMIN} `,
        [TEST_DATABASE_URL_UNPOOLED]: LOCAL_ADMIN,
      });
      expect(resolved.adminUrl).toBe(LOCAL_ADMIN);
      expect(resolved.admin.label).toBe(TEST_DATABASE_ADMIN_URL);
      expect(testDatabaseAdminNameNotice(resolved)).toBeNull();
    });

    it.each<[string, string]>([
      ['another database', LOCAL_OTHER_DB_ADMIN],
      ['the same target with another password (compared as written, never by target only)', OTHER_PASSWORD_ADMIN],
      ['another host', NEON_DIRECT],
    ])('both names set to different values (%s) are refused, naming both variables and no value', (_name, other) => {
      const message = expectRefused(
        { [TEST_DATABASE_URL]: LOCAL_APP, [TEST_DATABASE_ADMIN_URL]: LOCAL_ADMIN, [TEST_DATABASE_URL_UNPOOLED]: other },
        /TEST_DATABASE_ADMIN_URL and its deprecated name TEST_DATABASE_URL_UNPOOLED are both set, to different values/,
      );
      expectNoValue(message);
      expect(() => resolveTestDatabaseAdminUrl({ [TEST_DATABASE_ADMIN_URL]: other, [TEST_DATABASE_URL_UNPOOLED]: LOCAL_ADMIN })).toThrow(TestDatabaseConfigError);
    });

    it('an empty or blank value counts as unset under either name (never as a second value)', () => {
      expect(resolveIntegrationTestDatabase({ [TEST_DATABASE_URL]: LOCAL_APP, [TEST_DATABASE_ADMIN_URL]: '  ', [TEST_DATABASE_URL_UNPOOLED]: LOCAL_ADMIN }).admin.label).toBe(
        TEST_DATABASE_URL_UNPOOLED,
      );
      expect(resolveIntegrationTestDatabase({ [TEST_DATABASE_URL]: LOCAL_APP, [TEST_DATABASE_ADMIN_URL]: LOCAL_ADMIN, [TEST_DATABASE_URL_UNPOOLED]: '' }).admin.label).toBe(
        TEST_DATABASE_ADMIN_URL,
      );
      expectRefused({ [TEST_DATABASE_URL]: LOCAL_APP, [TEST_DATABASE_ADMIN_URL]: ' ', [TEST_DATABASE_URL_UNPOOLED]: '' }, /TEST_DATABASE_ADMIN_URL is required/);
    });

    it('every existing check applies to the new name, and the messages name it', () => {
      expectRefused({ [TEST_DATABASE_URL]: LOCAL_APP, [TEST_DATABASE_ADMIN_URL]: LOCAL_OTHER_DB_ADMIN }, /different databases \("rab_test_a" vs "rab_test_b"\)/);
      expectRefused({ [TEST_DATABASE_URL]: NEON_POOLED, [TEST_DATABASE_ADMIN_URL]: NEON_DIRECT }, /Remote test database/);
      expectRefused({ [TEST_DATABASE_URL]: LOCAL_APP, [TEST_DATABASE_ADMIN_URL]: 'postgres://127.0.0.1:55462/rab_test_a' }, /TEST_DATABASE_ADMIN_URL must name its login/);
      expectRefused({ [TEST_DATABASE_URL]: LOCAL_APP, [TEST_DATABASE_ADMIN_URL]: `not a url ${SECRET}` }, /TEST_DATABASE_ADMIN_URL is not a parseable postgres URL/);
      expectRefused(
        { [TEST_DATABASE_URL]: LOCAL_APP, [TEST_DATABASE_ADMIN_URL]: `postgres://rab_owner:${SECRET}@127.0.0.1:55462/rab_test_a?host=elsewhere` },
        /TEST_DATABASE_ADMIN_URL sets "host" as a query parameter/,
      );
      expectRefused(
        {
          [TEST_DATABASE_URL]: `postgres://crewflow_app:${SECRET}@127.0.0.1:15432/rab`,
          [TEST_DATABASE_ADMIN_URL]: `postgres://rab:${SECRET}@127.0.0.1:15432/rab`,
        },
        /development database \(rab-devdb\)/,
      );
    });

    it('setupFiles routing writes the validated admin URL under BOTH names (so a later .env cannot add another under either)', () => {
      const fromNew = s7Env({ [TEST_DATABASE_ADMIN_URL]: LOCAL_ADMIN });
      expect(applyIntegrationTestDatabaseEnv(fromNew)?.admin.label).toBe(TEST_DATABASE_ADMIN_URL);
      expect(fromNew[TEST_DATABASE_ADMIN_URL]).toBe(LOCAL_ADMIN);
      expect(fromNew[TEST_DATABASE_URL_UNPOOLED]).toBe(LOCAL_ADMIN);
      expect(fromNew.DATABASE_URL_UNPOOLED).toBe(LOCAL_ADMIN);
      const fromOld = s7Env({ [TEST_DATABASE_URL_UNPOOLED]: ` ${LOCAL_ADMIN}` });
      expect(applyIntegrationTestDatabaseEnv(fromOld)?.admin.label).toBe(TEST_DATABASE_URL_UNPOOLED);
      expect(fromOld[TEST_DATABASE_ADMIN_URL]).toBe(LOCAL_ADMIN);
      expect(fromOld[TEST_DATABASE_URL_UNPOOLED]).toBe(LOCAL_ADMIN);
    });

    it('a refused pair changes nothing (no name routed half-way), in setupFiles and in globalSetup', () => {
      const env = s7Env({ [TEST_DATABASE_ADMIN_URL]: LOCAL_ADMIN, [TEST_DATABASE_URL_UNPOOLED]: LOCAL_OTHER_DB_ADMIN, DATABASE_URL: 'untouched' });
      const before = { ...env };
      expect(() => applyIntegrationTestDatabaseEnv(env)).toThrow(/both set, to different values/);
      expect(env).toEqual(before);
      expect(() => resolveForJestGlobalSetup({ ...before, JEST_WORKER_ID: undefined })).toThrow(/both set, to different values/);
    });

    it('the Worker-login switch refuses the admin login under either name', () => {
      expect(WORKER_LOGIN_FORBIDDEN_LOGIN_SOURCES).toEqual(expect.arrayContaining([...TEST_DATABASE_ADMIN_URL_NAMES]));
      const worker = (over: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({ PHASE_D_SQL_APPROVED: 'true', [TEST_DATABASE_URL]: LOCAL_APP, [TEST_DATABASE_WORKER_URL]: LOCAL_ADMIN, ...over });
      expect(() => applyWorkerLoginTestDatabaseEnv(worker({ [TEST_DATABASE_ADMIN_URL]: LOCAL_ADMIN }))).toThrow(/same login as TEST_DATABASE_ADMIN_URL/);
      expect(() => applyWorkerLoginTestDatabaseEnv(worker({ [TEST_DATABASE_URL_UNPOOLED]: LOCAL_ADMIN }))).toThrow(/same login as TEST_DATABASE_URL_UNPOOLED/);
      expect(() => applyWorkerLoginTestDatabaseEnv(worker({ [TEST_DATABASE_ADMIN_URL]: LOCAL_ADMIN, [TEST_DATABASE_URL_UNPOOLED]: OTHER_PASSWORD_ADMIN }))).toThrow(
        /both set, to different values/,
      );
    });

    it('this Jest process was routed: both admin names hold the same validated value', () => {
      expect(process.env[TEST_DATABASE_ADMIN_URL]).toBeTruthy();
      expect(process.env[TEST_DATABASE_ADMIN_URL]).toBe(process.env[TEST_DATABASE_URL_UNPOOLED]);
    });
  });

  // ---- X1.8 review finding 4: the live rolsuper / rolbypassrls check, against this run's real TEST database (read-only).
  describe('X1.8 Worker-login live privilege check (assertWorkerLoginNotPrivilegedAtRuntime)', () => {
    const appUrl = process.env[TEST_DATABASE_URL] as string;
    const adminUrl = process.env[TEST_DATABASE_URL_UNPOOLED] as string;
    const base = (over: Record<string, string | undefined>) => ({ PHASE_D_SQL_APPROVED: 'true', [TEST_DATABASE_URL]: appUrl, [TEST_DATABASE_URL_UNPOOLED]: adminUrl, ...over });

    it('is off without the switch', async () => {
      await expect(assertWorkerLoginNotPrivilegedAtRuntime(base({ PHASE_D_SQL_APPROVED: undefined, [TEST_DATABASE_WORKER_URL]: appUrl }))).resolves.toBe(false);
    });

    it('accepts the restricted TEST application login as the worker login', async () => {
      await expect(assertWorkerLoginNotPrivilegedAtRuntime(base({ [TEST_DATABASE_WORKER_URL]: appUrl }))).resolves.toBe(true);
    });

    it('refuses, live, a superuser worker login that no name rule catches (the admin URL under the application name)', async () => {
      // The superuser is named as the WORKER login while the admin slot holds the application login, so only the live
      // rolsuper check can refuse it. Read-only: one SELECT on pg_roles.
      let message = '';
      try {
        await assertWorkerLoginNotPrivilegedAtRuntime({ PHASE_D_SQL_APPROVED: 'true', [TEST_DATABASE_URL]: appUrl, [TEST_DATABASE_URL_UNPOOLED]: appUrl, [TEST_DATABASE_WORKER_URL]: adminUrl });
      } catch (error) {
        expect(error).toBeInstanceOf(TestDatabaseConfigError);
        message = (error as Error).message;
      }
      expect(message).toMatch(/logs in as, or as a member of, a superuser or BYPASSRLS role/);
      expect(message).not.toMatch(/postgres(ql)?:\/\//);
    });

    it('re-review: a superuser URL that switches role through ?options=-c role=<restricted login> is refused', async () => {
      const appLogin = decodeURIComponent(new URL(appUrl).username);
      const switched = new URL(adminUrl);
      switched.searchParams.set('options', `-c role=${appLogin}`);
      await expect(
        assertWorkerLoginNotPrivilegedAtRuntime({ PHASE_D_SQL_APPROVED: 'true', [TEST_DATABASE_URL]: appUrl, [TEST_DATABASE_URL_UNPOOLED]: appUrl, [TEST_DATABASE_WORKER_URL]: switched.toString() }),
      ).rejects.toThrow(/TEST_DATABASE_WORKER_URL sets "options" as a query parameter/);
    });

    it('re-review: a non-superuser login that is a MEMBER of a superuser role is refused, live (disposable role, dropped after)', async () => {
      // Read-write on the disposable cluster only: a NOLOGIN superuser role and a LOGIN role that is its member (with
      // CONNECT on the test database), both dropped in finally. ci-server runs Jest --runInBand, so no posture spec runs meanwhile.
      const { Client } = require('pg') as typeof import('pg');
      const admin = new Client({ connectionString: adminUrl });
      await admin.connect();
      const suffix = `${process.pid}_${Date.now()}`;
      const member = `x18_member_${suffix}`;
      const superRole = `x18_super_${suffix}`;
      const password = `x18-${require('crypto').randomBytes(16).toString('hex')}`;
      const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;
      try {
        const { rows } = await admin.query<{ db: string }>('SELECT current_database() AS db');
        await admin.query(`CREATE ROLE ${ident(superRole)} NOLOGIN SUPERUSER`);
        await admin.query(`CREATE ROLE ${ident(member)} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);
        await admin.query(`GRANT CONNECT ON DATABASE ${ident(rows[0].db)} TO ${ident(member)}`);
        await admin.query(`GRANT ${ident(superRole)} TO ${ident(member)}`);
        const memberUrl = new URL(appUrl);
        memberUrl.username = member;
        memberUrl.password = password;
        let message = '';
        try {
          await assertWorkerLoginNotPrivilegedAtRuntime(base({ [TEST_DATABASE_WORKER_URL]: memberUrl.toString() }));
        } catch (error) {
          message = (error as Error).message;
        }
        expect(message).toMatch(/logs in as, or as a member of, a superuser or BYPASSRLS role/);
        expect(message).not.toContain(password);
      } finally {
        const { rows } = await admin.query<{ db: string }>('SELECT current_database() AS db');
        await admin.query(`REVOKE ALL ON DATABASE ${ident(rows[0].db)} FROM ${ident(member)}`).catch(() => undefined);
        await admin.query(`DROP ROLE IF EXISTS ${ident(member)}`).catch(() => undefined);
        await admin.query(`DROP ROLE IF EXISTS ${ident(superRole)}`).catch(() => undefined);
        await admin.end();
      }
    });
  });
});
