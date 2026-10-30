import { RuntimeDbError } from '../core/runtime-database-guard';
import { checkPendingMigrations } from './check-pending-migrations';

/**
 * Security review N-3: the API prestart check runs before main.js, so it applies the API runtime guard's pure rules itself
 * and opens NO connection when they refuse. `openDataSource` is the only way the check connects; it must never be called
 * on a refusal. Fake credentials only.
 */
const SECRET = 'S3cret-PW-do-not-print';
const LOCAL = `postgres://crewflow_app:${SECRET}@127.0.0.1:55462/rab`;
const PROD_NEON = `postgres://crewflow_app:${SECRET}@ep-round-rain-aess0njf.c-2.us-east-2.aws.neon.tech/neondb?sslmode=require`;
const OPENED = new Error('opened a connection');

async function refusedWithoutConnecting(env: Record<string, string | undefined>, pattern: RegExp, dotenvValues: Record<string, string> = {}): Promise<void> {
  const open = jest.fn(async () => {
    throw OPENED;
  });
  let caught: unknown;
  try {
    await checkPendingMigrations(env, dotenvValues, open);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(RuntimeDbError);
  expect((caught as Error).message).toMatch(pattern);
  expect((caught as Error).message).not.toContain(SECRET);
  expect(open).not.toHaveBeenCalled();
}

describe('check-pending-migrations (API prestart): runtime guard before any connection (security review N-3)', () => {
  it('refuses the unmarked production endpoint (deny list), including its trailing-dot spelling, with zero connections', async () => {
    await refusedWithoutConnecting({ NODE_ENV: 'development', PG_DATABASE_URL: PROD_NEON }, /names the current production Neon endpoint/);
    await refusedWithoutConnecting(
      { NODE_ENV: 'development', PG_DATABASE_URL: PROD_NEON.replace('neon.tech/', 'neon.tech./') },
      /names the current production Neon endpoint/,
    );
  });

  it('refuses migration / command authority in the API environment, and a half-declared production, with zero connections', async () => {
    await refusedWithoutConnecting({ NODE_ENV: 'development', PG_DATABASE_URL: LOCAL, CREWFLOW_MIGRATION_APPROVED: 'apply-pending-migrations' }, /CREWFLOW_MIGRATION_APPROVED is present/);
    await refusedWithoutConnecting({ NODE_ENV: 'development', PG_DATABASE_URL: LOCAL, DB_TARGET: 'production' }, /DB_TARGET is present/);
    await refusedWithoutConnecting({ NODE_ENV: 'production', PG_DATABASE_URL: LOCAL }, /requires RAB_RUNTIME_ENV=production/);
  });

  it('refuses a URL the policy rejects (Neon password routing through another host, a ?host= override) with zero connections', async () => {
    await refusedWithoutConnecting({ NODE_ENV: 'development', PG_DATABASE_URL: `postgres://crewflow_app:endpoint%3Dep-round-rain-aess0njf%24${SECRET}@127.0.0.1:15432/neondb` }, /Neon password routing/);
    await refusedWithoutConnecting({ NODE_ENV: 'development', PG_DATABASE_URL: `${LOCAL}?host=db.attacker.example` }, /sets "host" as a query parameter/);
  });

  it('a guard-clean environment proceeds to open its connection (the guard is a gate, not a replacement for the check)', async () => {
    const open = jest.fn(async () => {
      throw OPENED;
    });
    await expect(checkPendingMigrations({ NODE_ENV: 'development', DB_TARGET: 'local', PG_DATABASE_URL: LOCAL }, {}, open)).rejects.toBe(OPENED);
    expect(open).toHaveBeenCalledTimes(1);
  });
});
