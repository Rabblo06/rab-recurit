/**
 * Explicit database target model for every production-capable command: migrations (setup-db.ts, the locked runner and the
 * TypeORM CLI), the nest-commander CLI (bootstrap-admin, grant-platform-admin, storage-reconcile, seed, ...) and
 * `db:bind-identity`.
 *
 * Nothing here trusts packages/rab-server/.env. Production authority is refused when it comes from that file.
 *
 *   DB_TARGET=local|test|staging|production   required for every guarded command, no default
 *   production additionally needs, all from the process environment:
 *     DB_TARGET=production AND ALLOW_PRODUCTION_DB_COMMANDS=true
 *     CREWFLOW_DEPLOYMENT_ENVIRONMENT=production AND CREWFLOW_DEPLOYMENT_ID=<uuid>
 *   and the DATABASE must agree: its protected deployment identity marker (core.deployment_identity, read through the
 *   SECURITY DEFINER core.deployment_identity_check(); see ../../deployment-identity/deployment-identity.ts) must be bound
 *   to environment=production with the same deployment id. PG_EXPECTED_DATABASE_NAME, when set, must equal
 *   current_database() (Option A secondary).
 *
 * Phase B / B3 replaced the Neon endpoint pin (EXPECTED_PRODUCTION_IDENTITY: endpoint ep-round-rain-aess0njf, database
 * neondb). Production is decided by the marker plus the declared deployment identity, never by NODE_ENV, a hostname or an
 * endpoint name alone. A non-production target (local / test) is refused by the live check when the database is bound to
 * production (a clone of production must be rebound with production command authority first).
 *
 * First bind of a fresh production database (the marker migration not applied yet, or applied but unbound): refused unless
 * CREWFLOW_DEPLOYMENT_IDENTITY_BOOTSTRAP=unbound-production-database AND PG_EXPECTED_DATABASE_NAME are set in the process
 * environment (never .env). That bootstrap lets the migration runner apply DeploymentIdentity1786721230000 and
 * `db:bind-identity` bind the database; once bound, the flag is itself a refusal.
 *
 * Order, all before any write: resolve (pure, no connection) -> read-only probe (SELECT only, opened with
 * default_transaction_read_only: database, cluster id, deployment marker) -> print a sanitised summary. No session is
 * terminated and no data is changed here. Messages never contain a URL, password or username; they show variable names,
 * hosts, database names, environments and deployment ids only.
 *
 * Staging has no command path yet, so DB_TARGET=staging stays refused (fail closed).
 *
 * Connections (Phase B / B1): this guard never reads a database URL variable itself and never builds its own client. The
 * shared factory (src/database/postgres) resolves the process's connections — PG_DATABASE_URL, or outside production the
 * deprecated DATABASE_URL (+ DATABASE_URL_UNPOOLED as the elevated migration connection) — with the same URL policy, TLS
 * and startup options the real pools use, and the probe is a factory client opened read-only. The migration endpoint is
 * the factory's selectMigrationEndpoint rule (core.datasource.ts and the locked runner apply the same one).
 *
 * A marker the login may not read (SQLSTATE 42501 — e.g. a migration login without its owner-role memberships, which has
 * no USAGE on schema core): the migration DataSource and the locked runner pass `deferUnreadableMarker`, so the CF-41
 * migration-identity check (migration-identity.ts) reports the refusal it exists for. The deferral is never a pass: the
 * caller must run the full marker check on its own session after CF-41 and refuse when it still fails
 * (assertDeferredDeploymentIdentity). Every other caller (the CLI, db:bind-identity, migrate-workspace-schemas) refuses
 * at once.
 */
import * as fs from 'fs';
import * as path from 'path';

import { parse as parseDotenv } from 'dotenv';

