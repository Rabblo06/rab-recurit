/**
 * Integration-test database routing guard.
 *
 * Why this exists. `.env` (per developer, gitignored) carries real connection strings: DATABASE_URL and DATABASE_URL_UNPOOLED
 * can point at a remote Neon endpoint. Integration tests used to read those names directly, so a test run could split its
 * application connection and its admin connection across two different databases. The admin connection then wrote fixture
 * rows to whatever `.env` pointed at. This module makes the test database explicit and fail-closed.
 *
 * Rules enforced here:
 *   - Under Jest the process must run with NODE_ENV=test (X1.2, audit DBT-01). Nx loads packages/rab-server/.env into the
 *     test task without overriding what is already set, and Jest / the Nx Jest executor only DEFAULT NODE_ENV to `test`
 *     when it is unset, so `.env`'s `NODE_ENV=development` used to reach the test process. This guard then returned early,
 *     every test file's application connection followed `.env` while the fixtures went to the TEST admin URL. Refused now:
 *     in every test file (setupFiles: JEST_WORKER_ID set and NODE_ENV not `test`) and in globalSetup (the Jest parent).
 *   - TEST_DATABASE_URL (application role) and TEST_DATABASE_URL_UNPOOLED (admin role: the disposable cluster's bootstrap
 *     superuser) must BOTH be set, and each must name its login in the URL. No fallback to DATABASE_URL or
 *     DATABASE_URL_UNPOOLED, which may come from `.env`.
 *   - Both must name the same logical database on the same endpoint. Hostnames are NOT compared literally, because a pooled
 *     and a direct Neon URL legitimately differ by the `-pooler` suffix. TEST_DATABASE_CREWFLOW_URL and
 *     TEST_DATABASE_WORKER_URL, when set, must name that same database and endpoint too.
 *   - A non-loopback (remote) host is refused unless ALLOW_REMOTE_TEST_DATABASE=true is set deliberately. Never a default.
 *   - The development database is refused by endpoint (rab-devdb: loopback port 15432 or the compose host `devdb`) and, when
 *     DEVDB_URL is present, by being the same database on the same endpoint as DEVDB_URL. The catalog disposable marker
 *     (globalSetup) remains the positive proof; this is the explicit negative one.
 *   - An inherited database URL that would redirect a connection away from the TEST database is refused, never silently
 *     kept: PG_DATABASE_URL (the factory's primary name prefers it over DATABASE_URL), the legacy DATABASE_DIRECT_URL (lock
 *     connection), PG_DATABASE_REPLICA_URL (read routing), and the operations / migration / provisioner names. An empty
 *     value counts as unset; a value naming the TEST database and endpoint is allowed. DATABASE_URL and
 *     DATABASE_URL_UNPOOLED are overwritten with the validated pair (below), so an inherited value of either cannot redirect.
 *   - libpq environment variables that change WHERE node-postgres connects (PGHOST, PGPORT, PGUSER, PGDATABASE, ...) are
 *     refused: they fill any part a URL leaves out, so the target this guard checks would not be the target the driver uses.
 *   - Error messages never contain a URL, password or username. Only variable names, host, port and database name are shown.
 *
 * This file has no runtime dependencies beyond `pg` (used only by the live identity probe), so it is safe to load from Jest
 * setup, global setup, the admin test helper, and the worker package (which imports the compiled copy of rab-server).
 */
import { Client } from 'pg';

export const TEST_DATABASE_URL = 'TEST_DATABASE_URL';
export const TEST_DATABASE_URL_UNPOOLED = 'TEST_DATABASE_URL_UNPOOLED';
/** The `crewflow` login (worker provisioner tests). Optional; when set it must name the TEST database. */
export const TEST_DATABASE_CREWFLOW_URL = 'TEST_DATABASE_CREWFLOW_URL';
/** Phase D: the `crewflow_worker` login (worker claim tests). Optional; when set it must name the TEST database. */
export const TEST_DATABASE_WORKER_URL = 'TEST_DATABASE_WORKER_URL';
export const ALLOW_REMOTE_TEST_DATABASE = 'ALLOW_REMOTE_TEST_DATABASE';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
/** Query parameters that change WHERE pg connects (pg-connection-string maps them over the URL's own parts). */
export const TARGET_OVERRIDE_QUERY_PARAMS: readonly string[] = ['host', 'hostaddr', 'port', 'user', 'dbname', 'database', 'service'];

