// M9 hardening (Lane F) — production-scale volume seed for a DISPOSABLE database only.
//
// Extends the wave-6 perf seed (seed.mjs: clone the rows the product itself wrote, so every seeded row has the exact
// shape, CHECKs and constraints of real data) to the M9 target: 5,000 staff and 50,000 shifts in ONE organisation's
// workspace, plus the live work a load test needs:
//
//   past      completed shifts over the last 365 days, 2 seats each: assignment `completed`, offer `manager_confirmed`,
//             attendance `approved`, payroll record (`approved`, or `pending_approval` for the last 14 days), and a
//             finalised shift report (as months of real operation leave behind; without it the Worker's final-timesheet
//             job would try to render tens of thousands of historical PDFs at once and distort every measurement).
//   future    confirmed shifts over the next 30 days, 2 seats each (scheduling reads, calendar, dashboard).
//   offered   one-seat shifts 3-30 days ahead with a PENDING offer to one staff member each (staff accept/decline).
//   live      shifts whose clock-in window opens during the load test (staggered starts from --live-start over
//             --live-minutes), 2 confirmed seats each, at venues that do not enforce a geofence: check-in, clock-in and
//             clock-out by the staff app.
//
// Template: the console organisation written by packages/rab-e2e-testing/live/seed-live-e2e.ts (production role
// definitions, a real workspace, real staff/offer/attendance/payroll rows). Seeded users share the template staff
// member's password hash, i.e. the live seed's random per-run password (live.env E2E_SEED_PASSWORD).
//
// Refusals: a non-loopback host; a database whose catalog does not carry crewflow.disposable_test_database=true (the
// live seed's own guard, set by the operator with ALTER DATABASE on a throwaway cluster); a non-superuser login; a
// workspace that already holds perf rows.
//
//   PERF_ADMIN_URL=postgres://<superuser>@127.0.0.1:<port>/<db>[?sslmode=verify-full] [PERF_PG_CA=<ca.crt>] \
//     node packages/rab-e2e-testing/system/perf/seed-volume.mjs [--staff 5000] [--shifts 50000] [--live-bookings 1500] \
//       [--pending-offers 2000] [--live-start <ISO>] [--live-minutes 30] [--out <summary.json>]
//     [--batch live]   only another batch of live + offered work for the staff and venues a full run created (a second
//                      load-test run after fixes needs fresh bookings and pending offers; past/future history is reused).
import { readFileSync, writeFileSync } from 'node:fs';
import pg from 'pg';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const STAFF = Number(args.staff ?? 5000);
const SHIFTS = Number(args.shifts ?? 50000);
const LIVE_BOOKINGS = Number(args['live-bookings'] ?? 1500);
const PENDING_OFFERS = Number(args['pending-offers'] ?? 2000);
const LIVE_START = new Date(args['live-start'] ?? Date.now() + 10 * 60_000);
const LIVE_MINUTES = Number(args['live-minutes'] ?? 30);
const VENUES = 20;
const CONSOLE_ADMIN_EMAIL = process.env.E2E_SEED_EMAIL ?? 'admin@acme.test';

const LIVE_ONLY = args.batch === 'live';
const BATCH = LIVE_ONLY ? `b${Date.now().toString(36)}` : 'b0';
const LIVE_SHIFTS = Math.ceil(LIVE_BOOKINGS / 2);
const OFFERED_SHIFTS = PENDING_OFFERS;
const FUTURE_SHIFTS = LIVE_ONLY ? 0 : Math.round((SHIFTS - LIVE_SHIFTS - OFFERED_SHIFTS) * 0.05);
const PAST_SHIFTS = LIVE_ONLY ? 0 : SHIFTS - LIVE_SHIFTS - OFFERED_SHIFTS - FUTURE_SHIFTS;
if ((!LIVE_ONLY && PAST_SHIFTS <= 0) || LIVE_BOOKINGS + PENDING_OFFERS > STAFF) throw new Error('refusing: inconsistent volume arguments');

