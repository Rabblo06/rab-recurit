/**
 * RUNTIME database identity guard: the API server, the ordinary Worker process, and the separate
 * Workspace Provisioner process, at boot.
 *
 * This is the third and separate boundary (see docs/security/INCIDENT-2026-10-05-TEST-DATABASE-ROUTING.md, section 17):
 *   TEST     -> test-database-guard.ts        TEST_DATABASE_URL / _UNPOOLED, NODE_ENV=test only
 *   COMMAND  -> database-target.ts            DB_TARGET (+ ALLOW_PRODUCTION_DB_COMMANDS for production), CLI and migrations
 *   RUNTIME  -> this file                     RAB_RUNTIME_ENV, NODE_ENV=production, long-running API/Worker/Provisioner processes
 *
 * It deliberately does NOT reuse ALLOW_PRODUCTION_DB_COMMANDS. A running server is not a command: a runtime that connects to the
 * wrong database serves traffic against it, and that is the failure this guard exists to stop.
 *
 * Phase B / B1: every process takes ONE variable, `PG_DATABASE_URL`, holding its OWN credential (API and Worker: the
 * restricted `crewflow_app`; the provisioner child: the provisioner credential the Worker bundle launcher hands it under
 * that name). Connections are resolved by the shared factory (src/database/postgres: URL policy, TLS, legacy names refused
 * in production) and the probe is a factory client opened read-only; this guard never reads a URL variable itself.
 *
 * Worker credential isolation checkpoint: the deprecated `DATABASE_URL_UNPOOLED` (the historical privileged name) is
 * `provisioner`-only and non-production-only. The ordinary API and Worker processes refuse to start if it is present in
 * their environment at all: a misconfigured deployment that hands the ordinary Worker (or API) that variable fails to
 * boot, rather than silently working with an unnecessarily privileged credential sitting unused in its environment.
 *
 * Rules:
 *   - NODE_ENV=production REQUIRES RAB_RUNTIME_ENV=production from the process/deployment environment. Refused otherwise.
 *   - Phase B / B3 (replaces the Neon endpoint pin): a production process must declare CREWFLOW_DEPLOYMENT_ENVIRONMENT=production
 *     and CREWFLOW_DEPLOYMENT_ID=<uuid> from the deployment environment, and the database's protected deployment identity
 *     marker (core.deployment_identity_check(), ../../deployment-identity/deployment-identity.ts) must be bound to exactly
 *     that. PG_EXPECTED_DATABASE_NAME, when set, must equal current_database(). Outside production a provisioner may still
 *     use the deprecated DATABASE_URL_UNPOOLED for its DDL connection, and a deprecated DATABASE_DIRECT_URL names the
 *     session-lock connection; both are probed. All connections must agree.
 *   - The ordinary API and Worker processes refuse to start if DATABASE_URL_UNPOOLED is present in their environment at
 *     all — a restricted process must never be ABLE to escalate, not merely choose not to.
 *   - Production values present in the working directory's .env or any dotenv file Nx loads for a rab-server / rab-worker
 *     target (final review F6: nx-dotenv-files.ts) are refused. A developer .env is never production authority.
 *   - A NON-production process (any NODE_ENV other than production) must NOT run against a database bound to production
 *     (live marker check), whatever its host is called. This stops a local `.env` that still carries a production URL, or a
 *     clone of production that was never rebound, from turning a dev server into a production writer.
 *   - Read-only identity probe before listening or consuming jobs. SELECT only, in a read-only session. Nothing is changed.
 *   - Refusals never print a URL, host userinfo or credential. Only the variable name, endpoint key and database name appear.
 */
import * as fs from 'fs';
import * as path from 'path';

import { parse as parseDotenv } from 'dotenv';

import { nxDotenvPaths, readDotenvFilesValues } from './nx-dotenv-files';

import {
  createPgClient,
  describePgTarget,
  PgConfigError,
  PgEndpointName,
  PgTargetIdentity,
  readPrimaryDatabaseUrl,
  resolvePgEnvironmentCached,
  ResolvedPgEnvironment,
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
  isRemoteDatabaseHost,
} from '../../deployment-identity/deployment-identity';
import { unmarkedProductionRefusal } from '../../deployment-identity/unmarked-production-endpoints';
import { runtimeEnvRefusal } from './never-in-runtime-env';

