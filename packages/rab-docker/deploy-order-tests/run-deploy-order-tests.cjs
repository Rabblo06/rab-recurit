'use strict';
/**
 * DEPLOY-ORDER REAL-CONTAINER TESTS: "deploy exactly like Twenty" (owner decisions 2026-11-11). One command updates the API
 * and the Worker together from ONE image variable (CREWFLOW_IMAGE_TAG = a sha256 digest); the API starts first, migrates and
 * becomes healthy; the Worker starts after it; an old Worker never runs beside a new API (depends_on restart: true).
 *
 * The production file UNCHANGED (docker-compose.image.yml, with its bundled `db` service since DB-SETUP) plus the test-only
 * overlays deploy-order-tests/docker-compose.deploy-order.yml (infrastructure) and docker-compose.deploy-order-owner.yml (the
 * db's first start runs the shipped 01-crewflow-owner.sql: the hand-made crewflow_owner of an R254/R256 deployment, whose
 * URL the app services get as the PG_DATABASE_URL interpolation value: the DB-SETUP pass-through path, D5), deployed with
 * THE documented command, exactly:
 *
 *   docker compose pull && docker compose up -d
 *
 * (project, files and env file through COMPOSE_PROJECT_NAME / COMPOSE_FILE / COMPOSE_ENV_FILES). Images come from a LOCAL
 * registry (never Docker Hub) so each has a real registry digest:
 *
 *   DOT_REPOSITORY=127.0.0.1:5055/adolphus DOT_PREV_DIGEST=sha256:<previous release> DOT_NEW_DIGEST=sha256:<new release> \
 *   DOT_PG_IMAGE=postgres@sha256:<DEBIAN postgres 16, 17 or 18> DOT_REDIS_IMAGE=redis@sha256:<7> [DOT_PREV_PRE_DB_SETUP=1] \
 *     node packages/rab-docker/deploy-order-tests/run-deploy-order-tests.cjs <16|17|18> <out-dir> [--keep] [--only=T1,T2,...]
 *
 * DOT_PG_IMAGE is the bundled db's image (CREWFLOW_POSTGRES_IMAGE): a Debian postgres image (the db service runs as 999:999
 * with the Debian volume layout). DOT_PREV_PRE_DB_SETUP (default 1): the previous digest predates DB-SETUP (no
 * worker-start.sh), so its deploys add docker-compose.deploy-order-prev.yml (the previous release's own rab-worker
 * command); set 0 once the previous release ships worker-start.sh.
 *
 * Cases (T1-T3 share one project dot-pg<major>, T4 runs its own dot-pg<major>-t4):
 *   T1 fresh deploy of the previous digest: rab-api healthy BEFORE rab-worker starts (docker events + inspect);
 *   T2 deploy of the new digest: both containers recreated on the same new digest; the old Worker died BEFORE the new API
 *      started; the new API registered the schedulers, the new Worker consumes them and runs the new image's code for a
 *      scheduled job (the email dispatch sweep's new `generationsExhausted=` result field);
 *   T3 rollback to the previous digest with the same command: both go back together (same event order); the old API warns
 *      that the schema is AHEAD and serves;
 *   T4 an API that fails its health check: the Worker never starts and compose reports the dependency failure.
 *
 * At most five of this run's containers at once (db, rab-redis, rab-api, rab-worker + the registry the operator started).
 * Redis data is a tmpfs; the db's data and CA are the project's own named volumes. Cleanup removes only this run's projects
 * (`down --volumes` by project name; never a prune, never another project). Secrets are generated per run under <out-dir>/secrets (outside the
 * repository), reach the containers only through env files, and every captured output is redacted before it is written.
 * Results: <out-dir>/RESULTS.json and SUMMARY.md; raw evidence under <out-dir>/evidence.
 */
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const L = require('./upgrade-lib.cjs');

