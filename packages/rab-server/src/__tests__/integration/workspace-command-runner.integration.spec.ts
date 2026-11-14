import 'reflect-metadata';
import { Client } from 'pg';

import { resolveIntegrationTestDatabase } from '../../database/typeorm/core/test-database-guard';
import { MIGRATION_LOCK_KEY } from '../../database/typeorm/scripts/migrate/migration-lock';
import { EXPECTED_WORKSPACE_FINGERPRINTS, selectWorkspaceFingerprintsForServer } from '../../database/typeorm/workspace-schema/v1/expected-fingerprints';
import { LATEST_WORKSPACE_MODULE_VERSION } from '../../database/typeorm/workspace-schema/workspace-schema-modules';
import type { WorkspaceUpgradeCommand } from '../../engine/core-modules/upgrade/upgrade-commands/workspace-upgrade-command';
import { upgradeSessionOf, UpgradeSession } from '../../engine/core-modules/upgrade/upgrade-migration.service';
import { UpgradeRun } from '../../engine/core-modules/upgrade/upgrade-runner';
import { UpgradeVersionTooOldError } from '../../engine/core-modules/upgrade/upgrade-version-check';
import { WorkspaceCommandRunner, WorkspaceRunOptions } from '../../engine/core-modules/upgrade/workspace-command-runner';
import { dropWorkspaceSchema, provisionLegacyV14, provisionTypeScript, registryOf, SeededWorkspace, seedWorkspace } from './helpers/workspace-fixtures';

/**
 * OWNER-DB-ULTIMATE Part D: the workspace command runner on a real (disposable) database, through the one runtime login
 * (TEST_DATABASE_URL = crewflow_owner) holding the migration lock, exactly as the migrate-on-start child does. Workspaces are
 * built by the TypeScript provisioner (module 20 = the frozen template). Proves:
 *  - adoption (0.6.0): every READY workspace at module 20 with a matching structure gets ONE is_initial row; a behind or
 *    drifted workspace gets none (refused); a re-run writes nothing;
 *  - a 0.7.0 run: per workspace, a structural command (level 21, expected fingerprint) and a data command, ONE row each;
 *  - abuse: a failed workspace does not mark the others; a command cannot touch another workspace's schema (static name,
 *    dynamic DDL, dynamic DROP, dynamic DML, session re-bind, COMMIT); a structure mismatch refuses and rolls back;
 *  - idempotent after a crash between COMMIT and the logbook row; a workspace without a cursor is refused from 0.7.0;
 *  - --force marks rows forced; the previous-version check needs every workspace at the previous version's last workspace
 *    command (Twenty run-instance-commands.command.ts:124-168).
 * Everything written is removed by the cluster superuser afterwards.
 */
jest.setTimeout(300_000);

const RUN = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_DATABASE_URL_UNPOOLED);
const describeIfDb = RUN ? describe : describe.skip;
const SFX = Math.random().toString(36).replace(/[^a-z]/g, '').slice(0, 6) || 'x';
const LOCK = MIGRATION_LOCK_KEY.toString();
const T0 = 1786800000000;

