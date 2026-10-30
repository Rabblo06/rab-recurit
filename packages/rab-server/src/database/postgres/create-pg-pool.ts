/**
 * Phase B (B1/P2): the one connection factory. Every pool, client, lock connection and TypeORM DataSource in production
 * code gets its connection settings from here (the source scan in __tests__/no-unapproved-db-access.spec.ts enforces it).
 *
 * What every connection gets, explicitly (never from the URL, never from libpq environment fallbacks):
 *   - target: host, port, user, password, database from the validated URL (pg-url-policy.ts);
 *   - ssl: the explicit object from pg-tls.ts;
 *   - application_name: the URL's own, else `crewflow-<process>[-<purpose>][-replica]`, so connections can be told apart
 *     in pg_stat_activity;
 *   - startup `options`: `-c statement_timeout=<ms> -c idle_in_transaction_session_timeout=60000` (plus
 *     `-c default_transaction_read_only=on` for a replica), prefixed by an allow-listed Neon `endpoint=<id>` token when
 *     the URL had one. libpq option syntax: space-separated `-c name=value` pairs; values here are integers or `on`, so
 *     no escaping is needed. Server-side these equal the previous `statement_timeout` startup parameter;
 *   - client: query_timeout (PG_DATABASE_PRIMARY_TIMEOUT_MS), connect timeout 10 s (also pg-pool's wait for a free
 *     connection), TCP keep-alive after 10 s — unchanged from before;
 *   - pool: an explicit `max` always (PG_POOL_MAX_CONNECTIONS unless the caller sets its own), idle timeout and
 *     allowExitOnIdle from PG_POOL_IDLE_TIMEOUT_MS / PG_POOL_ALLOW_EXIT_ON_IDLE.
 *
 * Roles: 'primary' is every connection today. 'replica' is accepted so a read-replica pool can be added later (wave 2)
 * without a second factory; it only changes the application_name and makes the session read-only.
 */
import { Client, ClientConfig, Pool, PoolConfig } from 'pg';
import { DataSource, DataSourceOptions } from 'typeorm';
import type { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';

import {
  PG_CONNECT_TIMEOUT_MS,
  PG_IDLE_IN_TRANSACTION_TIMEOUT_MS,
  PG_KEEPALIVE_INITIAL_DELAY_MS,
  PG_POOL_MAX_LIMIT,
  PG_RUNTIME_STATEMENT_TIMEOUT_MS,
  PgEndpoint,
  PgEndpointName,
  resolvePgEnvironment,
  ResolvedPgEnvironment,
} from './pg-config';
import { buildPgSsl } from './pg-tls';
import { parsePgUrl, PgConfigError } from './pg-url-policy';

export type PgServerRole = 'primary' | 'replica';

export interface PgConnectionRequest {
  /** Which configured connection (default 'primary'). Ignored when `url` is given. */
  endpoint?: PgEndpointName;
  /** An explicit URL (e.g. a future PG_DATABASE_REPLICA_URL), validated by the same policy. `urlLabel` names it in errors. */
  url?: string;
  urlLabel?: string;
  /** Default 'primary'. */
  role?: PgServerRole;
  /** Short lowercase tag for application_name: 'runtime' (no suffix), 'lock', 'probe', 'migration', ... */
  purpose: string;
  /** Server-side statement_timeout in ms (default 30 000). 0 = none (only where a caller kept that behaviour). */
  statementTimeoutMs?: number;
  /** Client-side query_timeout in ms (default PG_DATABASE_PRIMARY_TIMEOUT_MS). 0 = none. */
  queryTimeoutMs?: number;
  /** Default 60 000. 0 = none. */
  idleInTransactionTimeoutMs?: number;
  /** Connect timeout, also pg-pool's wait for a free connection (default PG_CONNECT_TIMEOUT_MS, 10 s); e.g. ~2 s for a replica. */
  connectTimeoutMs?: number;
  /** Refuse a transaction-pooler URL shape (session advisory locks). Default: true for the 'lock' endpoint. */
  sessionAffinity?: boolean;
  /**
   * A read-only session (`-c default_transaction_read_only=on`): the identity guards' probes. Implied by role 'replica'.
   * It does not change the application_name.
   */
  readOnly?: boolean;
}

export interface PgPoolRequest extends PgConnectionRequest {
  /** Explicit pool ceiling for this pool; default PG_POOL_MAX_CONNECTIONS. */
  max?: number;
}

/** The pg-level settings, also what TypeORM's `extra` carries (TypeORM spreads `extra` over its own pool options). */
export type PgDriverConfig = ClientConfig & { enableChannelBinding?: boolean };

function selectEndpoint(resolved: ResolvedPgEnvironment, request: PgConnectionRequest): PgEndpoint {
  if (request.url !== undefined) {
    const label = request.urlLabel ?? 'the database URL';
    const target = parsePgUrl(request.url, label, { allowSessionRole: resolved.allowSessionRole });
    return { source: label, target, ssl: buildPgSsl(target.sslmode, resolved.tls, label), deprecated: false };
  }
  const name = request.endpoint ?? 'primary';
  if (name === 'elevated') {
    if (!resolved.elevated) {
      throw new PgConfigError(
        resolved.ops
          ? 'this ops command needs the elevated session: set PG_DATABASE_URL (the migration identity) in the one-off ops container. Refusing.'
          : resolved.production
          ? 'this command needs the elevated owner connection, which production does not configure (DATABASE_URL_UNPOOLED is refused in production). Refusing.'
          : 'this command needs the elevated owner connection: set DATABASE_URL_UNPOOLED (deprecated; non-production only). Refusing.',
      );
    }
    return resolved.elevated;
  }
  return name === 'lock' ? resolved.lock : resolved.primary;
}

function assertTimeout(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 86_400_000) throw new PgConfigError(`${name} must be a whole number of milliseconds.`);
  return value;
}

