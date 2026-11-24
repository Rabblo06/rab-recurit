import 'reflect-metadata';
import { Client } from 'pg';

import { integrationTestDatabase, integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';
import { PAYROLL_MAKER_CHECKER_HASHES, PAYROLL_MAKER_CHECKER_STATE_SQL } from '../../database/typeorm/workspace-schema/payroll-maker-checker-sql';
import { SeededWorkspace, seedWorkspace } from './helpers/workspace-fixtures';

/**
 * Owner decision 5 (DRAFT SQL, throwaway database only): PayrollMakerCheckerBackstop1786723020000, the database layer under the
 * services' maker-checker refusals, on the core copies, as the RUNTIME login:
 *  - the manager who finalised the shift report, or who reviewed the attendance seat, cannot write themselves in as the
 *    record's approver (core.payroll_record_guard, 42501); a third manager can;
 *  - the manager who prepared a run cannot write themselves in as its finaliser (payroll_run_update WITH CHECK, 42501); a
 *    third manager can.
 */
jest.setTimeout(300_000);

const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;
const SFX = Math.random().toString(36).replace(/[^a-z]/g, '').slice(0, 6) || 'x';

describeIfDb('decision 5: payroll maker-checker in the database (integration, throwaway database)', () => {
  const resolved = RUN ? integrationTestDatabase() : ({} as never);
  let admin: Client;
  let app: Client;
  let w: SeededWorkspace;
  const users = { finaliser: '', reviewer: '', approver: '', staff: '' };
  let recordId = '';
  let runId = '';

  beforeAll(async () => {
    admin = new Client({ connectionString: resolved.adminUrl });
    app = new Client({ connectionString: resolved.appUrl });
    await admin.connect();
    await app.connect();
    w = await seedWorkspace(admin, `mkchk-${SFX}`);
    const one = async (sql: string, params: unknown[]) => (await admin.query(sql, params)).rows[0].id as string;
    for (const k of Object.keys(users) as Array<keyof typeof users>) {
      users[k] = await one(`INSERT INTO core."user"(organisation_id, email, first_name, last_name, status) VALUES ($1, $2, 'MkChk', $3, 'active') RETURNING id`, [
        w.org,
        `mkchk-${k}-${SFX}@mkchk.invalid`,
        k,
      ]);
    }
    for (const u of [users.finaliser, users.reviewer, users.approver]) {
      await admin.query(`INSERT INTO core.manager_profile (organisation_id, user_id, type, workspace_id) VALUES ($1, $2, 'internal', $3)`, [w.org, u, w.id]);
    }
    const profile = await one(`INSERT INTO core.staff_profile (organisation_id, workspace_id, user_id, staff_ref, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [
      w.org, w.id, users.staff, `MKCHK-${SFX}`, w.owner,
    ]);
    const venue = await one(`INSERT INTO core.venue (organisation_id, workspace_id, name, created_by) VALUES ($1, $2, $3, $4) RETURNING id`, [w.org, w.id, `MkChk ${SFX}`, w.owner]);
    const role = await one(`INSERT INTO core.job_role (organisation_id, workspace_id, name) VALUES ($1, $2, $3) RETURNING id`, [w.org, w.id, `MkChk role ${SFX}`]);
    const shift = await one(
      `INSERT INTO core.shift (organisation_id, workspace_id, venue_id, job_role_id, starts_at, ends_at, required_count, pay_rate_pence, status, created_by)
       VALUES ($1, $2, $3, $4, '2031-02-03T09:00:00Z', '2031-02-03T13:00:00Z', 1, 1200, 'completed', $5) RETURNING id`,
      [w.org, w.id, venue, role, users.finaliser],
    );
    const seat = await one(
      `INSERT INTO core.shift_assignment (organisation_id, workspace_id, shift_id, staff_profile_id, status, pay_rate_snapshot_pence, assigned_by, period, attendance_reviewed_at, attendance_reviewed_by)
       VALUES ($1, $2, $3, $4, 'completed', 1200, $5, tstzrange('2031-02-03T09:00:00Z', '2031-02-03T13:00:00Z', '[)'), now(), $6) RETURNING id`,
      [w.org, w.id, shift, profile, users.finaliser, users.reviewer],
    );
    const attendance = await one(
      `INSERT INTO core.attendance (organisation_id, workspace_id, shift_assignment_id, shift_id, staff_profile_id, clock_in_at, clock_out_at, status)
       VALUES ($1, $2, $3, $4, $5, '2031-02-03T09:00:00Z', '2031-02-03T13:00:00Z', 'clocked_out') RETURNING id`,
      [w.org, w.id, seat, shift, profile],
    );
    await admin.query(`INSERT INTO core.shift_report (organisation_id, workspace_id, shift_id, status, finalised_at, finalised_by) VALUES ($1, $2, $3, 'finalised', now(), $4)`, [
      w.org, w.id, shift, users.finaliser,
    ]);
    recordId = await one(
      `INSERT INTO core.payroll_record (organisation_id, workspace_id, attendance_id, shift_id, staff_profile_id, status, worked_minutes, pay_rate_pence, amount_pence)
       VALUES ($1, $2, $3, $4, $5, 'pending_approval', 240, 1200, 4800) RETURNING id`,
      [w.org, w.id, attendance, shift, profile],
    );
    const calendar = await one(`INSERT INTO core.payroll_calendar (organisation_id, year, version, source, created_by) VALUES ($1, 2031, 1, 'mkchk', $2) RETURNING id`, [w.org, w.owner]);
    const period = await one(
      `INSERT INTO core.payroll_calendar_period (organisation_id, calendar_id, period_start, period_end, payday) VALUES ($1, $2, '2031-02-03', '2031-02-16', '2031-02-26') RETURNING id`,
      [w.org, calendar],
    );
    runId = await one(`INSERT INTO core.payroll_run (organisation_id, workspace_id, period_id, status, prepared_by) VALUES ($1, $2, $3, 'prepared', $4) RETURNING id`, [
      w.org, w.id, period, users.finaliser,
    ]);
  });

  afterAll(async () => {
    for (const table of ['payroll_run', 'payroll_calendar_period', 'payroll_calendar', 'payroll_record', 'shift_report', 'attendance', 'shift_assignment', 'shift', 'job_role', 'venue', 'staff_profile', 'manager_profile']) {
      await admin?.query(`DELETE FROM core.${table} WHERE organisation_id = $1`, [w?.org]).catch(() => undefined);
    }
    await app?.end();
    await admin?.end();
  });

  /** Runs `sql` as the runtime login bound to `user`, in a transaction that is always rolled back; returns the row count. */
  const as = async (user: string, sql: string, params: unknown[]): Promise<number | null> => {
    await app.query('BEGIN');
    try {
      await app.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true), set_config('rab.user_id', $3, true)`, [w.org, w.id, user]);
      return (await app.query(sql, params)).rowCount;
    } finally {
      await app.query('ROLLBACK');
    }
  };
  const approve = (user: string) => as(user, `UPDATE core.payroll_record SET status = 'approved', approved_at = now(), approved_by = $2, updated_at = now() WHERE id = $1`, [recordId, user]);
  const finalise = (user: string) => as(user, `UPDATE core.payroll_run SET status = 'finalised', finalised_at = now(), finalised_by = $2, updated_at = now() WHERE id = $1`, [runId, user]);

  it('runs as the configured runtime login (not SUPERUSER / BYPASSRLS), and the catalog holds the reviewed objects', async () => {
    const { rows } = await app.query(`SELECT current_user = $1 AS is_runtime, r.rolsuper AS su, r.rolbypassrls AS bypass FROM pg_roles r WHERE r.rolname = current_user`, [resolved.app.login]);
    expect(rows[0]).toMatchObject({ is_runtime: true, su: false, bypass: false });
    const [state] = (await admin.query(PAYROLL_MAKER_CHECKER_STATE_SQL)).rows;
    expect(state).toEqual({
      guard_body_hash: PAYROLL_MAKER_CHECKER_HASHES.guardBodyAfter,
      run_using_hash: PAYROLL_MAKER_CHECKER_HASHES.runUsing,
      run_check_hash: PAYROLL_MAKER_CHECKER_HASHES.runCheckAfter,
    });
  });

  it('the finaliser of the shift report cannot approve the record (42501)', async () => {
    await expect(approve(users.finaliser)).rejects.toMatchObject({ code: '42501' });
  });

  it('the reviewer of the attendance seat cannot approve the record (42501)', async () => {
    await expect(approve(users.reviewer)).rejects.toMatchObject({ code: '42501' });
  });

  it('a third manager can approve it', async () => {
    expect(await approve(users.approver)).toBe(1);
  });

  it('the preparer of a run cannot finalise it (42501); a third manager can', async () => {
    await expect(finalise(users.finaliser)).rejects.toMatchObject({ code: '42501' });
    expect(await finalise(users.approver)).toBe(1);
  });

  it('nothing was written by any of the above (every case rolled back)', async () => {
    expect((await admin.query(`SELECT status, approved_by FROM core.payroll_record WHERE id = $1`, [recordId])).rows[0]).toEqual({ status: 'pending_approval', approved_by: null });
    expect((await admin.query(`SELECT status FROM core.payroll_run WHERE id = $1`, [runId])).rows[0]).toEqual({ status: 'prepared' });
  });
});
