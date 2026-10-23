// Wave 6 lane E2E — volume seed for the DISPOSABLE e2e database only (127.0.0.1:15470/rab_e2e; refuses anything else).
//
// Clones the real rows the business-flow spec created through the API (one staff member, shift, assignment, offer,
// attendance, payroll record, venue and job role in workspace A) into N workspaces with new ids, so every seeded row has
// exactly the shape the product writes (all columns, CHECKs, exclusion constraint, workspace-bound CHECK). Superuser,
// one transaction per workspace. Seeded users share the template's password hash (the synthetic suite password).
//
//   node packages/rab-e2e-testing/system/perf/seed.mjs <state.json> <env-file> [staff=2000] [shifts=1700] [perShift=4]
import { readFileSync } from 'node:fs';
import pg from 'pg';

const [stateFile, envFile, staffN = '2000', shiftN = '1700', perShiftN = '4', onlyStep = ''] = process.argv.slice(2);
const STAFF = Number(staffN);
const SHIFTS = Number(shiftN);
const PER = Number(perShiftN);
const env = Object.fromEntries(readFileSync(envFile, 'utf8').split(/\r?\n/).filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const state = JSON.parse(readFileSync(stateFile, 'utf8'));
const c = new pg.Client({ host: '127.0.0.1', port: 15470, user: 'rab', password: env.E2E_PG_SUPERUSER_PASSWORD, database: 'rab_e2e' });
await c.connect();
const db = (await c.query('select current_database() d, inet_server_port() p')).rows[0];
if (db.d !== 'rab_e2e') throw new Error('refusing: not the disposable e2e database');

const A = state.A;
const q = async (text, params = []) => (await c.query(text, params)).rows;
const cols = async (schema, table) =>
  (await q(`select column_name from information_schema.columns where table_schema = $1 and table_name = $2 and is_generated = 'NEVER' order by ordinal_position`, [schema, table])).map((r) => r.column_name);

/** INSERT INTO target(cols) SELECT cols FROM jsonb_populate_record(NULL::target, to_jsonb(template) || <overrides>) FROM <source query>. */
async function cloneInsert(targetSchema, table, templateSql, overridesSql, fromSql, params) {
  const cs = await cols(targetSchema, table);
  const list = cs.map((x) => `"${x}"`).join(', ');
  const sql = `insert into "${targetSchema}"."${table}" (${list})
    select ${cs.map((x) => `r."${x}"`).join(', ')}
    from ${fromSql}
    cross join lateral (select * from jsonb_populate_record(null::"${targetSchema}"."${table}", (${templateSql}) || (${overridesSql}))) r`;
  const res = await c.query(sql, params);
  return res.rowCount;
}

const tUser = (await q(`select u.id from core."user" u where u.email = $1`, [A.staffEmail]))[0].id;
const t = {
  user: tUser,
  profile: (await q(`select id from "${A.schema}".staff_profile where user_id = $1`, [tUser]))[0].id,
  shift: A.shiftId,
  assignment: (await q(`select id from "${A.schema}".shift_assignment where shift_id = $1`, [A.shiftId]))[0].id,
  offer: A.offerId,
  attendance: A.attendanceId,
  payroll: A.payrollRecordId,
  venue: A.venueId,
  role: A.jobRoleId,
};

const workspaces = await q(
  `select w.id, w.organisation_id, w.owner_user_id, w.subdomain, r.schema_name from core.manager_workspace w join core.workspace_schema_registry r on r.workspace_id = w.id where w.id = any($1::uuid[])`,
  [[A.workspaceId, state.B.workspaceId, ...(state.notes.perfThirdWorkspaceId ? [state.notes.perfThirdWorkspaceId] : [])]],
);
const report = { template: t, workspaces: [] };

/**
 * Finished seeded shifts get a finalised shift_report (as months of real operation would have left behind), pointing at
 * the real report file of the template shift. Without it the worker's final-timesheet job would try to render thousands of
 * historical PDFs at once (observed: ~300 % CPU) and distort every latency measurement.
 */
async function seedReports(w) {
  const S = w.schema_name;
  const tReport = (await q(`select id, original_file_id, final_file_id from "${A.schema}".shift_report where shift_id = $1`, [A.shiftId]))[0];
  const fileId = tReport?.final_file_id ?? tReport?.original_file_id ?? (await q(`select id from core.stored_file order by created_at limit 1`))[0]?.id;
  const res = await c.query(`insert into "${S}".shift_report (organisation_id, workspace_id, shift_id, status, finalised_at, finalised_by, final_pdf_sent_at, created_at, updated_at, original_file_id, final_file_id, signed_off_name, break_confirmed)
    select x.organisation_id, x.workspace_id, x.id, 'finalised', x.ends_at + interval '2 hours', $1::uuid, x.ends_at + interval '2 hours', x.ends_at, x.ends_at + interval '2 hours', $2::uuid, $2::uuid, 'Perf Seed', true
    from "${S}".shift x where x.notes like 'perf seed %' and x.ends_at < now() and not exists (select 1 from "${S}".shift_report r where r.shift_id = x.id) on conflict (shift_id) do nothing`, [w.owner_user_id, fileId]);
  return res.rowCount;
}
if (onlyStep === 'reports-only') {
  for (const w of workspaces) console.log(JSON.stringify({ workspace: w.subdomain, reports: await seedReports(w) }));
  await c.end();
  process.exit(0);
}
const now = Date.now();
for (const w of workspaces) {
  const t0 = Date.now();
  const S = w.schema_name;
  const tag = w.subdomain.replace(/[^a-z0-9]/g, '');
  await c.query('begin');
  try {
    await c.query(`set local synchronous_commit = off`);
    let staffRole = (await q(`select id from core.role where organisation_id = $1 and key = 'staff'`, [w.organisation_id]))[0]?.id;
    if (!staffRole) {
      // An organisation that has never created staff has no 'staff' role row yet: clone A's (and its grants).
      staffRole = (await q('select gen_random_uuid() id'))[0].id;
      const aRole = (await q(`select id from core.role where organisation_id = $1 and key = 'staff'`, [A.orgId]))[0].id;
      await cloneInsert('core', 'role', 'select to_jsonb(r) from core.role r where r.id = $1', "jsonb_build_object('id', $2::uuid, 'organisation_id', $3::uuid)", '(select 1) one', [aRole, staffRole, w.organisation_id]);
      await c.query('insert into core.role_permission (role_id, permission_id, organisation_id) select $1, permission_id, $2 from core.role_permission where role_id = $3', [staffRole, w.organisation_id, aRole]);
    }
    // Venue + job role (one each) for the seeded work.
    const venueId = (await q('select gen_random_uuid() id'))[0].id;
    const roleId = (await q('select gen_random_uuid() id'))[0].id;
    await cloneInsert(S, 'venue', `select to_jsonb(v) from "${A.schema}".venue v where v.id = $1`,
      `jsonb_build_object('id', $2::uuid, 'organisation_id', $3::uuid, 'workspace_id', $4::uuid, 'name', 'Perf Venue ' || $5::text, 'archived_at', null, 'archived_by', null, 'created_by', $6::uuid)`,
      '(select 1) one', [t.venue, venueId, w.organisation_id, w.id, tag, w.owner_user_id]);
    await cloneInsert(S, 'job_role', `select to_jsonb(j) from "${A.schema}".job_role j where j.id = $1`,
      `jsonb_build_object('id', $2::uuid, 'organisation_id', $3::uuid, 'workspace_id', $4::uuid, 'name', 'Perf Role ' || $5::text, 'archived_at', null, 'archived_by', null)`,
      '(select 1) one', [t.role, roleId, w.organisation_id, w.id, tag]);
    // Staff: core user + role + org/workspace membership + workspace staff_profile.
    await c.query(`create temp table seed_staff on commit drop as select n, gen_random_uuid() uid, gen_random_uuid() pid from generate_series(1, $1) n`, [STAFF]);
    await cloneInsert('core', 'user', `select to_jsonb(u) from core."user" u where u.id = $1`,
      `jsonb_build_object('id', s.uid, 'organisation_id', $2::uuid, 'email', format('perf%s.%s@perf-e2e.test', s.n, $3::text), 'first_name', 'Perf', 'last_name', format('Staff %s %s', $3::text, s.n), 'phone', null, 'status', 'active', 'created_at', now(), 'updated_at', now(), 'avatar_key', null, 'avatar_file_id', null)`,
      'seed_staff s', [t.user, w.organisation_id, tag]);
    await c.query(`insert into core.user_role (user_id, role_id, organisation_id) select uid, $1, $2 from seed_staff`, [staffRole, w.organisation_id]);
    await cloneInsert('core', 'organisation_member', `select to_jsonb(m) from core.organisation_member m where m.user_id = $1`,
      `jsonb_build_object('id', gen_random_uuid(), 'organisation_id', $2::uuid, 'user_id', s.uid)`, 'seed_staff s', [t.user, w.organisation_id]);
    await cloneInsert('core', 'workspace_membership', `select to_jsonb(m) from core.workspace_membership m where m.user_id = $1`,
      `jsonb_build_object('id', gen_random_uuid(), 'organisation_id', $2::uuid, 'user_id', s.uid, 'workspace_id', $3::uuid)`, 'seed_staff s', [t.user, w.organisation_id, w.id]);
    await cloneInsert(S, 'staff_profile', `select to_jsonb(p) from "${A.schema}".staff_profile p where p.id = $1`,
      `jsonb_build_object('id', s.pid, 'organisation_id', $2::uuid, 'workspace_id', $3::uuid, 'user_id', s.uid, 'staff_ref', format('PF-%s-%s', $4::text, s.n), 'created_by', $5::uuid, 'job_role_id', $6::uuid, 'employment_status', 'active', 'archived_at', null, 'archived_by', null)`,
      'seed_staff s', [t.profile, w.organisation_id, w.id, tag, w.owner_user_id, roleId]);
    // Shifts every 6 h from ~300 days ago; PER seats each; staff (k*PER + j) mod STAFF never overlap themselves.
    await c.query(`create temp table seed_shift on commit drop as
      select k, gen_random_uuid() sid, (now() - interval '300 days') + (k * interval '6 hours') starts from generate_series(0, $1 - 1) k`, [SHIFTS]);
    await cloneInsert(S, 'shift', `select to_jsonb(x) from "${A.schema}".shift x where x.id = $1`,
      `jsonb_build_object('id', h.sid, 'organisation_id', $2::uuid, 'workspace_id', $3::uuid, 'venue_id', $4::uuid, 'job_role_id', $5::uuid, 'starts_at', h.starts, 'ends_at', h.starts + interval '5 hours',
        'default_starts_at', null, 'default_ends_at', null, 'required_count', $6::int, 'filled_count', $6::int, 'break_minutes', 0, 'status', case when h.starts < now() then 'completed' else 'confirmed' end,
        'created_by', $7::uuid, 'requested_by', null, 'approved_by', null, 'approved_at', null, 'declined_by', null, 'declined_at', null, 'declined_reason', null, 'cancelled_by', null, 'cancelled_at', null, 'cancelled_reason', null,
        'archived_at', null, 'archived_by', null, 'recurrence_group_id', null, 'notes', format('perf seed %s', h.k), 'qr_version', 0)`,
      'seed_shift h', [t.shift, w.organisation_id, w.id, venueId, roleId, PER, w.owner_user_id]);
    await c.query(`create temp table seed_seat on commit drop as
      select h.k, j, h.sid, h.starts, ss.pid, gen_random_uuid() aid, gen_random_uuid() oid, gen_random_uuid() attid
      from seed_shift h cross join generate_series(0, $1 - 1) j join seed_staff ss on ss.n = ((h.k * $1 + j) % $2) + 1`, [PER, STAFF]);
    await cloneInsert(S, 'shift_assignment', `select to_jsonb(x) from "${A.schema}".shift_assignment x where x.id = $1`,
      `jsonb_build_object('id', z.aid, 'organisation_id', $2::uuid, 'workspace_id', $3::uuid, 'shift_id', z.sid, 'staff_profile_id', z.pid, 'status', case when z.starts < now() then 'completed' else 'confirmed' end,
        'assigned_by', $4::uuid, 'confirmed_at', z.starts - interval '2 days', 'period', tstzrange(z.starts, z.starts + interval '5 hours'),
        'attendance_reviewed_at', case when z.starts < now() then z.starts + interval '6 hours' end, 'attendance_reviewed_by', case when z.starts < now() then $4::uuid end,
        'checked_in_at', case when z.starts < now() then z.starts - interval '5 minutes' end, 'check_in_source', case when z.starts < now() then 'staff' end,
        'check_in_location_verified', case when z.starts < now() then true end, 'check_in_distance_m', null, 'check_in_accuracy_m', null, 'check_in_captured_at', null, 'check_in_required', true)`,
      'seed_seat z', [t.assignment, w.organisation_id, w.id, w.owner_user_id]);
    await cloneInsert(S, 'job_offer', `select to_jsonb(x) from "${A.schema}".job_offer x where x.id = $1`,
      `jsonb_build_object('id', z.oid, 'organisation_id', $2::uuid, 'workspace_id', $3::uuid, 'shift_assignment_id', z.aid, 'staff_profile_id', z.pid, 'status', 'manager_confirmed',
        'sent_at', z.starts - interval '3 days', 'expires_at', z.starts - interval '1 day', 'responded_at', z.starts - interval '2 days', 'staff_accepted_at', z.starts - interval '2 days',
        'manager_confirmed_at', z.starts - interval '2 days', 'confirmed_by', $4::uuid, 'created_by', $4::uuid, 'created_at', z.starts - interval '3 days', 'offer_batch_id', null, 'rejected_by', null, 'manager_rejected_at', null)`,
      'seed_seat z', [t.offer, w.organisation_id, w.id, w.owner_user_id]);
    await cloneInsert(S, 'attendance', `select to_jsonb(x) from "${A.schema}".attendance x where x.id = $1`,
      `jsonb_build_object('id', z.attid, 'organisation_id', $2::uuid, 'workspace_id', $3::uuid, 'shift_assignment_id', z.aid, 'shift_id', z.sid, 'staff_profile_id', z.pid,
        'clock_in_at', z.starts, 'clock_out_at', z.starts + interval '5 hours', 'worked_minutes', 300, 'earned_pence', 7250, 'break_minutes', 0, 'created_at', z.starts, 'updated_at', z.starts + interval '5 hours',
        'post_shift_completed_at', z.starts + interval '6 hours', 'post_shift_expired_at', null, 'clock_in_by', null, 'clock_out_by', null, 'clock_in_reason', null, 'clock_out_reason', null,
        'clock_in_method', 'staff', 'clock_out_method', 'manual', 'clock_in_captured_at', null)`,
      '(select * from seed_seat where starts < now() - interval \'6 hours\') z', [t.attendance, w.organisation_id, w.id]);
    await seedReports(w);
    await c.query('commit');
  } catch (e) {
    await c.query('rollback');
    throw e;
  }
  const counts = {};
  for (const tb of ['staff_profile', 'shift', 'shift_assignment', 'job_offer', 'attendance', 'payroll_record']) counts[tb] = Number((await q(`select count(*)::int n from "${S}".${tb}`))[0].n);
  report.workspaces.push({ workspace: w.subdomain, schema: S, ms: Date.now() - t0, counts });
  console.log(JSON.stringify(report.workspaces.at(-1)));
}

// Payroll-run volume in A: approved records for ~600 seeded past attendances whose work date is in one past period.
const t1 = Date.now();
const prA = await c.query(`
  insert into "${A.schema}".payroll_record (${(await cols(A.schema, 'payroll_record')).map((x) => `"${x}"`).join(', ')})
  select ${(await cols(A.schema, 'payroll_record')).map((x) => `r."${x}"`).join(', ')}
  from (select a.* from "${A.schema}".attendance a join "${A.schema}".shift s on s.id = a.shift_id
        where s.notes like 'perf seed %' and a.clock_in_at >= $2::date and a.clock_in_at < $3::date
          and not exists (select 1 from "${A.schema}".payroll_record p where p.attendance_id = a.id)) a
  cross join lateral (select * from jsonb_populate_record(null::"${A.schema}".payroll_record,
    (select to_jsonb(p) from "${A.schema}".payroll_record p where p.id = $1) ||
    jsonb_build_object('id', gen_random_uuid(), 'attendance_id', a.id, 'shift_id', a.shift_id, 'staff_profile_id', a.staff_profile_id, 'status', 'approved',
      'worked_minutes', 300, 'pay_rate_pence', 1450, 'amount_pence', 7250, 'approved_at', a.clock_out_at + interval '1 day', 'created_at', a.clock_out_at,
      'updated_at', a.clock_out_at + interval '1 day', 'statement_status', 'none', 'statement_file_id', null, 'statement_generated_at', null, 'statement_notified_at', null,
      'statement_attempts', 0, 'statement_error', null, 'statement_dispatch_generation', 0, 'statement_queued_at', null, 'statement_processing_at', null))) r`,
  [t.payroll, state.notes.perfPeriod?.start ?? '2026-10-03', state.notes.perfPeriod?.endExclusive ?? '2026-10-17']);
report.payrollSeed = { rows: prA.rowCount, ms: Date.now() - t1 };
console.log(JSON.stringify({ payrollSeed: report.payrollSeed }));
await c.query('analyze');
await c.end();
console.log(JSON.stringify({ done: true, totalWorkspaces: report.workspaces.length, now: new Date(now).toISOString() }));
