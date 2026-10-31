#!/usr/bin/env node
// Before/after comparison of two screen-traffic result directories -> COMPARISON.md + comparison.json in the after dir.
//   node compare.mjs <before dir> <after dir>
// Every value is read from the two runs' own files; Δ% = (after - before) / before. Labels: (M) measured in that run,
// (D) derived from measured values (per user, minus the no-load control, Δ%).
import fs from 'node:fs';
import path from 'node:path';

const [B, A] = process.argv.slice(2);
if (!B || !A) { console.error('usage: compare.mjs <before dir> <after dir>'); process.exit(2); }
const j = (d, f) => { const p = path.join(d, f); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null; };
const fmt = (v, d = 1) => (v == null || Number.isNaN(v) ? '–' : typeof v === 'number' ? (Math.abs(v) >= 100 ? Math.round(v).toLocaleString('en-GB') : v.toFixed(d)) : String(v));
const dpct = (b, a) => (b == null || a == null || b === 0 ? (b === 0 && a === 0 ? '0 %' : '–') : `${a - b >= 0 ? '+' : ''}${(((a - b) / b) * 100).toFixed(0)} %`);
const row = (label, b, a, d = 1, worse = 'up') => {
  const flag = b != null && a != null && ((worse === 'up' && a > b * 1.05 && a - b > 0.5) || (worse === 'down' && a < b * 0.95)) ? ' **worse**' : '';
  return `| ${label} | ${fmt(b, d)} | ${fmt(a, d)} | ${dpct(b, a)}${flag} |`;
};
const out = [];
const cmp = { before: B, after: A };
const meta = (d) => (fs.existsSync(path.join(d, 'screen-traffic-meta.txt')) ? fs.readFileSync(path.join(d, 'screen-traffic-meta.txt'), 'utf8').trim() : '');
out.push('# Phase C1 polling: before / after', '', `Before: \`${B}\`  `, `After: \`${A}\``, '', '```', 'BEFORE', meta(B), '', 'AFTER', meta(A), '```', '');

const idle = (d) => j(d, 'idle-st-idle-baseline/summary.json');
const ib = idle(B), ia = idle(A);
out.push('## No-load control (worker only, M)', '', '| Metric | Before | After | Δ |', '|---|---:|---:|---:|');
out.push(row('SQL statements/min (top-level)', ib?.sql.topLevelCallsPerMin, ia?.sql.topLevelCallsPerMin, 0));
out.push(row('Postgres CPU % of one core', ib?.cpuFromCgroupPctOfOneCore['costaudit-pg'], ia?.cpuFromCgroupPctOfOneCore['costaudit-pg']));
out.push(row('Worker CPU %', ib?.cpuFromCgroupPctOfOneCore['costaudit-worker'], ia?.cpuFromCgroupPctOfOneCore['costaudit-worker']));
out.push(row('Host contention (other containers, CPU % sum)', ib?.hostContention?.totalCpuPctAvg, ia?.hostContention?.totalCpuPctAvg), '');

