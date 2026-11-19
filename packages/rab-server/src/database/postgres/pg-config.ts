/**
 * Phase B (B1): resolves the database configuration of THIS process from its environment. Pure apart from reading the
 * CA file named by PG_SSL_CA_CERT_PATH (or validating the inline PG_SSL_CA_CERT); no connection is made here.
 *
 * One primary variable everywhere: `PG_DATABASE_URL`. Each process gets its own credential through its own environment
 * (API and Worker: the restricted `crewflow_app`; the migration step: its migration-only login), so the variable NAME
 * is the same in every process and only the value differs.
 *
 * Rules (owner-approved P1):
 *   Production (NODE_ENV, RAB_RUNTIME_ENV or DB_TARGET is `production` — any one is enough, fail closed):
 *     - PG_DATABASE_URL is required;
 *     - the legacy names DATABASE_URL, DATABASE_URL_UNPOOLED, DATABASE_DIRECT_URL and DB_POOL_MAX must not be set at all;
 *     - libpq environment variables (PGHOST, PGPASSWORD, PGSSLMODE, PGOPTIONS, ...) must not be set: pg reads some of
 *       them as silent fallbacks;
 *     - TLS verify-full is required (pg-tls.ts).
 *   Outside production:
 *     - PG_DATABASE_URL wins. Without it, the legacy DATABASE_URL is accepted with a deprecation warning;
 *     - PG_DATABASE_URL and DATABASE_URL both set and naming a different target (user, host, port or database; the
 *       password is not compared) → refused. The same rule applies to DATABASE_DIRECT_URL;
 *     - without PG_DATABASE_URL, a legacy DATABASE_DIRECT_URL still names the session-lock connection (deprecated);
 *     - a legacy DATABASE_URL_UNPOOLED still names the elevated connection that migrations use (deprecated);
 *     - DB_POOL_MAX is accepted for PG_POOL_MAX_CONNECTIONS (deprecated, now strictly validated); both set and
 *       different → refused.
 *   Every number is validated strictly (digits only, bounded); a bad value refuses to start instead of falling back
 *   (the old `Number(DB_POOL_MAX) > 0 ? … : 10` silently ignored typos).
 *
 * Pooler policy (owner instruction 2026-11-19, "decide by capability": no provider-specific code, no host matching):
 *   - PG_DATABASE_SESSION_URL set: PG_DATABASE_URL may be ANY transaction-mode pooler (PgBouncer pool_mode=transaction,
 *     Supavisor, RDS Proxy, ...). PG_DATABASE_SESSION_URL is the direct (session) connection of the SAME login and database
 *     (refused otherwise). Only the API / Worker RUNTIME pool (endpoint 'runtime') uses PG_DATABASE_URL, through the
 *     transaction-scoped client (transaction-scoped-client.ts: per-transaction RESET ROLE + role assertion + settings);
 *     every other connection (the session-lock endpoint, boot gates, identity probes, migrations, the CLI, the
 *     provisioner) uses PG_DATABASE_SESSION_URL. WORKER_DISPATCH_MODE=event is refused in this mode (its NOTIFY switch is a
 *     startup setting); poll, the default, is unaffected.
 *   - PG_DATABASE_SESSION_URL unset: PG_DATABASE_URL must itself be a direct connection. That is decided by CAPABILITY, not
 *     by its host name: the live session-affinity probe (pg-session-probe.ts) runs on it before the API, the Worker or a
 *     migration relies on a session, and refuses to start when it behaves like a pooler. (A PgBouncer in its default
 *     configuration also refuses the startup `-c` settings, so it is refused at connect time as well.)
 *   - PG_DATABASE_URL_IS_DIRECT=true together with PG_DATABASE_SESSION_URL is a contradiction and is refused. The flag never
 *     skips the session probe.
 *   - Production (security review L-1): the API / Worker 'runtime' endpoint is ALWAYS transaction-scoped, with or without
 *     PG_DATABASE_SESSION_URL (`pooled` is then the same target as `primary`, scoped). WORKER_DISPATCH_MODE=event then
 *     travels in the per-transaction preamble (SET LOCAL crewflow.dispatch_notify = on); behind a pooler it stays refused.
 */
import { buildPgSsl, PgSsl, PgTlsSettings, resolvePgCaCertificate } from './pg-tls';
import { parsePgUrl, PgConfigError, PgTarget, sameTarget } from './pg-url-policy';

export { PgConfigError } from './pg-url-policy';

export type PgProcessRole = 'api' | 'worker' | 'provisioner' | 'cli' | 'migrate';

