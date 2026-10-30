/**
 * Phase B (B1): resolves the database configuration of THIS process from its environment. Pure apart from reading the
 * CA file named by PG_SSL_CA_CERT_PATH; no connection is made here.
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
 *     - a legacy DATABASE_URL_UNPOOLED still names the elevated connection that migrations and the three owner CLI
 *       commands use (deprecated);
 *     - DB_POOL_MAX is accepted for PG_POOL_MAX_CONNECTIONS (deprecated, now strictly validated); both set and
 *       different → refused.
 *   Every number is validated strictly (digits only, bounded); a bad value refuses to start instead of falling back
 *   (the old `Number(DB_POOL_MAX) > 0 ? … : 10` silently ignored typos).
 *
 * Pooler policy (P4): a documented transaction-pooler URL shape is refused for the processes that take session
 * advisory locks (worker, provisioner, migrate) and for any connection requested with session affinity; the API and the
 * CLI get a warning. PG_DATABASE_URL_IS_DIRECT=true on a pooler-shaped URL is a contradiction and is refused. The flag
 * never skips the Worker's live session probe (pg-session-probe.ts).
 */
import { buildPgSsl, PgSsl, PgTlsSettings, readPgCaCertificate } from './pg-tls';
import { parsePgUrl, PgConfigError, PgTarget, sameTarget } from './pg-url-policy';

export { PgConfigError } from './pg-url-policy';

export type PgProcessRole = 'api' | 'worker' | 'provisioner' | 'cli' | 'migrate' | 'ops';

/** Which configured connection a caller wants. */
export type PgEndpointName = 'primary' | 'lock' | 'elevated';

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
  'PG_DATABASE_URL_IS_DIRECT',
  'PG_DATABASE_REPLICA_URL',
  'PG_DATABASE_REPLICA_TIMEOUT_MS',
  'PG_DATABASE_REPLICA_MAX_LAG_MS',
] as const;

/**
 * Phase B (ops): the one-off OPERATIONS container (the three owner CLI commands: containment, hws:backfill,
 * user-session:backfill). Same pattern as rab-migrate: a short-lived container with its own environment, never the API,
 * the Worker, the provisioner or the migrate step. In it:
 *   - CREWFLOW_OPS_RUN=one-off declares the ops process (exactly that value; anything else refuses);
 *   - PG_OPS_APP_DATABASE_URL is the ordinary restricted runtime login (crewflow_app) and becomes the PRIMARY endpoint (the
 *     injected DataSource, the boot gates, every tenant-context write). It is the normal runtime credential, not a new
 *     privileged one;
 *   - PG_DATABASE_URL, when present, is the migration identity (crewflow_migrator) and becomes the ELEVATED endpoint, used
 *     only by command/ops/elevated-ops-session.ts (SET LOCAL ROLE to a narrow owner role, verified, frozen statements).
 *     Commands and modes that need no elevated session refuse its presence (minimum privilege: do not hand it over);
 *   - CREWFLOW_OPS_ACTOR_SOURCE / CREWFLOW_OPS_ACTOR_ID / CREWFLOW_OPS_CHANGE_REF: the operational audit label (required by
 *     every ops command, command/ops/ops-run.ts).
 * Every other process refuses ALL of these names (non-empty): the ops credential and label never reach a runtime container.
 * The legacy names and the read replica are refused in the ops process in every environment (no legacy path exists for it).
 */
export const OPS_RUN_VAR = 'CREWFLOW_OPS_RUN';
export const OPS_RUN_VALUE = 'one-off';
export const OPS_APP_DATABASE_URL_VAR = 'PG_OPS_APP_DATABASE_URL';
export const OPS_ACTOR_ENV_NAMES = ['CREWFLOW_OPS_ACTOR_SOURCE', 'CREWFLOW_OPS_ACTOR_ID', 'CREWFLOW_OPS_CHANGE_REF'] as const;
/** Names only the one-off operations container may hold (refused, when non-empty, by every other process). */
export const OPS_ONLY_ENV_NAMES = [OPS_RUN_VAR, OPS_APP_DATABASE_URL_VAR, ...OPS_ACTOR_ENV_NAMES] as const;

/**
 * True when THIS resolution is the ops process: the declared role is `ops`, or a `cli` resolution with CREWFLOW_OPS_RUN set
 * (the CLI boot gates and the command target guard resolve as `cli`; inside the ops container that IS the ops process).
 * Throws for a malformed CREWFLOW_OPS_RUN, for `ops` without it, and for any ops-only name in every other process.
 */
