// node lib/analyze-boot.js <label> <container...>  ->  $COST_OUT/<dir>/summary.json   (Phase A measurement, 2026-10-27)
//   label boot-cold | boot-restart  (dir boot-cold / boot-restart, one worker; scripts/measure.sh boot-probe)
//   label replicas                  (dir replicas, costaudit-worker + costaudit-worker2; scripts/measure.sh replicas)
// Everything here is MEASURED in that window: timings from timestamps the harness took and from `docker logs -t`, SQL from
// pg_stat_statements (reset at the window start), S3 calls from the MinIO trace (lib/storage-ops.js, run first), storage
// reconciles from the worker's own log lines, processes from /proc inside the container, BullMQ repeat keys from Redis.
const fs = require('fs');
const path = require('path');
const { OUT } = require('./lib');

const [label, ...containers] = process.argv.slice(2);
if (!label || !containers.length) { console.error('usage: analyze-boot.js <label> <container...>'); process.exit(2); }
const dir = path.join(OUT, label);
const rd = (f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return null; } };
const kv = (t) => Object.fromEntries((t || '').split(/\r?\n/).filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const times = kv(rd('times.env'));
const t0Ms = Number(times.t0Ns) / 1e6;
const windowS = Number(times.windowS);
const mins = windowS / 60;
const num = (x) => (x == null || x === 'none' || x === '' ? null : Number(x));

// Health timings per container.
const health = {};
for (const l of (rd('health.txt') || '').split(/\r?\n/).filter(Boolean)) {
  const [c, ...rest] = l.split(' ');
  const h = kv(rest.join('\n'));
  health[c] = { probeHealthyMs: num(h.probeHealthyMs), dockerHealthyMs: num(h.dockerHealthyMs) };
}

// Worker logs: timestamped (docker logs -t).
const logFile = (c) => (containers.length === 1 ? 'worker.log' : `${c}.log`);
const procFile = (c) => (containers.length === 1 ? 'procs.txt' : `${c}.procs.txt`);
const msOf = (line) => { const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)\s/.exec(line); return m ? Date.parse(m[1]) - t0Ms : null; };
const perContainer = {};
for (const c of containers) {
  const lines = (rd(logFile(c)) || '').split(/\r?\n/).filter(Boolean);
  const first = (re) => { const l = lines.find((x) => re.test(x)); return l ? Math.round(msOf(l)) : null; };
  const count = (re) => lines.filter((x) => re.test(x)).length;
  const storageLines = lines.filter((x) => /storage[ -](cleanup|reconcil)/i.test(x)).map((x) => x.replace(/^\S+\s/, '').slice(0, 240));
  const procs = (rd(procFile(c)) || '').split(/\r?\n/).filter(Boolean).filter((l) => !/worker-bundle-health\.cjs|for p in \/proc/.test(l));
  perContainer[c] = {
    readyMs: first(/rab-worker ready/),
    readyLines: count(/rab-worker ready/),
    storageReconcilesCompleted: count(/storage cleanup: checked=/),
    storageReconcileLines: storageLines.slice(0, 40),
    errorLines: lines.filter((x) => /\b(ERROR|error|failed)\b/.test(x)).length,
    processes: {
      // tini (PID 1) carries the launcher's command line as its arguments; counted separately.
      tini: procs.filter((l) => /\btini\b/.test(l)).length,
      launcher: procs.filter((l) => /start-worker-bundle\.cjs/.test(l) && !/\btini\b/.test(l)).length,
      jobs: procs.filter((l) => /rab-worker\/dist\/main\.js/.test(l)).length,
      provisioner: procs.filter((l) => /workspace-provisioner\.main\.js/.test(l)).length,
      list: procs.map((l) => l.slice(0, 160)),
    },
    health: health[c] || null,
  };
}

// Shutdown (restart probe only).
const shutdown = rd('worker-shutdown.log');
const shutdownInfo = shutdown == null ? null : {
  stopMs: num(times.stopMs),
  cleanShutdownLines: (shutdown.match(/Worker shut down cleanly/g) || []).length,
  lastLines: shutdown.split(/\r?\n/).filter(Boolean).slice(-8).map((x) => x.replace(/^\S+\s/, '').slice(0, 200)),
};