/**
 * Which configured connection a caller wants:
 *   'runtime'  the API / Worker request pool: PG_DATABASE_URL, which MAY be a transaction pooler when PG_DATABASE_SESSION_URL
 *              is set (then served by the transaction-scoped client). Only core.datasource.ts's runtime pool asks for it.
 *   'primary'  a direct session of the process's login: PG_DATABASE_SESSION_URL when set, else PG_DATABASE_URL.
 *   'lock'     session advisory locks: the same direct connection (or a legacy DATABASE_DIRECT_URL outside production).
 *   'elevated' the legacy DATABASE_URL_UNPOOLED (non-production only).
 */
export type PgEndpointName = 'runtime' | 'primary' | 'lock' | 'elevated';

/** Server-side statement timeout every runtime session gets (unchanged from the previous `extra.statement_timeout`). */
export const PG_RUNTIME_STATEMENT_TIMEOUT_MS = 30_000;
/** A session left idle inside an open transaction is ended by the server after this long (new in Phase B). */
export const PG_IDLE_IN_TRANSACTION_TIMEOUT_MS = 60_000;
/** Connect timeout, also pg-pool's wait for a free connection (unchanged). */
export const PG_CONNECT_TIMEOUT_MS = 10_000;
export const PG_KEEPALIVE_INITIAL_DELAY_MS = 10_000;

export const PG_POOL_MAX_DEFAULT = 10;
export const PG_POOL_MAX_LIMIT = 100;
export const PG_POOL_IDLE_TIMEOUT_DEFAULT_MS = 600_000;
export const PG_PRIMARY_TIMEOUT_DEFAULT_MS = 30_000;
/** Client-side query timeout on the optional read replica (PG_DATABASE_REPLICA_TIMEOUT_MS), same bounds as the primary's. */
export const PG_REPLICA_TIMEOUT_DEFAULT_MS = 30_000;
/** Replica lag beyond which reads go back to the primary (PG_DATABASE_REPLICA_MAX_LAG_MS). */
export const PG_REPLICA_MAX_LAG_DEFAULT_MS = 5_000;

/** Legacy names: accepted outside production only, refused in production. */
export const LEGACY_PG_ENV_NAMES = ['DATABASE_URL', 'DATABASE_URL_UNPOOLED', 'DATABASE_DIRECT_URL', 'DB_POOL_MAX'] as const;

/**
 * X3.5-S6 (release 1), the CI-only strict switch: `PG_LEGACY_NAMES_STRICT=true` makes every environment refuse the legacy
 * names, exactly as production already does, so a CI step proves it never relies on one before release 2 (S8) refuses them
 * everywhere. Strict `true` / `false` / unset (any other value refuses to start). Off by default: outside CI nothing changes.
 */
export const PG_LEGACY_NAMES_STRICT = 'PG_LEGACY_NAMES_STRICT';

/** The legacy names that hold a non-empty value in `env` (an empty value counts as unset, as everywhere here). Names only. */
export function presentLegacyPgEnvNames(env: Env): string[] {
  return LEGACY_PG_ENV_NAMES.filter((name) => present(env, name) !== undefined);
}

/** libpq variables pg may read as fallbacks (password, options, sslnegotiation, ...). Refused in production. */
export const LIBPQ_ENV_NAMES = [
  'PGHOST',
  'PGHOSTADDR',
  'PGPORT',
  'PGUSER',
  'PGPASSWORD',
  'PGPASSFILE',
  'PGDATABASE',
  'PGSERVICE',
  'PGSERVICEFILE',
  'PGOPTIONS',
  'PGAPPNAME',
  'PGSSLMODE',
  'PGSSLROOTCERT',
  'PGSSLCERT',
  'PGSSLKEY',
  'PGSSLNEGOTIATION',
  'PGCHANNELBINDING',
  'PGCONNECT_TIMEOUT',
] as const;

/** Every PG_* key the factory reads (also used by env.validation and the admin environment viewer). */
export const PG_ENV_NAMES = [
  'PG_DATABASE_URL',
  'PG_POOL_MAX_CONNECTIONS',
  'PG_POOL_IDLE_TIMEOUT_MS',
  'PG_POOL_ALLOW_EXIT_ON_IDLE',
  'PG_DATABASE_PRIMARY_TIMEOUT_MS',
  'PG_SSL_ALLOW_SELF_SIGNED',
  'PG_SSL_CA_CERT_PATH',
  'PG_SSL_CA_CERT',
  'PG_DATABASE_URL_IS_DIRECT',
  'PG_DATABASE_SESSION_URL',
  'PG_DATABASE_REPLICA_URL',
  'PG_DATABASE_REPLICA_TIMEOUT_MS',
  'PG_DATABASE_REPLICA_MAX_LAG_MS',
] as const;

