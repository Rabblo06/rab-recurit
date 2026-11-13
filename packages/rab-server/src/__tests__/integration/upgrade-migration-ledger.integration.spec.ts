import { Client } from 'pg';

import { MIGRATION_LOCK_KEY } from '../../database/typeorm/scripts/migrate/migration-lock';
import { resolveIntegrationTestDatabase } from '../../database/typeorm/core/test-database-guard';
import { SeededWorkspace, seedWorkspace } from './helpers/workspace-fixtures';

/**
 * OWNER-DB-ULTIMATE Part B (UpgradeMigrationLedger1786721470000, owner-approved SQL incl. REVISED 2): core.upgrade_migration
 * on the real test database, as the runtime login (TEST_DATABASE_URL, crewflow_owner).
 *
 * The owner's required test (2026-11-13): a direct DELETE on core.upgrade_migration as crewflow_owner, and after SET ROLE
 * rab_secure_owner, removes 0 rows; deleting a workspace removes exactly its rows (the FK cascade, which needs the owner's
 * DELETE privilege: REVISED 2) and leaves the instance rows. Plus the access rules of R3: no scope = nothing; 'upgrade'
 * inserts only while this session holds the migration lock; 'workspace_init' only for a workspace of the bound
 * organisation; no UPDATE / TRUNCATE for anyone. Rows written here are removed by the cluster superuser afterwards.
 *
 * Coordination: agent "B2 tests" owns the start-up / adoption / --force / deploy-order suites; this file holds only the
 * table-level rules (and the owner's delete / cascade test), so nothing is duplicated.
 */
jest.setTimeout(120_000);

const RUN = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_DATABASE_URL_UNPOOLED);
const describeIfDb = RUN ? describe : describe.skip;
const SFX = Math.random().toString(36).replace(/[^a-z]/g, '').slice(0, 8) || 'x';
const step = (n: string) => `0.6.0_Itest${n}${SFX}`;
const LOCK = MIGRATION_LOCK_KEY.toString();