import {
  createPgClient,
  describePgTarget,
  PgConfigError,
  PgEndpointName,
  PgProcessRole,
  PgTargetIdentity,
  readPrimaryDatabaseUrl,
  resolvePgEnvironmentCached,
  ResolvedPgEnvironment,
  selectMigrationEndpoint,
} from '../../postgres';
import {
  assertDeclaredIdentityForProcess,
  assertDeploymentIdentity,
  DeclaredDeploymentIdentity,
  DEPLOYMENT_ENVIRONMENT_VAR,
  DEPLOYMENT_ID_VAR,
  DeploymentIdentityError,
  EXPECTED_DATABASE_NAME_VAR,
  IDENTITY_BOOTSTRAP_VAR,
  isInsufficientPrivilege,
  isRemoteDatabaseHost,
  Query,
  readBootstrapFlag,
} from '../../deployment-identity/deployment-identity';
import { unmarkedProductionRefusal } from '../../deployment-identity/unmarked-production-endpoints';

export const DB_TARGETS = ['local', 'test', 'staging', 'production'] as const;
export type DbTarget = (typeof DB_TARGETS)[number];

export const ALLOW_PRODUCTION_DB_COMMANDS = 'ALLOW_PRODUCTION_DB_COMMANDS';

/** Purposes that run AS the migration identity (`db:bind-identity` is bind-deployment-identity.ts's BIND_COMMAND). */
const BIND_IDENTITY_PURPOSE = 'db:bind-identity';
const MIGRATION_IDENTITY_PURPOSES: ReadonlySet<string> = new Set(['migrations', BIND_IDENTITY_PURPOSE]);

/** Where a migration-identity session connects: the factory's parse of the endpoint selectMigrationEndpoint chose. */
export interface MigrationSessionLocation {
  app: { host?: string };
  admin?: { host?: string } | null;
  migrationEndpoint?: 'primary' | 'elevated';
}

/** The host a migration-identity session connects to, as the factory parsed it ('' when unknown: never a location match). */
export function migrationConnectionHost(resolved: MigrationSessionLocation): string {
  return (resolved.migrationEndpoint === 'elevated' && resolved.admin ? resolved.admin : resolved.app).host ?? '';
}

export interface DbTargetInput {
  purpose: string;
  env: Record<string, string | undefined>;
  /** Values parsed from packages/rab-server/.env, used only to refuse production authority that came from that file. */
  dotenvValues: Record<string, string>;
  /** Factory process role. Default: `migrate` for migrations and db:bind-identity, `cli` for everything else. */
  processRole?: PgProcessRole;
}

export interface ResolvedDbTarget {
  purpose: string;
  target: DbTarget;
  classification: 'PRODUCTION' | 'NON-PRODUCTION';
  /** The process's primary connection (PG_DATABASE_URL, or the deprecated DATABASE_URL outside production). */
  app: PgTargetIdentity;
  /** The deprecated elevated connection (DATABASE_URL_UNPOOLED, non-production only), or null. */
  admin: PgTargetIdentity | null;
  /** The factory resolution every connection of this command must use. */
  pg: ResolvedPgEnvironment;
  /** The endpoint a migration-identity command connects with (selectMigrationEndpoint); 'primary' for the CLI. */
  migrationEndpoint: 'primary' | 'elevated';
  /** The declared deployment identity (required for production, optional elsewhere). */
  declared: DeclaredDeploymentIdentity | null;
  /** True only for a production target with the one-time bootstrap flag set (validated live against the marker). */
  bootstrapRequested: boolean;
}

export class DbTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DbTargetError';
  }
}

function asTargetError<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof DeploymentIdentityError || error instanceof PgConfigError) throw new DbTargetError(error.message);
    throw error;
  }
}

function isLocalHost(identity: PgTargetIdentity): boolean {
  // Loopback, or a listed compose database service such as `postgres` (final review F4: any other single-label name is
  // remote). Security review N-4: the one shared host rule (deployment-identity.ts isRemoteDatabaseHost) — a dotted name
  // and a non-loopback IPv6 literal such as `fd00::5` (no dot) are remote.
  return !isRemoteDatabaseHost(identity.host);
}

/**
 * Production authority and identity variables that must never come from packages/rab-server/.env (checked for
 * DB_TARGET=production only). Security review L-2 follow-up: the per-release migration approval is authority too (Nx
 * injects packages/rab-server/.env into `nx run rab-server:migration:run`), so a standing approval in that file refuses
 * every production command, not only setup-db (setup-db.ts also checks its own dotenv sources before connecting).
 */
