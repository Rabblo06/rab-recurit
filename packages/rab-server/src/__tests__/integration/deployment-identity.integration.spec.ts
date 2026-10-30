/**
 * Deployment identity marker (Phase B / B3, migration DeploymentIdentity1786721230000) against the real, disposable,
 * harness-built test database (the migration applied by the restricted migrator, like every other integration suite).
 * It FAILS LOUDLY — never skips — when the marker is missing (first test).
 *
 * Covered: the plpgsql bodies compile and run on the server (every branch of bind() is executed); ownership, grants and the
 * exact reviewed state; RLS for the runtime logins (no table access, writes denied, bind() denied, and the RESTRICTIVE
 * policy still denies them if a privilege were ever granted by mistake); a member login querying directly sees and writes
 * nothing; history UPDATE / DELETE / TRUNCATE denied even to the owner; the documented boundary (SET ROLE
 * rab_secure_owner writes the marker without a history row: the history is NOT tamper-proof against the migration
 * identity); compare-and-swap; first bind; rebind; the host SET (direct + proxy host); location refusals in the boot gates;
 * up -> down -> up with zero posture and privilege drift; pg_control_system() callability on PostgreSQL 16.
 *
 * Every write happens inside a transaction that is rolled back (savepoints for the expected refusals), except the boot-gate
 * test, which needs a committed bind and restores the UNBOUND state in `finally` by down() + up() in one transaction.
 * The admin connection is the disposable cluster's superuser; `SET LOCAL ROLE` acts as crewflow_app / crewflow /
 * rab_secure_owner / a temporary member role (created inside the rolled-back transaction) where the test is about that
 * role's privileges. The runtime login is also exercised over its own connection (TEST_DATABASE_URL, crewflow_app).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Client } from 'pg';
import { DataSource } from 'typeorm';

import { DatabaseBootGateError, runDatabaseBootGates, RunBootGatesOptions } from '../../database/boot-checks/database-boot-gates';
import { DEPLOYMENT_IDENTITY_EXPECTED_STATE, DEPLOYMENT_IDENTITY_STATE_SQL } from '../../database/typeorm/core/deployment-identity-sql';
import { privilegeDriftSnapshot } from '../../database/typeorm/core/migration-privilege-drift';
import { DeploymentIdentity1786721230000 } from '../../database/typeorm/core/migrations/1786721230000-DeploymentIdentity';
import { readSecurityPosture } from '../../database/typeorm/core/security-posture';
import { resolveIntegrationTestDatabase } from '../../database/typeorm/core/test-database-guard';

const { appUrl, adminUrl } = resolveIntegrationTestDatabase(process.env);
const ID_A = '11111111-2222-4333-8444-555555555555';
const ID_B = '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const ID_C = '0b9a8c7d-6e5f-4a3b-9c2d-1e0f2a3b4c5d';
const REASON = 'integration test bind, rolled back';
const PROXY_HOST = 'proxy.integration.internal';
const GOLDEN = readFileSync(join(__dirname, '../../database/typeorm/core/security-posture.golden.txt'), 'utf8').split('\n').filter(Boolean);

async function withClient<T>(url: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}
const withAdmin = <T>(fn: (c: Client) => Promise<T>) => withClient(adminUrl, fn);

/** Runs `fn` in a transaction that is ALWAYS rolled back. */
const inRolledBackTx = <T>(fn: (c: Client) => Promise<T>, url = adminUrl) =>
  withClient(url, async (c) => {
    await c.query('BEGIN');
    try {
      return await fn(c);
    } finally {
      await c.query('ROLLBACK');
    }
  });

/** Expects `sql` to fail with `code`, leaving the surrounding transaction usable. */
async function expectSqlState(c: Client, sql: string, params: unknown[], code: string): Promise<void> {
  await c.query('SAVEPOINT expect_fail');
  let error: { code?: string } | null = null;
  try {
    await c.query(sql, params);
  } catch (e) {
    error = e as { code?: string };
  }
  await c.query('ROLLBACK TO SAVEPOINT expect_fail');
  expect({ sql: sql.slice(0, 80), code: error?.code }).toEqual({ sql: sql.slice(0, 80), code });
}

