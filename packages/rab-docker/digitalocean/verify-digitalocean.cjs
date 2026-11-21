#!/usr/bin/env node
'use strict';
/**
 * DigitalOcean deployment shape gate (owner decisions 24, 25, 26 and 53, accepted 2026-11-21).
 *
 *   node packages/rab-docker/digitalocean/verify-digitalocean.cjs
 *       templates + the committed shape: lints the DigitalOcean templates (filled with sentinels, through this file's
 *       DigitalOcean rules AND compose-owner-login.cjs's generic env-file lint) and renders
 *       docker-compose.image.yml + digitalocean/docker-compose.digitalocean.yml with `docker compose config`, then checks it.
 *   node packages/rab-docker/digitalocean/verify-digitalocean.cjs --environment --env-file /etc/crewflow/compose.env
 *       the same model check on the server's REAL compose.env (env files not resolved), plus its compose.env lint.
 *   node packages/rab-docker/digitalocean/verify-digitalocean.cjs --lint-env-file <compose|database|runtime> <path>
 *   node packages/rab-docker/digitalocean/verify-digitalocean.cjs --lint-acl <path>      the real redis-users.acl
 *   node packages/rab-docker/digitalocean/verify-digitalocean.cjs --lint-caddyfile <path> the real /etc/caddy/Caddyfile
 *   --environment also lints ${CREWFLOW_SECRETS_DIR}/database.env, runtime.env and redis-users.acl (and, with
 *   --caddyfile <path>, the Caddyfile and its trust pool), so one command checks every file the server uses.
 *
 * What it enforces on top of the generic gates (which keep running on this combination: compose-owner-login.cjs COMBOS
 * `digitalocean`, compose-one-image.cjs DEPLOY_COMBOS):
 *   - decision 24 a, Managed PostgreSQL: the bundled db off (CREWFLOW_BUNDLED_DB=0 AND 0 replicas), PG_ADMIN_URL on a
 *     *.db.ondigitalocean.com host, the DIRECT port 25060 (never the pool port 25061), sslmode=verify-full only (the generic
 *     gate also accepts require / verify-ca), the crewflow_owner URL on the same host, port and database, the cluster CA
 *     mounted (CREWFLOW_PG_CA_FILE) and named in database.env (PG_SSL_CA_CERT_PATH=/run/crewflow/pg-ca.crt);
 *   - decision 25.1, the full compose file: every service keeps the keys OpenShip drops (user non-root, read_only, cap_drop
 *     ALL without cap_add, no-new-privileges, pids/memory/CPU limits, tmpfs where declared, env_file, the depends_on
 *     conditions), bounded logs, nothing privileged, only rab-api publishes and only on 127.0.0.1;
 *   - decision 25.2: CREWFLOW_RUNTIME_ISOLATION=enforce on rab-api and rab-worker;
 *   - decision 25.3, Redis with a password: --aclfile mounted read-only; the ACL file's `default` user ON with a SHA-256
 *     password and the app user's command set (a `default` user with no command permissions loses BullMQ data replayed
 *     from the AOF on Redis 7.4: DOCKER_SECURITY_AND_CLEANUP_REPORT 2026-11-02 §3.5), `crewflow` with its own SHA-256
 *     password, no clear-text password, `nopass` only on the PING-only health-check user; REDIS_URL with a user and password;
 *   - decision 25.4 / the edge: the default network's fixed subnet and TRUSTED_PROXY_CIDRS exactly its gateway; the
 *     Caddyfile with per-hostname Authenticated Origin Pulls (require_and_verify against OUR client CA, never Cloudflare's
 *     shared origin-pull CA) and strict_sni_host on; every database URL query key at most once;
 *   - the M9 load test: the connection budget of runtime.env fits the 2 GiB plan's 47 connections (one API, one Worker);
 *   - AI stays off (AI_ENABLED unset or false).
 * Prints names and reasons only, never a value. Exit 0 = pass, 1 = a check failed, 2 = usage / docker compose unavailable.
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseEnvText, lintEnvText } = require('../scripts/compose-owner-login.cjs');

const DOCKER_DIR = path.resolve(__dirname, '..');
const IMAGE_FILE = path.join(DOCKER_DIR, 'docker-compose.image.yml');
const DO_FILE = path.join(__dirname, 'docker-compose.digitalocean.yml');
const TEMPLATES = Object.freeze({
  compose: path.join(__dirname, 'env/compose.env.example'),
  database: path.join(__dirname, 'env/database.env.example'),
  runtime: path.join(__dirname, 'env/runtime.env.digitalocean.example'),
  acl: path.join(__dirname, 'env/redis-users.acl.example'),
  caddyfile: path.join(__dirname, 'edge/Caddyfile.example'),
  genericRuntime: path.join(DOCKER_DIR, 'env/runtime.env.example'),
});

const PROJECT_NAME = 'rab-production';
const SERVICES = Object.freeze(['db', 'db-harden', 'db-setup', 'rab-api', 'rab-redis', 'rab-worker']);
const APP_SERVICES = Object.freeze(['rab-api', 'rab-worker']);
const ADMIN_SERVICES = Object.freeze(['db-setup', 'db-harden']);
const EDGE_SUBNET = '172.16.30.0/24';
const EDGE_GATEWAY = '172.16.30.1';
const TRUSTED_PROXY = `${EDGE_GATEWAY}/32`;
const DO_HOST_SUFFIX = '.db.ondigitalocean.com';
const DO_DIRECT_PORT = '25060';
const DO_POOL_PORT = '25061';
const PG_CA_TARGET = '/run/crewflow/pg-ca.crt';
const ACL_TARGET = '/run/secrets/redis-users.acl';
/** DigitalOcean Managed PostgreSQL, 2 GiB plan: 47 usable connections (docs.digitalocean.com .../postgresql/details/limits/). */
const DO_PLAN_CONNECTIONS = 47;
/**
 * The connection budget of connection-budget.ts (planConnectionBudget), per instance, for the owner login in poll mode.
 * Kept in step with packages/rab-server/src/database/runtime/connection-budget.ts (WORKER_DIRECT_POOL_MAX_BUDGET 6, scan +
 * storage locks 2, provisioner 2, API /healthz probe 1, BOOT_PROBE_ALLOWANCE 3, defaults 10 / 12 / 5); the test file reads
 * those constants from the TypeScript source and fails if they drift.
 */
