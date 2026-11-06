#!/usr/bin/env node
'use strict';
/**
 * Owner-login deployment gate: the compose and env-file contract of the ONE-LOGIN deployment (owner decision 2026-11-04:
 * one schema-owning login, crewflow_owner, for the API and the Worker; no mode switch). O3 (owner decisions C1-C5,
 * 2026-11-05, "EXACTLY LIKE TWENTY"): no release step; the API migrates on start, the Worker never migrates.
 *
 *   node packages/rab-docker/scripts/compose-owner-login.cjs            # full: docker-compose.image.yml + every override
 *   node packages/rab-docker/scripts/compose-owner-login.cjs --static   # templates + the bundled-database override only
 *   node packages/rab-docker/scripts/compose-owner-login.cjs --lint-env-file <database|runtime|compose> <path>
 *
 * FULL mode renders, with `docker compose --env-file <throw-away> --project-directory <throw-away> config --format json`,
 *   docker-compose.image.yml [+ docker-compose.local-db.yml]
 *   docker-compose.image.yml + staging/docker-compose.staging.yml
 * from sentinel env files only (no real .env, compose.env or secret of this machine is read; CREWFLOW_* / COMPOSE_* are
 * removed from the child environment because they would win over --env-file), and asserts on each rendered model:
 *   - ONE database credential: PG_DATABASE_URL present and byte-identical on rab-api and rab-worker (both
 *     read the one shared database.env), and no service carries any other database URL — no migrator, provisioner,
 *     worker, ops, replica, posture, drift or test URL, no legacy DATABASE_URL* name, no libpq PG* variable, no postgres://
 *     value under another key; no CREWFLOW_DB_MODE (there is no mode switch); nothing from a separated-mode env file
 *     (.env.migrate / .env.ops / per-service staging files) reaches any service;
 *   - CREWFLOW_MIGRATION_APPROVED is never set by a compose or env file (a one-run `run -e` only), and no role password or
 *     command/ops authority reaches any service; CREWFLOW_UPGRADE_INCOMPLETE (api-prestart.sh's own flag) is never set;
 *   - the H1-H6 hardening on every service: image by digest and no `build:`, non-root numeric user, read_only, cap_drop ALL
 *     and no cap_add, no-new-privileges, pids/memory/CPU limits, health checks, a stop window, bounded logs, no privileged /
 *     host namespaces / Docker socket, read-only binds, only rab-api publishes and only on loopback;
 *   - the lifecycle (O3): NO rab-migrate; the API migrates on start (CREWFLOW_MIGRATE_ON_START=true, approval mode
 *     ${CREWFLOW_MIGRATION_APPROVAL_MODE:-none} from compose.env, rendering only as none or token (BC-11/C4), a
 *     fresh-install start_period, registers the job schedulers), exactly ONE instance and never a
 *     start-first update (C5: stop-then-start); the deprecated CREWFLOW_UPGRADE_FAILURE_POLICY is not committed (C3:
 *     continue by default). The deployment identity stays an OPT-IN of database.env, never committed. The Worker never
 *     migrates (DISABLE_DB_MIGRATIONS=true), only consumes the schedulers (DISABLE_CRON_JOBS_REGISTRATION=true), does not
 *     wait for the schema itself (CREWFLOW_WORKER_SCHEMA_WAIT_SECONDS=0), starts after a healthy API and Redis, runs
 *     main.js as 1000:1000 with tmpfs and a jobs-only health check, stop grace >= 45 s; WORKER_SCHEDULER is never
 *     committed (production defaults to bullmq); Redis AOF + noeviction + ACL, never published;
 *   - notification delivery (owner decision 2026-11-06): WORKER_FAST_PUBLISH_NOTIFY=true and
 *     WORKER_EMAIL_DISPATCH_INTERVAL_SECONDS=30 committed, byte-identical, on rab-api AND rab-worker (the API registers the
 *     email scheduler with its own value; notify() runs in both processes), and never re-entered in an env file;
 *   - the Phase D switches (owner decision 2026-11-06): timer triggers on for all four kinds and the safety-sweep
 *     intervals (offer expiry 300 s, manager confirmation 120 s, late clock-in 300 s), committed, byte-identical, on rab-api
 *     AND rab-worker, never re-entered in an env file; the shift monitor keeps its 300 s and the combined shift scan stays
 *     off (neither may be changed by an env file);
 *   - the bundled PostgreSQL: Agent 1's fresh-install SQL mounted as the ONLY init file (never the transition script), the
 *     superuser is not the app login and has no clear-text password variable, TLS on, the reviewed pg_hba, internal
 *     network only, and the app services wait for it.
 * STATIC mode (used until the in-place compose edits can land, i.e. until #61/#62 merge) lints the committed templates and
 * renders docker-compose.image.yml + docker-compose.local-db.yml, checking only the bundled-database rules, which do not
 * depend on the image compose's shape.
 * Prints service names, variable NAMES and check results only, never a value.
 * Exit 0 = all checks passed, 1 = a check failed, 2 = usage error or docker compose unavailable.
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DOCKER_DIR = path.resolve(__dirname, '..');
const FILES = Object.freeze({
  image: path.join(DOCKER_DIR, 'docker-compose.image.yml'),
  localDb: path.join(DOCKER_DIR, 'docker-compose.local-db.yml'),
  staging: path.join(DOCKER_DIR, 'staging/docker-compose.staging.yml'),
});
const TEMPLATES = Object.freeze({
  database: path.join(DOCKER_DIR, 'env/database.env.example'),
  runtime: path.join(DOCKER_DIR, 'env/runtime.env.example'),
  compose: path.join(DOCKER_DIR, 'env/compose.env.example'),
});
// O3: one lifecycle (the API migrates on start); docker-compose.migrate-on-start.yml is folded into the image compose.
const COMBOS = Object.freeze([
  { name: 'default', files: ['image'], localDb: false, staging: false },
  { name: 'local-db', files: ['image', 'localDb'], localDb: true, staging: false },
  { name: 'staging', files: ['image', 'staging'], localDb: false, staging: true },
]);
const STATIC_COMBO = Object.freeze({ name: 'static:image+local-db', files: ['image', 'localDb'], localDb: true });

/** Agent 1's fresh-install provider-admin SQL; the transition script must never be an init script. */
const INIT_SQL = 'postgres-init/owner-login/01-crewflow-owner.sql';
const OWNER_LOGIN = 'crewflow_owner';
const MIN_FRESH_INSTALL_START_PERIOD_S = 600;
const MIN_WORKER_STOP_GRACE_S = 45;
const MIN_API_STOP_GRACE_S = 30;

// Synthetic markers the check plants (not credentials).
const SENTINEL_OWNER_PW = 'SENTINEL-OWNER-LOGIN-PW-5b8e31'; // gitleaks:allow
const SENTINEL_URL = `postgresql://${OWNER_LOGIN}:${SENTINEL_OWNER_PW}@db-direct.example:5432/crewflow?sslmode=verify-full`;
const SENTINEL_APP_SECRET = 'SENTINEL-OWNER-LOGIN-APP-SECRET-9d04aa'; // gitleaks:allow
const SENTINEL_REDIS_PW = 'SENTINEL-OWNER-LOGIN-REDIS-PW-41c7f2'; // gitleaks:allow
const SENTINEL_LEGACY_PW = 'SENTINEL-LEGACY-SEPARATED-PW-77aa10'; // gitleaks:allow

