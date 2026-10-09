/**
 * Explicit database target model for every production-capable command: migrations (setup-db.ts and the TypeORM CLI),
 * the nest-commander CLI (bootstrap-admin, grant-platform-admin, storage-reconcile, seed, ...).
 *
 * Nothing here trusts packages/rab-server/.env. Production authority is refused when it comes from that file.
 *
 *   DB_TARGET=local|test|staging|production   required for every guarded command, no default
 *   production additionally needs DB_TARGET=production AND ALLOW_PRODUCTION_DB_COMMANDS=true, both from the process
 *   environment, and the resolved identity must be the expected production identity below.
 *
 * Order, all before any write: resolve (pure, no connection) -> read-only identity probe (SELECT only, opened with
 * default_transaction_read_only) -> print a sanitised summary. No session is terminated and no data is changed here.
 * Messages never contain a URL, password or username; they show variable names, hosts and database names only.
 *
 * Staging has no expected identity configured yet, so staging is refused until one is defined (fail closed).
 */
import * as fs from 'fs';
import * as path from 'path';

import { parse as parseDotenv } from 'dotenv';
import { Client } from 'pg';

import { describeDatabaseUrl, TestDatabaseIdentity } from './test-database-guard';

export const DB_TARGETS = ['local', 'test', 'staging', 'production'] as const;
export type DbTarget = (typeof DB_TARGETS)[number];

export const ALLOW_PRODUCTION_DB_COMMANDS = 'ALLOW_PRODUCTION_DB_COMMANDS';

/**
 * The expected production identity. Confirmed by Neon control-plane metadata on 2026-10-05 (project rab-production-v2,
 * primary default branch `production`, endpoint ep-round-rain-aess0njf, database neondb). Changing this is a deliberate code
 * change: if the deployed production database is anything else, production commands fail closed until it is updated.
 */
export const EXPECTED_PRODUCTION_IDENTITY = {
  endpointKey: 'neon:ep-round-rain-aess0njf',
  database: 'neondb',
} as const;

export interface DbTargetInput {
  purpose: string;
  env: Record<string, string | undefined>;
  /** Values parsed from packages/rab-server/.env, used only to refuse production authority that came from that file. */
  dotenvValues: Record<string, string>;
}

export interface ResolvedDbTarget {
  purpose: string;
  target: DbTarget;
  classification: 'PRODUCTION' | 'NON-PRODUCTION';
  app: TestDatabaseIdentity;
  admin: TestDatabaseIdentity | null;
  appUrl: string;
  adminUrl: string | null;
}

export class DbTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DbTargetError';
  }
}

/** Parses a URL and re-throws any failure as this module's own error type, so callers catch one class. */
function describeOrRefuse(url: string, label: string): TestDatabaseIdentity {
  try {
    return describeDatabaseUrl(url, label);
  } catch (error) {
    throw new DbTargetError((error as Error).message);
  }
}

