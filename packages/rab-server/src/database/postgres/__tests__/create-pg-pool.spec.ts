import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { resolvePgEnvironment } from '../pg-config';
import {
  createPgPool,
  pgClientConfig,
  pgConnectionString,
  pgPoolConfig,
  pgTypeOrmConnectionOptions,
} from '../create-pg-pool';
import { PgConfigError } from '../pg-url-policy';

// Phase B (B2): what pg ACTUALLY uses. Every assertion goes through pg's own ConnectionParameters (the object a pg Client
// builds from its config), so a URL parameter that would override the factory's choice shows up here.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ConnectionParameters = require('pg/lib/connection-parameters') as new (config: unknown) => Record<string, unknown> & { password: string };
const SECRET = 'Pw-s3cret-9f';
const LOCAL = `postgres://crewflow_app:${SECRET}@localhost:5432/rab`;
const DO = `postgresql://crewflow_app:${SECRET}@db-postgresql-lon1-1.db.ondigitalocean.com:25060/defaultdb?sslmode=require`;
const PEM = '-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----\n';

/** TypeORM 0.3.31 PostgresDriver.createPool: its own fields, then `extra` spread over them (no `url` from the factory). */
function typeOrmDriverConfig(o: ReturnType<typeof pgTypeOrmConnectionOptions>) {
  return {
    connectionString: undefined,
    host: o.host,
    user: o.username,
    password: o.password,
    database: o.database,
    port: o.port,
    ssl: o.ssl,
    ...(o.extra as object),
  };
}

describe('pg version pin', () => {
  it('pg is 8.x: the TLS mapping below relies on pg 8 semantics (pg 9 announces weaker sslmode aliases)', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    expect((require('pg/package.json') as { version: string }).version).toMatch(/^8\./);
  });

  it('why the factory never hands pg a URL: URL ssl parameters replace an explicit ssl object wholesale', () => {
    const p = new ConnectionParameters({ connectionString: 'postgres://u:p@db.example.com/d?sslmode=disable', ssl: { rejectUnauthorized: true } });
    expect(p.ssl).toBe(false);
    const q = new ConnectionParameters({ connectionString: 'postgres://u:p@db.example.com/d?host=evil.example.com', host: 'db.example.com' });
    expect(q.host).toBe('evil.example.com');
  });
});