/** Names no service and no env file may carry (exact). */
const FORBIDDEN_NAMES = Object.freeze([
  'DATABASE_URL', 'DATABASE_URL_UNPOOLED', 'DATABASE_DIRECT_URL', 'DB_POOL_MAX', 'CREWFLOW_DB_MODE',
  'CREWFLOW_PROVISIONER_DATABASE_URL', 'CREWFLOW_MIGRATION_DATABASE_URL', 'CREWFLOW_PRESTART_MIGRATION_DATABASE_URL',
  'PG_WORKER_DATABASE_URL', 'PG_OPS_APP_DATABASE_URL', 'POSTURE_DATABASE_URL', 'DRIFT_DATABASE_URL', 'BENCH_DATABASE_URL',
  'CREWFLOW_MIGRATION_APPROVED', 'CREWFLOW_MIGRATION_PHASE', 'CREWFLOW_MIGRATOR_PASSWORD',
  'CREWFLOW_DEPLOYMENT_IDENTITY_BOOTSTRAP', 'ALLOW_PRODUCTION_DB_COMMANDS', 'DB_TARGET', 'ALLOW_REMOTE_TEST_DATABASE',
  'NODE_OPTIONS', 'CREWFLOW_PROVISIONER_ENABLED', 'WORKER_CLAIM_MODE', 'WORKER_DISPATCH_MODE',
  'WORKER_INVITE_AUTO_DELETE_ENABLED', 'WORKSPACE_SUBDOMAIN_ORIGIN_TRUST_ENABLED', 'PGCONNECT_TIMEOUT',
  'CREWFLOW_UPGRADE_INCOMPLETE', 'CREWFLOW_UPGRADE_FAILURE_POLICY',
]);
/** [pattern, reason] for whole families of forbidden names. */
const FORBIDDEN_PATTERNS = Object.freeze([
  [/^PG[A-Z]+$/, 'a libpq variable (overrides parts of the connection outside the one URL)'],
  [/REPLICA/, 'a read-replica setting (there is exactly one database URL)'],
  [/DATABASE_URL$/, 'a second database URL (there is exactly one: PG_DATABASE_URL)'],
  [/^TEST_/, 'a test-only variable'],
  [/^(CREWFLOW_OPS_|PG_OPS_)/, 'ops-container authority (no ops credential in the owner-login deployment)'],
  [/^CREWFLOW_.*BOOTSTRAP_PASSWORD$/, 'a role password (role passwords never belong in app config)'],
  [/^BOOTSTRAP_ADMIN_/, 'bootstrap-admin input (a one-off operator command, never a runtime variable)'],
  [/^AUTH_.*_ISSUER_URL$/, 'a test-only issuer override'],
]);
const URL_KEY = 'PG_DATABASE_URL';
/** Keys the compose files commit; an env file must not re-enter them. */
const COMMITTED_KEYS = Object.freeze([
  'NODE_ENV', 'RAB_RUNTIME_ENV', 'CREWFLOW_MIGRATE_ON_START', 'DISABLE_DB_MIGRATIONS',
  'DISABLE_CRON_JOBS_REGISTRATION', 'CREWFLOW_WORKER_SCHEMA_WAIT_SECONDS', 'CREWFLOW_RUNTIME_ISOLATION', 'AI_ENABLED',
  'HWS_RUNTIME_ENABLED', 'STORAGE_DRIVER', 'STORAGE_KEY_PREFIX', 'S3_FORCE_PATH_STYLE', 'S3_SERVER_SIDE_ENCRYPTION',
  'WORKER_SCHEDULER', 'HOME', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'CREWFLOW_INSTANCE_HEALTH_FILE',
  'WORKER_FAST_PUBLISH_NOTIFY', 'WORKER_EMAIL_DISPATCH_INTERVAL_SECONDS',
  'WORKER_TIMER_TRIGGERS', 'WORKER_TIMER_TRIGGER_KINDS', 'WORKER_OFFER_EXPIRY_INTERVAL_SECONDS',
  'WORKER_MANAGER_CONFIRMATION_TIMEOUT_INTERVAL_SECONDS', 'WORKER_LATE_CLOCK_IN_INTERVAL_SECONDS',
]);
/**
 * Notification delivery (owner decision 2026-11-06), committed on rab-api AND rab-worker with exactly these rendered values:
 *  - WORKER_FAST_PUBLISH_NOTIFY=true: notify()'s email (and, once PUSH_ENABLED=true, push) rows are published right after
 *    the transaction commits (NotifyFastPublishService); the dispatcher stays the safety net. Read wherever notify() runs,
 *    so both processes.
 *  - WORKER_EMAIL_DISPATCH_INTERVAL_SECONDS=30 (code default 2, bounds 1-60): the API's register-schedulers step sets the
 *    BullMQ scheduler's `every` from ITS value; the consume-only Worker's read-only verify checks only that the scheduler
 *    exists, never its interval, so a different Worker value would go unnoticed. Hence one value, identical on both.
 * The code defaults (false / 2 s) stay for development and tests. Push and realtime sweeps are not committed (2 s default).
 * compose-owner-login.test.cjs re-reads the TypeScript source and fails when 30 leaves the code's bounds.
 */
const NOTIFICATION_DELIVERY = Object.freeze({ WORKER_FAST_PUBLISH_NOTIFY: 'true', WORKER_EMAIL_DISPATCH_INTERVAL_SECONDS: '30' });
/**
 * Phase D switches (owner decision 2026-11-06), committed on rab-api AND rab-worker with exactly these rendered values:
 *  - WORKER_TIMER_TRIGGERS=on with all four kinds LISTED (offer-expiry, manager-confirmation, no-show, late-clock-in), so a
 *    kind added to the code later is never switched on by an unset list. The API arms the offer triggers and the Worker
 *    consumes them and arms no-show / late clock-in, so both carry the same values. No-show and late clock-in touch
 *    attendance and payroll: the owner decided them explicitly (THREAT-MODEL, evidence: the 336-decision shadow run).
 *  - the scans stay as safety sweeps: offer expiry 300 s (code default 60, bounds 10-300), manager confirmation 120 s
 *    (60, 10-300), late clock-in 300 s (120, 30-600). As for the email sweep, the API registers each BullMQ scheduler
 *    with ITS value and the consume-only Worker never compares intervals, hence one value, identical on both.
 * compose-owner-login.test.cjs re-reads the TypeScript source and fails when a value leaves the code's bounds or kinds.
 */
const PHASE_D_SWITCHES = Object.freeze({
  WORKER_TIMER_TRIGGERS: 'on',
  WORKER_TIMER_TRIGGER_KINDS: 'offer-expiry,manager-confirmation,no-show,late-clock-in',
  WORKER_OFFER_EXPIRY_INTERVAL_SECONDS: '300',
  WORKER_MANAGER_CONFIRMATION_TIMEOUT_INTERVAL_SECONDS: '120',
  WORKER_LATE_CLOCK_IN_INTERVAL_SECONDS: '300',
});
/**
 * Owner decision 2026-11-06: values that stay at the code default in production. They are not committed; neither the
 * compose files nor an env file may set them to anything else. The shift monitor (300 s) also sends the clock-in reminders
 * and arms the no-show / late clock-in triggers; the combined shift scan (D-Q4a) stays off until it is measured.
 */
