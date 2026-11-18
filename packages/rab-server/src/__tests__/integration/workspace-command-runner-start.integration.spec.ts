import 'reflect-metadata';
import { Client } from 'pg';

import { integrationTestDatabase, integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';
import { runMigrateOnStart } from '../../database/typeorm/scripts/migrate/owner-login/migrate-on-start';
import { deployPostCheckProblems } from '../../database/typeorm/scripts/migrate/deploy-post-checks';
import { STARTUP_EXIT_CODES } from '../../database/owner-login/runtime-db-config';
import { selectWorkspaceFingerprintsForServer, workspaceFingerprintMajor } from '../../database/typeorm/workspace-schema/v1/expected-fingerprints';
import { provisionWorkspaceSchema } from '../../database/typeorm/workspace-schema/provision-workspace-schema';
import { UPGRADE_COMMANDS, WORKSPACE_UPGRADE_COMMANDS } from '../../engine/core-modules/upgrade/upgrade-commands/registry';
import { codeWorkspaceStructureLevel } from '../../engine/core-modules/upgrade/workspace-structure-level';
import type { WorkspaceUpgradeCommand } from '../../engine/core-modules/upgrade/upgrade-commands/workspace-upgrade-command';
import { readUpgradeStatus } from '../../engine/core-modules/upgrade/upgrade-status.service';
import { upgradeSessionOf } from '../../engine/core-modules/upgrade/upgrade-migration.service';
import { lastStepOfVersion } from '../../engine/core-modules/upgrade/upgrade-sequence';
import { dropWorkspaceSchema, FROZEN_TEMPLATE_REGISTRY, provisionTypeScript, registryOf, SeededWorkspace, seedWorkspace } from './helpers/workspace-fixtures';
import { hwsRuntimeOn } from './helpers/hws-fixtures';

/**
 * OWNER-DB-ULTIMATE Part D, security review M3 / L3: the workspace pass through the REAL locked start (runMigrateOnStart,
 * in-process, as the migrate child runs it), with this code's real workspace commands plus a STRUCTURAL probe command
 * (level P = code level + 1, in release 0.7.0) in a test registry (the deps seam `testWorkspace`, unreachable from the
 * environment). Release 0.7.0 (this code; strict upgrade from 0.6.0, no adoption): the workspaces are 0.6.0-COMPLETE, i.e.
 * built as 0.6.0 builds them (its workspace commands) with 0.6.0's creation cursor. The 0.6.0 adoption pass itself is proven
 * on a 0.6.0-built database (workspace-command-runner.integration.spec.ts). Proves:
 *  - first start: the 0.6.0-complete workspaces get 0.7.0's real workspace steps and the probe, level P, the deploy
 *    post-checks (code level P) pass, exit 0;
 *  - second start: nothing to do, exit 0;
 *  - a workspace provisioned AFTERWARDS by the TypeScript provisioner from the level-P template starts at the probe's cursor and
 *    passes a later data step; exit 0;
 *  - a workspace with no cursor (0.7.0 never adopts): refused and blocked, the start serves with exit 70, the status says failed.
 *
 * The SQL provisioner's level-P template does not exist (re-creating core.provision_workspace is owner-reviewed SQL). It is
 * SIMULATED here by relabelling the throwaway database's function body: its app_version literal (the real level-21 one) is
 * replaced by the probe's declared literal (the body still builds level 21; nothing in these cases provisions through it), and
 * restored afterwards.
 */
jest.setTimeout(600_000);

const RUN = integrationTestDatabaseReady();
// Release 0.7.0: the start path gets past the HWS cutover (an instance step of 0.7.0) only with HWS on; with HWS off the
// release stops at the deferred / refused cutover by design (security review L1), so the workspace pass this spec proves never
// runs there. The HWS-off CI job therefore skips it; the HWS-on jobs run it (the cutover completed when the database was built).
const describeIfDb = RUN && hwsRuntimeOn() ? describe : describe.skip;
const SFX = Math.random().toString(36).replace(/[^a-z]/g, '').slice(0, 6) || 'x';
const L = codeWorkspaceStructureLevel();
const P = L + 1;
const REAL_06 = WORKSPACE_UPGRADE_COMMANDS['0-6'] ?? [];
const REAL_07 = WORKSPACE_UPGRADE_COMMANDS['0-7'] ?? [];
const REAL_CMDS = [...REAL_06, ...REAL_07];
/** The literal of the SQL provisioner this code's migrations installed: the newest structural command's (structure level L). */
const FROZEN_LITERAL = [...REAL_CMDS].reverse().find((c) => c.structure?.provisionFunctionLiteral)!.structure!.provisionFunctionLiteral!;
/** 0.7.0's real workspace steps: what a 0.6.0-complete workspace runs at this code's start (before the probe). */
const REAL = REAL_07.map((c) => `0.7.0_${c.name}_${c.timestamp}`);
const R06 = { '0-6': REAL_06 };
/** 0.6.0's creation cursor (the last step of 0.6.0 with its own workspace commands). */
const CURSOR_060 = lastStepOfVersion('0.6.0', UPGRADE_COMMANDS, R06);
const PROBE_LITERAL = 'db:provision_workspace@DrunnerProbeLevel1799999999991';
const T0 = 1786900000000;

describeIfDb('Part D through the locked start (runMigrateOnStart)', () => {
  const { adminUrl, appUrl } = RUN ? integrationTestDatabase() : ({} as never);
  let admin: Client;
  let originalDef: string | null = null;
  const created: SeededWorkspace[] = [];
  const lines: string[] = [];
  let probe: WorkspaceUpgradeCommand;
  let seq = 0;

  const make = async (n: string): Promise<SeededWorkspace> => {
    seq += 1;
    const ws = await seedWorkspace(admin, `drs-${n}-${SFX}-${String.fromCharCode(97 + seq)}`);
    created.push(ws);
    return ws;
  };
  const rows = async (ws: SeededWorkspace) =>
    (await admin.query(`SELECT name, status, attempt, is_initial FROM core.upgrade_migration WHERE workspace_id = $1 ORDER BY created_at, attempt`, [ws.id])).rows;
  const fingerprint = async (ws: SeededWorkspace) => (await admin.query('SELECT core.workspace_schema_fingerprint_v2($1) AS f', [ws.id])).rows[0].f as string;
  const frozen = (ws: SeededWorkspace) => provisionTypeScript(adminUrl, ws, { workspaceRegistry: FROZEN_TEMPLATE_REGISTRY });
  /** A workspace as 0.6.0 left it: built by 0.6.0's workspace commands, with 0.6.0's creation cursor. */
  const complete060 = async (ws: SeededWorkspace) => {
    expect(await provisionTypeScript(adminUrl, ws, { workspaceRegistry: R06 })).toBe('READY');
    await admin.query(`INSERT INTO core.upgrade_migration (name, status, attempt, executed_by_version, is_initial, workspace_id) VALUES ($1, 'completed', 1, '0.6.0', true, $2)`, [CURSOR_060, ws.id]);
  };
  const start = (
    registry: Record<string, readonly WorkspaceUpgradeCommand[]>,
    ids: string[],
    cache: { redis?: boolean; flush?: (ns: string) => Promise<void> } = {},
  ) => {
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, NODE_ENV: 'test', PG_DATABASE_URL: appUrl, CREWFLOW_MIGRATE_ON_START: 'true', HWS_RUNTIME_ENABLED: 'true' };
    if (cache.redis) env.REDIS_URL = 'redis://127.0.0.1:1';
    if (process.platform === 'win32' && process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    return runMigrateOnStart(
      { migrationApprovalMode: 'none' },
      { env, log: (l) => lines.push(l), cacheFlush: cache.flush ?? (async () => undefined), testWorkspace: { registry, workspaceIds: ids } },
    );
  };
  const exitOf = (r: { outcome: keyof typeof STARTUP_EXIT_CODES }) => STARTUP_EXIT_CODES[r.outcome];

  beforeAll(async () => {
    admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await selectWorkspaceFingerprintsForServer(async (sql) => (await admin.query(sql)).rows);
    const ref = await make('ref');
    expect(await frozen(ref)).toBe('READY');
    const sql = (s: string) => `ALTER TABLE ${s}.venue ADD COLUMN IF NOT EXISTS d_start_probe text`;
    await admin.query('BEGIN');
    for (const c of REAL_CMDS) if (c.sql) await admin.query(c.sql(ref.schema));
    await admin.query(sql(ref.schema));
    const levelP = await fingerprint(ref);
    await admin.query('ROLLBACK');
    probe = { kind: 'workspace', name: 'StartProbe', timestamp: T0, sql, structure: { level: P, fingerprints: { [workspaceFingerprintMajor()]: levelP }, provisionFunctionLiteral: PROBE_LITERAL } };
    originalDef = (await admin.query(`SELECT pg_catalog.pg_get_functiondef('core.provision_workspace(uuid)'::regprocedure) AS d`)).rows[0].d as string;
    expect(originalDef).toContain(FROZEN_LITERAL);
  });
  /** Simulate the level-21 SQL template (see the header): relabel the throwaway database's provision function; restore it. */
  const relabel = async (on: boolean) => admin.query(on ? originalDef!.split(FROZEN_LITERAL).join(PROBE_LITERAL) : originalDef!);

  afterAll(async () => {
    if (originalDef) await admin.query(originalDef).catch(() => undefined);
    for (const ws of created) {
      await admin.query('DELETE FROM core.upgrade_migration WHERE workspace_id = $1', [ws.id]).catch(() => undefined);
      await dropWorkspaceSchema(admin, ws.schema).catch(() => undefined);
      await admin.query(`UPDATE core.workspace_schema_registry SET status = 'FAILED', module_version = LEAST(module_version, 20) WHERE workspace_id = $1`, [ws.id]).catch(() => undefined);
    }
    await admin?.end();
  });

  it('start 1 brings a 0.6.0-complete fleet to level P (exit 0); start 2 does nothing (exit 0); a later-provisioned level-P workspace passes a data step', async () => {
    const [w1, w2] = [await make('w1'), await make('w2')];
    for (const w of [w1, w2]) await complete060(w);
    const r1 = { '0-6': REAL_06, '0-7': [...REAL_07, probe] };
    await relabel(true);
    try {

    const first = await start(r1, [w1.id, w2.id]);
    expect({ outcome: first.outcome, exit: exitOf(first) }).toEqual({ outcome: 'ok', exit: 0 });
    expect(first.upgrade?.workspaces).toMatchObject({ total: 2, adopted: 0, upgraded: 2, failures: [] });
    for (const w of [w1, w2]) {
      expect((await registryOf(admin, w.id)).module_version).toBe(P);
      expect((await rows(w)).map((r: { name: string; status: string; is_initial: boolean }) => [r.name, r.status, r.is_initial])).toEqual([
        [CURSOR_060, 'completed', true],
        ...REAL.map((name) => [name, 'completed', false]),
        [`0.7.0_StartProbe_${T0}`, 'completed', false],
      ]);
    }

    const second = await start(r1, [w1.id, w2.id]);
    expect({ outcome: second.outcome, exit: exitOf(second) }).toEqual({ outcome: 'ok', exit: 0 });
    expect((await rows(w1)).length).toBe(2 + REAL.length);

    // A new workspace from the level-P template (the TypeScript provisioner applies the structural commands after the 20
    // modules) with its creation-time cursor: the code version's last step.
    const w3 = await make('w3');
    const c = new Client({ connectionString: adminUrl });
    await c.connect();
    try {
      await c.query('SET ROLE crewflow');
      expect((await provisionWorkspaceSchema(c, w3.id, { workspaceRegistry: r1 })).outcome).toBe('READY');
    } finally {
      await c.end();
    }
    expect((await registryOf(admin, w3.id)).module_version).toBe(P);
    await admin.query(`INSERT INTO core.upgrade_migration (name, status, attempt, executed_by_version, is_initial, workspace_id) VALUES ($1, 'completed', 1, '0.7.0', true, $2)`, [
      lastStepOfVersion('0.7.0', UPGRADE_COMMANDS, r1),
      w3.id,
    ]);

    const data: WorkspaceUpgradeCommand = { kind: 'workspace', name: 'StartData', timestamp: T0 + 1, run: async ({ query, schemaName }) => void (await query(`SELECT count(*) FROM ${schemaName}.venue`)) };
    const third = await start({ '0-6': REAL_06, '0-7': [...REAL_07, probe, data] }, [w1.id, w2.id, w3.id]);
    expect({ outcome: third.outcome, exit: exitOf(third) }).toEqual({ outcome: 'ok', exit: 0 });
    for (const w of [w1, w2, w3]) expect((await rows(w)).slice(-1)[0]).toMatchObject({ name: `0.7.0_StartData_${T0 + 1}`, status: 'completed' });
    } finally {
      await relabel(false);
    }
  });

  it('a workspace with no cursor (0.7.0 never adopts): refused and blocked, the start serves with exit 70, and the status says failed (L3)', async () => {
    const [ok, orphan] = [await make('a-ok'), await make('a-nocursor')];
    await complete060(ok);
    expect(await frozen(orphan)).toBe('READY');
    const r = await start({ '0-6': REAL_06, '0-7': REAL_07 }, [ok.id, orphan.id]);
    expect({ outcome: r.outcome, exit: exitOf(r), serve: r.serve }).toEqual({ outcome: 'degradedContinue', exit: 70, serve: true });
    expect(r.upgrade?.commandFailure).toMatchObject({ name: '0.7.0_WorkspaceCursor', workspaceId: orphan.id });
    expect(await rows(orphan)).toEqual([]);
    expect((await rows(ok)).length).toBe(1 + REAL.length);
    // Owner D3: the refused workspace is blocked (registry marker → 503); the 0.6.0-complete one is not.
    expect((await registryOf(admin, orphan.id)).migration_error).toMatch(/^upgrade-blocked: 0\.7\.0_WorkspaceCursor \(/);
    expect((await registryOf(admin, ok.id)).migration_error).toBeNull();
    expect(r.upgrade?.workspaces?.blocked).toEqual([orphan.id]);

    const c = new Client({ connectionString: appUrl });
    await c.connect();
    try {
      expect((await readUpgradeStatus(upgradeSessionOf(c), '0.7.0')).state).toBe('failed');
    } finally {
      await c.end();
    }
  });
  it('review N2: the post-check outside the locked start (deploy-prepare, lifecycle) is strict: a workspace at 20 under a higher code level is behind', async () => {
    const w = await make('n2');
    expect(await frozen(w)).toBe('READY');
    const c = new Client({ connectionString: appUrl });
    await c.connect();
    try {
      const q = async (sql: string, p?: unknown[]) => (await c.query(sql, p as unknown[])).rows;
      const strict = await deployPostCheckProblems(q, { workspaceRegistry: { '0-6': [...REAL_CMDS, probe] }, workspaceIds: [w.id] });
      expect(strict.some((p) => p.includes('workspace-behind'))).toBe(true);
      const start = await deployPostCheckProblems(q, { workspaceRegistry: { '0-6': [...REAL_CMDS, probe] }, workspaceIds: [w.id], behindFloor: 20 });
      expect(start.some((p) => p.includes('workspace-behind'))).toBe(false);
    } finally {
      await c.end();
    }
    // deploy-prepare and the lifecycle checks call it without behindFloor (strict); only migrate-on-start passes 20.
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const scripts = join(__dirname, '..', '..', 'database', 'typeorm', 'scripts');
    expect(readFileSync(join(scripts, 'deploy-prepare.ts'), 'utf8')).not.toMatch(/behindFloor/);
    expect(readFileSync(join(scripts, 'migrate', 'owner-login', 'owner-login-lifecycle-check.ts'), 'utf8')).not.toMatch(/behindFloor/);
    expect(readFileSync(join(scripts, 'migrate', 'owner-login', 'migrate-on-start.ts'), 'utf8')).toMatch(/behindFloor: LATEST_WORKSPACE_MODULE_VERSION/);
  });
  it('review P2: a workspace block changed but the cache epoch bump failed: the start refuses (WorkspaceBlockCacheError, postCheck, 68) instead of serving stale routing', async () => {
    const w = await make('p2-drift');
    expect(await frozen(w)).toBe('READY');
    await admin.query(`DROP POLICY job_role_tenant ON ${w.schema}.job_role`);
    const r = await start({ '0-6': REAL_CMDS }, [w.id], { redis: true, flush: async () => { throw new Error('redis unreachable'); } });
    expect({ outcome: r.outcome, exit: exitOf(r), serve: r.serve }).toEqual({ outcome: 'postCheck', exit: 68, serve: false });
    expect((await registryOf(admin, w.id)).migration_error).toMatch(/^upgrade-blocked: /);
  });
});
