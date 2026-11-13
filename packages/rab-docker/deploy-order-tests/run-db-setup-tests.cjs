'use strict';
/**
 * DB-SETUP REAL-CONTAINER TESTS ("database setup like Twenty", owner's prompt 2026-11-12; DB-SETUP-PLAN.md §10 B1-B9).
 * TEST-ONLY. One PostgreSQL major per run (16, 17 or 18), the production file docker-compose.image.yml UNCHANGED (its
 * bundled `db`, the one-shot `db-setup` with the bootstrap child, rab-api with api-prestart.sh, rab-worker with
 * worker-start.sh; PR #125 option A: only db-setup receives the admin URL) plus the test-only overlays of this folder,
 * deployed with THE documented command `docker compose pull && docker compose up -d`.
 *
 *   DOT_REPOSITORY=127.0.0.1:<port>/adolphus     a LOCAL registry (never Docker Hub)
 *   DOT_NEW_DIGEST=sha256:…                      the image under test (DB-SETUP), pushed to that registry
 *   DOT_PG_IMAGE=postgres@sha256:…               the bundled db's image for this major: a DEBIAN postgres image
 *   DOT_REDIS_IMAGE=redis@sha256:…
 *   [DOT_R256_DIGEST=sha256:…]                   R256 (0e0a6edd) in the same registry: enables block r256 (owner's test 7)
 *   [DOT_PG15_IMAGE=postgres@sha256:…]           a Debian postgres:15 image: enables block pg15 (owner's test 10, PG15)
 *   [DOT_PROJECT_PREFIX=dbs]                     project names <prefix>-pg<major>-<block>; never shared between runs
 *     node packages/rab-docker/deploy-order-tests/run-db-setup-tests.cjs <16|17|18> <out-dir> [--blocks=a,race,ext,r256,pg15] [--keep]
 *
 * Blocks (each its own disposable project, run one after another, `down --volumes` after each):
 *   a     the bundled database, Twenty's default. S1 fresh install with ONLY PG_DATABASE_PASSWORD (compose.env) + APP_SECRET
 *         (runtime.env) + the required non-database settings (dummies): crewflow_owner created with exactly the 01
 *         attributes and grant, migrations applied, API and Worker healthy (owner 1). S6 no admin credential in ANY
 *         process of rab-api / rab-worker (/proc/<pid>/environ, PID 1 included), in a `docker exec` process (a health
 *         check's environment), in the health-check processes caught while they run, or in their container definitions;
 *         every runtime session is crewflow_owner; no admin backend other than db-setup's bootstrap child (owner 6). S2 `docker compose restart`, then `down` + the
 *         documented command: nothing recreated, the password unchanged (owner 2). S5 APP_SECRET rotation: the next start
 *         resets the password once, the Worker reconnects (owner 5). S10A a runtime process started WITHOUT the shell swap
 *         (the admin URL in its environment) refuses before connecting (owner 10, lead note for area 6). S8 no log (db with
 *         log_statement=all, API, Worker, Redis, compose output) holds the admin password, an APP_SECRET, a derived
 *         password or a SCRAM verifier (owner 8).
 *   race  S9 two db-setup runs at the same moment on a fresh bundled database: the bootstrap creates crewflow_owner once;
 *         then two API starts at the same moment (the migration lock held until both wait): one migrate child applies
 *         every migration, the other finds CURRENT; no duplicate ledger row (owner 9).
 *   ext   S4 an existing crewflow_owner with SUPERUSER, then BYPASSRLS: refused, the role untouched (owner 4). S10B the
 *         same roles through the PASS-THROUGH URL: the runtime guards refuse them, nothing created (owner 10). S3 an
 *         EXTERNAL admin URL (a non-superuser login): without CREATEROLE -> refused; CREATEROLE but cannot grant on the
 *         database -> refused; CREATEROLE + owns the database -> works (fresh, restart, rotation); a second admin without
 *         ADMIN OPTION on crewflow_owner -> refused when a reset is needed; logs: the admin and derived passwords never, the
 *         verifier only as the documented non-superuser residual (owner 3, 8).
 *   r256  S7 an R256 database (R256's API + Worker on the hand-made crewflow_owner, seeded): the NEW image with the
 *         unchanged crewflow_owner URL (pass-through: nothing about the role changes) and then with the bundled admin URL
 *         (the password is reset ONCE, then unchanged); data, money, FKs, tenant ownership and RLS identical (owner 7). It
 *         also records what a rollback to R256 with THIS release's compose files alone does to rab-worker.
 *   pg15  S10C PostgreSQL 15 as the bundled db: the bootstrap child refuses ("PostgreSQL 16 or later is required."), exit
 *         64, nothing created (owner 10).
 *
 * Limits: at most six running containers of this run (db, rab-redis, rab-api, rab-worker + the registry, + the one-shot
 * db-setup while it re-runs beside a running stack on a redeploy, PR #125 option A; block race: two one-off db-setup, then
 * two one-off API containers instead of rab-api/rab-worker; refusal runs: one one-off container). Secrets are generated per run
 * under <out>/secrets-<project> (outside the repository), reach the containers only through env files, and every
 * captured output is redacted before it is written or printed; secret checks only COUNT matches. Results:
 * <out>/RESULTS.json, SUMMARY.md, run.log, evidence/.
 */
const fs = require('node:fs');
const path = require('node:path');

const L = require('./upgrade-lib.cjs');