export const PRODUCTION_AUTHORITY_VARS: readonly string[] = [
  'DB_TARGET',
  ALLOW_PRODUCTION_DB_COMMANDS,
  'CREWFLOW_MIGRATION_APPROVED',
  DEPLOYMENT_ENVIRONMENT_VAR,
  DEPLOYMENT_ID_VAR,
  IDENTITY_BOOTSTRAP_VAR,
  EXPECTED_DATABASE_NAME_VAR,
];

/** Pure resolution. No connection. Throws DbTargetError with a message that never contains a URL or credential. */
export function resolveDbTarget(input: DbTargetInput): ResolvedDbTarget {
  const { purpose, env, dotenvValues } = input;
  const rawTarget = env.DB_TARGET?.trim();
  if (!rawTarget) {
    throw new DbTargetError(`DB_TARGET is required for ${purpose}. Set one of: ${DB_TARGETS.join(', ')}. No default is assumed.`);
  }
  if (!(DB_TARGETS as readonly string[]).includes(rawTarget)) {
    throw new DbTargetError(`DB_TARGET "${rawTarget}" is not recognised. Set one of: ${DB_TARGETS.join(', ')}.`);
  }
  const target = rawTarget as DbTarget;
  const production = target === 'production';

  if (production && env[ALLOW_PRODUCTION_DB_COMMANDS] !== 'true') {
    throw new DbTargetError(
      `production ${purpose} requires DB_TARGET=production AND ${ALLOW_PRODUCTION_DB_COMMANDS}=true in the process environment. Refusing.`,
    );
  }

  // The factory decides which connections exist and validates every URL (target overrides, TLS, legacy names refused in
  // production). The pooler rule belongs to the process's real connection (enforced where that is built), not this guard.
  const migrationIdentity = MIGRATION_IDENTITY_PURPOSES.has(purpose);
  const processRole = input.processRole ?? (migrationIdentity ? 'migrate' : 'cli');
  const pg = asTargetError(() => resolvePgEnvironmentCached(env, { processRole, enforceProcessPolicy: false }));
  const migrationEndpoint = migrationIdentity ? asTargetError(() => selectMigrationEndpoint(pg, env, production ? dotenvValues : {})).name : 'primary';
  const app = describePgTarget(pg.primary.target);
  const admin = pg.elevated ? describePgTarget(pg.elevated.target) : null;
  if (admin && (admin.database !== app.database || admin.endpointKey !== app.endpointKey)) {
    throw new DbTargetError(
      `${app.label} and ${admin.label} resolve to different databases or endpoints (${app.database}@${app.endpointKey} vs ${admin.database}@${admin.endpointKey}). Refusing: the command would split its connections.`,
    );
  }

  if (production) {
    const primaryValue = readPrimaryDatabaseUrl(env)?.value;
    const fromDotenv =
      PRODUCTION_AUTHORITY_VARS.some((name) => dotenvValues[name] !== undefined) ||
      (primaryValue !== undefined &&
        [dotenvValues.PG_DATABASE_URL, dotenvValues.DATABASE_URL].some((value) => value !== undefined && value.trim() === primaryValue));
    if (fromDotenv) {
      throw new DbTargetError(
        'production target values are present in packages/rab-server/.env. Production authority must come from the deployment environment, not that file. Refusing.',
      );
    }
  }

  const declared = asTargetError(() => assertDeclaredIdentityForProcess(env, production, `${purpose} command`));
  const bootstrapRequested = asTargetError(() => readBootstrapFlag(env));
  const base = { purpose, target, app, admin, pg, migrationEndpoint, declared, bootstrapRequested };

  if (production) return { ...base, classification: 'PRODUCTION' };

  if (bootstrapRequested) {
    throw new DbTargetError(`${IDENTITY_BOOTSTRAP_VAR} is honoured only with DB_TARGET=production. Remove it. Refusing.`);
  }
  if (target === 'staging') {
    throw new DbTargetError('DB_TARGET=staging is refused: no staging command path is configured. Fail closed.');
  }

  // local and test: must not be a dotted remote host. test may only be remote with the explicit test override.
  const remoteAllowed = target === 'test' && env.ALLOW_REMOTE_TEST_DATABASE === 'true';
  if (!isLocalHost(app) && !remoteAllowed) {
    throw new DbTargetError(`DB_TARGET=${target} refuses a remote host ("${app.host}"). Use a loopback or docker-service database.`);
  }
  if (admin && !isLocalHost(admin) && !remoteAllowed) {
    throw new DbTargetError(`DB_TARGET=${target} refuses a remote ${admin.label} host ("${admin.host}").`);
  }
  // INTERIM (security review H-1) — remove once production carries a bound deployment marker: today's production database
  // has no marker yet, so even DB_TARGET=test with ALLOW_REMOTE_TEST_DATABASE=true must not reach it. Checked before any
  // connection, on every endpoint the command could open.
  const unmarkedProduction = unmarkedProductionRefusal(pg, `DB_TARGET=${target} ${purpose} command`);
  if (unmarkedProduction) throw new DbTargetError(`${unmarkedProduction} Refusing.`);
  // A production-bound database is refused LIVE (assertDbTarget), whatever its host: the marker, not the endpoint name.
  return { ...base, classification: 'NON-PRODUCTION' };
}