/**
 * The development database (packages/rab-docker/docker-compose.yml service `devdb`, published on 127.0.0.1:15432). Never a
 * test target, whatever markers it carries.
 */
export const DEVELOPMENT_DATABASE_HOSTS: readonly string[] = ['devdb'];
export const DEVELOPMENT_DATABASE_LOOPBACK_PORTS: readonly string[] = ['15432'];
/** The compose file's application URL of the development database; compared by endpoint and database, never printed. */
export const DEVDB_URL = 'DEVDB_URL';

/**
 * Database URL names that a test process may inherit (Nx loads `.env`; a developer shell exports them) and that the
 * connection factory, a spec or a CLI child would use instead of, or next to, the TEST pair. DATABASE_URL and
 * DATABASE_URL_UNPOOLED are not here: the guard overwrites them with the validated pair.
 */
export const INHERITED_DATABASE_URL_NAMES: readonly string[] = [
  'PG_DATABASE_URL',
  'DATABASE_DIRECT_URL',
  'PG_DATABASE_REPLICA_URL',
  'PG_OPS_APP_DATABASE_URL',
  'CREWFLOW_MIGRATION_DATABASE_URL',
  'CREWFLOW_PRESTART_MIGRATION_DATABASE_URL',
  'CREWFLOW_PROVISIONER_DATABASE_URL',
];

/** libpq variables node-postgres reads as defaults for any connection part a URL leaves out (target-changing ones only). */
export const TARGET_CHANGING_LIBPQ_ENV_NAMES: readonly string[] = [
  'PGHOST',
  'PGHOSTADDR',
  'PGPORT',
  'PGUSER',
  'PGDATABASE',
  'PGSERVICE',
  'PGSERVICEFILE',
  'PGOPTIONS',
];

export class TestDatabaseConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TestDatabaseConfigError';
  }
}

export interface TestDatabaseIdentity {
  /** Which environment variable this came from. Safe to print. */
  label: string;
  host: string;
  port: string;
  database: string;
  /** Neon endpoint id when the host is a Neon host; otherwise host:port. Pooled and direct URLs share it. */
  endpointKey: string;
  pooled: boolean;
  remote: boolean;
  /** True when the URL names its login. Never the login itself. */
  hasUser: boolean;
}

export interface ResolvedTestDatabase {
  appUrl: string;
  adminUrl: string;
  app: TestDatabaseIdentity;
  admin: TestDatabaseIdentity;
}

/** Parses a connection string into printable identity fields. Throws without ever echoing the raw value. */
export function describeDatabaseUrl(raw: string, label: string): TestDatabaseIdentity {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TestDatabaseConfigError(`${label} is not a parseable postgres URL (value not shown).`);
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new TestDatabaseConfigError(`${label} must use the postgres:// scheme.`);
  }
  // Phase B finding F1: pg-connection-string turns every query parameter into a config key, so `?host=`, `?port=`,
  // `?user=`, `?hostaddr=`, `?dbname=`, `?database=` or `?service=` would make pg connect somewhere other than the host,
  // port, user or database read below. Every guard (test, command, runtime) parses here, so the override is refused here:
  // the identity a guard checks is then the identity the driver uses.
  for (const key of TARGET_OVERRIDE_QUERY_PARAMS) {
    if (url.searchParams.has(key)) {
      throw new TestDatabaseConfigError(
        `${label} sets "${key}" as a query parameter, which would override the connection target the URL names. Put it in the URL itself. Refusing.`,
      );
    }
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const port = url.port || '5432';
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!host || !database) {
    throw new TestDatabaseConfigError(`${label} must name a host and a database.`);
  }
  const firstLabel = host.split('.')[0] ?? host;
  const pooled = /-pooler$/.test(firstLabel);
  const isNeon = host.endsWith('.neon.tech');
  const endpointKey = isNeon ? `neon:${firstLabel.replace(/-pooler$/, '')}` : `${host}:${port}`;
  return { label, host, port, database, endpointKey, pooled, remote: !LOOPBACK_HOSTS.has(host), hasUser: url.username !== '' };
}

