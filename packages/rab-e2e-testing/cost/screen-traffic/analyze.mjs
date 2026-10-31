#!/usr/bin/env node
// Joins one load window's client-side request log (run-load.mjs), the API's own per-request SQL counts (request_complete
// log lines, exported by measure-window.sh) and the harness's server window (measure.sh idle -> idle-<label>/summary.json)
// into analysis-<label>.json and a markdown table.
//   node analyze.mjs <out dir> <label>
// Every figure is labelled: MEASURED (counted/timed in this run) or DERIVED (computed from measured values).
import fs from 'node:fs';
import path from 'node:path';

const [OUT, LABEL] = process.argv.slice(2);
if (!OUT || !LABEL) { console.error('usage: analyze.mjs <out dir> <label>'); process.exit(2); }
const rd = (f) => fs.readFileSync(path.join(OUT, f), 'utf8');
const meta = JSON.parse(rd(`load-meta-${LABEL}.json`));
const all = rd(`requests-${LABEL}.jsonl`).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const idleDir = path.join(OUT, `idle-st-${LABEL}`);
const hasIdle = fs.existsSync(path.join(idleDir, 'summary.json'));
// Window: the server measurement window if there is one, else the load phase(s) after warm-up.
let w0, w1;
if (hasIdle) { w0 = Number(fs.readFileSync(path.join(idleDir, 't-start'), 'utf8')) * 1000; w1 = Number(fs.readFileSync(path.join(idleDir, 't-end'), 'utf8')) * 1000; }
else { const ph = meta.phases.filter((p) => p.name !== 'warmup'); w0 = ph[0].t0; w1 = ph[ph.length - 1].t1; }
const mins = (w1 - w0) / 60000;
const inWin = all.filter((r) => r.t0 >= w0 && r.t0 < w1);
const sent = inWin.filter((r) => !r.joined && r.screen !== 'auth');

// SQL per request from the API's own log (requestId -> sqlCount); exported by measure-window.sh.
let sqlById = new Map();
const sqlFile = path.join(OUT, `api-sql-${LABEL}.json`);
if (fs.existsSync(sqlFile)) sqlById = new Map(Object.entries(JSON.parse(fs.readFileSync(sqlFile, 'utf8'))));

