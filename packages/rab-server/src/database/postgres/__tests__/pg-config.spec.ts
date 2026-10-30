import {
  emitPgWarnings,
  isPgProductionEnvironment,
  PgConfigError,
  readPrimaryDatabaseUrl,
  readReplicaDatabaseUrl,
  resolvePgEnvironment,
  ResolvePgOptions,
  selectMigrationEndpoint,
} from '../pg-config';
import { pgClientConfig } from '../create-pg-pool';

// Phase B (B1): environment resolution — one primary variable, legacy names, conflicts, production rules, strict numbers,
// pooler policy. Pure: every case passes its own env object.
const SECRET = 'Pw-s3cret-9f';
const OTHER_SECRET = 'Other-s3cret-1a';
const APP = `postgres://crewflow_app:${SECRET}@localhost:5432/rab`;
const PROD = `postgresql://crewflow_app:${SECRET}@db-postgresql-lon1-1.db.ondigitalocean.com:25060/defaultdb?sslmode=verify-full`;
const PEM = '-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----\n';

function refusal(env: Record<string, string | undefined>, options?: ResolvePgOptions): string {
  try {
    resolvePgEnvironment(env, options);
  } catch (error) {
    expect(error).toBeInstanceOf(PgConfigError);
    const message = (error as Error).message;
    // Redaction: no password, no user name, no CA path in any refusal.
    expect(message).not.toContain(SECRET);
    expect(message).not.toContain(OTHER_SECRET);
    expect(message).not.toContain('crewflow_app');
    expect(message).not.toContain('/etc/ssl/do-ca.pem');
    return message;
  }
  throw new Error('expected a refusal');
}

describe('pg-config: primary URL and legacy names (outside production)', () => {
  it('PG_DATABASE_URL alone: the primary, the lock endpoint and no warning', () => {
    const r = resolvePgEnvironment({ PG_DATABASE_URL: APP });
    expect(r.production).toBe(false);
    expect(r.primary.source).toBe('PG_DATABASE_URL');
    expect(r.lock).toBe(r.primary);
    expect(r.elevated).toBeNull();
    expect(r.warnings).toEqual([]);
    expect(r.pool).toEqual({ max: 10, idleTimeoutMillis: 600_000, allowExitOnIdle: false });
    expect(r.queryTimeoutMs).toBe(30_000);
  });

  it('legacy DATABASE_URL alone is accepted with a deprecation warning', () => {
    const r = resolvePgEnvironment({ DATABASE_URL: APP });
    expect(r.primary.source).toBe('DATABASE_URL');
    expect(r.primary.deprecated).toBe(true);
    expect(r.warnings.join('\n')).toMatch(/DATABASE_URL is deprecated; set PG_DATABASE_URL/);
  });

  it('both set naming the same target (password not compared): accepted, the legacy one flagged as redundant', () => {
    const r = resolvePgEnvironment({ PG_DATABASE_URL: APP, DATABASE_URL: `postgres://crewflow_app:${OTHER_SECRET}@LOCALHOST/rab` });
    expect(r.primary.source).toBe('PG_DATABASE_URL');
    expect(r.primary.target.password).toBe(SECRET);
    expect(r.warnings.join('\n')).toMatch(/redundant/);
  });

  it.each([
    ['another database', `postgres://crewflow_app:${SECRET}@localhost:5432/other`],
    ['another user', `postgres://crewflow:${SECRET}@localhost:5432/rab`],
    ['another host', `postgres://crewflow_app:${SECRET}@db.example.com:5432/rab`],
    ['another port', `postgres://crewflow_app:${SECRET}@localhost:5433/rab`],
  ])('both set naming different targets (%s): refused', (_name, legacy) => {
    expect(refusal({ PG_DATABASE_URL: APP, DATABASE_URL: legacy })).toMatch(/PG_DATABASE_URL and the legacy DATABASE_URL .* different targets/);
  });

  it('nothing set: refused, naming both variables', () => {
    expect(refusal({})).toMatch(/PG_DATABASE_URL is required.*deprecated DATABASE_URL/);
    expect(refusal({ PG_DATABASE_URL: '  ', DATABASE_URL: '' })).toMatch(/PG_DATABASE_URL is required/);
  });

  it('DATABASE_DIRECT_URL next to PG_DATABASE_URL must name the same target', () => {
    expect(refusal({ PG_DATABASE_URL: APP, DATABASE_DIRECT_URL: `postgres://crewflow_app:${SECRET}@db.example.com:5432/rab` })).toMatch(
      /DATABASE_DIRECT_URL .* different targets/,
    );
    const r = resolvePgEnvironment({ PG_DATABASE_URL: APP, DATABASE_DIRECT_URL: APP });
    expect(r.lock).toBe(r.primary);
  });

  it('legacy pair DATABASE_URL (pooled) + DATABASE_DIRECT_URL: the direct one becomes the lock endpoint (same database required)', () => {
    const pooled = `postgres://crewflow_app:${SECRET}@ep-a-1-pooler.eu-west-2.aws.neon.tech/neondb?sslmode=require`;
    const direct = `postgres://crewflow_app:${SECRET}@ep-a-1.eu-west-2.aws.neon.tech/neondb?sslmode=require`;
    const r = resolvePgEnvironment({ DATABASE_URL: pooled, DATABASE_DIRECT_URL: direct }, { processRole: 'api' });
    expect(r.lock.source).toBe('DATABASE_DIRECT_URL');
    expect(r.lock.target.transactionPooler).toBeNull();
    expect(refusal({ DATABASE_URL: APP, DATABASE_DIRECT_URL: `postgres://crewflow_app:${SECRET}@localhost/other` })).toMatch(/different databases/);
  });

  it('DATABASE_URL_UNPOOLED is the elevated endpoint (deprecated), never the primary', () => {
    const r = resolvePgEnvironment({ DATABASE_URL: APP, DATABASE_URL_UNPOOLED: `postgres://crewflow:${OTHER_SECRET}@localhost/rab` });
    expect(r.primary.target.user).toBe('crewflow_app');
    expect(r.elevated?.target.user).toBe('crewflow');
    expect(r.warnings.join('\n')).toMatch(/DATABASE_URL_UNPOOLED is deprecated/);
  });

  it('readPrimaryDatabaseUrl: PG_DATABASE_URL first, legacy only outside production', () => {
    expect(readPrimaryDatabaseUrl({ PG_DATABASE_URL: APP, DATABASE_URL: 'x' })?.name).toBe('PG_DATABASE_URL');
    expect(readPrimaryDatabaseUrl({ DATABASE_URL: APP })?.name).toBe('DATABASE_URL');
    expect(readPrimaryDatabaseUrl({ DATABASE_URL: APP, NODE_ENV: 'production' })).toBeNull();
  });
});