describeIfDb('Part D workspace command runner (integration)', () => {
  const { adminUrl } = RUN ? resolveIntegrationTestDatabase(process.env) : ({} as never);
  let admin: Client;
  let app: Client;
  let session: UpgradeSession;
  const created: SeededWorkspace[] = [];
  const lines: string[] = [];
  let level21: string;

  let seq = 0;
  const make = async (n: string, provision: 'ts' | 'v14' = 'ts'): Promise<SeededWorkspace> => {
    seq += 1;
    const ws = await seedWorkspace(admin, `dr-${n}-${SFX}-${String.fromCharCode(97 + Math.floor(seq / 26))}${String.fromCharCode(97 + (seq % 26))}`);
    created.push(ws);
    if (provision === 'ts') expect(await provisionTypeScript(adminUrl, ws)).toBe('READY');
    else await provisionLegacyV14(adminUrl, ws);
    return ws;
  };
  const rows = async (ws: SeededWorkspace) =>
    (
      await admin.query(
        `SELECT name, status, attempt, is_initial, forced, executed_by_version FROM core.upgrade_migration WHERE workspace_id = $1 ORDER BY created_at, attempt`,
        [ws.id],
      )
    ).rows as Array<{ name: string; status: string; attempt: number; is_initial: boolean; forced: boolean; executed_by_version: string }>;
  const fingerprint = async (ws: SeededWorkspace) => (await admin.query('SELECT core.workspace_schema_fingerprint($1) AS f', [ws.id])).rows[0].f as string;
  const hasColumn = async (ws: SeededWorkspace, table: string, column: string) =>
    Number(
      (
        await admin.query(
          `SELECT count(*)::int AS n FROM pg_attribute WHERE attrelid = format('%I.%I', $1::text, $2::text)::regclass AND attname = $3 AND NOT attisdropped`,
          [ws.schema, table, column],
        )
      ).rows[0].n,
    ) === 1;
  const runner = (o: Partial<WorkspaceRunOptions> & Pick<WorkspaceRunOptions, 'workspaceIds'>) =>
    new WorkspaceCommandRunner({
      codeVersion: '0.7.0',
      versions: ['0.4.0', '0.5.0', '0.6.0'],
      force: false,
      adopt: false,
      log: (l) => lines.push(l),
      expectedFingerprint: (level) => (level === 21 ? level21 : EXPECTED_WORKSPACE_FINGERPRINTS[level]),
      ...o,
    }).run(session);
  const adopt = (ids: string[]) => runner({ codeVersion: '0.6.0', versions: ['0.4.0', '0.5.0'], adopt: true, workspaceIds: ids });
  const cmd = (name: string, i: number, body: Partial<WorkspaceUpgradeCommand>): WorkspaceUpgradeCommand => ({ kind: 'workspace', name, timestamp: T0 + i, ...body });
  const probeColumn: WorkspaceUpgradeCommand = cmd('AddProbeColumn', 0, {
    sql: (s) => `ALTER TABLE ${s}.venue ADD COLUMN IF NOT EXISTS d_probe text`,
    structure: { level: 21, fingerprints: {} },
  });
  /** Hex digits of a schema name reversed, so the static scan cannot see the name (the dynamic-SQL abuse cases). */
  const hidden = (ws: SeededWorkspace) => `'workspace_' || reverse('${ws.schema.slice('workspace_'.length).split('').reverse().join('')}')`;

  beforeAll(async () => {
    admin = new Client({ connectionString: adminUrl });
    app = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.connect();
    await app.connect();
    await selectWorkspaceFingerprintsForServer(async (sql) => (await admin.query(sql)).rows);
    await app.query('SELECT pg_advisory_lock($1::bigint)', [LOCK]);
    session = upgradeSessionOf(app);
    // The expected structure level 21 = the frozen template + the probe column, measured on a reference workspace and rolled back.
    const ref = await make('ref');
    await admin.query('BEGIN');
    await admin.query(probeColumn.sql!(ref.schema));
    level21 = await fingerprint(ref);
    await admin.query('ROLLBACK');
    expect(level21).not.toBe(EXPECTED_WORKSPACE_FINGERPRINTS[LATEST_WORKSPACE_MODULE_VERSION]);
  });

  afterAll(async () => {
    await app?.query('SELECT pg_advisory_unlock($1::bigint)', [LOCK]).catch(() => undefined);
    for (const ws of created) {
      await admin.query('DELETE FROM core.upgrade_migration WHERE workspace_id = $1', [ws.id]).catch(() => undefined);
      await dropWorkspaceSchema(admin, ws.schema).catch(() => undefined);
      await admin.query(`UPDATE core.workspace_schema_registry SET status = 'FAILED', module_version = LEAST(module_version, 20) WHERE workspace_id = $1`, [ws.id]).catch(() => undefined);
      await admin.query('DELETE FROM core.manager_workspace WHERE id = $1', [ws.id]).catch(() => undefined);
    }
    await admin.query(`DELETE FROM core.upgrade_migration WHERE workspace_id IS NULL AND name LIKE '0.7.0_%' AND executed_by_version = '0.7.0'`).catch(() => undefined);
    await app?.end();
    await admin?.end();
  });

  it('the runner session is the one runtime login holding the migration lock', async () => {
    expect((await app.query('SELECT current_user::text AS u')).rows[0].u).toBe('crewflow_owner');
  });

  it('adoption (0.6.0): READY workspaces at module 20 get ONE is_initial row; behind / drifted get none; a re-run writes nothing', async () => {
    const a = await make('ad-a');
    const b = await make('ad-b');
    const drift = await make('ad-drift');
    const legacy = await make('ad-v14', 'v14');
    await admin.query(`DROP POLICY job_role_tenant ON ${drift.schema}.job_role`);

    // Through UpgradeRun (the migrate child's hooks): the previous-version check, then afterApply's workspace pass.
    const run = new UpgradeRun({ codeVersion: '0.6.0', force: false, log: (l) => lines.push(l), workspaceRunner: { workspaceIds: [a.id, b.id, drift.id, legacy.id] } });
    await run.beforeApply(session, { fresh: false, attribution: null, unrestrictedTarget: true });
    await run.afterApply(session);
    for (const ws of [a, b]) {
      expect(await rows(ws)).toEqual([{ name: '0.6.0_TypeOrmMigrations', status: 'completed', attempt: 1, is_initial: true, forced: false, executed_by_version: '0.6.0' }]);
    }
    expect(await rows(drift)).toEqual([]);
    expect(await rows(legacy)).toEqual([]);
    expect(run.report.workspaces).toMatchObject({ total: 4, adopted: 2 });
    const failures = Object.fromEntries(run.report.workspaces!.failures.map((f) => [f.workspaceId, f.errorClass]));
    expect(['VERIFY_FAILED', 'FINGERPRINT_MISMATCH']).toContain(failures[drift.id]);
    expect(failures[legacy.id]).toBe('BEHIND');
    expect(run.report.commandFailure).toMatchObject({ name: '0.6.0_WorkspaceAdoption' });

    const again = await adopt([a.id, b.id, drift.id]);
    expect(again.outcomes.find((o) => o.workspaceId === a.id)!.status).toBe('up-to-date');
    expect((await rows(a)).length).toBe(1);
    expect(again.failures.map((f) => f.workspaceId)).toEqual([drift.id]);
  });

  it('0.7.0: a structural and a data command run once per workspace, ONE row each, level 21; a failed workspace does not mark the others', async () => {
    const [a, b, c] = [await make('r-a'), await make('r-b'), await make('r-c')];
    await adopt([a.id, b.id, c.id]);
    let failB = true;
    const countVenues = cmd('CountVenues', 1, {
      run: async ({ query, schemaName, workspaceId }) => {
        await query(`SELECT count(*) FROM ${schemaName}.venue`);
        if (failB && workspaceId === b.id) throw new Error('boom for b only');
      },
    });
    const registry = { '0-7': [probeColumn, countVenues] };
    const first = await runner({ workspaceRegistry: registry, workspaceIds: [a.id, b.id, c.id] });
    expect(first.failures.map((f) => [f.workspaceId, f.step, f.attempt])).toEqual([[b.id, `0.7.0_CountVenues_${T0 + 1}`, 1]]);
    for (const ws of [a, c]) {
      expect((await rows(ws)).slice(1).map((r) => [r.name, r.status, r.attempt])).toEqual([
        [`0.7.0_AddProbeColumn_${T0}`, 'completed', 1],
        [`0.7.0_CountVenues_${T0 + 1}`, 'completed', 1],
      ]);
      expect(await hasColumn(ws, 'venue', 'd_probe')).toBe(true);
      expect((await registryOf(admin, ws.id)).module_version).toBe(21);
      expect(await fingerprint(ws)).toBe(level21);
    }
    expect((await rows(b)).slice(1).map((r) => [r.name, r.status, r.attempt])).toEqual([
      [`0.7.0_AddProbeColumn_${T0}`, 'completed', 1],
      [`0.7.0_CountVenues_${T0 + 1}`, 'failed', 1],
    ]);
    expect((await admin.query(`SELECT error_message FROM core.upgrade_migration WHERE workspace_id = $1 AND status = 'failed'`, [b.id])).rows[0].error_message).toBe(
      'Error: boom for b only',
    );

    failB = false;
    const second = await runner({ workspaceRegistry: registry, workspaceIds: [a.id, b.id, c.id] });
    expect(second.failures).toEqual([]);
    expect((await rows(b)).slice(-1)[0]).toMatchObject({ name: `0.7.0_CountVenues_${T0 + 1}`, status: 'completed', attempt: 2 });
    expect((await rows(a)).length).toBe(3);
    expect(second.outcomes.find((o) => o.workspaceId === a.id)!.status).toBe('up-to-date');
  });

  it('a structure mismatch refuses: a data command that changes the structure is rolled back and recorded failed', async () => {
    const [a, b] = [await make('sm-a'), await make('sm-b')];
    await adopt([a.id, b.id]);
    const before = await fingerprint(a);
    const sneaky = cmd('SneakyDdl', 2, { sql: (s) => `ALTER TABLE ${s}.venue ADD COLUMN sneaky text` });
    const out = await runner({ workspaceRegistry: { '0-7': [sneaky] }, workspaceIds: [a.id, b.id] });
    expect(out.failures.map((f) => f.errorClass)).toEqual(['FINGERPRINT_MISMATCH', 'FINGERPRINT_MISMATCH']);
    expect(await hasColumn(a, 'venue', 'sneaky')).toBe(false);
    expect(await fingerprint(a)).toBe(before);
    expect((await registryOf(admin, a.id)).module_version).toBe(20);
    // A structural command whose result is not its declared level is refused the same way.
    const c = await make('sm-c');
    await adopt([c.id]);
    const wrong = cmd('WrongLevel', 3, { sql: (s) => `ALTER TABLE ${s}.venue ADD COLUMN IF NOT EXISTS other_col text`, structure: { level: 21, fingerprints: {} } });
    const out2 = await runner({ workspaceRegistry: { '0-7': [wrong] }, workspaceIds: [c.id] });
    expect(out2.failures.map((f) => f.errorClass)).toEqual(['FINGERPRINT_MISMATCH']);
    expect(await hasColumn(c, 'venue', 'other_col')).toBe(false);
    expect((await registryOf(admin, c.id)).module_version).toBe(20);
  });

  describe("abuse: a workspace's command cannot touch another workspace's schema", () => {
    // A fresh pair per case: each case has its own registry, so a cursor from another case would be unknown to it.
    let x: SeededWorkspace;
    let y: SeededWorkspace;
    beforeEach(async () => {
      x = await make('ab-x');
      y = await make('ab-y');
      await adopt([x.id, y.id]);
      await admin.query(`INSERT INTO ${y.schema}.job_role (organisation_id, name, workspace_id) VALUES ($1, 'y-role', $2)`, [y.org, y.id]);
    });
    const evil = async (name: string, i: number, body: (ctx: { query: (s: string, p?: unknown[]) => Promise<unknown[]> }) => Promise<void>) => {
      const yBefore = await fingerprint(y);
      const yRoles = (await admin.query(`SELECT name FROM ${y.schema}.job_role ORDER BY name`)).rows;
      const out = await runner({
        workspaceRegistry: { '0-7': [cmd(name, i, { run: async (ctx) => (ctx.workspaceId === x.id ? body(ctx) : undefined) })] },
        workspaceIds: [x.id, y.id],
      });
      expect(await fingerprint(y)).toBe(yBefore);
      expect((await admin.query(`SELECT name FROM ${y.schema}.job_role ORDER BY name`)).rows).toEqual(yRoles);
      // y's own run of the same step is unaffected (a failed workspace does not mark the others).
      expect(out.outcomes.find((o) => o.workspaceId === y.id)!.completed).toEqual([`0.7.0_${name}_${T0 + i}`]);
      return out.failures.filter((f) => f.workspaceId === x.id).map((f) => f.errorClass);
    };

    it('layer 1: SQL naming the other schema is refused before it runs', async () => {
      expect(await evil('StaticName', 10, async ({ query }) => void (await query(`ALTER TABLE ${y.schema}.venue ADD COLUMN evil text`)))).toEqual(['FOREIGN_SCHEMA_NAME']);
      expect(await hasColumn(y, 'venue', 'evil')).toBe(false);
    });

    it('layer 4: dynamic DDL on the other schema (new column) is detected and rolled back', async () => {
      const sql = `DO $$ BEGIN EXECUTE format('ALTER TABLE %I.venue ADD COLUMN evil2 text', ${hidden(y)}); END $$`;
      expect(await evil('DynamicAddColumn', 11, async ({ query }) => void (await query(sql)))).toEqual(['OUTSIDE_SCHEMA']);
      expect(await hasColumn(y, 'venue', 'evil2')).toBe(false);
    });

    it('layer 4: a dynamic DROP POLICY on the other schema (no xmin left) is detected by the counts and rolled back', async () => {
      const sql = `DO $$ BEGIN EXECUTE format('DROP POLICY job_role_tenant ON %I.job_role', ${hidden(y)}); END $$`;
      expect(await evil('DynamicDropPolicy', 12, async ({ query }) => void (await query(sql)))).toEqual(['OUTSIDE_SCHEMA']);
    });

    it('layer 4: a dynamic GRANT on the other schema is detected and rolled back', async () => {
      const sql = `DO $$ BEGIN EXECUTE format('GRANT SELECT ON %I.venue TO PUBLIC', ${hidden(y)}); END $$`;
      expect(await evil('DynamicGrant', 13, async ({ query }) => void (await query(sql)))).toEqual(['OUTSIDE_SCHEMA']);
    });

    it('layer 2: dynamic DML into the other workspace changes nothing (FORCE RLS on the bound workspace)', async () => {
      const upd = `DO $$ BEGIN EXECUTE format('UPDATE %I.job_role SET name = ''hacked''', ${hidden(y)}); END $$`;
      expect(await evil('DynamicUpdate', 14, async ({ query }) => void (await query(upd)))).toEqual([]);
    });

    it('layer 2: a dynamic INSERT into the other workspace is refused by its RLS WITH CHECK (or its binding CHECK)', async () => {
      const ins = `DO $$ BEGIN EXECUTE format('INSERT INTO %I.job_role (organisation_id, name, workspace_id) VALUES (%L, ''planted'', %L)', ${hidden(y)}, '${y.org}', '${y.id}'); END $$`;
      const classes = await evil('DynamicInsert', 15, async ({ query }) => void (await query(ins)));
      expect(classes).toHaveLength(1);
      expect(['SQLSTATE_42501', 'SQLSTATE_23514']).toContain(classes[0]);
    });

    it('layer 3: re-binding the tenant mid-step is refused', async () => {
      expect(await evil('Rebind', 16, async ({ query }) => void (await query(`SELECT pg_catalog.set_config('rab.workspace_id', $1, true)`, [y.id])))).toEqual(['SESSION_CHANGED']);
    });

    it('layer 3: committing mid-step is refused', async () => {
      expect(await evil('Commit', 17, async ({ query }) => void (await query('COMMIT')))).toEqual(['SESSION_CHANGED']);
    });

    it('a foreign key from the workspace to a core table is NOT an outside change (internal RI triggers allowed)', async () => {
      const fk = cmd('FkToCore', 18, {
        run: async ({ query, schemaName, workspaceId }) => {
          if (workspaceId !== x.id) return;
          await query(`ALTER TABLE ${schemaName}.venue ADD COLUMN fk_probe uuid REFERENCES core."user"(id)`);
        },
      });
      const out = await runner({ workspaceRegistry: { '0-7': [fk] }, workspaceIds: [x.id] });
      // The isolation layer passes; the structure check then refuses (undeclared DDL), so it is rolled back either way.
      expect(out.failures.map((f) => f.errorClass)).toEqual(['FINGERPRINT_MISMATCH']);
    });
  });

  it('idempotent after a crash between COMMIT and the logbook row: the step re-runs and completes', async () => {
    const w = await make('crash');
    await adopt([w.id]);
    // Simulate: the command committed (column + level 21) but its row was never written.
    await admin.query('BEGIN');
    await admin.query(probeColumn.sql!(w.schema));
    await admin.query(`UPDATE core.workspace_schema_registry SET module_version = 21 WHERE workspace_id = $1`, [w.id]);
    await admin.query('COMMIT');
    const out = await runner({ workspaceRegistry: { '0-7': [probeColumn] }, workspaceIds: [w.id] });
    expect(out.failures).toEqual([]);
    expect((await rows(w)).slice(1).map((r) => [r.name, r.status, r.attempt])).toEqual([[`0.7.0_AddProbeColumn_${T0}`, 'completed', 1]]);
    expect(await fingerprint(w)).toBe(level21);
  });

  it('from 0.7.0 a workspace without a cursor is refused (NO_CURSOR); --force marks every row forced', async () => {
    const none = await make('nocursor');
    const out = await runner({ workspaceRegistry: { '0-7': [probeColumn] }, workspaceIds: [none.id] });
    expect(out.failures.map((f) => f.errorClass)).toEqual(['NO_CURSOR']);
    expect(await rows(none)).toEqual([]);
    expect(await hasColumn(none, 'venue', 'd_probe')).toBe(false);

    const f = await make('forced');
    await adopt([f.id]);
    await runner({ workspaceRegistry: { '0-7': [probeColumn] }, workspaceIds: [f.id], force: true });
    expect((await rows(f)).slice(1).map((r) => [r.name, r.forced])).toEqual([[`0.7.0_AddProbeColumn_${T0}`, true]]);
  });

  it('previous-version check: 0.8.0 refuses (65) until every workspace completed 0.7.0\'s last workspace command; --force skips it', async () => {
    const [a, b] = [await make('pv-a'), await make('pv-b')];
    await adopt([a.id, b.id]);
    let fail = true;
    const registry = { '0-7': [probeColumn, cmd('Last07', 1, { run: async ({ workspaceId }) => { if (fail && workspaceId === b.id) throw new Error('b not yet'); } })] };
    await runner({ workspaceRegistry: registry, workspaceIds: [a.id, b.id] });
    await admin.query(`INSERT INTO core.upgrade_migration (name, status, attempt, executed_by_version) VALUES ('0.7.0_TypeOrmMigrations', 'completed', 1, '0.7.0')`);
    const at = (force: boolean) =>
      new UpgradeRun({ codeVersion: '0.8.0', previousVersions: ['0.6.0', '0.7.0'], force, log: (l) => lines.push(l), workspaceRegistry: registry, workspaceRunner: { workspaceIds: [a.id, b.id] } }).beforeApply(session, {
        fresh: false,
        attribution: null,
        unrestrictedTarget: true,
      });
    await expect(at(false)).rejects.toBeInstanceOf(UpgradeVersionTooOldError);
    expect((await at(true)).kind).toBe('forced');
    fail = false;
    await runner({ workspaceRegistry: registry, workspaceIds: [a.id, b.id] });
    expect(await at(false)).toMatchObject({ kind: 'continue', from: '0.7.0' });
  });
});
