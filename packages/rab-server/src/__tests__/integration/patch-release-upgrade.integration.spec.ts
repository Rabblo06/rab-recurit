import 'reflect-metadata';
import { Client } from 'pg';

import { integrationTestDatabase, integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';
import { MIGRATION_LOCK_KEY } from '../../database/typeorm/scripts/migrate/migration-lock';
import { selectWorkspaceFingerprintsForServer } from '../../database/typeorm/workspace-schema/v1/expected-fingerprints';
import type { UpgradeCommand } from '../../engine/core-modules/upgrade/upgrade-commands/upgrade-command';
import type { WorkspaceUpgradeCommand } from '../../engine/core-modules/upgrade/upgrade-commands/workspace-upgrade-command';
import { UPGRADE_COMMANDS, WORKSPACE_UPGRADE_COMMANDS } from '../../engine/core-modules/upgrade/upgrade-commands/registry';
import { upgradeSessionOf, UpgradeSession } from '../../engine/core-modules/upgrade/upgrade-migration.service';
import { PatchReleaseCommandsError } from '../../engine/core-modules/upgrade/upgrade-registry-key';
import { UpgradeRun } from '../../engine/core-modules/upgrade/upgrade-runner';
import { lastStepOfVersion } from '../../engine/core-modules/upgrade/upgrade-sequence';
import { readUpgradeStatus } from '../../engine/core-modules/upgrade/upgrade-status.service';
import { UpgradeVersionTooOldError } from '../../engine/core-modules/upgrade/upgrade-version-check';
import { WorkspaceCommandRunner } from '../../engine/core-modules/upgrade/workspace-command-runner';
import { codeWorkspaceStructureLevel } from '../../engine/core-modules/upgrade/workspace-structure-level';
import { dropWorkspaceSchema, FROZEN_TEMPLATE_REGISTRY, provisionTypeScript, registryOf, SeededWorkspace, seedWorkspace } from './helpers/workspace-fixtures';

/**
 * Patch releases (e.g. 0.6.1) through the upgrade runner on a real (disposable) database: UpgradeRun's beforeApply / afterApply
 * on the one runtime login holding the migration lock, exactly as the migrate-on-start child calls them. The image version
 * comes from the root package.json (0.6.0 on this branch; 0.6.1 is not registered), so the code version and the published
 * list are passed explicitly (`codeVersion` / `previousVersions`, the same options the start path fills from
 * readAppVersion() and CREWFLOW_PREVIOUS_VERSIONS).
 *
 * A patch release carries no upgrade command, no workspace command and no structure level: 0.6.0's three workspace
 * commands are never re-listed as 0.6.1_… (closed draft PR #216: that made every 0.6.1 start exit 66). Proves, in order (the
 * cases share the workspaces and the instance logbook):
 *   1. 0.6.0 → 0.6.1 with 0 workspaces: continue from 0.6.0, one instance row (0.6.1_TypeOrmMigrations), a repeat records nothing;
 *   2. 0.6.0 → 0.6.1 with N workspaces that finished 0.6.0: no workspace step, no workspace row, level and block unchanged;
 *      /healthz behind before, ok after;
 *   3. a workspace created on 0.6.1 (fresh-install cursor 0.6.1_TypeOrmMigrations, current template) has nothing pending;
 *   4. downgrade 0.6.1 → 0.6.0: today's image-rollback rule (decision rollback, nothing recorded, no workspace pass), also
 *      under --force; /healthz "ahead";
 *   5. 0.6.1 → 0.7.0 still runs the 0.7 instance command and, per workspace, the 0.7 workspace command;
 *   6. a registry with a patch key refuses before anything is written (PatchReleaseCommandsError);
 *   7. abuse: a patch cannot skip an incomplete 0.6.0 (a READY workspace that never finished it): 65, nothing written.
 * Self-sufficient (shards share one database; an earlier spec file may have changed the instance logbook): beforeAll SEEDS
 * the state the cases need (a completed `0.6.0_TypeOrmMigrations` instance row, added only when its latest attempt is not
 * completed) and verifies that no instance row is newer than 0.6.0 (its own 0.6.1 / 0.7.0 rows are removed first). afterAll
 * removes exactly the rows it seeded, every row and workspace written here, and the 0.6.1 / 0.7.0 instance rows (also when a
 * case fails), so later spec files see the logbook as it was. /healthz-state assertions allow for workspace issues another
 * spec file left behind (they turn behind / ok into failed, as the real status would); none may be one of this file's.
 */
jest.setTimeout(300_000);

const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;
const SFX = Math.random().toString(36).replace(/[^a-z]/g, '').slice(0, 6) || 'x';
const LOCK = MIGRATION_LOCK_KEY.toString();
const T0 = 1786950000000;
const PREV_061 = ['0.4.0', '0.5.0', '0.6.0'];
const PREV_070 = [...PREV_061, '0.6.1'];
/** This code's real 0.6.0 workspace steps (an adopted workspace runs them right after its is_initial row). */
const REAL = (WORKSPACE_UPGRADE_COMMANDS['0-6'] ?? []).map((c) => `0.6.0_${c.name}_${c.timestamp}`);
/**
 * The 0.6 line's workspace registry: this code's registry without the 0.7 release's commands. A 0.6.x image never knows
 * 0.7.0's structural workspace commands (level 23+), so the 0.6.0 / 0.6.1 runs, the "current template" workspace and LEVEL
 * use this; the 0.7.0 cases pass their own registries.
 */
const W06: Record<string, readonly WorkspaceUpgradeCommand[]> = Object.fromEntries(Object.entries(WORKSPACE_UPGRADE_COMMANDS).filter(([key]) => key !== '0-7'));
const LEVEL = codeWorkspaceStructureLevel(W06);

describeIfDb('patch releases through the upgrade runner (integration)', () => {
  const { adminUrl, appUrl } = RUN ? integrationTestDatabase() : ({} as never);
  let admin: Client;
  let app: Client;
  let session: UpgradeSession;
  const created: SeededWorkspace[] = [];
  const lines: string[] = [];
  const done: SeededWorkspace[] = [];
  let fresh: SeededWorkspace;
  let seq = 0;
  /** Instance rows this file seeded in beforeAll (removed in afterAll by id). */
  const seeded: string[] = [];

  const make = async (n: string, provision: 'frozen' | 'current' = 'frozen'): Promise<SeededWorkspace> => {
    seq += 1;
    const ws = await seedWorkspace(admin, `pr-${n}-${SFX}-${String.fromCharCode(97 + seq)}`);
    created.push(ws);
    expect(await provisionTypeScript(adminUrl, ws, provision === 'frozen' ? { workspaceRegistry: FROZEN_TEMPLATE_REGISTRY } : { workspaceRegistry: W06 })).toBe('READY');
    return ws;
  };
  const rows = async (ws: SeededWorkspace) =>
    (
      await admin.query(
        `SELECT name, status, attempt, is_initial, forced, executed_by_version FROM core.upgrade_migration WHERE workspace_id = $1 ORDER BY created_at, attempt`,
        [ws.id],
      )
    ).rows as Array<{ name: string; status: string; attempt: number; is_initial: boolean; forced: boolean; executed_by_version: string }>;
  const instanceRows = async (version: string) =>
    (
      await admin.query(`SELECT name, status, attempt, forced FROM core.upgrade_migration WHERE workspace_id IS NULL AND executed_by_version = $1 ORDER BY created_at, attempt`, [
        version,
      ])
    ).rows.map((r: { name: string; status: string; attempt: number; forced: boolean }) => [r.name, r.status, r.attempt, r.forced]);
  const allRowCount = async () => Number((await admin.query('SELECT count(*)::int AS n FROM core.upgrade_migration')).rows[0].n);
  const dropNewerInstanceRows = () =>
    admin.query(`DELETE FROM core.upgrade_migration WHERE workspace_id IS NULL AND executed_by_version IN ('0.6.1', '0.7.0') AND (name LIKE '0.6.1\\_%' OR name LIKE '0.7.0\\_%')`);
  const status = async (version: string) => {
    const c = new Client({ connectionString: appUrl });
    await c.connect();
    try {
      return await readUpgradeStatus(upgradeSessionOf(c), version);
    } finally {
      await c.end();
    }
  };
  /**
   * The status of `version`, asserting `want` for this file's state. A workspace issue another spec file left on the shared
   * database (a failed cursor, a READY workspace without a row) turns behind / ok into failed, exactly as /healthz would;
   * none of the issues may be one of this file's workspaces.
   */
  const expectStatus = async (version: string, want: 'behind' | 'ok' | 'ahead') => {
    const s = await status(version);
    const mine = (s.workspaces ?? []).filter((w) => created.some((c) => c.id === w.workspaceId));
    expect(mine).toEqual([]);
    const foreign = (s.workspaces ?? []).length > 0;
    expect(s.state).toBe(foreign && want !== 'ahead' ? 'failed' : want);
    return s;
  };
  const run061 = (ids: string[], over: Partial<ConstructorParameters<typeof UpgradeRun>[0]> = {}) =>
    new UpgradeRun({ codeVersion: '0.6.1', previousVersions: PREV_061, force: false, log: (l) => lines.push(l), workspaceRegistry: W06, workspaceRunner: { workspaceIds: ids }, ...over });
  const start = async (run: UpgradeRun, fresh = false) => {
    const decision = await run.beforeApply(session, { fresh, attribution: null, unrestrictedTarget: true });
    await run.afterApply(session);
    return decision;
  };
  /** Adoption on 0.6.0 + this code's real 0.6.0 workspace commands: the workspace has finished 0.6.0 (level LEVEL). */
  const finish060 = (ids: string[]) =>
    new WorkspaceCommandRunner({ codeVersion: '0.6.0', versions: ['0.4.0', '0.5.0'], force: false, adopt: true, log: (l) => lines.push(l), workspaceRegistry: W06, workspaceIds: ids }).run(session);

  beforeAll(async () => {
    admin = new Client({ connectionString: adminUrl });
    app = new Client({ connectionString: appUrl });
    await admin.connect();
    await app.connect();
    await selectWorkspaceFingerprintsForServer(async (sql) => (await admin.query(sql)).rows);
    await app.query('SELECT pg_advisory_lock($1::bigint)', [LOCK]);
    session = upgradeSessionOf(app);
    await dropNewerInstanceRows();
    // Seed: the database is a completed 0.6.0 (what a fresh 0.6.0 install records), whatever an earlier spec file left.
    const [latest] = (
      await admin.query(`SELECT status, attempt FROM core.upgrade_migration WHERE name = '0.6.0_TypeOrmMigrations' AND workspace_id IS NULL ORDER BY attempt DESC LIMIT 1`)
    ).rows as Array<{ status: string; attempt: number }>;
    if (latest?.status !== 'completed') {
      const r = await admin.query(
        `INSERT INTO core.upgrade_migration (name, status, attempt, executed_by_version, is_initial) VALUES ('0.6.0_TypeOrmMigrations', 'completed', $1, '0.6.0', false) RETURNING id`,
        [(latest?.attempt ?? 0) + 1],
      );
      seeded.push(String(r.rows[0].id));
    }
  });

  afterAll(async () => {
    await dropNewerInstanceRows().catch(() => undefined);
    for (const id of seeded) await admin.query('DELETE FROM core.upgrade_migration WHERE id = $1', [id]).catch(() => undefined);
    await app?.query('SELECT pg_advisory_unlock($1::bigint)', [LOCK]).catch(() => undefined);
    for (const ws of created) {
      await admin.query('DELETE FROM core.upgrade_migration WHERE workspace_id = $1', [ws.id]).catch(() => undefined);
      await dropWorkspaceSchema(admin, ws.schema).catch(() => undefined);
      await admin.query(`UPDATE core.workspace_schema_registry SET status = 'FAILED', module_version = LEAST(module_version, 20) WHERE workspace_id = $1`, [ws.id]).catch(() => undefined);
      await admin.query('DELETE FROM core.manager_workspace WHERE id = $1', [ws.id]).catch(() => undefined);
    }
    await app?.end();
    await admin?.end();
  });

  it('precondition: the database is a completed 0.6.0 with no newer instance row', async () => {
    expect((await admin.query(`SELECT status FROM core.upgrade_migration WHERE name = '0.6.0_TypeOrmMigrations' AND workspace_id IS NULL ORDER BY attempt DESC LIMIT 1`)).rows[0]?.status).toBe(
      'completed',
    );
    const versions = (await admin.query('SELECT DISTINCT executed_by_version AS v FROM core.upgrade_migration WHERE workspace_id IS NULL')).rows.map((r: { v: string }) => r.v);
    expect(versions.filter((v: string) => !['0.4.0', '0.5.0', '0.6.0'].includes(v))).toEqual([]);
  });

  it('1. 0.6.0 → 0.6.1 with 0 workspaces: continue from 0.6.0; ONE instance row 0.6.1_TypeOrmMigrations; a repeat start records nothing', async () => {
    try {
      const first = run061([]);
      expect(await start(first)).toMatchObject({ kind: 'continue', from: '0.6.0' });
      expect(first.report).toMatchObject({
        codeVersion: '0.6.1',
        recorded: [{ name: '0.6.1_TypeOrmMigrations', status: 'completed', attempt: 1 }],
        commandFailure: null,
        workspaces: { total: 0, adopted: 0, upgraded: 0, failures: [], blocked: [] },
      });
      expect(await instanceRows('0.6.1')).toEqual([['0.6.1_TypeOrmMigrations', 'completed', 1, false]]);

      // A repeated start: still `continue` (the accepted previous version is checked first), and nothing is recorded.
      const again = run061([]);
      expect(await start(again)).toMatchObject({ kind: 'continue' });
      expect(again.report.recorded).toEqual([]);
      expect(await instanceRows('0.6.1')).toHaveLength(1);
    } finally {
      await dropNewerInstanceRows(); // back to a database at 0.6.0 for the N-workspace case
    }
  });

  it('2. 0.6.0 → 0.6.1 with N workspaces that finished 0.6.0: nothing pending, no workspace row, level and block unchanged; /healthz behind → ok', async () => {
    done.push(await make('w1'), await make('w2'), await make('w3'));
    const ids = done.map((w) => w.id);
    const at060 = await finish060(ids);
    expect(at060.failures).toEqual([]);
    const before = new Map<string, unknown>();
    for (const w of done) {
      const r = await rows(w);
      expect(r.map((x) => x.name)).toEqual(['0.6.0_TypeOrmMigrations', ...REAL]);
      expect((await registryOf(admin, w.id)).module_version).toBe(LEVEL);
      before.set(w.id, r);
    }
    await expectStatus('0.6.1', 'behind');

    const run = run061(ids);
    expect(await start(run)).toMatchObject({ kind: 'continue', from: '0.6.0' });
    expect(run.report).toMatchObject({
      recorded: [{ name: '0.6.1_TypeOrmMigrations', status: 'completed', attempt: 1 }],
      commandFailure: null,
      workspaces: { total: 3, adopted: 0, upgraded: 0, failures: [], blocked: [] },
    });
    for (const w of done) {
      expect(await rows(w)).toEqual(before.get(w.id));
      const reg = await registryOf(admin, w.id);
      expect([reg.module_version, reg.migration_error]).toEqual([LEVEL, null]);
    }
    expect(Number((await admin.query(`SELECT count(*)::int AS n FROM core.upgrade_migration WHERE workspace_id = ANY($1::uuid[]) AND executed_by_version = '0.6.1'`, [ids])).rows[0].n)).toBe(0);
    expect(lines.some((l) => /structure level/.test(l))).toBe(false);
    expect(await expectStatus('0.6.1', 'ok')).toMatchObject({ step: '0.6.1_TypeOrmMigrations', executedByVersion: '0.6.1', attempt: 1, forced: false });
  });

  it('3. fresh-install cursor on 0.6.1: a workspace created on 0.6.1 (current template, is_initial 0.6.1_TypeOrmMigrations) has nothing pending', async () => {
    fresh = await make('new061', 'current');
    expect((await registryOf(admin, fresh.id)).module_version).toBe(LEVEL);
    // What markNewWorkspaceInitial writes on a 0.6.1 image: the code version's last step (its migrations step), completed.
    const initial = lastStepOfVersion('0.6.1');
    expect(initial).toBe('0.6.1_TypeOrmMigrations');
    await admin.query(`INSERT INTO core.upgrade_migration (name, status, attempt, executed_by_version, is_initial, workspace_id) VALUES ($1, 'completed', 1, '0.6.1', true, $2)`, [
      initial,
      fresh.id,
    ]);
    // A fresh-install decision on 0.6.1 (no previous-version check), then the workspace pass over every workspace.
    const run = run061([fresh.id, ...done.map((w) => w.id)]);
    expect((await start(run, true)).kind).toBe('fresh');
    expect(run.report.recorded).toEqual([]); // 0.6.1_TypeOrmMigrations is already complete
    expect(run.report.workspaces).toMatchObject({ total: 4, adopted: 0, upgraded: 0, failures: [], blocked: [] });
    expect((await rows(fresh)).map((r) => [r.name, r.status, r.is_initial])).toEqual([['0.6.1_TypeOrmMigrations', 'completed', true]]);
    expect((await registryOf(admin, fresh.id)).migration_error).toBeNull();
  });

  it("4. downgrade 0.6.1 → 0.6.0: today's image-rollback rule — nothing recorded, no workspace pass, also under --force; /healthz ahead", async () => {
    const ids = [fresh.id, ...done.map((w) => w.id)];
    const count = await allRowCount();
    for (const force of [false, true]) {
      // The 0.6.0 image as published: its own previous-versions list (CREWFLOW_PREVIOUS_VERSIONS gained 0.6.0 with 0.7.0).
      const run = new UpgradeRun({ codeVersion: '0.6.0', previousVersions: ['0.4.0', '0.5.0'], force, log: (l) => lines.push(l), workspaceRegistry: W06, workspaceRunner: { workspaceIds: ids } });
      const decision = await start(run);
      expect(decision).toMatchObject({ kind: 'rollback' });
      expect((decision as { newer: string[] }).newer).toContain('0.6.1');
      expect(run.report).toMatchObject({ recorded: [], workspaces: null, commandFailure: null });
    }
    expect(await allRowCount()).toBe(count);
    await expectStatus('0.6.0', 'ahead');
  });

  it('5. 0.6.1 → 0.7.0 still runs the 0.7 commands: the instance command once, the workspace command once per workspace', async () => {
    const ids = [fresh.id, ...done.map((w) => w.id)];
    let instanceRuns = 0;
    const touched: string[] = [];
    const instance: UpgradeCommand = { name: 'PatchSpecInstance', timestamp: T0, run: async () => void (instanceRuns += 1) };
    const workspace: WorkspaceUpgradeCommand = {
      kind: 'workspace',
      name: 'PatchSpecData',
      timestamp: T0 + 1,
      run: async ({ query, schemaName, workspaceId }) => {
        await query(`SELECT count(*) FROM ${schemaName}.venue`);
        touched.push(workspaceId);
      },
    };
    try {
      const run = new UpgradeRun({
        codeVersion: '0.7.0',
        previousVersions: PREV_070,
        force: false,
        log: (l) => lines.push(l),
        registry: { ...UPGRADE_COMMANDS, '0-7': [instance] },
        workspaceRegistry: { ...WORKSPACE_UPGRADE_COMMANDS, '0-7': [workspace] },
        workspaceRunner: { workspaceIds: ids },
      });
      expect(await start(run)).toMatchObject({ kind: 'continue', from: '0.6.1' });
      expect(run.report.recorded).toEqual([
        { name: '0.7.0_TypeOrmMigrations', status: 'completed', attempt: 1 },
        { name: `0.7.0_PatchSpecInstance_${T0}`, status: 'completed', attempt: 1 },
      ]);
      expect(instanceRuns).toBe(1);
      expect(run.report.workspaces).toMatchObject({ total: 4, upgraded: 4, failures: [], blocked: [] });
      expect([...touched].sort()).toEqual([...ids].sort());
      for (const w of [fresh, ...done]) {
        expect((await rows(w)).slice(-1)[0]).toMatchObject({ name: `0.7.0_PatchSpecData_${T0 + 1}`, status: 'completed', attempt: 1, executed_by_version: '0.7.0' });
      }
    } finally {
      await admin.query(`DELETE FROM core.upgrade_migration WHERE workspace_id IS NULL AND executed_by_version = '0.7.0' AND name LIKE '0.7.0\\_%'`);
    }
  });

  it('6. a registry with commands for a patch key refuses before anything is written, fresh start included (PatchReleaseCommandsError)', async () => {
    const count = await allRowCount();
    const data: WorkspaceUpgradeCommand = { kind: 'workspace', name: 'PatchKey', timestamp: T0 + 2, run: async () => undefined };
    const viaWorkspace = run061([done[0]!.id], { workspaceRegistry: { ...WORKSPACE_UPGRADE_COMMANDS, '0-6-1': [data] } });
    await expect(viaWorkspace.beforeApply(session, { fresh: false, attribution: null, unrestrictedTarget: true })).rejects.toBeInstanceOf(PatchReleaseCommandsError);
    const viaInstance = run061([done[0]!.id], { registry: { ...UPGRADE_COMMANDS, '0-6-1': [{ name: 'PatchKey', timestamp: T0 + 2, run: async () => undefined }] } });
    await expect(viaInstance.beforeApply(session, { fresh: false, attribution: null, unrestrictedTarget: true })).rejects.toBeInstanceOf(PatchReleaseCommandsError);
    // L-1: also on a fresh-install start (the check is the first thing beforeApply does, before any read or migration).
    const viaFresh = run061([done[0]!.id], { workspaceRegistry: { ...WORKSPACE_UPGRADE_COMMANDS, '0-6-1': [data] } });
    await expect(viaFresh.beforeApply(session, { fresh: true, attribution: null, unrestrictedTarget: true })).rejects.toBeInstanceOf(PatchReleaseCommandsError);
    await expect(
      new WorkspaceCommandRunner({
        codeVersion: '0.6.1',
        versions: PREV_061,
        force: false,
        adopt: false,
        log: (l) => lines.push(l),
        workspaceIds: [done[0]!.id],
        workspaceRegistry: { ...WORKSPACE_UPGRADE_COMMANDS, '0-6-1': [data] },
      }).run(session),
    ).rejects.toBeInstanceOf(PatchReleaseCommandsError);
    expect(await allRowCount()).toBe(count);
  });

  it('7. abuse: a patch cannot skip an incomplete 0.6.0 — a READY workspace that never finished it refuses 0.6.1 with 65, nothing written', async () => {
    await dropNewerInstanceRows(); // the database is back at 0.6.0 (0.6.1 neither complete nor started)
    const behind = await make('behind');
    try {
      const count = await allRowCount();
      await expect(run061([done[0]!.id, behind.id]).beforeApply(session, { fresh: false, attribution: null, unrestrictedTarget: true })).rejects.toBeInstanceOf(
        UpgradeVersionTooOldError,
      );
      expect(await allRowCount()).toBe(count);
      // The finished workspaces alone still pass.
      expect((await run061([done[0]!.id]).beforeApply(session, { fresh: false, attribution: null, unrestrictedTarget: true })).kind).toBe('continue');
    } finally {
      // A READY workspace without a logbook row reads as "failed" in every later status check on this database.
      await admin.query(`UPDATE core.workspace_schema_registry SET status = 'FAILED' WHERE workspace_id = $1`, [behind.id]);
    }
  });

  it('8. M-1: a --force 0.6.1 over a workspace that never finished 0.6.0 does not let 0.7.0 through (65, nothing written); once 0.6.1 catches it up, 0.7.0 continues', async () => {
    await dropNewerInstanceRows(); // the database is at 0.6.0
    let fail = true;
    const gate: WorkspaceUpgradeCommand = {
      kind: 'workspace',
      name: 'PatchSpecGate',
      timestamp: T0 + 10,
      run: async () => {
        if (fail) throw new Error('gate not yet');
      },
    };
    // 0.6.0 as this code has it plus a last data command that fails until released: a workspace that never finished 0.6.0.
    const registry = { ...WORKSPACE_UPGRADE_COMMANDS, '0-6': [...(WORKSPACE_UPGRADE_COMMANDS['0-6'] ?? []), gate] };
    const gateName = `0.6.0_PatchSpecGate_${T0 + 10}`;
    const w = await make('gate');
    const at070 = () =>
      new UpgradeRun({ codeVersion: '0.7.0', previousVersions: PREV_070, force: false, log: (l) => lines.push(l), workspaceRegistry: registry, workspaceRunner: { workspaceIds: [w.id] } }).beforeApply(
        session,
        { fresh: false, attribution: null, unrestrictedTarget: true },
      );
    try {
      const adopted = await new WorkspaceCommandRunner({
        codeVersion: '0.6.0',
        versions: ['0.4.0', '0.5.0'],
        force: false,
        adopt: true,
        log: (l) => lines.push(l),
        workspaceIds: [w.id],
        workspaceRegistry: registry,
      }).run(session);
      expect(adopted.failures.map((f) => f.step)).toEqual([gateName]);

      // A forced 0.6.1: its migrations step completes (forced), the workspace pass retries the gate, which fails again.
      const forced = run061([w.id], { force: true, workspaceRegistry: registry });
      expect((await start(forced)).kind).toBe('forced');
      expect(await instanceRows('0.6.1')).toEqual([['0.6.1_TypeOrmMigrations', 'completed', 1, true]]);
      expect(forced.report.workspaces?.failures.map((f) => f.step)).toEqual([gateName]);
      expect((await rows(w)).slice(-1)[0]).toMatchObject({ name: gateName, status: 'failed', attempt: 2 });

      // 0.6.1 is complete, 0.6.0 is not: an unforced 0.7.0 refuses (65) and writes nothing.
      const count = await allRowCount();
      await expect(at070()).rejects.toBeInstanceOf(UpgradeVersionTooOldError);
      expect(await allRowCount()).toBe(count);

      // A repeated (unforced) 0.6.1 start still continues (its own entry is not folded) and catches the workspace up.
      fail = false;
      const again = run061([w.id], { workspaceRegistry: registry });
      expect(await start(again)).toMatchObject({ kind: 'continue', from: '0.6.1' });
      expect((await rows(w)).slice(-1)[0]).toMatchObject({ name: gateName, status: 'completed', attempt: 3 });
      expect(await at070()).toMatchObject({ kind: 'continue', from: '0.6.1' });
    } finally {
      await dropNewerInstanceRows();
    }
  });
});