const BUDGET = Object.freeze({ workerDirect: 6, workerLocks: 2, workerProvisioner: 2, apiHealthProbe: 1, bootProbes: 3, apiPoolDefault: 10, workerPoolDefault: 12, migrateDefault: 5 });
/** The Worker pool committed in docker-compose.image.yml (the compose value wins over runtime.env on rab-worker). */
const WORKER_POOL_COMMITTED = 12;

// ------------------------------------------------------------------------------------------------------------ helpers

const envMap = (text) => {
  const out = new Map();
  for (const e of parseEnvText(text)) if (e.key) out.set(e.key, e.value);
  return out;
};
const envOf = (s) => (Array.isArray(s?.environment)
  ? Object.fromEntries(s.environment.map((e) => [String(e).split('=')[0], String(e).split('=').slice(1).join('=')]))
  : s?.environment ?? {});
const parseUrl = (value) => {
  try {
    return new URL(String(value));
  } catch {
    return null;
  }
};
const isPlaceholder = (v) => /<[^>]*>/.test(String(v ?? ''));

// -------------------------------------------------------------------------------------------------------- model check

/** Problems with a rendered model (`docker compose config --format json`) of image.yml + the DigitalOcean override. */
function checkModel(model, { expectAdminUrl = null } = {}) {
  const problems = [];
  const p = (msg) => problems.push(msg);
  const services = model?.services ?? {};
  const names = Object.keys(services).sort();
  if (JSON.stringify(names) !== JSON.stringify([...SERVICES])) p(`services are [${names.join(', ')}], expected [${SERVICES.join(', ')}]`);
  if (model?.name !== PROJECT_NAME) p(`project name is not ${PROJECT_NAME}`);

  // Decision 24 a: the managed cluster, never the bundled db.
  if (services.db && Number(services.db.deploy?.replicas) !== 0) p('db: the bundled database must have 0 replicas on DigitalOcean (Managed PostgreSQL, decision 24 a)');
  for (const name of ADMIN_SERVICES) {
    if (services[name] && envOf(services[name]).CREWFLOW_BUNDLED_DB !== '0') p(`${name}: CREWFLOW_BUNDLED_DB must render 0 (compose.env CREWFLOW_BUNDLED_DB=0)`);
  }

  // Decision 25.1: every key OpenShip drops, on every service that runs.
  for (const name of names) {
    const s = services[name] ?? {};
    const user = String(s.user ?? '');
    if (!/^[1-9][0-9]*(:[0-9]+)?$/.test(user)) p(`${name}: user must be a non-root numeric uid (got ${user ? 'a root or named user' : 'none'})`);
    if (s.read_only !== true) p(`${name}: read_only must be true`);
    if (!(Array.isArray(s.cap_drop) && s.cap_drop.map(String).map((c) => c.toUpperCase()).includes('ALL'))) p(`${name}: cap_drop must include ALL`);
    if (Array.isArray(s.cap_add) && s.cap_add.length) p(`${name}: cap_add must be empty`);
    if (!(Array.isArray(s.security_opt) && s.security_opt.map(String).some((o) => /^no-new-privileges(:true|=true)?$/.test(o)))) p(`${name}: security_opt no-new-privileges is missing`);
    if (!(Number(s.pids_limit) > 0)) p(`${name}: pids_limit is missing`);
    if (s.mem_limit === undefined || s.mem_limit === null || String(s.mem_limit) === '0') p(`${name}: mem_limit is missing`);
    if (!(Number(s.cpus) > 0)) p(`${name}: cpus is missing`);
    if (s.privileged === true) p(`${name}: privileged`);
    for (const k of ['network_mode', 'pid', 'ipc', 'userns_mode']) if (String(s[k] ?? '') === 'host') p(`${name}: ${k} host`);
    if (s.logging?.driver !== 'json-file' || !s.logging?.options?.['max-size']) p(`${name}: logs are not bounded (json-file with max-size)`);
    for (const v of Array.isArray(s.volumes) ? s.volumes : []) {
      if (/docker\.sock/.test(String(v?.source ?? ''))) p(`${name}: mounts the Docker socket`);
      if (v?.type === 'bind' && v.read_only !== true) p(`${name}: a bind mount at ${String(v.target)} is writable`);
    }
    if (Array.isArray(s.ports) && s.ports.length && name !== 'rab-api') p(`${name}: publishes a port (only rab-api, on loopback)`);
  }

  const api = services['rab-api'] ?? {};
  const worker = services['rab-worker'] ?? {};
  const redis = services['rab-redis'] ?? {};
  // Only rab-api publishes, one port, on 127.0.0.1 (Caddy on the host is the edge).
  const ports = Array.isArray(api.ports) ? api.ports : [];
  if (ports.length !== 1 || ports[0]?.host_ip !== '127.0.0.1') p('rab-api: must publish exactly one port, on 127.0.0.1 (CREWFLOW_API_BIND)');
  // rab-api's OpenShip import guard (a long-form tmpfs at /tmp) stays: this file must never be importable there.
  if (!(Array.isArray(api.volumes) && api.volumes.some((v) => v?.type === 'tmpfs' && v.target === '/tmp'))) p('rab-api: the long-form tmpfs /tmp (the OpenShip import guard) is missing');
  const wTmpfs = (Array.isArray(worker.tmpfs) ? worker.tmpfs : [worker.tmpfs]).filter(Boolean).map(String);
  for (const dir of ['/tmp/crewflow-jobs', '/run/crewflow-health/jobs']) if (!wTmpfs.some((t) => t === dir || t.startsWith(`${dir}:`))) p(`rab-worker: tmpfs ${dir} is missing`);

  // Decision 25.2: enforce, never warn.
  for (const name of APP_SERVICES) if (envOf(services[name]).CREWFLOW_RUNTIME_ISOLATION !== 'enforce') p(`${name}: CREWFLOW_RUNTIME_ISOLATION must be enforce (decision 25.2)`);
  // The admin URL reaches db-setup / db-harden only.
  for (const name of APP_SERVICES) {
    const e = envOf(services[name]);
    if ((e.PG_ADMIN_URL ?? '') !== '' || (e.PG_ADMIN_DIRECT_URL ?? '') !== '') p(`${name}: receives the database admin URL`);
  }
  if (expectAdminUrl !== null) {
    for (const name of ADMIN_SERVICES) if (envOf(services[name]).PG_ADMIN_URL !== expectAdminUrl) p(`${name}: does not receive compose.env's PG_ADMIN_URL`);
  }
  // The crewflow_owner URL: DigitalOcean host, direct port, verify-full, identical on every service.
  const urls = [...APP_SERVICES, ...ADMIN_SERVICES].map((n) => envOf(services[n]).PG_DATABASE_URL);
  if (new Set(urls).size !== 1) p('PG_DATABASE_URL differs between db-setup, db-harden, rab-api and rab-worker');
  for (const msg of ownerUrlProblems(urls[0], 'PG_DATABASE_URL (rendered)')) p(msg);
  // env_file and the depends_on conditions (both dropped by OpenShip).
  for (const name of APP_SERVICES) {
    const files = (services[name]?.env_file ?? []).map((f) => path.basename(String(f?.path ?? f)));
    for (const f of ['database.env', 'runtime.env']) if (!files.includes(f)) p(`${name}: env_file ${f} is missing`);
  }
  for (const name of ADMIN_SERVICES) {
    const files = (services[name]?.env_file ?? []).map((f) => path.basename(String(f?.path ?? f)));
    if (JSON.stringify(files) !== JSON.stringify(['database.env'])) p(`${name}: env_file must be database.env only`);
  }
  if (api.depends_on?.['db-setup']?.condition !== 'service_completed_successfully') p('rab-api: must wait for db-setup (service_completed_successfully)');
  if (api.depends_on?.['rab-redis']?.condition !== 'service_healthy') p('rab-api: must wait for a healthy rab-redis');
  if (worker.depends_on?.['rab-api']?.condition !== 'service_healthy' || worker.depends_on?.['rab-api']?.restart !== true) p('rab-worker: must wait for a healthy rab-api with restart: true');
  if (worker.depends_on?.['rab-redis']?.condition !== 'service_healthy') p('rab-worker: must wait for a healthy rab-redis');
  // The cluster CA, read-only, on every service that connects (verify-full).
  for (const name of [...APP_SERVICES, ...ADMIN_SERVICES]) {
    const ca = (services[name]?.volumes ?? []).find((v) => v?.target === PG_CA_TARGET);
    if (!ca || ca.read_only !== true || /^\/dev\/null$/.test(String(ca.source ?? ''))) p(`${name}: the cluster CA (CREWFLOW_PG_CA_FILE) is not mounted read-only at ${PG_CA_TARGET}`);
  }
  // Decision 25.3: Redis with its ACL file (the content is checked by --lint-acl).
  const rc = (redis.command ?? []).map(String);
  const pair = (flag, value) => rc.some((t, i) => t === flag && rc[i + 1] === value);
  if (!pair('--aclfile', ACL_TARGET)) p(`rab-redis: --aclfile ${ACL_TARGET} is missing (unauthenticated Redis)`);
  if (!pair('--appendonly', 'yes') || !pair('--maxmemory-policy', 'noeviction')) p('rab-redis: AOF and noeviction are required');
  if (!(redis.volumes ?? []).some((v) => v?.target === ACL_TARGET && v.read_only === true)) p('rab-redis: the ACL file is not mounted read-only');
  // The edge: a fixed default subnet, so TRUSTED_PROXY_CIDRS can name the gateway exactly; the db network stays internal.
  const ipam = model?.networks?.default?.ipam?.config;
  if (!(Array.isArray(ipam) && ipam.length === 1 && ipam[0]?.subnet === EDGE_SUBNET && ipam[0]?.gateway === EDGE_GATEWAY)) p(`network default: must have exactly subnet ${EDGE_SUBNET} and gateway ${EDGE_GATEWAY} (TRUSTED_PROXY_CIDRS=${TRUSTED_PROXY})`);
  if (model?.networks?.['crewflow-db']?.internal !== true) p('network crewflow-db is not internal');
  // AI stays off in production.
  for (const name of APP_SERVICES) if (String(envOf(services[name]).AI_ENABLED ?? 'false') !== 'false') p(`${name}: AI_ENABLED must stay false in production`);
  return problems;
}

