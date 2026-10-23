import { DataSource } from 'typeorm';

import { ReconcileSuperuserOwnedCoreObjects1786719600000 } from '../../database/typeorm/core/migrations/1786719600000-ReconcileSuperuserOwnedCoreObjects';
import { createAdminDataSource } from './helpers/admin-datasource';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

/**
 * Foundation fix P3 (2026-10-22): no `core` object may be owned by a superuser, and `core.navigation_layout` is owned by
 * `crewflow` with `crewflow_app` limited to SELECT/INSERT/UPDATE — on a database built from migrations alone, with no
 * manual ALTER OWNER. Also exercises `ReconcileSuperuserOwnedCoreObjects1786719600000` itself against objects a
 * superuser creates (inside a transaction that is always rolled back), including the cases it must refuse to guess.
 * (`db-security-posture` compares the full golden snapshot; the fresh-install proof is in the foundation-fixes report.)
 */
describeIfDb('core object ownership (integration, P3)', () => {
  let admin: DataSource;

  beforeAll(async () => {
    admin = createAdminDataSource();
    await admin.initialize();
  });

  afterAll(async () => {
    await admin.destroy();
  });

  it('nothing in schema core (relations, functions, types, the schema) is owned by a superuser', async () => {
    const rows = await admin.query(`
      SELECT format('%s %s', c.relkind, c.oid::regclass) AS obj FROM pg_class c JOIN pg_roles o ON o.oid = c.relowner
       WHERE c.relnamespace = 'core'::regnamespace AND o.rolsuper
      UNION ALL
      SELECT format('function %s', p.oid::regprocedure) FROM pg_proc p JOIN pg_roles o ON o.oid = p.proowner
       WHERE p.pronamespace = 'core'::regnamespace AND o.rolsuper
      UNION ALL
      SELECT format('type %s', t.oid::regtype) FROM pg_type t JOIN pg_roles o ON o.oid = t.typowner
       WHERE t.typnamespace = 'core'::regnamespace AND o.rolsuper
      UNION ALL
      SELECT 'schema core' FROM pg_namespace n JOIN pg_roles o ON o.oid = n.nspowner WHERE n.nspname = 'core' AND o.rolsuper`);
    expect(rows).toEqual([]);
  });

  it('core.navigation_layout: owner crewflow, FORCE RLS, crewflow_app SELECT/INSERT/UPDATE only', async () => {
    const [row] = await admin.query(`
      SELECT pg_get_userbyid(c.relowner) AS owner, c.relrowsecurity AS rls, c.relforcerowsecurity AS force,
             has_table_privilege('crewflow_app', c.oid, 'SELECT') AS s, has_table_privilege('crewflow_app', c.oid, 'INSERT') AS i,
             has_table_privilege('crewflow_app', c.oid, 'UPDATE') AS u, has_table_privilege('crewflow_app', c.oid, 'DELETE') AS d,
             has_table_privilege('crewflow_app', c.oid, 'TRUNCATE') AS t
        FROM pg_class c WHERE c.oid = 'core.navigation_layout'::regclass`);
    expect(row).toEqual({ owner: 'crewflow', rls: true, force: true, s: true, i: true, u: true, d: false, t: false });
  });

  async function inRolledBackTransaction(fn: (run: (sql: string) => Promise<unknown>, migrate: () => Promise<void>) => Promise<void>): Promise<void> {
    const qr = admin.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      await fn(
        (sql) => qr.query(sql),
        () => new ReconcileSuperuserOwnedCoreObjects1786719600000().up(qr),
      );
    } finally {
      await qr.rollbackTransaction().catch(() => undefined);
      await qr.release();
    }
  }

  it('the reconcile migration hands a superuser-created FORCE-RLS table, view, sequence and function to crewflow and keeps existing grants', async () => {
    const suffix = Math.random().toString(36).slice(2, 10);
    await inRolledBackTransaction(async (run, migrate) => {
      await run(`CREATE TABLE core.p3_probe_${suffix} (id integer PRIMARY KEY, organisation_id uuid)`);
      await run(`ALTER TABLE core.p3_probe_${suffix} ENABLE ROW LEVEL SECURITY`);
      await run(`ALTER TABLE core.p3_probe_${suffix} FORCE ROW LEVEL SECURITY`);
      await run(`GRANT SELECT, INSERT, UPDATE ON core.p3_probe_${suffix} TO crewflow_app`);
      await run(`CREATE VIEW core.p3_probe_v_${suffix} AS SELECT 1 AS one`);
      await run(`CREATE SEQUENCE core.p3_probe_s_${suffix}`);
      await run(`CREATE FUNCTION core.p3_probe_f_${suffix}() RETURNS integer LANGUAGE sql AS 'SELECT 1'`);
      await migrate();
      const owners = (await run(`
        SELECT c.relname AS name, pg_get_userbyid(c.relowner) AS owner FROM pg_class c
         WHERE c.relnamespace = 'core'::regnamespace AND c.relname LIKE 'p3_probe%${suffix}%'
        UNION ALL
        SELECT p.proname, pg_get_userbyid(p.proowner) FROM pg_proc p
         WHERE p.pronamespace = 'core'::regnamespace AND p.proname LIKE 'p3_probe%${suffix}'
        ORDER BY 1`)) as Array<{ name: string; owner: string }>;
      expect(owners.map((o) => o.owner)).toEqual(owners.map(() => 'crewflow'));
      expect(owners.length).toBeGreaterThanOrEqual(5); // table, its pkey index, view, sequence, function
      const [grants] = (await run(`
        SELECT has_table_privilege('crewflow_app', 'core.p3_probe_${suffix}', 'SELECT,INSERT,UPDATE') AS siu,
               has_table_privilege('crewflow_app', 'core.p3_probe_${suffix}', 'DELETE') AS d`)) as Array<{ siu: boolean; d: boolean }>;
      expect(grants).toEqual({ siu: true, d: false });
    });
  });

  it('refuses to guess for a superuser-owned table with RLS enabled but NOT forced (a pre-auth table must be assigned explicitly)', async () => {
    const suffix = Math.random().toString(36).slice(2, 10);
    await inRolledBackTransaction(async (run, migrate) => {
      await run(`CREATE TABLE core.p3_preauth_${suffix} (id integer)`);
      await run(`ALTER TABLE core.p3_preauth_${suffix} ENABLE ROW LEVEL SECURITY`);
      await expect(migrate()).rejects.toThrow(/refuses to guess an owner for: table (core\.)?p3_preauth_\w+ has RLS enabled without FORCE/);
    });
  });

  it('refuses to guess for a superuser-owned SECURITY DEFINER function', async () => {
    const suffix = Math.random().toString(36).slice(2, 10);
    await inRolledBackTransaction(async (run, migrate) => {
      await run(`CREATE FUNCTION core.p3_definer_${suffix}() RETURNS integer LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'`);
      await expect(migrate()).rejects.toThrow(/SECURITY DEFINER \(its owner must be chosen explicitly\)/);
    });
  });

  it('is a no-op on a correctly owned database (idempotent)', async () => {
    await inRolledBackTransaction(async (run, migrate) => {
      const before = await run(`SELECT count(*)::int AS n FROM pg_class WHERE relnamespace = 'core'::regnamespace AND pg_get_userbyid(relowner) = 'crewflow'`);
      await migrate();
      const after = await run(`SELECT count(*)::int AS n FROM pg_class WHERE relnamespace = 'core'::regnamespace AND pg_get_userbyid(relowner) = 'crewflow'`);
      expect(after).toEqual(before);
    });
  });
});
