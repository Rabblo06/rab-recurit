import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

import { AttendanceStaffScopeRls1786722100000 } from '../../database/typeorm/core/migrations/1786722100000-AttendanceStaffScopeRls';
import { integrationTestDatabase, integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';
import {
  ATTENDANCE_TENANT_HASH,
  CORE_ATTENDANCE_POLICY_SQL,
  CORE_ATTENDANCE_SCOPE_DEPARSED,
  CORE_ATTENDANCE_SCOPE_HASH,
} from '../../database/typeorm/workspace-schema/attendance-staff-scope-sql';
import { SeededWorkspace, seedWorkspace } from './helpers/workspace-fixtures';

/**
 * M4 design §11 LOW finding (DRAFT SQL, throwaway databases only): AttendanceStaffScopeRls1786722100000, the fifth enforcement
 * layer on core.attendance (the copy every request uses while HWS is off). As the RUNTIME login (crewflow_owner), in one
 * workspace with two venues (shift X: Staff A and Staff B attended; shift Y: Staff B attended):
 *  - Staff A cannot read, update or insert Staff B's attendance in the same workspace (the abuse case);
 *  - a Manager of the workspace reads every row; a manager bound to another workspace reads none;
 *  - a Venue Manager reads only the rows of shifts at their own venues;
 *  - the worker marker reads every row; an unrelated user, an unknown user id, another organisation, another workspace and
 *    no tenant context read nothing;
 *  - the migration replaces only a known pair of expressions, and down() / up() round-trip (rolled back).
 */
jest.setTimeout(300_000);

const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;
const SFX = Math.random().toString(36).replace(/[^a-z]/g, '').slice(0, 6) || 'x';

describeIfDb('M4 §11: core.attendance staff-own-or-manager RLS predicate (integration, throwaway database)', () => {
  const { adminUrl, appUrl } = RUN ? integrationTestDatabase() : ({} as never);
  let admin: Client;
  let app: Client;
  let w: SeededWorkspace;
  let other: SeededWorkspace;
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
  let freeSeat = '';
  let shiftX = '';
  const runnerOf = (c: Client) => ({ isTransactionActive: true, query: async (sql: string, params?: unknown[]) => (await c.query(sql, params as unknown[])).rows }) as never;

  beforeAll(async () => {
    admin = new Client({ connectionString: adminUrl });
    app = new Client({ connectionString: appUrl });
    await admin.connect();
    await app.connect();
    w = await seedWorkspace(admin, `attscope-${SFX}`);
    other = await seedWorkspace(admin, `attscope-other-${SFX}`);
    const one = async (sql: string, params: unknown[]) => (await admin.query(sql, params)).rows[0].id as string;
    for (const k of Object.keys(users) as Array<keyof typeof users>) {
      users[k] = await one(`INSERT INTO core."user"(organisation_id, email, first_name, last_name, status) VALUES ($1, $2, 'AttScope', $3, 'active') RETURNING id`, [
        w.org,
        `attscope-${k}-${SFX}@attscope.invalid`,
        k,
      ]);
    }
    const profile = (user: string, label: string) =>
      one(`INSERT INTO core.staff_profile (organisation_id, workspace_id, user_id, staff_ref, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [
        w.org,
        w.id,
        user,
        `ATTSCOPE-${label}-${SFX}`,
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
    const venue = (name: string) => one(`INSERT INTO core.venue (organisation_id, workspace_id, name, created_by) VALUES ($1, $2, $3, $4) RETURNING id`, [w.org, w.id, name, w.owner]);
    const [venueX, venueY] = [await venue(`AttScope X ${SFX}`), await venue(`AttScope Y ${SFX}`)];
    for (const [vm, v] of [
      [vmX, venueX],
      [vmY, venueY],
    ]) {
      await admin.query(`INSERT INTO core.manager_venue (organisation_id, manager_profile_id, venue_id, workspace_id) VALUES ($1, $2, $3, $4)`, [w.org, vm, v, w.id]);
    }
    const role = await one(`INSERT INTO core.job_role (organisation_id, workspace_id, name) VALUES ($1, $2, $3) RETURNING id`, [w.org, w.id, `AttScope role ${SFX}`]);
    const shift = (v: string) =>
      one(
        `INSERT INTO core.shift (organisation_id, workspace_id, venue_id, job_role_id, starts_at, ends_at, required_count, pay_rate_pence, status, created_by)
         VALUES ($1, $2, $3, $4, '2030-11-02T22:00:00Z', '2030-11-03T07:00:00Z', 3, 1200, 'in_progress', $5) RETURNING id`,
        [w.org, w.id, v, role, w.owner],
      );
    shiftX = await shift(venueX);
    const shiftY = await shift(venueY);
    const seat = (s: string, p: string) =>
      one(
        `INSERT INTO core.shift_assignment (organisation_id, workspace_id, shift_id, staff_profile_id, status, pay_rate_snapshot_pence, assigned_by, period)
         VALUES ($1, $2, $3, $4, 'confirmed', 1200, $5, tstzrange('2030-11-02T22:00:00Z', '2030-11-03T07:00:00Z', '[)')) RETURNING id`,
        [w.org, w.id, s, p, w.owner],
      );
    const attend = async (s: string, p: string) =>
      one(
        `INSERT INTO core.attendance (organisation_id, workspace_id, shift_assignment_id, shift_id, staff_profile_id, clock_in_at, clock_out_at, status)
         VALUES ($1, $2, $3, $4, $5, '2030-11-02T22:00:00Z', '2030-11-03T07:00:00Z', 'clocked_out') RETURNING id`,
        [w.org, w.id, await seat(s, p), s, p],
      );
    att.xA = await attend(shiftX, profileA);
    att.xB = await attend(shiftX, profileB);
    att.yB = await attend(shiftY, profileB);
    freeSeat = await seat(shiftX, freeProfile);
  });

  afterAll(async () => {
    // The core business rows of these fixtures only (by organisation), children first; the users and organisations stay.
    for (const table of ['attendance', 'shift_assignment', 'shift', 'manager_venue', 'venue', 'job_role', 'staff_profile', 'manager_profile']) {
      await admin?.query(`DELETE FROM core.${table} WHERE organisation_id = $1`, [w?.org]).catch(() => undefined);
    }
    await app?.end();
    await admin?.end();
  });

  /** Runs `fn` as the runtime login with the given GUCs, inside a transaction that is always rolled back. */
  const as = async <T>(o: { user?: string; actor?: string; org?: string; workspace?: string; bind?: boolean }, fn: () => Promise<T>): Promise<T> => {
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
    as(o, async () =>
      (await app.query(`SELECT id FROM core.attendance WHERE id = ANY($1::uuid[]) ORDER BY id`, [Object.values(att)])).rows.map((r) => String(r.id)).sort(),
    );
  const sorted = (...ids: string[]) => [...ids].sort();

  it('the runtime login is crewflow_owner (the owner login), not SUPERUSER / BYPASSRLS: what the policy binds', async () => {
    const { rows } = await app.query(`SELECT current_user AS who, r.rolsuper AS su, r.rolbypassrls AS bypass FROM pg_roles r WHERE r.rolname = current_user`);
    expect(rows[0]).toMatchObject({ who: 'crewflow_owner', su: false, bypass: false });
  });

  it("Staff A sees only their own attendance (never Staff B's, same workspace)", async () => {
    expect(await visible({ user: users.staffA })).toEqual([att.xA]);
    expect(await as({ user: users.staffA }, async () => (await app.query(`SELECT id FROM core.attendance WHERE id = $1`, [att.xB])).rows)).toEqual([]);
  });

  it('Staff B sees both of their own rows', async () => {
    expect(await visible({ user: users.staffB })).toEqual(sorted(att.xB, att.yB));
  });

  it("Staff A cannot update Staff B's attendance (0 rows) and cannot insert attendance for Staff B (WITH CHECK, 42501)", async () => {
    const updated = await as({ user: users.staffA }, async () => (await app.query(`UPDATE core.attendance SET clock_out_at = clock_out_at + interval '1 hour' WHERE id = $1`, [att.xB])).rowCount);
    expect(updated).toBe(0);
    await expect(
      as({ user: users.staffA }, () =>
        app.query(
          `INSERT INTO core.attendance (organisation_id, workspace_id, shift_assignment_id, shift_id, staff_profile_id, clock_in_at, status)
           VALUES ($1, $2, $3, $4, $5, now(), 'clocked_in')`,
          [w.org, w.id, freeSeat, shiftX, profileB],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    expect((await admin.query(`SELECT clock_out_at FROM core.attendance WHERE id = $1`, [att.xB])).rows[0].clock_out_at.toISOString()).toBe('2030-11-03T07:00:00.000Z');
  });

  it('a Manager of the workspace sees every row; a manager bound to another workspace sees none', async () => {
    expect(await visible({ user: users.manager })).toEqual(sorted(att.xA, att.xB, att.yB));
    expect(await visible({ user: users.otherManager })).toEqual([]);
  });

  it('a Venue Manager sees only the rows of shifts at their own venues', async () => {
    expect(await visible({ user: users.vmX })).toEqual(sorted(att.xA, att.xB));
    expect(await visible({ user: users.vmY })).toEqual([att.yB]);
  });

  it('the worker marker (no user) sees every row; without the marker no user sees nothing', async () => {
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
    const { rows } = await app.query(`SELECT count(*)::int AS n FROM core.attendance`);
    expect(Number(rows[0].n)).toBe(0);
  });

  it('core.attendance carries the predicate on both expressions, deparsed exactly as reviewed', async () => {
    const [core] = (await admin.query(CORE_ATTENDANCE_POLICY_SQL)).rows;
    const { rows } = await admin.query(
      `SELECT pg_get_expr(p.polqual, p.polrelid) AS using, pg_get_expr(p.polwithcheck, p.polrelid) AS check FROM pg_policy p
        WHERE p.polrelid = 'core.attendance'::regclass AND p.polname = 'attendance_tenant'`,
    );
    // eslint-disable-next-line no-console
    console.log(`[att-scope-core] using=${core?.using_hash} check=${core?.check_hash} deparsed=${String(rows[0]?.using).replace(/\s+/g, ' ')}`);
    expect(core).toMatchObject({ using_hash: CORE_ATTENDANCE_SCOPE_HASH, check_hash: CORE_ATTENDANCE_SCOPE_HASH, permissive: true, cmd: '*', to_public: true });
    expect(String(rows[0].using).replace(/\s+/g, ' ')).toBe(CORE_ATTENDANCE_SCOPE_DEPARSED);
    expect(rows[0].check).toBe(rows[0].using);
  });

  it('down() restores the tenant-only predicate, up() refuses an unknown expression and restores the predicate (rolled back)', async () => {
    const migration = new AttendanceStaffScopeRls1786722100000();
    const hashes = async () => (await admin.query(CORE_ATTENDANCE_POLICY_SQL)).rows[0] as { using_hash: string; check_hash: string };
    const before = await hashes();
    await admin.query('BEGIN');
    try {
      await migration.down(runnerOf(admin));
      expect(await hashes()).toMatchObject({ using_hash: ATTENDANCE_TENANT_HASH, check_hash: ATTENDANCE_TENANT_HASH });
      await admin.query('SAVEPOINT tamper');
      await admin.query(`ALTER POLICY attendance_tenant ON core.attendance USING (organisation_id = core.current_org()) WITH CHECK (organisation_id = core.current_org())`);
      await expect(migration.up(runnerOf(admin))).rejects.toThrow(/is not a known policy/);
      await admin.query('ROLLBACK TO SAVEPOINT tamper');
      await migration.up(runnerOf(admin));
      expect(await hashes()).toMatchObject({ using_hash: CORE_ATTENDANCE_SCOPE_HASH, check_hash: CORE_ATTENDANCE_SCOPE_HASH });
      // A re-run is a no-op on the same expressions.
      await migration.up(runnerOf(admin));
      expect(await hashes()).toMatchObject({ using_hash: CORE_ATTENDANCE_SCOPE_HASH, check_hash: CORE_ATTENDANCE_SCOPE_HASH });
    } finally {
      await admin.query('ROLLBACK');
    }
    expect(await hashes()).toEqual(before);
  });
});