export const RUNTIME_ENV_VAR = 'RAB_RUNTIME_ENV';

/**
 * AI Part A (owner condition 5): what this process's boot guard established, kept for the AI real-provider gate. Set ONLY by
 * a successful `assertRuntimeDatabaseIdentity` (the same probe that lets the process listen or consume jobs); null in every
 * process that never ran it (CLI commands, Jest), which the AI gate treats as "not the development database" (fail closed).
 * Contains no URL, host or credential.
 */
export interface RecordedRuntimeDatabase {
  processName: string;
  runtimeEnvironment: ResolvedRuntimeDb['runtimeEnvironment'];
  classification: ResolvedRuntimeDb['classification'];
}
let recordedRuntimeDb: Readonly<RecordedRuntimeDatabase> | null = null;

export function recordedRuntimeDatabase(): Readonly<RecordedRuntimeDatabase> | null {
  return recordedRuntimeDb;
}

export class RuntimeDbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeDbError';
  }
}

export interface RuntimeDbInput {
  processName: 'api' | 'worker' | 'provisioner';
  env: Record<string, string | undefined>;
  dotenvValues: Record<string, string>;
}

export interface ResolvedRuntimeDb {
  processName: string;
  /** development is a non-production runtime that is also restricted to a local database. */
  runtimeEnvironment: 'production' | 'development' | 'non-production';
  /** LOCAL: a non-production runtime on a loopback or docker-service database. */
  classification: 'PRODUCTION' | 'LOCAL' | 'NON-PRODUCTION';
  /** The process's own connection (factory endpoint 'primary': PG_DATABASE_URL, or legacy DATABASE_URL outside production). */
  app: PgTargetIdentity;
  /** Provisioner only, non-production only: the deprecated DATABASE_URL_UNPOOLED (factory endpoint 'elevated'). */
  admin: PgTargetIdentity | null;
  /**
   * P0.6-1B (FULL-ARCHITECTURE-UPGRADE-PLAN.md §8A.1 item 5): `rab-worker/src/main.ts`'s `directDataSource` (the session-lock
   * pool) uses the factory's 'lock' endpoint: PG_DATABASE_URL itself, or outside production the deprecated
   * DATABASE_DIRECT_URL. A lock URL pointing at a different cluster/database would run those jobs against the wrong
   * database, so it is probed too. Non-null only when it names a different target from `app` (normally the lock endpoint
   * IS the primary and needs no separate probe).
   */
  direct: PgTargetIdentity | null;
  /** The factory resolution every connection of this process uses. */
  pg: ResolvedPgEnvironment;
  /** Phase B / B3: the declared deployment identity (required in production; checked live against the marker). */
  declared: DeclaredDeploymentIdentity | null;
}

function declaredOrRefuse(env: Record<string, string | undefined>, production: boolean, processName: string): DeclaredDeploymentIdentity | null {
  try {
    return assertDeclaredIdentityForProcess(env, production, `${processName} process`);
  } catch (error) {
    if (error instanceof DeploymentIdentityError) throw new RuntimeDbError(`${error.message} Refusing to start.`);
    throw error;
  }
}

/**
 * Presence-only check of a credential name that must never reach this process. Only whether the NAME is set is looked at
 * (a blank value counts as absent); the value is never parsed or used to connect.
 */
function isSet(env: Record<string, string | undefined>, name: string): boolean {
  return (env[name]?.trim() ?? '') !== '';
}

function sameEndpoint(a: PgTargetIdentity, b: PgTargetIdentity): boolean {
  return a.database === b.database && a.endpointKey === b.endpointKey;
}

