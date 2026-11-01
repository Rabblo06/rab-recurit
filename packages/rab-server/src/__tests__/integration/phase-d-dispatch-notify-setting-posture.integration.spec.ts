import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

import {
  diffPosture,
  dispatchNotifySettingProblems,
  goldenLinesFrom,
  POSTURE_QUERY,
  splitGolden,
} from '../../database/typeorm/core/security-posture';
import { resolveIntegrationTestDatabase } from '../../database/typeorm/core/test-database-guard';

/**
 * Phase D wave 3 (owner-approved OD-2 follow-up): a PERSISTENT database- or role-level `crewflow.dispatch_notify` would
 * silently put sessions into event-mode NOTIFY (where a NOTIFY failure fails the producer's COMMIT). The security posture
 * reports every such setting that applies to this database as a `setting|` line (never in the golden → always drift), and
 * the CI gate (tools/check-rls-coverage.ts → dispatchNotifySettingProblems) fails on it.
 *
 * Runs on the disposable test database as it is (no Phase D SQL needed). Every ALTER ROLE / ALTER DATABASE … SET is made
 * by the bootstrap superuser inside a transaction that is ALWAYS rolled back (pg_db_role_setting is transactional).
 */
const RUN = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_DATABASE_URL_UNPOOLED);
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(120_000);

const GOLDEN = readFileSync(join(__dirname, '../../database/typeorm/core/security-posture.golden.txt'), 'utf8').split('\n').filter(Boolean);

describe('posture golden never carries a crewflow.dispatch_notify setting (offline)', () => {
  it('the committed golden has no setting| line', () => {
    expect(GOLDEN.filter((l) => l.startsWith('setting|'))).toEqual([]);
  });

  it('goldenLinesFrom refuses to write a golden that contains one', () => {
    const posture = { core: ['owner|table|x|crewflow', 'setting|crewflow_app|crewflow.dispatch_notify|on'], workspaces: new Map<string, string[]>() };
    expect(() => goldenLinesFrom(posture, [])).toThrow(/refusing to write a golden that contains a persistent crewflow\.dispatch_notify setting/);
    expect(goldenLinesFrom({ core: ['owner|table|x|crewflow'], workspaces: new Map() }, []).lines).toEqual(['owner|table|x|crewflow']);
  });
});

describeIfDb('posture + CI gate report a persistent crewflow.dispatch_notify (rolled back on the live test database)', () => {
  const { adminUrl } = RUN ? resolveIntegrationTestDatabase(process.env) : ({} as never);
  let c: Client;
  let db: string;

  const settingLines = async () => (await c.query(POSTURE_QUERY)).rows.map((r: { line: string }) => r.line).filter((l: string) => l.startsWith('setting|'));
  const gate = () => dispatchNotifySettingProblems(async (sql) => (await c.query(sql)).rows);
  const unexpected = async () => diffPosture(splitGolden(GOLDEN).core, (await c.query(POSTURE_QUERY)).rows.map((r: { line: string }) => r.line)).unexpected;

  async function rolledBack(fn: () => Promise<void>): Promise<void> {
    await c.query('BEGIN');
    try {
      await c.query(`SET LOCAL lock_timeout = '5s'`);
      await fn();
    } finally {
      await c.query('ROLLBACK');
    }
  }

  beforeAll(async () => {
    c = new Client({ connectionString: adminUrl, connectionTimeoutMillis: 15_000 });
    await c.connect();
    const { rows } = await c.query('SELECT current_database() AS db, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su');
    if (!rows[0].su) throw new Error('this suite needs the disposable database bootstrap superuser as TEST_DATABASE_URL_UNPOOLED');
    db = rows[0].db;
  });

  afterAll(async () => {
    await c?.end();
  });

  it('baseline: no setting| posture line, no gate problem, nothing setting-related is drift', async () => {
    expect(await settingLines()).toEqual([]);
    expect(await gate()).toEqual([]);
    expect((await unexpected()).filter((l) => l.startsWith('setting|'))).toEqual([]);
  });

  it('ALTER ROLE crewflow_app / crewflow_worker IN DATABASE <this db> SET … → one line each (any value), drift, gate fails', async () => {
    await rolledBack(async () => {
      await c.query(`ALTER ROLE crewflow_app IN DATABASE ${quoteIdent(db)} SET crewflow.dispatch_notify = 'on'`);
      await c.query(`ALTER ROLE crewflow_worker IN DATABASE ${quoteIdent(db)} SET crewflow.dispatch_notify = 'off'`);
      const want = ['setting|crewflow_app|crewflow.dispatch_notify|on', 'setting|crewflow_worker|crewflow.dispatch_notify|off'];
      expect(await settingLines()).toEqual(want);
      expect(await unexpected()).toEqual(expect.arrayContaining(want));
      const problems = await gate();
      expect(problems).toHaveLength(2);
      expect(problems[0]).toMatch(/^setting\|crewflow_app\|crewflow\.dispatch_notify\|on: a persistent crewflow\.dispatch_notify setting/);
    });
    expect(await settingLines()).toEqual([]); // rolled back
  });

  it('a role-wide setting (every database, setdatabase = 0) is reported too', async () => {
    await rolledBack(async () => {
      await c.query(`ALTER ROLE crewflow SET crewflow.dispatch_notify = 'on'`);
      expect(await settingLines()).toEqual(['setting|crewflow|crewflow.dispatch_notify|on']);
      expect(await gate()).toHaveLength(1);
    });
  });

  it('a database-wide setting on this database (setrole = 0) is reported as *', async () => {
    await rolledBack(async () => {
      await c.query(`ALTER DATABASE ${quoteIdent(db)} SET crewflow.dispatch_notify = 'on'`);
      expect(await settingLines()).toEqual(['setting|*|crewflow.dispatch_notify|on']);
      expect(await gate()).toHaveLength(1);
    });
  });

  it('a setting that applies only to ANOTHER database is not this database\'s drift; other settings of the role are ignored', async () => {
    await rolledBack(async () => {
      await c.query(`ALTER ROLE crewflow_app IN DATABASE postgres SET crewflow.dispatch_notify = 'on'`);
      await c.query(`ALTER ROLE crewflow_app IN DATABASE ${quoteIdent(db)} SET crewflow.unrelated_probe = 'on'`);
      expect(await settingLines()).toEqual([]);
      expect(await gate()).toEqual([]);
    });
  });
});

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