const PHASE_D_UNCHANGED = Object.freeze({ WORKER_SHIFT_MONITOR_INTERVAL_SECONDS: '300', WORKER_SHIFT_SCAN_MODE: 'separate' });
const DATABASE_ALLOWED = Object.freeze([
  URL_KEY, 'PG_SSL_CA_CERT_PATH', 'PG_EXPECTED_DATABASE_NAME', 'CREWFLOW_DEPLOYMENT_ENVIRONMENT', 'CREWFLOW_DEPLOYMENT_ID',
]);
/**
 * BC-11 opt-ins: database.env only (so rab-api and rab-worker see one value), never committed in compose. O3: the approval
 * mode is no longer one of them (below).
 */
const DATABASE_OPT_INS = Object.freeze(['CREWFLOW_DEPLOYMENT_ENVIRONMENT', 'CREWFLOW_DEPLOYMENT_ID']);
/**
 * O3 + BC-11/C4: the approval mode is an INTERPOLATION value of compose.env (none by default, token an opt-in), committed on
 * rab-api as exactly this expression. In database.env / runtime.env it would be silently overridden by that line.
 */
const APPROVAL_MODE_KEY = 'CREWFLOW_MIGRATION_APPROVAL_MODE';
const APPROVAL_MODE_EXPR = '${CREWFLOW_MIGRATION_APPROVAL_MODE:-none}';
const APPROVAL_MODES = Object.freeze(['none', 'token']);
/**
 * BC-07: the external security audit sink, required in production by security-audit-sink.ts (securityAuditSinkConfig).
 * The values are the code's own: CREWFLOW_AUDIT_SINK none | stdout | file, of which production accepts only stdout;
 * CREWFLOW_AUDIT_SINK_FAILURE refuse | log, of which production accepts only refuse (unset = refuse);
 * CREWFLOW_AUDIT_SINK_FILE only with file (development). compose-owner-login.test.cjs re-reads the TypeScript source and
 * fails when these lists drift from it. It lives in runtime.env (rab-api and rab-worker both start the sink), never
 * committed in a compose file: the operator chooses it explicitly.
 */
const AUDIT_SINK_KEY = 'CREWFLOW_AUDIT_SINK';
const AUDIT_SINK_MODES = Object.freeze(['none', 'stdout', 'file']);
const AUDIT_SINK_PRODUCTION_MODES = Object.freeze(['stdout']);
const AUDIT_SINK_FAILURES = Object.freeze(['refuse', 'log']);
const AUDIT_SINK_PRODUCTION_FAILURES = Object.freeze(['refuse']);
/** O3 C3: what runtime.env may set for the upgrade-failure policy (unset = continue). */
const UPGRADE_FAILURE_VALUES = Object.freeze(['continue', 'refuse']);
/** Provider admin logins and the former separated runtime logins: never the app login (M0 section 3.5). */
const NOT_THE_APP_LOGIN = Object.freeze([
  'postgres', 'neondb_owner', 'doadmin', 'cloudsqlsuperuser', 'azure_pg_admin', 'azuresu', 'rdsadmin', 'supabase_admin',
  'crewflow', 'crewflow_app', 'crewflow_worker', 'crewflow_migrator', 'rab_owner', 'rab_secure_owner', 'rab_app',
]);
const POOLER_HINTS = Object.freeze([[/-pooler\./i, 'Neon -pooler host'], [/:6543(\/|$)/, 'port 6543 (Supabase pooler)'],
  [/:25061(\/|$)/, 'port 25061 (DigitalOcean pool)'], [/:6432(\/|$)/, 'port 6432 (PgBouncer)'], [/\.proxy-[a-z0-9]+\.rds\.amazonaws\.com/i, 'RDS Proxy']]);
const DIGEST_REF = /^[^@\s]+@sha256:[0-9a-f]{64}$/;

/** First reason a NAME is forbidden for any service or env file, or null. */
function forbiddenReason(name) {
  if (name === URL_KEY) return null;
  if (name === 'CREWFLOW_MIGRATION_APPROVED') return 'the approval token (O3: approval mode none; there is no token to pass)';
  if (name === 'CREWFLOW_UPGRADE_INCOMPLETE') return 'set only by api-prestart.sh after a failed upgrade (an inherited value is refused at start)';
  if (name === 'CREWFLOW_UPGRADE_FAILURE_POLICY') return 'deprecated (O3 C3): use CREWFLOW_UPGRADE_FAILURE=continue|refuse in runtime.env, or leave it unset (continue)';
  if (name === 'CREWFLOW_DB_MODE') return 'there is no mode switch (the owner login is the only architecture)';
  if (FORBIDDEN_NAMES.includes(name)) return 'forbidden (migration/bootstrap/ops/command authority, a second database identity, or an unapproved switch)';
  for (const [pattern, why] of FORBIDDEN_PATTERNS) if (pattern.test(name)) return why;
  return null;
}

const isPgUrl = (v) => /postgres(ql)?:\/\//i.test(String(v ?? ''));

