import { MARKER_PRESENT_SQL, MARKER_READ_SQL, Query } from '../deployment-identity/deployment-identity';
import {
  BOOT_FACTS_SQL,
  cliCommandFromArgv,
  DatabaseBootGateError,
  evaluateBootGates,
  EvaluateBootGatesInput,
  expectedRolesFor,
  FORCE_RLS_SPOT_CHECK_TABLES,
  FORCE_RLS_SQL,
  isDatabaseUnreachable,
  isProductionProcess,
  PROVISIONER_ROLE,
  RLS_DISABLED_TENANT_TABLES_SQL,
  withDatabaseRetry,
} from './database-boot-gate-rules';
import { assertSchemaCompatible, assessSchemaCompatibility } from './schema-compatibility';

const PROD_ID = '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const PROD_ENV = { NODE_ENV: 'production', RAB_RUNTIME_ENV: 'production', CREWFLOW_DEPLOYMENT_ENVIRONMENT: 'production', CREWFLOW_DEPLOYMENT_ID: PROD_ID };

interface FakeDb {
  facts: Record<string, unknown>;
  markerPresent: boolean;
  markerRows: Array<Record<string, unknown>>;
  force: Array<Record<string, unknown>>;
  disabled: string[];
}

function healthy(overrides: Partial<FakeDb> = {}, factOverrides: Record<string, unknown> = {}): FakeDb {
  return {
    facts: {
      who: 'crewflow_app',
      login: 'crewflow_app',
      super: false,
      bypassrls: false,
      login_privileged: false,
      owner_roles: null,
      server_version_num: 160015,
      database: 'crewflow',
      extensions: 'btree_gist,citext,pg_trgm,pgcrypto,plpgsql,unaccent,uuid-ossp',
      ssl: false,
      ...factOverrides,
    },
    markerPresent: false,
    markerRows: [],
    force: FORCE_RLS_SPOT_CHECK_TABLES.map((relname) => ({ relname, enabled: true, forced: true })),
    disabled: [],
    ...overrides,
  };
}

/**
 * The host the gate's connection names, and where the fake markers below were bound (owner decision A). A listed compose
 * database service (final review F4: an unlisted single-label name is remote): security review H-1 refuses an ABSENT/UNBOUND
 * marker on a remote host outside tests, which is covered by its own case below.
 */
const GATE_HOST = 'devdb';

function fakeQuery(db: FakeDb): Query {
  return async (sql: string) => {
    if (sql === BOOT_FACTS_SQL) return [db.facts];
    if (sql === MARKER_PRESENT_SQL) return [{ present: db.markerPresent, database: db.facts.database }];
    if (sql === MARKER_READ_SQL) return db.markerRows;
    if (sql === FORCE_RLS_SQL) return db.force;
    if (sql === RLS_DISABLED_TENANT_TABLES_SQL) return db.disabled.map((relname) => ({ relname }));
    throw new Error(`unexpected SQL ${sql.slice(0, 40)}`);
  };
}

