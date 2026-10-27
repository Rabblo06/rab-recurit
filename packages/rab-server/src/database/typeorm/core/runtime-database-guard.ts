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
 * Worker credential isolation checkpoint: `DATABASE_URL_UNPOOLED` (the privileged migration/provisioning identity) is now
 * `provisioner`-only. The ordinary API and Worker processes both run as the restricted `DATABASE_URL` (`crewflow_app`) alone —
 * neither reads, requires, or is permitted to have `DATABASE_URL_UNPOOLED` set in its process environment at all. This is
 * enforced here, not just by the application code never calling it: a misconfigured deployment that hands the ordinary
 * Worker (or API) that env var fails to boot, rather than silently working with an unnecessarily privileged credential
 * sitting unused in its environment.
 *
 * Rules:
 *   - NODE_ENV=production REQUIRES RAB_RUNTIME_ENV=production from the process/deployment environment. Refused otherwise.
 *   - A production process must resolve to the expected production identity (endpoint and database). The provisioner also
 *     checks DATABASE_URL_UNPOOLED, which it uses for its privileged DDL connection. Both must agree.
 *   - The ordinary API and Worker processes refuse to start if DATABASE_URL_UNPOOLED is present in their environment at
 *     all — a restricted process must never be ABLE to escalate, not merely choose not to.
 *   - Production values present in packages/rab-server/.env (or the working directory's .env) are refused. A developer .env is
 *     never production authority.
 *   - A NON-production process (any NODE_ENV other than production) must NOT resolve to the expected production database. This
 *     stops a local `.env` that still carries the production Neon URL from turning a dev server into a production writer.
 *   - Read-only identity probe before listening or consuming jobs. SELECT only, in a read-only session. Nothing is changed.
 *   - Refusals never print a URL, host userinfo or credential. Only the variable name, endpoint key and database name appear.
 */
import * as fs from 'fs';
import * as path from 'path';

import { parse as parseDotenv } from 'dotenv';
import { Client } from 'pg';

import { describeDatabaseUrl, TestDatabaseIdentity } from './test-database-guard';
import { EXPECTED_PRODUCTION_IDENTITY } from './database-target';

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
  app: TestDatabaseIdentity;
  admin: TestDatabaseIdentity | null;
  appUrl: string;
  adminUrl: string | null;
  /**
   * P0.6-1B (FULL-ARCHITECTURE-UPGRADE-PLAN.md §8A.1 item 5): `rab-worker/src/main.ts`'s
   * `directDataSource` reads a THIRD url, `DATABASE_DIRECT_URL` (falling back to
   * `DATABASE_URL`), for the advisory-lock-requiring jobs (final timesheet, shift-report
   * scheduler) — connected as `rab_app`, not `rab_owner`. This was never probed against
   * `DATABASE_URL`'s identity before this fix: a misconfigured `DATABASE_DIRECT_URL` pointing
   * at a different physical cluster/database would have run those jobs against the wrong
   * database with no startup refusal. Present (non-null) only when `DATABASE_DIRECT_URL` is
   * actually set and differs from `DATABASE_URL` (the fallback case needs no separate probe —
   * it's the same URL, already checked as `app`).
   */
  direct: TestDatabaseIdentity | null;
  directUrl: string | null;
}

function describeOrRefuse(url: string, label: string): TestDatabaseIdentity {
  try {
    return describeDatabaseUrl(url, label);
  } catch (error) {
    throw new RuntimeDbError((error as Error).message);
  }
}

function isExpectedProduction(identity: TestDatabaseIdentity): boolean {
  return identity.endpointKey === EXPECTED_PRODUCTION_IDENTITY.endpointKey && identity.database === EXPECTED_PRODUCTION_IDENTITY.database;
}