/** Seconds from a compose duration ("45s", "15m0s", "1h2m3s", "1m30.5s"); NaN when unparseable. */
function durationSeconds(value) {
  if (value === undefined || value === null) return NaN;
  if (typeof value === 'number') return value / 1e9;
  const text = String(value).trim();
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/.exec(text);
  if (!m || text === '') return NaN;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

// ------------------------------------------------------------------------------------------------- rendered-model checks

/** Generic H1-H6 hardening of one service. */
function hardeningProblems(name, s, p, { longRunning }) {
  if ('build' in s) p(`${name}: has a build section (images by digest only; a host must never rebuild a release)`);
  if (!DIGEST_REF.test(String(s.image ?? ''))) p(`${name}: image is not pinned by digest (repository@sha256:<64 hex>)`);
  const user = String(s.user ?? '');
  const uid = user.split(':')[0];
  if (!user) p(`${name}: no explicit user (the image default may be root)`);
  else if (uid === '0' || !/^\d+$/.test(uid)) p(`${name}: user "${user}" is root or not numeric`);
  if (s.read_only !== true) p(`${name}: read_only root filesystem is not set`);
  if (!(Array.isArray(s.cap_drop) && s.cap_drop.includes('ALL'))) p(`${name}: cap_drop ALL is missing`);
  if (Array.isArray(s.cap_add) && s.cap_add.length) p(`${name}: adds capabilities (${s.cap_add.join(', ')})`);
  if (!(Array.isArray(s.security_opt) && s.security_opt.includes('no-new-privileges:true'))) p(`${name}: security_opt no-new-privileges:true is missing`);
  if (s.privileged === true) p(`${name}: privileged`);
  for (const ns of ['network_mode', 'pid', 'ipc', 'userns_mode', 'uts', 'cgroup']) if (String(s[ns] ?? '').startsWith('host')) p(`${name}: ${ns} is host`);
  if (Array.isArray(s.devices) && s.devices.length) p(`${name}: maps host devices`);
  if (!(Number(s.pids_limit) > 0)) p(`${name}: pids_limit is missing`);
  if (!(Number(s.mem_limit) > 0)) p(`${name}: mem_limit is missing`);
  if (!(Number(s.cpus) > 0)) p(`${name}: cpus limit is missing`);
  if (s.logging?.driver !== 'json-file' || !s.logging?.options?.['max-size']) p(`${name}: logging is not bounded (json-file with max-size)`);
  if (!(durationSeconds(s.stop_grace_period) > 0)) p(`${name}: stop_grace_period is missing`);
  for (const v of s.volumes ?? []) {
    if (/docker\.sock/.test(String(v.source ?? '')) || /docker\.sock/.test(String(v.target ?? ''))) p(`${name}: mounts the Docker socket`);
    if (v.type === 'bind' && v.read_only !== true) p(`${name}: bind mount to ${v.target} is writable (host binds must be read-only)`);
    if (v.type === 'volume' && !((name === 'rab-redis' && v.target === '/data') || (name === 'rab-postgres' && v.target === '/var/lib/postgresql/data'))) {
      p(`${name}: unexpected named volume at ${v.target}`);
    }
  }
  for (const port of s.ports ?? []) {
    if (name !== 'rab-api') p(`${name}: publishes a port (only rab-api may, on loopback)`);
    const hostIp = String(port.host_ip ?? '');
    if (hostIp === '' || hostIp === '0.0.0.0' || hostIp === '::') p(`${name}: port ${port.target} is published on every interface`);
  }
  if (longRunning) {
    if (s.restart !== 'unless-stopped') p(`${name}: restart is "${s.restart}", expected unless-stopped`);
    const hc = s.healthcheck;
    if (!hc || hc.disable === true || !Array.isArray(hc.test) || hc.test.length === 0 || hc.test[0] === 'NONE') p(`${name}: no health check`);
  }
}

/** Bundled-database rules (independent of the image compose's shape). */
function localDbProblems(services, model, p) {
  const pg = services['rab-postgres'];
  if (!pg) { p('rab-postgres: missing'); return; }
  hardeningProblems('rab-postgres', pg, p, { longRunning: true });
  const pgEnv = pg.environment ?? {};
  const superuser = String(pgEnv.POSTGRES_USER ?? 'postgres');
  if (superuser === OWNER_LOGIN) p('rab-postgres: the superuser is the app login (crewflow_owner must never be a superuser)');
  if ('POSTGRES_PASSWORD' in pgEnv) p('rab-postgres: POSTGRES_PASSWORD in the environment (use POSTGRES_PASSWORD_FILE)');
  if (!pgEnv.POSTGRES_PASSWORD_FILE) p('rab-postgres: POSTGRES_PASSWORD_FILE is missing');
  if (String(pgEnv.POSTGRES_HOST_AUTH_METHOD ?? '').toLowerCase() === 'trust') p('rab-postgres: POSTGRES_HOST_AUTH_METHOD=trust');
  if (URL_KEY in pgEnv) p(`rab-postgres: has ${URL_KEY}`);
  for (const [k, v] of Object.entries(pgEnv)) {
    if (k !== URL_KEY && forbiddenReason(k)) p(`rab-postgres: environment has ${k}`);
    else if (k !== URL_KEY && isPgUrl(v)) p(`rab-postgres: ${k} holds a PostgreSQL URL`);
  }
  const pc = (pg.command ?? []).map(String);
  if (!pc.includes('ssl=on')) p('rab-postgres: TLS is not on (verify-full clients need it)');
  if (!pc.some((t) => t.startsWith('hba_file='))) p('rab-postgres: the reviewed pg_hba.conf is not used');
  const sourceOf = (v) => String(v.source ?? '').split('\\').join('/');
  const initMounts = (pg.volumes ?? []).filter((v) => String(v.target ?? '').startsWith('/docker-entrypoint-initdb.d'));
  if (initMounts.length !== 1 || !sourceOf(initMounts[0]).endsWith(INIT_SQL) || initMounts[0].target === '/docker-entrypoint-initdb.d' || initMounts[0].read_only !== true) {
    p(`rab-postgres: the init must be exactly ONE read-only file, ${INIT_SQL} (never the directory, never the transition script)`);
  }
  if ((pg.volumes ?? []).some((v) => /transition-from-separated/.test(sourceOf(v)))) p('rab-postgres: mounts the transition script');
  if (JSON.stringify(Object.keys(pg.networks ?? {})) !== JSON.stringify(['crewflow-db'])) p('rab-postgres: must be on the internal crewflow-db network only');
  if (model?.networks?.['crewflow-db']?.internal !== true) p('network crewflow-db is not internal');
  for (const name of ['rab-api', 'rab-worker']) {
    if (!services[name]) continue;
    if (services[name].depends_on?.['rab-postgres']?.condition !== 'service_healthy') p(`${name}: does not wait for a healthy rab-postgres`);
    if (!Object.keys(services[name].networks ?? {}).includes('crewflow-db')) p(`${name}: is not on the crewflow-db network`);
    const url = services[name].environment?.[URL_KEY];
    if (typeof url === 'string') {
      let login = '';
      try { login = decodeURIComponent(new URL(url).username); } catch { /* not a URL */ }
      if (login === superuser) p(`${name}: ${URL_KEY} logs in as the bundled superuser`);
    }
  }
}

/** Problems with one rendered FULL-mode combination (an entry of COMBOS). Pure: never prints a value. */
function checkModel(model, combo) {
  const problems = [];
  const p = (msg) => problems.push(`${combo.name}: ${msg}`);
  const services = model?.services ?? {};
  const names = Object.keys(services).sort();
  // O3: no rab-migrate (the API migrates on start).
  const expected = ['rab-api', 'rab-redis', 'rab-worker', ...(combo.localDb ? ['rab-postgres'] : [])].sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) p(`services are [${names.join(', ')}], expected [${expected.join(', ')}]`);
  const appServices = ['rab-api', 'rab-worker'];

  for (const name of names) {
    if (name === 'rab-postgres') continue; // localDbProblems
    const s = services[name] ?? {};
    hardeningProblems(name, s, p, { longRunning: true });
    if (Array.isArray(s.profiles) && s.profiles.length) p(`${name}: has profiles (it would not start with the stack)`);
    const env = s.environment ?? {};
    for (const [key, value] of Object.entries(env)) {
      const why = forbiddenReason(key);
      if (why) p(`${name}: environment has ${key} (${why})`);
      if (key !== URL_KEY && isPgUrl(value)) p(`${name}: environment ${key} holds a PostgreSQL URL (a second database identity)`);
    }
    const values = Object.values(env).map(String);
    if (values.some((v) => v.includes(SENTINEL_LEGACY_PW))) p(`${name}: received a value from a separated-mode env file (.env.migrate / .env.ops / per-service staging files)`);
    if (!appServices.includes(name) && URL_KEY in env) p(`${name}: has ${URL_KEY} (only rab-api and rab-worker hold the app login)`);
    if (!['rab-api', 'rab-worker'].includes(name) && values.some((v) => v.includes(SENTINEL_APP_SECRET) || v.includes(SENTINEL_REDIS_PW))) {
      p(`${name}: received a runtime secret (only rab-api and rab-worker read runtime.env)`);
    }
    if (!appServices.includes(name) && values.some((v) => v.includes(SENTINEL_OWNER_PW))) p(`${name}: received the database credential`);
  }

  // BC-11: the deployment identity is an opt-in of database.env. The sentinel database.env sets none of it, so a value in
  // the rendered model was committed by a compose file and would override the operator's choice.
  for (const name of names) {
    const env = services[name]?.environment ?? {};
    for (const key of DATABASE_OPT_INS) if (key in env) p(`${name}: commits ${key} (an opt-in of database.env, never a compose value)`);
  }

  // ONE database credential, identical everywhere.
  const urls = new Map();
  for (const name of appServices) {
    const url = services[name]?.environment?.[URL_KEY];
    if (typeof url !== 'string' || url === '') p(`${name}: ${URL_KEY} is missing (it must come from the shared database.env)`);
    else urls.set(name, url);
  }
  if (new Set(urls.values()).size > 1) p(`${URL_KEY} differs between ${[...urls.keys()].join(', ')} (one identical credential)`);
  for (const [name, url] of urls) if (url !== SENTINEL_URL) p(`${name}: ${URL_KEY} is not the value of the shared database.env (overridden)`);

  const api = services['rab-api'] ?? {};
  const worker = services['rab-worker'] ?? {};
  const redis = services['rab-redis'] ?? {};
  const envOf = (s) => s?.environment ?? {};
  for (const name of appServices) {
    const e = envOf(services[name]);
    const want = { NODE_ENV: 'production' };
    for (const [k, v] of Object.entries(want)) if (e[k] !== v) p(`${name}: ${k} is "${e[k] ?? ''}", expected "${v}"`);
    // O3 C3: the upgrade-failure policy is not committed (unset = continue); runtime.env may opt into refuse.
    if ('CREWFLOW_UPGRADE_FAILURE' in e && !UPGRADE_FAILURE_VALUES.includes(String(e.CREWFLOW_UPGRADE_FAILURE))) p(`${name}: CREWFLOW_UPGRADE_FAILURE must be continue or refuse`);
    // O3 C2: the scheduler mode is never committed (production defaults to bullmq; interval is refused there).
    if ('WORKER_SCHEDULER' in e) p(`${name}: commits WORKER_SCHEDULER (leave it unset: production runs bullmq; interval is refused)`);
  }
  for (const name of ['rab-api', 'rab-worker']) {
    const e = envOf(services[name]);
    // The long-running services refuse to start when a declared isolation control is missing (H6 enforce).
    if (e.CREWFLOW_RUNTIME_ISOLATION !== 'enforce') p(`${name}: CREWFLOW_RUNTIME_ISOLATION is "${e.CREWFLOW_RUNTIME_ISOLATION ?? ''}", expected "enforce"`);
    if (e.RAB_RUNTIME_ENV !== 'production') p(`${name}: RAB_RUNTIME_ENV is not production`);
    if (!String(e.APP_SECRET ?? '').includes(SENTINEL_APP_SECRET)) p(`${name}: does not read runtime.env (APP_SECRET missing)`);
    // BC-07: the sink must reach both services, as a production-accepted value.
    if (!AUDIT_SINK_PRODUCTION_MODES.includes(String(e[AUDIT_SINK_KEY] ?? ''))) p(`${name}: ${AUDIT_SINK_KEY} is "${e[AUDIT_SINK_KEY] ?? ''}", expected stdout (BC-07, from runtime.env)`);
    // Owner decision 2026-11-06: notification delivery, the same committed values on both services.
    for (const [key, want] of Object.entries(NOTIFICATION_DELIVERY)) {
      if (String(e[key] ?? '') !== want) p(`${name}: ${key} is "${e[key] ?? ''}", expected "${want}" (owner decision 2026-11-06, committed on rab-api and rab-worker)`);
    }
    // Owner decision 2026-11-06: the Phase D switches, the same committed values on both services.
    for (const [key, want] of Object.entries(PHASE_D_SWITCHES)) {
      if (String(e[key] ?? '') !== want) p(`${name}: ${key} is "${e[key] ?? ''}", expected "${want}" (owner decision 2026-11-06, Phase D switches, committed on rab-api and rab-worker)`);
    }
    for (const [key, keep] of Object.entries(PHASE_D_UNCHANGED)) {
      if (key in e && String(e[key]) !== keep) p(`${name}: ${key} is "${e[key]}"; the owner decision 2026-11-06 keeps it at ${keep} (leave it unset)`);
    }
  }

  // rab-api: the lifecycle.
  const apiEnv = envOf(api);
  if (JSON.stringify(api.command) !== JSON.stringify(['./api-prestart.sh'])) p('rab-api: command is not ./api-prestart.sh');
  // O3 C1: the API migrates on start, without an approval token, with a start_period long enough for a fresh install.
  if (apiEnv.CREWFLOW_MIGRATE_ON_START !== 'true') p('rab-api: CREWFLOW_MIGRATE_ON_START must be "true" (O3: the API migrates on start)');
  if (!APPROVAL_MODES.includes(String(apiEnv[APPROVAL_MODE_KEY] ?? ''))) p(`rab-api: ${APPROVAL_MODE_KEY} must render as none or token (compose.env; default none)`);
  if (String(apiEnv.DISABLE_DB_MIGRATIONS ?? '') === 'true') p('rab-api: DISABLE_DB_MIGRATIONS=true (the API is the one process that migrates)');
  if (String(apiEnv.DISABLE_CRON_JOBS_REGISTRATION ?? '') === 'true') p('rab-api: DISABLE_CRON_JOBS_REGISTRATION=true (the API registers the job schedulers; nothing else does)');
  if (!(durationSeconds(api.healthcheck?.start_period) >= MIN_FRESH_INSTALL_START_PERIOD_S)) p(`rab-api: healthcheck start_period below ${MIN_FRESH_INSTALL_START_PERIOD_S}s (it migrates first)`);
  for (const [name, s] of Object.entries(services)) if (s.depends_on?.['rab-migrate']) p(`${name}: depends on rab-migrate (O3: there is no release step)`);
  // C5: ONE API, deployed stop-then-start (two versions starting together would race for the migration lock).
  const replicas = api.deploy?.replicas ?? api.scale;
  if (replicas !== undefined && Number(replicas) !== 1) p(`rab-api: ${replicas} replicas (O3 C5: exactly one API)`);
  if (api.deploy?.update_config?.order === 'start-first') p('rab-api: start-first update (O3 C5: stop-then-start only)');
  if (!(durationSeconds(api.stop_grace_period) >= MIN_API_STOP_GRACE_S)) p(`rab-api: stop_grace_period below ${MIN_API_STOP_GRACE_S}s`);
  if (api.depends_on?.['rab-redis']?.condition !== 'service_healthy') p('rab-api: does not wait for a healthy rab-redis');

  // rab-worker
  const workerEnv = envOf(worker);
  if (worker.user !== '1000:1000') p(`rab-worker: user is "${worker.user ?? ''}", expected 1000:1000`);
  if ((worker.command ?? []).join(' ') !== 'node packages/rab-worker/dist/main.js') p('rab-worker: command is not `node packages/rab-worker/dist/main.js` (no root launcher, no per-child credentials)');
  if (worker.working_dir !== '/app') p('rab-worker: working_dir is not /app');
  // The Worker's watchdog SIGKILLs itself when its event loop stalls; the kernel ignores that signal for PID 1, so the
  // Worker refuses to start as PID 1. Docker's init (tini) must be PID 1 whatever the image entrypoint is.
  if (worker.init !== true) p('rab-worker: init: true is missing (the Worker refuses to run as PID 1; its watchdog SIGKILL needs a real init)');
  const tmpfs = (worker.tmpfs ?? []).map(String);
  for (const dir of ['/tmp/crewflow-jobs', '/run/crewflow-health/jobs']) if (!tmpfs.some((t) => t === dir || t.startsWith(`${dir}:`))) p(`rab-worker: tmpfs ${dir} is missing`);
  if (!tmpfs.every((t) => /uid=1000/.test(t) && /gid=1000/.test(t))) p('rab-worker: a tmpfs is not owned by 1000:1000');
  if (String(workerEnv.CREWFLOW_MIGRATE_ON_START ?? 'false') !== 'false') p('rab-worker: CREWFLOW_MIGRATE_ON_START is set (the Worker never migrates)');
  if (workerEnv.DISABLE_DB_MIGRATIONS !== 'true') p('rab-worker: DISABLE_DB_MIGRATIONS must be "true" (O3 C1: the Worker never migrates)');
  if (workerEnv.DISABLE_CRON_JOBS_REGISTRATION !== 'true') p('rab-worker: DISABLE_CRON_JOBS_REGISTRATION must be "true" (O3 C2: the API registers the schedulers; the Worker consumes them)');
  if (workerEnv.CREWFLOW_WORKER_SCHEMA_WAIT_SECONDS !== '0') p('rab-worker: CREWFLOW_WORKER_SCHEMA_WAIT_SECONDS must be "0" (it starts after a healthy API)');
  if (workerEnv.CREWFLOW_INSTANCE_HEALTH_FILE !== '/run/crewflow-health/jobs/heartbeat.json') p('rab-worker: CREWFLOW_INSTANCE_HEALTH_FILE does not name the jobs heartbeat on its tmpfs');
  if (workerEnv.HOME !== '/nonexistent') p('rab-worker: HOME must be /nonexistent (H1-M1: not a writable module search root)');
  const wTest = (worker.healthcheck?.test ?? []).map(String);
  if (!wTest.some((t) => t.endsWith('worker-bundle-health.cjs'))) p('rab-worker: health check is not the per-instance heartbeat check');
  if (!wTest.includes('CREWFLOW_PROVISIONER_ENABLED=false')) p('rab-worker: health check is not jobs-only (CREWFLOW_PROVISIONER_ENABLED=false on the check command)');
  if (worker.depends_on?.['rab-api']?.condition !== 'service_healthy') p('rab-worker: does not wait for a healthy rab-api (the schema must be current first)');
  if (worker.depends_on?.['rab-redis']?.condition !== 'service_healthy') p('rab-worker: does not wait for a healthy rab-redis');
  if (!(durationSeconds(worker.stop_grace_period) >= MIN_WORKER_STOP_GRACE_S)) p(`rab-worker: stop_grace_period below ${MIN_WORKER_STOP_GRACE_S}s`);

  // rab-redis
  const rc = (redis.command ?? []).map(String);
  const pair = (flag, value) => rc.some((t, i) => t === flag && rc[i + 1] === value);
  if (!pair('--appendonly', 'yes')) p('rab-redis: --appendonly yes is missing');
  if (!pair('--maxmemory-policy', 'noeviction')) p('rab-redis: --maxmemory-policy noeviction is missing');
  if (!rc.includes('--aclfile')) p('rab-redis: --aclfile is missing (unauthenticated Redis)');
  if (!rc.includes('--maxmemory')) p('rab-redis: --maxmemory is missing');

  // O1/O2: one image for every application service.
  if (worker.image !== api.image) p('rab-worker: image differs from rab-api (O2: one image)');

  if (combo.staging) {
    if (model?.name !== 'crewflow-staging') p(`project name is "${model?.name}", expected crewflow-staging`);
    for (const n of ['rab-api', 'rab-worker']) if (envOf(services[n]).STORAGE_KEY_PREFIX !== 'staging') p(`${n}: STORAGE_KEY_PREFIX is not staging`);
  }
  if (combo.localDb) localDbProblems(services, model, p);
  return problems;
}

