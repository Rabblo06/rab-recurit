'use strict';
/**
 * Deploy-order real-container tests (TEST-ONLY): the shared machinery of run-upgrade-with-data-tests.cjs and
 * run-db-setup-tests.cjs. One disposable Compose project per case, the production file docker-compose.image.yml UNCHANGED
 * (with its bundled `db` service, DB-SETUP) plus the test-only overlay(s) of this folder, deployed with THE documented
 * command `docker compose pull && docker compose up -d`. Secrets are generated per run under <out>/secrets-<project>
 * (outside the repository), reach the containers only through env files, and every captured output is redacted before it
 * is written or printed.
 *
 * DB-SETUP (docker-compose.local-db.yml retired, D3): the database is the production file's own `db` service. The
 * pass-through scenarios (an existing crewflow_owner, as every R254/R256 deployment has) add OWNER_OVERLAY, which runs the
 * shipped hand-made fallback 01-crewflow-owner.sql at the db's first start, and give the crewflow_owner URL as the compose
 * interpolation value PG_DATABASE_URL. PR #125, the Twenty Helm way (OWNER-DB-FINAL.md Part A, 2026-11-13):
 * PG_DATABASE_URL is the ONE database setting (an admin URL, an existing crewflow_owner URL, or unset = the bundled db) and
 * is interpolated into the one-shot db-setup ONLY. db-setup keeps crewflow_owner's password in a file on its setup volume
 * (OWNER_PASSWORD_FILE, 0400 1000:1000; random for the bundled db / an admin URL, the URL's own password for a crewflow_owner
 * URL, which is never changed); rab-api / rab-worker pin `PG_DATABASE_URL: ""` and build the crewflow_owner URL from the
 * credential-free target file + that password file, both mounted read-only. Project.readPasswordFile() reads it into
 * memory only (registered for redaction, never printed); Project.ownerPasswordNow() finds the password that logs in. An
 * image older than DB-SETUP has no worker-start.sh: its deploys add PREV_OVERLAY, the previous release's own start-up,
 * which also gives its rab-api / rab-worker the PG_DATABASE_URL interpolation value back, as that release's compose files did.
 *
 * (run-deploy-order-tests.cjs, the PR #90 T1-T4 driver, keeps its own copy of the same helpers.)
 */
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const RD = path.resolve(__dirname, '..'); // packages/rab-docker
const BASE = 'docker-compose.image.yml';
const OVERLAY = 'deploy-order-tests/docker-compose.deploy-order.yml';
const OWNER_OVERLAY = 'deploy-order-tests/docker-compose.deploy-order-owner.yml';
const PREV_OVERLAY = 'deploy-order-tests/docker-compose.deploy-order-prev.yml';
const SHORT_HEALTH_OVERLAY = 'deploy-order-tests/docker-compose.deploy-order-t4.yml';
const DB_SERVICE = 'db';
const MIGRATION_LOCK_KEY_SQL = "x'637265776d696772'::bigint";
/** application_name of the test's own psql sessions, so the admin-connection audit can tell them apart. */
const TEST_APP_NAME = 'dot-test';
/**
 * The setup volume (crewflow-db-target): db-setup writes the credential-free target and crewflow_owner's password file
 * there; rab-api / rab-worker mount it read-only. DOT_OWNER_PASSWORD_FILE overrides the file's path (interface of the
 * CODE agent's owner-password-file.ts).
 */
const TARGET_DIR = '/run/crewflow/db-target';
const TARGET_FILE = `${TARGET_DIR}/target.json`;
const OWNER_PASSWORD_FILE = process.env.DOT_OWNER_PASSWORD_FILE || `${TARGET_DIR}/owner-password`;

const secrets = {};
const hex = (n) => crypto.randomBytes(n).toString('hex');
const b64 = (n) => crypto.randomBytes(n).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, Math.ceil((n * 4) / 3) - 2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowS = () => Math.floor(Date.now() / 1000);

function newSecrets() {
  Object.assign(secrets, { dbPassword: hex(32), owner: hex(32), redis: hex(24), appSecret: b64(48), smtp: hex(16), s3key: hex(8), s3secret: hex(24) });
  return secrets;
}

/** Secrets the containers made (crewflow_owner passwords read from the password file): redacted like every secret. */
const runtimeSecrets = new Set();
function rememberSecret(v) {
  if (v && v.length >= 8) runtimeSecrets.add(v);
  return v;
}

