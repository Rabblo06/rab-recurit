// node lib/dq6-report.js  ->  $COST_OUT/dq6-results.md + dq6-results.json
// Collects every D-Q6 window of one results directory (scripts/dq6-bench.sh): idle-<arm>-r<rep>-{idle-off,idle-on,loaded}/
// summary.json (measure.sh idle + analyze-idle.js) and dq6-<arm>-r<rep>-{loaded,burst,rworker,rredis}.json (dq6-load.js).
// Every number is MEASURED in that directory; "mean" and "spread" are DERIVED across repetitions
// (spread = (max - min) / mean, the run-to-run noise of that metric on this shared host).
const fs = require('fs');
const path = require('path');
const { OUT } = require('./lib');

const read = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null);
const ARM_ORDER = ['per_scope', 'global', 'per_scope_combined', 'global_combined'];
const runs = new Map(); // `${arm}|${rep}` -> { arm, rep, windows: {}, scen: {} }
for (const d of fs.readdirSync(OUT)) {
  let m = /^idle-(.+)-r(\d+)-(idle-off|idle-on|loaded)$/.exec(d);
  if (m) {
    const s = read(path.join(OUT, d, 'summary.json'));
    if (!s) continue;
    const k = `${m[1]}|${m[2]}`;
    if (!runs.has(k)) runs.set(k, { arm: m[1], rep: Number(m[2]), windows: {}, scen: {} });
    runs.get(k).windows[m[3]] = s;
    continue;
  }
  m = /^dq6-(.+)-r(\d+)-(loaded|burst|rworker|rredis)\.json$/.exec(d);
  if (m) {
    const k = `${m[1]}|${m[2]}`;
    if (!runs.has(k)) runs.set(k, { arm: m[1], rep: Number(m[2]), windows: {}, scen: {} });
    runs.get(k).scen[m[3]] = read(path.join(OUT, d));
  }
}
const list = [...runs.values()].sort((a, b) => ARM_ORDER.indexOf(a.arm) - ARM_ORDER.indexOf(b.arm) || a.rep - b.rep);
const arms = [...new Set(list.map((r) => r.arm))];

