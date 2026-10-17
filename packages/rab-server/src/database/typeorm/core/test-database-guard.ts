/**
 * Integration-test database routing guard.
 *
 * Why this exists. `.env` (per developer, gitignored) carries real connection strings: DATABASE_URL and DATABASE_URL_UNPOOLED
 * can point at a remote Neon endpoint. Integration tests used to read those names directly, so a test run could split its
 * application connection and its admin connection across two different databases. The admin connection then wrote fixture
 * rows to whatever `.env` pointed at. This module makes the test database explicit and fail-closed.
 *
 * Rules enforced here, under NODE_ENV=test (Jest always sets it):
 *   - TEST_DATABASE_URL (application role) and TEST_DATABASE_URL_UNPOOLED (owner/admin role) must BOTH be set. No fallback to
 *     DATABASE_URL or DATABASE_URL_UNPOOLED, which may come from `.env`.
 *   - Both must name the same logical database on the same endpoint. Hostnames are NOT compared literally, because a pooled
 *     and a direct Neon URL legitimately differ by the `-pooler` suffix.
 *   - A non-loopback (remote) host is refused unless ALLOW_REMOTE_TEST_DATABASE=true is set deliberately. Never a default.
 *   - Error messages never contain a URL, password or username. Only host, port and database name are shown.
 *
 * This file has no runtime dependencies beyond `pg` (used only by the live identity probe), so it is safe to load from Jest
 * setup, global setup, the admin test helper, and the worker package (which imports the compiled copy of rab-server).
 */
import { Client } from 'pg';

export const TEST_DATABASE_URL = 'TEST_DATABASE_URL';
export const TEST_DATABASE_URL_UNPOOLED = 'TEST_DATABASE_URL_UNPOOLED';
export const ALLOW_REMOTE_TEST_DATABASE = 'ALLOW_REMOTE_TEST_DATABASE';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

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
  return { label, host, port, database, endpointKey, pooled, remote: !LOOPBACK_HOSTS.has(host) };
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
  return { appUrl, adminUrl, app, admin };
}

/**
 * Called from Jest setupFiles (every test file, every worker). Under NODE_ENV=test it validates the TEST_* pair and then
 * points the normal DATABASE_URL names at that same validated pair, so every module that reads them (core datasource, Nest
 * ConfigModule, which never overrides an already-set variable) uses the test database and nothing else.
 */
export function applyIntegrationTestDatabaseEnv(env: NodeJS.ProcessEnv): ResolvedTestDatabase | null {
  if (env.NODE_ENV !== 'test') return null;
  const resolved = resolveIntegrationTestDatabase(env);
  env.DATABASE_URL = resolved.appUrl;
  env.DATABASE_URL_UNPOOLED = resolved.adminUrl;
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