describe('pg-config: production', () => {
  const prod = { NODE_ENV: 'production', PG_DATABASE_URL: PROD };

  it('production is declared by NODE_ENV, RAB_RUNTIME_ENV or DB_TARGET (any one)', () => {
    expect(isPgProductionEnvironment({ NODE_ENV: 'production' })).toBe(true);
    expect(isPgProductionEnvironment({ RAB_RUNTIME_ENV: 'production' })).toBe(true);
    expect(isPgProductionEnvironment({ DB_TARGET: 'production', NODE_ENV: 'development' })).toBe(true);
    expect(isPgProductionEnvironment({ NODE_ENV: 'test', DB_TARGET: 'test' })).toBe(false);
  });

  it('a correct production configuration resolves to verify-full TLS', () => {
    const r = resolvePgEnvironment(prod);
    expect(r.production).toBe(true);
    expect(r.primary.ssl).toEqual({ rejectUnauthorized: true });
  });

  it('PG_DATABASE_URL is required', () => {
    expect(refusal({ NODE_ENV: 'production' })).toMatch(/PG_DATABASE_URL is required in production/);
    expect(refusal({ DB_TARGET: 'production', NODE_ENV: 'development' })).toMatch(/PG_DATABASE_URL is required in production/);
  });

  it.each(['DATABASE_URL', 'DATABASE_URL_UNPOOLED', 'DATABASE_DIRECT_URL', 'DB_POOL_MAX'])('refuses the legacy name %s being set at all', (name) => {
    expect(refusal({ ...prod, [name]: name === 'DB_POOL_MAX' ? '10' : PROD })).toMatch(new RegExp(`refuses the legacy database variable\\(s\\) ${name}`));
  });

  it.each(['PGPASSWORD', 'PGSSLMODE', 'PGOPTIONS', 'PGHOST', 'PGSSLNEGOTIATION'])('refuses the libpq fallback variable %s', (name) => {
    expect(refusal({ ...prod, [name]: 'x' })).toMatch(new RegExp(`libpq environment variable\\(s\\) ${name}`));
  });

  it.each(['disable', 'allow', 'prefer', 'no-verify', 'verify-ca'])('refuses sslmode=%s', (mode) => {
    expect(refusal({ ...prod, PG_DATABASE_URL: PROD.replace('verify-full', mode) })).toMatch(new RegExp(`sslmode=${mode}, which production refuses`));
  });

  it('refuses PG_SSL_ALLOW_SELF_SIGNED=true', () => {
    expect(refusal({ ...prod, PG_SSL_ALLOW_SELF_SIGNED: 'true' })).toMatch(/PG_SSL_ALLOW_SELF_SIGNED=true is refused in production/);
  });

  it('uses the CA from PG_SSL_CA_CERT_PATH, read at boot; an unreadable or non-PEM file is refused', () => {
    const r = resolvePgEnvironment({ ...prod, PG_SSL_CA_CERT_PATH: '/etc/ssl/do-ca.pem' }, { readFile: () => PEM });
    expect(r.primary.ssl).toEqual({ rejectUnauthorized: true, ca: PEM });
    const missing = refusal({ ...prod, PG_SSL_CA_CERT_PATH: '/etc/ssl/do-ca.pem' }, { readFile: () => { throw new Error('ENOENT /etc/ssl/do-ca.pem'); } });
    expect(missing).toMatch(/PG_SSL_CA_CERT_PATH is set but the file cannot be read/);
    expect(refusal({ ...prod, PG_SSL_CA_CERT_PATH: '/etc/ssl/do-ca.pem' }, { readFile: () => 'not a pem' })).toMatch(/does not contain a PEM certificate/);
  });
});

