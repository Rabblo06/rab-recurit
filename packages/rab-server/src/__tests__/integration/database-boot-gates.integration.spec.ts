import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { DataSourceOptions, MigrationInterface } from 'typeorm';

import { BootGateReport, DatabaseBootGateError, runDatabaseBootGates, RunBootGatesOptions } from '../../database/boot-checks/database-boot-gates';
import { coreDataSourceOptions } from '../../database/typeorm/core/core.datasource';
import { assertDbTarget, DbTargetError } from '../../database/typeorm/core/database-target';
import { assertRuntimeDatabaseIdentity, RuntimeDbError } from '../../database/typeorm/core/runtime-database-guard';
import { resolveIntegrationTestDatabase } from '../../database/typeorm/core/test-database-guard';

/**
 * Phase B boot gates against the real (disposable, migrations-only) test database, connected exactly as the API would be:
 * coreDataSourceOptions with the test application URL (crewflow_app). Role, server version, extensions, FORCE RLS spot
 * check, pending migrations, PG_EXPECTED_DATABASE_NAME, bounded retry, and the deployment marker's ABSENT/UNBOUND path.
 *
 * The marker's BOUND paths (bind, rebind, runtime denial, history insert-only, host set, down()) are covered by
 * deployment-identity.integration.spec.ts (migration DeploymentIdentity1786721230000, applied by the harness build).
 */
const { appUrl, adminUrl } = resolveIntegrationTestDatabase(process.env);
const PROD_ID = '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const NON_PROD = { NODE_ENV: 'test' };
const quiet = () => undefined;

// Phase B: the gate's connection comes from the factory; the spec points it at a test URL through `connectionEnv`
// (PG_DATABASE_URL) while the gate decisions read `env`.
function options(url: string, extra: Partial<RunBootGatesOptions> = {}, migrations?: DataSourceOptions['migrations']): RunBootGatesOptions {
  return {
    env: NON_PROD,
    connectionEnv: { NODE_ENV: 'test', PG_DATABASE_URL: url },
    ...(migrations ? { migrations } : {}),
    retry: { attempts: 1 },
    log: quiet,
    ...extra,
  };
}