function input(db: FakeDb, over: Partial<EvaluateBootGatesInput> = {}): EvaluateBootGatesInput {
  return {
    processName: 'api',
    env: { NODE_ENV: 'development' },
    query: fakeQuery(db),
    checkPendingMigrations: async () => undefined,
    connectionHost: GATE_HOST,
    ...over,
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

describe('database boot gates (fake connection)', () => {
  it('a healthy non-production database passes every gate; an unbound marker is a warning', async () => {
    const report = await evaluateBootGates(input(healthy()));
    expect(report).toMatchObject({ processName: 'api', role: 'crewflow_app', serverVersionNum: 160015, identity: 'absent', tls: false });
    expect(report.warnings).toHaveLength(1);
  });

  it('identity, H-1: an absent or unbound marker on a dotted REMOTE host is refused for a non-production process unless it is explicitly a remote test database', async () => {
    const unbound = healthy({ markerPresent: true, markerRows: [] });
    for (const db of [healthy(), unbound]) {
      for (const processName of ['api', 'worker', 'provisioner', 'cli'] as const) {
        const asRole = processName === 'provisioner' ? healthy(db === unbound ? { markerPresent: true, markerRows: [] } : {}, { who: 'crewflow', login: 'crewflow' }) : db;
        await refusedAt(
          evaluateBootGates(input(asRole, { processName, cliCommand: processName === 'cli' ? 'bootstrap-admin' : undefined, connectionHost: 'db.gate.example.com' })),
          'identity',
          /connects to the remote host "db\.gate\.example\.com".*cannot be told apart from an unmarked production database/,
        );
      }
    }
    await expect(
      evaluateBootGates(input(healthy(), { processName: 'cli', cliCommand: 'bootstrap-admin', connectionHost: 'db.gate.example.com', env: { DB_TARGET: 'test', ALLOW_REMOTE_TEST_DATABASE: 'true' } })),
    ).resolves.toMatchObject({ identity: 'absent' });
    // N-2 / L-4: a RUNTIME never reads DB_TARGET, so the command allowance grants an API / Worker / provisioner nothing,
    // and NODE_ENV=test alone (no server-side disposable-test setting) is no exemption either.
    for (const processName of ['api', 'worker'] as const) {
      for (const env of [{ DB_TARGET: 'test', ALLOW_REMOTE_TEST_DATABASE: 'true' }, { NODE_ENV: 'test' }]) {
        await refusedAt(evaluateBootGates(input(healthy(), { processName, connectionHost: 'db.gate.example.com', env })), 'identity', /remote host "db\.gate\.example\.com"/);
      }
    }
    await expect(evaluateBootGates(input(healthy(), { connectionHost: '127.0.0.1' }))).resolves.toMatchObject({ identity: 'absent' });
  });

  it('role: refuses the wrong login, SET ROLE, superuser / BYPASSRLS, and owner-role membership', async () => {
    await refusedAt(evaluateBootGates(input(healthy({}, { who: 'crewflow', login: 'crewflow' }))), 'role', /connects as "crewflow"; expected crewflow_app/);
    await refusedAt(evaluateBootGates(input(healthy({}, { login: 'crewflow_migrator' }))), 'role', /SET ROLE is not accepted/);
    await refusedAt(evaluateBootGates(input(healthy({}, { super: true }))), 'role', /SUPERUSER or BYPASSRLS/);
    await refusedAt(evaluateBootGates(input(healthy({}, { bypassrls: true }))), 'role', /SUPERUSER or BYPASSRLS/);
    await refusedAt(evaluateBootGates(input(healthy({}, { login_privileged: true }))), 'role', /SUPERUSER or BYPASSRLS/);
    await refusedAt(evaluateBootGates(input(healthy({}, { owner_roles: 'rab_secure_owner' }))), 'role', /member of rab_secure_owner/);
  });

  it('role, CLI: crewflow_app by default; the documented operator commands may also run as crewflow; never the migrator', async () => {
    expect(expectedRolesFor('api')).toEqual(['crewflow_app']);
    expect(expectedRolesFor('cli', 'storage:reconcile')).toEqual(['crewflow_app']);
    expect(expectedRolesFor('cli', undefined)).toEqual(['crewflow_app']);
    expect(expectedRolesFor('cli', 'bootstrap-admin')).toEqual(['crewflow', 'crewflow_app']);
    const asCrewflow = healthy({}, { who: 'crewflow', login: 'crewflow' });
    await expect(evaluateBootGates(input(asCrewflow, { processName: 'cli', cliCommand: 'bootstrap-admin' }))).resolves.toMatchObject({ role: 'crewflow' });
    await refusedAt(evaluateBootGates(input(asCrewflow, { processName: 'cli', cliCommand: 'storage:reconcile' })), 'role', /CLI command "storage:reconcile" connects as "crewflow"/);
    await refusedAt(
      evaluateBootGates(input(healthy({}, { who: 'crewflow_migrator', login: 'crewflow_migrator' }), { processName: 'cli', cliCommand: 'bootstrap-admin' })),
      'role',
      /expected crewflow or crewflow_app/,
    );
  });

  it('version: below PostgreSQL 16 is refused', async () => {
    await refusedAt(evaluateBootGates(input(healthy({}, { server_version_num: 150008 }))), 'version', /150008 is below the minimum 160000/);
  });

  it('extensions: each required extension must be installed (uuid-ossp is not required)', async () => {
    await refusedAt(evaluateBootGates(input(healthy({}, { extensions: 'btree_gist,citext,pgcrypto,plpgsql' }))), 'extensions', /missing: pg_trgm, unaccent/);
    await expect(evaluateBootGates(input(healthy({}, { extensions: 'btree_gist,citext,pg_trgm,pgcrypto,unaccent' })))).resolves.toBeDefined();
  });

  it('identity: a non-production process on a production-bound database is refused; production needs the matching marker', async () => {
    const prodBound = healthy({ markerPresent: true, markerRows: [{ environment: 'production', deployment_id: PROD_ID, bound_database: 'crewflow', bound_hosts: [GATE_HOST] }] });
    await refusedAt(evaluateBootGates(input(prodBound)), 'identity', /bound to production/);
    await refusedAt(evaluateBootGates(input(healthy(), { env: PROD_ENV })), 'identity', /production api process refuses to run: the database has no deployment identity marker/);
    await refusedAt(evaluateBootGates(input(healthy(), { env: { NODE_ENV: 'production', RAB_RUNTIME_ENV: 'production' } })), 'identity', /requires CREWFLOW_DEPLOYMENT_ENVIRONMENT=production/);
    // Production with the right marker but no TLS: the identity gate passes, the TLS gate refuses.
    await refusedAt(evaluateBootGates(input(prodBound, { env: PROD_ENV })), 'tls', /not using TLS/);
    const tls = healthy({ markerPresent: true, markerRows: [{ environment: 'production', deployment_id: PROD_ID, bound_database: 'crewflow', bound_hosts: [GATE_HOST] }] }, { ssl: true });
    await expect(evaluateBootGates(input(tls, { env: PROD_ENV }))).resolves.toMatchObject({ identity: `production/${PROD_ID}`, tls: true, warnings: [] });
  });

  it('identity: a marker bound in another database or at another host (restore / clone / fork) is refused, production or not', async () => {
    const row = { environment: 'production', deployment_id: PROD_ID, bound_database: 'crewflow', bound_hosts: [GATE_HOST] };
    const tls = (r: Record<string, unknown>) => healthy({ markerPresent: true, markerRows: [r] }, { ssl: true });
    await refusedAt(evaluateBootGates(input(tls(row), { env: PROD_ENV, connectionHost: 'restored.gate.internal' })), 'identity', /bound at host "devdb".*db:bind-identity/);
    await refusedAt(evaluateBootGates(input(tls({ ...row, bound_database: 'crewflow_prod' }), { env: PROD_ENV })), 'identity', /bound in database "crewflow_prod"/);
    const ci = { environment: 'ci', deployment_id: PROD_ID, bound_database: 'crewflow', bound_hosts: [GATE_HOST] };
    await refusedAt(evaluateBootGates(input(tls(ci), { connectionHost: 'copy.gate.internal' })), 'identity', /bound at host/);
    await expect(evaluateBootGates(input(tls(ci)))).resolves.toMatchObject({ identity: `ci/${PROD_ID}` });
  });

  it('identity: the runtime never honours the production bootstrap flag', async () => {
    await refusedAt(
      evaluateBootGates(input(healthy(), { env: { ...PROD_ENV, CREWFLOW_DEPLOYMENT_IDENTITY_BOOTSTRAP: 'unbound-production-database', PG_EXPECTED_DATABASE_NAME: 'crewflow' } })),
      'identity',
      /honoured only by production database commands/,
    );
  });

  it('force-rls: a spot-check table without FORCE, a missing one, or a tenant table without RLS is refused', async () => {
    const force = FORCE_RLS_SPOT_CHECK_TABLES.map((relname) => ({ relname, enabled: true, forced: relname !== 'shift' }));
    await refusedAt(evaluateBootGates(input(healthy({ force }))), 'force-rls', /core\.shift enable=true force=false/);
    await refusedAt(evaluateBootGates(input(healthy({ force: force.filter((r) => r.relname !== 'payslip') }))), 'force-rls', /core\.payslip missing/);
    await refusedAt(evaluateBootGates(input(healthy({ disabled: ['venue_role_rate'] }))), 'force-rls', /venue_role_rate has organisation_id but RLS disabled/);
  });

  it('tls: only enforced in production (CLI production = DB_TARGET=production)', async () => {
    expect(isProductionProcess('api', { NODE_ENV: 'production' })).toBe(true);
    expect(isProductionProcess('worker', { RAB_RUNTIME_ENV: 'production' })).toBe(true);
    expect(isProductionProcess('cli', { NODE_ENV: 'production' })).toBe(false);
    expect(isProductionProcess('cli', { DB_TARGET: 'production' })).toBe(true);
    await expect(evaluateBootGates(input(healthy({}, { ssl: null })))).resolves.toMatchObject({ tls: null });
  });

  it('pending migrations: any failure of the pending check is a refusal at that gate', async () => {
    await refusedAt(
      evaluateBootGates(input(healthy(), { checkPendingMigrations: async () => Promise.reject(new Error('Refusing to start the api process: 1 migration(s) are not applied: X1')) })),
      'pending-migrations',
      /1 migration\(s\) are not applied/,
    );
  });

  it('schema compatibility (gate 7): the check sees whether the process is production; its warnings reach the report', async () => {
    const seen: boolean[] = [];
    const report = await evaluateBootGates(
      input(healthy(), {
        processName: 'worker',
        checkPendingMigrations: async ({ production }) => {
          seen.push(production);
          return { warnings: ['the migration ledger is AHEAD of this code by 1 migration(s)'] };
        },
      }),
    );
    expect(seen).toEqual([false]);
    // The unbound-marker warning first (identity gate), then gate 7's.
    expect(report.warnings).toHaveLength(2);
    expect(report.warnings[1]).toBe('the migration ledger is AHEAD of this code by 1 migration(s)');
  });

  it('schema compatibility (gate 7): a SchemaCompatibilityError keeps its own gate name (pending-migrations or schema-compatibility)', async () => {
    const code = ['A1786000000000', 'B1786000000100'];
    const interleaved = assessSchemaCompatibility('api', { expected: code, applied: [...code, 'X1786000000050'] }, { production: false });
    await refusedAt(
      evaluateBootGates(input(healthy(), { checkPendingMigrations: async () => assertSchemaCompatible(interleaved, 'api process') && undefined })),
      'schema-compatibility',
      /another branch's migration chain or the wrong database/,
    );
    const pending = assessSchemaCompatibility('api', { expected: code, applied: [code[0]!] }, { production: false });
    await refusedAt(
      evaluateBootGates(input(healthy(), { checkPendingMigrations: async () => assertSchemaCompatible(pending, 'api process') && undefined })),
      'pending-migrations',
      /1 migration\(s\) are not applied: B1786000000100/,
    );
  });

  it('provisioner: expects crewflow (the provisioning identity), refuses crewflow_app, and keeps every other role rule', async () => {
    expect(PROVISIONER_ROLE).toBe('crewflow');
    expect(expectedRolesFor('provisioner')).toEqual(['crewflow']);
    const asCrewflow = healthy({}, { who: 'crewflow', login: 'crewflow' });
    await expect(evaluateBootGates(input(asCrewflow, { processName: 'provisioner' }))).resolves.toMatchObject({ processName: 'provisioner', role: 'crewflow' });
    await refusedAt(evaluateBootGates(input(healthy(), { processName: 'provisioner' })), 'role', /provisioner process connects as "crewflow_app"; expected crewflow/);
    await refusedAt(evaluateBootGates(input(healthy({}, { who: 'crewflow', login: 'crewflow', super: true }), { processName: 'provisioner' })), 'role', /SUPERUSER or BYPASSRLS/);
    await refusedAt(
      evaluateBootGates(input(healthy({}, { who: 'crewflow', login: 'crewflow', owner_roles: 'rab_secure_owner' }), { processName: 'provisioner' })),
      'role',
      /member of rab_secure_owner/,
    );
    await refusedAt(evaluateBootGates(input(healthy({}, { who: 'crewflow', login: 'crewflow_migrator' }), { processName: 'provisioner' })), 'role', /SET ROLE is not accepted/);
    // Production is the runtime's own declaration, as for the jobs child; TLS is then required.
    expect(isProductionProcess('provisioner', { NODE_ENV: 'production' })).toBe(true);
    await refusedAt(evaluateBootGates(input(asCrewflow, { processName: 'provisioner', env: PROD_ENV })), 'identity', /production provisioner process refuses to run/);
  });

  it('provisioner: a ledger ahead of the code is a refusal for it, while the API only warns', async () => {
    const code = ['A1786000000000'];
    const facts = { expected: code, applied: [...code, 'Newer1786000000900'] };
    await refusedAt(
      evaluateBootGates(
        input(healthy({}, { who: 'crewflow', login: 'crewflow' }), {
          processName: 'provisioner',
          checkPendingMigrations: async ({ production }) => ({ warnings: assertSchemaCompatible(assessSchemaCompatibility('provisioner', facts, { production }), 'provisioner process') }),
        }),
      ),
      'schema-compatibility',
      /AHEAD of this code by 1 migration/,
    );
    const api = await evaluateBootGates(
      input(healthy(), {
        checkPendingMigrations: async ({ production }) => ({ warnings: assertSchemaCompatible(assessSchemaCompatibility('api', facts, { production }), 'api process') }),
      }),
    );
    expect(api.warnings.join()).toMatch(/AHEAD of this code by 1 migration/);
  });

  it('cliCommandFromArgv returns the first non-option argument after the script', () => {
    expect(cliCommandFromArgv(['node', 'main.js', 'bootstrap-admin', '--x'])).toBe('bootstrap-admin');
    expect(cliCommandFromArgv(['node', 'main.js', '--help'])).toBeUndefined();
  });
});

describe('database boot gates: bounded retry when the database is unreachable', () => {
  const unreachable = () => Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });

  it('classifies only "not reachable (yet)" errors as retryable', () => {
    expect(isDatabaseUnreachable(unreachable())).toBe(true);
    expect(isDatabaseUnreachable(Object.assign(new Error('starting up'), { code: '57P03' }))).toBe(true);
    expect(isDatabaseUnreachable(new Error('Connection terminated unexpectedly'))).toBe(true);
    expect(isDatabaseUnreachable({ driverError: unreachable() })).toBe(true);
    expect(isDatabaseUnreachable(Object.assign(new Error('password authentication failed'), { code: '28P01' }))).toBe(false);
    expect(isDatabaseUnreachable(Object.assign(new Error('database does not exist'), { code: '3D000' }))).toBe(false);
    expect(isDatabaseUnreachable(new DatabaseBootGateError('role', 'x'))).toBe(false);
  });

  it('retries with exponential backoff capped at maxDelayMs, then fails with an actionable connect refusal', async () => {
    const delays: number[] = [];
    let calls = 0;
    await refusedAt(
      withDatabaseRetry(
        'api process',
        async () => {
          calls += 1;
          throw unreachable();
        },
        { attempts: 5, baseDelayMs: 100, maxDelayMs: 300, sleep: async (ms) => void delays.push(ms), log: () => undefined },
      ),
      'connect',
      /stayed unreachable for the api process after 5 attempt\(s\) \(last driver code ECONNREFUSED\)/,
    );
    expect(calls).toBe(5);
    expect(delays).toEqual([100, 200, 300, 300]);
  });

  it('succeeds once the database comes up; a gate refusal is never retried', async () => {
    let calls = 0;
    const value = await withDatabaseRetry('w', async () => {
      calls += 1;
      if (calls < 3) throw unreachable();
      return 'ok';
    }, { sleep: async () => undefined, log: () => undefined });
    expect(value).toBe('ok');
    expect(calls).toBe(3);

    let gateCalls = 0;
    await refusedAt(
      withDatabaseRetry('w', async () => {
        gateCalls += 1;
        throw new DatabaseBootGateError('role', 'wrong login');
      }, { sleep: async () => undefined, log: () => undefined }),
      'role',
      /wrong login/,
    );
    expect(gateCalls).toBe(1);
  });
});
