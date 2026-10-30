import {
  assertDeclaredIdentityForProcess,
  assertDeploymentIdentity,
  assertExpectedDatabaseName,
  decideDeploymentIdentity,
  DeploymentIdentityError,
  DeploymentMarker,
  DISPOSABLE_TEST_DATABASE_SETTING_NAME,
  isRemoteDatabaseHost,
  MARKER_PRESENT_SQL,
  MARKER_READ_SQL,
  Query,
  readBootstrapFlag,
  readDeclaredDeploymentIdentity,
  readDeploymentMarker,
  remoteUnmarkedDatabaseAllowed,
} from './deployment-identity';
import { DISPOSABLE_TEST_DATABASE_SETTING } from '../typeorm/core/test-database-guard';

const PROD_ID = '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const OTHER_ID = '0b9a8c7d-6e5f-4a3b-9c2d-1e0f2a3b4c5d';
const PROD_ENV = { CREWFLOW_DEPLOYMENT_ENVIRONMENT: 'production', CREWFLOW_DEPLOYMENT_ID: PROD_ID };
const HOST = 'db.example.internal';
/** Where the fake connection is: database + host the marker was bound at, unless a test says otherwise. */
const LOC = { currentDatabase: 'crewflow', connectionHost: HOST };
const bound = (environment: string, deploymentId: string, at: Partial<{ db: string; hosts: string[]; sid: string | null; now: string | null }> = {}): DeploymentMarker => ({
  state: 'bound',
  environment,
  deploymentId,
  boundDatabase: at.db ?? 'crewflow',
  boundHosts: at.hosts ?? [HOST],
  boundSystemIdentifier: at.sid ?? null,
  currentSystemIdentifier: at.now ?? null,
});