function applicationNameFor(resolved: ResolvedPgEnvironment, endpoint: PgEndpoint, request: PgConnectionRequest): string {
  if (endpoint.target.applicationName) return endpoint.target.applicationName;
  if (!/^[a-z0-9-]{1,32}$/.test(request.purpose)) throw new PgConfigError('connection purpose must be 1-32 lowercase letters, digits or dashes.');
  const parts = [`crewflow-${resolved.processRole}`];
  if (request.purpose !== 'runtime') parts.push(request.purpose);
  if (request.role === 'replica') parts.push('replica');
  return parts.join('-').slice(0, 63);
}

/** libpq-style startup options. Exported for its unit test. */
export function pgStartupOptions(endpoint: PgEndpoint, request: PgConnectionRequest): string {
  const statement = assertTimeout('statementTimeoutMs', request.statementTimeoutMs ?? PG_RUNTIME_STATEMENT_TIMEOUT_MS);
  const idle = assertTimeout('idleInTransactionTimeoutMs', request.idleInTransactionTimeoutMs ?? PG_IDLE_IN_TRANSACTION_TIMEOUT_MS);
  const parts: string[] = [];
  if (endpoint.target.providerOptions) parts.push(endpoint.target.providerOptions);
  if (endpoint.target.sessionRoleOption) parts.push(endpoint.target.sessionRoleOption);
  parts.push(`-c statement_timeout=${statement}`, `-c idle_in_transaction_session_timeout=${idle}`);
  if (request.role === 'replica' || request.readOnly === true) parts.push('-c default_transaction_read_only=on');
  return parts.join(' ');
}

function prepare(resolved: ResolvedPgEnvironment, request: PgConnectionRequest) {
  const endpoint = selectEndpoint(resolved, request);
  const sessionAffinity = request.sessionAffinity ?? (request.url === undefined && request.endpoint === 'lock');
  const pooler = endpoint.target.transactionPooler;
  if (sessionAffinity && pooler) {
    throw new PgConfigError(
      `${endpoint.source} has a documented transaction-pooler shape (${pooler.reason}); a session advisory lock needs a direct (non-pooled) connection. Refusing.`,
    );
  }
  const queryTimeout = assertTimeout('queryTimeoutMs', request.queryTimeoutMs ?? resolved.queryTimeoutMs);
  const connectTimeout = assertTimeout('connectTimeoutMs', request.connectTimeoutMs ?? PG_CONNECT_TIMEOUT_MS);
  if (connectTimeout === 0) throw new PgConfigError('connectTimeoutMs must be at least 1 ms (0 would wait forever).');
  return {
    endpoint,
    queryTimeout,
    connectTimeout,
    options: pgStartupOptions(endpoint, request),
    applicationName: applicationNameFor(resolved, endpoint, request),
  };
}