/** STATIC mode: only the bundled-database rules, on image + local-db as the image compose is today. */
function checkStaticModel(model) {
  const problems = [];
  localDbProblems(model?.services ?? {}, model, (msg) => problems.push(`${STATIC_COMBO.name}: ${msg}`));
  return problems;
}

// --------------------------------------------------------------------------------------------------------- env files

/** Parses KEY=VALUE lines (optional `export `). Returns [{key, value, line}]; comments and blanks skipped. */
function parseEnvText(text) {
  const out = [];
  String(text).split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) return;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!m) { out.push({ key: null, value: '', line: i + 1 }); return; }
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out.push({ key: m[1], value, line: i + 1 });
  });
  return out;
}

const isPlaceholder = (v) => /<[^>]*>/.test(v);

/**
 * Problems with one env file. kind: 'database' (database.env), 'runtime' (runtime.env) or 'compose' (compose.env).
 * `template` relaxes only the value-shape checks a <placeholder> cannot satisfy. Never includes a value.
 */
function lintEnvText(kind, text, { template = false } = {}) {
  const problems = [];
  const entries = parseEnvText(text);
  const seen = new Set();
  for (const { key, value, line } of entries) {
    if (key === null) { problems.push(`line ${line}: not a KEY=VALUE line`); continue; }
    if (seen.has(key)) problems.push(`${key}: set more than once (line ${line})`);
    seen.add(key);
    const why = forbiddenReason(key);
    if (why) problems.push(`${key}: ${why}`);
    if (COMMITTED_KEYS.includes(key)) problems.push(`${key}: committed in the compose files; never re-enter it in an env file`);
    if (kind === 'database' && !why && !DATABASE_ALLOWED.includes(key)) problems.push(`${key}: does not belong in the shared database file (only ${DATABASE_ALLOWED.join(', ')})`);
    if (kind === 'runtime' && key === URL_KEY) problems.push(`${key}: belongs in database.env only (so it is identical on every service)`);
    if (kind === 'runtime' && DATABASE_OPT_INS.includes(key)) problems.push(`${key}: belongs in database.env only (so rab-api and rab-worker see the same value)`);
    if (key === 'CREWFLOW_UPGRADE_FAILURE' && !UPGRADE_FAILURE_VALUES.includes(value)) problems.push(`${key}: must be exactly continue or refuse`);
    if (Object.hasOwn(PHASE_D_UNCHANGED, key) && value !== PHASE_D_UNCHANGED[key]) problems.push(`${key}: the owner decision 2026-11-06 keeps it at ${PHASE_D_UNCHANGED[key]} in production (leave it unset)`);
    if (/^CREWFLOW_AUDIT_SINK/.test(key) && kind !== 'runtime') problems.push(`${key}: belongs in runtime.env (rab-api and rab-worker both start the audit sink)`);
    if (kind === 'runtime' && key === AUDIT_SINK_KEY) {
      if (!AUDIT_SINK_MODES.includes(value)) problems.push(`${key}: must be exactly none, stdout or file (security-audit-sink.ts)`);
      else if (!AUDIT_SINK_PRODUCTION_MODES.includes(value)) problems.push(`${key}: production refuses ${value}; set stdout with an off-host append-only log shipper (BC-07)`);
    }
    if (kind === 'runtime' && key === 'CREWFLOW_AUDIT_SINK_FAILURE') {
      if (!AUDIT_SINK_FAILURES.includes(value)) problems.push(`${key}: must be exactly refuse or log (security-audit-sink.ts)`);
      else if (!AUDIT_SINK_PRODUCTION_FAILURES.includes(value)) problems.push(`${key}: production requires refuse (or leave it unset)`);
    }
    if (kind === 'runtime' && key === 'CREWFLOW_AUDIT_SINK_FILE') problems.push(`${key}: the file sink is development-only (production refuses CREWFLOW_AUDIT_SINK=file)`);
    if (key === APPROVAL_MODE_KEY && kind !== 'compose') problems.push(`${key}: set it in compose.env (the interpolation file): rab-api's committed ${APPROVAL_MODE_EXPR} would silently override a value here`);
    if (key === APPROVAL_MODE_KEY && kind === 'compose' && !APPROVAL_MODES.includes(value)) problems.push(`${key}: must be exactly none or token`);
    if (kind !== 'runtime' && key === 'CREWFLOW_UPGRADE_FAILURE') problems.push(`${key}: belongs in runtime.env (the API reads it)`);
    if (kind === 'compose') {
      if (!key.startsWith('CREWFLOW_')) problems.push(`${key}: compose.env holds only CREWFLOW_* interpolation values`);
      // CREWFLOW_SECRETS_DIR names a directory, not a secret.
      if (key !== 'CREWFLOW_SECRETS_DIR' && /PASSWORD|SECRET|TOKEN|APPROVED|_URL$|_KEY$/.test(key)) problems.push(`${key}: a secret-like name in the interpolation file`);
      if (/:\/\/[^/\s]*@/.test(value)) problems.push(`${key}: a URL with credentials in the interpolation file`);
      if (/_IMAGE$/.test(key) && !template && !DIGEST_REF.test(value)) problems.push(`${key}: not pinned by digest (repository@sha256:<64 hex>)`);
      if (/_IMAGE_DIGEST$/.test(key) && !template && !/^sha256:[0-9a-f]{64}$/.test(value)) problems.push(`${key}: not a sha256:<64 hex> digest`);
      // O2 (one image, one tag): the per-role image variables are retired. docker-compose.image.yml no longer reads them, so
      // one left in compose.env would be silently ignored while CREWFLOW_IMAGE_DIGEST decides what runs.
      if (/^CREWFLOW_(API|WORKER)_IMAGE_(DIGEST|REPOSITORY)$/.test(key)) problems.push(`${key}: retired (O2: one image); set CREWFLOW_IMAGE_${key.endsWith('DIGEST') ? 'DIGEST' : 'REPOSITORY'} instead`);
      if (key === 'CREWFLOW_API_BIND' && ['0.0.0.0', '::', ''].includes(value)) problems.push(`${key}: binds every interface`);
    }
    if (key !== URL_KEY && isPgUrl(value)) problems.push(`${key}: holds a PostgreSQL URL (a second database identity)`);
  }
  if (kind === 'runtime' && !entries.some((e) => e.key === AUDIT_SINK_KEY)) {
    problems.push(`${AUDIT_SINK_KEY}: missing (BC-07: production refuses to start without an external audit sink; set stdout with an off-host append-only log shipper)`);
  }
  if (kind === 'database') {
    const url = entries.find((e) => e.key === URL_KEY)?.value;
    if (!url) problems.push(`${URL_KEY}: missing`);
    else if (!(template && isPlaceholder(url))) {
      let u = null;
      try { u = new URL(url); } catch { problems.push(`${URL_KEY}: not a parseable URL`); }
      if (u) {
        const login = decodeURIComponent(u.username);
        if (!/^postgres(ql)?:$/.test(u.protocol)) problems.push(`${URL_KEY}: not a postgres:// URL`);
        if (login !== OWNER_LOGIN) {
          problems.push(NOT_THE_APP_LOGIN.includes(login)
            ? `${URL_KEY}: logs in as a provider admin or a former separated login, not ${OWNER_LOGIN}`
            : `${URL_KEY}: the login is not ${OWNER_LOGIN}`);
        }
        if (u.searchParams.get('sslmode') !== 'verify-full') problems.push(`${URL_KEY}: sslmode is not verify-full`);
        for (const [re, label] of POOLER_HINTS) if (re.test(url)) problems.push(`${URL_KEY}: points at a transaction pooler (${label}); use the DIRECT host`);
        if (u.password === '') problems.push(`${URL_KEY}: has no password`);
      }
    }
  }
  return problems;
}

