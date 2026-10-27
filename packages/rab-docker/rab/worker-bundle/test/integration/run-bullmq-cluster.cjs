'use strict';
/**
 * Lane A — BullMQ worker migration cluster + failure harness. ONLY against its own disposable compose project
 * (`crewflow-bullmq`, docker-compose.bullmq-test.yml: PostgreSQL 15480, Redis 16480 noeviction, Redis 16481 allkeys-lru),
 * migrated here by the guarded runner. Two (or three) ORDINARY jobs-process replicas run on the host
 * (`node --preserve-symlinks -r ts-node/register packages/rab-worker/src/main.ts`) as crewflow_app — the same entrypoint
 * the Worker bundle's jobs child runs. Never touches the development stack, never reads a .env file.
 *
 *   node packages/rab-docker/rab/worker-bundle/test/integration/run-bullmq-cluster.cjs <evidence-dir> [--only=C1,C2] [--keep]
 *
 * Credentials are random per run and redacted from every evidence file. Each case: PASS / FAIL with its log in
 * <evidence-dir>/NN-*.log and a summary in <evidence-dir>/SUMMARY.md.
 */
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../../../../../..');
const req = (m) => require(require.resolve(m, { paths: [ROOT] }));
const Redis = req('ioredis');
const { Queue } = req('bullmq');
const { Client } = req('pg');

const PROJECT = 'crewflow-bullmq';
const FILE = path.join(__dirname, 'docker-compose.bullmq-test.yml');
const OUT = path.resolve(process.argv[2] || '');
const KEEP = process.argv.includes('--keep');
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
// --mode=interval re-runs the replica/failure cases with WORKER_SCHEDULER=interval (the regression baseline): scheduler
// assertions then expect NO Crewflow schedulers; the bullmq-only cases (C2, C11, C15, C16) are skipped.
const MODE = (process.argv.find((a) => a.startsWith('--mode=')) || '--mode=bullmq').slice(7);
const BULLMQ = MODE === 'bullmq';
const EXPECTED_SCHEDULERS = BULLMQ ? 19 : 0;
if (!process.argv[2]) {
  console.error('usage: run-bullmq-cluster.cjs <evidence-dir> [--only=C1,...] [--keep]');
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });

const hex = (n) => crypto.randomBytes(n).toString('hex');
// Random per run, unless the caller supplies all four (e.g. to keep a host-side jest env file valid with --keep).
const SECRET_KEYS = ['BQ_SUPERUSER_PASSWORD', 'BQ_CREWFLOW_PASSWORD', 'BQ_APP_PASSWORD', 'BQ_APP_SECRET'];
const SECRETS = SECRET_KEYS.every((k) => /^[0-9a-f]{32,}$/.test(process.env[k] ?? ''))
  ? Object.fromEntries(SECRET_KEYS.map((k) => [k, process.env[k]]))
  : { BQ_SUPERUSER_PASSWORD: hex(20), BQ_CREWFLOW_PASSWORD: hex(20), BQ_APP_PASSWORD: hex(20), BQ_APP_SECRET: hex(40) };
const redact = (s) => Object.values(SECRETS).reduce((acc, v) => acc.split(v).join('<redacted>'), String(s ?? ''));
const BASE_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(DATABASE_|TEST_|CREWFLOW_|REDIS_URL|DB_TARGET|BQ_|WORKER_|BULLMQ_)/.test(k)));
const ENV = { ...BASE_ENV, ...SECRETS, COMPOSE_PROJECT_NAME: PROJECT, MSYS_NO_PATHCONV: '1' };
const SU_URL = () => `postgres://rab:${SECRETS.BQ_SUPERUSER_PASSWORD}@127.0.0.1:15480/rab`;
const APP_URL = () => `postgres://crewflow_app:${SECRETS.BQ_APP_PASSWORD}@127.0.0.1:15480/rab`;
const REDIS_URL = 'redis://127.0.0.1:16480';
const PREFIX = 'crewflow:development:bull';