const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? +s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))].toFixed(1) : null; };
const usersOf = (screen) => meta.users.filter((u) => u.screen === screen).length;
function block(rows, nUsers) {
  const st = (f) => rows.filter(f).length;
  const bytes = rows.reduce((s, r) => s + (r.bytes || 0) + (r.hdrBytes || 0), 0);
  const upBytes = rows.reduce((s, r) => s + (r.reqBytes || 0), 0);
  const sqlKnown = rows.filter((r) => r.requestId && sqlById.has(r.requestId));
  const sql = sqlKnown.reduce((s, r) => s + sqlById.get(r.requestId).sqlCount, 0);
  return {
    users: nUsers,
    requests: rows.length,
    requestsPerMin: +(rows.length / mins).toFixed(1),
    requestsPerMinPerUser: nUsers ? +(rows.length / mins / nUsers).toFixed(2) : null,
    status: { ok2xx: st((r) => r.status >= 200 && r.status < 300), r429: st((r) => r.status === 429), r401: st((r) => r.status === 401), other4xx: st((r) => r.status >= 400 && r.status < 500 && ![401, 429].includes(r.status)), r5xx: st((r) => r.status >= 500), network: st((r) => r.status === 0), cancelledByClient: st((r) => r.status === -1) },
    downBytesPerHour: Math.round((bytes / mins) * 60),
    downBytesPerHourPerUser: nUsers ? Math.round((bytes / mins) * 60 / nUsers) : null,
    upBytesPerHour: Math.round((upBytes / mins) * 60),
    withBackgroundHeader: st((r) => r.background),
    apiSql: { requestsMatched: sqlKnown.length, statements: sql, statementsPerMin: +(sql / mins).toFixed(1) },
  };
}
const screens = [...new Set(meta.users.map((u) => u.screen))];
const timerTotals = (screen) => {
  const out = {};
  for (const p of meta.phases.filter((x) => x.name !== 'warmup')) for (const t of p.timers.filter((x) => x.screen === screen)) for (const [k, v] of Object.entries(t.stats)) { out[k] ||= {}; for (const [kk, vv] of Object.entries(v)) out[k][kk] = (out[k][kk] ?? 0) + vv; }
  return out;
};
const perScreen = Object.fromEntries(screens.map((s) => [s, {
  client: meta.users.find((u) => u.screen === s).client,
  basis: meta.users.find((u) => u.screen === s).basis,
  ...block(sent.filter((r) => r.screen === s), usersOf(s)),
  dedupedJoins: inWin.filter((r) => r.screen === s && r.joined).length,
  timers: timerTotals(s),
  routes: Object.fromEntries(Object.entries(Object.groupBy(sent.filter((r) => r.screen === s), (r) => r.route)).map(([k, v]) => [k, { n: v.length, perMin: +(v.length / mins).toFixed(2), r429: v.filter((r) => r.status === 429).length }])),
}]));
const ipGroups = Object.fromEntries(Object.entries(Object.groupBy(sent, (r) => r.ip)).map(([ip, v]) => [ip, { users: new Set(v.map((r) => r.user)).size, requestsPerMin: +(v.length / mins).toFixed(1), r429: v.filter((r) => r.status === 429).length, r429Share: +(v.filter((r) => r.status === 429).length / v.length).toFixed(3) }]));
const lat = (pred) => { const v = sent.filter((r) => r.status >= 200 && r.status < 300 && pred(r)).map((r) => r.ms); const db = sent.filter((r) => r.status >= 200 && r.status < 300 && pred(r) && r.requestId && sqlById.has(r.requestId)).map((r) => sqlById.get(r.requestId).durationMs); return { n: v.length, clientMs: { p50: pct(v, 50), p95: pct(v, 95), p99: pct(v, 99) }, serverMs: { p50: pct(db, 50), p95: pct(db, 95), p99: pct(db, 99) } }; };
// Endpoint families (query keys differ between client versions: /offers/mine?scope&limit=50 after C1, none before).
const latency = {
  'GET /offers/mine (all variants)': lat((r) => r.route.startsWith('GET /offers/mine')),
  'GET /shifts/sent (all calls)': lat((r) => r.route.startsWith('GET /shifts/sent')),
  'GET /shifts/sent?view=all&limit=100 (full-refresh list pages)': lat((r) => r.route === 'GET /shifts/sent?view=all&limit=100'),
  'GET /shifts/sent?view=all&limit=1 (before: count probe)': lat((r) => r.route === 'GET /shifts/sent?view=all&limit=1'),
  'GET /shifts/sent?view=all&limit=50 (C1 first-page poll)': lat((r) => r.route === 'GET /shifts/sent?view=all&limit=50'),
  'GET /shifts/:id/pipeline': lat((r) => r.route === 'GET /shifts/:id/pipeline'),
  'GET /shifts/requests (all variants)': lat((r) => r.route.startsWith('GET /shifts/requests')),
};
const server = hasIdle ? JSON.parse(fs.readFileSync(path.join(idleDir, 'summary.json'), 'utf8')) : null;
// Memory over the window from the harness's docker stats samples (every ~15 s).
let memory = null;
if (hasIdle && fs.existsSync(path.join(idleDir, 'dstats.txt'))) {
  const toMiB = (s) => { const m = /([\d.]+)\s*([KMG]i?B)/.exec(s); if (!m) return null; return +m[1] * ({ KiB: 1 / 1024, MiB: 1, GiB: 1024, KB: 1 / 1024, MB: 1, GB: 1024 }[m[2]] ?? 1); };
  const by = Object.groupBy(fs.readFileSync(path.join(idleDir, 'dstats.txt'), 'utf8').trim().split(/\r?\n/).map((l) => l.split(',')), (p) => p[1]);
  memory = Object.fromEntries(Object.entries(by).map(([k, v]) => { const m = v.map((p) => toMiB(p[3])).filter((x) => x != null); const c = v.map((p) => parseFloat(p[2])); return [k, { samples: v.length, memMiBAvg: +(m.reduce((a, b) => a + b, 0) / m.length).toFixed(1), memMiBMax: +Math.max(...m).toFixed(1), dockerCpuPctAvg: +(c.reduce((a, b) => a + b, 0) / c.length).toFixed(1), dockerCpuPctMax: Math.max(...c) }]; }));
}
const result = {
  label: LABEL, schedule: meta.schedule, mix: meta.mix, onlyScreen: meta.onlyScreen, state: meta.phases.filter((p) => p.name !== 'warmup').map((p) => p.state).join('+'),
  window: { start: new Date(w0).toISOString(), end: new Date(w1).toISOString(), minutes: +mins.toFixed(2), source: hasIdle ? 'measure.sh idle window (server metrics) ∩ load phase' : 'load phase' },
  labels: { requests: 'MEASURED (load generator)', bytes: 'MEASURED (response body + response header bytes; request bytes approximate)', apiSql: 'MEASURED (API request_complete sqlCount, joined by x-request-id)', latency: 'MEASURED (clientMs: load generator wall clock on the host; serverMs: API durationMs)', server: 'MEASURED (harness measure.sh idle: pg_stat_statements delta, cgroup CPU, docker stats)', perUser: 'DERIVED (÷ users)' },
  total: block(sent, meta.users.length),
  perScreen, ipGroups, latency,
  server: server && { sqlStatementsPerMin: server.sql, cpuPctOfOneCore: server.cpuFromCgroupPctOfOneCore, memory, cgroupMemoryAtEnd: server.cgroupMemoryAtEnd, redis: server.redis, hostContention: server.hostContention },
};
fs.writeFileSync(path.join(OUT, `analysis-${LABEL}.json`), JSON.stringify(result, null, 2));

