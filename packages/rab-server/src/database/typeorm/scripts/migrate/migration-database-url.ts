/**
 * Phase B (P1/P7): the connection of the one-off migration process (`rab-migrate`: setup-db.ts, deploy-prepare.ts,
 * migrate-workspace-schemas.ts). The migration credential lives ONLY in that process's environment, as `PG_DATABASE_URL`;
 * the API and the Worker get their own `PG_DATABASE_URL` (the restricted runtime role) and never see it.
 *
 * Resolution is the shared factory's (src/database/postgres, `resolvePgEnvironment` with processRole `migrate`): production
 * (NODE_ENV, RAB_RUNTIME_ENV or DB_TARGET = production) requires PG_DATABASE_URL and refuses every legacy name and libpq
 * variable; outside production PG_DATABASE_URL wins over the deprecated DATABASE_URL, and the deprecated
 * DATABASE_URL_UNPOOLED still names the elevated (migration) connection, with warnings; a transaction-pooler URL shape is
 * refused (the migration lock is a session advisory lock); TLS follows pg-tls.ts. The migration endpoint is the elevated
 * one when configured, else the primary one, exactly as core.datasource.ts's migration options choose it.
 *
 * Two rules on top of the factory, both refusals:
 *   - PG_DATABASE_URL and the deprecated DATABASE_URL_UNPOOLED both set and naming different targets: the factory would
 *     use DATABASE_URL_UNPOOLED; this process refuses instead of silently running as a credential other than the one
 *     PG_DATABASE_URL names;
 *   - production: a PG_DATABASE_URL identical to the one in packages/rab-server/.env (production authority comes from the
 *     deployment environment, as database-target.ts already requires for DB_TARGET and the old URL names).
 *
 * Messages never contain a URL, user name or password: only variable names.
 */
import { PgConfigError, PgEndpoint, resolvePgEnvironment, ResolvedPgEnvironment } from '../../../postgres';

export class MigrationDatabaseUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationDatabaseUrlError';
  }
}

export interface ResolvedMigrationConnection {
  resolved: ResolvedPgEnvironment;
  /** Which factory endpoint the migration session uses. */
  endpoint: 'elevated' | 'primary';
  /** The variable the URL came from. Safe to print. */
  source: string;
  /** The raw URL, for database-target.ts (which takes a connection string). Never printed. */
  url: string;
  warnings: string[];
}

const sameTarget = (a: PgEndpoint, b: PgEndpoint): boolean =>
  a.target.host === b.target.host && a.target.port === b.target.port && a.target.user === b.target.user && a.target.database === b.target.database;

/** Throws MigrationDatabaseUrlError (or the factory's PgConfigError); never echoes a value. */
export function resolveMigrationConnection(
  env: Record<string, string | undefined>,
  dotenvValues: Record<string, string> = {},
): ResolvedMigrationConnection {
  const resolved = resolvePgEnvironment(env, { processRole: 'migrate' });
  const pgUrl = env.PG_DATABASE_URL?.trim();
  if (pgUrl && resolved.elevated && !sameTarget(resolved.primary, resolved.elevated)) {
    throw new MigrationDatabaseUrlError(
      'PG_DATABASE_URL and the deprecated DATABASE_URL_UNPOOLED are both set and name different targets. The migration process takes PG_DATABASE_URL only; remove DATABASE_URL_UNPOOLED. Refusing.',
    );
  }
  if (resolved.production && pgUrl && dotenvValues.PG_DATABASE_URL !== undefined && dotenvValues.PG_DATABASE_URL.trim() === pgUrl) {
    throw new MigrationDatabaseUrlError(
      'PG_DATABASE_URL comes from packages/rab-server/.env. Production authority must come from the deployment environment. Refusing.',
    );
  }
  const endpoint = resolved.elevated ? 'elevated' : 'primary';
  const chosen = resolved.elevated ?? resolved.primary;
  const url = env[chosen.source]?.trim();
  if (!url) throw new PgConfigError(`internal: ${chosen.source} resolved but is empty. Refusing.`);
  return { resolved, endpoint, source: chosen.source, url, warnings: resolved.warnings };
}

/**
 * The environment handed to database-target.ts. That guard resolves its connections through the same factory; the
 * migration process has exactly one connection, so the guard sees exactly that one, as PG_DATABASE_URL (the only name
 * production accepts), with every legacy name removed, and probes it once.
 */
export function targetGuardEnv(env: Record<string, string | undefined>, url: string): Record<string, string | undefined> {
  return { ...env, PG_DATABASE_URL: url, DATABASE_URL: undefined, DATABASE_URL_UNPOOLED: undefined, DATABASE_DIRECT_URL: undefined };
}