const RD = path.resolve(__dirname, '..'); // packages/rab-docker
const argv = process.argv.slice(2);
const MAJOR = argv[0];
const OUT = argv[1] ? path.resolve(process.platform === 'win32' ? argv[1].replace(/^\/([a-z])\//i, '$1:/') : argv[1]) : '';
const KEEP = argv.includes('--keep');
const ONLY = (argv.find((a) => a.startsWith('--only=')) ?? '').slice(7).split(',').filter(Boolean);
if (!['16', '17', '18'].includes(MAJOR) || !OUT) {
  console.error('usage: run-deploy-order-tests.cjs <16|17|18> <out-dir> [--keep] [--only=T1,T2,T3,T4]');
  process.exit(2);
}
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const REF = /^[a-z0-9./_:-]+@sha256:[0-9a-f]{64}$/;
for (const k of ['DOT_PREV_DIGEST', 'DOT_NEW_DIGEST']) if (!DIGEST.test(process.env[k] ?? '')) fail(`${k} must be sha256:<64 hex>`);
for (const k of ['DOT_PG_IMAGE', 'DOT_REDIS_IMAGE']) if (!REF.test(process.env[k] ?? '')) fail(`${k} must be <repository>@sha256:<64 hex>`);
if (!/^127\.0\.0\.1:\d+\/[a-z0-9._/-]+$/.test(process.env.DOT_REPOSITORY ?? '')) fail('DOT_REPOSITORY must be a LOCAL registry repository (127.0.0.1:<port>/<name>)');
if (process.env.DOT_PREV_DIGEST === process.env.DOT_NEW_DIGEST) fail('DOT_PREV_DIGEST and DOT_NEW_DIGEST must differ');
function fail(msg) {
  console.error(msg);
  process.exit(2);
}

const REPO = process.env.DOT_REPOSITORY;
const PREV = process.env.DOT_PREV_DIGEST;
const NEW = process.env.DOT_NEW_DIGEST;
const OVERLAY = 'deploy-order-tests/docker-compose.deploy-order.yml';
const OWNER_OVERLAY = 'deploy-order-tests/docker-compose.deploy-order-owner.yml';
const PREV_OVERLAY = 'deploy-order-tests/docker-compose.deploy-order-prev.yml';
const PREV_PRE_DB_SETUP = (process.env.DOT_PREV_PRE_DB_SETUP ?? '1') !== '0';
/** Project-name prefix (default dot: projects dot-pg<major>, dot-pg<major>-t4), so two runs or agents never share one. */
const PREFIX = process.env.DOT_PROJECT_PREFIX || 'dot';
if (!/^[a-z][a-z0-9-]{0,15}$/.test(PREFIX)) fail('DOT_PROJECT_PREFIX must match ^[a-z][a-z0-9-]{0,15}$');
const T4_OVERLAY = 'deploy-order-tests/docker-compose.deploy-order-t4.yml';
const REGISTRY_CONTAINER = process.env.DOT_REGISTRY_CONTAINER || 'deploy-order-registry';
const MAX_CONTAINERS = 5;

fs.mkdirSync(path.join(OUT, 'evidence'), { recursive: true });
const secrets = L.secrets;
const results = [];
const logLines = [];
let peak = { count: 0, at: '', names: [] };

const hex = (n) => crypto.randomBytes(n).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function redact(text) {
  let s = String(text ?? '');
  for (const v of Object.values(secrets)) if (v && v.length >= 8) s = s.split(v).join('<redacted>');
  return s.replace(/postgres(ql)?:\/\/[^\s'"]+/g, 'postgres://<redacted>').replace(/redis:\/\/[^\s'"]+/g, 'redis://<redacted>');
}
function note(line) {
  const l = redact(line);
  logLines.push(l);
  console.log(`[${PREFIX}-pg${MAJOR}] ${l}`);
}
function evidence(name, text) {
  fs.writeFileSync(path.join(OUT, 'evidence', name), redact(text));
}
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd ?? RD,
    env: { ...process.env, MSYS_NO_PATHCONV: '1', ...(opts.env ?? {}) },
    encoding: 'utf8',
    timeout: opts.timeout ?? 600_000,
    maxBuffer: 64 * 1024 * 1024,
    input: opts.input,
  });
  return { code: r.status ?? (r.error ? -1 : 0), out: `${r.stdout ?? ''}${r.stderr ?? ''}`, stdout: r.stdout ?? '', error: r.error };
}

// ---------------------------------------------------------------------------------------------------------- one project
class Project {
  constructor(name, secretsDir, files) {
    this.name = name;
    this.secretsDir = secretsDir;
    this.baseFiles = files;
    this.files = files;
  }
  get envFile() {
    return path.join(this.secretsDir, 'compose.env');
  }
  /** The compose environment an operator sets once on the host (instead of -p / -f / --env-file). */
  composeEnv(extra = {}) {
    return { COMPOSE_PROJECT_NAME: this.name, COMPOSE_FILE: this.files.join(';'), COMPOSE_PATH_SEPARATOR: ';', COMPOSE_ENV_FILES: this.envFile, ...extra };
  }
  compose(args, opts = {}) {
    return run('docker', ['compose', ...args], { ...opts, env: { ...this.composeEnv(), ...(opts.env ?? {}) } });
  }
  /** THE documented deploy, exactly: `docker compose pull && docker compose up -d`. */
  deploy(timeoutMs = 1_500_000) {
    const t0 = Date.now();
    const r = run('bash', ['-c', 'docker compose pull && docker compose up -d'], { env: this.composeEnv(), timeout: timeoutMs });
    return { ...r, ms: Date.now() - t0 };
  }
  container(service) {
    return `${this.name}-${service}-1`;
  }
  inspect(service, fmt) {
    const r = run('docker', ['inspect', '-f', fmt, this.container(service)]);
    return r.code === 0 ? r.stdout.trim() : '';
  }
  health(service) {
    return this.inspect(service, '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{.State.Status}}|{{.State.ExitCode}}|{{.RestartCount}}');
  }
  async waitHealthy(service, timeoutMs) {
    return waitFor(`${service} healthy`, () => this.health(service).startsWith('healthy|'), timeoutMs);
  }
  psql(sql) {
    // The bundled db is SCRAM on its socket too: the superuser password (PG_DATABASE_PASSWORD) via the exec environment.
    const r = run('docker', ['exec', '-i', '-e', 'PGPASSWORD', this.container('db'), 'psql', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'crewflow'], { input: sql, env: { PGPASSWORD: secrets.dbPassword }, timeout: 120_000 });
    if (r.code !== 0) throw new Error(`psql failed (${r.code}): ${redact(r.out).slice(0, 600)}`);
    return r.stdout.trim();
  }
  redis(args) {
    return run('docker', ['exec', '-e', 'REDISCLI_AUTH', this.container('rab-redis'), 'redis-cli', '--no-auth-warning', '--user', 'crewflow', ...args], {
      env: { REDISCLI_AUTH: secrets.redis },
      timeout: 60_000,
    });
  }
  /** Every BullMQ job scheduler id: the `<prefix>:<queue>:repeat` sorted sets and their members. */
  schedulers() {
    const keys = new Set();
    let cursor = '0';
    do {
      const r = this.redis(['SCAN', cursor, 'MATCH', '*:repeat', 'COUNT', '1000']);
      if (r.code !== 0) throw new Error(`redis SCAN failed: ${redact(r.out)}`);
      const lines = r.stdout.trim().split('\n');
      cursor = lines[0].trim();
      for (const k of lines.slice(1)) if (k.trim()) keys.add(k.trim());
    } while (cursor !== '0');
    const out = [];
    for (const key of [...keys].sort()) {
      if (this.redis(['TYPE', key]).stdout.trim() !== 'zset') continue;
      for (const m of this.redis(['ZRANGE', key, '0', '-1']).stdout.trim().split('\n').filter(Boolean)) out.push(`${key}|${m.trim()}`);
    }
    return out.sort();
  }
  healthz() {
    const r = run('docker', ['exec', this.container('rab-api'), 'wget', '-qO-', 'http://localhost:3000/healthz'], { timeout: 30_000 });
    return { code: r.code, body: r.stdout.trim() };
  }
  logs(service) {
    return run('docker', ['logs', this.container(service)], { timeout: 60_000 }).out;
  }
  /** Container events of this project between two unix-second marks, oldest first. */
  events(since, until) {
    const r = run('docker', ['events', '--since', String(since), '--until', String(until), '--filter', `label=com.docker.compose.project=${this.name}`, '--filter', 'type=container', '--format', '{{json .}}']);
    return r.stdout
      .split('\n')
      .filter((l) => l.trim().startsWith('{'))
      .map((l) => JSON.parse(l))
      .map((e) => ({ t: BigInt(e.timeNano), action: e.Action, service: e.Actor?.Attributes?.['com.docker.compose.service'], id: String(e.Actor?.ID ?? e.id ?? '').slice(0, 12), image: e.Actor?.Attributes?.image }))
      .sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  }
  down() {
    // This run's own disposable project only: its containers, networks and its OWN named volumes (the bundled db's).
    return this.compose(['down', '--timeout', '60', '--remove-orphans', '--volumes'], { timeout: 300_000 });
  }
}

async function waitFor(label, fn, timeoutMs, everyMs = 3000) {
  const t0 = Date.now();
  for (;;) {
    let v;
    try {
      v = await fn();
    } catch {
      v = false;
    }
    if (v) return Date.now() - t0;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${label} (${Math.round(timeoutMs / 1000)} s)`);
    await sleep(everyMs);
  }
}

/** Peak number of THIS run's running containers (its projects + the local registry), sampled every 2 s. */
function startPeakSampler(projects) {
  const names = projects.map((p) => p.name);
  const timer = setInterval(() => {
    const r = run('docker', ['ps', '--format', '{{.Names}}|{{.Label "com.docker.compose.project"}}'], { timeout: 20_000 });
    const mine = r.stdout
      .split('\n')
      .filter(Boolean)
      .filter((l) => {
        const [n, proj] = l.split('|');
        return n === REGISTRY_CONTAINER || names.includes(proj);
      })
      .map((l) => l.split('|')[0]);
    if (mine.length > peak.count) peak = { count: mine.length, at: new Date().toISOString(), names: mine };
  }, 2000);
  timer.unref();
  return () => clearInterval(timer);
}

// ------------------------------------------------------------------------------------------------------------ secrets
/** Secrets and env files from the SHIPPED templates (upgrade-lib.cjs; SMTP and S3 point at names that do not resolve). */
function writeSecrets(dir, opts = {}) {
  L.writeSecrets(dir, opts);
}
/** compose.env with the pass-through crewflow_owner URL; a pre-DB-SETUP PREV digest also gets its own rab-worker command. */
function writeComposeEnv(project, digest) {
  project.files = [...project.baseFiles, ...(PREV_PRE_DB_SETUP && digest === PREV ? [PREV_OVERLAY] : [])];
  L.writeComposeEnv(project, { repository: REPO, digest, pgImage: process.env.DOT_PG_IMAGE, redisImage: process.env.DOT_REDIS_IMAGE });
}

// ------------------------------------------------------------------------------------------------------------- cases
async function step(id, title, fn, project) {
  if (ONLY.length && !ONLY.includes(id)) return;
  const r = { id, title, status: 'NOT RUN', checks: [], notes: [] };
  results.push(r);
  note(`=== ${id} ${title}`);
  const check = (ok, what) => {
    r.checks.push({ ok: Boolean(ok), what: redact(what) });
    note(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`);
    return Boolean(ok);
  };
  try {
    await fn(check, (n) => {
      r.notes.push(redact(n));
      note(`  note: ${n}`);
    });
    r.status = r.checks.length && r.checks.every((c) => c.ok) ? 'PASS' : 'FAIL';
  } catch (e) {
    r.status = 'FAIL';
    r.checks.push({ ok: false, what: `threw: ${redact(e && e.message ? e.message : String(e))}` });
    note(`  FAIL threw: ${e && e.message ? e.message : e}`);
    if (project) for (const svc of ['rab-api', 'rab-worker']) evidence(`${id}-failure-${svc}.log`, run('docker', ['logs', '--tail', '400', project.container(svc)]).out);
  }
  note(`=== ${id} ${r.status}`);
  fs.writeFileSync(path.join(OUT, 'RESULTS.json'), JSON.stringify({ major: MAJOR, prev: PREV, next: NEW, peak, results }, null, 2));
}

