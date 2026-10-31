// Compares two crewflow-cost runs (baseline vs after) from their raw result files. Analysis only: reads two results
// directories, writes <out>/comparison.json and <out>/comparison.md. Never touches Docker or a database.
//   node lib/compare.js <baseline dir> <after dir> <out dir>
//
// Labels: MEASURED = read from a run; DERIVED = computed from measured values (ratios, background subtraction, splits
// taken from code structure). Nothing here is an ESTIMATE presented as a result.
//
// Host noise. The dev stack keeps running beside the harness, so timing metrics carry host noise. It is measured, not
// assumed: the API request path is code-identical between the two commits under test (no server module, shared or
// migration change; Sentry is off without SENTRY_DSN), so every API endpoint/load timing, CPU and memory metric is a
// CONTROL whose delta is host noise by construction. A non-control metric is "within host noise" when |delta%| <= the
// 90th percentile of |delta%| of the controls of its class. Exact counters (statement counts, S3 operations, email
// counts) have no host noise: any difference is real. Idle SQL/min is a rate of fixed-interval polling loops; its band
// is the O=0 idle delta (no organisation exists, so no changed code path runs), floored at 0.5%. PDF render CPU/wall use
// a Mann-Whitney U test over the 10 renders of each run (within noise when p >= 0.05).
const fs = require('fs');
const path = require('path');