const url = new URL(process.env.PERF_ADMIN_URL ?? '');
if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)) throw new Error('refusing: PERF_ADMIN_URL is not a loopback host');
const ssl = process.env.PERF_PG_CA ? { ca: readFileSync(process.env.PERF_PG_CA, 'utf8'), rejectUnauthorized: true } : undefined;
url.searchParams.delete('sslmode');
const c = new pg.Client({ connectionString: url.toString(), ssl });
await c.connect();
const q = async (text, params = []) => (await c.query(text, params)).rows;

// The marker is read from the CATALOG (ALTER DATABASE ... SET, pg_db_role_setting), never from current_setting(): a
// connection option or PGOPTIONS could set the session value and fake it.
const [guard] = await q(
  `select exists (select 1 from pg_db_role_setting s, unnest(s.setconfig) c
                   where s.setdatabase = (select oid from pg_database where datname = current_database()) and s.setrole = 0
                     and c = 'crewflow.disposable_test_database=true') marker,
          (select rolsuper from pg_roles where rolname = current_user) su`,
);
if (guard.marker !== true) throw new Error('refusing: the database is not marked crewflow.disposable_test_database=true in its catalog (ALTER DATABASE ... SET)');
if (!guard.su) throw new Error('refusing: the seed needs the disposable cluster superuser (fixture connection)');

const [admin] = await q(`select u.id, u.organisation_id from core."user" u where lower(u.email) = lower($1)`, [CONSOLE_ADMIN_EMAIL]);
if (!admin) throw new Error('template missing: run live/seed-live-e2e.ts first');
const ORG = admin.organisation_id;
const [ws] = await q(`select id from core.manager_workspace where organisation_id = $1 order by created_at limit 1`, [ORG]);
const WS = ws.id;
// HWS off (production): business rows live in core; HWS on: in the workspace's own schema.
const [hws] = await q(`select current_setting('crewflow.hws_runtime_enabled', true) v`);
const [reg] = await q(`select schema_name from core.workspace_schema_registry where workspace_id = $1`, [WS]);
const S = process.env.PERF_BUSINESS_SCHEMA ?? (hws.v === 'true' && reg ? reg.schema_name : 'core');
const seeded = (await q(`select 1 from "${S}".shift where workspace_id = $1 and notes like 'perf volume %' limit 1`, [WS])).length > 0;
if (LIVE_ONLY && !seeded) throw new Error('refusing: --batch live needs a full run first');
if (!LIVE_ONLY && seeded) {
  throw new Error('refusing: this workspace already holds perf volume rows (seed a fresh database)');
}

const cols = async (schema, table) =>
  (await q(`select column_name from information_schema.columns where table_schema = $1 and table_name = $2 and is_generated = 'NEVER' order by ordinal_position`, [schema, table])).map((r) => r.column_name);
/** INSERT target(cols) SELECT cols FROM <from> CROSS JOIN LATERAL jsonb_populate_record(NULL::target, template || overrides). */
async function cloneInsert(schema, table, templateSql, overridesSql, fromSql, params) {
  const cs = await cols(schema, table);
  const list = cs.map((x) => `"${x}"`).join(', ');
  const res = await c.query(
    `insert into "${schema}"."${table}" (${list})
     select ${cs.map((x) => `r."${x}"`).join(', ')} from ${fromSql}
     cross join lateral (select * from jsonb_populate_record(null::"${schema}"."${table}", (${templateSql}) || (${overridesSql}))) r`,
    params,
  );
  return res.rowCount;
}

// Templates (the live seed's console organisation).
const one = async (sql, params) => (await q(sql, params))[0];
const t = {};
t.staff = await one(`select p.id profile, p.user_id from "${S}".staff_profile p join core."user" u on u.id = p.user_id where p.workspace_id = $1 and p.employment_status = 'active' order by p.created_at limit 1`, [WS]);
t.completed = await one(`select s.id shift, a.id assignment, att.id attendance, pr.id payroll from "${S}".shift s join "${S}".shift_assignment a on a.shift_id = s.id join "${S}".attendance att on att.shift_assignment_id = a.id join "${S}".payroll_record pr on pr.attendance_id = att.id where s.workspace_id = $1 and s.status = 'completed' and pr.status = 'approved' limit 1`, [WS]);
t.offer = await one(`select o.id offer, o.shift_assignment_id assignment, a.shift_id shift from "${S}".job_offer o join "${S}".shift_assignment a on a.id = o.shift_assignment_id where o.workspace_id = $1 and o.status = 'pending' limit 1`, [WS]);
t.venue = await one(`select id from "${S}".venue where workspace_id = $1 and name = 'Riverside Kitchen'`, [WS]);
t.role = await one(`select id from "${S}".job_role where workspace_id = $1 and name = 'Bartender'`, [WS]);
for (const [k, v] of Object.entries(t)) if (!v) throw new Error(`template missing: ${k}`);
const [staffRole] = await q(`select ur.role_id from core.user_role ur where ur.user_id = $1`, [t.staff.user_id]);

