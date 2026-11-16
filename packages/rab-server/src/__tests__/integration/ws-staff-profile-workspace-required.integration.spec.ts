import 'reflect-metadata';
import { Client } from 'pg';

import { WorkspaceStaffProfileWorkspaceRequiredValidated1786721570000 } from '../../database/typeorm/core/migrations/1786721570000-WorkspaceStaffProfileWorkspaceRequiredValidated';
import { integrationTestDatabase, integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';
import { MIGRATION_LOCK_KEY } from '../../database/typeorm/scripts/migrate/migration-lock';
import { selectWorkspaceFingerprintsForServer, workspaceFingerprintMajor } from '../../database/typeorm/workspace-schema/v1/expected-fingerprints';
import { WORKSPACE_CORE_FK_REMOVAL } from '../../engine/core-modules/upgrade/upgrade-commands/0-6/workspace-core-fk-removal';
import {
  STAFF_PROFILE_WORKSPACE_REQUIRED_VALIDATE,
  staffProfileWorkspaceRequiredValidateSql,
} from '../../engine/core-modules/upgrade/upgrade-commands/0-7/staff-profile-workspace-required-validate';
import { WORKSPACE_UPGRADE_COMMANDS } from '../../engine/core-modules/upgrade/upgrade-commands/registry';
import { upgradeSessionOf, UpgradeSession } from '../../engine/core-modules/upgrade/upgrade-migration.service';
import { WorkspaceCommandRunner, WorkspaceRunOptions } from '../../engine/core-modules/upgrade/workspace-command-runner';
import { codeWorkspaceStructureLevel, declaredFingerprint } from '../../engine/core-modules/upgrade/workspace-structure-level';
import { dropWorkspaceSchema, provisionServerPath, provisionTypeScript, registryOf, SeededWorkspace, seedWorkspace } from './helpers/workspace-fixtures';

/**
 * OWNER-DB-ULTIMATE Part C3, owner decision Q3 (DRAFT SQL, throwaway databases only): `0.7.0_ValidateStaffProfileWorkspaceRequired_1786721570000`
 * (structure level 23) and WorkspaceStaffProfileWorkspaceRequiredValidated1786721570000. Proves:
 *  - the runner validates `staff_profile_workspace_required` on existing level-22 workspaces (level 23, declared v2),
 *    idempotently, and nothing else changes (constraint definition, row data);
 *  - new workspaces (TypeScript provisioner and core.provision_workspace) are built at level 23, identical to an upgraded one;
 *  - fail closed: the VALIDATE scan reads rows without RLS and refuses a NULL workspace_id (23514); a tampered workspace is
 *    refused by the runner and stays blocked at level 22, constraint still NOT VALID, its rows untouched;
 *  - down() refuses while a level-23 workspace exists (nothing changed);
 *  - zero rows from the upgraded table with no tenant context bound.
 * The `[q3-fp]` log line prints the measured level-23 v2 fingerprint of this major (the declared value's source).
 */
jest.setTimeout(600_000);

const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;
const SFX = Math.random().toString(36).replace(/[^a-z]/g, '').slice(0, 6) || 'x';
const LOCK = MIGRATION_LOCK_KEY.toString();
const STEP = `0.7.0_${STAFF_PROFILE_WORKSPACE_REQUIRED_VALIDATE.name}_${STAFF_PROFILE_WORKSPACE_REQUIRED_VALIDATE.timestamp}`;
const L22_STEP = `0.6.0_${WORKSPACE_CORE_FK_REMOVAL.name}_${WORKSPACE_CORE_FK_REMOVAL.timestamp}`;
/** The registry through level 22 (0b + 0a): how a workspace created by 0.6.0 is built. */
const L22 = { '0-6': [...(WORKSPACE_UPGRADE_COMMANDS['0-6'] ?? [])] };

describeIfDb('C3 Q3: staff_profile_workspace_required validated as structure level 23 (integration, throwaway database)', () => {
  const { adminUrl, appUrl } = RUN ? integrationTestDatabase() : ({} as never);
  let admin: Client;
  let app: Client;
  let session: UpgradeSession;
  const created: SeededWorkspace[] = [];
  let seq = 0;

  /** A workspace as 0.6.0 built it (level 22) with 0.6.0's creation cursor, or one built by this code ('ts' / 'sql'). */
  const make = async (n: string, how: 'level22' | 'ts' | 'sql' = 'level22'): Promise<SeededWorkspace> => {
    seq += 1;
    const ws = await seedWorkspace(admin, `wsq3-${n}-${SFX}-${seq}`);
    created.push(ws);
    if (how === 'level22') {
      expect(await provisionTypeScript(adminUrl, ws, { workspaceRegistry: L22 })).toBe('READY');
      await admin.query(
        `INSERT INTO core.upgrade_migration (name, status, attempt, executed_by_version, is_initial, workspace_id) VALUES ($1, 'completed', 1, '0.6.0', true, $2)`,
        [L22_STEP, ws.id],
      );
    }
    if (how === 'ts') expect(await provisionTypeScript(adminUrl, ws)).toBe('READY');
    if (how === 'sql') expect(await provisionServerPath(appUrl, ws)).toBe('READY');
    return ws;
  };
  const constraintOf = async (ws: SeededWorkspace) =>
    (
      await admin.query(
        `SELECT k.convalidated AS validated, pg_get_constraintdef(k.oid) AS def FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
          JOIN pg_namespace s ON s.oid = c.relnamespace WHERE s.nspname = $1 AND c.relname = 'staff_profile' AND k.conname = 'staff_profile_workspace_required'`,
        [ws.schema],
      )
    ).rows[0] as { validated: boolean; def: string };
  const v2 = async (ws: SeededWorkspace) => (await admin.query('SELECT core.workspace_schema_fingerprint_v2($1) AS f', [ws.id])).rows[0].f as string;
  const runner = (o: Partial<WorkspaceRunOptions> & Pick<WorkspaceRunOptions, 'workspaceIds'>) =>
    new WorkspaceCommandRunner({ codeVersion: '0.7.0', versions: ['0.4.0', '0.5.0', '0.6.0'], force: false, adopt: false, log: () => undefined, ...o }).run(session);

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

  it('the command is level 23 of this code: one VALIDATE statement, no pre-check, no drop, a v2 fingerprint declared for this major', async () => {
    expect(codeWorkspaceStructureLevel()).toBe(23);
    expect(STAFF_PROFILE_WORKSPACE_REQUIRED_VALIDATE.structure).toMatchObject({
      level: 23,
      provisionFunctionLiteral: 'db:provision_workspace@WorkspaceStaffProfileWorkspaceRequiredValidated1786721570000',
    });
    expect(STAFF_PROFILE_WORKSPACE_REQUIRED_VALIDATE.structure?.mayDrop).toBeUndefined();
    expect(STAFF_PROFILE_WORKSPACE_REQUIRED_VALIDATE.precheck).toBeUndefined();
    expect(staffProfileWorkspaceRequiredValidateSql('workspace_00000000000000000000000000000000')).toBe(
      'ALTER TABLE workspace_00000000000000000000000000000000.staff_profile VALIDATE CONSTRAINT staff_profile_workspace_required',
    );
    expect(declaredFingerprint(23, workspaceFingerprintMajor())).toMatch(/^[0-9a-f]{64}$/);
  });

  it('measures the level-23 v2 fingerprint of this major (the command SQL on a level-22 workspace, as crewflow, twice)', async () => {
    const m = await make('measure');
    expect(await constraintOf(m)).toEqual({ validated: false, def: 'CHECK ((workspace_id IS NOT NULL)) NOT VALID' });
    const before = await v2(m);
    const c = new Client({ connectionString: adminUrl });
    await c.connect();
    try {
      for (let i = 0; i < 2; i += 1) {
        await c.query('BEGIN');
        await c.query('SET LOCAL ROLE crewflow');
        await c.query(`SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true)`);
        await c.query(staffProfileWorkspaceRequiredValidateSql(m.schema));
        await c.query('COMMIT');
      }
    } finally {
      await c.end();
    }
    const measured = await v2(m);
    // eslint-disable-next-line no-console
    console.log(`[q3-fp] postgres=${workspaceFingerprintMajor()} level22-v2=${before} level23-v2=${measured} declared=${declaredFingerprint(23, workspaceFingerprintMajor())}`);
    expect(before).toBe(declaredFingerprint(22, workspaceFingerprintMajor()));
    expect(await constraintOf(m)).toEqual({ validated: true, def: 'CHECK ((workspace_id IS NOT NULL))' });
    expect(measured).toBe(declaredFingerprint(23, workspaceFingerprintMajor()));
  });

  it('existing level-22 workspaces: the runner validates the constraint (level 23, declared v2), idempotently; rows untouched; new workspaces match', async () => {
    const [a, b] = [await make('ex-a'), await make('ex-b')];
    await admin.query(`INSERT INTO ${a.schema}.staff_profile (organisation_id, user_id, staff_ref, workspace_id, created_by) VALUES ($1, $2, $3, $4, $2)`, [a.org, a.owner, `WSQ3-${SFX}`, a.id]);
    const rowsBefore = (await admin.query(`SELECT * FROM ${a.schema}.staff_profile ORDER BY id`)).rows;
    const out = await runner({ workspaceIds: [a.id, b.id] });
    expect(out.failures).toEqual([]);
    for (const w of [a, b]) {
      expect(out.outcomes.find((o) => o.workspaceId === w.id)!.completed).toContain(STEP);
      expect(await constraintOf(w)).toEqual({ validated: true, def: 'CHECK ((workspace_id IS NOT NULL))' });
      expect(await registryOf(admin, w.id)).toMatchObject({ status: 'READY', module_version: 23, migration_error: null });
      expect(await v2(w)).toBe(declaredFingerprint(23, workspaceFingerprintMajor()));
    }
    expect((await admin.query(`SELECT * FROM ${a.schema}.staff_profile ORDER BY id`)).rows).toEqual(rowsBefore);
    expect((await runner({ workspaceIds: [a.id, b.id] })).outcomes.map((o) => o.status)).toEqual(['up-to-date', 'up-to-date']);
    const [ts, sql] = [await make('nw-ts', 'ts'), await make('nw-sql', 'sql')];
    for (const w of [ts, sql]) {
      expect(await constraintOf(w)).toEqual({ validated: true, def: 'CHECK ((workspace_id IS NOT NULL))' });
      expect((await registryOf(admin, w.id)).module_version).toBe(23);
      expect(await v2(w)).toBe(await v2(a));
    }
  });

  it('fail closed: VALIDATE reads rows without RLS and refuses a NULL workspace_id (23514); the runner leaves a tampered workspace blocked at 22, rows untouched', async () => {
    const t = await make('tamper');
    // Tamper as the cluster superuser (an operator mistake): the bound CHECK removed, then a row with no workspace.
    await admin.query(`ALTER TABLE ${t.schema}.staff_profile DROP CONSTRAINT staff_profile_workspace_bound`);
    await admin.query(`ALTER TABLE ${t.schema}.staff_profile DROP CONSTRAINT staff_profile_workspace_required`);
    await admin.query(`INSERT INTO ${t.schema}.staff_profile (organisation_id, user_id, staff_ref, workspace_id, created_by) VALUES ($1, $2, $3, NULL, $2)`, [t.org, t.owner, `WSQ3-T-${SFX}`]);
    await admin.query(`ALTER TABLE ${t.schema}.staff_profile ADD CONSTRAINT staff_profile_workspace_required CHECK ((workspace_id IS NOT NULL)) NOT VALID`);
    // The statement itself, as crewflow with a tenant bound (the runner's session shape): refused, nothing validated.
    const c = new Client({ connectionString: adminUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE crewflow');
      await c.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true)`, [t.org, t.id]);
      await expect(c.query(staffProfileWorkspaceRequiredValidateSql(t.schema))).rejects.toMatchObject({ code: '23514' });
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
    // The runner: refused (structure check or the VALIDATE), the workspace blocked, never recorded at level 23.
    const out = await runner({ workspaceIds: [t.id] });
    expect(out.failures.map((f) => f.workspaceId)).toEqual([t.id]);
    const reg = await registryOf(admin, t.id);
    expect(reg.module_version).toBe(22);
    expect(String(reg.migration_error ?? '')).toMatch(/^upgrade-blocked: /);
    expect((await constraintOf(t)).validated).toBe(false);
    expect(Number((await admin.query(`SELECT count(*)::int AS n FROM ${t.schema}.staff_profile WHERE workspace_id IS NULL`)).rows[0].n)).toBe(1);
  });

  it('zero rows from the upgraded staff_profile with no tenant context bound (runtime login)', async () => {
    const w = await make('notenant');
    expect((await runner({ workspaceIds: [w.id] })).failures).toEqual([]);
    await admin.query(`INSERT INTO ${w.schema}.staff_profile (organisation_id, user_id, staff_ref, workspace_id, created_by) VALUES ($1, $2, $3, $4, $2)`, [w.org, w.owner, `WSQ3-N-${SFX}`, w.id]);
    const { rows } = await app.query(`SELECT count(*)::int AS n FROM ${w.schema}.staff_profile`);
    expect(Number(rows[0].n)).toBe(0);
  });

  it('down() of WorkspaceStaffProfileWorkspaceRequiredValidated1786721570000 refuses while a level-23 workspace exists (nothing changed)', async () => {
    await make('down', 'ts');
    const bodies = async () => (await admin.query(`SELECT md5(prosrc) AS h FROM pg_proc WHERE oid = 'core.provision_workspace(uuid)'::regprocedure`)).rows;
    const before = await bodies();
    const runnerOf = (c: Client) => ({ isTransactionActive: true, query: async (sql: string, params?: unknown[]) => (await c.query(sql, params as unknown[])).rows }) as never;
    await admin.query('BEGIN');
    try {
      await expect(new WorkspaceStaffProfileWorkspaceRequiredValidated1786721570000().down(runnerOf(admin))).rejects.toThrow(
        /down\(\) refused: \d+ workspace schema\(s\) are at structure level 23/,
      );
    } finally {
      await admin.query('ROLLBACK');
    }
    expect(await bodies()).toEqual(before);
  });
});