/** Pure resolution. No connection. */
export function resolveRuntimeDatabase(input: RuntimeDbInput): ResolvedRuntimeDb {
  const { processName, env, dotenvValues } = input;
  const appUrl = env.DATABASE_URL?.trim();
  if (!appUrl) throw new RuntimeDbError(`DATABASE_URL is required for the ${processName} process.`);
  const adminUrl = env.DATABASE_URL_UNPOOLED?.trim() || null;

  // Worker credential isolation checkpoint: the ordinary API and Worker processes must never be
  // ABLE to escalate, not merely choose not to — refuse to boot if the privileged credential is
  // present in their environment at all, regardless of whether anything would have read it.
  if (processName !== 'provisioner' && adminUrl) {
    throw new RuntimeDbError(
      `DATABASE_URL_UNPOOLED is present in the ${processName} process's environment, but only the provisioner process may hold it. Remove it from this process's environment. Refusing to start.`,
    );
  }
  // Same rule for the Worker bundle's provisioning variable (packages/rab-docker/rab/worker-bundle/start-worker-bundle.cjs):
  // only that launcher may receive it, and it hands it to the provisioner child under the names above. No application
  // process — the provisioner child included — ever needs CREWFLOW_PROVISIONER_DATABASE_URL itself, so its presence means
  // a misrouted privileged credential.
  if (env.CREWFLOW_PROVISIONER_DATABASE_URL?.trim()) {
    throw new RuntimeDbError(
      `CREWFLOW_PROVISIONER_DATABASE_URL is present in the ${processName} process's environment. Only the Worker bundle launcher may hold it. Remove it from this process's environment. Refusing to start.`,
    );
  }

  // Twenty-parity Phase 7: the api prestart (packages/rab-docker/rab/api-prestart.sh) consumes the one-time migration
  // credential and approval in a short-lived child and REMOVES them before exec'ing main.js. Seeing any of them here means a
  // privileged migration credential reached a long-running process. The Worker never migrates, so it never holds them either.
  for (const name of ['CREWFLOW_PRESTART_MIGRATION_DATABASE_URL', 'CREWFLOW_MIGRATION_DATABASE_URL', 'CREWFLOW_MIGRATION_APPROVED']) {
    if (env[name]?.trim()) {
      throw new RuntimeDbError(
        `${name} is present in the ${processName} process's environment. Migration authority is consumed only by the short-lived migration step and never reaches a long-running process. Refusing to start.`,
      );
    }
  }

  const app = describeOrRefuse(appUrl, 'DATABASE_URL');
  const admin = adminUrl ? describeOrRefuse(adminUrl, 'DATABASE_URL_UNPOOLED') : null;

  if (admin && (admin.database !== app.database || admin.endpointKey !== app.endpointKey)) {
    throw new RuntimeDbError(
      `DATABASE_URL and DATABASE_URL_UNPOOLED resolve to different databases or endpoints (${app.database}@${app.endpointKey} vs ${admin.database}@${admin.endpointKey}). Refusing to start.`,
    );
  }

  // P0.6-1B: DATABASE_DIRECT_URL falls back to DATABASE_URL in rab-worker/src/main.ts, so only a
  // DISTINCT, actually-configured value needs its own probe — the fallback case is already the
  // `app` identity, already checked above.
  const rawDirectUrl = env.DATABASE_DIRECT_URL?.trim() || null;
  const directUrl = rawDirectUrl && rawDirectUrl !== appUrl ? rawDirectUrl : null;
  const direct = directUrl ? describeOrRefuse(directUrl, 'DATABASE_DIRECT_URL') : null;
  if (direct && (direct.database !== app.database || direct.endpointKey !== app.endpointKey)) {
    throw new RuntimeDbError(
      `DATABASE_URL and DATABASE_DIRECT_URL resolve to different databases or endpoints (${app.database}@${app.endpointKey} vs ${direct.database}@${direct.endpointKey}). Refusing to start.`,
    );
  }

  const declared = env[RUNTIME_ENV_VAR]?.trim();
  if (declared !== undefined && declared !== '' && !['production', 'development', 'non-production'].includes(declared)) {
    throw new RuntimeDbError(`${RUNTIME_ENV_VAR} "${declared}" is not recognised. Use production, development or non-production.`);
  }
  const productionNode = env.NODE_ENV === 'production';
  const declaredProduction = declared === 'production';
  const touchesProduction = isExpectedProduction(app) || (admin !== null && isExpectedProduction(admin)) || (direct !== null && isExpectedProduction(direct));

  if (productionNode || declaredProduction) {
    if (!productionNode) {
      throw new RuntimeDbError(`${RUNTIME_ENV_VAR}=production requires NODE_ENV=production in the same deployment environment. Refusing to start.`);
    }
    if (!declaredProduction) {
      throw new RuntimeDbError(
        `NODE_ENV=production requires ${RUNTIME_ENV_VAR}=production from the deployment environment. Refusing to start the ${processName} process.`,
      );
    }
    if (
      dotenvValues[RUNTIME_ENV_VAR] !== undefined ||
      (dotenvValues.DATABASE_URL !== undefined && dotenvValues.DATABASE_URL === env.DATABASE_URL) ||
      (dotenvValues.DATABASE_URL_UNPOOLED !== undefined && dotenvValues.DATABASE_URL_UNPOOLED === env.DATABASE_URL_UNPOOLED) ||
      (dotenvValues.DATABASE_DIRECT_URL !== undefined && dotenvValues.DATABASE_DIRECT_URL === env.DATABASE_DIRECT_URL)
    ) {
      throw new RuntimeDbError(
        'production runtime values are present in a .env file. Production authority must come from the deployment environment. Refusing to start.',
      );
    }
    if (!isExpectedProduction(app)) {
      throw new RuntimeDbError(
        `the ${processName} process resolves to endpoint ${app.endpointKey} / database ${app.database}, which is not the expected production identity. Refusing to start.`,
      );
    }
    if (processName === 'provisioner' && !admin) {
      throw new RuntimeDbError('the production provisioner requires DATABASE_URL_UNPOOLED (its privileged DDL connection). Refusing to start.');
    }
    return { processName, runtimeEnvironment: 'production', classification: 'PRODUCTION', app, admin, appUrl, adminUrl, direct, directUrl };
  }

  // Non-production process: must never resolve to the production database.
  if (touchesProduction) {
    throw new RuntimeDbError(
      `a non-production ${processName} process (NODE_ENV=${env.NODE_ENV ?? 'unset'}) resolves to the expected production database. ` +
        `Point DATABASE_URL, DATABASE_URL_UNPOOLED and DATABASE_DIRECT_URL at a non-production database. Production values belong in the deployment environment only. Refusing to start.`,
    );
  }
  // development: a local-only runtime. It refuses any remote host, not only the production endpoint.
  const localOnly = isLocalIdentity(app) && (admin === null || isLocalIdentity(admin)) && (direct === null || isLocalIdentity(direct));
  if (declared === 'development') {
    if (!localOnly) {
      throw new RuntimeDbError(
        `${RUNTIME_ENV_VAR}=development refuses a remote database ("${app.host}"). A development ${processName} uses a loopback or docker-service database only.`,
      );
    }
    return { processName, runtimeEnvironment: 'development', classification: 'LOCAL', app, admin, appUrl, adminUrl, direct, directUrl };
  }
  return {
    processName,
    runtimeEnvironment: 'non-production',
    classification: localOnly ? 'LOCAL' : 'NON-PRODUCTION',
    app,
    admin,
    appUrl,
    adminUrl,
    direct,
    directUrl,
  };
}

