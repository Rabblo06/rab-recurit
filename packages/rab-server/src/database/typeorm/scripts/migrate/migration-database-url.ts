/**
 * Phase B (P1/P7): the connection of the one-off migration process (`rab-migrate`: setup-db.ts, deploy-prepare.ts,
 * migrate-workspace-schemas.ts). The migration credential lives ONLY in that process's environment, as `PG_DATABASE_URL`;
 * the API and the Worker get their own `PG_DATABASE_URL` (the restricted runtime role) and never see it.
 *
 * Resolution is the shared factory's (src/database/postgres, `resolvePgEnvironment` with processRole `migrate`):
 * PG_DATABASE_URL is required and the legacy names (DATABASE_URL, DATABASE_URL_UNPOOLED, DATABASE_DIRECT_URL, DB_POOL_MAX)
 * are refused in every environment (X3.5-S8; release 1 still let DATABASE_URL_UNPOOLED name an elevated migration
 * connection outside production); production also refuses libpq variables; a transaction-pooler URL shape is refused (the
 * migration lock is a session advisory lock); TLS follows pg-tls.ts. The migration endpoint is the primary one, exactly as
 * core.datasource.ts's migration options choose it.
 *
 * One rule on top of the factory, a refusal:
 *   - production: a PG_DATABASE_URL identical to the one in packages/rab-server/.env (production authority comes from the
 *     deployment environment, as database-target.ts already requires for DB_TARGET and the old URL names).
 *
 * Messages never contain a URL, user name or password: only variable names.
 */
import { PgConfigError, resolvePgEnvironment, ResolvedPgEnvironment } from '../../../postgres';

export class MigrationDatabaseUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationDatabaseUrlError';
  }
}

export interface ResolvedMigrationConnection {
  resolved: ResolvedPgEnvironment;
  /** Which factory endpoint the migration session uses: the one primary endpoint (X3.5-S8). */
  endpoint: 'primary';
  /** The variable the URL came from. Safe to print. */
  source: string;
  /** The raw URL, for database-target.ts (which takes a connection string). Never printed. */
  url: string;
  warnings: string[];
}

/** Throws MigrationDatabaseUrlError (or the factory's PgConfigError); never echoes a value. */
export function resolveMigrationConnection(
  env: Record<string, string | undefined>,
  dotenvValues: Record<string, string> = {},
): ResolvedMigrationConnection {
  const resolved = resolvePgEnvironment(env, { processRole: 'migrate' });
  const pgUrl = env.PG_DATABASE_URL?.trim();
  if (resolved.production && pgUrl && dotenvValues.PG_DATABASE_URL !== undefined && dotenvValues.PG_DATABASE_URL.trim() === pgUrl) {
    throw new MigrationDatabaseUrlError(
      'PG_DATABASE_URL comes from packages/rab-server/.env or another .env file Nx loads. Production authority must come from the deployment environment. Refusing.',
    );
  }
  const endpoint = 'primary' as const;
  const chosen = resolved.primary;
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
