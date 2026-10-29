import 'reflect-metadata';
import { DataSource, QueryRunner } from 'typeorm';
import { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';

import { SECURE_OWNER_INVARIANT_VIOLATIONS_SQL } from '../../database/typeorm/core/secure-owner-invariants';
import { createAdminDataSource } from './helpers/admin-datasource';
import { SECURE_OWNER_INVARIANT_VIOLATIONS_SQL as PHASE_0B_REFERENCE_SQL } from './helpers/secure-owner-invariants-phase0b-reference';

/**
 * M2-F4: the optimised secure-owner invariant query must report EXACTLY what the Phase 0b query (frozen copy from 0d677bbf)
 * reports — on a healthy database and for every kind of violation the invariants exist to catch: each attachment kind on a
 * secure table (including the table's own dependency: a partition key), both transitive edges and a mixed three-hop chain (by name, by SQL-standard-body dependency), an unpinned definer search_path, CREATE on
 * core for a runtime login, and runtime membership in rab_secure_owner. Each case runs in its own transaction that is
 * always rolled back. A case the Phase 0b query does NOT flag (other than the healthy baseline) fails too: the cases must
 * really exercise the checks.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(900_000); // the Phase 0b reference query takes ~30 s per run on a database with 5+ workspace schemas

const BAD = `CREATE FUNCTION core.m2f4_bad(x int DEFAULT 0) RETURNS int LANGUAGE sql IMMUTABLE AS 'SELECT 1';
             ALTER FUNCTION core.m2f4_bad(int) OWNER TO crewflow;`;
const BAD_TRG = `CREATE FUNCTION core.m2f4_bad_trg() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END';
                 ALTER FUNCTION core.m2f4_bad_trg() OWNER TO crewflow;`;
const CASES: Record<string, string> = {
  'healthy database': 'SELECT 1',
  'trigger on a secure table': `${BAD_TRG} CREATE TRIGGER m2f4 BEFORE UPDATE ON core."user" FOR EACH ROW EXECUTE FUNCTION core.m2f4_bad_trg();`,
  'column default on a secure table': `${BAD} ALTER TABLE core."user" ADD COLUMN m2f4 int DEFAULT core.m2f4_bad();`,
  'generated column on a secure table': `${BAD} ALTER TABLE core."user" ADD COLUMN m2f4 int GENERATED ALWAYS AS (core.m2f4_bad(1)) STORED;`,
  'CHECK constraint on a secure table': `${BAD} ALTER TABLE core."user" ADD CONSTRAINT m2f4 CHECK (core.m2f4_bad() = 1) NOT VALID;`,
  'index expression on a secure table': `${BAD} CREATE INDEX m2f4 ON core."user" ((core.m2f4_bad(1)));`,
  'rule on a secure table': `${BAD} CREATE RULE m2f4 AS ON UPDATE TO core."user" DO ALSO SELECT core.m2f4_bad();`,
  'policy on a secure table': `${BAD} CREATE POLICY m2f4 ON core."user" USING (core.m2f4_bad() = 1);`,
  'transitive by name: definer -> secure helper -> crewflow function': `${BAD}
     CREATE FUNCTION core.m2f4_mid() RETURNS int LANGUAGE plpgsql AS 'BEGIN RETURN core.m2f4_bad(); END';
     ALTER FUNCTION core.m2f4_mid() OWNER TO rab_secure_owner;
     CREATE FUNCTION core.m2f4_top() RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
       AS 'BEGIN RETURN core.m2f4_mid (); END';
     ALTER FUNCTION core.m2f4_top() OWNER TO rab_secure_owner;`,
  'transitive by dependency: SQL-standard body': `${BAD}
     CREATE FUNCTION core.m2f4_atomic() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
       BEGIN ATOMIC SELECT core.m2f4_bad(); END;
     ALTER FUNCTION core.m2f4_atomic() OWNER TO rab_secure_owner;`,
  // The table's OWN pg_class dependency (not via pg_attrdef / pg_constraint / an index): a partition-key expression.
  // The key function must use its argument (a constant-folded key is rejected by PostgreSQL).
  'partition-key expression on a secure (partitioned) table': `
     CREATE FUNCTION core.m2f4_key(x int) RETURNS int LANGUAGE sql IMMUTABLE AS 'SELECT x + 1';
     ALTER FUNCTION core.m2f4_key(int) OWNER TO crewflow;
     CREATE TABLE core.m2f4_p (a int) PARTITION BY RANGE ((core.m2f4_key(a)));
     ALTER TABLE core.m2f4_p OWNER TO rab_secure_owner;`,
  'three-hop chain: name -> SQL-standard dependency -> name': `${BAD}
     CREATE FUNCTION core.m2f4_h2() RETURNS int LANGUAGE plpgsql AS 'BEGIN RETURN core.m2f4_bad(); END';
     ALTER FUNCTION core.m2f4_h2() OWNER TO rab_secure_owner;
     CREATE FUNCTION core.m2f4_h1() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT core.m2f4_h2(); END;
     ALTER FUNCTION core.m2f4_h1() OWNER TO rab_secure_owner;
     CREATE FUNCTION core.m2f4_h0() RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
       AS 'BEGIN RETURN core.m2f4_h1(); END';
     ALTER FUNCTION core.m2f4_h0() OWNER TO rab_secure_owner;`,
  'definer without a pinned search_path': `CREATE FUNCTION core.m2f4_def() RETURNS int LANGUAGE sql SECURITY DEFINER AS 'SELECT 1';
     ALTER FUNCTION core.m2f4_def() OWNER TO rab_secure_owner;`,
  'runtime login gains CREATE on core': 'GRANT CREATE ON SCHEMA core TO crewflow_app;',
  'runtime login becomes a member of rab_secure_owner': 'GRANT rab_secure_owner TO crewflow;',
};

describeIfDb('M2-F4: optimised secure-owner invariants report exactly what the Phase 0b query reports', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = createAdminDataSource();
    const extra = (ds.options as PostgresConnectionOptions).extra ?? {};
    // The REFERENCE query is the slow one (M2-F4); this suite's own connection only.
    ds.setOptions({ extra: { ...extra, statement_timeout: 180_000, query_timeout: 200_000 } } as Partial<PostgresConnectionOptions>);
    await ds.initialize();
    const [me] = await ds.query('SELECT rolsuper FROM pg_roles WHERE rolname = current_user');
    if (!me?.rolsuper) throw new Error('this suite needs the disposable database bootstrap superuser as TEST_DATABASE_URL_UNPOOLED');
  });

  afterAll(async () => {
    await ds?.destroy();
  });

  it.each(Object.entries(CASES))('%s', async (name, ddl) => {
    const qr: QueryRunner = ds.createQueryRunner();
    await qr.connect();
    try {
      await qr.startTransaction();
      await qr.query(ddl);
      const optimised = ((await qr.query(SECURE_OWNER_INVARIANT_VIOLATIONS_SQL)) as Array<{ line: string }>).map((r) => r.line);
      const reference = ((await qr.query(PHASE_0B_REFERENCE_SQL)) as Array<{ line: string }>).map((r) => r.line);
      expect(optimised).toEqual(reference);
      if (name === 'healthy database') expect(reference).toEqual([]);
      else {
        expect(reference.length).toBeGreaterThan(0);
        // Each reported line is about the injected object (or the runtime login it changed), never unrelated noise.
        for (const line of reference) expect(line).toMatch(/m2f4|crewflow/);
      }
    } finally {
      await qr.rollbackTransaction().catch(() => undefined);
      await qr.release();
    }
  });
});
