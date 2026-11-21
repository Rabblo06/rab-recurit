import 'reflect-metadata';
import { Client } from 'pg';

import { AttendanceCorrectionInsertOnly1786722110000 } from '../../database/typeorm/core/migrations/1786722110000-AttendanceCorrectionInsertOnly';
import { integrationTestDatabase, integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';
import { CORE_CORRECTION_GUARD_STATE_SQL } from '../../database/typeorm/workspace-schema/attendance-correction-insert-only-sql';
import { SeededWorkspace, seedWorkspace } from './helpers/workspace-fixtures';

/**
 * Security finding S11 / architecture §5.7 (DRAFT SQL, throwaway databases only): AttendanceCorrectionInsertOnly1786722110000.
 * core.attendance_correction is insert-only for the RUNTIME login (crewflow_owner, which inherits the table owner, so grants
 * never bound it): UPDATE, DELETE and TRUNCATE are refused with 42501 per statement — even a statement RLS leaves with no row,
 * even by a manager who can read the row — while INSERT and SELECT work as before. Definers / FK actions (the table owner)
 * still pass, so retention is unchanged. Enforced by the database, not by the service.
 */
jest.setTimeout(300_000);

const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;
const SFX = Math.random().toString(36).replace(/[^a-z]/g, '').slice(0, 6) || 'x';

describeIfDb('S11: core.attendance_correction is insert-only in the database (integration, throwaway database)', () => {
  const { adminUrl, appUrl } = RUN ? integrationTestDatabase() : ({} as never);
  let admin: Client;
  let app: Client;
  let w: SeededWorkspace;
  let manager = '';
  let attendanceId = '';
  let correctionId = '';
  const runnerOf = (c: Client) => ({ isTransactionActive: true, query: async (sql: string, params?: unknown[]) => (await c.query(sql, params as unknown[])).rows }) as never;

  beforeAll(async () => {
    admin = new Client({ connectionString: adminUrl });
    app = new Client({ connectionString: appUrl });
    await admin.connect();
    await app.connect();
    w = await seedWorkspace(admin, `corrins-${SFX}`);
    const one = async (sql: string, params: unknown[]) => (await admin.query(sql, params)).rows[0].id as string;
    const user = (label: string) =>
      one(`INSERT INTO core."user"(organisation_id, email, first_name, last_name, status) VALUES ($1, $2, 'CorrIns', $3, 'active') RETURNING id`, [
        w.org,
        `corrins-${label}-${SFX}@corrins.invalid`,
        label,
      ]);
    manager = await user('manager');
    await admin.query(`INSERT INTO core.manager_profile (organisation_id, user_id, type, workspace_id) VALUES ($1, $2, 'internal', $3)`, [w.org, manager, w.id]);
    const staff = await one(`INSERT INTO core.staff_profile (organisation_id, workspace_id, user_id, staff_ref, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [
      w.org,
      w.id,
      await user('staff'),
      `CORRINS-${SFX}`,
      w.owner,
    ]);
    const venue = await one(`INSERT INTO core.venue (organisation_id, workspace_id, name, created_by) VALUES ($1, $2, $3, $4) RETURNING id`, [w.org, w.id, `CorrIns ${SFX}`, w.owner]);
    const role = await one(`INSERT INTO core.job_role (organisation_id, workspace_id, name) VALUES ($1, $2, $3) RETURNING id`, [w.org, w.id, `CorrIns role ${SFX}`]);
    const shift = await one(
      `INSERT INTO core.shift (organisation_id, workspace_id, venue_id, job_role_id, starts_at, ends_at, required_count, pay_rate_pence, status, created_by)
       VALUES ($1, $2, $3, $4, '2030-11-02T22:00:00Z', '2030-11-03T07:00:00Z', 1, 1200, 'in_progress', $5) RETURNING id`,
      [w.org, w.id, venue, role, manager],
    );
    const seat = await one(
      `INSERT INTO core.shift_assignment (organisation_id, workspace_id, shift_id, staff_profile_id, status, pay_rate_snapshot_pence, assigned_by, period)
       VALUES ($1, $2, $3, $4, 'confirmed', 1200, $5, tstzrange('2030-11-02T22:00:00Z', '2030-11-03T07:00:00Z', '[)')) RETURNING id`,
      [w.org, w.id, shift, staff, manager],
    );
    attendanceId = await one(
      `INSERT INTO core.attendance (organisation_id, workspace_id, shift_assignment_id, shift_id, staff_profile_id, clock_in_at, clock_out_at, status)
       VALUES ($1, $2, $3, $4, $5, '2030-11-02T22:00:00Z', '2030-11-03T07:00:00Z', 'clocked_out') RETURNING id`,
      [w.org, w.id, seat, shift, staff],
    );
    correctionId = await one(
      `INSERT INTO core.attendance_correction (organisation_id, workspace_id, attendance_id, field, old_value, new_value, reason, corrected_by)
       VALUES ($1, $2, $3, 'clockOutAt', '2030-11-03T07:00:00.000Z', '2030-11-03T06:30:00.000Z', 'left early, confirmed by the venue', $4) RETURNING id`,
      [w.org, w.id, attendanceId, manager],
    );
  });

  afterAll(async () => {
    // The fixtures' core business rows (corrections as the superuser, which the guard lets through), children first.
    for (const table of ['attendance_correction', 'attendance', 'shift_assignment', 'shift', 'venue', 'job_role', 'staff_profile', 'manager_profile']) {
      await admin?.query(`DELETE FROM core.${table} WHERE organisation_id = $1`, [w?.org]).catch(() => undefined);
    }
    await app?.end();
    await admin?.end();
  });

  /** As the runtime login, the Manager's tenant context, inside a transaction that is always rolled back. */
  const asManager = async <T>(fn: () => Promise<T>, bind = true): Promise<T> => {
    await app.query('BEGIN');
    try {
      if (bind) {
        await app.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true), set_config('rab.user_id', $3, true)`, [
          w.org,
          w.id,
          manager,
        ]);
      }
      return await fn();
    } finally {
      await app.query('ROLLBACK');
    }
  };
  const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code ?? 'error');
  const stored = async () => (await admin.query(`SELECT new_value, reason FROM core.attendance_correction WHERE id = $1`, [correctionId])).rows;

  it('the runtime login is crewflow_owner (inherits the table owner: grants alone never bound it)', async () => {
    const { rows } = await app.query(
      `SELECT current_user AS who, pg_has_role(current_user, 'crewflow', 'USAGE') AS owner_member, r.rolsuper AS su, r.rolbypassrls AS bypass
         FROM pg_roles r WHERE r.rolname = current_user`,
    );
    expect(rows[0]).toMatchObject({ who: 'crewflow_owner', owner_member: true, su: false, bypass: false });
  });

  it('the Manager can read the correction (the guard does not hide rows)', async () => {
    expect(await asManager(async () => (await app.query(`SELECT id FROM core.attendance_correction WHERE id = $1`, [correctionId])).rows.length)).toBe(1);
  });

  it.each([
    ['UPDATE of a visible row', `UPDATE core.attendance_correction SET new_value = '2030-11-03T09:00:00.000Z' WHERE id = $1`],
    ['DELETE of a visible row', `DELETE FROM core.attendance_correction WHERE id = $1`],
    ['UPDATE that matches no row', `UPDATE core.attendance_correction SET reason = 'rewritten reason text' WHERE id = $1 AND false`],
    ['DELETE that matches no row', `DELETE FROM core.attendance_correction WHERE id = $1 AND false`],
  ])('%s is refused with 42501 for the runtime login (per statement)', async (_label, sql) => {
    expect(await asManager(() => code(app.query(sql, [correctionId])))).toBe('42501');
    expect(await stored()).toEqual([{ new_value: '2030-11-03T06:30:00.000Z', reason: 'left early, confirmed by the venue' }]);
  });

  it('TRUNCATE (which RLS never filters) is refused with 42501 for the runtime login', async () => {
    expect(await asManager(() => code(app.query(`TRUNCATE core.attendance_correction`)))).toBe('42501');
    expect(await asManager(() => code(app.query(`TRUNCATE core.attendance_correction`)), false)).toBe('42501');
    expect(await stored()).toHaveLength(1);
  });

  it('INSERT still works for the runtime login (the correction write path is unchanged)', async () => {
    const inserted = await asManager(async () =>
      (
        await app.query(
          `INSERT INTO core.attendance_correction (organisation_id, workspace_id, attendance_id, field, old_value, new_value, reason, corrected_by)
           VALUES ($1, $2, $3, 'breakMinutes', '30', '45', 'longer break agreed on the night', $4) RETURNING id`,
          [w.org, w.id, attendanceId, manager],
        )
      ).rows.length,
    );
    expect(inserted).toBe(1);
  });

  it('definers / FK actions (the table owner, crewflow) still pass: retention is unchanged', async () => {
    await admin.query('BEGIN');
    try {
      await admin.query('SET LOCAL ROLE crewflow');
      await admin.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true), set_config('rab.user_id', $3, true)`, [
        w.org,
        w.id,
        manager,
      ]);
      expect((await admin.query(`DELETE FROM core.attendance_correction WHERE id = $1`, [correctionId])).rowCount).toBe(1);
    } finally {
      await admin.query('ROLLBACK');
    }
    expect(await stored()).toHaveLength(1);
  });

  it('zero rows from core.attendance_correction with no tenant context bound (runtime login)', async () => {
    const { rows } = await app.query(`SELECT count(*)::int AS n FROM core.attendance_correction`);
    expect(Number(rows[0].n)).toBe(0);
  });

  it('down() drops the three triggers and up() restores them (rolled back); a re-run of up() is a no-op', async () => {
    const migration = new AttendanceCorrectionInsertOnly1786722110000();
    const names = async () => (await admin.query(CORE_CORRECTION_GUARD_STATE_SQL)).rows.map((r) => `${r.name}:${r.tgtype}:${r.fn}`);
    const before = await names();
    expect(before).toEqual([
      'attendance_correction_insert_only_delete:10:core.owner_login_grant_parity_guard()',
      'attendance_correction_insert_only_truncate:34:core.owner_login_grant_parity_guard()',
      'attendance_correction_insert_only_update:18:core.owner_login_grant_parity_guard()',
    ]);
    await admin.query('BEGIN');
    try {
      await migration.down(runnerOf(admin));
      expect(await names()).toEqual([]);
      await migration.up(runnerOf(admin));
      await migration.up(runnerOf(admin));
      expect(await names()).toEqual(before);
    } finally {
      await admin.query('ROLLBACK');
    }
    expect(await names()).toEqual(before);
  });
});