export function resolveOpsMode(env: Env, processRole: PgProcessRole): boolean {
  const run = present(env, OPS_RUN_VAR);
  if (run !== undefined && run !== OPS_RUN_VALUE) {
    throw new PgConfigError(`${OPS_RUN_VAR} must be unset or exactly "${OPS_RUN_VALUE}". Refusing to start.`);
  }
  if (processRole === 'ops' || (processRole === 'cli' && run !== undefined)) {
    if (run === undefined) {
      throw new PgConfigError(`the ops process requires ${OPS_RUN_VAR}=${OPS_RUN_VALUE} (the one-off operations container only). Refusing to start.`);
    }
    return true;
  }
  const held = OPS_ONLY_ENV_NAMES.filter((name) => present(env, name) !== undefined);
  if (held.length > 0) {
    throw new PgConfigError(
      `the ${processRole} process refuses the operations-container variable(s) ${held.join(', ')}: they belong to the one-off ops container only (never the API, the Worker, the provisioner, the migrate step or an ordinary CLI run). Remove them. Refusing to start.`,
    );
  }
  return false;
}

/** Processes that hold session advisory locks: a transaction pooler is refused for them. */
const SESSION_LOCK_PROCESSES: ReadonlySet<PgProcessRole> = new Set(['worker', 'provisioner', 'migrate']);

export interface PgEndpoint {
  /** Variable the URL came from. */
  source: string;
  target: PgTarget;
  ssl: PgSsl;
  /** True when it came from a legacy variable name. */
  deprecated: boolean;
}

export interface ResolvedPgEnvironment {
  production: boolean;
  processRole: PgProcessRole;
  /** The process's own connection (PG_DATABASE_URL, or legacy DATABASE_URL). */
  primary: PgEndpoint;
  /** Session advisory locks (Worker direct pool, scan lock, storage lock). The primary unless a legacy DIRECT URL is set. */
  lock: PgEndpoint;
  /**
   * The ops process: PG_DATABASE_URL (the migration identity, used only by the verified elevated ops session,
   * command/ops/elevated-ops-session.ts). Every other process: the legacy DATABASE_URL_UNPOOLED (non-production only), or null.
   */
  elevated: PgEndpoint | null;
  /** True for the one-off operations container (resolveOpsMode); `processRole` is then 'ops'. */
  ops: boolean;
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
  /** Deprecation and pooler warnings. Names only, never values. */
  warnings: string[];
}

