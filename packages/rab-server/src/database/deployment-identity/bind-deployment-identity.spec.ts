import { DbTargetError, resolveDbTarget } from '../typeorm/core/database-target';
import { assertBindLogin, BIND_COMMAND, BIND_USAGE, BindArgs, BindIdentityError, parseBindArgs, parseConfirmHosts, planBind } from './bind-deployment-identity';

const NEW_ID = '11111111-2222-4333-8444-555555555555';
const CUR_ID = '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const BASE = [
  '--environment', 'staging',
  '--deployment-id', NEW_ID,
  '--reason', 'restored copy for staging, OPS-123',
  '--actor', 'ops: Jane Doe',
  '--confirm-database', 'defaultdb',
  '--confirm-host', 'db-copy.example.internal',
];

function refused(fn: () => unknown, pattern: RegExp): void {
  let error: unknown;
  try {
    fn();
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(BindIdentityError);
  expect((error as Error).message).toMatch(pattern);
}

const args = (extra: string[] = []): BindArgs => parseBindArgs([...BASE, ...extra]);
const NON_PROD = { target: 'test' as const, declared: null, bootstrapRequested: false };
const PROD = { target: 'production' as const, declared: { environment: 'production' as const, deploymentId: CUR_ID }, bootstrapRequested: false };

describe('db:bind-identity arguments', () => {
  it('parses every flag, in both --flag value and --flag=value forms, and lower-cases ids and hosts', () => {
    const parsed = parseBindArgs([...BASE.slice(0, 2), `--deployment-id=${NEW_ID.toUpperCase()}`, ...BASE.slice(4), '--confirm-current-deployment-id', CUR_ID]);
    expect(parsed).toEqual({
      environment: 'staging',
      deploymentId: NEW_ID,
      reason: 'restored copy for staging, OPS-123',
      actor: 'ops: Jane Doe',
      confirmDatabase: 'defaultdb',
      confirmHosts: ['db-copy.example.internal'],
      confirmCurrentDeploymentId: CUR_ID,
    });
  });

  it('--confirm-host repeats: 1 to 5 distinct canonical names, stored sorted (direct host + session-compatible proxy host)', () => {
    expect(args(['--confirm-host', 'Proxy.Example.Internal']).confirmHosts).toEqual(['db-copy.example.internal', 'proxy.example.internal']);
    expect(args(['--confirm-host=[::1]']).confirmHosts).toEqual(['::1', 'db-copy.example.internal']);
    expect(parseConfirmHosts(['e', 'd', 'c', 'b', 'a'])).toEqual(['a', 'b', 'c', 'd', 'e']);
    refused(() => parseConfirmHosts(['a', 'b', 'c', 'd', 'e', 'f']), /at most 5 host names/);
    refused(() => args(['--confirm-host', 'DB-COPY.example.internal']), /names the same host twice/);
    refused(() => args(['--confirm-host', 'db_copy']), /is not a host name or address/);
    refused(() => args(['--confirm-host', 'a,b']), /is not a host name or address/);
    refused(() => parseConfirmHosts([]), /--confirm-host is required/);
  });

  it('--confirm-host refuses documented transaction-pooler host names (they cannot hold session state)', () => {
    refused(() => args(['--confirm-host', 'ep-round-rain-aess0njf-pooler.c-2.eu-central-1.aws.neon.tech']), /transaction-pooler shape \(Neon pooled host/);
    refused(() => args(['--confirm-host', 'app.proxy-abc123.eu-west-1.rds.amazonaws.com']), /transaction-pooler shape \(AWS RDS Proxy/);
    // The direct Neon host of the same endpoint is fine.
    expect(args(['--confirm-host', 'ep-round-rain-aess0njf.c-2.eu-central-1.aws.neon.tech']).confirmHosts).toHaveLength(2);
  });

  it('refuses unknown, repeated, valueless and missing arguments, and bad values', () => {
    refused(() => parseBindArgs([...BASE, '--force']), /unknown argument "--force"/);
    refused(() => parseBindArgs([...BASE, '--actor', 'x']), /--actor is given twice/);
    refused(() => parseBindArgs([...BASE, '--confirm-host']), /--confirm-host needs a value/);
    refused(() => parseBindArgs([...BASE, '--confirm-current-deployment-id']), /needs a value/);
    refused(() => parseBindArgs(BASE.slice(2)), /--environment is required/);
    refused(() => parseBindArgs(BASE.slice(0, 10)), /--confirm-host is required/);
    refused(() => parseBindArgs(['--environment', 'prod', ...BASE.slice(2)]), /--environment must be one of/);
    refused(() => parseBindArgs([...BASE.slice(0, 2), '--deployment-id', 'nope', ...BASE.slice(4)]), /--deployment-id must be a uuid/);
    refused(() => parseBindArgs([...BASE.slice(0, 4), '--reason', 'short', ...BASE.slice(6)]), /--reason must be 10 to 500/);
    refused(() => args(['--confirm-current-deployment-id', 'x']), /must be a uuid/);
  });

  it('usage text documents every flag and the bootstrap variables', () => {
    for (const flag of ['--environment', '--deployment-id', '--reason', '--actor', '--confirm-database', '--confirm-host', '--confirm-current-deployment-id']) {
      expect(BIND_USAGE).toContain(flag);
    }
    expect(BIND_USAGE).toContain('CREWFLOW_DEPLOYMENT_IDENTITY_BOOTSTRAP=unbound-production-database');
    expect(BIND_USAGE).toMatch(/REPEAT once per host name/);
    expect(BIND_USAGE).toMatch(/self-asserted text, not an authenticated identity/);
  });
});

describe('db:bind-identity login', () => {
  const migrator = { currentUser: 'crewflow_migrator', sessionUser: 'crewflow_migrator', isSuperuser: false, canActAsOwnerRoles: true };

  it('accepts the migration identity (a member of rab_secure_owner + crewflow) and a superuser', () => {
    expect(() => assertBindLogin(migrator)).not.toThrow();
    expect(() => assertBindLogin({ currentUser: 'postgres', sessionUser: 'postgres', isSuperuser: true, canActAsOwnerRoles: true })).not.toThrow();
  });

  it('refuses crewflow_app, crewflow, a SET ROLE session and a login that cannot act as the owner roles', () => {
    refused(() => assertBindLogin({ ...migrator, currentUser: 'crewflow_app', sessionUser: 'crewflow_app' }), /refuses the runtime login "crewflow_app"/);
    refused(() => assertBindLogin({ ...migrator, currentUser: 'crewflow', sessionUser: 'crewflow' }), /refuses the runtime login "crewflow"/);
    refused(() => assertBindLogin({ ...migrator, currentUser: 'rab_secure_owner' }), /SET ROLE/);
    refused(() => assertBindLogin({ ...migrator, canActAsOwnerRoles: false }), /cannot act as rab_secure_owner/);
  });
});

describe('db:bind-identity plan (pure, before any write)', () => {
  const where = { database: 'defaultdb', host: 'db-copy.example.internal' };

  it('typed confirmations must match the live database, and the host set must contain the host this command connects to', () => {
    refused(() => planBind({ args: args(), target: NON_PROD, marker: { state: 'unbound' }, database: 'other', host: where.host }), /--confirm-database "defaultdb" does not match/);
    refused(
      () => planBind({ args: args(), target: NON_PROD, marker: { state: 'unbound' }, database: where.database, host: 'prod.example' }),
      /--confirm-host "db-copy\.example\.internal" does not include the host this command connects to \("prod\.example"\)/,
    );
    // A second (proxy) host is accepted as long as the live host is in the set.
    const twoHosts = args(['--confirm-host', 'proxy.example.internal']);
    expect(planBind({ args: twoHosts, target: NON_PROD, marker: { state: 'unbound' }, ...where })).toBe(
      `bind (unbound) -> staging/${NEW_ID} at db-copy.example.internal,proxy.example.internal/defaultdb`,
    );
    refused(() => planBind({ args: twoHosts, target: NON_PROD, marker: { state: 'unbound' }, database: where.database, host: 'other.example' }), /does not include the host/);
  });

  it('an absent marker means the migration is not applied: refused', () => {
    refused(() => planBind({ args: args(), target: NON_PROD, marker: { state: 'absent' }, ...where }), /apply migration DeploymentIdentity1786721230000 first/);
  });

  it('a production bind refuses loopback and single-label hosts (final review F7)', () => {
    const bootstrap = { target: 'production' as const, declared: { environment: 'production' as const, deploymentId: NEW_ID }, bootstrapRequested: true };
    for (const local of ['127.0.0.1', 'localhost', '::1', 'postgres']) {
      const prodArgs = parseBindArgs(['--environment', 'production', '--deployment-id', NEW_ID, ...BASE.slice(4, 10), '--confirm-host', local]);
      refused(() => planBind({ args: prodArgs, target: bootstrap, marker: { state: 'unbound' }, database: 'defaultdb', host: local }), /loopback or single-label host/);
    }
    // A non-production bind keeps working on a local database.
    const devArgs = parseBindArgs(['--environment', 'development', '--deployment-id', NEW_ID, ...BASE.slice(4, 10), '--confirm-host', '127.0.0.1']);
    expect(planBind({ args: devArgs, target: NON_PROD, marker: { state: 'unbound' }, database: 'defaultdb', host: '127.0.0.1' })).toBe(
      `bind (unbound) -> development/${NEW_ID} at 127.0.0.1/defaultdb`,
    );
  });

  it('first bind: no current id may be confirmed; a non-production target may not bind production', () => {
    expect(planBind({ args: args(), target: NON_PROD, marker: { state: 'unbound' }, ...where })).toBe(`bind (unbound) -> staging/${NEW_ID} at db-copy.example.internal/defaultdb`);
    refused(() => planBind({ args: args(['--confirm-current-deployment-id', CUR_ID]), target: NON_PROD, marker: { state: 'unbound' }, ...where }), /must not be given/);
    const prodArgs = parseBindArgs(['--environment', 'production', ...BASE.slice(2)]);
    refused(() => planBind({ args: prodArgs, target: NON_PROD, marker: { state: 'unbound' }, ...where }), /requires DB_TARGET=production/);
  });

  it('first PRODUCTION bind needs the bootstrap flag and binds exactly the declared identity', () => {
    const prodArgs = parseBindArgs(['--environment', 'production', '--deployment-id', NEW_ID, ...BASE.slice(4)]);
    refused(() => planBind({ args: prodArgs, target: { ...PROD, declared: { environment: 'production', deploymentId: NEW_ID } }, marker: { state: 'unbound' }, ...where }), /needs the bootstrap flag/);
    refused(() => planBind({ args: prodArgs, target: { ...PROD, bootstrapRequested: true }, marker: { state: 'unbound' }, ...where }), /must bind exactly CREWFLOW_DEPLOYMENT_ENVIRONMENT/);
    expect(
      planBind({ args: prodArgs, target: { target: 'production', declared: { environment: 'production', deploymentId: NEW_ID }, bootstrapRequested: true }, marker: { state: 'unbound' }, ...where }),
    ).toBe(`bind (unbound) -> production/${NEW_ID} at db-copy.example.internal/defaultdb`);
  });

  it('rebind: the current id must be confirmed exactly and the new id must differ', () => {
    const marker = { state: 'bound' as const, environment: 'production', deploymentId: CUR_ID.toUpperCase() };
    refused(() => planBind({ args: args(), target: PROD, marker, ...where }), /--confirm-current-deployment-id is required/);
    refused(() => planBind({ args: args(['--confirm-current-deployment-id', NEW_ID]), target: PROD, marker, ...where }), /does not match the bound id/);
    const same = parseBindArgs([...BASE.slice(0, 2), '--deployment-id', CUR_ID, ...BASE.slice(4), '--confirm-current-deployment-id', CUR_ID]);
    refused(() => planBind({ args: same, target: PROD, marker, ...where }), /needs a NEW deployment id/);
    expect(planBind({ args: args(['--confirm-current-deployment-id', CUR_ID]), target: PROD, marker, ...where })).toBe(
      `rebind production/${CUR_ID} -> staging/${NEW_ID} at db-copy.example.internal/defaultdb`,
    );
  });
});

describe('db:bind-identity connection variables (Phase B: the factory, through the target guard)', () => {
  const MIG = 'postgres://crewflow_migrator:pw@127.0.0.1:5432/rab';
  const OTHER = 'postgres://crewflow_app:pw@127.0.0.1:5432/rab';
  const target = (env: Record<string, string | undefined>) => resolveDbTarget({ purpose: BIND_COMMAND, env: { DB_TARGET: 'local', ...env }, dotenvValues: {} });

  it('PG_DATABASE_URL is the migration endpoint; outside production the deprecated DATABASE_URL_UNPOOLED still is', () => {
    expect(target({ PG_DATABASE_URL: MIG }).migrationEndpoint).toBe('primary');
    expect(target({ PG_DATABASE_URL: MIG }).pg.processRole).toBe('migrate');
    expect(target({ DATABASE_URL: OTHER, DATABASE_URL_UNPOOLED: MIG }).migrationEndpoint).toBe('elevated');
  });

  it('two variables naming different targets are refused (no silent preference)', () => {
    expect(() => target({ PG_DATABASE_URL: MIG, DATABASE_URL_UNPOOLED: OTHER })).toThrow(DbTargetError);
    expect(() => target({ PG_DATABASE_URL: MIG, DATABASE_URL_UNPOOLED: OTHER })).toThrow(/different targets/);
    expect(() => target({ PG_DATABASE_URL: MIG, DATABASE_URL: OTHER })).toThrow(/different targets/);
  });
});