const [BASE, AFTER, OUTDIR] = process.argv.slice(2);
if (!BASE || !AFTER || !OUTDIR) { console.error('usage: compare.js <baseline dir> <after dir> <out dir>'); process.exit(2); }
fs.mkdirSync(OUTDIR, { recursive: true });
const J = (d, f) => { try { return JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')); } catch { return null; } };
const T = (d, f) => { try { return fs.readFileSync(path.join(d, f), 'utf8'); } catch { return null; } };
const r = (x, d = 2) => (x == null || Number.isNaN(x) || !Number.isFinite(x) ? null : +Number(x).toFixed(d));
const pctDelta = (b, a) => (b == null || a == null ? null : b === 0 ? (a === 0 ? 0 : null) : r(((a - b) / Math.abs(b)) * 100, 2));

// ---- generic metric table -------------------------------------------------------------------------------------------
const rows = [];
const add = (group, metric, unit, b, a, label, cls, extra = {}) => rows.push({ group, metric, unit, base: b, after: a, deltaPct: pctDelta(b, a), label, cls, ...extra });

// ---- idle ---------------------------------------------------------------------------------------------------------
const idle = (d, l) => J(d, `idle-${l}/summary.json`);
// Idle-SQL control. Historically the O=0 window (no organisation => no changed code path). Phase A (2026-10-27) changes
// the O=0 loops too (realtime/push gating), so when BOTH runs have the Phase A windows the controls are instead the
// windows whose code path is identical in both builds: the flags-on window (gating not engaged) and the provisioner's
// crewflow-role rate in its 5 s default configuration. COST_COMPARE_IDLE_CONTROL=o0 forces the old rule.
const phaseAControls = process.env.COST_COMPARE_IDLE_CONTROL !== 'o0' && ['O0', 'O5', 'O20'].some((o) => idle(BASE, o + '-flags-on') && idle(AFTER, o + '-flags-on'));
for (const l of ['O0', 'O5', 'O20']) {
  const b = idle(BASE, l), a = idle(AFTER, l);
  if (!b || !a) continue;
  const ctl = l === 'O0' && !phaseAControls;
  add('idle', `Idle SQL/min ${l} (old-audit def: all crewflow_app/crewflow)`, 'stmts/min', b.sql.topLevelCallsPerMin, a.sql.topLevelCallsPerMin, 'MEASURED', 'idle-sql', { control: ctl });
  add('idle', `Idle client-sent SQL/min ${l} (toplevel)`, 'stmts/min', b.sql.clientStatementsPerMin, a.sql.clientStatementsPerMin, 'MEASURED', 'idle-sql', { control: ctl });
  add('idle', `Idle nested SQL/min ${l} (SECURITY DEFINER)`, 'stmts/min', b.sql.nestedInsideDefinerFunctionsPerMin, a.sql.nestedInsideDefinerFunctionsPerMin, 'MEASURED', 'idle-sql', { control: ctl });
  for (const [c, name] of [['costaudit-pg', 'DB'], ['costaudit-worker', 'Worker'], ['costaudit-api', 'API (control)'], ['costaudit-redis', 'Redis (control)'], ['costaudit-minio', 'MinIO (control)']]) {
    add('idle', `${name} CPU at idle ${l}`, '% of one core', b.cpuFromCgroupPctOfOneCore[c], a.cpuFromCgroupPctOfOneCore[c], 'MEASURED', 'idle-cpu', { control: /control/.test(name) });
  }
  add('idle', `Redis commands/s at idle ${l}`, 'cmd/s', b.redis.commandsPerSec, a.redis.commandsPerSec, 'MEASURED', 'idle-rate', {});
  add('idle', `Worker memory.current at end of idle ${l}`, 'MiB', b.cgroupMemoryAtEnd?.['costaudit-worker']?.memoryCurrentMiB, a.cgroupMemoryAtEnd?.['costaudit-worker']?.memoryCurrentMiB, 'MEASURED', 'memory', {});
}
// Least-squares fit over O=0/5/20 (DERIVED) for each run.
const fitOf = (d, key) => {
  const pts = ['O0', 'O5', 'O20'].map((l) => [Number(l.slice(1)), idle(d, l)]).filter(([, s]) => s).map(([o, s]) => [o, key(s)]);
  if (pts.length < 2) return null;
  const n = pts.length, sx = pts.reduce((s, p) => s + p[0], 0), sy = pts.reduce((s, p) => s + p[1], 0), sxx = pts.reduce((s, p) => s + p[0] * p[0], 0), sxy = pts.reduce((s, p) => s + p[0] * p[1], 0);
  const b = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  return { intercept: r((sy - b * sx) / n, 2), slope: r(b, 3) };
};
const fits = {};
for (const [k, f] of [['sql', (s) => s.sql.topLevelCallsPerMin], ['pgCpu', (s) => s.cpuFromCgroupPctOfOneCore['costaudit-pg']], ['workerCpu', (s) => s.cpuFromCgroupPctOfOneCore['costaudit-worker']]]) {
  fits[k] = { base: fitOf(BASE, f), after: fitOf(AFTER, f) };
  if (fits[k].base && fits[k].after) {
    add('idle-fit', `Idle ${k} fit: intercept`, k === 'sql' ? 'stmts/min' : '% core', fits[k].base.intercept, fits[k].after.intercept, 'DERIVED', k === 'sql' ? 'idle-sql' : 'idle-cpu', {});
    add('idle-fit', `Idle ${k} fit: slope per org`, k === 'sql' ? 'stmts/min/org' : '% core/org', fits[k].base.slope, fits[k].after.slope, 'DERIVED', k === 'sql' ? 'idle-sql' : 'idle-cpu', {});
  }
}

// ---- endpoints (API path: code-identical => controls for timing; counters must match) -------------------------------
const epB = J(BASE, 'endpoints-baseline.json'), epA = J(AFTER, 'endpoints-baseline.json');
if (epB && epA) {
  for (const name of Object.keys(epB.endpoints)) {
    const b = epB.endpoints[name], a = epA.endpoints[name];
    if (!a) continue;
    add('endpoints', `${name}: SQL/request`, 'stmts', b.sqlCountMedian, a.sqlCountMedian, 'MEASURED', 'counter', {});
    add('endpoints', `${name}: transactions/request`, 'tx', b.txCountMedian, a.txCountMedian, 'MEASURED', 'counter', {});
    add('endpoints', `${name}: server ms (median)`, 'ms', b.serverMsMedian, a.serverMsMedian, 'MEASURED', 'latency', { control: true });
    add('endpoints', `${name}: client ms (median)`, 'ms', r(b.clientMsMedian, 1), r(a.clientMsMedian, 1), 'MEASURED', 'latency', { control: true });
    add('endpoints', `${name}: response bytes`, 'B', b.responseBytesMedian, a.responseBytesMedian, 'MEASURED', 'counter', {});
  }
  const db = epB.dashboardFullLoad, da = epA.dashboardFullLoad;
  add('dashboard', 'Dashboard load: SQL', 'stmts', db.sqlTotalMedian, da.sqlTotalMedian, 'MEASURED', 'counter', {});
  add('dashboard', 'Dashboard load: KB', 'KB', r(db.bytesTotalMedian / 1024, 1), r(da.bytesTotalMedian / 1024, 1), 'MEASURED', 'counter', {});
  add('dashboard', 'Dashboard load: wall ms', 'ms', r(db.wallMsMedian, 1), r(da.wallMsMedian, 1), 'MEASURED', 'latency', { control: true });
  const pb = epB.pgssCrossCheck, pa = epA.pgssCrossCheck;
  add('endpoints', 'pgss cross-check /dashboard/summary: top-level/request', 'stmts', pb.crewflowAppToplevelPerRequest, pa.crewflowAppToplevelPerRequest, 'MEASURED', 'counter', {});
  add('endpoints', 'pgss cross-check /dashboard/summary: nested/request', 'stmts', pb.nestedDefinerPerRequest, pa.nestedDefinerPerRequest, 'MEASURED', 'counter', {});
}

// ---- load ---------------------------------------------------------------------------------------------------------
const ldB = J(BASE, 'load-baseline.json'), ldA = J(AFTER, 'load-baseline.json');
if (ldB && ldA) {
  for (const b of ldB) {
    const a = ldA.find((x) => x.scenario === b.scenario);
    if (!a) continue;
    const s = b.scenario;
    add('load', `${s}: req/s`, 'req/s', r(b.rps, 1), r(a.rps, 1), 'MEASURED', 'throughput', { control: true });
    for (const p of ['p50', 'p95', 'p99']) add('load', `${s}: latency ${p}`, 'ms', b.latencyExact?.[p], a.latencyExact?.[p], 'MEASURED', 'latency', { control: true });
    add('load', `${s}: API CPU ms/request`, 'ms CPU', b.apiCpuMsPerRequest, a.apiCpuMsPerRequest, 'MEASURED', 'cpu-per-req', { control: true });
    add('load', `${s}: DB CPU ms/request`, 'ms CPU', b.pgCpuMsPerRequest, a.pgCpuMsPerRequest, 'MEASURED', 'cpu-per-req', { control: true });
    add('load', `${s}: API memory peak`, 'MiB', b.apiMemPeakMiB_cgroup, a.apiMemPeakMiB_cgroup, 'MEASURED', 'memory', { control: true });
    add('load', `${s}: non-2xx + errors`, 'count', (b.non2xx || 0) + (b.errors || 0), (a.non2xx || 0) + (a.errors || 0), 'MEASURED', 'counter', {});
    if (b.pgss && a.pgss) {
      add('load', `${s}: statements/request (pgss)`, 'stmts', b.pgss.statementsPerRequest, a.pgss.statementsPerRequest, 'MEASURED', 'counter', {});
      add('load', `${s}: DB exec ms/request (pgss)`, 'ms', b.pgss.dbExecMsPerRequest_toplevel, a.pgss.dbExecMsPerRequest_toplevel, 'MEASURED', 'cpu-per-req', { control: true });
    }
  }
}

// ---- pdf ------------------------------------------------------------------------------------------------------------
const erf = (x) => { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; };
const mannWhitneyP = (x, y) => {
  const all = [...x.map((v) => [v, 0]), ...y.map((v) => [v, 1])].sort((p, q) => p[0] - q[0]);
  const ranks = new Array(all.length);
  for (let i = 0; i < all.length;) { let j = i; while (j + 1 < all.length && all[j + 1][0] === all[i][0]) j++; for (let k = i; k <= j; k++) ranks[k] = (i + j) / 2 + 1; i = j + 1; }
  const n1 = x.length, n2 = y.length;
  const R1 = all.reduce((s, p, i) => s + (p[1] === 0 ? ranks[i] : 0), 0);
  const U = R1 - (n1 * (n1 + 1)) / 2, mu = (n1 * n2) / 2, sd = Math.sqrt((n1 * n2 * (n1 + n2 + 1)) / 12);
  const z = (Math.abs(U - mu) - 0.5) / sd;
  return r(2 * (1 - 0.5 * (1 + erf(z / Math.SQRT2))), 4);
};
const pdB = J(BASE, 'pdfbench.json'), pdA = J(AFTER, 'pdfbench.json');
if (pdB && pdA) {
  for (const doc of Object.keys(pdB.docs)) {
    const b = pdB.docs[doc], a = pdA.docs[doc];
    if (!a) continue;
    const pc = mannWhitneyP(b.renders.map((x) => x.cpuMs), a.renders.map((x) => x.cpuMs));
    const pw = mannWhitneyP(b.renders.map((x) => x.wallMs), a.renders.map((x) => x.wallMs));
    add('pdf', `PDF ${doc}: CPU s/render (median of ${b.renders.length})`, 'CPU-s', b.summary.cpuSecondsMedian, a.summary.cpuSecondsMedian, 'MEASURED', 'pdf', { mwP: pc });
    add('pdf', `PDF ${doc}: wall ms/render (median)`, 'ms', b.summary.wallMsMedian, a.summary.wallMsMedian, 'MEASURED', 'pdf', { mwP: pw });
    add('pdf', `PDF ${doc}: peak container memory`, 'MiB', b.summary.peakContainerMemMiBMax, a.summary.peakContainerMemMiBMax, 'MEASURED', 'memory', {});
    add('pdf', `PDF ${doc}: size`, 'bytes', b.summary.pdfBytesMedian, a.summary.pdfBytesMedian, 'MEASURED', 'counter', {});
  }
}

// ---- emails / redis / storage -----------------------------------------------------------------------------------------
const emB = J(BASE, 'emails-bullmq.json'), emA = J(AFTER, 'emails-bullmq.json');
if (emB && emA) {
  add('redis', 'Redis used_memory delta per completed email job', 'bytes', r(emB.bytesPerCompletedJob_usedMemoryDelta, 0), r(emA.bytesPerCompletedJob_usedMemoryDelta, 0), 'MEASURED', 'redis-mem', {});
  add('redis', 'Emails sent in the email window', 'emails', emB.sentResetEmails, emA.sentResetEmails, 'MEASURED', 'counter', {});
  add('redis', 'Seconds to drain the email window', 's', r(emB.secondsToDrain, 1), r(emA.secondsToDrain, 1), 'MEASURED', 'latency', {});
}
for (const lab of ['cli', 'boot', 'shiftcycle']) {
  const b = J(BASE, `storage-${lab}.json`), a = J(AFTER, `storage-${lab}.json`);
  if (!b || !a) continue;
  for (const op of ['HEAD', 'LIST', 'GET', 'PUT', 'DELETE']) if ((b.ops[op] || 0) + (a.ops[op] || 0) > 0) add('storage', `S3 ${op}, ${lab}`, 'calls', b.ops[op] || 0, a.ops[op] || 0, 'MEASURED', 'counter', {});
  add('storage', `stored_file rows at end of ${lab}`, 'rows', b.storedFileRows, a.storedFileRows, 'MEASURED', 'counter', {});
}

// ---- Phase A measurement phases (2026-10-27; present only when both runs ran them) ------------------------------------
// Six idle windows: O=0/5/20 x flags off (idle-O<n>) / flags on (idle-O<n>-flags-on: REALTIME_ENABLED + PUSH_ENABLED true on the
// API and the worker). The flags-on SQL rows are compared (not controls): the idle-SQL band comes only from the
// provisioner's crewflow-role rate at 5 s, whose code path is identical in both builds.
for (const o of ['O0', 'O5', 'O20']) {
  for (const [l, cfg] of [[o, 'flags off'], [o + '-flags-on', 'flags on (API+worker)']]) {
    const b = idle(BASE, l), a = idle(AFTER, l);
    if (!b || !a) continue;
    if (l.endsWith('-flags-on')) {
      add('flags', 'Idle SQL/min ' + o + ', ' + cfg, 'stmts/min', b.sql.topLevelCallsPerMin, a.sql.topLevelCallsPerMin, 'MEASURED', 'idle-sql', {});
      add('flags', 'Idle nested SQL/min ' + o + ', ' + cfg, 'stmts/min', b.sql.nestedInsideDefinerFunctionsPerMin, a.sql.nestedInsideDefinerFunctionsPerMin, 'MEASURED', 'idle-sql', {});
      add('flags', 'DB CPU at idle ' + o + ', ' + cfg, '% of one core', b.cpuFromCgroupPctOfOneCore['costaudit-pg'], a.cpuFromCgroupPctOfOneCore['costaudit-pg'], 'MEASURED', 'idle-cpu', {});
      add('flags', 'Worker CPU at idle ' + o + ', ' + cfg, '% of one core', b.cpuFromCgroupPctOfOneCore['costaudit-worker'], a.cpuFromCgroupPctOfOneCore['costaudit-worker'], 'MEASURED', 'idle-cpu', {});
      add('flags', 'API CPU at idle ' + o + ', ' + cfg, '% of one core', b.cpuFromCgroupPctOfOneCore['costaudit-api'], a.cpuFromCgroupPctOfOneCore['costaudit-api'], 'MEASURED', 'idle-cpu', {});
      add('flags', 'Worker memory.current at end of idle ' + o + ', ' + cfg, 'MiB', b.cgroupMemoryAtEnd?.['costaudit-worker']?.memoryCurrentMiB, a.cgroupMemoryAtEnd?.['costaudit-worker']?.memoryCurrentMiB, 'MEASURED', 'memory', {});
      add('flags', 'Redis commands/s at idle ' + o + ', ' + cfg, 'cmd/s', b.redis.commandsPerSec, a.redis.commandsPerSec, 'MEASURED', 'idle-rate', {});
    }
    add('provisioner', 'Provisioner SQL/min (crewflow role) at idle ' + o + ', default configuration, ' + cfg, 'stmts/min', b.sql.topLevelByRole.crewflow, a.sql.topLevelByRole.crewflow, 'MEASURED', 'idle-sql', { control: !!phaseAControls });
    const sb = J(BASE, 'storage-idle-' + l + '.json'), sa = J(AFTER, 'storage-idle-' + l + '.json');
    if (sb && sa) for (const op of ['HEAD', 'LIST', 'GET', 'PUT']) add('storage', 'S3 ' + op + ' during idle ' + o + ', ' + cfg, 'calls', sb.ops[op] || 0, sa.ops[op] || 0, 'MEASURED', 'counter', {});
  }
}
const provNames = (d) => { try { return fs.readdirSync(d).filter((x) => /^idle-prov-/.test(x)).map((x) => x.replace(/^idle-prov-/, '')); } catch { return []; } };
for (const n of [...new Set([...provNames(BASE), ...provNames(AFTER)])].sort()) {
  const b = idle(BASE, `prov-${n}`), a = idle(AFTER, `prov-${n}`);
  if (!b || !a) {
    // A configuration one build cannot run (the worker refused it) still gets a row: refused vs measured.
    const sideB = b ? b.sql.topLevelByRole.crewflow : (fs.existsSync(path.join(BASE, 'worker-env', `prov-${n}.REFUSED`)) ? 'refused' : null);
    const sideA = a ? a.sql.topLevelByRole.crewflow : (fs.existsSync(path.join(AFTER, 'worker-env', `prov-${n}.REFUSED`)) ? 'refused' : null);
    if (sideB != null || sideA != null) add('provisioner', `Provisioner SQL/min (crewflow role), configuration '${n}'`, 'stmts/min', sideB, sideA, 'MEASURED', 'counter', {});
    continue;
  }
  add('provisioner', `Provisioner SQL/min (crewflow role), configuration '${n}'`, 'stmts/min', b.sql.topLevelByRole.crewflow, a.sql.topLevelByRole.crewflow, 'MEASURED', 'idle-sql', { control: !!phaseAControls && n === 'default' });
  add('provisioner', `All runtime SQL/min, configuration '${n}'`, 'stmts/min', b.sql.topLevelCallsPerMin, a.sql.topLevelCallsPerMin, 'MEASURED', 'idle-sql', {});
}
for (const l of ['boot-cold', 'boot-restart', 'replicas']) {
  const b = J(BASE, `${l}/summary.json`), a = J(AFTER, `${l}/summary.json`);
  if (!b || !a) continue;
  for (const c of Object.keys(b.perContainer)) {
    const pb = b.perContainer[c], pa = a.perContainer[c] || {};
    add('boot', `${l} ${c}: ms to "rab-worker ready"`, 'ms', pb.readyMs, pa.readyMs, 'MEASURED', 'latency', {});
    add('boot', `${l} ${c}: ms to healthy (image health command)`, 'ms', pb.health?.probeHealthyMs, pa.health?.probeHealthyMs, 'MEASURED', 'latency', {});
    add('boot', `${l} ${c}: storage reconciles completed in window`, 'runs', pb.storageReconcilesCompleted, pa.storageReconcilesCompleted, 'MEASURED', 'counter', {});
    add('boot', `${l} ${c}: jobs / provisioner processes`, 'processes', `${pb.processes.jobs}/${pb.processes.provisioner}`, `${pa.processes?.jobs}/${pa.processes?.provisioner}`, 'MEASURED', 'counter', {});
    const ob = b.s3?.byClient?.[c] || {}, oa = a.s3?.byClient?.[c] || {};
    for (const op of ['HEAD', 'LIST', 'GET', 'PUT']) if ((ob[op] || 0) + (oa[op] || 0) > 0) add('boot', `${l} ${c}: S3 ${op} in window`, 'calls', ob[op] || 0, oa[op] || 0, 'MEASURED', 'counter', {});
  }
  if (b.shutdown && a.shutdown) add('boot', `${l}: graceful stop duration`, 'ms', b.shutdown.stopMs, a.shutdown.stopMs, 'MEASURED', 'latency', {});
  add('boot', `${l}: SQL/min in window (runtime roles)`, 'stmts/min', b.sql.runtimeStatementsPerMin, a.sql.runtimeStatementsPerMin, 'MEASURED', 'idle-sql', {});
  add('boot', `${l}: provisioner SQL/min in window`, 'stmts/min', b.sql.provisionerRoleStatementsPerMin, a.sql.provisionerRoleStatementsPerMin, 'MEASURED', 'idle-sql', {});
  add('boot', `${l}: S3 calls in window (all clients)`, 'calls', b.s3?.totalS3Calls, a.s3?.totalS3Calls, 'MEASURED', 'counter', {});
}

// ---- shift cycle: per-email SQL attribution ----------------------------------------------------------------------------
const parseCsv = (text) => {
  const out = []; let row = []; let f = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; continue; }
    if (c === '"') q = true; else if (c === ',') { row.push(f); f = ''; } else if (c === '\n') { row.push(f); out.push(row); row = []; f = ''; } else if (c !== '\r') f += c;
  }
  if (f.length || row.length) { row.push(f); out.push(row); }
  const [h, ...rest] = out;
  return rest.filter((x) => x.length === h.length).map((x) => Object.fromEntries(h.map((k, i) => [k, x[i]])));
};
const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
const fpKey = (x) => `${x.role}|${x.toplevel}|${norm(x.query)}`;
const agg = (rowsIn) => { const m = new Map(); for (const x of rowsIn) { const k = fpKey(x); const v = m.get(k) || { calls: 0, ms: 0 }; v.calls += Number(x.calls); v.ms += Number(x.total_exec_ms || x.total_exec_time || 0); m.set(k, v); } return m; };
const runRoles = new Set(['crewflow_app', 'crewflow', 'rab_secure_owner']);
const shiftCycle = (d) => {
  const sc = J(d, 'shift-cycle.json'); const raw = T(d, 'shift-cycle.pgss-raw.csv'); const idleRaw = T(d, 'idle-O20/pgss-raw.csv');
  if (!sc || !raw || !idleRaw) return null;
  const idleSecs = Number(T(d, 'idle-O20/t-end')) - Number(T(d, 'idle-O20/t-start'));
  const win = agg(parseCsv(raw).filter((x) => runRoles.has(x.role)));
  const bg = agg(parseCsv(idleRaw).filter((x) => runRoles.has(x.role)));
  const W = sc.windowSeconds;
  const sent = (sc.emailsCreated || []).filter((e) => e.status === 'SENT').reduce((s, e) => s + e.n, 0);
  const all = (sc.emailsCreated || []).reduce((s, e) => s + e.n, 0);
  const fps = new Map();
  for (const [k, v] of win) {
    const idleCalls = bg.get(k)?.calls || 0;
    const expectedBg = (idleCalls / idleSecs) * W;
    fps.set(k, { calls: v.calls, ms: v.ms, idleCalls, expectedBg, incremental: v.calls - expectedBg, backgroundFree: idleCalls === 0 });
  }
  return { sc, W, sent, all, fps };
};
const scB = shiftCycle(BASE), scA = shiftCycle(AFTER);
let attribution = null;
if (scB && scA) {
  add('shift-cycle', 'Roster shifts triggered', 'shifts', scB.sc.shifts, scA.sc.shifts, 'MEASURED', 'counter', {});
  add('shift-cycle', 'Venue-manager recipients (venue links)', 'recipients', scB.sc.venueManagerRecipients, scA.sc.venueManagerRecipients, 'MEASURED', 'counter', {});
  add('shift-cycle', 'Roster emails SENT (with PDF)', 'emails', scB.sent, scA.sent, 'MEASURED', 'counter', {});
  add('shift-cycle', 'Roster email rows created (any status)', 'emails', scB.all, scA.all, 'MEASURED', 'counter', {});
  add('shift-cycle', 'Roster PDFs rendered', 'renders', scB.sc.rosterPdfRowsCreated, scA.sc.rosterPdfRowsCreated, 'MEASURED', 'counter', {});
  add('shift-cycle', 'Window length', 's', scB.W, scA.W, 'MEASURED', 'latency', {});
  add('shift-cycle', 'Worker CPU in window', 'CPU-s', scB.sc.workerCpuSecondsInWindow, scA.sc.workerCpuSecondsInWindow, 'MEASURED', 'window-cpu', {});
  add('shift-cycle', 'DB CPU in window', 'CPU-s', scB.sc.pgCpuSecondsInWindow, scA.sc.pgCpuSecondsInWindow, 'MEASURED', 'window-cpu', {});
  const keys = new Set([...scB.fps.keys(), ...scA.fps.keys()]);
  const list = [];
  for (const k of keys) {
    const b = scB.fps.get(k) || { calls: 0, idleCalls: 0, expectedBg: 0, incremental: 0, backgroundFree: true };
    const a = scA.fps.get(k) || { calls: 0, idleCalls: 0, expectedBg: 0, incremental: 0, backgroundFree: true };
    const [role, toplevel, query] = [k.split('|')[0], k.split('|')[1], k.split('|').slice(2).join('|')];
    const bgFree = b.backgroundFree && a.backgroundFree;
    const perB = scB.sent ? b.incremental / scB.sent : null, perA = scA.sent ? a.incremental / scA.sent : null;
    list.push({ role, toplevel, query, bgFree, base: { calls: b.calls, expectedBackground: r(b.expectedBg, 1), perEmail: r(perB, 3) }, after: { calls: a.calls, expectedBackground: r(a.expectedBg, 1), perEmail: r(perA, 3) }, deltaPerEmail: perA != null && perB != null ? r(perA - perB, 3) : null });
  }
  const bf = list.filter((x) => x.bgFree);
  const sumPer = (arr, side, pred = () => true) => r(arr.filter(pred).reduce((s, x) => s + (x[side].perEmail || 0), 0), 2);
  attribution = {
    method: 'pg_stat_statements reset at shift-cycle prepare, dumped at collect (every role, nested included). Per fingerprint: incremental = window calls - (idle-O20 calls/s of the same fingerprint in the same run x window seconds); per email = incremental / roster emails SENT. Fingerprints matched across runs by role + toplevel + normalised query text.',
    emailsSent: { base: scB.sent, after: scA.sent },
    backgroundFreeTotals: {
      label: 'MEASURED (fingerprints with zero calls in the idle-O20 window of both runs: exact counts)',
      toplevelPerEmail: { base: sumPer(bf, 'base', (x) => x.toplevel === 't'), after: sumPer(bf, 'after', (x) => x.toplevel === 't') },
      nestedPerEmail: { base: sumPer(bf, 'base', (x) => x.toplevel !== 't'), after: sumPer(bf, 'after', (x) => x.toplevel !== 't') },
    },
    backgroundSubtractedTotals: {
      label: 'DERIVED (fingerprints that also run in idle loops: window calls minus the scaled idle rate; noisy, read with care)',
      toplevelPerEmail: { base: sumPer(list.filter((x) => !x.bgFree), 'base', (x) => x.toplevel === 't'), after: sumPer(list.filter((x) => !x.bgFree), 'after', (x) => x.toplevel === 't') },
    },
    fingerprintsChanged: list.filter((x) => x.bgFree && x.deltaPerEmail != null && Math.abs(x.deltaPerEmail) >= 0.05).sort((p, q) => Math.abs(q.deltaPerEmail) - Math.abs(p.deltaPerEmail)),
    backgroundFingerprintsChanged: list.filter((x) => !x.bgFree && x.deltaPerEmail != null && Math.abs(x.deltaPerEmail) >= 0.5).sort((p, q) => Math.abs(q.deltaPerEmail) - Math.abs(p.deltaPerEmail)).slice(0, 25),
    backgroundFreeFingerprints: bf.sort((p, q) => (q.after.perEmail || 0) - (p.after.perEmail || 0)),
  };
  add('shift-cycle', 'Background-free SQL per roster email: top-level', 'stmts/email', attribution.backgroundFreeTotals.toplevelPerEmail.base, attribution.backgroundFreeTotals.toplevelPerEmail.after, 'MEASURED', 'counter', {});
  add('shift-cycle', 'Background-free SQL per roster email: nested (SECURITY DEFINER)', 'stmts/email', attribution.backgroundFreeTotals.nestedPerEmail.base, attribution.backgroundFreeTotals.nestedPerEmail.after, 'MEASURED', 'counter', {});
  add('shift-cycle', 'Background-subtracted SQL per roster email: top-level (loop fingerprints)', 'stmts/email', attribution.backgroundSubtractedTotals.toplevelPerEmail.base, attribution.backgroundSubtractedTotals.toplevelPerEmail.after, 'DERIVED', 'derived-noisy', {});
}