const r1 = (x, d = 1) => (x == null || Number.isNaN(x) ? null : +Number(x).toFixed(d));
const workerRssMiB = (s) => {
  const kb = (s.workerProcs || []).filter((l) => /node/.test(l)).map((l) => Number((/RSS_kB=(\d+)/.exec(l) || [])[1] || 0));
  return kb.length ? r1(kb.reduce((a, b) => a + b, 0) / 1024) : null;
};
function windowMetrics(s) {
  if (!s) return null;
  return {
    pgTxPerMin: s.pgTransactions ? s.pgTransactions.transactionsPerMin : null,
    sqlPerMin: s.sql.topLevelCallsPerMin,
    pgCpuPct: r1(s.cpuFromCgroupPctOfOneCore['costaudit-pg'], 2),
    workerCpuPct: r1(s.cpuFromCgroupPctOfOneCore['costaudit-worker'], 2),
    redisCpuPct: r1(s.cpuFromCgroupPctOfOneCore['costaudit-redis'], 2),
    redisCmdPerMin: r1(s.redis.commandsPerSec * 60, 0),
    redisMemMiB: r1(s.redis.usedMemory / 1048576, 2),
    workerRssMiB: workerRssMiB(s),
    workerCgroupMiB: s.cgroupMemoryAtEnd && s.cgroupMemoryAtEnd['costaudit-worker'] ? s.cgroupMemoryAtEnd['costaudit-worker'].memoryCurrentMiB : null,
    hostOtherCpuPct: s.hostContention ? s.hostContention.totalCpuPctAvg : null,
  };
}
function depthMax(label) {
  const f = path.join(OUT, `dq6-${label}.gen.jsonl`);
  if (!fs.existsSync(f)) return null;
  let rows = 0;
  let bull = 0;
  let wAll = null;
  let wBusy = null;
  for (const l of fs.readFileSync(f, 'utf8').split('\n').filter((x) => x.trim())) {
    const e = JSON.parse(l);
    if (e.kind !== 'depth') continue;
    rows = Math.max(rows, (e.email || 0) + (e.push || 0) + (e.realtime || 0));
    bull = Math.max(bull, (e.bullWait || 0) + (e.bullActive || 0));
    if (e.workerBackends != null) wAll = Math.max(wAll || 0, e.workerBackends);
    if (e.workerBackendsNonIdle != null) wBusy = Math.max(wBusy || 0, e.workerBackendsNonIdle);
  }
  return { outboxRowsNonTerminalMax: rows, bullmqWaitActiveMax: bull, workerBackendsMax: wAll, workerBackendsNonIdleMax: wBusy };
}
const stat = (vals) => {
  const v = vals.filter((x) => x != null && !Number.isNaN(x));
  if (!v.length) return { mean: null, spreadPct: null, n: 0 };
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  return { mean: r1(mean, 2), spreadPct: v.length > 1 && mean ? r1(((Math.max(...v) - Math.min(...v)) / Math.abs(mean)) * 100, 0) : null, n: v.length };
};
const fmt = (x) => (x == null ? '—' : typeof x === 'number' ? x.toLocaleString('en-GB', { maximumFractionDigits: 2 }) : String(x));
const ms = (x) => (x == null ? '—' : `${(x / 1000).toFixed(1)} s`);
// Duplicate cell: "<duplicates> (seen <coverage> %)" per detector. Coverage = rows the detector saw / rows that reached
// the state it can see (email: SENT rows have one LOGGER line each; realtime: completed events were published). Below
// COVERAGE_MIN the cell is marked LOW: the duplicate count is then not evidence of anything.
const COVERAGE_MIN = 95;
// Unrounded percentage: the LOW threshold is applied to it; only the displayed value is rounded (down, so 94.5 never shows 95).
const cov = (seen, eligible) => (seen == null ? null : eligible ? (seen / eligible) * 100 : null);
const dupCell = (s) => {
  const e = cov(s.email.rowsWithLoggerSendLine, s.email.status.SENT || 0);
  const r = cov(s.realtime.distinctEventsSeenOnPubSub, s.realtime.status.completed || 0);
  const one = (dup, c) => `${fmt(dup)} (seen ${c == null ? '—' : `${Math.floor(c * 10) / 10} %`}${c != null && c < COVERAGE_MIN ? ' LOW' : ''})`;
  return `${one(s.email.duplicateSends, e)} / ${one(s.realtime.duplicatePublishes, r)}`;
};
const lat = (l) => (l && l.n ? `${l.p50} / ${l.p95} / ${l.p99} / ${l.max}` : '—');

const json = { generatedAt: new Date().toISOString(), out: OUT, runs: [] };
const md = [];
md.push('# D-Q6 benchmark results (generated by lib/dq6-report.js)', '');
md.push(`Duplicate cells: "N (seen C %)"; C = rows the detector saw / rows it could see (email SENT, realtime completed); LOW below ${COVERAGE_MIN} %. Non-terminal rows are shown in their own column.`, '');
md.push(`Results directory: \`${OUT}\`. Every per-run value is MEASURED. "mean" and "spread" are DERIVED across repetitions; spread = (max − min) / mean.`, '');

