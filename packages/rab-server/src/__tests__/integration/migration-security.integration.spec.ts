import 'reflect-metadata';
import { DataSource, QueryRunner } from 'typeorm';
import { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';

import { withCrewflowCoreCreate } from '../../database/typeorm/core/core-schema-create-scope';
import { postMigrationPrivilegeProblems, privilegeDriftSnapshot } from '../../database/typeorm/core/migration-privilege-drift';
import { migrationSourceViolations } from '../../database/typeorm/core/migration-source-rules';
import { NavigationLayoutCrewflowOwner1786721110000 } from '../../database/typeorm/core/migrations/1786721110000-NavigationLayoutCrewflowOwner';
import { createAdminDataSource } from './helpers/admin-datasource';

/**
 * M2: the catalog drift check (migration-privilege-drift.ts) against fixture migrations, on a database built from migrations
 * with Phase 0b applied. Every fixture runs inside ONE transaction that is always rolled back: the restricted migrator role,
 * the fixture objects and every grant disappear with it.
 *
 * A fixture runs as a throwaway restricted migrator (NOSUPERUSER, NOBYPASSRLS, member of rab_secure_owner and crewflow only,
 * the identity the CI job uses), or as the superuser where only a bootstrap identity could make that change at all; the
 * checker must catch the change whoever made it. The dynamic-SQL fixture shows why the source scan is only an early
 * warning: it passes the scan and is still caught here.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(600_000); // two invariant runs per test, ~30 s each on a database past the M2-F4 plan cliff

type Fixture = (qr: QueryRunner) => Promise<unknown>;

/**
 * M2-F4: the committed Phase 0b invariants query takes ~30 s once a database holds 5+ workspace schemas (earlier suites in
 * the same run provision them), the admin connection's default server AND client limit. This suite's own connection only;
 * no runtime setting and no assertion is weakened.
 */
function createSlowCatalogAdminDataSource(): DataSource {
  const ds = createAdminDataSource();
  const extra = (ds.options as PostgresConnectionOptions).extra ?? {};
  ds.setOptions({ extra: { ...extra, statement_timeout: 180_000, query_timeout: 200_000 } } as Partial<PostgresConnectionOptions>);
  return ds;
}

describeIfDb('M2: catalog drift check catches unsafe migrations and passes safe ones', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = createSlowCatalogAdminDataSource();
    await ds.initialize();
    const [me] = await ds.query('SELECT rolsuper FROM pg_roles WHERE rolname = current_user');
    if (!me?.rolsuper) throw new Error('this suite needs the disposable database bootstrap superuser as TEST_DATABASE_URL_UNPOOLED');
    const [core] = await ds.query(`SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = 'core'`);
    if (core?.owner !== 'rab_secure_owner') throw new Error('this suite needs a database with Phase 0b applied');
  });

  afterAll(async () => {
    await ds?.destroy();
  });

  /** Problems the checker reports for `fixture`, run as `as`, all inside one rolled-back transaction. */
  async function problemsAfter(as: 'restricted' | 'superuser', fixture: Fixture): Promise<string[]> {
    const qr = ds.createQueryRunner();
    await qr.connect();
    const query = (sql: string) => qr.query(sql) as Promise<Array<Record<string, unknown>>>;
    try {
      await qr.startTransaction();
      const before = await privilegeDriftSnapshot(query);
      if (as === 'restricted') {
        const role = `m2_mig_${Math.random().toString(36).slice(2, 8)}`;
        await qr.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
        await qr.query(`GRANT rab_secure_owner, crewflow TO ${role} WITH INHERIT TRUE, SET TRUE`);
        await qr.query(`SET ROLE ${role}`);
      }
      await fixture(qr);
      await qr.query('RESET ROLE');
      return await postMigrationPrivilegeProblems(query, before);
    } finally {
      await qr.rollbackTransaction().catch(() => undefined);
      await qr.release();
    }
  }

  /** SQLSTATE of `fixture` run as the restricted migrator (null when it succeeds). */
  async function restrictedSqlState(fixture: Fixture): Promise<string | null> {
    try {
      await problemsAfter('restricted', fixture);
      return null;
    } catch (e) {
      return (e as { code?: string; driverError?: { code?: string } }).code ?? (e as { driverError?: { code?: string } }).driverError?.code ?? 'unknown';
    }
  }

  it('a safe migration (new core table handed to crewflow inside withCrewflowCoreCreate, runtime grant) reports nothing', async () => {
    expect(
      await problemsAfter('restricted', async (qr) => {
        await qr.query('CREATE TABLE core.m2_fixture_safe (id uuid PRIMARY KEY, organisation_id uuid NOT NULL)');
        await withCrewflowCoreCreate(qr, () => qr.query('ALTER TABLE core.m2_fixture_safe OWNER TO crewflow'));
        await qr.query('GRANT SELECT ON core.m2_fixture_safe TO crewflow_app');
      }),
    ).toEqual([]);
  });

  it('a body that fails inside withCrewflowCoreCreate, with the error caught by the migration, leaves no privilege change', async () => {
    expect(
      await problemsAfter('restricted', async (qr) => {
        await qr.query('CREATE TABLE core.m2_fixture_caught (i int)');
        await withCrewflowCoreCreate(qr, async () => {
          await qr.query('ALTER TABLE core.m2_fixture_caught OWNER TO crewflow');
          await qr.query('SELECT 1/0');
        }).catch(() => undefined);
      }),
    ).toEqual([]);
  });

  it('a migration that leaves CREATE on core with crewflow is caught', async () => {
    const problems = await problemsAfter('restricted', (qr) => qr.query('GRANT CREATE ON SCHEMA core TO crewflow'));
    expect(problems).toEqual(
      expect.arrayContaining([
        'privilege-drift - schema-create|core|crewflow|false',
        'privilege-drift + schema-create|core|crewflow|true',
        'crewflow holds CREATE on schema core',
      ]),
    );
  });

  it('the same grant assembled at run time passes the source scan and is still caught by the catalog check', async () => {
    const source = `await q.query(\`DO $$ BEGIN EXECUTE format('GRANT %s ON SCHEMA %I TO %I', 'CR' || 'EATE', 'co' || 're', 'crewflow'); END $$\`)`;
    expect(migrationSourceViolations(source)).toEqual([]);
    const problems = await problemsAfter('restricted', (qr) =>
      qr.query(`DO $$ BEGIN EXECUTE format('GRANT %s ON SCHEMA %I TO %I', 'CR' || 'EATE', 'co' || 're', 'crewflow'); END $$`),
    );
    expect(problems).toContain('crewflow holds CREATE on schema core');
  });

  it('a database-level CREATE grant to crewflow_app is caught', async () => {
    const problems = await problemsAfter('restricted', (qr) => qr.query(`DO $$ BEGIN EXECUTE format('GRANT CREATE ON DATABASE %I TO crewflow_app', current_database()); END $$`));
    expect(problems).toContain('privilege-drift + database|crewflow_app|create=true|temp=true');
  });

  it('a new SECURITY DEFINER owned by rab_secure_owner without a pinned search_path is caught by the secure-owner invariants', async () => {
    const problems = await problemsAfter('restricted', async (qr) => {
      await qr.query(`CREATE FUNCTION core.m2_fixture_definer() RETURNS int LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'`);
      await qr.query('ALTER FUNCTION core.m2_fixture_definer() OWNER TO rab_secure_owner');
    });
    expect(problems.some((p) => p.startsWith('secure-owner-invariant ') && p.includes('m2_fixture_definer'))).toBe(true);
  });

  it('owner-role membership, elevated runtime attributes and runtime-owned objects are refused to the restricted migrator', async () => {
    expect(await restrictedSqlState((qr) => qr.query('GRANT rab_secure_owner TO crewflow'))).toBe('42501');
    expect(await restrictedSqlState((qr) => qr.query('ALTER ROLE crewflow_app BYPASSRLS'))).toBe('42501');
    expect(await restrictedSqlState((qr) => qr.query('ALTER ROLE crewflow CREATEROLE'))).toBe('42501');
    expect(await restrictedSqlState(async (qr) => {
      await qr.query('CREATE TABLE core.m2_fixture_app_owned (i int)');
      await qr.query('ALTER TABLE core.m2_fixture_app_owned OWNER TO crewflow_app');
    })).toBe('42501');
  });

  it('...and the checker still catches each of them when a bootstrap identity makes the change', async () => {
    expect(await problemsAfter('superuser', (qr) => qr.query('GRANT rab_secure_owner TO crewflow'))).toEqual(
      expect.arrayContaining([
        'privilege-drift + member|crewflow|of|rab_secure_owner|admin=false|inherit=true|set=true',
        // ...which, through inheritance, also hands crewflow CREATE on core again.
        'crewflow holds CREATE on schema core',
      ]),
    );
    expect(await problemsAfter('superuser', (qr) => qr.query('ALTER ROLE crewflow_app BYPASSRLS'))).toEqual(
      expect.arrayContaining([expect.stringMatching(/^privilege-drift \+ role\|crewflow_app\|.*bypassrls=true/)]),
    );
    expect(
      await problemsAfter('superuser', async (qr) => {
        await qr.query('CREATE TABLE core.m2_fixture_app_owned (i int)');
        await qr.query('ALTER TABLE core.m2_fixture_app_owned OWNER TO crewflow_app');
      }),
    ).toEqual(expect.arrayContaining(['privilege-drift - crewflow_app-owns|0', expect.stringMatching(/^privilege-drift \+ crewflow_app-owns\|[1-9]/)]));
  });
});

