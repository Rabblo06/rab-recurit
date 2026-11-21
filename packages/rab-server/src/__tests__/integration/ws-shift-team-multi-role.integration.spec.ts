import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

import { StaffShiftTeamMultiRole1786721600000 } from '../../database/typeorm/core/migrations/1786721600000-StaffShiftTeamMultiRole';
import { AttendanceStaffScopeRls1786722100000 } from '../../database/typeorm/core/migrations/1786722100000-AttendanceStaffScopeRls';
import { attendanceTenantOnlySql } from '../../engine/core-modules/upgrade/upgrade-commands/0-7/attendance-staff-scope';
import { integrationTestDatabase, integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';
import { MIGRATION_LOCK_KEY } from '../../database/typeorm/scripts/migrate/migration-lock';
import {
  CORE_SHIFT_TEAM_POLICY_SQL,
  CORE_SHIFT_TEAM_USING_HASH_EQUALITY,
  CORE_SHIFT_TEAM_USING_HASH_MEMBERSHIP,
  LEVEL_24_WORKSPACES_SQL,
} from '../../database/typeorm/workspace-schema/structure-level-24';
import { provisionWorkspaceFunctionLevelSql } from '../../database/typeorm/workspace-schema/structure-level-21';
import { composeServerPathTemplateLevel23 } from '../../database/typeorm/workspace-schema/structure-level-23';
import { moduleChecksum, modulesThrough } from '../../database/typeorm/workspace-schema/workspace-schema-modules';
import { selectWorkspaceFingerprintsForServer, workspaceFingerprintMajor } from '../../database/typeorm/workspace-schema/v1/expected-fingerprints';
import { WORKSPACE_CORE_FK_REMOVAL } from '../../engine/core-modules/upgrade/upgrade-commands/0-6/workspace-core-fk-removal';
import {
  STAFF_PROFILE_SHIFT_TEAM_MULTI_ROLE,
  shiftTeamSelectMultiRoleSql,
  shiftTeamSelectSingleRoleSql,
} from '../../engine/core-modules/upgrade/upgrade-commands/0-7/staff-profile-shift-team-multi-role';
import { STAFF_PROFILE_WORKSPACE_REQUIRED_VALIDATE } from '../../engine/core-modules/upgrade/upgrade-commands/0-7/staff-profile-workspace-required-validate';
import { WORKSPACE_UPGRADE_COMMANDS } from '../../engine/core-modules/upgrade/upgrade-commands/registry';
import { upgradeSessionOf, UpgradeSession } from '../../engine/core-modules/upgrade/upgrade-migration.service';
import { WorkspaceCommandRunner, WorkspaceRunOptions } from '../../engine/core-modules/upgrade/workspace-command-runner';
import { codeWorkspaceStructureLevel, declaredFingerprint } from '../../engine/core-modules/upgrade/workspace-structure-level';
import { dropWorkspaceSchema, provisionServerPath, provisionTypeScript, registryOf, SeededWorkspace, seedWorkspace } from './helpers/workspace-fixtures';

/**
 * #205 layer 4 (DRAFT SQL, throwaway databases only): `0.7.0_ShiftTeamSelectMultiRole_1786721600000` (structure level 24) and
 * StaffShiftTeamMultiRole1786721600000. Proves:
 *  - the runner moves existing workspaces to level 24 (declared v2), idempotently; new workspaces (TypeScript provisioner and
 *    core.provision_workspace) are built at level 24, identical to an upgraded one;
 *  - the policy (layer 4) admits a caller whose comma-joined `rab.role` CONTAINS `staff`, and nobody else: no `staff`
 *    element, a look-alike key, an empty / unset role, a caller not confirmed on the shift, another workspace, and no tenant
 *    context all see zero rows;
 *  - core.staff_profile's copy (HWS off) has the new predicate, and the migration replaces only a known expression;
 *  - down() refuses while a level-24 workspace exists (nothing changed).
 * The `[l24-fp]` log line prints the measured level-24 v2 fingerprint of this major (the declared value's source).
 */
jest.setTimeout(600_000);

const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;
const SFX = Math.random().toString(36).replace(/[^a-z]/g, '').slice(0, 6) || 'x';
const LOCK = MIGRATION_LOCK_KEY.toString();
const STEP = `0.7.0_${STAFF_PROFILE_SHIFT_TEAM_MULTI_ROLE.name}_${STAFF_PROFILE_SHIFT_TEAM_MULTI_ROLE.timestamp}`;
const L22_STEP = `0.6.0_${WORKSPACE_CORE_FK_REMOVAL.name}_${WORKSPACE_CORE_FK_REMOVAL.timestamp}`;
/** The registry through level 22 (how 0.6.0 built a workspace) and through level 23 (#177, before this command). */
const L22 = { '0-6': [...(WORKSPACE_UPGRADE_COMMANDS['0-6'] ?? [])] };
const L23 = { ...L22, '0-7': [STAFF_PROFILE_WORKSPACE_REQUIRED_VALIDATE] };
/** The registry through level 24 (this spec's command): later structural commands (level 25, attendance scope) are proven by their own spec. */
const L24 = { ...L22, '0-7': [STAFF_PROFILE_WORKSPACE_REQUIRED_VALIDATE, STAFF_PROFILE_SHIFT_TEAM_MULTI_ROLE] };

describeIfDb('#205: staff_profile_shift_team_select tests staff role membership, structure level 24 (integration, throwaway database)', () => {
  const { adminUrl, appUrl } = RUN ? integrationTestDatabase() : ({} as never);
  let admin: Client;
  let app: Client;
  let session: UpgradeSession;
  const created: SeededWorkspace[] = [];
  let seq = 0;

  const make = async (n: string, how: 'level22' | 'level23' | 'level24' | 'ts' | 'sql' = 'level22'): Promise<SeededWorkspace> => {
    seq += 1;
    const ws = await seedWorkspace(admin, `wsl24-${n}-${SFX}-${seq}`);
    created.push(ws);
    if (how === 'level22') {
      expect(await provisionTypeScript(adminUrl, ws, { workspaceRegistry: L22 })).toBe('READY');
      await admin.query(
        `INSERT INTO core.upgrade_migration (name, status, attempt, executed_by_version, is_initial, workspace_id) VALUES ($1, 'completed', 1, '0.6.0', true, $2)`,
        [L22_STEP, ws.id],
      );
    }
    if (how === 'level23') expect(await provisionTypeScript(adminUrl, ws, { workspaceRegistry: L23 })).toBe('READY');
    if (how === 'level24') expect(await provisionTypeScript(adminUrl, ws, { workspaceRegistry: L24 })).toBe('READY');
    if (how === 'ts') expect(await provisionTypeScript(adminUrl, ws)).toBe('READY');
    if (how === 'sql') expect(await provisionServerPath(appUrl, ws)).toBe('READY');
    return ws;
  };
  const policyOf = async (schema: string) =>
    (
      await admin.query(
        `SELECT pg_get_expr(p.polqual, p.polrelid) AS using, p.polpermissive AS permissive, p.polcmd::text AS cmd, p.polwithcheck IS NULL AS no_check
           FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relname = 'staff_profile' AND p.polname = 'staff_profile_shift_team_select'`,
        [schema],
      )
    ).rows[0] as { using: string; permissive: boolean; cmd: string; no_check: boolean };
  const MEMBERSHIP_DEPARSED = "('staff'::text = ANY (string_to_array(current_setting('rab.role'::text, true), ','::text)))";
  const EQUALITY_DEPARSED = "(current_setting('rab.role'::text, true) = 'staff'::text)";
  const v2 = async (ws: SeededWorkspace) => (await admin.query('SELECT core.workspace_schema_fingerprint_v2($1) AS f', [ws.id])).rows[0].f as string;
  const runner = (o: Partial<WorkspaceRunOptions> & Pick<WorkspaceRunOptions, 'workspaceIds'>) =>
    new WorkspaceCommandRunner({ codeVersion: '0.7.0', versions: ['0.4.0', '0.5.0', '0.6.0'], force: false, adopt: false, log: () => undefined, workspaceRegistry: L24, ...o }).run(session);

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

  it('the command is level 24 of this code: one ALTER POLICY that changes only the role test; no pre-check, no drop; a v2 fingerprint declared for this major', async () => {
    expect(codeWorkspaceStructureLevel()).toBeGreaterThanOrEqual(24);
    expect(STAFF_PROFILE_SHIFT_TEAM_MULTI_ROLE.structure).toMatchObject({ level: 24, provisionFunctionLiteral: 'db:provision_workspace@StaffShiftTeamMultiRole1786721600000' });
    expect(STAFF_PROFILE_SHIFT_TEAM_MULTI_ROLE.structure?.mayDrop).toBeUndefined();
    expect(STAFF_PROFILE_SHIFT_TEAM_MULTI_ROLE.precheck).toBeUndefined();
    const s = 'workspace_00000000000000000000000000000000';
    expect(shiftTeamSelectMultiRoleSql(s)).toBe(
      shiftTeamSelectSingleRoleSql(s).replace("current_setting('rab.role', true) = 'staff'", "'staff' = ANY (pg_catalog.string_to_array(current_setting('rab.role', true), ','))"),
    );
    expect(declaredFingerprint(24, workspaceFingerprintMajor())).toMatch(/^[0-9a-f]{64}$/);
  });

  it('measures the level-24 v2 fingerprint of this major (the command SQL on a level-23 workspace, as crewflow, twice)', async () => {
    const m = await make('measure', 'level23');
    expect((await policyOf(m.schema)).using).toContain(EQUALITY_DEPARSED);
    const before = await v2(m);
    const c = new Client({ connectionString: adminUrl });
    await c.connect();
    try {
      for (let i = 0; i < 2; i += 1) {
        await c.query('BEGIN');
        await c.query('SET LOCAL ROLE crewflow');
        await c.query(`SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true)`);
        await c.query(shiftTeamSelectMultiRoleSql(m.schema));
        await c.query('COMMIT');
      }
    } finally {
      await c.end();
    }
    const measured = await v2(m);
    // eslint-disable-next-line no-console
    console.log(`[l24-fp] postgres=${workspaceFingerprintMajor()} level23-v2=${before} level24-v2=${measured} declared=${declaredFingerprint(24, workspaceFingerprintMajor())}`);
    const fresh = await seedWorkspace(admin, `wsl24-fresh-${SFX}`);
    created.push(fresh);
    const freshOutcome = await provisionServerPath(appUrl, fresh).catch((e: Error) => `REFUSED ${e.message.slice(0, 200)}`);
    const lines = async (w: SeededWorkspace) => new Set((await admin.query('SELECT l FROM core.workspace_schema_fingerprint_v2_lines($1) AS f(l)', [w.id])).rows.map((r) => String(r.l)));
    const [lu, lf] = [await lines(m), await lines(fresh)];
    // eslint-disable-next-line no-console
    console.log(`[l24-diff] fresh=${freshOutcome} only-upgraded=${JSON.stringify([...lu].filter((l) => !lf.has(l)))} only-fresh=${JSON.stringify([...lf].filter((l) => !lu.has(l)))}`);
    expect(before).toBe(declaredFingerprint(23, workspaceFingerprintMajor()));
    const p = await policyOf(m.schema);
    expect(p.using).toContain(MEMBERSHIP_DEPARSED);
    expect(p.using).not.toContain(EQUALITY_DEPARSED);
    expect(p).toMatchObject({ permissive: true, cmd: 'r', no_check: true });
    expect(measured).toBe(declaredFingerprint(24, workspaceFingerprintMajor()));
  });

  it('existing workspaces: the runner moves them to level 24 (declared v2), idempotently; new workspaces (both provisioners) match', async () => {
    const [a, b] = [await make('ex-a'), await make('ex-b')];
    const out = await runner({ workspaceIds: [a.id, b.id] });
    expect(out.failures).toEqual([]);
    for (const w of [a, b]) {
      expect(out.outcomes.find((o) => o.workspaceId === w.id)!.completed).toContain(STEP);
      expect(await registryOf(admin, w.id)).toMatchObject({ status: 'READY', module_version: 24, migration_error: null });
      expect(await v2(w)).toBe(declaredFingerprint(24, workspaceFingerprintMajor()));
      expect((await policyOf(w.schema)).using).toContain(MEMBERSHIP_DEPARSED);
    }
    expect((await runner({ workspaceIds: [a.id, b.id] })).outcomes.map((o) => o.status)).toEqual(['up-to-date', 'up-to-date']);
    // core.provision_workspace builds THIS code's level (25 since the attendance scope): compared with the upgraded one only
    // while that is 24; the TypeScript provisioner is pinned to the level-24 registry.
    const nwTs = await make('nw-ts', 'level24');
    const nwSql = await make('nw-sql', 'sql');
    expect((await registryOf(admin, nwSql.id)).module_version).toBe(codeWorkspaceStructureLevel());
    expect((await policyOf(nwSql.schema)).using).toContain(MEMBERSHIP_DEPARSED);
    for (const w of codeWorkspaceStructureLevel() === 24 ? [nwTs, nwSql] : [nwTs]) {
      expect((await registryOf(admin, w.id)).module_version).toBe(24);
      expect(await v2(w)).toBe(await v2(a));
    }
  });

  describe('layer 4 abuse cases: only a caller whose roles CONTAIN staff, confirmed on the live shift, sees teammates', () => {
    let w: SeededWorkspace;
    let other: SeededWorkspace;
    const profiles: Record<'caller' | 'mate' | 'stranger', string> = { caller: '', mate: '', stranger: '' };
    let shiftId = '';

    beforeAll(async () => {
      w = await make('rls', 'sql');
      other = await make('rls-other', 'sql');
      const q = w.schema;
      const one = async (sql: string, params: unknown[]) => (await admin.query(sql, params)).rows[0].id as string;
      const user = (label: string) =>
        one(`INSERT INTO core."user"(organisation_id, email, first_name, last_name, status) VALUES ($1, $2, 'L24', $3, 'active') RETURNING id`, [
          w.org,
          `l24-${label}-${SFX}@l24.invalid`,
          label,
        ]);
      for (const k of Object.keys(profiles) as Array<keyof typeof profiles>) {
        profiles[k] = await one(`INSERT INTO ${q}.staff_profile (organisation_id, workspace_id, user_id, staff_ref, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [
          w.org,
          w.id,
          await user(k),
          `L24-${k}-${SFX}`,
          w.owner,
        ]);
      }
      const venue = await one(`INSERT INTO ${q}.venue (organisation_id, workspace_id, name, created_by) VALUES ($1, $2, 'L24 venue', $3) RETURNING id`, [w.org, w.id, w.owner]);
      const role = await one(`INSERT INTO ${q}.job_role (organisation_id, workspace_id, name) VALUES ($1, $2, 'L24 role') RETURNING id`, [w.org, w.id]);
      shiftId = await one(
        `INSERT INTO ${q}.shift (organisation_id, workspace_id, venue_id, job_role_id, starts_at, ends_at, required_count, pay_rate_pence, status, created_by)
         VALUES ($1, $2, $3, $4, '2030-11-02T22:00:00Z', '2030-11-03T07:00:00Z', 3, 1200, 'confirmed', $5) RETURNING id`,
        [w.org, w.id, venue, role, w.owner],
      );
      for (const [k, status] of [['caller', 'confirmed'], ['mate', 'confirmed'], ['stranger', 'offered']] as const) {
        await admin.query(
          `INSERT INTO ${q}.shift_assignment (organisation_id, workspace_id, shift_id, staff_profile_id, status, pay_rate_snapshot_pence, assigned_by, period)
           VALUES ($1, $2, $3, $4, $5, 1200, $6, tstzrange('2030-11-02T22:00:00Z', '2030-11-03T07:00:00Z', '[)'))`,
          [w.org, w.id, shiftId, profiles[k], status, w.owner],
        );
      }
    });

    /** As the runtime login, inside a rolled-back transaction: the profiles of THIS workspace the caller's GUCs make visible. */
    const visible = async (o: { role?: string | null; org?: string; workspace?: string; teamStaff?: string; teamShift?: string; schema?: string }) => {
      await app.query('BEGIN');
      try {
        await app.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true)`, [o.org ?? w.org, o.workspace ?? w.id]);
        if (o.role !== null) await app.query(`SELECT set_config('rab.role', $1, true)`, [o.role ?? 'staff']);
        await app.query(`SELECT set_config('rab.team_shift_id', $1, true), set_config('rab.team_staff_id', $2, true)`, [o.teamShift ?? shiftId, o.teamStaff ?? profiles.caller]);
        const { rows } = await app.query(`SELECT id FROM ${o.schema ?? w.schema}.staff_profile ORDER BY id`);
        return rows.map((r) => String(r.id)).sort();
      } finally {
        await app.query('ROLLBACK');
      }
    };
    const team = () => [profiles.caller, profiles.mate].sort();

    it('a single-role staff caller sees the confirmed team (unchanged)', async () => {
      expect(await visible({ role: 'staff' })).toEqual(team());
    });

    it.each(['manager,staff', 'staff,venue_manager', 'manager,staff,custom_crew_lead'])('a multi-role caller (%s) sees the same confirmed team (was: nothing)', async (role) => {
      expect(await visible({ role })).toEqual(team());
    });

    it.each(['manager', 'manager,venue_manager', 'custom_staff', 'manager,custom_staff', 'staffing', 'staff_', ' staff', 'staff ', 'STAFF', '', 'manager;staff'])(
      'roles without an exact "staff" element (%j) see nothing',
      async (role) => {
        expect(await visible({ role })).toEqual([]);
      },
    );

    it('an unset rab.role sees nothing (string_to_array(NULL) is NULL: fail closed)', async () => {
      expect(await visible({ role: null })).toEqual([]);
    });

    it('the capability is still required: a multi-role caller NOT confirmed on the shift, or naming another shift, sees nothing', async () => {
      expect(await visible({ role: 'manager,staff', teamStaff: profiles.stranger })).toEqual([]);
      expect(await visible({ role: 'manager,staff', teamShift: randomUUID() })).toEqual([]);
    });

    it.each(['cancelled', 'completed'])('a %s shift shows nobody, even to a confirmed multi-role caller (the shift-status line of the predicate)', async (status) => {
      expect(await visible({ role: 'manager,staff' })).toEqual(team());
      await admin.query(`UPDATE ${w.schema}.shift SET status = $1 WHERE id = $2`, [status, shiftId]);
      try {
        expect(await visible({ role: 'manager,staff' })).toEqual([]);
        expect(await visible({ role: 'staff' })).toEqual([]);
      } finally {
        await admin.query(`UPDATE ${w.schema}.shift SET status = 'confirmed' WHERE id = $1`, [shiftId]);
      }
      expect(await visible({ role: 'manager,staff' })).toEqual(team());
    });

    it('tenant binding is still required: another workspace or organisation bound sees nothing', async () => {
      expect(await visible({ role: 'manager,staff', workspace: other.id })).toEqual([]);
      expect(await visible({ role: 'manager,staff', org: other.org, workspace: other.id })).toEqual([]);
    });

    it('zero rows from the level-24 staff_profile with no tenant context bound (runtime login)', async () => {
      const { rows } = await app.query(`SELECT count(*)::int AS n FROM ${w.schema}.staff_profile`);
      expect(Number(rows[0].n)).toBe(0);
    });
  });

  it('core.staff_profile (HWS off) carries the same predicate; up() refuses a provision body that is not the level-23 predecessor (rolled back)', async () => {
    const [core] = (await admin.query(CORE_SHIFT_TEAM_POLICY_SQL)).rows;
    expect(core).toMatchObject({ using_hash: CORE_SHIFT_TEAM_USING_HASH_MEMBERSHIP, permissive: true, cmd: 'r', to_public: true, no_check: true });
    expect((await policyOf('core')).using).toContain(MEMBERSHIP_DEPARSED);
    const runnerOf = (c: Client) => ({ isTransactionActive: true, query: async (sql: string, params?: unknown[]) => (await c.query(sql, params as unknown[])).rows }) as never;
    await admin.query('BEGIN');
    try {
      // Installed body = level 24, not #177's level 23: up() refuses before changing anything.
      await expect(new StaffShiftTeamMultiRole1786721600000().up(runnerOf(admin))).rejects.toThrow(/is not the expected predecessor body/);
    } finally {
      await admin.query('ROLLBACK');
    }
    expect((await admin.query(CORE_SHIFT_TEAM_POLICY_SQL)).rows[0].using_hash).toBe(CORE_SHIFT_TEAM_USING_HASH_MEMBERSHIP);
  });

  it('down() of StaffShiftTeamMultiRole1786721600000 refuses while a level-24 workspace exists (nothing changed)', async () => {
    await make('down', 'ts');
    const state = async () => ({
      provision: (await admin.query(`SELECT md5(prosrc) AS h FROM pg_proc WHERE oid = 'core.provision_workspace(uuid)'::regprocedure`)).rows,
      core: (await admin.query(CORE_SHIFT_TEAM_POLICY_SQL)).rows,
    });
    const before = await state();
    const runnerOf = (c: Client) => ({ isTransactionActive: true, query: async (sql: string, params?: unknown[]) => (await c.query(sql, params as unknown[])).rows }) as never;
    await admin.query('BEGIN');
    try {
      await expect(new StaffShiftTeamMultiRole1786721600000().down(runnerOf(admin))).rejects.toThrow(/down\(\) refused: \d+ workspace schema\(s\) are at structure level 24/);
    } finally {
      await admin.query('ROLLBACK');
    }
    expect(await state()).toEqual(before);
  });

  it('down() with no level-24 workspace left (rolled back): the core policy reverts, the level-23 body is restored; up() needs a known core policy and restores level 24', async () => {
    const migration = new StaffShiftTeamMultiRole1786721600000();
    const runnerOf = (c: Client) => ({ isTransactionActive: true, query: async (sql: string, params?: unknown[]) => (await c.query(sql, params as unknown[])).rows }) as never;
    const prosrc = async () => (await admin.query(`SELECT prosrc FROM pg_proc WHERE oid = 'core.provision_workspace(uuid)'::regprocedure`)).rows[0].prosrc as string;
    const coreHash = async () => (await admin.query(CORE_SHIFT_TEAM_POLICY_SQL)).rows[0].using_hash as string;
    const s23 = STAFF_PROFILE_WORKSPACE_REQUIRED_VALIDATE.structure!;
    const s24 = STAFF_PROFILE_SHIFT_TEAM_MULTI_ROLE.structure!;
    const level23Body = (() => {
      const modules = modulesThrough(20).map((m) => ({ id: m.id, version: m.version, checksum: moduleChecksum(m) }));
      const sql = provisionWorkspaceFunctionLevelSql(composeServerPathTemplateLevel23(), modules, 23, s23.fingerprints[workspaceFingerprintMajor()]!, s23.provisionFunctionLiteral!);
      return sql.slice(sql.indexOf('AS $provision$') + 'AS $provision$'.length, sql.lastIndexOf('$provision$'));
    })();
    const before = { body: await prosrc(), core: await coreHash() };
    await admin.query('BEGIN');
    try {
      // "No level-24 workspace": every workspace policy that is not the level-23 form goes back to it (rolled back below).
      const { rows } = await admin.query(
        `SELECT DISTINCT n.nspname FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname ~ '^workspace_[0-9a-f]{32}$' AND c.relname = 'staff_profile' AND p.polname = 'staff_profile_shift_team_select'`,
      );
      for (const r of rows as Array<{ nspname: string }>) await admin.query(shiftTeamSelectSingleRoleSql(r.nspname));
      // The fail-closed guard recognises the level-23 form on this major (else it would count these and refuse).
      expect((await admin.query(LEVEL_24_WORKSPACES_SQL)).rows[0].n).toBe(0);
      // Level 25 (attendance scope) is installed on top: take it down first, the same way (its workspaces back to the tenant-only
      // attendance policy, then its own down()), so this migration's down() finds its own level-24 body.
      if ((await admin.query(`SELECT 1 FROM core.migrations WHERE name = 'AttendanceStaffScopeRls1786722100000'`)).rows.length === 1) {
        const att = await admin.query(
          `SELECT DISTINCT n.nspname FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname ~ '^workspace_[0-9a-f]{32}$' AND c.relname = 'attendance' AND p.polname = 'attendance_tenant'`,
        );
        for (const r of att.rows as Array<{ nspname: string }>) await admin.query(attendanceTenantOnlySql(r.nspname));
        await new AttendanceStaffScopeRls1786722100000().down(runnerOf(admin));
      }

      await migration.down(runnerOf(admin));
      expect(await coreHash()).toBe(CORE_SHIFT_TEAM_USING_HASH_EQUALITY);
      expect((await policyOf('core')).using).toContain(EQUALITY_DEPARSED);
      expect(await prosrc()).toBe(level23Body);
      // down() again: the installed body is no longer level 24, so it refuses before changing anything.
      await admin.query('SAVEPOINT again');
      await expect(migration.down(runnerOf(admin))).rejects.toThrow(/is not the expected predecessor body/);
      await admin.query('ROLLBACK TO SAVEPOINT again');

      // up() after down(): an unknown core expression is refused before any change ...
      await admin.query('SAVEPOINT tamper');
      await admin.query(shiftTeamSelectSingleRoleSql('core').replace("AND s.status NOT IN ('cancelled', 'completed')", "AND s.status NOT IN ('cancelled')"));
      await expect(migration.up(runnerOf(admin))).rejects.toThrow(/is not a known policy/);
      await admin.query('ROLLBACK TO SAVEPOINT tamper');
      expect(await prosrc()).toBe(level23Body);
      // ... and the known one is moved to level 24 again.
      await migration.up(runnerOf(admin));
      expect(await coreHash()).toBe(CORE_SHIFT_TEAM_USING_HASH_MEMBERSHIP);
      expect((await prosrc()).includes(s24.provisionFunctionLiteral!)).toBe(true);
    } finally {
      await admin.query('ROLLBACK');
    }
    expect({ body: await prosrc(), core: await coreHash() }).toEqual(before);
  });
});