/** Problems in raw compose text that rendering cannot show. */
function lintComposeText(rel, text) {
  const problems = [];
  if (/^\s*build\s*:/m.test(text)) problems.push(`${rel}: has a build: key`);
  if (/^\s*-?\s*CREWFLOW_MIGRATION_APPROVED\s*[:=]/m.test(text)) problems.push(`${rel}: sets CREWFLOW_MIGRATION_APPROVED`);
  if (/^\s*-?\s*CREWFLOW_DB_MODE\s*[:=]/m.test(text)) problems.push(`${rel}: sets CREWFLOW_DB_MODE (there is no mode switch)`);
  if (/^\s*-?\s*CREWFLOW_(DEPLOYMENT_ENVIRONMENT|DEPLOYMENT_ID)\s*:/m.test(text)) problems.push(`${rel}: commits a BC-11 opt-in (the deployment identity belongs in database.env)`);
  if (/^\s*-?\s*CREWFLOW_AUDIT_SINK\w*\s*[:=]/m.test(text)) problems.push(`${rel}: commits the audit sink (BC-07: the operator sets CREWFLOW_AUDIT_SINK in runtime.env)`);
  // The approval mode may only be the compose.env interpolation (none by default), never a literal that pins it.
  for (const m of text.matchAll(/^\s*-?\s*CREWFLOW_MIGRATION_APPROVAL_MODE\s*[:=]\s*(.*?)\s*$/gm)) {
    if (m[1] !== APPROVAL_MODE_EXPR) problems.push(`${rel}: ${APPROVAL_MODE_KEY} must be exactly ${APPROVAL_MODE_EXPR} (an opt-in of compose.env)`);
  }
  if (/^\s*privileged\s*:\s*true/m.test(text)) problems.push(`${rel}: privileged: true`);
  return problems;
}