// ---- idle per-fingerprint diff at O=20 (explains an idle SQL delta) -------------------------------------------------
const idleFp = (d) => { const raw = T(d, 'idle-O20/pgss-raw.csv'); if (!raw) return null; const s = Number(T(d, 'idle-O20/t-end')) - Number(T(d, 'idle-O20/t-start')); const m = agg(parseCsv(raw).filter((x) => runRoles.has(x.role))); return { m, mins: s / 60 }; };
const ifB = idleFp(BASE), ifA = idleFp(AFTER);
let idleFpDiff = null;
if (ifB && ifA) {
  const keys = new Set([...ifB.m.keys(), ...ifA.m.keys()]);
  idleFpDiff = [...keys].map((k) => { const b = (ifB.m.get(k)?.calls || 0) / ifB.mins, a = (ifA.m.get(k)?.calls || 0) / ifA.mins; const [role, toplevel] = k.split('|'); return { role, toplevel, query: k.split('|').slice(2).join('|').slice(0, 160), basePerMin: r(b, 2), afterPerMin: r(a, 2), delta: r(a - b, 2) }; })
    .filter((x) => Math.abs(x.delta) >= 1).sort((p, q) => Math.abs(q.delta) - Math.abs(p.delta)).slice(0, 20);
}

// ---- noise bands and verdicts ---------------------------------------------------------------------------------------
const p90 = (arr) => { const v = arr.filter((x) => x != null).map(Math.abs).sort((a, b) => a - b); return v.length ? v[Math.min(v.length - 1, Math.floor(0.9 * v.length))] : null; };
const bands = {};
for (const cls of ['latency', 'throughput', 'cpu-per-req', 'memory', 'idle-cpu']) bands[cls] = p90(rows.filter((x) => x.control && x.cls === cls).map((x) => x.deltaPct));
bands['idle-sql'] = Math.max(0.5, p90(rows.filter((x) => x.control && x.cls === 'idle-sql').map((x) => x.deltaPct)) ?? 0);
bands['idle-rate'] = bands['idle-sql'];
bands['window-cpu'] = bands['idle-cpu'];
for (const x of rows) {
  if (x.deltaPct == null && x.base !== x.after) { x.verdict = x.cls === 'counter' && x.base != null && x.after != null ? 'REAL (exact counter)' : 'n/a'; continue; }
  if (x.control) { x.verdict = 'control (code-identical path: delta = host noise)'; continue; }
  if (x.cls === 'counter') { x.verdict = x.base === x.after ? 'identical' : 'REAL (exact counter)'; continue; }
  if (x.cls === 'pdf') { x.verdict = x.mwP >= 0.05 ? `within noise (Mann-Whitney p=${x.mwP})` : `outside noise (Mann-Whitney p=${x.mwP})`; continue; }
  if (x.cls === 'derived-noisy' || x.cls === 'redis-mem') { x.verdict = 'no noise band (single noisy measurement)'; continue; }
  const band = bands[x.cls];
  if (band == null) { x.verdict = 'no band'; continue; }
  x.noiseBandPct = band;
  x.verdict = Math.abs(x.deltaPct) <= band ? `within noise (band ${band}%)` : `outside noise (band ${band}%)`;
}

