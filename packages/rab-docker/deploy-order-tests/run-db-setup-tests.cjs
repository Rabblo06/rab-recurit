'use strict';
/**
 * DB-SETUP REAL-CONTAINER TESTS, PR #125 THE TWENTY HELM WAY (OWNER-DB-FINAL.md Part A, A6; DB-SETUP-HELM-PLAN.md).
 * TEST-ONLY. One PostgreSQL major per run (16, 17 or 18), the production file docker-compose.image.yml UNCHANGED (its
 * bundled `db`, the one-shot `db-setup`, rab-api with api-prestart.sh, rab-worker with worker-start.sh) plus the test-only
 * overlays of this folder, deployed with THE documented command `docker compose pull && docker compose up -d`.
 *
 * The design under test: PG_DATABASE_URL (compose.env) is the ONE database setting and reaches db-setup ONLY (rab-api /
 * rab-worker pin it to "" and refuse any non-empty value). db-setup keeps crewflow_owner's password in a file on its setup
 * volume (0400, 1000:1000): for the bundled db or a client's admin URL a random 32-byte password, written before the
 * transaction, crewflow_owner created only if missing (01-crewflow-owner.sql attributes and grants), later starts change
 * nothing; for an existing crewflow_owner URL only O1 + the read-only refusals, that URL's password copied into the file,
 * the database never written. The apps build their URL from target.json (credential-free) + the password file, both
 * read-only. APP_SECRET is never part of a database credential. Crewflow additions (labelled): an admin URL creates
 * crewflow_owner; a lost file + an admin URL resets the password.
 *
 *   DOT_REPOSITORY=127.0.0.1:<port>/adolphus     a LOCAL registry (never Docker Hub)
 *   DOT_NEW_DIGEST=sha256:…                      the image under test, pushed to that registry
 *   DOT_PG_IMAGE=postgres@sha256:…               the bundled db's image for this major: a DEBIAN postgres image
 *   DOT_REDIS_IMAGE=redis@sha256:…
 *   [DOT_R256_DIGEST=sha256:…]                   R256 (0e0a6edd) in the same registry: enables block r256
 *   [DOT_PG15_IMAGE=postgres@sha256:…]           a Debian postgres:15 image: enables block pg15
 *   [DOT_PROJECT_PREFIX=dbs]                     project names <prefix>-pg<major>-<block>; never shared between runs
 *   [DOT_OWNER_PASSWORD_FILE=/run/crewflow/db-target/…]  the password file's path inside the containers (upgrade-lib)
 *     node packages/rab-docker/deploy-order-tests/run-db-setup-tests.cjs <16|17|18> <out-dir>
 *          [--blocks=a,dep,race,ext,ref,pt,ptx,r256,pg15] [--only=S1,P1,...] [--keep]
 *
 * Blocks (each its own disposable project, run one after another, `down --volumes` after each):
 *   a     bundled db. S1 fresh with ONLY PG_DATABASE_PASSWORD + APP_SECRET (+ dummy non-database settings): crewflow_owner
 *         created (01 attributes and grant), migrations applied, API + Worker healthy; the password file 0400 1000:1000,
 *         random (>= 32 chars), logs in, read-only in both apps, read-write only in db-setup, absent from every env file,
 *         container definition, rendered compose config and from the image (inspect, history, filesystem). S6 no admin
 *         credential in any rab-api / rab-worker process (PID 1 included), docker exec / health-check process or container
 *         definition (PG_DATABASE_URL present and EMPTY there); the crewflow_owner password only in the runtime's own
 *         crewflow_owner URL. S2 restart, then down + up: the same password file, ZERO database changes (role, verifier,
 *         memberships, ACL, role/database settings snapshots identical). S5 APP_SECRET change: apps recreated and connected,
 *         the database and the file untouched, db-setup never receives APP_SECRET. F1 the file present with a password that
 *         no longer logs in: refused 64 with the fix message, nothing changed; then the file deleted + the admin URL: reset
 *         (new random password, old ones refused), the apps recover. S10A the admin URL forced into the apps: refused before
 *         connecting. S8 no log holds a password, an APP_SECRET, a credentialed URL or a verifier.
 *   dep   S11 `depends_on` ignored: rab-api / rab-worker started BEFORE db-setup on a fresh db wait (no connection), then
 *         recover once db-setup has run.
 *   race  S9 two db-setup at the same moment on a fresh db: one creates crewflow_owner, the file's password logs in; then
 *         two API starts at once: one migrate child applies, the other finds CURRENT.
 *   ext   S4 an existing SUPERUSER / BYPASSRLS crewflow_owner, admin path: refused, untouched. S3 an EXTERNAL non-superuser
 *         admin URL: no CREATEROLE / cannot grant -> refused; CREATEROLE + owns the database -> created, restart unchanged,
 *         APP_SECRET change unchanged, lost file -> reset; a second admin without ADMIN OPTION + lost file -> refused; the
 *         admin URL absent from every app process / docker exec / definition. S8X log scan. M1 an admin URL naming a missing
 *         database: refused, nothing created.
 *   ref   the H1 / N1 / N2 refusals on the bundled db: SP a search_path default -> 64; H1a crewflow_owner OWNS the database
 *         and plants an operator + database search_path -> 64, ZERO planted calls during the setup (a sanity call proves
 *         the plant is live); H1b the same through an INHERITed owner role; N2 a SET-only membership of the owner -> 64;
 *         N1 a transition-shaped database (owner role inherited by a NOCREATEROLE crewflow_owner): the admin URL -> 64,
 *         the crewflow_owner URL -> works, nothing written (runbook §5.4).
 *   pt    an existing crewflow_owner URL (hand-made with 01-crewflow-owner.sql). P1 used unchanged: zero writes (every
 *         statement of the setup sessions read-only in the db log; role snapshot identical), the OLD password still logs
 *         in, the file holds it, API + Worker healthy, again on the next start. P5 a non-empty PG_DATABASE_URL forced into
 *         the apps: exit 64 before any connection. S10B crewflow_owner made privileged after db-setup: the runtime guards
 *         refuse. F2 the file lost with no admin URL: a valid crewflow_owner URL rewrites it (no write); a crewflow_owner URL
 *         whose password no longer logs in -> refused 64, no file, an app start waits and gives up without connecting.
 *   ptx   P3 the crewflow_owner URL of a SUPERUSER, then a BYPASSRLS crewflow_owner: db-setup 64, untouched, no extension
 *         or object created, the apps never start.
 *   r256  S7 an R256 database (seeded) upgrades with its crewflow_owner URL (unchanged, password kept) and then with the
 *         bundled admin URL (the file logs in: unchanged); data, money, FKs, tenant ownership, RLS identical.
 *   pg15  S10C PostgreSQL 15: refused 64, nothing created.
 *
 * Limits: at most six running containers of this run (db, rab-redis, rab-api, rab-worker + the registry, + db-setup or one
 * one-off). Secrets are generated per run under <out>/secrets-<project> (outside the repository), reach the containers only
 * through env files; the crewflow_owner password file is read into memory only; every captured output is redacted before
 * it is written or printed; secret checks only COUNT matches. Results: <out>/RESULTS.json, SUMMARY.md, run.log, evidence/.
 */
const fs = require('node:fs');
const path = require('node:path');

const L = require('./upgrade-lib.cjs');

