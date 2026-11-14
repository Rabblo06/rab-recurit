import { Client } from 'pg';

import { readSemanticPosture } from '../../database/posture-drift/semantic-posture';
import { resolveIntegrationTestDatabase } from '../../database/typeorm/core/test-database-guard';
import { integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';

/**
 * Hotfix fix/posture-test-marker (2026-11-05): the semantic posture reads the same on a database with and without the
 * disposable-test marker, so a real (unmarked) database compares cleanly with goldens generated in CI. Runs on the
 * disposable test database; the marker is toggled by the bootstrap superuser inside a transaction that is ALWAYS rolled
 * back (pg_db_role_setting is transactional).
 */
const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(120_000);

describeIfDb('semantic posture is identical with and without crewflow.disposable_test_database (rolled back)', () => {
  const { adminUrl } = RUN ? resolveIntegrationTestDatabase(process.env) : ({} as never);
  let c: Client;
  let db: string;

  const read = async () => {
    const p = await readSemanticPosture(async (sql, params) => (await c.query(sql, params as unknown[] | undefined)).rows, { ownTransaction: false });
    return { core: p.core, roles: p.roles, workspaces: [...p.workspaces.entries()] };
  };

  beforeAll(async () => {
    c = new Client({ connectionString: adminUrl });
    await c.connect();
    db = (await c.query('SELECT current_database() AS d')).rows[0].d as string;
  });
  afterAll(async () => {
    await c?.end();
  });

  it('marker set (true), marker set (false) and marker reset all read the same posture; no line names the marker', async () => {
    await c.query('BEGIN');
    try {
      await c.query(`SET LOCAL lock_timeout = '5s'`);
      const ident = `"${db.replace(/"/g, '""')}"`;
      await c.query(`ALTER DATABASE ${ident} SET crewflow.disposable_test_database = 'true'`);
      const marked = await read();
      await c.query(`ALTER DATABASE ${ident} SET crewflow.disposable_test_database = 'false'`);
      const other = await read();
      await c.query(`ALTER DATABASE ${ident} RESET crewflow.disposable_test_database`);
      const unmarked = await read();
      expect(marked.core.filter((l) => l.includes('disposable_test_database'))).toEqual([]);
      expect(other).toEqual(marked);
      expect(unmarked).toEqual(marked);
    } finally {
      await c.query('ROLLBACK');
    }
  });
});