// ---- comparability (host conditions) ----------------------------------------------------------------------------------
const kv = (d) => Object.fromEntries((T(d, 'versions.txt') || '').split(/\r?\n/).filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const vB = kv(BASE), vA = kv(AFTER);
// The first "running non-harness containers" section of host-state.txt is the run-start snapshot.
const othersAtStart = (d) => {
  const lines = (T(d, 'host-state.txt') || '').split(/\r?\n/);
  const i = lines.findIndex((l) => l.startsWith('## running non-harness'));
  if (i < 0) return null;
  const out = [];
  for (const l of lines.slice(i + 1)) { if (l.startsWith('#')) break; if (l.trim()) out.push(l.split('\t')[0]); }
  return out.join(',');
};
const hostIdle = (d) => Object.fromEntries(['O0', 'O5', 'O20'].map((l) => [l, idle(d, l)?.hostContention || null]));
const comparability = {
  devContainersAtStart: { base: vB['devContainers.atStart'], after: vA['devContainers.atStart'], same: vB['devContainers.atStart'] === vA['devContainers.atStart'] },
  devContainersChangedDuringRun: { base: vB['devContainers.changedDuringRun'], after: vA['devContainers.changedDuringRun'] },
  otherContainersRunningAtStart: { base: othersAtStart(BASE), after: othersAtStart(AFTER) },
  vm: { base: vB['vm.cpus'], after: vA['vm.cpus'] },
  limits: { same: vB['limits.api'] === vA['limits.api'] },
  idleSeconds: { base: vB.idleSeconds, after: vA.idleSeconds },
  seed: { base: vB.seed, after: vA.seed },
  hostContentionIdle: { base: hostIdle(BASE), after: hostIdle(AFTER) },
  mainCheckout: { base: vB.mainCheckout, after: vA.mainCheckout },
};

const out = { generatedAt: new Date().toISOString(), base: BASE, after: AFTER, noiseBandsPct: bands, comparability, metrics: rows, idleFits: fits, shiftCycleAttribution: attribution, idleO20FingerprintDiff: idleFpDiff };
fs.writeFileSync(path.join(OUTDIR, 'comparison.json'), JSON.stringify(out, null, 2));

// ---- markdown -------------------------------------------------------------------------------------------------------
// Markdown table cell: escape backslashes first, then pipes (CodeQL js/incomplete-sanitization).
const esc = (x) => String(x ?? '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
const md = [];
md.push(`# Cost comparison: baseline vs after`, '', `- baseline: \`${BASE}\``, `- after: \`${AFTER}\``, `- generated ${out.generatedAt}`, '');
md.push('## Host conditions (comparability)', '');
md.push(`| | baseline | after |`, '|---|---|---|');
md.push(`| dev containers at start | ${esc(comparability.devContainersAtStart.base)} | ${esc(comparability.devContainersAtStart.after)} |`);
md.push(`| dev containers changed during run | ${comparability.devContainersChangedDuringRun.base} | ${comparability.devContainersChangedDuringRun.after} |`);
md.push(`| other containers running at start | ${esc(comparability.otherContainersRunningAtStart.base)} | ${esc(comparability.otherContainersRunningAtStart.after)} |`);
for (const l of ['O0', 'O5', 'O20']) {
  const b = comparability.hostContentionIdle.base[l], a = comparability.hostContentionIdle.after[l];
  const top = (h) => (h ? Object.entries(h.containers).sort((p, q) => q[1].cpuPctAvg - p[1].cpuPctAvg).slice(0, 3).map(([k, v]) => `${k} ${v.cpuPctAvg}%`).join(', ') : '');
  md.push(`| non-harness CPU during idle ${l} (sum of avgs, % of one core) | ${b?.totalCpuPctAvg ?? ''} (${top(b)}) | ${a?.totalCpuPctAvg ?? ''} (${top(a)}) |`);
}
md.push(`| main checkout | ${esc(comparability.mainCheckout.base)} | ${esc(comparability.mainCheckout.after)} |`, '');
md.push('## Noise bands (from code-identical control metrics; p90 of |delta%|)', '', '| class | band % |', '|---|---|', ...Object.entries(bands).map(([k, v]) => `| ${k} | ${v ?? '-'} |`), '');
md.push('## All metrics', '', '| Group | Metric | Unit | Baseline | After | Δ% | Label | Verdict |', '|---|---|---|---|---|---|---|---|');
for (const x of rows) md.push(`| ${x.group} | ${esc(x.metric)} | ${esc(x.unit)} | ${esc(x.base)} | ${esc(x.after)} | ${x.deltaPct ?? '-'} | ${x.label} | ${esc(x.verdict)} |`);
md.push('');
if (attribution) {
  md.push('## Roster stage: SQL per roster email by fingerprint', '', attribution.method, '');
  md.push(`Emails SENT: baseline ${attribution.emailsSent.base}, after ${attribution.emailsSent.after}.`, '');
  md.push('### Fingerprints whose per-email count changed (background-free, MEASURED)', '', '| role | top | base/email | after/email | Δ/email | query |', '|---|---|---|---|---|---|');
  for (const f of attribution.fingerprintsChanged) md.push(`| ${f.role} | ${f.toplevel} | ${f.base.perEmail} | ${f.after.perEmail} | ${f.deltaPerEmail} | \`${esc(f.query.slice(0, 220))}\` |`);
  md.push('', '### Loop fingerprints with a per-email change ≥ 0.5 after background subtraction (DERIVED, noisy)', '', '| role | top | base/email | after/email | Δ/email | expected bg (base/after) | query |', '|---|---|---|---|---|---|---|');
  for (const f of attribution.backgroundFingerprintsChanged) md.push(`| ${f.role} | ${f.toplevel} | ${f.base.perEmail} | ${f.after.perEmail} | ${f.deltaPerEmail} | ${f.base.expectedBackground}/${f.after.expectedBackground} | \`${esc(f.query.slice(0, 160))}\` |`);
  md.push('');
}
if (idleFpDiff) {
  md.push('## Idle O=20: fingerprints whose rate changed by ≥ 1/min', '', '| role | top | base/min | after/min | Δ/min | query |', '|---|---|---|---|---|---|');
  for (const f of idleFpDiff) md.push(`| ${f.role} | ${f.toplevel} | ${f.basePerMin} | ${f.afterPerMin} | ${f.delta} | \`${esc(f.query)}\` |`);
  md.push('');
}
fs.writeFileSync(path.join(OUTDIR, 'comparison.md'), md.join('\n') + '\n');
console.log(`metrics ${rows.length}; bands ${JSON.stringify(bands)}; written ${path.join(OUTDIR, 'comparison.md')}`);