async function refusedAt(promise: Promise<unknown>, gate: string, pattern: RegExp): Promise<void> {
  let error: unknown;
  try {
    await promise;
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(DatabaseBootGateError);
  expect((error as DatabaseBootGateError).gate).toBe(gate);
  expect((error as Error).message).toMatch(pattern);
  expect((error as Error).message).not.toMatch(/postgres:\/\//);
}

/**
 * An OLD-timestamped migration the ledger has never seen while newer ones are applied: pending, but NOT an in-order tail
 * (out of order).
 */
class BootGateFakeOutOfOrder1700000000000 implements MigrationInterface {
  name = 'BootGateFakeOutOfOrder1700000000000';
  async up(): Promise<void> {
    throw new Error('never run');
  }
  async down(): Promise<void> {
    throw new Error('never run');
  }
}

/** A migration the ledger has never seen: the database is then "behind the code". */
class BootGateFakePending9999999999999 implements MigrationInterface {
  name = 'BootGateFakePending9999999999999';
  async up(): Promise<void> {
    throw new Error('never run');
  }
  async down(): Promise<void> {
    throw new Error('never run');
  }
}

const OWNER_LOGIN_DOCUMENTED_WARNING = (w: string) => w.startsWith('BC-08 (DBA-01') || w.startsWith('semantic posture: the PostgreSQL');

describe('database boot gates (integration, migrations-only test database)', () => {
  let report: BootGateReport;

  beforeAll(async () => {
    report = await runDatabaseBootGates('api', options(appUrl));
  });

  // I-class (owner-login architecture, BC-02): the one runtime login is crewflow_owner. Its boot report also carries the
  // documented owner-login warnings: BC-08 (DBA-01 lost, ACCEPTED (owner, 2026-11-05); asserted present) and, on a database with
  // workspace schemas the PostgreSQL golden has no template for, the semantic-posture note. Any OTHER warning still counts.
  it('the API runtime login passes every gate: crewflow_owner, PostgreSQL 16+, extensions, FORCE RLS, no pending migration', () => {
    expect(report.role).toBe('crewflow_owner');
    expect(report.serverVersionNum).toBeGreaterThanOrEqual(160000);
    expect(report.forceRlsTables).toBeGreaterThanOrEqual(10);
    // The marker migration is applied on the harness-built database but never left bound: unbound (absent on an older build).
    expect(['absent', 'unbound']).toContain(report.identity);
    expect(report.warnings.filter((w) => w.startsWith('BC-08 (DBA-01'))).toHaveLength(1);
    expect(report.warnings.filter((w) => !OWNER_LOGIN_DOCUMENTED_WARNING(w))).toHaveLength(1);
  });

  it('the CLI gate accepts the runtime login (crewflow_owner, BC-02) for runtime commands and for the operator commands', async () => {
    await expect(runDatabaseBootGates('cli', options(appUrl, { cliCommand: 'storage:reconcile' }))).resolves.toMatchObject({ role: 'crewflow_owner' });
    await expect(runDatabaseBootGates('cli', options(appUrl, { cliCommand: 'bootstrap-admin' }))).resolves.toMatchObject({ role: 'crewflow_owner' });
  });

  it('role: a superuser login is refused (API and CLI)', async () => {
    // Still refused; the message names the one login now (BC-02).
    await refusedAt(runDatabaseBootGates('api', options(adminUrl)), 'role', /expected crewflow_owner/);
    await refusedAt(runDatabaseBootGates('cli', options(adminUrl, { cliCommand: 'bootstrap-admin' })), 'role', /expected crewflow_owner/); // still refused (BC-02)
  });

  it('role: a privileged login cannot even ask to SET ROLE to crewflow_app — the factory refuses the URL option before connecting', async () => {
    // Phase B: `options=-c role=…` is refused by the URL policy for every runtime process (only the migrate process against
    // a local/test target accepts it), so the live SET ROLE case can no longer be constructed here. The role gate's own
    // SET ROLE refusal (session_user <> current_user) stays covered by database-boot-gate-rules.spec.ts.
    const withRole = new URL(adminUrl);
    withRole.searchParams.set('options', '-c role=crewflow_app');
    await refusedAt(runDatabaseBootGates('api', options(withRole.toString())), 'connect', /sets "options"/);
  });

  // OWNER-DB-ULTIMATE Part B3: the C3 relaxation is retired. Any pending migration refuses the API AND the Worker, in order or
  // not, with or without physical upgrade evidence.
  it('pending migrations: the API refuses one pending migration', async () => {
    const migrations = [...((coreDataSourceOptions.migrations as string[]) ?? []), BootGateFakePending9999999999999];
    await refusedAt(runDatabaseBootGates('api', options(appUrl, {}, migrations)), 'pending-migrations', /1 migration\(s\) are not applied: BootGateFakePending9999999999999/);
  });

  it('pending migrations: the Worker refuses an OUT-OF-ORDER pending migration (older than the newest applied)', async () => {
    const migrations = [...((coreDataSourceOptions.migrations as string[]) ?? []), BootGateFakeOutOfOrder1700000000000];
    await refusedAt(runDatabaseBootGates('worker', options(appUrl, {}, migrations)), 'pending-migrations', /1 migration\(s\) are not applied: BootGateFakeOutOfOrder1700000000000/);
  });

  it('pending migrations: the Worker refuses an in-order pending tail too, even with physical upgrade evidence (Part B3: no partly-upgraded start)', async () => {
    const su = new Client({ connectionString: adminUrl });
    await su.connect();
    try {
      await su.query('BEGIN');
      const slug = `bootgate-evidence-${randomUUID().slice(0, 8)}`;
      await su.query(`INSERT INTO core.organisation (name, slug) VALUES ($1, $2)`, [slug, slug]);
      await su.query('ROLLBACK');
    } finally {
      await su.end();
    }
    const migrations = [...((coreDataSourceOptions.migrations as string[]) ?? []), BootGateFakePending9999999999999];
    await refusedAt(runDatabaseBootGates('worker', options(appUrl, {}, migrations)), 'pending-migrations', /1 migration\(s\) are not applied: BootGateFakePending9999999999999/);
  });

  it('identity: PG_EXPECTED_DATABASE_NAME must equal current_database()', async () => {
    await refusedAt(runDatabaseBootGates('api', options(appUrl, { env: { ...NON_PROD, PG_EXPECTED_DATABASE_NAME: 'not_this_database' } })), 'identity', /expects database "not_this_database"/);
    await expect(runDatabaseBootGates('api', options(appUrl, { env: { ...NON_PROD, PG_EXPECTED_DATABASE_NAME: report.database } }))).resolves.toBeDefined();
  });

  it('identity: a declared identity cannot match an absent/unbound marker; DECLARED production fails closed without a bound marker (undeclared production only warns: BC-11, owner-accepted 2026-11-05, covered by Agent 1 unit tests; it needs TLS)', async () => {
    await refusedAt(
      runDatabaseBootGates('api', options(appUrl, { env: { ...NON_PROD, CREWFLOW_DEPLOYMENT_ENVIRONMENT: 'test', CREWFLOW_DEPLOYMENT_ID: PROD_ID } })),
      'identity',
      /declares test\/6f1c2d3e.*(no deployment identity marker|never bound)/,
    );
    await refusedAt(
      runDatabaseBootGates('api', options(appUrl, { env: { NODE_ENV: 'production', RAB_RUNTIME_ENV: 'production', CREWFLOW_DEPLOYMENT_ENVIRONMENT: 'production', CREWFLOW_DEPLOYMENT_ID: PROD_ID } })),
      'identity',
      /production api process refuses to run/,
    );
  });

  it('unreachable database: bounded retry, then an actionable refusal without the URL', async () => {
    const lines: string[] = [];
    await refusedAt(
      runDatabaseBootGates('api', {
        ...options('postgres://crewflow_app:not-the-password@127.0.0.1:1/nothing'),
        retry: { attempts: 3, baseDelayMs: 5, maxDelayMs: 10 },
        log: (l) => lines.push(l),
      }),
      'connect',
      /unreachable for the api process after 3 attempt\(s\)/,
    );
    expect(lines.filter((l) => /retrying in/.test(l))).toHaveLength(2);
    expect(lines.join('\n')).not.toContain('not-the-password');
  });
});

describe('B3 identity in the command and runtime guards (integration, marker absent or unbound)', () => {
  const silence = () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  };
  afterEach(() => jest.restoreAllMocks());

  it('DB_TARGET=test on an unmarked database proceeds (with a warning); a declared identity it cannot match is refused', async () => {
    silence();
    await expect(assertDbTarget('migrations', { DB_TARGET: 'test', DATABASE_URL: appUrl }, {})).resolves.toMatchObject({ target: 'test' });
    await expect(
      assertDbTarget('migrations', { DB_TARGET: 'test', DATABASE_URL: appUrl, CREWFLOW_DEPLOYMENT_ENVIRONMENT: 'test', CREWFLOW_DEPLOYMENT_ID: PROD_ID }, {}),
    ).rejects.toBeInstanceOf(DbTargetError);
  });

  it('the runtime guard reads the marker on its probe connection: unmarked non-production passes, a declared identity is refused', async () => {
    silence();
    await expect(assertRuntimeDatabaseIdentity('api', { NODE_ENV: 'test', PG_DATABASE_URL: appUrl }, {})).resolves.toMatchObject({ classification: 'LOCAL' });
    await expect(
      assertRuntimeDatabaseIdentity('api', { NODE_ENV: 'test', PG_DATABASE_URL: appUrl, CREWFLOW_DEPLOYMENT_ENVIRONMENT: 'ci', CREWFLOW_DEPLOYMENT_ID: PROD_ID }, {}),
    ).rejects.toBeInstanceOf(RuntimeDbError);
  });
});
