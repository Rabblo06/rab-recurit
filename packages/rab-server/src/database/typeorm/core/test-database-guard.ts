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
 *     kept: PG_DATABASE_URL (the factory's primary name prefers it over DATABASE_URL), the operations / migration /
 *     provisioner names (allowed only when they name the TEST database, endpoint AND the TEST application login), and the
 *     legacy DATABASE_DIRECT_URL (lock connection) and PG_DATABASE_REPLICA_URL (read routing), which a test process never
 *     needs and which are refused whenever non-empty (X1.9: pg-config compares DATABASE_DIRECT_URL by database name only
 *     and refuses a replica only when it is the very same target, so a superuser login on the TEST database slipped through).
 *     An empty value counts as unset. DATABASE_URL and DATABASE_URL_UNPOOLED are overwritten with the validated pair
 *     (below), so an inherited value of either cannot redirect.
 *   - The same inherited-URL and libpq rules also read the working directory's `.env` (and DOTENV_CONFIG_PATH), as data
 *     only (X1.9): @nestjs/config and `dotenv/config` load that file into process.env LATER (when AppModule or a script is
 *     imported), after this guard ran, so a name present only there would otherwise escape it on a direct `npx jest -c` run.
 *   - libpq environment variables that change WHERE node-postgres connects (PGHOST, PGPORT, PGUSER, PGDATABASE, ...) are
 *     refused: they fill any part a URL leaves out, so the target this guard checks would not be the target the driver uses.
 *   - Hosts are compared the way the driver resolves them (X1.9): a percent-encoded host is refused (pg-connection-string
 *     decodes it, the WHATWG parser here does not), and the loopback aliases (localhost, 127.0.0.0/8, ::1, 0.0.0.0, ::,
 *     ::ffff:127.x) are one endpoint for the development-database and same-database comparisons.
 *   - Error messages never contain a URL, password or username. Only variable names, host, port and database name are shown.
 *
 * Runtime dependencies: `pg` (only the live identity probe) and `dotenv` (parse only, never loads into process.env), so it is
 * safe to load from Jest setup, global setup, the admin test helper, and the worker package (which imports the compiled copy
 * of rab-server).
 */
import * as fs from 'fs';
import * as path from 'path';

import { parse as parseDotenv } from 'dotenv';
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
  'PG_OPS_APP_DATABASE_URL',
  'CREWFLOW_MIGRATION_DATABASE_URL',
  'CREWFLOW_PRESTART_MIGRATION_DATABASE_URL',
  'CREWFLOW_PROVISIONER_DATABASE_URL',
];

/**
 * Connection names a test process never needs (no spec or CI workflow sets them for Jest): refused whenever non-empty, even
 * when they name the TEST database (X1.9 finding 1).
 */
export const FORBIDDEN_IN_TEST_DATABASE_URL_NAMES: readonly string[] = ['DATABASE_DIRECT_URL', 'PG_DATABASE_REPLICA_URL'];

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
  /**
   * Comparison key for "the same server": loopback aliases collapse to `loopback:<port>`; Neon pooled / direct share the
   * endpoint id; anything else is `host:port`. Safe to print.
   */
  serverKey: string;
  /** The decoded login, for equality checks ONLY. Never printed, logged or put in a message. */
  login: string;
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
  // X1.9 finding 3: pg-connection-string percent-decodes the host (`local%68ost` connects to localhost); the WHATWG parser
  // does not. Refused rather than decoded, so no comparison below can be fooled by an encoding.
  if (host.includes('%')) {
    throw new TestDatabaseConfigError(`${label} has a percent-encoded host, which the driver decodes differently from this check. Write the host plainly. Refusing.`);
  }
  const port = url.port || '5432';
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!host || !database) {
    throw new TestDatabaseConfigError(`${label} must name a host and a database.`);
  }
  const firstLabel = host.split('.')[0] ?? host;
  const pooled = /-pooler$/.test(firstLabel);
  const isNeon = host.endsWith('.neon.tech');
  const endpointKey = isNeon ? `neon:${firstLabel.replace(/-pooler$/, '')}` : `${host}:${port}`;
  let login = '';
  try {
    login = decodeURIComponent(url.username);
  } catch {
    throw new TestDatabaseConfigError(`${label} has an undecodable login (value not shown). Refusing.`);
  }
  const serverKey = isLoopbackAlias(host) ? `loopback:${port}` : endpointKey;
  return { label, host, port, database, endpointKey, pooled, remote: !LOOPBACK_HOSTS.has(host), hasUser: url.username !== '', serverKey, login };
}