const present = (env: Record<string, string | undefined>, name: string): string | undefined => {
  const value = env[name]?.trim();
  return value ? value : undefined;
};

const sameDatabase = (a: TestDatabaseIdentity, b: TestDatabaseIdentity): boolean =>
  a.database === b.database && a.endpointKey === b.endpointKey;

/** The development database by endpoint (rab-devdb) or, when DEVDB_URL is present, by being that same database. */
function developmentDatabaseRefusal(id: TestDatabaseIdentity, env: Record<string, string | undefined>): string | null {
  if (DEVELOPMENT_DATABASE_HOSTS.includes(id.host)) return `${id.label} names the development database host "${id.host}".`;
  if (!id.remote && DEVELOPMENT_DATABASE_LOOPBACK_PORTS.includes(id.port)) {
    return `${id.label} names ${id.host}:${id.port}, the development database (rab-devdb).`;
  }
  const devdb = present(env, DEVDB_URL);
  if (devdb) {
    let dev: TestDatabaseIdentity;
    try {
      dev = describeDatabaseUrl(devdb, DEVDB_URL);
    } catch {
      return null; // DEVDB_URL is another process's setting; an unparseable one says nothing about this target.
    }
    if (sameDatabase(id, dev)) return `${id.label} names the same database and endpoint as ${DEVDB_URL} (the development database).`;
  }
  return null;
}

/**
 * Resolves the integration-test database from TEST_* variables only. Never reads DATABASE_URL or DATABASE_URL_UNPOOLED.
 * Pure function: pass any env-like object (tests pass explicit objects).
 */
export function resolveIntegrationTestDatabase(env: Record<string, string | undefined>): ResolvedTestDatabase {
  const appUrl = env[TEST_DATABASE_URL]?.trim();
  const adminUrl = env[TEST_DATABASE_URL_UNPOOLED]?.trim();
  if (!appUrl) {
    throw new TestDatabaseConfigError(
      `${TEST_DATABASE_URL} is required for integration tests. DATABASE_URL is never used as a fallback.`,
    );
  }
  if (!adminUrl) {
    throw new TestDatabaseConfigError(
      `${TEST_DATABASE_URL_UNPOOLED} is required for integration tests. DATABASE_URL_UNPOOLED is never used as a fallback.`,
    );
  }
  const app = describeDatabaseUrl(appUrl, TEST_DATABASE_URL);
  const admin = describeDatabaseUrl(adminUrl, TEST_DATABASE_URL_UNPOOLED);
  for (const id of [app, admin]) {
    // A URL without its login takes PGUSER or the operating-system user: not a credential this guard can reason about.
    if (!id.hasUser) {
      throw new TestDatabaseConfigError(`${id.label} must name its login in the URL (no login found; value not shown). Refusing to start.`);
    }
  }

  if (app.database !== admin.database) {
    throw new TestDatabaseConfigError(
      `Test connections target different databases ("${app.database}" vs "${admin.database}"). Refusing to start: fixtures would split across databases.`,
    );
  }
  if (app.endpointKey !== admin.endpointKey) {
    throw new TestDatabaseConfigError(
      `Test connections target different endpoints (${app.host}:${app.port} vs ${admin.host}:${admin.port}). Refusing to start.`,
    );
  }
  if ((app.remote || admin.remote) && env[ALLOW_REMOTE_TEST_DATABASE] !== 'true') {
    const remoteHost = app.remote ? app.host : admin.host;
    throw new TestDatabaseConfigError(
      `Remote test database "${remoteHost}" refused. Integration tests run only against a loopback database unless ${ALLOW_REMOTE_TEST_DATABASE}=true is set deliberately.`,
    );
  }
  for (const id of [app, admin]) {
    const dev = developmentDatabaseRefusal(id, env);
    if (dev) throw new TestDatabaseConfigError(`${dev} Integration tests never run against the development database. Refusing to start.`);
  }
  // The other test logins (audit DBT-10): a spec that connects through them must reach the same database.
  for (const label of [TEST_DATABASE_CREWFLOW_URL, TEST_DATABASE_WORKER_URL]) {
    const raw = present(env, label);
    if (!raw) continue;
    const other = describeDatabaseUrl(raw, label);
    if (!other.hasUser) throw new TestDatabaseConfigError(`${label} must name its login in the URL (value not shown). Refusing to start.`);
    if (!sameDatabase(other, app)) {
      throw new TestDatabaseConfigError(
        `${label} names "${other.database}" on ${other.host}:${other.port}, not the test database "${app.database}" on ${app.host}:${app.port}. Refusing to start.`,
      );
    }
  }
  return { appUrl, adminUrl, app, admin };
}