const bind = `SELECT core.deployment_identity_bind($1, $2::uuid, $3, $4, $5::uuid, $6::text[])`;
/** The host the boot gates' connection names (the factory lower-cases it): every bind here records it. */
const BIND_HOST = new URL(appUrl).hostname.replace(/^\[|\]$/g, '').toLowerCase();
const WRITE_ATTEMPTS = [
  `INSERT INTO core.deployment_identity (environment, deployment_id, bound_database, bound_hosts, bound_at, bound_by, reason) VALUES ('test', '${ID_A}', current_database(), ARRAY['x'], now(), 'x', 'xxxxxxxxxxxx')`,
  `UPDATE core.deployment_identity SET reason = reason`,
  `DELETE FROM core.deployment_identity`,
  `TRUNCATE core.deployment_identity`,
  `INSERT INTO core.deployment_identity_history (bound_at, environment, deployment_id, bound_database, bound_hosts, session_login, bound_by, reason) VALUES (now(), 'test', '${ID_A}', 'x', ARRAY['x'], 'x', 'x', 'xxxxxxxxxxxx')`,
  `UPDATE core.deployment_identity_history SET reason = reason`,
  `DELETE FROM core.deployment_identity_history`,
  `TRUNCATE core.deployment_identity_history`,
];

describe('deployment identity marker (integration, migration DeploymentIdentity1786721230000 applied)', () => {
  it('the marker exists, is unbound, has exactly the reviewed shape, and both definers are compiled plpgsql (fails loudly if missing)', async () => {
    await withAdmin(async (c) => {
      const [state] = (await c.query(DEPLOYMENT_IDENTITY_STATE_SQL)).rows;
      expect(state).toEqual({ ...DEPLOYMENT_IDENTITY_EXPECTED_STATE });
      expect((await c.query('SELECT * FROM core.deployment_identity_check()')).rows).toEqual([]);
      const ledger = (await c.query(`SELECT name FROM core.migrations WHERE name LIKE 'DeploymentIdentity%' ORDER BY name`)).rows.map((r) => r.name);
      expect(ledger).toEqual(['DeploymentIdentity1786721230000']);
      const langs = (await c.query(
        `SELECT p.proname, l.lanname FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
          WHERE p.pronamespace = 'core'::regnamespace AND p.proname LIKE 'deployment_identity_%' ORDER BY 1`,
      )).rows;
      expect(langs).toEqual([
        { proname: 'deployment_identity_bind', lanname: 'plpgsql' },
        { proname: 'deployment_identity_check', lanname: 'plpgsql' },
      ]);
    });
  });

  it('posture: the live identity lines are exactly the golden snapshot lines (owner, definer, search_path, grants, FORCE RLS)', async () => {
    const live = (await readSecurityPosture(adminUrl)).filter((l) => l.includes('deployment_identity'));
    const golden = GOLDEN.filter((l) => l.includes('deployment_identity'));
    expect(live.length).toBe(16);
    expect([...live].sort()).toEqual([...golden].sort());
  });

  it('runtime logins (SET ROLE and the real crewflow_app connection): no table access, every write denied, check() allowed, bind() denied', async () => {
    await inRolledBackTx(async (c) => {
      await c.query(bind, ['test', ID_A, REASON, 'integration', null, [BIND_HOST]]);
      for (const role of ['crewflow_app', 'crewflow']) {
        await c.query(`SET LOCAL ROLE ${role}`);
        await expectSqlState(c, 'SELECT * FROM core.deployment_identity', [], '42501');
        await expectSqlState(c, 'SELECT * FROM core.deployment_identity_history', [], '42501');
        for (const sql of WRITE_ATTEMPTS) await expectSqlState(c, sql, [], '42501');
        expect((await c.query('SELECT environment, deployment_id::text AS id, bound_hosts FROM core.deployment_identity_check()')).rows).toEqual([
          { environment: 'test', id: ID_A, bound_hosts: [BIND_HOST] },
        ]);
        await expectSqlState(c, bind, ['test', ID_B, REASON, 'test', ID_A, [BIND_HOST]], '42501');
        await c.query('RESET ROLE');
      }
    });
    // The real runtime login, over its own connection: same denials (nothing is bound on this committed database).
    await inRolledBackTx(async (c) => {
      expect((await c.query('SELECT current_user::text AS u, session_user::text AS s')).rows[0]).toEqual({ u: 'crewflow_app', s: 'crewflow_app' });
      for (const sql of WRITE_ATTEMPTS) await expectSqlState(c, sql, [], '42501');
      await expectSqlState(c, bind, ['test', ID_A, REASON, 'test', null, [BIND_HOST]], '42501');
      expect((await c.query('SELECT * FROM core.deployment_identity_check()')).rows).toEqual([]);
    }, appUrl);
  });

  it('defence in depth: even with a mistaken table grant, the RESTRICTIVE policy hides every row from the runtime logins and rejects their writes', async () => {
    await inRolledBackTx(async (c) => {
      await c.query(bind, ['test', ID_A, REASON, 'integration', null, [BIND_HOST]]);
      await c.query('GRANT SELECT, INSERT, UPDATE, DELETE ON core.deployment_identity, core.deployment_identity_history TO crewflow_app, crewflow');
      for (const role of ['crewflow_app', 'crewflow']) {
        await c.query(`SET LOCAL ROLE ${role}`);
        expect((await c.query('SELECT count(*)::int AS n FROM core.deployment_identity')).rows[0].n).toBe(0);
        expect((await c.query('SELECT count(*)::int AS n FROM core.deployment_identity_history')).rows[0].n).toBe(0);
        await expectSqlState(c, WRITE_ATTEMPTS[0], [], '42501');
        expect((await c.query('UPDATE core.deployment_identity SET reason = reason')).rowCount).toBe(0);
        expect((await c.query('DELETE FROM core.deployment_identity_history')).rowCount).toBe(0);
        await c.query('RESET ROLE');
      }
    });
  });

  it('a member login querying directly (not through the definers) sees and writes nothing; history is insert-only even for the owner', async () => {
    await inRolledBackTx(async (c) => {
      await c.query(bind, ['test', ID_A, REASON, 'integration', null, [BIND_HOST]]);
      // A member of rab_secure_owner with INHERIT (what the migration login is), created inside this rolled-back transaction.
      await c.query('CREATE ROLE di_probe_member NOLOGIN IN ROLE rab_secure_owner');
      await c.query('SET LOCAL ROLE di_probe_member');
      expect((await c.query('SELECT count(*)::int AS n FROM core.deployment_identity')).rows[0].n).toBe(0);
      expect((await c.query('SELECT count(*)::int AS n FROM core.deployment_identity_history')).rows[0].n).toBe(0);
      await expectSqlState(c, WRITE_ATTEMPTS[0], [], '42501');
      await expectSqlState(c, WRITE_ATTEMPTS[4], [], '42501');
      expect((await c.query('UPDATE core.deployment_identity SET reason = reason')).rowCount).toBe(0);
      await c.query('RESET ROLE');
      await c.query('SET LOCAL ROLE rab_secure_owner');
      await expectSqlState(c, 'UPDATE core.deployment_identity_history SET reason = reason', [], '42501');
      await expectSqlState(c, 'DELETE FROM core.deployment_identity_history', [], '42501');
      await expectSqlState(c, 'TRUNCATE core.deployment_identity_history', [], '42501');
      await expectSqlState(c, 'DELETE FROM core.deployment_identity', [], '42501');
      await expectSqlState(c, 'TRUNCATE core.deployment_identity', [], '42501');
      await c.query('RESET ROLE');
    });
  });

  it('BOUNDARY (documented, not a control): acting AS rab_secure_owner writes the marker directly with NO history row — the history is not tamper-proof against the migration identity', async () => {
    await inRolledBackTx(async (c) => {
      await c.query(bind, ['test', ID_A, REASON, 'integration', null, [BIND_HOST]]);
      await c.query('SET LOCAL ROLE rab_secure_owner');
      const updated = await c.query(`UPDATE core.deployment_identity SET deployment_id = '${ID_C}', reason = 'direct write, bypassing bind()'`);
      expect(updated.rowCount).toBe(1);
      expect((await c.query('SELECT count(*)::int AS n FROM core.deployment_identity_history')).rows[0].n).toBe(1);
      await c.query('RESET ROLE');
      expect((await c.query('SELECT deployment_id::text AS id FROM core.deployment_identity_check()')).rows).toEqual([{ id: ID_C }]);
    });
  });

  it('bind (migration identity): first bind, compare-and-swap, new id required, host-set validation, rebind, audited history row', async () => {
    await inRolledBackTx(async (c) => {
      await expectSqlState(c, bind, ['test', ID_A, REASON, 'integration', ID_B, [BIND_HOST]], '55000'); // unbound: nothing to confirm
      await c.query(bind, ['test', ID_A, REASON, 'integration', null, [PROXY_HOST, BIND_HOST]]);
      expect((await c.query('SELECT environment, deployment_id::text AS id, bound_database = current_database() AS same_db, bound_hosts FROM core.deployment_identity_check()')).rows).toEqual([
        { environment: 'test', id: ID_A, same_db: true, bound_hosts: [BIND_HOST, PROXY_HOST].sort() },
      ]);
      await expectSqlState(c, bind, ['staging', ID_B, REASON, 'integration', null, [BIND_HOST]], '55000'); // current id not confirmed
      await expectSqlState(c, bind, ['staging', ID_B, REASON, 'integration', ID_B, [BIND_HOST]], '55000'); // wrong current id
      await expectSqlState(c, bind, ['staging', ID_A, REASON, 'integration', ID_A, [BIND_HOST]], '22023'); // same id
      await expectSqlState(c, bind, ['prod', ID_B, REASON, 'integration', ID_A, [BIND_HOST]], '22023'); // unknown environment
      await expectSqlState(c, bind, ['staging', ID_B, 'short', 'integration', ID_A, [BIND_HOST]], '22023'); // reason too short
      await expectSqlState(c, bind, ['staging', ID_B, REASON, ' ', ID_A, [BIND_HOST]], '22023'); // actor empty
      for (const hosts of [null, [], ['DB.Example'], [BIND_HOST, BIND_HOST], ['a', 'b', 'c', 'd', 'e', 'f'], ['a,b'], ['db_host'], [null], ['x'.repeat(254)]]) {
        await expectSqlState(c, bind, ['staging', ID_B, REASON, 'integration', ID_A, hosts], '22023');
      }
      await expectSqlState(c, `SELECT core.deployment_identity_bind('staging', $1::uuid, $2, 'integration', $3::uuid, '{{a},{b}}'::text[])`, [ID_B, REASON, ID_A], '22023');
      await c.query(bind, ['staging', ID_B, REASON, '  ops: integration  ', ID_A, [BIND_HOST]]);
      const history = (await c.query(
        `SELECT previous_environment, previous_deployment_id::text AS prev, previous_bound_database = current_database() AS prev_same_db,
                previous_bound_hosts, environment, deployment_id::text AS id, bound_database = current_database() AS same_db, bound_hosts,
                session_login = session_user::text AS login_recorded, bound_by, reason
           FROM core.deployment_identity_history ORDER BY bound_at`,
      )).rows;
      expect(history).toEqual([
        { previous_environment: null, prev: null, prev_same_db: null, previous_bound_hosts: null, environment: 'test', id: ID_A, same_db: true, bound_hosts: [BIND_HOST, PROXY_HOST].sort(), login_recorded: true, bound_by: 'integration', reason: REASON },
        { previous_environment: 'test', prev: ID_A, prev_same_db: true, previous_bound_hosts: [BIND_HOST, PROXY_HOST].sort(), environment: 'staging', id: ID_B, same_db: true, bound_hosts: [BIND_HOST], login_recorded: true, bound_by: 'ops: integration', reason: REASON },
      ]);
    });
  });

  it('the table CHECK refuses a malformed host set even from the owner (not only the definer validates)', async () => {
    await inRolledBackTx(async (c) => {
      await c.query('SET LOCAL ROLE rab_secure_owner');
      for (const hosts of ['{}', '{UPPER}', '{a,NULL}', '{"a,b"}', '{a,b,c,d,e,f}']) {
        await expectSqlState(
          c,
          `INSERT INTO core.deployment_identity (environment, deployment_id, bound_database, bound_hosts, bound_at, bound_by, reason) VALUES ('test', $1::uuid, current_database(), $2::text[], now(), 'x', 'xxxxxxxxxxxx')`,
          [ID_A, hosts],
          '23514',
        );
      }
      await c.query('RESET ROLE');
    });
  });

  it('pg_control_system() on PostgreSQL 16: callability per role, and check() reports the identifier exactly when its owner may call it', async () => {
    await withAdmin(async (c) => {
      const [facts] = (await c.query(
        `SELECT current_setting('server_version_num')::int AS version,
                has_function_privilege('crewflow_app', 'pg_catalog.pg_control_system()', 'EXECUTE') AS crewflow_app,
                has_function_privilege('crewflow', 'pg_catalog.pg_control_system()', 'EXECUTE') AS crewflow,
                has_function_privilege('rab_secure_owner', 'pg_catalog.pg_control_system()', 'EXECUTE') AS rab_secure_owner,
                (SELECT proacl::text FROM pg_proc WHERE oid = 'pg_catalog.pg_control_system()'::regprocedure) AS acl`,
      )).rows;
      // eslint-disable-next-line no-console
      console.log(`[a8b] pg_control_system evidence ${JSON.stringify(facts)}`);
      expect(facts.version).toBeGreaterThanOrEqual(160000);
      await c.query('BEGIN');
      try {
        await c.query(bind, ['test', ID_A, REASON, 'integration', null, [BIND_HOST]]);
        const [row] = (await c.query('SELECT bound_system_identifier::text AS bound, current_system_identifier::text AS now FROM core.deployment_identity_check()')).rows;
        // eslint-disable-next-line no-console
        console.log(`[a8b] check() system_identifier bound=${row.bound === null ? 'NULL' : 'set'} current=${row.now === null ? 'NULL' : 'set'}`);
        expect(row.now !== null).toBe(facts.rab_secure_owner);
        expect(row.bound).toBe(row.now);
        for (const role of ['crewflow_app', 'crewflow']) {
          await c.query(`SET LOCAL ROLE ${role}`);
          if (facts[role]) await c.query('SELECT system_identifier FROM pg_catalog.pg_control_system()');
          else await expectSqlState(c, 'SELECT system_identifier FROM pg_catalog.pg_control_system()', [], '42501');
          await c.query('RESET ROLE');
        }
      } finally {
        await c.query('ROLLBACK');
      }
    });
  });

  it('boot gates against a bound marker: host set match passes; another host, another database name and production-bound are refused', async () => {
    // A committed bind is needed here (the gates open their own connection); the UNBOUND state is restored in finally.
    await withAdmin(async (c) => c.query(bind, ['ci', ID_A, REASON, 'integration', null, [BIND_HOST, PROXY_HOST]]));
    const opts = (env: Record<string, string>): RunBootGatesOptions => ({
      env,
      connectionEnv: { NODE_ENV: 'test', PG_DATABASE_URL: appUrl },
      retry: { attempts: 1 },
      log: () => undefined,
    });
    const declared = (id: string) => ({ NODE_ENV: 'test', CREWFLOW_DEPLOYMENT_ENVIRONMENT: 'ci', CREWFLOW_DEPLOYMENT_ID: id });
    try {
      await expect(runDatabaseBootGates('api', opts(declared(ID_A)))).resolves.toMatchObject({ identity: `ci/${ID_A}`, warnings: [] });
      await expect(runDatabaseBootGates('api', opts(declared(ID_B)))).rejects.toBeInstanceOf(DatabaseBootGateError);
      await expect(runDatabaseBootGates('api', opts({ NODE_ENV: 'test' }))).resolves.toMatchObject({ identity: `ci/${ID_A}` });
      // The same marker bound only at OTHER hosts (what a restore / clone elsewhere, or a provider-issued new host name,
      // looks like from here) is refused even with the matching declared identity.
      await withAdmin(async (c) => c.query(bind, ['ci', ID_B, REASON, 'integration', ID_A, ['origin.example.internal', PROXY_HOST]]));
      await expect(runDatabaseBootGates('api', opts(declared(ID_B)))).rejects.toThrow(
        /bound at hosts "origin\.example\.internal", "proxy\.integration\.internal".*db:bind-identity/,
      );
      // A restore under another database name: simulated by the documented owner-level write (the boundary above).
      await withAdmin(async (c) => {
        await c.query(bind, ['ci', ID_C, REASON, 'integration', ID_B, [BIND_HOST]]);
        await c.query('BEGIN');
        await c.query('SET LOCAL ROLE rab_secure_owner');
        await c.query(`UPDATE core.deployment_identity SET bound_database = 'restored_elsewhere'`);
        await c.query('COMMIT');
      });
      await expect(runDatabaseBootGates('api', opts(declared(ID_C)))).rejects.toThrow(/bound in database "restored_elsewhere".*db:bind-identity/);
      await withAdmin(async (c) => {
        await c.query('BEGIN');
        await c.query('SET LOCAL ROLE rab_secure_owner');
        await c.query(`UPDATE core.deployment_identity SET bound_database = current_database()`);
        await c.query('COMMIT');
      });
      await withAdmin(async (c) => c.query(bind, ['production', ID_A, REASON, 'integration', ID_C, [BIND_HOST]]));
      await expect(runDatabaseBootGates('api', opts({ NODE_ENV: 'test' }))).rejects.toThrow(/bound to production/);
    } finally {
      await resetMarker();
    }
    await withAdmin(async (c) => expect((await c.query('SELECT * FROM core.deployment_identity_check()')).rows).toEqual([]));
  });

  it('up -> down -> up (committed, as the migration does it): the exact reviewed state, zero posture and privilege drift', async () => {
    const posture = await readSecurityPosture(adminUrl);
    const privileges = await withAdmin((c) => privilegeDriftSnapshot(async (sql) => (await c.query(sql)).rows));
    const ds = new DataSource({ type: 'postgres', url: adminUrl, entities: [], logging: false });
    await ds.initialize();
    const qr = ds.createQueryRunner();
    try {
      await qr.startTransaction();
      await new DeploymentIdentity1786721230000().down(qr);
      expect((await qr.query(`SELECT to_regclass('core.deployment_identity') AS t, to_regprocedure('core.deployment_identity_check()') AS f`))[0]).toEqual({ t: null, f: null });
      await qr.rollbackTransaction();
    } finally {
      await qr.release();
      await ds.destroy();
    }
    await resetMarker();
    await withAdmin(async (c) => {
      const [state] = (await c.query(DEPLOYMENT_IDENTITY_STATE_SQL)).rows;
      expect(state).toEqual({ ...DEPLOYMENT_IDENTITY_EXPECTED_STATE });
    });
    expect(await readSecurityPosture(adminUrl)).toEqual(posture);
    expect(await withAdmin((c) => privilegeDriftSnapshot(async (sql) => (await c.query(sql)).rows))).toEqual(privileges);
  });
});

/** Restores the unbound marker after a committed bind: down() + up() in one committed transaction (the round trip). */
async function resetMarker(): Promise<void> {
  const ds = new DataSource({ type: 'postgres', url: adminUrl, entities: [], logging: false });
  await ds.initialize();
  const qr = ds.createQueryRunner();
  try {
    await qr.startTransaction();
    await new DeploymentIdentity1786721230000().down(qr);
    await new DeploymentIdentity1786721230000().up(qr);
    await qr.commitTransaction();
  } catch (error) {
    await qr.rollbackTransaction().catch(() => undefined);
    throw error;
  } finally {
    await qr.release();
    await ds.destroy();
  }
}