const METRICS = [
  ['pgTxPerMin', 'PostgreSQL transactions/min'],
  ['sqlPerMin', 'SQL statements/min (runtime roles)'],
  ['pgCpuPct', 'PostgreSQL CPU % of a core'],
  ['redisCmdPerMin', 'Redis commands/min'],
  ['redisMemMiB', 'Redis used memory MiB'],
  ['workerCpuPct', 'Worker CPU % of a core'],
  ['workerRssMiB', 'Worker RSS MiB (node processes)'],
  ['workerCgroupMiB', 'Worker cgroup memory MiB'],
  ['hostOtherCpuPct', 'Host: other containers CPU % (contention)'],
];
// Memory contention (Docker VM, 4 GB, shared): scripts/dq6-bench.sh writes VM MemAvailable / SwapFree / pswpin / pswpout
// at both edges of every window and scenario (vm-memory.txt). A window is EXCLUDED, from its table and from every mean, if
// it swapped in more than MAX_SWAPIN_MIB, if either edge had less than MIN_AVAIL_MIB available, or if it has no complete
// record (fail closed: a window not shown to be unstarved is not reported). Swap counters are VM-wide, so swapping by any
// other container counts too; that is contention as well.
const MAX_SWAPIN_MIB = Number(process.env.DQ6_MAX_SWAPIN_MIB || 16);
// DQ6_SWAPIN_SCOPE=vm (default, the rule fixed before the first run): the VM-wide swap-in decides. =harness: a POST-HOC
// view, added after the first windows showed VM-wide swap-in of 57-186 MiB per window while the harness's own containers
// faulted in under 8 MiB: the same threshold applied to the harness containers' own swap-ins only (no attribution record
// = excluded). It writes dq6-results.harness-rule.{md,json} and is labelled as needing the owner's approval.
const SWAPIN_SCOPE = process.env.DQ6_SWAPIN_SCOPE || 'vm';
if (!['vm', 'harness'].includes(SWAPIN_SCOPE)) throw new Error('DQ6_SWAPIN_SCOPE must be vm or harness');
const MIN_AVAIL_MIB = Number(process.env.DQ6_MIN_AVAIL_MIB || 384);
const PAGE_MIB = 4 / 1024;
const vm = new Map(); // label -> { start, end }
const vmFile = path.join(OUT, 'vm-memory.txt');
if (fs.existsSync(vmFile)) {
  for (const l of fs.readFileSync(vmFile, 'utf8').split(/\r?\n/)) {
    const m = /^(\S+) (start|end) t=(\d+) availMiB=(\d+) swapFreeMiB=(\d+) pswpin=(\d+) pswpout=(\d+)(?: harnessRefaultPages=(\d+))?/.exec(l.trim());
    if (!m) continue;
    if (!vm.has(m[1])) vm.set(m[1], {});
    vm.get(m[1])[m[2]] = { t: Number(m[3]), availMiB: Number(m[4]), swapFreeMiB: Number(m[5]), pswpin: Number(m[6]), pswpout: Number(m[7]), harnessRefault: m[8] == null ? null : Number(m[8]) };
  }
}
const vmRows = [];
const excludedMem = [];
const memVerdict = (label) => {
  const v = vm.get(label);
  if (!v || !v.start || !v.end) return { why: 'no VM memory record at both edges' };
  const swapInMiB = (v.end.pswpin - v.start.pswpin) * PAGE_MIB;
  const swapOutMiB = (v.end.pswpout - v.start.pswpout) * PAGE_MIB;
  const minAvail = Math.min(v.start.availMiB, v.end.availMiB);
  // Attribution only: swap-ins by the harness's own containers (a recreated container restarts its counter: shown as n/a).
  const hr = v.start.harnessRefault != null && v.end.harnessRefault != null && v.end.harnessRefault >= v.start.harnessRefault ? +((v.end.harnessRefault - v.start.harnessRefault) * PAGE_MIB).toFixed(1) : null;
  const row = { label, availStartMiB: v.start.availMiB, availEndMiB: v.end.availMiB, swapFreeEndMiB: v.end.swapFreeMiB, swapInMiB: +swapInMiB.toFixed(1), swapOutMiB: +swapOutMiB.toFixed(1), harnessRefaultMiB: hr };
  const counted = SWAPIN_SCOPE === 'vm' ? swapInMiB : hr;
  if (counted == null) return { row, why: 'no harness swap-in attribution for this window (post-hoc rule)' };
  const why = counted > MAX_SWAPIN_MIB ? `${SWAPIN_SCOPE === 'vm' ? '' : 'harness containers '}swapped in ${counted.toFixed(1)} MiB (> ${MAX_SWAPIN_MIB})` : minAvail < MIN_AVAIL_MIB ? `MemAvailable ${minAvail} MiB at an edge (< ${MIN_AVAIL_MIB})` : null;
  return { row, why };
};
for (const r of list) {
  for (const w of ['idle-off', 'idle-on', 'loaded', 'burst', 'rworker', 'rredis']) {
    const has = w in r.windows || w in r.scen;
    if (!has) continue;
    const label = `${r.arm}-r${r.rep}-${w}`;
    const { row, why } = memVerdict(label);
    if (row) vmRows.push({ ...row, verdict: why ? 'EXCLUDED' : 'ok' });
    if (why) {
      excludedMem.push(`${label}: ${why}`);
      (r.memExcluded = r.memExcluded || {})[w] = why;
      delete r.windows[w];
      delete r.scen[w];
    }
  }
}
if (SWAPIN_SCOPE === 'harness') md.push('**POST-HOC MEMORY RULE (NEEDS OWNER APPROVAL).** Swap-in is counted for the harness containers only (costaudit-pg/worker/redis/api/minio, cgroup workingset_refault_anon), not VM-wide. The rule fixed before the run (VM-wide) is in dq6-results.md; use these tables only if the owner accepts this rule.', '');
if (excludedMem.length) md.push(`**Windows EXCLUDED for memory contention** (${SWAPIN_SCOPE === 'vm' ? 'Docker VM' : 'harness containers'}; swap-in > ${MAX_SWAPIN_MIB} MiB, MemAvailable < ${MIN_AVAIL_MIB} MiB at an edge, or no record):`, '', ...excludedMem.map((x) => `- ${x}`), '');
md.push('## Docker VM memory per window (MEASURED, VM-wide)', '');
md.push('| Window | MemAvailable start / end MiB | SwapFree at end MiB | Swapped in / out MiB (VM) | of which faulted in by harness containers MiB | Verdict |');
md.push('|---|---|---|---|---|---|');
for (const v of vmRows) md.push(`| ${v.label} | ${v.availStartMiB} / ${v.availEndMiB} | ${v.swapFreeEndMiB} | ${v.swapInMiB} / ${v.swapOutMiB} | ${v.harnessRefaultMiB == null ? 'n/a' : v.harnessRefaultMiB} | ${v.verdict} |`);
md.push('');