export interface DbIdentityProbe {
  database: string;
  systemIdentifier: string;
  /** Sanitised marker summary (absent | unbound | bootstrap | <environment>/<deployment id>), not-checked, or deferred-unreadable. */
  identity: string;
  warnings: string[];
  /** True only when the caller asked to defer an unreadable (SQLSTATE 42501) marker; the caller must check it later. */
  identityDeferred: boolean;
}

export interface DbIdentityCheck {
  env: Record<string, string | undefined>;
  production: boolean;
  processLabel: string;
  /** Return `identityDeferred` instead of refusing when the login may not read the marker (42501). Never a pass. */
  deferUnreadableMarker?: boolean;
  /**
   * Owner decision A: only the audited rebind command (`db:bind-identity`) may read a marker bound in another database or
   * at another host — as a warning — because recording the new location is its job. Every other purpose refuses.
   */
  locationMismatch?: 'refuse' | 'warn';
}

/**
 * Read-only probe: SELECT only, in a read-only session (a factory client with `default_transaction_read_only=on`). Returns
 * the database name and cluster identifier and, when `identity` is given, enforces the deployment identity marker on the
 * same connection.
 */
export async function probeDbIdentity(pg: ResolvedPgEnvironment, endpoint: PgEndpointName, identity?: DbIdentityCheck): Promise<DbIdentityProbe> {
  const probed = endpoint === 'elevated' ? pg.elevated : endpoint === 'lock' ? pg.lock : pg.primary;
  const label = probed?.source ?? endpoint;
  const client = asTargetError(() => createPgClient(pg, { endpoint, purpose: 'probe', readOnly: true }));
  let row: { db: string; sid: string } | undefined;
  try {
    await client.connect();
    const result = await client.query<{ db: string; sid: string }>(
      `SELECT pg_catalog.current_database() AS db, (SELECT system_identifier::text FROM pg_catalog.pg_control_system()) AS sid`,
    );
    row = result.rows[0];
    if (!row) throw new Error('empty probe');
  } catch (error) {
    await client.end().catch(() => undefined);
    const code = (error as { code?: string }).code ?? 'unknown';
    throw new DbTargetError(`Cannot reach the ${label} database for the read-only identity probe (driver code ${code}).`);
  }
  const base = { database: row.db, systemIdentifier: row.sid };
  try {
    if (!identity) return { ...base, identity: 'not-checked', warnings: [], identityDeferred: false };
    const decision = await assertDeploymentIdentity(async (sql, params) => (await client.query(sql, params as unknown[])).rows, {
      processLabel: identity.processLabel,
      production: identity.production,
      env: identity.env,
      allowBootstrap: true,
      connectionHost: probed?.target.host ?? '',
      locationMismatch: identity.locationMismatch ?? 'refuse',
      command: true,
    });
    return { ...base, identity: decision.summary, warnings: decision.warnings, identityDeferred: false };
  } catch (error) {
    if (identity?.deferUnreadableMarker && isInsufficientPrivilege(error)) {
      return { ...base, identity: 'deferred-unreadable', warnings: [], identityDeferred: true };
    }
    if (error instanceof DeploymentIdentityError) throw new DbTargetError(error.message);
    const code = (error as { code?: string }).code ?? 'unknown';
    throw new DbTargetError(`The ${label} deployment identity check failed (SQLSTATE ${code}). Refusing.`);
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * The marker check a caller owes after `assertDbTarget(..., { deferUnreadableMarker: true })` returned `identityDeferred`:
 * run on the caller's own migration session AFTER its CF-41 identity check (which, for a login that cannot read the marker,
 * normally refuses first with the precise reason). Same rules as the probe; any failure, 42501 included, is a refusal.
 */
export async function assertDeferredDeploymentIdentity(
  query: Query,
  resolved: Pick<ResolvedDbTarget, 'purpose' | 'target'> & MigrationSessionLocation,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  try {
    await assertDeploymentIdentity(query, {
      processLabel: `${resolved.purpose} command (DB_TARGET=${resolved.target})`,
      production: resolved.target === 'production',
      env,
      allowBootstrap: true,
      connectionHost: migrationConnectionHost(resolved),
      locationMismatch: resolved.purpose === BIND_IDENTITY_PURPOSE ? 'warn' : 'refuse',
      command: true,
    });
  } catch (error) {
    if (error instanceof DeploymentIdentityError && !isInsufficientPrivilege(error)) throw new DbTargetError(error.message);
    const code = (error as { code?: string; sqlState?: string }).code ?? (error as { sqlState?: string }).sqlState ?? 'unknown';
    throw new DbTargetError(
      `the ${resolved.purpose} login cannot read the deployment identity marker (SQLSTATE ${code}); a migration identity must be able to. Refusing.`,
    );
  }
}

/** Reads packages/rab-server/.env as data only. Never loads it into process.env here. */
export function readDotenvValues(filePath: string = path.resolve(__dirname, '../../../../.env')): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  return parseDotenv(fs.readFileSync(filePath));
}