export interface ResolvePgOptions {
  /** Defaults to the role this process declared through setPgProcessRole(). */
  processRole?: PgProcessRole;
  /**
   * false skips the per-process pooler refusal (still warns). env.validation runs before an entrypoint can declare its
   * role (ConfigModule validates at import time), so it checks everything else and leaves this rule to the process.
   */
  enforceProcessPolicy?: boolean;
  /** Test seam for PG_SSL_CA_CERT_PATH. */
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

/** The optional read-replica URL (trimmed), or null when unset. Validation is resolvePgEnvironment's. */
export function readReplicaDatabaseUrl(env: Env = process.env): { name: 'PG_DATABASE_REPLICA_URL'; value: string } | null {
  const value = present(env, 'PG_DATABASE_REPLICA_URL');
  return value ? { name: 'PG_DATABASE_REPLICA_URL', value } : null;
}

/** Pure resolution. Throws PgConfigError (credential-free message) on any refused configuration. */
export function resolvePgEnvironment(env: Env = process.env, options: ResolvePgOptions = {}): ResolvedPgEnvironment {
  const production = isPgProductionEnvironment(env);
  const declaredRole = options.processRole ?? currentPgProcessRole();
  const ops = resolveOpsMode(env, declaredRole);
  const processRole: PgProcessRole = ops ? 'ops' : declaredRole;
  const enforceProcessPolicy = options.enforceProcessPolicy !== false;
  const warnings: string[] = [];

  const pgUrl = present(env, 'PG_DATABASE_URL');
  const legacy = Object.fromEntries(LEGACY_PG_ENV_NAMES.map((name) => [name, present(env, name)])) as Record<(typeof LEGACY_PG_ENV_NAMES)[number], string | undefined>;

  if (ops) {
    const setLegacy = LEGACY_PG_ENV_NAMES.filter((name) => legacy[name] !== undefined);
    if (setLegacy.length > 0) {
      throw new PgConfigError(`the ops process refuses the legacy database variable(s) ${setLegacy.join(', ')} in every environment. Refusing to start.`);
    }
    if (present(env, 'PG_DATABASE_REPLICA_URL') !== undefined) {
      throw new PgConfigError('the ops process refuses PG_DATABASE_REPLICA_URL (it has no replica path). Refusing to start.');
    }
    if (present(env, OPS_APP_DATABASE_URL_VAR) === undefined) {
      throw new PgConfigError(`the ops process requires ${OPS_APP_DATABASE_URL_VAR} (the restricted runtime login). Refusing to start.`);
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
    if (!pgUrl && !ops) throw new PgConfigError('PG_DATABASE_URL is required in production. Refusing to start.');
  }

  const caPath = present(env, 'PG_SSL_CA_CERT_PATH') ?? null;
  const tls: ResolvedPgEnvironment['tls'] = {
    production,
    caPath,
    caPem: caPath ? readPgCaCertificate(caPath, options.readFile) : null,
    allowSelfSigned: boolSetting(env, 'PG_SSL_ALLOW_SELF_SIGNED'),
  };
  const allowSessionRole = processRole === 'migrate' && !production && (env.DB_TARGET === 'local' || env.DB_TARGET === 'test');
  const endpoint = (raw: string, source: string, deprecated: boolean): PgEndpoint => {
    const target = parsePgUrl(raw, source, { allowSessionRole });
    return { source, target, ssl: buildPgSsl(target.sslmode, tls, source), deprecated };
  };

  let primary: PgEndpoint;
  let opsElevated: PgEndpoint | null = null;
  if (ops) {
    primary = endpoint(present(env, OPS_APP_DATABASE_URL_VAR)!, OPS_APP_DATABASE_URL_VAR, false);
    if (pgUrl) {
      opsElevated = endpoint(pgUrl, 'PG_DATABASE_URL', false);
      const a = primary.target;
      const b = opsElevated.target;
      if (a.host.toLowerCase() !== b.host.toLowerCase() || a.port !== b.port || a.database !== b.database) {
        throw new PgConfigError(
          `${OPS_APP_DATABASE_URL_VAR} and PG_DATABASE_URL name different databases (host, port or database): the ops command would split its connections. Refusing to start.`,
        );
      }
      if (a.user === b.user) {
        throw new PgConfigError(
          `${OPS_APP_DATABASE_URL_VAR} and PG_DATABASE_URL name the same login. PG_DATABASE_URL is the migration identity; ${OPS_APP_DATABASE_URL_VAR} is the restricted runtime login. Refusing to start.`,
        );
      }
      if (b.transactionPooler) {
        throw new PgConfigError(
          `PG_DATABASE_URL has a documented transaction-pooler shape (${b.transactionPooler.reason}); the ops elevated session needs a direct connection. Refusing to start.`,
        );
      }
    }
  } else if (pgUrl) {
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

  let elevated: PgEndpoint | null = opsElevated;
  if (!ops && legacy.DATABASE_URL_UNPOOLED) {
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
    replica = { source: replicaUrl.name, target, ssl: buildPgSsl(target.sslmode, tls, replicaUrl.name), deprecated: false };
    if (sameTarget(primary.target, target)) {
      throw new PgConfigError('PG_DATABASE_REPLICA_URL names the primary (same user, host, port and database). Unset it, or point it at a standby. Refusing to start.');
    }
  }
  const declaredDirect = boolSetting(env, 'PG_DATABASE_URL_IS_DIRECT');

  for (const ep of lock === primary ? [primary] : [primary, lock]) {
    const pooler = ep.target.transactionPooler;
    if (pooler) {
      if (declaredDirect) {
        throw new PgConfigError(
          `PG_DATABASE_URL_IS_DIRECT=true, but ${ep.source} has a documented transaction-pooler shape (${pooler.reason}). Refusing to start.`,
        );
      }
      // Any OTHER process asking for a session-affine connection (the CLI's storage lock) is refused when it asks for it
      // (create-pg-pool.ts, sessionAffinity).
      if (enforceProcessPolicy && SESSION_LOCK_PROCESSES.has(processRole)) {
        throw new PgConfigError(
          `${ep.source} has a documented transaction-pooler shape (${pooler.reason}). The ${processRole} process holds session advisory locks, which a transaction pooler cannot keep. Use a direct connection. Refusing to start.`,
        );
      }
      warnings.push(
        `${ep.source} has a transaction-pooler shape (${pooler.reason}). Session state is not kept across transactions, and PgBouncer-style poolers may reject the per-session startup options (statement_timeout, idle_in_transaction_session_timeout).`,
      );
    } else if (ep.target.poolerSuspicion) {
      warnings.push(`${ep.source} may point at a connection pooler (${ep.target.poolerSuspicion}); the Worker's session probe decides.`);
    }
  }

  return {
    production,
    processRole,
    primary,
    lock,
    elevated,
    ops,
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
 * Prints each warning once per process. Silent under NODE_ENV=test: the Jest setup deliberately fills the legacy names
 * from TEST_DATABASE_URL, so every spec file would otherwise repeat the same deprecation notice.
 */
export function emitPgWarnings(resolved: ResolvedPgEnvironment, env: Env = process.env, sink: (line: string) => void = (l) => console.warn(l)): void {
  if (env.NODE_ENV === 'test') return;
  for (const warning of resolved.warnings) {
    if (emittedWarnings.has(warning)) continue;
    emittedWarnings.add(warning);
    sink(`[pg-config] warning: ${warning}`);
  }
}

const RELEVANT_ENV_NAMES = [...PG_ENV_NAMES, ...LEGACY_PG_ENV_NAMES, ...LIBPQ_ENV_NAMES, ...OPS_ONLY_ENV_NAMES, 'NODE_ENV', 'RAB_RUNTIME_ENV', 'DB_TARGET'];
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
