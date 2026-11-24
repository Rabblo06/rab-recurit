import 'reflect-metadata';
import { join } from 'node:path';
import { Client } from 'pg';
import type { MigrationInterface, QueryRunner } from 'typeorm';

import { integrationTestDatabase, integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';
import { STARTUP_EXIT_CODES } from '../../database/owner-login/runtime-db-config';
import { runLockedMigrations } from '../../database/typeorm/scripts/migrate/locked-migration-runner';
import { MIGRATION_LOCK_KEY } from '../../database/typeorm/scripts/migrate/migration-lock';
import { runMigrateOnStart } from '../../database/typeorm/scripts/migrate/owner-login/migrate-on-start';
import { selectWorkspaceFingerprintsForServer } from '../../database/typeorm/workspace-schema/v1/expected-fingerprints';
import type { WorkspaceMetadataCacheService } from '../../engine/core-modules/entity-cache/workspace-metadata-cache.service';
import { SchemaResolverService, WorkspaceRoutingError } from '../../engine/core-modules/tenant/schema-resolver.service';
import type { UpgradeCommand } from '../../engine/core-modules/upgrade/upgrade-commands/upgrade-command';
import type { WorkspaceUpgradeCommand } from '../../engine/core-modules/upgrade/upgrade-commands/workspace-upgrade-command';
import { UPGRADE_COMMANDS, WORKSPACE_UPGRADE_COMMANDS } from '../../engine/core-modules/upgrade/upgrade-commands/registry';
import { Query, upgradeSessionOf, UpgradeSession } from '../../engine/core-modules/upgrade/upgrade-migration.service';
import { UpgradeRun } from '../../engine/core-modules/upgrade/upgrade-runner';
import { readUpgradeStatus } from '../../engine/core-modules/upgrade/upgrade-status.service';
import { UpgradeVersionTooOldError } from '../../engine/core-modules/upgrade/upgrade-version-check';
import { WorkspaceCommandRunner } from '../../engine/core-modules/upgrade/workspace-command-runner';
import { upgradeBlockMarker } from '../../engine/core-modules/upgrade/workspace-upgrade-block';
import { dropWorkspaceSchema, FROZEN_TEMPLATE_REGISTRY, provisionTypeScript, registryOf, SeededWorkspace, seedWorkspace } from './helpers/workspace-fixtures';

/**
 * Owner decisions 2026-11-18 (follow-up to #219) on a real, disposable database, through UpgradeRun's beforeApply / afterApply
 * on the one runtime login holding the migration lock, exactly as the migrate-on-start child calls them:
 *   (a) 0.7.0 upgrades from the versions on its reviewed list (CREWFLOW_UPGRADE_FROM_VERSIONS; passed here as `upgradeFrom`);
 *   (b) a patch release retries a failed .0 instance step under the .0's step name, executed_by_version = the patch.
 *
 * The HWS switch-on scenario. 0.7.0's registration (#175) is not merged, so the 0.7.0 registry here holds a PROBE instance
 * command shaped like the C3 cutover (upgrade-commands/0-7/hws-cutover.ts): it BLOCKS its workspace first (the Part D marker
 * `upgrade-blocked: HwsCutover (HWS_CUTOVER_PENDING)`, role crewflow, tenant bound; the resolver answers 'upgrading' = 503
 * "Workspace is being upgraded."), then fails while the "backup" is missing (as NO_BACKUP), and on success lifts its own
 * block. It is idempotent like the real command (the block write and the lift are re-runnable). Proves, in order:
 *   1. abuse: 0.7.1 before any 0.7.0 start cannot skip 0.7.0: 65, nothing written;
 *   2. 0.7.0 (from 0.6.0, on its list): the cutover fails (attempt 1) → the workspace is BLOCKED (resolver 'upgrading');
 *   3. abuse: a READY workspace with no logbook row (a patch never adopts) → 0.7.1 still refuses 65, nothing written;
 *   4. 0.7.1, still no backup: resumes 0.7.0 (decision continue from 0.7.0), the cutover fails again under its 0.7.0 name
 *      (attempt 2, executed_by 0.7.1), 0.7.1_TypeOrmMigrations not recorded, the workspace stays BLOCKED; /healthz 'failed'
 *      (and 'failed' too when the patch's own last step is completed but the .0 step's latest attempt failed);
 *   5. 0.7.1 again, backup present: the cutover completes (attempt 3, executed_by 0.7.1), then 0.7.1_TypeOrmMigrations; the
 *      workspace is UNBLOCKED (resolver → its schema); /healthz ok; a further start records nothing;
 *   6. a failed 0.7.0 WORKSPACE step is retried by 0.7.1 under its 0.7.0 name too (the workspace pass walks from the cursor);
 *   7. ORDER (review R1 of #240), through the REAL locked start (runMigrateOnStart → runLockedMigrations) with a REAL
 *      patch-only migration (a test migration class added to this code's chain): the 0.7.0 cutover is retried BEFORE the
 *      0.7.1 migration applies; if it fails again the start refuses (66, the log names the command, not a migration) and the
 *      migration is NOT applied, unless --force (review B: the migration applies, 70, rows forced, still blocked); when
 *      0.7.0's migrations step is not completed the start refuses (65) and nothing is applied;
 *   8. review O3: after a FRESH 0.7.1 whose 0.7.0 retry failed (rows executed by 0.7.1 only), 0.7.2 resumes 0.7.0 (not 65).
 * Self-sufficient on the shared database: beforeAll seeds a completed `0.6.0_TypeOrmMigrations` row when needed; afterAll
 * removes every row and workspace written here (the 0.7.0 / 0.7.1 instance rows included).
 */
jest.setTimeout(300_000);

const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;
const SFX = Math.random().toString(36).replace(/[^a-z]/g, '').slice(0, 6) || 'x';
const LOCK = MIGRATION_LOCK_KEY.toString();
const T0 = 1786995000000;
const PREV_070 = ['0.4.0', '0.5.0', '0.6.0'];
const PREV_071 = [...PREV_070, '0.7.0'];
const UF = { '0.7.0': ['0.6.0'] };
const CUTOVER = `0.7.0_ProbeHwsCutover_${T0}`;
const PREV_072 = [...PREV_071, '0.7.1'];
/** The real patch-only migration of case 7 (newer than every migration of this code; removed from core.migrations afterwards). */
const PATCH_MIGRATION = 'CrossUpgradePatchProbe1799999990001';
const MIGRATIONS_GLOB = join(__dirname, '..', '..', 'database', 'typeorm', 'core', 'migrations', '*.{ts,js}');
/** What ran, in order, across the cutover probe and the patch migration (case 7). */
const events: string[] = [];

describeIfDb('cross-upgrade lists and patch resume of a failed .0 step (integration)', () => {
  const { adminUrl, appUrl } = RUN ? integrationTestDatabase() : ({} as never);
  let admin: Client;
  let app: Client;
  let session: UpgradeSession;
  const created: SeededWorkspace[] = [];
  const seeded: string[] = [];
  const lines: string[] = [];
  let w: SeededWorkspace;
  let seq = 0;
  /** The "backup marker" of the probe: absent → the cutover refuses (as the real NO_BACKUP). */
  let backup = false;
  let cutoverRuns = 0;

  /** As hws-cutover.ts enter(): role crewflow, search_path pg_catalog, the tenant bound to exactly this workspace. */
  const inTenant = async (q: Query, ws: SeededWorkspace, sql: string, params: unknown[]) => {
    await q('BEGIN');
    try {
      const [r] = (await q(`SELECT current_user IN ('crewflow'::name, 'rab_secure_owner'::name) AS allowed`)) as Array<{ allowed: boolean }>;
      if (!r?.allowed) await q(`SELECT pg_catalog.set_config('role', 'crewflow', true)`);
      await q(`SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true)`);
      await q(`SELECT pg_catalog.set_config('rab.organisation_id', $1, true), pg_catalog.set_config('rab.workspace_id', $2, true)`, [ws.org, ws.id]);
      await q(sql, params);
      await q('COMMIT');
    } catch (error) {
      await q('ROLLBACK').catch(() => undefined);
      throw error;
    }
  };
  const PENDING = upgradeBlockMarker('HwsCutover', 'HWS_CUTOVER_PENDING');
  /** The probe, shaped like the C3 cutover: block first, refuse without a backup (block kept), lift its own block on success. */
  const probe = (target: () => SeededWorkspace): UpgradeCommand => ({
    name: 'ProbeHwsCutover',
    timestamp: T0,
    run: async (ctx) => {
      cutoverRuns += 1;
      const [m] = (await ctx.query('SELECT EXISTS (SELECT 1 FROM core.migrations WHERE name = $1) AS applied', [PATCH_MIGRATION])) as Array<{ applied: boolean }>;
      events.push(`cutover(patch migration applied=${m?.applied === true})`);
      const ws = target();
      await inTenant(ctx.query, ws, 'UPDATE core.workspace_schema_registry SET migration_error = $2 WHERE workspace_id = $1', [ws.id, PENDING]);
      ctx.markBlockChanged?.();
      if (!backup) throw Object.assign(new Error('probe cutover refused: no verified backup'), { name: 'HwsCutoverRefused' });
      await inTenant(ctx.query, ws, 'UPDATE core.workspace_schema_registry SET migration_error = NULL WHERE workspace_id = $1 AND migration_error = $2', [ws.id, PENDING]);
      ctx.markBlockChanged?.();
    },
  });

  const make = async (n: string): Promise<SeededWorkspace> => {
    seq += 1;
    const ws = await seedWorkspace(admin, `cu-${n}-${SFX}-${String.fromCharCode(97 + seq)}`);
    created.push(ws);
    expect(await provisionTypeScript(adminUrl, ws, { workspaceRegistry: FROZEN_TEMPLATE_REGISTRY })).toBe('READY');
    return ws;
  };
  /** Adoption on 0.6.0 + this code's real 0.6.0 workspace commands: the workspace has finished 0.6.0. */
  const finish060 = (ids: string[]) =>
    new WorkspaceCommandRunner({ codeVersion: '0.6.0', versions: ['0.4.0', '0.5.0'], force: false, adopt: true, log: (l) => lines.push(l), workspaceIds: ids }).run(session);
  const instanceRows = async (name: string) =>
    (
      await admin.query(`SELECT status, attempt, executed_by_version AS v, forced FROM core.upgrade_migration WHERE workspace_id IS NULL AND name = $1 ORDER BY attempt`, [name])
    ).rows as Array<{ status: string; attempt: number; v: string; forced: boolean }>;
  const allRowCount = async () => Number((await admin.query('SELECT count(*)::int AS n FROM core.upgrade_migration')).rows[0].n);
  const dropNewerInstanceRows = () =>
    admin.query(`DELETE FROM core.upgrade_migration WHERE workspace_id IS NULL AND (name LIKE '0.7.0\\_%' OR name LIKE '0.7.1\\_%' OR name LIKE '0.7.2\\_%')`);
  const REGISTRY = () => ({ ...UPGRADE_COMMANDS, '0-7': [probe(() => w)] });
  const run = (codeVersion: '0.7.0' | '0.7.1' | '0.7.2', ids: string[], extra: { workspaceRegistry?: Record<string, readonly WorkspaceUpgradeCommand[]> } = {}) =>
    new UpgradeRun({
      codeVersion,
      previousVersions: codeVersion === '0.7.0' ? PREV_070 : codeVersion === '0.7.1' ? PREV_071 : PREV_072,
      upgradeFrom: UF,
      force: false,
      log: (l) => lines.push(l),
      registry: REGISTRY(),
      workspaceRegistry: extra.workspaceRegistry ?? WORKSPACE_UPGRADE_COMMANDS,
      workspaceRunner: { workspaceIds: ids },
    });
  const start = async (r: UpgradeRun, fresh = false) => {
    const decision = await r.beforeApply(session, { fresh, attribution: null, unrestrictedTarget: true });
    await r.afterApply(session);
    return decision;
  };
  /** The resolver every API / Worker workspace bind passes through (cache stubbed to "always ask Postgres"). */
  const resolveAs = async (ws: SeededWorkspace): Promise<string> => {
    const cache = { resolveSchema: (_id: string, fetch: () => Promise<unknown>) => fetch(), invalidate: async () => undefined } as unknown as WorkspaceMetadataCacheService;
    const c = new Client({ connectionString: appUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true)`, [ws.org, ws.id]);
      const manager = { query: (sql: string, params?: unknown[]) => c.query(sql, params).then((r) => r.rows) } as never;
      try {
        return await new SchemaResolverService(cache).resolve(manager, ws.id);
      } catch (error) {
        return error instanceof WorkspaceRoutingError ? `refused:${error.code}` : `error:${(error as Error).name}`;
      }
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
  };
  /** The /healthz state for this file's state: another spec file's workspace issue turns ok / behind into failed (ignored here). */
  const ownState = async (version: string) => {
    const s = await statusOf(version);
    expect((s.workspaces ?? []).filter((x) => created.some((c) => c.id === x.workspaceId))).toEqual([]);
    return s.state;
  };
  const statusOf = async (version: string) => {
    const c = new Client({ connectionString: appUrl });
    await c.connect();
    try {
      return await readUpgradeStatus(upgradeSessionOf(c), version, REGISTRY());
    } finally {
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
    w = await make('hws');
    expect((await finish060([w.id])).failures).toEqual([]);
  });

  afterAll(async () => {
    await dropNewerInstanceRows().catch(() => undefined);
    for (const id of seeded) await admin.query('DELETE FROM core.upgrade_migration WHERE id = $1', [id]).catch(() => undefined);
    await app?.query('SELECT pg_advisory_unlock($1::bigint)', [LOCK]).catch(() => undefined);
    for (const ws of created) {
      await admin.query('DELETE FROM core.upgrade_migration WHERE workspace_id = $1', [ws.id]).catch(() => undefined);
      await dropWorkspaceSchema(admin, ws.schema).catch(() => undefined);
      await admin.query(`UPDATE core.workspace_schema_registry SET status = 'FAILED', migration_error = NULL, module_version = LEAST(module_version, 20) WHERE workspace_id = $1`, [ws.id]).catch(() => undefined);
      await admin.query('DELETE FROM core.manager_workspace WHERE id = $1', [ws.id]).catch(() => undefined);
    }
    await app?.end();
    await admin?.end();
  });

  it('precondition: the workspace finished 0.6.0 and is served; no 0.7.x instance row', async () => {
    expect(await resolveAs(w)).toBe(w.schema);
    expect(await instanceRows(CUTOVER)).toEqual([]);
  });

  it('1. abuse: 0.7.1 before any 0.7.0 start cannot skip 0.7.0 (65, nothing written)', async () => {
    const count = await allRowCount();
    await expect(run('0.7.1', [w.id]).beforeApply(session, { fresh: false, attribution: null, unrestrictedTarget: true })).rejects.toBeInstanceOf(UpgradeVersionTooOldError);
    expect(await allRowCount()).toBe(count);
    expect(cutoverRuns).toBe(0);
  });

  it('2. 0.7.0 from 0.6.0 (on its list): the cutover fails (attempt 1) and the workspace is BLOCKED (503 "being upgraded")', async () => {
    const r = run('0.7.0', [w.id]);
    expect(await start(r)).toMatchObject({ kind: 'continue', from: '0.6.0' });
    expect(r.report.commandFailure).toMatchObject({ name: CUTOVER, errorName: 'HwsCutoverRefused' });
    expect(r.report.commandBlockChanged).toBe(true);
    expect(r.report.workspaces).toBeNull(); // a failed instance command stops the start before the workspace pass
    expect(await instanceRows('0.7.0_TypeOrmMigrations')).toEqual([{ status: 'completed', attempt: 1, v: '0.7.0', forced: false }]);
    expect(await instanceRows(CUTOVER)).toEqual([{ status: 'failed', attempt: 1, v: '0.7.0', forced: false }]);
    expect((await registryOf(admin, w.id)).migration_error).toBe(PENDING);
    expect(await resolveAs(w)).toBe('refused:upgrading');
  });

  it('3. abuse: a READY workspace with no logbook row stops the resume (a patch never adopts): 0.7.1 refuses 65, nothing written', async () => {
    const orphan = await make('norow');
    try {
      const count = await allRowCount();
      await expect(run('0.7.1', [w.id, orphan.id]).beforeApply(session, { fresh: false, attribution: null, unrestrictedTarget: true })).rejects.toBeInstanceOf(
        UpgradeVersionTooOldError,
      );
      expect(await allRowCount()).toBe(count);
    } finally {
      await admin.query(`UPDATE core.workspace_schema_registry SET status = 'FAILED' WHERE workspace_id = $1`, [orphan.id]);
    }
  });

  it('4. 0.7.1 without a backup: resumes 0.7.0, the cutover fails again under its 0.7.0 name (attempt 2, by 0.7.1); still BLOCKED', async () => {
    const r = run('0.7.1', [w.id]);
    const decision = await start(r);
    expect(decision).toMatchObject({ kind: 'continue', from: '0.7.0' });
    expect(decision.reason).toMatch(/0\.7\.1 resumes its incomplete steps under their own names/);
    expect(r.report.recorded).toEqual([{ name: CUTOVER, status: 'failed', attempt: 2 }]);
    expect(await instanceRows(CUTOVER)).toEqual([
      { status: 'failed', attempt: 1, v: '0.7.0', forced: false },
      { status: 'failed', attempt: 2, v: '0.7.1', forced: false },
    ]);
    // The patch's own migrations step is not recorded while its .0 is not resumed (the .0's commands run before the patch's
    // migrations, order invariant; case 7 proves it with a real migration); 0.7.0's migrations step is not re-recorded.
    expect(await instanceRows('0.7.1_TypeOrmMigrations')).toEqual([]);
    expect(await instanceRows('0.7.0_TypeOrmMigrations')).toHaveLength(1);
    expect((await registryOf(admin, w.id)).migration_error).toBe(PENDING);
    expect(await resolveAs(w)).toBe('refused:upgrading');
    // Review R2: exactly 'failed' (the .0's failed step is read for the patch; without it this state reads 'behind').
    expect(await ownState('0.7.1')).toBe('failed');
  });

  it("4b. /healthz: the patch's own last step completed but a .0 step's latest attempt failed → 'failed' (not 'ok')", async () => {
    const seededRow = await admin.query(
      `INSERT INTO core.upgrade_migration (name, status, attempt, executed_by_version, is_initial) VALUES ('0.7.1_TypeOrmMigrations', 'completed', 1, '0.7.1', false) RETURNING id`,
    );
    try {
      expect(await instanceRows(CUTOVER)).toHaveLength(2);
      expect(await ownState('0.7.1')).toBe('failed');
    } finally {
      await admin.query('DELETE FROM core.upgrade_migration WHERE id = $1', [seededRow.rows[0].id]);
    }
  });

  it('5. 0.7.1 with the backup: the cutover completes (attempt 3, by 0.7.1), then 0.7.1_TypeOrmMigrations; UNBLOCKED; /healthz ok', async () => {
    backup = true;
    const r = run('0.7.1', [w.id]);
    // 0.7.1 was started (its failed retry row is executed_by 0.7.1): the repeated start continues as a retry of 0.7.1.
    expect(await start(r)).toMatchObject({ kind: 'continue', from: '0.7.1' });
    expect(r.report.commandFailure).toBeNull();
    expect(r.report.recorded).toEqual([
      { name: CUTOVER, status: 'completed', attempt: 3 },
      { name: '0.7.1_TypeOrmMigrations', status: 'completed', attempt: 1 },
    ]);
    expect(await instanceRows(CUTOVER)).toEqual([
      { status: 'failed', attempt: 1, v: '0.7.0', forced: false },
      { status: 'failed', attempt: 2, v: '0.7.1', forced: false },
      { status: 'completed', attempt: 3, v: '0.7.1', forced: false },
    ]);
    expect(r.report.workspaces).toMatchObject({ total: 1, failures: [], blocked: [] });
    expect((await registryOf(admin, w.id)).migration_error).toBeNull();
    expect(await resolveAs(w)).toBe(w.schema);
    const s = await statusOf('0.7.1');
    const foreign = (s.workspaces ?? []).filter((x) => !created.some((c) => c.id === x.workspaceId));
    expect((s.workspaces ?? []).filter((x) => x.workspaceId === w.id)).toEqual([]);
    expect(s.state).toBe(foreign.length ? 'failed' : 'ok');

    // A further start: everything complete, nothing re-run, nothing recorded.
    const runs = cutoverRuns;
    const again = run('0.7.1', [w.id]);
    expect(await start(again)).toMatchObject({ kind: 'continue', from: '0.7.0' });
    expect(again.report.recorded).toEqual([]);
    expect(cutoverRuns).toBe(runs);
  });

  it('6. a failed 0.7.0 WORKSPACE step is retried by 0.7.1 under its 0.7.0 name (executed_by 0.7.1)', async () => {
    await dropNewerInstanceRows(); // the database is back at 0.6.0 for a clean 0.7.0 start
    backup = true;
    const v = await make('wsstep');
    expect((await finish060([v.id])).failures).toEqual([]);
    let fail = true;
    const followUp: WorkspaceUpgradeCommand = {
      kind: 'workspace',
      name: 'ProbeCutoverFollowUp',
      timestamp: T0 + 1,
      run: async ({ query, schemaName }) => {
        await query(`SELECT count(*) FROM ${schemaName}.venue`);
        if (fail) throw new Error('follow-up not yet');
      },
    };
    const step = `0.7.0_ProbeCutoverFollowUp_${T0 + 1}`;
    const workspaceRegistry = { ...WORKSPACE_UPGRADE_COMMANDS, '0-7': [followUp] };
    const target = w;
    w = v; // the probe cutover works on this workspace now
    try {
      const at070 = run('0.7.0', [v.id], { workspaceRegistry });
      expect(await start(at070)).toMatchObject({ kind: 'continue', from: '0.6.0' });
      expect(at070.report.workspaces?.failures.map((f) => f.step)).toEqual([step]);
      const wsRows = async () =>
        (await admin.query(`SELECT status, attempt, executed_by_version AS v FROM core.upgrade_migration WHERE workspace_id = $1 AND name = $2 ORDER BY attempt`, [v.id, step])).rows;
      expect(await wsRows()).toEqual([{ status: 'failed', attempt: 1, v: '0.7.0' }]);

      fail = false;
      const at071 = run('0.7.1', [v.id], { workspaceRegistry });
      expect(await start(at071)).toMatchObject({ kind: 'continue', from: '0.7.0' });
      expect(at071.report.workspaces).toMatchObject({ total: 1, failures: [], blocked: [] });
      expect(await wsRows()).toEqual([
        { status: 'failed', attempt: 1, v: '0.7.0' },
        { status: 'completed', attempt: 2, v: '0.7.1' },
      ]);
      expect(await resolveAs(v)).toBe(v.schema);
    } finally {
      w = target;
      await dropNewerInstanceRows();
    }
  });

  describe('7. the order invariant through the real locked start, with a real patch-only migration (review R1)', () => {
    class PatchProbeMigration implements MigrationInterface {
      name = PATCH_MIGRATION;
      async up(queryRunner: QueryRunner): Promise<void> {
        events.push('patch migration');
        await queryRunner.query('SELECT 1');
      }
      async down(): Promise<void> {
        // nothing to undo
      }
    }
    /**
     * The real migrate-on-start child (its own UpgradeRun and hooks, deploy post-checks included) as a 0.7.1 image: the
     * testUpgrade seam sets the version, the published list and the registry with the cutover probe; the runner seam only adds
     * the patch migration to this code's chain.
     */
    const startPatch = async (force = false) => {
      const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, NODE_ENV: 'test', PG_DATABASE_URL: appUrl, CREWFLOW_MIGRATE_ON_START: 'true' };
      if (process.platform === 'win32' && process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
      return runMigrateOnStart(
        { migrationApprovalMode: 'none' },
        {
          env,
          log: (l) => lines.push(l),
          cacheFlush: async () => undefined,
          ...(force ? { upgradeForce: true as const } : {}),
          testUpgrade: { codeVersion: '0.7.1', previousVersions: PREV_071, upgradeFrom: UF, registry: REGISTRY() },
          testWorkspace: { registry: WORKSPACE_UPGRADE_COMMANDS, workspaceIds: [w.id] },
          runner: (options) =>
            runLockedMigrations({ ...options, dataSourceOverrides: { ...options.dataSourceOverrides, migrations: [MIGRATIONS_GLOB, PatchProbeMigration] } }),
        },
      );
    };
    const patchApplied = async () => Number((await admin.query('SELECT count(*)::int AS n FROM core.migrations WHERE name = $1', [PATCH_MIGRATION])).rows[0].n) === 1;

    beforeAll(async () => {
      await dropNewerInstanceRows();
      backup = false;
      // 0.7.0 (on the plain session, as before): its cutover fails, the workspace is blocked.
      const at070 = run('0.7.0', [w.id]);
      expect(await start(at070)).toMatchObject({ kind: 'continue', from: '0.6.0' });
      expect(await instanceRows(CUTOVER)).toEqual([{ status: 'failed', attempt: 1, v: '0.7.0', forced: false }]);
      // The real locked start takes the migration lock itself.
      await app.query('SELECT pg_advisory_unlock($1::bigint)', [LOCK]);
    });
    afterAll(async () => {
      await admin.query('DELETE FROM core.migrations WHERE name = $1', [PATCH_MIGRATION]).catch(() => undefined);
      await app.query('SELECT pg_advisory_lock($1::bigint)', [LOCK]);
      await dropNewerInstanceRows();
    });

    it('7a. 0.7.0 migrations step not completed → 65, nothing applied (no migration, no logbook row, cutover not run)', async () => {
      const seededRow = await admin.query(
        `INSERT INTO core.upgrade_migration (name, status, attempt, executed_by_version, is_initial) VALUES ('0.7.0_TypeOrmMigrations', 'failed', 2, '0.7.0', false) RETURNING id`,
      );
      try {
        const count = await allRowCount();
        const runs = cutoverRuns;
        const result = await startPatch();
        expect([result.outcome, STARTUP_EXIT_CODES[result.outcome]]).toEqual(['behind', 65]);
        expect(lines.some((l) => /FAILED \(behind\): UpgradeVersionTooOldError: .*0\.7\.0_TypeOrmMigrations is not completed/.test(l))).toBe(true);
        expect(await patchApplied()).toBe(false);
        expect(await allRowCount()).toBe(count);
        expect(cutoverRuns).toBe(runs);
      } finally {
        await admin.query('DELETE FROM core.upgrade_migration WHERE id = $1', [seededRow.rows[0].id]);
      }
    });

    it('7b. the cutover fails again BEFORE the patch migration → 66, the patch migration is NOT applied, the workspace stays blocked', async () => {
      events.length = 0;
      const from = lines.length;
      const result = await startPatch();
      expect([result.outcome, STARTUP_EXIT_CODES[result.outcome]]).toEqual(['migrationFailed', 66]);
      expect(lines.slice(from).some((l) => /FAILED \(migrationFailed\): MinorReleaseResumeFailedError: /.test(l))).toBe(true);
      // Review A: the 66 names the .0 command and its attempt, never a migration that did not run.
      expect(result.failedMigration ?? null).toBeNull();
      expect(lines.slice(from).some((l) => l.includes(`ERROR: the upgrade command ${CUTOVER} (attempt 2) failed again before any migration of this start`))).toBe(true);
      expect(lines.slice(from).some((l) => l.includes('the schema upgrade FAILED at'))).toBe(false);
      expect(events).toEqual(['cutover(patch migration applied=false)']);
      expect(result.upgrade?.recorded).toEqual([{ name: CUTOVER, status: 'failed', attempt: 2 }]);
      expect(await patchApplied()).toBe(false);
      expect(await instanceRows('0.7.1_TypeOrmMigrations')).toEqual([]);
      expect(await resolveAs(w)).toBe('refused:upgrading');
    });

    it('7b2. review B: under --force the failed retry goes on: the patch migration applies, the start serves degraded (70), rows forced, still blocked', async () => {
      events.length = 0;
      const result = await startPatch(true);
      expect([result.outcome, STARTUP_EXIT_CODES[result.outcome]]).toEqual(['degradedContinue', 70]);
      expect(events).toEqual(['cutover(patch migration applied=false)', 'patch migration']);
      expect(await patchApplied()).toBe(true);
      expect(result.upgrade?.commandFailure).toMatchObject({ name: CUTOVER });
      expect(result.upgrade?.recorded).toEqual([{ name: CUTOVER, status: 'failed', attempt: 3 }]);
      expect((await instanceRows(CUTOVER)).slice(-1)).toEqual([{ status: 'failed', attempt: 3, v: '0.7.1', forced: true }]);
      // A degraded start does not record the patch's own step; the blocked workspace stays 503.
      expect(await instanceRows('0.7.1_TypeOrmMigrations')).toEqual([]);
      expect(await resolveAs(w)).toBe('refused:upgrading');
    });

    it('7c. with the backup, after the --force start applied the migration: the retry runs (forced, WARNING), then 0.7.1_TypeOrmMigrations; unblocked', async () => {
      backup = true;
      events.length = 0;
      const from = lines.length;
      const result = await startPatch();
      expect([result.outcome, STARTUP_EXIT_CODES[result.outcome]]).toEqual(['ok', 0]);
      // Nothing pending: 7b2's --force start already applied the patch migration, so the retry runs on that schema.
      expect(events).toEqual(['cutover(patch migration applied=true)']);
      expect(lines.slice(from).some((l) => l.includes(`WARNING: ${CUTOVER} runs on a schema that an earlier --force start moved past 0.7.0`))).toBe(true);
      expect(await patchApplied()).toBe(true);
      expect(result.upgrade?.recorded).toEqual([
        { name: CUTOVER, status: 'completed', attempt: 4 },
        { name: '0.7.1_TypeOrmMigrations', status: 'completed', attempt: 1 },
      ]);
      expect(await instanceRows(CUTOVER)).toEqual([
        { status: 'failed', attempt: 1, v: '0.7.0', forced: false },
        { status: 'failed', attempt: 2, v: '0.7.1', forced: false },
        { status: 'failed', attempt: 3, v: '0.7.1', forced: true },
        // Final review: an earlier attempt was forced and nothing was pending → this retry is recorded forced too.
        { status: 'completed', attempt: 4, v: '0.7.1', forced: true },
      ]);
      expect(await instanceRows('0.7.1_TypeOrmMigrations')).toEqual([{ status: 'completed', attempt: 1, v: '0.7.1', forced: false }]);
      expect(await resolveAs(w)).toBe(w.schema);
    });
  });

  it('8. review O3: after a FRESH 0.7.1 whose 0.7.0 retry failed (rows by 0.7.1 only), 0.7.2 resumes 0.7.0 instead of refusing 65', async () => {
    await dropNewerInstanceRows();
    backup = false;
    await admin.query(`UPDATE core.workspace_schema_registry SET migration_error = NULL WHERE workspace_id = $1`, [w.id]);
    try {
      // A fresh-install decision on 0.7.1 (no previous-version check): 0.7.0's steps run after every migration, as 0.7.1.
      const fresh = run('0.7.1', [w.id]);
      expect((await start(fresh, true)).kind).toBe('fresh');
      expect(await instanceRows('0.7.0_TypeOrmMigrations')).toEqual([{ status: 'completed', attempt: 1, v: '0.7.1', forced: false }]);
      expect(await instanceRows(CUTOVER)).toEqual([{ status: 'failed', attempt: 1, v: '0.7.1', forced: false }]);
      expect(Number((await admin.query(`SELECT count(*)::int AS n FROM core.upgrade_migration WHERE workspace_id IS NULL AND executed_by_version = '0.7.0'`)).rows[0].n)).toBe(0);
      expect(await resolveAs(w)).toBe('refused:upgrading');

      backup = true;
      const at072 = run('0.7.2', [w.id]);
      expect(await start(at072)).toMatchObject({ kind: 'continue', from: '0.7.0' });
      expect(at072.report.recorded).toEqual([
        { name: CUTOVER, status: 'completed', attempt: 2 },
        { name: '0.7.2_TypeOrmMigrations', status: 'completed', attempt: 1 },
      ]);
      expect(await resolveAs(w)).toBe(w.schema);
    } finally {
      await dropNewerInstanceRows();
    }
  });
});