export interface AssertDbTargetOptions {
  /** See the header: only for callers that run CF-41 and then assertDeferredDeploymentIdentity on their own session. */
  deferUnreadableMarker?: boolean;
}

export type GuardedDbTarget = ResolvedDbTarget & { identityDeferred: boolean };

/**
 * Full guard: resolve, probe both connections read-only, confirm they agree, enforce the deployment identity marker,
 * print a sanitised summary, return. Call before any write-capable operation. Throws DbTargetError to fail.
 */
export async function assertDbTarget(
  purpose: string,
  env: Record<string, string | undefined> = process.env,
  dotenvValues: Record<string, string> = readDotenvValues(),
  options: AssertDbTargetOptions = {},
): Promise<GuardedDbTarget> {
  const resolved = resolveDbTarget({ purpose, env, dotenvValues });
  const appProbe = await probeDbIdentity(resolved.pg, 'primary', {
    env,
    production: resolved.target === 'production',
    processLabel: `${purpose} command (DB_TARGET=${resolved.target})`,
    deferUnreadableMarker: options.deferUnreadableMarker,
    locationMismatch: purpose === BIND_IDENTITY_PURPOSE ? 'warn' : 'refuse',
  });
  if (resolved.admin) {
    const adminProbe = await probeDbIdentity(resolved.pg, 'elevated');
    if (adminProbe.database !== appProbe.database || adminProbe.systemIdentifier !== appProbe.systemIdentifier) {
      throw new DbTargetError(`runtime identity mismatch between ${resolved.app.label} and ${resolved.admin.label}. Refusing.`);
    }
  }
  for (const warning of appProbe.warnings) {
    // eslint-disable-next-line no-console
    console.warn(`[db-target] WARNING purpose=${purpose}: ${warning}`);
  }
  // Sanitised summary: no URL, host userinfo, password or username.
  // eslint-disable-next-line no-console
  console.log(
    `[db-target] purpose=${purpose} target=${resolved.target} classification=${resolved.classification} endpoint=${resolved.app.endpointKey} database=${appProbe.database} cluster=${appProbe.systemIdentifier} probe=read-only-ok identity=${appProbe.identity}`,
  );
  return { ...resolved, identityDeferred: appProbe.identityDeferred };
}