const argv = process.argv.slice(2);
const MAJOR = argv[0];
// Git Bash hands over /c/... paths; on Windows node would resolve them to C:\c\..., so map the drive prefix.
const OUT = argv[1] ? path.resolve(process.platform === 'win32' ? argv[1].replace(/^\/([a-z])\//i, '$1:/') : argv[1]) : '';
const KEEP = argv.includes('--keep');
const BLOCKS = (argv.find((a) => a.startsWith('--blocks=')) ?? '--blocks=a,race,ext,r256,pg15').slice(9).split(',').filter(Boolean);
function fail(msg) {
  console.error(msg);
  process.exit(2);
}
if (!['16', '17', '18'].includes(MAJOR) || !OUT) fail('usage: run-db-setup-tests.cjs <16|17|18> <out-dir> [--blocks=a,race,ext,r256,pg15] [--keep]');
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const REF = /^[a-z0-9./_:-]+@sha256:[0-9a-f]{64}$/;
if (!DIGEST.test(process.env.DOT_NEW_DIGEST ?? '')) fail('DOT_NEW_DIGEST must be sha256:<64 hex>');
if (process.env.DOT_R256_DIGEST && !DIGEST.test(process.env.DOT_R256_DIGEST)) fail('DOT_R256_DIGEST must be sha256:<64 hex> when set');
for (const k of ['DOT_PG_IMAGE', 'DOT_REDIS_IMAGE']) if (!REF.test(process.env[k] ?? '')) fail(`${k} must be <repository>@sha256:<64 hex>`);
if (process.env.DOT_PG15_IMAGE && !REF.test(process.env.DOT_PG15_IMAGE)) fail('DOT_PG15_IMAGE must be <repository>@sha256:<64 hex> when set');
if (!/^127\.0\.0\.1:\d+\/[a-z0-9._/-]+$/.test(process.env.DOT_REPOSITORY ?? '')) fail('DOT_REPOSITORY must be a LOCAL registry repository (127.0.0.1:<port>/<name>)');
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const rel = path.relative(REPO_ROOT.toLowerCase(), OUT.toLowerCase());
if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) fail('the output directory must be OUTSIDE the repository (it holds per-run secrets)');
const PREFIX = process.env.DOT_PROJECT_PREFIX || 'dbs';
if (!/^[a-z][a-z0-9-]{0,15}$/.test(PREFIX)) fail('DOT_PROJECT_PREFIX must match ^[a-z][a-z0-9-]{0,15}$');

const REPO = process.env.DOT_REPOSITORY;
const NEW = process.env.DOT_NEW_DIGEST;
const R256 = process.env.DOT_R256_DIGEST || null;
const PG_IMAGE = process.env.DOT_PG_IMAGE;
const PG15_IMAGE = process.env.DOT_PG15_IMAGE || null;
const REGISTRY_CONTAINER = process.env.DOT_REGISTRY_CONTAINER || 'deploy-order-registry';
const MAX_CONTAINERS = 6; // + the one-shot db-setup re-running beside a running stack (PR #125 option A)
const LOGGING_OVERLAY = 'deploy-order-tests/docker-compose.db-setup-logging.yml';
const BOOTSTRAP_APP = 'crewflow-owner-bootstrap';
const MSG = {
  // owner-bootstrap.ts OWNER_BOOTSTRAP_MESSAGES (fixed text; compared exactly).
  passThrough: 'PG_DATABASE_URL is the crewflow_owner login: the database setup step is skipped.',
  pgTooOld: 'PostgreSQL 16 or later is required.',
  privileged: (attrs) => `crewflow_owner exists with ${attrs}; Crewflow never runs as a privileged login.`,
  cannotCreateRoles: "The PG_DATABASE_URL login cannot create roles (needs CREATEROLE, or use the provider's admin login).",
  cannotGrantDb: 'The PG_DATABASE_URL login cannot grant CONNECT, CREATE, TEMPORARY on this database',
  noAdminOption: "crewflow_owner's password must be reset but the PG_DATABASE_URL login has no ADMIN OPTION on it",
  ready: (what) => `[owner-bootstrap] crewflow_owner is ready (${what}).`,
  // runtime-db-config.ts checkRuntimeLogin
  runtimeLogin: 'PG_DATABASE_URL does not log in as crewflow_owner.',
  runtimeLoginTail: 'Refusing to start before connecting.',
};

fs.mkdirSync(path.join(OUT, 'evidence'), { recursive: true });
const results = [];
const logLines = [];
const projects = [];
let peak = { count: 0, at: '', names: [] };

function note(line) {
  const l = L.redact(line);
  logLines.push(l);
  console.log(`[${PREFIX}-pg${MAJOR}] ${l}`);
}
function evidence(name, text) {
  fs.writeFileSync(path.join(OUT, 'evidence', name), L.redact(text));
}
const imageRef = (digest) => `${REPO}@${digest}`;

function startPeakSampler() {
  const timer = setInterval(() => {
    const names = projects.map((p) => p.name);
    const r = L.run('docker', ['ps', '--format', '{{.Names}}|{{.Label "com.docker.compose.project"}}'], { timeout: 20_000 });
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

function writeResults() {
  fs.writeFileSync(path.join(OUT, 'RESULTS.json'), JSON.stringify({ major: MAJOR, image: imageRef(NEW), r256: R256 && imageRef(R256), pgImage: PG_IMAGE, peak, results }, null, 2));
}

/** One case. A throw or a failed check fails it; the block continues with its next case unless `fatal`. */
async function step(id, owner, title, fn, p) {
  const r = { id, owner, title, status: 'NOT RUN', checks: [], notes: [] };
  results.push(r);
  note(`=== ${id} (owner ${owner}) ${title}`);
  const check = (ok, what) => {
    r.checks.push({ ok: Boolean(ok), what: L.redact(what) });
    note(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`);
    return Boolean(ok);
  };
  try {
    await fn(check, (n) => {
      r.notes.push(L.redact(n));
      note(`  note: ${n}`);
    });
    r.status = r.checks.length && r.checks.every((c) => c.ok) ? 'PASS' : 'FAIL';
  } catch (e) {
    r.status = 'FAIL';
    r.checks.push({ ok: false, what: `threw: ${L.redact(e && e.message ? e.message : String(e))}` });
    note(`  FAIL threw: ${e && e.message ? e.message : e}`);
  }
  if (p && r.status === 'FAIL') for (const svc of ['db', 'db-setup', 'rab-api', 'rab-worker']) evidence(`${id}-failure-${svc}.log`, L.run('docker', ['logs', '--tail', '400', p.container(svc)]).out);
  note(`=== ${id} ${r.status}`);
  writeResults();
  return r.status === 'PASS';
}

// ------------------------------------------------------------------------------------------------------------ helpers
/** Every compose / docker output of a project, kept (raw, in memory only) for the log scan. */
const transcripts = new Map();
function keep(p, label, out) {
  if (!transcripts.has(p.name)) transcripts.set(p.name, []);
  transcripts.get(p.name).push(`--- ${label}\n${out}`);
}

function project(block, { ownerInit = false, logging = true } = {}) {
  const p = new L.Project(`${PREFIX}-pg${MAJOR}-${block}`, OUT, { ownerInit, extra: logging ? [LOGGING_OVERLAY] : [] });
  projects.push(p);
  return p;
}

function use(p, { digest = NEW, databaseUrl = null, pgImage = PG_IMAGE } = {}) {
  L.writeComposeEnv(p, { repository: REPO, digest, pgImage, redisImage: process.env.DOT_REDIS_IMAGE, databaseUrl });
}

function deploy(p, label) {
  const d = p.deploy();
  keep(p, label, d.out);
  evidence(`${p.name}-${label}.log`, d.out);
  return d;
}

/**
 * A one-off container of `service` (db-setup, rab-api or rab-worker), no dependencies started: the default entrypoint unless
 * `entrypoint` / `cmd` are given. `env`: variables handed over as `-e NAME` (the value travels in the compose process's
 * environment, never argv).
 */
function oneOff(p, service, label, { entrypoint, cmd = [], timeout = 300_000, env = {} } = {}) {
  const args = ['run', '--rm', '-T', '--no-deps', ...Object.keys(env).flatMap((k) => ['-e', k]), ...(entrypoint ? ['--entrypoint', entrypoint] : []), service, ...cmd];
  const t0 = Date.now();
  const r = p.compose(args, { timeout, env });
  keep(p, label, r.out);
  evidence(`${p.name}-${label}.log`, r.out);
  return { ...r, ms: Date.now() - t0 };
}

const ATTRS = ['oid', 'super', 'inherit', 'createrole', 'createdb', 'login', 'replication', 'bypassrls', 'validUntil', 'verifierSha'];
/** crewflow_owner as pg_authid has it (the verifier only as a sha256 of it; nothing is printed but booleans and the oid). */
function role(p) {
  const v = p.psql(
    `SELECT r.oid || '|' || r.rolsuper || '|' || r.rolinherit || '|' || r.rolcreaterole || '|' || r.rolcreatedb || '|' || r.rolcanlogin || '|' || r.rolreplication || '|' || r.rolbypassrls || '|' || coalesce(r.rolvaliduntil::text, '-') || '|' || encode(sha256(convert_to(coalesce(r.rolpassword, ''), 'UTF8')), 'hex') FROM pg_authid r WHERE r.rolname = 'crewflow_owner'`,
  );
  if (!v) return null;
  const parts = v.split('|');
  return Object.fromEntries(ATTRS.map((k, i) => [k, parts[i]]));
}
const T = (v) => v === 't' || v === 'true'; // boolean || text renders 'true' / 'false'
const roleShape = (r) => (r ? `oid ${r.oid}: ${T(r.super) ? 'SUPERUSER' : 'NOSUPERUSER'} ${T(r.bypassrls) ? 'BYPASSRLS' : 'NOBYPASSRLS'} ${T(r.replication) ? 'REPLICATION' : 'NOREPLICATION'} ${T(r.createdb) ? 'CREATEDB' : 'NOCREATEDB'} ${T(r.createrole) ? 'CREATEROLE' : 'NOCREATEROLE'} ${T(r.inherit) ? 'INHERIT' : 'NOINHERIT'} ${T(r.login) ? 'LOGIN' : 'NOLOGIN'} valid-until ${r.validUntil}` : '(absent)');
const exactly01 = (r) => Boolean(r) && !T(r.super) && !T(r.bypassrls) && !T(r.replication) && !T(r.createdb) && T(r.createrole) && T(r.inherit) && T(r.login) && r.validUntil === '-';
function dbAcl(p, db = 'crewflow') {
  return p.psql(`SELECT coalesce(datacl::text, '') FROM pg_database WHERE datname = '${db}'`);
}
/** Client sessions other than the test's own: user|application_name|ssl|count. */
function sessions(p) {
  return p
    .psql(
      `SELECT a.usename || '|' || coalesce(a.application_name, '') || '|' || coalesce(s.ssl::text, 'false') || '|' || count(*) FROM pg_stat_activity a LEFT JOIN pg_stat_ssl s ON s.pid = a.pid WHERE a.backend_type = 'client backend' AND a.pid <> pg_backend_pid() AND coalesce(a.application_name, '') <> '${L.TEST_APP_NAME}' GROUP BY a.usename, a.application_name, s.ssl ORDER BY 1`,
    )
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [user, app, ssl, count] = l.split('|');
      return { user, app, ssl: ssl === 'true', count: Number(count) };
    });
}
function checkSessions(p, check, label) {
  const s = sessions(p);
  const apps = s.map((x) => `${x.user}/${x.app}${x.ssl ? '/tls' : '/PLAIN'} x${x.count}`).join(', ');
  check(s.length > 0 && s.every((x) => x.user === 'crewflow_owner'), `${label}: every client session's session_user is crewflow_owner (${apps || 'none'})`);
  check(s.length > 0 && s.every((x) => x.ssl), `${label}: every client session is TLS (verify-full against the bundled db's own CA)`);
  return s;
}

/**
 * Admin connections in the db log (log_connections=on): every `connection authorized` line of an ADMIN user after the
 * image's init phase. Allowed: the bootstrap child and the test's own psql sessions. Returns the others.
 */
function adminConnections(p, adminUsers) {
  const log = p.logs(L.DB_SERVICE);
  const start = log.lastIndexOf('PostgreSQL init process complete');
  const body = start >= 0 ? log.slice(start) : log;
  const seen = new Map();
  for (const m of body.matchAll(/connection authorized: user=(\S+) database=(\S+)(?: application_name=(\S+))?/g)) {
    const key = `${m[1]}|${m[3] ?? ''}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const all = [...seen.entries()].map(([k, n]) => ({ user: k.split('|')[0], app: k.split('|')[1], n }));
  const admin = all.filter((x) => adminUsers.includes(x.user));
  // pg_isready: the db service's own healthcheck (inside the db container; it runs no SQL).
  return { all, admin, others: admin.filter((x) => x.app !== BOOTSTRAP_APP && x.app !== L.TEST_APP_NAME && x.app !== 'pg_isready') };
}

const ENVIRON_SCRIPT = [
  'read -r S1; read -r S2; read -r S3',
  'for d in /proc/[0-9]*; do',
  '  p=${d#/proc/}',
  '  e=$(tr "\\0" "\\n" < "$d/environ" 2>/dev/null) || { echo "$p|gone"; continue; }',
  '  [ -n "$e" ] || { c=$(tr "\\0" " " < "$d/cmdline" 2>/dev/null | cut -c1-90); echo "$p|empty|||$c"; continue; }',
  '  case "$e" in *DOT_ENVIRON_PROBE=1*) continue;; esac',
  '  h=0',
  '  for s in "$S1" "$S2" "$S3"; do case "$e" in *"$s"*) h=1;; esac; done',
  '  u=$(printf "%s\\n" "$e" | sed -n "s#^PG_DATABASE_URL=[a-z]*://\\([^:@/]*\\).*#\\1#p")',
  '  w=$(printf "%s\\n" "$e" | grep -c "^PG_DATABASE_PASSWORD=")',
  '  c=$(tr "\\0" " " < "$d/cmdline" 2>/dev/null | cut -c1-90)',
  '  echo "$p|$h|$u|$w|$c"',
  'done',
  // The probe itself (a `docker exec`): it carries the container DEFINITION's environment, the accepted risk of plan §5.3.
  'e=$(tr "\\0" "\\n" < /proc/$$/environ); h=0; for s in "$S1" "$S2" "$S3"; do case "$e" in *"$s"*) h=1;; esac; done; echo "probe|$h"',
].join('\n');

/**
 * Every process of a running container: does its /proc/<pid>/environ hold any sentinel (the admin password)? The sentinels
 * travel on stdin (never argv or the probe's environment); only flags are returned. Runs as the container user (uid 1000),
 * which is what can read the app processes' environ.
 */
function environScan(p, service, sentinels) {
  const pad = [...sentinels, L.hex(24), L.hex(24), L.hex(24)].slice(0, 3);
  const r = L.run('docker', ['exec', '-i', '-e', 'DOT_ENVIRON_PROBE=1', p.container(service), 'sh', '-c', ENVIRON_SCRIPT], { input: `${pad.join('\n')}\n`, timeout: 60_000 });
  if (r.code !== 0) throw new Error(`environ scan of ${service} failed (${r.code}): ${L.redact(r.out).slice(0, 300)}`);
  const rows = [];
  let probe = null;
  for (const line of r.stdout.split('\n').filter(Boolean)) {
    const f = line.split('|');
    if (f[0] === 'probe') probe = f[1] === '1';
    else if (f[1] !== 'gone') rows.push({ pid: f[0], hit: f[1] === '1', empty: f[1] === 'empty', urlUser: f[2] ?? '', pwVar: Number(f[3] || 0), cmd: (f[4] ?? '').trim() });
  }
  return { rows, probe };
}
function checkEnviron(p, check, n, label, sentinels, { services = ['rab-api', 'rab-worker'] } = {}) {
  for (const svc of services) {
    const { rows, probe } = environScan(p, svc, sentinels);
    const desc = rows.map((x) => `pid ${x.pid} [${x.cmd.slice(0, 60)}] ${x.empty ? 'empty' : `${x.hit ? 'ADMIN-CREDENTIAL' : 'clean'} url-user=${x.urlUser || '-'}${x.pwVar ? ' PG_DATABASE_PASSWORD' : ''}`}`).join('; ');
    evidence(`${p.name}-${label}-${svc}-environ.txt`, desc.split('; ').join('\n'));
    const pid1 = rows.find((x) => x.pid === '1');
    check(Boolean(pid1) && !pid1.hit && !pid1.pwVar && (pid1.urlUser === '' || pid1.urlUser === 'crewflow_owner'), `${label}: ${svc} PID 1 [${pid1 ? pid1.cmd.slice(0, 60) : '?'}] holds no admin credential (url-user ${pid1 ? pid1.urlUser || '-' : '?'})`);
    const bad = rows.filter((x) => x.hit || x.pwVar || (x.urlUser && x.urlUser !== 'crewflow_owner'));
    check(rows.length > 1 && bad.length === 0, `${label}: none of ${svc}'s ${rows.length} processes holds the admin password, PG_DATABASE_PASSWORD or a non-crewflow_owner PG_DATABASE_URL${bad.length ? ` (FOUND in: ${bad.map((x) => `pid ${x.pid} ${x.cmd.slice(0, 40)}`).join(', ')})` : ''}`);
    const node = rows.filter((x) => /node .*main\.js/.test(x.cmd));
    check(node.length >= 1 && node.every((x) => x.urlUser === 'crewflow_owner'), `${label}: ${svc}'s runtime (${node.map((x) => `pid ${x.pid}`).join(', ') || 'not found'}) has PG_DATABASE_URL = the crewflow_owner login`);
    n(`${svc} processes: ${desc}`);
    // Option A: a `docker exec` process (and a health check, which Docker runs the same way) gets the container
    // DEFINITION's environment, which no longer holds any database credential.
    check(probe === false, `${label}: a \`docker exec\` process in ${svc} (the environment a health check gets) holds no admin credential`);
    const def = L.run('docker', ['inspect', '-f', '{{range .Config.Env}}{{println .}}{{end}}', p.container(svc)], { timeout: 30_000 }).stdout;
    const defUrl = (def.match(/^PG_DATABASE_URL=(.*)$/m) || [null, null])[1];
    check(!sentinels.some((x) => def.includes(x)) && !/^PG_DATABASE_PASSWORD=/m.test(def) && defUrl === '' && !/postgres(ql)?:\/\//.test(def), `${label}: ${svc}'s container definition (docker inspect Config.Env) holds no admin credential, no PG_DATABASE_PASSWORD and no database URL (PG_DATABASE_URL empty: not pass-through)`);
  }
}

/**
 * Option A: catch the health-check processes WHILE they run. A loop inside the container (uid 1000, as the app) scans /proc
 * for `seconds` and records, for every process whose command line is the service's health check (rab-api: wget /healthz;
 * rab-worker: worker-bundle-health.cjs), whether its environ holds a sentinel. Sentinels on stdin; only flags come back.
 */
const HEALTH_SCAN = [
  'read -r S1; read -r S2; read -r S3; read -r PAT; read -r SECS',
  'end=$(( $(date +%s) + SECS )); seen=""',
  'while [ "$(date +%s)" -lt "$end" ]; do',
  '  for d in /proc/[0-9]*; do',
  '    p=${d#/proc/}; case " $seen " in *" $p "*) continue;; esac',
  '    c=$(tr "\\0" " " < "$d/cmdline" 2>/dev/null) || continue',
  '    case "$c" in *"$PAT"*) ;; *) continue;; esac',
  '    case "$c" in *DOT_HEALTH_SCAN*|*"read -r"*) continue;; esac',
  '    e=$(tr "\\0" "\\n" < "$d/environ" 2>/dev/null) || continue',
  '    [ -n "$e" ] || continue',
  '    h=0; for s in "$S1" "$S2" "$S3"; do case "$e" in *"$s"*) h=1;; esac; done',
  '    u=$(printf "%s\\n" "$e" | grep -c "^PG_DATABASE_URL=..*")',
  '    seen="$seen $p"; echo "$p|$h|$u|$(printf "%s" "$c" | cut -c1-80)"',
  '  done',
  'done',
].join('\n');
function healthScan(p, check, n, label, sentinels, seconds = 40) {
  for (const [svc, pat] of [['rab-api', 'wget -qO- http://localhost:3000/healthz'], ['rab-worker', 'worker-bundle-health.cjs']]) {
    const pad = [...sentinels, L.hex(24), L.hex(24), L.hex(24)].slice(0, 3);
    const r = L.run('docker', ['exec', '-i', '-e', 'DOT_HEALTH_SCAN=1', p.container(svc), 'sh', '-c', HEALTH_SCAN], { input: `${pad.join('\n')}\n${pat}\n${seconds}\n`, timeout: (seconds + 60) * 1000 });
    const rows = r.stdout.split('\n').filter(Boolean).map((l) => { const f = l.split('|'); return { pid: f[0], hit: f[1] === '1', url: f[2] !== '0', cmd: f[3] ?? '' }; });
    evidence(`${p.name}-${label}-${svc}-healthcheck-environ.txt`, rows.map((x) => `pid ${x.pid} [${x.cmd}] ${x.hit ? 'ADMIN-CREDENTIAL' : 'clean'}${x.url ? ' PG_DATABASE_URL-set' : ''}`).join('\n'));
    n(`${svc}: ${rows.length} health-check process(es) caught while running in ${seconds} s (${rows.map((x) => `pid ${x.pid} ${x.hit ? 'ADMIN' : 'clean'}`).join(', ') || 'none caught'})`);
    check(r.code === 0 && rows.every((x) => !x.hit && !x.url), `${label}: every ${svc} health-check process caught while running holds no admin credential and no database URL (${rows.length} caught)`);
    if (svc === 'rab-worker') check(rows.length >= 1, `${label}: at least one rab-worker health check was caught while running (a node process, ${seconds} s window, interval 30 s)`);
  }
}

/** Counts of each secret in each text. Never returns or prints a value. */
function scanSecrets(texts, sentinels) {
  const found = [];
  for (const [tname, text] of Object.entries(texts)) {
    for (const [sname, value] of Object.entries(sentinels)) {
      if (!value || value.length < 8) continue;
      const count = text.split(value).length - 1;
      if (count) found.push(`${sname} x${count} in ${tname}`);
    }
  }
  return found;
}
const VERIFIER_RE = /SCRAM-SHA-256\$\d+:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+/g;

function logTexts(p) {
  const texts = {};
  for (const svc of [L.DB_SERVICE, 'db-setup', 'rab-redis', 'rab-api', 'rab-worker']) texts[`${svc} log`] = L.run('docker', ['logs', p.container(svc)], { timeout: 120_000 }).out;
  texts['compose and one-off output'] = (transcripts.get(p.name) ?? []).join('\n');
  return texts;
}

/** Option A: the bootstrap child runs in the one-shot db-setup service; its log holds the [owner-bootstrap] lines. */
const setupLog = (p) => p.logs('db-setup');
const lastReady = (log) => log.trim().split('\n').filter((l) => l.includes('[owner-bootstrap] crewflow_owner is ready')).pop() ?? '';
const setupExit = (p) => p.inspect('db-setup', '{{.State.Status}}|{{.State.ExitCode}}');
const bootstrapLines = (log) => log.split('\n').filter((l) => l.includes('[owner-bootstrap]')).map((l) => l.replace(/^.*?\[owner-bootstrap\]/, '[owner-bootstrap]').trim());
const count = (text, needle) => text.split(needle).length - 1;

function migrateResults(log) {
  return [...log.matchAll(/TWENTY_MIGRATE_RESULT (\{.*\})/g)]
    .map((m) => {
      try {
        return JSON.parse(m[1]);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/** The bundled db's certificate fingerprints (server, CA): a restart must not make new ones. */
function certs(p) {
  const r = L.run('docker', ['exec', p.container(L.DB_SERVICE), 'sh', '-c', 'openssl x509 -noout -fingerprint -sha256 -in /var/lib/postgresql/tls/server.crt; openssl x509 -noout -fingerprint -sha256 -in /var/tmp/ca.crt'], { timeout: 30_000 });
  return r.stdout.replace(/\s+/g, ' ').trim();
}

async function waitApp(p, { api = 600_000, worker = 300_000 } = {}) {
  await p.waitHealthy('rab-api', api);
  if (worker) await p.waitHealthy('rab-worker', worker);
}

function teardown(p) {
  if (KEEP) return;
  const d = p.down();
  note(`cleanup ${p.name}: compose down --volumes exit ${d.code}`);
}

// ------------------------------------------------------------------------------------------------------------ block a
async function blockBundled() {
  const p = project('a');
  const s = L.secrets;
  const app1 = s.appSecret;
  const app2 = L.b64(48);
  s.appSecret2 = app2;
  const d1 = L.derivedOwnerPassword(app1);
  const d2 = L.derivedOwnerPassword(app2);
  L.writeSecrets(p.secretsDir, { caPath: null, appSecret: app1 });
  use(p, { databaseUrl: null });
  const state = {};

  const ok1 = await step('S1', '1', 'bundled database, fresh install with only PG_DATABASE_PASSWORD + APP_SECRET (+ dummy non-database settings): crewflow_owner created, migrations applied, API and Worker healthy', async (check, n) => {
    const envs = ['compose.env', 'database.env', 'runtime.env'].map((f) => fs.readFileSync(path.join(p.secretsDir, f), 'utf8'));
    check(!envs.some((e) => /^PG_DATABASE_URL=|^PG_SSL_CA_CERT_PATH=|^CREWFLOW_PG_CA_FILE=/m.test(e)), 'no PG_DATABASE_URL, PG_SSL_CA_CERT_PATH or CA file in any env file: the database settings are PG_DATABASE_PASSWORD (compose.env) and APP_SECRET (runtime.env) only');
    n(`database.env holds only: ${envs[1].trim().split('\n').map((l) => l.split('=')[0]).join(', ')}`);
    const d = deploy(p, 'S1-deploy');
    check(d.code === 0, `\`docker compose pull && docker compose up -d\` exit ${d.code} after ${Math.round(d.ms / 1000)} s`);
    const dbHealth = p.health(L.DB_SERVICE);
    check(dbHealth.startsWith('healthy|'), `db healthy (${dbHealth})`);
    if (!dbHealth.startsWith('healthy|')) {
      const dl = p.logs(L.DB_SERVICE);
      evidence('S1-db.log', dl);
      n(`db log tail: ${dl.trim().split('\n').slice(-6).join(' / ')}`);
      throw new Error('the bundled db did not become healthy');
    }
    await waitApp(p);
    check(true, 'rab-api healthy, then rab-worker healthy');
    const pg = p.psql('SHOW server_version_num');
    check(pg.startsWith(MAJOR), `PostgreSQL major ${MAJOR} (server_version_num ${pg})`);
    const al = p.logs('rab-api');
    const sl = setupLog(p);
    evidence('S1-api.log', al);
    evidence('S1-db-setup.log', sl);
    evidence('S1-worker.log', p.logs('rab-worker'));
    n(`bootstrap (db-setup): ${bootstrapLines(sl).join(' / ')}`);
    check(setupExit(p) === 'exited|0', `db-setup ran once and exited 0 (${setupExit(p)})`);
    check(sl.includes(MSG.ready('created')) && /db-setup: done/.test(sl), 'db-setup\'s bootstrap child created crewflow_owner ("crewflow_owner is ready (created).") and wrote the target file');
    check(!al.includes('[owner-bootstrap]'), 'rab-api ran no bootstrap child (option A: it never receives the admin URL)');
    const tgt = L.run('docker', ['exec', p.container('rab-api'), 'cat', '/run/crewflow/db-target/target.json'], { timeout: 30_000 }).stdout;
    check(/"v":\s*1/.test(tgt) && !tgt.includes('@') && !tgt.includes(s.dbPassword) && !tgt.includes(d1) && !tgt.includes(app1), 'the target file rab-api reads holds no login, no password and no APP_SECRET (credential-free; value not printed)');
    const r = role(p);
    state.role = r;
    check(exactly01(r), `crewflow_owner has exactly the 01 attributes: ${roleShape(r)}`);
    const acl = dbAcl(p);
    check(/(^|[{,])crewflow_owner=C\*T\*c\*\/postgres([,}]|$)/.test(acl), `database grant CONNECT, CREATE, TEMPORARY WITH GRANT OPTION from the admin (crewflow_owner=C*T*c*/postgres in ${acl})`);
    const ledger = p.psql(`SELECT count(*) || '|' || count(DISTINCT name) FROM core.migrations`);
    const mr = migrateResults(al).pop() || {};
    n(`migrate result: state ${mr.state}, applied ${Array.isArray(mr.applied) ? mr.applied.length : '?'}, exit ${mr.exitCode}; ledger ${ledger}`);
    const [lc, ld] = ledger.split('|').map(Number);
    check(lc > 200 && lc === ld && Array.isArray(mr.applied) && mr.applied.length === lc && mr.exitCode === 0, `migrations applied by the migrate child as crewflow_owner: ${lc} ledger rows, no duplicates, all applied on this start`);
    const coreOwner = p.psql(`SELECT n.nspowner::regrole::text || '|' || (n.nspowner = r.oid OR pg_has_role('crewflow_owner', n.nspowner, 'USAGE'))::text FROM pg_namespace n, pg_roles r WHERE n.nspname = 'core' AND r.rolname = 'crewflow_owner'`);
    check(coreOwner.endsWith('|true') && !coreOwner.startsWith('postgres|'), `schema core belongs to crewflow_owner's schema-role tree, not the admin (owner ${coreOwner.split('|')[0]}): the migrations ran as the derived login`);
    const hz = p.healthz();
    check(hz.code === 0 && /"upgradeFailed":\s*false/.test(hz.body), `/healthz answers, upgradeFailed:false (${hz.body.slice(0, 120)})`);
    check(p.ownerLoginWorks(d1), 'crewflow_owner logs in with hex(HKDF(APP_SECRET, "crewflow-owner-db-password-v1")) computed by the test (value never printed)');
    checkSessions(p, check, 'S1');
    check(/crewflow-db: creating the bundled database CA and server certificate/.test(p.logs(L.DB_SERVICE)), 'the db made its own CA and server certificate on its first start (D1 a)');
    state.certs = certs(p);
    const hba = p.psql(`SELECT string_agg(type || ' ' || coalesce(address, '-') || ' ' || auth_method, '; ' ORDER BY line_number) FROM pg_hba_file_rules`);
    n(`the bundled db's pg_hba: ${hba}`);
    check(hba.length > 0 && !/\b(trust|peer)\b/.test(hba), 'the bundled db\'s pg_hba has no trust or peer line (SCRAM for local and host connections)');
  }, p);
  if (!ok1 && !p.health('rab-api').startsWith('healthy|')) {
    note('S1 did not bring the stack up: the rest of block a is not run');
    for (const id of ['S6', 'S2', 'S5', 'S10A', 'S8']) results.push({ id, owner: '-', title: 'not run (S1 failed)', status: 'NOT RUN', checks: [], notes: [] });
    teardown(p);
    return;
  }

  await step('S6', '6', 'no admin credential in any rab-api / rab-worker process environment (PID 1 included), docker exec / health-check environment or container definition; every runtime session is crewflow_owner; no admin backend but db-setup\'s bootstrap child', async (check, n) => {
    checkEnviron(p, check, n, 'S6', [s.dbPassword]);
    healthScan(p, check, n, 'S6', [s.dbPassword]);
    const setupDef = L.run('docker', ['inspect', '-f', '{{range .Config.Env}}{{println .}}{{end}}', p.container('db-setup')], { timeout: 30_000 }).stdout;
    n(`db-setup's container definition ${setupDef.includes(s.dbPassword) ? 'holds' : 'does NOT hold'} the admin URL (expected: it is the one service that receives it; TM-DB-1)`);
    checkSessions(p, check, 'S6');
    const a = adminConnections(p, ['postgres']);
    n(`connections seen in the db log since init: ${a.all.map((x) => `${x.user}/${x.app || '-'} x${x.n}`).join(', ')}`);
    check(a.admin.some((x) => x.app === BOOTSTRAP_APP) && a.others.length === 0, `the only admin (postgres) connections are the bootstrap child's (application_name ${BOOTSTRAP_APP}), the db's own pg_isready healthcheck and the test's own psql${a.others.length ? `; OTHERS: ${a.others.map((x) => `${x.app || '-'} x${x.n}`).join(', ')}` : ''}`);
  }, p);

  await step('S2', '2', 'restart: `docker compose restart`, then `down` + the documented command: nothing recreated, the password unchanged', async (check, n) => {
    const before = role(p);
    const acl = dbAcl(p);
    const r1 = p.compose(['restart'], { timeout: 600_000 });
    keep(p, 'S2-restart', r1.out);
    check(r1.code === 0, `docker compose restart exit ${r1.code}`);
    await waitApp(p);
    const after1 = role(p);
    check(after1 && after1.oid === before.oid, `same crewflow_owner role (oid ${before.oid} -> ${after1 && after1.oid})`);
    check(after1 && after1.verifierSha === before.verifierSha, 'the stored SCRAM verifier is byte-identical (sha256 compared, never printed): the password was not set again');
    check(exactly01(after1) && dbAcl(p) === acl, 'attributes and the database ACL unchanged');
    const sl1 = setupLog(p);
    n(`bootstrap after restart (db-setup ran again): ${bootstrapLines(sl1).slice(-1).join('')}`);
    check(lastReady(sl1).includes('(unchanged)') && setupExit(p) === 'exited|0', 'db-setup ran again on restart and changed nothing ("ready (unchanged)", exit 0)');
    const down = p.compose(['down', '--timeout', '60'], { timeout: 300_000 });
    keep(p, 'S2-down', down.out);
    check(down.code === 0, '`docker compose down` (volumes kept) exit 0');
    const d = deploy(p, 'S2-redeploy');
    check(d.code === 0, `the documented command again: exit ${d.code}`);
    await waitApp(p);
    const after2 = role(p);
    check(after2 && after2.oid === before.oid && after2.verifierSha === before.verifierSha && exactly01(after2) && dbAcl(p) === acl, 'after down + up: same role oid, same verifier, same attributes and database ACL');
    const al2 = p.logs('rab-api');
    const sl2 = setupLog(p);
    check(sl2.includes(MSG.ready('unchanged')) && !sl2.includes(MSG.ready('created')) && !sl2.includes('password set'), 'the new db-setup container: "ready (unchanged)"');
    const c2 = certs(p);
    check(c2 === state.certs && !/creating the bundled database CA/.test(p.logs(L.DB_SERVICE)), 'the db kept its CA and server certificate (same fingerprints; no new certificate on the new container)');
    const ledger = p.psql('SELECT count(*) FROM core.migrations');
    const mr = migrateResults(al2).pop() || {};
    check(mr.state === 'CURRENT' && Array.isArray(mr.applied) && mr.applied.length === 0, `the migrate child found the database CURRENT and applied nothing (ledger ${ledger})`);
  }, p);

  await step('S5', '5', 'APP_SECRET rotation: the next start resets the crewflow_owner password once; the Worker reconnects', async (check, n) => {
    const before = role(p);
    const ids = { api: p.inspect('rab-api', '{{.Id}}'), worker: p.inspect('rab-worker', '{{.Id}}') };
    L.writeSecrets(p.secretsDir, { caPath: null, appSecret: app2 });
    const d = deploy(p, 'S5-deploy');
    check(d.code === 0, `APP_SECRET changed in runtime.env, the documented command: exit ${d.code}`);
    await waitApp(p);
    check(p.inspect('rab-api', '{{.Id}}') !== ids.api && p.inspect('rab-worker', '{{.Id}}') !== ids.worker, 'rab-api and rab-worker were recreated with the new APP_SECRET');
    const sl = setupLog(p);
    evidence('S5-api.log', p.logs('rab-api'));
    evidence('S5-db-setup.log', sl);
    evidence('S5-worker.log', p.logs('rab-worker'));
    n(`bootstrap (db-setup): ${bootstrapLines(sl).join(' / ')}`);
    check(sl.includes(MSG.ready('password set')), 'db-setup\'s bootstrap child reset the password ("ready (password set)")');
    const after = role(p);
    check(after && after.oid === before.oid && exactly01(after), `same role, same attributes (${roleShape(after)})`);
    check(after && after.verifierSha !== before.verifierSha, 'the stored verifier changed (sha256 compared)');
    const newOk = p.ownerLoginWorks(d2);
    check(newOk, `the password derived from the NEW APP_SECRET logs in${newOk ? '' : ` (${p.lastOwnerLoginError})`}`);
    check(!p.ownerLoginWorks(d1), 'the password derived from the OLD APP_SECRET no longer logs in');
    const ss = checkSessions(p, check, 'S5');
    check(ss.some((x) => /worker/i.test(x.app)), `the new Worker is connected as crewflow_owner (${ss.filter((x) => /worker/i.test(x.app)).map((x) => x.app).join(', ') || 'no worker session'})`);
    const wl = p.logs('rab-worker');
    check(!/28P01|password authentication failed/i.test(wl), 'the Worker log has no authentication failure');
    const r2 = p.compose(['restart', 'rab-api'], { timeout: 300_000 });
    keep(p, 'S5-restart', r2.out);
    await waitApp(p, { worker: 0 });
    const again = role(p);
    check(again && again.verifierSha === after.verifierSha, 'restarting rab-api alone changes nothing (it runs no bootstrap child; same verifier)');
    const d3 = deploy(p, 'S5-redeploy');
    await waitApp(p);
    const again2 = role(p);
    check(d3.code === 0 && again2 && again2.verifierSha === after.verifierSha && lastReady(setupLog(p)).includes('(unchanged)'), 'the documented command again runs db-setup again: "ready (unchanged)", same verifier (the reset happens once per rotation)');
    checkEnviron(p, check, n, 'S5', [s.dbPassword]);
  }, p);

  await step('S10A', '10', 'the admin URL handed to a runtime process anyway (`run -e PG_DATABASE_URL=<admin>`): the entrypoints and every runtime process refuse before connecting', async (check, n) => {
    const stop = p.compose(['stop', 'rab-worker', 'rab-api'], { timeout: 300_000 });
    check(stop.code === 0, 'rab-api and rab-worker stopped (cap: one one-off container at a time)');
    const before = adminConnections(p, ['postgres']);
    // Option A: the compose files give rab-api / rab-worker no URL; an operator who passes the admin URL anyway.
    const ADMIN = { PG_DATABASE_URL: `postgresql://postgres:${s.dbPassword}@db:5432/crewflow?sslmode=verify-full` };
    for (const [svc, label] of [['rab-api', 'S10A-api-prestart'], ['rab-worker', 'S10A-worker-start']]) {
      const r = oneOff(p, svc, label, { env: ADMIN, timeout: 180_000 });
      check(r.code === 64 && /must be the crewflow_owner login/.test(r.out), `${label.slice(5)} (the production entrypoint with an admin PG_DATABASE_URL): exit ${r.code}, refused by derive --owner-only`);
    }
    const cases = [
      ['rab-worker', 'S10A-worker-main', ['packages/rab-worker/dist/main.js']],
      ['rab-api', 'S10A-api-main', ['packages/rab-server/dist/main.js']],
      ['rab-api', 'S10A-migrate-child', ['packages/rab-server/dist/database/typeorm/scripts/migrate/twenty/twenty-migrate.js']], // gitleaks:allow (a case label and a file path, not a credential)
    ];
    // The image's tini as PID 1 (the Worker refuses to be PID 1 itself), then node directly: no cleaning script runs.
    for (const [svc, label, cmd] of cases) {
      const r = oneOff(p, svc, label, { entrypoint: '/sbin/tini', cmd: ['-s', '--', 'node', ...cmd], timeout: 180_000, env: ADMIN });
      const line = (r.out.match(/.*PG_DATABASE_URL does not log in as crewflow_owner.*/) || [''])[0];
      check(r.code !== 0 && line.includes(MSG.runtimeLoginTail), `${label.slice(5)} (\`node ${cmd[0].split('/').slice(-2).join('/')}\` with the admin URL): exit ${r.code}, "${line.trim().slice(0, 150)}"`);
      check(!/password|postgres:\/\//i.test(L.redact(line).replace(/<redacted>/g, '')), `${label.slice(5)}: the refusal names no credential or URL`);
    }
    const after = adminConnections(p, ['postgres']);
    const sum = (a) => a.others.reduce((t, x) => t + x.n, 0);
    check(sum(after) === sum(before), `none of the five opened an admin connection (admin connections other than the bootstrap child, pg_isready and the test's psql: ${sum(before)} -> ${sum(after)})`);
  }, p);

  await step('S8', '8', 'logs never contain the admin URL, the admin password, an APP_SECRET, a derived crewflow_owner password or a verifier (db with log_statement=all)', async (check, n) => {
    const texts = logTexts(p);
    for (const [k, v] of Object.entries(texts)) evidence(`S8-${k.replace(/\W+/g, '-')}.txt`, v);
    n(`scanned: ${Object.entries(texts).map(([k, v]) => `${k} ${v.length} bytes`).join(', ')}`);
    check(/statement: /.test(texts['db log']) && /connection authorized/.test(texts['db log']), 'the db log is the worst case (statements and connections are logged)');
    const found = scanSecrets(texts, { 'admin password (PG_DATABASE_PASSWORD)': s.dbPassword, 'APP_SECRET (before rotation)': app1, 'APP_SECRET (after rotation)': app2, 'derived password (before rotation)': d1, 'derived password (after rotation)': d2 });
    check(found.length === 0, `no secret in any log or compose output${found.length ? `: FOUND ${found.join('; ')}` : ''}`);
    const urls = Object.entries(texts).filter(([, v]) => /postgres(ql)?:\/\/[^\s'"]*@/.test(v)).map(([k]) => k);
    check(urls.length === 0, `no database URL with credentials in any log${urls.length ? `: FOUND in ${urls.join(', ')}` : ''}`);
    const ver = Object.entries(texts).map(([k, v]) => [k, (v.match(VERIFIER_RE) || []).length]).filter(([, c]) => c);
    check(ver.length === 0, `no SCRAM verifier in any log (a superuser admin: the bootstrap child turns statement logging off for its session)${ver.length ? `: FOUND ${ver.map(([k, c]) => `${c} in ${k}`).join(', ')}` : ''}`);
  }, p);
  teardown(p);
}

// --------------------------------------------------------------------------------------------------------- block race
async function blockRace() {
  const p = project('race', { logging: false });
  L.writeSecrets(p.secretsDir, { caPath: null });
  use(p, { databaseUrl: null });
  await step('S9', '9', 'two db-setup runs at the same moment on a fresh bundled database: one bootstrap creates the role; then two API starts at the same moment: the migration lock lets one migrate child apply, the other finds CURRENT', async (check, n) => {
    const pull = p.compose(['pull', '--quiet'], { timeout: 600_000 });
    check(pull.code === 0, 'images pulled');
    const up = p.compose(['up', '-d', '--wait', L.DB_SERVICE], { timeout: 300_000 });
    keep(p, 'S9-db-up', up.out);
    check(up.code === 0, `db up and healthy (exit ${up.code})`);
    const logsOfS = (c) => L.run('docker', ['logs', c], { timeout: 60_000 }).out;
    const setups = [`${p.name}-setup-1`, `${p.name}-setup-2`];
    const ss = setups.map((c) => L.runAsync('docker', ['compose', 'run', '--no-deps', '-T', '--name', c, 'db-setup'], { env: p.composeEnv() }));
    const sr = await Promise.all(ss.map((x) => x.done));
    const slogs = setups.map(logsOfS);
    slogs.forEach((l, i) => evidence(`S9-db-setup-${i + 1}.log`, l));
    const sboot = slogs.map((l) => bootstrapLines(l));
    n(`db-setup 1: ${sboot[0].join(' / ')} || db-setup 2: ${sboot[1].join(' / ')}`);
    const created = slogs.filter((l) => l.includes(MSG.ready('created'))).length;
    // Area 2 (388630e3): the bootstrap child re-plans under its advisory lock, so the run that waited reports what it did.
    check(sr.every((r) => r.code === 0) && slogs.every((l) => /\[owner-bootstrap\] crewflow_owner is ready \(/.test(l)) && created === 1, `two db-setup runs at once: both exit 0, both report crewflow_owner ready, exactly one says "created" (exits ${sr.map((r) => r.code).join(', ')}; created: ${created})`);
    check(exactly01(role(p)), `one crewflow_owner, exactly the 01 attributes (${roleShape(role(p))})`);
    for (const c of setups) L.run('docker', ['rm', '-f', c], { timeout: 120_000 });
    const holder = await p.holdLock(`SELECT pg_advisory_lock(${L.MIGRATION_LOCK_KEY_SQL})`);
    const names = [`${p.name}-race-1`, `${p.name}-race-2`];
    const logsOf = (c) => L.run('docker', ['logs', c], { timeout: 60_000 }).out;
    try {
      const starts = names.map((c) => L.runAsync('docker', ['compose', 'run', '-d', '--no-deps', '--name', c, 'rab-api'], { env: p.composeEnv() }));
      const rs = await Promise.all(starts.map((x) => x.done));
      check(rs.every((r) => r.code === 0), `two one-off rab-api containers started together (./api-prestart.sh, the production entrypoint): exits ${rs.map((r) => r.code).join(', ')}`);
      await L.waitFor('both migrate children to wait for the migration lock', () => names.every((c) => /taking the migration lock/.test(logsOf(c))), 240_000, 2000);
      check(true, 'both built the crewflow_owner URL from the target file, passed the login wait and wait on the migration advisory lock');
    } finally {
      await holder.release();
    }
    await L.waitFor('both migrate results', () => names.every((c) => migrateResults(logsOf(c)).length >= 1), 600_000, 3000);
    const logs = names.map(logsOf);
    logs.forEach((l, i) => evidence(`S9-api-${i + 1}.log`, l));
    check(logs.every((l) => !l.includes('[owner-bootstrap]')), 'neither API start ran a bootstrap child (option A)');
    const res = logs.map((l) => migrateResults(l).pop() || {});
    n(`migrate 1: state ${res[0].state} applied ${(res[0].applied || []).length} exit ${res[0].exitCode}; migrate 2: state ${res[1].state} applied ${(res[1].applied || []).length} exit ${res[1].exitCode}`);
    const ledger = p.psql(`SELECT count(*) || '|' || count(DISTINCT name) FROM core.migrations`);
    const [lc, ld] = ledger.split('|').map(Number);
    const applied = res.map((r) => (r.applied || []).length).sort((a, b) => b - a);
    check(res.every((r) => r.exitCode === 0) && applied[0] === lc && applied[1] === 0, `one migrate child applied all ${lc} migrations, the other applied none (applied ${applied.join(' / ')})`);
    check(res.map((r) => r.state).includes('CURRENT'), `the second found the database CURRENT after waiting (${res.map((r) => r.state).join(', ')})`);
    check(lc === ld && lc > 200, `ledger ${lc} rows, no duplicates`);
    for (const c of names) L.run('docker', ['rm', '-f', c], { timeout: 120_000 });
  }, p);
  teardown(p);
}

// ---------------------------------------------------------------------------------------------------------- block ext
async function blockExternal() {
  const p = project('ext');
  const s = L.secrets;
  const pw = { owner4: L.hex(32), norole: L.hex(32), nogrant: L.hex(32), admin: L.hex(32), admin2: L.hex(32) };
  for (const [k, v] of Object.entries(pw)) s[`ext:${k}`] = v;
  const app1 = s.appSecret;
  const app2 = L.b64(48);
  const app3 = L.b64(48);
  Object.assign(s, { 'ext:app2': app2, 'ext:app3': app3 });
  const d1 = L.derivedOwnerPassword(app1);
  const d2 = L.derivedOwnerPassword(app2);
  L.writeSecrets(p.secretsDir, { caPath: null, appSecret: app1 });
  use(p, { databaseUrl: null });
  const url = (user, password) => `postgresql://${user}:${password}@db:5432/crewflow?sslmode=verify-full`;
  const noCore = () => p.psql(`SELECT count(*) FROM pg_namespace WHERE nspname = 'core'`) === '0';
  /** Objects crewflow_owner owns in this database (pg_shdepend 'o'), described, never values. */
  const owned = () => p.psql(`SELECT coalesce(string_agg(pg_describe_object(classid, objid, objsubid), ', ' ORDER BY 1), '') FROM pg_shdepend WHERE deptype = 'o' AND refobjid = (SELECT oid FROM pg_roles WHERE rolname = 'crewflow_owner') AND dbid = (SELECT oid FROM pg_database WHERE datname = current_database())`);
  /** Option A: a one-off db-setup (the bootstrap child) with the current compose.env: its exit code and fixed lines. */
  const start = (label) => {
    const r = oneOff(p, 'db-setup', label, { timeout: 300_000 });
    return { code: r.code, out: r.out, boot: bootstrapLines(r.out) };
  };

  await step('S4', '4', 'an existing crewflow_owner with SUPERUSER, then with BYPASSRLS: refused, the role left untouched', async (check, n) => {
    const up = p.compose(['up', '-d', '--wait', L.DB_SERVICE], { timeout: 300_000 });
    keep(p, 'S4-db-up', up.out);
    check(up.code === 0, `db up and healthy (exit ${up.code})`);
    p.psql(`CREATE ROLE crewflow_owner LOGIN SUPERUSER PASSWORD '${pw.owner4}'`);
    for (const [label, alter, attr] of [
      ['SUPERUSER', null, 'SUPERUSER'],
      ['BYPASSRLS', 'ALTER ROLE crewflow_owner NOSUPERUSER BYPASSRLS', 'BYPASSRLS'],
    ]) {
      if (alter) p.psql(alter);
      const before = role(p);
      const r = start(`S4-${label}`);
      n(`${label}: ${r.boot.join(' / ')}`);
      check(r.code === 64, `${label}: db-setup exits 64 (refusal), exit ${r.code}`);
      check(r.out.includes(MSG.privileged(attr)), `${label}: the fixed message "${MSG.privileged(attr).slice(0, 90)}…"`);
      const after = role(p);
      check(JSON.stringify(after) === JSON.stringify(before), `${label}: the role is untouched (attributes and verifier compared: ${roleShape(after)})`);
      check(noCore() && owned() === '', `${label}: nothing created (no core schema, the role owns no object${owned() ? `: ${owned()}` : ''})`);
      check(!/\n\s+at .*\(.*\.js:\d+:\d+\)/.test(r.out), `${label}: no stack trace`);
    }
  }, p);

  await step('S10B', '10', 'the same privileged crewflow_owner through the PASS-THROUGH URL: the runtime guards refuse BYPASSRLS and SUPERUSER, nothing created', async (check, n) => {
    use(p, { databaseUrl: url('crewflow_owner', pw.owner4) });
    for (const [label, alter, re] of [
      ['BYPASSRLS', null, /bypassrls|BYPASSRLS|bypass/],
      ['SUPERUSER', 'ALTER ROLE crewflow_owner SUPERUSER NOBYPASSRLS', /superuser|SUPERUSER/],
    ]) {
      if (alter) p.psql(alter);
      const su = start(`S10B-${label}-setup`);
      check(su.code === 0 && su.out.includes(MSG.passThrough), `${label}: db-setup passes the crewflow_owner URL through (the bootstrap child is skipped; exit ${su.code})`);
      const r = oneOff(p, 'rab-api', `S10B-${label}`, { timeout: 300_000 });
      const refusal = r.out.split('\n').filter((l) => re.test(l)).map((l) => l.trim()).slice(0, 2);
      n(`${label}: API exit ${r.code}; refusal: ${refusal.join(' | ').slice(0, 300)}`);
      check(r.code !== 0 && refusal.length > 0, `${label}: the API start (from db-setup's pass-through target) is refused by the runtime guard (exit ${r.code})`);
      check(noCore(), `${label}: no core schema created`);
      const o = owned();
      n(`${label}: objects the refused crewflow_owner owns after the refused start: ${o || 'none'}`);
    }
    p.psql('DROP OWNED BY crewflow_owner; DROP ROLE crewflow_owner;');
    use(p, { databaseUrl: null });
  }, p);

  const ok3 = await step('S3', '3', 'an EXTERNAL admin URL with a non-superuser login: refused without CREATEROLE, refused without the right to grant on the database, works with CREATEROLE + database owner (fresh, restart, rotation); no ADMIN OPTION -> refused when a reset is needed', async (check, n) => {
    p.psql(`CREATE ROLE ext_norole LOGIN NOCREATEROLE PASSWORD '${pw.norole}'; ALTER DATABASE crewflow OWNER TO ext_norole;`);
    use(p, { databaseUrl: url('ext_norole', pw.norole) });
    let r = start('S3-no-createrole');
    n(`no CREATEROLE: ${r.boot.join(' / ')}`);
    check(r.code === 64 && r.out.includes(MSG.cannotCreateRoles), `admin without CREATEROLE: exit ${r.code}, "${MSG.cannotCreateRoles}"`);
    check(role(p) === null && noCore(), 'no crewflow_owner, nothing created');
    p.psql(`CREATE ROLE ext_nogrant LOGIN CREATEROLE NOSUPERUSER PASSWORD '${pw.nogrant}'; ALTER DATABASE crewflow OWNER TO postgres;`);
    use(p, { databaseUrl: url('ext_nogrant', pw.nogrant) });
    r = start('S3-no-grant');
    n(`CREATEROLE, cannot grant: ${r.boot.join(' / ')}`);
    check(r.code === 64 && r.out.includes(MSG.cannotGrantDb), `admin with CREATEROLE that neither owns the database nor holds its privileges WITH GRANT OPTION: exit ${r.code}, "${MSG.cannotGrantDb}…"`);
    check(role(p) === null && noCore(), 'no crewflow_owner, nothing created');
    // The managed-provider shape (neondb_owner / RDS master / doadmin / Supabase postgres): NOSUPERUSER CREATEROLE, owns the database.
    p.psql(`CREATE ROLE ext_admin LOGIN CREATEROLE NOSUPERUSER NOBYPASSRLS PASSWORD '${pw.admin}'; ALTER DATABASE crewflow OWNER TO ext_admin; ALTER SCHEMA public OWNER TO ext_admin;`);
    use(p, { databaseUrl: url('ext_admin', pw.admin) });
    const d = deploy(p, 'S3-deploy');
    check(d.code === 0, `external admin (NOSUPERUSER CREATEROLE, owns the database) in PG_DATABASE_URL, the documented command: exit ${d.code}`);
    if (d.code !== 0) throw new Error('the external-admin deploy failed');
    await waitApp(p);
    const al = setupLog(p);
    evidence('S3-api.log', p.logs('rab-api'));
    evidence('S3-db-setup.log', al);
    n(`bootstrap (db-setup): ${bootstrapLines(al).join(' / ')}`);
    check(al.includes(MSG.ready('created')), 'crewflow_owner created by the non-superuser admin (db-setup)');
    const ro = role(p);
    check(exactly01(ro), `exactly the 01 attributes (${roleShape(ro)})`);
    check(/(^|[{,])crewflow_owner=C\*T\*c\*\/ext_admin([,}]|$)/.test(dbAcl(p)), `the grant comes from the external admin (${dbAcl(p)})`);
    check(p.psql(`SELECT count(*) FROM core.migrations`) > '200' && p.ownerLoginWorks(d1), 'migrated; the derived password logs in');
    checkSessions(p, check, 'S3');
    const a = adminConnections(p, ['ext_admin']);
    check(a.admin.some((x) => x.app === BOOTSTRAP_APP) && a.others.length === 0, `the only ext_admin connections are the bootstrap child's${a.others.length ? `; OTHERS: ${a.others.map((x) => `${x.app} x${x.n}`).join(', ')}` : ''}`);
    checkEnviron(p, check, n, 'S3', [pw.admin, s.dbPassword]);
    // restart
    const r1 = p.compose(['restart', 'rab-api', 'rab-worker'], { timeout: 300_000 });
    keep(p, 'S3-restart', r1.out);
    await waitApp(p);
    const ro2 = role(p);
    check(ro2.verifierSha === ro.verifierSha && ro2.oid === ro.oid, 'restart of rab-api / rab-worker: unchanged (same oid and verifier; no bootstrap child in them)');
    // rotation
    L.writeSecrets(p.secretsDir, { caPath: null, appSecret: app2 });
    const d2r = deploy(p, 'S3-rotate');
    check(d2r.code === 0, `APP_SECRET rotated: exit ${d2r.code}`);
    await waitApp(p);
    const ro3 = role(p);
    check(setupLog(p).includes(MSG.ready('password set')) && ro3.verifierSha !== ro.verifierSha, 'rotation with the non-superuser admin: the password is reset (it has ADMIN OPTION on the role it created); the Worker is healthy');
    const newOk = p.ownerLoginWorks(d2);
    check(newOk, `rotation: the new derived password logs in${newOk ? '' : ` (${p.lastOwnerLoginError})`}`);
    check(!p.ownerLoginWorks(d1), 'rotation: the old derived password no longer logs in');
    // a second admin without ADMIN OPTION on crewflow_owner, and a reset needed
    const stop = p.compose(['stop', 'rab-worker', 'rab-api'], { timeout: 300_000 });
    check(stop.code === 0, 'rab-api and rab-worker stopped');
    p.psql(`CREATE ROLE ext_admin2 LOGIN CREATEROLE NOSUPERUSER PASSWORD '${pw.admin2}'; GRANT CONNECT, CREATE, TEMPORARY ON DATABASE crewflow TO ext_admin2 WITH GRANT OPTION;`);
    use(p, { databaseUrl: url('ext_admin2', pw.admin2) });
    L.writeSecrets(p.secretsDir, { caPath: null, appSecret: app3 });
    r = start('S3-no-admin-option');
    n(`no ADMIN OPTION: ${r.boot.join(' / ')}`);
    check(r.code === 64 && r.out.includes(MSG.noAdminOption), `a second CREATEROLE admin that did not create crewflow_owner, with a reset needed: exit ${r.code}, "${MSG.noAdminOption}…"`);
    check(role(p).verifierSha === ro3.verifierSha, 'the role is untouched');
  }, p);

  await step('S8X', '8', 'external non-superuser admin: logs never contain the admin URL, either admin password or a derived password; a verifier only as the documented residual', async (check, n) => {
    if (!ok3) n('S3 did not pass: scanning what it left');
    const texts = logTexts(p);
    for (const [k, v] of Object.entries(texts)) evidence(`S8X-${k.replace(/\W+/g, '-')}.txt`, v);
    const found = scanSecrets(texts, {
      'bundled admin password': s.dbPassword,
      'ext_admin password': pw.admin,
      'ext_admin2 password': pw.admin2,
      'ext_norole password': pw.norole,
      'ext_nogrant password': pw.nogrant,
      'hand-made crewflow_owner password (S4/S10B)': pw.owner4,
      'derived password 1': d1,
      'derived password 2': d2,
      'APP_SECRET 1': app1,
      'APP_SECRET 2': app2,
      'APP_SECRET 3': app3,
    });
    check(found.length === 0, `no secret in any log or compose output${found.length ? `: FOUND ${found.join('; ')}` : ''}`);
    const urls = Object.entries(texts).filter(([, v]) => /postgres(ql)?:\/\/[^\s'"]*@/.test(v)).map(([k]) => k);
    check(urls.length === 0, `no database URL with credentials in any log${urls.length ? `: FOUND in ${urls.join(', ')}` : ''}`);
    const dbVer = (texts['db log'].match(VERIFIER_RE) || []).length;
    const appVer = Object.entries(texts).filter(([k]) => k !== 'db log').reduce((a, [, v]) => a + (v.match(VERIFIER_RE) || []).length, 0);
    check(appVer === 0, 'no verifier in an application log or compose output');
    n(`RESIDUAL (plan §3.6 / B9): the db log (log_statement=all, a NON-superuser admin cannot turn statement logging off for its session) holds ${dbVer} SCRAM verifier occurrence(s), never a password`);
    check(true, `db log verifier occurrences with the non-superuser admin: ${dbVer} (documented residual; the password itself: 0)`);
  }, p);
  teardown(p);
}

// --------------------------------------------------------------------------------------------------------- block r256
async function blockR256() {
  const p = project('r256', { ownerInit: true, logging: false });
  const s = L.secrets;
  const d1 = L.derivedOwnerPassword(s.appSecret);
  L.writeSecrets(p.secretsDir); // PG_SSL_CA_CERT_PATH spelled out: R256 has no bundled-db CA rule
  await step('S7', '7', 'an R256 database upgrades unchanged with its crewflow_owner URL (pass-through), then with the admin URL (the password is reset once)', async (check, n) => {
    // R256 on THIS release's compose files alone: what a rollback across DB-SETUP without the old files does.
    p.setPrev(false);
    use(p, { digest: R256, databaseUrl: L.ownerUrl() });
    const d0 = deploy(p, 'S7-r256-new-files');
    const s0 = p.health('db-setup');
    const a0 = p.neverStarted('rab-api');
    const sl0 = setupLog(p);
    evidence('S7-r256-new-files-db-setup.log', sl0);
    n(`R256 with this release's compose files alone: deploy exit ${d0.code}; db-setup ${s0} (health|status|exit|restarts); rab-api ${a0 ? 'never started' : p.health('rab-api')}`);
    check(d0.code !== 0 && !s0.endsWith('|0|0') && a0, 'OBSERVED: a pre-DB-SETUP image cannot run under this release\'s compose files (./db-setup.sh is not in the old image, so db-setup fails and rab-api never starts): a rollback across DB-SETUP needs the previous release\'s compose files');
    p.setPrev(true);
    const d = deploy(p, 'S7-r256');
    check(d.code === 0, `R256 (its own rab-worker command, the hand-made crewflow_owner of 01-crewflow-owner.sql): exit ${d.code}`);
    await waitApp(p);
    check(p.psql('SELECT count(*) FROM core.migrations') === '256', 'R256 installed its 256 migrations');
    p.psqlFile('seed-organisations.sql');
    check(p.psql(`SELECT count(*) FROM core.organisation WHERE slug::text LIKE 'dot-seed-%'`) === '2', 'seeded 2 synthetic organisations');
    const before = L.facts(p);
    const r0 = role(p);
    n(`R256 crewflow_owner: ${roleShape(r0)}`);
    // (a) pass-through
    p.setPrev(false);
    use(p, { digest: NEW, databaseUrl: L.ownerUrl() });
    const da = deploy(p, 'S7-new-pass-through');
    check(da.code === 0, `NEW with the unchanged crewflow_owner URL: exit ${da.code}`);
    await waitApp(p);
    const ala = p.logs('rab-api');
    const sla = setupLog(p);
    evidence('S7-new-pass-through-api.log', ala);
    evidence('S7-new-pass-through-db-setup.log', sla);
    check(sla.includes(MSG.passThrough) && !sla.includes('[owner-bootstrap] crewflow_owner is ready'), `pass-through: db-setup says "${MSG.passThrough}", the bootstrap child never connected`);
    const ra = role(p);
    check(JSON.stringify(ra) === JSON.stringify(r0), 'pass-through: crewflow_owner unchanged (oid, attributes, verifier)');
    const mra = migrateResults(ala).pop() || {};
    n(`pass-through migrate result: state ${mra.state}, applied ${(mra.applied || []).length}`);
    check(mra.exitCode === 0 && p.psql(`SELECT count(*) || '|' || count(DISTINCT name) FROM core.migrations`).split('|').every((x, i, a) => x === a[0]), 'the upgrade completed, no duplicate ledger rows');
    L.compareFacts(check, before, L.facts(p), 'pass-through upgrade');
    L.rlsCheck(p, check, 'pass-through upgrade');
    checkSessions(p, check, 'S7 pass-through');
    // (b) the admin URL (the bundled default)
    use(p, { digest: NEW, databaseUrl: null });
    const db = deploy(p, 'S7-new-admin-url');
    check(db.code === 0, `NEW with the bundled admin URL instead (PG_DATABASE_URL removed from compose.env): exit ${db.code}`);
    await waitApp(p);
    const alb = setupLog(p);
    evidence('S7-new-admin-url-api.log', p.logs('rab-api'));
    evidence('S7-new-admin-url-db-setup.log', alb);
    n(`bootstrap (db-setup): ${bootstrapLines(alb).join(' / ')}`);
    check(alb.includes(MSG.ready('password set')), 'admin URL: db-setup resets the existing crewflow_owner\'s password to the derived one ("ready (password set)")');
    const rb = role(p);
    check(rb.oid === r0.oid && rb.verifierSha !== r0.verifierSha && exactly01(rb), `same role, new verifier, attributes unchanged (${roleShape(rb)})`);
    check(p.ownerLoginWorks(d1) && !p.ownerLoginWorks(s.owner), 'the derived password logs in; the hand-made one no longer does');
    p.ownerPassword = d1;
    L.compareFacts(check, before, L.facts(p), 'admin-URL start');
    L.rlsCheck(p, check, 'admin-URL start');
    checkSessions(p, check, 'S7 admin URL');
    const rr = p.compose(['restart', 'rab-api'], { timeout: 300_000 });
    keep(p, 'S7-restart', rr.out);
    await waitApp(p, { worker: 0 });
    const rc = role(p);
    const dc = deploy(p, 'S7-redeploy');
    await waitApp(p);
    const rc2 = role(p);
    check(rc.verifierSha === rb.verifierSha && dc.code === 0 && rc2.verifierSha === rb.verifierSha && lastReady(setupLog(p)).includes('(unchanged)'), 'the next starts change nothing (an API restart, then db-setup again: "ready (unchanged)"): the password was reset ONCE');
  }, p);
  teardown(p);
}

// --------------------------------------------------------------------------------------------------------- block pg15
async function blockPg15() {
  const p = project('pg15', { logging: false });
  L.writeSecrets(p.secretsDir, { caPath: null });
  use(p, { databaseUrl: null, pgImage: PG15_IMAGE });
  await step('S10C', '10', 'PostgreSQL 15 as the bundled db: refused before anything is created', async (check, n) => {
    const up = p.compose(['up', '-d', '--wait', L.DB_SERVICE], { timeout: 300_000 });
    keep(p, 'S10C-db-up', up.out);
    check(up.code === 0, `db (PostgreSQL 15) up and healthy (exit ${up.code})`);
    check(p.psql('SHOW server_version_num').startsWith('15'), 'the server is PostgreSQL 15');
    const r = oneOff(p, 'db-setup', 'S10C-db-setup', { timeout: 300_000 });
    n(`bootstrap: ${bootstrapLines(r.out).join(' / ')}`);
    check(r.code === 64 && r.out.includes(MSG.pgTooOld), `db-setup exits 64 with "${MSG.pgTooOld}" (exit ${r.code})`);
    check(role(p) === null && p.psql(`SELECT count(*) FROM pg_namespace WHERE nspname = 'core'`) === '0', 'no crewflow_owner, nothing created');
  }, p);
  teardown(p);
}

// ------------------------------------------------------------------------------------------------------------- main
async function main() {
  L.newSecrets();
  const stopSampler = startPeakSampler();
  note(`PostgreSQL ${PG_IMAGE}; image ${imageRef(NEW)}; R256 ${R256 ? imageRef(R256) : '(not set)'}; PG15 ${PG15_IMAGE ?? '(not set)'}; blocks ${BLOCKS.join(',')}`);
  if (BLOCKS.includes('a')) await blockBundled();
  if (BLOCKS.includes('race')) await blockRace();
  if (BLOCKS.includes('ext')) await blockExternal();
  // R256 supports PostgreSQL 16 and 18 only (its fingerprint majors; it refuses 17 at boot): no R256 database exists on 17.
  if (BLOCKS.includes('r256') && R256 && MAJOR === '17') {
    note('block r256 not run on PostgreSQL 17: R256 refuses 17 at boot (SUPPORTED_FINGERPRINT_MAJORS = [16, 18]), so no R256 database on 17 exists to upgrade');
    results.push({ id: 'S7', owner: '7', title: 'not applicable on 17: R256 never ran on PostgreSQL 17', status: 'N/A', checks: [], notes: [] });
  } else if (BLOCKS.includes('r256') && R256) await blockR256();
  if (BLOCKS.includes('pg15') && PG15_IMAGE) await blockPg15();
  stopSampler();
  note(`peak of this run's running containers: ${peak.count} at ${peak.at} (${peak.names.join(', ')})`);
  writeResults();
  const summary = [
    `# DB-SETUP real-container tests, PostgreSQL ${MAJOR}`,
    '',
    `image \`${imageRef(NEW)}\`; db \`${PG_IMAGE}\`; command \`docker compose pull && docker compose up -d\``,
    `peak running containers of this run: ${peak.count} (cap ${MAX_CONTAINERS})`,
    '',
    '| case | owner test | status | checks |',
    '|---|---|---|---|',
    ...results.map((r) => `| ${r.id} | ${r.owner} | ${r.status} | ${r.checks.filter((c) => c.ok).length}/${r.checks.length} |`),
    '',
    ...results.flatMap((r) => [`## ${r.id} (owner ${r.owner}) ${r.status}: ${r.title}`, ...r.checks.map((c) => `- ${c.ok ? 'ok' : '**FAIL**'} ${c.what}`), ...r.notes.map((x) => `- note: ${x}`), '']),
  ].join('\n');
  fs.writeFileSync(path.join(OUT, 'SUMMARY.md'), L.redact(summary));
  fs.writeFileSync(path.join(OUT, 'run.log'), logLines.join('\n'));
  if (peak.count > MAX_CONTAINERS) note(`CONTAINER CAP EXCEEDED: ${peak.count} > ${MAX_CONTAINERS}`);
  process.exitCode = results.length > 0 && results.every((r) => r.status === 'PASS' || r.status === 'N/A') && peak.count <= MAX_CONTAINERS ? 0 : 1;
}

main().catch((e) => {
  console.error(L.redact(e && e.stack ? e.stack : String(e)));
  for (const p of projects) if (!KEEP) p.down();
  process.exit(1);
});