/**
 * The retired separated-mode operations container (`rab-ops`, removed in the rab-ops clean-up, PR 2 of X2.2) read these
 * names: CREWFLOW_OPS_RUN declared the ops process, PG_OPS_APP_DATABASE_URL was its restricted runtime login, and the
 * three CREWFLOW_OPS_ACTOR_* / CHANGE_REF values were its operator label. No process reads them any more. The three ops
 * commands run as one-off CLI commands of the API image under the owner login crewflow_owner, with the label from their
 * own flags (command/ops/ops-run.ts). A leftover value is never ignored: EVERY process refuses any of these names when
 * non-empty (assertNoRetiredOpsEnv), the CLI included, so an old rab-ops invocation fails closed instead of silently
 * running as something else.
 */
export const RETIRED_OPS_ENV_NAMES = [
  'CREWFLOW_OPS_RUN',
  'PG_OPS_APP_DATABASE_URL',
  'CREWFLOW_OPS_ACTOR_SOURCE',
  'CREWFLOW_OPS_ACTOR_ID',
  'CREWFLOW_OPS_CHANGE_REF',
] as const;

/** Where the replacement is documented (named in every refusal so an operator knows what to run instead). */
export const OPS_COMMANDS_RUNBOOK = 'packages/rab-docker/docs/release/OWNER-LOGIN-DEPLOYMENT.md, section 7 "Operations commands"';

/**
 * Refuses any non-empty retired operations-container variable, in every process role (api, worker, provisioner, cli,
 * migrate). Throws PgConfigError; the message names variables only, never values.
 */
export function assertNoRetiredOpsEnv(env: Env, processRole: PgProcessRole): void {
  const held = RETIRED_OPS_ENV_NAMES.filter((name) => present(env, name) !== undefined);
  if (held.length > 0) {
    throw new PgConfigError(
      `the ${processRole} process refuses the retired operations-container variable(s) ${held.join(', ')}: the rab-ops container was removed and no process reads them. The ops commands run as one-off CLI commands under the owner login crewflow_owner (${OPS_COMMANDS_RUNBOOK}). Remove them. Refusing to start.`,
    );
  }
}

/** The only processes whose runtime pool may go through a transaction pooler (with PG_DATABASE_SESSION_URL set). */
const POOLED_RUNTIME_PROCESSES: ReadonlySet<PgProcessRole> = new Set(['api', 'worker']);

export interface PgEndpoint {
  /** Variable the URL came from. */
  source: string;
  target: PgTarget;
  ssl: PgSsl;
  /** True when it came from a legacy variable name. */
  deprecated: boolean;
  /**
   * True only for the API / Worker runtime endpoint behind a transaction pooler (PG_DATABASE_URL with PG_DATABASE_SESSION_URL
   * set). The factory then serves it with the transaction-scoped client, sends no startup `-c` settings, and refuses it for
   * any session-affine use.
   */
  transactionScoped?: boolean;
}