for (const w of ['mix-visible', 'mix-hidden']) {
  const b = j(B, `analysis-${w}.json`), a = j(A, `analysis-${w}.json`);
  if (!b || !a) continue;
  cmp[w] = { before: b, after: a };
  out.push(`## ${w} (${b.window.minutes} / ${a.window.minutes} min, ${b.total.users} users, mix ${b.mix} / ${a.mix})`, '');
  out.push('Per screen (M; per user D):', '', '| Screen | basis | req/min B → A | Δ | req/min/user B → A | MB/h B → A | Δ | 429 B → A | API SQL/min B → A | Δ |', '|---|---|---|---:|---|---|---:|---|---|---:|');
  for (const s of Object.keys(b.perScreen)) {
    const x = b.perScreen[s], y = a.perScreen[s] ?? {};
    out.push(`| ${s} | ${x.basis} | ${fmt(x.requestsPerMin)} → ${fmt(y.requestsPerMin)} | ${dpct(x.requestsPerMin, y.requestsPerMin)} | ${fmt(x.requestsPerMinPerUser, 2)} → ${fmt(y.requestsPerMinPerUser, 2)} | ${fmt(x.downBytesPerHour / 1e6)} → ${fmt(y.downBytesPerHour / 1e6)} | ${dpct(x.downBytesPerHour, y.downBytesPerHour)} | ${x.status.r429} → ${y.status?.r429} | ${fmt(x.apiSql.statementsPerMin)} → ${fmt(y.apiSql?.statementsPerMin)} | ${dpct(x.apiSql.statementsPerMin, y.apiSql?.statementsPerMin)} |`);
  }
  const tb = b.total, ta = a.total;
  out.push(`| **total** | | ${fmt(tb.requestsPerMin)} → ${fmt(ta.requestsPerMin)} | ${dpct(tb.requestsPerMin, ta.requestsPerMin)} | ${fmt(tb.requestsPerMinPerUser, 2)} → ${fmt(ta.requestsPerMinPerUser, 2)} | ${fmt(tb.downBytesPerHour / 1e6)} → ${fmt(ta.downBytesPerHour / 1e6)} | ${dpct(tb.downBytesPerHour, ta.downBytesPerHour)} | ${tb.status.r429} → ${ta.status.r429} | ${fmt(tb.apiSql.statementsPerMin)} → ${fmt(ta.apiSql.statementsPerMin)} | ${dpct(tb.apiSql.statementsPerMin, ta.apiSql.statementsPerMin)} |`, '');
  const sb = b.server, sa = a.server;
  out.push('Server (M; "minus control" D):', '', '| Metric | Before | After | Δ |', '|---|---:|---:|---:|');
  out.push(row('DB statements/min, top-level (crewflow_app+crewflow)', sb.sqlStatementsPerMin.topLevelCallsPerMin, sa.sqlStatementsPerMin.topLevelCallsPerMin, 0));
  out.push(row('… minus the no-load control (D)', sb.sqlStatementsPerMin.topLevelCallsPerMin - (ib?.sql.topLevelCallsPerMin ?? 0), sa.sqlStatementsPerMin.topLevelCallsPerMin - (ia?.sql.topLevelCallsPerMin ?? 0), 0));
  out.push(row('DB statements/min nested in SECURITY DEFINER', sb.sqlStatementsPerMin.nestedInsideDefinerFunctionsPerMin, sa.sqlStatementsPerMin.nestedInsideDefinerFunctionsPerMin, 0));
  out.push(row('DB execution ms/min', sb.sqlStatementsPerMin.topLevelExecMsPerMin, sa.sqlStatementsPerMin.topLevelExecMsPerMin, 0));
  for (const c of ['pg', 'api', 'worker', 'redis']) out.push(row(`${c} CPU % of one core (cgroup)`, sb.cpuPctOfOneCore[`costaudit-${c}`], sa.cpuPctOfOneCore[`costaudit-${c}`]));
  for (const c of ['pg', 'api', 'worker']) out.push(row(`${c} memory MiB avg (docker stats)`, sb.memory?.[`costaudit-${c}`]?.memMiBAvg, sa.memory?.[`costaudit-${c}`]?.memMiBAvg), row(`${c} memory MiB max`, sb.memory?.[`costaudit-${c}`]?.memMiBMax, sa.memory?.[`costaudit-${c}`]?.memMiBMax));
  out.push(row('Host contention (other containers, CPU % sum)', sb.hostContention?.totalCpuPctAvg, sa.hostContention?.totalCpuPctAvg), '');
  out.push('Latency, 2xx only (M): client wall clock / API durationMs', '', '| Endpoint | n B / A | client p50/p95/p99 B | A | API p50/p95/p99 B | A |', '|---|---|---|---|---|---|');
  for (const k of Object.keys(b.latency)) {
    const x = b.latency[k], y = a.latency[k] ?? { n: 0, clientMs: {}, serverMs: {} };
    const t = (o) => `${fmt(o.p50)}/${fmt(o.p95)}/${fmt(o.p99)}`;
    out.push(`| ${k} | ${x.n} / ${y.n} | ${t(x.clientMs)} | ${t(y.clientMs)} | ${t(x.serverMs)} | ${t(y.serverMs)} |`);
  }
  const extra = Object.keys(a.latency).filter((k) => !b.latency[k]);
  for (const k of extra) out.push(`| ${k} (after only) | – / ${a.latency[k].n} | – | ${fmt(a.latency[k].clientMs.p50)}/${fmt(a.latency[k].clientMs.p95)}/${fmt(a.latency[k].clientMs.p99)} | – | ${fmt(a.latency[k].serverMs.p50)}/${fmt(a.latency[k].serverMs.p95)}/${fmt(a.latency[k].serverMs.p99)} |`);
  out.push('', 'IP groups (M):', '', '| IP group | req/min B → A | 429 B → A |', '|---|---|---|');
  for (const k of Object.keys(b.ipGroups)) out.push(`| ${k} | ${fmt(b.ipGroups[k].requestsPerMin)} → ${fmt(a.ipGroups[k]?.requestsPerMin ?? 0)} | ${b.ipGroups[k].r429} → ${a.ipGroups[k]?.r429 ?? 0} |`);
  out.push('');
}