let currentLog = path.join(OUT, '00-setup.log');
const write = (text) => fs.appendFileSync(currentLog, `${redact(text)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (cond, message) => {
  if (!cond) throw new Error(message);
};
async function waitFor(label, predicate, timeoutMs, everyMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await predicate();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for: ${label}`);
    await sleep(everyMs);
  }
}

function docker(args, { timeout = 300_000, quiet = false } = {}) {
  const res = spawnSync('docker', args, { env: ENV, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 });
  const out = redact(`${res.stdout ?? ''}${res.stderr ?? ''}`);
  if (!quiet) write(`$ docker ${redact(args.join(' ')).slice(0, 300)}\n${out.trimEnd()}\n[exit ${res.status}]`);
  return { code: res.status, out };
}
const compose = (args, opts) => docker(['compose', '-p', PROJECT, '-f', FILE, ...args], opts);
const svc = (name) => `${PROJECT}-${name}-1`;

async function sql(text, params = [], url = SU_URL()) {
  const c = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  c.on('error', () => undefined);
  await c.connect();
  try {
    return (await c.query(text, params)).rows;
  } finally {
    await c.end().catch(() => undefined);
  }
}
async function trySql(text, params) {
  try {
    return await sql(text, params);
  } catch {
    return null;
  }
}
let redisClient;
const redis = () => (redisClient ??= (() => {
  const r = new Redis(REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: false });
  r.on('error', () => undefined);
  return r;
})());

// ------------------------------------------------------------------------------------------------ replicas