/** A crewflow_owner or admin URL on the DigitalOcean cluster: host, direct port, verify-full. Never includes a value. */
function doUrlProblems(value, label) {
  const problems = [];
  const u = parseUrl(value);
  if (!u || !/^postgres(ql)?:$/.test(u.protocol)) return [`${label}: not a postgresql:// URL`];
  if (!u.hostname.endsWith(DO_HOST_SUFFIX)) problems.push(`${label}: the host is not a DigitalOcean Managed PostgreSQL host (*${DO_HOST_SUFFIX})`);
  if (u.port === DO_POOL_PORT) problems.push(`${label}: port ${DO_POOL_PORT} is the connection POOL; use the direct port ${DO_DIRECT_PORT}`);
  else if (u.port !== DO_DIRECT_PORT) problems.push(`${label}: must use the direct port ${DO_DIRECT_PORT}`);
  // Security review of #332 (LOW): `?sslmode=verify-full&sslmode=disable` would pass a get() check while a client that
  // reads the LAST value disables TLS. A key given more than once is refused outright.
  const keys = [...u.searchParams.keys()];
  for (const k of new Set(keys.filter((k, i) => keys.indexOf(k) !== i))) problems.push(`${label}: the ${k} parameter appears more than once`);
  if (u.searchParams.get('sslmode') !== 'verify-full') problems.push(`${label}: sslmode must be verify-full on DigitalOcean`);
  for (const k of ['host', 'hostaddr', 'port', 'sslrootcert', 'sslcert', 'sslkey', 'options', 'target_session_attrs']) if (u.searchParams.has(k)) problems.push(`${label}: carries the ${k} parameter (the URL's own host, port and the mounted CA only)`);
  if (decodeURIComponent(u.password) === '') problems.push(`${label}: has no password`);
  return problems;
}

function ownerUrlProblems(value, label) {
  const u = parseUrl(value);
  const problems = doUrlProblems(value, label);
  if (u && decodeURIComponent(u.username) !== 'crewflow_owner') problems.push(`${label}: must log in as crewflow_owner`);
  return problems;
}

// --------------------------------------------------------------------------------------------------------- env lints

