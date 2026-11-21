import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

import { AttendanceStaffScopeRls1786722100000 } from '../../database/typeorm/core/migrations/1786722100000-AttendanceStaffScopeRls';
import { integrationTestDatabase, integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';
import { MIGRATION_LOCK_KEY } from '../../database/typeorm/scripts/migrate/migration-lock';
import {
  ATTENDANCE_TENANT_HASH,
  CORE_ATTENDANCE_POLICY_SQL,
  CORE_ATTENDANCE_SCOPE_DEPARSED,
  CORE_ATTENDANCE_SCOPE_HASH,
  LEVEL_25_WORKSPACES_SQL,
} from '../../database/typeorm/workspace-schema/structure-level-25';
import { provisionWorkspaceFunctionLevelSql } from '../../database/typeorm/workspace-schema/structure-level-21';
import { composeServerPathTemplateLevel24 } from '../../database/typeorm/workspace-schema/structure-level-24';
import { moduleChecksum, modulesThrough } from '../../database/typeorm/workspace-schema/workspace-schema-modules';
import { selectWorkspaceFingerprintsForServer, workspaceFingerprintMajor } from '../../database/typeorm/workspace-schema/v1/expected-fingerprints';
import { WORKSPACE_CORE_FK_REMOVAL } from '../../engine/core-modules/upgrade/upgrade-commands/0-6/workspace-core-fk-removal';
import { ATTENDANCE_STAFF_SCOPE, attendanceStaffScopeSql, attendanceTenantOnlySql } from '../../engine/core-modules/upgrade/upgrade-commands/0-7/attendance-staff-scope';
import { STAFF_PROFILE_SHIFT_TEAM_MULTI_ROLE } from '../../engine/core-modules/upgrade/upgrade-commands/0-7/staff-profile-shift-team-multi-role';
import { STAFF_PROFILE_WORKSPACE_REQUIRED_VALIDATE } from '../../engine/core-modules/upgrade/upgrade-commands/0-7/staff-profile-workspace-required-validate';
import { WORKSPACE_UPGRADE_COMMANDS } from '../../engine/core-modules/upgrade/upgrade-commands/registry';
import { upgradeSessionOf, UpgradeSession } from '../../engine/core-modules/upgrade/upgrade-migration.service';
import { WorkspaceCommandRunner, WorkspaceRunOptions } from '../../engine/core-modules/upgrade/workspace-command-runner';
import { codeWorkspaceStructureLevel, declaredFingerprint } from '../../engine/core-modules/upgrade/workspace-structure-level';
import { dropWorkspaceSchema, provisionServerPath, provisionTypeScript, registryOf, SeededWorkspace, seedWorkspace } from './helpers/workspace-fixtures';

/**
 * M4 design §11 LOW finding (DRAFT SQL, throwaway databases only): `0.7.0_AttendanceStaffScope_1786722100000` (structure level
 * 25) and AttendanceStaffScopeRls1786722100000. Proves:
 *  - the runner moves existing level-24 workspaces to level 25 (declared v2), idempotently; new workspaces (TypeScript
 *    provisioner and core.provision_workspace) are built at level 25, identical to an upgraded one;
 *  - the fifth enforcement layer on attendance, as the RUNTIME login (crewflow_owner), in a workspace schema AND in core (the
 *    HWS-off copy): Staff A cannot read, update or insert Staff B's attendance in the same workspace; a Manager of the
 *    workspace reads every row; a Venue Manager reads only the rows of shifts at their own venues; the worker marker reads
 *    every row; an unrelated user, a manager of another workspace, another organisation and no tenant context read nothing;
 *  - the migration replaces only a known core expression; down() refuses while a level-25 workspace exists (nothing changed).
 * The `[l25-fp]` log line prints the measured level-25 v2 fingerprint of this major (the declared value's source).
 */
jest.setTimeout(600_000);

const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;
const SFX = Math.random().toString(36).replace(/[^a-z]/g, '').slice(0, 6) || 'x';
const LOCK = MIGRATION_LOCK_KEY.toString();
const STEP = `0.7.0_${ATTENDANCE_STAFF_SCOPE.name}_${ATTENDANCE_STAFF_SCOPE.timestamp}`;
const L22_STEP = `0.6.0_${WORKSPACE_CORE_FK_REMOVAL.name}_${WORKSPACE_CORE_FK_REMOVAL.timestamp}`;
const L22 = { '0-6': [...(WORKSPACE_UPGRADE_COMMANDS['0-6'] ?? [])] };
/** The registry through level 24 (#243, before this command) and through level 25 (this command). */
const L24 = { ...L22, '0-7': [STAFF_PROFILE_WORKSPACE_REQUIRED_VALIDATE, STAFF_PROFILE_SHIFT_TEAM_MULTI_ROLE] };
const L25 = { ...L22, '0-7': [STAFF_PROFILE_WORKSPACE_REQUIRED_VALIDATE, STAFF_PROFILE_SHIFT_TEAM_MULTI_ROLE, ATTENDANCE_STAFF_SCOPE] };

describeIfDb('M4 §11: attendance staff-own-or-manager RLS predicate, structure level 25 (integration, throwaway database)', () => {
  const { adminUrl, appUrl } = RUN ? integrationTestDatabase() : ({} as never);
  let admin: Client;
  let app: Client;
  let session: UpgradeSession;
  const created: SeededWorkspace[] = [];
  let seq = 0;

  const make = async (n: string, how: 'level24' | 'level25' | 'sql'): Promise<SeededWorkspace> => {
    seq += 1;
    const ws = await seedWorkspace(admin, `wsl25-${n}-${SFX}-${seq}`);
    created.push(ws);
    if (how === 'level24') {
      expect(await provisionTypeScript(adminUrl, ws, { workspaceRegistry: L24 })).toBe('READY');
      await admin.query(
        `INSERT INTO core.upgrade_migration (name, status, attempt, executed_by_version, is_initial, workspace_id) VALUES ($1, 'completed', 1, '0.6.0', true, $2)`,
        [L22_STEP, ws.id],
      );
    }
    if (how === 'level25') expect(await provisionTypeScript(adminUrl, ws, { workspaceRegistry: L25 })).toBe('READY');
    if (how === 'sql') expect(await provisionServerPath(appUrl, ws)).toBe('READY');
    return ws;
  };
  const policyOf = async (schema: string) =>
    (
      await admin.query(
        `SELECT pg_get_expr(p.polqual, p.polrelid) AS using, pg_get_expr(p.polwithcheck, p.polrelid) AS check, p.polpermissive AS permissive, p.polcmd::text AS cmd
           FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relname = 'attendance' AND p.polname = 'attendance_tenant'`,
        [schema],
      )
    ).rows[0] as { using: string; check: string; permissive: boolean; cmd: string };
  const v2 = async (ws: SeededWorkspace) => (await admin.query('SELECT core.workspace_schema_fingerprint_v2($1) AS f', [ws.id])).rows[0].f as string;
  const runner = (o: Partial<WorkspaceRunOptions> & Pick<WorkspaceRunOptions, 'workspaceIds'>) =>
    new WorkspaceCommandRunner({ codeVersion: '0.7.0', versions: ['0.4.0', '0.5.0', '0.6.0'], force: false, adopt: false, log: () => undefined, workspaceRegistry: L25, ...o }).run(session);
  const runnerOf = (c: Client) => ({ isTransactionActive: true, query: async (sql: string, params?: unknown[]) => (await c.query(sql, params as unknown[])).rows }) as never;

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

  it('the command is level 25 of this code: one ALTER POLICY (USING and WITH CHECK) on its own schema; no pre-check, no drop; a v2 fingerprint declared', async () => {
    expect(codeWorkspaceStructureLevel()).toBeGreaterThanOrEqual(25);
    expect(ATTENDANCE_STAFF_SCOPE.structure).toMatchObject({ level: 25, provisionFunctionLiteral: 'db:provision_workspace@AttendanceStaffScopeRls1786722100000' });
    expect(ATTENDANCE_STAFF_SCOPE.structure?.mayDrop).toBeUndefined();
    expect(ATTENDANCE_STAFF_SCOPE.precheck).toBeUndefined();
    expect(declaredFingerprint(25, workspaceFingerprintMajor())).toMatch(/^[0-9a-f]{64}$/);
  });

  it('measures the level-25 v2 fingerprint of this major (the command SQL on a level-24 workspace, as crewflow, twice)', async () => {
    const m = await make('measure', 'level24');
    expect((await policyOf(m.schema)).using).toBe('((organisation_id = core.current_org()) AND (workspace_id = core.current_workspace()))');
    const before = await v2(m);
    const c = new Client({ connectionString: adminUrl });
    await c.connect();
    try {
      for (let i = 0; i < 2; i += 1) {
        await c.query('BEGIN');
        await c.query('SET LOCAL ROLE crewflow');
        await c.query(`SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true)`);
        await c.query(attendanceStaffScopeSql(m.schema));
        await c.query('COMMIT');
      }
    } finally {
      await c.end();
    }
    const measured = await v2(m);
    const p = await policyOf(m.schema);
    // eslint-disable-next-line no-console
    console.log(`[l25-fp] postgres=${workspaceFingerprintMajor()} level24-v2=${before} level25-v2=${measured} declared=${declaredFingerprint(25, workspaceFingerprintMajor())}`);
    // eslint-disable-next-line no-console
    console.log(`[l25-deparse] ${p.using.split(m.schema).join('workspace_*')}`);
    expect(before).toBe(declaredFingerprint(24, workspaceFingerprintMajor()));
    expect(p).toMatchObject({ permissive: true, cmd: '*' });
    expect(p.check).toBe(p.using);
    expect(p.using.split(m.schema).join('core').replace(/\s+/g, ' ')).toBe(CORE_ATTENDANCE_SCOPE_DEPARSED);
    expect(measured).toBe(declaredFingerprint(25, workspaceFingerprintMajor()));
  });

  it('existing workspaces: the runner moves them to level 25 (declared v2), idempotently; new workspaces (both provisioners) match', async () => {
    const [a, b] = [await make('ex-a', 'level24'), await make('ex-b', 'level24')];
    const out = await runner({ workspaceIds: [a.id, b.id] });
    expect(out.failures).toEqual([]);
    for (const w of [a, b]) {
      expect(out.outcomes.find((o) => o.workspaceId === w.id)!.completed).toContain(STEP);
      expect(await registryOf(admin, w.id)).toMatchObject({ status: 'READY', module_version: 25, migration_error: null });
      expect(await v2(w)).toBe(declaredFingerprint(25, workspaceFingerprintMajor()));
    }
    expect((await runner({ workspaceIds: [a.id, b.id] })).outcomes.map((o) => o.status)).toEqual(['up-to-date', 'up-to-date']);
    const nwTs = await make('nw-ts', 'level25');
    const nwSql = await make('nw-sql', 'sql');
    expect((await registryOf(admin, nwSql.id)).module_version).toBe(codeWorkspaceStructureLevel());
    for (const w of codeWorkspaceStructureLevel() === 25 ? [nwTs, nwSql] : [nwTs]) {
      expect((await registryOf(admin, w.id)).module_version).toBe(25);
      expect(await v2(w)).toBe(await v2(a));
    }
  });

  /**
   * One workspace, two venues: shift X (venue X) with Staff A and Staff B attended, shift Y (venue Y) with Staff B attended.
   * Seeded as the superuser; every read / write below runs as the runtime login inside a rolled-back transaction.
   */
  describe.each(['workspace', 'core'] as const)('layer 5 abuse cases on %s attendance (runtime login)', (where) => {
    let w: SeededWorkspace;
    let other: SeededWorkspace;
    let q = '';
    const users: Record<'staffA' | 'staffB' | 'manager' | 'vmX' | 'vmY' | 'stranger' | 'otherManager', string> = {
      staffA: '',
      staffB: '',
      manager: '',
      vmX: '',
      vmY: '',
      stranger: '',
      otherManager: '',
    };
    const att = { xA: '', xB: '', yB: '' };
    let profileB = '';
    let assignmentFree = '';
    let shiftX = '';

    beforeAll(async () => {
      w = await make(`rls-${where}`, 'sql');
      other = await make(`rls-${where}-other`, 'sql');
      q = where === 'core' ? 'core' : w.schema;
      const one = async (sql: string, params: unknown[]) => (await admin.query(sql, params)).rows[0].id as string;
      for (const k of Object.keys(users) as Array<keyof typeof users>) {
        users[k] = await one(`INSERT INTO core."user"(organisation_id, email, first_name, last_name, status) VALUES ($1, $2, 'L25', $3, 'active') RETURNING id`, [
          w.org,
          `l25-${where}-${k}-${SFX}@l25.invalid`,
          k,
        ]);
      }
      const profile = (user: string, label: string) =>
        one(`INSERT INTO ${q}.staff_profile (organisation_id, workspace_id, user_id, staff_ref, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [
          w.org,
          w.id,
          user,
          `L25-${where}-${label}-${SFX}`,
          w.owner,
        ]);
      const profileA = await profile(users.staffA, 'a');
      profileB = await profile(users.staffB, 'b');
      const freeProfile = await profile(users.stranger, 'free');
      const manager = (user: string, type: string, workspaceId: string) =>
        one(`INSERT INTO core.manager_profile (organisation_id, user_id, type, workspace_id) VALUES ($1, $2, $3, $4) RETURNING id`, [w.org, user, type, workspaceId]);
      await manager(users.manager, 'internal', w.id);
      await manager(users.otherManager, 'internal', other.id);
      const vmX = await manager(users.vmX, 'venue', w.id);
      const vmY = await manager(users.vmY, 'venue', w.id);
      const venue = (name: string) => one(`INSERT INTO ${q}.venue (organisation_id, workspace_id, name, created_by) VALUES ($1, $2, $3, $4) RETURNING id`, [w.org, w.id, name, w.owner]);
      const [venueX, venueY] = [await venue('L25 X'), await venue('L25 Y')];
      for (const [vm, v] of [[vmX, venueX], [vmY, venueY]]) {
        await admin.query(`INSERT INTO ${q}.manager_venue (organisation_id, manager_profile_id, venue_id, workspace_id) VALUES ($1, $2, $3, $4)`, [w.org, vm, v, w.id]);
      }
      const role = await one(`INSERT INTO ${q}.job_role (organisation_id, workspace_id, name) VALUES ($1, $2, 'L25 role') RETURNING id`, [w.org, w.id]);
      const shift = (v: string) =>
        one(
          `INSERT INTO ${q}.shift (organisation_id, workspace_id, venue_id, job_role_id, starts_at, ends_at, required_count, pay_rate_pence, status, created_by)
           VALUES ($1, $2, $3, $4, '2030-11-02T22:00:00Z', '2030-11-03T07:00:00Z', 3, 1200, 'in_progress', $5) RETURNING id`,
          [w.org, w.id, v, role, w.owner],
        );
      shiftX = await shift(venueX);
      const shiftY = await shift(venueY);
      const seat = (s: string, p: string) =>
        one(
          `INSERT INTO ${q}.shift_assignment (organisation_id, workspace_id, shift_id, staff_profile_id, status, pay_rate_snapshot_pence, assigned_by, period)
           VALUES ($1, $2, $3, $4, 'confirmed', 1200, $5, tstzrange('2030-11-02T22:00:00Z', '2030-11-03T07:00:00Z', '[)')) RETURNING id`,
          [w.org, w.id, s, p, w.owner],
        );
      const attend = async (s: string, p: string) =>
        one(
          `INSERT INTO ${q}.attendance (organisation_id, workspace_id, shift_assignment_id, shift_id, staff_profile_id, clock_in_at, clock_out_at, status)
           VALUES ($1, $2, $3, $4, $5, '2030-11-02T22:00:00Z', '2030-11-03T07:00:00Z', 'clocked_out') RETURNING id`,
          [w.org, w.id, await seat(s, p), s, p],
        );
      att.xA = await attend(shiftX, profileA);
      att.xB = await attend(shiftX, profileB);
      // A seat with no attendance yet, for the insert cases (Staff B's own booking on shift Y is attended below).
      att.yB = await attend(shiftY, profileB);
      assignmentFree = await seat(shiftX, freeProfile);
    });

    /** Runs `fn` as the runtime login with the given GUCs, inside a transaction that is always rolled back. */
    const as = async <T>(o: { user?: string | null; actor?: string; org?: string; workspace?: string; bind?: boolean }, fn: () => Promise<T>): Promise<T> => {
      await app.query('BEGIN');
      try {
        if (o.bind !== false) {
          await app.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true)`, [o.org ?? w.org, o.workspace ?? w.id]);
          await app.query(`SELECT set_config('rab.user_id', $1, true), set_config('rab.actor_type', $2, true)`, [o.user ?? '', o.actor ?? '']);
        }
        return await fn();
      } finally {
        await app.query('ROLLBACK');
      }
    };
    const visible = (o: Parameters<typeof as>[0]) =>
      as(o, async () => (await app.query(`SELECT id FROM ${q}.attendance WHERE shift_id = ANY($1::uuid[]) OR id = ANY($2::uuid[]) ORDER BY id`, [[shiftX], Object.values(att)])).rows.map((r) => String(r.id)).sort());
    const sorted = (...ids: string[]) => [...ids].sort();

    it('Staff A sees only their own attendance (never Staff B\'s, same workspace)', async () => {
      expect(await visible({ user: users.staffA })).toEqual([att.xA]);
      expect(await as({ user: users.staffA }, async () => (await app.query(`SELECT id FROM ${q}.attendance WHERE id = $1`, [att.xB])).rows)).toEqual([]);
    });

    it('Staff B sees both of their own rows', async () => {
      expect(await visible({ user: users.staffB })).toEqual(sorted(att.xB, att.yB));
    });

    it('Staff A cannot update Staff B\'s attendance (0 rows) and cannot insert attendance for Staff B (WITH CHECK)', async () => {
      const updated = await as({ user: users.staffA }, async () => (await app.query(`UPDATE ${q}.attendance SET clock_out_at = clock_out_at + interval '1 hour' WHERE id = $1`, [att.xB])).rowCount);
      expect(updated).toBe(0);
      await expect(
        as({ user: users.staffA }, () =>
          app.query(
            `INSERT INTO ${q}.attendance (organisation_id, workspace_id, shift_assignment_id, shift_id, staff_profile_id, clock_in_at, status)
             VALUES ($1, $2, $3, $4, $5, now(), 'clocked_in')`,
            [w.org, w.id, assignmentFree, shiftX, profileB],
          ),
        ),
      ).rejects.toMatchObject({ code: '42501' });
      expect((await admin.query(`SELECT clock_out_at FROM ${q}.attendance WHERE id = $1`, [att.xB])).rows[0].clock_out_at.toISOString()).toBe('2030-11-03T07:00:00.000Z');
    });

    it('a Manager of the workspace sees every row; a manager of another workspace sees none', async () => {
      expect(await visible({ user: users.manager })).toEqual(sorted(att.xA, att.xB, att.yB));
      expect(await visible({ user: users.otherManager })).toEqual([]);
    });

    it('a Venue Manager sees only the rows of shifts at their own venues', async () => {
      expect(await visible({ user: users.vmX })).toEqual(sorted(att.xA, att.xB));
      expect(await visible({ user: users.vmY })).toEqual([att.yB]);
    });

    it('the worker marker (no user) sees every row; the marker is required (no user, no marker: nothing)', async () => {
      expect(await visible({ user: '', actor: 'worker' })).toEqual(sorted(att.xA, att.xB, att.yB));
      expect(await visible({ user: '' })).toEqual([]);
      expect(await visible({ user: '', actor: 'human' })).toEqual([]);
    });

    it('an unrelated user, an unknown user id, another organisation and another workspace see nothing', async () => {
      expect(await visible({ user: users.stranger })).toEqual([]);
      expect(await visible({ user: randomUUID() })).toEqual([]);
      expect(await visible({ user: users.manager, org: other.org, workspace: other.id })).toEqual([]);
      expect(await visible({ user: users.manager, workspace: other.id })).toEqual([]);
      expect(await visible({ user: '', actor: 'worker', workspace: other.id })).toEqual([]);
    });

    it('zero rows with no tenant context bound (runtime login)', async () => {
      expect(await visible({ bind: false })).toEqual([]);
      const { rows } = await app.query(`SELECT count(*)::int AS n FROM ${q}.attendance`);
      expect(Number(rows[0].n)).toBe(0);
    });
  });

  it('core.attendance (HWS off) carries the same predicate on both expressions; up() refuses a provision body that is not the level-24 predecessor', async () => {
    const [core] = (await admin.query(CORE_ATTENDANCE_POLICY_SQL)).rows;
    // eslint-disable-next-line no-console
    console.log(`[l25-core] using=${core?.using_hash} check=${core?.check_hash}`);
    expect(core).toMatchObject({ using_hash: CORE_ATTENDANCE_SCOPE_HASH, check_hash: CORE_ATTENDANCE_SCOPE_HASH, permissive: true, cmd: '*', to_public: true });
    expect((await policyOf('core')).using.replace(/\s+/g, ' ')).toBe(CORE_ATTENDANCE_SCOPE_DEPARSED);
    await admin.query('BEGIN');
    try {
      await expect(new AttendanceStaffScopeRls1786722100000().up(runnerOf(admin))).rejects.toThrow(/is not the expected predecessor body/);
    } finally {
      await admin.query('ROLLBACK');
    }
  });

  it('down() of AttendanceStaffScopeRls1786722100000 refuses while a level-25 workspace exists (nothing changed)', async () => {
    await make('down', 'level25');
    const state = async () => ({
      provision: (await admin.query(`SELECT md5(prosrc) AS h FROM pg_proc WHERE oid = 'core.provision_workspace(uuid)'::regprocedure`)).rows,
      core: (await admin.query(CORE_ATTENDANCE_POLICY_SQL)).rows,
    });
    const before = await state();
    await admin.query('BEGIN');
    try {
      await expect(new AttendanceStaffScopeRls1786722100000().down(runnerOf(admin))).rejects.toThrow(/down\(\) refused: \d+ workspace schema\(s\) are at structure level 25/);
    } finally {
      await admin.query('ROLLBACK');
    }
    expect(await state()).toEqual(before);
  });

  it('down() with no level-25 workspace left (rolled back): the core policy reverts, the level-24 body is restored; up() needs a known core policy and restores level 25', async () => {
    const migration = new AttendanceStaffScopeRls1786722100000();
    const prosrc = async () => (await admin.query(`SELECT prosrc FROM pg_proc WHERE oid = 'core.provision_workspace(uuid)'::regprocedure`)).rows[0].prosrc as string;
    const coreHashes = async () => (await admin.query(CORE_ATTENDANCE_POLICY_SQL)).rows[0] as { using_hash: string; check_hash: string };
    const s24 = STAFF_PROFILE_SHIFT_TEAM_MULTI_ROLE.structure!;
    const s25 = ATTENDANCE_STAFF_SCOPE.structure!;
    const level24Body = (() => {
      const modules = modulesThrough(20).map((m) => ({ id: m.id, version: m.version, checksum: moduleChecksum(m) }));
      const sql = provisionWorkspaceFunctionLevelSql(composeServerPathTemplateLevel24(), modules, 24, s24.fingerprints[workspaceFingerprintMajor()]!, s24.provisionFunctionLiteral!);
      return sql.slice(sql.indexOf('AS $provision$') + 'AS $provision$'.length, sql.lastIndexOf('$provision$'));
    })();
    const before = { body: await prosrc(), core: await coreHashes() };
    await admin.query('BEGIN');
    try {
      const { rows } = await admin.query(
        `SELECT DISTINCT n.nspname FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname ~ '^workspace_[0-9a-f]{32}$' AND c.relname = 'attendance' AND p.polname = 'attendance_tenant'`,
      );
      for (const r of rows as Array<{ nspname: string }>) await admin.query(attendanceTenantOnlySql(r.nspname));
      expect((await admin.query(LEVEL_25_WORKSPACES_SQL)).rows[0].n).toBe(0);

      await migration.down(runnerOf(admin));
      expect(await coreHashes()).toEqual({ using_hash: ATTENDANCE_TENANT_HASH, check_hash: ATTENDANCE_TENANT_HASH });
      expect(await prosrc()).toBe(level24Body);
      await admin.query('SAVEPOINT again');
      await expect(migration.down(runnerOf(admin))).rejects.toThrow(/is not the expected predecessor body/);
      await admin.query('ROLLBACK TO SAVEPOINT again');

      // up() after down(): an unknown core expression is refused before any change ...
      await admin.query('SAVEPOINT tamper');
      await admin.query(`ALTER POLICY attendance_tenant ON core.attendance USING (organisation_id = core.current_org()) WITH CHECK (organisation_id = core.current_org())`);
      await expect(migration.up(runnerOf(admin))).rejects.toThrow(/is not a known policy/);
      await admin.query('ROLLBACK TO SAVEPOINT tamper');
      expect(await prosrc()).toBe(level24Body);
      // ... and the known one is moved to level 25 again.
      await migration.up(runnerOf(admin));
      expect(await coreHashes()).toEqual({ using_hash: CORE_ATTENDANCE_SCOPE_HASH, check_hash: CORE_ATTENDANCE_SCOPE_HASH });
      expect((await prosrc()).includes(s25.provisionFunctionLiteral!)).toBe(true);
    } finally {
      await admin.query('ROLLBACK');
    }
    expect({ body: await prosrc(), core: await coreHashes() }).toEqual(before);
  });
});
