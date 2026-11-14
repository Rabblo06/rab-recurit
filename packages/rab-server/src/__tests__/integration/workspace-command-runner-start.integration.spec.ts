import 'reflect-metadata';
import { Client } from 'pg';

import { resolveIntegrationTestDatabase } from '../../database/typeorm/core/test-database-guard';
import { runMigrateOnStart } from '../../database/typeorm/scripts/migrate/owner-login/migrate-on-start';
import { STARTUP_EXIT_CODES } from '../../database/owner-login/runtime-db-config';
import { selectWorkspaceFingerprintsForServer, workspaceFingerprintMajor } from '../../database/typeorm/workspace-schema/v1/expected-fingerprints';
import { provisionWorkspaceSchema } from '../../database/typeorm/workspace-schema/provision-workspace-schema';
import { UPGRADE_COMMANDS } from '../../engine/core-modules/upgrade/upgrade-commands/registry';
import type { WorkspaceUpgradeCommand } from '../../engine/core-modules/upgrade/upgrade-commands/workspace-upgrade-command';
import { readUpgradeStatus } from '../../engine/core-modules/upgrade/upgrade-status.service';
import { upgradeSessionOf } from '../../engine/core-modules/upgrade/upgrade-migration.service';
import { lastStepOfVersion } from '../../engine/core-modules/upgrade/upgrade-sequence';
import { dropWorkspaceSchema, provisionTypeScript, registryOf, SeededWorkspace, seedWorkspace } from './helpers/workspace-fixtures';

/**
 * OWNER-DB-ULTIMATE Part D, security review M3 / L3: the workspace pass through the REAL locked start (runMigrateOnStart,
 * in-process, as the migrate child runs it), with a STRUCTURAL probe command (level 21) in a test registry (the deps seam
 * `testWorkspace`, unreachable from the environment). Proves:
 *  - first start: the pre-Part-D workspaces are adopted (is_initial at the last instance step), the probe brings them to
 *    level 21, the deploy post-checks (code level 21) pass, exit 0;
 *  - second start: nothing to do, exit 0;
 *  - a workspace provisioned AFTERWARDS by the TypeScript provisioner from the level-21 template starts at the probe's cursor and
 *    passes a later data step; exit 0;
 *  - a drifted, unadopted workspace: adoption refused, the start serves with exit 70, and the status says failed.
 *
 * The SQL provisioner's level-21 template cannot exist yet (re-creating core.provision_workspace is owner-reviewed SQL). It is
 * SIMULATED here by relabelling the throwaway database's function body: its app_version literal is replaced by the probe's
 * declared literal (the body still builds module 20; nothing in these cases provisions through it), and restored afterwards.
 */
jest.setTimeout(600_000);

const RUN = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_DATABASE_URL_UNPOOLED);
const describeIfDb = RUN ? describe : describe.skip;
const SFX = Math.random().toString(36).replace(/[^a-z]/g, '').slice(0, 6) || 'x';
const FROZEN_LITERAL = 'db:provision_workspace@WorkspaceGrantParityGuards1786721430000';
const PROBE_LITERAL = 'db:provision_workspace@DrunnerProbeLevel1799999999991';
const T0 = 1786900000000;