/** DigitalOcean rules for compose.env (the generic lint runs too). */
function lintComposeEnv(text, { template = false } = {}) {
  const problems = [];
  const env = envMap(text);
  const get = (k) => env.get(k);
  if (get('CREWFLOW_BUNDLED_DB') !== '0') problems.push('CREWFLOW_BUNDLED_DB: must be 0 (Managed PostgreSQL, decision 24 a)');
  if (env.has('PG_DATABASE_PASSWORD')) problems.push('PG_DATABASE_PASSWORD: must not be set (no bundled db on DigitalOcean)');
  if (env.has('PG_ADMIN_DIRECT_URL')) problems.push('PG_ADMIN_DIRECT_URL: must not be set (PG_ADMIN_URL is already the direct address on DigitalOcean)');
  const admin = get('PG_ADMIN_URL');
  if (!admin) problems.push('PG_ADMIN_URL: missing (the cluster\'s doadmin URL, used by db-setup and db-harden only)');
  else {
    problems.push(...doUrlProblems(admin, 'PG_ADMIN_URL'));
    const u = parseUrl(admin);
    if (u && decodeURIComponent(u.username) === 'crewflow_owner') problems.push('PG_ADMIN_URL: must be the admin login, never crewflow_owner');
    if (u && u.pathname.replace(/^\//, '') === 'defaultdb') problems.push('PG_ADMIN_URL: names defaultdb; create a database for Crewflow (crewflow) and name it');
  }
  const adminUrl = parseUrl(admin);
  const ownerUrl = get('PG_DATABASE_URL');
  const parts = ['PG_DATABASE_APP_PASSWORD', 'PG_DATABASE_HOST', 'PG_DATABASE_PORT', 'PG_DATABASE_NAME'].filter((k) => env.has(k));
  if (ownerUrl && parts.length) problems.push(`PG_DATABASE_URL and ${parts.join(', ')}: set the whole URL or its parts, never both`);
  if (ownerUrl) {
    problems.push(...ownerUrlProblems(ownerUrl, 'PG_DATABASE_URL'));
    const o = parseUrl(ownerUrl);
    if (o && adminUrl && (o.hostname !== adminUrl.hostname || o.port !== adminUrl.port || o.pathname !== adminUrl.pathname)) problems.push('PG_DATABASE_URL: must name the same host, port and database as PG_ADMIN_URL');
  } else {
    for (const k of ['PG_DATABASE_APP_PASSWORD', 'PG_DATABASE_HOST', 'PG_DATABASE_PORT', 'PG_DATABASE_NAME']) if (!get(k)) problems.push(`${k}: missing (or set the whole PG_DATABASE_URL)`);
    if (get('PG_DATABASE_PORT') && get('PG_DATABASE_PORT') !== DO_DIRECT_PORT) problems.push(`PG_DATABASE_PORT: must be the direct port ${DO_DIRECT_PORT}${get('PG_DATABASE_PORT') === DO_POOL_PORT ? ` (${DO_POOL_PORT} is the connection pool)` : ''}`);
    if (adminUrl && get('PG_DATABASE_HOST') && get('PG_DATABASE_HOST') !== adminUrl.hostname) problems.push('PG_DATABASE_HOST: must be the same host as PG_ADMIN_URL');
    if (adminUrl && get('PG_DATABASE_NAME') && get('PG_DATABASE_NAME') !== adminUrl.pathname.replace(/^\//, '')) problems.push('PG_DATABASE_NAME: must be the same database as PG_ADMIN_URL');
    if (get('PG_DATABASE_HOST') && !get('PG_DATABASE_HOST').endsWith(DO_HOST_SUFFIX)) problems.push(`PG_DATABASE_HOST: not a DigitalOcean Managed PostgreSQL host (*${DO_HOST_SUFFIX})`);
  }
  const ca = get('CREWFLOW_PG_CA_FILE');
  if (!ca || !(template && isPlaceholder(ca)) && !ca.startsWith('/')) problems.push('CREWFLOW_PG_CA_FILE: must be the absolute path of the cluster\'s CA certificate on the server (verify-full)');
  if (env.has('CREWFLOW_API_BIND') && get('CREWFLOW_API_BIND') !== '127.0.0.1') problems.push('CREWFLOW_API_BIND: must be 127.0.0.1 (Caddy on the host is the only client)');
  if (env.has('AI_ENABLED') && get('AI_ENABLED') !== 'false') problems.push('AI_ENABLED: AI stays off in production (leave it unset)');
  return problems;
}

/** DigitalOcean rules for database.env. */
function lintDatabaseEnv(text) {
  const problems = [];
  const env = envMap(text);
  if (env.get('PG_SSL_CA_CERT_PATH') !== PG_CA_TARGET) problems.push(`PG_SSL_CA_CERT_PATH: must be ${PG_CA_TARGET} (the mounted cluster CA; verify-full)`);
  if (env.has('PG_SSL_CA_CERT')) problems.push('PG_SSL_CA_CERT: use the mounted file (PG_SSL_CA_CERT_PATH) on DigitalOcean, not inline PEM');
  if (env.has('PG_SSL_ALLOW_SELF_SIGNED')) problems.push('PG_SSL_ALLOW_SELF_SIGNED: never in production');
  if (!env.get('PG_EXPECTED_DATABASE_NAME')) problems.push('PG_EXPECTED_DATABASE_NAME: missing (the database created for Crewflow)');
  else if (env.get('PG_EXPECTED_DATABASE_NAME') === 'defaultdb') problems.push('PG_EXPECTED_DATABASE_NAME: defaultdb; use the database created for Crewflow');
  return problems;
}

function intOr(env, key, fallback) {
  const raw = env.get(key);
  if (raw === undefined || raw === '') return fallback;
  return /^\d{1,6}$/.test(raw) ? Number(raw) : NaN;
}

/** The worst-case connection total of a runtime.env (connection-budget.ts planConnectionBudget, poll mode). */
function connectionBudget(text) {
  const env = envMap(text);
  const apiInstances = intOr(env, 'PG_EXPECTED_API_INSTANCES', NaN);
  const workerInstances = intOr(env, 'PG_EXPECTED_WORKER_INSTANCES', NaN);
  const apiPool = intOr(env, 'PG_EXPECTED_API_POOL_MAX', BUDGET.apiPoolDefault);
  const workerPool = intOr(env, 'PG_EXPECTED_WORKER_POOL_MAX', BUDGET.workerPoolDefault);
  const migrate = intOr(env, 'PG_EXPECTED_MIGRATE_CONNECTIONS', BUDGET.migrateDefault);
  const total = apiInstances * (apiPool + BUDGET.apiHealthProbe)
    + workerInstances * (workerPool + BUDGET.workerDirect + BUDGET.workerLocks + BUDGET.workerProvisioner)
    + migrate + BUDGET.bootProbes;
  return { total, apiInstances, workerInstances, apiPool, workerPool, migrate, runtimePool: intOr(env, 'PG_POOL_MAX_CONNECTIONS', BUDGET.apiPoolDefault) };
}

/** DigitalOcean rules for runtime.env (the generic lint runs too). */
function lintRuntimeEnv(text, { template = false } = {}) {
  const problems = [];
  const env = envMap(text);
  if (env.get('TRUSTED_PROXY_CIDRS') !== TRUSTED_PROXY) problems.push(`TRUSTED_PROXY_CIDRS: must be exactly ${TRUSTED_PROXY} (the Docker gateway the host's Caddy arrives from; the DigitalOcean override fixes it)`);
  const redis = parseUrl(env.get('REDIS_URL'));
  if (!redis || redis.protocol !== 'redis:') problems.push('REDIS_URL: not a redis:// URL');
  else {
    if (redis.hostname !== 'rab-redis') problems.push('REDIS_URL: must name the compose service rab-redis');
    if (decodeURIComponent(redis.username) === '' || decodeURIComponent(redis.username) === 'default') problems.push('REDIS_URL: must log in as the ACL app user (crewflow), not the default user');
    if (decodeURIComponent(redis.password) === '') problems.push('REDIS_URL: has no password (decision 25.3)');
  }
  const b = connectionBudget(text);
  if (b.apiInstances !== 1) problems.push('PG_EXPECTED_API_INSTANCES: must be 1 (one API, stop-then-start)');
  if (b.workerInstances !== 1) problems.push('PG_EXPECTED_WORKER_INSTANCES: must be 1');
  if (Number.isNaN(b.apiPool) || Number.isNaN(b.workerPool) || Number.isNaN(b.migrate) || Number.isNaN(b.runtimePool)) problems.push('PG_POOL_MAX_CONNECTIONS / PG_EXPECTED_*: must be whole numbers');
  else {
    if (b.runtimePool > b.apiPool) problems.push('PG_POOL_MAX_CONNECTIONS: larger than PG_EXPECTED_API_POOL_MAX (the API refuses to start)');
    if (b.workerPool !== WORKER_POOL_COMMITTED) problems.push(`PG_EXPECTED_WORKER_POOL_MAX: must be ${WORKER_POOL_COMMITTED} (rab-worker's committed pool)`);
    if (b.total > DO_PLAN_CONNECTIONS) problems.push(`connection budget: up to ${b.total} connections, more than the 2 GiB plan's ${DO_PLAN_CONNECTIONS} (the API would refuse to start)`);
  }
  if (env.has('PG_SSL_ALLOW_SELF_SIGNED')) problems.push('PG_SSL_ALLOW_SELF_SIGNED: never in production');
  if (!template) {
    for (const k of ['APP_URL', 'ACCOUNTS_URL']) {
      const u = parseUrl(env.get(k));
      if (!u || u.protocol !== 'https:') problems.push(`${k}: must be an https:// address (Cloudflare, Full (strict))`);
    }
  }
  return problems;
}

/** The ONLY permission tokens the `default` and `crewflow` ACL users may carry (env/redis-users.acl.example's set). */
const APP_ACL_ALLOWED = Object.freeze([
  'resetkeys', '~*', 'resetchannels', '&*', '+@all', '-@admin', '-@dangerous', '+info',
  '+client|setname', '+client|getname', '+client|id', '+client|info', '+client|list', '-flushall', '-flushdb', '-keys', '-swapdb',
]);
/** Denials both users must carry after `+@all`. */
const APP_ACL_REQUIRED_DENIALS = Object.freeze(['-@admin', '-@dangerous', '-flushall', '-flushdb', '-keys', '-swapdb']);

/**
 * The real redis-users.acl (decision 25.3). Lines: `user <name> <rules...>`. Never includes a value.
 */
function lintRedisAcl(text) {
  const problems = [];
  const users = new Map();
  String(text).split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (line === '') return;
    const tokens = line.split(/\s+/);
    if (tokens[0] !== 'user' || tokens.length < 3) { problems.push(`line ${i + 1}: not a "user <name> <rules>" line`); return; }
    if (users.has(tokens[1])) problems.push(`user ${tokens[1]}: defined more than once`);
    users.set(tokens[1], tokens.slice(2));
  });
  const passwords = (rules) => rules.filter((r) => /^#/.test(r));
  const perms = (rules) => rules.filter((r) => !/^(#|>|<|!)/.test(r) && !['on', 'off', 'nopass', 'resetpass'].includes(r));
  for (const [name, rules] of users) {
    if (rules.some((r) => r.startsWith('>'))) problems.push(`user ${name}: a clear-text password (>...) in the file; use #<sha256 hex>`);
    for (const h of passwords(rules)) if (!/^#[0-9a-f]{64}$/.test(h)) problems.push(`user ${name}: a password hash that is not 64 lower-case hex characters`);
    const on = rules.includes('on') && !rules.includes('off');
    if (name === 'healthcheck') {
      if (on && JSON.stringify(perms(rules).filter((r) => !['resetkeys', 'resetchannels'].includes(r))) !== JSON.stringify(['-@all', '+ping'])) problems.push('user healthcheck: must be PING-only (-@all +ping)');
      continue;
    }
    if (on && (rules.includes('nopass') || passwords(rules).length === 0)) problems.push(`user ${name}: enabled without a password`);
  }
  const def = users.get('default');
  if (!def) problems.push('user default: missing (an unlisted default user is ON with no password)');
  else {
    if (!def.includes('on') || def.includes('off')) problems.push('user default: must be ON with a password (decision 25.3; a disabled default user without command permissions loses AOF data on Redis 7.4)');
    if (passwords(def).length !== 1) problems.push('user default: must have exactly one #<sha256> password');
  }
  const app = users.get('crewflow');
  if (!app) problems.push('user crewflow: missing (the application user of REDIS_URL)');
  else if (!app.includes('on') || passwords(app).length !== 1) problems.push('user crewflow: must be ON with exactly one #<sha256> password');
  // Security review of #332 (LOW): both users must carry the reviewed command set, not merely equal ones (`+@all` on both
  // would otherwise pass). Every permission token is on the allow-list, and every denial follows the last `+@all`.
  for (const [name, rules] of [['default', def], ['crewflow', app]]) {
    if (!rules) continue;
    const p = perms(rules);
    for (const t of p) if (!APP_ACL_ALLOWED.includes(t)) problems.push(`user ${name}: permission ${t} is not allowed (only the reviewed set: +@all minus @admin, @dangerous, flushall, flushdb, keys, swapdb, plus info and five client subcommands)`);
    const lastAll = p.lastIndexOf('+@all');
    if (lastAll < 0) problems.push(`user ${name}: must start its command rules from +@all (the app's command set)`);
    for (const d of APP_ACL_REQUIRED_DENIALS) {
      const at = p.lastIndexOf(d);
      if (at < 0) problems.push(`user ${name}: ${d} is missing`);
      else if (at < lastAll) problems.push(`user ${name}: ${d} must come after +@all (rules apply left to right)`);
    }
  }
  if (def && app && JSON.stringify(perms(def)) !== JSON.stringify(perms(app))) problems.push('user default: must have exactly the crewflow user\'s command and key permissions (what AOF replay needs, and nothing more)');
  if (def && app && passwords(def).length === 1 && passwords(def)[0] === passwords(app)[0]) problems.push('user default: must not share the crewflow user\'s password');
  return problems;
}

// ------------------------------------------------------------------------------------------------------------ Caddyfile

/** Splits a Caddyfile into its top-level blocks: [{ label, body }] (comments removed). Small and strict on purpose. */
function caddyBlocks(text) {
  const lines = String(text).split(/\r?\n/).map((l) => l.replace(/(^|\s)#.*$/, '').trimEnd());
  const blocks = [];
  let depth = 0;
  let current = null;
  for (const line of lines) {
    const t = line.trim();
    if (t === '') continue;
    if (depth === 0) current = { label: t.replace(/\s*\{$/, '').trim(), body: [] };
    else current.body.push(t);
    depth += (t.match(/\{/g) ?? []).length - (t.match(/\}/g) ?? []).length;
    if (depth < 0) return null;
    if (depth === 0 && current) {
      blocks.push(current);
      current = null;
    }
  }
  return depth === 0 ? blocks : null;
}

/** A trust-pool file NAMED like Cloudflare's SHARED origin-pull CA (zone-level / global Authenticated Origin Pulls). */
const SHARED_AOP_NAME = /origin[-_ ]?pull|authenticated[-_ ]?origin|cloudflare/i;

/**
 * The real /etc/caddy/Caddyfile (security review of #332, MEDIUM): per-hostname Authenticated Origin Pulls with OUR client
 * CA, `require_and_verify`, `strict_sni_host on`, rab-api reached on loopback only, nothing proxied over plain HTTP.
 * `readFile` (optional) reads the trust-pool file, to refuse a Cloudflare-issued (shared) CA by its subject. No value is
 * ever included in a problem.
 */
function lintCaddyfile(text, { readFile = null } = {}) {
  const problems = [];
  const blocks = caddyBlocks(text);
  if (!blocks) return ['the Caddyfile braces do not balance'];
  const global = blocks.find((b) => b.label === '');
  const all = blocks.flatMap((b) => b.body);
  if (!global || !global.body.includes('strict_sni_host on')) problems.push('strict_sni_host on is missing from the global servers block (the TLS server name and the Host header must match)');
  if (all.some((l) => /^strict_sni_host\s+(?!on$)/.test(l))) problems.push('strict_sni_host is set to something other than on');
  const https = blocks.filter((b) => /^https:\/\//.test(b.label));
  if (https.length === 0) problems.push('no https:// site block');
  for (const b of https) {
    const body = b.body;
    if (!body.includes('client_auth {')) problems.push(`${b.label}: no client_auth (per-hostname Authenticated Origin Pulls)`);
    const modes = body.filter((l) => /^mode\s/.test(l));
    if (modes.length === 0 || modes.some((l) => l !== 'mode require_and_verify')) problems.push(`${b.label}: client_auth mode must be exactly require_and_verify`);
    const pools = body.filter((l) => /^trust_pool\s/.test(l));
    if (pools.length !== 1 || !/^trust_pool file \S+$/.test(pools[0] ?? '')) problems.push(`${b.label}: exactly one "trust_pool file <our CA>" is required`);
    for (const l of pools) {
      const file = /^trust_pool file (\S+)$/.exec(l)?.[1];
      if (file && SHARED_AOP_NAME.test(path.basename(file))) problems.push(`${b.label}: the trust pool is named like Cloudflare's SHARED origin-pull CA; trust only our own client CA (per-hostname AOP)`);
      if (file && readFile) {
        let pem = null;
        try {
          pem = readFile(file);
        } catch {
          problems.push(`${b.label}: the trust pool file cannot be read`);
        }
        if (pem !== null) problems.push(...trustPoolPemProblems(pem, b.label));
      }
    }
    if (body.some((l) => /^(trusted_ca_cert|trusted_ca_cert_file|trusted_leaf_cert|trusted_leaf_cert_file)\b/.test(l))) problems.push(`${b.label}: use only "trust_pool file <our CA>" (no other client-trust directive)`);
    for (const l of body.filter((x) => /^reverse_proxy\s/.test(x))) {
      const upstreams = l.replace(/^reverse_proxy\s+/, '').replace(/\s*\{$/, '').split(/\s+/).filter(Boolean);
      if (upstreams.length === 0 || upstreams.some((u) => !/^(https?:\/\/)?(127\.0\.0\.1|localhost):\d+$/.test(u))) problems.push(`${b.label}: reverse_proxy must target rab-api on loopback only`);
    }
  }
  for (const b of blocks.filter((x) => /^http:\/\//.test(x.label))) {
    if (b.body.some((l) => /^reverse_proxy\b/.test(l))) problems.push(`${b.label}: proxies over plain HTTP (redirect only)`);
  }
  return problems;
}

/** The trust-pool PEM: CA certificates, none issued by Cloudflare (the shared origin-pull CA is a Cloudflare one). */
function trustPoolPemProblems(pem, label) {
  const { X509Certificate } = require('node:crypto');
  const certs = String(pem).match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  if (certs.length === 0) return [`${label}: the trust pool file holds no certificate`];
  const problems = [];
  for (const c of certs) {
    let x;
    try {
      x = new X509Certificate(c);
    } catch {
      problems.push(`${label}: a trust pool certificate does not parse`);
      continue;
    }
    if (/cloudflare|origin-pull/i.test(`${x.subject}\n${x.issuer}`)) problems.push(`${label}: the trust pool holds a Cloudflare-issued certificate (the SHARED origin-pull CA admits every Cloudflare customer); trust only our own client CA`);
    if (!x.ca) problems.push(`${label}: a trust pool certificate is not a CA certificate`);
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------- templates (sentinels)

const SENTINEL_HOST = 'private-db-postgresql-lon1-00000-do-user-0-0.a.db.ondigitalocean.com';
const SENTINEL_ADMIN_PW = 'SENTINEL-DO-DOADMIN-PW-6e2a91'; // gitleaks:allow (synthetic marker, not a credential)
const SENTINEL_APP_PW = 'SENTINELDOAPPOWNERPW3f8b0c71d2e94a65'; // gitleaks:allow (synthetic marker, not a credential)
const SENTINEL_VALUES = Object.freeze({
  'doadmin-password': SENTINEL_ADMIN_PW,
  'private-cluster-host': SENTINEL_HOST.replace(/\.db\.ondigitalocean\.com$/, ''),
  'openssl-rand-hex-32': SENTINEL_APP_PW,
  'image-index-digest-64-hex': '0'.repeat(64),
  'redis-index-digest-64-hex': '2'.repeat(64),
  'redis-app-password': 'SENTINEL-DO-REDIS-PW-9a11c4', // gitleaks:allow (synthetic marker, not a credential)
  'console-host': 'console.example.com',
  'deployment-uuid': '00000000-0000-4000-8000-000000000000',
  'sha256-hex-of-the-redis-app-password': 'a'.repeat(64),
  'sha256-hex-of-a-second-random-password-then-discard-it': 'b'.repeat(64),
});

/** Replaces every <placeholder> with its sentinel (unknown placeholders stay, so the lints flag them). */
function materialise(text, extra = {}) {
  const values = { ...SENTINEL_VALUES, ...extra };
  return String(text).replace(/<([a-z0-9-]+)>/g, (m, name) => (Object.hasOwn(values, name) ? values[name] : m));
}

/** The DigitalOcean runtime.env a server would hold: the generic template with the DigitalOcean lines applied. */
function digitalOceanRuntimeText() {
  const doLines = parseEnvText(fs.readFileSync(TEMPLATES.runtime, 'utf8')).filter((e) => e.key);
  const doKeys = new Set(doLines.map((e) => e.key));
  const generic = fs.readFileSync(TEMPLATES.genericRuntime, 'utf8').split(/\r?\n/).filter((l) => {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(l);
    return !(m && doKeys.has(m[1]));
  });
  const genericFilled = generic.join('\n')
    .replace(/<app-secret>/g, 'SENTINEL-DO-APP-SECRET-0000000000000000000000000000000000')
    .replace(/<smtp-host>/g, 'smtp.example.com').replace(/<smtp-user>/g, 'mailer').replace(/<smtp-password>/g, 'SENTINEL-SMTP')
    .replace(/<sender-address>/g, 'noreply@example.com');
  const doText = doLines.map((e) => `${e.key}=${e.value}`).join('\n');
  return materialise(`${genericFilled}\n${doText}\n`, {
    bucket: 'crewflow-files', 'region-or-auto': 'auto', 's3-compatible-endpoint': 'r2.example.com',
    'bucket-scoped-key-id': 'SENTINEL-KEY-ID', 'bucket-scoped-secret': 'SENTINEL-KEY-SECRET',
  });
}

/** Problems of the committed templates, filled with sentinels: the DigitalOcean rules and the generic lint. */
function templateProblems() {
  const problems = [];
  const compose = materialise(fs.readFileSync(TEMPLATES.compose, 'utf8'));
  const database = materialise(fs.readFileSync(TEMPLATES.database, 'utf8'));
  const runtime = digitalOceanRuntimeText();
  const acl = materialise(fs.readFileSync(TEMPLATES.acl, 'utf8'));
  for (const [kind, text] of [['compose', compose], ['database', database], ['runtime', runtime]]) {
    if (/<[a-z0-9-]+>/.test(text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n'))) problems.push(`template ${kind}: a placeholder without a sentinel`);
    for (const m of lintEnvText(kind, text)) problems.push(`template ${kind} (generic lint): ${m}`);
  }
  for (const m of lintComposeEnv(compose)) problems.push(`template compose: ${m}`);
  for (const m of lintDatabaseEnv(database)) problems.push(`template database: ${m}`);
  for (const m of lintRuntimeEnv(runtime)) problems.push(`template runtime: ${m}`);
  for (const m of lintRedisAcl(acl)) problems.push(`template acl: ${m}`);
  for (const m of lintCaddyfile(fs.readFileSync(TEMPLATES.caddyfile, 'utf8'))) problems.push(`template Caddyfile: ${m}`);
  return problems;
}

// -------------------------------------------------------------------------------------------------------------- render

function composeAvailable() {
  try {
    execFileSync('docker', ['compose', 'version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Renders image.yml + the DigitalOcean override. `composeEnvText`: the interpolation file (default: the filled template);
 * `files`: override the compose files (tests pass weakened copies). Env files are never resolved (no secret is read).
 */
function render({ composeEnvText = null, composeEnvPath = null, files = [IMAGE_FILE, DO_FILE] } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-digitalocean-'));
  try {
    const project = path.join(tmp, 'project');
    fs.mkdirSync(project);
    let envFile = composeEnvPath;
    if (!envFile) {
      envFile = path.join(tmp, 'compose.env');
      const secrets = path.join(tmp, 'secrets').split(path.sep).join('/');
      const text = (composeEnvText ?? materialise(fs.readFileSync(TEMPLATES.compose, 'utf8')))
        .replace(/^CREWFLOW_SECRETS_DIR=.*$/m, `CREWFLOW_SECRETS_DIR=${secrets}`);
      fs.writeFileSync(envFile, text, { mode: 0o600 });
    }
    const childEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CREWFLOW_|COMPOSE_|PG_DATABASE_|PG_ADMIN_|AI_ENABLED$)/i.test(k)));
    const args = ['compose', '--env-file', envFile, '--project-directory', project];
    for (const f of files) args.push('-f', f);
    args.push('--profile', '*', 'config', '--no-env-resolution', '--format', 'json');
    return JSON.parse(execFileSync('docker', args, { env: childEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 }));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ----------------------------------------------------------------------------------------------------------------- main

function report(label, problems) {
  for (const m of problems) console.log(`[digitalocean] FAIL ${label}: ${m}`);
  console.log(`[digitalocean] ${problems.length ? 'FAIL' : 'PASS'} ${label}`);
  return problems.length;
}

function readOrNull(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Security review of #332 (LOW): --environment lints every file the server will use, not only compose.env: the two
 * secret env files and the Redis ACL under CREWFLOW_SECRETS_DIR (DigitalOcean rules AND the generic lint), and the
 * Caddyfile when given. Returns [label, problems] pairs; never includes a value.
 */
function environmentFileProblems(composeText, { caddyfile = null } = {}) {
  const out = [];
  const dir = envMap(composeText).get('CREWFLOW_SECRETS_DIR');
  if (!dir || !path.isAbsolute(dir)) return [['secret directory', ['CREWFLOW_SECRETS_DIR: missing or not an absolute path']]];
  for (const kind of ['database', 'runtime']) {
    const text = readOrNull(path.join(dir, `${kind}.env`));
    if (text === null) {
      out.push([`${kind}.env`, [`${kind}.env: cannot read it in CREWFLOW_SECRETS_DIR`]]);
      continue;
    }
    const lint = kind === 'database' ? lintDatabaseEnv : lintRuntimeEnv;
    out.push([`${kind}.env (DigitalOcean rules + generic lint)`, [...lint(text), ...lintEnvText(kind, text)]]);
  }
  const acl = readOrNull(path.join(dir, 'redis-users.acl'));
  out.push(['redis-users.acl', acl === null ? ['redis-users.acl: cannot read it in CREWFLOW_SECRETS_DIR'] : lintRedisAcl(acl)]);
  if (caddyfile) {
    const text = readOrNull(caddyfile);
    out.push(['Caddyfile', text === null ? ['the Caddyfile cannot be read'] : lintCaddyfile(text, { readFile: (f) => fs.readFileSync(f, 'utf8') })]);
  }
  return out;
}

function main(argv) {
  if (argv[0] === '--lint-env-file') {
    const [, kind, file] = argv;
    if (!['compose', 'database', 'runtime'].includes(kind) || !file) { console.error('usage: verify-digitalocean.cjs --lint-env-file <compose|database|runtime> <path>'); return 2; }
    const text = readOrNull(file);
    if (text === null) { console.error(`[digitalocean] cannot read ${file}`); return 2; }
    const lint = { compose: lintComposeEnv, database: lintDatabaseEnv, runtime: lintRuntimeEnv }[kind];
    return report(`${kind} env file (DigitalOcean rules; names only, no value printed)`, lint(text)) ? 1 : 0;
  }
  if (argv[0] === '--lint-acl') {
    const text = argv[1] ? readOrNull(argv[1]) : null;
    if (text === null) { console.error('usage: verify-digitalocean.cjs --lint-acl <readable path>'); return 2; }
    return report('redis ACL file (names only, no value printed)', lintRedisAcl(text)) ? 1 : 0;
  }
  if (argv[0] === '--lint-caddyfile') {
    const text = argv[1] ? readOrNull(argv[1]) : null;
    if (text === null) { console.error('usage: verify-digitalocean.cjs --lint-caddyfile <readable path>'); return 2; }
    return report('Caddyfile', lintCaddyfile(text, { readFile: (f) => fs.readFileSync(f, 'utf8') })) ? 1 : 0;
  }
  if (argv[0] === '--environment') {
    const opt = (name) => {
      const i = argv.indexOf(name);
      return i > 0 ? argv[i + 1] ?? null : null;
    };
    const file = opt('--env-file');
    if (!file) { console.error('usage: verify-digitalocean.cjs --environment --env-file <compose.env> [--caddyfile <path>]'); return 2; }
    if (!composeAvailable()) { console.error('[digitalocean] docker compose is not available'); return 2; }
    const text = readOrNull(file);
    if (text === null) { console.error(`[digitalocean] cannot read ${file}`); return 2; }
    let failed = report('compose.env (DigitalOcean rules)', lintComposeEnv(text));
    for (const [label, problems] of environmentFileProblems(text, { caddyfile: opt('--caddyfile') })) failed += report(label, problems);
    let model;
    try {
      model = render({ composeEnvPath: path.resolve(file) });
    } catch (e) {
      console.log(`[digitalocean] FAIL docker compose config: ${String(e.stderr ?? e.message).trim().split('\n').slice(-2).join(' | ').replace(/postgres(ql)?:\/\/\S+/g, '<url>')}`);
      return 1;
    }
    failed += report('image.yml + digitalocean override (this server)', checkModel(model, { expectAdminUrl: envMap(text).get('PG_ADMIN_URL') ?? null }));
    return failed ? 1 : 0;
  }
  if (argv.length) { console.error('usage: verify-digitalocean.cjs [--environment --env-file <f> [--caddyfile <f>] | --lint-env-file <kind> <f> | --lint-acl <f> | --lint-caddyfile <f>]'); return 2; }
  let failed = report('DigitalOcean templates', templateProblems());
  if (!composeAvailable()) { console.error('[digitalocean] docker compose is not available (needed to render the shape)'); return 2; }
  const model = render();
  failed += report('docker-compose.image.yml + digitalocean/docker-compose.digitalocean.yml', checkModel(model, { expectAdminUrl: materialise(envMap(fs.readFileSync(TEMPLATES.compose, 'utf8')).get('PG_ADMIN_URL')) }));
  return failed ? 1 : 0;
}

module.exports = {
  checkModel, lintComposeEnv, lintDatabaseEnv, lintRuntimeEnv, lintRedisAcl, lintCaddyfile, trustPoolPemProblems, environmentFileProblems,
  main, connectionBudget, templateProblems, materialise,
  digitalOceanRuntimeText, render, composeAvailable, BUDGET, DO_PLAN_CONNECTIONS, TEMPLATES, IMAGE_FILE, DO_FILE, SENTINEL_ADMIN_PW,
  SENTINEL_HOST, TRUSTED_PROXY, EDGE_SUBNET, EDGE_GATEWAY,
};
if (require.main === module) process.exit(main(process.argv.slice(2)));