export interface ResolvedPgEnvironment {
  production: boolean;
  processRole: PgProcessRole;
  /**
   * The process's own connection (PG_DATABASE_URL, or legacy DATABASE_URL). For the migrate / CLI / provisioner processes
   * with PG_DATABASE_SESSION_URL set, this IS the direct endpoint (they never use the pooler).
   */
  primary: PgEndpoint;
  /** Session advisory locks (Worker direct pool, scan lock, storage lock): the direct endpoint. */
  lock: PgEndpoint;
  /** PG_DATABASE_SESSION_URL (same login and database as PG_DATABASE_URL), or null when unset. */
  direct: PgEndpoint | null;
  /**
   * The transaction-pooler runtime endpoint (PG_DATABASE_URL, transactionScoped) of the API / Worker when
   * PG_DATABASE_SESSION_URL is set; null otherwise (the 'runtime' endpoint is then the primary).
   */
  pooled: PgEndpoint | null;
  /** The legacy DATABASE_URL_UNPOOLED (non-production only), or null. */
  elevated: PgEndpoint | null;
  /**
   * Optional read replica (PG_DATABASE_REPLICA_URL), validated by the same URL policy and TLS rules as the primary (verify-full
   * in production) and refused when it names the primary's target. Null when unset. The replica DataSource itself lives in
   * src/database/replica (createPgDataSource with `url`, role 'replica').
   */
  replica: PgEndpoint | null;
  /** PG_DATABASE_REPLICA_TIMEOUT_MS (client query timeout on the replica) and PG_DATABASE_REPLICA_MAX_LAG_MS. */
  replicaQueryTimeoutMs: number;
  replicaMaxLagMs: number;
  pool: { max: number; idleTimeoutMillis: number; allowExitOnIdle: boolean };
  /** Client-side query timeout (pg `query_timeout`) for runtime connections: PG_DATABASE_PRIMARY_TIMEOUT_MS. */
  queryTimeoutMs: number;
  tls: PgTlsSettings & { caPath: string | null };
  declaredDirect: boolean;
  /**
   * URL `options=-c role=<identifier>` accepted: only the migrate process, outside production, with DB_TARGET local or
   * test (the M2 restricted-migrator harness's phase-A identity). Everything else refuses it.
   */
  allowSessionRole: boolean;
  /**
   * Phase D (SQL review E-1): every writable API / Worker session carries `-c crewflow.dispatch_notify=on` when
   * WORKER_DISPATCH_MODE=event, so the dispatch-pointer triggers' pg_notify fires only then (default poll ⇒ the setting is
   * absent ⇒ zero NOTIFY). Set by the factory as a startup option — every pooled/direct (re)connection gets it; nothing a
   * request sends can choose it. Other process roles (provisioner, CLI, migrate) never set it.
   */
  dispatchNotify: boolean;
  /** Deprecation and pooler warnings. Names only, never values. */
  warnings: string[];
}

/**
 * True when an endpoint came from this process's own owner-login URL: PG_DATABASE_URL, or PG_DATABASE_SESSION_URL (the
 * direct session connection of the same login and database, which the CLI and migrations use instead of a pooled
 * PG_DATABASE_URL). Never a legacy name.
 */
export function isOwnPgDatabaseUrlSource(source: string): boolean {
  return source === 'PG_DATABASE_URL' || source === 'PG_DATABASE_SESSION_URL';
}

/** WORKER_DISPATCH_MODE as the connection factory reads it (same values as environment-variables.ts; fail closed). */
export function dispatchNotifyFor(env: Env, processRole: PgProcessRole): boolean {
  const raw = env.WORKER_DISPATCH_MODE?.trim();
  if (raw !== undefined && raw !== '' && raw !== 'poll' && raw !== 'event') {
    throw new PgConfigError('WORKER_DISPATCH_MODE must be exactly poll or event. Refusing.');
  }
  return raw === 'event' && (processRole === 'api' || processRole === 'worker');
}

export interface ResolvePgOptions {
  /** Defaults to the role this process declared through setPgProcessRole(). */
  processRole?: PgProcessRole;
  /**
   * false skips the per-process pooler refusal (still warns). env.validation runs before an entrypoint can declare its
   * role (ConfigModule validates at import time), so it checks everything else and leaves this rule to the process.
   */
  enforceProcessPolicy?: boolean;
  /** Test seam for reading the PG_SSL_CA_CERT_PATH file. */
  readFile?: (path: string) => string;
}

type Env = Record<string, string | undefined>;

let declaredProcessRole: PgProcessRole | null = null;

/**
 * Declares which process this is (`crewflow-<role>` application_name, pooler policy). Call it first in the entrypoint,
 * before any DataSource is constructed. A process that never declares one is treated as the API.
 */
export function setPgProcessRole(role: PgProcessRole): void {
  declaredProcessRole = role;
}

export function currentPgProcessRole(): PgProcessRole {
  return declaredProcessRole ?? 'api';
}

export function isPgProductionEnvironment(env: Env): boolean {
  return env.NODE_ENV === 'production' || env.RAB_RUNTIME_ENV === 'production' || env.DB_TARGET === 'production';
}

function present(env: Env, name: string): string | undefined {
  const value = env[name];
  return value !== undefined && value.trim() !== '' ? value.trim() : undefined;
}

function intSetting(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = present(env, name);
  if (raw === undefined) return fallback;
  if (!/^\d{1,10}$/.test(raw)) throw new PgConfigError(`${name} must be a whole number (got a non-numeric value). Refusing to start.`);
  const n = Number(raw);
  if (n < min || n > max) throw new PgConfigError(`${name} must be between ${min} and ${max}. Refusing to start.`);
  return n;
}