describeIfDb('Part D through the locked start (runMigrateOnStart)', () => {
  const { adminUrl } = RUN ? resolveIntegrationTestDatabase(process.env) : ({} as never);
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
  const fingerprint = async (ws: SeededWorkspace) => (await admin.query('SELECT core.workspace_schema_fingerprint($1) AS f', [ws.id])).rows[0].f as string;
  const start = (registry: Record<string, readonly WorkspaceUpgradeCommand[]>, ids: string[]) => {
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, NODE_ENV: 'test', PG_DATABASE_URL: process.env.TEST_DATABASE_URL, CREWFLOW_MIGRATE_ON_START: 'true' };
    if (process.platform === 'win32' && process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    return runMigrateOnStart({ migrationApprovalMode: 'none' }, { env, log: (l) => lines.push(l), cacheFlush: async () => undefined, testWorkspace: { registry, workspaceIds: ids } });
  };
  const exitOf = (r: { outcome: keyof typeof STARTUP_EXIT_CODES }) => STARTUP_EXIT_CODES[r.outcome];

  beforeAll(async () => {
    admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await selectWorkspaceFingerprintsForServer(async (sql) => (await admin.query(sql)).rows);
    const ref = await make('ref');
    expect(await provisionTypeScript(adminUrl, ref)).toBe('READY');
    const sql = (s: string) => `ALTER TABLE ${s}.venue ADD COLUMN IF NOT EXISTS d_start_probe text`;
    await admin.query('BEGIN');
    await admin.query(sql(ref.schema));
    const level21 = await fingerprint(ref);
    await admin.query('ROLLBACK');
    probe = { kind: 'workspace', name: 'StartProbe', timestamp: T0, sql, structure: { level: 21, fingerprints: { [workspaceFingerprintMajor()]: level21 }, provisionFunctionLiteral: PROBE_LITERAL } };
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

  it('start 1 adopts and brings the fleet to level 21 (exit 0); start 2 does nothing (exit 0); a later-provisioned level-21 workspace passes a data step', async () => {
    const [w1, w2] = [await make('w1'), await make('w2')];
    for (const w of [w1, w2]) expect(await provisionTypeScript(adminUrl, w)).toBe('READY');
    const r1 = { '0-6': [probe] };
    await relabel(true);
    try {

    const first = await start(r1, [w1.id, w2.id]);
    expect({ outcome: first.outcome, exit: exitOf(first) }).toEqual({ outcome: 'ok', exit: 0 });
    expect(first.upgrade?.workspaces).toMatchObject({ total: 2, adopted: 2, upgraded: 2, failures: [] });
    for (const w of [w1, w2]) {
      expect((await registryOf(admin, w.id)).module_version).toBe(21);
      expect((await rows(w)).map((r: { name: string; status: string; is_initial: boolean }) => [r.name, r.status, r.is_initial])).toEqual([
        ['0.6.0_TypeOrmMigrations', 'completed', true],
        [`0.6.0_StartProbe_${T0}`, 'completed', false],
      ]);
    }

    const second = await start(r1, [w1.id, w2.id]);
    expect({ outcome: second.outcome, exit: exitOf(second) }).toEqual({ outcome: 'ok', exit: 0 });
    expect((await rows(w1)).length).toBe(2);

    // A new workspace from the level-21 template (the TypeScript provisioner applies the structural commands after the 20
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
    expect((await registryOf(admin, w3.id)).module_version).toBe(21);
    await admin.query(`INSERT INTO core.upgrade_migration (name, status, attempt, executed_by_version, is_initial, workspace_id) VALUES ($1, 'completed', 1, '0.6.0', true, $2)`, [
      lastStepOfVersion('0.6.0', UPGRADE_COMMANDS, r1),
      w3.id,
    ]);

    const data: WorkspaceUpgradeCommand = { kind: 'workspace', name: 'StartData', timestamp: T0 + 1, run: async ({ query, schemaName }) => void (await query(`SELECT count(*) FROM ${schemaName}.venue`)) };
    const third = await start({ '0-6': [probe, data] }, [w1.id, w2.id, w3.id]);
    expect({ outcome: third.outcome, exit: exitOf(third) }).toEqual({ outcome: 'ok', exit: 0 });
    for (const w of [w1, w2, w3]) expect((await rows(w)).slice(-1)[0]).toMatchObject({ name: `0.6.0_StartData_${T0 + 1}`, status: 'completed' });
    } finally {
      await relabel(false);
    }
  });

  it('a drifted, unadopted workspace: adoption refused, the start serves with exit 70, and the status says failed (L3)', async () => {
    const [ok, drift] = [await make('a-ok'), await make('a-drift')];
    for (const w of [ok, drift]) expect(await provisionTypeScript(adminUrl, w)).toBe('READY');
    await admin.query(`DROP POLICY job_role_tenant ON ${drift.schema}.job_role`);
    const r = await start({ '0-6': [] }, [ok.id, drift.id]);
    expect({ outcome: r.outcome, exit: exitOf(r), serve: r.serve }).toEqual({ outcome: 'degradedContinue', exit: 70, serve: true });
    expect(r.upgrade?.commandFailure).toMatchObject({ name: '0.6.0_WorkspaceAdoption', workspaceId: drift.id });
    expect(await rows(drift)).toEqual([]);
    expect((await rows(ok)).length).toBe(1);

    const c = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    await c.connect();
    try {
      expect((await readUpgradeStatus(upgradeSessionOf(c), '0.6.0')).state).toBe('failed');
    } finally {
      await c.end();
    }
  });
});
