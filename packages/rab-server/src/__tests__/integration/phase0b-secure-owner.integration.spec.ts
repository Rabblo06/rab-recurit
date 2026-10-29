import 'reflect-metadata';
import { Client } from 'pg';
import { DataSource, QueryRunner } from 'typeorm';

import { withCrewflowCoreCreate } from '../../database/typeorm/core/core-schema-create-scope';
import { SecureOwnerCoreSchemaAndHelpers1786721100000 } from '../../database/typeorm/core/migrations/1786721100000-SecureOwnerCoreSchemaAndHelpers';
import {
  R4_CREWFLOW_TABLES_REACHED_BY_SECURE_DEFINERS,
  R4_TABLES_SQL,
  secureOwnerInvariantViolations,
} from '../../database/typeorm/core/secure-owner-invariants';
import { resolveIntegrationTestDatabase } from '../../database/typeorm/core/test-database-guard';
import { createAdminDataSource } from './helpers/admin-datasource';

/**
 * Phase 0b (E1: R1, R2, R5, R6) on a database built from migrations. Read-only assertions, and rolled-back transactions
 * for every privilege probe: nothing here leaves a role, object or grant behind.
 *
 * Covered: the ownership move and preserved privileges; current_* still inlined into RLS (no SET clause); crewflow can no
 * longer create in core, redefine the helpers or drop rab_secure_owner objects; the migration (down and up) runs under a
 * NON-superuser migration identity; the scoped CREATE window for later migrations works there, and the plain ownership
 * hand-over without it fails. E1 is PARTIALLY mitigated: R4 is asserted as frozen, not as fixed.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(180_000);

const HELPERS = ['current_org()', 'current_uid()', 'current_workspace()', 'current_role_name()', 'immutable_unaccent(text)'];
const TRIGGERS = [
  'enforce_user_security_version_monotonic()',
  'enforce_organisation_security_version_monotonic()',
  'enforce_platform_admin_security_version_monotonic()',
  'enforce_user_session_mutation_invariants()',
];

describeIfDb('Phase 0b: rab_secure_owner owns schema core and the helpers it executes (E1 channels 1, 2, 4)', () => {
  const { adminUrl, appUrl } = RUN ? resolveIntegrationTestDatabase(process.env) : ({} as never);
  let admin: Client;
  let ds: DataSource;

  /**
   * Every connection fails fast instead of hanging. The batch run of 2026-10-28 hit a 180 s hook timeout while the
   * test database logged no activity at all (a client-side connection wait right after a Docker port-forwarding
   * restart); it never reproduced. A bounded connect turns that into a clear error within seconds.
   */
  const client = (connectionString: string) => new Client({ connectionString, connectionTimeoutMillis: 15_000 });

  /** Runs `fn` in a transaction on its own superuser connection and always rolls it back. */
  async function rolledBack<T>(fn: (c: Client) => Promise<T>): Promise<T> {
    const c = client(adminUrl);
    await c.connect();
    try {
      await c.query('BEGIN');
      return await fn(c);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
  }

  /** SQLSTATE of `sql` run as the session's current role inside a savepoint (null when it succeeds). */
  async function sqlState(c: Client, sql: string): Promise<string | null> {
    await c.query('SAVEPOINT probe');
    try {
      await c.query(sql);
      await c.query('RELEASE SAVEPOINT probe');
      return null;
    } catch (e) {
      await c.query('ROLLBACK TO SAVEPOINT probe');
      return (e as { code?: string }).code ?? 'unknown';
    }
  }

  beforeAll(async () => {
    admin = client(adminUrl);
    await admin.connect();
    if (!(await admin.query('SELECT rolsuper FROM pg_roles WHERE rolname = current_user')).rows[0].rolsuper) {
      throw new Error('this suite needs the disposable database bootstrap superuser as TEST_DATABASE_URL_UNPOOLED');
    }
    ds = createAdminDataSource();
    await ds.initialize();
  });

  afterAll(async () => {
    await ds?.destroy();
    await admin?.end();
  });

  it('every secure-owner invariant holds (R6), and the R4 residual set is exactly the frozen, reviewed list', async () => {
    expect(await secureOwnerInvariantViolations(async (sql) => (await admin.query(sql)).rows)).toEqual([]);
    const r4 = (await admin.query(R4_TABLES_SQL)).rows.map((r: { relname: string }) => r.relname);
    expect(r4).toEqual([...R4_CREWFLOW_TABLES_REACHED_BY_SECURE_DEFINERS]);
  });

  it('R1/R5: rab_secure_owner owns core; crewflow, crewflow_app and rab_secure_owner keep USAGE; crewflow has no CREATE', async () => {
    const { rows: [s] } = await admin.query(`
      SELECT pg_get_userbyid(nspowner) AS owner,
             has_schema_privilege('crewflow', 'core', 'USAGE') AS crewflow_usage,
             has_schema_privilege('crewflow_app', 'core', 'USAGE') AS app_usage,
             has_schema_privilege('rab_secure_owner', 'core', 'USAGE') AS secure_usage,
             has_schema_privilege('crewflow', 'core', 'CREATE') AS crewflow_create,
             has_schema_privilege('crewflow_app', 'core', 'CREATE') AS app_create
        FROM pg_namespace WHERE nspname = 'core'`);
    expect(s).toEqual({ owner: 'rab_secure_owner', crewflow_usage: true, app_usage: true, secure_usage: true, crewflow_create: false, app_create: false });
  });

  it('R2: the nine functions are owned by rab_secure_owner, EXECUTE is preserved, triggers pinned, helpers have no SET clause', async () => {
    const { rows } = await admin.query(
      `SELECT replace(p.oid::regprocedure::text, 'core.', '') AS fn, pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer,
              array_to_string(p.proconfig, ';') AS cfg,
              has_function_privilege('crewflow', p.oid, 'EXECUTE') AS crewflow_exec, has_function_privilege('crewflow_app', p.oid, 'EXECUTE') AS app_exec
         FROM pg_proc p WHERE p.oid = ANY ($1::regprocedure[]) ORDER BY 1`,
      [[...HELPERS, ...TRIGGERS].map((f) => `core.${f}`)],
    );
    expect(rows).toHaveLength(9);
    for (const r of rows) {
      expect(r).toMatchObject({ owner: 'rab_secure_owner', definer: false, crewflow_exec: true, app_exec: true });
      expect(r.cfg).toBe(HELPERS.includes(r.fn) ? null : 'search_path=pg_catalog, pg_temp');
    }
  });

  it('performance: current_org() / current_workspace() are still inlined into RLS policies for the runtime role', async () => {
    const app = client(appUrl);
    await app.connect();
    try {
      await app.query('BEGIN');
      await app.query(`SELECT set_config('rab.organisation_id', gen_random_uuid()::text, true), set_config('rab.workspace_id', gen_random_uuid()::text, true)`);
      const plan = (await app.query('EXPLAIN (VERBOSE, COSTS OFF) SELECT id FROM core.venue')).rows.map((r) => r['QUERY PLAN']).join('\n');
      expect(plan).toContain("current_setting('rab.organisation_id'");
      expect(plan).not.toMatch(/current_org\(\)/);
      await app.query('ROLLBACK');
    } finally {
      await app.end();
    }
  });

  it('crewflow can no longer create in core, redefine a helper, re-point a trigger function, or drop a rab_secure_owner object', async () => {
    await rolledBack(async (c) => {
      await c.query('SET ROLE crewflow');
      expect(await sqlState(c, 'CREATE TABLE core.p0b_probe (i int)')).toBe('42501');
      expect(await sqlState(c, `CREATE OR REPLACE FUNCTION core.current_org() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$`)).toBe('42501');
      expect(await sqlState(c, 'ALTER FUNCTION core.enforce_user_session_mutation_invariants() SET search_path = core, pg_catalog')).toBe('42501');
      expect(await sqlState(c, 'DROP FUNCTION core.is_active_platform_admin(uuid)')).toBe('42501');
      // M1: the generated search_vector column of core."user" depends on it; crewflow can neither drop nor alter it now.
      expect(await sqlState(c, 'DROP FUNCTION core.immutable_unaccent(text) CASCADE')).toBe('42501');
      expect(await sqlState(c, 'ALTER FUNCTION core.immutable_unaccent(text) VOLATILE')).toBe('42501');
      expect(await sqlState(c, 'DROP SCHEMA core CASCADE')).toBe('42501');
      // Its own tenant tables are untouched by Phase 0b (R4 territory): it still owns them.
      expect((await c.query(`SELECT pg_get_userbyid(relowner) AS o FROM pg_class WHERE oid = 'core.venue'::regclass`)).rows[0].o).toBe('crewflow');
    });
  });

  it('the migration runs down then up under a NON-superuser migration identity (CF-41 shape), all inside one rolled-back transaction', async () => {
    const qr: QueryRunner = ds.createQueryRunner();
    await qr.connect();
    try {
      await qr.startTransaction();
      const role = `p0b_mig_${Math.random().toString(36).slice(2, 8)}`;
      await qr.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
      await qr.query(`GRANT rab_secure_owner, crewflow TO ${role}`);
      await qr.query(`SET ROLE ${role}`);
      expect((await qr.query('SELECT rolsuper FROM pg_roles WHERE rolname = current_user'))[0].rolsuper).toBe(false);
      const migration = new SecureOwnerCoreSchemaAndHelpers1786721100000();
      await migration.down(qr);
      expect((await qr.query(`SELECT pg_get_userbyid(nspowner) AS o FROM pg_namespace WHERE nspname = 'core'`))[0].o).toBe('crewflow');
      await migration.up(qr);
      expect((await qr.query(`SELECT pg_get_userbyid(nspowner) AS o FROM pg_namespace WHERE nspname = 'core'`))[0].o).toBe('rab_secure_owner');
    } finally {
      await qr.rollbackTransaction().catch(() => undefined);
      await qr.release();
    }
  });

  it('R5 window: as a non-superuser migrator, handing a new core object to crewflow fails without withCrewflowCoreCreate and works with it', async () => {
    const qr: QueryRunner = ds.createQueryRunner();
    await qr.connect();
    try {
      await qr.startTransaction();
      const role = `p0b_mig_${Math.random().toString(36).slice(2, 8)}`;
      await qr.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
      await qr.query(`GRANT rab_secure_owner, crewflow TO ${role}`);
      await qr.query(`SET ROLE ${role}`);
      await qr.query('CREATE TABLE core.p0b_window_probe (i int)');
      await qr.query('SAVEPOINT plain');
      await expect(qr.query('ALTER TABLE core.p0b_window_probe OWNER TO crewflow')).rejects.toMatchObject({ code: '42501' });
      await qr.query('ROLLBACK TO SAVEPOINT plain');
      await withCrewflowCoreCreate(qr, () => qr.query('ALTER TABLE core.p0b_window_probe OWNER TO crewflow'));
      expect((await qr.query(`SELECT pg_get_userbyid(relowner) AS o FROM pg_class WHERE oid = 'core.p0b_window_probe'::regclass`))[0].o).toBe('crewflow');
      expect((await qr.query(`SELECT has_schema_privilege('crewflow', 'core', 'CREATE') AS c`))[0].c).toBe(false);
    } finally {
      await qr.rollbackTransaction().catch(() => undefined);
      await qr.release();
    }
  });

  it('N1: the migration pins its own search_path — a same-signature function earlier on the session path is never called', async () => {
    const qr: QueryRunner = ds.createQueryRunner();
    await qr.connect();
    try {
      await qr.startTransaction();
      await qr.query('CREATE SCHEMA p0b_path_probe');
      await qr.query(`CREATE FUNCTION p0b_path_probe.has_table_privilege(oid, oid, text) RETURNS boolean LANGUAGE plpgsql
                        AS $$ BEGIN RAISE EXCEPTION 'p0b path probe was resolved'; END $$`);
      await qr.query(`SELECT set_config('search_path', 'p0b_path_probe, pg_catalog', true)`);
      const migration = new SecureOwnerCoreSchemaAndHelpers1786721100000();
      await migration.down(qr);
      await migration.up(qr);
      expect((await qr.query(`SELECT pg_catalog.pg_get_userbyid(nspowner) AS o FROM pg_catalog.pg_namespace WHERE nspname = 'core'`))[0].o).toBe('rab_secure_owner');
    } finally {
      await qr.rollbackTransaction().catch(() => undefined);
      await qr.release();
    }
  });

  it('R6 is search_path-independent: the same (empty) result over a search_path=core session and a default session', async () => {
    expect(await secureOwnerInvariantViolations((sql) => ds.query(sql))).toEqual([]);
    expect(await secureOwnerInvariantViolations(async (sql) => (await admin.query(sql)).rows)).toEqual([]);
  });

  it('R6 sees functions attached to a secure table (M1): a crewflow-owned function in a CHECK on core."user" is a violation', async () => {
    await rolledBack(async (c) => {
      await c.query(`CREATE FUNCTION core.p0b_probe_check(text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT true $$`);
      await c.query('ALTER FUNCTION core.p0b_probe_check(text) OWNER TO crewflow');
      await c.query(`ALTER TABLE core."user" ADD CONSTRAINT p0b_probe_check CHECK (core.p0b_probe_check(first_name)) NOT VALID`);
      const violations = await secureOwnerInvariantViolations(async (sql) => (await c.query(sql)).rows);
      expect(violations).toContain('reachable-function-owner|core.p0b_probe_check(pg_catalog.text)|crewflow');
    });
  });

  it('L1: a failing body inside withCrewflowCoreCreate leaves no grant, even when the caller catches the error and continues', async () => {
    const qr: QueryRunner = ds.createQueryRunner();
    await qr.connect();
    try {
      await qr.startTransaction();
      await expect(withCrewflowCoreCreate(qr, () => qr.query('SELECT 1/0'))).rejects.toMatchObject({ code: '22012' });
      // The transaction is still usable (rolled back to the window's savepoint) and crewflow holds no CREATE.
      expect((await qr.query(`SELECT has_schema_privilege('crewflow', 'core', 'CREATE') AS c`))[0].c).toBe(false);
    } finally {
      await qr.rollbackTransaction().catch(() => undefined);
      await qr.release();
    }
  });

  it('withCrewflowCoreCreate refuses to run outside a transaction (the grant must never be committed)', async () => {
    const qr: QueryRunner = ds.createQueryRunner();
    await qr.connect();
    try {
      await expect(withCrewflowCoreCreate(qr, async () => undefined)).rejects.toThrow('must run inside the migration transaction');
      expect((await qr.query(`SELECT has_schema_privilege('crewflow', 'core', 'CREATE') AS c`))[0].c).toBe(false);
    } finally {
      await qr.release();
    }
  });
});
