import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

import { integrationTestDatabase, integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';
import { MIGRATION_LOCK_KEY } from '../../database/typeorm/scripts/migrate/migration-lock';
import { selectWorkspaceFingerprintsForServer, workspaceFingerprintMajor } from '../../database/typeorm/workspace-schema/v1/expected-fingerprints';
import { checkWorkspaceCoreOrphans, coreReferences } from '../../database/typeorm/workspace-schema/workspace-core-orphans';
import { WORKSPACE_UPGRADE_COMMANDS } from '../../engine/core-modules/upgrade/upgrade-commands/registry';
import { WORKSPACE_CORE_FK_REMOVAL } from '../../engine/core-modules/upgrade/upgrade-commands/0-6/workspace-core-fk-removal';
import type { WorkspaceUpgradeCommand } from '../../engine/core-modules/upgrade/upgrade-commands/workspace-upgrade-command';
import { upgradeSessionOf, UpgradeSession } from '../../engine/core-modules/upgrade/upgrade-migration.service';
import { WorkspaceCommandRunner, WorkspaceRunOptions } from '../../engine/core-modules/upgrade/workspace-command-runner';
import { codeWorkspaceStructureLevel, declaredFingerprint } from '../../engine/core-modules/upgrade/workspace-structure-level';
import { dropWorkspaceSchema, FROZEN_TEMPLATE_REGISTRY, provisionServerPath, provisionTypeScript, registryOf, SeededWorkspace, seedWorkspace } from './helpers/workspace-fixtures';

/**
 * OWNER-DB-ULTIMATE Part D, decision 0a (DRAFT SQL, throwaway databases only): `0.6.0_DropWorkspaceCoreForeignKeys_1786721530000`
 * (structure level 22) and WorkspaceCoreForeignKeyRemoval1786721530000. Proves:
 *  - the runner removes the 72 workspace → core."user" / core.organisation / core.manager_workspace foreign keys from existing
 *    workspaces (level 22, declared v2), idempotently; new workspaces (both provisioners) are built without them, identical;
 *  - THE LOCK TEST: deleting and key-updating a core user takes NO lock on any workspace table at level 22 (and, as the control,
 *    takes ~31 relation locks per workspace at level 21);
 *  - the orphan check reports (counts only) a row left pointing at a deleted core user, and nothing on a clean workspace;
 *  - the other FKs (inside the schema, to core.stored_file / manager_profile / payroll_calendar_period) are untouched.
 */
jest.setTimeout(600_000);

const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;
const SFX = Math.random().toString(36).replace(/[^a-z]/g, '').slice(0, 6) || 'x';
const LOCK = MIGRATION_LOCK_KEY.toString();
const FK_STEP = `0.6.0_${WORKSPACE_CORE_FK_REMOVAL.name}_${WORKSPACE_CORE_FK_REMOVAL.timestamp}`;
const W = 12;
/** The registry through level 22 (0a): later structural commands (C3 Q3's level 23) are proven by their own spec. */
const L22 = { '0-6': [...(WORKSPACE_UPGRADE_COMMANDS['0-6'] ?? [])] };

describeIfDb('Part D 0a: workspace → core foreign keys removed (integration, throwaway database)', () => {
  const { adminUrl, appUrl } = RUN ? integrationTestDatabase() : ({} as never);
  let admin: Client;
  let app: Client;
  let session: UpgradeSession;
  const created: SeededWorkspace[] = [];
  let seq = 0;

  const make = async (n: string, how: 'frozen' | 'level21' | 'ts' | 'sql' = 'frozen', org?: SeededWorkspace): Promise<SeededWorkspace> => {
    seq += 1;
    let ws: SeededWorkspace;
    if (org) {
      const owner = (await admin.query(`INSERT INTO core."user"(organisation_id, email, first_name, last_name, status) VALUES ($1, $2, 'O', 'W', 'active') RETURNING id`, [org.org, `fk-${randomUUID().slice(0, 8)}@ws0a.invalid`])).rows[0].id;
      const r = (await admin.query(
        `INSERT INTO core.manager_workspace(organisation_id, owner_user_id, name, subdomain, status, schema_status) VALUES ($1, $2, $3::text, $3::text, 'active', 'CREATING') RETURNING id`,
        [org.org, owner, `ws0a-${n}-${SFX}-${seq}`],
      )).rows[0];
      ws = { id: r.id, org: org.org, owner, schema: `workspace_${String(r.id).replace(/-/g, '')}`, label: n };
    } else {
      ws = await seedWorkspace(admin, `ws0a-${n}-${SFX}-${seq}`);
    }
    created.push(ws);
    const level21 = { '0-6': (WORKSPACE_UPGRADE_COMMANDS['0-6'] ?? []).filter((c) => (c.structure?.level ?? 0) <= 21) };
    if (how === 'frozen') expect(await provisionTypeScript(adminUrl, ws, { workspaceRegistry: FROZEN_TEMPLATE_REGISTRY })).toBe('READY');
    if (how === 'level21') expect(await provisionTypeScript(adminUrl, ws, { workspaceRegistry: level21 })).toBe('READY');
    if (how === 'ts') expect(await provisionTypeScript(adminUrl, ws, { workspaceRegistry: L22 })).toBe('READY');
    if (how === 'sql') expect(await provisionServerPath(appUrl, ws)).toBe('READY');
    return ws;
  };
  const coreFks = async (ws: SeededWorkspace) =>
    Number(
      (
        await admin.query(
          `SELECT count(*)::int AS n FROM pg_constraint k JOIN pg_namespace s ON s.oid = k.connamespace
            WHERE s.nspname = $1 AND k.contype = 'f' AND k.confrelid IN ('core."user"'::regclass, 'core.organisation'::regclass, 'core.manager_workspace'::regclass)`,
          [ws.schema],
        )
      ).rows[0].n,
    );
  const allFks = async (ws: SeededWorkspace) =>
    Number((await admin.query(`SELECT count(*)::int AS n FROM pg_constraint k JOIN pg_namespace s ON s.oid = k.connamespace WHERE s.nspname = $1 AND k.contype = 'f'`, [ws.schema])).rows[0].n);
  const fp = async (ws: SeededWorkspace) => (await admin.query('SELECT core.workspace_schema_fingerprint($1) AS v1, core.workspace_schema_fingerprint_v2($1) AS v2', [ws.id])).rows[0];
  const runner = (o: Partial<WorkspaceRunOptions> & Pick<WorkspaceRunOptions, 'workspaceIds'>) =>
    new WorkspaceCommandRunner({ codeVersion: '0.6.0', versions: ['0.4.0', '0.5.0'], force: false, adopt: true, log: () => undefined, workspaceRegistry: L22, ...o }).run(session);

  /** Relation locks held on workspace_* tables by a transaction that deletes / key-updates a core user (rolled back). */
  const workspaceLocksOf = async (sql: string, params: unknown[], schemas: string[]): Promise<number> => {
    const c = new Client({ connectionString: adminUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query(sql, params);
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM pg_locks l JOIN pg_class r ON r.oid = l.relation JOIN pg_namespace s ON s.oid = r.relnamespace
          WHERE l.pid = pg_backend_pid() AND l.locktype = 'relation' AND s.nspname = ANY ($1::text[])`,
        [schemas],
      );
      return Number(rows[0].n);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
  };

  beforeAll(async () => {
    admin = new Client({ connectionString: adminUrl });
    app = new Client({ connectionString: appUrl });
    await admin.connect();
    await app.connect();
    await selectWorkspaceFingerprintsForServer(async (sql) => (await admin.query(sql)).rows);
    await app.query('SELECT pg_advisory_lock($1::bigint)', [LOCK]);
    session = upgradeSessionOf(app);
  });

  afterAll(async () => {
    await app?.query('SELECT pg_advisory_unlock($1::bigint)', [LOCK]).catch(() => undefined);
    for (const ws of created) {
      await admin.query('DELETE FROM core.upgrade_migration WHERE workspace_id = $1', [ws.id]).catch(() => undefined);
      await dropWorkspaceSchema(admin, ws.schema).catch(() => undefined);
      await admin.query(`UPDATE core.workspace_schema_registry SET status = 'FAILED', module_version = LEAST(module_version, 20) WHERE workspace_id = $1`, [ws.id]).catch(() => undefined);
    }
    await app?.end();
    await admin?.end();
  });

  it('the reference list is exactly the 72 constraints of the frozen template (31 user, 21 organisation, 20 workspace)', async () => {
    expect(codeWorkspaceStructureLevel()).toBeGreaterThanOrEqual(22);
    const refs = coreReferences();
    expect(refs).toHaveLength(72);
    expect(refs.filter((r) => r.target === 'core."user"')).toHaveLength(31);
    expect(refs.filter((r) => r.target === 'core.organisation')).toHaveLength(21);
    expect(refs.filter((r) => r.target === 'core.manager_workspace')).toHaveLength(20);
    const w = await make('list', 'frozen');
    expect(await coreFks(w)).toBe(72);
    expect(await allFks(w)).toBe(128);
  });

  it('existing workspaces: the runner drops the 72 (level 22, declared v2), keeps the other 56, idempotently; new workspaces match', async () => {
    const [a, b] = [await make('ex-a'), await make('ex-b')];
    const out = await runner({ workspaceIds: [a.id, b.id] });
    expect(out.failures).toEqual([]);
    for (const w of [a, b]) {
      expect(out.outcomes.find((o) => o.workspaceId === w.id)!.completed).toContain(FK_STEP);
      expect(await coreFks(w)).toBe(0);
      expect(await allFks(w)).toBe(56);
      expect((await registryOf(admin, w.id)).module_version).toBe(22);
      expect((await fp(w)).v2).toBe(declaredFingerprint(22, workspaceFingerprintMajor()));
    }
    expect((await runner({ workspaceIds: [a.id, b.id] })).outcomes.map((o) => o.status)).toEqual(['up-to-date', 'up-to-date']);
    const [ts, sql] = [await make('nw-ts', 'ts'), await make('nw-sql', 'sql')];
    // core.provision_workspace builds THIS code's level: compared with the upgraded one only while that is 22.
    expect(await coreFks(sql)).toBe(0);
    expect((await registryOf(admin, sql.id)).module_version).toBe(codeWorkspaceStructureLevel());
    for (const w of codeWorkspaceStructureLevel() === 22 ? [ts, sql] : [ts]) {
      expect(await coreFks(w)).toBe(0);
      expect((await registryOf(admin, w.id)).module_version).toBe(22);
      expect(await fp(w)).toEqual(await fp(a));
    }
  });

  it('LOCK TEST: deleting / key-updating a core user takes no workspace-table lock at level 22; at level 21 it locks every referencing table of every workspace', async () => {
    const base = await make('lk-base', 'frozen');
    const old: SeededWorkspace[] = [];
    for (let i = 0; i < W; i += 1) old.push(await make(`lk21-${i}`, 'level21', base));
    // Workspaces created while level 21 was the code's level carry that release's creation cursor (Part B is_initial).
    const L21_STEP = `0.6.0_${(WORKSPACE_UPGRADE_COMMANDS['0-6'] ?? [])[0]!.name}_${(WORKSPACE_UPGRADE_COMMANDS['0-6'] ?? [])[0]!.timestamp}`;
    for (const w of old) {
      await admin.query(`INSERT INTO core.upgrade_migration (name, status, attempt, executed_by_version, is_initial, workspace_id) VALUES ($1, 'completed', 1, '0.6.0', true, $2)`, [L21_STEP, w.id]);
    }
    const fresh: SeededWorkspace[] = [];
    for (let i = 0; i < W; i += 1) fresh.push(await make(`lk22-${i}`, 'ts', base));
    const victim = (await admin.query(`INSERT INTO core."user"(organisation_id, email, first_name, last_name, status) VALUES ($1, $2, 'V', 'Ictim', 'active') RETURNING id`, [base.org, `victim-${SFX}@ws0a.invalid`])).rows[0].id as string;
    const del = `DELETE FROM core."user" WHERE id = $1`;
    const upd = `UPDATE core."user" SET id = $2 WHERE id = $1`;
    // Control: with W level-21 workspaces in the database the RI checks lock 31 tables in each of them (+ the level-20 base).
    const mine = [base, ...old, ...fresh].map((w) => w.schema);
    const before = await workspaceLocksOf(del, [victim], mine);
    expect(before).toBeGreaterThanOrEqual(31 * W);
    // Bring the level-21 ones to 22 (the runner, as the locked start does): now no workspace still has a reference.
    expect((await runner({ workspaceIds: [base.id, ...old.map((w) => w.id)] })).failures).toEqual([]);
    const after = await workspaceLocksOf(del, [victim], mine);
    const afterUpd = await workspaceLocksOf(upd, [victim, randomUUID()], mine);
    // eslint-disable-next-line no-console
    console.log(`[ws0a-lock] workspace-table locks for one core user DELETE: ${before} with ${W + 1} workspaces at level <= 21, ${after} with ${2 * W + 1} at level 22 (key UPDATE: ${afterUpd})`);
    expect(after).toBe(0);
    expect(afterUpd).toBe(0);
    expect(fresh.length).toBe(W);
  });

  it('the orphan check reports a row left pointing at a deleted core user (counts only), and nothing on a clean workspace', async () => {
    const w = await make('orph', 'ts');
    const clean = await make('orph-clean', 'ts');
    const u = (await admin.query(`INSERT INTO core."user"(organisation_id, email, first_name, last_name, status) VALUES ($1, $2, 'S', 'Taff', 'active') RETURNING id`, [w.org, `orph-${SFX}@ws0a.invalid`])).rows[0].id;
    await admin.query(`INSERT INTO ${w.schema}.staff_profile (organisation_id, user_id, staff_ref, workspace_id, created_by) VALUES ($1, $2, $3, $4, $2)`, [w.org, u, `WS0A-${SFX}`, w.id]);
    // The core delete succeeds now (no FK refuses or cascades): the workspace row is left behind as an orphan.
    await admin.query(`DELETE FROM core."user" WHERE id = $1`, [u]);
    const c = new Client({ connectionString: adminUrl });
    await c.connect();
    try {
      await c.query('SET ROLE crewflow');
      const r = await checkWorkspaceCoreOrphans(c, [w.id, clean.id]);
      expect(r.errors.filter((e) => [w.id, clean.id].includes(e.workspaceId))).toEqual([]);
      const mine = r.findings.filter((f) => f.workspaceId === w.id).map((f) => [f.table, f.column, f.target, f.rows]).sort();
      expect(mine).toEqual([
        ['staff_profile', 'created_by', 'core."user"', 1],
        ['staff_profile', 'user_id', 'core."user"', 1],
      ]);
      expect(r.findings.filter((f) => f.workspaceId === clean.id)).toEqual([]);
    } finally {
      await c.end();
    }
  });

  it('the command declares mayDrop and only drops the 72 constraints (structure check passes, no other object changes)', async () => {
    expect(WORKSPACE_CORE_FK_REMOVAL.structure).toMatchObject({ level: 22, mayDrop: true });
    const sql = WORKSPACE_CORE_FK_REMOVAL.sql!('workspace_00000000000000000000000000000000');
    expect(sql.match(/DROP CONSTRAINT IF EXISTS/g)).toHaveLength(72);
    expect(sql).not.toMatch(/\b(CREATE|GRANT|REVOKE|POLICY|DROP TABLE|DROP INDEX|TRIGGER)\b/);
    const cmds: WorkspaceUpgradeCommand[] = [...(WORKSPACE_UPGRADE_COMMANDS['0-6'] ?? [])];
    expect(cmds.map((c) => c.structure?.level)).toEqual([21, 22]);
  });
});
