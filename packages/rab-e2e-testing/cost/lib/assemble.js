// Builds $COST_OUT/results.json (+ results-table.md) from the raw result files of one run. Every metric carries a label:
//   MEASURED - read directly from this run (counters, timers, traces)
//   DERIVED  - computed from MEASURED values (fits, ratios, per-unit divisions) or from code paths; method states how
//   ASSUMED  - an input chosen by the harness (seed shape, concurrency, window lengths)
//   QUOTED   - taken from an external source (the old audit's numbers, provider price classes)
// Projections are never labelled MEASURED.
const fs = require('fs');
const path = require('path');
const { OUT } = require('./lib');

const R = (f) => { try { return JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8')); } catch { return null; } };
const T = (f) => { try { return fs.readFileSync(path.join(OUT, f), 'utf8'); } catch { return null; } };
const r2 = (x, d = 2) => (x == null || Number.isNaN(x) ? null : +Number(x).toFixed(d));

// The 2026-10-26 audit (docs/audits/COST_COMPARISON_100K_CLAUDE.md §2-§3), commit 5fa7b323. QUOTED for comparison.
const OLD = {
  idleSqlPerMin: { O0: 222, O5: 4046, O20: 15153 }, idleNested: { O0: 151, O5: 285, O20: 340 }, idleFit: '264 + 745*O',
  dbCpuIdleO20Pct: 7.03, dbCpuMsPerStatement: 0.28, workerCpuIdle: '0.84% + 0.149%*O (3.74% at O=20)', workerRss: 'jobs 149 MB, provisioner 20 MB',
  redisIdle: '10 commands/s; used_memory 2.45 MB',
  sql: { '/auth/me': 12, '/profile': 12, 'unread-count': '10-11', '/files/:id': '10-11', '/dashboard/summary': 29, 'GET /shifts default': '15 (290 KB)', 'GET /shifts?limit=50': '15 (47 KB)', 'send offer': 28, 'check-in': 20, 'clock-in': 21 },
  dashboard: '16 requests, 237 SQL, 477 KB, 194-204 ms wall',
  load: {
    'GET /dashboard/summary c=25': { rps: 133, p50: 178, p95: 231, p99: 345, apiMs: 7.5, dbMs: 22.5 },
    'GET /shifts?limit=50 c=25': { rps: 154, p50: 155, p95: 206, p99: 317, apiMs: 6.5, dbMs: 11.6 },
    'GET /notifications/unread-count c=25': { rps: 327, p50: 72, p95: 97, p99: 178, apiMs: 3.1, dbMs: 6.4 },
    'GET /offers/mine (bearer) c=25': { rps: 57, p50: 369, p95: 826, p99: 2898, apiMs: 14.3, dbMs: 50.7, apiRss: 720 },
    'GET /files/:id avatar c=25': { rps: 118, p50: 140, p95: 300, p99: 511, apiMs: 7.2, dbMs: 7.2 },
    'POST /notifications/:id/read (bearer) c=10': { rps: 328, p50: 29, p95: 41, p99: 57 },
  },
  pdf: '1.95 s CPU / 1.96 s wall per roster (5 staff), new Chromium per render, container peak 517 MB, 57 KB (re-implemented renderer)',
  redisPerJob: '3.5 KB per completed email job',
  storage: 'DERIVED (not measured): one HEAD per stored_file row + a full LIST, daily and at every boot',
  emailsPerShift: 'DERIVED 4.5 per shift (1.5 venue-manager recipients ASSUMED x (>=2 rosters + 1 final timesheet))',
};

const metrics = [];
const add = (group, metric, value, unit, label, method, old = null, note = null) => metrics.push({ group, metric, value, unit, label, method, oldAudit: old, note });

// ---- idle ---------------------------------------------------------------------------------------------------------
const idle = {};
for (const l of ['O0', 'O5', 'O20']) { const s = R(`idle-${l}/summary.json`); if (s) idle[l] = s; }
const O = { O0: 0, O5: 5, O20: 20 };
for (const [l, s] of Object.entries(idle)) {
  add('idle', `Idle runtime SQL/min, O=${O[l]} (old-audit definition: all statements as crewflow_app/crewflow)`, s.sql.topLevelCallsPerMin, 'statements/min', 'MEASURED', `pg_stat_statements delta over ${s.windowMinutes} min, worker only, no HTTP`, OLD.idleSqlPerMin[l]);
  add('idle', `Idle client-sent SQL/min, O=${O[l]} (pg_stat_statements toplevel=true)`, s.sql.clientStatementsPerMin, 'statements/min', 'MEASURED', 'same window, toplevel rows only', null);
  add('idle', `Idle nested SQL/min inside SECURITY DEFINER functions, O=${O[l]}`, s.sql.nestedInsideDefinerFunctionsPerMin, 'statements/min', 'MEASURED', 'same window, role rab_secure_owner', OLD.idleNested[l]);
  add('idle', `DB CPU at idle, O=${O[l]}`, s.cpuFromCgroupPctOfOneCore['costaudit-pg'], '% of one core', 'MEASURED', 'cgroup v2 cpu.stat usage_usec delta / window', l === 'O20' ? OLD.dbCpuIdleO20Pct : null);
  add('idle', `Worker CPU at idle, O=${O[l]}`, s.cpuFromCgroupPctOfOneCore['costaudit-worker'], '% of one core', 'MEASURED', 'cgroup v2 cpu.stat delta (jobs + provisioner children)', l === 'O20' ? 3.74 : null);
  add('idle', `Redis commands/s at idle, O=${O[l]}`, s.redis.commandsPerSec, 'commands/s', 'MEASURED', 'INFO stats total_commands_processed delta', l === 'O20' ? 10 : null);
  add('idle', `Worker memory (cgroup memory.current) at end of idle window, O=${O[l]}`, s.cgroupMemoryAtEnd?.['costaudit-worker']?.memoryCurrentMiB ?? null, 'MiB', 'MEASURED', 'cgroup memory.current (resident + page cache charged to the container); VM swapping => indicative', null);
  if (s.hostContention) add('host', `Non-harness containers' CPU during idle window, O=${O[l]} (contention context, not a cost)`, s.hostContention.totalCpuPctAvg, '% of one core (sum of averages)', 'MEASURED', 'docker stats every 15 s of every running non-harness container (dev stack, other agents); compare between baseline and after runs', null, 'The dev stack is no longer stopped; a large difference between two runs weakens their comparability.');
}
const pts = Object.entries(idle).map(([l, s]) => ({ o: O[l], sql: s.sql.topLevelCallsPerMin, client: s.sql.clientStatementsPerMin, nested: s.sql.nestedInsideDefinerFunctionsPerMin, pg: s.cpuFromCgroupPctOfOneCore['costaudit-pg'], worker: s.cpuFromCgroupPctOfOneCore['costaudit-worker'], redis: s.redis.commandsPerSec }));
const lin = (k) => { const n = pts.length; if (n < 2) return null; const sx = pts.reduce((a, p) => a + p.o, 0), sy = pts.reduce((a, p) => a + p[k], 0), sxx = pts.reduce((a, p) => a + p.o * p.o, 0), sxy = pts.reduce((a, p) => a + p.o * p[k], 0); const b = (n * sxy - sx * sy) / (n * sxx - sx * sx); return { intercept: r2((sy - b * sx) / n, 3), slopePerOrg: r2(b, 3) }; };
const fit = { points: pts, note: 'Least squares over the measured O points. W = O (one workspace per organisation in this seed), so the per-org slope includes the per-workspace term.', sqlPerMin: lin('sql'), clientSqlPerMin: lin('client'), nestedPerMin: lin('nested'), pgCpuPctOfOneCore: lin('pg'), workerCpuPctOfOneCore: lin('worker'), redisCmdsPerSec: lin('redis') };
if (fit.sqlPerMin) add('idle', 'Idle SQL/min fitted formula (old-audit definition)', `${fit.sqlPerMin.intercept} + ${fit.sqlPerMin.slopePerOrg}*O`, 'statements/min', 'DERIVED', 'least-squares fit of the MEASURED O=0/5/20 points; any O outside 0-20 is an extrapolation', OLD.idleFit);
if (fit.workerCpuPctOfOneCore) add('idle', 'Worker CPU at idle, fitted', `${fit.workerCpuPctOfOneCore.intercept}% + ${fit.workerCpuPctOfOneCore.slopePerOrg}%*O`, '% of one core', 'DERIVED', 'least-squares fit of MEASURED points', OLD.workerCpuIdle);
if (fit.pgCpuPctOfOneCore) add('idle', 'DB CPU at idle, fitted', `${fit.pgCpuPctOfOneCore.intercept}% + ${fit.pgCpuPctOfOneCore.slopePerOrg}%*O`, '% of one core', 'DERIVED', 'least-squares fit of MEASURED points', null);
if (idle.O20) {
  const s = idle.O20; const perSec = s.sql.topLevelCallsPerMin / 60;
  add('idle', 'DB CPU per idle statement, O=20', r2(((s.cpuFromCgroupPctOfOneCore['costaudit-pg'] / 100) * 1000) / perSec, 4), 'ms CPU / statement', 'DERIVED', 'MEASURED pg cgroup CPU / MEASURED statements per second (old-audit statement definition)', OLD.dbCpuMsPerStatement);
  add('idle', 'Redis used_memory at idle, O=20', s.redis.usedMemory, 'bytes', 'MEASURED', 'INFO memory', '2.45 MB');
  add('idle', 'Worker processes RSS at idle, O=20', (s.workerProcs || []).join(' ; '), 'kB', 'MEASURED', '/proc/<pid>/status VmRSS inside the worker container (swapped pages excluded)', OLD.workerRss);
}

// ---- requests ------------------------------------------------------------------------------------------------------
const ep = R('endpoints-baseline.json');
if (ep) {
  for (const [name, v] of Object.entries(ep.endpoints)) add('sql-per-request', `SQL per request: ${name}`, v.sqlCountMedian, 'statements (median)', 'MEASURED', `request_complete.sqlCount, median of ${v.n} sequential requests (status ${v.statuses.join('/')}); tx=${v.txCountMedian}; server ${v.serverMsMedian} ms; client ${r2(v.clientMsMedian, 1)} ms; ${v.responseBytesMedian} B`, null);
  const d = ep.dashboardFullLoad; const d16 = ep.dashboardOld16Set;
  add('dashboard', 'Web dashboard load at this commit: requests', d.requests, 'requests', 'DERIVED', `distinct API calls in rab-front Dashboard.tsx at the commit under test (pipeline fired: ${d.pipelineFired})`, 16, 'The /shifts/:id/pipeline call became conditional in dcddb901; the seed has no venue-requested shifts, so it is not fired.');
  add('dashboard', 'Web dashboard load at this commit: SQL', d.sqlTotalMedian, 'statements', 'MEASURED', `sum of request_complete.sqlCount, median of ${d.runs} loads at concurrency ${d.concurrency}`, 237);
  add('dashboard', 'Web dashboard load at this commit: KB', r2(d.bytesTotalMedian / 1024, 1), 'KB', 'MEASURED', 'sum of response bytes (uncompressed, loopback)', 477);
  add('dashboard', 'Web dashboard load at this commit: wall time', r2(d.wallMsMedian, 1), 'ms', 'MEASURED', '6 concurrent connections, loopback', '194-204');
  add('dashboard', 'Old-audit 16-request set (incl. pipeline): SQL / KB', `${d16.sqlTotalMedian} / ${r2(d16.bytesTotalMedian / 1024, 1)}`, 'statements / KB', 'MEASURED', `same method; pipeline status ${Object.keys(d16.statuses).join(', ') || '200'}`, '237 / 477');
  add('sql-per-request', 'pg_stat_statements cross-check, GET /dashboard/summary', `${ep.pgssCrossCheck.crewflowAppToplevelPerRequest} top-level + ${ep.pgssCrossCheck.nestedDefinerPerRequest} nested (logged sqlCount ${ep.pgssCrossCheck.loggedSqlCountMedian})`, 'statements/request', 'MEASURED', '20 requests with the worker paused; pgss includes BEGIN', '30 top-level + 8 nested (logged 29)');
}
const load = R('load-baseline.json');
if (load) for (const s of load) {
  const o = OLD.load[s.scenario] || {};
  add('load', `${s.scenario}: throughput`, r2(s.rps, 1), 'req/s', 'MEASURED', `autocannon 8.0.0, ${s.connections} connections, ${s.durationS} s, API --cpus=1, worker paused; non2xx=${s.non2xx} errors=${s.errors}`, o.rps ?? null);
  add('load', `${s.scenario}: latency p50/p95/p99`, `${s.latencyExact?.p50} / ${s.latencyExact?.p95} / ${s.latencyExact?.p99}`, 'ms', 'MEASURED', 'per-response latency from autocannon (exact percentiles over all responses)', o.p50 != null ? `${o.p50} / ${o.p95} / ${o.p99}` : null);
  add('load', `${s.scenario}: API / DB CPU per request`, `${s.apiCpuMsPerRequest} / ${s.pgCpuMsPerRequest}`, 'ms CPU', 'MEASURED', 'cgroup CPU delta of costaudit-api / costaudit-pg divided by requests', o.apiMs != null ? `${o.apiMs} / ${o.dbMs ?? '-'}` : null);
  add('load', `${s.scenario}: API memory peak`, s.apiMemPeakMiB_cgroup, 'MiB', 'MEASURED', 'cgroup memory.current sampled every 3 s (indicative: VM swapping)', o.apiRss ?? null);
  add('load', `${s.scenario}: peak DB connections by role`, JSON.stringify(s.peakDbConnectionsByRole), 'connections', 'MEASURED', 'pg_stat_activity sampled every 3 s', '14-22 (crewflow_app)');
  if (s.pgss) add('load', `${s.scenario}: DB execution per request`, `${s.pgss.dbExecMsPerRequest_toplevel} ms exec, ${s.pgss.statementsPerRequest} statements (+${s.pgss.nestedDefinerStatementsPerRequest} nested)`, 'ms / statements', 'MEASURED', 'pg_stat_statements total_exec_time (toplevel, crewflow_app) / requests, during the load window', o.dbMs != null ? `${o.dbMs} ms DB CPU (cgroup)` : null);
}

// ---- pdf / redis / storage / shift cycle ---------------------------------------------------------------------------
const pdf = R('pdfbench.json');
if (pdf) for (const [doc, v] of Object.entries(pdf.docs)) {
  add('pdf', `PDF render CPU, ${doc} (${pdf.staffRows} staff)`, v.summary.cpuSecondsMedian, 'CPU-seconds (median)', 'MEASURED', `real renderHtmlToPdf (launch per render), N=${pdf.n} after 1 warm-up, --cpus=1 --memory=1g, cgroup CPU of the whole container; mean ${v.summary.cpuSecondsMean}`, doc === 'roster' ? 1.95 : null);
  add('pdf', `PDF render wall / peak memory / size, ${doc}`, `${v.summary.wallMsMedian} ms / ${v.summary.peakContainerMemMiBMax} MiB / ${r2(v.summary.pdfBytesMedian / 1024, 1)} KB`, 'ms / MiB / KB', 'MEASURED', 'same renders', doc === 'roster' ? '1960 ms / 517 MB / 57 KB' : null);
}
const em = R('emails-bullmq.json');
if (em) {
  add('redis', 'Redis memory per completed email job', r2(em.bytesPerCompletedJob_usedMemoryDelta / 1024, 2), 'KB', 'MEASURED', `${em.sentResetEmails} forgot-password emails through the API and worker; used_memory delta / jobs sent`, 3.5, `job hash median ${em.jobHashBytesMedianOf20} B over ${em.jobHashKeysPresent} job keys`);
}
for (const [lab, title] of [['cli', 'storage:reconcile CLI (report-only, worker paused)'], ['boot', 'worker boot (scheduled storage cleanup + boot-time jobs)'], ['shiftcycle', 'shift-cycle window (roster stage)']]) {
  const s = R(`storage-${lab}.json`);
  if (!s) continue;
  add('storage', `S3 ops, ${title}: HEAD/LIST/GET/PUT`, `${s.ops.HEAD} / ${s.ops.LIST} / ${s.ops.GET} / ${s.ops.PUT}`, 'calls', 'MEASURED', `MinIO mc admin trace, every S3 call in the window; stored_file rows ${s.storedFileRows}`, lab === 'cli' ? OLD.storage : null);
  add('storage', `S3 ops per stored_file row, ${title}`, JSON.stringify(s.perStoredFileRow), 'calls/row', 'DERIVED', 'MEASURED calls / stored_file rows at end of window', null);
  add('storage', `R2 operation classes, ${title}`, `A=${s.r2Classes_DERIVED.classA} B=${s.r2Classes_DERIVED.classB}`, 'operations', 'DERIVED', s.r2Classes_DERIVED.note, null);
}
const sc = R('shift-cycle.json');
if (sc) {
  add('email', 'Roster emails per shift', sc.perShift.rosterEmails, 'emails/shift', 'MEASURED', `${sc.shifts} shifts moved into the roster window (synthetic trigger), real worker path; all with PDF attachment: ${sc.perShift.rosterEmailsWithPdfAttachment}`, OLD.emailsPerShift);
  add('email', 'Roster PDFs per shift', sc.perShift.rosterPdfs, 'renders/shift', 'MEASURED', 'SHIFT_ROSTER_PDF stored_file rows created in the window / shifts', '>=2 (DERIVED, re-render on shift.updated_at)');
  add('email', 'Emails per shift, roster + final timesheet', r2(sc.venueManagerRecipients / sc.shifts * 2, 2), 'emails/shift', 'DERIVED', 'recipients = venue managers linked to the shift venue (MEASURED for the chosen shifts) x (1 roster + 1 final timesheet), from shift-report-scheduler.job.ts / final-timesheet.job.ts; excludes roster re-renders', OLD.emailsPerShift);
  add('worker', 'Worker CPU during shift-cycle window', `${sc.workerCpuSecondsInWindow} CPU-s over ${sc.windowSeconds} s (${sc.shifts} rosters)`, 'CPU-seconds', 'MEASURED', 'cgroup CPU delta; includes idle loops running concurrently', null);
}

// ---- Phase A measurement (2026-10-27): flag configurations, provisioner, startup/recovery, two replicas ---------------
const phaseA = { flags: {}, provisioner: {}, boot: {}, replicas: null };
const flagCfg = {};
for (const o of ['O0', 'O5', 'O20']) {
  flagCfg[o] = 'REALTIME_ENABLED=false PUSH_ENABLED=false (code defaults; production compose sets neither)';
  flagCfg[`${o}-flags-on`] = 'REALTIME_ENABLED=true PUSH_ENABLED=true (API and worker)';
}
for (const [l, cfg] of Object.entries(flagCfg)) {
  const s = R(`idle-${l}/summary.json`);
  if (!s) continue;
  const o = l.replace(/-flags-on$/, '');
  const s3 = R(`storage-idle-${l}.json`);
  const mem = s.cgroupMemoryAtEnd?.['costaudit-worker']?.memoryCurrentMiB ?? null;
  phaseA.flags[l] = { config: cfg, sql: s.sql.topLevelCallsPerMin, client: s.sql.clientStatementsPerMin, nested: s.sql.nestedInsideDefinerFunctionsPerMin, workerCpu: s.cpuFromCgroupPctOfOneCore['costaudit-worker'], dbCpu: s.cpuFromCgroupPctOfOneCore['costaudit-pg'], workerMemMiB: mem, redisCmdsPerSec: s.redis.commandsPerSec, s3: s3 ? s3.ops : null, flagsSeen: (T(`idle-${l}/flags.txt`) || '').trim().split(/\r?\n/) };
  add('flags', `Idle window ${o}, ${cfg}: SQL/min / DB CPU / worker CPU / worker memory / Redis cmd/s`, `${s.sql.topLevelCallsPerMin} / ${s.cpuFromCgroupPctOfOneCore['costaudit-pg']}% / ${s.cpuFromCgroupPctOfOneCore['costaudit-worker']}% / ${mem} MiB / ${s.redis.commandsPerSec}`, 'mixed', 'MEASURED', `idle-${l}, ${s.windowMinutes} min; flags seen: ${phaseA.flags[l].flagsSeen.join('; ')}`, null);
  if (s3) add('flags', `Idle window ${o}, ${cfg}: S3 HEAD/LIST/GET/PUT`, `${s3.ops.HEAD} / ${s3.ops.LIST} / ${s3.ops.GET} / ${s3.ops.PUT}`, 'calls', 'MEASURED', 'MinIO trace over the idle window', null);
}
for (const l of ['O0', 'O5', 'O20']) if (idle[l]) add('provisioner', `Provisioner SQL/min (crewflow role), as configured, O=${O[l]}`, idle[l].sql.topLevelByRole.crewflow, 'statements/min', 'MEASURED', `idle-${l}: statements executed as crewflow (the provisioner child's only login)`, null);
let provDirs = [];
try { provDirs = fs.readdirSync(OUT).filter((d) => /^idle-prov-[A-Za-z0-9_-]+$/.test(d)); } catch { /* none */ }
for (const d of provDirs) {
  const s = R(`${d}/summary.json`); if (!s) continue;
  const name = d.replace(/^idle-prov-/, '');
  const cfg = T(`worker-env/prov-${name}.config`) || '';
  phaseA.provisioner[name] = { crewflowSqlPerMin: s.sql.topLevelByRole.crewflow, runtimeSqlPerMin: s.sql.topLevelCallsPerMin, workerCpu: s.cpuFromCgroupPctOfOneCore['costaudit-worker'], dbCpu: s.cpuFromCgroupPctOfOneCore['costaudit-pg'], config: cfg.trim().split(/\r?\n/), windowMinutes: s.windowMinutes };
  add('provisioner', `Provisioner SQL/min (crewflow role), configuration '${name}'`, s.sql.topLevelByRole.crewflow, 'statements/min', 'MEASURED', `${d}, ${s.windowMinutes} min at O=20; env-file keys: ${(cfg.match(/^envFileKeys=(.*)$/m) || [])[1] || '-'}`, null);
  add('provisioner', `All runtime SQL/min / worker CPU, configuration '${name}'`, `${s.sql.topLevelCallsPerMin} / ${s.cpuFromCgroupPctOfOneCore['costaudit-worker']}%`, 'statements/min / % core', 'MEASURED', `${d}`, null);
}
let refused = [];
try { refused = fs.readdirSync(path.join(OUT, 'worker-env')).filter((x) => /^prov-.*\.REFUSED$/.test(x)); } catch { /* none */ }
for (const x of refused) {
  const name = x.replace(/^prov-/, '').replace(/\.REFUSED$/, '');
  const txt = (T(`worker-env/${x}`) || '').trim().split(/\r?\n/);
  phaseA.provisioner[name] = { refused: true, firstLine: txt[0], log: txt.slice(1, 21), config: (T(`worker-env/prov-${name}.config`) || '').trim().split(/\r?\n/) };
  add('provisioner', `Provisioner configuration '${name}': worker did not start`, 'refused', '-', 'MEASURED', `${txt[0]}; last log line: ${txt.filter(Boolean).slice(-1)[0] || '-'}`, null);
}
for (const l of ['cold', 'restart']) {
  const b = R(`boot-${l}/summary.json`); if (!b) continue;
  const w = b.perContainer['costaudit-worker'] || {};
  phaseA.boot[l] = b;
  add('boot', `Worker ${l}: ready / healthy (probe) / healthy (Docker HEALTHCHECK)`, `${w.readyMs} / ${w.health?.probeHealthyMs} / ${w.health?.dockerHealthyMs}`, 'ms after start', 'MEASURED', `${l === 'restart' ? `after a graceful stop that took ${b.shutdown?.stopMs} ms (clean-shutdown lines: ${b.shutdown?.cleanShutdownLines}); ` : 'fresh container; '}"rab-worker ready" log line; image health command via docker exec every ~2 s; Docker HEALTHCHECK polled (30 s interval)`, null);
  add('boot', `Worker ${l}: S3 HEAD/LIST/GET/PUT in the first ${b.windowSeconds} s`, b.s3 ? `${b.s3.ops.HEAD} / ${b.s3.ops.LIST} / ${b.s3.ops.GET} / ${b.s3.ops.PUT}` : null, 'calls', 'MEASURED', `MinIO trace; stored_file rows ${b.s3?.storedFileRows}`, null);
  add('boot', `Worker ${l}: storage reconciles completed in the first ${b.windowSeconds} s`, w.storageReconcilesCompleted, 'runs', 'MEASURED', '"storage cleanup: checked=" log lines', null);
  add('boot', `Worker ${l}: SQL/min (runtime roles) / provisioner SQL/min in the first ${b.windowSeconds} s`, `${b.sql.runtimeStatementsPerMin} / ${b.sql.provisionerRoleStatementsPerMin}`, 'statements/min', 'MEASURED', 'pg_stat_statements reset at the start of the window', null);
  add('boot', `Worker ${l}: processes (launcher/jobs/provisioner), ready lines, BullMQ repeat keys after`, `${w.processes?.launcher}/${w.processes?.jobs}/${w.processes?.provisioner}, ${w.readyLines}, ${(b.redisRepeatKeys.after || []).filter((x) => x && !x.startsWith('dbsize')).length}`, 'count', 'MEASURED', '/proc in the container; worker log; redis --scan *repeat*', null);
}
const rep = R('replicas/summary.json');
if (rep) {
  phaseA.replicas = rep;
  const pc = rep.perContainer;
  add('replicas', `Two replicas booting together: storage reconciles completed per replica (${rep.windowSeconds} s)`, Object.entries(pc).map(([c, p]) => `${c}=${p.storageReconcilesCompleted}`).join(', '), 'runs', 'MEASURED', '"storage cleanup: checked=" log lines per container', null);
  add('replicas', 'Two replicas booting together: S3 HEAD/LIST per replica', rep.s3 ? Object.entries(rep.s3.byClient).map(([c, o]) => `${c}: HEAD ${o.HEAD || 0} LIST ${o.LIST || 0} GET ${o.GET || 0} PUT ${o.PUT || 0}`).join('; ') : null, 'calls', 'MEASURED', `MinIO trace by client container; total ${rep.s3?.totalS3Calls}`, null);
  add('replicas', 'Two replicas booting together: SQL/min (runtime roles) / provisioner SQL/min', `${rep.sql.runtimeStatementsPerMin} / ${rep.sql.provisionerRoleStatementsPerMin}`, 'statements/min', 'MEASURED', 'pg_stat_statements over the window, both replicas', null);
  add('replicas', 'Two replicas booting together: ready / healthy (probe) per replica', Object.entries(pc).map(([c, p]) => `${c} ${p.readyMs}/${p.health?.probeHealthyMs}`).join('; '), 'ms after start', 'MEASURED', 'as for boot', null);
}

// ---- assemble -------------------------------------------------------------------------------------------------------
const seedLine = (T('seed-1-5.log') || T('seed.log') || '').split(/\r?\n/).find((l) => l.startsWith('{"logicalNow"'));
const out = {
  generatedAt: new Date().toISOString(),
  labels: { MEASURED: 'read directly from this run', DERIVED: 'computed from measured values or code paths', ASSUMED: 'chosen input', QUOTED: 'external source' },
  versions: (T('versions.txt') || '').trim().split(/\r?\n/).filter(Boolean),
  seed: { clock: seedLine ? JSON.parse(seedLine) : null, label: 'ASSUMED', shape: '20 organisations x 50 users (1 CEO, 2 managers, 3 venue managers, 44 staff); 3-5 venues; 31 days x 10 shifts; 8 notifications/user; 100 avatars + 20 venue photos via the API', rowCounts: (T('rowcounts-after-seed.txt') || '').trim().split(/\r?\n/) },
  // Shared-host mode: the dev stack is never stopped or touched. What was running, and whether it changed, is recorded
  // so that a baseline and an after run can be checked for comparable conditions (README "Comparability").
  hostState: {
    mode: 'shared-host (dev stack running and untouched)',
    devContainersAtStart: (T('guard/dev-containers-start.tsv') || '').trim().split(/\r?\n/).filter(Boolean).map((l) => { const [name, status, startedAt, restarts, health] = l.split('\t'); return { name, status, startedAt, restarts: Number(restarts), health }; }),
    devContainerChanges: (T('dev-containers-changes.log') || '').trim().split(/\r?\n/).filter(Boolean),
    snapshots: (T('host-state.txt') || '').trim().split(/\r?\n/).filter(Boolean),
    mainCheckoutDrift: T('MAIN-CHECKOUT-DRIFT.txt') ? 'DETECTED - run aborted' : 'none through the last checkpoint',
  },
  metrics,
  idle, idleFit: fit,
  endpoints: ep, load, pdf, emailsBullmq: em,
  storage: { cli: R('storage-cli.json'), boot: R('storage-boot.json'), shiftcycle: R('storage-shiftcycle.json'), bootWorkerLine: (T('storage-boot.worker-line.txt') || '').trim(), cliWallMs: Number((T('storage-cli.wall-ms') || '').trim()) || null },
  shiftCycle: sc,
  phaseA,
  oldAudit: { source: 'docs/audits/COST_COMPARISON_100K_CLAUDE.md §2-§3 (commit 5fa7b323, 2026-10-26)', label: 'QUOTED', values: OLD },
};
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(out, null, 2));
const esc = (x) => String(x ?? '').replace(/\|/g, '\\|');
const md = ['| Group | Metric | Value | Unit | Label | Method | Old audit (5fa7b323) |', '|---|---|---|---|---|---|---|', ...metrics.map((m) => `| ${m.group} | ${esc(m.metric)} | ${esc(m.value)} | ${esc(m.unit)} | ${m.label} | ${esc(m.method)} | ${esc(m.oldAudit)} |`)].join('\n');
fs.writeFileSync(path.join(OUT, 'results-table.md'), md + '\n');
console.log(`metrics: ${metrics.length}; idle fit: ${JSON.stringify(fit.sqlPerMin)}`);