const replicas = new Map();
function startReplica(name, mode, extraEnv = {}) {
  const logFile = path.join(OUT, `replica-${name}.log`);
  const env = {
    PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, TEMP: process.env.TEMP, TMP: process.env.TMP, USERPROFILE: process.env.USERPROFILE,
    NODE_ENV: 'development', RAB_RUNTIME_ENV: 'development',
    DATABASE_URL: APP_URL(), DATABASE_DIRECT_URL: APP_URL(), REDIS_URL,
    APP_SECRET: SECRETS.BQ_APP_SECRET, EMAIL_DRIVER: 'LOGGER',
    STORAGE_DRIVER: 'LOCAL', STORAGE_LOCAL_ROOT: path.join(OUT, 'storage'), STORAGE_KEY_PREFIX: 'bqtest',
    APP_URL: 'http://127.0.0.1:5173', ACCOUNTS_URL: 'http://127.0.0.1:5173', CORS_ORIGINS: 'http://127.0.0.1:5173',
    WORKER_SCHEDULER: mode, WORKER_SCHEDULER_RECONCILE_SECONDS: '10', WORKER_SHUTDOWN_TIMEOUT_MS: '15000',
    TS_NODE_PROJECT: 'packages/rab-worker/tsconfig.app.json', TS_NODE_TRANSPILE_ONLY: 'true',
    ...extraEnv,
  };
  const child = spawn(process.execPath, ['--preserve-symlinks', '-r', 'ts-node/register', 'packages/rab-worker/src/main.ts'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const rec = { name, mode, child, pid: child.pid, lines: [], exited: null, startedAt: Date.now(), raw: '' };
  const onData = (buf) => {
    const text = buf.toString();
    rec.raw += text;
    fs.appendFileSync(logFile, redact(text));
    for (const line of text.split(/\r?\n/)) if (line) rec.lines.push(line);
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('exit', (code, signal) => {
    rec.exited = { code, signal, at: Date.now() };
    fs.appendFileSync(logFile, `\n[harness] exited code=${code} signal=${signal}\n`);
  });
  replicas.set(name, rec);
  write(`started replica ${name} mode=${mode} pid=${child.pid}`);
  return rec;
}
async function ready(rec, timeoutMs = 120_000) {
  await waitFor(`${rec.name} ready`, () => rec.exited ? Promise.reject(new Error(`${rec.name} exited ${JSON.stringify(rec.exited)}`)) : rec.lines.some((l) => /rab-worker ready/.test(l)), timeoutMs, 500);
}
async function stopReplica(rec, signal = 'SIGTERM', timeoutMs = 60_000) {
  if (rec.exited) return rec.exited;
  const t0 = Date.now();
  if (signal === 'SIGKILL') rec.child.kill('SIGKILL');
  else {
    // Windows has no POSIX SIGTERM delivery to node children; ask the process to run its own SIGTERM handler.
    rec.child.kill('SIGTERM');
  }
  await waitFor(`${rec.name} exit`, () => rec.exited, timeoutMs, 200);
  return { ...rec.exited, ms: Date.now() - t0 };
}

// ------------------------------------------------------------------------------------------------ fixtures + probes

let ORG;
let USER;
async function seedOrganisation() {
  const label = `bq-${hex(3)}`;
  const [org] = await sql(`INSERT INTO core.organisation(name, slug) VALUES ($1, $2) RETURNING id`, [label, label]);
  // NOTIFICATION emails must target a live user (the send path revalidates it and cancels otherwise).
  const [user] = await sql(
    `INSERT INTO core."user"(organisation_id, email, first_name, last_name, status) VALUES ($1, $2, 'BQ', 'Recipient', 'active') RETURNING id`,
    [org.id, `${label}@bq-test.invalid`],
  );
  USER = user.id;
  return org.id;
}
async function insertEmails(n, tag) {
  const rows = await sql(
    `INSERT INTO core.email_outbox(organisation_id, job_type, recipient_email, target_user_id, rendered_subject, rendered_text)
     SELECT $1, 'NOTIFICATION', 'bq-' || $2 || '-' || g || '@bq-test.invalid', $4, 'BQ ' || $2, 'cluster test body'
     FROM generate_series(1, $3::int) g RETURNING id`,
    [ORG, tag, n, USER],
  );
  return rows.map((r) => r.id);
}
async function emailStatus(ids) {
  const rows = await sql(`SELECT status, count(*)::int AS n FROM core.email_outbox WHERE id = ANY($1::uuid[]) GROUP BY status`, [ids]);
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}
/** Times each email id's provider "send" (LOGGER line) appears across ALL replica logs, ever. */
function sendCounts(ids) {
  const all = [...replicas.values()].map((r) => r.raw).join('\n') + Object.values(retiredLogs).join('\n');
  const counts = {};
  for (const id of ids) counts[id] = all.split(`idempotencyKey: email-outbox:${id}`).length - 1;
  return counts;
}
const retiredLogs = {};
function retire(rec) {
  retiredLogs[`${rec.name}-${rec.pid}`] = rec.raw;
  replicas.delete(rec.name);
}
async function deliveredExactlyOnce(ids, timeoutMs = 120_000) {
  await waitFor(`${ids.length} emails SENT`, async () => (await trySql(`SELECT count(*)::int AS n FROM core.email_outbox WHERE id = ANY($1::uuid[]) AND status = 'SENT'`, [ids]))?.[0]?.n === ids.length, timeoutMs, 1000);
  const counts = sendCounts(ids);
  const dup = Object.entries(counts).filter(([, n]) => n !== 1);
  write(`delivery: ${ids.length} SENT; send-count histogram ${JSON.stringify(Object.values(counts).reduce((h, n) => ((h[n] = (h[n] || 0) + 1), h), {}))}`);
  assert(dup.length === 0, `${dup.length} email(s) not sent exactly once: ${JSON.stringify(dup.slice(0, 3))}`);
}
async function schedulerIds() {
  const ids = [];
  for (const q of ['crewflow-scan-email', 'crewflow-scan-push', 'crewflow-scan-shifts', 'crewflow-scan-offers', 'crewflow-scan-reports', 'crewflow-scan-maintenance', 'crewflow-scan-realtime']) {
    const queue = new Queue(q, { connection: redis(), prefix: PREFIX });
    try {
      for (const s of await queue.getJobSchedulers()) ids.push(s.key);
    } finally {
      await queue.close();
    }
  }
  return ids.sort();
}
/** Executed (not skipped) jobs of one scan queue since `since`, with which replica ran them. */
async function executedJobs(queueName, jobName, since) {
  const queue = new Queue(queueName, { connection: redis(), prefix: PREFIX });
  try {
    const jobs = await queue.getJobs(['completed', 'failed'], 0, 2000);
    return jobs
      .filter((j) => j && j.name === jobName && j.processedOn >= since)
      .map((j) => ({ id: j.id, by: j.processedBy, start: j.processedOn, end: j.finishedOn, outcome: j.returnvalue?.outcome ?? (j.failedReason ? 'failed' : '?') }));
  } finally {
    await queue.close();
  }
}
function overlaps(jobs) {
  const ran = jobs.filter((j) => j.outcome !== 'skipped-locked' && j.outcome !== 'skipped-running' && j.outcome !== 'skipped-shutdown').sort((a, b) => a.start - b.start);
  const bad = [];
  for (let i = 1; i < ran.length; i += 1) if (ran[i].start < ran[i - 1].end) bad.push([ran[i - 1], ran[i]]);
  return bad;
}
const alive = () => [...replicas.values()].filter((r) => !r.exited).map((r) => r.name);

// ------------------------------------------------------------------------------------------------ steps

const results = [];
async function step(id, title, fn) {
  if (ONLY.length && !ONLY.includes(id) && id !== 'C0') return;
  if (!BULLMQ && ['C2', 'C11', 'C15', 'C16', 'C17'].includes(id)) return;
  currentLog = path.join(OUT, `${id}-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)}.log`);
  fs.writeFileSync(currentLog, `# ${id} ${title}\n# ${new Date().toISOString()}\n`);
  const started = Date.now();
  let status = 'PASS';
  let note = '';
  try {
    const r = await fn();
    if (typeof r === 'string') note = r;
  } catch (e) {
    status = 'FAIL';
    note = redact(e.message);
  }
  write(`\n# RESULT: ${status}${note ? ` — ${note}` : ''} (${Math.round((Date.now() - started) / 1000)}s)`);
  results.push({ id, title, status, note, secs: Math.round((Date.now() - started) / 1000) });
  console.log(`${status.padEnd(5)} ${id} ${title}${note ? ` — ${note}` : ''}`);
}

async function migrate() {
  const run = (url) => {
    const res = spawnSync(process.execPath, ['dist/database/typeorm/scripts/setup-db.js'], {
      cwd: path.join(ROOT, 'packages/rab-server'),
      env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, NODE_ENV: 'development', RAB_RUNTIME_ENV: 'development', DB_TARGET: 'local', DATABASE_URL: url, DATABASE_URL_UNPOOLED: url, CREWFLOW_BOOTSTRAP_PASSWORD: SECRETS.BQ_CREWFLOW_PASSWORD, CREWFLOW_APP_BOOTSTRAP_PASSWORD: SECRETS.BQ_APP_PASSWORD },
      encoding: 'utf8', timeout: 600_000,
    });
    write(redact(`${res.stdout}${res.stderr}`).split('\n').filter((l) => !/^\s+at /.test(l)).slice(-6).join('\n'));
    return res;
  };
  const a = run('postgres://rab_owner:rab_owner_dev_only@127.0.0.1:15480/rab');
  assert(/refuses to run as 'rab_owner'/.test(`${a.stdout}${a.stderr}`), 'phase A did not stop at the role split');
  const b = run(SU_URL());
  assert(b.status === 0 && /Migrations applied/.test(b.stdout), 'phase B failed');
}

(async () => {
  const RUN_STARTED = Date.now();
  write(`# BullMQ cluster harness — project ${PROJECT}, replicas in ${MODE} mode`);
  compose(['down', '-v', '--remove-orphans']);

  await step('C0', 'Disposable stack, guarded migrations, fixture organisation', async () => {
    assert(compose(['up', '-d', '--wait']).code === 0, 'infra did not start');
    await migrate();
    const [{ n }] = await sql('SELECT count(*)::int AS n FROM core.migrations');
    ORG = await seedOrganisation();
    return `migrations=${n}`;
  });

  await step('C1', 'Two bullmq replicas start; exactly 19 Crewflow schedulers; status key; only crewflow_app sessions', async () => {
    const a = startReplica('A', MODE);
    const b = startReplica('B', MODE);
    await Promise.all([ready(a), ready(b)]);
    const ids = await schedulerIds();
    write(`schedulers (${ids.length}): ${ids.join(' ')}`);
    assert(ids.length === EXPECTED_SCHEDULERS && ids.every((i) => /^crewflow:crewflow-scan-[a-z]+:[a-z-]+$/.test(i)), `expected ${EXPECTED_SCHEDULERS} crewflow:<queue>:<job> schedulers`);
    const status = await redis().hgetall('rab:worker:scheduler');
    write(`rab:worker:scheduler ${JSON.stringify(status)}`);
    assert(BULLMQ ? status.mode === 'bullmq' && status.prefix === PREFIX : !status.mode, 'scheduler status');
    const roles = await sql(`SELECT usename, count(*)::int AS n FROM pg_stat_activity WHERE datname = 'rab' AND usename IS NOT NULL AND pid <> pg_backend_pid() GROUP BY 1 ORDER BY 1`);
    write(`pg sessions by role: ${JSON.stringify(roles)}`);
    assert(roles.every((r) => r.usename === 'crewflow_app'), 'a replica connected as something other than crewflow_app');
    const bullKeys = await redis().keys('bull:crewflow-scan-*');
    assert(bullKeys.length === 0, 'scan queues leaked into the legacy bull: prefix');
    for (const r of [a, b]) assert(!BULLMQ || r.lines.some((l) => /bullmq scheduler: Redis maxmemory-policy=noeviction/.test(l)), `${r.name} preflight line`);
    return `${EXPECTED_SCHEDULERS} schedulers (${MODE}), crewflow_app only`;
  });

  await step('C2', 'Distribution, one run per tick cluster-wide, never the same scan concurrently (90 s)', async () => {
    const since = Date.now();
    await sleep(90_000);
    const summary = [];
    for (const [q, j, every] of [['crewflow-scan-email', 'email-dispatch', 2000], ['crewflow-scan-realtime', 'realtime-outbox-publish', 2000], ['crewflow-scan-push', 'push-dispatch', 2000], ['crewflow-scan-reports', 'shift-statement-dispatch', 5000]]) {
      const jobs = await executedJobs(q, j, since);
      const by = jobs.reduce((m, x) => ((m[x.by] = (m[x.by] || 0) + 1), m), {});
      const ov = overlaps(jobs);
      const expected = Math.floor(90_000 / every);
      summary.push(`${j}: executed=${jobs.length} (expected≈${expected}, interval-mode×2 would be ≈${expected * 2}) by=${JSON.stringify(by)} overlaps=${ov.length}`);
      assert(ov.length === 0, `${j}: ${ov.length} overlapping runs`);
      assert(jobs.length <= expected * 1.25 + 2 && jobs.length >= expected * 0.6, `${j}: executed ${jobs.length}, expected ≈${expected}`);
      assert(Object.keys(by).length === 2, `${j}: not distributed over both replicas (${JSON.stringify(by)})`);
    }
    write(summary.join('\n'));
    return summary.map((s) => s.split(':')[0] + ' ok').join(', ');
  });

  await step('C3', 'Committed effects exactly once: 100 emails dispatched + sent once across two replicas', async () => {
    const ids = await insertEmails(100, 'c3');
    await deliveredExactlyOnce(ids);
  });

  await step('C4', 'SIGKILL one replica mid-traffic: survivor keeps scheduling; no duplicate sends; schedulers intact', async () => {
    const ids = await insertEmails(100, 'c4');
    await sleep(1500);
    const a = replicas.get('A');
    await stopReplica(a, 'SIGKILL');
    retire(a);
    const since = Date.now();
    await deliveredExactlyOnce(ids, 180_000);
    await sleep(10_000);
    const after = await executedJobs('crewflow-scan-email', 'email-dispatch', since);
    write(`email-dispatch after kill: ${after.length} executed, by=${JSON.stringify([...new Set(after.map((j) => j.by))])}`);
    assert(!BULLMQ || after.length >= 3, 'scheduling stopped with one replica dead');
    assert((await schedulerIds()).length === EXPECTED_SCHEDULERS, 'schedulers changed');
    const a2 = startReplica('A', MODE);
    await ready(a2);
    return `${ids.length} sent exactly once; survivor ran ${after.length} dispatch ticks`;
  });

  await step('C5', 'SIGTERM: bounded graceful shutdown, exits cleanly, schedulers NOT removed, queued jobs kept', async () => {
    const b = replicas.get('B');
    const before = await schedulerIds();
    const r = await stopReplica(b, 'SIGTERM', 60_000);
    write(`B exit ${JSON.stringify(r)}`);
    const clean = b.lines.some((l) => /Worker shut down cleanly/.test(l));
    // Windows: child.kill('SIGTERM') terminates the process without running handlers; the in-process path is unit/integration-tested.
    if (process.platform !== 'win32') assert(clean && r.code === 0, 'B did not shut down cleanly');
    retire(b);
    assert(JSON.stringify(await schedulerIds()) === JSON.stringify(before), 'schedulers changed on shutdown');
    const b2 = startReplica('B', MODE);
    await ready(b2);
    return process.platform === 'win32' ? 'win32: terminate (no POSIX SIGTERM); schedulers intact; restart ok' : `clean exit in ${r.ms}ms`;
  });

  const recovery = async (label, tag, fn) => {
    const pids = alive();
    await fn();
    for (const n of pids) assert(!replicas.get(n).exited, `${label}: replica ${n} exited ${JSON.stringify(replicas.get(n).exited)}`);
    const ids = await insertEmails(20, tag);
    await deliveredExactlyOnce(ids, 240_000);
    assert((await schedulerIds()).length === EXPECTED_SCHEDULERS, `${label}: schedulers not ${EXPECTED_SCHEDULERS} after recovery`);
    for (const n of pids) assert(!replicas.get(n).exited, `${label}: replica ${n} exited after recovery`);
    return `replicas ${pids.join('+')} stayed up; 20 new emails sent exactly once; ${EXPECTED_SCHEDULERS} schedulers`;
  };

  await step('C6', 'PG restart (docker restart): replicas stay up, reconnect, work resumes', () => recovery('pg restart', 'c6', async () => {
    docker(['restart', '-t', '5', svc('pg')]);
    await waitFor('pg back', async () => (await trySql('SELECT 1 AS ok'))?.length === 1, 60_000);
  }));

  await step('C7', 'Backend kill (pg_terminate_backend: pooled, direct and scan-lock sessions)', () => recovery('backend kill', 'c7', async () => {
    const killed = await sql(`SELECT count(pg_terminate_backend(pid))::int AS n FROM pg_stat_activity WHERE usename = 'crewflow_app'`);
    write(`terminated ${killed[0].n} crewflow_app backends`);
  }));

  await step('C8', 'Network blip (PG paused 15 s)', () => recovery('blip', 'c8', async () => {
    docker(['pause', svc('pg')]);
    await sleep(15_000);
    docker(['unpause', svc('pg')]);
  }));

  await step('C9', 'Long PG outage (stopped 120 s)', () => recovery('long outage', 'c9', async () => {
    docker(['stop', '-t', '5', svc('pg')]);
    await sleep(120_000);
    docker(['start', svc('pg')]);
    await waitFor('pg back', async () => (await trySql('SELECT 1 AS ok'))?.length === 1, 60_000);
  }));

  await step('C10', 'Redis outage (stopped 30 s, restarted)', () => recovery('redis outage', 'c10', async () => {
    docker(['stop', '-t', '5', svc('redis')]);
    await sleep(30_000);
    docker(['start', svc('redis')]);
    await waitFor('redis back', async () => (await redis().ping().catch(() => null)) === 'PONG', 60_000);
  }));

  await step('C11', 'Redis flush (schedulers lost) → recreated by the periodic reconcile', async () => {
    await redis().flushall();
    const t0 = Date.now();
    await waitFor('19 schedulers recreated', async () => (await schedulerIds()).length === 19, 60_000, 1000);
    write(`recreated in ${Date.now() - t0}ms`);
    const ids = await insertEmails(20, 'c11');
    await deliveredExactlyOnce(ids);
    return `recreated in ${Math.round((Date.now() - t0) / 1000)}s`;
  });

  await step('C12', 'PG + Redis outage at the same time (30 s)', () => recovery('pg+redis', 'c12', async () => {
    docker(['stop', '-t', '5', svc('pg'), svc('redis')]);
    await sleep(30_000);
    docker(['start', svc('pg'), svc('redis')]);
    await waitFor('pg back', async () => (await trySql('SELECT 1 AS ok'))?.length === 1, 60_000);
    await waitFor('redis back', async () => (await redis().ping().catch(() => null)) === 'PONG', 60_000);
  }));

  await step('C13', 'Worker started before PG/Redis are ready: refuses (non-zero, no secret in output); starts once they are', async () => {
    docker(['stop', '-t', '5', svc('pg'), svc('redis')]);
    const c = startReplica('C', MODE);
    await waitFor('C exits', () => c.exited, 120_000, 500);
    write(`C exited ${JSON.stringify(c.exited)} after ${c.exited.at - c.startedAt}ms; last lines:\n${c.lines.slice(-5).join('\n')}`);
    assert(c.exited.code !== 0, 'C did not refuse');
    for (const v of Object.values(SECRETS)) assert(!c.raw.includes(v), 'C printed a secret');
    retire(c);
    docker(['start', svc('pg'), svc('redis')]);
    await waitFor('pg back', async () => (await trySql('SELECT 1 AS ok'))?.length === 1, 60_000);
    await waitFor('redis back', async () => (await redis().ping().catch(() => null)) === 'PONG', 60_000);
    const c2 = startReplica('C', MODE);
    await ready(c2);
    await stopReplica(c2, 'SIGKILL');
    retire(c2);
    // A and B survived the dependency outage too.
    for (const n of ['A', 'B']) assert(replicas.get(n) && !replicas.get(n).exited, `${n} exited during the outage`);
    const ids = await insertEmails(10, 'c13');
    await deliveredExactlyOnce(ids, 240_000);
    return `refused in ${c.exited.at - c.startedAt}ms with exit ${c.exited.code}; started after recovery`;
  });

  await step('C14', 'Pending jobs drain: all replicas down, work queued, replicas back → drained once; 1 pending job per scheduler', async () => {
    for (const n of ['A', 'B']) {
      await stopReplica(replicas.get(n), 'SIGKILL');
      retire(replicas.get(n));
    }
    const ids = await insertEmails(50, 'c14');
    await sleep(20_000);
    const pending = [];
    for (const q of ['crewflow-scan-email', 'crewflow-scan-maintenance']) {
      const queue = new Queue(q, { connection: redis(), prefix: PREFIX });
      const counts = await queue.getJobCounts('wait', 'delayed', 'active', 'prioritized');
      pending.push(`${q}=${JSON.stringify(counts)}`);
      await queue.close();
    }
    write(`while down: ${pending.join(' ')}`);
    const a = startReplica('A', MODE);
    const b = startReplica('B', MODE);
    await Promise.all([ready(a), ready(b)]);
    await deliveredExactlyOnce(ids, 240_000);
    return pending.join(' ');
  });

  await step('C15', 'Security: Redis holds only ids/metadata for scan jobs (no email, token, body, URL); legacy bull: untouched', async () => {
    const keys = await redis().keys(`${PREFIX}:*`);
    let checked = 0;
    for (const key of keys) {
      const type = await redis().type(key);
      let blob = '';
      if (type === 'hash') blob = JSON.stringify(await redis().hgetall(key));
      else if (type === 'string') blob = await redis().get(key);
      else continue;
      checked += 1;
      assert(!/@bq-test\.invalid|cluster test body|postgres:\/\/|redis:\/\/|idempotency|password/i.test(blob), `sensitive content in ${key}`);
    }
    const legacy = (await redis().keys('bull:*')).filter((k) => /crewflow-scan/.test(k));
    assert(legacy.length === 0, 'scan keys under bull:');
    return `${checked} scan keys checked`;
  });

  await step('C16', 'Rollback drill: interval-mode replicas, no scan jobs consumed (no duplicate ticks), schedulers inert; removal command', async () => {
    for (const n of ['A', 'B']) {
      await stopReplica(replicas.get(n), 'SIGKILL');
      retire(replicas.get(n));
    }
    const a = startReplica('A', 'interval');
    const b = startReplica('B', 'interval');
    await Promise.all([ready(a), ready(b)]);
    const since = Date.now();
    await sleep(30_000);
    const consumed = await executedJobs('crewflow-scan-email', 'email-dispatch', since);
    const queue = new Queue('crewflow-scan-email', { connection: redis(), prefix: PREFIX });
    const counts = await queue.getJobCounts('wait', 'delayed', 'active');
    await queue.close();
    write(`interval mode: scan jobs consumed since switch=${consumed.length}; crewflow-scan-email pending=${JSON.stringify(counts)}`);
    assert(consumed.length === 0, 'interval-mode replicas consumed scan jobs');
    assert(counts.wait + counts.delayed <= 1 && counts.active === 0, 'leftover scheduler is not inert');
    const ids = await insertEmails(20, 'c16');
    await deliveredExactlyOnce(ids);
    const rm = spawnSync(process.execPath, ['--preserve-symlinks', '-r', 'ts-node/register', 'packages/rab-worker/src/tools/remove-crewflow-schedulers.ts', '--confirm'], {
      cwd: ROOT, encoding: 'utf8', timeout: 120_000,
      env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, REDIS_URL, NODE_ENV: 'development', TS_NODE_PROJECT: 'packages/rab-worker/tsconfig.app.json', TS_NODE_TRANSPILE_ONLY: 'true' },
    });
    write(`removal: exit=${rm.status} ${redact(rm.stdout).trim()} ${redact(rm.stderr).trim().slice(0, 300)}`);
    assert(rm.status === 0 && /removed 19/.test(rm.stdout), 'removal command');
    assert((await schedulerIds()).length === 0, 'schedulers remain');
    return `consumed=0 during interval mode; removed 19`;
  });

  await step('C17', 'M1 durations collected (rab:worker:cycle-durations)', async () => {
    const d = await redis().hgetall('rab:worker:cycle-durations');
    const lines = Object.entries(d).map(([k, v]) => `${k} ${v}`);
    write(lines.join('\n'));
    fs.writeFileSync(path.join(OUT, 'cycle-durations.json'), redact(JSON.stringify(Object.fromEntries(Object.entries(d).map(([k, v]) => [k, JSON.parse(v)])), null, 2)));
    return `${lines.length} loops`;
  });

  for (const r of replicas.values()) await stopReplica(r, 'SIGKILL').catch(() => undefined);
  await redisClient?.quit().catch(() => undefined);
  const summary = [`# BullMQ cluster harness (${MODE} mode) — ${new Date().toISOString()} (${Math.round((Date.now() - RUN_STARTED) / 60000)} min)`, '', '| case | result | note |', '|---|---|---|',
    ...results.map((r) => `| ${r.id} ${r.title} | ${r.status} | ${r.note.replace(/\|/g, '/')} (${r.secs}s) |`)].join('\n');
  fs.writeFileSync(path.join(OUT, 'SUMMARY.md'), `${redact(summary)}\n`);
  console.log(summary);
  if (!KEEP) compose(['down', '-v', '--remove-orphans']);
  process.exit(results.some((r) => r.status !== 'PASS') ? 1 : 0);
})().catch((e) => {
  console.error(redact(e.stack || e.message));
  process.exit(1);
});