// Markdown table.
const L = [];
L.push(`### ${LABEL} — ${result.state}, ${result.window.minutes} min, schedule ${meta.schedule}, mix ${meta.mix}${meta.onlyScreen ? `, only ${meta.onlyScreen}` : ''}`, '');
L.push('| Screen | client | basis | users | req/min (M) | req/min/user (D) | down MB/h (M) | 429 (M) | other err (M) | SQL/min via API log (M) | overlaps | ticks skipped (in flight) |', '|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
for (const [s, v] of Object.entries(perScreen)) {
  const ov = Object.values(v.timers).reduce((a, t) => a + (t.overlaps ?? 0), 0), sk = Object.values(v.timers).reduce((a, t) => a + (t.skippedInflight ?? 0), 0);
  L.push(`| ${s} | ${v.client} | ${v.basis} | ${v.users} | ${v.requestsPerMin} | ${v.requestsPerMinPerUser} | ${(v.downBytesPerHour / 1e6).toFixed(2)} | ${v.status.r429} | ${v.status.other4xx + v.status.r5xx + v.status.network + v.status.r401} | ${v.apiSql.statementsPerMin} | ${ov} | ${sk} |`);
}
const T = result.total;
L.push(`| **total** | | | ${T.users} | ${T.requestsPerMin} | ${T.requestsPerMinPerUser} | ${(T.downBytesPerHour / 1e6).toFixed(2)} | ${T.status.r429} | ${T.status.other4xx + T.status.r5xx + T.status.network + T.status.r401} | ${T.apiSql.statementsPerMin} | | |`, '');
L.push('| IP group | users | req/min | 429 | 429 share |', '|---|---:|---:|---:|---:|');
for (const [k, v] of Object.entries(ipGroups)) L.push(`| ${k} | ${v.users} | ${v.requestsPerMin} | ${v.r429} | ${v.r429Share} |`);
L.push('', '| Endpoint (2xx only) | n | client p50/p95/p99 ms | API p50/p95/p99 ms |', '|---|---:|---|---|');
for (const [k, v] of Object.entries(latency)) L.push(`| ${k} | ${v.n} | ${v.clientMs.p50}/${v.clientMs.p95}/${v.clientMs.p99} | ${v.serverMs.p50}/${v.serverMs.p95}/${v.serverMs.p99} |`);
if (result.server) {
  const s = result.server;
  L.push('', `Server (MEASURED, harness window): SQL/min toplevel(crewflow_app+crewflow)=${s.sqlStatementsPerMin.topLevelCallsPerMin}, client statements=${s.sqlStatementsPerMin.clientStatementsPerMin}, nested in SECURITY DEFINER=${s.sqlStatementsPerMin.nestedInsideDefinerFunctionsPerMin}; exec ms/min=${s.sqlStatementsPerMin.topLevelExecMsPerMin}.`);
  L.push(`CPU % of one core (cgroup): ${Object.entries(s.cpuPctOfOneCore).map(([k, v]) => `${k.replace('costaudit-', '')}=${v}`).join(', ')}.`);
  if (s.memory) L.push(`Memory MiB avg/max (docker stats): ${Object.entries(s.memory).map(([k, v]) => `${k.replace('costaudit-', '')}=${v.memMiBAvg}/${v.memMiBMax}`).join(', ')}.`);
  L.push(`Host contention (other containers' CPU % avg sum): ${s.hostContention?.totalCpuPctAvg}.`);
}
fs.writeFileSync(path.join(OUT, `analysis-${LABEL}.md`), L.join('\n') + '\n');
console.log(L.join('\n'));
