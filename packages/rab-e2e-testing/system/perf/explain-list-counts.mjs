// W6-E2E-06: SQL-level before/after on the DISPOSABLE e2e database (127.0.0.1:15470/rab_e2e) only.
// Runs the attendance / offer list COUNT queries exactly as the services build them for Initial Manager A (role manager,
// actor user, search_path = A's workspace schema, executed as crewflow_app via SET ROLE), with and without the pinned
// join order, under (1) the current statistics and (2) statistics removed from A's workspace tables (the state of freshly
// bulk-loaded, not-yet-analysed tables: the planner falls back to default estimates). ANALYZE restores them at the end.
// Usage: node explain06.mjs <e2e env file> <state.json> <out.json>
import fs from 'node:fs';
import pg from 'pg';

const [envFile, stateFile, outFile] = process.argv.slice(2);
const env = Object.fromEntries(fs.readFileSync(envFile, 'utf8').split(/\r?\n/).filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^['"]|['"]$/g, '')]));
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const c = new pg.Client({ host: '127.0.0.1', port: 15470, user: 'rab', password: env.E2E_PG_SUPERUSER_PASSWORD, database: 'rab_e2e' });
await c.connect();
const db = (await c.query('select current_database() d')).rows[0].d;
if (db !== 'rab_e2e') throw new Error('refusing: not the disposable e2e database');

const A = state.A;
const user = (await c.query('select id from core."user" where email = $1', [A.imEmail])).rows[0];
const schema = A.schema;
const ws = A.workspaceId;

const COUNTS = {
  attendance: `SELECT count(*)::int AS count FROM attendance a
           JOIN shift s ON s.id = a.shift_id
           JOIN venue v ON v.id = s.venue_id
           JOIN job_role jr ON jr.id = s.job_role_id
           JOIN staff_profile sp ON sp.id = a.staff_profile_id
           JOIN core."user" u ON u.id = sp.user_id
         WHERE sp.created_by = $1`,
  offers: `SELECT count(*)::int AS count FROM job_offer o
           JOIN shift_assignment sa ON sa.id = o.shift_assignment_id
           JOIN shift s ON s.id = sa.shift_id
           JOIN venue v ON v.id = s.venue_id
           JOIN job_role jr ON jr.id = s.job_role_id
           JOIN staff_profile sp ON sp.id = o.staff_profile_id
           JOIN core."user" u ON u.id = sp.user_id
         WHERE o.created_by = $1`,
};

function maxRows(node) {
  let m = node['Actual Rows'] * (node['Actual Loops'] ?? 1);
  for (const ch of node.Plans ?? []) m = Math.max(m, maxRows(ch));
  return m;
}

async function explain(sqlText, pinned) {
  await c.query('BEGIN');
  try {
    await c.query('SET LOCAL ROLE crewflow_app');
    await c.query(
      `SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true), set_config('rab.user_id', $3, true), set_config('rab.role', 'manager', true), set_config('rab.actor_type', 'user', true), set_config('rab.team_shift_id', '', true), set_config('rab.team_staff_id', '', true), set_config('search_path', $4, true), set_config('jit', 'off', true)`,
      [A.orgId, ws, user.id, schema],
    );
    if (pinned) await c.query(`SELECT set_config('join_collapse_limit', '1', true)`);
    const res = (await c.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${sqlText}`, [user.id])).rows[0]['QUERY PLAN'][0];
    return { execMs: Math.round(res['Execution Time'] * 10) / 10, planMs: Math.round(res['Planning Time'] * 10) / 10, rows: res.Plan.Plans?.[0]?.['Actual Rows'] ?? res.Plan['Actual Rows'], maxIntermediateRows: maxRows(res.Plan) };
  } finally {
    await c.query('ROLLBACK');
  }
}

async function round(label) {
  const out = {};
  for (const [name, q] of Object.entries(COUNTS)) {
    const runs = { before: [], after: [] };
    for (let i = 0; i < 5; i++) {
      runs.before.push(await explain(q, false));
      runs.after.push(await explain(q, true));
    }
    const med = (xs) => [...xs].sort((a, b) => a.execMs - b.execMs)[2];
    out[name] = { before: med(runs.before), after: med(runs.after) };
  }
  console.log(label, JSON.stringify(out));
  return out;
}

const tables = ['attendance', 'shift', 'venue', 'job_role', 'staff_profile', 'job_offer', 'shift_assignment'];
const result = { schema, counts: {} };
result.counts.attendanceRows = (await c.query(`select count(*)::int n from ${schema}.attendance`)).rows[0].n;
result.counts.offerRows = (await c.query(`select count(*)::int n from ${schema}.job_offer`)).rows[0].n;
await c.query(`ANALYZE ${tables.map((t) => `${schema}.${t}`).join(', ')}, core."user"`);
result.analysed = await round('analysed');
// Simulate freshly bulk-loaded tables (no statistics yet), the plausible state of the lane's iteration-1 run.
await c.query(`DELETE FROM pg_statistic WHERE starelid IN (${tables.map((t) => `'${schema}.${t}'::regclass`).join(', ')})`);
await c.query(`UPDATE pg_class SET reltuples = -1, relpages = 0 WHERE oid IN (${tables.map((t) => `'${schema}.${t}'::regclass`).join(', ')})`);
result.noStatistics = await round('no-statistics');
await c.query(`ANALYZE ${tables.map((t) => `${schema}.${t}`).join(', ')}`);
fs.writeFileSync(outFile, JSON.stringify(result, null, 2));
await c.end();
