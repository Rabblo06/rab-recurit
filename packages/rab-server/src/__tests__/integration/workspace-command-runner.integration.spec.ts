import 'reflect-metadata';
import { Client } from 'pg';

import { resolveIntegrationTestDatabase } from '../../database/typeorm/core/test-database-guard';
import { MIGRATION_LOCK_KEY } from '../../database/typeorm/scripts/migrate/migration-lock';
import { EXPECTED_WORKSPACE_FINGERPRINTS, selectWorkspaceFingerprintsForServer } from '../../database/typeorm/workspace-schema/v1/expected-fingerprints';
import { LATEST_WORKSPACE_MODULE_VERSION } from '../../database/typeorm/workspace-schema/workspace-schema-modules';
import type { WorkspaceUpgradeCommand } from '../../engine/core-modules/upgrade/upgrade-commands/workspace-upgrade-command';
import { countFailedWorkspaceCursors, upgradeSessionOf, UpgradeSession, withUpgradeScope } from '../../engine/core-modules/upgrade/upgrade-migration.service';
import { TARGET_EXTRA_STRUCTURE_SQL } from '../../engine/core-modules/upgrade/workspace-step-checks-sql';
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
    const t0 = Date.now();
    const first = await runner({ workspaceRegistry: registry, workspaceIds: [a.id, b.id, c.id] });
    const pgClass = Number((await admin.query('SELECT count(*)::int AS n FROM pg_class')).rows[0].n);
    // eslint-disable-next-line no-console
    console.log(`[drunner-timing] 3 workspaces x 2 steps (incl. listing, cursors, rows): ${Date.now() - t0} ms; pg_class rows: ${pgClass}`);
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
      // The isolation layer passes (no OUTSIDE_SCHEMA); the structure check then refuses the undeclared DDL (the verify
      // function's fixed FK count, or the fingerprint), so it is rolled back either way.
      expect(out.failures).toHaveLength(1);
      expect(['VERIFY_FAILED', 'FINGERPRINT_MISMATCH']).toContain(out.failures[0]!.errorClass);
      expect(await hasColumn(x, 'venue', 'fk_probe')).toBe(false);
    });
  });

  describe('review M1: data and role-catalog writes outside the schema (layer 4b)', () => {
    let x: SeededWorkspace;
    let y: SeededWorkspace;
    beforeEach(async () => {
      x = await make('m1-x');
      y = await make('m1-y');
      await adopt([x.id, y.id]);
      await admin.query(`INSERT INTO ${y.schema}.job_role (organisation_id, name, workspace_id) VALUES ($1, 'y-role', $2)`, [y.org, y.id]);
    });
    const step = async (name: string, i: number, body: (q: (s: string, p?: unknown[]) => Promise<unknown[]>) => Promise<void>) => {
      const out = await runner({
        workspaceRegistry: { '0-7': [cmd(name, i, { run: async (ctx) => (ctx.workspaceId === x.id ? body(ctx.query) : undefined) })] },
        workspaceIds: [x.id, y.id],
      });
      expect(out.outcomes.find((o) => o.workspaceId === y.id)!.completed).toEqual([`0.7.0_${name}_${T0 + i}`]);
      expect((await app.query(`SELECT pg_catalog.current_setting('role') AS r, current_user = session_user AS same`)).rows[0]).toEqual({ r: 'none', same: true });
      return out.failures.filter((f) => f.workspaceId === x.id);
    };
    const members = async () =>
      Number((await admin.query(`SELECT count(*)::int AS n FROM pg_auth_members WHERE roleid = 'crewflow'::regrole AND member = 'crewflow_app'::regrole`)).rows[0].n);

    it('re-binding to the other workspace, updating its rows and restoring the binding is refused; its rows are unchanged', async () => {
      const f = await step('RebindWrite', 30, async (q) => {
        await q(`SELECT pg_catalog.set_config('rab.organisation_id', $1, true), pg_catalog.set_config('rab.workspace_id', $2, true)`, [y.org, y.id]);
        await q(`DO $$ BEGIN EXECUTE format('UPDATE %I.job_role SET name = ''hacked''', ${hidden(y)}); END $$`);
        await q(`SELECT pg_catalog.set_config('rab.organisation_id', $1, true), pg_catalog.set_config('rab.workspace_id', $2, true)`, [x.org, x.id]);
      });
      expect(f.map((o) => o.errorClass)).toEqual(['OUTSIDE_SCHEMA']);
      expect((await admin.query(`SELECT name FROM ${y.schema}.job_role`)).rows).toEqual([{ name: 'y-role' }]);
    });

    it('RESET ROLE; GRANT crewflow TO crewflow_app; SET ROLE crewflow is refused; pg_auth_members unchanged', async () => {
      const before = await members();
      const f = await step('RoleGrant', 31, async (q) => {
        await q('RESET ROLE');
        await q('GRANT crewflow TO crewflow_app');
        await q('SET ROLE crewflow');
      });
      expect(f).toHaveLength(1);
      // OUTSIDE_SCHEMA when the GRANT went through (then rolled back), SQLSTATE_42501 when the login may not grant it.
      expect(['OUTSIDE_SCHEMA', 'SQLSTATE_42501']).toContain(f[0]!.errorClass);
      // eslint-disable-next-line no-console
      console.log(`[drunner-m1] RESET ROLE + GRANT outcome: ${f[0]!.errorClass}`);
      expect(await members()).toBe(before);
    });

    it('ALTER ROLE CURRENT_USER SET (pg_db_role_setting) is refused and rolled back', async () => {
      const f = await step('RoleSetting', 32, async (q) => void (await q(`ALTER ROLE CURRENT_USER SET work_mem = '7MB'`)));
      expect(f.map((o) => o.errorClass)).toEqual(['OUTSIDE_SCHEMA']);
      expect(Number((await admin.query(`SELECT count(*)::int AS n FROM pg_db_role_setting WHERE 'work_mem=7MB' = ANY(setconfig)`)).rows[0].n)).toBe(0);
    });

    it('a forged logbook row (scope set, tenant unbound, then restored) is refused; no row is left', async () => {
      const forged = `0.7.0_Forged_${T0 + 99}`;
      // As crewflow the INSERT is refused by privileges (42501); a real forge first drops back to the login (crewflow_owner,
      // which reaches the logbook through rab_secure_owner) and the session's migration lock, then restores everything.
      const f = await step('ForgeRow', 33, async (q) => {
        await q('RESET ROLE');
        await q(`SELECT pg_catalog.set_config('rab.upgrade_scope', 'upgrade', true), pg_catalog.set_config('rab.organisation_id', '', true)`);
        await q(`INSERT INTO core.upgrade_migration (name, status, attempt, executed_by_version, workspace_id) VALUES ($1, 'completed', 1, '0.7.0', $2)`, [forged, y.id]);
        await q(`SELECT pg_catalog.set_config('rab.upgrade_scope', '', true), pg_catalog.set_config('rab.organisation_id', $1, true)`, [x.org]);
        await q(`SELECT pg_catalog.set_config('role', 'crewflow', true)`);
      });
      expect(f.map((o) => o.errorClass)).toEqual(['OUTSIDE_SCHEMA']);
      expect(Number((await admin.query('SELECT count(*)::int AS n FROM core.upgrade_migration WHERE name = $1', [forged])).rows[0].n)).toBe(0);
    });

    it('updating a core table row of its own organisation is refused and rolled back', async () => {
      const f = await step('CoreWrite', 34, async (q) => void (await q(`UPDATE core."user" SET last_name = 'changed-by-step' WHERE id = $1`, [x.owner])));
      expect(f.map((o) => o.errorClass)).toEqual(['OUTSIDE_SCHEMA']);
      expect((await admin.query(`SELECT last_name FROM core."user" WHERE id = $1`, [x.owner])).rows[0].last_name).not.toBe('changed-by-step');
    });

    it("the write counters move with THIS transaction's writes (user table and the shared pg_authid); earlier transactions' writes stay as a constant offset, which is why the runner compares a delta", async () => {
      const c = new Client({ connectionString: adminUrl });
      await c.connect();
      const counter = async (sql: string, p: unknown[]) => Number((await c.query(sql, p)).rows[0]?.n ?? 0);
      const userSql = `SELECT (n_tup_ins + n_tup_upd + n_tup_del)::int AS n FROM pg_stat_xact_user_tables WHERE schemaname = $1 AND relname = 'job_role'`;
      const authSql = `SELECT (n_tup_ins + n_tup_upd + n_tup_del)::int AS n FROM pg_stat_xact_sys_tables WHERE relname = $1`;
      try {
        // An earlier, committed transaction of this backend writes job_role.
        await c.query(`UPDATE ${y.schema}.job_role SET name = name`);
        await c.query('BEGIN');
        const u0 = await counter(userSql, [y.schema]);
        const a0 = await counter(authSql, ['pg_authid']);
        await c.query(`UPDATE ${y.schema}.job_role SET name = name`);
        await c.query(`CREATE ROLE drunner_stats_probe_${SFX} NOLOGIN`);
        const u1 = await counter(userSql, [y.schema]);
        const a1 = await counter(authSql, ['pg_authid']);
        await c.query('ROLLBACK');
        // eslint-disable-next-line no-console
        console.log(`[drunner-m1] counters: job_role ${u0} -> ${u1}, pg_authid ${a0} -> ${a1} (offset ${u0} = earlier transactions not yet flushed)`);
        expect(u1 - u0).toBe(1);
        expect(a1 - a0).toBeGreaterThanOrEqual(1);
        // A transaction that writes nothing outside: the delta is zero (the runner's increasedCounters).
        await c.query('BEGIN');
        const { OUTSIDE_WRITE_COUNTERS_SQL, increasedCounters } = await import('../../engine/core-modules/upgrade/workspace-command-runner');
        const before = (await c.query(OUTSIDE_WRITE_COUNTERS_SQL, [x.schema])).rows;
        await c.query(`UPDATE ${x.schema}.job_role SET name = name`);
        const after = (await c.query(OUTSIDE_WRITE_COUNTERS_SQL, [x.schema])).rows;
        expect(increasedCounters(before, after)).toEqual([]);
        await c.query(`UPDATE ${y.schema}.job_role SET name = name`);
        const after2 = (await c.query(OUTSIDE_WRITE_COUNTERS_SQL, [x.schema])).rows;
        expect(increasedCounters(before, after2)).toEqual([`${y.schema}.job_role`]);
        await c.query('ROLLBACK');
      } finally {
        await c.end();
      }
    });
  });

  describe('review M2: structure the v1 fingerprint cannot see', () => {
    it('a data command doing CREATE RULE, or creating an UNLOGGED table, is refused (STRUCTURE_EXTRA), rolled back, recorded failed', async () => {
      const [a, b] = [await make('m2-a'), await make('m2-b')];
      await adopt([a.id, b.id]);
      const rule = cmd('AddRule', 40, { sql: (s) => `CREATE RULE d_rule AS ON INSERT TO ${s}.job_role DO INSTEAD NOTHING` });
      const out = await runner({ workspaceRegistry: { '0-7': [rule] }, workspaceIds: [a.id] });
      expect(out.failures.map((f) => f.errorClass)).toEqual(['STRUCTURE_EXTRA']);
      expect(Number((await admin.query(`SELECT count(*)::int AS n FROM pg_rewrite WHERE rulename = 'd_rule'`)).rows[0].n)).toBe(0);
      expect((await rows(a)).slice(-1)[0]).toMatchObject({ name: `0.7.0_AddRule_${T0 + 40}`, status: 'failed', attempt: 1 });
      const unlogged = cmd('AddUnlogged', 41, { sql: (s) => `CREATE UNLOGGED TABLE ${s}.d_scratch (x int)` });
      const out2 = await runner({ workspaceRegistry: { '0-7': [unlogged] }, workspaceIds: [b.id] });
      expect(out2.failures.map((f) => f.errorClass)).toEqual(['STRUCTURE_EXTRA']);
      expect(Number((await admin.query(`SELECT count(*)::int AS n FROM pg_class WHERE relname = 'd_scratch' AND relnamespace = $1::regnamespace`, [b.schema])).rows[0].n)).toBe(0);
    });

    it('a freshly provisioned workspace has none of it (no rule, all permanent, no inheritance, no foreign type or operator)', async () => {
      const w = await make('m2-fresh');
      expect((await admin.query(TARGET_EXTRA_STRUCTURE_SQL, [w.schema])).rows).toEqual([]);
    });
  });

  it('review M4: after --force skipped a failed 0.7.0 step, 0.8.0 runs that step first; the cursor never jumps; status says failed', async () => {
    const [a, b] = [await make('m4-a'), await make('m4-b')];
    await adopt([a.id, b.id]);
    let failB = true;
    const registry = {
      '0-7': [
        cmd('Step07', 50, {
          run: async ({ workspaceId }) => {
            if (failB && workspaceId === b.id) throw new Error('b fails 0.7.0');
          },
        }),
      ],
      '0-8': [cmd('Step08', 60, { run: async () => undefined })],
    };
    await runner({ workspaceRegistry: registry, workspaceIds: [a.id, b.id] });
    const at08 = (force: boolean) => runner({ codeVersion: '0.8.0', versions: ['0.4.0', '0.5.0', '0.6.0', '0.7.0'], force, workspaceRegistry: registry, workspaceIds: [a.id, b.id] });
    const forced = await at08(true);
    expect(forced.failures.map((f) => [f.workspaceId, f.step])).toEqual([[b.id, `0.7.0_Step07_${T0 + 50}`]]);
    expect((await rows(b)).map((r) => r.name)).not.toContain(`0.8.0_Step08_${T0 + 60}`);
    expect((await rows(a)).slice(-1)[0]).toMatchObject({ name: `0.8.0_Step08_${T0 + 60}`, status: 'completed', forced: true });
    expect(await withUpgradeScope(session, 'status', (q) => countFailedWorkspaceCursors(q))).toBeGreaterThanOrEqual(1);
    failB = false;
    await at08(false);
    expect((await rows(b)).slice(-2).map((r) => [r.name, r.status])).toEqual([
      [`0.7.0_Step07_${T0 + 50}`, 'completed'],
      [`0.8.0_Step08_${T0 + 60}`, 'completed'],
    ]);
  });

  it('review L1: a workspace deleted between listing and its step is refused (WORKSPACE_GONE); the others complete', async () => {
    const [a, b, c] = [await make('l1-a'), await make('l1-b'), await make('l1-c')];
    await adopt([a.id, b.id, c.id]);
    const out = await runner({
      workspaceRegistry: { '0-7': [cmd('AfterDelete', 70, { run: async () => undefined })] },
      workspaceIds: [a.id, b.id, c.id],
      onBeforeWorkspace: async (id) => {
        if (id !== b.id) return;
        // The workspace row and its logbook rows disappear while its schema and registry row remain. The superuser skips the RI
        // triggers (replica role) only to delete it out from under the run.
        const d = new Client({ connectionString: adminUrl });
        await d.connect();
        try {
          await d.query('SET session_replication_role = replica');
          await d.query('DELETE FROM core.upgrade_migration WHERE workspace_id = $1', [b.id]);
          await d.query('DELETE FROM core.manager_workspace WHERE id = $1', [b.id]);
        } finally {
          await d.end();
        }
      },
    });
    expect(out.failures.map((f) => [f.workspaceId, f.errorClass])).toEqual([[b.id, 'WORKSPACE_GONE']]);
    for (const w of [a, c]) expect(out.outcomes.find((o) => o.workspaceId === w.id)!.completed).toEqual([`0.7.0_AfterDelete_${T0 + 70}`]);
  });

  it('review L2: a command that leaves a session-level SET ROLE behind is refused (SESSION_LEAK) and the session is reset', async () => {
    const w = await make('l2');
    await adopt([w.id]);
    const out = await runner({ workspaceRegistry: { '0-7': [cmd('LeakRole', 80, { run: async ({ query }) => void (await query('SET ROLE crewflow')) })] }, workspaceIds: [w.id] });
    expect(out.failures.map((f) => f.errorClass)).toEqual(['SESSION_LEAK']);
    expect((await app.query(`SELECT pg_catalog.current_setting('role') AS r`)).rows[0].r).toBe('none');
  });

  it('review N3: whether pg_settings lists a custom rab.* placeholder (recorded per major); the runner checks the names directly either way', async () => {
    const c = new Client({ connectionString: adminUrl });
    await c.connect();
    try {
      await c.query(`SET rab.organisation_id = '00000000-0000-4000-8000-000000000000'`);
      const listed = Number((await c.query(`SELECT count(*)::int AS n FROM pg_settings WHERE name = 'rab.organisation_id'`)).rows[0].n);
      const direct = (await c.query(`SELECT current_setting('rab.organisation_id', true) AS v`)).rows[0].v;
      // eslint-disable-next-line no-console
      console.log(`[drunner-n3] pg_settings lists a session-level rab.organisation_id: ${listed === 1 ? 'yes' : 'no'}; current_setting sees it: ${direct ? 'yes' : 'no'}`);
      expect(direct).toBe('00000000-0000-4000-8000-000000000000');
    } finally {
      await c.end();
    }
  });

  it('review N3: a session-level SET of rab.organisation_id to the SAME value is refused (SESSION_LEAK) and is empty afterwards', async () => {
    const w = await make('n3');
    await adopt([w.id]);
    const leak = cmd('LeakOrg', 90, { run: async ({ query, organisationId }) => void (await query(`SELECT pg_catalog.set_config('rab.organisation_id', $1, false)`, [organisationId])) });
    const out = await runner({ workspaceRegistry: { '0-7': [leak] }, workspaceIds: [w.id] });
    expect(out.failures.map((f) => f.errorClass)).toEqual(['SESSION_LEAK']);
    expect((await app.query(`SELECT COALESCE(pg_catalog.current_setting('rab.organisation_id', true), '') AS v`)).rows[0].v).toBe('');
  });

  it('review N4: a session-level advisory lock left behind by a step is refused (SESSION_LEAK) and released; the migration lock stays', async () => {
    const w = await make('n4');
    await adopt([w.id]);
    const advisory = async () =>
      (await app.query(`SELECT l.objid::text AS objid FROM pg_locks l WHERE l.locktype = 'advisory' AND l.pid = pg_backend_pid() AND l.granted ORDER BY 1`)).rows.map((r: { objid: string }) => r.objid);
    const before = await advisory();
    const lock = cmd('LeakLock', 91, { run: async ({ query }) => void (await query('SELECT pg_catalog.pg_advisory_lock(4242424242)')) });
    const out = await runner({ workspaceRegistry: { '0-7': [lock] }, workspaceIds: [w.id] });
    expect(out.failures.map((f) => f.errorClass)).toEqual(['SESSION_LEAK']);
    expect(await advisory()).toEqual(before);
    expect(before.length).toBeGreaterThanOrEqual(1);
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