const iso = (ns) => new Date(Number(ns / 1_000_000n)).toISOString().replace('Z', `${String(ns % 1_000_000n).padStart(6, '0')}Z`);
const fmtEvents = (evs) => evs.map((e) => `${iso(e.t)} ${e.action.padEnd(24)} ${String(e.service).padEnd(12)} ${e.id} ${e.image ?? ''}`).join('\n');
const nowS = () => Math.floor(Date.now() / 1000);
const imageRef = (digest) => `${REPO}@${digest}`;

/** The image reference each app container was created from, and its id. */
function appState(p) {
  const out = {};
  for (const s of ['rab-api', 'rab-worker']) out[s] = { id: p.inspect(s, '{{.Id}}').slice(0, 12), image: p.inspect(s, '{{.Config.Image}}'), started: p.inspect(s, '{{.State.StartedAt}}'), health: p.health(s) };
  return out;
}

/** Ordering proof for a REDEPLOY: the old Worker died before the new API started, and the new Worker started after the new API was healthy. */
function redeployOrder(check, evs, before, after) {
  const find = (action, id) => evs.find((e) => e.action === action && e.id === id);
  const oldWorkerDie = find('die', before['rab-worker'].id);
  const oldApiDie = find('die', before['rab-api'].id);
  const newApiStart = find('start', after['rab-api'].id);
  const newApiHealthy = evs.find((e) => e.action.startsWith('health_status: healthy') && e.id === after['rab-api'].id);
  const newWorkerStart = find('start', after['rab-worker'].id);
  check(Boolean(oldWorkerDie && oldApiDie && newApiStart && newApiHealthy && newWorkerStart), 'events: old Worker die, old API die, new API start, new API healthy, new Worker start all recorded');
  if (!(oldWorkerDie && newApiStart && newApiHealthy && newWorkerStart)) return {};
  check(oldWorkerDie.t < newApiStart.t, `the OLD Worker died (${iso(oldWorkerDie.t)}) BEFORE the NEW API started (${iso(newApiStart.t)}): no old Worker beside the new API`);
  check(newApiHealthy.t < newWorkerStart.t, `the NEW API was healthy (${iso(newApiHealthy.t)}) BEFORE the NEW Worker started (${iso(newWorkerStart.t)})`);
  return { oldWorkerDie: iso(oldWorkerDie.t), oldApiDie: oldApiDie ? iso(oldApiDie.t) : null, newApiStart: iso(newApiStart.t), newApiHealthy: iso(newApiHealthy.t), newWorkerStart: iso(newWorkerStart.t) };
}