function refused(fn: () => unknown, pattern: RegExp): void {
  let error: unknown;
  try {
    fn();
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(DeploymentIdentityError);
  expect((error as Error).message).toMatch(pattern);
  expect((error as Error).message).not.toMatch(/postgres:\/\//);
}

/** A fake connection: the marker function present or not, and the rows it returns. */
function fakeQuery(opts: { present: boolean; rows?: Array<Record<string, unknown>>; database?: string; readError?: { code: string }; disposableTest?: unknown }): Query {
  return async (sql: string) => {
    if (sql === MARKER_PRESENT_SQL) return [{ present: opts.present, database: opts.database ?? 'crewflow', disposable_test: opts.disposableTest }];
    if (sql === MARKER_READ_SQL) {
      if (opts.readError) throw Object.assign(new Error('denied'), opts.readError);
      return opts.rows ?? [];
    }
    throw new Error(`unexpected SQL: ${sql.slice(0, 40)}`);
  };
}

describe('deployment identity: declared environment (pure)', () => {
  it('both unset is "no declaration"; both set is parsed and the id lower-cased', () => {
    expect(readDeclaredDeploymentIdentity({})).toBeNull();
    expect(readDeclaredDeploymentIdentity({ CREWFLOW_DEPLOYMENT_ENVIRONMENT: ' ', CREWFLOW_DEPLOYMENT_ID: '' })).toBeNull();
    expect(readDeclaredDeploymentIdentity({ CREWFLOW_DEPLOYMENT_ENVIRONMENT: 'staging', CREWFLOW_DEPLOYMENT_ID: PROD_ID.toUpperCase() })).toEqual({
      environment: 'staging',
      deploymentId: PROD_ID,
    });
  });

  it('one variable without the other, an unknown environment or a non-uuid id is refused', () => {
    refused(() => readDeclaredDeploymentIdentity({ CREWFLOW_DEPLOYMENT_ENVIRONMENT: 'production' }), /must be set together/);
    refused(() => readDeclaredDeploymentIdentity({ CREWFLOW_DEPLOYMENT_ID: PROD_ID }), /must be set together/);
    refused(() => readDeclaredDeploymentIdentity({ CREWFLOW_DEPLOYMENT_ENVIRONMENT: 'prod', CREWFLOW_DEPLOYMENT_ID: PROD_ID }), /"prod" is not recognised/);
    refused(() => readDeclaredDeploymentIdentity({ CREWFLOW_DEPLOYMENT_ENVIRONMENT: 'test', CREWFLOW_DEPLOYMENT_ID: 'not-a-uuid' }), /must be a uuid \(value not shown\)/);
  });

  it('production requires a production declaration; a non-production process may not declare production', () => {
    refused(() => assertDeclaredIdentityForProcess({}, true, 'api process'), /production api process requires CREWFLOW_DEPLOYMENT_ENVIRONMENT=production/);
    refused(
      () => assertDeclaredIdentityForProcess({ CREWFLOW_DEPLOYMENT_ENVIRONMENT: 'staging', CREWFLOW_DEPLOYMENT_ID: PROD_ID }, true, 'api process'),
      /must declare production/,
    );
    refused(() => assertDeclaredIdentityForProcess(PROD_ENV, false, 'api process'), /non-production api process declares CREWFLOW_DEPLOYMENT_ENVIRONMENT=production/);
    expect(assertDeclaredIdentityForProcess(PROD_ENV, true, 'api process')).toEqual({ environment: 'production', deploymentId: PROD_ID });
    expect(assertDeclaredIdentityForProcess({}, false, 'api process')).toBeNull();
  });

  it('the bootstrap flag accepts only its exact value', () => {
    expect(readBootstrapFlag({})).toBe(false);
    expect(readBootstrapFlag({ CREWFLOW_DEPLOYMENT_IDENTITY_BOOTSTRAP: 'unbound-production-database' })).toBe(true);
    refused(() => readBootstrapFlag({ CREWFLOW_DEPLOYMENT_IDENTITY_BOOTSTRAP: 'true' }), /must be unset or exactly/);
  });

  it('PG_EXPECTED_DATABASE_NAME, when set, must equal the server-reported name', () => {
    expect(assertExpectedDatabaseName({}, 'defaultdb', 'api process')).toBe(false);
    expect(assertExpectedDatabaseName({ PG_EXPECTED_DATABASE_NAME: 'defaultdb' }, 'defaultdb', 'api process')).toBe(true);
    refused(() => assertExpectedDatabaseName({ PG_EXPECTED_DATABASE_NAME: 'crewflow' }, 'defaultdb', 'api process'), /expects database "crewflow".*reports "defaultdb"/);
  });
});

describe('deployment identity: the marker decision (pure)', () => {
  const prod = { environment: 'production' as const, deploymentId: PROD_ID };

  it('production + marker bound to the same production id passes', () => {
    expect(decideDeploymentIdentity({ ...LOC, processLabel: 'api', production: true, declared: prod, marker: bound('production', PROD_ID.toUpperCase()) })).toEqual({
      warnings: [],
      summary: `production/${PROD_ID}`,
      bootstrap: false,
    });
  });

  it('production refuses a wrong deployment id, a wrong environment, a missing or unbound marker', () => {
    refused(() => decideDeploymentIdentity({ ...LOC, processLabel: 'api', production: true, declared: prod, marker: bound('production', OTHER_ID) }), /bound to production\/0b9a8c7d/);
    refused(() => decideDeploymentIdentity({ ...LOC, processLabel: 'api', production: true, declared: prod, marker: bound('staging', PROD_ID) }), /bound to staging\//);
    refused(() => decideDeploymentIdentity({ ...LOC, processLabel: 'api', production: true, declared: prod, marker: { state: 'absent' } }), /no deployment identity marker.*db:bind-identity/);
    refused(() => decideDeploymentIdentity({ ...LOC, processLabel: 'api', production: true, declared: prod, marker: { state: 'unbound' } }), /never bound/);
    refused(() => decideDeploymentIdentity({ ...LOC, processLabel: 'api', production: true, declared: null, marker: bound('production', PROD_ID) }), /no declared deployment identity/);
  });

  it('production bootstrap: allowed only for an absent/unbound marker AND with PG_EXPECTED_DATABASE_NAME; refused once bound', () => {
    refused(
      () => decideDeploymentIdentity({ ...LOC, processLabel: 'migrations', production: true, declared: prod, marker: { state: 'unbound' }, bootstrapRequested: true }),
      /needs PG_EXPECTED_DATABASE_NAME/,
    );
    const ok = decideDeploymentIdentity({
      ...LOC,
      processLabel: 'migrations',
      production: true,
      declared: prod,
      marker: { state: 'absent' },
      bootstrapRequested: true,
      expectedDatabaseNameSet: true,
    });
    expect(ok.bootstrap).toBe(true);
    expect(ok.summary).toBe('bootstrap');
    expect(ok.warnings[0]).toMatch(/^BOOTSTRAP/);
    refused(
      () => decideDeploymentIdentity({ ...LOC, processLabel: 'migrations', production: true, declared: prod, marker: bound('production', PROD_ID), bootstrapRequested: true, expectedDatabaseNameSet: true }),
      /already bound .*Remove the flag/,
    );
  });

  it('outside production: absent/unbound + nothing declared passes with a warning on a LOCAL host; a declaration must match', () => {
    // H-1: the pass is for loopback and single-label docker-service hosts only (a remote host is the next test).
    for (const connectionHost of ['127.0.0.1', 'localhost', '::1', 'postgres', 'devdb']) {
      const absent = decideDeploymentIdentity({ ...LOC, connectionHost, processLabel: 'api', production: false, declared: null, marker: { state: 'absent' } });
      expect(absent.summary).toBe('absent');
      expect(absent.warnings).toHaveLength(1);
      expect(decideDeploymentIdentity({ ...LOC, connectionHost, processLabel: 'api', production: false, declared: null, marker: { state: 'unbound' } }).summary).toBe('unbound');
    }
    const staging = { environment: 'staging' as const, deploymentId: OTHER_ID };
    refused(() => decideDeploymentIdentity({ ...LOC, processLabel: 'api', production: false, declared: staging, marker: { state: 'absent' } }), /declares staging\/.*but the database has no deployment identity marker/);
    expect(decideDeploymentIdentity({ ...LOC, processLabel: 'api', production: false, declared: staging, marker: bound('staging', OTHER_ID) }).warnings).toEqual([]);
    refused(() => decideDeploymentIdentity({ ...LOC, processLabel: 'api', production: false, declared: staging, marker: bound('staging', PROD_ID) }), /wrong database, or the database is a copy/);
  });

  it('H-1: outside production an ABSENT or UNBOUND marker on a remote host is refused unless explicitly a remote test database', () => {
    const remoteHosts = ['db.example.internal', 'ep-round-rain-aess0njf.c-2.us-east-2.aws.neon.tech', '10.0.0.5', '2001:db8::1', ''];
    for (const connectionHost of remoteHosts) {
      for (const state of ['absent', 'unbound'] as const) {
        refused(
          () => decideDeploymentIdentity({ ...LOC, connectionHost, processLabel: 'worker process', production: false, declared: null, marker: { state } }),
          /refuses to run: .* remote host .*cannot be told apart from an unmarked production database.*ALLOW_REMOTE_TEST_DATABASE=true.*crewflow\.disposable_test_database = 'true'\. Refusing\./,
        );
      }
    }
    // The explicit remote-test allowance (computed by assertDeploymentIdentity from the environment) passes with a warning.
    const allowed = decideDeploymentIdentity({ ...LOC, processLabel: 'migrations', production: false, declared: null, marker: { state: 'absent' }, remoteUnmarkedAllowed: true });
    expect(allowed.summary).toBe('absent');
    // A bound non-production marker on a remote host is unaffected (it is the marker's own location rule that applies).
    expect(decideDeploymentIdentity({ ...LOC, processLabel: 'api', production: false, declared: null, marker: bound('staging', OTHER_ID) }).summary).toBe(`staging/${OTHER_ID}`);
  });

  it('H-1 / N-2: the remote allowance needs NODE_ENV=test ON a server-marked disposable test database, or a COMMAND with DB_TARGET=test AND ALLOW_REMOTE_TEST_DATABASE=true', async () => {
    const disposable = { disposableTestDatabase: true, command: false };
    const plain = { disposableTestDatabase: false, command: false };
    const command = { disposableTestDatabase: false, command: true };
    expect(remoteUnmarkedDatabaseAllowed({ NODE_ENV: 'test' }, disposable)).toBe(true);
    // N-2: NODE_ENV=test alone (a valid runtime NODE_ENV) is no longer enough.
    expect(remoteUnmarkedDatabaseAllowed({ NODE_ENV: 'test' }, plain)).toBe(false);
    expect(remoteUnmarkedDatabaseAllowed({ NODE_ENV: 'test' }, command)).toBe(false);
    expect(remoteUnmarkedDatabaseAllowed({ NODE_ENV: 'development' }, disposable)).toBe(false);
    expect(remoteUnmarkedDatabaseAllowed({ DB_TARGET: 'test', ALLOW_REMOTE_TEST_DATABASE: 'true' }, command)).toBe(true);
    // A runtime (command: false) never reads DB_TARGET, so the command allowance grants it nothing.
    expect(remoteUnmarkedDatabaseAllowed({ DB_TARGET: 'test', ALLOW_REMOTE_TEST_DATABASE: 'true' }, plain)).toBe(false);
    expect(remoteUnmarkedDatabaseAllowed({ DB_TARGET: 'test' }, command)).toBe(false);
    expect(remoteUnmarkedDatabaseAllowed({ ALLOW_REMOTE_TEST_DATABASE: 'true' }, command)).toBe(false);
    expect(remoteUnmarkedDatabaseAllowed({ DB_TARGET: 'local', ALLOW_REMOTE_TEST_DATABASE: 'true' }, command)).toBe(false);
    expect(remoteUnmarkedDatabaseAllowed({ NODE_ENV: 'development', ALLOW_REMOTE_TEST_DATABASE: 'TRUE', DB_TARGET: 'test' }, command)).toBe(false);
    expect(isRemoteDatabaseHost('postgres')).toBe(false);
    expect(isRemoteDatabaseHost('127.0.0.53')).toBe(false);
    expect(isRemoteDatabaseHost('[::1]')).toBe(false);
    // Final review F3: only a real IPv4 literal is loopback; a resolvable dotted name shaped like one is remote.
    expect(isRemoteDatabaseHost('127.999.999.999')).toBe(true);
    expect(isRemoteDatabaseHost('127.0.0.09')).toBe(true);
    expect(isRemoteDatabaseHost('127.0.0.1.example.net')).toBe(true);
    expect(isRemoteDatabaseHost('db.internal')).toBe(true);
    // End to end through the live check (fake connection, marker function absent).
    const opts = { processLabel: 'api process', production: false, connectionHost: 'db.example.internal' };
    await expect(assertDeploymentIdentity(fakeQuery({ present: false }), { ...opts, env: { NODE_ENV: 'development' } })).rejects.toThrow(/remote host "db\.example\.internal"/);
    await expect(
      assertDeploymentIdentity(fakeQuery({ present: false }), { ...opts, command: true, env: { DB_TARGET: 'test', ALLOW_REMOTE_TEST_DATABASE: 'true' } }),
    ).resolves.toMatchObject({ summary: 'absent' });
    await expect(assertDeploymentIdentity(fakeQuery({ present: false }), { ...opts, env: { DB_TARGET: 'test', ALLOW_REMOTE_TEST_DATABASE: 'true' } })).rejects.toThrow(/remote host/);
    await expect(assertDeploymentIdentity(fakeQuery({ present: false }), { ...opts, connectionHost: 'postgres', env: { NODE_ENV: 'development' } })).resolves.toMatchObject({ summary: 'absent' });
  });

  it('N-2: NODE_ENV=test + remote host + no marker + no disposable-test setting is REFUSED (any runtime); with the server-side setting it passes', async () => {
    const opts = { processLabel: 'api process', production: false, env: { NODE_ENV: 'test' } };
    for (const connectionHost of ['db.example.internal', 'ep-round-rain-aess0njf.c-2.us-east-2.aws.neon.tech', '10.0.0.5', 'fd00::5']) {
      for (const disposableTest of [undefined, null, false, 'true', 't', 1]) {
        await expect(assertDeploymentIdentity(fakeQuery({ present: false, disposableTest }), { ...opts, connectionHost })).rejects.toThrow(
          /refuses to run: .*remote host .*cannot be told apart from an unmarked production database/,
        );
      }
      // Unbound marker: same rule.
      await expect(assertDeploymentIdentity(fakeQuery({ present: true, rows: [] }), { ...opts, connectionHost })).rejects.toThrow(/remote host/);
      await expect(assertDeploymentIdentity(fakeQuery({ present: false, disposableTest: true }), { ...opts, connectionHost })).resolves.toMatchObject({ summary: 'absent' });
    }
    // Loopback and single-label docker hosts are unaffected (CI 127.0.0.1, the dev compose `devdb`).
    for (const connectionHost of ['127.0.0.1', '::1', 'localhost', 'devdb', 'postgres']) {
      await expect(assertDeploymentIdentity(fakeQuery({ present: false }), { ...opts, connectionHost })).resolves.toMatchObject({ summary: 'absent' });
    }
  });

  it('N-2: the disposable-test fact is the DATABASE-level catalog setting read on the checking connection, never current_setting()', async () => {
    expect(DISPOSABLE_TEST_DATABASE_SETTING_NAME).toBe(DISPOSABLE_TEST_DATABASE_SETTING);
    expect(MARKER_PRESENT_SQL).toContain('pg_catalog.pg_db_role_setting');
    expect(MARKER_PRESENT_SQL).toContain('s.setrole = 0');
    expect(MARKER_PRESENT_SQL).toContain(`'${DISPOSABLE_TEST_DATABASE_SETTING}=true'`);
    expect(MARKER_PRESENT_SQL).not.toMatch(/current_setting/i);
    await expect(readDeploymentMarker(fakeQuery({ present: false, disposableTest: true }))).resolves.toMatchObject({ disposableTestDatabase: true });
    await expect(readDeploymentMarker(fakeQuery({ present: false, disposableTest: 'true' }))).resolves.toMatchObject({ disposableTestDatabase: false });
    await expect(readDeploymentMarker(fakeQuery({ present: false }))).resolves.toMatchObject({ disposableTestDatabase: false });
  });

  it('outside production: a database bound to production is ALWAYS refused (clone of production), declared or not', () => {
    refused(() => decideDeploymentIdentity({ ...LOC, processLabel: 'api', production: false, declared: null, marker: bound('production', PROD_ID) }), /bound to production .*rebind it with db:bind-identity/);
    const staging = { environment: 'staging' as const, deploymentId: PROD_ID };
    refused(() => decideDeploymentIdentity({ ...LOC, processLabel: 'api', production: false, declared: staging, marker: bound('production', PROD_ID) }), /bound to production\//);
  });

  it('outside production: a non-production bound database and no declaration passes with a warning', () => {
    const d = decideDeploymentIdentity({ ...LOC, processLabel: 'api', production: false, declared: null, marker: bound('development', OTHER_ID) });
    expect(d.summary).toBe(`development/${OTHER_ID}`);
    expect(d.warnings[0]).toMatch(/declares no identity/);
  });

  it('a marker holding an unrecognised value is refused (corrupt or tampered)', () => {
    refused(() => decideDeploymentIdentity({ ...LOC, processLabel: 'api', production: false, declared: null, marker: bound('prod', OTHER_ID) }), /unrecognised value/);
    refused(() => decideDeploymentIdentity({ ...LOC, processLabel: 'api', production: false, declared: null, marker: bound('test', 'x') }), /unrecognised value/);
  });
});

describe('deployment identity: reading the marker (fake connection)', () => {
  it('absent when the check function does not exist; unbound when it returns no row; bound otherwise', async () => {
    expect((await readDeploymentMarker(fakeQuery({ present: false }))).marker).toEqual({ state: 'absent' });
    expect((await readDeploymentMarker(fakeQuery({ present: true, rows: [] }))).marker).toEqual({ state: 'unbound' });
    expect((await readDeploymentMarker(fakeQuery({ present: true, rows: [{ environment: 'test', deployment_id: OTHER_ID, bound_database: 'crewflow', bound_hosts: [HOST], bound_system_identifier: null, current_system_identifier: null }] }))).marker).toEqual(bound('test', OTHER_ID));
  });

  it('a present but unreadable marker (42501) is a refusal, never "absent"', async () => {
    await expect(readDeploymentMarker(fakeQuery({ present: true, readError: { code: '42501' } }))).rejects.toThrow(/could not be read \(SQLSTATE 42501\)/);
  });

  it('assertDeploymentIdentity: the runtime never honours the bootstrap flag; production + correct marker passes', async () => {
    await expect(
      assertDeploymentIdentity(fakeQuery({ present: false }), {
        processLabel: 'api process',
        production: true,
        connectionHost: HOST,
        env: { ...PROD_ENV, CREWFLOW_DEPLOYMENT_IDENTITY_BOOTSTRAP: 'unbound-production-database', PG_EXPECTED_DATABASE_NAME: 'crewflow' },
      }),
    ).rejects.toThrow(/honoured only by production database commands/);
    const ok = await assertDeploymentIdentity(fakeQuery({ present: true, rows: [{ environment: 'production', deployment_id: PROD_ID, bound_database: 'defaultdb', bound_hosts: [HOST] }], database: 'defaultdb' }), {
      processLabel: 'api process',
      production: true,
      connectionHost: HOST,
      env: { ...PROD_ENV, PG_EXPECTED_DATABASE_NAME: 'defaultdb' },
    });
    expect(ok.summary).toBe(`production/${PROD_ID}`);
    expect(ok.database).toBe('defaultdb');
    await expect(
      assertDeploymentIdentity(fakeQuery({ present: true, rows: [{ environment: 'production', deployment_id: PROD_ID, bound_database: 'other', bound_hosts: [HOST] }], database: 'other' }), {
        processLabel: 'api process',
        production: true,
        connectionHost: HOST,
        env: { ...PROD_ENV, PG_EXPECTED_DATABASE_NAME: 'defaultdb' },
      }),
    ).rejects.toThrow(/expects database "defaultdb"/);
  });
});

describe('deployment identity: bound location (owner decision A — a restore, clone or fork is never the original)', () => {
  const prod = { environment: 'production' as const, deploymentId: PROD_ID };
  const decide = (marker: DeploymentMarker, at: Partial<typeof LOC> = {}, extra: Partial<Parameters<typeof decideDeploymentIdentity>[0]> = {}) =>
    decideDeploymentIdentity({ ...LOC, ...at, processLabel: 'api process', production: true, declared: prod, marker, ...extra });

  it('same database and same host (in-place restart, in-place PITR): accepted', () => {
    expect(decide(bound('production', PROD_ID)).summary).toBe(`production/${PROD_ID}`);
    // The factory already lower-cases hosts; the comparison is canonical either way.
    expect(decide(bound('production', PROD_ID, { hosts: ['DB.Example.Internal'] })).summary).toBe(`production/${PROD_ID}`);
    // A DNS / IP change behind the same name, or a managed failover that keeps the name: the NAME is compared, so it passes.
    expect(decide(bound('production', PROD_ID), { connectionHost: 'DB.EXAMPLE.INTERNAL' }).warnings).toEqual([]);
  });

  it('a host SET: direct host for Worker/migrations and a session-compatible proxy host for the API both pass; others are refused', () => {
    const both = bound('production', PROD_ID, { hosts: ['db.example.internal', 'proxy.example.internal'] });
    expect(decide(both, { connectionHost: 'db.example.internal' }).summary).toBe(`production/${PROD_ID}`);
    expect(decide(both, { connectionHost: 'proxy.example.internal' }).summary).toBe(`production/${PROD_ID}`);
    refused(
      () => decide(both, { connectionHost: 'replica-promoted.example.internal' }),
      /connects to host "replica-promoted\.example\.internal" but the marker was bound at hosts "db\.example\.internal", "proxy\.example\.internal".*db:bind-identity/,
    );
    // Exact membership only: no suffix, prefix or wildcard match.
    refused(() => decide(both, { connectionHost: 'example.internal' }), /bound at hosts/);
    refused(() => decide(both, { connectionHost: 'x.db.example.internal' }), /bound at hosts/);
  });

  it('a provider-issued NEW host name (failover / fork / branch onto another endpoint name) is refused until the audited rebind', () => {
    refused(() => decide(bound('production', PROD_ID), { connectionHost: 'db-failover-2.example.internal' }), /bound at host "db\.example\.internal".*db:bind-identity/);
  });

  it('another database name: refused with the rebind instruction, even though environment and id match', () => {
    refused(() => decide(bound('production', PROD_ID), { currentDatabase: 'crewflow_restore' }), /reports database "crewflow_restore" but the marker was bound in database "crewflow".*db:bind-identity/);
  });

  it('another host (restore / clone elsewhere, Neon branch, DigitalOcean fork): refused with the rebind instruction', () => {
    refused(() => decide(bound('production', PROD_ID), { connectionHost: 'clone.example.internal' }), /connects to host "clone.example.internal" but the marker was bound at host "db.example.internal".*db:bind-identity/);
    // Outside production too: a staging app pointed at a copy of the staging database elsewhere.
    refused(
      () => decideDeploymentIdentity({ ...LOC, connectionHost: 'copy.example.internal', processLabel: 'api', production: false, declared: { environment: 'staging', deploymentId: OTHER_ID }, marker: bound('staging', OTHER_ID) }),
      /bound at host/,
    );
    // And when the process declares nothing (non-production, non-production marker): still refused.
    refused(() => decideDeploymentIdentity({ ...LOC, connectionHost: 'copy.example.internal', processLabel: 'api', production: false, declared: null, marker: bound('test', OTHER_ID) }), /bound at host/);
  });

  it('a fork that inherits the system_identifier but differs by host is refused; the identifier itself only ever warns', () => {
    refused(() => decide(bound('production', PROD_ID, { sid: '7300000000000000001', now: '7300000000000000001' }), { connectionHost: 'fork.example.internal' }), /bound at host/);
    const moved = decide(bound('production', PROD_ID, { sid: '7300000000000000001', now: '7311111111111111111' }));
    expect(moved.summary).toBe(`production/${PROD_ID}`);
    expect(moved.warnings.join(' ')).toMatch(/system_identifier \(7311111111111111111\) differs .*never proof/);
    // Unknown on either side (provider withholds pg_control_system): no warning, no refusal.
    expect(decide(bound('production', PROD_ID, { sid: null, now: '7311111111111111111' })).warnings).toEqual([]);
  });

  it('a bound marker without a recorded location is refused as unrecognised (fail closed)', () => {
    refused(() => decide({ state: 'bound', environment: 'production', deploymentId: PROD_ID }), /no bound database or host/);
    refused(() => decide({ ...(bound('production', PROD_ID) as Extract<DeploymentMarker, { state: 'bound' }>), boundHosts: null }), /no bound database or host/);
    refused(() => decide({ ...(bound('production', PROD_ID) as Extract<DeploymentMarker, { state: 'bound' }>), boundHosts: [] }), /no bound database or host/);
    refused(() => decide({ ...(bound('production', PROD_ID) as Extract<DeploymentMarker, { state: 'bound' }>), boundHosts: [''] }), /no bound database or host/);
  });

  it('an empty connection host or database is never a match', () => {
    refused(() => decide(bound('production', PROD_ID), { connectionHost: '' }), /bound at host/);
    refused(() => decide(bound('production', PROD_ID), { currentDatabase: '' }), /bound in database/);
  });

  it("'warn' (the rebind command only) turns the mismatch into a warning; identity rules still apply", () => {
    const d = decide(bound('production', PROD_ID), { connectionHost: 'clone.example.internal' }, { locationMismatch: 'warn' });
    expect(d.warnings.join(' ')).toMatch(/^LOCATION MISMATCH: .*clone\.example\.internal/);
    refused(() => decide(bound('production', OTHER_ID), { connectionHost: 'clone.example.internal' }, { locationMismatch: 'warn' }), /bound to production\/0b9a8c7d/);
  });

  it('assertDeploymentIdentity reads the location from the marker row and compares it with the connection it was given', async () => {
    const row = { environment: 'production', deployment_id: PROD_ID, bound_database: 'defaultdb', bound_hosts: [HOST], bound_system_identifier: '1', current_system_identifier: '1' };
    const env = { ...PROD_ENV };
    await expect(assertDeploymentIdentity(fakeQuery({ present: true, rows: [row], database: 'defaultdb' }), { processLabel: 'api process', production: true, env, connectionHost: HOST })).resolves.toMatchObject({ warnings: [] });
    await expect(
      assertDeploymentIdentity(fakeQuery({ present: true, rows: [row], database: 'defaultdb' }), { processLabel: 'api process', production: true, env, connectionHost: 'restore.example.internal' }),
    ).rejects.toThrow(/bound at host "db.example.internal"/);
    await expect(
      assertDeploymentIdentity(fakeQuery({ present: true, rows: [row], database: 'defaultdb_copy' }), { processLabel: 'api process', production: true, env, connectionHost: HOST }),
    ).rejects.toThrow(/bound in database "defaultdb"/);
  });

  it('the marker read selects every location column from the check function', () => {
    expect(MARKER_READ_SQL).toMatch(/bound_database, bound_hosts, bound_system_identifier::text AS bound_system_identifier, current_system_identifier::text AS current_system_identifier FROM core\.deployment_identity_check\(\)/);
  });

  it('bound_hosts is read as the driver array, or as a plain array literal; anything else is an unrecognised marker', async () => {
    const row = (bound_hosts: unknown) => ({ environment: 'test', deployment_id: OTHER_ID, bound_database: 'crewflow', bound_hosts });
    const read = async (v: unknown) => (await readDeploymentMarker(fakeQuery({ present: true, rows: [row(v)] }))).marker as Extract<DeploymentMarker, { state: 'bound' }>;
    expect((await read(['a.example', 'b.example'])).boundHosts).toEqual(['a.example', 'b.example']);
    expect((await read('{a.example,b.example}')).boundHosts).toEqual(['a.example', 'b.example']);
    expect((await read(null)).boundHosts).toBeNull();
    expect((await read('a.example')).boundHosts).toBeNull();
    refused(() => decideDeploymentIdentity({ ...LOC, processLabel: 'api', production: false, declared: null, marker: { ...(bound('test', OTHER_ID) as Extract<DeploymentMarker, { state: 'bound' }>), boundHosts: null } }), /no bound database or host/);
  });
});