/** Connection-level settings shared by Client, Pool and TypeORM (no target). */
function driverSettings(prepared: ReturnType<typeof prepare>): PgDriverConfig {
  const { endpoint, queryTimeout, connectTimeout, options, applicationName } = prepared;
  return {
    ssl: endpoint.ssl,
    options,
    application_name: applicationName,
    ...(queryTimeout > 0 ? { query_timeout: queryTimeout } : {}),
    connectionTimeoutMillis: connectTimeout,
    keepAlive: true,
    keepAliveInitialDelayMillis: PG_KEEPALIVE_INITIAL_DELAY_MS,
    enableChannelBinding: endpoint.target.channelBinding,
  };
}

/** A complete pg ClientConfig: explicit target + explicit ssl, no connectionString. */
export function pgClientConfig(resolved: ResolvedPgEnvironment, request: PgConnectionRequest): PgDriverConfig {
  const prepared = prepare(resolved, request);
  const { target } = prepared.endpoint;
  return {
    host: target.host,
    port: target.port,
    user: target.user,
    password: target.password,
    database: target.database,
    ...driverSettings(prepared),
  };
}

function poolSettings(resolved: ResolvedPgEnvironment, request: PgPoolRequest): Pick<PoolConfig, 'max' | 'idleTimeoutMillis' | 'allowExitOnIdle'> {
  const max = request.max ?? resolved.pool.max;
  if (!Number.isInteger(max) || max < 1 || max > PG_POOL_MAX_LIMIT) throw new PgConfigError(`pool max must be between 1 and ${PG_POOL_MAX_LIMIT}.`);
  return { max, idleTimeoutMillis: resolved.pool.idleTimeoutMillis, allowExitOnIdle: resolved.pool.allowExitOnIdle };
}

export function pgPoolConfig(resolved: ResolvedPgEnvironment, request: PgPoolRequest): PoolConfig & PgDriverConfig {
  return { ...pgClientConfig(resolved, request), ...poolSettings(resolved, request) };
}

/**
 * Connection options for a TypeORM postgres DataSource: target as host/port/username/password/database (no `url`), and
 * every pg-level setting in `extra`, which TypeORM spreads over its own pool options last.
 */
export function pgTypeOrmConnectionOptions(
  resolved: ResolvedPgEnvironment,
  request: PgPoolRequest,
): Pick<PostgresConnectionOptions, 'type' | 'host' | 'port' | 'username' | 'password' | 'database' | 'ssl' | 'extra'> {
  const prepared = prepare(resolved, request);
  const { target } = prepared.endpoint;
  return {
    type: 'postgres',
    host: target.host,
    port: target.port,
    username: target.user,
    password: target.password,
    database: target.database,
    // Only rejectUnauthorized / ca are ever set (pg-tls.ts), which TypeORM's TlsOptions type also accepts.
    ssl: prepared.endpoint.ssl as PostgresConnectionOptions['ssl'],
    extra: { ...driverSettings(prepared), ...poolSettings(resolved, request) },
  };
}

/**
 * The same connection as a connection string, for a consumer that only accepts a string. No production call site uses it
 * any more (Phase B A7: ScanLock.open() and the schema-drift job take pgClientConfig). Everything pg can read from a URL is encoded explicitly — sslmode (disable /
 * verify-full / no-verify) and sslrootcert (PG_SSL_CA_CERT_PATH), application_name and options — so pg-connection-string
 * reproduces the explicit `ssl` object exactly (asserted in the spec through pg's ConnectionParameters). Not expressible
 * in a URL: query_timeout and channel binding; the caller sets query_timeout itself. Prefer pgClientConfig().
 */