describe('pg-config: strict numbers and booleans (the DB_POOL_MAX fallback bug)', () => {
  it.each(['abc', '1e3', '2.5', '-1', ' 7x', '0x10'])('refuses PG_POOL_MAX_CONNECTIONS=%j instead of falling back', (value) => {
    expect(refusal({ PG_DATABASE_URL: APP, PG_POOL_MAX_CONNECTIONS: value })).toMatch(/PG_POOL_MAX_CONNECTIONS must be a whole number/);
  });

  it.each(['0', '101'])('refuses PG_POOL_MAX_CONNECTIONS=%s (out of range)', (value) => {
    expect(refusal({ PG_DATABASE_URL: APP, PG_POOL_MAX_CONNECTIONS: value })).toMatch(/between 1 and 100/);
  });

  it('accepts a valid pool size, idle timeout, exit-on-idle and query timeout', () => {
    const r = resolvePgEnvironment({
      PG_DATABASE_URL: APP,
      PG_POOL_MAX_CONNECTIONS: '25',
      PG_POOL_IDLE_TIMEOUT_MS: '0',
      PG_POOL_ALLOW_EXIT_ON_IDLE: 'true',
      PG_DATABASE_PRIMARY_TIMEOUT_MS: '45000',
    });
    expect(r.pool).toEqual({ max: 25, idleTimeoutMillis: 0, allowExitOnIdle: true });
    expect(r.queryTimeoutMs).toBe(45_000);
  });

  it('legacy DB_POOL_MAX: strictly validated, deprecated, and refused when it disagrees with PG_POOL_MAX_CONNECTIONS', () => {
    expect(resolvePgEnvironment({ DATABASE_URL: APP, DB_POOL_MAX: '12' }).pool.max).toBe(12);
    expect(refusal({ DATABASE_URL: APP, DB_POOL_MAX: 'abc' })).toMatch(/DB_POOL_MAX must be a whole number/);
    expect(refusal({ PG_DATABASE_URL: APP, PG_POOL_MAX_CONNECTIONS: '10', DB_POOL_MAX: '20' })).toMatch(/both set and differ/);
  });

  it('PG_DATABASE_PRIMARY_TIMEOUT_MS below the 30 s statement timeout is refused (the client must not give up first)', () => {
    expect(refusal({ PG_DATABASE_URL: APP, PG_DATABASE_PRIMARY_TIMEOUT_MS: '10000' })).toMatch(/between 30000 and 3600000/);
  });

  it.each(['PG_POOL_ALLOW_EXIT_ON_IDLE', 'PG_SSL_ALLOW_SELF_SIGNED', 'PG_DATABASE_URL_IS_DIRECT'])('%s accepts only true/false', (name) => {
    expect(refusal({ PG_DATABASE_URL: APP, [name]: 'yes' })).toMatch(new RegExp(`${name} must be exactly true or false`));
  });
});

