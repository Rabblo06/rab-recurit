#!/usr/bin/env node
// Exports the API's own per-request accounting (request_complete: requestId, route, status, durationMs, sqlCount =
// statements excluding BEGIN, transactionCount; engine/observability/request-context.ts) for requests since <iso>.
//   node lib/api-sql.mjs <since ISO> <out file>
// Same parser as ../../lib/lib.js requestLog(). Reads `docker logs costaudit-api` only (the harness container).
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const [since, outFile] = process.argv.slice(2);
const text = execFileSync('docker', ['logs', 'costaudit-api', '--since', since], { encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, MSYS_NO_PATHCONV: '1' } }).replace(/\x1b\[[0-9;]*m/g, '');
const out = {};
for (const block of text.split("event: 'request_complete'").slice(1)) {
  const g = (k) => { const m = new RegExp(`${k}: '?([^,'\\n]+)'?`).exec(block); return m ? m[1] : null; };
  const id = g('requestId');
  if (id) out[id] = { route: g('route'), status: Number(g('status')), durationMs: Number(g('durationMs')), sqlCount: Number(g('sqlCount')), transactionCount: Number(g('transactionCount')) };
}
fs.writeFileSync(outFile, JSON.stringify(out));
console.log(JSON.stringify({ requests: Object.keys(out).length }));
