/**
 * D-Q6 realistic journeys: runs k6/main.js in the pinned grafana/k6 image on crewflow-cost-net and samples the queues
 * while it runs. Disposable crewflow-cost stack ONLY (lib.psql refuses any database without the disposable marker; the
 * k6 script refuses any host but costaudit-api:3000; the generator container joins only crewflow-cost-net).
 *
 *   node lib/k6-run.js <label> [--orgs 8] [--warm 60] [--win 240] [--tail 20] [--spread 30]
 *
 * Writes into $COST_OUT (all MEASURED):
 *   dq6-<label>.k6-ready         t0 (epoch ms, k6 clock) once every account is logged in and the VUs start
 *   dq6-<label>.k6.json          the k6 result (per journey / endpoint / persona latency, throughput, errors), plus timing
 *   dq6-<label>.k6.log           k6's own log lines (no secrets: the script never prints the password or a token)
 *   dq6-<label>.gen.jsonl        queue depth every 10 s (+ this sampler's own psql transactions, which analyze-idle.js
 *                                subtracts from the window's PostgreSQL transactions)
 *   dq6-<label>.gen-window.json  [start, end] of the generator's steady state, for the report's coverage check
 * The generator container is named k6p-<label> and removed by exact name (docker run --rm; on a failure, rm -f by name).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const { OUT, psql, redis, secrets, dockerEnv, HARNESS_LABEL_ARGS } = require('./lib');

// The official image, pinned by digest (k6 v2.3.0, pulled 2026-11-06). k6/Dockerfile FROMs the same digest.
const K6_BASE = 'grafana/k6@sha256:3e4186aea62e11a45560bfc51e19eeafe82fc07ce069c78aff44b7ff893d9a5e';
const K6_DIR = path.join(__dirname, '..', 'k6');

const [label, ...rest] = process.argv.slice(2);
if (!/^[a-z0-9_-]{1,60}$/.test(label || '')) throw new Error('usage: k6-run.js <label [a-z0-9_-]> [--orgs N] [--warm S] [--win S] [--tail S] [--spread S]');
const opt = (n, d) => { const i = rest.indexOf(`--${n}`); const v = i >= 0 ? Number(rest[i + 1]) : d; if (!Number.isInteger(v) || v < 0) throw new Error(`--${n} must be a whole number`); return v; };
const ORGS = opt('orgs', 8), WARM = opt('warm', 60), WIN = opt('win', 240), TAIL = opt('tail', 20), SPREAD = opt('spread', 30);
const f = (x) => path.join(OUT, `dq6-${label}.${x}`);
for (const x of ['k6.json', 'k6-ready', 'gen.jsonl', 'k6.log']) if (fs.existsSync(f(x))) throw new Error(`label ${label} was already used (${path.basename(f(x))} exists); use a new repetition number`);
const logGen = (e) => fs.appendFileSync(f('gen.jsonl'), `${JSON.stringify({ t: Date.now(), ...e })}\n`);

// ---- image: FROM the pinned digest + this folder's scripts, tagged by content ---------------------------------------
function image() {
  const files = ['Dockerfile', 'lib.js', 'profile.js', 'journeys.js', 'main.js'];
  const h = crypto.createHash('sha256');
  for (const x of files) h.update(x).update(fs.readFileSync(path.join(K6_DIR, x)));
  const tag = `crewflow-cost/k6:${h.digest('hex').slice(0, 12)}`;
  try { execFileSync('docker', ['image', 'inspect', tag], { env: dockerEnv, stdio: 'ignore' }); } catch {
    execFileSync('docker', ['build', '-q', '--label', 'crewflow-cost.harness=true', '-t', tag, K6_DIR], { env: dockerEnv, stdio: ['ignore', 'ignore', 'inherit'] });
  }
  return tag;
}

// ---- queue depth (every queue, not only the scenario's rows: the journeys' own notifications are in there) -----------
const BULL = "local r={} for _,k in ipairs(redis.call('KEYS','*:wait')) do r[#r+1]=k r[#r+1]=redis.call('LLEN',k) end "
  + "for _,k in ipairs(redis.call('KEYS','*:active')) do r[#r+1]=k r[#r+1]=redis.call('LLEN',k) end "
  + "for _,k in ipairs(redis.call('KEYS','*:delayed')) do r[#r+1]=k r[#r+1]=redis.call('ZCARD',k) end return r";
function workerAddr() {
  try {
    const ip = execFileSync('docker', ['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', 'costaudit-worker'], { env: dockerEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) ? ip : null;
  } catch { return null; }
}
function sampleDepth() {
  const ip = workerAddr();
  const be = ip ? `(select count(*) from pg_stat_activity where datname='rab' and client_addr='${ip}'::inet), (select count(*) from pg_stat_activity where datname='rab' and client_addr='${ip}'::inet and state <> 'idle')` : 'null, null';
  const [email, push, realtime, dueWork, dueNow, wAll, wBusy] = psql(`select
      (select count(*) from core.email_outbox where status not in ('SENT','FAILED','CANCELLED')),
      (select count(*) from core.push_delivery where status not in ('ACCEPTED','FAILED','CANCELLED')),
      (select count(*) from core.realtime_event where status not in ('completed','failed','cancelled')),
      (select count(*) from core.worker_due_work),
      (select count(*) from core.worker_due_work where due_at <= now()),
      ${be}`).split('|').map((x) => (x === '' ? null : Number(x)));
  const bull = {};
  try {
    const out = redis('EVAL', BULL, '0').split('\n');
    for (let i = 0; i + 1 < out.length; i += 2) {
      const m = /^(?:.*:)?([^:]+):(wait|active|delayed)$/.exec(out[i]);
      if (!m) continue;
      bull[m[1]] = bull[m[1]] || { wait: 0, active: 0, delayed: 0 };
      bull[m[1]][m[2]] += Number(out[i + 1]);
    }
  } catch { /* Redis busy: the next sample tries again */ }
  logGen({ kind: 'depth', xact: 1, email, push, realtime, dueWork, dueNow, workerBackends: wAll, workerBackendsNonIdle: wBusy, bull });
}