// Each live batch takes the next block of staff, so consecutive batches do not reuse the same people (the previous batch's
// bookings may still be open).
const STAFF_OFFSET = LIVE_ONLY
  ? (Number((await one(`select count(distinct split_part(notes, ' ', 4)) n from "${S}".shift where workspace_id = $1 and notes like 'perf volume live %'`, [WS])).n) *
      (LIVE_BOOKINGS + PENDING_OFFERS)) % STAFF
  : 0;
const summary = { batch: BATCH, org: ORG, workspace: WS, schema: S, liveStart: LIVE_START.toISOString(), liveMinutes: LIVE_MINUTES, volumes: { STAFF, PAST_SHIFTS, FUTURE_SHIFTS, OFFERED_SHIFTS, LIVE_SHIFTS }, steps: [] };
const step = async (name, fn) => {
  const t0 = Date.now();
  const rows = await fn();
  summary.steps.push({ name, rows, ms: Date.now() - t0 });
  console.log(JSON.stringify({ step: name, rows, ms: Date.now() - t0 }));
};

/**
 * Months of real operation leave every approved historical payroll record with its generated pay statement and every
 * finalised shift report with its final timesheet. Without these the Worker's statement and timesheet jobs would start
 * rendering ~90,000 PDFs the moment it boots and dominate every measurement. One shared placeholder object per kind
 * (the operator puts it in the test bucket: PERF_S3_BUCKET / PERF_S3_PREFIX, see LOAD-TEST.md) stands in for them.
 */
async function historicalDocuments() {
  const bucket = process.env.PERF_S3_BUCKET ?? 'crewtest-lanef';
  const prefix = process.env.PERF_S3_PREFIX ?? 'production';
  const file = async (kind, key, resourceType) =>
    (await one(
      `insert into core.stored_file (organisation_id, workspace_id, kind, resource_type, resource_id, storage_driver, bucket, object_key, original_filename, mime_type, size_bytes, sha256, status, created_by)
       values ($1, $2, $3, $4, $2, 'S3', $5, $6, 'placeholder.pdf', 'application/pdf', 24, repeat('0', 64), 'AVAILABLE', $7) returning id`,
      [ORG, WS, kind, resourceType, bucket, `${prefix}/perf/${key}`, admin.id],
    )).id;
  const statement = await file('APPROVED_SHIFT_STATEMENT_PDF', 'statement-placeholder.pdf', 'payroll_record');
  const timesheet = await file('FINAL_TIMESHEET_PDF', 'timesheet-placeholder.pdf', 'shift_report');
  const a = await c.query(
    `update "${S}".payroll_record set statement_status = 'generated', statement_file_id = $2, statement_generated_at = approved_at + interval '1 hour',
       statement_notified_at = approved_at + interval '1 hour', statement_attempts = 1, statement_error = null
     from v_seat z where z.kind = 'past' and z.prid = payroll_record.id and payroll_record.workspace_id = $1 and payroll_record.status = 'approved'`, [WS, statement]);
  const b = await c.query(`update "${S}".shift_report set final_file_id = $2, original_file_id = $2 from v_shift h where h.kind = 'past' and h.sid = shift_report.shift_id and shift_report.workspace_id = $1`, [WS, timesheet]);
  return a.rowCount + b.rowCount;
}