function redact(text) {
  let s = String(text ?? '');
  for (const v of [...Object.values(secrets), ...runtimeSecrets]) if (v && v.length >= 8) s = s.split(v).join('<redacted>');
  return s.replace(/postgres(ql)?:\/\/[^\s'"]+/g, 'postgres://<redacted>').replace(/rediss?:\/\/[^\s'"]+/g, 'redis://<redacted>');
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd ?? RD,
    env: { ...process.env, MSYS_NO_PATHCONV: '1', ...(opts.env ?? {}) },
    encoding: 'utf8',
    timeout: opts.timeout ?? 600_000,
    maxBuffer: 256 * 1024 * 1024,
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

/** Container events of a project, parsed and sorted (oldest first). */
function parseEvents(text) {
  return String(text)
    .split('\n')
    .filter((l) => l.trim().startsWith('{'))
    .map((l) => JSON.parse(l))
    .map((e) => ({ t: BigInt(e.timeNano), action: e.Action, service: e.Actor?.Attributes?.['com.docker.compose.service'], id: String(e.Actor?.ID ?? e.id ?? '').slice(0, 12), image: e.Actor?.Attributes?.image }))
    .sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
}
/**
 * A LIVE stream of a project's container events, started before a deploy. `docker events --since` only replays the daemon's
 * small in-memory buffer, which other projects' health-check exec events overflow on a busy host; a stream sees every event.
 * Pass it to Project.events(watcher) to stop it and get the events.
 */
const liveWatchers = new Set();
process.on('exit', () => {
  for (const c of liveWatchers) {
    try {
      c.kill();
    } catch {
      /* already gone */
    }
  }
});
function watchEvents(projectName) {
  const child = spawn('docker', ['events', '--filter', `label=com.docker.compose.project=${projectName}`, '--filter', 'type=container', '--format', '{{json .}}'], { env: { ...process.env, MSYS_NO_PATHCONV: '1' }, stdio: ['ignore', 'pipe', 'ignore'] });
  let buf = '';
  child.stdout.on('data', (b) => (buf += b.toString('utf8')));
  // Never keeps the run alive or outlives it: unref'd, and killed at exit if a failed case never stopped it.
  child.unref();
  child.stdout.unref();
  liveWatchers.add(child);
  child.on('exit', () => liveWatchers.delete(child));
  return {
    watcher: true,
    stop() {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      return parseEvents(buf);
    },
  };
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
  /**
   * `ownerInit`: the db's first start runs 01-crewflow-owner.sql (an existing crewflow_owner: pass-through scenarios).
   * `extra`: further test-only overlays (relative to packages/rab-docker).
   */
  constructor(name, out, { shortHealth = false, ownerInit = true, extra = [] } = {}) {
    this.name = name;
    this.secretsDir = path.join(out, `secrets-${name}`);
    this.ownerInit = ownerInit;
    this.extra = extra;
    this.prev = false;
    this.shortHealth = shortHealth;
    /** The crewflow_owner password the test logs in with (psqlOwner); the manual one until a DB-SETUP reset. */
    this.ownerPassword = undefined;
    this.refreshFiles();
  }
  refreshFiles() {
    this.files = [BASE, OVERLAY, ...(this.ownerInit ? [OWNER_OVERLAY] : []), ...this.extra, ...(this.prev ? [PREV_OVERLAY] : []), ...(this.shortHealth ? [SHORT_HEALTH_OVERLAY] : [])];
  }
  /** The T4 overlay: an API health window of about a minute (refusal cases), instead of the production 900 s start period. */
  setShortHealth(on) {
    this.shortHealth = on;
    this.refreshFiles();
  }
  /** An image older than DB-SETUP (no worker-start.sh): its deploys use the previous release's rab-worker command. */
  setPrev(on) {
    this.prev = on;
    this.refreshFiles();
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
  composeAsync(args, env = {}) {
    return runAsync('docker', ['compose', ...args], { env: { ...this.composeEnv(), ...env } });
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
  /**
   * psql as the PostgreSQL superuser over the db container's local socket, database crewflow. The bundled db is SCRAM on
   * the socket too (no peer, no trust), so the superuser password (PG_DATABASE_PASSWORD) travels as PGPASSWORD in the
   * exec environment (never argv). The session first turns statement logging off (a superuser may), so no test statement (a
   * test role's password, for instance) ever reaches the server log the log-scan cases read.
   */
  psql(sql, { db = 'crewflow' } = {}) {
    const r = run('docker', ['exec', '-i', '-e', 'PGPASSWORD', '-e', `PGAPPNAME=${TEST_APP_NAME}`, this.container(DB_SERVICE), 'psql', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', db], {
      env: { PGPASSWORD: secrets.dbPassword },
      input: `SET log_statement = 'none';\nSET log_min_error_statement = 'panic';\n${sql}`,
      timeout: 300_000,
    });
    if (r.code !== 0) throw new Error(`psql failed (${r.code}): ${redact(r.out).slice(0, 800)}`);
    return r.stdout.trim();
  }
  psqlFile(file) {
    return this.psql(fs.readFileSync(path.join(__dirname, file), 'utf8'));
  }
  /**
   * psql as crewflow_owner over TLS (verify-full against the db's own CA), from inside the db container but to its NETWORK
   * address (the service name `db`), the path the app containers take.
   */
  psqlOwner(sql, password = this.ownerPasswordNow()) {
    const r = run(
      'docker',
      ['exec', '-i', '-e', 'PGPASSWORD', '-e', `PGAPPNAME=${TEST_APP_NAME}`, this.container(DB_SERVICE), 'psql', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', 'host=db sslmode=verify-full sslrootcert=/var/tmp/ca.crt dbname=crewflow user=crewflow_owner'],
      { input: sql, env: { PGPASSWORD: password }, timeout: 240_000 },
    );
    if (r.code !== 0) throw new Error(`psql (owner) failed (${r.code}): ${redact(r.out).slice(0, 800)}`);
    return r.stdout.trim();
  }
  /** Whether `password` logs in as crewflow_owner over TLS (never printed). */
  ownerLoginWorks(password) {
    try {
      this.lastOwnerLoginError = '';
      return this.psqlOwner('SELECT session_user', password) === 'crewflow_owner';
    } catch (e) {
      this.lastOwnerLoginError = redact(e && e.message ? e.message : String(e)).slice(0, 300);
      return false;
    }
  }
  /**
   * crewflow_owner's password file on the setup volume, as rab-api sees it (uid 1000, read-only mount): `null` when it is
   * not there, else { password, mode: '<octal> <uid>:<gid>' }. Read in memory only: the value is registered for redaction
   * and never written or printed. Uses the running rab-api when there is one, else a one-off rab-api container (no deps).
   */
  readPasswordFile() {
    const script = `f=${OWNER_PASSWORD_FILE}; [ -f "$f" ] || { echo ABSENT; exit 0; }; stat -c '%a %u:%g' "$f"; cat "$f"`;
    const running = this.inspect('rab-api', '{{.State.Running}}') === 'true';
    const r = running
      ? run('docker', ['exec', this.container('rab-api'), 'sh', '-c', script], { timeout: 240_000 })
      : this.compose(['run', '--rm', '--no-deps', '-T', '--entrypoint', 'sh', 'rab-api', '-c', script], { timeout: 180_000 });
    if (r.code !== 0) throw new Error(`reading the password file failed (${r.code}): ${redact(r.out).slice(0, 300)}`);
    const lines = r.stdout.split('\n');
    if (lines[0].trim() === 'ABSENT') return null;
    const mode = lines[0].trim();
    const password = rememberSecret(lines.slice(1).join('\n').replace(/\n$/, ''));
    return { password, mode };
  }
  /** Whether a path exists on the setup volume (as rab-api sees it; the running one, else a one-off). */
  setupPathExists(file) {
    const script = `[ -e '${file}' ] && echo YES || echo NO`;
    const running = this.inspect('rab-api', '{{.State.Running}}') === 'true';
    const r = running
      ? run('docker', ['exec', this.container('rab-api'), 'sh', '-c', script], { timeout: 240_000 })
      : this.compose(['run', '--rm', '--no-deps', '-T', '--entrypoint', 'sh', 'rab-api', '-c', script], { timeout: 180_000 });
    if (r.code !== 0) throw new Error(`checking ${file} failed (${r.code})`);
    return r.stdout.trim() === 'YES';
  }
  /**
   * The crewflow_owner password that logs in NOW. Tried in order: the one the test last set, the password file's, the
   * hand-made one (01-crewflow-owner.sql). With the db not running: the one the test last set, else the hand-made one.
   */
  ownerPasswordNow() {
    if (this.inspect(DB_SERVICE, '{{.State.Running}}') !== 'true') return this.ownerPassword ?? secrets.owner;
    let filePw = null;
    try {
      const f = this.readPasswordFile();
      filePw = f && f.password;
    } catch {
      filePw = null;
    }
    const candidates = [...new Set([this.ownerPassword, filePw, secrets.owner].filter(Boolean))];
    for (const c of candidates) if (this.ownerLoginWorks(c)) return c;
    return this.ownerPassword ?? secrets.owner;
  }
  /** An idle superuser transaction holding `lockSql` until release() (stdin kept open; no statement keeps a snapshot). */
  async holdLock(lockSql) {
    const h = runAsync('docker', ['exec', '-i', '-e', 'PGPASSWORD', '-e', `PGAPPNAME=${TEST_APP_NAME}`, this.container(DB_SERVICE), 'psql', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'crewflow'], { env: { PGPASSWORD: secrets.dbPassword } });
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
    const r = run('docker', ['exec', this.container('rab-api'), 'wget', '-qO-', 'http://localhost:3000/healthz'], { timeout: 120_000 });
    return { code: r.code, body: r.stdout.trim() };
  }
  logs(service) {
    return run('docker', ['logs', this.container(service)], { timeout: 120_000 }).out;
  }
  events(since, until) {
    if (since && since.watcher) return since.stop();
    const r = run('docker', ['events', '--since', String(since), '--until', String(until), '--filter', `label=com.docker.compose.project=${this.name}`, '--filter', 'type=container', '--format', '{{json .}}']);
    return r.stdout
      .split('\n')
      .filter((l) => l.trim().startsWith('{'))
      .map((l) => JSON.parse(l))
      .map((e) => ({ t: BigInt(e.timeNano), action: e.Action, service: e.Actor?.Attributes?.['com.docker.compose.service'], id: String(e.Actor?.ID ?? e.id ?? '').slice(0, 12), image: e.Actor?.Attributes?.image }))
      .sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  }
  down() {
    // This run's own disposable project only: its containers, its networks and its OWN named volumes (the bundled db's
    // data and CA volumes, `<project>_crewflow-db-*`). Never a prune, never another project.
    return this.compose(['down', '--timeout', '60', '--remove-orphans', '--volumes'], { timeout: 300_000 });
  }
}

/** Secrets and the two env files from the SHIPPED templates (env/*.env.example), as run-deploy-order-tests.cjs does. */
function writeSecrets(dir, { expectedDatabase, appSecret = secrets.appSecret, caPath = '/run/crewflow/db-ca/ca.crt' } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  // The hand-made crewflow_owner password (01-crewflow-owner.sql reads it at the db's first start; OWNER_OVERLAY only).
  fs.writeFileSync(path.join(dir, 'crewflow-owner-password'), secrets.owner);
  const acl = fs
    .readFileSync(path.join(RD, 'env/redis-users.acl.example'), 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('#'))
    .map((l) => l.replace('<sha256-hex-of-the-redis-app-password>', crypto.createHash('sha256').update(secrets.redis).digest('hex')))
    .join('\n');
  fs.writeFileSync(path.join(dir, 'redis-users.acl'), `${acl}\n`);
  const host = 'deploy-order.example.com';
  const values = {
    '<db-name>': 'crewflow',
    '<redis-app-password>': secrets.redis,
    '<app-secret>': appSecret,
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
  const lineOverrides = { EMAIL_SMTP_PORT: '2525', ...(expectedDatabase ? { PG_EXPECTED_DATABASE_NAME: expectedDatabase } : {}) };
  // A pre-DB-SETUP image has no bundled-db CA rule: it needs PG_SSL_CA_CERT_PATH spelled out (the db's own CA, mounted
  // read-only from the crewflow-db-ca volume). `caPath: null` leaves it out (the bundled default needs nothing).
  const appended = { 'database.env': caPath ? [`PG_SSL_CA_CERT_PATH=${caPath}`] : [], 'runtime.env': [] };
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
    out.push(...appended[name]);
    fs.writeFileSync(path.join(dir, name), `${out.join('\n')}\n`);
  }
}

/**
 * The documented "print the crewflow_owner URL" command (DB-SETUP-LEAD.md, Helm model, operator command 1), run exactly as
 * documented plus `--name` (every container of these suites is named): the CURRENT image, the project's setup volume
 * read-only, no network, read-only root, uid 1000, `--log-driver none`. stdout (the URL, SENSITIVE) stays in memory; the
 * documented `2>/dev/null` is stderr, which is captured here only to prove it carries no URL. Returns { code, url, stderr,
 * parsed } (parsed: user/host/port/db/password, password registered for redaction).
 */
function printOwnerUrl(project, imageRef) {
  const name = `${project.name}-print-url`;
  const r = spawnSync(
    'docker',
    [
      'run', '--rm', '--pull', 'never', '--name', name, '--log-driver', 'none', '--network', 'none', '--read-only',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '1000:1000',
      '-v', `${project.name}_crewflow-db-target:${TARGET_DIR}:ro`,
      '-e', `CREWFLOW_DB_TARGET_FILE=${TARGET_FILE}`,
      '--entrypoint', 'sh', imageRef,
      '-c', 'node packages/rab-server/dist/database/typeorm/scripts/owner-login/derive-runtime-url.js 4>&1 1>&2',
    ],
    { cwd: RD, env: { ...process.env, MSYS_NO_PATHCONV: '1' }, encoding: 'utf8', timeout: 180_000 },
  );
  const url = (r.stdout || '').trim();
  let parsed = null;
  try {
    const u = new URL(url);
    parsed = { protocol: u.protocol, user: decodeURIComponent(u.username), password: rememberSecret(decodeURIComponent(u.password)), host: u.hostname, port: u.port || '5432', db: u.pathname.slice(1), params: [...u.searchParams.keys()] };
  } catch {
    parsed = null;
  }
  return { code: r.status ?? -1, url, lines: url ? url.split('\n').length : 0, stderr: r.stderr || '', parsed, name, command: `docker run --rm --pull never --name ${name} --log-driver none --network none --read-only --cap-drop ALL --security-opt no-new-privileges --user 1000:1000 -v ${project.name}_crewflow-db-target:${TARGET_DIR}:ro -e CREWFLOW_DB_TARGET_FILE=${TARGET_FILE} --entrypoint sh <IMAGE> -c 'node packages/rab-server/dist/database/typeorm/scripts/owner-login/derive-runtime-url.js 4>&1 1>&2' 2>/dev/null` };
}

/**
 * The documented "change the password on purpose" removal (DB-SETUP-LEAD.md, Helm model, operator command 2; env-free):
 * `docker run --rm --pull never --network none --log-driver none --read-only --cap-drop ALL --security-opt no-new-privileges
 * --user 1000:1000 -v <project>_crewflow-db-target:/v <IMAGE> rm -f /v/owner-password /v/owner-password.next`, plus `--name`. `script` replaces the rm (test-only file states, e.g. an empty file). No env, no
 * database connection, no secret in the command.
 */
function onSetupVolume(project, imageRef, args, label = 'setup-volume') {
  const name = `${project.name}-${label}`;
  const cmd = ['run', '--rm', '--pull', 'never', '--name', name, '--network', 'none', '--log-driver', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '1000:1000', '-v', `${project.name}_crewflow-db-target:/v`, imageRef, ...args];
  const r = run('docker', cmd, { timeout: 180_000 });
  return { ...r, command: `docker ${cmd.join(' ').replace(imageRef, '<IMAGE>')}` };
}
function removePasswordFile(project, imageRef) {
  const base = path.posix.basename(OWNER_PASSWORD_FILE);
  return onSetupVolume(project, imageRef, ['rm', '-f', `/v/${base}`, `/v/${base}.next`], 'rm-password-file');
}

/** A URL of the bundled db for `user` (verify-full). Built here only, so no caller spells a credential into a URL literal. */
function dbUrl(user, password, database = 'crewflow') {
  return `postgresql://${user}:${encodeURIComponent(password)}@db:5432/${database}?sslmode=verify-full`;
}

/** The pass-through URL: the hand-made crewflow_owner at the bundled db, verify-full (as every R254/R256 deployment has). */
function ownerUrl(password = secrets.owner) {
  return dbUrl('crewflow_owner', password);
}

/**
 * compose.env. `databaseUrl`: the database URL of the case (default: the pass-through crewflow_owner URL); `null` leaves it
 * out, i.e. the production default, the bundled db's admin URL built from PG_DATABASE_PASSWORD. PR #125: whatever
 * the login (an admin, crewflow_owner), it is written as PG_DATABASE_URL, the ONE database setting, which the compose
 * files interpolate into the one-shot db-setup only (there is no second, admin-only variable any more).
 */
function writeComposeEnv(project, { repository, digest, pgImage, redisImage, databaseUrl = ownerUrl() }) {
  const S = project.secretsDir.replace(/\\/g, '/');
  const lines = {
    CREWFLOW_IMAGE_REPOSITORY: repository,
    CREWFLOW_IMAGE_TAG: digest,
    CREWFLOW_REDIS_IMAGE: redisImage,
    CREWFLOW_POSTGRES_IMAGE: pgImage,
    CREWFLOW_SECRETS_DIR: S,
    PG_DATABASE_PASSWORD: secrets.dbPassword,
    ...(databaseUrl ? { PG_DATABASE_URL: databaseUrl } : {}),
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

// --------------------------------------------------------------------------------------------- seeded-data comparators
/** The tables the seed writes: their row sets (count + md5 of ids) per organisation must not change across an upgrade. */
const SEEDED_TABLES = [
  'attendance', 'job_offer', 'job_role', 'manager_profile', 'manager_workspace', 'payroll_calendar', 'payroll_calendar_period', 'payroll_record',
  'payroll_run', 'payroll_run_line', 'role', 'shift', 'shift_assignment', 'staff_profile', 'user', 'venue', 'workspace_membership',
];

function facts(p) {
  const lines = p.psqlFile('data-facts.sql').split('\n').filter(Boolean);
  const map = new Map(lines.map((l) => [l.slice(0, l.lastIndexOf('|')), l.slice(l.lastIndexOf('|') + 1)]));
  return { lines, map };
}

/** Seeded row sets, row CONTENT and money equal; every FK holds; every cross-table organisation_id agrees. */
function compareFacts(check, before, after, label) {
  const seeded = [...before.map.keys()].filter((k) => k.startsWith('rows|') && SEEDED_TABLES.includes(k.split('|')[1]));
  const changed = seeded.filter((k) => before.map.get(k) !== after.map.get(k));
  check(seeded.length === SEEDED_TABLES.length * 2 && changed.length === 0, `${label}: the seeded row sets of ${SEEDED_TABLES.length} tables x 2 organisations are identical (count + md5 of ids)${changed.length ? `; changed: ${changed.join(', ')}` : ''}`);
  const content = [...before.map.keys()].filter((k) => k.startsWith('content|'));
  const contentChanged = content.filter((k) => before.map.get(k) !== after.map.get(k));
  check(content.length === SEEDED_TABLES.length * 2 && contentChanged.length === 0, `${label}: the seeded rows' CONTENT is identical (status, money, minutes, tenant keys, references, key timestamps; ${content.length} hashes)${contentChanged.length ? `; changed: ${contentChanged.join(', ')}` : ''}`);
  const nonZero = (k) => [...before.map.keys()].filter((key) => key.startsWith('rows|') && key.split('|')[1] === k && !before.map.get(key).startsWith('0:'));
  check(nonZero('payroll_record').length === 2 && nonZero('attendance').length === 2, `${label}: the seed is really there (payroll and attendance rows in both organisations)`);
  const money = [...before.map.keys()].filter((k) => k.startsWith('money|'));
  const moneyChanged = money.filter((k) => before.map.get(k) !== after.map.get(k));
  check(money.length === 6 && moneyChanged.length === 0, `${label}: payroll pence and worked minutes unchanged (${money.map((k) => `${k.slice(6)}=${after.map.get(k)}`).join(', ')})`);
  const fkBad = [...after.map.entries()].filter(([k, v]) => k.startsWith('fk|') && v !== '0');
  const fkCount = [...after.map.keys()].filter((k) => k.startsWith('fk|')).length;
  check(fkCount > 100 && fkBad.length === 0, `${label}: all ${fkCount} core foreign keys hold row by row${fkBad.length ? `; orphans: ${fkBad.map(([k, v]) => `${k}=${v}`).join(', ')}` : ''}`);
  const ownBad = [...after.map.entries()].filter(([k, v]) => k.startsWith('own|') && v !== '0');
  const ownCount = [...after.map.keys()].filter((k) => k.startsWith('own|')).length;
  check(ownCount > 20 && ownBad.length === 0, `${label}: tenant ownership holds on ${ownCount} cross-table references (child organisation_id = parent's)${ownBad.length ? `; violations: ${ownBad.map(([k, v]) => `${k}=${v}`).join(', ')}` : ''}`);
}

/** RLS regression as the runtime login: no context -> zero rows; organisation A's context -> exactly A's rows, none of B's. */
function rlsCheck(p, check, label, { tamperExpected = false } = {}) {
  const ids = p
    .psql(`SELECT o.slug || ' ' || o.id || ' ' || w.id || ' ' || w.owner_user_id FROM core.organisation o JOIN core.manager_workspace w ON w.organisation_id = o.id WHERE o.slug::text LIKE 'dot-seed-%' ORDER BY o.slug`)
    .split('\n')
    .map((l) => l.split(' '));
  const [a, b] = ids;
  const uuid = /^[0-9a-f-]{36}$/;
  if (!a || !b || ![...a.slice(1), ...b.slice(1)].every((v) => uuid.test(v))) throw new Error('cannot read the seeded organisation ids');
  const tables = ['shift', 'shift_assignment', 'job_offer', 'attendance', 'payroll_record', 'payroll_run_line', 'staff_profile', 'venue'];
  const counts = (where = '') => tables.map((t) => `(SELECT count(*) FROM core.${t}${where})`).join(" || ',' || ");
  const none = p.psqlOwner(`SELECT ${counts()};`);
  check(/^0(,0)*$/.test(none) && none.split(',').length === tables.length, `${label}: crewflow_owner with NO tenant context reads 0 rows from ${tables.length} tenant tables (${none})`);
  const ctx = (org, ws, user) => `BEGIN; SELECT set_config('rab.organisation_id', '${org}', true), set_config('rab.workspace_id', '${ws}', true), set_config('rab.user_id', '${user}', true);`;
  const own = p.psqlOwner(`${ctx(a[1], a[2], a[3])}\nSELECT 'A|' || ${counts()} || '|B|' || ${counts(` WHERE organisation_id = '${b[1]}'`)};\nCOMMIT;`).split('\n').pop();
  const real = p.psql(`SELECT ${counts(` WHERE organisation_id = '${a[1]}'`)}`);
  // Self-check only (review note 2): a deliberately wrong expectation must make this check FAIL.
  const expected = tamperExpected ? real.replace(/^\d+/, (x) => String(Number(x) + 1)) : real;
  check(own === `A|${expected}|B|${tables.map(() => '0').join(',')}`, `${label}: in organisation A's context it reads exactly A's rows (${expected}) and none of B's`);
  const mixed = p.psqlOwner(`${ctx(a[1], b[2], a[3])}\nSELECT ${counts()};\nCOMMIT;`).split('\n').pop();
  check(/^0(,0)*$/.test(mixed), `${label}: organisation A with organisation B's workspace reads 0 rows (${mixed})`);
}

const iso = (ns) => new Date(Number(ns / 1_000_000n)).toISOString().replace('Z', `${String(ns % 1_000_000n).padStart(6, '0')}Z`);
const fmtEvents = (evs) => evs.map((e) => `${iso(e.t)} ${e.action.padEnd(24)} ${String(e.service).padEnd(12)} ${e.id} ${e.image ?? ''}`).join('\n');

module.exports = {
  DB_SERVICE,
  MIGRATION_LOCK_KEY_SQL,
  Project,
  SEEDED_TABLES,
  TEST_APP_NAME,
  b64,
  OWNER_PASSWORD_FILE,
  TARGET_DIR,
  TARGET_FILE,
  compareFacts,
  dbUrl,
  onSetupVolume,
  printOwnerUrl,
  rememberSecret,
  removePasswordFile,
  facts,
  fmtEvents,
  hex,
  iso,
  newSecrets,
  nowS,
  ownerUrl,
  parseEvents,
  redact,
  rlsCheck,
  run,
  runAsync,
  secrets,
  sleep,
  waitFor,
  watchEvents,
  writeComposeEnv,
  writeSecrets,
};