describe('pg-config: pooler policy (P4)', () => {
  const pooled = `postgres://crewflow_app:${SECRET}@ep-a-1-pooler.eu-west-2.aws.neon.tech/neondb?sslmode=require`;

  it.each(['worker', 'provisioner', 'migrate'] as const)('the %s process (session advisory locks) refuses a transaction-pooler shape', (role) => {
    expect(refusal({ PG_DATABASE_URL: pooled }, { processRole: role })).toMatch(new RegExp(`The ${role} process holds session advisory locks`));
  });

  it('the API and the CLI only warn', () => {
    for (const role of ['api', 'cli'] as const) {
      const r = resolvePgEnvironment({ PG_DATABASE_URL: pooled }, { processRole: role });
      expect(r.warnings.join('\n')).toMatch(/transaction-pooler shape/);
    }
  });

  it('enforceProcessPolicy=false (env.validation, before the entrypoint declares its role) only warns', () => {
    expect(resolvePgEnvironment({ PG_DATABASE_URL: pooled }, { processRole: 'worker', enforceProcessPolicy: false }).warnings.length).toBeGreaterThan(0);
  });

  it('PG_DATABASE_URL_IS_DIRECT=true on a pooler shape is a contradiction, refused for every process', () => {
    expect(refusal({ PG_DATABASE_URL: pooled, PG_DATABASE_URL_IS_DIRECT: 'true' }, { processRole: 'api' })).toMatch(/PG_DATABASE_URL_IS_DIRECT=true, but/);
  });

  it('a suspicious port only warns', () => {
    const r = resolvePgEnvironment({ PG_DATABASE_URL: `postgres://crewflow_app:${SECRET}@db.internal.example:6432/rab` }, { processRole: 'worker' });
    expect(r.warnings.join('\n')).toMatch(/session probe decides/);
  });
});