(async () => {
  const tag = image();
  const digest = execFileSync('docker', ['image', 'inspect', '-f', '{{.Id}}', tag], { env: dockerEnv, encoding: 'utf8' }).trim();
  const name = `k6p-${label}`.slice(0, 63);
  const args = ['run', '--rm', '--name', name, ...HARNESS_LABEL_ARGS, '--network', 'crewflow-cost-net', '--cpus=1', '--memory=384m',
    '-e', 'SEED_PW', '-e', `K6P_ORGS=${ORGS}`, '-e', `K6P_WARM_S=${WARM}`, '-e', `K6P_WIN_S=${WIN}`, '-e', `K6P_TAIL_S=${TAIL}`, '-e', `K6P_SPREAD_S=${SPREAD}`,
    '-e', 'K6_NO_USAGE_REPORT=true', tag];
  // SEED_PW reaches the container through the environment (`-e NAME` without a value), never the command line.
  const child = spawn('docker', args, { env: { ...dockerEnv, SEED_PW: secrets.SEED_PW }, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = fs.createWriteStream(f('k6.log'));
  let t0 = null, result = null, sampler = null, buf = '';
  const startedAt = Date.now();
  const onLine = (line) => {
    const m = /K6P_SETUP_DONE t0=(\d+)/.exec(line);
    if (m && t0 === null) {
      t0 = Number(m[1]);
      fs.writeFileSync(f('k6-ready'), `${t0}\n`);
      sampleDepth();
      sampler = setInterval(() => { try { sampleDepth(); } catch (e) { logGen({ kind: 'sample-error', xact: 0, error: String(e.message).slice(0, 200) }); } }, 10_000);
    }
    if (line.startsWith('K6P_RESULT ')) { result = JSON.parse(line.slice(11)); return; }
    log.write(`${line}\n`);
  };
  for (const s of [child.stdout, child.stderr]) {
    s.setEncoding('utf8');
    s.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); } });
  }
  const code = await new Promise((resolve) => child.on('close', resolve));
  if (buf) onLine(buf);
  if (sampler) clearInterval(sampler);
  log.end();
  const endedAt = Date.now();
  try { execFileSync('docker', ['rm', '-f', name], { env: dockerEnv, stdio: 'ignore' }); } catch { /* --rm already removed it */ }
  // Steady state = all VUs running: [t0, end of the run minus the tail]. A run that died early ends at its exit.
  const genEnd = t0 === null ? null : Math.min(endedAt, t0 + (WARM + WIN + TAIL) * 1000);
  fs.writeFileSync(f('gen-window.json'), JSON.stringify({ start: t0, end: genEnd, exitCode: code, error: code === 0 ? null : `k6 exit ${code}` }));
  if (!result) throw new Error(`k6 produced no result (exit ${code}); see ${path.basename(f('k6.log'))}`);
  result.timing = { startedAt, t0, windowStart: t0 + WARM * 1000, windowEnd: t0 + (WARM + WIN) * 1000, endedAt, exitCode: code };
  result.image = { tag, id: digest, base: K6_BASE };
  fs.writeFileSync(f('k6.json'), JSON.stringify(result, null, 2));
  const o = result.overall;
  console.log(JSON.stringify({ label, exit: code, requests: o.n, rps: o.rps, p50: o.p50, p95: o.p95, p99: o.p99, errorRate: o.errorRate, halvesP95: [result.halves.a.p95, result.halves.b.p95] }));
  process.exit(code === 0 ? 0 : 1);
})().catch((e) => { console.error('[k6-run] FAILED', e.message); process.exit(1); });