/**
 * M2-F2: NavigationLayoutCrewflowOwner1786721110000, run directly inside a rolled-back transaction for every branch: no-op
 * where crewflow already owns the table (every existing database), repair of a table left with the migration login, and
 * refusal for an unexpected owner or an identity that cannot act as the owner.
 */
describeIfDb('M2-F2: navigation_layout ownership repair', () => {
  let ds: DataSource;
  const STATE = `SELECT pg_get_userbyid(c.relowner) AS owner, c.relrowsecurity AS rls, c.relforcerowsecurity AS force,
                        has_table_privilege('crewflow_app', c.oid, 'SELECT,INSERT,UPDATE') AS app_siu,
                        has_table_privilege('crewflow_app', c.oid, 'DELETE') AS app_d,
                        has_table_privilege('crewflow', c.oid, 'DELETE') AS crewflow_d,
                        (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies,
                        has_schema_privilege('crewflow', 'core', 'CREATE') AS crewflow_core_create
                   FROM pg_class c WHERE c.oid = 'core.navigation_layout'::regclass`;
  const GOOD = { owner: 'crewflow', rls: true, force: true, app_siu: true, app_d: false, crewflow_d: true, policies: 1, crewflow_core_create: false };

  beforeAll(async () => {
    ds = createSlowCatalogAdminDataSource();
    await ds.initialize();
  });
  afterAll(async () => {
    await ds?.destroy();
  });

  /** Runs `body` in a rolled-back transaction with a throwaway restricted migrator role `role` available. */
  async function inTxn(body: (qr: QueryRunner, role: string) => Promise<void>): Promise<void> {
    const qr = ds.createQueryRunner();
    await qr.connect();
    try {
      await qr.startTransaction();
      const role = `m2_f2_${Math.random().toString(36).slice(2, 8)}`;
      await qr.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
      await qr.query(`GRANT rab_secure_owner, crewflow TO ${role} WITH INHERIT TRUE, SET TRUE`);
      await body(qr, role);
    } finally {
      await qr.rollbackTransaction().catch(() => undefined);
      await qr.release();
    }
  }

  it('every existing database already has the target state, and the migration leaves it untouched', async () => {
    await inTxn(async (qr, role) => {
      expect((await qr.query(STATE))[0]).toEqual(GOOD);
      await qr.query(`SET ROLE ${role}`);
      await new NavigationLayoutCrewflowOwner1786721110000().up(qr);
      await qr.query('RESET ROLE');
      expect((await qr.query(STATE))[0]).toEqual(GOOD);
    });
  });

  it('a table left with the migration login is handed to crewflow by a restricted migrator, grants and FORCE RLS preserved', async () => {
    await inTxn(async (qr, role) => {
      // Reproduce the fresh restricted install: the migration login owns the table; crewflow kept only its explicit grant.
      await qr.query(`ALTER TABLE core.navigation_layout OWNER TO ${role}`);
      await qr.query('REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON core.navigation_layout FROM crewflow');
      expect((await qr.query(STATE))[0]).toMatchObject({ owner: role, crewflow_d: false, force: true });
      await qr.query(`SET ROLE ${role}`);
      await new NavigationLayoutCrewflowOwner1786721110000().up(qr);
      await qr.query('RESET ROLE');
      expect((await qr.query(STATE))[0]).toEqual(GOOD);
    });
  });

  it('refuses a table owned by rab_secure_owner (unexpected owner), changing nothing', async () => {
    await inTxn(async (qr, role) => {
      await qr.query('ALTER TABLE core.navigation_layout OWNER TO rab_secure_owner');
      await qr.query(`SET ROLE ${role}`);
      await expect(new NavigationLayoutCrewflowOwner1786721110000().up(qr)).rejects.toThrow('does not expect');
      await qr.query('RESET ROLE');
      expect((await qr.query(STATE))[0].owner).toBe('rab_secure_owner');
    });
  });

  it('refuses a table owned by a superuser or by crewflow_app (unexpected owners), changing nothing', async () => {
    for (const ownerOf of ['superuser', 'crewflow_app'] as const) {
      await inTxn(async (qr, role) => {
        const owner = ownerOf === 'superuser' ? (await qr.query('SELECT session_user AS u'))[0].u : 'crewflow_app';
        await qr.query(`ALTER TABLE core.navigation_layout OWNER TO "${owner}"`);
        await qr.query(`SET ROLE ${role}`);
        await expect(new NavigationLayoutCrewflowOwner1786721110000().up(qr)).rejects.toThrow('does not expect');
        await qr.query('RESET ROLE');
        expect((await qr.query(STATE))[0].owner).toBe(owner);
      });
    }
  });

  it('refuses, even for a superuser runner, a table owned by a login that is not the running identity', async () => {
    await inTxn(async (qr, role) => {
      const other = `${role}_login`;
      await qr.query(`CREATE ROLE ${other} LOGIN NOSUPERUSER`);
      await qr.query(`ALTER TABLE core.navigation_layout OWNER TO ${other}`);
      await expect(new NavigationLayoutCrewflowOwner1786721110000().up(qr)).rejects.toThrow('not the running migration identity');
      expect((await qr.query(STATE))[0].owner).toBe(other);
    });
  });

  it('refuses when the running identity cannot act as the current owner', async () => {
    await inTxn(async (qr, role) => {
      const stranger = `${role}_x`;
      await qr.query(`CREATE ROLE ${stranger} NOLOGIN`);
      await qr.query(`ALTER TABLE core.navigation_layout OWNER TO ${stranger}`);
      await qr.query(`SET ROLE ${role}`);
      await expect(new NavigationLayoutCrewflowOwner1786721110000().up(qr)).rejects.toThrow('not the running migration identity');
      await qr.query('RESET ROLE');
      expect((await qr.query(STATE))[0].owner).toBe(stranger);
    });
  });
});