/** Pure resolution. No connection. */
export function resolveRuntimeDatabase(input: RuntimeDbInput): ResolvedRuntimeDb {
  const { processName, env, dotenvValues } = input;

  // Worker credential isolation checkpoint + Phase B P7 + security review L-4: a long-running process must never be ABLE to
  // escalate, not merely choose not to. Refuse to boot if any migration, bootstrap, command or operations authority (the
  // one shared list, never-in-runtime-env.ts — api-prestart.sh and the Worker bundle launcher are checked against it) is
  // present in its environment at all, regardless of whether anything would have read it. This holds even when a
  // platform starts main.js directly and api-prestart.sh never runs. Names only, with the one value-aware exception the
  // list declares: DB_TARGET=local|test is tolerated (ignored, never read) in a NON-production runtime, so local `yarn
  // start` with a developer .env boots; any other DB_TARGET, or any DB_TARGET in production, is refused.
  const forbidden = runtimeEnvRefusal(env, processName);
  if (forbidden) {
    throw new RuntimeDbError(`${forbidden.name} is present in the ${processName} process's environment. ${forbidden.why} Refusing to start.`);
  }

  const declared = env[RUNTIME_ENV_VAR]?.trim();
  if (declared !== undefined && declared !== '' && !['production', 'development', 'non-production'].includes(declared)) {
    throw new RuntimeDbError(`${RUNTIME_ENV_VAR} "${declared}" is not recognised. Use production, development or non-production.`);
  }
  const productionNode = env.NODE_ENV === 'production';
  const declaredProduction = declared === 'production';
  if (productionNode || declaredProduction) {
    if (!productionNode) {
      throw new RuntimeDbError(`${RUNTIME_ENV_VAR}=production requires NODE_ENV=production in the same deployment environment. Refusing to start.`);
    }
    if (!declaredProduction) {
      throw new RuntimeDbError(
        `NODE_ENV=production requires ${RUNTIME_ENV_VAR}=production from the deployment environment. Refusing to start the ${processName} process.`,
      );
    }
  }

  // The connections exactly as this process's pools build them. The factory refuses legacy names and libpq variables in
  // production, a URL that overrides its own target, TLS weaker than verify-full in production, and — for the worker and
  // the provisioner, which hold session advisory locks — a transaction-pooler URL shape.
  let pg: ResolvedPgEnvironment;
  try {
    pg = resolvePgEnvironmentCached(env, { processRole: processName });
  } catch (error) {
    if (error instanceof PgConfigError) throw new RuntimeDbError(`The ${processName} process: ${error.message}`);
    throw error;
  }
  const app = describePgTarget(pg.primary.target);
  const admin = pg.elevated ? describePgTarget(pg.elevated.target) : null;
  if (admin && !sameEndpoint(admin, app)) {
    throw new RuntimeDbError(
      `${app.label} and ${admin.label} resolve to different databases or endpoints (${app.database}@${app.endpointKey} vs ${admin.database}@${admin.endpointKey}). Refusing to start.`,
    );
  }
  // P0.6-1B: the session-lock endpoint is the primary unless a (deprecated) DATABASE_DIRECT_URL names another target.
  const direct = pg.lock !== pg.primary && pg.lock.target.canonicalKey !== pg.primary.target.canonicalKey ? describePgTarget(pg.lock.target) : null;
  if (direct && !sameEndpoint(direct, app)) {
    throw new RuntimeDbError(
      `${app.label} and ${direct.label} resolve to different databases or endpoints (${app.database}@${app.endpointKey} vs ${direct.database}@${direct.endpointKey}). Refusing to start.`,
    );
  }

  // The bootstrap of an unbound production database is a migration-command action only; a runtime never honours it.
  if (isSet(env, IDENTITY_BOOTSTRAP_VAR)) {
    throw new RuntimeDbError(
      `${IDENTITY_BOOTSTRAP_VAR} is present in the ${processName} process's environment. It is honoured only by production database commands. Remove it. Refusing to start.`,
    );
  }

  if (productionNode) {
    const primaryValue = readPrimaryDatabaseUrl(env)?.value;
    if (
      dotenvValues[RUNTIME_ENV_VAR] !== undefined ||
      dotenvValues[DEPLOYMENT_ENVIRONMENT_VAR] !== undefined ||
      dotenvValues[DEPLOYMENT_ID_VAR] !== undefined ||
      dotenvValues[EXPECTED_DATABASE_NAME_VAR] !== undefined ||
      (primaryValue !== undefined &&
        [dotenvValues.PG_DATABASE_URL, dotenvValues.DATABASE_URL, dotenvValues.DATABASE_DIRECT_URL, dotenvValues.DATABASE_URL_UNPOOLED].some(
          (value) => value !== undefined && value.trim() === primaryValue,
        ))
    ) {
      throw new RuntimeDbError(
        'production runtime values are present in a .env file. Production authority must come from the deployment environment. Refusing to start.',
      );
    }
    const declaredIdentity = declaredOrRefuse(env, true, processName);
    // The production provisioner's privileged DDL connection is its own PG_DATABASE_URL (the factory requires it in
    // production; the Worker bundle launcher sets it from CREWFLOW_PROVISIONER_DATABASE_URL). Nothing else to require.
    return { processName, runtimeEnvironment: 'production', classification: 'PRODUCTION', app, admin, direct, pg, declared: declaredIdentity };
  }

  // Non-production process: may not declare production. Whether the DATABASE is production is decided live by the marker.
  const declaredIdentity = declaredOrRefuse(env, false, processName);
  // INTERIM (security review H-1) — remove once production carries a bound deployment marker: today's production
  // database has no marker yet, so the live check cannot tell it apart from an unmarked development database. Every
  // endpoint this process could open is checked against the known unmarked production endpoints, before any connection.
  const unmarkedProduction = unmarkedProductionRefusal(pg, `${processName} process`);
  if (unmarkedProduction) throw new RuntimeDbError(`${unmarkedProduction} Refusing to start.`);
  // development: a local-only runtime. It refuses any remote host, not only the production endpoint.
  const localOnly = isLocalIdentity(app) && (admin === null || isLocalIdentity(admin)) && (direct === null || isLocalIdentity(direct));
  if (declared === 'development') {
    if (!localOnly) {
      throw new RuntimeDbError(
        `${RUNTIME_ENV_VAR}=development refuses a remote database ("${app.host}"). A development ${processName} uses a loopback or docker-service database only.`,
      );
    }
    return { processName, runtimeEnvironment: 'development', classification: 'LOCAL', app, admin, direct, pg, declared: declaredIdentity };
  }
  return {
    processName,
    runtimeEnvironment: 'non-production',
    classification: localOnly ? 'LOCAL' : 'NON-PRODUCTION',
    app,
    admin,
    direct,
    pg,
    declared: declaredIdentity,
  };
}

