import { randomBytes } from 'crypto';
import { Client } from 'pg';

import { createPgPool } from '../postgres/create-pg-pool';
import { resolvePgEnvironment } from '../postgres/pg-config';
import {
  assertDispatchNotifyGate,
  DatabaseBootGateError,
  DISPATCH_NOTIFY_SESSION_SQL,
  DISPATCH_NOTIFY_STORED_SQL,
} from './database-boot-gate-rules';
import { integrationTestDatabaseReady } from '../typeorm/core/integration-test-database-gate';

/**
 * Phase D wave 3 gate 1c ("dispatch-notify") against the real PostgreSQL catalog of the disposable test database (C1 schema;
 * no Phase D SQL needed — the gate reads only pg_db_role_setting / pg_roles / pg_database and a session setting).
 *
 * Every stored setting below is written by the admin connection INSIDE one transaction that is always rolled back
 * (ALTER ROLE … [IN DATABASE …] SET, ALTER DATABASE … SET, CREATE ROLE and GRANT are transactional). The check then runs in
 * that same transaction as `SET LOCAL ROLE crewflow_app` — the uncommitted rows are invisible to every other session, and
 * nothing survives the test (asserted at the end from a fresh crewflow_app connection).
 */
const appUrl = process.env.TEST_DATABASE_URL;
const adminUrl = process.env.TEST_DATABASE_URL_UNPOOLED;
const describeDb = integrationTestDatabaseReady() ? describe : describe.skip;

const resolved = (processRole: 'api' | 'worker' | 'cli', mode?: string) =>
  resolvePgEnvironment({ NODE_ENV: 'test', PG_DATABASE_URL: appUrl, ...(mode ? { WORKER_DISPATCH_MODE: mode } : {}) }, { processRole, enforceProcessPolicy: false });

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;
const APP_SETTINGS_COUNT_SQL = `SELECT count(*)::int AS n FROM pg_catalog.pg_db_role_setting s JOIN pg_catalog.pg_roles r ON r.oid = s.setrole WHERE r.rolname = 'crewflow_app'`;