// SQL in the window (pg_stat_statements reset ~1 s before T0; dumped after the window).
const pg = (rd('pgss.txt') || '').trim().split(/\r?\n/).filter(Boolean).map((l) => { const p = l.split('|'); return { role: p[0], calls: Number(p[1]), ms: Number(p[2]), rows: Number(p[3]), toplevel: p[4] === 't', query: p.slice(5).join('|') }; });
const app = pg.filter((r) => r.role !== 'rab');
const sum = (a) => a.reduce((s, r) => s + r.calls, 0);
const byRole = {};
for (const r of app) { const k = `${r.role}${r.toplevel ? '' : ' (nested)'}`; byRole[k] = (byRole[k] || 0) + r.calls; }
const sql = {
  windowSeconds: windowS,
  runtimeStatements: sum(app.filter((r) => r.role === 'crewflow_app' || r.role === 'crewflow')),
  runtimeStatementsPerMin: +(sum(app.filter((r) => r.role === 'crewflow_app' || r.role === 'crewflow')) / mins).toFixed(1),
  provisionerRoleStatements: sum(app.filter((r) => r.role === 'crewflow')),
  provisionerRoleStatementsPerMin: +(sum(app.filter((r) => r.role === 'crewflow')) / mins).toFixed(1),
  nestedDefinerStatements: sum(app.filter((r) => r.role === 'rab_secure_owner')),
  byRole,
  top20: app.slice(0, 20).map((r) => ({ role: r.role, toplevel: r.toplevel, calls: r.calls, query: r.query.slice(0, 160) })),
};

// CPU over the window.
const cpu = (f) => Object.fromEntries((rd(f) || '').trim().split(/\r?\n/).filter(Boolean).map((l) => { const [n, v] = l.split(' '); return [n, Number(v)]; }));
const c0 = cpu('cpu-start.txt'), c1 = cpu('cpu-end.txt');
const cpuSeconds = Object.fromEntries(Object.keys(c1).map((k) => [k, c0[k] ? +((c1[k] - c0[k]) / 1e6).toFixed(2) : +(c1[k] / 1e6).toFixed(2)]));

// S3 (lib/storage-ops.js wrote storage-<label>.json).
let s3 = null;
try { s3 = JSON.parse(fs.readFileSync(path.join(OUT, `storage-${label}.json`), 'utf8')); } catch { /* absent */ }

const out = {
  label, label_kind: 'MEASURED', containers, windowSeconds: windowS, startedAt: times.startedAt || null, restartCount: num(times.restartCount),
  perContainer,
  shutdown: shutdownInfo,
  sql,
  cpuSecondsInWindow: cpuSeconds,
  s3: s3 ? { totalS3Calls: s3.totalS3Calls, ops: s3.ops, byClient: s3.byClient, storedFileRows: s3.storedFileRows } : null,
  storageReconcilesCompletedTotal: Object.values(perContainer).reduce((s, p) => s + p.storageReconcilesCompleted, 0),
  redisRepeatKeys: { before: (rd('redis-sched-before.txt') || '').trim().split(/\r?\n/), after: (rd('redis-sched-after.txt') || '').trim().split(/\r?\n/) },
};
fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify({
  label,
  timings: Object.fromEntries(Object.entries(perContainer).map(([c, p]) => [c, { readyMs: p.readyMs, ...(p.health || {}) }])),
  stopMs: shutdownInfo?.stopMs ?? null,
  reconciles: Object.fromEntries(Object.entries(perContainer).map(([c, p]) => [c, p.storageReconcilesCompleted])),
  s3: out.s3 ? out.s3.ops : null,
  s3ByClient: out.s3 ? out.s3.byClient : null,
  sqlPerMin: sql.runtimeStatementsPerMin, provisionerSqlPerMin: sql.provisionerRoleStatementsPerMin,
  processes: Object.fromEntries(Object.entries(perContainer).map(([c, p]) => [c, { launcher: p.processes.launcher, jobs: p.processes.jobs, provisioner: p.processes.provisioner }])),
}, null, 1));