/**
 * Loopback, or a listed compose database service such as `postgres` (final review F4: any other single-label name is
 * remote). Security review N-4: the one shared host rule (deployment-identity.ts isRemoteDatabaseHost), so a dotted name AND
 * a non-loopback IPv6 literal (`fd00::5`, which has no dot) are remote. `classification: 'LOCAL'` (which the AI real-provider gate relies on) is therefore never given to one.
 */
function isLocalIdentity(identity: PgTargetIdentity): boolean {
  return !isRemoteDatabaseHost(identity.host);
}

export interface RuntimeIdentityProbe {
  database: string;
  systemIdentifier: string;
  currentUser: string;
  /** Sanitised deployment marker summary, or 'not-checked' when no identity check was requested. */
  identity: string;
  warnings: string[];
}

/**
 * Read-only identity probe. SELECT only, read-only session (a factory client with `default_transaction_read_only=on`, the
 * same URL policy and TLS as the process's pools). Never terminates a session or changes data. With `identity`, the
 * deployment identity marker is enforced on the same connection (Phase B / B3).
 */
export async function probeRuntimeIdentity(
  pg: ResolvedPgEnvironment,
  endpoint: PgEndpointName,
  identity?: { env: Record<string, string | undefined>; production: boolean; processLabel: string },
): Promise<RuntimeIdentityProbe> {
  const probed = endpoint === 'elevated' ? pg.elevated : endpoint === 'lock' ? pg.lock : pg.primary;
  const label = probed?.source ?? endpoint;
  let client: ReturnType<typeof createPgClient>;
  try {
    client = createPgClient(pg, { endpoint, purpose: 'probe', readOnly: true });
  } catch (error) {
    if (error instanceof PgConfigError) throw new RuntimeDbError(`${error.message} Refusing to start.`);
    throw error;
  }
  let row: { db: string; sid: string; usr: string } | undefined;
  try {
    await client.connect();
    const result = await client.query<{ db: string; sid: string; usr: string }>(
      `SELECT pg_catalog.current_database() AS db, (SELECT system_identifier::text FROM pg_catalog.pg_control_system()) AS sid, current_user AS usr`,
    );
    row = result.rows[0];
    if (!row) throw new Error('empty probe');
  } catch (error) {
    await client.end().catch(() => undefined);
    const code = (error as { code?: string }).code ?? 'unknown';
    throw new RuntimeDbError(`Cannot reach the ${label} database for the read-only identity probe (driver code ${code}). Refusing to start.`);
  }
  try {
    const base = { database: row.db, systemIdentifier: row.sid, currentUser: row.usr };
    if (!identity) return { ...base, identity: 'not-checked', warnings: [] };
    const decision = await assertDeploymentIdentity(async (sql, params) => (await client.query(sql, params as unknown[])).rows, {
      processLabel: identity.processLabel,
      production: identity.production,
      env: identity.env,
      allowBootstrap: false,
      // Owner decision A: the marker must have been bound at the host this very connection names.
      connectionHost: probed?.target.host ?? '',
    });
    return { ...base, identity: decision.summary, warnings: decision.warnings };
  } catch (error) {
    if (error instanceof DeploymentIdentityError) throw new RuntimeDbError(`${error.message} Refusing to start.`);
    const code = (error as { code?: string }).code ?? 'unknown';
    throw new RuntimeDbError(`The ${label} deployment identity check failed (SQLSTATE ${code}). Refusing to start.`);
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * Reads, as data only (never into process.env), the working directory's .env (dotenv/config's default) and — final review
 * F6 — every dotenv file Nx loads for a rab-server or rab-worker target (nx-dotenv-files.ts), merged first-file-wins. Before
 * F6 only the working directory's .env was read, so production values in packages/rab-server/.env* or
 * packages/rab-worker/.env* (what `nx run rab-server:start` / `rab-worker:start` inject) went unseen. A `filePath` reads
 * that one file only (tests).
 */
export function readRuntimeDotenvValues(filePath?: string): Record<string, string> {
  if (filePath !== undefined) return fs.existsSync(filePath) ? parseDotenv(fs.readFileSync(filePath)) : {};
  return readDotenvFilesValues([path.join(process.cwd(), '.env'), ...nxDotenvPaths()]);
}

/**
 * Called first in the API, Worker and Provisioner bootstrap, before any listener starts, any job
 * is consumed, or any provisioning cycle runs. Throws RuntimeDbError on any mismatch. The caller
 * exits non-zero.
 */
export async function assertRuntimeDatabaseIdentity(
  processName: 'api' | 'worker' | 'provisioner',
  env: Record<string, string | undefined> = process.env,
  dotenvValues: Record<string, string> = readRuntimeDotenvValues(),
): Promise<ResolvedRuntimeDb> {
  const resolved = resolveRuntimeDatabase({ processName, env, dotenvValues });
  const appProbe = await probeRuntimeIdentity(resolved.pg, 'primary', {
    env,
    production: resolved.classification === 'PRODUCTION',
    processLabel: `${processName} process`,
  });
  for (const warning of appProbe.warnings) {
    // eslint-disable-next-line no-console
    console.warn(`[runtime-db-guard] WARNING process=${processName}: ${warning}`);
  }
  if (resolved.admin) {
    const adminProbe = await probeRuntimeIdentity(resolved.pg, 'elevated');
    if (adminProbe.database !== appProbe.database || adminProbe.systemIdentifier !== appProbe.systemIdentifier) {
      throw new RuntimeDbError(`runtime identity mismatch between ${resolved.app.label} and ${resolved.admin.label}. Refusing to start.`);
    }
  }
  // P0.6-1B: the worker's directDataSource (the session-lock pool — see rab-worker/src/main.ts's own doc comment) is probed
  // whenever its endpoint names a different target from the primary (resolveRuntimeDatabase leaves `direct` null otherwise).
  if (resolved.direct) {
    const directProbe = await probeRuntimeIdentity(resolved.pg, 'lock');
    if (directProbe.database !== appProbe.database || directProbe.systemIdentifier !== appProbe.systemIdentifier) {
      throw new RuntimeDbError(`runtime identity mismatch between ${resolved.app.label} and ${resolved.direct.label}. Refusing to start.`);
    }
  }
  // Sanitised summary only: no URL, userinfo, password or username. The role is the connected role name, which is not a secret.
  // eslint-disable-next-line no-console
  console.log(
    `[runtime-db-guard] process=${processName} runtime=${resolved.runtimeEnvironment} classification=${resolved.classification} endpoint=${resolved.app.endpointKey} database=${appProbe.database} cluster=${appProbe.systemIdentifier} role=${appProbe.currentUser} probe=read-only-ok identity=${appProbe.identity}`,
  );
  recordedRuntimeDb = Object.freeze({ processName, runtimeEnvironment: resolved.runtimeEnvironment, classification: resolved.classification });
  return resolved;
}
