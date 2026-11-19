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
 * Transaction pooler (pg-config.ts, PG_DATABASE_SESSION_URL): the 'runtime' endpoint of the API / Worker may then be a
 * transaction pooler. It is served ONLY by TransactionScopedClient (transaction-scoped-client.ts): no startup `-c` settings
 * (a pooler drops or refuses them); the same values are set per transaction by its preamble, which also runs RESET ROLE and
 * asserts current_user = session_user at the start of EVERY transaction (and wraps every statement sent outside one). Such
 * an endpoint is refused for any session-affine use, and pgClientConfig / pgConnectionString refuse it (a caller building
 * its own plain Client would lose the preamble): createPgClient, createPgPool and TypeORM (extra.Client) are the only ways
 * to it.
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
import { installSessionRoleResetOnAcquire, installSessionRoleResetOnDataSource } from './session-role-reset';
import { TRANSACTION_SCOPE_CONFIG_KEY, TransactionScopedClient, TransactionScopeSettings } from './transaction-scoped-client';

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
  /**
   * The caller needs one real database session (session advisory locks, SET ROLE across statements, LISTEN). Refused on
   * the transaction-pooled 'runtime' endpoint. Default: true for the 'lock' endpoint. A pooler cannot be told from its URL;
   * callers that hold a session lock also run the live session probe (pg-session-probe.ts).
   */
  sessionAffinity?: boolean;
  /**
   * false: send no startup `-c` settings (statement_timeout, idle_in_transaction_session_timeout, read-only, NOTIFY switch).
   * Only for the session-affinity probe, so that it can CONNECT through a pooler that refuses startup settings and report
   * the pooler clearly; it runs fixed SQL only and relies on the client-side query timeout. Default true.
   */
  sessionSettings?: boolean;
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
export type PgDriverConfig = ClientConfig & { enableChannelBinding?: boolean; [TRANSACTION_SCOPE_CONFIG_KEY]?: TransactionScopeSettings };