/** Loopback, or a single-label docker-service name such as `postgres`. A dotted public host is never local. */
function isLocalIdentity(identity: TestDatabaseIdentity): boolean {
  return ['localhost', '127.0.0.1', '::1'].includes(identity.host) || !identity.host.includes('.');
}

/** Read-only identity probe. SELECT only, read-only session. Never terminates a session or changes data. */
export async function probeRuntimeIdentity(url: string, label: string): Promise<{ database: string; systemIdentifier: string; currentUser: string }> {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 10_000, options: '-c default_transaction_read_only=on' });
  try {
    await client.connect();
    const result = await client.query<{ db: string; sid: string; usr: string }>(
      `SELECT current_database() AS db, (SELECT system_identifier::text FROM pg_control_system()) AS sid, current_user AS usr`,
    );
    const row = result.rows[0];
    if (!row) throw new Error('empty probe');
    return { database: row.db, systemIdentifier: row.sid, currentUser: row.usr };
  } catch (error) {
    const code = (error as { code?: string }).code ?? 'unknown';
    throw new RuntimeDbError(`Cannot reach the ${label} database for the read-only identity probe (driver code ${code}). Refusing to start.`);
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** Reads the working directory's .env as data only. Never loaded into process.env here. */
export function readRuntimeDotenvValues(filePath: string = path.join(process.cwd(), '.env')): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  return parseDotenv(fs.readFileSync(filePath));
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
  const appProbe = await probeRuntimeIdentity(resolved.appUrl, 'DATABASE_URL');
  if (resolved.classification === 'PRODUCTION' && appProbe.database !== EXPECTED_PRODUCTION_IDENTITY.database) {
    throw new RuntimeDbError('the server reports a database name that is not the expected production database. Refusing to start.');
  }
  if (resolved.adminUrl) {
    const adminProbe = await probeRuntimeIdentity(resolved.adminUrl, 'DATABASE_URL_UNPOOLED');
    if (adminProbe.database !== appProbe.database || adminProbe.systemIdentifier !== appProbe.systemIdentifier) {
      throw new RuntimeDbError('runtime identity mismatch between DATABASE_URL and DATABASE_URL_UNPOOLED. Refusing to start.');
    }
  }
  // P0.6-1B: the worker's directDataSource (final timesheet, shift-report scheduler — see
  // rab-worker/src/main.ts's own doc comment) is the one live connection path that previously
  // escaped this guard entirely. Probed unconditionally whenever DATABASE_DIRECT_URL is set and
  // actually distinct from DATABASE_URL (resolveRuntimeDatabase already normalised the
  // fallback-to-DATABASE_URL case to null above).
  if (resolved.directUrl) {
    const directProbe = await probeRuntimeIdentity(resolved.directUrl, 'DATABASE_DIRECT_URL');
    if (directProbe.database !== appProbe.database || directProbe.systemIdentifier !== appProbe.systemIdentifier) {
      throw new RuntimeDbError('runtime identity mismatch between DATABASE_URL and DATABASE_DIRECT_URL. Refusing to start.');
    }
  }
  // Sanitised summary only: no URL, userinfo, password or username. The role is the connected role name, which is not a secret.
  // eslint-disable-next-line no-console
  console.log(
    `[runtime-db-guard] process=${processName} runtime=${resolved.runtimeEnvironment} classification=${resolved.classification} endpoint=${resolved.app.endpointKey} database=${appProbe.database} cluster=${appProbe.systemIdentifier} role=${appProbe.currentUser} probe=read-only-ok`,
  );
  recordedRuntimeDb = Object.freeze({ processName, runtimeEnvironment: resolved.runtimeEnvironment, classification: resolved.classification });
  return resolved;
}