// A loaded resource window is valid only if the generator's own recorded [start, end] covers the window's [t-start, t-end]
// (dq6-<label>.gen-window.json, written by dq6-load.js on success and on failure). Missing record or gap -> INVALID, excluded.
const MAX_INSERT_GAP_MS = 3000; // one tick is 1 s
const MIN_OFFERED_SHARE = 0.9;
const invalidLoaded = [];
for (const r of list) {
  if (!r.windows.loaded) continue;
  const label = `${r.arm}-r${r.rep}-loaded`;
  const gw = read(path.join(OUT, `dq6-${label}.gen-window.json`));
  const rdT = (f) => { const p = path.join(OUT, `idle-${label}`, f); return fs.existsSync(p) ? Number(fs.readFileSync(p, 'utf8').trim()) * 1000 : null; };
  const ts = rdT('t-start');
  const te = rdT('t-end');
  const why = !gw ? 'no generator window record' : ts == null || te == null ? 'no window timestamps' : gw.start > ts ? `generator started ${((gw.start - ts) / 1000).toFixed(1)} s after the window` : gw.end < te ? `generator stopped ${((te - gw.end) / 1000).toFixed(1)} s before the window ended${gw.error ? ` (${gw.error.slice(0, 80)})` : ''}` : null;
  let why2 = why;
  if (!why2) {
    const genF = path.join(OUT, `dq6-${label}.gen.jsonl`);
    const ins = fs.existsSync(genF) ? fs.readFileSync(genF, 'utf8').split('\n').filter((x) => x.trim()).map((x) => JSON.parse(x)).filter((e) => e.kind === 'insert' && e.t >= ts && e.t <= te) : [];
    const rate = r.scen.loaded && r.scen.loaded.offered ? r.scen.loaded.offered.notificationsPerSecond : null;
    const pts = [ts, ...ins.map((e) => e.t), te];
    let gap = 0;
    for (let i = 1; i < pts.length; i++) gap = Math.max(gap, pts[i] - pts[i - 1]);
    const delivered = ins.reduce((a, e) => a + (e.n || 0), 0);
    const expected = rate ? (rate * (te - ts)) / 1000 : null;
    if (!ins.length) why2 = 'no generator inserts inside the window';
    else if (gap > MAX_INSERT_GAP_MS) why2 = `load stalled inside the window (largest gap between inserts ${(gap / 1000).toFixed(1)} s > ${MAX_INSERT_GAP_MS / 1000} s)`;
    else if (expected == null) why2 = 'no offered rate recorded (dq6-<label>.json missing)';
    else if (delivered < MIN_OFFERED_SHARE * expected) why2 = `insufficient load inside the window (${delivered} of ${Math.round(expected)} notifications, < ${MIN_OFFERED_SHARE * 100} %)`;
    else r.loadedCoverage = { insertsInWindow: ins.length, notificationsInWindow: delivered, expected: Math.round(expected), largestGapMs: gap };
  }
  if (why2) { invalidLoaded.push(`${r.arm} r${r.rep}: ${why2}`); r.loadedInvalid = why2; delete r.windows.loaded; }
}
if (invalidLoaded.length) md.push('**Loaded windows excluded as INVALID** (the load did not cover the whole resource window):', '', ...invalidLoaded.map((x) => `- ${x}`), '');
for (const w of ['idle-off', 'idle-on', 'loaded']) {
  md.push(`## ${w === 'idle-off' ? 'Idle, realtime + push OFF (production default)' : w === 'idle-on' ? 'Idle, realtime + push ON' : 'Loaded (steady notifications, realtime + push ON)'}`, '');
  md.push(`| Metric | ${list.map((r) => `${r.arm} r${r.rep}`).join(' | ')} | ${arms.map((a) => `${a} mean (spread)`).join(' | ')} |`);
  md.push(`|---|${list.map(() => '---').join('|')}|${arms.map(() => '---').join('|')}|`);
  for (const [k, name] of METRICS) {
    const per = list.map((r) => { const m = windowMetrics(r.windows[w]); return m ? m[k] : null; });
    const agg = arms.map((a) => stat(list.filter((r) => r.arm === a).map((r) => { const m = windowMetrics(r.windows[w]); return m ? m[k] : null; })));
    md.push(`| ${name} | ${per.map(fmt).join(' | ')} | ${agg.map((s) => `${fmt(s.mean)}${s.spreadPct == null ? '' : ` (${s.spreadPct} %)`}`).join(' | ')} |`);
  }
  md.push('');
}