function selectEndpoint(resolved: ResolvedPgEnvironment, request: PgConnectionRequest): PgEndpoint {
  if (request.url !== undefined) {
    const label = request.urlLabel ?? 'the database URL';
    const target = parsePgUrl(request.url, label, { allowSessionRole: resolved.allowSessionRole });
    return { source: label, target, ssl: buildPgSsl(target.sslmode, resolved.tls, label, target.host), deprecated: false };
  }
  const name = request.endpoint ?? 'primary';
  if (name === 'runtime') return resolved.pooled ?? resolved.primary;
  if (name === 'elevated') {
    if (!resolved.elevated) {
      throw new PgConfigError(
        resolved.production
          ? 'this command needs the elevated owner connection, which production does not configure (DATABASE_URL_UNPOOLED is refused in production). Refusing.'
          : 'this command needs the elevated owner connection: set DATABASE_URL_UNPOOLED (deprecated; non-production only). Refusing.',
      );
    }
    return resolved.elevated;
  }
  // 'primary' is always a direct session: PG_DATABASE_SESSION_URL when set (pg-config.ts), never the transaction pooler.
  return name === 'lock' ? resolved.lock : (resolved.direct ?? resolved.primary);
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
export function pgStartupOptions(endpoint: PgEndpoint, request: PgConnectionRequest, dispatchNotify = false): string {
  const statement = assertTimeout('statementTimeoutMs', request.statementTimeoutMs ?? PG_RUNTIME_STATEMENT_TIMEOUT_MS);
  const idle = assertTimeout('idleInTransactionTimeoutMs', request.idleInTransactionTimeoutMs ?? PG_IDLE_IN_TRANSACTION_TIMEOUT_MS);
  const parts: string[] = [];
  if (endpoint.target.providerOptions) parts.push(endpoint.target.providerOptions);
  if (endpoint.target.sessionRoleOption) parts.push(endpoint.target.sessionRoleOption);
  // A transaction pooler drops or refuses session startup settings: the transaction-scoped client's preamble sets the same
  // values per transaction (transactionScopeSettings below). The probe asks for none (sessionSettings: false).
  if (endpoint.transactionScoped || request.sessionSettings === false) return parts.join(' ');
  parts.push(`-c statement_timeout=${statement}`, `-c idle_in_transaction_session_timeout=${idle}`);
  const readOnly = request.role === 'replica' || request.readOnly === true;
  if (readOnly) parts.push('-c default_transaction_read_only=on');
  // Phase D (E-1): see ResolvedPgEnvironment.dispatchNotify. Writable sessions only; absent (not 'off') otherwise.
  if (dispatchNotify && !readOnly) parts.push('-c crewflow.dispatch_notify=on');
  return parts.join(' ');
}

/** The per-transaction settings of a transaction-scoped endpoint: the values pgStartupOptions would have sent. */
export function transactionScopeSettings(request: PgConnectionRequest): TransactionScopeSettings {
  return {
    statementTimeoutMs: assertTimeout('statementTimeoutMs', request.statementTimeoutMs ?? PG_RUNTIME_STATEMENT_TIMEOUT_MS),
    idleInTransactionTimeoutMs: assertTimeout('idleInTransactionTimeoutMs', request.idleInTransactionTimeoutMs ?? PG_IDLE_IN_TRANSACTION_TIMEOUT_MS),
    readOnly: request.role === 'replica' || request.readOnly === true,
  };
}

function prepare(resolved: ResolvedPgEnvironment, request: PgConnectionRequest) {
  const endpoint = selectEndpoint(resolved, request);
  const sessionAffinity = request.sessionAffinity ?? (request.url === undefined && request.endpoint === 'lock');
  if (endpoint.transactionScoped && endpoint.target.sessionRoleOption) {
    throw new PgConfigError(`${endpoint.source} carries a session role option (-c role=...), refused on the transaction-scoped runtime endpoint. Refusing.`);
  }
  if (sessionAffinity && endpoint.transactionScoped) {
    throw new PgConfigError(
      `${endpoint.source} is the transaction-pooled runtime connection; a session advisory lock (or any session state) needs the direct connection (PG_DATABASE_SESSION_URL). Refusing.`,
    );
  }
  const queryTimeout = assertTimeout('queryTimeoutMs', request.queryTimeoutMs ?? resolved.queryTimeoutMs);
  const connectTimeout = assertTimeout('connectTimeoutMs', request.connectTimeoutMs ?? PG_CONNECT_TIMEOUT_MS);
  if (connectTimeout === 0) throw new PgConfigError('connectTimeoutMs must be at least 1 ms (0 would wait forever).');
  return {
    endpoint,
    queryTimeout,
    connectTimeout,
    options: pgStartupOptions(endpoint, request, resolved.dispatchNotify === true),
    applicationName: applicationNameFor(resolved, endpoint, request),
    transactionScope: endpoint.transactionScoped ? { ...transactionScopeSettings(request), dispatchNotify: resolved.dispatchNotify === true } : null,
  };
}

/** Connection-level settings shared by Client, Pool and TypeORM (no target). */
function driverSettings(prepared: ReturnType<typeof prepare>): PgDriverConfig {
  const { endpoint, queryTimeout, connectTimeout, options, applicationName, transactionScope } = prepared;
  return {
    ssl: endpoint.ssl,
    ...(options !== '' ? { options } : {}),
    ...(transactionScope ? { [TRANSACTION_SCOPE_CONFIG_KEY]: transactionScope } : {}),
    application_name: applicationName,
    ...(queryTimeout > 0 ? { query_timeout: queryTimeout } : {}),
    connectionTimeoutMillis: connectTimeout,
    keepAlive: true,
    keepAliveInitialDelayMillis: PG_KEEPALIVE_INITIAL_DELAY_MS,
    enableChannelBinding: endpoint.target.channelBinding,
  };
}

function clientConfigOf(prepared: ReturnType<typeof prepare>): PgDriverConfig {
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

const TRANSACTION_SCOPED_REFUSAL =
  'is the transaction-pooled runtime connection: it is reachable only through createPgClient, createPgPool or a TypeORM DataSource from this factory (the transaction-scoped client). Refusing.';

/**
 * A complete pg ClientConfig: explicit target + explicit ssl, no connectionString. Refused for the transaction-pooled
 * runtime endpoint: a caller that builds its own `new Client(config)` would bypass the per-transaction preamble.
 */
export function pgClientConfig(resolved: ResolvedPgEnvironment, request: PgConnectionRequest): PgDriverConfig {
  const prepared = prepare(resolved, request);
  if (prepared.transactionScope) throw new PgConfigError(`${prepared.endpoint.source} ${TRANSACTION_SCOPED_REFUSAL}`);
  return clientConfigOf(prepared);
}

function poolSettings(resolved: ResolvedPgEnvironment, request: PgPoolRequest): Pick<PoolConfig, 'max' | 'idleTimeoutMillis' | 'allowExitOnIdle'> {
  const max = request.max ?? resolved.pool.max;
  if (!Number.isInteger(max) || max < 1 || max > PG_POOL_MAX_LIMIT) throw new PgConfigError(`pool max must be between 1 and ${PG_POOL_MAX_LIMIT}.`);
  return { max, idleTimeoutMillis: resolved.pool.idleTimeoutMillis, allowExitOnIdle: resolved.pool.allowExitOnIdle };
}

export function pgPoolConfig(resolved: ResolvedPgEnvironment, request: PgPoolRequest): PoolConfig & PgDriverConfig {
  const prepared = prepare(resolved, request);
  return {
    ...clientConfigOf(prepared),
    ...poolSettings(resolved, request),
    ...(prepared.transactionScope ? { Client: TransactionScopedClient as unknown as PoolConfig['Client'] } : {}),
  };
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
    extra: {
      ...driverSettings(prepared),
      ...poolSettings(resolved, request),
      // TypeORM passes `extra` to pg-pool, which builds every connection with `new Client(config)`.
      ...(prepared.transactionScope ? { Client: TransactionScopedClient } : {}),
    },
  };
}

/**
 * The same connection as a connection string, for a consumer that only accepts a string. No production call site uses it
 * any more (Phase B A7: ScanLock.open() and the schema-drift job take pgClientConfig). Everything pg can read from a URL is encoded explicitly — sslmode (disable /
 * verify-full / no-verify) and sslrootcert (PG_SSL_CA_CERT_PATH), application_name and options — so pg-connection-string
 * reproduces the explicit `ssl` object exactly (asserted in the spec through pg's ConnectionParameters). Not expressible
 * in a URL: query_timeout and channel binding; the caller sets query_timeout itself. An inline PG_SSL_CA_CERT is not
 * expressible either (sslrootcert names a file): refused, never silently dropped. Prefer pgClientConfig().
 */
export function pgConnectionString(resolved: ResolvedPgEnvironment, request: PgConnectionRequest): string {
  const prepared = prepare(resolved, request);
  if (prepared.transactionScope) throw new PgConfigError(`${prepared.endpoint.source} ${TRANSACTION_SCOPED_REFUSAL}`);
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
    if (ssl.checkServerIdentity) {
      // An IP-literal host: the string form would lose the IP-bound host-name check (pg-tls.ts), so refuse it.
      throw new PgConfigError('A connection string cannot carry the host-name check for an IP-address host. This call site needs pgClientConfig. Refusing.');
    }
    if (ssl.ca) {
      if (resolved.tls.caSource !== 'PG_SSL_CA_CERT_PATH' || !resolved.tls.caPath) {
        throw new PgConfigError(
          'A connection string cannot carry the inline PG_SSL_CA_CERT (sslrootcert names a file). This call site needs pgClientConfig, or PG_SSL_CA_CERT_PATH. Refusing.',
        );
      }
      url.searchParams.set('sslrootcert', resolved.tls.caPath);
    }
  }
  url.searchParams.set('application_name', prepared.applicationName);
  if (prepared.options !== '') url.searchParams.set('options', prepared.options);
  return url.toString();
}

