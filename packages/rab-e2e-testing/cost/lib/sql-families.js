// Statement families of an idle pg_stat_statements window: which Worker scan (or framing, or the API's health ping) each
// statement belongs to, so "Worker-scan SQL" can be counted per scan instead of as one total (Phase X P0-H, ST-08 / J3).
// Owner-login architecture: the API and the Worker log in as the SAME role (crewflow_owner), so pg_stat_statements cannot
// split them by role; at idle the only API statements are its health-check ping (TypeORM pingCheck: `SELECT 1`), which
// has its own family. Statements inside SECURITY DEFINER functions run as the definer (rab_secure_owner) with
// toplevel=false; they are reported as nested, never added to the top-level totals.
//
// Classification is by query text, first match wins, from the scan SQL the Worker sends (rab-worker/src/queues/**). A
// statement no rule matches is `other` and is listed, so a new scan shows up instead of being silently folded in.
//
//   node lib/sql-families.js <pgss.tsv> <window seconds> [role, default crewflow_owner]
//     <pgss.tsv>: role<TAB>toplevel(t|f)<TAB>calls<TAB>rows<TAB>total_exec_ms<TAB>query (run-system.sh `idle`, dcf idle.sh)
'use strict';
const fs = require('fs');

const FAMILIES = [
  // Transaction and tenant-context framing (TenantContextService, the pool-checkout RESET ROLE, READ ONLY transactions).
  ['framing', /^(begin|start transaction|commit|rollback|end|savepoint|release savepoint|reset role|set transaction|set local|set session)\b/i],
  ['framing', /^select (pg_catalog\.)?set_config\(/i],
  ['framing', /^select pg_catalog\.current_setting\(/i],
  // The API's health check (Docker probes /healthz every few seconds: TypeORM pingCheck).
  ['api-health-ping', /^select 1$/i],
  ['advisory-lock', /pg_(try_)?advisory_(xact_)?(un)?lock/i],
  ['workspace-discovery', /worker_list_workspaces|worker_list_organisations|from core\.manager_workspace mw where \(p_after|from core\.organisation o where \(p_after/i],
  ['provisioner', /worker_list_pending_workspace_schemas|pg_catalog\.pg_proc|current_user::text as who|from core\.migrations|mw\.schema_status/i],
  ['statement-dispatch', /\bpayroll_record\b/i],
  ['email-outbox', /\bemail_outbox\b/i],
  ['push-delivery', /\bpush_delivery\b|\bpush_token\b/i],
  ['realtime-outbox', /\brealtime_event\b/i],
  ['timer-triggers', /worker_due_work|worker_claim_due_work/i],
  // Offer expiry, manager confirmation, replacement requests and the assignment-level shift-monitor queries.
  ['offer-and-assignment-scans', /\bjob_offer\b|\breplacement_request\b|\bshift_assignment\b/i],
  ['attendance-scans', /\battendance\b/i],
  ['shift-monitor', /\bshift_report\b|\bfrom shift\b/i],
  ['storage', /\bstored_file\b|\bfile_object\b|\bfile\b.*\bstorage_key\b/i],
];

function family(query) {
  const q = String(query || '').trim();
  for (const [name, re] of FAMILIES) if (re.test(q)) return name;
  return 'other';
}

/** rows: [{ role, toplevel, calls, ms, query }] -> per-family calls (and per minute) for `role`, plus nested definer rows. */
function summarize(rows, seconds, role = 'crewflow_owner') {
  const mins = seconds / 60;
  const per = (n) => +(n / mins).toFixed(1);
  const mine = rows.filter((r) => r.role === role);
  const top = mine.filter((r) => r.toplevel);
  const nested = rows.filter((r) => !r.toplevel && r.role !== role && !/^(rab|postgres)$/.test(r.role));
  const byFamily = {};
  for (const r of top) {
    const f = family(r.query);
    (byFamily[f] ||= { calls: 0, ms: 0 });
    byFamily[f].calls += r.calls;
    byFamily[f].ms += r.ms;
  }
  const total = top.reduce((s, r) => s + r.calls, 0);
  const ping = byFamily['api-health-ping']?.calls || 0;
  return {
    role,
    windowSeconds: +seconds.toFixed(1),
    topLevelCalls: total,
    topLevelPerMin: per(total),
    allRowsOfRolePerMin: per(mine.reduce((s, r) => s + r.calls, 0)),
    nestedDefinerPerMin: per(nested.reduce((s, r) => s + r.calls, 0)),
    // Everything this role sent except the API's own health ping. An UPPER bound for the Worker: the ping's pool checkout
    // also runs one RESET ROLE, which is counted under framing and cannot be told apart from the Worker's by text.
    workerScanUpperBoundPerMin: per(total - ping),
    apiHealthPingPerMin: per(ping),
    families: Object.fromEntries(
      Object.entries(byFamily)
        .sort((a, b) => b[1].calls - a[1].calls)
        .map(([k, v]) => [k, { calls: v.calls, perMin: per(v.calls), share: total ? +(v.calls / total).toFixed(3) : 0, execMs: +v.ms.toFixed(1) }]),
    ),
    unclassified: top.filter((r) => family(r.query) === 'other').slice(0, 10).map((r) => ({ calls: r.calls, query: r.query.slice(0, 160) })),
  };
}

function readTsv(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => {
      const [role, tl, calls, rows, ms, ...q] = l.split('\t');
      return { role, toplevel: tl === 't', calls: Number(calls), rows: Number(rows), ms: Number(ms), query: q.join('\t') };
    });
}

module.exports = { family, summarize, readTsv, FAMILIES };

if (require.main === module) {
  const [file, secs, role] = process.argv.slice(2);
  if (!file || !(Number(secs) > 0)) {
    console.error('usage: node sql-families.js <pgss.tsv> <window seconds> [role]');
    process.exit(64);
  }
  console.log(JSON.stringify(summarize(readTsv(file), Number(secs), role || 'crewflow_owner'), null, 1));
}