md.push('## Loaded: delivery (steady load)', '');
md.push('| Run | Offered | Email latency ms p50/p95/p99/max | Push | Realtime | Max non-terminal rows | Max BullMQ wait+active | Max Worker DB backends all / non-idle (pool proxy) | Drain after load stop (email/push/rt) | Duplicates email / realtime (detector coverage) | Non-terminal at end | Failed rows | Worker error lines | Jain (email, per-org mean latency) | Per-org p95 email min/median/max |');
md.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const r of list) {
  const s = r.scen.loaded;
  if (!s) continue;
  const d = depthMax(`${r.arm}-r${r.rep}-loaded`) || {};
  const failed = ['email', 'push', 'realtime'].map((k) => (s[k].status.FAILED || 0) + (s[k].status.failed || 0) + (s[k].status.CANCELLED || 0) + (s[k].status.cancelled || 0)).join('/');
  md.push(`| ${r.arm} r${r.rep} | ${s.offered.notificationsPerSecond}/s × ${s.offered.seconds} s = ${s.offered.notifications} | ${lat(s.email.latencyMs)} | ${lat(s.push.latencyMs)} | ${lat(s.realtime.latencyMs)} | ${fmt(d.outboxRowsNonTerminalMax)} | ${fmt(d.bullmqWaitActiveMax)} | ${fmt(d.workerBackendsMax)} / ${fmt(d.workerBackendsNonIdleMax)} | ${['email', 'push', 'realtime'].map((k) => ms(s.drainAfterLoadStopMs && s.drainAfterLoadStopMs[k])).join(' / ')} | ${dupCell(s)} | ${s.email.nonTerminal}/${s.push.nonTerminal}/${s.realtime.nonTerminal} | ${failed} | ${s.workerLogErrorLines} | ${s.email.fairness ? s.email.fairness.jainIndexOfMeanLatency : '—'} | ${s.email.fairness ? `${s.email.fairness.perOrgP95Ms.min} / ${s.email.fairness.perOrgP95Ms.median} / ${s.email.fairness.perOrgP95Ms.max}` : '—'} |`);
}
md.push('');