describe('create-pg-pool: explicit target, TLS and session settings as pg sees them', () => {
  const savedPgSslMode = process.env.PGSSLMODE;
  afterEach(() => {
    if (savedPgSslMode === undefined) delete process.env.PGSSLMODE;
    else process.env.PGSSLMODE = savedPgSslMode;
  });

  it('local Docker (no sslmode): plaintext by explicit choice — PGSSLMODE in the environment cannot change it', () => {
    process.env.PGSSLMODE = 'no-verify';
    const config = pgClientConfig(resolvePgEnvironment({ PG_DATABASE_URL: LOCAL }, { processRole: 'api' }), { purpose: 'runtime' });
    expect(config).not.toHaveProperty('connectionString');
    const p = new ConnectionParameters(config);
    expect({ host: p.host, port: p.port, user: p.user, database: p.database, ssl: p.ssl }).toEqual({
      host: 'localhost',
      port: 5432,
      user: 'crewflow_app',
      database: 'rab',
      ssl: false,
    });
    expect(p.password).toBe(SECRET);
    expect(p.application_name).toBe('crewflow-api');
    expect(p.options).toBe('-c statement_timeout=30000 -c idle_in_transaction_session_timeout=60000');
    expect(p.query_timeout).toBe(30_000);
    expect(p.connect_timeout).toBe(10);
    expect(p.keepalives).toBe(1);
  });

  it('production DigitalOcean (sslmode=require): verify-full against the system CA store', () => {
    const r = resolvePgEnvironment({ NODE_ENV: 'production', PG_DATABASE_URL: DO }, { processRole: 'api' });
    const p = new ConnectionParameters(pgClientConfig(r, { purpose: 'runtime' }));
    expect(p.ssl).toEqual({ rejectUnauthorized: true });
    expect((p.ssl as Record<string, unknown>).checkServerIdentity).toBeUndefined();
    expect(p.host).toBe('db-postgresql-lon1-1.db.ondigitalocean.com');
    expect(p.port).toBe(25060);
    expect(p.database).toBe('defaultdb');
  });

  it('production with PG_SSL_CA_CERT_PATH: verify-full against that CA', () => {
    const r = resolvePgEnvironment({ NODE_ENV: 'production', PG_DATABASE_URL: DO, PG_SSL_CA_CERT_PATH: '/ca.pem' }, { processRole: 'api', readFile: () => PEM });
    expect(new ConnectionParameters(pgClientConfig(r, { purpose: 'runtime' })).ssl).toEqual({ rejectUnauthorized: true, ca: PEM });
  });

  it('outside production, PG_SSL_ALLOW_SELF_SIGNED=true relaxes verification only when TLS is in use', () => {
    const r = resolvePgEnvironment({ PG_DATABASE_URL: DO, PG_SSL_ALLOW_SELF_SIGNED: 'true' }, { processRole: 'api' });
    expect(new ConnectionParameters(pgClientConfig(r, { purpose: 'runtime' })).ssl).toEqual({ rejectUnauthorized: false });
    const local = resolvePgEnvironment({ PG_DATABASE_URL: LOCAL, PG_SSL_ALLOW_SELF_SIGNED: 'true' }, { processRole: 'api' });
    expect(new ConnectionParameters(pgClientConfig(local, { purpose: 'runtime' })).ssl).toBe(false);
  });

  it('Neon: the endpoint token leads the startup options; channel_binding=require enables SCRAM-SHA-256-PLUS when offered', () => {
    const url = `postgresql://u:${SECRET}@ep-cool-darkness-123456.eu-west-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require&options=endpoint%3Dep-cool-darkness-123456`;
    const config = pgClientConfig(resolvePgEnvironment({ PG_DATABASE_URL: url }, { processRole: 'api' }), { purpose: 'runtime' });
    expect(config.enableChannelBinding).toBe(true);
    expect(new ConnectionParameters(config).options).toBe(
      'endpoint=ep-cool-darkness-123456 -c statement_timeout=30000 -c idle_in_transaction_session_timeout=60000',
    );
  });

  it('application_name: per process and purpose, the URL\'s own wins; replica role is read-only', () => {
    const worker = resolvePgEnvironment({ PG_DATABASE_URL: LOCAL }, { processRole: 'worker' });
    expect(pgClientConfig(worker, { endpoint: 'lock', purpose: 'lock' }).application_name).toBe('crewflow-worker-lock');
    expect(pgClientConfig(worker, { purpose: 'runtime' }).application_name).toBe('crewflow-worker');
    const replica = pgClientConfig(worker, { url: LOCAL, urlLabel: 'PG_DATABASE_REPLICA_URL', role: 'replica', purpose: 'runtime' });
    expect(replica.application_name).toBe('crewflow-worker-replica');
    expect(replica.options).toMatch(/-c default_transaction_read_only=on$/);
    const named = resolvePgEnvironment({ PG_DATABASE_URL: `${LOCAL}?application_name=ops-shell` }, { processRole: 'cli' });
    expect(pgClientConfig(named, { purpose: 'runtime' }).application_name).toBe('ops-shell');
  });

  it('per-call timeouts: lock connections keep 5 s; 0 disables (only where the old code had none)', () => {
    const r = resolvePgEnvironment({ PG_DATABASE_URL: LOCAL }, { processRole: 'cli' });
    const lock = new ConnectionParameters(pgClientConfig(r, { endpoint: 'lock', purpose: 'storage-lock', statementTimeoutMs: 5_000, queryTimeoutMs: 5_000 }));
    expect(lock.options).toBe('-c statement_timeout=5000 -c idle_in_transaction_session_timeout=60000');
    expect(lock.query_timeout).toBe(5_000);
    const none = pgClientConfig(r, { purpose: 'backfill', statementTimeoutMs: 0, queryTimeoutMs: 0 });
    expect(none.options).toBe('-c statement_timeout=0 -c idle_in_transaction_session_timeout=60000');
    expect(none).not.toHaveProperty('query_timeout');
  });

  it('a session-lock connection on a transaction-pooler shape is refused (CLI storage lock), a runtime one is not', () => {
    const r = resolvePgEnvironment({ PG_DATABASE_URL: `postgres://u:${SECRET}@ep-a-1-pooler.eu-west-2.aws.neon.tech/neondb` }, { processRole: 'cli' });
    expect(() => pgClientConfig(r, { endpoint: 'lock', purpose: 'storage-lock' })).toThrow(PgConfigError);
    expect(() => pgClientConfig(r, { endpoint: 'lock', purpose: 'storage-lock' })).toThrow(/session advisory lock needs a direct/);
    expect(() => pgClientConfig(r, { purpose: 'runtime' })).not.toThrow();
  });

  it('the elevated endpoint is refused when it is not configured (always in production)', () => {
    const r = resolvePgEnvironment({ PG_DATABASE_URL: LOCAL }, { processRole: 'cli' });
    expect(() => pgClientConfig(r, { endpoint: 'elevated', purpose: 'backfill' })).toThrow(/set DATABASE_URL_UNPOOLED/);
    const p = resolvePgEnvironment({ NODE_ENV: 'production', PG_DATABASE_URL: DO }, { processRole: 'cli' });
    expect(() => pgClientConfig(p, { endpoint: 'elevated', purpose: 'backfill' })).toThrow(/production does not configure/);
  });

  it('pools always carry an explicit max (PG_POOL_MAX_CONNECTIONS or the caller\'s), idle timeout and exit-on-idle', () => {
    const r = resolvePgEnvironment({ PG_DATABASE_URL: LOCAL, PG_POOL_MAX_CONNECTIONS: '12' }, { processRole: 'worker' });
    expect(pgPoolConfig(r, { purpose: 'runtime' })).toMatchObject({ max: 12, idleTimeoutMillis: 600_000, allowExitOnIdle: false });
    expect(pgPoolConfig(r, { endpoint: 'lock', purpose: 'lock', max: 6 }).max).toBe(6);
    expect(() => pgPoolConfig(r, { purpose: 'runtime', max: 0 })).toThrow(/between 1 and 100/);
    const pool = createPgPool(r, { purpose: 'runtime', max: 3 });
    expect((pool as unknown as { options: { max: number } }).options.max).toBe(3);
    void pool.end();
  });

  it('TypeORM: no url, target fields plus extra; what pg receives after TypeORM\'s merge is the explicit config', () => {
    const r = resolvePgEnvironment({ NODE_ENV: 'production', PG_DATABASE_URL: DO }, { processRole: 'api' });
    const o = pgTypeOrmConnectionOptions(r, { purpose: 'runtime' });
    expect(o).not.toHaveProperty('url');
    const p = new ConnectionParameters(typeOrmDriverConfig(o));
    expect(p.ssl).toEqual({ rejectUnauthorized: true });
    expect(p.host).toBe('db-postgresql-lon1-1.db.ondigitalocean.com');
    expect(p.options).toBe('-c statement_timeout=30000 -c idle_in_transaction_session_timeout=60000');
    expect(o.extra).toMatchObject({ max: 10, application_name: 'crewflow-api', query_timeout: 30_000 });
  });
});