export function createPgClient(resolved: ResolvedPgEnvironment, request: PgConnectionRequest): Client {
  const prepared = prepare(resolved, request);
  const config = clientConfigOf(prepared);
  return prepared.transactionScope ? new TransactionScopedClient(config) : new Client(config);
}

/** Settings an operator script's single-URL client takes from its environment (TLS and the production classification). */
const OPERATOR_SETTING_NAMES = ['NODE_ENV', 'RAB_RUNTIME_ENV', 'DB_TARGET', 'PG_SSL_CA_CERT_PATH', 'PG_SSL_CA_CERT', 'PG_SSL_ALLOW_SELF_SIGNED'] as const;

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
  const pool = new Pool(pgPoolConfig(resolved, request));
  // Owner login: a session-level SET ROLE must never reach the next checkout (session-role-reset.ts). A transaction-scoped
  // pool is skipped there: its client resets the role inside every transaction instead.
  installSessionRoleResetOnAcquire(pool);
  return pool;
}

/** A TypeORM DataSource whose connection comes from the factory; `base` carries the non-connection options. */
export function createPgDataSource(
  resolved: ResolvedPgEnvironment,
  request: PgPoolRequest,
  base: Omit<Partial<PostgresConnectionOptions>, 'type' | 'url' | 'host' | 'port' | 'username' | 'password' | 'database' | 'ssl' | 'extra'> = {},
): DataSource {
  const dataSource = new DataSource({ ...base, ...pgTypeOrmConnectionOptions(resolved, request) } as DataSourceOptions);
  // Owner login: RESET ROLE on every pool checkout, installed as soon as the driver's pool exists (session-role-reset.ts).
  const initialize = dataSource.initialize.bind(dataSource);
  dataSource.initialize = async () => {
    await initialize();
    installSessionRoleResetOnDataSource(dataSource);
    return dataSource;
  };
  return dataSource;
}