// ------------------------------------------------------------------------------------------------------------ render

// The sentinel database.env sets NONE of the BC-11 opt-ins (approval mode, deployment identity): any of them in a rendered
// model was therefore committed by a compose file.
const DATABASE_ENV_TEXT = [
  `${URL_KEY}=${SENTINEL_URL}`, 'PG_SSL_CA_CERT_PATH=/run/crewflow/pg-ca.crt', 'PG_EXPECTED_DATABASE_NAME=crewflow', '',
].join('\n');
const RUNTIME_ENV_TEXT = [`APP_SECRET=${SENTINEL_APP_SECRET}`, `REDIS_URL=redis://crewflow:${SENTINEL_REDIS_PW}@rab-redis:6379`, 'APP_URL=https://crewflow.example', 'CREWFLOW_AUDIT_SINK=stdout', ''].join('\n');
/** Separated-mode env files a compose file must no longer read: their marker value must never reach a service. */
const LEGACY_ENV_TEXT = `PG_DATABASE_URL=postgresql://crewflow_migrator:${SENTINEL_LEGACY_PW}@db-direct.example:5432/rab?sslmode=verify-full\nLEGACY_MARKER=${SENTINEL_LEGACY_PW}\n`;

/** Renders the given combos; returns { [comboName]: model }. Throws when docker compose fails. */
function renderModels(combos = COMBOS, extraComposeEnv = []) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-owner-login-'));
  try {
    const secrets = path.join(tmp, 'secrets');
    const project = path.join(tmp, 'project');
    fs.mkdirSync(secrets);
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(secrets, 'database.env'), DATABASE_ENV_TEXT, { mode: 0o600 });
    fs.writeFileSync(path.join(secrets, 'runtime.env'), RUNTIME_ENV_TEXT, { mode: 0o600 });
    // The separated-mode env files (project-relative .env.migrate / .env.ops, per-service staging files) exist only so a
    // file that still names them renders; the gate then fails on their marker.
    for (const f of ['.env.migrate', '.env.ops']) fs.writeFileSync(path.join(project, f), LEGACY_ENV_TEXT, { mode: 0o600 });
    for (const f of ['api.env', 'worker.env', 'migrate.env']) fs.writeFileSync(path.join(secrets, f), LEGACY_ENV_TEXT, { mode: 0o600 });
    const fwd = (p) => p.split(path.sep).join('/');
    const composeEnv = path.join(tmp, 'compose.env');
    fs.writeFileSync(composeEnv, [
      `CREWFLOW_IMAGE_DIGEST=sha256:${'0'.repeat(64)}`,
      `CREWFLOW_REDIS_IMAGE=redis@sha256:${'2'.repeat(64)}`,
      `CREWFLOW_POSTGRES_IMAGE=postgres@sha256:${'3'.repeat(64)}`,
      `CREWFLOW_SECRETS_DIR=${fwd(secrets)}`,
      'CREWFLOW_PG_CA_FILE=/etc/crewflow/pg-ca.crt',
      'CREWFLOW_REDIS_CONF=/etc/crewflow/redis.conf',
      ...extraComposeEnv,
      '',
    ].join('\n'), { mode: 0o600 });
    const childEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CREWFLOW_|COMPOSE_)/i.test(k)));
    const models = {};
    for (const combo of combos) {
      // --project-directory: relative env_file / bind paths resolve in the throw-away directory, never this checkout.
      const args = ['compose', '--env-file', composeEnv, '--project-directory', project];
      for (const f of combo.files) args.push('-f', FILES[f]);
      args.push('config', '--format', 'json');
      models[combo.name] = JSON.parse(execFileSync('docker', args, { env: childEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 }));
    }
    return models;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Static checks: committed templates and the raw text of the owner-login files that exist. */