/**
 * The agency payment calendar the organisation's Initial Manager would have imported (POST /payroll/calendar/import is
 * Initial-Manager-only): 4-week periods from 13 months ago to next month, payday 5 days after each period ends. Written
 * as the import writes it (core.payroll_calendar + core.payroll_calendar_period, one active calendar).
 */
async function payrollCalendar() {
  if ((await q(`select 1 from core.payroll_calendar where organisation_id = $1 and status = 'active'`, [ORG])).length) return 0;
  const year = new Date().getUTCFullYear();
  const cal = await one(
    `insert into core.payroll_calendar (organisation_id, year, version, source, timezone, status, notes, created_by)
     values ($1, $2, 1, 'Load test calendar', 'Europe/London', 'active', 'perf volume seed', $3) returning id`, [ORG, year, admin.id]);
  const res = await c.query(
    `insert into core.payroll_calendar_period (organisation_id, calendar_id, period_start, period_end, payday, note, needs_confirmation, active)
     select $1, $2, d::date, (d + interval '27 days')::date, (d + interval '32 days')::date, null, false, true
     from generate_series(date_trunc('week', now() - interval '392 days'), now() + interval '28 days', interval '28 days') d`, [ORG, cal.id]);
  return res.rowCount;
}

await c.query('begin');
try {
  await c.query(`set local synchronous_commit = off`);
  if (LIVE_ONLY) {
    await c.query(`create temp table v_venue on commit drop as select 0 i, $1::uuid id union all select substring(name from 12)::int i, id from "${S}".venue where workspace_id = $2 and name ~ '^Perf Venue [0-9]+$'`, [t.venue.id, WS]);
    await c.query(`create temp table v_staff on commit drop as select substring(u.email from '^perf([0-9]+)@')::int n, u.id uid, p.id pid from core."user" u join "${S}".staff_profile p on p.user_id = u.id where u.email like 'perf%@perf-lanef.test' and p.workspace_id = $1`, [WS]);
  } else {
  // Venues: Riverside (the Venue Manager's) + 19 clones; no geofence enforcement on any (location is not under test).
  await c.query(`create temp table v_venue on commit drop as select 0 i, $1::uuid id union all select i, gen_random_uuid() from generate_series(1, $2 - 1) i`, [t.venue.id, VENUES]);
  await step('venue', () => cloneInsert(S, 'venue', `select to_jsonb(v) from "${S}".venue v where v.id = $1`,
    `jsonb_build_object('id', x.id, 'name', 'Perf Venue ' || x.i)`, '(select * from v_venue where i > 0) x', [t.venue.id]));
  await c.query(`update "${S}".venue set enforce_geofence = false where id in (select id from v_venue)`);

  // Staff: core user + role + organisation member + workspace membership + staff profile, all cloned from the template.
  await c.query(`create temp table v_staff on commit drop as select n, gen_random_uuid() uid, gen_random_uuid() pid from generate_series(1, $1) n`, [STAFF]);
  await step('user', () => cloneInsert('core', 'user', `select to_jsonb(u) from core."user" u where u.id = $1`,
    `jsonb_build_object('id', s.uid, 'email', format('perf%s@perf-lanef.test', s.n), 'first_name', 'Perf', 'last_name', format('Staff %s', s.n), 'phone', null, 'status', 'active', 'created_at', now(), 'updated_at', now(), 'avatar_key', null, 'avatar_file_id', null)`,
    'v_staff s', [t.staff.user_id]));
  await step('user_role', async () => (await c.query(`insert into core.user_role (user_id, role_id, organisation_id) select uid, $1, $2 from v_staff`, [staffRole.role_id, ORG])).rowCount);
  // Membership rows exactly as the template staff member has them (a staff member may have none of one kind).
  if ((await q(`select 1 from core.organisation_member where user_id = $1`, [t.staff.user_id])).length)
  await step('organisation_member', () => cloneInsert('core', 'organisation_member', `select to_jsonb(m) from core.organisation_member m where m.user_id = $1`,
    `jsonb_build_object('id', gen_random_uuid(), 'user_id', s.uid)`, 'v_staff s', [t.staff.user_id]));
  if ((await q(`select 1 from core.workspace_membership where user_id = $1`, [t.staff.user_id])).length)
  await step('workspace_membership', () => cloneInsert('core', 'workspace_membership', `select to_jsonb(m) from core.workspace_membership m where m.user_id = $1`,
    `jsonb_build_object('id', gen_random_uuid(), 'user_id', s.uid)`, 'v_staff s', [t.staff.user_id]));
  await step('staff_profile', () => cloneInsert(S, 'staff_profile', `select to_jsonb(p) from "${S}".staff_profile p where p.id = $1`,
    `jsonb_build_object('id', s.pid, 'user_id', s.uid, 'staff_ref', format('PF-%s', s.n), 'employment_status', 'active', 'archived_at', null, 'archived_by', null, 'created_at', now() - make_interval(days => (s.n % 700)))`,
    'v_staff s', [t.staff.profile]));
  }

  // Shifts. kind: past | future | offered | live. Seats: past/future/live 2, offered 1.
  // Staff use: live bookings -> a block of LIVE_BOOKINGS staff; pending offers -> the next PENDING_OFFERS; past and future
  // cycle over all staff with no self-overlap (a staff member's consecutive bookings are thousands of shifts apart).
  await c.query(
    `create temp table v_shift on commit drop as
     select 'past'::text kind, k, gen_random_uuid() sid, now() - interval '366 days' + k * (interval '365 days' / greatest($1, 1)) starts, interval '5 hours' len from generate_series(0, $1 - 1) k
     union all select 'future', k, gen_random_uuid(), date_trunc('hour', now()) + interval '1 day' + k * (interval '29 days' / greatest($2, 1)), interval '6 hours' from generate_series(0, $2 - 1) k
     union all select 'offered', k, gen_random_uuid(), date_trunc('hour', now()) + interval '3 days' + k * (interval '27 days' / greatest($3, 1)), interval '6 hours' from generate_series(0, $3 - 1) k
     union all select 'live', k, gen_random_uuid(), $5::timestamptz + k * (make_interval(mins => $6) / greatest($4, 1)), interval '30 minutes' from generate_series(0, $4 - 1) k`,
    [PAST_SHIFTS, FUTURE_SHIFTS, OFFERED_SHIFTS, LIVE_SHIFTS, LIVE_START, LIVE_MINUTES],
  );
  await c.query(
    `create temp table v_seat on commit drop as
     select h.kind, h.k, j, h.sid, h.starts, h.len, ss.pid, gen_random_uuid() aid, gen_random_uuid() oid, gen_random_uuid() attid, gen_random_uuid() prid
     from v_shift h cross join generate_series(0, 1) j
     join v_staff ss on ss.n = case h.kind
       when 'live' then ((h.k * 2 + j + $3) % $2) + 1
       when 'offered' then (($1 + h.k + $3) % $2) + 1
       when 'past' then ((h.k * 2 + j) % $2) + 1
       else ((h.k * 2 + j + 7) % $2) + 1 end
     where h.kind <> 'offered' or j = 0`,
    [LIVE_BOOKINGS, STAFF, STAFF_OFFSET],
  );
  await c.query(`delete from v_seat where kind = 'live' and (k * 2 + j) >= $1`, [LIVE_BOOKINGS]);
  // A later batch never double-books anyone (shift_assignment_no_double_booking): drop the seats whose staff member already
  // holds an overlapping booking, then the live / offered shifts left without a seat.
  await c.query(`delete from v_seat z where z.kind in ('live', 'offered') and exists (select 1 from "${S}".shift_assignment a where a.staff_profile_id = z.pid and a.period && tstzrange(z.starts, z.starts + z.len))`);
  await c.query(`delete from v_shift h where h.kind in ('live', 'offered') and not exists (select 1 from v_seat z where z.sid = h.sid)`);
  await c.query('analyze v_shift; analyze v_seat; analyze v_staff');
  await step('shift', () => cloneInsert(S, 'shift', `select to_jsonb(x) from "${S}".shift x where x.id = $1`,
    `jsonb_build_object('id', h.sid, 'venue_id', (select id from v_venue where i = h.k % ${VENUES}), 'job_role_id', $2::uuid, 'starts_at', h.starts, 'ends_at', h.starts + h.len,
      'default_starts_at', null, 'default_ends_at', null, 'required_count', case h.kind when 'offered' then 1 else 2 end, 'filled_count', case h.kind when 'offered' then 0 else 2 end,
      'break_minutes', 0, 'status', case h.kind when 'past' then 'completed' when 'offered' then 'offered' else 'confirmed' end, 'created_by', $3::uuid,
      'requested_by', null, 'approved_by', null, 'approved_at', null, 'declined_by', null, 'declined_at', null, 'declined_reason', null, 'cancelled_by', null, 'cancelled_at', null, 'cancelled_reason', null,
      'archived_at', null, 'archived_by', null, 'recurrence_group_id', null, 'notes', format('perf volume %s %s %s', h.kind, $4::text, h.k), 'qr_version', 0, 'created_at', least(h.starts - interval '7 days', now()), 'updated_at', least(h.starts, now()))`,
    'v_shift h', [t.completed.shift, t.role.id, admin.id, BATCH]));

  await step('shift_assignment', () => cloneInsert(S, 'shift_assignment', `select to_jsonb(x) from "${S}".shift_assignment x where x.id = $1`,
    `jsonb_build_object('id', z.aid, 'shift_id', z.sid, 'staff_profile_id', z.pid,
      'status', case z.kind when 'past' then 'completed' when 'offered' then 'offered' else 'confirmed' end,
      'assigned_by', $2::uuid, 'confirmed_at', case when z.kind = 'offered' then null else z.starts - interval '2 days' end, 'period', tstzrange(z.starts, z.starts + z.len),
      'attendance_reviewed_at', case when z.kind = 'past' then z.starts + z.len + interval '1 hour' end, 'attendance_reviewed_by', case when z.kind = 'past' then $2::uuid end,
      'checked_in_at', case when z.kind = 'past' then z.starts - interval '5 minutes' end, 'check_in_source', case when z.kind = 'past' then 'staff' end,
      'check_in_location_verified', case when z.kind = 'past' then true end, 'check_in_distance_m', null, 'check_in_accuracy_m', null, 'check_in_captured_at', null,
      'check_in_required', true, 'pay_rate_snapshot_pence', 1500, 'created_at', least(z.starts - interval '3 days', now()))`,
    'v_seat z', [t.completed.assignment, admin.id]));
  await step('job_offer', () => cloneInsert(S, 'job_offer', `select to_jsonb(x) from "${S}".job_offer x where x.id = $1`,
    `jsonb_build_object('id', z.oid, 'shift_assignment_id', z.aid, 'staff_profile_id', z.pid,
      'status', case z.kind when 'offered' then 'pending' else 'manager_confirmed' end,
      'sent_at', least(z.starts - interval '3 days', now() - interval '1 hour'), 'expires_at', case z.kind when 'offered' then now() + interval '7 days' else z.starts - interval '1 day' end,
      'responded_at', case when z.kind = 'offered' then null else z.starts - interval '2 days' end, 'staff_accepted_at', case when z.kind = 'offered' then null else z.starts - interval '2 days' end,
      'manager_confirmed_at', case when z.kind = 'offered' then null else z.starts - interval '2 days' end, 'confirmed_by', case when z.kind = 'offered' then null else $2::uuid end,
      'created_by', $2::uuid, 'created_at', least(z.starts - interval '3 days', now() - interval '1 hour'), 'offer_batch_id', null, 'rejected_by', null, 'manager_rejected_at', null)`,
    'v_seat z', [t.offer.offer, admin.id]));
  await step('attendance', () => cloneInsert(S, 'attendance', `select to_jsonb(x) from "${S}".attendance x where x.id = $1`,
    `jsonb_build_object('id', z.attid, 'shift_assignment_id', z.aid, 'shift_id', z.sid, 'staff_profile_id', z.pid, 'status', 'approved',
      'clock_in_at', z.starts, 'clock_out_at', z.starts + z.len, 'worked_minutes', 300, 'earned_pence', 7500, 'break_minutes', 0, 'created_at', z.starts, 'updated_at', z.starts + z.len,
      'post_shift_completed_at', z.starts + z.len + interval '1 hour', 'post_shift_expired_at', null, 'clock_in_by', null, 'clock_out_by', null, 'clock_in_reason', null, 'clock_out_reason', null,
      'clock_in_method', 'staff', 'clock_out_method', 'manual', 'clock_in_captured_at', null)`,
    `(select * from v_seat where kind = 'past') z`, [t.completed.attendance]));
  await step('payroll_record', () => cloneInsert(S, 'payroll_record', `select to_jsonb(x) from "${S}".payroll_record x where x.id = $1`,
    `jsonb_build_object('id', z.prid, 'attendance_id', z.attid, 'shift_id', z.sid, 'staff_profile_id', z.pid,
      'status', case when z.starts < now() - interval '14 days' then 'approved' else 'pending_approval' end,
      'worked_minutes', 300, 'pay_rate_pence', 1500, 'amount_pence', 7500,
      'approved_at', case when z.starts < now() - interval '14 days' then z.starts + interval '2 days' end, 'approved_by', case when z.starts < now() - interval '14 days' then $2::uuid end,
      'created_at', z.starts + z.len, 'updated_at', z.starts + interval '2 days')`,
    `(select * from v_seat where kind = 'past') z`, [t.completed.payroll, admin.id]));
  await step('shift_report', async () => (await c.query(
    `insert into "${S}".shift_report (organisation_id, workspace_id, shift_id, status, finalised_at, finalised_by, final_pdf_sent_at, created_at, updated_at, signed_off_name, break_confirmed)
     select $1, $2, h.sid, 'finalised', h.starts + h.len + interval '2 hours', $3::uuid, h.starts + h.len + interval '2 hours', h.starts, h.starts + h.len + interval '2 hours', 'Perf Seed', true
     from v_shift h where h.kind = 'past' on conflict (shift_id) do nothing`, [ORG, WS, admin.id])).rowCount);
  if (!LIVE_ONLY) await step('historical documents', () => historicalDocuments());
  if (!LIVE_ONLY) await step('payroll calendar', () => payrollCalendar());
  await c.query('commit');
} catch (e) {
  await c.query('rollback');
  throw e;
}
const t1 = Date.now();
await c.query('analyze');
summary.analyzeMs = Date.now() - t1;
const counts = {};
for (const tb of ['staff_profile', 'venue', 'shift', 'shift_assignment', 'job_offer', 'attendance', 'payroll_record', 'shift_report']) {
  counts[tb] = Number((await q(`select count(*)::int n from "${S}".${tb} where workspace_id = $1`, [WS]))[0].n);
}
summary.counts = counts;
// The load test's work list for this batch (emails only, never a password): bookings to check in / clock in / clock out,
// ordered by start, and the pending offers to accept or decline.
summary.liveBookings = await q(
  `select u.email, s.id "shiftId", s.venue_id "venueId", s.qr_version "qrVersion", s.starts_at "startsAt", s.ends_at "endsAt"
   from "${S}".shift s join "${S}".shift_assignment a on a.shift_id = s.id join "${S}".staff_profile p on p.id = a.staff_profile_id join core."user" u on u.id = p.user_id
   where s.workspace_id = $1 and s.notes like $2 order by s.starts_at, u.email`, [WS, `perf volume live ${BATCH} %`]);
summary.pendingOffers = await q(
  `select u.email, o.id "offerId" from "${S}".job_offer o join "${S}".shift_assignment a on a.id = o.shift_assignment_id join "${S}".shift s on s.id = a.shift_id
   join "${S}".staff_profile p on p.id = o.staff_profile_id join core."user" u on u.id = p.user_id
   where s.workspace_id = $1 and s.notes like $2 and o.status = 'pending' order by s.starts_at`, [WS, `perf volume offered ${BATCH} %`]);
summary.dbBytes = Number((await q('select pg_database_size(current_database()) b'))[0].b);
console.log(JSON.stringify({ counts, dbMiB: Math.round(summary.dbBytes / 1048576) }));
if (args.out) writeFileSync(args.out, JSON.stringify(summary, null, 2));
await c.end();