describeDb('dispatch-notify boot gate on a real catalog', () => {
  let admin: Client;
  let database: string;
  let baselineAppSettings: number;

  beforeAll(async () => {
    admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    database = (await admin.query('SELECT pg_catalog.current_database()::text AS d')).rows[0].d;
    if (!IDENT.test(database)) throw new Error('unexpected test database name shape');
    const app = await admin.query(`SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'crewflow_app'`);
    if (app.rowCount !== 1) throw new Error('crewflow_app must exist on the test cluster');
    baselineAppSettings = (await admin.query(APP_SETTINGS_COUNT_SQL)).rows[0].n;
  });

  afterAll(async () => {
    await admin?.end();
  });

  /** Runs `body` inside BEGIN … ROLLBACK on the admin connection (always rolled back, even on failure). */
  async function inRolledBackTransaction(body: () => Promise<void>): Promise<void> {
    await admin.query('BEGIN');
    try {
      await admin.query(`SET LOCAL lock_timeout = '5s'`);
      await admin.query(`SET LOCAL statement_timeout = '10s'`);
      await body();
    } finally {
      await admin.query('ROLLBACK');
    }
  }

  /** The gate's stored-setting query as crewflow_app, inside the admin's open transaction. */
  async function storedAsApp(): Promise<Array<Record<string, unknown>>> {
    await admin.query('SET LOCAL ROLE crewflow_app');
    try {
      return (await admin.query(DISPATCH_NOTIFY_STORED_SQL)).rows;
    } finally {
      await admin.query('RESET ROLE');
    }
  }

  function refusal(rows: Array<Record<string, unknown>>): DatabaseBootGateError {
    try {
      assertDispatchNotifyGate(rows, { dispatch_notify: null }, { expectOn: false, label: 'api process' });
    } catch (error) {
      return error as DatabaseBootGateError;
    }
    throw new Error('expected the dispatch-notify gate to refuse');
  }

  it('clean database: crewflow_app can read the catalog, nothing is stored; poll session absent, event session on', async () => {
    const poll = createPgPool(resolved('api', 'poll'), { purpose: 'boot-gates', max: 1 });
    const event = createPgPool(resolved('worker', 'event'), { purpose: 'boot-gates', max: 1 });
    const cli = createPgPool(resolved('cli', 'event'), { purpose: 'boot-gates', max: 1 });
    try {
      const stored = (await poll.query(DISPATCH_NOTIFY_STORED_SQL)).rows;
      expect(stored).toEqual([]);
      expect(assertDispatchNotifyGate(stored, (await poll.query(DISPATCH_NOTIFY_SESSION_SQL)).rows[0], { expectOn: false, label: 'api process' })).toBe('absent');
      expect(assertDispatchNotifyGate(stored, (await event.query(DISPATCH_NOTIFY_SESSION_SQL)).rows[0], { expectOn: true, label: 'worker process' })).toBe('on');
      expect(assertDispatchNotifyGate(stored, (await cli.query(DISPATCH_NOTIFY_SESSION_SQL)).rows[0], { expectOn: false, label: 'CLI command "ping"' })).toBe('absent');
      // A poll-mode process whose session carried it, and an event-mode process whose session did not, both refuse.
      const eventSession = (await event.query(DISPATCH_NOTIFY_SESSION_SQL)).rows[0];
      expect(() => assertDispatchNotifyGate(stored, eventSession, { expectOn: false, label: 'api process' })).toThrow(/must not carry/);
      expect(() => assertDispatchNotifyGate(stored, { dispatch_notify: null }, { expectOn: true, label: 'worker process' })).toThrow(/event mode/);
    } finally {
      await Promise.all([poll.end(), event.end(), cli.end()]);
    }
  });

  it(`ALTER ROLE crewflow_app IN DATABASE <db> SET crewflow.dispatch_notify = 'on' is reported (rolled back)`, async () => {
    await inRolledBackTransaction(async () => {
      await admin.query(`ALTER ROLE crewflow_app IN DATABASE ${database} SET crewflow.dispatch_notify = 'on'`);
      const rows = await storedAsApp();
      expect(rows).toEqual([{ role_name: 'crewflow_app', database_name: database }]);
      const error = refusal(rows);
      expect(error.gate).toBe('dispatch-notify');
      expect(error.message).toContain(`role crewflow_app in database ${database}`);
    });
  });

  it("'off' is reported too (any stored value), as is the all-databases row of the role", async () => {
    await inRolledBackTransaction(async () => {
      await admin.query(`ALTER ROLE crewflow_app SET crewflow.dispatch_notify = 'off'`);
      expect(await storedAsApp()).toEqual([{ role_name: 'crewflow_app', database_name: null }]);
    });
  });

  it('the database-wide row (setrole = 0, ALTER DATABASE … SET) is reported', async () => {
    await inRolledBackTransaction(async () => {
      await admin.query(`ALTER DATABASE ${database} SET crewflow.dispatch_notify = 'on'`);
      expect(await storedAsApp()).toEqual([{ role_name: null, database_name: database }]);
    });
  });

  it('a row for a role crewflow_app is a member of is reported; a row for an unrelated role is not', async () => {
    const parent = `dn_gate_parent_${randomBytes(4).toString('hex')}`;
    const other = `dn_gate_other_${randomBytes(4).toString('hex')}`;
    await inRolledBackTransaction(async () => {
      await admin.query(`CREATE ROLE ${parent} NOLOGIN`);
      await admin.query(`CREATE ROLE ${other} NOLOGIN`);
      await admin.query(`GRANT ${parent} TO crewflow_app WITH INHERIT FALSE, SET FALSE`);
      await admin.query(`ALTER ROLE ${parent} IN DATABASE ${database} SET crewflow.dispatch_notify = 'on'`);
      await admin.query(`ALTER ROLE ${other} IN DATABASE ${database} SET crewflow.dispatch_notify = 'on'`);
      expect(await storedAsApp()).toEqual([{ role_name: parent, database_name: database }]);
    });
  });

  it('an unrelated setting of crewflow_app is not reported', async () => {
    await inRolledBackTransaction(async () => {
      await admin.query(`ALTER ROLE crewflow_app IN DATABASE ${database} SET work_mem = '8MB'`);
      expect(await storedAsApp()).toEqual([]);
    });
  });

  it('nothing survived: a fresh crewflow_app connection sees no stored setting and no leftover test role', async () => {
    const pool = createPgPool(resolved('api'), { purpose: 'boot-gates', max: 1 });
    try {
      expect((await pool.query(DISPATCH_NOTIFY_STORED_SQL)).rows).toEqual([]);
      expect((await pool.query(`SELECT count(*)::int AS n FROM pg_catalog.pg_roles WHERE rolname LIKE 'dn\\_gate\\_%'`)).rows[0].n).toBe(0);
      expect((await pool.query(APP_SETTINGS_COUNT_SQL)).rows[0].n).toBe(baselineAppSettings);
    } finally {
      await pool.end();
    }
  });
});