describe('pgConnectionString: the string form reproduces the explicit config exactly (for string-only call sites)', () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-ca-'));
    fs.writeFileSync(path.join(dir, 'ca.pem'), PEM);
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it.each([
    ['local plaintext', { PG_DATABASE_URL: LOCAL }, false],
    ['production verify-full, system CA', { NODE_ENV: 'production', PG_DATABASE_URL: DO }, {}],
    ['self-signed outside production', { PG_DATABASE_URL: DO, PG_SSL_ALLOW_SELF_SIGNED: 'true' }, { rejectUnauthorized: false }],
  ])('%s', (_name, env, expectedSsl) => {
    const r = resolvePgEnvironment(env as Record<string, string>, { processRole: 'worker' });
    const fromString = new ConnectionParameters(pgConnectionString(r, { endpoint: 'lock', purpose: 'scan-lock' }));
    const fromConfig = new ConnectionParameters(pgClientConfig(r, { endpoint: 'lock', purpose: 'scan-lock' }));
    // `{}` is pg-connection-string's verify-full: Node's defaults, rejectUnauthorized true and host-name verification.
    expect(fromString.ssl).toEqual(expectedSsl);
    for (const key of ['host', 'port', 'user', 'database', 'application_name', 'options'] as const) expect(fromString[key]).toEqual(fromConfig[key]);
    expect(fromString.password).toBe(SECRET);
  });

  it('production with PG_SSL_CA_CERT_PATH: verify-full with that CA file', () => {
    const caPath = path.join(dir, 'ca.pem');
    const r = resolvePgEnvironment({ NODE_ENV: 'production', PG_DATABASE_URL: DO, PG_SSL_CA_CERT_PATH: caPath }, { processRole: 'worker' });
    expect(new ConnectionParameters(pgConnectionString(r, { endpoint: 'lock', purpose: 'scan-lock' })).ssl).toEqual({ ca: PEM });
  });

  it('a password with reserved characters survives the round trip', () => {
    const tricky = 'p@ss:w/rd?#&=%41';
    const r = resolvePgEnvironment({ PG_DATABASE_URL: `postgres://crewflow_app:${encodeURIComponent(tricky)}@localhost:5432/rab` }, { processRole: 'worker' });
    expect(r.primary.target.password).toBe(tricky);
    expect(new ConnectionParameters(pgConnectionString(r, { purpose: 'drift' })).password).toBe(tricky);
  });
});