describeIfDb('core.upgrade_migration (integration, OWNER-DB-ULTIMATE Part B)', () => {
  const { adminUrl } = RUN ? resolveIntegrationTestDatabase(process.env) : ({} as never);
  let admin: Client;
  let app: Client;
  let ws: SeededWorkspace;
  let other: SeededWorkspace;

  const tx = async <T>(c: Client, fn: () => Promise<T>): Promise<T> => {
    await c.query('BEGIN');
    try {
      const out = await fn();
      await c.query('COMMIT');
      return out;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    }
  };
  const scope = (c: Client, s: string) => c.query(`SELECT pg_catalog.set_config('rab.upgrade_scope', $1, true)`, [s]);
  const tenant = (c: Client, org: string) => c.query(`SELECT pg_catalog.set_config('rab.organisation_id', $1, true)`, [org]);
  const record = (c: Client, name: string, status = 'completed') =>
    c.query(
      `INSERT INTO core.upgrade_migration (name, status, attempt, executed_by_version, error_message)
       SELECT $1, $2, pg_catalog.count(*)::int + 1, '0.6.0', CASE WHEN $2 = 'failed' THEN 'Error: boom' END
         FROM core.upgrade_migration m WHERE m.name = $1 AND m.workspace_id IS NULL
       RETURNING attempt`,
      [name, status],
    );
  const sqlstate = async (p: Promise<unknown>) => {
    try {
      await p;
      return 'ok';
    } catch (e) {
      return (e as { code?: string }).code ?? 'error';
    }
  };
  const count = async (where: string, params: unknown[] = []) =>
    Number((await admin.query(`SELECT pg_catalog.count(*)::int AS n FROM core.upgrade_migration WHERE ${where}`, params)).rows[0].n);

  beforeAll(async () => {
    admin = new Client({ connectionString: adminUrl });
    app = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.connect();
    await app.connect();
    ws = await seedWorkspace(admin, `upgr-a-${SFX}`);
    other = await seedWorkspace(admin, `upgr-b-${SFX}`);
  });

  afterAll(async () => {
    await admin.query(`DELETE FROM core.upgrade_migration WHERE name LIKE $1`, [`0.6.0_Itest%${SFX}`]).catch(() => undefined);
    for (const w of [ws, other]) {
      if (!w) continue;
      await admin.query('DELETE FROM core.manager_workspace WHERE id = $1', [w.id]).catch(() => undefined);
      await admin.query('DELETE FROM core."user" WHERE id = $1', [w.owner]).catch(() => undefined);
      await admin.query('DELETE FROM core.organisation WHERE id = $1', [w.org]).catch(() => undefined);
    }
    await app.end();
    await admin.end();
  });

  it('the test login is the one runtime login, crewflow_owner', async () => {
    const who = (await app.query('SELECT current_user::text AS u, session_user::text AS s')).rows[0];
    expect(who).toEqual({ u: 'crewflow_owner', s: 'crewflow_owner' });
  });

  it("no scope (every request handler): 0 rows, INSERT refused (42501); a scope does not outlive its transaction", async () => {
    await admin.query(
      `INSERT INTO core.upgrade_migration (name, status, attempt, executed_by_version) VALUES ($1, 'completed', 1, '0.6.0')`,
      [step('Seen')],
    );
    expect(Number((await app.query('SELECT pg_catalog.count(*)::int AS n FROM core.upgrade_migration')).rows[0].n)).toBe(0);
    await app.query(`SELECT pg_advisory_lock($1::bigint)`, [LOCK]);
    try {
      expect(await sqlstate(record(app, step('NoScope')))).toBe('42501');
      await tx(app, () => scope(app, 'upgrade'));
      expect(Number((await app.query('SELECT pg_catalog.count(*)::int AS n FROM core.upgrade_migration')).rows[0].n)).toBe(0);
    } finally {
      await app.query(`SELECT pg_advisory_unlock($1::bigint)`, [LOCK]);
    }
  });

  it("'upgrade' inserts only while this session holds the migration lock; attempts count up; (name, attempt) is unique", async () => {
    expect(await sqlstate(tx(app, async () => { await scope(app, 'upgrade'); await record(app, step('Lock')); }))).toBe('42501');
    await app.query(`SELECT pg_advisory_lock($1::bigint)`, [LOCK]);
    try {
      const a1 = await tx(app, async () => { await scope(app, 'upgrade'); return (await record(app, step('Lock'), 'failed')).rows[0].attempt; });
      const a2 = await tx(app, async () => { await scope(app, 'upgrade'); return (await record(app, step('Lock'))).rows[0].attempt; });
      expect([a1, a2]).toEqual([1, 2]);
      const dup = tx(app, async () => {
        await scope(app, 'upgrade');
        await app.query(`INSERT INTO core.upgrade_migration (name, status, attempt, executed_by_version) VALUES ($1, 'completed', 2, '0.6.0')`, [step('Lock')]);
      });
      expect(await sqlstate(dup)).toBe('23505');
      // The 'upgrade' scope never works inside a tenant transaction, lock or not.
      expect(await sqlstate(tx(app, async () => { await tenant(app, ws.org); await scope(app, 'upgrade'); await record(app, step('Tenant')); }))).toBe('42501');
      // 'status' reads but never writes.
      expect(await sqlstate(tx(app, async () => { await scope(app, 'status'); await record(app, step('Status')); }))).toBe('42501');
    } finally {
      await app.query(`SELECT pg_advisory_unlock($1::bigint)`, [LOCK]);
    }
  });

  it("'workspace_init' writes is_initial rows only for a workspace of the bound organisation", async () => {
    // As markAsWorkspaceInitial does: the organisation bound by the tenant context, and rab.workspace_id bound to the new
    // workspace (core.manager_workspace's own RLS decides what the policy's organisation check can see).
    const init = (w: SeededWorkspace, org: string, isInitial = true) =>
      tx(app, async () => {
        await tenant(app, org);
        await app.query(`SELECT pg_catalog.set_config('rab.workspace_id', $1, true)`, [w.id]);
        await scope(app, 'workspace_init');
        await app.query(
          `INSERT INTO core.upgrade_migration (name, status, attempt, executed_by_version, is_initial, workspace_id) VALUES ($1, 'completed', 1, '0.6.0', $2, $3)`,
          [step('Ws'), isInitial, w.id],
        );
      });
    expect(await sqlstate(init(ws, ws.org))).toBe('ok');
    expect(await sqlstate(init(other, ws.org))).toBe('42501');
    expect(await sqlstate(init(other, other.org, false))).toBe('42501');
    expect(await sqlstate(init(other, other.org))).toBe('ok');
    expect(await sqlstate(init(ws, ws.org))).toBe('23505');
  });

  it('nobody may UPDATE or TRUNCATE it, the owner role included (42501)', async () => {
    expect(await sqlstate(tx(app, async () => { await scope(app, 'upgrade'); await app.query(`UPDATE core.upgrade_migration SET status = 'completed'`); }))).toBe('42501');
    expect(await sqlstate(app.query('TRUNCATE core.upgrade_migration'))).toBe('42501');
    expect(await sqlstate(tx(app, async () => { await app.query('SET LOCAL ROLE rab_secure_owner'); await app.query(`UPDATE core.upgrade_migration SET status = 'completed'`); }))).toBe('42501');
    expect(await sqlstate(tx(app, async () => { await app.query('SET LOCAL ROLE rab_secure_owner'); await app.query('TRUNCATE core.upgrade_migration'); }))).toBe('42501');
  });

  it('OWNER TEST: a direct DELETE as crewflow_owner, and after SET ROLE rab_secure_owner, removes 0 rows (every scope)', async () => {
    const before = await count('name LIKE $1', [`0.6.0_Itest%${SFX}`]);
    expect(before).toBeGreaterThanOrEqual(5);
    for (const s of ['', 'upgrade', 'status', 'workspace_init']) {
      const direct = await tx(app, async () => {
        await scope(app, s);
        if (s === 'workspace_init') {
          await tenant(app, ws.org);
          await app.query(`SELECT pg_catalog.set_config('rab.workspace_id', $1, true)`, [ws.id]);
        }
        return app.query('DELETE FROM core.upgrade_migration');
      });
      expect(direct.rowCount).toBe(0);
      const asOwner = await tx(app, async () => {
        await app.query('SET LOCAL ROLE rab_secure_owner');
        await scope(app, s);
        if (s === 'workspace_init') {
          await tenant(app, ws.org);
          await app.query(`SELECT pg_catalog.set_config('rab.workspace_id', $1, true)`, [ws.id]);
        }
        return app.query('DELETE FROM core.upgrade_migration');
      });
      expect(asOwner.rowCount).toBe(0);
    }
    expect(await count('name LIKE $1', [`0.6.0_Itest%${SFX}`])).toBe(before);
  });

  it('OWNER TEST: deleting a workspace removes exactly its rows (FK cascade); the instance rows and other workspaces stay', async () => {
    const instance = await count('name LIKE $1 AND workspace_id IS NULL', [`0.6.0_Itest%${SFX}`]);
    expect(instance).toBeGreaterThanOrEqual(3);
    expect(await count('workspace_id = $1', [ws.id])).toBe(1);
    expect(await count('workspace_id = $1', [other.id])).toBe(1);
    await admin.query('DELETE FROM core.manager_workspace WHERE id = $1', [ws.id]);
    expect(await count('workspace_id = $1', [ws.id])).toBe(0);
    expect(await count('workspace_id = $1', [other.id])).toBe(1);
    expect(await count('name LIKE $1 AND workspace_id IS NULL', [`0.6.0_Itest%${SFX}`])).toBe(instance);
  });
});
