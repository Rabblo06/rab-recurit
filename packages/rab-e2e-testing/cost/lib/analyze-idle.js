// node lib/analyze-idle.js <label>  ->  $COST_OUT/idle-<label>/summary.json (ported from the 2026-10-26 harness).
// Two statement counts are reported:
//   sql.topLevelCallsPerMin   - the 2026-10-26 audit's definition: every statement executed AS the runtime login
//                               (pg_stat_statements rows for that role, nested or not). Owner-login architecture (Phase X
//                               P0-H): the runtime login is crewflow_owner, for the API and the Worker alike. The separated
//                               logins of older result directories (crewflow_app, crewflow, crewflow_worker) are still
//                               counted, so an old directory re-analyses to the same numbers.
//   sql.clientStatementsPerMin - pg_stat_statements toplevel=true only: statements the worker actually sent.
//   sql.families               - those top-level statements per Worker scan / framing / the API health ping
//                               (lib/sql-families.js), so Worker-scan SQL is counted per scan.
// Statements run inside SECURITY DEFINER functions execute as rab_secure_owner and are reported separately (nested).
const fs = require('fs');
const path = require('path');
const { OUT } = require('./lib');
const { summarize: familySummary } = require('./sql-families');

const label = process.argv[2];
const dir = path.join(OUT, `idle-${label}`);
const rd = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
const t0 = Number(rd('t-start')), t1 = Number(rd('t-end'));
const secs = t1 - t0, mins = secs / 60;
const cpu = (f) => Object.fromEntries(rd(f).trim().split(/\r?\n/).map((l) => { const [n, v] = l.split(' '); return [n, Number(v)]; }));
const c0 = cpu('cpu-start.txt'), c1 = cpu('cpu-end.txt');
const cpuPct = Object.fromEntries(Object.keys(c0).map((k) => [k, +(((c1[k] - c0[k]) / 1e6 / secs) * 100).toFixed(3)]));
const kv = (f) => Object.fromEntries(rd(f).split(/\r?\n/).filter((l) => l.includes(':')).map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1)]));
const r0 = kv('redis-stats-start.txt'), r1 = kv('redis-stats-end.txt'), rm = kv('redis-mem.txt');
const cmds = Number(r1.total_commands_processed) - Number(r0.total_commands_processed);
const pg = rd('pgss.txt').trim().split(/\r?\n/).filter(Boolean).map((l) => { const p = l.split('|'); return { role: p[0], calls: Number(p[1]), ms: Number(p[2]), rows: Number(p[3]), toplevel: p[4] === 't', query: p.slice(5).join('|') }; });
const app = pg.filter((r) => r.role !== 'rab'); // 'rab' = this harness's own psql
// crewflow_owner = the one login of the owner-login stack; the other three only appear in pre-P0-H result directories.
const RUNTIME_ROLES = ['crewflow_owner', 'crewflow_app', 'crewflow', 'crewflow_worker'];
const runtime = app.filter((r) => RUNTIME_ROLES.includes(r.role));
const nested = app.filter((r) => r.role === 'rab_secure_owner');
const sum = (a, k) => a.reduce((s, r) => s + r[k], 0);
const perMin = (n) => +(n / mins).toFixed(1);
const ds = rd('dstats.txt').trim().split(/\r?\n/).filter(Boolean).map((l) => l.split(','));
const byC = {};
for (const [, name, cpuS, mem] of ds) { (byC[name] ||= { cpu: [], mem: [] }); byC[name].cpu.push(parseFloat(cpuS)); byC[name].mem.push(mem.split(' / ')[0]); }
const dockerStats = Object.fromEntries(Object.entries(byC).map(([k, v]) => [k, { samples: v.cpu.length, cpuPctAvg: +(v.cpu.reduce((a, b) => a + b, 0) / v.cpu.length).toFixed(2), cpuPctMax: Math.max(...v.cpu), memLast: v.mem[v.mem.length - 1] }]));
// Host contention during the window (dev stack and other agents' containers, sampled read-only by measure.sh).
const hostCpu = {};
if (fs.existsSync(path.join(dir, 'dstats-host.txt'))) {
  for (const l of rd('dstats-host.txt').trim().split(/\r?\n/).filter(Boolean)) { const [, name, cpuS] = l.split(','); (hostCpu[name] ||= []).push(parseFloat(cpuS)); }
}
const avg = (a) => (a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2) : null);
const hostContention = { containers: Object.fromEntries(Object.entries(hostCpu).map(([k, v]) => [k, { samples: v.length, cpuPctAvg: avg(v), cpuPctMax: Math.max(...v) }])), totalCpuPctAvg: +Object.values(hostCpu).reduce((t, v) => t + (avg(v) || 0), 0).toFixed(2) };
const ops = rd('redis-ops.txt').trim().split(/\r?\n/).filter(Boolean).map((l) => Number(l.split(':')[1]));
const cgMem = fs.existsSync(path.join(dir, 'cgroup-mem.txt')) ? rd('cgroup-mem.txt').trim().split(/\r?\n/).map((l) => { const [n, cur, anon] = l.split(' '); return [n, { memoryCurrentMiB: cur ? +(Number(cur) / 1048576).toFixed(1) : null, anonMiB: anon ? +(Number(anon.split('=')[1]) / 1048576).toFixed(1) : null }]; }) : [];
const top = (a) => a.slice(0, 15).map((r) => ({ role: r.role, toplevel: r.toplevel, callsPerMin: +(r.calls / mins).toFixed(2), query: r.query.slice(0, 160) }));
// D-Q6: database transactions per minute (pg_stat_database xact_commit + xact_rollback; absent in older result dirs).
// The start snapshot read is a harness transaction inside the delta (the end read commits after itself); a load generator that logged its own psql transactions in
// <out>/dq6-<label>.gen.jsonl ({"t": epoch ms, "xact": n}) is subtracted too, for the window [t-start, t-end].
let pgXact = null;
if (fs.existsSync(path.join(dir, 'pg-xact-start.txt')) && fs.existsSync(path.join(dir, 'pg-xact-end.txt'))) {
  const raw = Number(rd('pg-xact-end.txt').trim()) - Number(rd('pg-xact-start.txt').trim());
  let harness = 1; // only the START read commits inside the delta; the end read's own transaction commits after it
  const gen = path.join(OUT, `dq6-${label}.gen.jsonl`);
  if (fs.existsSync(gen)) {
    for (const l of fs.readFileSync(gen, 'utf8').split(String.fromCharCode(10)).filter((x) => x.trim())) {
      const e = JSON.parse(l);
      if (e.xact && e.t >= t0 * 1000 && e.t <= t1 * 1000) harness += e.xact;
    }
  }
  pgXact = { rawInWindow: raw, harnessInWindow: harness, applicationInWindow: raw - harness, transactionsPerMin: perMinX(raw - harness, mins) };
}
function perMinX(n, m) { return +(n / m).toFixed(1); }
const out = {
  label, windowMinutes: +mins.toFixed(2),
  pgTransactions: pgXact,
  sql: {
    topLevelCallsPerMin: perMin(sum(runtime, 'calls')),
    topLevelByRole: Object.fromEntries(RUNTIME_ROLES.map((r) => [r, perMin(sum(runtime.filter((x) => x.role === r), 'calls'))])),
    clientStatementsPerMin: perMin(sum(runtime.filter((r) => r.toplevel), 'calls')),
    nestedInsideDefinerFunctionsPerMin: perMin(sum(nested, 'calls')),
    allIncludingNestedPerMin: perMin(sum(app, 'calls')),
    topLevelExecMsPerMin: perMin(sum(runtime, 'ms')),
    top15TopLevel: top(runtime),
    // Per Worker scan (and framing, and the API's health ping); see lib/sql-families.js.
    families: familySummary(app, secs),
    top15All: top(app),
  },
  cpuFromCgroupPctOfOneCore: cpuPct,
  dockerStats,
  hostContention,
  cgroupMemoryAtEnd: Object.fromEntries(cgMem),
  redis: { commandsPerSec: +(cmds / secs).toFixed(2), commandsInWindow: cmds, instantaneousOpsAvg: ops.length ? +(ops.reduce((a, b) => a + b, 0) / ops.length).toFixed(2) : null, usedMemory: Number(rm.used_memory), usedMemoryHuman: (rm.used_memory_human || '').trim(), dbsize: rd('redis-dbsize.txt').trim() },
  pgActivityAtEnd: rd('pg-activity.txt').trim().split(/\r?\n/),
  workerProcs: fs.existsSync(path.join(dir, 'worker-procs.txt')) ? rd('worker-procs.txt').trim().split(/\r?\n/).filter((l) => /node|chrom/.test(l)) : [],
  vmMemInfo: fs.existsSync(path.join(dir, 'vm-meminfo.txt')) ? rd('vm-meminfo.txt').trim().split(/\r?\n/) : [],
};
fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify({ label, mins: out.windowMinutes, sql: { topLevel: out.sql.topLevelCallsPerMin, client: out.sql.clientStatementsPerMin, nested: out.sql.nestedInsideDefinerFunctionsPerMin }, cpu: cpuPct }, null, 1));
