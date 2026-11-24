import 'reflect-metadata';
import { Client } from 'pg';

import { WorkspaceAttendanceBreaksReceipts1786722150000 } from '../../database/typeorm/core/migrations/1786722150000-WorkspaceAttendanceBreaksReceipts';
import { integrationTestDatabase, integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';
import { MIGRATION_LOCK_KEY } from '../../database/typeorm/scripts/migrate/migration-lock';
import { LEVEL_27_COUNTS, LEVEL_27_WORKSPACES_SQL } from '../../database/typeorm/workspace-schema/structure-level-27';
import { selectWorkspaceFingerprintsForServer, workspaceFingerprintMajor } from '../../database/typeorm/workspace-schema/v1/expected-fingerprints';
import { WORKSPACE_CORE_FK_REMOVAL } from '../../engine/core-modules/upgrade/upgrade-commands/0-6/workspace-core-fk-removal';
import { ATTENDANCE_BREAKS_RECEIPTS, workspaceAttendanceBreaksReceiptsSql } from '../../engine/core-modules/upgrade/upgrade-commands/0-7/attendance-breaks-receipts';
import { ATTENDANCE_CORRECTION_INSERT_ONLY } from '../../engine/core-modules/upgrade/upgrade-commands/0-7/attendance-correction-insert-only';
import { ATTENDANCE_STAFF_SCOPE } from '../../engine/core-modules/upgrade/upgrade-commands/0-7/attendance-staff-scope';
import { STAFF_PROFILE_SHIFT_TEAM_MULTI_ROLE } from '../../engine/core-modules/upgrade/upgrade-commands/0-7/staff-profile-shift-team-multi-role';
import { STAFF_PROFILE_WORKSPACE_REQUIRED_VALIDATE } from '../../engine/core-modules/upgrade/upgrade-commands/0-7/staff-profile-workspace-required-validate';
import { WORKSPACE_UPGRADE_COMMANDS } from '../../engine/core-modules/upgrade/upgrade-commands/registry';
import { upgradeSessionOf, UpgradeSession } from '../../engine/core-modules/upgrade/upgrade-migration.service';
import { WorkspaceCommandRunner, WorkspaceRunOptions } from '../../engine/core-modules/upgrade/workspace-command-runner';
import { codeWorkspaceStructureLevel, declaredFingerprint } from '../../engine/core-modules/upgrade/workspace-structure-level';
import { BreakFixture, seedBreakFixture } from './helpers/attendance-break-fixture';
import { registerBreakAbuseCases } from './helpers/attendance-break-abuse';
import { takeAttendanceLevelsDownTo } from './helpers/attendance-levels-down';
import { dropWorkspaceSchema, provisionServerPath, provisionTypeScript, registryOf, SeededWorkspace, seedWorkspace } from './helpers/workspace-fixtures';

/**
 * M4 design §13 PR 2, the workspace-schema copies (DRAFT SQL, throwaway databases only): `0.7.0_AttendanceBreaksReceipts_
 * 1786722150000` (structure level 27, the first level that adds tables) and WorkspaceAttendanceBreaksReceipts1786722150000.
 * Proves: the level-27 fingerprint (`[l27-fp]` prints the measured value); the runner upgrade from level 26 (idempotent) and
 * both provisioners build the same level-27 schema; core.verify_workspace_schema_v1 accepts it with the level-27 counts and
 * names a missing table; the bound CHECKs; the A.3 / A.4 / A.7 abuse cases as the RUNTIME login in a workspace schema
 * (helpers/attendance-break-abuse.ts); no foreign key to core; the migration's predecessor and down() guards.
 */
jest.setTimeout(900_000);

const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;
const SFX = Math.random().toString(36).replace(/[^a-z]/g, '').slice(0, 6) || 'x';
const LOCK = MIGRATION_LOCK_KEY.toString();
const STEP = `0.7.0_${ATTENDANCE_BREAKS_RECEIPTS.name}_${ATTENDANCE_BREAKS_RECEIPTS.timestamp}`;
const L22_STEP = `0.6.0_${WORKSPACE_CORE_FK_REMOVAL.name}_${WORKSPACE_CORE_FK_REMOVAL.timestamp}`;
const L22 = { '0-6': [...(WORKSPACE_UPGRADE_COMMANDS['0-6'] ?? [])] };
const L26 = { ...L22, '0-7': [STAFF_PROFILE_WORKSPACE_REQUIRED_VALIDATE, STAFF_PROFILE_SHIFT_TEAM_MULTI_ROLE, ATTENDANCE_STAFF_SCOPE, ATTENDANCE_CORRECTION_INSERT_ONLY] };
const L27 = { ...L22, '0-7': [...L26['0-7'], ATTENDANCE_BREAKS_RECEIPTS] };

describeIfDb('M4 §13 PR 2: attendance breaks and sync receipts in workspace schemas, structure level 27 (integration, throwaway database)', () => {
  const { adminUrl, appUrl } = RUN ? integrationTestDatabase() : ({} as never);
  let admin: Client;
  let app: Client;
  let session: UpgradeSession;
  const created: SeededWorkspace[] = [];
  let seq = 0;

  const make = async (n: string, how: 'level26' | 'level27' | 'sql'): Promise<SeededWorkspace> => {
    seq += 1;
    const ws = await seedWorkspace(admin, `wsl27-${n}-${SFX}-${seq}`);
    created.push(ws);
    if (how === 'level26') {
      expect(await provisionTypeScript(adminUrl, ws, { workspaceRegistry: L26 })).toBe('READY');
      await admin.query(
        `INSERT INTO core.upgrade_migration (name, status, attempt, executed_by_version, is_initial, workspace_id) VALUES ($1, 'completed', 1, '0.6.0', true, $2)`,
        [L22_STEP, ws.id],
      );
    }
    if (how === 'level27') expect(await provisionTypeScript(adminUrl, ws, { workspaceRegistry: L27 })).toBe('READY');
    if (how === 'sql') expect(await provisionServerPath(appUrl, ws)).toBe('READY');
    return ws;
  };
  const v2 = async (ws: SeededWorkspace) => (await admin.query('SELECT core.workspace_schema_fingerprint_v2($1) AS f', [ws.id])).rows[0].f as string;
  const runner = (o: Partial<WorkspaceRunOptions> & Pick<WorkspaceRunOptions, 'workspaceIds'>) =>
    new WorkspaceCommandRunner({ codeVersion: '0.7.0', versions: ['0.4.0', '0.5.0', '0.6.0'], force: false, adopt: false, log: () => undefined, workspaceRegistry: L27, ...o }).run(session);
  const runnerOf = (c: Client) => ({ isTransactionActive: true, query: async (sql: string, params?: unknown[]) => (await c.query(sql, params as unknown[])).rows }) as never;
  const counts = async (ws: SeededWorkspace) =>
    (
      await admin.query(
        `SELECT (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind = 'r') AS tables,
                (SELECT count(*)::int FROM pg_indexes WHERE schemaname = $1) AS indexes,
                (SELECT count(*)::int FROM pg_policies WHERE schemaname = $1) AS policies,
                (SELECT count(*)::int FROM pg_constraint k JOIN pg_namespace n ON n.oid = k.connamespace WHERE n.nspname = $1 AND k.contype = 'f') AS "foreignKeys"`,
        [ws.schema],
      )
    ).rows[0];

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

  it('the command is level 27 of this code: additive (no drop), a v2 fingerprint declared, its own provision literal', () => {
    expect(codeWorkspaceStructureLevel()).toBeGreaterThanOrEqual(27);
    expect(ATTENDANCE_BREAKS_RECEIPTS.structure).toMatchObject({ level: 27, provisionFunctionLiteral: 'db:provision_workspace@WorkspaceAttendanceBreaksReceipts1786722150000' });
    expect(ATTENDANCE_BREAKS_RECEIPTS.structure?.mayDrop).toBeUndefined();
    expect(declaredFingerprint(27, workspaceFingerprintMajor())).toMatch(/^[0-9a-f]{64}$/);
  });

  it('measures the level-27 v2 fingerprint of this major (the command SQL on a level-26 workspace, as crewflow, twice)', async () => {
    const m = await make('measure', 'level26');
    const before = await v2(m);
    const c = new Client({ connectionString: adminUrl });
    await c.connect();
    try {
      for (let i = 0; i < 2; i += 1) {
        await c.query('BEGIN');
        await c.query('SET LOCAL ROLE crewflow');
        await c.query(`SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true)`);
        await c.query(workspaceAttendanceBreaksReceiptsSql(m.schema));
        await c.query('COMMIT');
      }
    } finally {
      await c.end();
    }
    const measured = await v2(m);
    // eslint-disable-next-line no-console
    console.log(`[l27-fp] postgres=${workspaceFingerprintMajor()} level26-v2=${before} level27-v2=${measured} declared=${declaredFingerprint(27, workspaceFingerprintMajor())}`);
    expect(before).toBe(declaredFingerprint(26, workspaceFingerprintMajor()));
    expect(await counts(m)).toEqual(LEVEL_27_COUNTS);
    expect(measured).toBe(declaredFingerprint(27, workspaceFingerprintMajor()));
  });

  it('existing workspaces: the runner moves them to level 27 (declared v2, verify clean), idempotently; new workspaces (both provisioners) match', async () => {
    const [a, b] = [await make('ex-a', 'level26'), await make('ex-b', 'level26')];
    const out = await runner({ workspaceIds: [a.id, b.id] });
    expect(out.failures).toEqual([]);
    for (const w of [a, b]) {
      expect(out.outcomes.find((o) => o.workspaceId === w.id)!.completed).toContain(STEP);
      expect(await registryOf(admin, w.id)).toMatchObject({ status: 'READY', module_version: 27, migration_error: null });
      expect(await v2(w)).toBe(declaredFingerprint(27, workspaceFingerprintMajor()));
      expect((await admin.query('SELECT core.verify_workspace_schema_v1($1) AS p', [w.id])).rows[0].p).toBeNull();
    }
    expect((await runner({ workspaceIds: [a.id, b.id] })).outcomes.map((o) => o.status)).toEqual(['up-to-date', 'up-to-date']);
    const nwTs = await make('nw-ts', 'level27');
    const nwSql = await make('nw-sql', 'sql');
    expect((await registryOf(admin, nwSql.id)).module_version).toBe(codeWorkspaceStructureLevel());
    for (const w of codeWorkspaceStructureLevel() === 27 ? [nwTs, nwSql] : [nwTs]) {
      expect((await registryOf(admin, w.id)).module_version).toBe(27);
      expect(await v2(w)).toBe(await v2(a));
      expect(await counts(w)).toEqual(LEVEL_27_COUNTS);
    }
  });

  it('verify_workspace_schema_v1 names a level-27 workspace that lost a table (table count), and a level-26 one with 21 tables passes (rolled back)', async () => {
    const w27 = await make('verify', 'sql');
    const w26 = await make('verify26', 'level26');
    await admin.query('BEGIN');
    try {
      await admin.query(`DROP TABLE "${w27.schema}".attendance_sync_receipt`);
      expect((await admin.query('SELECT core.verify_workspace_schema_v1($1) AS p', [w27.id])).rows[0].p).toBe('table count');
      expect((await admin.query('SELECT core.verify_workspace_schema_v1($1) AS p', [w26.id])).rows[0].p).toBeNull();
    } finally {
      await admin.query('ROLLBACK');
    }
  });

  it('bound CHECKs: both new tables refuse another workspace id; no foreign key from them to any core table', async () => {
    const w = await make('bound', 'sql');
    const { rows } = await admin.query(
      `SELECT c.relname::text AS t, pg_get_constraintdef(k.oid) AS def FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND k.conname IN ('attendance_break_workspace_bound', 'attendance_sync_receipt_workspace_bound') ORDER BY 1`,
      [w.schema],
    );
    expect(rows.map((r) => r.t)).toEqual(['attendance_break', 'attendance_sync_receipt']);
    for (const r of rows) expect(r.def).toBe(`CHECK (((workspace_id IS NOT NULL) AND (workspace_id = '${w.id}'::uuid)))`);
    const core = await admin.query(
      `SELECT k.conname FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname IN ('attendance_break', 'attendance_sync_receipt') AND k.contype = 'f' AND k.confrelid::regclass::text LIKE 'core.%'`,
      [w.schema],
    );
    expect(core.rows).toEqual([]);
  });

  describe('runtime login in a level-27 workspace schema', () => {
    let w: SeededWorkspace;
    let fx: BreakFixture;
    beforeAll(async () => {
      w = await make('rls', 'sql');
      fx = await seedBreakFixture(admin, w, w.schema, `ws-${SFX}`);
    });
    registerBreakAbuseCases({ app: () => app, admin: () => admin, w: () => w, fx: () => fx });
  });

  it('up() refuses a provision body that is not the level-26 predecessor; down() refuses while a level-27 workspace exists', async () => {
    await admin.query('BEGIN');
    try {
      await expect(new WorkspaceAttendanceBreaksReceipts1786722150000().up(runnerOf(admin))).rejects.toThrow(/is not the expected predecessor body/);
    } finally {
      await admin.query('ROLLBACK');
    }
    await make('down', 'level27');
    await admin.query('BEGIN');
    try {
      await expect(new WorkspaceAttendanceBreaksReceipts1786722150000().down(runnerOf(admin))).rejects.toThrow(/down\(\) refused: \d+ workspace schema\(s\) are at structure level 27/);
    } finally {
      await admin.query('ROLLBACK');
    }
  });

  it('down() with no level-27 workspace left (rolled back) restores the level-26 provision and verify bodies; up() restores level 27', async () => {
    const fn = async (name: string) => (await admin.query(`SELECT prosrc FROM pg_proc WHERE oid = $1::regprocedure`, [name])).rows[0].prosrc as string;
    const before = { provision: await fn('core.provision_workspace(uuid)'), verify: await fn('core.verify_workspace_schema_v1(uuid)') };
    await admin.query('BEGIN');
    try {
      await takeAttendanceLevelsDownTo(admin, 26);
      expect((await admin.query(LEVEL_27_WORKSPACES_SQL)).rows[0].n).toBe(0);
      expect((await fn('core.provision_workspace(uuid)')).includes(ATTENDANCE_CORRECTION_INSERT_ONLY.structure!.provisionFunctionLiteral!)).toBe(true);
      expect(await fn('core.verify_workspace_schema_v1(uuid)')).not.toContain('v_l27');
      await new WorkspaceAttendanceBreaksReceipts1786722150000().up(runnerOf(admin));
      expect((await fn('core.provision_workspace(uuid)')).includes(ATTENDANCE_BREAKS_RECEIPTS.structure!.provisionFunctionLiteral!)).toBe(true);
      expect(await fn('core.verify_workspace_schema_v1(uuid)')).toContain('v_l27');
    } finally {
      await admin.query('ROLLBACK');
    }
    expect({ provision: await fn('core.provision_workspace(uuid)'), verify: await fn('core.verify_workspace_schema_v1(uuid)') }).toEqual(before);
  });
});