async function main() {
  L.newSecrets();
  const main = new Project(`${PREFIX}-pg${MAJOR}`, path.join(OUT, 'secrets'), ['docker-compose.image.yml', OVERLAY, OWNER_OVERLAY]);
  const t4 = new Project(`${PREFIX}-pg${MAJOR}-t4`, path.join(OUT, 'secrets-t4'), ['docker-compose.image.yml', OVERLAY, OWNER_OVERLAY, T4_OVERLAY]);
  const stopSampler = startPeakSampler([main, t4]);
  note(`projects ${main.name}, ${t4.name}; PostgreSQL ${process.env.DOT_PG_IMAGE}; previous ${imageRef(PREV)}; new ${imageRef(NEW)}`);
  writeSecrets(main.secretsDir);
  const state = {};

  // ------------------------------------------------------------------------------------------------------------ T1
  await step('T1', 'fresh deploy (previous digest) with the one command: rab-api healthy BEFORE rab-worker starts', async (check, n) => {
    writeComposeEnv(main, PREV);
    const since = nowS() - 1;
    const d = main.deploy();
    evidence('T1-deploy.log', d.out);
    check(d.code === 0, `\`docker compose pull && docker compose up -d\` exit ${d.code} after ${Math.round(d.ms / 1000)} s`);
    await main.waitHealthy('rab-api', 120_000);
    await main.waitHealthy('rab-worker', 300_000);
    const evs = main.events(since, nowS() + 1);
    evidence('T1-events.txt', fmtEvents(evs));
    const after = appState(main);
    state.t1 = after;
    const apiHealthy = evs.find((e) => e.action.startsWith('health_status: healthy') && e.service === 'rab-api');
    const workerStart = evs.find((e) => e.action === 'start' && e.service === 'rab-worker');
    const workerCreate = evs.find((e) => e.action === 'create' && e.service === 'rab-worker');
    check(Boolean(apiHealthy && workerStart), 'events: rab-api healthy and rab-worker start recorded');
    if (apiHealthy && workerStart) {
      check(apiHealthy.t < workerStart.t, `rab-api healthy ${iso(apiHealthy.t)} BEFORE rab-worker started ${iso(workerStart.t)} (+${Number((workerStart.t - apiHealthy.t) / 1_000_000n)} ms)`);
      n(`rab-worker container was created at ${workerCreate ? iso(workerCreate.t) : '?'} but only STARTED after the API was healthy`);
    }
    const apiStartedAt = new Date(after['rab-api'].started).getTime();
    const workerStartedAt = new Date(after['rab-worker'].started).getTime();
    check(workerStartedAt > apiStartedAt, `inspect: rab-api StartedAt ${after['rab-api'].started} < rab-worker StartedAt ${after['rab-worker'].started}`);
    for (const s of ['rab-api', 'rab-worker']) check(after[s].image === imageRef(PREV), `${s} runs ${after[s].image}`);
    const pg = main.psql('SHOW server_version_num');
    check(pg.startsWith(MAJOR), `PostgreSQL major ${MAJOR} (server_version_num ${pg})`);
    const hz = main.healthz();
    check(hz.code === 0 && /"upgradeFailed":\s*false/.test(hz.body), `/healthz answers with upgradeFailed:false (${hz.body.slice(0, 160)})`);
    state.prevLedger = main.psql('SELECT count(*) FROM core.migrations');
    n(`ledger after the fresh install: ${state.prevLedger} migrations`);
    const scheds = main.schedulers();
    state.prevSchedulers = scheds;
    evidence('T1-schedulers.txt', scheds.join('\n'));
    check(scheds.length > 0, `the API registered ${scheds.length} BullMQ job schedulers`);
    const wl = main.logs('rab-worker');
    evidence('T1-worker.log', wl);
    evidence('T1-api.log', main.logs('rab-api'));
    check(/consume only, DISABLE_CRON_JOBS_REGISTRATION=true\): all \d+ enabled Crewflow schedulers present/.test(wl), 'the Worker found every scheduler present (consume only, registers none)');
  }, main);

  // ------------------------------------------------------------------------------------------------------------ T2
  await step('T2', 'deploy the NEW digest with the same command: both recreated on the same new digest; the old Worker stops before the new API starts; the new Worker runs the new code', async (check, n) => {
    const before = appState(main);
    writeComposeEnv(main, NEW);
    const since = nowS() - 1;
    const d = main.deploy();
    evidence('T2-deploy.log', d.out);
    check(d.code === 0, `\`docker compose pull && docker compose up -d\` exit ${d.code} after ${Math.round(d.ms / 1000)} s`);
    await main.waitHealthy('rab-api', 120_000);
    await main.waitHealthy('rab-worker', 300_000);
    const evs = main.events(since, nowS() + 1);
    evidence('T2-events.txt', fmtEvents(evs));
    const after = appState(main);
    state.t2 = after;
    for (const s of ['rab-api', 'rab-worker']) {
      check(after[s].id !== before[s].id, `${s} recreated (${before[s].id} -> ${after[s].id})`);
      check(after[s].image === imageRef(NEW), `${s} runs the NEW digest ${after[s].image}`);
    }
    state.t2order = redeployOrder(check, evs, before, after);
    const ledger = main.psql('SELECT count(*) FROM core.migrations');
    n(`ledger: ${state.prevLedger} -> ${ledger} migrations (the new API migrated on start)`);
    check(Number(ledger) > Number(state.prevLedger), 'the new API applied the new release\'s migrations on start');
    const scheds = main.schedulers();
    evidence('T2-schedulers.txt', scheds.join('\n'));
    check(scheds.length >= state.prevSchedulers.length, `schedulers after the new API: ${scheds.length} (before ${state.prevSchedulers.length})`);
    // The new Worker runs the new code for a SCHEDULED job: queue one email row (as the superuser, the way an API write
    // would leave it), then the email dispatch sweep (scheduler, every 30 s) claims it on the NEW Worker, whose result line
    // carries generationsExhausted= (only the new release prints that field, PR #89).
    const outbox = queueProbeEmail(main);
    n(`queued probe email_outbox row ${outbox}`);
    const ms = await waitFor('the new Worker to claim the probe email', () => /email dispatch: claimed=\d+ .*generationsExhausted=\d+/.test(main.logs('rab-worker')), 180_000, 5000);
    const wl = main.logs('rab-worker');
    evidence('T2-worker.log', wl);
    evidence('T2-api.log', main.logs('rab-api'));
    const line = (wl.match(/.*email dispatch: claimed=\d+ .*generationsExhausted=\d+.*/) || [''])[0];
    check(Boolean(line), `the NEW Worker ran the scheduled email dispatch with the new code after ${Math.round(ms / 1000)} s: ${line.trim().slice(0, 220)}`);
    check(/consume only, DISABLE_CRON_JOBS_REGISTRATION=true\): all \d+ enabled Crewflow schedulers present/.test(wl), 'the new Worker found every scheduler present');
    const row = main.psql(`SELECT status || '|' || dispatch_generation FROM core.email_outbox WHERE id = '${outbox}'`);
    n(`probe row now: status|generation = ${row}`);
    check(!row.startsWith('PENDING|'), `the probe row left PENDING: claimed by the new Worker (${row})`);
  }, main);

  // ------------------------------------------------------------------------------------------------------------ T3
  await step('T3', 'rollback to the previous digest with the same command: both go back together; the old API warns the schema is AHEAD and serves', async (check, n) => {
    const before = appState(main);
    writeComposeEnv(main, PREV);
    const since = nowS() - 1;
    const d = main.deploy();
    evidence('T3-deploy.log', d.out);
    check(d.code === 0, `\`docker compose pull && docker compose up -d\` exit ${d.code} after ${Math.round(d.ms / 1000)} s`);
    await main.waitHealthy('rab-api', 300_000);
    await main.waitHealthy('rab-worker', 300_000);
    const evs = main.events(since, nowS() + 1);
    evidence('T3-events.txt', fmtEvents(evs));
    const after = appState(main);
    state.t3 = after;
    for (const s of ['rab-api', 'rab-worker']) {
      check(after[s].id !== before[s].id, `${s} recreated (${before[s].id} -> ${after[s].id})`);
      check(after[s].image === imageRef(PREV), `${s} back on the PREVIOUS digest ${after[s].image}`);
    }
    state.t3order = redeployOrder(check, evs, before, after);
    const al = main.logs('rab-api');
    evidence('T3-api.log', al);
    evidence('T3-worker.log', main.logs('rab-worker'));
    const ahead = (al.match(/.*\bAHEAD\b.*/i) || al.match(/.*schema.*ahead.*/i) || [''])[0];
    check(Boolean(ahead), `the old API warned that the schema is ahead: ${ahead.trim().slice(0, 240)}`);
    const hz = main.healthz();
    check(hz.code === 0, `the old API serves: /healthz ${hz.body.slice(0, 160)}`);
  }, main);

  if (!KEEP) {
    const r = main.down();
    note(`cleanup ${main.name}: compose down exit ${r.code}`);
  }

  // ------------------------------------------------------------------------------------------------------------ T4
  await step('T4', 'an API that fails its health check: the Worker never starts and compose reports the dependency failure', async (check, n) => {
    if (KEEP && !ONLY.includes('T4')) {
      n('skipped: --keep leaves the T1-T3 stack running and T4 would exceed the container cap');
      check(false, 'T4 not run because of --keep');
      return;
    }
    writeSecrets(t4.secretsDir, { expectedDatabase: 'crewflow_wrong_on_purpose' });
    writeComposeEnv(t4, NEW);
    n('the T4 database.env names PG_EXPECTED_DATABASE_NAME=crewflow_wrong_on_purpose (the API refuses to start on it); the T4 overlay shortens the API health window only');
    const since = nowS() - 1;
    const d = t4.deploy(900_000);
    evidence('T4-deploy.log', d.out);
    check(d.code !== 0, `\`docker compose pull && docker compose up -d\` FAILED as it must (exit ${d.code}) after ${Math.round(d.ms / 1000)} s`);
    const msg = (d.out.match(/.*dependency failed to start.*|.*is unhealthy.*|.*exited \(\d+\).*/i) || [''])[0];
    check(Boolean(msg), `compose reported the dependency failure: ${msg.trim().slice(0, 200)}`);
    await sleep(15_000);
    const workerStarted = t4.inspect('rab-worker', '{{.State.StartedAt}}');
    const workerStatus = t4.inspect('rab-worker', '{{.State.Status}}');
    check(!workerStarted || workerStarted.startsWith('0001-01-01'), `rab-worker NEVER started (State.StartedAt=${workerStarted || '(no container)'}, status=${workerStatus || 'none'})`);
    const evs = t4.events(since, nowS() + 1);
    evidence('T4-events.txt', fmtEvents(evs));
    check(!evs.some((e) => e.service === 'rab-worker' && e.action === 'start'), 'no rab-worker start event');
    check(!evs.some((e) => e.service === 'rab-api' && e.action.startsWith('health_status: healthy')), 'rab-api never became healthy');
    n(`rab-api: ${t4.health('rab-api')}`);
    const al = run('docker', ['logs', '--tail', '200', t4.container('rab-api')]).out;
    evidence('T4-api.log', al);
    const refusal = (al.match(/.*(PG_EXPECTED_DATABASE_NAME|expected database|crewflow_wrong_on_purpose).*/i) || [''])[0];
    n(`API refusal line: ${refusal.trim().slice(0, 240)}`);
  }, t4);
  if (!KEEP) {
    const r = t4.down();
    note(`cleanup ${t4.name}: compose down exit ${r.code}`);
  }

  stopSampler();
  note(`peak of this run's running containers: ${peak.count} at ${peak.at} (${peak.names.join(', ')})`);
  fs.writeFileSync(path.join(OUT, 'RESULTS.json'), JSON.stringify({ major: MAJOR, prev: PREV, next: NEW, peak, order: { t2: state.t2order, t3: state.t3order }, results }, null, 2));
  const summary = [
    `# Deploy-order tests, PostgreSQL ${MAJOR}`,
    '',
    `previous \`${imageRef(PREV)}\`, new \`${imageRef(NEW)}\`; command \`docker compose pull && docker compose up -d\``,
    `peak running containers of this run: ${peak.count} (cap ${MAX_CONTAINERS})`,
    '',
    '| case | status | checks |',
    '|---|---|---|',
    ...results.map((r) => `| ${r.id} | ${r.status} | ${r.checks.filter((c) => c.ok).length}/${r.checks.length} |`),
    '',
    ...results.flatMap((r) => [`## ${r.id} ${r.status}: ${r.title}`, ...r.checks.map((c) => `- ${c.ok ? 'ok' : '**FAIL**'} ${c.what}`), ...r.notes.map((x) => `- note: ${x}`), '']),
  ].join('\n');
  fs.writeFileSync(path.join(OUT, 'SUMMARY.md'), summary);
  fs.writeFileSync(path.join(OUT, 'run.log'), logLines.join('\n'));
  if (peak.count > MAX_CONTAINERS) note(`CONTAINER CAP EXCEEDED: ${peak.count} > ${MAX_CONTAINERS}`);
  process.exitCode = results.every((r) => r.status === 'PASS') && peak.count <= MAX_CONTAINERS ? 0 : 1;
}

/**
 * One PENDING email_outbox row (and a throwaway organisation for it), inserted as the superuser: the state an API write
 * leaves. The recipient is an .invalid address and SMTP does not resolve, so nothing is ever delivered; the row only has to
 * be CLAIMED by the scheduled dispatch sweep.
 */
function queueProbeEmail(p) {
  const slug = `deploy-order-probe-${hex(4)}`;
  return p
    .psql(
      `WITH o AS (INSERT INTO core.organisation (name, slug) VALUES ('Deploy-order probe', '${slug}') RETURNING id)
       INSERT INTO core.email_outbox (organisation_id, job_type, status, recipient_email, rendered_subject, rendered_text)
       SELECT id, 'NOTIFICATION', 'PENDING', 'probe@deploy-order.invalid', 'Deploy-order probe', 'probe' FROM o RETURNING id;`,
    )
    .split('\n')
    .pop()
    .trim();
}

main().catch((e) => {
  console.error(redact(e && e.stack ? e.stack : String(e)));
  process.exit(1);
});
