'use strict';
/**
 * DB-SETUP REAL-CONTAINER TESTS, THE TWENTY WAY (owner decision 2026-11-18, "change PR #125 option 2 to Twenty's way").
 * TEST-ONLY. One PostgreSQL major per run (16, 17 or 18), the production file docker-compose.image.yml UNCHANGED (its
 * bundled `db`, the one-shot `db-setup`, rab-api with api-prestart.sh, rab-worker with worker-start.sh) plus the test-only
 * overlays of this folder, deployed with THE documented command `docker compose pull && docker compose up -d`.
 *
 * The design under test: db-setup, rab-api and rab-worker all receive PG_DATABASE_URL, the crewflow_owner URL (for the
 * bundled db compose builds it from PG_DATABASE_APP_PASSWORD; upgrade-lib.cjs writeComposeEnv). Only db-setup holds an admin
 * login: the bundled db's superuser (mode a) or PG_ADMIN_URL (mode b, both URLs set). With it, crewflow_owner is created with
 * the password inside PG_DATABASE_URL, the password is SET when it does not log in, and CREATEROLE is kept and MARKED while
 * the schema bootstrap is pending, then REMOVED at the first db-setup run after the schema is current. Without an admin
 * (mode c) db-setup only checks crewflow_owner, read-only. rab-api / rab-worker refuse PG_ADMIN_URL, an empty password, and
 * (boot gate, production) a CREATEROLE crewflow_owner that is not marked. There is no setup volume, no target file and no
 * password file.
 *
 *   DOT_REPOSITORY=127.0.0.1:<port>/adolphus     a LOCAL registry (never Docker Hub)
 *   DOT_NEW_DIGEST=sha256:…                      the image under test, pushed to that registry
 *   DOT_PG_IMAGE=postgres@sha256:…               the bundled db's image for this major: a DEBIAN postgres image
 *   DOT_REDIS_IMAGE=redis@sha256:…
 *   [DOT_R256_DIGEST=sha256:…]                   R256 (0e0a6edd) in the same registry: enables block r256
 *   [DOT_PG15_IMAGE=postgres@sha256:…]           a Debian postgres:15 image: enables block pg15
 *   [DOT_PROJECT_PREFIX=dbs]                     project names <prefix>-pg<major>-<block>; never shared between runs
 *     node packages/rab-docker/deploy-order-tests/run-db-setup-tests.cjs <16|17|18> <out-dir>
 *          [--blocks=a,b,dep,race,ref,r256,pg15,lock] [--only=A1,B1,...] [--keep]
 *
 * Blocks (each its own disposable project, run one after another, `down --volumes` after each):
 *   a     mode (a), the bundled db. A1 fresh: crewflow_owner created with PG_DATABASE_APP_PASSWORD (01 attributes, CREATEROLE
 *         kept and marked), the first API start accepts the marked CREATEROLE with a WARNING, API + Worker healthy, no setup
 *         volume, no admin credential in any app process / definition, the image clean. A2 the next `up`: CREATEROLE removed
 *         and the mark cleared; the next `up`, and down + up, change nothing. A3 the boot check: CREATEROLE re-granted
 *         (unmarked) -> rab-api refuses to start; the next `up` removes it and the API recovers. C1-C3 mode (c) with the REAL
 *         bootstrap child (PG_DATABASE_URL only): read-only and unchanged; a wrong password refused 64 (no admin, never
 *         changed); an unmarked CREATEROLE on a complete schema refused 64. A4 a new PG_DATABASE_APP_PASSWORD: set by the
 *         superuser, the old refused, the apps recreated and healthy. A5 PG_ADMIN_URL forced into rab-api / rab-worker, an
 *         empty crewflow_owner password (apps and db-setup): 64. S8 no log holds a password, APP_SECRET or a verifier.
 *   b     mode (b), BOTH URLs set, a NON-superuser admin (CREATEROLE + the database grants WITH GRANT OPTION). B1 created; B2
 *         CREATEROLE removed by that admin; B3 a new password set by it; B4 refusals before any write (no ADMIN OPTION + a
 *         wrong password, two different databases, a non-crewflow_owner PG_DATABASE_URL, a crewflow_owner PG_ADMIN_URL, a
 *         BYPASSRLS / SUPERUSER crewflow_owner); S8X the log scan (a verifier only as the db log's non-superuser residual).
 *   dep   S11 `depends_on` ignored: rab-api / rab-worker started BEFORE db-setup cannot log in and restart; healthy once
 *         db-setup has run, without an admin path.
 *   race  S9 two db-setup at once (advisory lock): both exit 0, one creates; then two API starts at once: one migrate child
 *         applies, the other finds CURRENT.
 *   ref   the H1 / N1 / N2 refusals on the admin path: SP, H1a, H1b, N2; N1 the transition-shaped database (runbook §5):
 *         the admin path refused, mode (c) with the crewflow_owner URL works and writes nothing.
 *   r256  S7 an R256 database upgrades with the same compose.env: the hand-made password kept, CREATEROLE marked then
 *         removed on the next `up`; data, money, FKs, tenant ownership, RLS identical.
 *   pg15  S10C PostgreSQL 15: refused 64, nothing created.
 *   lock  M1L one server per data volume.
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
const BLOCKS = (argv.find((a) => a.startsWith('--blocks=')) ?? '--blocks=a,b,dep,race,ref,r256,pg15,lock').slice(9).split(',').filter(Boolean);
/** --only=<ids>: run only these cases (the others of a selected block are skipped and not reported). */
const ONLY = (argv.find((a) => a.startsWith('--only=')) ?? '').slice(7).split(',').filter(Boolean);
function fail(msg) {
  console.error(msg);
  process.exit(2);
}
if (!['16', '17', '18'].includes(MAJOR) || !OUT) fail('usage: run-db-setup-tests.cjs <16|17|18> <out-dir> [--blocks=a,b,dep,race,ref,r256,pg15,lock] [--only=A1,B1,...] [--keep]');
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
const MAX_CONTAINERS = 6; // + the one-shot db-setup or one one-off beside a running stack
const LOGGING_OVERLAY = 'deploy-order-tests/docker-compose.db-setup-logging.yml';
const BOOTSTRAP_APP = 'crewflow-owner-bootstrap';
const MSG = {
  // owner-bootstrap.ts OWNER_BOOTSTRAP_MESSAGES (the fixed refusal texts compared exactly, the outcome lines loosely).
  pgTooOld: 'PostgreSQL 15 is not supported; use 16-18 (PostgreSQL 16, 17 or 18). Nothing was created. Refusing.',
  privileged: (attrs) => `crewflow_owner exists with ${attrs}; Crewflow never runs as a privileged login.`,
  noAdminOption: /has no ADMIN OPTION on crewflow_owner/,
  ownerOwnsDatabase: /crewflow_owner owns this database/,
  searchPathDefault: /search_path default is set/,
  missingDb: /does not exist/,
  readyCreated: /crewflow_owner is ready \(created/,
  readyUnchanged: /crewflow_owner is ready \((existing crewflow_owner, checked read-only, )?unchanged/,
  readyReset: /crewflow_owner is ready \(password set/,
  passwordSet: /did not log in, so crewflow_owner now uses it/,
  // Owner decision 2026-11-20: an existing crewflow_owner's password is changed only with CREWFLOW_ROTATE_APP_PASSWORD=1.
  passwordMismatch: /PG_DATABASE_URL password doesn't match crewflow_owner/,
  rotateDone: /remove CREWFLOW_ROTATE_APP_PASSWORD/,
  ownerUrlAuth: /Without PG_ADMIN_URL db-setup never changes the password/,
  createRoleRemoved: /CREATEROLE was removed from crewflow_owner/,
  createRoleMarked: /crewflow_owner keeps CREATEROLE for it and is marked/,
  ownerUrlCreateRoleComplete: /has CREATEROLE although the schema is complete/,
  // api-prestart.sh / worker-start.sh
  adminRefusal: /PG_ADMIN_URL must never be set on the (api|worker) service/,
  emptyPassword: /PG_DATABASE_URL has an empty crewflow_owner password/,
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

/** compose.env for the case (upgrade-lib writeComposeEnv): by default mode (a) with PG_DATABASE_APP_PASSWORD = secrets.owner. */
function use(p, { digest = NEW, databaseUrl = null, adminUrl = null, appPassword = L.secrets.owner, pgImage = PG_IMAGE, extra = {} } = {}) {
  L.writeComposeEnv(p, { repository: REPO, digest, pgImage, redisImage: process.env.DOT_REDIS_IMAGE, databaseUrl, adminUrl, appPassword, extra });
}
/** Owner decision 2026-11-20: the one-deploy opt-in that lets db-setup change an existing crewflow_owner's password. */
const ROTATE = Object.freeze({ CREWFLOW_ROTATE_APP_PASSWORD: '1' });

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
  '  w=$(printf "%s\\n" "$e" | grep -cE "^PG_DATABASE_(APP_)?PASSWORD=")',
  '  c=$(tr "\\0" " " < "$d/cmdline" 2>/dev/null | cut -c1-90)',
  '  echo "$p|$h|$u|$w|$c"',
  'done',
  // The probe itself (a `docker exec`): it carries the container DEFINITION's environment, the accepted risk of plan §5.3.
  'e=$(tr "\\0" "\\n" < /proc/$$/environ); h=0; for s in "$S1" "$S2" "$S3"; do case "$e" in *"$s"*) h=1;; esac; done',
  // Owner decision 2026-11-18: a docker exec process carries the definition's PG_DATABASE_URL, the crewflow_owner URL.
  'z=$(printf "%s\\n" "$e" | sed -n "s#^PG_DATABASE_URL=[a-z]*://\\([^:@/]*\\).*#\\1#p")',
  'echo "probe|$h|${z:-unset}"',
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
      probeUrl = f[2] ?? '?'; // the crewflow_owner login of a docker exec process's PG_DATABASE_URL, or 'unset'
    }
    else if (f[1] !== 'gone') rows.push({ pid: f[0], hit: f[1] === '1', empty: f[1] === 'empty', urlUser: f[2] ?? '', pwVar: Number(f[3] || 0), cmd: (f[4] ?? '').trim() });
  }
  return { rows, probe, probeUrl };
}

/**
 * The rendered compose config (never written or printed): each app service's PG_DATABASE_URL login and host, whether it has
 * PG_ADMIN_URL pinned to "" (owner decision L-2), and db-setup's PG_DATABASE_URL login.
 */
function renderedUrls(p) {
  const r = p.compose(['config', '--format', 'json'], { timeout: 120_000 });
  if (r.code !== 0) throw new Error(`compose config failed (${r.code})`);
  const cfg = JSON.parse(r.stdout);
  const env = (svc) => (cfg.services && cfg.services[svc] && cfg.services[svc].environment) || {};
  const login = (u) => L.urlLogin(u);
  return {
    api: login(env('rab-api').PG_DATABASE_URL),
    worker: login(env('rab-worker').PG_DATABASE_URL),
    setup: login(env('db-setup').PG_DATABASE_URL),
    same: env('rab-api').PG_DATABASE_URL === env('db-setup').PG_DATABASE_URL && env('rab-worker').PG_DATABASE_URL === env('db-setup').PG_DATABASE_URL,
    adminPinned: ['rab-api', 'rab-worker'].every((svc) => env(svc).PG_ADMIN_URL === ''),
  };
}
/**
 * The app processes and definitions (owner decision 2026-11-18): every runtime process holds PG_DATABASE_URL = the
 * crewflow_owner URL; NO process, `docker exec` process or definition holds an admin credential (the sentinels),
 * PG_DATABASE_PASSWORD / PG_DATABASE_APP_PASSWORD or any non-crewflow_owner database URL.
 */
function checkEnviron(p, check, n, label, sentinels, { services = ['rab-api', 'rab-worker'] } = {}) {
  for (const svc of services) {
    const { rows, probe, probeUrl } = environScan(p, svc, sentinels);
    const desc = rows.map((x) => `pid ${x.pid} [${x.cmd.slice(0, 60)}] ${x.empty ? 'empty' : `${x.hit ? 'ADMIN-CREDENTIAL' : 'clean'} url-user=${x.urlUser || '-'}${x.pwVar ? ' PASSWORD-VARIABLE' : ''}`}`).join('; ');
    evidence(`${p.name}-${label}-${svc}-environ.txt`, desc.split('; ').join('\n'));
    const bad = rows.filter((x) => x.hit || x.pwVar || (x.urlUser && x.urlUser !== 'crewflow_owner'));
    check(rows.length > 1 && bad.length === 0, `${label}: none of ${svc}'s ${rows.length} processes holds an admin credential, a password variable or a non-crewflow_owner PG_DATABASE_URL${bad.length ? ` (FOUND in: ${bad.map((x) => `pid ${x.pid} ${x.cmd.slice(0, 40)}`).join(', ')})` : ''}`);
    const node = rows.filter((x) => /node .*main\.js/.test(x.cmd));
    check(node.length >= 1 && node.every((x) => x.urlUser === 'crewflow_owner'), `${label}: ${svc}'s runtime (${node.map((x) => `pid ${x.pid}`).join(', ') || 'not found'}) has PG_DATABASE_URL = the crewflow_owner login`);
    n(`${svc} processes: ${desc}`);
    check(probe === false && probeUrl === 'crewflow_owner', `${label}: a \`docker exec\` process in ${svc} holds no admin credential; its PG_DATABASE_URL is the crewflow_owner URL (${probeUrl})`);
    const def = L.run('docker', ['inspect', '-f', '{{range .Config.Env}}{{println .}}{{end}}', p.container(svc)], { timeout: 180_000 }).stdout;
    const urls = [...def.matchAll(/^([A-Z0-9_]+)=.*postgres(ql)?:\/\//gm)].map((m) => m[1]);
    check(!sentinels.some((x) => def.includes(x)) && !/^PG_DATABASE_(APP_)?PASSWORD=/m.test(def) && urls.join(',') === 'PG_DATABASE_URL' && !/^PG_ADMIN_URL=./m.test(def), `${label}: ${svc}'s container definition holds no admin credential, no password variable, no PG_ADMIN_URL value and exactly one database URL, PG_DATABASE_URL (${urls.join(', ') || 'none'})`);
  }
  const ru = renderedUrls(p);
  check(ru.api === 'crewflow_owner' && ru.worker === 'crewflow_owner' && ru.setup === 'crewflow_owner' && ru.same, `${label}: the rendered compose config gives db-setup, rab-api and rab-worker the SAME crewflow_owner PG_DATABASE_URL (${ru.api || '-'} / ${ru.worker || '-'} / ${ru.setup || '-'})`);
  check(ru.adminPinned, `${label}: the rendered compose config gives rab-api and rab-worker PG_ADMIN_URL="" (pinned; owner decision L-2)`);
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

async function waitApp(p, { api = 600_000, worker = 300_000 } = {}) {
  await p.waitHealthy('rab-api', api);
  if (worker) await p.waitHealthy('rab-worker', worker);
}

function teardown(p) {
  if (KEEP) return;
  const d = p.down();
  note(`cleanup ${p.name}: compose down --volumes exit ${d.code}`);
}

// ----------------------------------------------------------------------------------------------- snapshots / one-offs
/** Everything about crewflow_owner and the database a setup run could change; compared as one string (no secret values). */
function dbSnapshot(p) {
  const r = role(p);
  const members = p.psql(
    `SELECT coalesce(string_agg(b.rolname || ':' || m.inherit_option || '/' || m.set_option || '/' || m.admin_option, ',' ORDER BY b.rolname), '') FROM pg_auth_members m JOIN pg_roles b ON b.oid = m.roleid WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = 'crewflow_owner')`,
  );
  const settings = p.psql(`SELECT coalesce(string_agg(coalesce(d.datname, '-') || '/' || coalesce(r.rolname, '-') || '=' || array_to_string(s.setconfig, ';'), ',' ORDER BY 1), '') FROM pg_db_role_setting s LEFT JOIN pg_database d ON d.oid = s.setdatabase LEFT JOIN pg_roles r ON r.oid = s.setrole`);
  const owner = p.psql(`SELECT datdba::regrole::text FROM pg_database WHERE datname = 'crewflow'`);
  const roles = p.psql(`SELECT count(*) FROM pg_roles`);
  return JSON.stringify({ role: r, comment: roleComment(p), acl: dbAcl(p), members, settings, owner, roles });
}
const snapDiff = (a, b) => {
  const x = JSON.parse(a);
  const y = JSON.parse(b);
  return Object.keys(x).filter((k) => JSON.stringify(x[k]) !== JSON.stringify(y[k])).join(', ') || 'none';
};
/** crewflow_owner's COMMENT (the CREATEROLE mark lives there), '' when it has none. */
function roleComment(p) {
  return p.psql(`SELECT coalesce(pg_catalog.shobj_description(oid, 'pg_authid'), '') FROM pg_roles WHERE rolname = 'crewflow_owner'`);
}
/** The project's named volumes (names only). */
function projectVolumes(p) {
  return L.run('docker', ['volume', 'ls', '--format', '{{.Name}}', '--filter', `label=com.docker.compose.project=${p.name}`], { timeout: 60_000 })
    .stdout.split('\n')
    .filter(Boolean);
}
/** No setup volume, and no service mounts one: the target / password-file contract is gone (owner decision 2026-11-18). */
function checkNoSetupVolume(p, check, label) {
  const vols = projectVolumes(p);
  check(!vols.some((v) => /crewflow-db-target/.test(v)), `${label}: no setup volume in the project (${vols.join(', ') || 'none'})`);
  for (const svc of ['db-setup', 'rab-api', 'rab-worker']) {
    const r = L.run('docker', ['inspect', '-f', '{{json .Mounts}}', p.container(svc)], { timeout: 180_000 });
    if (r.code !== 0) continue;
    const dests = (JSON.parse(r.stdout || '[]') || []).map((m) => m.Destination);
    check(!dests.includes('/run/crewflow/db-target'), `${label}: ${svc} mounts no setup directory (${dests.join(', ') || 'no mounts'})`);
  }
}
/** The bootstrap child's machine line. */
function resultOf(out) {
  const m = [...String(out).matchAll(/OWNER_BOOTSTRAP_RESULT (\{.*\})/g)].pop();
  try {
    return m ? JSON.parse(m[1]) : {};
  } catch {
    return {};
  }
}
/** db-setup as a one-off (its own entrypoint, db-setup.sh): `env` overrides travel as `-e NAME`. */
function setupOnce(p, label, env = {}) {
  const r = oneOff(p, 'db-setup', label, { timeout: 300_000, env });
  return { code: r.code, out: r.out, boot: bootstrapLines(r.out), result: resultOf(r.out) };
}
/**
 * Mode (c) on these suites' bundled db: db-setup.sh refuses CREWFLOW_BUNDLED_DB=0 with a URL on the host `db` (the only name
 * the bundled db's certificate carries), so the REAL bootstrap child runs here directly, in the db-setup image and
 * definition, with PG_DATABASE_URL only (no PG_ADMIN_URL) and the bundled CA: exactly what db-setup.sh hands it in mode (c).
 * (db-setup.sh's mode switch itself is covered by run-prestart-shell-tests.cjs.)
 */
const CHILD = 'packages/rab-server/dist/database/typeorm/scripts/owner-login/bootstrap-owner-login.js';
function childModeC(p, label, ownerPassword) {
  L.rememberSecret(ownerPassword);
  const env = { PG_DATABASE_URL: L.ownerUrl(ownerPassword), PG_ADMIN_URL: '', PG_SSL_CA_CERT_PATH: '/run/crewflow/db-ca/ca.crt' };
  const r = oneOff(p, 'db-setup', label, { entrypoint: 'node', cmd: [CHILD], env, timeout: 300_000 });
  return { code: r.code, out: r.out, boot: bootstrapLines(r.out), result: resultOf(r.out) };
}
/** The image holds no password file, no setup directory and no database setting (inspect, history, filesystem). */
function checkImage(p, check, n, label) {
  const ref = imageRef(NEW);
  const insp = L.run('docker', ['image', 'inspect', '-f', '{{json .Config.Env}}|{{json .Config.Volumes}}', ref], { timeout: 240_000 });
  check(insp.code === 0 && !/PASSWORD_FILE|owner-password|db-target|PG_DATABASE_URL=.|PG_DATABASE_APP_PASSWORD/i.test(insp.stdout), `${label}: \`docker image inspect\`: no password-file, setup-volume or database setting in the image's Env or Volumes`);
  const name = `${p.name}-imagecheck`;
  const fsr = L.run('docker', ['run', '--rm', '--name', name, '--network', 'none', '--entrypoint', 'sh', ref, '-c', "find / -xdev -name 'owner-password*' 2>/dev/null; ls -A /run/crewflow/db-target 2>/dev/null; echo END"], { timeout: 180_000 });
  const found = fsr.stdout.split('\n').map((x) => x.trim()).filter((x) => x && x !== 'END');
  n(`image filesystem: ${found.length ? found.join(', ') : 'no password file, no setup directory'}`);
  check(fsr.code === 0 && /END/.test(fsr.stdout) && found.length === 0, `${label}: the image's filesystem holds no password file and no setup directory content`);
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
const MARK = 'crewflow:createrole-until-schema-current';

// ------------------------------------------------------------------------------------------------------------ block a
async function blockBundled() {
  const p = project('a');
  const s = L.secrets;
  L.writeSecrets(p.secretsDir, { caPath: null });
  use(p); // mode (a): PG_DATABASE_PASSWORD + PG_DATABASE_APP_PASSWORD (= s.owner); no PG_DATABASE_URL, no PG_ADMIN_URL
  let deployed = false;

  await step('A1', 'a', 'mode (a) fresh: the bundled superuser creates crewflow_owner with PG_DATABASE_APP_PASSWORD; CREATEROLE kept and MARKED for the first start; API and Worker healthy on that same URL', async (check, n) => {
    const d = deploy(p, 'A1-deploy');
    check(d.code === 0, `\`docker compose pull && docker compose up -d\` exit ${d.code} after ${Math.round(d.ms / 1000)} s`);
    await waitApp(p, { api: 900_000 });
    deployed = true;
    const sl = setupLog(p);
    evidence('A1-db-setup.log', sl);
    check(setupExit(p) === 'exited|0' && /db-setup: mode bundled/.test(sl) && MSG.readyCreated.test(lastReady(sl)), `db-setup (mode bundled) created crewflow_owner and exited 0 (${setupExit(p)})`);
    check(MSG.createRoleMarked.test(sl) && resultOf(sl).createRole === 'marked', `db-setup kept CREATEROLE for the bootstrap and marked it (createRole=${resultOf(sl).createRole})`);
    const r = role(p);
    check(exactly01(r), `crewflow_owner has exactly the 01 attributes, CREATEROLE included (${roleShape(r)})`);
    check(p.ownerLoginWorks(s.owner), 'PG_DATABASE_APP_PASSWORD logs in as crewflow_owner (verify-full)');
    check(roleComment(p) === MARK, 'crewflow_owner carries the CREATEROLE mark (COMMENT ON ROLE)');
    const al = p.logs('rab-api');
    evidence('A1-api.log', al);
    check(/still has CREATEROLE, marked by db-setup/.test(al), 'the API boot gate accepted the marked CREATEROLE for the first start, with its WARNING');
    const mr = migrateResults(al).pop() || {};
    check(mr.exitCode === 0 && ['EMPTY', 'BOOTSTRAP-PARTIAL'].includes(mr.state), `the first start's migrate child bootstrapped the schema (${mr.state}, exit ${mr.exitCode})`);
    checkSessions(p, check, 'A1');
    checkNoSetupVolume(p, check, 'A1');
    // The trade-off (THREAT-MODEL): the crewflow_owner URL is in the app definitions; the ADMIN credentials never are.
    checkEnviron(p, check, n, 'A1', [s.dbPassword]);
    checkImage(p, check, n, 'A1');
    const adm = adminConnections(p, ['postgres']);
    check(adm.others.length === 0, `the only admin connections are db-setup's (and the test's): ${adm.admin.map((x) => `${x.user}/${x.app || '-'} x${x.n}`).join(', ')}`);
  }, p);
  if (!deployed) return teardown(p);

  let afterRemoval = '';
  await step('A2', 'a', 'the next `up` after the schema is current: db-setup REMOVES CREATEROLE (and the mark); the next ones change nothing; a restart changes nothing', async (check, n) => {
    const d = deploy(p, 'A2-second-up');
    check(d.code === 0, `second deploy exit ${d.code}`);
    await L.waitFor('db-setup to exit', () => p.inspect('db-setup', '{{.State.Status}}') === 'exited', 300_000, 2000);
    const sl = setupLog(p);
    evidence('A2-db-setup.log', sl);
    check(setupExit(p) === 'exited|0' && MSG.createRoleRemoved.test(sl) && resultOf(sl).createRole === 'removed', `db-setup: "CREATEROLE was removed" (createRole=${resultOf(sl).createRole}, ${setupExit(p)})`);
    const r = role(p);
    check(r && !T(r.createrole) && !T(r.super) && !T(r.bypassrls) && !T(r.createdb) && !T(r.replication), `crewflow_owner is NOCREATEROLE now (${roleShape(r)})`);
    check(roleComment(p) === '', 'the mark is gone');
    n(`right after the second up: rab-api ${p.health('rab-api')}, rab-worker ${p.health('rab-worker')} (their posture baseline still has CREATEROLE)`);
    const rs = p.compose(['restart', 'rab-api', 'rab-worker'], { timeout: 600_000 });
    keep(p, 'A2-restart', rs.out);
    await waitApp(p);
    check(true, 'after a restart, rab-api and rab-worker boot on the NOCREATEROLE crewflow_owner and become healthy');
    afterRemoval = dbSnapshot(p);
    const d3 = deploy(p, 'A2-third-up');
    check(d3.code === 0, `third deploy exit ${d3.code}`);
    await L.waitFor('db-setup to exit', () => p.inspect('db-setup', '{{.State.Status}}') === 'exited', 300_000, 2000);
    const sl3 = setupLog(p);
    check(MSG.readyUnchanged.test(lastReady(sl3)) && resultOf(sl3).createRole === 'none', `the third db-setup: unchanged, nothing to do for CREATEROLE (createRole=${resultOf(sl3).createRole})`);
    check(dbSnapshot(p) === afterRemoval, `ZERO database changes on the third up (changed: ${snapDiff(afterRemoval, dbSnapshot(p))})`);
    const dn = p.compose(['down'], { timeout: 300_000 });
    keep(p, 'A2-down', dn.out);
    const d4 = deploy(p, 'A2-down-up');
    check(dn.code === 0 && d4.code === 0, `down (volumes kept) + up: exit ${dn.code} / ${d4.code}`);
    await waitApp(p);
    check(dbSnapshot(p) === afterRemoval, `down + up: ZERO database changes (changed: ${snapDiff(afterRemoval, dbSnapshot(p))})`);
  }, p);

  await step('A3', 'a', 'the boot check: CREATEROLE re-granted by an admin after the NOCREATEROLE step (no mark) -> rab-api refuses to start; the next `up` removes it again and the API recovers', async (check, n) => {
    p.psql('ALTER ROLE crewflow_owner CREATEROLE');
    const before = count(p.logs('rab-api'), 'has CREATEROLE after the schema bootstrap');
    const rs = p.compose(['restart', 'rab-api'], { timeout: 300_000 });
    keep(p, 'A3-restart', rs.out);
    await L.waitFor('the API boot gate to refuse', () => count(p.logs('rab-api'), 'has CREATEROLE after the schema bootstrap') > before, 600_000, 5000);
    const al = p.logs('rab-api');
    evidence('A3-api-refused.log', al);
    check(true, 'rab-api refused to start: "has CREATEROLE after the schema bootstrap"');
    check(!p.health('rab-api').startsWith('healthy|'), `rab-api is not healthy (${p.health('rab-api')})`);
    const d = deploy(p, 'A3-up');
    check(d.code === 0 || /rab-api/.test(d.out), `the next \`up\` (exit ${d.code}) ran db-setup again`);
    await L.waitFor('db-setup to exit', () => p.inspect('db-setup', '{{.State.Status}}') === 'exited', 300_000, 2000);
    check(resultOf(setupLog(p)).createRole === 'removed' && !T(role(p).createrole), 'db-setup (its latest run) removed the re-granted CREATEROLE');
    await waitApp(p, { api: 900_000 });
    check(true, 'rab-api recovered (restart policy) and is healthy again; the Worker too');
    n(`restart counts: rab-api ${p.inspect('rab-api', '{{.RestartCount}}')}, rab-worker ${p.inspect('rab-worker', '{{.RestartCount}}')}`);
  }, p);

  await step('C1', 'c', 'mode (c), the real bootstrap child with PG_DATABASE_URL only: read-only (every setup statement read-only in the db log), nothing changed, exit 0', async (check, n) => {
    const before = dbSnapshot(p);
    const from = p.logs(L.DB_SERVICE).length;
    const r = childModeC(p, 'C1-mode-c', s.owner);
    n(`bootstrap: ${r.boot.join(' / ')}`);
    check(r.code === 0 && r.result.outcome === 'pass-through' && MSG.readyUnchanged.test(r.out), `exit ${r.code}, outcome ${r.result.outcome}`);
    const st = setupStatements(p, from);
    const writes = st.filter((x) => !READ_ONLY_STATEMENT.test(x));
    check(st.length > 0 && writes.length === 0, `every statement of the crewflow_owner session is read-only (${st.length} logged; writes: ${writes.length})`);
    check(dbSnapshot(p) === before, `nothing changed (changed: ${snapDiff(before, dbSnapshot(p))})`);
  }, p);

  await step('C2', 'c', 'mode (c) with a password that does not log in: refused (64) with "Without PG_ADMIN_URL db-setup never changes the password"; nothing changed', async (check, n) => {
    const wrong = L.hex(32);
    s['a:wrong'] = wrong;
    const before = dbSnapshot(p);
    const r = childModeC(p, 'C2-mode-c-wrong', wrong);
    n(`bootstrap: ${r.boot.join(' / ')}`);
    check(r.code === 64 && MSG.ownerUrlAuth.test(r.out), `exit ${r.code}, the no-admin password refusal`);
    check(dbSnapshot(p) === before && p.ownerLoginWorks(s.owner) && !p.ownerLoginWorks(wrong), 'nothing changed: the real password still logs in, the wrong one does not');
  }, p);

  await step('C3', 'c', 'mode (c) with CREATEROLE re-granted, unmarked, on a complete schema: refused (64), the role untouched', async (check, n) => {
    p.psql('ALTER ROLE crewflow_owner CREATEROLE');
    const before = dbSnapshot(p);
    const r = childModeC(p, 'C3-mode-c-createrole', s.owner);
    n(`bootstrap: ${r.boot.join(' / ')}`);
    check(r.code === 64 && MSG.ownerUrlCreateRoleComplete.test(r.out), `exit ${r.code}, "has CREATEROLE although the schema is complete"`);
    check(dbSnapshot(p) === before, 'the role is untouched (mode c never writes)');
    p.psql('ALTER ROLE crewflow_owner NOCREATEROLE');
  }, p);

  await step('A4', 'a', 'mode (a) password mismatch: a NEW PG_DATABASE_APP_PASSWORD -> refused (64) without the opt-in; with CREWFLOW_ROTATE_APP_PASSWORD=1 db-setup SETS it with the superuser; the old one is refused; API and Worker recreated and healthy', async (check, n) => {
    const newPw = L.hex(32);
    s['a:new'] = newPw;
    const before = role(p);
    use(p, { appPassword: newPw });
    const refused = setupOnce(p, 'A4-no-opt-in');
    check(refused.code === 64 && MSG.passwordMismatch.test(refused.out), `without the opt-in: exit ${refused.code}, "PG_DATABASE_URL password doesn't match crewflow_owner"`);
    use(p, { appPassword: newPw, extra: ROTATE });
    const d = deploy(p, 'A4-new-password');
    check(d.code === 0, `deploy with the new password: exit ${d.code}`);
    await waitApp(p, { api: 900_000 });
    const sl = setupLog(p);
    evidence('A4-db-setup.log', sl);
    check(MSG.readyReset.test(lastReady(sl)) && MSG.passwordSet.test(sl) && MSG.rotateDone.test(sl), 'db-setup: "password set to the one inside PG_DATABASE_URL", then "remove CREWFLOW_ROTATE_APP_PASSWORD"');
    use(p, { appPassword: newPw });
    const after = role(p);
    check(after && before && after.oid === before.oid && after.verifierSha !== before.verifierSha, 'the same role (oid), a new verifier');
    check(p.ownerLoginWorks(newPw) && !p.ownerLoginWorks(s.owner), 'the new password logs in, the old one is refused');
    checkSessions(p, check, 'A4');
  }, p);

  await step('A5', 'a', 'the entrypoints: PG_ADMIN_URL forced into a rab-api one-off or rab-worker, or an empty crewflow_owner password, -> refused (64) before any connection', async (check, n) => {
    const admin = L.dbUrl('postgres', s.dbPassword);
    for (const svc of ['rab-api', 'rab-worker']) {
      const r = oneOff(p, svc, `A5-${svc}-admin`, { env: { PG_ADMIN_URL: admin }, cmd: svc === 'rab-api' ? ['node', 'packages/rab-server/dist/command/main.js', 'help'] : [], timeout: 180_000 });
      check(r.code === 64 && MSG.adminRefusal.test(r.out) && !r.out.includes(s.dbPassword), `${svc} with PG_ADMIN_URL: exit ${r.code}, refused, value not shown`);
    }
    const empty = 'postgresql://crewflow_owner:@db:5432/crewflow?sslmode=verify-full';
    for (const svc of ['rab-api', 'rab-worker']) {
      const r = oneOff(p, svc, `A5-${svc}-empty`, { env: { PG_DATABASE_URL: empty }, cmd: svc === 'rab-api' ? ['node', 'packages/rab-server/dist/command/main.js', 'help'] : [], timeout: 180_000 });
      check(r.code === 64 && MSG.emptyPassword.test(r.out), `${svc} with an empty crewflow_owner password: exit ${r.code}, refused`);
    }
    const r = setupOnce(p, 'A5-db-setup-empty', { PG_DATABASE_URL: empty });
    check(r.code === 64 && /the crewflow_owner password in PG_DATABASE_URL is empty/.test(r.out) && r.boot.length === 0, `db-setup with an empty crewflow_owner password: exit ${r.code}, refused before the child`);
  }, p);

  await step('S8', 'a', 'no log holds a password (superuser, crewflow_owner old and new), APP_SECRET or a SCRAM verifier', async (check, n) => {
    const texts = logTexts(p);
    const found = scanSecrets(texts, { dbPassword: s.dbPassword, owner: s.owner, ownerNew: s['a:new'], wrong: s['a:wrong'], appSecret: s.appSecret });
    check(found.length === 0, `no secret in ${Object.keys(texts).length} logs (${found.join('; ') || 'none'})`);
    const verifiers = Object.entries(texts).map(([k, t]) => [k, (t.match(VERIFIER_RE) || []).length]).filter(([, c]) => c > 0);
    check(verifiers.length === 0, `no SCRAM verifier in any log (${verifiers.map(([k, c]) => `${k} x${c}`).join(', ') || 'none'})`);
  }, p);
  teardown(p);
}

// ------------------------------------------------------------------------------------------------------------ block b
/**
 * Mode (b): PG_ADMIN_URL + PG_DATABASE_URL BOTH set (the normal admin mode now), with a NON-superuser admin on the bundled
 * db (CREATEROLE + CONNECT/CREATE/TEMPORARY WITH GRANT OPTION, as a provider admin), so the NOCREATEROLE step runs through
 * CREATEROLE + ADMIN OPTION, not superuser.
 */
async function blockAdmin() {
  const p = project('b');
  const s = L.secrets;
  const adminPw = L.hex(32);
  const admin2Pw = L.hex(32);
  const appPw = L.hex(32);
  Object.assign(s, { 'b:admin': adminPw, 'b:admin2': admin2Pw, 'b:app': appPw });
  L.writeSecrets(p.secretsDir, { caPath: null });
  const adminUrl = L.dbUrl('dot_admin', adminPw);
  use(p, { adminUrl, databaseUrl: L.ownerUrl(appPw), appPassword: null });
  const pull = p.compose(['pull', '--quiet'], { timeout: 600_000 });
  const up = p.compose(['up', '-d', '--wait', L.DB_SERVICE], { timeout: 300_000 });
  keep(p, 'b-db-up', up.out);
  if (pull.code !== 0 || up.code !== 0) throw new Error(`block b: db did not come up (pull ${pull.code}, up ${up.code})`);
  p.psql(`CREATE ROLE dot_admin LOGIN NOSUPERUSER NOBYPASSRLS CREATEROLE PASSWORD '${adminPw}'; GRANT CONNECT, CREATE, TEMPORARY ON DATABASE crewflow TO dot_admin WITH GRANT OPTION;`);
  let deployed = false;

  await step('B1', 'b', 'mode (b), both URLs set, a NON-superuser admin: crewflow_owner created with the password inside PG_DATABASE_URL; API and Worker healthy; the admin URL in no app container', async (check, n) => {
    const d = deploy(p, 'B1-deploy');
    check(d.code === 0, `deploy exit ${d.code}`);
    await waitApp(p, { api: 900_000 });
    deployed = true;
    const sl = setupLog(p);
    evidence('B1-db-setup.log', sl);
    check(/db-setup: mode admin/.test(sl) && MSG.readyCreated.test(lastReady(sl)) && resultOf(sl).createRole === 'marked', `db-setup mode admin: created, CREATEROLE marked (createRole=${resultOf(sl).createRole})`);
    check(exactly01(role(p)) && p.ownerLoginWorks(appPw), `crewflow_owner exactly 01, the PG_DATABASE_URL password logs in (${roleShape(role(p))})`);
    checkSessions(p, check, 'B1');
    checkEnviron(p, check, n, 'B1', [adminPw, s.dbPassword]);
  }, p);
  if (!deployed) return teardown(p);

  await step('B2', 'b', 'the next `up`: the NON-superuser admin removes CREATEROLE (CREATEROLE + ADMIN OPTION on crewflow_owner)', async (check, n) => {
    const d = deploy(p, 'B2-up');
    check(d.code === 0, `deploy exit ${d.code}`);
    await L.waitFor('db-setup to exit', () => p.inspect('db-setup', '{{.State.Status}}') === 'exited', 300_000, 2000);
    const sl = setupLog(p);
    evidence('B2-db-setup.log', sl);
    check(MSG.createRoleRemoved.test(sl) && !T(role(p).createrole) && roleComment(p) === '', 'CREATEROLE removed and the mark cleared by dot_admin');
    const rs = p.compose(['restart', 'rab-api', 'rab-worker'], { timeout: 600_000 });
    keep(p, 'B2-restart', rs.out);
    await waitApp(p);
    check(true, 'the apps boot on the NOCREATEROLE crewflow_owner');
  }, p);

  await step('B3', 'b', 'mode (b) password mismatch: a new password inside PG_DATABASE_URL -> the admin SETS it (other-database check passed); old refused; apps healthy', async (check, n) => {
    const newPw = L.hex(32);
    s['b:new'] = newPw;
    use(p, { adminUrl, databaseUrl: L.ownerUrl(newPw), appPassword: null, extra: ROTATE });
    const d = deploy(p, 'B3-new-password');
    check(d.code === 0, `deploy exit ${d.code}`);
    await waitApp(p, { api: 900_000 });
    check(MSG.readyReset.test(lastReady(setupLog(p))), 'db-setup: password set');
    check(p.ownerLoginWorks(newPw) && !p.ownerLoginWorks(appPw), 'the new password logs in, the old one is refused');
    use(p, { adminUrl, databaseUrl: L.ownerUrl(newPw), appPassword: null });
  }, p);

  await step('B4', 'b', 'refusals of mode (b), each before any write: an admin without ADMIN OPTION + a wrong password; a SUPERUSER / BYPASSRLS crewflow_owner; two URLs naming different databases; a non-crewflow_owner PG_DATABASE_URL; a PG_ADMIN_URL that logs in as crewflow_owner', async (check, n) => {
    p.psql(`CREATE ROLE dot_admin2 LOGIN NOSUPERUSER NOBYPASSRLS CREATEROLE PASSWORD '${admin2Pw}'; GRANT CONNECT, CREATE, TEMPORARY ON DATABASE crewflow TO dot_admin2 WITH GRANT OPTION;`);
    const cur = s['b:new'];
    const before = dbSnapshot(p);
    const wrong = L.hex(32);
    s['b:wrong'] = wrong;
    const cases = [
      ['a wrong password without the opt-in', { PG_ADMIN_URL: adminUrl, PG_DATABASE_URL: L.ownerUrl(wrong) }, MSG.passwordMismatch],
      ['no ADMIN OPTION + a wrong password', { PG_ADMIN_URL: L.dbUrl('dot_admin2', admin2Pw), PG_DATABASE_URL: L.ownerUrl(wrong), ...ROTATE }, MSG.noAdminOption],
      ['different databases', { PG_ADMIN_URL: L.dbUrl('dot_admin', adminPw, 'postgres'), PG_DATABASE_URL: L.ownerUrl(cur) }, /name different databases/],
      ['a non-crewflow_owner PG_DATABASE_URL', { PG_ADMIN_URL: adminUrl, PG_DATABASE_URL: L.dbUrl('dot_admin', adminPw) }, /must log in as crewflow_owner/],
      ['a crewflow_owner PG_ADMIN_URL', { PG_ADMIN_URL: L.ownerUrl(cur), PG_DATABASE_URL: L.ownerUrl(cur) }, /PG_ADMIN_URL logs in as crewflow_owner/],
    ];
    for (const [label, env, re] of cases) {
      const r = setupOnce(p, `B4-${label.replace(/[^a-z]+/gi, '-')}`, env);
      n(`${label}: ${r.boot.join(' / ')}`);
      check(r.code === 64 && re.test(r.out), `${label}: exit ${r.code}, refused`);
      check(dbSnapshot(p) === before, `${label}: nothing changed (changed: ${snapDiff(before, dbSnapshot(p))})`);
    }
    for (const attr of ['BYPASSRLS', 'SUPERUSER']) {
      p.psql(`ALTER ROLE crewflow_owner ${attr}`);
      const snap = dbSnapshot(p);
      const r = setupOnce(p, `B4-${attr}`);
      check(r.code === 64 && r.out.includes(MSG.privileged(attr)), `a ${attr} crewflow_owner on the admin path: exit ${r.code}, "${MSG.privileged(attr)}"`);
      check(dbSnapshot(p) === snap, `${attr}: untouched`);
      p.psql(`ALTER ROLE crewflow_owner NO${attr}`);
    }
  }, p);

  await step('S8X', 'b', 'the log scan with a NON-superuser admin: no password or APP_SECRET; a SCRAM verifier only as the documented non-superuser residual (the bind parameters of the db log)', async (check, n) => {
    const texts = logTexts(p);
    const found = scanSecrets(texts, { admin: adminPw, admin2: admin2Pw, app: appPw, appNew: s['b:new'], wrong: s['b:wrong'], dbPassword: s.dbPassword, appSecret: s.appSecret });
    check(found.length === 0, `no secret in any log (${found.join('; ') || 'none'})`);
    const verifiers = Object.entries(texts).map(([k, t]) => [k, (t.match(VERIFIER_RE) || []).length]).filter(([, c]) => c > 0);
    n(`verifiers: ${verifiers.map(([k, c]) => `${k} x${c}`).join(', ') || 'none'}`);
    check(verifiers.every(([k]) => k === `${L.DB_SERVICE} log`), 'a verifier, if any, only in the db server log (non-superuser residual), never in an app or db-setup log');
  }, p);
  teardown(p);
}

// ---------------------------------------------------------------------------------------------------------- block dep
async function blockDependsOnIgnored() {
  const p = project('dep', { logging: true });
  L.writeSecrets(p.secretsDir, { caPath: null });
  use(p);
  await step('S11', 'A6', '`depends_on` ignored: rab-api and rab-worker started BEFORE db-setup on a fresh database cannot log in (no crewflow_owner yet) and restart; once db-setup has run they become healthy', async (check, n) => {
    const pull = p.compose(['pull', '--quiet'], { timeout: 600_000 });
    check(pull.code === 0, 'images pulled');
    const up = p.compose(['up', '-d', '--wait', L.DB_SERVICE, 'rab-redis'], { timeout: 300_000 });
    keep(p, 'S11-infra-up', up.out);
    check(up.code === 0, `db and rab-redis up (exit ${up.code})`);
    // A platform that ignores depends_on: compose only CREATES the two containers, and docker starts them directly.
    const created = p.compose(['create', 'rab-api', 'rab-worker'], { timeout: 300_000 });
    keep(p, 'S11-create', created.out);
    const started = L.run('docker', ['start', p.container('rab-api'), p.container('rab-worker')], { timeout: 600_000 });
    keep(p, 'S11-start', started.out);
    check(created.code === 0 && started.code === 0 && p.neverStarted('db-setup'), `rab-api and rab-worker started directly (\`docker start\`), db-setup NOT run (create exit ${created.code}, start exit ${started.code})`);
    await L.sleep(40_000);
    const al = p.logs('rab-api');
    evidence('S11-api-before.log', al);
    evidence('S11-worker-before.log', p.logs('rab-worker'));
    check(!p.health('rab-api').startsWith('healthy|'), `rab-api is not healthy without crewflow_owner (${p.health('rab-api')})`);
    check(role(p) === null, 'no crewflow_owner exists yet (the apps never take an admin path)');
    const conns = adminConnections(p, []).all.filter((x) => x.app !== L.TEST_APP_NAME && x.app !== 'pg_isready');
    check(conns.length === 0, `no AUTHORIZED connection from the apps (${conns.map((x) => `${x.user}/${x.app} x${x.n}`).join(', ') || 'none'})`);
    const setup = p.compose(['up', '-d', '--no-deps', 'db-setup'], { timeout: 300_000 });
    keep(p, 'S11-db-setup', setup.out);
    await L.waitFor('db-setup to exit', () => p.inspect('db-setup', '{{.State.Status}}') === 'exited', 300_000, 2000);
    check(setupExit(p) === 'exited|0', `db-setup ran afterwards and exited 0 (${setupExit(p)})`);
    await waitApp(p, { api: 900_000, worker: 600_000 });
    check(true, 'rab-api and rab-worker became healthy (restart policy) without the test restarting them');
    n(`restart counts: rab-api ${p.inspect('rab-api', '{{.RestartCount}}')}, rab-worker ${p.inspect('rab-worker', '{{.RestartCount}}')}`);
    checkSessions(p, check, 'S11');
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
  use(p); // mode (a): the bundled superuser is the admin
  const start = (label) => {
    const r = setupOnce(p, label);
    return { code: r.code, out: r.out, boot: r.boot };
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
    await step(id, 'A5', `H1: crewflow_owner ${variant === 'db-owner' ? 'OWNS the database' : 'INHERITs the role that owns the database'} and plants an operator + a database search_path: the admin path is refused (64), ZERO planted calls ran during the setup`, async (check, n) => {
      makeOwner();
      if (variant === 'db-owner') p.psql('ALTER DATABASE crewflow OWNER TO crewflow_owner');
      else p.psql('CREATE ROLE cf_dbo NOLOGIN NOSUPERUSER NOBYPASSRLS; GRANT cf_dbo TO crewflow_owner; ALTER DATABASE crewflow OWNER TO cf_dbo;');
      plant();
      const before = dbSnapshot(p);
      const c0 = calls();
      const r = start(`${id}-admin`);
      const c1 = calls();
      n(`bootstrap: ${r.boot.join(' / ')}`);
      check(r.code === 64 && MSG.ownerOwnsDatabase.test(r.out), `exit ${r.code}, the "crewflow_owner owns this database" refusal`);
      check(c1 === c0, `the planted operator never ran during the setup (${c1 - c0} call(s) while db-setup ran)`);
      check(dbSnapshot(p) === before, `crewflow_owner and the database unchanged (changed: ${snapDiff(before, dbSnapshot(p))})`);
      const c2 = calls();
      p.psql(`SELECT 'a'::name = 'a'::name`);
      check(calls() - c2 >= 1, 'sanity: an unpinned superuser session does reach the planted operator, so "zero" proves the pinning');
      unplant();
      p.psql(`DROP OWNED BY crewflow_owner; DROP ROLE crewflow_owner;${variant === 'db-owner' ? '' : ' DROP ROLE cf_dbo;'}`);
    }, p);
  }

  await step('N2', 'A5', 'N2: crewflow_owner a member of the owning role WITH INHERIT FALSE, SET TRUE: the admin path is refused (64), nothing written', async (check, n) => {
    makeOwner();
    p.psql('CREATE ROLE cf_dbo2 NOLOGIN NOSUPERUSER NOBYPASSRLS; GRANT cf_dbo2 TO crewflow_owner WITH INHERIT FALSE, SET TRUE; ALTER DATABASE crewflow OWNER TO cf_dbo2;');
    const before = dbSnapshot(p);
    const r = start('N2-admin');
    n(`bootstrap: ${r.boot.join(' / ')}`);
    check(r.code === 64 && MSG.ownerOwnsDatabase.test(r.out), `exit ${r.code}, the owner refusal`);
    check(dbSnapshot(p) === before, `nothing changed (changed: ${snapDiff(before, dbSnapshot(p))})`);
    p.psql('ALTER DATABASE crewflow OWNER TO postgres; DROP OWNED BY crewflow_owner; DROP ROLE crewflow_owner; DROP ROLE cf_dbo2;');
  }, p);

  await step('N1', 'A5', 'N1 (the transition from a separated deployment, runbook §5): a transition-shaped database (owned by a role a NOCREATEROLE crewflow_owner INHERITs): the admin path -> 64; mode (c) with the crewflow_owner URL -> exit 0, nothing written', async (check, n) => {
    p.psql(`CREATE ROLE cf_rab_owner NOLOGIN NOSUPERUSER NOBYPASSRLS; ALTER DATABASE crewflow OWNER TO cf_rab_owner; CREATE ROLE crewflow_owner LOGIN NOSUPERUSER NOBYPASSRLS NOREPLICATION NOCREATEDB NOCREATEROLE INHERIT PASSWORD '${pwH}'; GRANT cf_rab_owner TO crewflow_owner WITH INHERIT TRUE, SET TRUE; GRANT CONNECT, CREATE, TEMPORARY ON DATABASE crewflow TO crewflow_owner WITH GRANT OPTION;`);
    const before = dbSnapshot(p);
    const r = start('N1-admin');
    n(`admin path: ${r.boot.join(' / ')}`);
    check(r.code === 64 && MSG.ownerOwnsDatabase.test(r.out), `the admin path: exit ${r.code}, the owner refusal`);
    check(dbSnapshot(p) === before, 'nothing changed');
    const r2 = childModeC(p, 'N1-mode-c', pwH);
    n(`mode (c): ${r2.boot.join(' / ')}`);
    check(r2.code === 0 && r2.result.outcome === 'pass-through', `mode (c) with the crewflow_owner URL: exit ${r2.code}`);
    check(dbSnapshot(p) === before && p.ownerLoginWorks(pwH), `mode (c) wrote nothing and the password still logs in (changed: ${snapDiff(before, dbSnapshot(p))})`);
  }, p);
  teardown(p);
}

// --------------------------------------------------------------------------------------------------------- block r256
async function blockR256() {
  const p = project('r256', { ownerInit: true, logging: false });
  const s = L.secrets;
  L.writeSecrets(p.secretsDir); // PG_SSL_CA_CERT_PATH spelled out: R256 has no bundled-db CA rule
  await step('S7', '7', 'an R256 database upgrades with the SAME compose.env (PG_DATABASE_APP_PASSWORD = its hand-made crewflow_owner password): the password is kept, CREATEROLE marked then removed on the next up; data and RLS identical', async (check, n) => {
    p.setPrev(false);
    use(p, { digest: R256 });
    const d0 = deploy(p, 'S7-r256-new-files');
    const s0 = p.health('db-setup');
    const a0 = p.neverStarted('rab-api');
    n(`R256 with this release's compose files alone: deploy exit ${d0.code}; db-setup ${s0}; rab-api ${a0 ? 'never started' : p.health('rab-api')}`);
    check(d0.code !== 0 && !s0.endsWith('|0|0') && a0, "OBSERVED: a pre-DB-SETUP image cannot run under this release's compose files: a rollback across DB-SETUP needs the previous release's compose files");
    p.setPrev(true);
    const d = deploy(p, 'S7-r256');
    check(d.code === 0, `R256 (its own start-up, the hand-made crewflow_owner): exit ${d.code}`);
    await waitApp(p);
    check(p.psql('SELECT count(*) FROM core.migrations') === '256', 'R256 installed its 256 migrations');
    p.psqlFile('seed-organisations.sql');
    check(p.psql(`SELECT count(*) FROM core.organisation WHERE slug::text LIKE 'dot-seed-%'`) === '2', 'seeded 2 synthetic organisations');
    const before = L.facts(p);
    const r0 = role(p);
    p.setPrev(false);
    use(p, { digest: NEW });
    const da = deploy(p, 'S7-new');
    check(da.code === 0, `NEW with the same compose.env: exit ${da.code}`);
    await waitApp(p, { api: 900_000 });
    const sla = setupLog(p);
    evidence('S7-new-db-setup.log', sla);
    check(MSG.readyUnchanged.test(lastReady(sla)) && ['marked', 'kept'].includes(resultOf(sla).createRole), `db-setup: the password logs in (unchanged); CREATEROLE kept and marked for the pending migrations (createRole=${resultOf(sla).createRole}; 'kept' when 01-crewflow-owner.sql already marked it)`);
    const ra = role(p);
    check(ra && r0 && ra.oid === r0.oid && ra.verifierSha === r0.verifierSha, 'crewflow_owner (oid, VERIFIER) exactly as R256 left it');
    check(p.ownerLoginWorks(s.owner), 'the hand-made password still logs in');
    const mra = migrateResults(p.logs('rab-api')).pop() || {};
    check(mra.exitCode === 0 && p.psql(`SELECT count(*) || '|' || count(DISTINCT name) FROM core.migrations`).split('|').every((x, i, a) => x === a[0]), `the upgrade completed (${mra.state}), no duplicate ledger rows`);
    L.compareFacts(check, before, L.facts(p), 'upgrade');
    L.rlsCheck(p, check, 'upgrade');
    checkSessions(p, check, 'S7');
    const db2 = deploy(p, 'S7-next-up');
    check(db2.code === 0, `the next up: exit ${db2.code}`);
    await L.waitFor('db-setup to exit', () => p.inspect('db-setup', '{{.State.Status}}') === 'exited', 300_000, 2000);
    check(resultOf(setupLog(p)).createRole === 'removed' && !T(role(p).createrole), 'the next db-setup removed CREATEROLE');
    const rs = p.compose(['restart', 'rab-api', 'rab-worker'], { timeout: 600_000 });
    keep(p, 'S7-restart', rs.out);
    await waitApp(p);
    L.compareFacts(check, before, L.facts(p), 'after the NOCREATEROLE step');
  }, p);
  teardown(p);
}

// --------------------------------------------------------------------------------------------------------- block race
async function blockRace() {
  const p = project('race', { logging: false });
  L.writeSecrets(p.secretsDir, { caPath: null });
  use(p);
  await step('S9', '9', 'two db-setup runs at the same moment on a fresh bundled database: the advisory lock serialises them (one creates, the other finds it ready); then two API starts at the same moment: one migrate child applies, the other finds CURRENT', async (check, n) => {
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
    n(`db-setup 1: ${bootstrapLines(slogs[0]).join(' / ')} || db-setup 2: ${bootstrapLines(slogs[1]).join(' / ')}`);
    const created = slogs.filter((l) => MSG.readyCreated.test(l)).length;
    check(created === 1 && sr.every((r) => r.code === 0), `two db-setup runs at once: both exit 0, exactly one creates crewflow_owner (exits ${sr.map((r) => r.code).join(', ')}; created ${created})`);
    check(exactly01(role(p)) && p.ownerLoginWorks(L.secrets.owner), `one crewflow_owner, exactly the 01 attributes, PG_DATABASE_APP_PASSWORD logs in (${roleShape(role(p))})`);
    const again = L.run('docker', ['compose', 'run', '--rm', '--no-deps', '-T', 'db-setup'], { env: p.composeEnv(), timeout: 300_000 });
    keep(p, 'S9-db-setup-again', again.out);
    check(again.code === 0 && MSG.readyUnchanged.test(again.out), `a third db-setup afterwards: exit ${again.code}, unchanged`);
    for (const c of setups) L.run('docker', ['rm', '-f', c], { timeout: 120_000 });
    const holder = await p.holdLock(`SELECT pg_advisory_lock(${L.MIGRATION_LOCK_KEY_SQL})`);
    const names = [`${p.name}-race-1`, `${p.name}-race-2`];
    const logsOf = (c) => L.run('docker', ['logs', c], { timeout: 240_000 }).out;
    try {
      const starts = names.map((c) => L.runAsync('docker', ['compose', 'run', '-d', '--no-deps', '--name', c, 'rab-api'], { env: p.composeEnv() }));
      const rs = await Promise.all(starts.map((x) => x.done));
      check(rs.every((r) => r.code === 0), `two one-off rab-api containers started together (./api-prestart.sh): exits ${rs.map((r) => r.code).join(', ')}`);
      await L.waitFor('both migrate children to wait for the migration lock', () => names.every((c) => /taking the migration lock/.test(logsOf(c))), 240_000, 2000);
      check(true, 'both took PG_DATABASE_URL from the environment and wait on the migration advisory lock');
    } finally {
      await holder.release();
    }
    await L.waitFor('both migrate results', () => names.every((c) => migrateResults(logsOf(c)).length >= 1), 600_000, 3000);
    const logs = names.map(logsOf);
    logs.forEach((l, i) => evidence(`S9-api-${i + 1}.log`, l));
    check(logs.every((l) => !l.includes('[owner-bootstrap]')), 'neither API start ran a bootstrap child');
    const res = logs.map((l) => migrateResults(l).pop() || {});
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
  use(p, { pgImage: PG15_IMAGE });
  await step('S10C', '10', 'PostgreSQL 15 as the bundled db: refused before anything is created', async (check, n) => {
    const up = p.compose(['up', '-d', '--wait', L.DB_SERVICE], { timeout: 300_000 });
    keep(p, 'S10C-db-up', up.out);
    check(up.code === 0, `db (PostgreSQL 15) up and healthy (exit ${up.code})`);
    check(p.psql('SHOW server_version_num').startsWith('15'), 'the server is PostgreSQL 15');
    const r = setupOnce(p, 'S10C-db-setup');
    n(`bootstrap: ${r.boot.join(' / ')}`);
    check(r.code === 64 && r.out.includes(MSG.pgTooOld), `db-setup exits 64 with "${MSG.pgTooOld}" (exit ${r.code})`);
    check(role(p) === null && p.psql(`SELECT count(*) FROM pg_namespace WHERE nspname = 'core'`) === '0', 'no crewflow_owner, nothing created');
  }, p);
  teardown(p);
}

// --------------------------------------------------------------------------------------------------------- block lock
/**
 * Security review of F2, M1: ONE server per data volume (the 2026-10-15 incident: two postgres servers on one data
 * directory corrupt it). The db entrypoint takes a kernel lock (flock -n, fd 8) on /var/lib/postgresql/.crewflow-server.lock
 * in the data volume before anything else. With the stack's db running, `docker compose run -d db` starts a second db
 * container on the SAME named volumes: it must exit non-zero with the refusal line, before the TLS or pg_hba step, and the
 * first server must stay healthy and keep serving.
 */
const LOCK_REFUSAL = 'crewflow-db: another server already holds this data volume - refusing';
async function blockServerLock() {
  const p = project('lock', { logging: false });
  L.writeSecrets(p.secretsDir, { caPath: null });
  use(p, { databaseUrl: null });
  const second = `${p.name}-db-second`;
  await step('M1L', 'F2-M1', 'one server per data volume: a second db container on the same volume refuses; the first stays healthy', async (check, n) => {
    const up = p.compose(['up', '-d', '--wait', L.DB_SERVICE], { timeout: 300_000 });
    keep(p, 'M1L-db-up', up.out);
    check(up.code === 0, `db up and healthy (exit ${up.code})`);
    const started = p.inspect(L.DB_SERVICE, '{{.State.StartedAt}}');
    const postmaster = p.psql('SELECT pg_postmaster_start_time()');
    check(postmaster !== '', 'the first server answers');
    // The image ships flock (Debian util-linux, essential), and the lock file is on the data volume (same device as the
    // cluster), owned by the db's uid 999.
    const fl = L.run('docker', ['exec', p.container(L.DB_SERVICE), 'sh', '-c', 'command -v flock; stat -c "%u %d" /var/lib/postgresql/.crewflow-server.lock /var/lib/postgresql/pgdata']);
    const [flockPath, lockStat, dataStat] = fl.stdout.trim().split('\n');
    n(`flock: ${flockPath}; lock file uid/device ${lockStat}; pgdata uid/device ${dataStat}`);
    check(fl.code === 0 && /\/flock$/.test(flockPath ?? ''), `the db image has flock (${flockPath ?? 'missing'})`);
    check(Boolean(lockStat) && lockStat.split(' ')[0] === '999' && lockStat.split(' ')[1] === (dataStat ?? '').split(' ')[1], 'the lock file is on the data volume, owned by uid 999');
    // The second server: the same service, so the same named volumes (data, CA); detached, named so it is removed exactly.
    const run2 = p.compose(['run', '-d', '--no-deps', '--name', second, L.DB_SERVICE], { timeout: 120_000 });
    keep(p, 'M1L-second-run', run2.out);
    check(run2.code === 0, `the second db container was started (docker compose run -d, exit ${run2.code})`);
    let state = '';
    for (let i = 0; i < 60; i += 1) {
      state = L.run('docker', ['inspect', '-f', '{{.State.Status}}|{{.State.ExitCode}}', second]).stdout.trim();
      if (state.startsWith('exited|')) break;
      await L.sleep(1000);
    }
    const logs2 = L.run('docker', ['logs', second], { timeout: 60_000 }).out;
    evidence(`${p.name}-M1L-second.log`, L.redact(logs2));
    n(`second container: ${state}`);
    check(/^exited\|[1-9]\d*$/.test(state), `the second container exited non-zero (${state || 'no state'})`);
    check(logs2.includes(LOCK_REFUSAL), `the second container printed "${LOCK_REFUSAL}"`);
    check(!/creating the bundled database CA|database system is ready|PostgreSQL init process/i.test(logs2), 'the second container refused before the TLS step and never started postgres');
    check(p.health(L.DB_SERVICE).startsWith('healthy|running|'), `the first db is still healthy (${p.health(L.DB_SERVICE)})`);
    check(p.inspect(L.DB_SERVICE, '{{.State.StartedAt}}') === started, 'the first db container was not restarted');
    check(p.psql('SELECT pg_postmaster_start_time()') === postmaster, 'the first server is the same postmaster and still answers');
    const rm = L.run('docker', ['rm', '-f', second]);
    check(rm.code === 0, `the second container removed by its exact name (exit ${rm.code})`);
  }, p);
  // Never leave the second container behind, whatever happened above (exact name only).
  L.run('docker', ['rm', '-f', second]);
  teardown(p);
}

// ------------------------------------------------------------------------------------------------------------- main
async function main() {
  L.newSecrets();
  const stopSampler = startPeakSampler();
  note(`PostgreSQL ${PG_IMAGE}; image ${imageRef(NEW)}; R256 ${R256 ? imageRef(R256) : '(not set)'}; PG15 ${PG15_IMAGE ?? '(not set)'}; blocks ${BLOCKS.join(',')}`);
  if (BLOCKS.includes('a')) await blockBundled();
  if (BLOCKS.includes('b')) await blockAdmin();
  if (BLOCKS.includes('dep')) await blockDependsOnIgnored();
  if (BLOCKS.includes('race')) await blockRace();
  if (BLOCKS.includes('ref')) await blockRefusals();
  // R256 supports PostgreSQL 16 and 18 only (its fingerprint majors; it refuses 17 at boot): no R256 database exists on 17.
  if (BLOCKS.includes('r256') && R256 && MAJOR === '17') {
    note('block r256 not run on PostgreSQL 17: R256 refuses 17 at boot, so no R256 database on 17 exists to upgrade');
    results.push({ id: 'S7', owner: '7', title: 'not applicable on 17: R256 never ran on PostgreSQL 17', status: 'N/A', checks: [], notes: [] });
  } else if (BLOCKS.includes('r256') && R256) await blockR256();
  if (BLOCKS.includes('pg15') && PG15_IMAGE) await blockPg15();
  if (BLOCKS.includes('lock')) await blockServerLock();
  stopSampler();
  note(`peak of this run's running containers: ${peak.count} at ${peak.at} (${peak.names.join(', ')})`);
  writeResults();
  const summary = [
    `# DB-SETUP real-container tests (the Twenty way, owner decision 2026-11-18), PostgreSQL ${MAJOR}`,
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
