import { Client } from 'pg';
import { DataSource } from 'typeorm';

import { MIGRATION_LOCK_KEY } from '../../database/typeorm/scripts/migrate/migration-lock';
import { integrationTestDatabase, integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';
import { SeededWorkspace, seedWorkspace } from './helpers/workspace-fixtures';
import { markNewWorkspaceInitial, upgradeSessionOf, UpgradeSessionError, versionStartedUnforced, withUpgradeScope } from '../../engine/core-modules/upgrade/upgrade-migration.service';
import { bindGucsSql } from '../../engine/core-modules/tenant/tenant-context.service';

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

// DEAD-07: the validated TEST pair decides (an invalid pair throws, never a silent skip).
const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;
const SFX = Math.random().toString(36).replace(/[^a-z]/g, '').slice(0, 8) || 'x';
const step = (n: string) => `0.6.0_Itest${n}${SFX}`;
const LOCK = MIGRATION_LOCK_KEY.toString();

describeIfDb('core.upgrade_migration (integration, OWNER-DB-ULTIMATE Part B)', () => {
  const { adminUrl, appUrl } = integrationTestDatabase();
  let admin: Client;
  let app: Client;
  let ws: SeededWorkspace;
  let other: SeededWorkspace;
  let third: SeededWorkspace;

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
    app = new Client({ connectionString: appUrl });
    await admin.connect();
    await app.connect();
    ws = await seedWorkspace(admin, `upgr-a-${SFX}`);
    other = await seedWorkspace(admin, `upgr-b-${SFX}`);
    third = await seedWorkspace(admin, `upgr-c-${SFX}`);
  });

  afterAll(async () => {
    await admin.query(`DELETE FROM core.upgrade_migration WHERE name LIKE $1`, [`0.6.0_Itest%${SFX}`]).catch(() => undefined);
    for (const w of [ws, other, third]) {
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

  it('L2(b): the tenant binding clears rab.upgrade_scope: status scope, then a tenant bound in the same transaction -> 0 rows', async () => {
    const seen = await tx(app, async () => {
      await scope(app, 'status');
      await app.query(bindGucsSql(), [ws.org, ws.id, ws.owner, 'CEO', 'user']);
      const s = (await app.query(`SELECT COALESCE(pg_catalog.current_setting('rab.upgrade_scope', true), '') AS s`)).rows[0].s;
      const n = Number((await app.query('SELECT pg_catalog.count(*)::int AS n FROM core.upgrade_migration')).rows[0].n);
      return { s, n };
    });
    expect(seen).toEqual({ s: '', n: 0 });
  });

  it('L3: markNewWorkspaceInitial clears the scope and restores rab.workspace_id; a failing INSERT surfaces its original error', async () => {
    const q = (sql: string, params?: unknown[]) => app.query(sql, params).then((r) => r.rows as unknown[]);
    const after = await tx(app, async () => {
      await tenant(app, third.org);
      await app.query(`SELECT pg_catalog.set_config('rab.workspace_id', $1, true)`, [ws.id]);
      const wrote = await markNewWorkspaceInitial(q, { id: third.id, organisationId: third.org });
      const row = (await app.query(
        `SELECT COALESCE(pg_catalog.current_setting('rab.upgrade_scope', true), '') AS s, pg_catalog.current_setting('rab.workspace_id', true) AS w`,
      )).rows[0];
      return { wrote, s: row.s, w: row.w };
    });
    expect(after).toEqual({ wrote: true, s: '', w: ws.id });
    expect(await count('workspace_id = $1 AND is_initial', [third.id])).toBe(1);
    // A lying entity (another organisation's workspace under the bound organisation): the policy refuses the INSERT and the
    // caller sees that original 42501, not 25P02 from a restore statement run on the aborted transaction.
    const err = await sqlstate(tx(app, async () => {
      await tenant(app, ws.org);
      await markNewWorkspaceInitial(q, { id: other.id, organisationId: ws.org });
    }));
    expect(err).toBe('42501');
  });

  it('withUpgradeScope accepts a FRESH autocommit session through the real drivers (node-pg Client and a TypeORM QueryRunner)', async () => {
    // Regression guard (ef7f56c0): a parameterised pre-check ran on the extended protocol and refused every real session.
    const viaClient = await withUpgradeScope(upgradeSessionOf(app), 'status', async (q) => (await q('SELECT 1 AS one')) as Array<{ one: number }>);
    expect(viaClient[0]?.one).toBe(1);
    const ds = new DataSource({ type: 'postgres', url: appUrl, entities: [], migrations: [], synchronize: false });
    await ds.initialize();
    const runner = ds.createQueryRunner();
    await runner.connect();
    try {
      const viaRunner = await withUpgradeScope(upgradeSessionOf(runner), 'status', async (q) => (await q('SELECT 2 AS two')) as Array<{ two: number }>);
      expect(viaRunner[0]?.two).toBe(2);
      // ... and the same QueryRunner inside BEGIN; SELECT 1 is refused.
      await runner.query('BEGIN');
      await runner.query('SELECT 1');
      await expect(withUpgradeScope(upgradeSessionOf(runner), 'status', async () => 'read')).rejects.toBeInstanceOf(UpgradeSessionError);
      await runner.query('ROLLBACK');
    } finally {
      await runner.release();
      await ds.destroy();
    }
  });

  it('R2: withUpgradeScope refuses a session inside an open read-only transaction, and leaves that transaction alone', async () => {
    await app.query('BEGIN');
    try {
      await app.query(`SELECT pg_catalog.set_config('rab.r2_marker', 'open', true)`);
      await app.query('SELECT 1');
      await expect(withUpgradeScope(upgradeSessionOf(app), 'status', async () => 'read')).rejects.toBeInstanceOf(UpgradeSessionError);
      // Still the caller's transaction (no COMMIT / ROLLBACK was issued for it): its transaction-local setting is there.
      expect((await app.query(`SELECT pg_catalog.current_setting('rab.r2_marker', true) AS v`)).rows[0].v).toBe('open');
    } finally {
      await app.query('ROLLBACK');
    }
    expect((await app.query(`SELECT COALESCE(pg_catalog.current_setting('rab.r2_marker', true), '') AS v`)).rows[0].v).toBe('');
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

  it('L1 review: versionStartedUnforced counts only an UNFORCED INSTANCE STEP row of the version (no workspace, is_initial or forced row)', async () => {
    // A version of its own (older than the code, so no other suite reads it as a rollback), removed again in finally.
    const v = `0.0.${100 + Math.floor(Math.random() * 800)}`;
    const name = (kind: string) => `${v}_Itest${kind}${SFX}`;
    const plant = (kind: string, row: { initial: boolean; workspace: string | null; forced: boolean; status?: string }) =>
      admin.query(
        `INSERT INTO core.upgrade_migration (name, status, attempt, executed_by_version, error_message, is_initial, workspace_id, forced)
         VALUES ($1, $2, 1, $3, CASE WHEN $2 = 'failed' THEN 'Error: planted' END, $4, $5::uuid, $6)`,
        [name(kind), row.status ?? 'completed', v, row.initial, row.workspace, row.forced],
      );
    const started = () => withUpgradeScope(upgradeSessionOf(app), 'status', (q) => versionStartedUnforced(q, v));
    try {
      expect(await started()).toBe(false);
      // What workspace creation writes (markNewWorkspaceInitial): a workspace is_initial row at the version.
      await plant('Wsinitial', { initial: true, workspace: other.id, forced: false });
      expect(await started()).toBe(false);
      await plant('Wsstep', { initial: false, workspace: other.id, forced: false });
      expect(await started()).toBe(false);
      // The one-time adoption row shape (instance is_initial).
      await plant('Instinitial', { initial: true, workspace: null, forced: false });
      expect(await started()).toBe(false);
      // A step only --force recorded (completed and failed).
      await plant('Forcedok', { initial: false, workspace: null, forced: true });
      await plant('Forcedfail', { initial: false, workspace: null, forced: true, status: 'failed' });
      expect(await started()).toBe(false);
      // Only now: an unforced instance step row (a failed attempt counts: the run passed the check before failing).
      await plant('Step', { initial: false, workspace: null, forced: false, status: 'failed' });
      expect(await started()).toBe(true);
    } finally {
      await admin.query('DELETE FROM core.upgrade_migration WHERE executed_by_version = $1', [v]);
    }
    expect(await count('executed_by_version = $1', [v])).toBe(0);
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