md.push('## Burst (all notifications inserted at once; throughput and fairness)', '');
md.push('| Run | Notifications × organisations | Email drained after insert | Email rows/s | Max Worker DB backends all / non-idle | Push drained | Realtime drained | Per-org email completion min/median/max | Jain (email) | Duplicates email / realtime (detector coverage) | Non-terminal | Worker error lines | CPU-s pg / worker / redis | PG transactions (incl. harness) |');
md.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const r of list) {
  const s = r.scen.burst;
  const bd = depthMax(`${r.arm}-r${r.rep}-burst`) || {};
  if (!s) continue;
  const t = s.throughput || {};
  const pc = t.email && t.email.perOrgCompletionMs;
  const cpu = s.resources ? s.resources.cpuSeconds : {};
  md.push(`| ${r.arm} r${r.rep} | ${s.offered.notifications} × ${s.offered.organisations} | ${ms(t.email && t.email.drainedMsAfterInsert)} | ${fmt(t.email && t.email.rowsPerSecond)} | ${fmt(bd.workerBackendsMax)} / ${fmt(bd.workerBackendsNonIdleMax)} | ${ms(t.push && t.push.drainedMsAfterInsert)} | ${ms(t.realtime && t.realtime.drainedMsAfterInsert)} | ${pc ? `${ms(pc.min)} / ${ms(pc.median)} / ${ms(pc.max)}` : '—'} | ${s.email.fairness ? s.email.fairness.jainIndexOfMeanLatency : '—'} | ${dupCell(s)} | ${s.email.nonTerminal}/${s.push.nonTerminal}/${s.realtime.nonTerminal} | ${s.workerLogErrorLines} | ${fmt(cpu['costaudit-pg'])} / ${fmt(cpu['costaudit-worker'])} / ${fmt(cpu['costaudit-redis'])} | ${fmt(s.resources && s.resources.pgTransactionsInclHarness)} |`);
}
md.push('');

md.push('## Recovery (load running; service stopped 30 s, then started)', '');
md.push('| Run | Stopped | Stop took | Back ready after start | Rows created during outage (email) | First delivery after start (email / push / rt) | Backlog cleared after start (email / push / rt) | Stuck at cap (e/p/rt) | Max latency email | Duplicates email / realtime (detector coverage) | Worker after | Worker error lines |');
md.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const r of list) {
  for (const k of ['rworker', 'rredis']) {
    const s = r.scen[k];
    if (!s || !s.recovery) continue;
    const v = s.recovery;
    md.push(`| ${r.arm} r${r.rep} | ${v.what} | ${ms(v.stopMs)} | ${ms(v.readyMsAfterStart)} | ${v.email.rowsCreatedDuringOutage} | ${['email', 'push', 'realtime'].map((q) => ms(v[q].firstTerminalAfterStartMs)).join(' / ')} | ${['email', 'push', 'realtime'].map((q) => (v[q].backlogClearedMsAfterStart == null ? 'NOT by cap' : ms(v[q].backlogClearedMsAfterStart))).join(' / ')} | ${v.email.stuckAtCap}/${v.push.stuckAtCap}/${v.realtime.stuckAtCap} | ${ms(v.email.maxLatencyMs)} | ${dupCell(s)} | ${v.workerState} | ${s.workerLogErrorLines} |`);
  }
}
md.push('');
const errs = new Set();
for (const r of list) for (const s of Object.values(r.scen)) for (const e of (s && s.workerLogErrorSamples) || []) errs.add(e);
if (errs.size) {
  md.push('## Worker log error samples (deduplicated, ids and URLs redacted)', '');
  for (const e of [...errs].slice(0, 30)) md.push(`- \`${e.replace(/`/g, "'")}\``);
  md.push('');
}
json.vmMemory = vmRows;
json.excludedForMemory = excludedMem;
for (const r of list) json.runs.push({ arm: r.arm, rep: r.rep, memExcluded: r.memExcluded || null, loadedInvalid: r.loadedInvalid || null, windows: Object.fromEntries(Object.entries(r.windows).map(([k, s]) => [k, windowMetrics(s)])), scenarios: r.scen });
json.memoryRule = { swapInScope: SWAPIN_SCOPE, maxSwapInMiB: MAX_SWAPIN_MIB, minAvailMiB: MIN_AVAIL_MIB, postHoc: SWAPIN_SCOPE !== 'vm' };
const base = SWAPIN_SCOPE === 'vm' ? 'dq6-results' : 'dq6-results.harness-rule';
fs.writeFileSync(path.join(OUT, `${base}.md`), md.join('\n'));
fs.writeFileSync(path.join(OUT, `${base}.json`), JSON.stringify(json, null, 2));
console.log(md.join('\n'));