function isLocalHost(identity: TestDatabaseIdentity): boolean {
  // Loopback, or a single-label name such as the docker-compose service `postgres`. A dotted public name is never local.
  return !identity.remote || !identity.host.includes('.');
}

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

  const appUrl = env.DATABASE_URL?.trim();
  if (!appUrl) throw new DbTargetError(`DATABASE_URL is required for ${purpose}.`);
  const adminUrl = env.DATABASE_URL_UNPOOLED?.trim() || null;

  const app = describeOrRefuse(appUrl, 'DATABASE_URL');
  const admin = adminUrl ? describeOrRefuse(adminUrl, 'DATABASE_URL_UNPOOLED') : null;
  if (admin && (admin.database !== app.database || admin.endpointKey !== app.endpointKey)) {
    throw new DbTargetError(
      `DATABASE_URL and DATABASE_URL_UNPOOLED resolve to different databases or endpoints (${app.database}@${app.endpointKey} vs ${admin.database}@${admin.endpointKey}). Refusing: the command would split its connections.`,
    );
  }

  if (target === 'production') {
    if (env.DB_TARGET !== 'production' || env[ALLOW_PRODUCTION_DB_COMMANDS] !== 'true') {
      throw new DbTargetError(
        `production ${purpose} requires DB_TARGET=production AND ${ALLOW_PRODUCTION_DB_COMMANDS}=true in the process environment. Refusing.`,
      );
    }
    const fromDotenv =
      dotenvValues.DB_TARGET !== undefined ||
      dotenvValues[ALLOW_PRODUCTION_DB_COMMANDS] !== undefined ||
      (dotenvValues.DATABASE_URL !== undefined && dotenvValues.DATABASE_URL === env.DATABASE_URL) ||
      (dotenvValues.DATABASE_URL_UNPOOLED !== undefined && dotenvValues.DATABASE_URL_UNPOOLED === env.DATABASE_URL_UNPOOLED);
    if (fromDotenv) {
      throw new DbTargetError(
        'production target values are present in packages/rab-server/.env. Production authority must come from the deployment environment, not that file. Refusing.',
      );
    }
    if (
      app.endpointKey !== EXPECTED_PRODUCTION_IDENTITY.endpointKey ||
      app.database !== EXPECTED_PRODUCTION_IDENTITY.database
    ) {
      throw new DbTargetError(
        `resolved identity (${app.endpointKey} / ${app.database}) is not the expected production identity. Refusing. Update EXPECTED_PRODUCTION_IDENTITY only by deliberate change.`,
      );
    }
    return { purpose, target, classification: 'PRODUCTION', app, admin, appUrl, adminUrl };
  }

  if (target === 'staging') {
    throw new DbTargetError('DB_TARGET=staging is refused: no expected staging identity is configured. Fail closed.');
  }

  // local and test: must not be a dotted remote host. test may only be remote with the explicit test override.
  const remoteAllowed = target === 'test' && env.ALLOW_REMOTE_TEST_DATABASE === 'true';
  if (!isLocalHost(app) && !remoteAllowed) {
    throw new DbTargetError(
      `DB_TARGET=${target} refuses a remote host ("${app.host}"). Use a loopback or docker-service database.`,
    );
  }
  if (admin && !isLocalHost(admin) && !remoteAllowed) {
    throw new DbTargetError(`DB_TARGET=${target} refuses a remote DATABASE_URL_UNPOOLED host ("${admin.host}").`);
  }
  if (app.endpointKey === EXPECTED_PRODUCTION_IDENTITY.endpointKey) {
    throw new DbTargetError(`DB_TARGET=${target} points at the expected production endpoint. Refusing.`);
  }
  return { purpose, target, classification: 'NON-PRODUCTION', app, admin, appUrl, adminUrl };
}

/** Read-only probe: SELECT only, in a read-only session. Returns the database name and cluster identifier. */
export async function probeDbIdentity(url: string, label: string): Promise<{ database: string; systemIdentifier: string }> {
  const client = new Client({
    connectionString: url,
    connectionTimeoutMillis: 10_000,
    options: '-c default_transaction_read_only=on',
  });
  try {
    await client.connect();
    const result = await client.query<{ db: string; sid: string }>(
      `SELECT current_database() AS db, (SELECT system_identifier::text FROM pg_control_system()) AS sid`,
    );
    const row = result.rows[0];
    if (!row) throw new Error('empty probe');
    return { database: row.db, systemIdentifier: row.sid };
  } catch (error) {
    const code = (error as { code?: string }).code ?? 'unknown';
    throw new DbTargetError(`Cannot reach the ${label} database for the read-only identity probe (driver code ${code}).`);
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** Reads packages/rab-server/.env as data only. Never loads it into process.env here. */
export function readDotenvValues(filePath: string = path.resolve(__dirname, '../../../../.env')): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  return parseDotenv(fs.readFileSync(filePath));
}

/**
 * Full guard: resolve, probe both connections read-only, confirm they agree, print a sanitised summary, return.
 * Call before any write-capable operation. Throws DbTargetError (or TestDatabaseConfigError from the probe helper) to fail.
 */
export async function assertDbTarget(
  purpose: string,
  env: Record<string, string | undefined> = process.env,
  dotenvValues: Record<string, string> = readDotenvValues(),
): Promise<ResolvedDbTarget> {
  const resolved = resolveDbTarget({ purpose, env, dotenvValues });
  const appProbe = await probeDbIdentity(resolved.appUrl, 'DATABASE_URL');
  if (resolved.adminUrl) {
    const adminProbe = await probeDbIdentity(resolved.adminUrl, 'DATABASE_URL_UNPOOLED');
    if (adminProbe.database !== appProbe.database || adminProbe.systemIdentifier !== appProbe.systemIdentifier) {
      throw new DbTargetError('runtime identity mismatch between DATABASE_URL and DATABASE_URL_UNPOOLED. Refusing.');
    }
  }
  if (resolved.target === 'production' && appProbe.database !== EXPECTED_PRODUCTION_IDENTITY.database) {
    throw new DbTargetError('the server reports a database name that is not the expected production database. Refusing.');
  }
  // Sanitised summary: no URL, host userinfo, password or username.
  // eslint-disable-next-line no-console
  console.log(
    `[db-target] purpose=${purpose} target=${resolved.target} classification=${resolved.classification} endpoint=${resolved.app.endpointKey} database=${appProbe.database} cluster=${appProbe.systemIdentifier} probe=read-only-ok`,
  );
  return resolved;
}