/** Prints NODE_ENV only when it is one of the declared values; anything else is not echoed. */
function describeNodeEnv(value: string | undefined): string {
  if (value === undefined) return 'unset';
  return ['development', 'test', 'production', 'staging', ''].includes(value) ? `"${value}"` : 'an unrecognised value (not shown)';
}

/**
 * DBT-01: a Jest process (setupFiles: JEST_WORKER_ID set; globalSetup: the Jest parent) must run with NODE_ENV=test, or the
 * test database routing below would be skipped and connections would follow `.env`. Pure.
 */
export function assertJestNodeEnv(env: Record<string, string | undefined>): void {
  if (env.NODE_ENV === 'test') return;
  throw new TestDatabaseConfigError(
    `Jest is running with NODE_ENV=${describeNodeEnv(env.NODE_ENV)}, not "test" (a developer .env loaded by Nx can set it). ` +
      'The test database routing would be skipped and connections would follow .env. Run tests with NODE_ENV=test. Refusing to start.',
  );
}

/**
 * The inherited-environment rules for a test process: no target-changing libpq variable, and no inherited database URL
 * that names anything but the validated TEST database (an empty value counts as unset). Pure: reads `env` only.
 */
export function assertNoRedirectingDatabaseEnv(env: Record<string, string | undefined>, resolved: ResolvedTestDatabase): void {
  const libpq = TARGET_CHANGING_LIBPQ_ENV_NAMES.filter((name) => present(env, name) !== undefined);
  if (libpq.length > 0) {
    throw new TestDatabaseConfigError(
      `libpq variable(s) ${libpq.join(', ')} are set: node-postgres uses them for any connection part a URL leaves out, so the target checked here would not be the target used. Unset them for test runs. Refusing to start.`,
    );
  }
  for (const name of INHERITED_DATABASE_URL_NAMES) {
    const raw = present(env, name);
    if (!raw) continue;
    let inherited: TestDatabaseIdentity;
    try {
      inherited = describeDatabaseUrl(raw, name);
    } catch {
      throw new TestDatabaseConfigError(`${name} is set and is not a valid postgres URL (value not shown). Unset it for test runs. Refusing to start.`);
    }
    if (!sameDatabase(inherited, resolved.app)) {
      throw new TestDatabaseConfigError(
        `${name} is set (inherited, e.g. from a developer .env loaded by Nx) and names "${inherited.database}" on ${inherited.host}:${inherited.port}, not the test database "${resolved.app.database}" on ${resolved.app.host}:${resolved.app.port}. ` +
          'It would redirect test connections. Unset it (or leave it empty) for test runs. Refusing to start.',
      );
    }
  }
}

/**
 * Called from Jest setupFiles (every test file, every worker) and from the e2e seed scripts. Under NODE_ENV=test it validates
 * the TEST_* pair and the inherited environment, then points the normal DATABASE_URL names at that same validated pair, so
 * every module that reads them (core datasource, Nest ConfigModule, which never overrides an already-set variable) uses the
 * test database and nothing else.
 *
 * Outside NODE_ENV=test it returns null and changes nothing (runtime and CLI processes are unaffected), EXCEPT under Jest
 * (JEST_WORKER_ID set), where any other NODE_ENV is refused (DBT-01): a test file never runs unrouted.
 */
export function applyIntegrationTestDatabaseEnv(env: NodeJS.ProcessEnv): ResolvedTestDatabase | null {
  if (env.NODE_ENV !== 'test') {
    if (env.JEST_WORKER_ID === undefined) return null;
    assertJestNodeEnv(env);
  }
  const resolved = resolveIntegrationTestDatabase(env);
  assertNoRedirectingDatabaseEnv(env, resolved);
  env.DATABASE_URL = resolved.appUrl;
  env.DATABASE_URL_UNPOOLED = resolved.adminUrl;
  return resolved;
}

