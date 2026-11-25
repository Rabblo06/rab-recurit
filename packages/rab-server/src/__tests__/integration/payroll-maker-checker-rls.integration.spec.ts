import 'reflect-metadata';
import { Client } from 'pg';

import { integrationTestDatabase, integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';
import {
  PAYROLL_GUARD_PREDEPLOY_COUNT_SQL,
  PAYROLL_MAKER_CHECKER_HASHES,
  PAYROLL_MAKER_CHECKER_STATE_SQL,
} from '../../database/typeorm/workspace-schema/payroll-maker-checker-sql';
import { SeededWorkspace, seedWorkspace } from './helpers/workspace-fixtures';

/**
 * Owner decision 5 (DRAFT SQL, throwaway database only): PayrollMakerCheckerBackstop1786723020000 — core.payroll_record_guard()
 * on the core copy (the same function guards every workspace copy; payroll-approval.integration.spec.ts covers those), as the
 * RUNTIME login. On the move to approved: the approver is the caller, is neither the finaliser nor the reviewer (live columns
 * AND the insert-only audit history), and the report, seat and history must exist (fail closed). approved_by never changes
 * outside that move — including from a forged worker-marker session.
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
  const ids = { record: '', report: '', seat: '', unaudited: '' };

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
    /** A worked, reviewed (by the reviewer) and finalised (by the finaliser) seat with its pending payroll record. */
    const workedSeat = async (day: string, audited: boolean) => {
      const shift = await one(
        `INSERT INTO core.shift (organisation_id, workspace_id, venue_id, job_role_id, starts_at, ends_at, required_count, pay_rate_pence, status, created_by)
         VALUES ($1, $2, $3, $4, $5::timestamptz, $5::timestamptz + interval '4 hours', 1, 1200, 'completed', $6) RETURNING id`,
        [w.org, w.id, venue, role, `${day}T09:00:00Z`, users.finaliser],
      );
      const seat = await one(
        `INSERT INTO core.shift_assignment (organisation_id, workspace_id, shift_id, staff_profile_id, status, pay_rate_snapshot_pence, assigned_by, period, attendance_reviewed_at, attendance_reviewed_by)
         VALUES ($1, $2, $3, $4, 'completed', 1200, $5, tstzrange($6::timestamptz, $6::timestamptz + interval '4 hours', '[)'), now(), $7) RETURNING id`,
        [w.org, w.id, shift, profile, users.finaliser, `${day}T09:00:00Z`, users.reviewer],
      );
      const attendance = await one(
        `INSERT INTO core.attendance (organisation_id, workspace_id, shift_assignment_id, shift_id, staff_profile_id, clock_in_at, clock_out_at, status)
         VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $6::timestamptz + interval '4 hours', 'clocked_out') RETURNING id`,
        [w.org, w.id, seat, shift, profile, `${day}T09:00:00Z`],
      );
      const report = await one(`INSERT INTO core.shift_report (organisation_id, workspace_id, shift_id, status, finalised_at, finalised_by) VALUES ($1, $2, $3, 'finalised', now(), $4) RETURNING id`, [
        w.org, w.id, shift, users.finaliser,
      ]);
      if (audited) {
        // The insert-only history the real flow writes (ShiftReportService.reviewAttendance / finalise).
        await admin.query(`INSERT INTO core.audit_log (organisation_id, actor_user_id, entity_type, entity_id, action, metadata) VALUES ($1, $2, 'shift_assignment', $3, 'attendance.reviewed', '{}')`, [w.org, users.reviewer, seat]);
        await admin.query(`INSERT INTO core.audit_log (organisation_id, actor_user_id, entity_type, entity_id, action, metadata) VALUES ($1, $2, 'shift_report', $3, 'attendance.report_finalised', '{}')`, [w.org, users.finaliser, report]);
      }
      const record = await one(
        `INSERT INTO core.payroll_record (organisation_id, workspace_id, attendance_id, shift_id, staff_profile_id, status, worked_minutes, pay_rate_pence, amount_pence)
         VALUES ($1, $2, $3, $4, $5, 'pending_approval', 240, 1200, 4800) RETURNING id`,
        [w.org, w.id, attendance, shift, profile],
      );
      return { record, report, seat };
    };
    const main = await workedSeat('2031-02-03', true);
    Object.assign(ids, { record: main.record, report: main.report, seat: main.seat });
    ids.unaudited = (await workedSeat('2031-02-04', false)).record;
  });

  afterAll(async () => {
    for (const table of ['payroll_record', 'shift_report', 'attendance', 'shift_assignment', 'shift', 'job_role', 'venue', 'staff_profile', 'manager_profile']) {
      await admin?.query(`DELETE FROM core.${table} WHERE organisation_id = $1`, [w?.org]).catch(() => undefined);
    }
    await app?.end();
    await admin?.end();
  });

  /** Runs the statements as the runtime login bound to `user`, in ONE transaction that is always rolled back; returns the last row count. */
  const asMany = async (user: string, statements: Array<[string, unknown[]]>, actor = ''): Promise<number | null> => {
    await app.query('BEGIN');
    try {
      await app.query(
        `SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true), set_config('rab.user_id', $3, true), set_config('rab.actor_type', $4, true)`,
        [w.org, w.id, user, actor],
      );
      let count: number | null = null;
      for (const [sql, params] of statements) count = (await app.query(sql, params)).rowCount;
      return count;
    } finally {
      await app.query('ROLLBACK');
    }
  };
  const APPROVE = `UPDATE core.payroll_record SET status = 'approved', approved_at = now(), approved_by = $2, updated_at = now() WHERE id = $1`;
  const approve = (user: string, record = ids.record, approver = user) => asMany(user, [[APPROVE, [record, approver]]]);
  /** Fixture tampering done by the bootstrap identity, always restored. */
  const withTamper = async (set: [string, unknown[]], restore: [string, unknown[]], fn: () => Promise<void>) => {
    await admin.query(set[0], set[1]);
    try {
      await fn();
    } finally {
      await admin.query(restore[0], restore[1]);
    }
  };

  it('runs as the configured runtime login (not SUPERUSER / BYPASSRLS), and the catalog holds the reviewed guard', async () => {
    const { rows } = await app.query(`SELECT current_user = $1 AS is_runtime, r.rolsuper AS su, r.rolbypassrls AS bypass FROM pg_roles r WHERE r.rolname = current_user`, [resolved.app.login]);
    expect(rows[0]).toMatchObject({ is_runtime: true, su: false, bypass: false });
    expect((await admin.query(PAYROLL_MAKER_CHECKER_STATE_SQL)).rows[0]).toEqual({ guard_body_hash: PAYROLL_MAKER_CHECKER_HASHES.guardBodyAfter });
  });

  it('the finaliser and the reviewer cannot approve (42501); a third manager can', async () => {
    await expect(approve(users.finaliser)).rejects.toMatchObject({ code: '42501' });
    await expect(approve(users.reviewer)).rejects.toMatchObject({ code: '42501' });
    expect(await approve(users.approver)).toBe(1);
  });

  it('the approver is the caller, recorded once: writing someone else in, replacing or clearing it is 42501', async () => {
    await expect(approve(users.finaliser, ids.record, users.approver)).rejects.toMatchObject({ code: '42501' });
    await expect(asMany(users.approver, [[APPROVE, [ids.record, users.approver]], [`UPDATE core.payroll_record SET approved_by = $2 WHERE id = $1`, [ids.record, users.reviewer]]]))
      .rejects.toMatchObject({ code: '42501' });
    await expect(asMany(users.approver, [[APPROVE, [ids.record, users.approver]], [`UPDATE core.payroll_record SET approved_by = NULL, approved_at = NULL WHERE id = $1`, [ids.record]]]))
      .rejects.toMatchObject({ code: '42501' });
  });

  it('two-step forgery: approved_by set on a pending row from a forged worker-marker session is refused, so the status-only flip never happens', async () => {
    await expect(asMany(users.finaliser, [[`UPDATE core.payroll_record SET approved_by = $2, approved_at = now() WHERE id = $1`, [ids.record, users.approver]]], 'worker'))
      .rejects.toMatchObject({ code: '42501' });
    await expect(asMany(users.finaliser, [[`UPDATE core.payroll_record SET approved_by = $2, approved_at = now() WHERE id = $1`, [ids.record, users.approver]]]))
      .rejects.toMatchObject({ code: '42501' });
  });

  it('tampering with the who-prepared columns does not help: the insert-only history still names the finaliser and reviewer', async () => {
    // Re-point the report to the reviewer: the finaliser is no longer in the live columns, but finalised it.
    const reportBy = `UPDATE core.shift_report SET finalised_by = $2 WHERE id = $1`;
    await withTamper([reportBy, [ids.report, users.reviewer]], [reportBy, [ids.report, users.finaliser]], async () => {
      await expect(approve(users.finaliser)).rejects.toMatchObject({ code: '42501' });
    });
    // Re-point the seat's reviewer to the finaliser: the reviewer is no longer live, but reviewed it.
    const seatBy = `UPDATE core.shift_assignment SET attendance_reviewed_by = $2 WHERE id = $1`;
    await withTamper([seatBy, [ids.seat, users.finaliser]], [seatBy, [ids.seat, users.reviewer]], async () => {
        await expect(approve(users.reviewer)).rejects.toMatchObject({ code: '42501' });
      },
    );
  });

  it('fail closed: a null reviewer, or missing history, refuses even a third manager (42501)', async () => {
    await withTamper(
      [`UPDATE core.shift_assignment SET attendance_reviewed_by = NULL, attendance_reviewed_at = NULL WHERE id = $1`, [ids.seat]],
      [`UPDATE core.shift_assignment SET attendance_reviewed_by = $2, attendance_reviewed_at = now() WHERE id = $1`, [ids.seat, users.reviewer]],
      async () => {
        await expect(approve(users.approver)).rejects.toMatchObject({ code: '42501' });
      },
    );
    await expect(approve(users.approver, ids.unaudited)).rejects.toMatchObject({ code: '42501' });
  });

  it('the history must match the live columns: a finaliser re-pointed to someone who never finalised refuses even a third manager', async () => {
    const reportBy = `UPDATE core.shift_report SET finalised_by = $2 WHERE id = $1`;
    await withTamper([reportBy, [ids.report, users.staff]], [reportBy, [ids.report, users.finaliser]], async () => {
      await expect(approve(users.approver)).rejects.toMatchObject({ code: '42501' });
    });
  });

  it('forged history naming a colleague plus a re-pointed finalised_by does not let the real finaliser approve (42501)', async () => {
    // The finaliser re-points the report to the reviewer AND a history row names the reviewer as finaliser: the live columns
    // and the history now agree on a colleague, but the original insert-only row still names the finaliser.
    await admin.query(`INSERT INTO core.audit_log (organisation_id, actor_user_id, entity_type, entity_id, action, metadata) VALUES ($1, $2, 'shift_report', $3, 'attendance.report_finalised', '{}')`, [w.org, users.reviewer, ids.report]);
    const reportBy = `UPDATE core.shift_report SET finalised_by = $2 WHERE id = $1`;
    await withTamper([reportBy, [ids.report, users.reviewer]], [reportBy, [ids.report, users.finaliser]], async () => {
      await expect(approve(users.finaliser)).rejects.toMatchObject({ code: '42501' });
    });
  });

  it('performance: the history lookups are uuid = uuid, so the audit_log index serves them by (organisation_id, entity_type, entity_id)', async () => {
    // Sequential scans are switched off so the plan shows whether an index CAN serve the predicate (on a small test table the
    // planner would otherwise pick a sequential scan whatever the predicate). Before the fix (entity_id::text = $3::text) no
    // index condition on entity_id was possible.
    await admin.query('BEGIN');
    try {
      await admin.query('SET LOCAL enable_seqscan = off');
      const plan = (await admin.query(`EXPLAIN SELECT 1 FROM core.audit_log al WHERE al.organisation_id = $1 AND al.entity_type = 'shift_report' AND al.entity_id = $2`, [w.org, ids.report]))
        .rows.map((r: Record<string, string>) => r['QUERY PLAN']).join(' | ');
      expect(plan).toMatch(/Index (Only )?Scan|Bitmap Index Scan/);
      expect(plan).toMatch(/Index Cond: .*entity_id = /);
      expect(plan).not.toMatch(/Seq Scan/);
    } finally {
      await admin.query('ROLLBACK');
    }
  });

  it('the read-only pre-deploy count runs and counts the record without history', async () => {
    const [{ blocked_pending_records }] = (await admin.query(PAYROLL_GUARD_PREDEPLOY_COUNT_SQL)).rows;
    expect(Number(blocked_pending_records)).toBeGreaterThanOrEqual(1);
  });

  it('nothing was written by any of the above (every case rolled back)', async () => {
    expect((await admin.query(`SELECT status, approved_by FROM core.payroll_record WHERE id = ANY($1::uuid[]) ORDER BY id`, [[ids.record, ids.unaudited]])).rows)
      .toEqual([{ status: 'pending_approval', approved_by: null }, { status: 'pending_approval', approved_by: null }]);
  });
});