describe('pg-config: warnings', () => {
  it('prints each warning once per process, names only, and stays silent under NODE_ENV=test', () => {
    const r = resolvePgEnvironment({ DATABASE_URL: APP });
    const lines: string[] = [];
    emitPgWarnings(r, { NODE_ENV: 'test' }, (l) => lines.push(l));
    expect(lines).toEqual([]);
    emitPgWarnings(r, { NODE_ENV: 'development' }, (l) => lines.push(l));
    emitPgWarnings(r, { NODE_ENV: 'development' }, (l) => lines.push(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[pg-config\] warning: DATABASE_URL is deprecated/);
    expect(lines.join('\n')).not.toContain(SECRET);
  });
});

describe('pg-config: `options=-c role=…` (the M2 restricted-migrator harness) — migrate process, local/test target only', () => {
  const phaseA = `postgres://rab_ci_migrator:${SECRET}@127.0.0.1:15436/m2_db?options=-c+role%3Drab_owner`;

  it.each(['test', 'local'])('accepted for the migrate process with DB_TARGET=%s, and sent as a startup option', (target) => {
    const r = resolvePgEnvironment({ DATABASE_URL: phaseA, DATABASE_URL_UNPOOLED: phaseA, DB_TARGET: target }, { processRole: 'migrate' });
    expect(r.allowSessionRole).toBe(true);
    expect(r.elevated?.target.sessionRoleOption).toBe('-c role=rab_owner');
    expect(pgClientConfig(r, { endpoint: 'elevated', purpose: 'runtime' }).options).toBe(
      '-c role=rab_owner -c statement_timeout=30000 -c idle_in_transaction_session_timeout=60000',
    );
  });

  it.each([
    ['the api process', { DB_TARGET: 'test' }, 'api'],
    ['the worker process', { DB_TARGET: 'test' }, 'worker'],
    ['the cli process', { DB_TARGET: 'test' }, 'cli'],
    ['migrate without DB_TARGET', {}, 'migrate'],
    ['migrate with DB_TARGET=staging', { DB_TARGET: 'staging' }, 'migrate'],
    ['migrate in production (NODE_ENV)', { DB_TARGET: 'test', NODE_ENV: 'production' }, 'migrate'],
  ] as const)('refused for %s', (_name, extra, role) => {
    const env: Record<string, string> = { ...extra, PG_DATABASE_URL: phaseA };
    expect(refusal(env, { processRole: role })).toMatch(/sets "options"|PG_DATABASE_URL is required|legacy/);
  });

  it.each(['-c role=rab_owner -c search_path=public', '-c search_path=public', '-c role=Bad-Name', '-c statement_timeout=0'])(
    'every other -c setting stays refused even for migrate on a test target (%s)',
    (value) => {
      const url = `postgres://rab_ci_migrator:${SECRET}@127.0.0.1:15436/m2_db?options=${encodeURIComponent(value)}`;
      expect(refusal({ PG_DATABASE_URL: url, DB_TARGET: 'test' }, { processRole: 'migrate' })).toMatch(/sets "options"/);
    },
  );
});

describe('pg-config: selectMigrationEndpoint (shared with the migrate runner)', () => {
  const MIGRATOR = `postgres://crewflow_migrator:${SECRET}@localhost:5432/rab`;
  const OWNER = `postgres://crewflow:${OTHER_SECRET}@localhost:5432/rab`;

  it('PG_DATABASE_URL alone → primary; legacy UNPOOLED without PG_DATABASE_URL → elevated', () => {
    const env1 = { PG_DATABASE_URL: MIGRATOR };
    expect(selectMigrationEndpoint(resolvePgEnvironment(env1, { processRole: 'migrate' }), env1).name).toBe('primary');
    const env2 = { DATABASE_URL: APP, DATABASE_URL_UNPOOLED: OWNER };
    const chosen = selectMigrationEndpoint(resolvePgEnvironment(env2, { processRole: 'migrate' }), env2);
    expect(chosen.name).toBe('elevated');
    expect(chosen.endpoint.target.user).toBe('crewflow');
  });

  it('PG_DATABASE_URL with a DATABASE_URL_UNPOOLED naming another target is refused (no silent preference)', () => {
    const env = { PG_DATABASE_URL: MIGRATOR, DATABASE_URL_UNPOOLED: OWNER };
    const r = resolvePgEnvironment(env, { processRole: 'migrate' });
    expect(() => selectMigrationEndpoint(r, env)).toThrow(/both set and name different targets/);
    const same = { PG_DATABASE_URL: MIGRATOR, DATABASE_URL_UNPOOLED: MIGRATOR };
    expect(selectMigrationEndpoint(resolvePgEnvironment(same, { processRole: 'migrate' }), same).name).toBe('primary');
  });

  it('production refuses a PG_DATABASE_URL equal to the .env value', () => {
    const env = { NODE_ENV: 'production', PG_DATABASE_URL: PROD };
    const r = resolvePgEnvironment(env, { processRole: 'migrate' });
    expect(() => selectMigrationEndpoint(r, env, { PG_DATABASE_URL: PROD })).toThrow(/comes from the .env file/);
    expect(selectMigrationEndpoint(r, env, {}).name).toBe('primary');
  });
});

describe('pg-config: optional read replica (PG_DATABASE_REPLICA_URL)', () => {
  const REPLICA = `postgres://crewflow_app:${SECRET}@localhost:5433/rab`;
  const PROD_REPLICA = `postgresql://crewflow_app:${SECRET}@replica-db-postgresql-lon1-1.db.ondigitalocean.com:25060/defaultdb?sslmode=verify-full`;

  it('unset: readReplicaDatabaseUrl is null, no replica endpoint, defaults for timeout and lag', () => {
    expect(readReplicaDatabaseUrl({ PG_DATABASE_URL: APP })).toBeNull();
    expect(readReplicaDatabaseUrl({ PG_DATABASE_REPLICA_URL: '   ' })).toBeNull();
    const r = resolvePgEnvironment({ PG_DATABASE_URL: APP });
    expect(r.replica).toBeNull();
    expect(r.replicaQueryTimeoutMs).toBe(30_000);
    expect(r.replicaMaxLagMs).toBe(5_000);
  });

  it('set: trimmed, validated by the same URL policy, with its own TLS and label', () => {
    expect(readReplicaDatabaseUrl({ PG_DATABASE_REPLICA_URL: ` ${REPLICA} ` })).toEqual({ name: 'PG_DATABASE_REPLICA_URL', value: REPLICA });
    const r = resolvePgEnvironment({ PG_DATABASE_URL: APP, PG_DATABASE_REPLICA_URL: REPLICA, PG_DATABASE_REPLICA_TIMEOUT_MS: '45000', PG_DATABASE_REPLICA_MAX_LAG_MS: '250' });
    expect(r.replica?.source).toBe('PG_DATABASE_REPLICA_URL');
    expect(r.replica?.target.port).toBe(5433);
    expect(r.replica?.ssl).toBe(false);
    expect(r.replicaQueryTimeoutMs).toBe(45_000);
    expect(r.replicaMaxLagMs).toBe(250);
    expect(refusal({ PG_DATABASE_URL: APP, PG_DATABASE_REPLICA_URL: `${REPLICA}?host=elsewhere` })).toMatch(/PG_DATABASE_REPLICA_URL sets "host"/);
    expect(refusal({ PG_DATABASE_URL: APP, PG_DATABASE_REPLICA_URL: `${REPLICA}?options=-c%20role%3Dcrewflow` })).toMatch(/PG_DATABASE_REPLICA_URL sets "options"/);
  });

  it('a replica URL naming the primary (password not compared) is refused', () => {
    expect(refusal({ PG_DATABASE_URL: APP, PG_DATABASE_REPLICA_URL: APP.replace(SECRET, OTHER_SECRET) })).toMatch(/PG_DATABASE_REPLICA_URL names the primary/);
  });

  it('production: verify-full TLS on the replica too; weaker modes and legacy names stay refused', () => {
    const r = resolvePgEnvironment({ NODE_ENV: 'production', PG_DATABASE_URL: PROD, PG_DATABASE_REPLICA_URL: PROD_REPLICA });
    expect(r.replica?.ssl).toEqual({ rejectUnauthorized: true });
    expect(refusal({ NODE_ENV: 'production', PG_DATABASE_URL: PROD, PG_DATABASE_REPLICA_URL: PROD_REPLICA.replace('verify-full', 'disable') })).toMatch(
      /sslmode=disable, which production refuses/,
    );
    expect(refusal({ NODE_ENV: 'production', PG_DATABASE_URL: PROD, PG_DATABASE_REPLICA_URL: PROD_REPLICA, DATABASE_URL: PROD })).toMatch(/legacy database variable/);
  });

  it('strict numbers: the replica timeout has the primary timeout bounds, the max lag is a positive whole number of ms', () => {
    expect(refusal({ PG_DATABASE_URL: APP, PG_DATABASE_REPLICA_TIMEOUT_MS: '1000' })).toMatch(/PG_DATABASE_REPLICA_TIMEOUT_MS must be between 30000/);
    expect(refusal({ PG_DATABASE_URL: APP, PG_DATABASE_REPLICA_TIMEOUT_MS: '30s' })).toMatch(/PG_DATABASE_REPLICA_TIMEOUT_MS must be a whole number/);
    expect(refusal({ PG_DATABASE_URL: APP, PG_DATABASE_REPLICA_MAX_LAG_MS: '0' })).toMatch(/PG_DATABASE_REPLICA_MAX_LAG_MS must be between 100 and 600000/);
    expect(refusal({ PG_DATABASE_URL: APP, PG_DATABASE_REPLICA_MAX_LAG_MS: '-5' })).toMatch(/PG_DATABASE_REPLICA_MAX_LAG_MS must be a whole number/);
  });

  it('the factory builds the replica connection from `url` with role replica: read-only session, short connect timeout', () => {
    const r = resolvePgEnvironment({ PG_DATABASE_URL: APP, PG_DATABASE_REPLICA_URL: REPLICA }, { processRole: 'api' });
    const config = pgClientConfig(r, { url: REPLICA, urlLabel: 'PG_DATABASE_REPLICA_URL', role: 'replica', purpose: 'runtime', connectTimeoutMs: 2_000 });
    expect(config.port).toBe(5433);
    expect(config.application_name).toBe('crewflow-api-replica');
    expect(config.options).toContain('-c default_transaction_read_only=on');
    expect(config.connectionTimeoutMillis).toBe(2_000);
    expect(pgClientConfig(r, { purpose: 'runtime' }).connectionTimeoutMillis).toBe(10_000);
    expect(() => pgClientConfig(r, { purpose: 'runtime', connectTimeoutMs: 0 })).toThrow(/connectTimeoutMs must be at least 1 ms/);
    expect(pgClientConfig(r, { purpose: 'probe', readOnly: true }).options).toContain('-c default_transaction_read_only=on');
    expect(pgClientConfig(r, { purpose: 'probe', readOnly: true }).application_name).toBe('crewflow-api-probe');
  });
});

describe('pg-config: the one-off operations container (Phase B ops)', () => {
  const MIGRATOR = `postgres://crewflow_migrator:${OTHER_SECRET}@localhost:5432/rab`;
  const OPS = { CREWFLOW_OPS_RUN: 'one-off', PG_OPS_APP_DATABASE_URL: APP, PG_DATABASE_URL: MIGRATOR };

  it('ops: the primary is PG_OPS_APP_DATABASE_URL (crewflow_app), the elevated endpoint PG_DATABASE_URL (migration identity)', () => {
    const r = resolvePgEnvironment(OPS, { processRole: 'ops' });
    expect(r.ops).toBe(true);
    expect(r.processRole).toBe('ops');
    expect(r.primary.source).toBe('PG_OPS_APP_DATABASE_URL');
    expect(r.primary.target.user).toBe('crewflow_app');
    expect(r.elevated?.source).toBe('PG_DATABASE_URL');
    expect(r.elevated?.target.user).toBe('crewflow_migrator');
    expect(pgClientConfig(r, { purpose: 'runtime' }).application_name).toBe('crewflow-ops');
    expect(pgClientConfig(r, { endpoint: 'elevated', purpose: 'containment-read' }).application_name).toBe('crewflow-ops-containment-read');
  });

  it('the CLI resolution (boot gates, command target guard) inside the ops container IS the ops process', () => {
    const r = resolvePgEnvironment(OPS, { processRole: 'cli' });
    expect(r.ops).toBe(true);
    expect(r.primary.source).toBe('PG_OPS_APP_DATABASE_URL');
  });

  it('ops without PG_DATABASE_URL: no elevated endpoint (the crewflow_app-only modes); asking for it refuses', () => {
    const r = resolvePgEnvironment({ CREWFLOW_OPS_RUN: 'one-off', PG_OPS_APP_DATABASE_URL: APP }, { processRole: 'ops' });
    expect(r.elevated).toBeNull();
    expect(() => pgClientConfig(r, { endpoint: 'elevated', purpose: 'x' })).toThrow(/set PG_DATABASE_URL \(the migration identity\) in the one-off ops container/);
  });

  it('ops refusals: missing app URL, a bad CREWFLOW_OPS_RUN value, ops role without the flag, split databases, one login for both', () => {
    expect(refusal({ CREWFLOW_OPS_RUN: 'one-off', PG_DATABASE_URL: MIGRATOR }, { processRole: 'ops' })).toMatch(/requires PG_OPS_APP_DATABASE_URL/);
    expect(refusal({ ...OPS, CREWFLOW_OPS_RUN: 'yes' }, { processRole: 'ops' })).toMatch(/CREWFLOW_OPS_RUN must be unset or exactly "one-off"/);
    expect(refusal({ PG_OPS_APP_DATABASE_URL: APP }, { processRole: 'ops' })).toMatch(/requires CREWFLOW_OPS_RUN=one-off/);
    expect(refusal({ ...OPS, PG_DATABASE_URL: `postgres://crewflow_migrator:${OTHER_SECRET}@localhost:5432/other` }, { processRole: 'ops' })).toMatch(
      /name different databases/,
    );
    expect(refusal({ ...OPS, PG_DATABASE_URL: APP.replace(SECRET, OTHER_SECRET) }, { processRole: 'ops' })).toMatch(/name the same login/);
  });

  it('ops refuses every legacy name and the replica, in every environment', () => {
    for (const name of ['DATABASE_URL', 'DATABASE_URL_UNPOOLED', 'DATABASE_DIRECT_URL']) {
      expect(refusal({ ...OPS, [name]: MIGRATOR }, { processRole: 'ops' })).toMatch(new RegExp(String.raw`refuses the legacy database variable\(s\) ${name}`));
    }
    expect(refusal({ ...OPS, DB_POOL_MAX: '5' }, { processRole: 'ops' })).toMatch(/DB_POOL_MAX/);
    expect(refusal({ ...OPS, PG_DATABASE_REPLICA_URL: APP.replace('5432', '5433') }, { processRole: 'ops' })).toMatch(/refuses PG_DATABASE_REPLICA_URL/);
  });

  it('every other process refuses every ops variable (the ops credential and label never reach a runtime container)', () => {
    const OPS_ONLY = {
      CREWFLOW_OPS_RUN: 'one-off',
      PG_OPS_APP_DATABASE_URL: APP,
      CREWFLOW_OPS_ACTOR_SOURCE: 'github-actions',
      CREWFLOW_OPS_ACTOR_ID: 'repo:org/repo:environment:production',
      CREWFLOW_OPS_CHANGE_REF: 'OPS-1',
    };
    for (const role of ['api', 'worker', 'provisioner', 'migrate'] as const) {
      for (const [name, value] of Object.entries(OPS_ONLY)) {
        expect(refusal({ PG_DATABASE_URL: APP, [name]: value }, { processRole: role })).toMatch(
          new RegExp(String.raw`the ${role} process refuses the operations-container variable\(s\) ${name}`),
        );
      }
    }
    // An ordinary CLI run: any ops name without CREWFLOW_OPS_RUN refuses (with it, the CLI IS the ops process).
    expect(refusal({ PG_DATABASE_URL: APP, PG_OPS_APP_DATABASE_URL: APP }, { processRole: 'cli' })).toMatch(/the cli process refuses/);
    expect(refusal({ PG_DATABASE_URL: APP, CREWFLOW_OPS_ACTOR_ID: 'x' }, { processRole: 'cli' })).toMatch(/CREWFLOW_OPS_ACTOR_ID/);
    // Empty values count as unset (compose renders unset variables as empty strings).
    expect(resolvePgEnvironment({ PG_DATABASE_URL: APP, PG_OPS_APP_DATABASE_URL: '' }, { processRole: 'api' }).ops).toBe(false);
  });

  it('ops in production: PG_DATABASE_URL is optional, verify-full TLS still required on both', () => {
    const prodApp = PROD;
    const prodMigrator = PROD.replace('crewflow_app', 'crewflow_migrator').replace(SECRET, OTHER_SECRET);
    const r = resolvePgEnvironment(
      { NODE_ENV: 'production', DB_TARGET: 'production', CREWFLOW_OPS_RUN: 'one-off', PG_OPS_APP_DATABASE_URL: prodApp, PG_DATABASE_URL: prodMigrator },
      { processRole: 'ops' },
    );
    expect(r.production).toBe(true);
    expect(r.elevated?.target.user).toBe('crewflow_migrator');
    expect(resolvePgEnvironment({ DB_TARGET: 'production', CREWFLOW_OPS_RUN: 'one-off', PG_OPS_APP_DATABASE_URL: prodApp }, { processRole: 'ops' }).elevated).toBeNull();
    expect(
      refusal({ DB_TARGET: 'production', CREWFLOW_OPS_RUN: 'one-off', PG_OPS_APP_DATABASE_URL: prodApp.replace('sslmode=verify-full', 'sslmode=disable') }, { processRole: 'ops' }),
    ).toMatch(/verify-full|sslmode/);
    expect(
      refusal({ DB_TARGET: 'production', CREWFLOW_OPS_RUN: 'one-off', PG_OPS_APP_DATABASE_URL: prodApp, PG_DATABASE_URL: prodMigrator.replace('sslmode=verify-full', 'sslmode=disable') }, { processRole: 'ops' }),
    ).toMatch(/verify-full|sslmode/);
  });
});