function boolSetting(env: Env, name: string): boolean {
  const raw = present(env, name);
  if (raw === undefined || raw === 'false') return false;
  if (raw === 'true') return true;
  throw new PgConfigError(`${name} must be exactly true or false. Refusing to start.`);
}

/** The raw primary URL and the variable it came from, without validation (for callers that only need presence/host). */
export function readPrimaryDatabaseUrl(env: Env = process.env): { name: 'PG_DATABASE_URL' | 'DATABASE_URL'; value: string } | null {
  const pg = present(env, 'PG_DATABASE_URL');
  if (pg) return { name: 'PG_DATABASE_URL', value: pg };
  const legacy = present(env, 'DATABASE_URL');
  if (legacy && !isPgProductionEnvironment(env)) return { name: 'DATABASE_URL', value: legacy };
  return null;
}

/** PG_DATABASE_SESSION_URL (trimmed), or null when unset. Validation is resolvePgEnvironment's. */
export function readSessionDatabaseUrl(env: Env = process.env): { name: 'PG_DATABASE_SESSION_URL'; value: string } | null {
  const value = present(env, 'PG_DATABASE_SESSION_URL');
  return value ? { name: 'PG_DATABASE_SESSION_URL', value } : null;
}

/** The optional read-replica URL (trimmed), or null when unset. Validation is resolvePgEnvironment's. */
export function readReplicaDatabaseUrl(env: Env = process.env): { name: 'PG_DATABASE_REPLICA_URL'; value: string } | null {
  const value = present(env, 'PG_DATABASE_REPLICA_URL');
  return value ? { name: 'PG_DATABASE_REPLICA_URL', value } : null;
}

