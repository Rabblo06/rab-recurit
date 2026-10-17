import { Client } from 'pg';

import {
  ALLOW_REMOTE_TEST_DATABASE,
  describeDatabaseUrl,
  probeDatabaseIdentity,
  resolveIntegrationTestDatabase,
  TEST_DATABASE_URL,
  TEST_DATABASE_URL_UNPOOLED,
  TestDatabaseConfigError,
} from '@rab/server/database/typeorm/core/test-database-guard';

/**
 * A connection string for ONE specific database role on the isolated integration-test database, verified before any test
 * uses it. Fails closed: every failure throws `TestDatabaseConfigError`, so the test fails. It never skips, never falls back
 * to the developer's `.env`, `DATABASE_URL` or a hardcoded URL, and never connects anywhere else.
 *
 * Checks, all of which must pass:
 *   - the value comes from the named TEST_* environment variable only;
 *   - it parses, and a remote host is refused unless ALLOW_REMOTE_TEST_DATABASE=true (same rule as test-database-guard.ts);
 *   - live probe: it reaches the SAME database in the SAME cluster as TEST_DATABASE_URL_UNPOOLED, the admin connection the
 *     fixtures are written through;
 *   - live probe: it authenticates as exactly `expectedRole`, which is neither superuser nor BYPASSRLS.
 *
 * Error messages never contain a URL, user name or password.
 */
export async function resolveVerifiedRoleDatabaseUrl(
  envVar: string,
  expectedRole: 'crewflow_app' | 'crewflow',
): Promise<string> {
  const resolved = resolveIntegrationTestDatabase(process.env);
  const url = process.env[envVar]?.trim();
  if (!url) {
    throw new TestDatabaseConfigError(
      `${envVar} is required: a ${expectedRole} login on the isolated test database. There is no fallback.`,
    );
  }
  const identity = describeDatabaseUrl(url, envVar);
  if (identity.remote && process.env[ALLOW_REMOTE_TEST_DATABASE] !== 'true') {
    throw new TestDatabaseConfigError(
      `${envVar} names a remote host "${identity.host}". Refused unless ${ALLOW_REMOTE_TEST_DATABASE}=true is set deliberately.`,
    );
  }
  const [mine, admin] = await Promise.all([
    probeDatabaseIdentity(url, envVar),
    probeDatabaseIdentity(resolved.adminUrl, TEST_DATABASE_URL_UNPOOLED),
  ]);
  if (
    mine.database !== admin.database ||
    mine.systemIdentifier !== admin.systemIdentifier
  ) {
    throw new TestDatabaseConfigError(
      `${envVar} reached database "${mine.database}" (cluster ${mine.systemIdentifier}), not the test database "${admin.database}" (cluster ${admin.systemIdentifier}) the fixtures are written to. Refusing.`,
    );
  }
  const client = new Client({
    connectionString: url,
    connectionTimeoutMillis: 10_000,
  });
  try {
    await client.connect();
    const { rows } = await client.query<{
      role: string;
      superuser: boolean;
      bypass: boolean;
    }>(
      `SELECT current_user AS role, r.rolsuper AS superuser, r.rolbypassrls AS bypass FROM pg_roles r WHERE r.rolname = current_user`,
    );
    const row = rows[0];
    if (!row || row.role !== expectedRole || row.superuser || row.bypass) {
      throw new TestDatabaseConfigError(
        `${envVar} must authenticate as ${expectedRole} without SUPERUSER or BYPASSRLS (got ${row ? `${row.superuser ? 'a superuser' : row.bypass ? 'a BYPASSRLS role' : 'a different role'}` : 'no role row'}). Refusing.`,
      );
    }
  } finally {
    await client.end().catch(() => undefined);
  }
  return url;
}

/** The restricted runtime role: TEST_DATABASE_URL, which jest-setup.ts also binds to DATABASE_URL for the app under test. */
export const verifiedRestrictedRuntimeUrl = (): Promise<string> =>
  resolveVerifiedRoleDatabaseUrl(TEST_DATABASE_URL, 'crewflow_app');

/** The ordinary migration/DDL role the provisioner authenticates as, on the same test database. */
export const TEST_DATABASE_CREWFLOW_URL = 'TEST_DATABASE_CREWFLOW_URL';
export const verifiedCrewflowUrl = (): Promise<string> =>
  resolveVerifiedRoleDatabaseUrl(TEST_DATABASE_CREWFLOW_URL, 'crewflow');
