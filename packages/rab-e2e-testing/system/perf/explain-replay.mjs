// M9 hardening (Lane F) — replays the slowest statements auto_explain captured (with their logged parameters) as the
// RUNTIME login under the same tenant context, with EXPLAIN (ANALYZE, BUFFERS), on a DISPOSABLE database only. Used for
// the "slowest 10 queries" evidence and for before/after comparisons of a fix (JIT, an index).
//
//   PERF_ADMIN_URL=<superuser URL, loopback> [PERF_PG_CA=<ca.crt>] [PERF_CTX_EMAIL=admin@acme.test] \
//     node packages/rab-e2e-testing/system/perf/explain-replay.mjs <auto-explain.log> <out.json> [--top 10] [--jit on|off|both] [--runs 3]
//
// Context: the captured statements ran as the console organisation's CEO (the load test's manager sessions), so the replay
// binds that user's organisation, workspace, user id and role exactly as TenantContextService.bindGucs does, then
// SET LOCAL ROLE crewflow_owner (NOBYPASSRLS, FORCE RLS applies). Read-only: only SELECT / WITH statements are replayed,
// each inside a transaction that is rolled back.
import { readFileSync, writeFileSync } from 'node:fs';
import pg from 'pg';

const [logFile, outFile, ...rest] = process.argv.slice(2);
const opt = Object.fromEntries(rest.reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
const TOP = Number(opt.top ?? 10);
const RUNS = Number(opt.runs ?? 3);
const JITS = (opt.jit ?? 'both') === 'both' ? ['on', 'off'] : [opt.jit];
const url = new URL(process.env.PERF_ADMIN_URL ?? '');
if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('refusing: PERF_ADMIN_URL is not a loopback host');
url.searchParams.delete('sslmode');
const ssl = process.env.PERF_PG_CA ? { ca: readFileSync(process.env.PERF_PG_CA, 'utf8'), rejectUnauthorized: true } : undefined;

// ---- parse auto_explain blocks: duration, query text, parameters
const text = readFileSync(logFile, 'utf8');
const blocks = text.split(/\n(?=\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)/).filter((b) => b.includes('plan:') && b.includes('Query Text:'));
const parseParams = (line) => {
  const out = [];
  if (!line) return out;
  const re = /\$(\d+) = (NULL|'((?:[^']|'')*)')/g;
  let m;
  while ((m = re.exec(line))) out[Number(m[1]) - 1] = m[2] === 'NULL' ? null : m[3].replace(/''/g, "'");
  return out;
};
const statements = new Map();
for (const b of blocks) {
  const ms = Number(b.match(/duration: ([\d.]+) ms/)[1]);
  const qm = b.match(/Query Text:([\s\S]*?)\n\s*Query Parameters: ([^\n]*)/) ?? b.match(/Query Text:([\s\S]*?)\n\s*(?=[A-Z][A-Za-z ]+ {2}\(cost)/);
  if (!qm) continue;
  const sql = qm[1].replace(/^\s+/, '').replace(/\n\t/g, '\n');
  if (!/^\s*(SELECT|WITH)\b/i.test(sql)) continue;
  const key = sql.replace(/\s+/g, ' ').trim();
  const jit = /JIT:[\s\S]*?Total ([\d.]+) ms/.exec(b);
  const s = statements.get(key) ?? { key, sql, n: 0, maxMs: 0, sumMs: 0, params: [], jitMs: 0 };
  s.n++;
  s.sumMs += ms;
  if (ms > s.maxMs) Object.assign(s, { maxMs: ms, params: parseParams(qm[2]), jitMs: jit ? Number(jit[1]) : 0 });
  statements.set(key, s);
}
const top = [...statements.values()].sort((a, b) => b.maxMs - a.maxMs).slice(0, TOP);

// ---- replay
const c = new pg.Client({ connectionString: url.toString(), ssl });
await c.connect();
const [guard] = (await c.query(`select (select rolsuper from pg_roles where rolname = current_user) su, inet_server_addr() addr`)).rows;
if (!guard.su) throw new Error('refusing: the replay needs the disposable cluster superuser (it sets the runtime role itself)');
const email = process.env.PERF_CTX_EMAIL ?? 'admin@acme.test';
const [ctx] = (
  await c.query(
    `select u.id, u.organisation_id, w.id workspace_id, (select r.key from core.user_role ur join core.role r on r.id = ur.role_id where ur.user_id = u.id order by r.key limit 1) role
       from core."user" u join core.manager_workspace w on w.organisation_id = u.organisation_id where lower(u.email) = lower($1) order by w.created_at limit 1`,
    [email],
  )
).rows;
if (!ctx) throw new Error(`no such user ${email}`);
const plans = [];
for (const [i, s] of top.entries()) {
  const entry = { rank: i + 1, calls: s.n, capturedMaxMs: Math.round(s.maxMs), capturedJitMs: Math.round(s.jitMs), sql: s.sql, params: s.params, replay: {} };
  for (const jit of JITS) {
    const runs = [];
    let plan = '';
    for (let r = 0; r < RUNS; r++) {
      await c.query('BEGIN');
      try {
        await c.query('SET LOCAL ROLE crewflow_owner');
        await c.query(
          `SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true), set_config('rab.user_id', $3, true), set_config('rab.role', $4, true),
                  set_config('rab.actor_type', 'user', true), set_config('rab.team_shift_id', '', true), set_config('rab.team_staff_id', '', true), set_config('rab.admin_scope', '', true),
                  set_config('rab.upgrade_scope', '', true), set_config('search_path', 'core', true), set_config('jit', $5, true)`,
          [ctx.organisation_id, ctx.workspace_id, ctx.id, ctx.role ?? '', jit],
        );
        const res = await c.query(`EXPLAIN (ANALYZE, BUFFERS) ${s.sql}`, s.params);
        plan = res.rows.map((x) => x['QUERY PLAN']).join('\n');
        runs.push(Number(/Execution Time: ([\d.]+) ms/.exec(plan)?.[1] ?? NaN));
      } catch (e) {
        plan = `ERROR: ${e.message}`;
        runs.push(NaN);
      } finally {
        await c.query('ROLLBACK');
      }
    }
    const sorted = runs.filter(Number.isFinite).sort((a, b) => a - b);
    entry.replay[`jit_${jit}`] = { medianMs: sorted.length ? Math.round(sorted[Math.floor(sorted.length / 2)] * 10) / 10 : null, runs, plan };
  }
  plans.push(entry);
  console.log(`#${entry.rank} calls=${entry.calls} captured max=${entry.capturedMaxMs} ms (JIT ${entry.capturedJitMs} ms) ${JITS.map((j) => `jit ${j}: ${entry.replay[`jit_${j}`].medianMs} ms`).join(', ')} :: ${s.key.slice(0, 110)}`);
}
writeFileSync(outFile, JSON.stringify({ at: new Date().toISOString(), context: { email, role: ctx.role }, plans }, null, 2));
await c.end();
