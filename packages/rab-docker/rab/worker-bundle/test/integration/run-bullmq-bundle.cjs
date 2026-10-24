'use strict';
/**
 * Lane A — Linux-only BullMQ cases with the REAL Worker bundle image (launcher + jobs child + provisioner child, the
 * production security settings and health check): per-instance health in bullmq mode, SIGTERM drain with work in flight,
 * SIGKILL, provisioner stats identity. Runs against the disposable `crewflow-bullmq` project only (profile `bundle`),
 * after run-bullmq-cluster.cjs (or reset) left it migrated. The caller supplies the four BQ_* secrets of that database.
 *
 *   BQ_...=... node packages/rab-docker/rab/worker-bundle/test/integration/run-bullmq-bundle.cjs <evidence-dir>
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../../../../../..');
const req = (m) => require(require.resolve(m, { paths: [ROOT] }));
const Redis = req('ioredis');
const { Client } = req('pg');

const PROJECT = 'crewflow-bullmq';
const FILE = path.join(__dirname, 'docker-compose.bullmq-test.yml');
const OUT = path.resolve(process.argv[2] || '');
if (!process.argv[2]) {
  console.error('usage: run-bullmq-bundle.cjs <evidence-dir>');
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });
const KEYS = ['BQ_SUPERUSER_PASSWORD', 'BQ_CREWFLOW_PASSWORD', 'BQ_APP_PASSWORD', 'BQ_APP_SECRET'];
for (const k of KEYS) if (!process.env[k]) throw new Error(`${k} is required`);
const SECRETS = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const redact = (s) => Object.values(SECRETS).reduce((acc, v) => acc.split(v).join('<redacted>'), String(s ?? ''));
const ENV = { ...process.env, COMPOSE_PROJECT_NAME: PROJECT, MSYS_NO_PATHCONV: '1' };
const SU_URL = `postgres://rab:${SECRETS.BQ_SUPERUSER_PASSWORD}@127.0.0.1:15480/rab`;

let currentLog = path.join(OUT, 'B0-setup.log');
const write = (t) => fs.appendFileSync(currentLog, `${redact(t)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (c, m) => {
  if (!c) throw new Error(m);
};
async function waitFor(label, fn, timeoutMs, everyMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for: ${label}`);
    await sleep(everyMs);
  }
}
function docker(args, { quiet = false, timeout = 300_000 } = {}) {
  const res = spawnSync('docker', args, { env: ENV, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 });
  const out = redact(`${res.stdout ?? ''}${res.stderr ?? ''}`);
  if (!quiet) write(`$ docker ${redact(args.join(' ')).slice(0, 300)}\n${out.trimEnd().slice(-4000)}\n[exit ${res.status}]`);
  return { code: res.status, out };
}
const compose = (args, o) => docker(['compose', '-p', PROJECT, '-f', FILE, '--profile', 'bundle', ...args], o);
const cname = (s) => `${PROJECT}-${s}-1`;
const health = (s) => docker(['inspect', '-f', '{{if .State.Health}}{{.State.Health.Status}}{{end}}', cname(s)], { quiet: true }).out.trim();
const logs = (s) => docker(['logs', cname(s)], { quiet: true }).out;
async function sql(text, params = []) {
  const c = new Client({ connectionString: SU_URL });
  await c.connect();
  try {
    return (await c.query(text, params)).rows;
  } finally {
    await c.end();
  }
}
const redis = new Redis('redis://127.0.0.1:16480', { maxRetriesPerRequest: 1 });
redis.on('error', () => undefined);

let ORG;
let USER;
async function insertEmails(n, tag) {
  const rows = await sql(
    `INSERT INTO core.email_outbox(organisation_id, job_type, recipient_email, target_user_id, rendered_subject, rendered_text)
     SELECT $1, 'NOTIFICATION', 'bb-' || $2 || '-' || g || '@bq-test.invalid', $4, 'BB ' || $2, 'bundle test body' FROM generate_series(1, $3::int) g RETURNING id`,
    [ORG, tag, n, USER],
  );
  return rows.map((r) => r.id);
}
const allLogs = () => logs('bundle-a') + logs('bundle-b') + Object.values(retired).join('\n');
// Only for containers that are RECREATED (B6): `docker logs` of a stopped/restarted container keeps its earlier output,
// so snapshotting it as well would count every send twice.
const retired = {};
async function deliveredExactlyOnce(ids, timeoutMs = 240_000) {
  await waitFor(`${ids.length} SENT`, async () => (await sql(`SELECT count(*)::int n FROM core.email_outbox WHERE id = ANY($1::uuid[]) AND status='SENT'`, [ids]))[0].n === ids.length, timeoutMs);
  const all = allLogs();
  const bad = ids.filter((id) => all.split(`idempotencyKey: email-outbox:${id}`).length - 1 !== 1);
  write(`delivered ${ids.length}; not exactly once: ${bad.length}`);
  assert(bad.length === 0, `${bad.length} not sent exactly once`);
}

const results = [];
async function step(id, title, fn) {
  currentLog = path.join(OUT, `${id}-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60)}.log`);
  fs.writeFileSync(currentLog, `# ${id} ${title}\n# ${new Date().toISOString()}\n`);
  const t0 = Date.now();
  let status = 'PASS';
  let note = '';
  try {
    note = (await fn()) || '';
  } catch (e) {
    status = 'FAIL';
    note = redact(e.message);
  }
  write(`# RESULT: ${status} ${note} (${Math.round((Date.now() - t0) / 1000)}s)`);
  results.push({ id, title, status, note });
  console.log(`${status.padEnd(5)} ${id} ${title}${note ? ` — ${note}` : ''}`);
}

(async () => {
  await step('B0', 'Fixture organisation + user on the migrated disposable database', async () => {
    const label = `bb-${Date.now().toString(36)}`;
    [{ id: ORG }] = await sql(`INSERT INTO core.organisation(name, slug) VALUES ($1, $2) RETURNING id`, [label, label]);
    [{ id: USER }] = await sql(`INSERT INTO core."user"(organisation_id, email, first_name, last_name, status) VALUES ($1, $2, 'BB', 'R', 'active') RETURNING id`, [ORG, `${label}@bq-test.invalid`]);
    await redis.flushall();
  });

  await step('B1', 'Two bundles in bullmq mode become healthy; both children identified; heartbeat file carries the bullmq contract', async () => {
    assert(compose(['up', '-d', 'bundle-a', 'bundle-b']).code === 0, 'up failed');
    await waitFor('both healthy', () => health('bundle-a') === 'healthy' && health('bundle-b') === 'healthy', 240_000, 3000);
    for (const s of ['bundle-a', 'bundle-b']) {
      const l = logs(s);
      assert(/live identity probes agree: database=rab cluster=\d+ \(jobs=crewflow_app, provisioner=crewflow\)/.test(l), `${s}: identity line`);
      assert(/\[jobs\] rab-worker ready \(scheduler=bullmq\)/.test(l), `${s}: jobs not ready in bullmq mode`);
      const hb = JSON.parse(docker(['exec', '-u', '1000:1000', cname(s), 'cat', '/run/crewflow-health/jobs/heartbeat.json'], { quiet: true }).out);
      write(`${s} jobs heartbeat: ${JSON.stringify(hb)}`);
      assert(hb.mode === 'bullmq' && hb.consumersReadyAt > 0 && hb.reconcileOkAt > 0, `${s}: heartbeat contract`);
    }
  });

  await step('B2', 'Both bundles stay healthy for 6 min (> the 5-min "cycle finished" window) — no idle-replica restart loop', async () => {
    const samples = [];
    for (let i = 0; i < 36; i += 1) {
      samples.push(`${health('bundle-a')}/${health('bundle-b')}`);
      await sleep(10_000);
    }
    const restarts = ['bundle-a', 'bundle-b'].map((s) => docker(['inspect', '-f', '{{.RestartCount}} {{.State.StartedAt}}', cname(s)], { quiet: true }).out.trim());
    write(`health samples: ${samples.join(' ')}\nrestarts/startedAt: ${restarts.join(' | ')}`);
    assert(samples.every((s) => s === 'healthy/healthy'), 'a bundle went unhealthy');
    // Per-instance work: which replica ran how many email-dispatch ticks in that window (BullMQ processedBy).
    return `36/36 samples healthy/healthy`;
  });

  await step('B3', 'Provisioner stats identity: jobs startedAt no longer overwritten; old readers still see lastWorkspaceProvisioningAt', async () => {
    const jobs = await redis.hgetall('rab:worker:stats');
    const prov = await redis.hgetall('rab:workspace-provisioner:stats');
    write(`rab:worker:stats startedAt=${jobs.startedAt} lastWorkspaceProvisioningAt=${jobs.lastWorkspaceProvisioningAt}\nrab:workspace-provisioner:stats ${JSON.stringify(prov)}`);
    assert(prov.startedAt && jobs.startedAt && jobs.lastWorkspaceProvisioningAt, 'missing fields');
    // The provisioner's startedAt never lands in the jobs hash: sample it 6 times over 30 s (provisioner writes every 5 s).
    const seen = new Set();
    for (let i = 0; i < 6; i += 1) {
      seen.add((await redis.hget('rab:worker:stats', 'startedAt')) ?? '');
      await sleep(5_000);
    }
    const provStarts = new Set([prov.startedAt]);
    for (const v of seen) assert(!provStarts.has(v), 'rab:worker:stats startedAt equals a provisioner start time');
    return `jobs startedAt values seen=${seen.size}; provisioner startedAt kept separately`;
  });

  await step('B4', 'SIGTERM with emails in flight: bounded drain, launcher exits 0, no email lost or sent twice', async () => {
    const ids = await insertEmails(300, 'b4');
    await sleep(1_500);
    const t0 = Date.now();
    const stop = docker(['stop', '-t', '55', cname('bundle-a')]);
    const ms = Date.now() - t0;
    const l = logs('bundle-a');
    write(l.split('\n').filter((x) => /Worker received|shut down|exiting with code|still busy|force-clos|cycle\(s\) still running|provisioner\] shut down/.test(x)).join('\n'));
    const code = docker(['inspect', '-f', '{{.State.ExitCode}}', cname('bundle-a')], { quiet: true }).out.trim();
    assert(stop.code === 0 && /\[jobs\] Worker shut down cleanly/.test(l) && /exiting with code 0/.test(l) && code === '0', `unclean stop (exit ${code})`);
    assert(ms < 55_000, `stop took ${ms}ms`);
    await deliveredExactlyOnce(ids);
    const schedulers = await redis.zcard('crewflow:development:bull:crewflow-scan-email:repeat');
    assert(schedulers === 1, 'email-dispatch scheduler removed by shutdown');
    compose(['start', 'bundle-a']);
    await waitFor('a healthy again', () => health('bundle-a') === 'healthy', 240_000, 3000);
    return `stopped in ${ms}ms, exit 0, 300 emails exactly once`;
  });

  await step('B5', 'SIGKILL a bundle mid-traffic: the other keeps scheduling; stalled work recovered; exactly once', async () => {
    const ids = await insertEmails(300, 'b5');
    await sleep(1_500);
    docker(['kill', cname('bundle-a')]);
    await deliveredExactlyOnce(ids, 300_000);
    assert(health('bundle-b') === 'healthy', 'bundle-b unhealthy');
    return '300 emails exactly once after SIGKILL';
  });

  await step('B6', 'Rollback in place: bundle-b recreated in interval mode stays healthy; no scan job consumed after the switch', async () => {
    retired.b1 = logs('bundle-b');
    const env = { ...ENV, BQ_WORKER_SCHEDULER: 'interval' };
    const r = spawnSync('docker', ['compose', '-p', PROJECT, '-f', FILE, '--profile', 'bundle', 'up', '-d', '--force-recreate', 'bundle-b'], { env, encoding: 'utf8' });
    write(redact(`${r.stdout}${r.stderr}`));
    await waitFor('b healthy (interval)', () => health('bundle-b') === 'healthy', 240_000, 3000);
    assert(/\[jobs\] rab-worker ready$/m.test(logs('bundle-b')), 'not interval mode');
    const before = await redis.zcard('crewflow:development:bull:crewflow-scan-email:completed');
    await sleep(30_000);
    const after = await redis.zcard('crewflow:development:bull:crewflow-scan-email:completed');
    write(`scan-email completed before=${before} after=${after}`);
    assert(after === before, 'interval-mode bundle consumed scan jobs');
    const ids = await insertEmails(20, 'b6');
    await deliveredExactlyOnce(ids);
    return 'healthy in interval mode; 0 scan jobs consumed; delivery unchanged';
  });

  compose(['stop', 'bundle-a', 'bundle-b']);
  for (const s of ['bundle-a', 'bundle-b']) fs.writeFileSync(path.join(OUT, `${s}.log`), redact(logs(s)));
  compose(['rm', '-f', 'bundle-a', 'bundle-b']);
  await redis.quit();
  const summary = ['| case | result | note |', '|---|---|---|', ...results.map((r) => `| ${r.id} ${r.title} | ${r.status} | ${String(r.note).replace(/\|/g, '/')} |`)].join('\n');
  fs.writeFileSync(path.join(OUT, 'SUMMARY.md'), `${redact(summary)}\n`);
  console.log(summary);
  process.exit(results.some((r) => r.status !== 'PASS') ? 1 : 0);
})().catch((e) => {
  console.error(redact(e.stack || e.message));
  process.exit(1);
});