const argv = process.argv.slice(2);
const MAJOR = argv[0];
// Git Bash hands over /c/... paths; on Windows node would resolve them to C:\c\..., so map the drive prefix.
const OUT = argv[1] ? path.resolve(process.platform === 'win32' ? argv[1].replace(/^\/([a-z])\//i, '$1:/') : argv[1]) : '';
const KEEP = argv.includes('--keep');
const BLOCKS = (argv.find((a) => a.startsWith('--blocks=')) ?? '--blocks=a,dep,race,ext,ref,pt,ptx,r256,pg15').slice(9).split(',').filter(Boolean);
/** --only=<ids>: run only these cases (the others of a selected block are skipped and not reported). */
const ONLY = (argv.find((a) => a.startsWith('--only=')) ?? '').slice(7).split(',').filter(Boolean);
function fail(msg) {
  console.error(msg);
  process.exit(2);
}
if (!['16', '17', '18'].includes(MAJOR) || !OUT) fail('usage: run-db-setup-tests.cjs <16|17|18> <out-dir> [--blocks=a,dep,race,ext,ref,pt,ptx,r256,pg15] [--only=S1,P1,...] [--keep]');
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
const MAX_CONTAINERS = 6; // + the one-shot db-setup or one one-off beside a running stack (PR #125)
const LOGGING_OVERLAY = 'deploy-order-tests/docker-compose.db-setup-logging.yml';
const BOOTSTRAP_APP = 'crewflow-owner-bootstrap';
const MSG = {
  // owner-bootstrap.ts OWNER_BOOTSTRAP_MESSAGES. The fixed refusal texts kept from #125 are compared exactly; the outcome
  // lines and the Helm-design refusals are matched loosely (their final wording is the CODE agent's).
  pgTooOld: 'PostgreSQL 16 or later is required.',
  privileged: (attrs) => `crewflow_owner exists with ${attrs}; Crewflow never runs as a privileged login.`,
  cannotCreateRoles: "The PG_DATABASE_URL login cannot create roles (needs CREATEROLE, or use the provider's admin login).",
  cannotGrantDb: 'The PG_DATABASE_URL login cannot grant CONNECT, CREATE, TEMPORARY on this database',
  noAdminOption: /must be reset, but the PG_DATABASE_URL login has no ADMIN OPTION on crewflow_owner|must be reset but the PG_DATABASE_URL login has no ADMIN OPTION on it/,
  ownerOwnsDatabase: /crewflow_owner owns this database/,
  searchPathDefault: /search_path default is set/,
  missingDb: /does not exist/,
  // decision A3.1: the file's password no longer logs in -> 64 with the fix
  wrongPasswordFix: /delete the password file/i,
  readyCreated: /crewflow_owner is ready \(created/,
  readyUnchanged: /crewflow_owner is ready \((existing crewflow_owner URL, )?unchanged/,
  readyReset: /crewflow_owner is ready \(password (set|reset)/,
  // a concurrent db-setup on the same volume: the password-file race message, or (per-volume lock) "another db-setup is running"
  passwordFileRace: /Another db-setup stored a crewflow_owner password at the same moment|another db-setup is running/i,
  // api-prestart.sh / worker-start.sh: any non-empty PG_DATABASE_URL, any login.
  entrypointRefusal: /PG_DATABASE_URL must never be set on the (api|worker) service/,
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
  if (ONLY.length && !ONLY.includes(id)) return true;
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
  'e=$(tr "\\0" "\\n" < /proc/$$/environ); h=0; for s in "$S1" "$S2" "$S3"; do case "$e" in *"$s"*) h=1;; esac; done',
  // Option 2: the definition pins PG_DATABASE_URL to "": present and EMPTY in a docker exec process.
  'z=unset; printf "%s\\n" "$e" | grep -q "^PG_DATABASE_URL=" && z=set; printf "%s\\n" "$e" | grep -qx "PG_DATABASE_URL=" && z=empty',
  'echo "probe|$h|$z"',
].join('\n');

/**
 * Every process of a running container: does its /proc/<pid>/environ hold any sentinel (the admin password)? The sentinels
 * travel on stdin (never argv or the probe's environment); only flags are returned. Runs as the container user (uid 1000),
 * which is what can read the app processes' environ.
 */
function environScan(p, service, sentinels) {
  const pad = [...sentinels, L.hex(24), L.hex(24), L.hex(24)].slice(0, 3);
  const r = L.run('docker', ['exec', '-i', '-e', 'DOT_ENVIRON_PROBE=1', p.container(service), 'sh', '-c', ENVIRON_SCRIPT], { input: `${pad.join('\n')}\n`, timeout: 240_000 });
  if (r.code !== 0) throw new Error(`environ scan of ${service} failed (${r.code}): ${L.redact(r.out).slice(0, 300)}`);
  const rows = [];
  let probe = null;
  let probeUrl = '?';
  for (const line of r.stdout.split('\n').filter(Boolean)) {
    const f = line.split('|');
    if (f[0] === 'probe') {
      probe = f[1] === '1';
      probeUrl = f[2] ?? '?';
    }
    else if (f[1] !== 'gone') rows.push({ pid: f[0], hit: f[1] === '1', empty: f[1] === 'empty', urlUser: f[2] ?? '', pwVar: Number(f[3] || 0), cmd: (f[4] ?? '').trim() });
  }
  return { rows, probe, probeUrl };
}

/** The rendered compose config (never written or printed): each app service's PG_DATABASE_URL, and whether db-setup has one. */
function renderedUrls(p) {
  const r = p.compose(['config', '--format', 'json'], { timeout: 120_000 });
  if (r.code !== 0) throw new Error(`compose config failed (${r.code})`);
  const cfg = JSON.parse(r.stdout);
  const env = (svc) => (cfg.services && cfg.services[svc] && cfg.services[svc].environment) || {};
  return { api: env('rab-api').PG_DATABASE_URL, worker: env('rab-worker').PG_DATABASE_URL, setupSet: Boolean(env('db-setup').PG_DATABASE_URL) };
}
function checkEnviron(p, check, n, label, sentinels, { services = ['rab-api', 'rab-worker'] } = {}) {
  for (const svc of services) {
    const { rows, probe, probeUrl } = environScan(p, svc, sentinels);
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
    check(probeUrl === 'empty', `${label}: a \`docker exec\` process in ${svc} has PG_DATABASE_URL present and EMPTY (pinned ""; state ${probeUrl})`);
    const def = L.run('docker', ['inspect', '-f', '{{range .Config.Env}}{{println .}}{{end}}', p.container(svc)], { timeout: 180_000 }).stdout;
    const defUrl = (def.match(/^PG_DATABASE_URL=(.*)$/m) || [null, null])[1];
    check(!sentinels.some((x) => def.includes(x)) && !/^PG_DATABASE_PASSWORD=/m.test(def) && defUrl === '' && !/postgres(ql)?:\/\//.test(def), `${label}: ${svc}'s container definition (docker inspect Config.Env) holds no admin credential, no PG_DATABASE_PASSWORD and no database URL (PG_DATABASE_URL present and EMPTY)`);
  }
  const ru = renderedUrls(p);
  check(ru.api === '' && ru.worker === '' && ru.setupSet, `${label}: the rendered compose config gives rab-api and rab-worker PG_DATABASE_URL="" (whatever compose.env holds) and db-setup a URL (api ${ru.api === '' ? 'empty' : ru.api === undefined ? 'absent' : 'SET'}, worker ${ru.worker === '' ? 'empty' : ru.worker === undefined ? 'absent' : 'SET'})`);
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
  '    z=$(printf "%s\\n" "$e" | grep -cx "PG_DATABASE_URL=")',
  '    seen="$seen $p"; echo "$p|$h|$u|$(printf "%s" "$c" | cut -c1-80)|$z"',
  '  done',
  'done',
].join('\n');
function healthScan(p, check, n, label, sentinels, seconds = 40) {
  for (const [svc, pat] of [['rab-api', 'wget -qO- http://localhost:3000/healthz'], ['rab-worker', 'worker-bundle-health.cjs']]) {
    const pad = [...sentinels, L.hex(24), L.hex(24), L.hex(24)].slice(0, 3);
    const r = L.run('docker', ['exec', '-i', '-e', 'DOT_HEALTH_SCAN=1', p.container(svc), 'sh', '-c', HEALTH_SCAN], { input: `${pad.join('\n')}\n${pat}\n${seconds}\n`, timeout: (seconds + 60) * 1000 });
    const rows = r.stdout.split('\n').filter(Boolean).map((l) => { const f = l.split('|'); return { pid: f[0], hit: f[1] === '1', url: f[2] !== '0', cmd: f[3] ?? '', empty: f[4] === '1' }; });
    evidence(`${p.name}-${label}-${svc}-healthcheck-environ.txt`, rows.map((x) => `pid ${x.pid} [${x.cmd}] ${x.hit ? 'ADMIN-CREDENTIAL' : 'clean'}${x.url ? ' PG_DATABASE_URL-set' : ''}`).join('\n'));
    n(`${svc}: ${rows.length} health-check process(es) caught while running in ${seconds} s (${rows.map((x) => `pid ${x.pid} ${x.hit ? 'ADMIN' : 'clean'}`).join(', ') || 'none caught'})`);
    check(r.code === 0 && rows.every((x) => !x.hit && !x.url), `${label}: every ${svc} health-check process caught while running holds no admin credential and no database URL (${rows.length} caught)`);
    check(rows.every((x) => x.empty), `${label}: every ${svc} health-check process caught has PG_DATABASE_URL present and EMPTY (pinned ""; ${rows.filter((x) => x.empty).length}/${rows.length})`);
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

/** The bootstrap child runs in the one-shot db-setup service; its log holds the [owner-bootstrap] lines. */
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
  const r = L.run('docker', ['exec', p.container(L.DB_SERVICE), 'sh', '-c', 'openssl x509 -noout -fingerprint -sha256 -in /var/lib/postgresql/tls/server.crt; openssl x509 -noout -fingerprint -sha256 -in /var/tmp/ca.crt'], { timeout: 180_000 });
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

// ------------------------------------------------------------------------------------------- password file / snapshots
const sha = (v) => require('node:crypto').createHash('sha256').update(String(v)).digest('hex');
/** Everything about crewflow_owner and the database a setup run could change; compared as one string (no secret values). */
function dbSnapshot(p) {
  const r = role(p);
  const members = p.psql(
    `SELECT coalesce(string_agg(b.rolname || ':' || m.inherit_option || '/' || m.set_option || '/' || m.admin_option, ',' ORDER BY b.rolname), '') FROM pg_auth_members m JOIN pg_roles b ON b.oid = m.roleid WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = 'crewflow_owner')`,
  );
  const settings = p.psql(`SELECT coalesce(string_agg(coalesce(d.datname, '-') || '/' || coalesce(r.rolname, '-') || '=' || array_to_string(s.setconfig, ';'), ',' ORDER BY 1), '') FROM pg_db_role_setting s LEFT JOIN pg_database d ON d.oid = s.setdatabase LEFT JOIN pg_roles r ON r.oid = s.setrole`);
  const owner = p.psql(`SELECT datdba::regrole::text FROM pg_database WHERE datname = 'crewflow'`);
  const roles = p.psql(`SELECT count(*) FROM pg_roles`);
  return JSON.stringify({ role: r, acl: dbAcl(p), members, settings, owner, roles });
}
const snapDiff = (a, b) => {
  const x = JSON.parse(a);
  const y = JSON.parse(b);
  return Object.keys(x).filter((k) => JSON.stringify(x[k]) !== JSON.stringify(y[k])).join(', ') || 'none';
};
/** The setup volume's mount in a service's container: 'rw' / 'ro' / 'absent'. */
function targetMount(p, svc) {
  const r = L.run('docker', ['inspect', '-f', '{{json .Mounts}}', p.container(svc)], { timeout: 180_000 });
  if (r.code !== 0) return 'absent';
  const m = (JSON.parse(r.stdout || '[]') || []).find((x) => x.Destination === L.TARGET_DIR);
  return m ? (m.RW ? 'rw' : 'ro') : 'absent';
}
/** Delete the password file with the documented env-free command (operator command 2: docker run ... rm -f /v/owner-password). */
function deletePasswordFile(p, label) {
  const r = L.removePasswordFile(p, imageRef(NEW));
  keep(p, label, r.out);
  if (r.code !== 0) throw new Error(`deleting the password file failed (${r.code}): ${L.redact(r.out).slice(0, 200)}`);
  return r;
}
/**
 * The password file's facts for a running stack: present, 0400 1000:1000, logs in, read-only in both apps and read-write
 * in db-setup, never in an env file, a container definition, the rendered config, a docker exec / health-check process;
 * in an app process only inside the runtime's own crewflow_owner URL. Returns the password (memory only).
 */
function checkPasswordFile(p, check, n, label, { random = true, healthCheck = false, urlSupplied = false } = {}) {
  const f = p.readPasswordFile();
  check(Boolean(f), `${label}: the password file exists on the setup volume`);
  if (!f) return null;
  const pw = f.password;
  check(f.mode === '400 1000:1000', `${label}: the password file is 0400 1000:1000 (${f.mode})`);
  check(!p.setupPathExists(`${L.OWNER_PASSWORD_FILE}.next`), `${label}: no ${path.posix.basename(L.OWNER_PASSWORD_FILE)}.next left behind`);
  if (random) check(pw.length >= 32 && !/\s/.test(pw), `${label}: a random password of ${pw.length} characters (>= 32; value not shown)`);
  check(p.ownerLoginWorks(pw), `${label}: the file's password logs in as crewflow_owner (verify-full)`);
  const m = Object.fromEntries(['rab-api', 'rab-worker', 'db-setup'].map((x) => [x, targetMount(p, x)]));
  check(m['rab-api'] === 'ro' && m['rab-worker'] === 'ro', `${label}: the setup volume is read-only in rab-api and rab-worker (${Object.entries(m).map(([k, v]) => `${k}=${v}`).join(', ')})`);
  const setupMount = m['db-setup'];
  check(setupMount === 'rw' || setupMount === 'absent', `${label}: only db-setup mounts it read-write (${setupMount}; absent = its container is gone)`);
  const envFiles = ['compose.env', 'database.env', 'runtime.env'].map((x) => fs.readFileSync(path.join(p.secretsDir, x), 'utf8'));
  // urlSupplied: the operator gave the crewflow_owner URL (PG_DATABASE_URL, compose.env), so that password is legitimately in
  // compose.env, db-setup's definition and the rendered config; it must still be in no app definition or app env.
  check(!envFiles.some((e, i) => (!(urlSupplied && i === 0) && e.includes(pw)) || /PASSWORD_FILE|owner-password/i.test(e)), `${label}: no env file holds the password${urlSupplied ? ' (except the operator own crewflow_owner URL in compose.env)' : ''} or a password-file setting`);
  for (const svc of [...(urlSupplied ? [] : ['db-setup']), 'rab-api', 'rab-worker', L.DB_SERVICE]) {
    const def = L.run('docker', ['inspect', '-f', '{{range .Config.Env}}{{println .}}{{end}}', p.container(svc)], { timeout: 180_000 });
    if (def.code !== 0) continue;
    check(!def.stdout.includes(pw), `${label}: ${svc}'s container definition does not hold the password`);
  }
  if (!urlSupplied) {
    const cfg = p.compose(['config'], { timeout: 120_000 });
    check(cfg.code === 0 && !cfg.stdout.includes(pw), `${label}: the rendered compose config does not hold the password`);
  }
  for (const svc of ['rab-api', 'rab-worker']) {
    const { rows, probe } = environScan(p, svc, [pw]);
    check(probe === false, `${label}: a \`docker exec\` process in ${svc} does not hold the password`);
    const bad = rows.filter((x) => x.hit && x.urlUser !== 'crewflow_owner');
    check(bad.length === 0, `${label}: in ${svc} the password appears only inside the runtime's crewflow_owner URL (${rows.filter((x) => x.hit).length} process(es) with it; others: ${bad.map((x) => x.pid).join(',') || 'none'})`);
  }
  if (healthCheck) healthScan(p, check, n, `${label} (crewflow_owner password)`, [pw]);
  return pw;
}
/** The image never holds a password file or a password-file setting (inspect, history, filesystem). */
function checkImage(p, check, n, label) {
  const ref = imageRef(NEW);
  const base = path.posix.basename(L.OWNER_PASSWORD_FILE);
  const insp = L.run('docker', ['image', 'inspect', '-f', '{{json .Config.Env}}|{{json .Config.Volumes}}', ref], { timeout: 240_000 });
  check(insp.code === 0 && !/PASSWORD_FILE|owner-password/i.test(insp.stdout) && !insp.stdout.includes(base), `${label}: \`docker image inspect\`: no password-file setting in the image's Env or Volumes`);
  const hist = L.run('docker', ['history', '--no-trunc', '--format', '{{.CreatedBy}}', ref], { timeout: 240_000 });
  check(hist.code === 0 && !hist.stdout.includes(base), `${label}: \`docker history\`: no layer command names the password file`);
  const name = `${p.name}-imagecheck`;
  const fsr = L.run('docker', ['run', '--rm', '--name', name, '--network', 'none', '--entrypoint', 'sh', ref, '-c', `find / -xdev -name '${base}' 2>/dev/null; ls -A ${L.TARGET_DIR} 2>/dev/null; echo END`], { timeout: 180_000 });
  const found = fsr.stdout.split('\n').map((x) => x.trim()).filter((x) => x && x !== 'END');
  n(`image filesystem: ${found.length ? found.join(', ') : 'no password file, setup directory empty or absent'}`);
  check(fsr.code === 0 && /END/.test(fsr.stdout) && found.length === 0, `${label}: the image's filesystem holds no password file and an empty or absent ${L.TARGET_DIR}`);
}
/** The setup sessions' statements in the db log after `from` (log_statement=all; a non-superuser login cannot hide them). */
function setupStatements(p, from = 0) {
  const log = p.logs(L.DB_SERVICE).slice(from);
  const out = [];
  for (const line of log.split('\n')) {
    const m = line.match(/app=(crewflow-owner-bootstrap\S*) .*?(?:LOG|ERROR):\s+(?:statement|execute [^:]*):\s+(.*)$/);
    if (m) out.push(m[2].trim());
  }
  return out;
}
const READ_ONLY_STATEMENT = /^(SELECT|SET |SHOW|BEGIN|COMMIT|ROLLBACK|RESET|DISCARD)\b/i;

// ------------------------------------------------------------------------------------------------------------ block a
async function blockBundled() {
  const p = project('a');
  const s = L.secrets;
  const app1 = s.appSecret;
  const app2 = L.b64(48);
  s.appSecret2 = app2;
  L.writeSecrets(p.secretsDir, { caPath: null, appSecret: app1 });
  use(p, { databaseUrl: null });
  const state = { pws: [] };

  const ok1 = await step('S1', 'A6', 'bundled database, fresh, with only PG_DATABASE_PASSWORD + APP_SECRET: crewflow_owner created, migrations applied, API and Worker healthy; the password file random, 0400 1000:1000, read-only in the apps, in no env and not in the image', async (check, n) => {
    const envs = ['compose.env', 'database.env', 'runtime.env'].map((f) => fs.readFileSync(path.join(p.secretsDir, f), 'utf8'));
    check(!envs.some((e) => /^PG_DATABASE_URL=|^PG_SSL_CA_CERT_PATH=|^CREWFLOW_PG_CA_FILE=/m.test(e)), 'no PG_DATABASE_URL, PG_SSL_CA_CERT_PATH or CA file in any env file: the database settings are PG_DATABASE_PASSWORD (compose.env) and APP_SECRET (runtime.env) only');
    const d = deploy(p, 'S1-deploy');
    check(d.code === 0, `\`docker compose pull && docker compose up -d\` exit ${d.code} after ${Math.round(d.ms / 1000)} s`);
    const dbHealth = p.health(L.DB_SERVICE);
    check(dbHealth.startsWith('healthy|'), `db healthy (${dbHealth})`);
    if (!dbHealth.startsWith('healthy|')) throw new Error('the bundled db did not become healthy');
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
    check(setupExit(p) === 'exited|0' && MSG.readyCreated.test(sl), `db-setup ran once, created crewflow_owner and exited 0 (${setupExit(p)})`);
    check(!al.includes('[owner-bootstrap]'), 'rab-api ran no bootstrap child (it never receives PG_DATABASE_URL)');
    const tgt = L.run('docker', ['exec', p.container('rab-api'), 'cat', L.TARGET_FILE], { timeout: 180_000 }).stdout;
    check(/"v":\s*1/.test(tgt) && !tgt.includes('@') && !tgt.includes(s.dbPassword) && !tgt.includes(app1) && !/password/i.test(tgt), 'the target file holds no login, no password and no APP_SECRET (credential-free; value not printed)');
    const r = role(p);
    check(exactly01(r), `crewflow_owner has exactly the 01 attributes: ${roleShape(r)}`);
    const acl = dbAcl(p);
    check(/(^|[{,])crewflow_owner=C\*T\*c\*\/postgres([,}]|$)/.test(acl), `database grant CONNECT, CREATE, TEMPORARY WITH GRANT OPTION from the admin (${acl})`);
    const ledger = p.psql(`SELECT count(*) || '|' || count(DISTINCT name) FROM core.migrations`);
    const mr = migrateResults(al).pop() || {};
    const [lc, ld] = ledger.split('|').map(Number);
    check(lc > 200 && lc === ld && Array.isArray(mr.applied) && mr.applied.length === lc && mr.exitCode === 0, `migrations applied by the migrate child as crewflow_owner: ${lc} ledger rows, no duplicates`);
    const pw = checkPasswordFile(p, check, n, 'S1');
    state.pws.push(pw);
    state.pw = pw;
    check(pw && pw !== app1 && !pw.includes(app1.slice(0, 16)), 'the password is not APP_SECRET (APP_SECRET is never part of a database credential)');
    checkImage(p, check, n, 'S1');
    checkSessions(p, check, 'S1');
    const hz = p.healthz();
    check(hz.code === 0 && /"upgradeFailed":\s*false/.test(hz.body), `/healthz answers, upgradeFailed:false (${hz.body.slice(0, 120)})`);
    state.certs = certs(p);
    const hba = p.psql(`SELECT string_agg(type || ' ' || coalesce(address, '-') || ' ' || auth_method, '; ' ORDER BY line_number) FROM pg_hba_file_rules`);
    check(hba.length > 0 && !/\b(trust|peer)\b/.test(hba), 'the bundled db\'s pg_hba has no trust or peer line');
  }, p);
  if (!ok1 && !p.health('rab-api').startsWith('healthy|')) {
    note('S1 did not bring the stack up: the rest of block a is not run');
    for (const id of ['S6', 'S2', 'S5', 'X1', 'F3', 'F1', 'R1', 'C1', 'C2', 'S10A', 'S8']) results.push({ id, owner: '-', title: 'not run (S1 failed)', status: 'NOT RUN', checks: [], notes: [] });
    teardown(p);
    return;
  }

  await step('S6', 'A6', 'no admin credential in any rab-api / rab-worker process (PID 1 included), docker exec / health-check process or container definition (PG_DATABASE_URL present and empty there); every runtime session is crewflow_owner; no admin backend but db-setup\'s bootstrap child', async (check, n) => {
    checkEnviron(p, check, n, 'S6', [s.dbPassword]);
    healthScan(p, check, n, 'S6', [s.dbPassword, state.pw]);
    checkSessions(p, check, 'S6');
    const a = adminConnections(p, ['postgres']);
    n(`connections seen in the db log since init: ${a.all.map((x) => `${x.user}/${x.app || '-'} x${x.n}`).join(', ')}`);
    check(a.admin.some((x) => x.app === BOOTSTRAP_APP) && a.others.length === 0, `the only admin connections are the bootstrap child's, pg_isready and the test's own psql${a.others.length ? `; OTHERS: ${a.others.map((x) => `${x.app || '-'} x${x.n}`).join(', ')}` : ''}`);
  }, p);

  await step('S2', 'A6', 'restart: `docker compose restart`, then `down` + the documented command: the same password file, ZERO database changes (role, verifier, memberships, ACL, settings snapshots)', async (check, n) => {
    const before = dbSnapshot(p);
    const r1 = p.compose(['restart'], { timeout: 600_000 });
    keep(p, 'S2-restart', r1.out);
    check(r1.code === 0, `docker compose restart exit ${r1.code}`);
    await waitApp(p);
    const after1 = dbSnapshot(p);
    check(after1 === before, `after the restart the database snapshot is identical (changed: ${snapDiff(before, after1)})`);
    const f1 = p.readPasswordFile();
    check(f1 && sha(f1.password) === sha(state.pw) && f1.mode === '400 1000:1000', 'the same password file (sha256 compared, never printed), still 0400 1000:1000');
    check(MSG.readyUnchanged.test(lastReady(setupLog(p))) && setupExit(p) === 'exited|0', `db-setup ran again and changed nothing ("${lastReady(setupLog(p)).replace(/^.*?\[owner-bootstrap\]/, '[owner-bootstrap]')}")`);
    const down = p.compose(['down', '--timeout', '60'], { timeout: 300_000 });
    keep(p, 'S2-down', down.out);
    check(down.code === 0, '`docker compose down` (volumes kept) exit 0');
    const d = deploy(p, 'S2-redeploy');
    check(d.code === 0, `the documented command again: exit ${d.code}`);
    await waitApp(p);
    const after2 = dbSnapshot(p);
    check(after2 === before, `after down + up the database snapshot is identical (changed: ${snapDiff(before, after2)})`);
    const f2 = p.readPasswordFile();
    check(f2 && sha(f2.password) === sha(state.pw), 'after down + up: the same password file');
    check(MSG.readyUnchanged.test(lastReady(setupLog(p))) && !MSG.readyCreated.test(setupLog(p)), 'the new db-setup container: unchanged');
    check(certs(p) === state.certs, 'the db kept its CA and server certificate');
    const mr = migrateResults(p.logs('rab-api')).pop() || {};
    check(mr.state === 'CURRENT' && Array.isArray(mr.applied) && mr.applied.length === 0, 'the migrate child found the database CURRENT and applied nothing');
    checkSessions(p, check, 'S2');
  }, p);

  await step('S5', 'A6', 'APP_SECRET change: the apps are recreated and connect, the database and the password file are untouched, db-setup never receives APP_SECRET', async (check, n) => {
    const before = dbSnapshot(p);
    const ids = { api: p.inspect('rab-api', '{{.Id}}'), worker: p.inspect('rab-worker', '{{.Id}}') };
    L.writeSecrets(p.secretsDir, { caPath: null, appSecret: app2 });
    const d = deploy(p, 'S5-deploy');
    check(d.code === 0, `APP_SECRET changed in runtime.env, the documented command: exit ${d.code}`);
    await waitApp(p);
    check(p.inspect('rab-api', '{{.Id}}') !== ids.api && p.inspect('rab-worker', '{{.Id}}') !== ids.worker, 'rab-api and rab-worker were recreated with the new APP_SECRET');
    const after = dbSnapshot(p);
    check(after === before, `the database snapshot is identical (changed: ${snapDiff(before, after)})`);
    const f = p.readPasswordFile();
    check(f && sha(f.password) === sha(state.pw), 'the password file is unchanged');
    const sl = setupLog(p);
    evidence('S5-db-setup.log', sl);
    check(MSG.readyUnchanged.test(lastReady(sl)), 'db-setup: unchanged');
    const setupDef = L.run('docker', ['inspect', '-f', '{{range .Config.Env}}{{println .}}{{end}}', p.container('db-setup')], { timeout: 180_000 }).stdout;
    check(!/^APP_SECRET=/m.test(setupDef) && !setupDef.includes(app1) && !setupDef.includes(app2), 'db-setup\'s container definition holds no APP_SECRET (it is no database credential)');
    const ss = checkSessions(p, check, 'S5');
    check(ss.some((x) => /worker/i.test(x.app)), `the new Worker is connected as crewflow_owner (${ss.filter((x) => /worker/i.test(x.app)).map((x) => x.app).join(', ') || 'no worker session'})`);
    check(!/28P01|password authentication failed/i.test(p.logs('rab-worker')), 'the Worker log has no authentication failure');
  }, p);

  await step('X1', 'L5', 'red control: the old option-2 expectation (crewflow_owner password = hex(HKDF(APP_SECRET))) FAILS on this design, for both APP_SECRETs used', async (check, n) => {
    const crypto = require('node:crypto');
    const hkdf = (secret) => L.rememberSecret(Buffer.from(crypto.hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), 'crewflow-owner-db-password-v1', 32)).toString('hex'));
    const f = p.readPasswordFile();
    for (const [label, secret] of [['APP_SECRET 1', app1], ['APP_SECRET 2', app2]]) {
      const old = hkdf(secret);
      check(!p.ownerLoginWorks(old) && (!f || f.password !== old), `red control (${label}): the HKDF-derived password does NOT log in and is not the stored one, so an HKDF assertion here would fail`);
    }
  }, p);

  await step('F3', 'A6', 'an EMPTY password file: db-setup refuses (64) and changes nothing; the documented recovery (stop the apps, remove the file, `up -d`) resets and the apps start', async (check, n) => {
    const base = path.posix.basename(L.OWNER_PASSWORD_FILE);
    const mk = L.onSetupVolume(p, imageRef(NEW), ['sh', '-c', `rm -f /v/${base} && : > /v/${base} && chmod 400 /v/${base}`], 'empty-password-file');
    check(mk.code === 0, 'an empty password file made on the setup volume (uid 1000, 0400)');
    const before = dbSnapshot(p);
    const d = deploy(p, 'F3-empty-file');
    const sl = setupLog(p);
    evidence('F3-db-setup.log', sl);
    n(`bootstrap: ${bootstrapLines(sl).slice(-2).join(' / ')}`);
    check(d.code !== 0 && setupExit(p) === 'exited|64', `the documented command fails: db-setup exits 64 (${setupExit(p)})`);
    check(dbSnapshot(p) === before, `nothing changed in the database (changed: ${snapDiff(before, dbSnapshot(p))})`);
    check(p.setupPathExists(L.OWNER_PASSWORD_FILE) && !p.setupPathExists(`${L.OWNER_PASSWORD_FILE}.next`), 'the empty file was left as it was; no .next file');
    const stop = p.compose(['stop', 'rab-worker', 'rab-api'], { timeout: 300_000 });
    check(stop.code === 0, '$P stop rab-worker rab-api');
    deletePasswordFile(p, 'F3-rm');
    const up = p.compose(['up', '-d'], { timeout: 900_000 });
    keep(p, 'F3-up', up.out);
    await waitApp(p);
    check(up.code === 0 && MSG.readyReset.test(lastReady(setupLog(p))), `$P up -d: exit ${up.code}, the password reset, apps healthy`);
    const fresh = p.readPasswordFile();
    if (fresh) {
      state.pws.push(fresh.password);
      state.pw = fresh.password;
    }
    checkPasswordFile(p, check, n, 'F3');
    checkSessions(p, check, 'F3');
  }, p);

  await step('F1', 'A6', 'the password file present with a password that no longer logs in: refused 64 with the fix message, nothing changed; then the file deleted + the admin URL: reset (Crewflow addition), the apps recover', async (check, n) => {
    const other = L.hex(32);
    s['a:other'] = other;
    p.psql(`ALTER ROLE crewflow_owner PASSWORD '${other}'`);
    const before = dbSnapshot(p);
    const d = deploy(p, 'F1-wrong-password');
    const sl = setupLog(p);
    evidence('F1-db-setup-refused.log', sl);
    n(`bootstrap: ${bootstrapLines(sl).slice(-3).join(' / ')}`);
    check(d.code !== 0 && setupExit(p) === 'exited|64', `the documented command fails: db-setup exits 64 (${setupExit(p)}, deploy exit ${d.code})`);
    check(MSG.wrongPasswordFix.test(sl), 'the fix message names deleting the password file and starting again with the admin URL');
    check(dbSnapshot(p) === before, `nothing changed in the database (changed: ${snapDiff(before, dbSnapshot(p))})`);
    const f = p.readPasswordFile();
    check(f && sha(f.password) === sha(state.pw), 'the password file was left as it was');
    // the fix: delete the file, start again (the bundled admin URL)
    deletePasswordFile(p, 'F1-delete');
    check(p.readPasswordFile() === null, 'the password file is gone');
    const d2 = deploy(p, 'F1-reset');
    const sl2 = setupLog(p);
    evidence('F1-db-setup-reset.log', sl2);
    n(`bootstrap: ${bootstrapLines(sl2).slice(-3).join(' / ')}`);
    check(d2.code === 0 && setupExit(p) === 'exited|0' && MSG.readyReset.test(lastReady(sl2)), `with the file lost and the admin URL, db-setup resets the password (exit ${d2.code}; "${lastReady(sl2).replace(/^.*?\[owner-bootstrap\]/, '[owner-bootstrap]')}")`);
    const after = JSON.parse(dbSnapshot(p));
    const b = JSON.parse(before);
    check(after.role.oid === b.role.oid && exactly01(after.role) && after.role.verifierSha !== b.role.verifierSha && after.acl === b.acl && after.members === b.members, 'same role, attributes, memberships and ACL; only the verifier changed');
    const oldPw = state.pw;
    const f2 = p.readPasswordFile();
    if (f2) {
      state.pws.push(f2.password);
      state.pw = f2.password;
    }
    const pw2 = checkPasswordFile(p, check, n, 'F1 after the reset');
    check(pw2 && sha(pw2) !== sha(oldPw), 'a NEW random password');
    check(!p.ownerLoginWorks(oldPw) && !p.ownerLoginWorks(other), 'neither the old file password nor the hand-changed one logs in any more');
    const re = p.compose(['restart', 'rab-api', 'rab-worker'], { timeout: 600_000 });
    keep(p, 'F1-restart', re.out);
    await waitApp(p);
    check(re.code === 0, 'rab-api and rab-worker restarted on the new password file and are healthy');
    checkSessions(p, check, 'F1');
  }, p);

  await step('R1', 'A6', 'the documented "print the crewflow_owner URL" command on the bundled db: exit 0, exactly one line, a crewflow_owner URL for db:5432/crewflow whose password is the file\'s random one and logs in; nothing on stderr but the fixed status line, nothing in any container log', async (check, n) => {
    const r = L.printOwnerUrl(p, imageRef(NEW));
    n(`command (redacted): ${r.command}`);
    const q = r.parsed;
    check(r.code === 0 && r.lines === 1 && q, `exit ${r.code}, ${r.lines} stdout line(s), a URL (value not shown)`);
    check(q && /^postgres(ql)?:$/.test(q.protocol) && q.user === 'crewflow_owner' && q.host === 'db' && q.port === '5432' && q.db === 'crewflow', `crewflow_owner@${q ? `${q.host}:${q.port}/${q.db}` : '?'} (params ${q ? q.params.join(',') || '-' : '?'})`);
    const f = p.readPasswordFile();
    check(q && f && q.password === f.password && p.ownerLoginWorks(q.password), 'its password is the password file\'s (random) and logs in');
    check(q && !r.stderr.includes(q.password) && !/postgres(ql)?:\/\//.test(r.stderr), `stderr (dropped by the documented 2>/dev/null) holds no URL or password (${r.stderr.trim().split('\n').length} line(s): ${L.redact(r.stderr).trim().slice(0, 120)})`);
    check(L.run('docker', ['inspect', r.name], { timeout: 180_000 }).code !== 0, 'the container is gone (--rm); with --log-driver none nothing was kept in a container log');
    const texts = logTexts(p);
    check(q && Object.values(texts).every((v) => !v.includes(q.password)), 'no container log of the project holds the password');
  }, p);

  await step('C1', 'A6', 'changing the crewflow_owner password on purpose, exactly as documented (stop the apps, delete the password file with the one-off rm, `up -d`): a NEW password works, the old one fails, the apps start on it by themselves', async (check, n) => {
    const old = p.readPasswordFile().password;
    const t0 = Date.now();
    const stop = p.compose(['stop', 'rab-worker', 'rab-api'], { timeout: 300_000 });
    check(stop.code === 0, '`$P stop rab-worker rab-api`: exit 0');
    const rm = deletePasswordFile(p, 'C1-rm');
    check(rm.code === 0 && p.readPasswordFile() === null, `the documented env-free removal (${rm.command}): exit 0, the file is gone`);
    const t1 = Date.now();
    const up = p.compose(['up', '-d'], { timeout: 900_000 });
    keep(p, 'C1-up', up.out);
    check(up.code === 0, `\`$P up -d\`: exit ${up.code}`);
    await waitApp(p);
    const secs = Math.round((Date.now() - t1) / 1000);
    check(true, `rab-api and rab-worker healthy ${secs} s after \`up -d\` (whole procedure ${Math.round((Date.now() - t0) / 1000)} s), with no manual restart`);
    const sl = setupLog(p);
    check(MSG.readyReset.test(lastReady(sl)), `db-setup reset the password (A4, a Crewflow addition): "${lastReady(sl).replace(/^.*?\[owner-bootstrap\]/, '[owner-bootstrap]').slice(0, 140)}"`);
    const fc = p.readPasswordFile();
    if (fc) {
      state.pws.push(fc.password);
      state.pw = fc.password;
    }
    const now = checkPasswordFile(p, check, n, 'C1');
    check(now && now !== old && p.ownerLoginWorks(now) && !p.ownerLoginWorks(old), 'the NEW password logs in; the old one fails');
    checkSessions(p, check, 'C1');
    n(`commands: $P stop rab-worker rab-api; ${rm.command}; $P up -d  ($P = docker compose with this project's files and env file)`);
  }, p);

  await step('C2', 'A6', 'the same WITHOUT stopping the apps first: the running apps are not recreated, keep their old URL (new connections would fail), and recover only after `up -d --force-recreate rab-api rab-worker` (timed)', async (check, n) => {
    const old = p.readPasswordFile().password;
    const ids = { api: p.inspect('rab-api', '{{.Id}}'), worker: p.inspect('rab-worker', '{{.Id}}') };
    const rm = deletePasswordFile(p, 'C2-rm');
    check(rm.code === 0, 'the documented removal: exit 0 (apps still running)');
    const up = p.compose(['up', '-d'], { timeout: 900_000 });
    keep(p, 'C2-up', up.out);
    check(up.code === 0 && MSG.readyReset.test(lastReady(setupLog(p))), `\`up -d\`: exit ${up.code}, db-setup reset the password`);
    const now = p.readPasswordFile().password;
    state.pws.push(now);
    state.pw = now;
    check(now !== old && p.ownerLoginWorks(now) && !p.ownerLoginWorks(old), 'the new password works, the old one fails');
    await L.sleep(60_000);
    const same = p.inspect('rab-api', '{{.Id}}') === ids.api && p.inspect('rab-worker', '{{.Id}}') === ids.worker;
    const auth = ['rab-api', 'rab-worker'].map((sv) => (p.logs(sv).match(/28P01|password authentication failed/g) || []).length);
    n(`60 s after \`up -d\`: containers ${same ? 'NOT recreated (same ids)' : 'recreated'}; health api ${p.health('rab-api')}, worker ${p.health('rab-worker')}; 28P01 lines api ${auth[0]}, worker ${auth[1]}`);
    check(same, 'the running apps were NOT recreated by `up -d`: they still hold the OLD password in their runtime URL (documented: they do not recover on their own)');
    const t1 = Date.now();
    const fr = p.compose(['up', '-d', '--force-recreate', 'rab-api', 'rab-worker'], { timeout: 900_000 });
    keep(p, 'C2-force-recreate', fr.out);
    await waitApp(p);
    check(fr.code === 0, `\`$P up -d --force-recreate rab-api rab-worker\`: exit ${fr.code}; healthy again after ${Math.round((Date.now() - t1) / 1000)} s`);
    const ss = checkSessions(p, check, 'C2');
    check(ss.some((x) => /worker/i.test(x.app)), 'the recreated Worker is connected');
  }, p);

  await step('S10A', '10', 'the admin URL forced into a runtime process (`run -e PG_DATABASE_URL=<admin>`): the entrypoints and every runtime process refuse before connecting', async (check, n) => {
    const stop = p.compose(['stop', 'rab-worker', 'rab-api'], { timeout: 300_000 });
    check(stop.code === 0, 'rab-api and rab-worker stopped (cap: one one-off container at a time)');
    const before = adminConnections(p, ['postgres']);
    const ADMIN = { PG_DATABASE_URL: L.dbUrl('postgres', s.dbPassword) };
    for (const [svc, label] of [['rab-api', 'S10A-api-prestart'], ['rab-worker', 'S10A-worker-start']]) {
      const r = oneOff(p, svc, label, { env: ADMIN, timeout: 180_000 });
      check(r.code === 64 && MSG.entrypointRefusal.test(r.out), `${label.slice(5)} with an admin PG_DATABASE_URL: exit ${r.code}, refused`);
    }
    const cases = [
      ['rab-worker', 'S10A-worker-main', ['packages/rab-worker/dist/main.js']],
      ['rab-api', 'S10A-api-main', ['packages/rab-server/dist/main.js']],
      ['rab-api', 'S10A-migrate-child', ['packages/rab-server/dist/database/typeorm/scripts/migrate/twenty/twenty-migrate.js']], // gitleaks:allow (a case label and a file path, not a credential)
    ];
    for (const [svc, label, cmd] of cases) {
      const r = oneOff(p, svc, label, { entrypoint: '/sbin/tini', cmd: ['-s', '--', 'node', ...cmd], timeout: 180_000, env: ADMIN });
      const line = (r.out.match(/.*PG_DATABASE_URL does not log in as crewflow_owner.*/) || [''])[0];
      check(r.code !== 0 && line.includes(MSG.runtimeLoginTail), `${label.slice(5)} (\`node ${cmd[0].split('/').slice(-2).join('/')}\` with the admin URL): exit ${r.code}, "${line.trim().slice(0, 150)}"`);
    }
    const after = adminConnections(p, ['postgres']);
    const sum = (a) => a.others.reduce((t, x) => t + x.n, 0);
    check(sum(after) === sum(before), `none of the five opened an admin connection (${sum(before)} -> ${sum(after)})`);
  }, p);

  await step('S8', '8', 'logs never contain the admin URL, the admin password, an APP_SECRET, a crewflow_owner password or a verifier (db with log_statement=all)', async (check, n) => {
    const texts = logTexts(p);
    for (const [k, v] of Object.entries(texts)) evidence(`S8-${k.replace(/\W+/g, '-')}.txt`, v);
    check(/statement: /.test(texts['db log']) && /connection authorized/.test(texts['db log']), 'the db log is the worst case (statements and connections are logged)');
    const sentinels = { 'admin password (PG_DATABASE_PASSWORD)': s.dbPassword, 'APP_SECRET 1': app1, 'APP_SECRET 2': app2, 'the hand-changed password (F1)': s['a:other'] };
    state.pws.forEach((pw, i) => (sentinels[`crewflow_owner password ${i + 1}`] = pw));
    const found = scanSecrets(texts, sentinels);
    check(found.length === 0, `no secret in any log or compose output${found.length ? `: FOUND ${found.join('; ')}` : ''}`);
    const urls = Object.entries(texts).filter(([, v]) => /postgres(ql)?:\/\/[^\s'"]*@/.test(v)).map(([k]) => k);
    check(urls.length === 0, `no database URL with credentials in any log${urls.length ? `: FOUND in ${urls.join(', ')}` : ''}`);
    const ver = Object.entries(texts).map(([k, v]) => [k, (v.match(VERIFIER_RE) || []).length]).filter(([, c]) => c);
    check(ver.length === 0, `no SCRAM verifier in any log (a superuser admin turns statement logging off for its session)${ver.length ? `: FOUND ${ver.map(([k, c]) => `${c} in ${k}`).join(', ')}` : ''}`);
  }, p);
  teardown(p);
}

// ---------------------------------------------------------------------------------------------------------- block dep
async function blockDependsOnIgnored() {
  const p = project('dep', { logging: true });
  L.writeSecrets(p.secretsDir, { caPath: null });
  use(p, { databaseUrl: null });
  await step('S11', 'A6', '`depends_on` ignored: rab-api and rab-worker started BEFORE db-setup on a fresh database wait without connecting, then recover once db-setup has run', async (check, n) => {
    const pull = p.compose(['pull', '--quiet'], { timeout: 600_000 });
    check(pull.code === 0, 'images pulled');
    const up = p.compose(['up', '-d', '--wait', L.DB_SERVICE, 'rab-redis'], { timeout: 300_000 });
    keep(p, 'S11-infra-up', up.out);
    check(up.code === 0, `db and rab-redis up (exit ${up.code})`);
    // A platform that ignores depends_on: compose only CREATES the two containers (compose itself would enforce
    // depends_on even with --no-deps), and docker starts them directly; db-setup is never started here.
    const created = p.compose(['create', 'rab-api', 'rab-worker'], { timeout: 300_000 });
    keep(p, 'S11-create', created.out);
    const started = L.run('docker', ['start', p.container('rab-api'), p.container('rab-worker')], { timeout: 600_000 });
    keep(p, 'S11-start', started.out);
    check(created.code === 0 && started.code === 0 && p.neverStarted('db-setup'), `rab-api and rab-worker started directly (\`docker start\`), db-setup NOT run (create exit ${created.code}, start exit ${started.code})`);
    await L.sleep(25_000);
    const al = p.logs('rab-api');
    const wl = p.logs('rab-worker');
    evidence('S11-api-waiting.log', al);
    evidence('S11-worker-waiting.log', wl);
    n(`rab-api while waiting: ${al.trim().split('\n').slice(-2).join(' / ').slice(0, 300)}`);
    check(p.inspect('rab-api', '{{.State.Running}}') === 'true' && p.inspect('rab-worker', '{{.State.Running}}') === 'true', 'both are running (waiting), not crashed');
    check(!p.health('rab-api').startsWith('healthy|'), `rab-api is not healthy while there is no target / password file (${p.health('rab-api')})`);
    check(role(p) === null, 'no crewflow_owner exists yet');
    const conns = adminConnections(p, []).all.filter((x) => x.app !== L.TEST_APP_NAME && x.app !== 'pg_isready');
    check(conns.length === 0, `no database connection from the waiting apps (${conns.map((x) => `${x.user}/${x.app} x${x.n}`).join(', ') || 'none'})`);
    const setup = p.compose(['up', '-d', '--no-deps', 'db-setup'], { timeout: 300_000 });
    keep(p, 'S11-db-setup', setup.out);
    await L.waitFor('db-setup to exit', () => p.inspect('db-setup', '{{.State.Status}}') === 'exited', 300_000, 2000);
    check(setupExit(p) === 'exited|0', `db-setup ran afterwards and exited 0 (${setupExit(p)})`);
    await waitApp(p);
    check(true, 'rab-api and rab-worker became healthy without being restarted by the test');
    n(`restart counts: rab-api ${p.inspect('rab-api', '{{.RestartCount}}')}, rab-worker ${p.inspect('rab-worker', '{{.RestartCount}}')} (0 = recovered inside the bounded wait)`);
    checkSessions(p, check, 'S11');
  }, p);
  teardown(p);
}

// ---------------------------------------------------------------------------------------------------------- block ext
async function blockExternal() {
  const p = project('ext');
  const s = L.secrets;
  const pw = { owner4: L.hex(32), norole: L.hex(32), nogrant: L.hex(32), admin: L.hex(32), admin2: L.hex(32) };
  for (const [k, v] of Object.entries(pw)) s[`ext:${k}`] = v;
  const app2 = L.b64(48);
  s['ext:app2'] = app2;
  L.writeSecrets(p.secretsDir, { caPath: null });
  use(p, { databaseUrl: null });
  const url = (user, password, db) => L.dbUrl(user, password, db);
  const noCore = () => p.psql(`SELECT count(*) FROM pg_namespace WHERE nspname = 'core'`) === '0';
  const start = (label) => {
    const r = oneOff(p, 'db-setup', label, { timeout: 300_000 });
    return { code: r.code, out: r.out, boot: bootstrapLines(r.out) };
  };
  const filePws = [];

  await step('S4', '4', 'an existing crewflow_owner with SUPERUSER, then with BYPASSRLS (admin path): refused, the role left untouched', async (check, n) => {
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
      check(r.code === 64, `${label}: db-setup exits 64 (exit ${r.code})`);
      check(r.out.includes(MSG.privileged(attr)), `${label}: the fixed message "${MSG.privileged(attr).slice(0, 90)}…"`);
      check(JSON.stringify(role(p)) === JSON.stringify(before), `${label}: the role is untouched (${roleShape(role(p))})`);
      check(noCore(), `${label}: nothing created`);
      check(!/\n\s+at .*\(.*\.js:\d+:\d+\)/.test(r.out), `${label}: no stack trace`);
      const f = p.readPasswordFile();
      n(`${label}: password file after the refusal: ${f ? `present (${f.mode}); its password ${p.ownerLoginWorks(f.password) ? 'LOGS IN' : 'does not log in'}` : 'absent'}`);
    }
    p.psql('DROP OWNED BY crewflow_owner; DROP ROLE crewflow_owner;');
  }, p);

  const ok3 = await step('S3', '3', 'an EXTERNAL admin URL (non-superuser): no CREATEROLE / cannot grant -> refused; CREATEROLE + owns the database -> created, restart and APP_SECRET change unchanged, lost file -> reset; a second admin without ADMIN OPTION + lost file -> refused; the admin URL in no app process, docker exec or definition', async (check, n) => {
    deletePasswordFile(p, 'S3-clean-file');
    p.psql(`CREATE ROLE ext_norole LOGIN NOCREATEROLE PASSWORD '${pw.norole}'; ALTER DATABASE crewflow OWNER TO ext_norole;`);
    use(p, { databaseUrl: url('ext_norole', pw.norole) });
    let r = start('S3-no-createrole');
    check(r.code === 64 && r.out.includes(MSG.cannotCreateRoles), `admin without CREATEROLE: exit ${r.code}, "${MSG.cannotCreateRoles}"`);
    check(role(p) === null && noCore(), 'no crewflow_owner, nothing created');
    p.psql(`CREATE ROLE ext_nogrant LOGIN CREATEROLE NOSUPERUSER PASSWORD '${pw.nogrant}'; ALTER DATABASE crewflow OWNER TO postgres;`);
    use(p, { databaseUrl: url('ext_nogrant', pw.nogrant) });
    r = start('S3-no-grant');
    check(r.code === 64 && r.out.includes(MSG.cannotGrantDb), `admin with CREATEROLE that cannot grant on the database: exit ${r.code}`);
    check(role(p) === null && noCore(), 'no crewflow_owner, nothing created');
    deletePasswordFile(p, 'S3-clean-file-2');
    p.psql(`CREATE ROLE ext_admin LOGIN CREATEROLE NOSUPERUSER NOBYPASSRLS PASSWORD '${pw.admin}'; ALTER DATABASE crewflow OWNER TO ext_admin; ALTER SCHEMA public OWNER TO ext_admin;`);
    use(p, { databaseUrl: url('ext_admin', pw.admin) });
    const d = deploy(p, 'S3-deploy');
    check(d.code === 0, `external admin (NOSUPERUSER CREATEROLE, owns the database) in PG_DATABASE_URL, the documented command: exit ${d.code}`);
    if (d.code !== 0) throw new Error('the external-admin deploy failed');
    await waitApp(p);
    const sl = setupLog(p);
    evidence('S3-db-setup.log', sl);
    check(MSG.readyCreated.test(sl), 'crewflow_owner created by the non-superuser admin');
    const ro = role(p);
    check(exactly01(ro), `exactly the 01 attributes (${roleShape(ro)})`);
    check(/(^|[{,])crewflow_owner=C\*T\*c\*\/ext_admin([,}]|$)/.test(dbAcl(p)), `the grant comes from the external admin (${dbAcl(p)})`);
    const fpw = checkPasswordFile(p, check, n, 'S3');
    filePws.push(fpw);
    checkSessions(p, check, 'S3');
    const a = adminConnections(p, ['ext_admin']);
    check(a.admin.some((x) => x.app === BOOTSTRAP_APP) && a.others.length === 0, `the only ext_admin connections are the bootstrap child's${a.others.length ? `; OTHERS: ${a.others.map((x) => `${x.app} x${x.n}`).join(', ')}` : ''}`);
    checkEnviron(p, check, n, 'S3', [pw.admin, s.dbPassword]);
    // restart, then an APP_SECRET change: nothing changes
    const snap = dbSnapshot(p);
    const r1 = p.compose(['restart'], { timeout: 600_000 });
    keep(p, 'S3-restart', r1.out);
    await waitApp(p);
    check(dbSnapshot(p) === snap && MSG.readyUnchanged.test(lastReady(setupLog(p))), `restart: unchanged (changed: ${snapDiff(snap, dbSnapshot(p))})`);
    L.writeSecrets(p.secretsDir, { caPath: null, appSecret: app2 });
    const d2 = deploy(p, 'S3-app-secret');
    await waitApp(p);
    check(d2.code === 0 && dbSnapshot(p) === snap && sha(p.readPasswordFile().password) === sha(fpw), `APP_SECRET change: the apps restart, the database and the file are unchanged (changed: ${snapDiff(snap, dbSnapshot(p))})`);
    // lost file with this admin (it created crewflow_owner, so it has ADMIN OPTION): reset
    deletePasswordFile(p, 'S3-lost-file');
    const d3 = deploy(p, 'S3-reset');
    const sl3 = setupLog(p);
    evidence('S3-db-setup-reset.log', sl3);
    check(d3.code === 0 && MSG.readyReset.test(lastReady(sl3)), `lost file + the external admin URL: the password is reset (exit ${d3.code})`);
    const fpw2 = p.readPasswordFile();
    check(fpw2 && sha(fpw2.password) !== sha(fpw) && p.ownerLoginWorks(fpw2.password) && !p.ownerLoginWorks(fpw), 'a new random password logs in, the old one does not');
    filePws.push(fpw2 && fpw2.password);
    const rr = p.compose(['restart', 'rab-api', 'rab-worker'], { timeout: 600_000 });
    keep(p, 'S3-restart-after-reset', rr.out);
    await waitApp(p);
    checkSessions(p, check, 'S3 after the reset');
    // a second admin without ADMIN OPTION on crewflow_owner, and the file lost again
    const stop = p.compose(['stop', 'rab-worker', 'rab-api'], { timeout: 300_000 });
    check(stop.code === 0, 'rab-api and rab-worker stopped');
    p.psql(`CREATE ROLE ext_admin2 LOGIN CREATEROLE NOSUPERUSER PASSWORD '${pw.admin2}'; GRANT CONNECT, CREATE, TEMPORARY ON DATABASE crewflow TO ext_admin2 WITH GRANT OPTION;`);
    use(p, { databaseUrl: url('ext_admin2', pw.admin2) });
    deletePasswordFile(p, 'S3-lost-file-2');
    const before2 = role(p);
    r = start('S3-no-admin-option');
    n(`no ADMIN OPTION: ${r.boot.join(' / ')}`);
    check(r.code === 64 && MSG.noAdminOption.test(r.out), `a second CREATEROLE admin without ADMIN OPTION, the file lost: exit ${r.code}, the no-ADMIN-OPTION refusal`);
    check(JSON.stringify(role(p)) === JSON.stringify(before2), 'the role is untouched');
    const left = p.readPasswordFile();
    n(`password file after that refusal: ${left ? `present; its password ${p.ownerLoginWorks(left.password) ? 'LOGS IN' : 'does NOT log in'}` : 'absent'}`);
    if (left) filePws.push(left.password);
  }, p);

  await step('M1', 'A6', 'an admin URL naming a database that does not exist: refused, nothing created (Crewflow never creates the database; the postgres image or the provider does)', async (check, n) => {
    use(p, { databaseUrl: url('postgres', s.dbPassword, 'crewflow_missing') });
    const before = p.psql(`SELECT count(*) FROM pg_database`);
    const r = start('M1-missing-database');
    n(`bootstrap: ${r.boot.join(' / ')}`);
    check(r.code === 64 && MSG.missingDb.test(r.out), `db-setup exits 64 with a clear message (exit ${r.code})`);
    check(p.psql(`SELECT count(*) FROM pg_database WHERE datname = 'crewflow_missing'`) === '0' && p.psql(`SELECT count(*) FROM pg_database`) === before, 'no database was created');
    use(p, { databaseUrl: null });
  }, p);

  await step('S8X', '8', 'external non-superuser admin: logs never contain an admin password, a crewflow_owner password or an APP_SECRET; a verifier only as the documented residual', async (check, n) => {
    if (!ok3) n('S3 did not pass: scanning what it left');
    const texts = logTexts(p);
    for (const [k, v] of Object.entries(texts)) evidence(`S8X-${k.replace(/\W+/g, '-')}.txt`, v);
    const sentinels = { 'bundled admin password': s.dbPassword, 'ext_admin password': pw.admin, 'ext_admin2 password': pw.admin2, 'ext_norole password': pw.norole, 'ext_nogrant password': pw.nogrant, 'hand-made crewflow_owner password (S4)': pw.owner4, 'APP_SECRET 1': s.appSecret, 'APP_SECRET 2': app2 };
    filePws.filter(Boolean).forEach((x, i) => (sentinels[`crewflow_owner file password ${i + 1}`] = x));
    const found = scanSecrets(texts, sentinels);
    check(found.length === 0, `no secret in any log or compose output${found.length ? `: FOUND ${found.join('; ')}` : ''}`);
    const urls = Object.entries(texts).filter(([, v]) => /postgres(ql)?:\/\/[^\s'"]*@/.test(v)).map(([k]) => k);
    check(urls.length === 0, `no database URL with credentials in any log${urls.length ? `: FOUND in ${urls.join(', ')}` : ''}`);
    const appVer = Object.entries(texts).filter(([k]) => k !== 'db log').reduce((a, [, v]) => a + (v.match(VERIFIER_RE) || []).length, 0);
    check(appVer === 0, 'no verifier in an application log or compose output');
    n(`RESIDUAL: the db log (log_statement=all, a non-superuser admin cannot turn it off) holds ${(texts['db log'].match(VERIFIER_RE) || []).length} SCRAM verifier occurrence(s), never a password`);
  }, p);
  teardown(p);
}

// ---------------------------------------------------------------------------------------------------------- block ref
async function blockRefusals() {
  const p = project('ref');
  const s = L.secrets;
  const pwH = L.hex(32);
  s['ref:owner'] = pwH;
  L.writeSecrets(p.secretsDir, { caPath: null });
  use(p, { databaseUrl: null });
  /** Each refusal case starts WITHOUT a password file, so a stale file can never be the reason for the refusal. */
  const start = (label, { keepFile = false } = {}) => {
    if (!keepFile) deletePasswordFile(p, `${label}-no-file`);
    const r = oneOff(p, 'db-setup', label, { timeout: 300_000 });
    return { code: r.code, out: r.out, boot: bootstrapLines(r.out) };
  };
  const makeOwner = () => p.psql(`CREATE ROLE crewflow_owner LOGIN NOSUPERUSER NOBYPASSRLS NOREPLICATION NOCREATEDB CREATEROLE INHERIT PASSWORD '${pwH}'; GRANT CONNECT, CREATE, TEMPORARY ON DATABASE crewflow TO crewflow_owner WITH GRANT OPTION;`);
  /** The H1 plant, made AS crewflow_owner (never as the superuser): a `name = name` operator that records current_user. */
  const plant = () =>
    p.psqlOwner(
      [
        'CREATE SCHEMA h1x;',
        'CREATE TABLE h1x.calls (who text NOT NULL, at timestamptz NOT NULL DEFAULT pg_catalog.now());',
        'GRANT USAGE ON SCHEMA h1x TO PUBLIC;',
        'GRANT INSERT ON h1x.calls TO PUBLIC;',
        "CREATE FUNCTION h1x.spy_eq(a name, b name) RETURNS boolean LANGUAGE plpgsql AS $f$ BEGIN INSERT INTO h1x.calls(who) VALUES (current_user::text); RETURN a::text OPERATOR(pg_catalog.=) b::text; END $f$;",
        'GRANT EXECUTE ON FUNCTION h1x.spy_eq(name, name) TO PUBLIC;',
        'CREATE OPERATOR h1x.= (LEFTARG = name, RIGHTARG = name, FUNCTION = h1x.spy_eq);',
        'ALTER DATABASE crewflow SET search_path = h1x, pg_catalog;',
      ].join('\n'),
      pwH,
    );
  const calls = () => Number(p.psql('SELECT pg_catalog.count(*) FROM h1x.calls'));
  const unplant = () => p.psql('ALTER DATABASE crewflow RESET search_path; ALTER DATABASE crewflow OWNER TO postgres; DROP SCHEMA IF EXISTS h1x CASCADE;');
  const up = p.compose(['up', '-d', '--wait', L.DB_SERVICE], { timeout: 300_000 });
  keep(p, 'ref-db-up', up.out);
  if (up.code !== 0) throw new Error(`block ref: db did not come up (exit ${up.code})`);

  await step('SP', 'A5', 'a database-wide search_path default: db-setup refuses (64) before creating anything', async (check, n) => {
    p.psql('ALTER DATABASE crewflow SET search_path = public, pg_catalog');
    const r = start('SP-default');
    n(`bootstrap: ${r.boot.join(' / ')}`);
    check(r.code === 64 && MSG.searchPathDefault.test(r.out), `exit ${r.code}, the search_path message`);
    check(role(p) === null, 'crewflow_owner was not created');
    p.psql('ALTER DATABASE crewflow RESET search_path');
  }, p);

  for (const [id, variant] of [['H1a', 'db-owner'], ['H1b', 'inherited-owner']]) {
    await step(id, 'A5', `H1: crewflow_owner ${variant === 'db-owner' ? 'OWNS the database' : 'INHERITs the role that owns the database'} and plants an operator + a database search_path: the admin URL is refused (64), ZERO planted calls ran during the setup`, async (check, n) => {
      makeOwner();
      if (variant === 'db-owner') p.psql('ALTER DATABASE crewflow OWNER TO crewflow_owner');
      else p.psql('CREATE ROLE cf_dbo NOLOGIN NOSUPERUSER NOBYPASSRLS; GRANT cf_dbo TO crewflow_owner; ALTER DATABASE crewflow OWNER TO cf_dbo;');
      plant();
      // The test's own superuser queries (the snapshots) run UNPINNED in this database and do call the plant, so only the
      // calls made while db-setup runs count: c0 just before it, c1 just after it, nothing else in between.
      const before = dbSnapshot(p);
      deletePasswordFile(p, `${id}-no-file`);
      const c0 = calls();
      const r = start(`${id}-admin`, { keepFile: true });
      const c1 = calls();
      n(`bootstrap: ${r.boot.join(' / ')}`);
      check(r.code === 64 && MSG.ownerOwnsDatabase.test(r.out), `exit ${r.code}, the "crewflow_owner owns this database" refusal`);
      check(c1 === c0, `the planted operator never ran during the setup (${c1 - c0} call(s) while db-setup ran; ${c0} before it, all from the test's own unpinned superuser snapshot)`);
      check(dbSnapshot(p) === before, `crewflow_owner and the database unchanged (changed: ${snapDiff(before, dbSnapshot(p))})`);
      // sanity: an UNPINNED superuser session runs the plant, so the zero above means something
      const c2 = calls();
      p.psql(`SELECT 'a'::name = 'a'::name`);
      const live = calls() - c2;
      check(live >= 1, `sanity: an unpinned superuser session does reach the planted operator (+${live} call(s)), so "zero" proves the pinning`);
      unplant();
      p.psql(`DROP OWNED BY crewflow_owner; DROP ROLE crewflow_owner;${variant === 'db-owner' ? '' : ' DROP ROLE cf_dbo;'}`);
    }, p);
  }

  await step('N2', 'A5', 'N2: crewflow_owner a member of the owning role WITH INHERIT FALSE, SET TRUE: the admin URL is refused (64), nothing written', async (check, n) => {
    makeOwner();
    p.psql('CREATE ROLE cf_dbo2 NOLOGIN NOSUPERUSER NOBYPASSRLS; GRANT cf_dbo2 TO crewflow_owner WITH INHERIT FALSE, SET TRUE; ALTER DATABASE crewflow OWNER TO cf_dbo2;');
    const before = dbSnapshot(p);
    const r = start('N2-admin');
    n(`bootstrap: ${r.boot.join(' / ')}`);
    check(r.code === 64 && MSG.ownerOwnsDatabase.test(r.out), `exit ${r.code}, the owner refusal`);
    check(dbSnapshot(p) === before, `nothing changed (changed: ${snapDiff(before, dbSnapshot(p))})`);
    p.psql('ALTER DATABASE crewflow OWNER TO postgres; DROP OWNED BY crewflow_owner; DROP ROLE crewflow_owner; DROP ROLE cf_dbo2;');
  }, p);

  await step('N1', 'A5', 'N1: a transition-shaped database (owned by a role a NOCREATEROLE crewflow_owner INHERITs): the admin URL -> 64; the crewflow_owner URL -> works, nothing written (runbook §5.4)', async (check, n) => {
    p.psql(`CREATE ROLE cf_rab_owner NOLOGIN NOSUPERUSER NOBYPASSRLS; ALTER DATABASE crewflow OWNER TO cf_rab_owner; CREATE ROLE crewflow_owner LOGIN NOSUPERUSER NOBYPASSRLS NOREPLICATION NOCREATEDB NOCREATEROLE INHERIT PASSWORD '${pwH}'; GRANT cf_rab_owner TO crewflow_owner WITH INHERIT TRUE, SET TRUE; GRANT CONNECT, CREATE, TEMPORARY ON DATABASE crewflow TO crewflow_owner WITH GRANT OPTION;`);
    const before = dbSnapshot(p);
    const r = start('N1-admin');
    n(`admin URL: ${r.boot.join(' / ')}`);
    check(r.code === 64 && MSG.ownerOwnsDatabase.test(r.out), `the admin URL: exit ${r.code}, the owner refusal`);
    check(dbSnapshot(p) === before, 'nothing changed');
    use(p, { databaseUrl: L.ownerUrl(pwH) });
    const r2 = start('N1-owner-url');
    n(`crewflow_owner URL: ${r2.boot.join(' / ')}`);
    check(r2.code === 0, `the crewflow_owner URL: db-setup exits 0 (${r2.code})`);
    check(dbSnapshot(p) === before, `the crewflow_owner URL wrote nothing (changed: ${snapDiff(before, dbSnapshot(p))})`);
    const f = p.readPasswordFile();
    check(f && f.password === pwH && f.mode === '400 1000:1000' && p.ownerLoginWorks(pwH), 'the file holds the URL\'s own password (0400 1000:1000), which still logs in');
    use(p, { databaseUrl: null });
  }, p);
  teardown(p);
}

// ---------------------------------------------------------------------------------------------------- blocks pt / ptx
/** Client connections in the db log other than the test's own psql and the db's pg_isready (log_connections=on). */
function appConnections(p) {
  return adminConnections(p, []).all.filter((x) => x.app !== L.TEST_APP_NAME && x.app !== 'pg_isready').reduce((t, x) => t + x.n, 0);
}
function extensions(p) {
  return p.psql(`SELECT coalesce(string_agg(extname || ' ' || extowner::regrole::text, ', ' ORDER BY extname), '') FROM pg_extension`);
}
function ownedByOwner(p) {
  return p.psql(`SELECT coalesce(string_agg(pg_describe_object(classid, objid, objsubid), ', ' ORDER BY 1), '') FROM pg_shdepend WHERE deptype = 'o' AND refobjid = (SELECT oid FROM pg_roles WHERE rolname = 'crewflow_owner') AND dbid = (SELECT oid FROM pg_database WHERE datname = current_database())`);
}
const coreCount = (p) => p.psql(`SELECT count(*) FROM pg_namespace WHERE nspname = 'core'`);

async function blockPassThrough() {
  const p = project('pt', { ownerInit: true });
  const s = L.secrets;
  L.writeSecrets(p.secretsDir, { caPath: null });
  use(p, { databaseUrl: L.ownerUrl(s.owner) });

  const ok1 = await step('P1', 'A6', 'an existing crewflow_owner URL: used unchanged (zero writes), the OLD password still logs in, the file holds it, API and Worker start; the same on the next start', async (check, n) => {
    const up = p.compose(['up', '-d', '--wait', L.DB_SERVICE], { timeout: 300_000 });
    keep(p, 'P1-db-up', up.out);
    check(up.code === 0, 'db up with the hand-made crewflow_owner of 01-crewflow-owner.sql');
    const before = dbSnapshot(p);
    const from = p.logs(L.DB_SERVICE).length;
    // db-setup ALONE first, so its zero writes are measured without the migrations a full start then applies.
    const pull = p.compose(['pull', '--quiet'], { timeout: 600_000 });
    const solo = p.compose(['up', '-d', 'db-setup'], { timeout: 300_000 });
    keep(p, 'P1-db-setup-alone', solo.out);
    await L.waitFor('db-setup to exit', () => p.inspect('db-setup', '{{.State.Status}}') === 'exited', 300_000, 2000);
    const afterSetup = dbSnapshot(p);
    check(pull.code === 0 && setupExit(p) === 'exited|0' && afterSetup === before, `db-setup alone (\`up -d db-setup\`): exit 0, the database snapshot is identical (changed: ${snapDiff(before, afterSetup)})`);
    const d = deploy(p, 'P1-deploy');
    check(d.code === 0, `compose.env PG_DATABASE_URL = the hand-made crewflow_owner URL, the documented command: exit ${d.code}`);
    await waitApp(p);
    const sl = setupLog(p);
    evidence('P1-db-setup.log', sl);
    n(`bootstrap (db-setup): ${bootstrapLines(sl).join(' / ')}`);
    check(setupExit(p) === 'exited|0' && MSG.readyUnchanged.test(lastReady(sl)), `db-setup exited 0, crewflow_owner unchanged (${setupExit(p)})`);
    const stmts = setupStatements(p, from);
    const writes = stmts.filter((x) => !READ_ONLY_STATEMENT.test(x));
    evidence('P1-setup-statements.txt', stmts.join('\n'));
    check(stmts.length > 0 && writes.length === 0, `every statement of the setup sessions is read-only (${stmts.length} logged; writes: ${writes.map((x) => x.slice(0, 40)).join(' | ') || 'none'})`);
    const migrated = JSON.parse(dbSnapshot(p));
    const b = JSON.parse(before);
    n(`after the full start (the migrations ran as crewflow_owner) the snapshot differs in: ${snapDiff(before, JSON.stringify(migrated))}`);
    check(migrated.role && b.role && migrated.role.oid === b.role.oid && migrated.role.verifierSha === b.role.verifierSha && exactly01(migrated.role) && migrated.owner === b.owner, 'crewflow_owner keeps its oid, its VERIFIER (password never changed) and the 01 attributes; the database owner is unchanged');
    check(p.ownerLoginWorks(s.owner), 'the OLD (hand-made) password still logs in');
    const pw = checkPasswordFile(p, check, n, 'P1', { random: false, urlSupplied: true });
    check(pw === s.owner, 'the password file holds the URL\'s own password (compared in memory)');
    checkSessions(p, check, 'P1');
    checkEnviron(p, check, n, 'P1', [s.dbPassword]);
    const snap = dbSnapshot(p);
    const from2 = p.logs(L.DB_SERVICE).length;
    const d2 = deploy(p, 'P1-redeploy');
    check(d2.code === 0, `the documented command again: exit ${d2.code}`);
    await waitApp(p);
    const w2 = setupStatements(p, from2).filter((x) => !READ_ONLY_STATEMENT.test(x));
    check(dbSnapshot(p) === snap && w2.length === 0 && MSG.readyUnchanged.test(lastReady(setupLog(p))), `the next start: unchanged, no write (changed: ${snapDiff(snap, dbSnapshot(p))})`);
    const texts = logTexts(p);
    const found = scanSecrets(texts, { 'admin password': s.dbPassword, 'crewflow_owner password': s.owner, APP_SECRET: s.appSecret });
    check(found.length === 0, `no secret in any log${found.length ? `: FOUND ${found.join('; ')}` : ''}`);
    check(Object.values(texts).every((v) => !VERIFIER_RE.test(v)), 'no SCRAM verifier in any log (nothing is ever set on this path)');
  }, p);

  await step('P5', 'A6', 'a non-empty PG_DATABASE_URL forced into rab-api / rab-worker (the WORKING crewflow_owner URL, the admin URL, a non-URL value): the entrypoints exit 64 before any database connection', async (check, n) => {
    if (!ok1) n('P1 did not pass: running anyway on what it left');
    const stop = p.compose(['stop', 'rab-worker', 'rab-api'], { timeout: 300_000 });
    check(stop.code === 0, 'rab-api and rab-worker stopped');
    const before = appConnections(p);
    const values = [['owner', L.ownerUrl(s.owner)], ['admin', L.dbUrl('postgres', s.dbPassword)], ['junk', 'x']];
    for (const [svc, short] of [['rab-api', 'api'], ['rab-worker', 'worker']]) {
      for (const [kind, value] of values) {
        const r = oneOff(p, svc, `P5-${short}-${kind}`, { env: { PG_DATABASE_URL: value }, timeout: 180_000 });
        check(r.code === 64 && MSG.entrypointRefusal.test(r.out), `${svc} with a forced ${kind} PG_DATABASE_URL: exit ${r.code}`);
      }
    }
    check(appConnections(p) === before, `no database connection by any of the six refused starts (${before} -> ${appConnections(p)})`);
    const up = p.compose(['up', '-d'], { timeout: 600_000 });
    keep(p, 'P5-up', up.out);
    await waitApp(p);
    check(up.code === 0, 'the stack comes back');
  }, p);

  await step('S10B', '10', 'a crewflow_owner made privileged AFTER db-setup (BYPASSRLS, then SUPERUSER): the runtime guards refuse it', async (check, n) => {
    const stop = p.compose(['stop', 'rab-worker', 'rab-api'], { timeout: 300_000 });
    check(stop.code === 0, 'rab-api and rab-worker stopped');
    for (const [label, alter, re] of [
      ['BYPASSRLS', 'ALTER ROLE crewflow_owner BYPASSRLS', /bypassrls|BYPASSRLS|bypass/],
      ['SUPERUSER', 'ALTER ROLE crewflow_owner NOBYPASSRLS SUPERUSER', /superuser|SUPERUSER/],
    ]) {
      p.psql(alter);
      const r = oneOff(p, 'rab-api', `S10B-${label}`, { timeout: 300_000 });
      const refusal = r.out.split('\n').filter((l) => re.test(l)).map((l) => l.trim()).slice(0, 2);
      n(`${label}: API exit ${r.code}; refusal: ${refusal.join(' | ').slice(0, 300)}`);
      check(r.code !== 0 && refusal.length > 0, `${label}: refused by the runtime guard (exit ${r.code})`);
    }
    p.psql('ALTER ROLE crewflow_owner NOSUPERUSER NOBYPASSRLS');
    check(exactly01(role(p)), 'crewflow_owner restored to the 01 attributes');
  }, p);

  await step('F2', 'A6', 'the password file lost with no admin URL: a valid crewflow_owner URL rewrites it (no write); a crewflow_owner URL whose password no longer logs in -> refused 64, no file, an app start waits and gives up without connecting', async (check, n) => {
    deletePasswordFile(p, 'F2-lost');
    const snap = dbSnapshot(p);
    const r = oneOff(p, 'db-setup', 'F2-valid-url', { timeout: 300_000 });
    const f = p.readPasswordFile();
    check(r.code === 0 && f && f.password === s.owner && f.mode === '400 1000:1000', `a valid crewflow_owner URL: db-setup exit ${r.code}, the file rewritten with that URL's password`);
    check(dbSnapshot(p) === snap, 'nothing written to the database');
    // the URL's password no longer logs in (changed by someone in the database) and the file is lost
    const changed = L.hex(32);
    s['pt:changed'] = changed;
    p.psql(`ALTER ROLE crewflow_owner PASSWORD '${changed}'`);
    deletePasswordFile(p, 'F2-lost-2');
    const snap2 = dbSnapshot(p);
    const r2 = oneOff(p, 'db-setup', 'F2-stale-url', { timeout: 300_000 });
    n(`stale URL: ${bootstrapLines(r2.out).join(' / ')}`);
    check(r2.code === 64, `the crewflow_owner URL whose password no longer logs in: refused 64 (exit ${r2.code})`);
    check(p.readPasswordFile() === null && dbSnapshot(p) === snap2, 'no password file written, nothing changed in the database');
    const before = appConnections(p);
    const a = oneOff(p, 'rab-api', 'F2-api-without-file', { timeout: 300_000 });
    n(`rab-api without a password file: exit ${a.code} after ${Math.round(a.ms / 1000)} s; ${a.out.trim().split('\n').slice(-1)[0].slice(0, 200)}`);
    check(a.code === 75, `an app start without a password file waits (bounded) and gives up with exit 75 (exit ${a.code})`);
    check(appConnections(p) === before, 'it opened no database connection');
  }, p);
  teardown(p);
}

async function blockPassThroughRefusals() {
  const p = project('ptx', { ownerInit: true });
  const s = L.secrets;
  L.writeSecrets(p.secretsDir, { caPath: null });
  use(p, { databaseUrl: L.ownerUrl(s.owner) });
  const up = p.compose(['up', '-d', '--wait', L.DB_SERVICE], { timeout: 300_000 });
  keep(p, 'ptx-db-up', up.out);
  if (up.code !== 0) throw new Error(`block ptx: db did not come up (exit ${up.code})`);

  await step('P3', 'A6', 'the crewflow_owner URL of a SUPERUSER, then a BYPASSRLS crewflow_owner: db-setup exits 64, no role change, no extension or object created, the apps never start', async (check, n) => {
    const ext0 = extensions(p);
    const own0 = ownedByOwner(p);
    for (const [label, alter, attr] of [
      ['SUPERUSER', 'ALTER ROLE crewflow_owner SUPERUSER', 'SUPERUSER'],
      ['BYPASSRLS', 'ALTER ROLE crewflow_owner NOSUPERUSER BYPASSRLS', 'BYPASSRLS'],
    ]) {
      p.psql(alter);
      const before = role(p);
      const d = deploy(p, `P3-${label}`);
      const sl = setupLog(p);
      evidence(`P3-${label}-db-setup.log`, sl);
      n(`${label}: ${bootstrapLines(sl).slice(-3).join(' / ')}`);
      check(d.code !== 0 && setupExit(p) === 'exited|64', `${label}: the documented command fails, db-setup exited 64 (${setupExit(p)})`);
      check(sl.includes(MSG.privileged(attr)), `${label}: the fixed refusal`);
      check(JSON.stringify(role(p)) === JSON.stringify(before), `${label}: the role is untouched (${roleShape(role(p))})`);
      check(p.ownerLoginWorks(s.owner), `${label}: the hand-made password still logs in`);
      check(extensions(p) === ext0 && ownedByOwner(p) === own0 && coreCount(p) === '0', `${label}: no extension, object or core schema created`);
      check(p.neverStarted('rab-api') && p.neverStarted('rab-worker'), `${label}: rab-api and rab-worker never started`);
      const f = p.readPasswordFile();
      n(`${label}: password file after the refusal: ${f ? 'present' : 'absent'}`);
    }
    p.psql('ALTER ROLE crewflow_owner NOBYPASSRLS');
  }, p);
  teardown(p);
}

// --------------------------------------------------------------------------------------------------------- block r256
async function blockR256() {
  const p = project('r256', { ownerInit: true, logging: false });
  const s = L.secrets;
  L.writeSecrets(p.secretsDir); // PG_SSL_CA_CERT_PATH spelled out: R256 has no bundled-db CA rule
  await step('S7', '7', 'an R256 database upgrades with its crewflow_owner URL (used unchanged, password kept), then with the bundled admin URL (the file logs in: unchanged); data and RLS identical', async (check, n) => {
    p.setPrev(false);
    use(p, { digest: R256, databaseUrl: L.ownerUrl() });
    const d0 = deploy(p, 'S7-r256-new-files');
    const s0 = p.health('db-setup');
    const a0 = p.neverStarted('rab-api');
    n(`R256 with this release's compose files alone: deploy exit ${d0.code}; db-setup ${s0}; rab-api ${a0 ? 'never started' : p.health('rab-api')}`);
    check(d0.code !== 0 && !s0.endsWith('|0|0') && a0, 'OBSERVED: a pre-DB-SETUP image cannot run under this release\'s compose files: a rollback across DB-SETUP needs the previous release\'s compose files');
    p.setPrev(true);
    const d = deploy(p, 'S7-r256');
    check(d.code === 0, `R256 (its own start-up, the hand-made crewflow_owner): exit ${d.code}`);
    await waitApp(p);
    check(p.psql('SELECT count(*) FROM core.migrations') === '256', 'R256 installed its 256 migrations');
    p.psqlFile('seed-organisations.sql');
    check(p.psql(`SELECT count(*) FROM core.organisation WHERE slug::text LIKE 'dot-seed-%'`) === '2', 'seeded 2 synthetic organisations');
    const before = L.facts(p);
    const snap0 = dbSnapshot(p);
    // (a) the unchanged crewflow_owner URL
    p.setPrev(false);
    use(p, { digest: NEW, databaseUrl: L.ownerUrl() });
    const da = deploy(p, 'S7-new-owner-url');
    check(da.code === 0, `NEW with the unchanged crewflow_owner URL: exit ${da.code}`);
    await waitApp(p);
    const sla = setupLog(p);
    evidence('S7-new-owner-url-db-setup.log', sla);
    check(MSG.readyUnchanged.test(lastReady(sla)), 'db-setup: crewflow_owner unchanged');
    const ra = JSON.parse(dbSnapshot(p));
    const r0 = JSON.parse(snap0);
    check(JSON.stringify(ra.role) === JSON.stringify(r0.role) && ra.acl === r0.acl && ra.members === r0.members, 'crewflow_owner (oid, attributes, VERIFIER, memberships) and the ACL are exactly as R256 left them');
    const f = p.readPasswordFile();
    check(f && f.password === s.owner && p.ownerLoginWorks(s.owner), 'the password file holds the hand-made password, which still logs in');
    const mra = migrateResults(p.logs('rab-api')).pop() || {};
    check(mra.exitCode === 0 && p.psql(`SELECT count(*) || '|' || count(DISTINCT name) FROM core.migrations`).split('|').every((x, i, a) => x === a[0]), `the upgrade completed (${mra.state}), no duplicate ledger rows`);
    L.compareFacts(check, before, L.facts(p), 'owner-URL upgrade');
    L.rlsCheck(p, check, 'owner-URL upgrade');
    checkSessions(p, check, 'S7 owner URL');
    // (b) the bundled admin URL instead
    const snapA = dbSnapshot(p);
    use(p, { digest: NEW, databaseUrl: null });
    const db = deploy(p, 'S7-new-admin-url');
    check(db.code === 0, `NEW with the bundled admin URL instead: exit ${db.code}`);
    await waitApp(p);
    check(MSG.readyUnchanged.test(lastReady(setupLog(p))) && dbSnapshot(p) === snapA, `admin URL: the file logs in, nothing changes (changed: ${snapDiff(snapA, dbSnapshot(p))})`);
    L.compareFacts(check, before, L.facts(p), 'admin-URL start');
    L.rlsCheck(p, check, 'admin-URL start');
    checkSessions(p, check, 'S7 admin URL');
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
    const logsOfS = (c) => L.run('docker', ['logs', c], { timeout: 240_000 }).out;
    const setups = [`${p.name}-setup-1`, `${p.name}-setup-2`];
    const ss = setups.map((c) => L.runAsync('docker', ['compose', 'run', '--no-deps', '-T', '--name', c, 'db-setup'], { env: p.composeEnv() }));
    const sr = await Promise.all(ss.map((x) => x.done));
    const slogs = setups.map(logsOfS);
    slogs.forEach((l, i) => evidence(`S9-db-setup-${i + 1}.log`, l));
    const sboot = slogs.map((l) => bootstrapLines(l));
    n(`db-setup 1: ${sboot[0].join(' / ')} || db-setup 2: ${sboot[1].join(' / ')}`);
    const created = slogs.filter((l) => MSG.readyCreated.test(l)).length;
    // The Helm design stores the password file exclusively BEFORE the transaction: the run that loses the race refuses
    // (the password-file race message) having changed nothing, or (if it came later) finds the role ready.
    const okRuns = sr.filter((r) => r.code === 0).length;
    const lostRace = slogs.filter((l, i) => sr[i].code !== 0 && MSG.passwordFileRace.test(l)).length;
    n(`exits ${sr.map((r) => r.code).join(', ')}; created ${created}; lost the race with the fixed message: ${lostRace}`);
    check(created === 1 && okRuns >= 1 && okRuns + lostRace === 2, `two db-setup runs at once: exactly one creates crewflow_owner; the other succeeds or refuses (the password-file race / per-volume lock message, nothing changed) (exits ${sr.map((r) => r.code).join(', ')})`);
    check(exactly01(role(p)), `one crewflow_owner, exactly the 01 attributes (${roleShape(role(p))})`);
    const pf = p.readPasswordFile();
    check(pf && pf.mode === '400 1000:1000' && p.ownerLoginWorks(pf.password), `after the race the password file (${pf ? pf.mode : 'absent'}) logs in as crewflow_owner: the file and the role agree`);
    const again = L.run('docker', ['compose', 'run', '--rm', '--no-deps', '-T', 'db-setup'], { env: p.composeEnv(), timeout: 300_000 });
    keep(p, 'S9-db-setup-again', again.out);
    check(again.code === 0 && MSG.readyUnchanged.test(again.out), `a third db-setup afterwards: exit ${again.code}, unchanged (the "start again" advice works)`);
    for (const c of setups) L.run('docker', ['rm', '-f', c], { timeout: 120_000 });
    const holder = await p.holdLock(`SELECT pg_advisory_lock(${L.MIGRATION_LOCK_KEY_SQL})`);
    const names = [`${p.name}-race-1`, `${p.name}-race-2`];
    const logsOf = (c) => L.run('docker', ['logs', c], { timeout: 240_000 }).out;
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
    check(logs.every((l) => !l.includes('[owner-bootstrap]')), 'neither API start ran a bootstrap child');
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
  note(`PostgreSQL ${PG_IMAGE}; image ${imageRef(NEW)}; R256 ${R256 ? imageRef(R256) : '(not set)'}; PG15 ${PG15_IMAGE ?? '(not set)'}; blocks ${BLOCKS.join(',')}; password file ${L.OWNER_PASSWORD_FILE}`);
  if (BLOCKS.includes('a')) await blockBundled();
  if (BLOCKS.includes('dep')) await blockDependsOnIgnored();
  if (BLOCKS.includes('race')) await blockRace();
  if (BLOCKS.includes('ext')) await blockExternal();
  if (BLOCKS.includes('ref')) await blockRefusals();
  if (BLOCKS.includes('pt')) await blockPassThrough();
  if (BLOCKS.includes('ptx')) await blockPassThroughRefusals();
  // R256 supports PostgreSQL 16 and 18 only (its fingerprint majors; it refuses 17 at boot): no R256 database exists on 17.
  if (BLOCKS.includes('r256') && R256 && MAJOR === '17') {
    note('block r256 not run on PostgreSQL 17: R256 refuses 17 at boot, so no R256 database on 17 exists to upgrade');
    results.push({ id: 'S7', owner: '7', title: 'not applicable on 17: R256 never ran on PostgreSQL 17', status: 'N/A', checks: [], notes: [] });
  } else if (BLOCKS.includes('r256') && R256) await blockR256();
  if (BLOCKS.includes('pg15') && PG15_IMAGE) await blockPg15();
  stopSampler();
  note(`peak of this run's running containers: ${peak.count} at ${peak.at} (${peak.names.join(', ')})`);
  writeResults();
  const summary = [
    `# DB-SETUP real-container tests (PR #125, the Twenty Helm way), PostgreSQL ${MAJOR}`,
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
