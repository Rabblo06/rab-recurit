import { Client } from 'pg';

import { integrationTestDatabase } from '../typeorm/core/integration-test-database-gate';
import { assertDatabaseOwnershipGate, BOOT_FACTS_SQL, DatabaseBootGateError, parseBootFacts } from './database-boot-gate-rules';
import { OWNER_LOGIN_FACTS_SQL, ownerLoginRolePostureProblems } from './owner-login-posture';

/**
 * Owner decision 2026-11-19 (boot refusals, "refuse to start if the login ... owns the database, is a member of
 * neon_superuser or another admin role"), on REAL PostgreSQL: the read-only fact queries the boot gate and the posture rules
 * run see each planted condition, and the rules refuse it. Every plant is made by the cluster superuser inside a
 * transaction that is ROLLED BACK; the queries are evaluated for crewflow_owner inside that open transaction (they read
 * catalogs only), exactly as owner-login-guards.integration.spec.ts does. Skipped (NOT a pass) unless TEST_DATABASE_URL is
 * the owner login.
 */
const env = integrationTestDatabase();
const OWNER = env.app.login === 'crewflow_owner';
const suite = OWNER ? describe : describe.skip;
if (!OWNER) console.warn('[owner-login boot refusals] SKIPPED: TEST_DATABASE_URL is not the owner login crewflow_owner (NOT a pass).'); // eslint-disable-line no-console

type Rows = Array<Record<string, unknown>>;

suite('owner-login boot refusals (real PostgreSQL, as crewflow_owner)', () => {
  let admin: Client;
  let database: string;
  const asOwner = async (sql: string, params?: unknown[]): Promise<Rows> =>
    (await admin.query(sql.replace(/session_user/g, `'crewflow_owner'::name`).replace(/current_user/g, `'crewflow_owner'::name`), params as unknown[] | undefined)).rows;
  const planted = async <T>(setup: string[], fn: () => Promise<T>): Promise<T> => {
    await admin.query('BEGIN');
    try {
      for (const sql of setup) await admin.query(sql);
      return await fn();
    } finally {
      await admin.query('ROLLBACK');
    }
  };
  const quoted = () => `"${database.replace(/"/g, '""')}"`;
  const gateRefusal = (row: Record<string, unknown> | undefined): string => {
    try {
      assertDatabaseOwnershipGate(parseBootFacts(row), true, 'api process');
    } catch (error) {
      expect(error).toBeInstanceOf(DatabaseBootGateError);
      return (error as Error).message;
    }
    return '';
  };

  beforeAll(async () => {
    admin = new Client({ connectionString: env!.adminUrl });
    await admin.connect();
    database = String((await admin.query('SELECT pg_catalog.current_database() AS d')).rows[0].d);
  });
  afterAll(async () => {
    await admin?.end();
  });

  it('the test database is not owned by the owner login: both fact queries say so and the production gate passes', async () => {
    const [facts] = await asOwner(BOOT_FACTS_SQL);
    expect({ owns: facts.owns_database, member: facts.member_of_database_owner, pgdbo: facts.database_owner_role }).toEqual({ owns: false, member: false, pgdbo: false });
    expect(gateRefusal(facts)).toBe('');
    const [login] = await asOwner(OWNER_LOGIN_FACTS_SQL);
    expect({ owns: login.owns_database, member: login.member_of_database_owner, pgdbo: login.database_owner_role }).toEqual({ owns: false, member: false, pgdbo: false });
  });

  it('DENIAL: crewflow_owner owning the database directly is refused (boot gate and posture rule 1 in production)', async () => {
    await planted([`ALTER DATABASE ${quoted()} OWNER TO crewflow_owner`], async () => {
      const [facts] = await asOwner(BOOT_FACTS_SQL);
      expect(facts).toMatchObject({ owns_database: true, member_of_database_owner: true, database_owner_role: true, database_owner: 'crewflow_owner' });
      expect(gateRefusal(facts)).toMatch(/"crewflow_owner" owns the current database/);
      expect((await ownerLoginRolePostureProblems(asOwner, { refuseDatabaseOwnership: true })).join('; ')).toMatch(/owns the current database/);
    });
  });

  it('DENIAL: owning it through a role (any membership, even INHERIT FALSE / SET FALSE) is refused, and pg_database_owner shows it', async () => {
    await planted(
      ['CREATE ROLE g_db_owner NOLOGIN', 'GRANT g_db_owner TO crewflow_owner WITH INHERIT FALSE, SET FALSE', `ALTER DATABASE ${quoted()} OWNER TO g_db_owner`],
      async () => {
        const [facts] = await asOwner(BOOT_FACTS_SQL);
        expect(facts).toMatchObject({ owns_database: false, member_of_database_owner: true, database_owner: 'g_db_owner' });
        const message = gateRefusal(facts);
        expect(message).toMatch(/is a member of "g_db_owner", the owner of the current database/);
        expect(message).toMatch(/ALTER DATABASE <database> OWNER TO <admin>/);
      },
    );
  });

  it('DENIAL: a reachable CREATEROLE role is refused by the reachability walk (ADMIN-only edge included)', async () => {
    await planted(['CREATE ROLE g_createrole NOLOGIN CREATEROLE', 'GRANT g_createrole TO crewflow WITH ADMIN TRUE, INHERIT FALSE, SET FALSE'], async () => {
      expect((await ownerLoginRolePostureProblems(asOwner)).join('; ')).toMatch(/"g_createrole" has CREATEROLE and is reachable from crewflow_owner \(crewflow_owner>crewflow>g_createrole\)/);
    });
  });

  it.each([
    ['pg_checkpoint', /predefined role "pg_checkpoint" is reachable/],
    ['pg_use_reserved_connections', /predefined role "pg_use_reserved_connections" is reachable/],
    ['pg_write_server_files', /predefined role "pg_write_server_files" is reachable/],
  ])('DENIAL: a reachable %s is refused', async (role, pattern) => {
    await planted([`GRANT ${role} TO rab_owner WITH INHERIT FALSE, SET FALSE`], async () => {
      expect((await ownerLoginRolePostureProblems(asOwner)).join('; ')).toMatch(pattern);
    });
  });

  it.each(['rds_superuser', 'azure_pg_admin', 'cloudsqlsuperuser', 'alloydbsuperuser', 'tsdbadmin'])('DENIAL: membership of a provider admin role named %s is refused', async (role) => {
    await planted([`CREATE ROLE ${role} NOLOGIN`, `GRANT ${role} TO crewflow_owner WITH INHERIT FALSE, SET FALSE`], async () => {
      expect((await ownerLoginRolePostureProblems(asOwner)).join('; ')).toMatch(new RegExp(`provider administrator role "${role}"`));
    });
  });
});
