import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Client } from 'pg';

import { integrationTestDatabase, integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';

/**
 * M9 load-test index fix (LoadTestListIndexes1786722700000; packages/rab-docker/docs/hardening/LOAD-TEST.md §5): EXPLAIN
 * regression tests for the two statements it serves, planned as the RUNTIME LOGIN.
 *
 *  - GET /attendance (AttendanceService.list): `ORDER BY a.clock_in_at DESC, a.id DESC LIMIT 50` inside the workspace must be
 *    an ordered scan of attendance_workspace_clock_in_idx that stops after the page, never a sort of every attendance row
 *    (the load test measured 598 ms per page without the index, 1.5 ms with it, at 90k rows).
 *  - The shift-report list's per-report delivery count (`eo.attachment_file_id = b.final_file_id`, ShiftReportService) must be
 *    an index probe of email_outbox_attachment_file_idx, never a sequential scan of the outbox per report.
 *
 * Method as index-fix-claim-plans (rab-worker): the test cluster's superuser seeds synthetic rows in ONE transaction that is
 * always rolled back (replica mode skips the foreign-key and trigger checks of the synthetic parents), ANALYZEs inside it,
 * then `SET LOCAL ROLE crewflow_owner` (NOBYPASSRLS; FORCE RLS on both tables) with the transaction-local GUCs
 * TenantContextService binds, so the plans carry the production RLS predicates. Asserted on SHAPE only (the index, no Sort,
 * no sequential scan of the big table); timings are printed, never asserted.
 *
 * The statement fragments the indexes depend on are COPIES of the service source; the first test proves they still occur
 * there verbatim, so a change of the list order or of the delivery join fails here instead of silently losing the index.
 */
const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(300_000);

const ORG = '1e000000-0000-4000-8000-000000000001';
const WS_BIG = '1e000000-0000-4000-8000-0000000000b1';
const WS_SMALL = '1e000000-0000-4000-8000-0000000000b2';
const FILE = '1e000000-0000-4000-8000-0000000000f1';
const ATTENDANCE = 40_000;
const OUTBOX = 40_000;

const usesIndex = (name: string) => new RegExp(`(Index Scan( Backward)? using|Index Only Scan using|Bitmap Index Scan on) ${name}( |$)`, 'm');
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
const source = (rel: string) => squash(readFileSync(join(__dirname, '..', '..', rel), 'utf8'));

describeIfDb('M9 load-test indexes: attendance list order and report delivery probe as the runtime login (EXPLAIN regression)', () => {
  let admin: Client;

  const explain = async (label: string, sql: string, params: unknown[] = []): Promise<string> => {
    await admin.query('SAVEPOINT plan');
    let plan = '';
    try {
      const { rows } = await admin.query(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`, params);
      plan = rows.map((r: Record<string, string>) => r['QUERY PLAN']).join('\n');
    } finally {
      await admin.query('ROLLBACK TO SAVEPOINT plan');
    }
    // eslint-disable-next-line no-console
    console.log(`--- ${label}\n${plan}`);
    return plan;
  };

  /** TenantContextService.bindGucs, as the runtime login (transaction-local); a manager user of the big workspace. */
  const asRuntime = async (workspaceId: string) => {
    await admin.query('SET LOCAL ROLE crewflow_owner');
    await admin.query(
      `SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true), set_config('rab.user_id', gen_random_uuid()::text, true),
              set_config('rab.role', 'manager', true), set_config('rab.actor_type', 'user', true), set_config('rab.team_shift_id', '', true),
              set_config('rab.team_staff_id', '', true), set_config('rab.admin_scope', '', true), set_config('rab.upgrade_scope', '', true),
              set_config('search_path', 'core', true), set_config('jit', 'off', true)`,
      [ORG, workspaceId],
    );
  };

  beforeAll(async () => {
    admin = new Client({ connectionString: integrationTestDatabase().adminUrl });
    await admin.connect();
    await admin.query('BEGIN');
    // Synthetic rows only, never committed. Replica mode skips the FK / trigger checks of the synthetic parents (superuser).
    await admin.query(`SET LOCAL session_replication_role = replica`);
    await admin.query(`INSERT INTO core.organisation (id, name, slug) VALUES ($1, 'idx-m9', 'idx-m9-load-test')`, [ORG]);
    // 90 % of the attendance in one workspace (the large agency of the load test), the rest in another; one clock-in a
    // minute going back in time, approved and clocked out (the shape history has).
    await admin.query(
      `INSERT INTO core.attendance (organisation_id, workspace_id, shift_assignment_id, shift_id, staff_profile_id, clock_in_at, clock_out_at, status,
                                    worked_minutes, earned_pence, break_minutes)
       SELECT $1, CASE WHEN g % 10 = 0 THEN $3::uuid ELSE $2::uuid END, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
              now() - make_interval(mins => g), now() - make_interval(mins => g) + interval '5 hours', 'approved', 300, 7500, 0
         FROM generate_series(1, $4) g`,
      [ORG, WS_BIG, WS_SMALL, ATTENDANCE],
    );
    // Outbox: 2 % of the rows carry an attachment (final timesheets, statements), two of them the report file under test.
    await admin.query(
      `INSERT INTO core.email_outbox (organisation_id, job_type, status, recipient_email, rendered_subject, created_at, updated_at, sent_at, attachment_file_id)
       SELECT $1, 'NOTIFICATION', 'SENT', 'idx' || g || '@example.test', 's', now() - make_interval(mins => g), now() - make_interval(mins => g), now() - make_interval(mins => g),
              CASE WHEN g <= 2 THEN $2::uuid WHEN g % 50 = 0 THEN gen_random_uuid() END
         FROM generate_series(1, $3) g`,
      [ORG, FILE, OUTBOX],
    );
    await admin.query(`SET LOCAL session_replication_role = origin`);
    for (const t of ['attendance', 'email_outbox']) await admin.query(`ANALYZE core.${t}`);
  });

  afterAll(async () => {
    await admin?.query('ROLLBACK').catch(() => undefined);
    await admin?.end().catch(() => undefined);
  });

  it('the list order and the delivery join the indexes serve still occur verbatim in the services', () => {
    const attendance = source('modules/attendance/services/attendance.service.ts');
    expect(attendance).toContain(squash(`clockInAt: 'a.clock_in_at',`));
    expect(attendance).toContain(squash('ORDER BY ${sortColumn} ${direction}, a.id ${direction} LIMIT ${takeIdx} OFFSET ${skipIdx}'));
    expect(attendance).toContain(squash(`ATTENDANCE_SORT_COLUMNS[sortKey ?? 'clockInAt']`));
    expect(attendance).toContain(squash(`const direction = (dto.direction ?? 'desc').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';`));
    expect(source('modules/attendance/services/shift-report.service.ts')).toContain(squash('eo.attachment_file_id = b.final_file_id'));
  });

  it('both indexes exist and are VALID', async () => {
    const { rows } = await admin.query(
      `SELECT c.relname, i.indisvalid AND i.indisready AS ok FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
        WHERE c.relnamespace = 'core'::regnamespace AND c.relname = ANY($1) ORDER BY 1`,
      [['attendance_workspace_clock_in_idx', 'email_outbox_attachment_file_idx']],
    );
    expect(rows).toEqual(['attendance_workspace_clock_in_idx', 'email_outbox_attachment_file_idx'].map((relname) => ({ relname, ok: true })));
  });

  it.each([
    ['first page', 0],
    ['tenth page', 450],
  ])('attendance list, newest first (%s): an ordered scan of attendance_workspace_clock_in_idx, no Sort, no Seq Scan', async (_label, offset) => {
    await admin.query('SAVEPOINT ctx');
    await asRuntime(WS_BIG);
    const plan = await explain(`attendance list offset ${offset}`, 'SELECT a.id, a.clock_in_at FROM core.attendance a ORDER BY a.clock_in_at DESC, a.id DESC LIMIT $1 OFFSET $2', [50, offset]);
    await admin.query('ROLLBACK TO SAVEPOINT ctx');
    expect(plan).toMatch(usesIndex('attendance_workspace_clock_in_idx'));
    expect(plan).not.toMatch(/\bSort\b/);
    expect(plan).not.toMatch(/Seq Scan on attendance/);
  });

  it('attendance list, oldest first: the same index walked backwards, no Sort', async () => {
    await admin.query('SAVEPOINT ctx');
    await asRuntime(WS_BIG);
    const plan = await explain('attendance list ascending', 'SELECT a.id FROM core.attendance a ORDER BY a.clock_in_at ASC, a.id ASC LIMIT 50');
    await admin.query('ROLLBACK TO SAVEPOINT ctx');
    expect(plan).toMatch(usesIndex('attendance_workspace_clock_in_idx'));
    expect(plan).not.toMatch(/\bSort\b/);
  });

  it('report delivery count for one final timesheet: an index probe of email_outbox_attachment_file_idx, no Seq Scan of the outbox', async () => {
    await admin.query('SAVEPOINT ctx');
    await asRuntime(WS_BIG);
    const plan = await explain(
      'delivery count',
      `SELECT count(*) FILTER (WHERE eo.status = 'SENT') AS d_sent FROM core.email_outbox eo WHERE eo.attachment_file_id = $1 AND eo.status <> 'CANCELLED'`,
      [FILE],
    );
    await admin.query('ROLLBACK TO SAVEPOINT ctx');
    expect(plan).toMatch(usesIndex('email_outbox_attachment_file_idx'));
    expect(plan).not.toMatch(/Seq Scan on email_outbox/);
  });

  it('RLS still applies under the runtime login: the small workspace sees only its own rows through the new index', async () => {
    await admin.query('SAVEPOINT ctx');
    await asRuntime(WS_SMALL);
    const { rows } = await admin.query(`SELECT count(*)::int AS n, count(*) FILTER (WHERE workspace_id <> $1)::int AS foreign FROM core.attendance`, [WS_SMALL]);
    await admin.query('ROLLBACK TO SAVEPOINT ctx');
    expect(rows[0]).toEqual({ n: ATTENDANCE / 10, foreign: 0 });
  });
});