/**
 * Every spelling that reaches this machine's own PostgreSQL (X1.9 finding 3): localhost (and *.localhost), 127.0.0.0/8,
 * 0.0.0.0, ::1, ::, and IPv4-mapped loopback. Used only to COMPARE endpoints, never to relax the remote-host rule.
 */
export function isLoopbackAlias(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (/^127(\.\d{1,3}){3}$/.test(h) || h === '0.0.0.0') return true;
  if (h === '::1' || h === '::' || /^(0{1,4}:){7}0{0,3}1$/.test(h) || /^(0{1,4}:){7}0{1,4}$/.test(h)) return true;
  if (/^::ffff:127(\.\d{1,3}){3}$/.test(h) || /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(h)) return true;
  return false;
}

const present = (env: Record<string, string | undefined>, name: string): string | undefined => {
  const value = env[name]?.trim();
  return value ? value : undefined;
};

const sameDatabase = (a: TestDatabaseIdentity, b: TestDatabaseIdentity): boolean =>
  a.database === b.database && a.serverKey === b.serverKey;

/** The development database by endpoint (rab-devdb) or, when DEVDB_URL is present, by being that same database. */
function developmentDatabaseRefusal(id: TestDatabaseIdentity, env: Record<string, string | undefined>): string | null {
  if (DEVELOPMENT_DATABASE_HOSTS.includes(id.host)) return `${id.label} names the development database host "${id.host}".`;
  if (isLoopbackAlias(id.host) && DEVELOPMENT_DATABASE_LOOPBACK_PORTS.includes(id.port)) {
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
  for (const name of FORBIDDEN_IN_TEST_DATABASE_URL_NAMES) {
    if (present(env, name)) {
      throw new TestDatabaseConfigError(
        `${name} is set (inherited, e.g. from a developer .env). A test process never uses it, and it would open a connection the TEST pair does not control. Unset it (or leave it empty) for test runs. Refusing to start.`,
      );
    }
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
    // X1.9 finding 1: the same database is not enough; the login must be the TEST application login too (an inherited
    // superuser URL on the TEST database would otherwise be accepted). The login is compared, never shown.
    if (sameDatabase(inherited, resolved.app) && inherited.login !== resolved.app.login) {
      throw new TestDatabaseConfigError(
        `${name} is set (inherited, e.g. from a developer .env loaded by Nx) and names the test database "${resolved.app.database}" with a different login than ${TEST_DATABASE_URL}. ` +
          'Unset it (or leave it empty) for test runs. Refusing to start.',
      );
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
 * X1.9 finding 2: the values a LATER dotenv load would add to process.env — the working directory's `.env` (the default of
 * @nestjs/config and `dotenv/config`) and DOTENV_CONFIG_PATH's file — for the names the inherited-environment rules check,
 * keeping only names process.env does not already hold (dotenv never overrides those). Read as data, never loaded, never
 * printed. `read` is the test seam.
 */
export function laterDotenvValues(
  env: Record<string, string | undefined>,
  cwd: string = process.cwd(),
  read: (file: string) => string | null = readFileIfExists,
): Record<string, string> {
  const files = [path.resolve(cwd, '.env')];
  const configured = env.DOTENV_CONFIG_PATH?.trim();
  if (configured) files.push(path.resolve(cwd, configured));
  const names = new Set([...INHERITED_DATABASE_URL_NAMES, ...FORBIDDEN_IN_TEST_DATABASE_URL_NAMES, ...TARGET_CHANGING_LIBPQ_ENV_NAMES]);
  const out: Record<string, string> = {};
  for (const file of files) {
    const content = read(file);
    if (content === null) continue;
    for (const [key, value] of Object.entries(parseDotenv(content))) {
      if (names.has(key) && env[key] === undefined && !(key in out)) out[key] = value;
    }
  }
  return out;
}

function readFileIfExists(file: string): string | null {
  try {
    return fs.statSync(file).isFile() ? fs.readFileSync(file, 'utf8') : null;
  } catch {
    return null;
  }
}

/** The inherited-environment rules over process.env plus what a later dotenv load would add to it. */
function assertNoRedirectingProcessEnv(env: Record<string, string | undefined>, resolved: ResolvedTestDatabase): void {
  assertNoRedirectingDatabaseEnv({ ...laterDotenvValues(env), ...env }, resolved);
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
  assertNoRedirectingProcessEnv(env, resolved);
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
  assertNoRedirectingProcessEnv(env, resolved);
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