function staticProblems() {
  const problems = [];
  for (const [kind, file] of Object.entries(TEMPLATES)) {
    const rel = path.relative(DOCKER_DIR, file).split(path.sep).join('/');
    for (const msg of lintEnvText(kind, fs.readFileSync(file, 'utf8'), { template: true })) problems.push(`${rel}: ${msg}`);
  }
  for (const file of Object.values(FILES)) {
    if (!fs.existsSync(file)) continue;
    problems.push(...lintComposeText(path.relative(DOCKER_DIR, file).split(path.sep).join('/'), fs.readFileSync(file, 'utf8')));
  }
  return problems;
}

// -------------------------------------------------------------------------------------------------------------- main

function main(argv) {
  if (argv[0] === '--lint-env-file') {
    const [, kind, file] = argv;
    if (!['database', 'runtime', 'compose'].includes(kind) || !file) {
      console.error('usage: compose-owner-login.cjs --lint-env-file <database|runtime|compose> <path>');
      return 2;
    }
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { console.error(`[owner-login] cannot read ${file}`); return 2; }
    const problems = lintEnvText(kind, text);
    for (const msg of problems) console.log(`[owner-login] FAIL ${kind} env file: ${msg}`);
    console.log(`[owner-login] ${problems.length === 0 ? 'PASS' : 'FAIL'} ${kind} env file (${parseEnvText(text).length} entries; names only, no value printed)`);
    return problems.length === 0 ? 0 : 1;
  }
  const staticOnly = argv[0] === '--static';
  if (argv.length && !staticOnly) { console.error('usage: compose-owner-login.cjs [--static | --lint-env-file <kind> <path>]'); return 2; }
  let failures = 0;
  const report = (label, problems) => {
    for (const msg of problems) console.log(`[owner-login] FAIL ${msg}`);
    console.log(`[owner-login] ${problems.length === 0 ? 'PASS' : 'FAIL'} ${label}`);
    failures += problems.length;
  };
  report('templates and raw compose text', staticProblems());
  try { execFileSync('docker', ['compose', 'version'], { stdio: 'ignore' }); } catch { console.log('[owner-login] docker compose is not available (CI must have it)'); return 2; }
  const combos = staticOnly ? [STATIC_COMBO] : COMBOS;
  let models;
  try {
    models = renderModels(combos);
  } catch (error) {
    console.log(`[owner-login] FAIL docker compose config: ${String(error.stderr ?? error.message).trim().split('\n').slice(-3).join(' | ')}`);
    return 1;
  }
  for (const combo of combos) {
    const label = `${combo.name} (${combo.files.map((f) => path.relative(DOCKER_DIR, FILES[f]).split(path.sep).join('/')).join(' + ')})`;
    report(label, staticOnly ? checkStaticModel(models[combo.name]) : checkModel(models[combo.name], combo));
  }
  return failures === 0 ? 0 : 1;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = {
  FILES, TEMPLATES, COMBOS, STATIC_COMBO, INIT_SQL, NOTIFICATION_DELIVERY, PHASE_D_SWITCHES, PHASE_D_UNCHANGED, AUDIT_SINK_MODES, AUDIT_SINK_PRODUCTION_MODES, AUDIT_SINK_FAILURES,
  AUDIT_SINK_PRODUCTION_FAILURES, SENTINEL_URL, SENTINEL_OWNER_PW, SENTINEL_APP_SECRET,
  SENTINEL_REDIS_PW, SENTINEL_LEGACY_PW, forbiddenReason, durationSeconds, checkModel, checkStaticModel, parseEnvText,
  lintEnvText, lintComposeText, renderModels, staticProblems, main,
};