const solos = fs.readdirSync(B).filter((f) => /^analysis-solo-.*\.json$/.test(f)).map((f) => f.slice(14, -5));
if (solos.length) {
  out.push('## Per-screen windows (only that screen\'s users, M; minus control D)', '', '| Screen | users | req/min/user B → A | API SQL/min B → A | DB stmts/min − control B → A | pg CPU % B → A | api CPU % B → A | api mem max MiB B → A |', '|---|---:|---|---|---|---|---|---|');
  for (const s of solos) {
    const b = j(B, `analysis-solo-${s}.json`), a = j(A, `analysis-solo-${s}.json`);
    if (!b || !a) continue;
    const x = b.perScreen[s], y = a.perScreen[s];
    const ctl = (r, i) => r.server.sqlStatementsPerMin.topLevelCallsPerMin - (i?.sql.topLevelCallsPerMin ?? 0);
    out.push(`| ${s} | ${x.users} | ${fmt(x.requestsPerMinPerUser, 2)} → ${fmt(y.requestsPerMinPerUser, 2)} | ${fmt(x.apiSql.statementsPerMin)} → ${fmt(y.apiSql.statementsPerMin)} | ${fmt(ctl(b, ib), 0)} → ${fmt(ctl(a, ia), 0)} | ${fmt(b.server.cpuPctOfOneCore['costaudit-pg'])} → ${fmt(a.server.cpuPctOfOneCore['costaudit-pg'])} | ${fmt(b.server.cpuPctOfOneCore['costaudit-api'])} → ${fmt(a.server.cpuPctOfOneCore['costaudit-api'])} | ${fmt(b.server.memory?.['costaudit-api']?.memMiBMax)} → ${fmt(a.server.memory?.['costaudit-api']?.memMiBMax)} |`);
  }
  out.push('');
}

const wb = j(B, 'web/web-summary.json'), wa = j(A, 'web/web-summary.json');
if (wb && wa) {
  cmp.web = { before: wb, after: wa };
  out.push('## Real web client (Playwright, M; hidden = emulated visibility)', '', '| Screen | phase | requests B → A | req/min B → A | down KB/h B → A | first request after phase start (ms) A |', '|---|---|---|---|---|---:|');
  for (const r of wb.results) {
    const ra = wa.results.find((x) => x.id === r.id);
    for (const ph of Object.keys(r.summary)) {
      const x = r.summary[ph], y = ra?.summary[ph] ?? {};
      out.push(`| ${r.id} | ${ph} | ${x.requests} → ${y.requests ?? '–'} | ${fmt(x.requestsPerMin, 2)} → ${fmt(y.requestsPerMin, 2)} | ${x.downBytesPerHour == null ? '–' : Math.round(x.downBytesPerHour / 1024)} → ${y.downBytesPerHour == null ? '–' : Math.round(y.downBytesPerHour / 1024)} | ${fmt(y.firstRequestAfterPhaseStartMs, 0)} |`);
    }
  }
  out.push('');
}
const fb = j(B, 'flutter/flutter-summary.json'), fa = j(A, 'flutter/flutter-summary.json');
if (fb && fa) {
  cmp.flutter = { before: fb, after: fa };
  out.push('## Real Flutter client (Android emulator, M from the API log; bytes from netstats for the app uid)', '', '| Screen | window | requests B → A | req/min B → A | SQL stmts B → A | app MB/h B → A |', '|---|---|---|---|---|---|');
  for (const r of fb.results) {
    const ra = fa.results.find((x) => x.kind === r.kind);
    for (const w of r.windows) {
      const y = ra?.windows.find((x) => x.name === w.name) ?? {};
      out.push(`| ${r.screen} | ${w.name} | ${w.requests} → ${y.requests ?? '–'} | ${fmt(w.requestsPerMin, 2)} → ${fmt(y.requestsPerMin, 2)} | ${w.sqlStatements} → ${y.sqlStatements ?? '–'} | ${fmt(w.uidBytesPerHour / 1e6)} → ${fmt(y.uidBytesPerHour / 1e6)} |`);
    }
  }
  out.push('');
}
const hc = (d) => (fs.existsSync(path.join(d, 'host-conditions.log')) ? fs.readFileSync(path.join(d, 'host-conditions.log'), 'utf8').split('\n').filter((l) => l.startsWith('hostFreeMB=')).map((l) => Number(l.slice(11))).filter(Boolean) : []);
const rb = hc(B), ra = hc(A);
out.push('## Host conditions', '', `Host free RAM per window (MB): before ${Math.min(...rb)}–${Math.max(...rb)}, after ${Math.min(...ra)}–${Math.max(...ra)}. Every server window held the heavy-run token (no other heavy run concurrent); light activity on the shared host is recorded per window as "host contention" above.`, '');
fs.writeFileSync(path.join(A, 'COMPARISON.md'), out.join('\n') + '\n');
fs.writeFileSync(path.join(A, 'comparison.json'), JSON.stringify(cmp, null, 2));
console.log(out.join('\n'));