/**
 * Jest globalSetup (the parent process, where JEST_WORKER_ID is not set): NODE_ENV=test, the TEST pair and the inherited
 * environment rules, before the live identity proof (assertSameDatabaseAtRuntime).
 */
export function resolveForJestGlobalSetup(env: Record<string, string | undefined>): ResolvedTestDatabase {
  assertJestNodeEnv(env);
  const resolved = resolveIntegrationTestDatabase(env);
  assertNoRedirectingDatabaseEnv(env, resolved);
  return resolved;
}

export interface DatabaseIdentityProbe {
  database: string;
  systemIdentifier: string;
  /** Value of the database-level marker setting; 'true' only on a database deliberately marked as a disposable test target. */
  disposableMarker: string | null;
}

/**
 * Positive marker a database must carry before integration tests may write to it (P0B, incident 2026-10-05):
 *   ALTER DATABASE <name> SET crewflow.disposable_test_database = 'true';
 * Loopback alone does not prove "disposable": a developer's real local database is loopback too. Set it once, by hand, on a
 * database you are prepared to have fixtures written into. Never set it on a development, staging or production database.
 */
export const DISPOSABLE_TEST_DATABASE_SETTING = 'crewflow.disposable_test_database';

/** Read-only identity probe: which database and which cluster a connection really reached. */
export async function probeDatabaseIdentity(url: string, label: string): Promise<DatabaseIdentityProbe> {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 10_000 });
  try {
    await client.connect();
    const result = await client.query<{ db: string; sid: string; marker: string | null }>(
      // Read the DATABASE-level setting from the catalog, not current_setting(): a connection string can set any session
      // value (options=-c ...), so only what was stored with ALTER DATABASE counts.
      `SELECT current_database() AS db, (SELECT system_identifier::text FROM pg_control_system()) AS sid,
              (SELECT split_part(cfg, '=', 2) FROM pg_db_role_setting s JOIN pg_database d ON d.oid = s.setdatabase,
                      unnest(s.setconfig) cfg
                WHERE d.datname = current_database() AND s.setrole = 0 AND split_part(cfg, '=', 1) = $1 LIMIT 1) AS marker`,
      [DISPOSABLE_TEST_DATABASE_SETTING],
    );
    const row = result.rows[0];
    if (!row) throw new Error('empty identity probe');
    return { database: row.db, systemIdentifier: row.sid, disposableMarker: row.marker };
  } catch (error) {
    // Never rethrow the driver error verbatim: it can echo connection details.
    const code = (error as { code?: string }).code ?? 'unknown';
    throw new TestDatabaseConfigError(`Cannot reach ${label} for the identity check (driver code ${code}).`);
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * Live proof, run once before any suite (Jest globalSetup). Both connections must reach the same database in the same
 * cluster. Pooled and direct connections are allowed to differ by hostname, so the proof is on identity, not on strings.
 */
export async function assertSameDatabaseAtRuntime(resolved: ResolvedTestDatabase): Promise<DatabaseIdentityProbe> {
  const app = await probeDatabaseIdentity(resolved.appUrl, TEST_DATABASE_URL);
  const admin = await probeDatabaseIdentity(resolved.adminUrl, TEST_DATABASE_URL_UNPOOLED);
  if (app.database !== admin.database || app.systemIdentifier !== admin.systemIdentifier) {
    throw new TestDatabaseConfigError(
      `Runtime identity mismatch: application connection reached database "${app.database}" (cluster ${app.systemIdentifier}), admin connection reached "${admin.database}" (cluster ${admin.systemIdentifier}). Refusing to start.`,
    );
  }
  if (app.disposableMarker !== 'true' || admin.disposableMarker !== 'true') {
    throw new TestDatabaseConfigError(
      `Database "${app.database}" (cluster ${app.systemIdentifier}) is not marked as a disposable test database. Refusing to write fixtures. ` +
        `If, and only if, it is disposable, mark it once: ALTER DATABASE ${app.database} SET ${DISPOSABLE_TEST_DATABASE_SETTING} = 'true';`,
    );
  }
  return app;
}
