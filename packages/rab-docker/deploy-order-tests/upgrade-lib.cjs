'use strict';
/**
 * Deploy-order real-container tests (TEST-ONLY): the shared machinery of run-upgrade-with-data-tests.cjs. One disposable
 * Compose project per case, the production files UNCHANGED (docker-compose.image.yml + docker-compose.local-db.yml) plus the
 * test-only infrastructure overlay(s) of this folder, deployed with THE documented command `docker compose pull && docker
 * compose up -d`. Secrets are generated per run under <out>/secrets-<project> (outside the repository), reach the
 * containers only through env files, and every captured output is redacted before it is written or printed.
 *
 * (run-deploy-order-tests.cjs, the PR #90 T1-T4 driver, keeps its own copy of the same helpers unchanged.)
 */
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const RD = path.resolve(__dirname, '..'); // packages/rab-docker
const OVERLAY = 'deploy-order-tests/docker-compose.deploy-order.yml';
const SHORT_HEALTH_OVERLAY = 'deploy-order-tests/docker-compose.deploy-order-t4.yml';
const MIGRATION_LOCK_KEY_SQL = "x'637265776d696772'::bigint";

const secrets = {};
const hex = (n) => crypto.randomBytes(n).toString('hex');
const b64 = (n) => crypto.randomBytes(n).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, Math.ceil((n * 4) / 3) - 2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowS = () => Math.floor(Date.now() / 1000);

function newSecrets() {
  Object.assign(secrets, { superuser: hex(24), owner: hex(32), redis: hex(24), appSecret: b64(48), smtp: hex(16), s3key: hex(8), s3secret: hex(24) });
  return secrets;
}

