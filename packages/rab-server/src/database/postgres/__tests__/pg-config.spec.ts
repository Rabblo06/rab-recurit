import {
  emitPgWarnings,
  isPgProductionEnvironment,
  PgConfigError,
  PgProcessRole,
  presentLegacyPgEnvNames,
  readPrimaryDatabaseUrl,
  readReplicaDatabaseUrl,
  resolvePgEnvironment,
  resolvePgEnvironmentCached,
  ResolvePgOptions,
  RETIRED_OPS_ENV_NAMES,
  selectMigrationEndpoint,
} from '../pg-config';
import { pgClientConfig } from '../create-pg-pool';
import { NEVER_IN_RUNTIME_ENV } from '../../typeorm/core/never-in-runtime-env';

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

describe('pg-config: primary URL, and the legacy names refused in every environment (X3.5-S8)', () => {
  const LEGACY_VALUES: Record<string, string> = {
    DATABASE_URL: APP,
    DATABASE_URL_UNPOOLED: `postgres://crewflow:${OTHER_SECRET}@localhost/rab`,
    DATABASE_DIRECT_URL: APP,
    DB_POOL_MAX: '12',
  };
  const REPLACEMENT: Record<string, RegExp> = {
    DATABASE_URL: /DATABASE_URL -> use PG_DATABASE_URL/,
    DATABASE_URL_UNPOOLED: /DATABASE_URL_UNPOOLED -> use PG_DATABASE_URL \(every process.*TEST_DATABASE_ADMIN_URL\)/,
    DATABASE_DIRECT_URL: /DATABASE_DIRECT_URL -> use PG_DATABASE_URL pointed at a direct \(non-pooled\) connection/,
    DB_POOL_MAX: /DB_POOL_MAX -> use PG_POOL_MAX_CONNECTIONS/,
  };
  const ALL_ROLES: PgProcessRole[] = ['api', 'worker', 'provisioner', 'cli', 'migrate'];

  it('PG_DATABASE_URL alone: the primary, the lock endpoint and no warning; there is no elevated endpoint', () => {
    const r = resolvePgEnvironment({ PG_DATABASE_URL: APP });
    expect(r.production).toBe(false);
    expect(r.primary.source).toBe('PG_DATABASE_URL');
    expect(r.lock).toBe(r.primary);
    expect('elevated' in r).toBe(false);
    expect(r.warnings).toEqual([]);
    expect(r.pool).toEqual({ max: 10, idleTimeoutMillis: 600_000, allowExitOnIdle: false });
    expect(r.queryTimeoutMs).toBe(30_000);
  });

  it.each(Object.keys(LEGACY_VALUES))('%s is refused in every non-production environment and process role, naming its replacement (names only)', (name) => {
    for (const extra of [{}, { NODE_ENV: 'development' }, { NODE_ENV: 'test' }, { DB_TARGET: 'local' }, { DB_TARGET: 'test' }]) {
      for (const role of ALL_ROLES) {
        // Alone (the old fallback), next to PG_DATABASE_URL naming the same target, and next to PG_DATABASE_URL naming another.
        for (const env of [{ ...extra, [name]: LEGACY_VALUES[name] }, { ...extra, PG_DATABASE_URL: APP, [name]: LEGACY_VALUES[name] }]) {
          const message = refusal(env, { processRole: role });
          expect(message).toMatch(new RegExp(`^the ${role} process refuses the legacy database variable\\(s\\) ${name}: .*X3\\.5-S8.*every environment`));
          expect(message).toMatch(REPLACEMENT[name]);
          expect(message).toMatch(/Refusing to start\.$/);
        }
      }
    }
  });

  it('the env.validation path (enforceProcessPolicy=false) refuses them too, and every held name is listed', () => {
    const message = refusal({ PG_DATABASE_URL: APP, ...LEGACY_VALUES }, { processRole: 'api', enforceProcessPolicy: false });
    expect(message).toMatch(/refuses the legacy database variable\(s\) DATABASE_URL, DATABASE_URL_UNPOOLED, DATABASE_DIRECT_URL, DB_POOL_MAX:/);
    for (const re of Object.values(REPLACEMENT)) expect(message).toMatch(re);
  });

  it('an empty or blank legacy value counts as unset (compose renders unset variables as empty; the Jest routing blanks them)', () => {
    const r = resolvePgEnvironment({ PG_DATABASE_URL: APP, DATABASE_URL: '', DATABASE_URL_UNPOOLED: '  ', DATABASE_DIRECT_URL: '', DB_POOL_MAX: ' ' }, { processRole: 'cli' });
    expect(r.primary.source).toBe('PG_DATABASE_URL');
    expect(r.warnings).toEqual([]);
  });

  it('the legacy refusal comes before "PG_DATABASE_URL is required" (the operator learns the rename, not only that a name is missing)', () => {
    expect(refusal({ DATABASE_URL: APP })).toMatch(/refuses the legacy database variable\(s\) DATABASE_URL: /);
  });

  it('nothing set: refused', () => {
    expect(refusal({})).toMatch(/^PG_DATABASE_URL is required\. Refusing to start\.$/);
    expect(refusal({ PG_DATABASE_URL: '  ', DATABASE_URL: '' })).toMatch(/PG_DATABASE_URL is required/);
  });

  it('the memoised resolution never hides a legacy name that appears after a clean hit', () => {
    const clean = { PG_DATABASE_URL: APP, NODE_ENV: 'test' };
    expect(resolvePgEnvironmentCached(clean, { processRole: 'cli' }).primary.source).toBe('PG_DATABASE_URL');
    for (const name of Object.keys(LEGACY_VALUES)) {
      expect(() => resolvePgEnvironmentCached({ ...clean, [name]: LEGACY_VALUES[name] }, { processRole: 'cli' })).toThrow(/refuses the legacy database variable/);
    }
  });

  it('readPrimaryDatabaseUrl: PG_DATABASE_URL only, never the legacy DATABASE_URL', () => {
    expect(readPrimaryDatabaseUrl({ PG_DATABASE_URL: APP, DATABASE_URL: 'x' })?.name).toBe('PG_DATABASE_URL');
    expect(readPrimaryDatabaseUrl({ DATABASE_URL: APP })).toBeNull();
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

  it('X3.5-S8: the legacy DB_POOL_MAX is refused whatever its value, even when it agrees with PG_POOL_MAX_CONNECTIONS', () => {
    for (const value of ['12', 'abc', '10']) {
      expect(refusal({ PG_DATABASE_URL: APP, PG_POOL_MAX_CONNECTIONS: '10', DB_POOL_MAX: value })).toMatch(/DB_POOL_MAX -> use PG_POOL_MAX_CONNECTIONS/);
    }
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
  it('prints each warning once per process, names only, and is NOT silent under NODE_ENV=test (X3.5-S6, DBR-08)', () => {
    const r = resolvePgEnvironment({ PG_DATABASE_URL: `postgres://crewflow_app:${SECRET}@ep-a-1-pooler.eu-west-2.aws.neon.tech/neondb?sslmode=require` }, { processRole: 'api' });
    expect(r.warnings.join('\n')).toMatch(/transaction-pooler shape/);
    expect(r.warnings.join('\n')).not.toContain(SECRET);
    // The once-per-process set is module-wide, so this case uses a warning no other case can have emitted already.
    const unique = { ...r, warnings: ['X3.5-S6 emit-once probe (pg-config.spec)'] };
    const lines: string[] = [];
    emitPgWarnings(unique, { NODE_ENV: 'test' }, (l) => lines.push(l));
    expect(lines).toEqual(['[pg-config] warning: X3.5-S6 emit-once probe (pg-config.spec)']);
    emitPgWarnings(unique, { NODE_ENV: 'development' }, (l) => lines.push(l));
    emitPgWarnings(unique, { NODE_ENV: 'test' }, (l) => lines.push(l));
    expect(lines).toHaveLength(1);
  });

  it('X3.5-S8: the release-1 strict switch is gone; the refusal no longer depends on PG_LEGACY_NAMES_STRICT', () => {
    for (const strict of [undefined, 'false', 'true', '']) {
      expect(refusal({ DATABASE_URL: APP, PG_LEGACY_NAMES_STRICT: strict }, { processRole: 'cli' })).toMatch(/refuses the legacy database variable\(s\) DATABASE_URL/);
    }
  });

  it('presentLegacyPgEnvNames lists the legacy names that hold a value (empty counts as unset), names only', () => {
    expect(presentLegacyPgEnvNames({ PG_DATABASE_URL: APP })).toEqual([]);
    expect(presentLegacyPgEnvNames({ PG_DATABASE_URL: APP, DATABASE_URL: '', DATABASE_URL_UNPOOLED: '  ' })).toEqual([]);
    expect(presentLegacyPgEnvNames({ DATABASE_URL: APP, DATABASE_URL_UNPOOLED: APP, DATABASE_DIRECT_URL: APP, DB_POOL_MAX: '5' })).toEqual([
      'DATABASE_URL',
      'DATABASE_URL_UNPOOLED',
      'DATABASE_DIRECT_URL',
      'DB_POOL_MAX',
    ]);
  });
});

describe('pg-config: `options=-c role=…` (the M2 restricted-migrator harness) — migrate process, local/test target only', () => {
  const phaseA = `postgres://rab_ci_migrator:${SECRET}@127.0.0.1:15436/m2_db?options=-c+role%3Drab_owner`;

  it.each(['test', 'local'])('accepted for the migrate process with DB_TARGET=%s, and sent as a startup option', (target) => {
    const r = resolvePgEnvironment({ PG_DATABASE_URL: phaseA, DB_TARGET: target }, { processRole: 'migrate' });
    expect(r.allowSessionRole).toBe(true);
    expect(r.primary.target.sessionRoleOption).toBe('-c role=rab_owner');
    expect(pgClientConfig(r, { endpoint: 'primary', purpose: 'runtime' }).options).toBe(
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

  it('PG_DATABASE_URL → the primary endpoint, the only one', () => {
    const env1 = { PG_DATABASE_URL: MIGRATOR };
    const chosen = selectMigrationEndpoint(resolvePgEnvironment(env1, { processRole: 'migrate' }), env1);
    expect(chosen.name).toBe('primary');
    expect(chosen.endpoint.target.user).toBe('crewflow_migrator');
  });

  it('X3.5-S8: the migrate process refuses DATABASE_URL_UNPOOLED (alone, or next to PG_DATABASE_URL with the same or another target)', () => {
    for (const env of [{ DATABASE_URL: APP, DATABASE_URL_UNPOOLED: OWNER }, { PG_DATABASE_URL: MIGRATOR, DATABASE_URL_UNPOOLED: OWNER }, { PG_DATABASE_URL: MIGRATOR, DATABASE_URL_UNPOOLED: MIGRATOR }]) {
      expect(refusal(env, { processRole: 'migrate' })).toMatch(/^the migrate process refuses the legacy database variable\(s\) .*DATABASE_URL_UNPOOLED/);
    }
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

describe('pg-config: the retired operations-container variables (rab-ops removed)', () => {
  const MIGRATOR = `postgres://crewflow_migrator:${OTHER_SECRET}@localhost:5432/rab`;
  const OWNER = `postgres://crewflow_owner:${OTHER_SECRET}@localhost:5432/rab`;
  // Every variable the removed rab-ops container read, with the value it used to carry.
  const RETIRED: Record<(typeof RETIRED_OPS_ENV_NAMES)[number], string> = {
    CREWFLOW_OPS_RUN: 'one-off',
    PG_OPS_APP_DATABASE_URL: APP,
    CREWFLOW_OPS_ACTOR_SOURCE: 'github-actions',
    CREWFLOW_OPS_ACTOR_ID: 'repo:org/repo:environment:production',
    CREWFLOW_OPS_CHANGE_REF: 'OPS-1',
  };
  const ALL_ROLES: readonly PgProcessRole[] = ['api', 'worker', 'provisioner', 'cli', 'migrate'];

  it('names exactly the five retired variables, and every one is also on the in-process runtime refusal list', () => {
    expect([...RETIRED_OPS_ENV_NAMES].sort()).toEqual(Object.keys(RETIRED).sort());
    const runtimeRefused = new Set(NEVER_IN_RUNTIME_ENV.map((entry) => entry.name));
    for (const name of RETIRED_OPS_ENV_NAMES) expect(runtimeRefused.has(name)).toBe(true);
  });

  it('EVERY process role refuses each retired variable, the cli included (no process reads them any more)', () => {
    for (const role of ALL_ROLES) {
      for (const [name, value] of Object.entries(RETIRED)) {
        const message = refusal({ PG_DATABASE_URL: APP, [name]: value }, { processRole: role });
        expect(message).toMatch(new RegExp(String.raw`^the ${role} process refuses the retired operations-container variable\(s\) ${name}: the rab-ops container was removed`));
        // It names the replacement; it never echoes a value.
        expect(message).toContain('one-off CLI commands under the owner login crewflow_owner');
        expect(message).toContain('OWNER-LOGIN-DEPLOYMENT.md');
        if (name !== 'CREWFLOW_OPS_RUN') expect(message).not.toContain(value); // 'one-off' is a word of the fixed text
      }
    }
  });

  it('the old ops-container invocation on the cli (CREWFLOW_OPS_RUN=one-off) is refused, never resolved as an ops process', () => {
    // The exact old rab-ops environment: the app URL in PG_OPS_APP_DATABASE_URL and the migration identity in PG_DATABASE_URL.
    const oldOps = { ...RETIRED, PG_DATABASE_URL: MIGRATOR };
    expect(refusal(oldOps, { processRole: 'cli' })).toMatch(
      /^the cli process refuses the retired operations-container variable\(s\) CREWFLOW_OPS_RUN, PG_OPS_APP_DATABASE_URL, CREWFLOW_OPS_ACTOR_SOURCE, CREWFLOW_OPS_ACTOR_ID, CREWFLOW_OPS_CHANGE_REF:/,
    );
    // Without PG_DATABASE_URL the retired-variable refusal still comes first (not "PG_DATABASE_URL is required").
    expect(refusal({ CREWFLOW_OPS_RUN: 'one-off', PG_OPS_APP_DATABASE_URL: APP }, { processRole: 'cli' })).toMatch(/refuses the retired operations-container variable/);
    // Next to the owner login, with any CREWFLOW_OPS_RUN value, and in production.
    for (const value of ['one-off', 'true', 'x']) {
      expect(refusal({ PG_DATABASE_URL: OWNER, CREWFLOW_OPS_RUN: value }, { processRole: 'cli' })).toMatch(/the cli process refuses the retired operations-container variable\(s\) CREWFLOW_OPS_RUN/);
    }
    expect(refusal({ DB_TARGET: 'production', PG_DATABASE_URL: PROD, CREWFLOW_OPS_RUN: 'one-off' }, { processRole: 'cli' })).toMatch(/CREWFLOW_OPS_RUN/);
    // The env.validation path (enforceProcessPolicy false) refuses them too.
    expect(refusal({ PG_DATABASE_URL: APP, CREWFLOW_OPS_ACTOR_ID: 'x' }, { processRole: 'api', enforceProcessPolicy: false })).toMatch(/CREWFLOW_OPS_ACTOR_ID/);
  });

  it('empty values count as unset (compose renders unset variables as empty strings); the resolution has no ops field', () => {
    for (const role of ALL_ROLES) {
      const r = resolvePgEnvironment({ PG_DATABASE_URL: APP, CREWFLOW_OPS_RUN: '', PG_OPS_APP_DATABASE_URL: '  ' }, { processRole: role });
      expect(r.processRole).toBe(role);
      expect(r.primary.source).toBe('PG_DATABASE_URL');
      expect('elevated' in r).toBe(false);
      expect('ops' in r).toBe(false);
    }
  });

  it('the memoised resolution sees the retired names (a clean hit never hides a later retired value)', () => {
    const clean = { PG_DATABASE_URL: APP, NODE_ENV: 'test' };
    expect(resolvePgEnvironmentCached(clean, { processRole: 'cli' }).primary.source).toBe('PG_DATABASE_URL');
    for (const name of RETIRED_OPS_ENV_NAMES) {
      expect(() => resolvePgEnvironmentCached({ ...clean, [name]: RETIRED[name] }, { processRole: 'cli' })).toThrow(PgConfigError);
    }
  });
});