export function pgConnectionString(resolved: ResolvedPgEnvironment, request: PgConnectionRequest): string {
  const prepared = prepare(resolved, request);
  const { target, ssl } = prepared.endpoint;
  const host = target.host.includes(':') ? `[${target.host}]` : target.host;
  const url = new URL(`postgresql://${host}:${target.port}`);
  url.username = encodeURIComponent(target.user);
  url.password = encodeURIComponent(target.password);
  url.pathname = `/${encodeURIComponent(target.database)}`;
  if (ssl === false) {
    url.searchParams.set('sslmode', 'disable');
  } else if (ssl.rejectUnauthorized === false) {
    url.searchParams.set('sslmode', 'no-verify');
  } else {
    url.searchParams.set('sslmode', 'verify-full');
    if (ssl.ca) {
      if (!resolved.tls.caPath) throw new PgConfigError('internal: a CA is configured without PG_SSL_CA_CERT_PATH.');
      url.searchParams.set('sslrootcert', resolved.tls.caPath);
    }
  }
  url.searchParams.set('application_name', prepared.applicationName);
  url.searchParams.set('options', prepared.options);
  return url.toString();
}

export function createPgClient(resolved: ResolvedPgEnvironment, request: PgConnectionRequest): Client {
  return new Client(pgClientConfig(resolved, request));
}

/** Settings an operator script's single-URL client takes from its environment (TLS and the production classification). */
const OPERATOR_SETTING_NAMES = ['NODE_ENV', 'RAB_RUNTIME_ENV', 'DB_TARGET', 'PG_SSL_CA_CERT_PATH', 'PG_SSL_ALLOW_SELF_SIGNED'] as const;

/**
 * Security review L-5: a client for an operator script or check that is handed ONE explicit URL in its own variable
 * (POSTURE_DATABASE_URL, DRIFT_DATABASE_URL, a test's admin URL, ...) instead of the process's PG_DATABASE_URL. The same
 * URL policy (no `?host=` / `?port=` / `?user=` / session `options` override), TLS (sslmode honoured, verify-full in
 * production), explicit fields and startup options as every other connection; nothing else from `env` is consulted
 * (no libpq fallbacks, no other database variable). `label` names the variable in refusals; values are never shown.
 */
export function createPgClientForUrl(
  url: string,
  label: string,
  request: Omit<PgConnectionRequest, 'url' | 'urlLabel' | 'endpoint'>,
  env: Record<string, string | undefined> = process.env,
): Client {
  const settings: Record<string, string | undefined> = {};
  for (const name of OPERATOR_SETTING_NAMES) if (env[name] !== undefined) settings[name] = env[name];
  let resolved: ResolvedPgEnvironment;
  try {
    resolved = resolvePgEnvironment({ ...settings, PG_DATABASE_URL: url }, { processRole: 'cli', enforceProcessPolicy: false });
  } catch (error) {
    if (error instanceof PgConfigError) throw new PgConfigError(error.message.split('PG_DATABASE_URL').join(label));
    throw error;
  }
  return createPgClient(resolved, { ...request, url, urlLabel: label });
}

/** `createPgPool({ url?, role, purpose, max })` — a plain pg Pool with every setting explicit. */
export function createPgPool(resolved: ResolvedPgEnvironment, request: PgPoolRequest): Pool {
  return new Pool(pgPoolConfig(resolved, request));
}

/** A TypeORM DataSource whose connection comes from the factory; `base` carries the non-connection options. */
export function createPgDataSource(
  resolved: ResolvedPgEnvironment,
  request: PgPoolRequest,
  base: Omit<Partial<PostgresConnectionOptions>, 'type' | 'url' | 'host' | 'port' | 'username' | 'password' | 'database' | 'ssl' | 'extra'> = {},
): DataSource {
  return new DataSource({ ...base, ...pgTypeOrmConnectionOptions(resolved, request) } as DataSourceOptions);
}
