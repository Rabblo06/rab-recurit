import { Client } from 'pg';
import { DataSource } from 'typeorm';

import { resolveIntegrationTestDatabase } from '../../database/typeorm/core/test-database-guard';
import { integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';
import { createAdminDataSource } from './helpers/admin-datasource';
import { otherActiveClientBackends, otherActiveClientBackendsSql } from './helpers/concurrent-backend-guard';

/**
 * C1b.9: the TRUNCATE guards of ops-owner-login / containment-suspend-test-accounts count only other CLIENT sessions with a
 * query in flight. A concurrent test process (another client running a query) is still refused; an autovacuum or other
 * background worker of the same database is not counted.
 */
const describeIfDb = integrationTestDatabaseReady() ? describe : describe.skip;

describeIfDb('concurrent-backend guard: client sessions only (integration)', () => {
  let admin: DataSource;

  beforeAll(async () => {
    admin = createAdminDataSource();
    await admin.initialize();
  });
  afterAll(async () => {
    await admin?.destroy();
  });

  it('the predicate ignores non-client backend types and idle / other-database / own sessions, and counts an active client', async () => {
    // Same WHERE clause, evaluated over a synthetic activity relation (a real autovacuum worker cannot be started on demand).
    const [{ n }] = await admin.query<[{ n: number }]>(
      `WITH fake_activity (datname, pid, state, backend_type) AS (VALUES
         (current_database()::name, -1, 'active', 'autovacuum worker'),
         (current_database()::name, -2, 'active', 'parallel worker'),
         (current_database()::name, -3, 'active', 'background worker'),
         (current_database()::name, -4, 'idle', 'client backend'),
         ('some_other_database'::name, -5, 'active', 'client backend'),
         (current_database()::name, pg_backend_pid(), 'active', 'client backend'),
         (current_database()::name, -6, 'active', 'client backend'))
       ${otherActiveClientBackendsSql('fake_activity')}`,
    );
    expect(n).toBe(1); // only the other database-local, active CLIENT session (-6)
  });

  it('ABUSE: a concurrent client session with a query in flight is counted (the guard refuses), and not after it ends', async () => {
    expect(await otherActiveClientBackends(admin)).toBe(0);
    const { adminUrl } = resolveIntegrationTestDatabase(process.env);
    const other = new Client({ connectionString: adminUrl });
    await other.connect();
    try {
      const sleeping = other.query('SELECT pg_sleep(4)');
      let seen = 0;
      for (let i = 0; i < 30 && seen === 0; i++) {
        seen = await otherActiveClientBackends(admin);
        if (seen === 0) await new Promise((r) => setTimeout(r, 100));
      }
      expect(seen).toBe(1);
      await sleeping;
      expect(await otherActiveClientBackends(admin)).toBe(0); // idle now: no longer a query in flight
    } finally {
      await other.end();
    }
  });

  it('refuses an unexpected relation name (the source is interpolated)', () => {
    expect(() => otherActiveClientBackendsSql('pg_stat_activity; DROP TABLE x')).toThrow(/invalid source/);
  });
});