/** Pure resolution. Throws PgConfigError (credential-free message) on any refused configuration. */
export function resolvePgEnvironment(env: Env = process.env, options: ResolvePgOptions = {}): ResolvedPgEnvironment {
  const production = isPgProductionEnvironment(env);
  const processRole = options.processRole ?? currentPgProcessRole();
  assertNoRetiredOpsEnv(env, processRole);
  const enforceProcessPolicy = options.enforceProcessPolicy !== false;
  const warnings: string[] = [];

  const pgUrl = present(env, 'PG_DATABASE_URL');
  const legacy = Object.fromEntries(LEGACY_PG_ENV_NAMES.map((name) => [name, present(env, name)])) as Record<(typeof LEGACY_PG_ENV_NAMES)[number], string | undefined>;

  if (!production && boolSetting(env, PG_LEGACY_NAMES_STRICT)) {
    const setLegacy = LEGACY_PG_ENV_NAMES.filter((name) => legacy[name] !== undefined);
    if (setLegacy.length > 0) {
      throw new PgConfigError(
        `${PG_LEGACY_NAMES_STRICT}=true refuses the legacy database variable(s) ${setLegacy.join(', ')}. Use PG_DATABASE_URL (and PG_POOL_MAX_CONNECTIONS) only, and remove the legacy names. Refusing to start.`,
      );
    }
  }

  if (production) {
    const setLegacy = LEGACY_PG_ENV_NAMES.filter((name) => legacy[name] !== undefined);
    if (setLegacy.length > 0) {
      throw new PgConfigError(
        `production refuses the legacy database variable(s) ${setLegacy.join(', ')}. Use PG_DATABASE_URL (and PG_POOL_MAX_CONNECTIONS) only, and remove the legacy names. Refusing to start.`,
      );
    }
    const setLibpq = LIBPQ_ENV_NAMES.filter((name) => present(env, name) !== undefined);
    if (setLibpq.length > 0) {
      throw new PgConfigError(
        `production refuses libpq environment variable(s) ${setLibpq.join(', ')}: node-postgres reads some of them as silent fallbacks. Put everything in PG_DATABASE_URL. Refusing to start.`,
      );
    }
    if (!pgUrl) throw new PgConfigError('PG_DATABASE_URL is required in production. Refusing to start.');
  }

  // The CA: PG_SSL_CA_CERT (inline PEM) or PG_SSL_CA_CERT_PATH (a file), never both; validated here, at boot (pg-tls.ts).
  const caPath = present(env, 'PG_SSL_CA_CERT_PATH') ?? null;
  const tls: ResolvedPgEnvironment['tls'] = {
    production,
    caPath,
    ...resolvePgCaCertificate(present(env, 'PG_SSL_CA_CERT'), caPath ?? undefined, options.readFile),
    allowSelfSigned: boolSetting(env, 'PG_SSL_ALLOW_SELF_SIGNED'),
  };
  const allowSessionRole = processRole === 'migrate' && !production && (env.DB_TARGET === 'local' || env.DB_TARGET === 'test');
  const endpoint = (raw: string, source: string, deprecated: boolean): PgEndpoint => {
    const target = parsePgUrl(raw, source, { allowSessionRole });
    return { source, target, ssl: buildPgSsl(target.sslmode, tls, source, target.host), deprecated };
  };

  let primary: PgEndpoint;
  if (pgUrl) {
    primary = endpoint(pgUrl, 'PG_DATABASE_URL', false);
    if (legacy.DATABASE_URL) {
      const other = parsePgUrl(legacy.DATABASE_URL, 'DATABASE_URL', { allowSessionRole });
      if (!sameTarget(primary.target, other)) {
        throw new PgConfigError(
          'PG_DATABASE_URL and the legacy DATABASE_URL are both set and name different targets (user, host, port or database). Remove DATABASE_URL. Refusing to start.',
        );
      }
      warnings.push('DATABASE_URL is deprecated and redundant next to PG_DATABASE_URL; remove it.');
    }
  } else if (legacy.DATABASE_URL) {
    primary = endpoint(legacy.DATABASE_URL, 'DATABASE_URL', true);
    warnings.push('DATABASE_URL is deprecated; set PG_DATABASE_URL instead (production accepts only PG_DATABASE_URL).');
  } else {
    throw new PgConfigError('PG_DATABASE_URL is required (outside production the deprecated DATABASE_URL is still accepted). Refusing to start.');
  }

  let lock = primary;
  const directUrl = present(env, 'PG_DATABASE_SESSION_URL');
  if (directUrl && legacy.DATABASE_DIRECT_URL) {
    throw new PgConfigError('PG_DATABASE_SESSION_URL and the legacy DATABASE_DIRECT_URL are both set. Remove DATABASE_DIRECT_URL. Refusing to start.');
  }
  if (legacy.DATABASE_DIRECT_URL) {
    const direct = endpoint(legacy.DATABASE_DIRECT_URL, 'DATABASE_DIRECT_URL', true);
    if (pgUrl) {
      if (!sameTarget(primary.target, direct.target)) {
        throw new PgConfigError(
          'PG_DATABASE_URL and the legacy DATABASE_DIRECT_URL are both set and name different targets. PG_DATABASE_URL must itself be a direct connection; remove DATABASE_DIRECT_URL. Refusing to start.',
        );
      }
      warnings.push('DATABASE_DIRECT_URL is deprecated and redundant next to PG_DATABASE_URL; remove it.');
    } else {
      if (direct.target.database !== primary.target.database) {
        throw new PgConfigError('DATABASE_URL and DATABASE_DIRECT_URL name different databases. Refusing to start.');
      }
      lock = direct;
      warnings.push('DATABASE_DIRECT_URL is deprecated; point PG_DATABASE_URL at a direct (non-pooled) connection instead.');
    }
  }

  let elevated: PgEndpoint | null = null;
  if (legacy.DATABASE_URL_UNPOOLED) {
    elevated = endpoint(legacy.DATABASE_URL_UNPOOLED, 'DATABASE_URL_UNPOOLED', true);
    warnings.push('DATABASE_URL_UNPOOLED is deprecated (non-production only); the migration step uses its own PG_DATABASE_URL.');
  }

  const poolMaxNew = intSetting(env, 'PG_POOL_MAX_CONNECTIONS', PG_POOL_MAX_DEFAULT, 1, PG_POOL_MAX_LIMIT);
  let poolMax = poolMaxNew;
  if (legacy.DB_POOL_MAX !== undefined) {
    const poolMaxLegacy = intSetting(env, 'DB_POOL_MAX', PG_POOL_MAX_DEFAULT, 1, PG_POOL_MAX_LIMIT);
    if (present(env, 'PG_POOL_MAX_CONNECTIONS') !== undefined && poolMaxLegacy !== poolMaxNew) {
      throw new PgConfigError('PG_POOL_MAX_CONNECTIONS and the legacy DB_POOL_MAX are both set and differ. Remove DB_POOL_MAX. Refusing to start.');
    }
    poolMax = poolMaxLegacy;
    warnings.push('DB_POOL_MAX is deprecated; set PG_POOL_MAX_CONNECTIONS instead.');
  }

  const queryTimeoutMs = intSetting(env, 'PG_DATABASE_PRIMARY_TIMEOUT_MS', PG_PRIMARY_TIMEOUT_DEFAULT_MS, PG_RUNTIME_STATEMENT_TIMEOUT_MS, 3_600_000);
  const replicaQueryTimeoutMs = intSetting(env, 'PG_DATABASE_REPLICA_TIMEOUT_MS', PG_REPLICA_TIMEOUT_DEFAULT_MS, PG_RUNTIME_STATEMENT_TIMEOUT_MS, 3_600_000);
  // Same bounds as the replica service (src/database/runtime/replica/pg-replica.service.ts): 100 ms .. 10 min.
  const replicaMaxLagMs = intSetting(env, 'PG_DATABASE_REPLICA_MAX_LAG_MS', PG_REPLICA_MAX_LAG_DEFAULT_MS, 100, 600_000);
  let replica: PgEndpoint | null = null;
  const replicaUrl = readReplicaDatabaseUrl(env);
  if (replicaUrl) {
    // Never a session role on a replica, whatever the process: it is a read path of the runtime role only.
    const target = parsePgUrl(replicaUrl.value, replicaUrl.name, { allowSessionRole: false });
    replica = { source: replicaUrl.name, target, ssl: buildPgSsl(target.sslmode, tls, replicaUrl.name, target.host), deprecated: false };
    if (sameTarget(primary.target, target)) {
      throw new PgConfigError('PG_DATABASE_REPLICA_URL names the primary (same user, host, port and database). Unset it, or point it at a standby. Refusing to start.');
    }
  }
  const declaredDirect = boolSetting(env, 'PG_DATABASE_URL_IS_DIRECT');
  const dispatchNotify = dispatchNotifyFor(env, processRole);

  // Transaction pooler support (see the header): decided by the explicit PG_DATABASE_SESSION_URL, never by a host name.
  let direct: PgEndpoint | null = null;
  let pooled: PgEndpoint | null = null;
  if (directUrl) {
    if (declaredDirect) {
      throw new PgConfigError(
        'PG_DATABASE_URL_IS_DIRECT=true contradicts PG_DATABASE_SESSION_URL (which says PG_DATABASE_URL is a pooler). Remove one of them. Refusing to start.',
      );
    }
    direct = endpoint(directUrl, 'PG_DATABASE_SESSION_URL', false);
    if (direct.target.user !== primary.target.user || direct.target.database !== primary.target.database) {
      throw new PgConfigError(
        'PG_DATABASE_SESSION_URL must name the same login and database as PG_DATABASE_URL (only the host and port may differ: the direct connection of the same database). Values not shown. Refusing to start.',
      );
    }
    if (sameTarget(primary.target, direct.target)) {
      throw new PgConfigError(
        'PG_DATABASE_SESSION_URL names the same host, port, login and database as PG_DATABASE_URL. Unset it: PG_DATABASE_URL is then the direct connection. Refusing to start.',
      );
    }
    if (POOLED_RUNTIME_PROCESSES.has(processRole)) {
      if (dispatchNotify) {
        throw new PgConfigError(
          'WORKER_DISPATCH_MODE=event is refused with PG_DATABASE_SESSION_URL (a transaction-pooled runtime): its NOTIFY switch is a per-session startup setting, which a transaction pooler does not keep. Use WORKER_DISPATCH_MODE=poll (the default). Refusing to start.',
        );
      }
      pooled = { ...primary, transactionScoped: true };
      primary = pooled;
    } else {
      // Migrations, the CLI and the provisioner never use the pooler: their primary IS the direct connection.
      primary = direct;
    }
    lock = direct;
  } else if (production && POOLED_RUNTIME_PROCESSES.has(processRole)) {
    // Security review L-1: in production the API / Worker runtime pool is ALWAYS served by the transaction-scoped client,
    // pooler or not (an undetected pooler, or a silently dropped startup option, can then never undo the per-transaction
    // RESET ROLE + assertion). A separate endpoint object: 'primary' (boot gates, probes, the lock endpoint) stays a plain
    // direct session with its startup settings; only 'runtime' is scoped. The NOTIFY switch travels per transaction too.
    pooled = { ...primary, transactionScoped: true };
  }
  // Security review I-4: a session-role startup option can never ride on a transaction-scoped endpoint.
  if (pooled?.target.sessionRoleOption) {
    throw new PgConfigError('PG_DATABASE_URL carries a session role option (-c role=...), which a transaction-scoped runtime endpoint refuses. Refusing to start.');
  }

  return {
    production,
    processRole,
    primary,
    lock,
    direct,
    pooled,
    elevated,
    replica,
    replicaQueryTimeoutMs,
    replicaMaxLagMs,
    pool: {
      max: poolMax,
      idleTimeoutMillis: intSetting(env, 'PG_POOL_IDLE_TIMEOUT_MS', PG_POOL_IDLE_TIMEOUT_DEFAULT_MS, 0, 86_400_000),
      allowExitOnIdle: boolSetting(env, 'PG_POOL_ALLOW_EXIT_ON_IDLE'),
    },
    queryTimeoutMs,
    tls,
    declaredDirect,
    allowSessionRole,
    dispatchNotify,
    warnings,
  };
}

