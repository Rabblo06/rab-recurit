import { Client } from 'pg';

import { readSemanticPosture } from '../../database/posture-drift/semantic-posture';
import { integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';
import { resolveIntegrationTestDatabase } from '../../database/typeorm/core/test-database-guard';

/**
 * Semantic posture: trigger definition hash (`def=`; DB review F5 of PR #251, split into its own PR). A trigger re-created
 * under the SAME name and function with another timing, column list, WHEN clause or arguments keeps its old line prefix,
 * so before `def=` the monitor could not see the change. Everything here runs in ONE transaction that is rolled back.
 */
const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;
const TRG = 'zz_posture_def_probe';
// The probe trigger reuses an existing core trigger function (core.owner_login_grant_parity_guard); it never fires (rolled back).

describeIfDb('semantic posture: trigger definition hash (rolled back)', () => {
  const { adminUrl } = RUN ? resolveIntegrationTestDatabase(process.env) : { adminUrl: '' };
  let c: Client;

  beforeAll(async () => {
    c = new Client({ connectionString: adminUrl });
    await c.connect();
  });
  afterAll(async () => {
    await c?.end();
  });

  const read = async () => readSemanticPosture(async (sql, params) => (await c.query(sql, params as unknown[] | undefined)).rows, { ownTransaction: false });
  const probeLine = async () => {
    const lines = (await read()).core.filter((l) => l.startsWith(`trigger|permission|${TRG}|`));
    expect(lines).toHaveLength(1);
    return lines[0]!;
  };
  it('same name and function, another definition: the line prefix is unchanged but def= changes', async () => {
    await c.query('BEGIN');
    try {
      await c.query(`DROP TRIGGER IF EXISTS ${TRG} ON core.permission`);
      await c.query(`CREATE TRIGGER ${TRG} BEFORE UPDATE ON core.permission FOR EACH ROW EXECUTE FUNCTION core.owner_login_grant_parity_guard('key')`);
      const base = await probeLine();
      expect(base).toMatch(new RegExp(`^trigger\\|permission\\|${TRG}\\|enabled=O\\|core\\.owner_login_grant_parity_guard\\(\\)\\|def=[0-9a-f]{32}$`));
      const prefix = base.slice(0, base.indexOf('|def='));

      const variants: Record<string, string> = {};
      // Each variant is a full re-create: same name, same function.
      await c.query(`DROP TRIGGER ${TRG} ON core.permission`);
      await c.query(`CREATE TRIGGER ${TRG} AFTER UPDATE ON core.permission FOR EACH ROW EXECUTE FUNCTION core.owner_login_grant_parity_guard('key')`);
      variants.after = await probeLine();
      await c.query(`DROP TRIGGER ${TRG} ON core.permission`);
      await c.query(`CREATE TRIGGER ${TRG} BEFORE UPDATE OF description ON core.permission FOR EACH ROW EXECUTE FUNCTION core.owner_login_grant_parity_guard('key')`);
      variants.columns = await probeLine();
      await c.query(`DROP TRIGGER ${TRG} ON core.permission`);
      await c.query(
        `CREATE TRIGGER ${TRG} BEFORE UPDATE ON core.permission FOR EACH ROW WHEN (OLD.key IS DISTINCT FROM NEW.key) EXECUTE FUNCTION core.owner_login_grant_parity_guard('key')`,
      );
      variants.when = await probeLine();
      await c.query(`DROP TRIGGER ${TRG} ON core.permission`);
      await c.query(`CREATE TRIGGER ${TRG} BEFORE UPDATE ON core.permission FOR EACH ROW EXECUTE FUNCTION core.owner_login_grant_parity_guard('key', 'description')`);
      variants.args = await probeLine();
      await c.query(`DROP TRIGGER ${TRG} ON core.permission`);
      await c.query(`CREATE TRIGGER ${TRG} BEFORE UPDATE OR DELETE ON core.permission FOR EACH ROW EXECUTE FUNCTION core.owner_login_grant_parity_guard('key')`);
      variants.events = await probeLine();

      const all = [base, ...Object.values(variants)];
      for (const l of all) expect(l.startsWith(`${prefix}|def=`)).toBe(true);
      expect(new Set(all).size).toBe(all.length); // every definition change shows

      // Re-creating the original definition gives the original line back (the hash is a pure function of the definition).
      await c.query(`DROP TRIGGER ${TRG} ON core.permission`);
      await c.query(`CREATE TRIGGER ${TRG} BEFORE UPDATE ON core.permission FOR EACH ROW EXECUTE FUNCTION core.owner_login_grant_parity_guard('key')`);
      expect(await probeLine()).toBe(base);
    } finally {
      await c.query('ROLLBACK');
    }
  });

  it('the read pins search_path: a session search_path that includes core renders the same lines, and is restored afterwards', async () => {
    await c.query('BEGIN');
    try {
      const plain = await read();
      await c.query(`SELECT set_config('search_path', 'core, public', true)`);
      const withCore = await read();
      expect(withCore.core).toEqual(plain.core);
      expect(withCore.sha256).toBe(plain.sha256);
      expect((await c.query(`SELECT current_setting('search_path') AS sp`)).rows[0]).toEqual({ sp: 'core, public' });
    } finally {
      await c.query('ROLLBACK');
    }
  });
});
