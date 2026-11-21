// M9 hardening (Lane F) — compares a load-mix.mjs result with the latency / error targets, per endpoint group.
//
//   node packages/rab-e2e-testing/system/perf/check-thresholds.mjs <load.json> [--phase peakAndSpike|<phase name>]
//     [--p95 500] [--p99 1000] [--clock-p99 800] [--error-rate 0.1]
//
// Error rate = (5xx + network errors + timeouts) / requests, in percent. A 409 is a business refusal and is reported, not
// counted as an error; any other 4xx is reported too (a load path that is refused is a broken script, so the smoke
// treats more than 1 % of other 4xx in a group as a failure as well). Exit 1 when any group misses a target.
import { readFileSync } from 'node:fs';

const [file, ...rest] = process.argv.slice(2);
const opt = Object.fromEntries(rest.reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
const phase = opt.phase ?? 'peakAndSpike';
const P95 = Number(opt.p95 ?? 500);
const P99 = Number(opt.p99 ?? 1000);
const CLOCK_P99 = Number(opt['clock-p99'] ?? Math.min(800, P99));
const ERR = Number(opt['error-rate'] ?? 0.1);
const r = JSON.parse(readFileSync(file, 'utf8'));
const stats = phase === 'peakAndSpike' ? r.peakAndSpike : r.perPhase?.[phase];
if (!stats) throw new Error(`no results for phase ${phase}`);
let failed = 0;
console.log(`group           n      p50    p95    p99    max   err%  409  4xx  verdict  (targets p95<${P95} p99<${P99} clock p99<${CLOCK_P99} err<${ERR}%)`);
for (const [group, s] of Object.entries(stats).filter(([k]) => !k.includes('|'))) {
  const p99Target = group === 'clock' ? CLOCK_P99 : P99;
  const misses = [];
  if (s.p95 > P95) misses.push('p95');
  if (s.p99 > p99Target) misses.push('p99');
  if (s.errorRatePct > ERR) misses.push('errors');
  if (s.other4xx / s.n > 0.01) misses.push('4xx');
  if (misses.length) failed++;
  const f = (v) => String(v ?? '-').padStart(6);
  console.log(`${group.padEnd(14)}${f(s.n)} ${f(s.p50)} ${f(s.p95)} ${f(s.p99)} ${f(s.max)} ${f(s.errorRatePct)} ${String(s.conflicts409).padStart(4)} ${String(s.other4xx).padStart(4)}  ${misses.length ? `MISS ${misses.join(',')}` : 'ok'}`);
}
process.exit(failed ? 1 : 0);