function redact(text) {
  let s = String(text ?? '');
  for (const v of Object.values(secrets)) if (v && v.length >= 8) s = s.split(v).join('<redacted>');
  return s.replace(/postgres(ql)?:\/\/[^\s'"]+/g, 'postgres://<redacted>').replace(/rediss?:\/\/[^\s'"]+/g, 'redis://<redacted>');
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

/** The same, without blocking the event loop (a deploy that must be interrupted, two racing children). */
function runAsync(cmd, args, opts = {}) {
  const child = spawn(cmd, args, { cwd: opts.cwd ?? RD, env: { ...process.env, MSYS_NO_PATHCONV: '1', ...(opts.env ?? {}) }, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (b) => (out += b.toString('utf8')));
  child.stderr.on('data', (b) => (out += b.toString('utf8')));
  const done = new Promise((resolve) => child.on('close', (code) => resolve({ code: code ?? -1, out })));
  return { child, done, output: () => out };
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

class Project {
  constructor(name, out, { shortHealth = false } = {}) {
    this.name = name;
    this.secretsDir = path.join(out, `secrets-${name}`);
    this.setShortHealth(shortHealth);
  }
  /** The T4 overlay: an API health window of about a minute (refusal cases), instead of the production 900 s start period. */
  setShortHealth(on) {
    this.files = ['docker-compose.image.yml', 'docker-compose.local-db.yml', OVERLAY, ...(on ? [SHORT_HEALTH_OVERLAY] : [])];
  }
  get envFile() {
    return path.join(this.secretsDir, 'compose.env');
  }
  composeEnv(extra = {}) {
    return { COMPOSE_PROJECT_NAME: this.name, COMPOSE_FILE: this.files.join(';'), COMPOSE_PATH_SEPARATOR: ';', COMPOSE_ENV_FILES: this.envFile, ...extra };
  }
  compose(args, opts = {}) {
    return run('docker', ['compose', ...args], { ...opts, env: { ...this.composeEnv(), ...(opts.env ?? {}) } });
  }
  composeAsync(args) {
    return runAsync('docker', ['compose', ...args], { env: this.composeEnv() });
  }
  /** THE documented deploy, exactly. */
  deploy(timeoutMs = 1_500_000) {
    const t0 = Date.now();
    const r = run('bash', ['-c', 'docker compose pull && docker compose up -d'], { env: this.composeEnv(), timeout: timeoutMs });
    return { ...r, ms: Date.now() - t0 };
  }
  deployAsync() {
    return runAsync('bash', ['-c', 'docker compose pull && docker compose up -d'], { env: this.composeEnv() });
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
  /** Never started: no container, or StartedAt is the zero time. */
  neverStarted(service) {
    const s = this.inspect(service, '{{.State.StartedAt}}');
    return !s || s.startsWith('0001-01-01');
  }
  /** psql as the PostgreSQL superuser (local socket, peer), database crewflow. */
  psql(sql, { db = 'crewflow' } = {}) {
    const r = run('docker', ['exec', '-i', this.container('rab-postgres'), 'psql', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', db], { input: sql, timeout: 300_000 });
    if (r.code !== 0) throw new Error(`psql failed (${r.code}): ${redact(r.out).slice(0, 800)}`);
    return r.stdout.trim();
  }
  psqlFile(file) {
    return this.psql(fs.readFileSync(path.join(__dirname, file), 'utf8'));
  }
  /** psql as crewflow_owner over TLS (the runtime login), for the RLS checks. */
  psqlOwner(sql) {
    const r = run(
      'docker',
      ['exec', '-i', '-e', 'PGPASSWORD', this.container('rab-postgres'), 'psql', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', 'host=127.0.0.1 sslmode=require dbname=crewflow user=crewflow_owner'],
      { input: sql, env: { PGPASSWORD: secrets.owner }, timeout: 120_000 },
    );
    if (r.code !== 0) throw new Error(`psql (owner) failed (${r.code}): ${redact(r.out).slice(0, 800)}`);
    return r.stdout.trim();
  }
  /** An idle superuser transaction holding `lockSql` until release() (stdin kept open; no statement keeps a snapshot). */
  async holdLock(lockSql) {
    const h = runAsync('docker', ['exec', '-i', this.container('rab-postgres'), 'psql', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'crewflow']);
    h.child.stdin.write(`SELECT 'holder-pid|' || pg_backend_pid();\nBEGIN;\n${lockSql};\nSELECT 'holder-ready';\n`);
    await waitFor('the lock holder', () => /holder-ready/.test(h.output()), 60_000, 500);
    const pid = (h.output().match(/holder-pid\|(\d+)/) || [])[1];
    let released = false;
    return {
      pid,
      release: async () => {
        if (released) return;
        released = true;
        h.child.stdin.end('ROLLBACK;\n\\q\n');
        await Promise.race([h.done, sleep(15_000)]);
        if (pid) this.psql(`SELECT pg_terminate_backend(${Number(pid)}) FROM pg_stat_activity WHERE pid = ${Number(pid)}`);
      },
    };
  }
  redis(args) {
    return run('docker', ['exec', '-e', 'REDISCLI_AUTH', this.container('rab-redis'), 'redis-cli', '--no-auth-warning', '--user', 'crewflow', ...args], {
      env: { REDISCLI_AUTH: secrets.redis },
      timeout: 60_000,
    });
  }
  healthz() {
    const r = run('docker', ['exec', this.container('rab-api'), 'wget', '-qO-', 'http://localhost:3000/healthz'], { timeout: 30_000 });
    return { code: r.code, body: r.stdout.trim() };
  }
  logs(service) {
    return run('docker', ['logs', this.container(service)], { timeout: 60_000 }).out;
  }
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
    // This run's own disposable project only (no volumes exist: every data dir is a tmpfs). Never a prune.
    return this.compose(['down', '--timeout', '60', '--remove-orphans'], { timeout: 300_000 });
  }
}

function ossl(dir, args) {
  const r = run('openssl', args, { cwd: dir });
  if (r.code !== 0) throw new Error(`openssl ${args[0]} failed: ${r.out.slice(0, 400)}`);
}

/** Secrets, TLS and the two env files from the SHIPPED templates (env/*.env.example), as run-deploy-order-tests.cjs does. */
function writeSecrets(dir) {
  fs.mkdirSync(path.join(dir, 'pg-tls'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'postgres-superuser-password'), secrets.superuser);
  fs.writeFileSync(path.join(dir, 'crewflow-owner-password'), secrets.owner);
  const acl = fs
    .readFileSync(path.join(RD, 'env/redis-users.acl.example'), 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('#'))
    .map((l) => l.replace('<sha256-hex-of-the-redis-app-password>', crypto.createHash('sha256').update(secrets.redis).digest('hex')))
    .join('\n');
  fs.writeFileSync(path.join(dir, 'redis-users.acl'), `${acl}\n`);
  const tls = path.join(dir, 'pg-tls');
  ossl(tls, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=deploy-order test CA', '-keyout', 'ca.key', '-out', 'ca.crt']);
  ossl(tls, ['req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=rab-postgres', '-keyout', 'server.key', '-out', 'server.csr']);
  fs.writeFileSync(path.join(tls, 'ext.cnf'), 'subjectAltName=DNS:rab-postgres\nextendedKeyUsage=serverAuth\n');
  ossl(tls, ['x509', '-req', '-in', 'server.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '2', '-extfile', 'ext.cnf', '-out', 'server.crt']);
  fs.copyFileSync(path.join(tls, 'ca.crt'), path.join(dir, 'pg-ca.crt'));
  for (const f of ['ca.key', 'server.csr', 'ext.cnf', 'ca.srl']) fs.rmSync(path.join(tls, f), { force: true });
  const host = 'deploy-order.example.com';
  const values = {
    '<crewflow_owner-password>': secrets.owner,
    '<db-direct-host>': 'rab-postgres',
    '<db-name>': 'crewflow',
    '<redis-app-password>': secrets.redis,
    '<app-secret>': secrets.appSecret,
    '<app-host>': host,
    '<edge-proxy-cidr>': '10.255.255.1/32',
    '<smtp-host>': 'smtp.deploy-order.invalid',
    '<smtp-user>': 'dot',
    '<smtp-password>': secrets.smtp,
    '<sender-address>': `Crewflow deploy-order <no-reply@${host}>`,
    '<bucket>': 'dot',
    '<region-or-auto>': 'eu-west-2',
    'https://<s3-compatible-endpoint>': 'http://s3.deploy-order.invalid:9000',
    '<bucket-scoped-key-id>': `dot${secrets.s3key}`,
    '<bucket-scoped-secret>': secrets.s3secret,
  };
  const lineOverrides = { EMAIL_SMTP_PORT: '2525' };
  for (const name of ['database.env', 'runtime.env']) {
    const out = [];
    for (const raw of fs.readFileSync(path.join(RD, 'env', `${name}.example`), 'utf8').split(/\r?\n/)) {
      if (!raw.trim() || raw.trim().startsWith('#')) continue;
      let line = raw;
      for (const [k, v] of Object.entries(values)) line = line.split(k).join(v);
      const key = line.split('=')[0];
      if (lineOverrides[key] !== undefined) line = `${key}=${lineOverrides[key]}`;
      if (/<[a-z0-9_-]+>/i.test(line)) throw new Error(`template ${name}: unfilled placeholder in ${key}`);
      out.push(line);
    }
    fs.writeFileSync(path.join(dir, name), `${out.join('\n')}\n`);
  }
}

function writeComposeEnv(project, { repository, digest, pgImage, redisImage }) {
  const S = project.secretsDir.replace(/\\/g, '/');
  const lines = {
    CREWFLOW_IMAGE_REPOSITORY: repository,
    CREWFLOW_IMAGE_TAG: digest,
    CREWFLOW_REDIS_IMAGE: redisImage,
    CREWFLOW_POSTGRES_IMAGE: pgImage,
    CREWFLOW_SECRETS_DIR: S,
    CREWFLOW_PG_CA_FILE: `${S}/pg-ca.crt`,
    CREWFLOW_API_MEM_LIMIT: '1024m',
    CREWFLOW_API_CPUS: '2',
    CREWFLOW_WORKER_MEM_LIMIT: '1536m',
    CREWFLOW_WORKER_CPUS: '2',
    CREWFLOW_REDIS_MAXMEMORY: '128mb',
    CREWFLOW_POSTGRES_MEM_LIMIT: '768m',
    CREWFLOW_POSTGRES_CPUS: '2',
  };
  fs.writeFileSync(project.envFile, `${Object.entries(lines).map(([k, v]) => `${k}=${v}`).join('\n')}\n`);
}

const iso = (ns) => new Date(Number(ns / 1_000_000n)).toISOString().replace('Z', `${String(ns % 1_000_000n).padStart(6, '0')}Z`);
const fmtEvents = (evs) => evs.map((e) => `${iso(e.t)} ${e.action.padEnd(24)} ${String(e.service).padEnd(12)} ${e.id} ${e.image ?? ''}`).join('\n');

module.exports = {
  MIGRATION_LOCK_KEY_SQL,
  Project,
  b64,
  fmtEvents,
  hex,
  iso,
  newSecrets,
  nowS,
  redact,
  run,
  runAsync,
  secrets,
  sleep,
  waitFor,
  writeComposeEnv,
  writeSecrets,
};