/**
 * The migration connection (core.datasource.ts and the migrate runner agree on it). The migration process takes its own
 * PG_DATABASE_URL. Outside production, without PG_DATABASE_URL, the deprecated DATABASE_URL_UNPOOLED still names the
 * elevated connection (else DATABASE_URL). No silent preference:
 *   - PG_DATABASE_URL and DATABASE_URL_UNPOOLED both set and naming different targets → refused;
 *   - production: a PG_DATABASE_URL identical to the value in the .env file → refused (production authority comes from the
 *     deployment environment, never a developer file). `dotenvValues` is that file read as data.
 */
export function selectMigrationEndpoint(
  resolved: ResolvedPgEnvironment,
  env: Env,
  dotenvValues: Record<string, string> = {},
): { name: 'elevated' | 'primary'; endpoint: PgEndpoint } {
  const pgUrl = present(env, 'PG_DATABASE_URL');
  if (pgUrl && resolved.elevated && !sameTarget(resolved.primary.target, resolved.elevated.target)) {
    throw new PgConfigError(
      'PG_DATABASE_URL and the deprecated DATABASE_URL_UNPOOLED are both set and name different targets. The migration process takes PG_DATABASE_URL only; remove DATABASE_URL_UNPOOLED. Refusing.',
    );
  }
  if (resolved.production && pgUrl && dotenvValues.PG_DATABASE_URL !== undefined && dotenvValues.PG_DATABASE_URL.trim() === pgUrl) {
    throw new PgConfigError('PG_DATABASE_URL comes from the .env file. Production authority must come from the deployment environment. Refusing.');
  }
  if (pgUrl || !resolved.elevated) return { name: 'primary', endpoint: resolved.primary };
  return { name: 'elevated', endpoint: resolved.elevated };
}

