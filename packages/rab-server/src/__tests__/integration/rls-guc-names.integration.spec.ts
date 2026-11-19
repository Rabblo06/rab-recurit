import { Client } from 'pg';

import { RLS_GUC_CATALOG_SQL, RLS_GUC_NAMES, rlsGucNamesMissing } from '../../database/postgres/transaction-scoped-client';
import { integrationTestDatabase } from '../../database/typeorm/core/integration-test-database-gate';

/**
 * Security review M-2 (PR #258): the transaction-scoped client's preamble clears every RLS GUC by NAME (RLS_GUC_NAMES:
 * PostgreSQL does not list placeholder settings in pg_settings). This proves the list against the DATABASE ITSELF, not only
 * the source: every `rab.<name>` that any policy (USING / WITH CHECK, every schema) or any function (body or SET clause)
 * reads must be in the list. Fail-first: a planted policy, and a planted function, reading an unknown `rab.zz_*` name make
 * the check report exactly those names (planted inside a transaction that is rolled back). Read-only otherwise.
 */
const env = integrationTestDatabase();

describe('RLS GUC names: the preamble list covers every rab.* setting the database reads (integration)', () => {
  let admin: Client;
  const missing = async (): Promise<string[]> =>
    rlsGucNamesMissing(((await admin.query(RLS_GUC_CATALOG_SQL)).rows as Array<{ name: string }>).map((r) => r.name));

  beforeAll(async () => {
    admin = new Client({ connectionString: env.adminUrl });
    await admin.connect();
  });
  afterAll(async () => {
    await admin?.end();
  });

  it('every rab.<name> in pg_policies and pg_proc is in RLS_GUC_NAMES, and the catalog really uses the core ones', async () => {
    const names = ((await admin.query(RLS_GUC_CATALOG_SQL)).rows as Array<{ name: string }>).map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(['rab.organisation_id', 'rab.user_id']));
    expect(rlsGucNamesMissing(names)).toEqual([]);
    expect(RLS_GUC_NAMES.length).toBeGreaterThanOrEqual(12);
  });

  it('fail-first: a policy and a function reading an unknown rab.zz_* name are reported (planted and rolled back)', async () => {
    await admin.query('BEGIN');
    try {
      await admin.query(`CREATE POLICY crewflow_zz_probe ON core.role AS RESTRICTIVE FOR SELECT USING (pg_catalog.current_setting('rab.zz_probe', true) IS DISTINCT FROM 'never')`);
      await admin.query(`CREATE FUNCTION pg_temp.crewflow_zz_probe_fn() RETURNS text LANGUAGE sql AS $$ SELECT pg_catalog.current_setting('rab.zz_probe_fn', true) $$`);
      expect(await missing()).toEqual(['rab.zz_probe', 'rab.zz_probe_fn']);
    } finally {
      await admin.query('ROLLBACK');
    }
    expect(await missing()).toEqual([]);
  });
});
