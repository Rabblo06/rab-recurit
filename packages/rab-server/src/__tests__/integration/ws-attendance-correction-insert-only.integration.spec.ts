import 'reflect-metadata';
import { Client } from 'pg';

import { WorkspaceAttendanceCorrectionInsertOnly1786722130000 } from '../../database/typeorm/core/migrations/1786722130000-WorkspaceAttendanceCorrectionInsertOnly';
import { integrationTestDatabase, integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';
import { MIGRATION_LOCK_KEY } from '../../database/typeorm/scripts/migrate/migration-lock';
import { LEVEL_26_WORKSPACES_SQL } from '../../database/typeorm/workspace-schema/structure-level-26';
import { selectWorkspaceFingerprintsForServer, workspaceFingerprintMajor } from '../../database/typeorm/workspace-schema/v1/expected-fingerprints';
import { WORKSPACE_CORE_FK_REMOVAL } from '../../engine/core-modules/upgrade/upgrade-commands/0-6/workspace-core-fk-removal';
import { ATTENDANCE_CORRECTION_INSERT_ONLY, workspaceCorrectionInsertOnlySql } from '../../engine/core-modules/upgrade/upgrade-commands/0-7/attendance-correction-insert-only';
import { ATTENDANCE_STAFF_SCOPE } from '../../engine/core-modules/upgrade/upgrade-commands/0-7/attendance-staff-scope';
import { STAFF_PROFILE_SHIFT_TEAM_MULTI_ROLE } from '../../engine/core-modules/upgrade/upgrade-commands/0-7/staff-profile-shift-team-multi-role';
import { STAFF_PROFILE_WORKSPACE_REQUIRED_VALIDATE } from '../../engine/core-modules/upgrade/upgrade-commands/0-7/staff-profile-workspace-required-validate';
import { WORKSPACE_UPGRADE_COMMANDS } from '../../engine/core-modules/upgrade/upgrade-commands/registry';
import { upgradeSessionOf, UpgradeSession } from '../../engine/core-modules/upgrade/upgrade-migration.service';
import { WorkspaceCommandRunner, WorkspaceRunOptions } from '../../engine/core-modules/upgrade/workspace-command-runner';
import { codeWorkspaceStructureLevel, declaredFingerprint } from '../../engine/core-modules/upgrade/workspace-structure-level';
import { takeAttendanceLevelsDownTo } from './helpers/attendance-levels-down';
import { dropWorkspaceSchema, provisionServerPath, provisionTypeScript, registryOf, SeededWorkspace, seedWorkspace } from './helpers/workspace-fixtures';

/**
 * S11 + owner decision 46, the workspace-schema copies (DRAFT SQL, throwaway databases only):
 * `0.7.0_AttendanceCorrectionInsertOnly_1786722130000` (structure level 26) and WorkspaceAttendanceCorrectionInsertOnly1786722130000.
 * Proves: the level-26 fingerprint (`[l26-fp]` prints the measured value), the runner upgrade (idempotent) and both
 * provisioners; in a workspace schema, as the RUNTIME login, UPDATE / DELETE / TRUNCATE of a correction are refused with
 * 42501 while INSERT works, deleting an attendance that has a correction is refused (RESTRICT) and both rows remain, and
 * crewflow_app holds no UPDATE / DELETE there; the migration's predecessor and down() guards.
 */
jest.setTimeout(600_000);

const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;
const SFX = Math.random().toString(36).replace(/[^a-z]/g, '').slice(0, 6) || 'x';
const LOCK = MIGRATION_LOCK_KEY.toString();
const STEP = `0.7.0_${ATTENDANCE_CORRECTION_INSERT_ONLY.name}_${ATTENDANCE_CORRECTION_INSERT_ONLY.timestamp}`;
const L22_STEP = `0.6.0_${WORKSPACE_CORE_FK_REMOVAL.name}_${WORKSPACE_CORE_FK_REMOVAL.timestamp}`;
const L22 = { '0-6': [...(WORKSPACE_UPGRADE_COMMANDS['0-6'] ?? [])] };
const L25 = { ...L22, '0-7': [STAFF_PROFILE_WORKSPACE_REQUIRED_VALIDATE, STAFF_PROFILE_SHIFT_TEAM_MULTI_ROLE, ATTENDANCE_STAFF_SCOPE] };
const L26 = { ...L22, '0-7': [...L25['0-7'], ATTENDANCE_CORRECTION_INSERT_ONLY] };

describeIfDb('S11: attendance_correction insert-only in workspace schemas, structure level 26 (integration, throwaway database)', () => {
  const { adminUrl, appUrl } = RUN ? integrationTestDatabase() : ({} as never);
  let admin: Client;
  let app: Client;
  let session: UpgradeSession;
  const created: SeededWorkspace[] = [];
  let seq = 0;

  const make = async (n: string, how: 'level25' | 'level26' | 'sql'): Promise<SeededWorkspace> => {
    seq += 1;
    const ws = await seedWorkspace(admin, `wsl26-${n}-${SFX}-${seq}`);
    created.push(ws);
    if (how === 'level25') {
      expect(await provisionTypeScript(adminUrl, ws, { workspaceRegistry: L25 })).toBe('READY');
      await admin.query(
        `INSERT INTO core.upgrade_migration (name, status, attempt, executed_by_version, is_initial, workspace_id) VALUES ($1, 'completed', 1, '0.6.0', true, $2)`,
        [L22_STEP, ws.id],
      );
    }
    if (how === 'level26') expect(await provisionTypeScript(adminUrl, ws, { workspaceRegistry: L26 })).toBe('READY');
    if (how === 'sql') expect(await provisionServerPath(appUrl, ws)).toBe('READY');
    return ws;
  };
  const v2 = async (ws: SeededWorkspace) => (await admin.query('SELECT core.workspace_schema_fingerprint_v2($1) AS f', [ws.id])).rows[0].f as string;
  const runner = (o: Partial<WorkspaceRunOptions> & Pick<WorkspaceRunOptions, 'workspaceIds'>) =>
    new WorkspaceCommandRunner({ codeVersion: '0.7.0', versions: ['0.4.0', '0.5.0', '0.6.0'], force: false, adopt: false, log: () => undefined, workspaceRegistry: L26, ...o }).run(session);
  const runnerOf = (c: Client) => ({ isTransactionActive: true, query: async (sql: string, params?: unknown[]) => (await c.query(sql, params as unknown[])).rows }) as never;
  const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code ?? 'error');

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

  it('the command is level 26 of this code; it declares its drop (the key is dropped and re-added) and a v2 fingerprint', () => {
    expect(codeWorkspaceStructureLevel()).toBeGreaterThanOrEqual(26);
    expect(ATTENDANCE_CORRECTION_INSERT_ONLY.structure).toMatchObject({ level: 26, mayDrop: true, provisionFunctionLiteral: 'db:provision_workspace@WorkspaceAttendanceCorrectionInsertOnly1786722130000' });
    expect(declaredFingerprint(26, workspaceFingerprintMajor())).toMatch(/^[0-9a-f]{64}$/);
  });

  it('measures the level-26 v2 fingerprint of this major (the command SQL on a level-25 workspace, as crewflow, twice)', async () => {
    const m = await make('measure', 'level25');
    const before = await v2(m);
    const c = new Client({ connectionString: adminUrl });
    await c.connect();
    try {
      for (let i = 0; i < 2; i += 1) {
        await c.query('BEGIN');
        await c.query('SET LOCAL ROLE crewflow');
        await c.query(`SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true)`);
        await c.query(workspaceCorrectionInsertOnlySql(m.schema));
        await c.query('COMMIT');
      }
    } finally {
      await c.end();
    }
    const measured = await v2(m);
    // eslint-disable-next-line no-console
    console.log(`[l26-fp] postgres=${workspaceFingerprintMajor()} level25-v2=${before} level26-v2=${measured} declared=${declaredFingerprint(26, workspaceFingerprintMajor())}`);
    expect(before).toBe(declaredFingerprint(25, workspaceFingerprintMajor()));
    expect(measured).toBe(declaredFingerprint(26, workspaceFingerprintMajor()));
  });

  it('existing workspaces: the runner moves them to level 26 (declared v2), idempotently; new workspaces (both provisioners) match', async () => {
    const [a, b] = [await make('ex-a', 'level25'), await make('ex-b', 'level25')];
    const out = await runner({ workspaceIds: [a.id, b.id] });
    expect(out.failures).toEqual([]);
    for (const w of [a, b]) {
      expect(out.outcomes.find((o) => o.workspaceId === w.id)!.completed).toContain(STEP);
      expect(await registryOf(admin, w.id)).toMatchObject({ status: 'READY', module_version: 26, migration_error: null });
      expect(await v2(w)).toBe(declaredFingerprint(26, workspaceFingerprintMajor()));
    }
    expect((await runner({ workspaceIds: [a.id, b.id] })).outcomes.map((o) => o.status)).toEqual(['up-to-date', 'up-to-date']);
    const nwTs = await make('nw-ts', 'level26');
    const nwSql = await make('nw-sql', 'sql');
    expect((await registryOf(admin, nwSql.id)).module_version).toBe(codeWorkspaceStructureLevel());
    for (const w of codeWorkspaceStructureLevel() === 26 ? [nwTs, nwSql] : [nwTs]) {
      expect((await registryOf(admin, w.id)).module_version).toBe(26);
      expect(await v2(w)).toBe(await v2(a));
    }
  });

  describe('runtime login in a level-26 workspace schema', () => {
    let w: SeededWorkspace;
    let manager = '';
    let attendanceId = '';
    let correctionId = '';

    beforeAll(async () => {
      w = await make('rls', 'sql');
      const q = w.schema;
      const one = async (sql: string, params: unknown[]) => (await admin.query(sql, params)).rows[0].id as string;
      const user = (label: string) =>
        one(`INSERT INTO core."user"(organisation_id, email, first_name, last_name, status) VALUES ($1, $2, 'L26', $3, 'active') RETURNING id`, [w.org, `l26-${label}-${SFX}@l26.invalid`, label]);
      manager = await user('manager');
      await admin.query(`INSERT INTO core.manager_profile (organisation_id, user_id, type, workspace_id) VALUES ($1, $2, 'internal', $3)`, [w.org, manager, w.id]);
      const staff = await one(`INSERT INTO ${q}.staff_profile (organisation_id, workspace_id, user_id, staff_ref, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [
        w.org,
        w.id,
        await user('staff'),
        `L26-${SFX}`,
        w.owner,
      ]);
      const venue = await one(`INSERT INTO ${q}.venue (organisation_id, workspace_id, name, created_by) VALUES ($1, $2, 'L26 venue', $3) RETURNING id`, [w.org, w.id, w.owner]);
      const role = await one(`INSERT INTO ${q}.job_role (organisation_id, workspace_id, name) VALUES ($1, $2, 'L26 role') RETURNING id`, [w.org, w.id]);
      const shift = await one(
        `INSERT INTO ${q}.shift (organisation_id, workspace_id, venue_id, job_role_id, starts_at, ends_at, required_count, pay_rate_pence, status, created_by)
         VALUES ($1, $2, $3, $4, '2030-11-02T22:00:00Z', '2030-11-03T07:00:00Z', 1, 1200, 'in_progress', $5) RETURNING id`,
        [w.org, w.id, venue, role, w.owner],
      );
      const seat = await one(
        `INSERT INTO ${q}.shift_assignment (organisation_id, workspace_id, shift_id, staff_profile_id, status, pay_rate_snapshot_pence, assigned_by, period)
         VALUES ($1, $2, $3, $4, 'confirmed', 1200, $5, tstzrange('2030-11-02T22:00:00Z', '2030-11-03T07:00:00Z', '[)')) RETURNING id`,
        [w.org, w.id, shift, staff, w.owner],
      );
      attendanceId = await one(
        `INSERT INTO ${q}.attendance (organisation_id, workspace_id, shift_assignment_id, shift_id, staff_profile_id, clock_in_at, clock_out_at, status)
         VALUES ($1, $2, $3, $4, $5, '2030-11-02T22:00:00Z', '2030-11-03T07:00:00Z', 'clocked_out') RETURNING id`,
        [w.org, w.id, seat, shift, staff],
      );
      correctionId = await one(
        `INSERT INTO ${q}.attendance_correction (organisation_id, workspace_id, attendance_id, field, old_value, new_value, reason, corrected_by)
         VALUES ($1, $2, $3, 'breakMinutes', '30', '45', 'longer break agreed on the night', $4) RETURNING id`,
        [w.org, w.id, attendanceId, manager],
      );
    });

    const asManager = async <T>(fn: () => Promise<T>): Promise<T> => {
      await app.query('BEGIN');
      try {
        await app.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true), set_config('rab.user_id', $3, true)`, [w.org, w.id, manager]);
        return await fn();
      } finally {
        await app.query('ROLLBACK');
      }
    };

    it('the runtime login is crewflow_owner (the owner login), not SUPERUSER / BYPASSRLS: what the triggers bind', async () => {
      const { rows } = await app.query(`SELECT current_user AS who, r.rolsuper AS su, r.rolbypassrls AS bypass FROM pg_roles r WHERE r.rolname = current_user`);
      expect(rows[0]).toMatchObject({ who: 'crewflow_owner', su: false, bypass: false });
    });

    it.each([
      ['UPDATE', `UPDATE __S__.attendance_correction SET new_value = '0' WHERE id = $1`],
      ['DELETE', `DELETE FROM __S__.attendance_correction WHERE id = $1`],
      ['UPDATE (no row)', `UPDATE __S__.attendance_correction SET new_value = '0' WHERE id = $1 AND false`],
    ])('%s of a correction is refused with 42501 for the runtime login', async (_l, sql) => {
      expect(await asManager(() => code(app.query(sql.split('__S__').join(w.schema), [correctionId])))).toBe('42501');
    });

    it('TRUNCATE is refused; INSERT still works; the row is unchanged', async () => {
      expect(await asManager(() => code(app.query(`TRUNCATE ${w.schema}.attendance_correction`)))).toBe('42501');
      const inserted = await asManager(async () =>
        (
          await app.query(
            `INSERT INTO ${w.schema}.attendance_correction (organisation_id, workspace_id, attendance_id, field, old_value, new_value, reason, corrected_by)
             VALUES ($1, $2, $3, 'breakMinutes', '45', '40', 'second correction after review', $4)`,
            [w.org, w.id, attendanceId, manager],
          )
        ).rowCount,
      );
      expect(inserted).toBe(1);
      expect((await admin.query(`SELECT new_value FROM ${w.schema}.attendance_correction WHERE id = $1`, [correctionId])).rows).toEqual([{ new_value: '45' }]);
    });

    it('owner decision 46 (RESTRICT): deleting the attendance is refused and both rows remain', async () => {
      expect(['23503', '23001']).toContain(await asManager(() => code(app.query(`DELETE FROM ${w.schema}.attendance WHERE id = $1`, [attendanceId]))));
      expect((await admin.query(`SELECT count(*)::int AS n FROM ${w.schema}.attendance_correction WHERE id = $1`, [correctionId])).rows[0].n).toBe(1);
    });

    it('crewflow_app holds SELECT and INSERT only, as on core (check-rls-coverage parity)', async () => {
      const priv = async (table: string) =>
        (
          await admin.query(
            `SELECT has_table_privilege('crewflow_app', $1, 'UPDATE') AS u, has_table_privilege('crewflow_app', $1, 'DELETE') AS d,
                    has_table_privilege('crewflow_app', $1, 'INSERT') AS i, has_table_privilege('crewflow_app', $1, 'SELECT') AS s`,
            [table],
          )
        ).rows[0];
      expect(await priv(`${w.schema}.attendance_correction`)).toEqual({ u: false, d: false, i: true, s: true });
      expect(await priv('core.attendance_correction')).toEqual({ u: false, d: false, i: true, s: true });
    });

    it('zero rows with no tenant context bound (runtime login)', async () => {
      expect(Number((await app.query(`SELECT count(*)::int AS n FROM ${w.schema}.attendance_correction`)).rows[0].n)).toBe(0);
    });
  });

  it('up() refuses a provision body that is not the level-25 predecessor; down() refuses while a level-26 workspace exists', async () => {
    await admin.query('BEGIN');
    try {
      await expect(new WorkspaceAttendanceCorrectionInsertOnly1786722130000().up(runnerOf(admin))).rejects.toThrow(/is not the expected predecessor body/);
    } finally {
      await admin.query('ROLLBACK');
    }
    await make('down', 'level26');
    await admin.query('BEGIN');
    try {
      await expect(new WorkspaceAttendanceCorrectionInsertOnly1786722130000().down(runnerOf(admin))).rejects.toThrow(/down\(\) refused: \d+ workspace schema\(s\) are at structure level 26/);
    } finally {
      await admin.query('ROLLBACK');
    }
  });

  it('down() with no level-26 workspace left (rolled back) restores the grant and the level-25 body; up() restores level 26', async () => {
    const prosrc = async () => (await admin.query(`SELECT prosrc FROM pg_proc WHERE oid = 'core.provision_workspace(uuid)'::regprocedure`)).rows[0].prosrc as string;
    const grant = async () => (await admin.query(`SELECT has_table_privilege('crewflow_app', 'core.attendance_correction', 'UPDATE') AS u`)).rows[0].u as boolean;
    const before = { body: await prosrc(), grant: await grant() };
    await admin.query('BEGIN');
    try {
      await takeAttendanceLevelsDownTo(admin, 25);
      expect((await admin.query(LEVEL_26_WORKSPACES_SQL)).rows[0].n).toBe(0);
      expect(await grant()).toBe(true);
      expect((await prosrc()).includes(ATTENDANCE_STAFF_SCOPE.structure!.provisionFunctionLiteral!)).toBe(true);
      await new WorkspaceAttendanceCorrectionInsertOnly1786722130000().up(runnerOf(admin));
      expect(await grant()).toBe(false);
      expect((await prosrc()).includes(ATTENDANCE_CORRECTION_INSERT_ONLY.structure!.provisionFunctionLiteral!)).toBe(true);
    } finally {
      await admin.query('ROLLBACK');
    }
    expect({ body: await prosrc(), grant: await grant() }).toEqual(before);
  });
});