const emittedWarnings = new Set<string>();

/**
 * Prints each warning once per process, in every environment. X3.5-S6 (audit DBR-08), release 1: it used to be silent under
 * NODE_ENV=test because the Jest setup filled the legacy names from the TEST pair; the Jest setup now routes through
 * PG_DATABASE_URL only (test-database-guard.ts), and both Jest globalSetups refuse a routed environment that still holds a
 * legacy name (routedTestDatabaseLegacyNames), so a deprecation line under test is a real finding, not noise. `env` is kept
 * for the call sites; it no longer changes the behaviour.
 */
export function emitPgWarnings(resolved: ResolvedPgEnvironment, _env: Env = process.env, sink: (line: string) => void = (l) => console.warn(l)): void {
  for (const warning of resolved.warnings) {
    if (emittedWarnings.has(warning)) continue;
    emittedWarnings.add(warning);
    sink(`[pg-config] warning: ${warning}`);
  }
}

const RELEVANT_ENV_NAMES = [...PG_ENV_NAMES, PG_LEGACY_NAMES_STRICT, ...LEGACY_PG_ENV_NAMES, ...LIBPQ_ENV_NAMES, ...RETIRED_OPS_ENV_NAMES, 'NODE_ENV', 'RAB_RUNTIME_ENV', 'DB_TARGET', 'WORKER_DISPATCH_MODE'];
const cache = new Map<string, ResolvedPgEnvironment>();

/**
 * resolvePgEnvironment + emitPgWarnings, memoised on the relevant environment values (DataSource option getters call it
 * repeatedly). Errors are not cached: a fixed environment resolves on the next call.
 */
export function resolvePgEnvironmentCached(env: Env = process.env, options: ResolvePgOptions = {}): ResolvedPgEnvironment {
  const processRole = options.processRole ?? currentPgProcessRole();
  const key = JSON.stringify([processRole, options.enforceProcessPolicy !== false, ...RELEVANT_ENV_NAMES.map((n) => env[n] ?? null)]);
  const hit = cache.get(key);
  if (hit) return hit;
  const resolved = resolvePgEnvironment(env, { ...options, processRole });
  emitPgWarnings(resolved, env);
  if (cache.size > 32) cache.clear();
  cache.set(key, resolved);
  return resolved;
}
