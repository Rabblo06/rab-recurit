#!/usr/bin/env node
'use strict';
/**
 * Verifies packages/rab-docker/docker-compose.image.yml, the image-based, digest-pinned variant of the production compose
 * file (owner decisions R1/R5, 2026-11-03), on the OWNER LOGIN (owner's final decision 2026-11-04: one crewflow_owner login
 * for rab-api, rab-worker and rab-migrate, from ONE shared database.env; runtime.env for rab-api / rab-worker only; no
 * .env.migrate, no provisioner/migrator/worker URL, no root launcher). The owner-login contract itself (one identical URL,
 * no second identity, the lifecycle) is scripts/compose-owner-login.cjs; this file keeps the image <-> production H6
 * equivalence and the operator's deployed-model preflight. Two modes:
 *
 *   node packages/rab-docker/staging/verify-image-compose.cjs
 *     STATIC: renders the variant and docker-compose.production.yml with `docker compose config --format json` in a
 *     throw-away project directory (sentinel database.env / runtime.env / .env.ops, dummy digests; no real .env is read)
 *     and checks the rendered models (checkVariant below).
 *
 *   node packages/rab-docker/staging/verify-image-compose.cjs --environment [--env-file <file>]... [--compose <extra file>]...
 *          [--project-directory <dir>] [--allow-repository <repo>]...
 *     ENVIRONMENT: the operator's preflight on the deployment host. Renders the variant (plus any override, e.g.
 *     staging/docker-compose.staging.yml) with the REAL interpolation environment (process env + --env-file) and checks
 *     that every image resolved to repository@sha256:<64 hex> from an allowed repository (default adhin007/adolphus for
 *     the application images; Redis: any repository, digest required). Prints image references and check names only.
 *
 * Exit 0 = every check passed, 1 = a check failed, 2 = usage error or docker compose unavailable.
 * Never prints an environment value other than image references (which are not secrets).
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '../../..');
const VARIANT = path.join(REPO, 'packages/rab-docker/docker-compose.image.yml');
const PRODUCTION = path.join(REPO, 'packages/rab-docker/docker-compose.production.yml');

/** Application image repository (owner decision R1). Overridable only with --allow-repository (local rehearsal). */
const DEFAULT_APP_REPOSITORY = 'adhin007/adolphus';
const DIGEST = /^sha256:[0-9a-f]{64}$/;
/** repository[:port]/path @sha256:<64 hex>, and no tag. */
const DIGEST_REF = /^([a-z0-9]+(?:[._-][a-z0-9]+)*(?::\d+)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*)@(sha256:[0-9a-f]{64})$/;

/**
 * H6 runtime keys of rab-api / rab-worker that must be IDENTICAL to docker-compose.production.yml. Superset of the H6
 * matrix's step 00 list, plus the start command and the entrypoint.
 */
const RUNTIME_KEYS = [
  'user', 'read_only', 'cap_drop', 'cap_add', 'security_opt', 'tmpfs', 'pids_limit', 'mem_limit', 'memswap_limit', 'cpus',
  'stop_grace_period', 'privileged', 'healthcheck', 'restart', 'init', 'ipc', 'pid', 'network_mode', 'devices', 'shm_size',
  'ulimits', 'command', 'entrypoint', 'volumes',
];
/** Committed environment keys that must keep the production file's value on rab-api / rab-worker. */
const PINNED_ENV = ['NODE_ENV', 'RAB_RUNTIME_ENV', 'AI_ENABLED', 'HWS_RUNTIME_ENABLED', 'STORAGE_DRIVER', 'STORAGE_KEY_PREFIX',
  'S3_FORCE_PATH_STYLE', 'S3_SERVER_SIDE_ENCRYPTION', 'CREWFLOW_PROVISIONER_ENABLED', 'WORKSPACE_PROVISIONER_INTERVAL_SECONDS',
  'PG_POOL_MAX_CONNECTIONS', 'WORKER_SCHEDULER', 'CREWFLOW_MIGRATE_ON_START', 'CREWFLOW_MIGRATION_APPROVAL_MODE',
  'CREWFLOW_UPGRADE_FAILURE_POLICY', 'CREWFLOW_UPGRADE_FAILURE', 'DISABLE_DB_MIGRATIONS', 'DISABLE_CRON_JOBS_REGISTRATION',
  'CREWFLOW_WORKER_SCHEMA_WAIT_SECONDS'];
const MIGRATION_AUTHORITY = ['CREWFLOW_MIGRATION_APPROVED', 'CREWFLOW_MIGRATION_DATABASE_URL', 'CREWFLOW_MIGRATION_PHASE',
  'ALLOW_PRODUCTION_DB_COMMANDS', 'DATABASE_URL_UNPOOLED', 'CREWFLOW_DEPLOYMENT_IDENTITY_BOOTSTRAP',
  'CREWFLOW_BOOTSTRAP_PASSWORD', 'CREWFLOW_APP_BOOTSTRAP_PASSWORD', 'CREWFLOW_WORKER_BOOTSTRAP_PASSWORD', 'CREWFLOW_MIGRATOR_PASSWORD',
  // Owner login: no second database identity and no mode switch on any service.
  'CREWFLOW_PROVISIONER_DATABASE_URL', 'PG_WORKER_DATABASE_URL', 'CREWFLOW_PRESTART_MIGRATION_DATABASE_URL', 'DB_TARGET',
  'CREWFLOW_DB_MODE'];
/** The one runtime login. */
const OWNER_LOGIN = 'crewflow_owner';
const OPS_ONLY = ['CREWFLOW_OPS_RUN', 'PG_OPS_APP_DATABASE_URL', 'CREWFLOW_OPS_ACTOR_SOURCE', 'CREWFLOW_OPS_ACTOR_ID', 'CREWFLOW_OPS_CHANGE_REF'];
const LEGACY_DB = ['DATABASE_URL', 'DATABASE_DIRECT_URL', 'DB_POOL_MAX'];

const SENTINEL_MIGRATOR_PW = 'SENTINEL-IMAGE-MIGRATOR-PW-5b1e'; // gitleaks:allow (synthetic marker planted by this check)
const SENTINEL_OPS_PW = 'SENTINEL-IMAGE-OPS-PW-93ad'; // gitleaks:allow (synthetic marker planted by this check)
const SENTINEL_OWNER_PW = 'SENTINEL-IMAGE-OWNER-PW-c41d'; // gitleaks:allow (synthetic marker planted by this check)
const SENTINEL_RUNTIME_REDIS_URL = 'redis://crewflow:sentinel-runtime-c41d@rab-redis:6379'; // gitleaks:allow (synthetic)
const SENTINEL_DIGEST = `sha256:${'5e'.repeat(32)}`;

const stable = (v) => JSON.stringify(v ?? null, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));
const envOf = (svc) => svc?.environment ?? {};
const baseName = (p) => String(p).split(/[\\/]/).pop();
/** The one bind every app service has: the PostgreSQL CA, read-only (verify-full). */
const caMount = (v) => v.type === 'bind' && v.target === '/run/crewflow/pg-ca.crt' && v.read_only === true;
const withoutCa = (vols) => {
  const rest = (vols ?? []).filter((v) => !caMount(v));
  return rest.length ? rest : undefined;
};
/** The Redis command must carry these flag/value pairs (AOF, never evicting, ACL file). */
const REDIS_FLAGS = [['--appendonly', 'yes'], ['--maxmemory-policy', 'noeviction'], ['--aclfile', '/run/secrets/redis-users.acl']];
const redisFlagProblems = (redis, where) => {
  const c = (redis.command ?? []).map(String);
  return REDIS_FLAGS.filter(([f, v]) => !c.some((t, i) => t === f && c[i + 1] === v)).map(([f, v]) => `rab-redis: command lacks ${f} ${v}${where}`);
};

/**
 * Pure checks on the rendered models (`docker compose config --format json` output). `variant`: env files resolved with
 * the sentinels (compose then inlines their values and drops the env_file key); `variantFiles`: the same file rendered
 * with --no-env-resolution (keeps the env_file names); `production`: docker-compose.production.yml, --no-env-resolution.
 * Returns failure messages.
 */
function checkVariant(variant, production, variantFiles = variant) {
  const problems = [];
  const envFiles = (name) => (variantFiles?.services?.[name]?.env_file ?? []).map((e) => (typeof e === 'string' ? e : e.path));
  const fail = (m) => problems.push(m);
  const services = variant?.services ?? {};
  const names = Object.keys(services).sort();
  // O3 (owner decisions C1-C5): no rab-migrate; the API migrates on start.
  const expected = ['rab-api', 'rab-ops', 'rab-redis', 'rab-worker'];
  if (stable(names) !== stable(expected)) fail(`services are ${names.join(',')}; expected exactly ${expected.join(',')}`);

  // 1. Image-based and digest-pinned only.
  for (const [name, svc] of Object.entries(services)) {
    if (svc.build !== undefined) fail(`${name}: has a build section (this file must never build)`);
    const ref = String(svc.image ?? '');
    if (!DIGEST_REF.test(ref)) fail(`${name}: image "${ref}" is not repository@sha256:<64 hex> without a tag`);
    if (svc.pull_policy && svc.pull_policy !== 'missing' && svc.pull_policy !== 'always') fail(`${name}: pull_policy ${svc.pull_policy}`);
    if (svc.privileged) fail(`${name}: privileged`);
    if (svc.network_mode === 'host' || svc.pid === 'host' || svc.ipc === 'host') fail(`${name}: host namespace`);
    for (const v of svc.volumes ?? []) {
      if (/docker\.sock/.test(String(v.source ?? ''))) fail(`${name}: mounts the Docker socket`);
    }
  }
  const apiImage = services['rab-api']?.image;
  for (const name of ['rab-migrate', 'rab-ops']) {
    if (services[name] && services[name].image !== apiImage) fail(`${name}: image differs from rab-api's (the migrations ship in the API image)`);
  }
  // O1/O2: ONE image. The Worker runs rab-api's image with its own command; a different Worker image is a drift.
  if (services['rab-worker'] && services['rab-worker'].image !== apiImage) fail('rab-worker: image differs from rab-api\'s (O2: one image for every application service)');

  // 2. Every H6 runtime key identical to the production file.
  for (const name of ['rab-api', 'rab-worker']) {
    const a = services[name];
    const b = production?.services?.[name];
    if (!a || !b) {
      fail(`${name}: missing in ${a ? 'docker-compose.production.yml' : 'the variant'}`);
      continue;
    }
    for (const key of RUNTIME_KEYS) {
      // The read-only PostgreSQL CA bind is the one allowed difference (the image file mounts it from the host).
      const av = key === 'volumes' ? withoutCa(a.volumes) : a[key];
      const bv = key === 'volumes' ? withoutCa(b.volumes) : b[key];
      if (stable(av) !== stable(bv)) fail(`${name}.${key} differs from docker-compose.production.yml: ${stable(av)} vs ${stable(bv)}`);
    }
    for (const key of PINNED_ENV) {
      if (stable(envOf(a)[key]) !== stable(envOf(b)[key])) fail(`${name}.environment.${key} differs from docker-compose.production.yml`);
    }
    // depends_on: same services and conditions (the production file's, without build-only additions).
    const deps = (s) => Object.fromEntries(Object.entries(s.depends_on ?? {}).map(([k, v]) => [k, v.condition]));
    if (stable(deps(a)) !== stable(deps(b))) fail(`${name}.depends_on differs from docker-compose.production.yml: ${stable(deps(a))} vs ${stable(deps(b))}`);
    // 3. Fail-closed isolation.
    if (envOf(a).CREWFLOW_RUNTIME_ISOLATION !== 'enforce') fail(`${name}: CREWFLOW_RUNTIME_ISOLATION is not "enforce"`);
    // 4. Infrastructure hardening: REDIS_URL is never committed (it carries the ACL password). It must come from runtime.env:
    // a committed `environment:` value would override the env file, so anything but the sentinel means it is committed.
    if (envOf(a).REDIS_URL !== SENTINEL_RUNTIME_REDIS_URL) fail(`${name}: REDIS_URL is committed (enter it from the secret store)`);
  }
  // The isolation variable belongs to the long-running runtime services only.
  for (const name of ['rab-migrate', 'rab-ops', 'rab-redis']) {
    if (services[name] && envOf(services[name]).CREWFLOW_RUNTIME_ISOLATION !== undefined) fail(`${name}: sets CREWFLOW_RUNTIME_ISOLATION`);
  }

  // 5. rab-api port: bound to an explicit address, never every interface.
  for (const p of services['rab-api']?.ports ?? []) {
    if (!p.host_ip || p.host_ip === '0.0.0.0' || p.host_ip === '::') fail(`rab-api: port ${p.target} is published on every interface`);
  }
  // 6. Redis: no port, ACL from the secret directory, reviewed config read-only, memory limit.
  const redis = services['rab-redis'];
  if (redis) {
    if ((redis.ports ?? []).length) fail('rab-redis: publishes a port');
    const vols = redis.volumes ?? [];
    if (!vols.some((v) => v.target === '/run/secrets/redis-users.acl' && v.read_only)) fail('rab-redis: ACL file not mounted read-only at /run/secrets/redis-users.acl');
    for (const pr of redisFlagProblems(redis, '')) fail(pr);
    if (!redis.mem_limit) fail('rab-redis: no memory limit');
  }

  // 7. Lifecycle (O3, owner decisions C1-C5, like Twenty): no release step. rab-api migrates on start without a token and
  // registers the job schedulers; rab-worker never migrates, never registers them, and starts after a healthy API and Redis.
  if (services['rab-migrate']) fail('rab-migrate: present (O3: the API migrates on start; there is no release step)');
  const api = envOf(services['rab-api']);
  const worker = envOf(services['rab-worker']);
  if (api.CREWFLOW_MIGRATE_ON_START !== 'true') fail('rab-api: CREWFLOW_MIGRATE_ON_START is not "true" (O3 C1)');
  if (!['none', 'token'].includes(String(api.CREWFLOW_MIGRATION_APPROVAL_MODE ?? ''))) fail('rab-api: CREWFLOW_MIGRATION_APPROVAL_MODE is not none or token (compose.env; default none)');
  if (api.DISABLE_DB_MIGRATIONS === 'true' || api.DISABLE_CRON_JOBS_REGISTRATION === 'true') fail('rab-api: must migrate and register the job schedulers (O3 C1/C2)');
  if (worker.DISABLE_DB_MIGRATIONS !== 'true' || worker.DISABLE_CRON_JOBS_REGISTRATION !== 'true') fail('rab-worker: DISABLE_DB_MIGRATIONS and DISABLE_CRON_JOBS_REGISTRATION must be "true" (O3 C1/C2)');
  for (const name of ['rab-api', 'rab-worker']) {
    if ('WORKER_SCHEDULER' in envOf(services[name])) fail(`${name}: commits WORKER_SCHEDULER (production runs bullmq; interval is refused)`);
    if ('CREWFLOW_UPGRADE_FAILURE_POLICY' in envOf(services[name])) fail(`${name}: commits the deprecated CREWFLOW_UPGRADE_FAILURE_POLICY (O3 C3)`);
  }
  const ops = services['rab-ops'];
  // The OpenShip import guard (a long-form tmpfs volume; OpenShip refuses the file at import). O3 moved it from the removed
  // rab-migrate to rab-ops.
  if (!Object.values(services).some((svc) => (svc.volumes ?? []).some((v) => v.type === 'tmpfs'))) fail('no long-form tmpfs volume: the OpenShip import guard is missing');
  if (ops) {
    if (stable(ops.profiles) !== stable(['ops'])) fail('rab-ops: not in (only) the "ops" profile');
    if (stable(envFiles('rab-ops').map(baseName)) !== stable(['.env.ops'])) fail('rab-ops: must read .env.ops only');
    if (ops.restart !== 'no') fail('rab-ops: restart is not "no"');
    if ((ops.ports ?? []).length) fail('rab-ops: publishes a port');
  }
  for (const name of ['rab-api', 'rab-worker']) {
    const svc = services[name];
    if (!svc) continue;
    const files = envFiles(name).map(baseName);
    if (files.includes('.env.migrate') || files.includes('.env.ops')) fail(`${name}: names .env.migrate or .env.ops`);
    if (stable(files) !== stable(['database.env', 'runtime.env'])) fail(`${name}: must read database.env and runtime.env (got ${files.join(', ') || 'none'})`);
    const env = envOf(svc);
    for (const [k, v] of Object.entries(env)) {
      const value = String(v ?? '');
      if (value.includes(SENTINEL_MIGRATOR_PW) || value.includes(SENTINEL_OPS_PW) || /crewflow_migrator/.test(value)) fail(`${name}: ${k} carries a migration/ops credential`);
    }
    for (const k of [...MIGRATION_AUTHORITY, ...OPS_ONLY, ...LEGACY_DB]) {
      if (Object.prototype.hasOwnProperty.call(env, k)) fail(`${name}: sets ${k}`);
    }
    if (svc.depends_on?.['rab-migrate']) fail(`${name}: depends on rab-migrate (O3: there is none)`);
  }
  for (const [name, svc] of Object.entries(services)) {
    if (name !== 'rab-ops' && svc.depends_on?.['rab-ops']) fail(`${name}: depends on rab-ops`);
    if (name !== 'rab-ops' && envFiles(name).some((f) => baseName(f) === '.env.ops')) fail(`${name}: names .env.ops`);
  }
  return problems;
}

/**
 * Environment mode: every image resolved to an allowed repository@digest. Pure. `allowed`: application repositories.
 */
function checkResolvedImages(model, allowed = [DEFAULT_APP_REPOSITORY]) {
  const problems = [];
  const lines = [];
  for (const [name, svc] of Object.entries(model?.services ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    const ref = String(svc.image ?? '');
    const m = DIGEST_REF.exec(ref);
    lines.push(`${name}: ${ref || '(none)'}`);
    if (svc.build !== undefined) problems.push(`${name}: has a build section`);
    if (!m) {
      problems.push(`${name}: image "${ref}" is not repository@sha256:<64 hex>`);
      continue;
    }
    if (name !== 'rab-redis' && !allowed.includes(m[1].replace(/^docker\.io\//, ''))) {
      problems.push(`${name}: repository ${m[1]} is not an allowed release repository (${allowed.join(', ')})`);
    }
  }
  return { problems, lines };
}

/**
 * Environment mode: the DEPLOYED model (the variant + overrides, rendered with the real interpolation values) still holds
 * every control. Pure. Overrides may change only what the staging override changes: env files, ONE read-only bind of the
 * PostgreSQL CA at /run/crewflow/pg-ca.crt, STORAGE_KEY_PREFIX. `redisConf`: the text of the mounted Redis config, or null.
 * `envFileKeys`: { service: { names: [variable names], dbUsers: { VAR: login } } } read from the services' env files (names
 * and the login part of database URLs only, never a value), or omitted when the files are not readable here.
 */
function checkDeployment(merged, production, envFileKeys = {}) {
  const problems = [];
  const fail = (m) => problems.push(m);
  const services = merged?.services ?? {};
  // Credential isolation in the deployed model (the same rules checkVariant applies to the committed file).
  for (const name of ['rab-api', 'rab-worker']) {
    const svc = services[name];
    if (!svc) continue;
    const files = (svc.env_file ?? []).map((e) => baseName(typeof e === 'string' ? e : e.path));
    if (files.includes('.env.migrate') || files.includes('.env.ops')) fail(`${name}: names .env.migrate or .env.ops in the deployed model`);
    const fromFiles = envFileKeys[name]?.names ?? [];
    for (const k of [...MIGRATION_AUTHORITY, ...OPS_ONLY, ...LEGACY_DB]) {
      if (Object.prototype.hasOwnProperty.call(envOf(svc), k) || fromFiles.includes(k)) fail(`${name}: sets ${k} in the deployed model`);
    }
    if (Object.prototype.hasOwnProperty.call(envOf(svc), 'REDIS_URL')) fail(`${name}: REDIS_URL is committed in a compose file (enter it in the env file)`);
    for (const k of envFileKeys[name]?.unfilled ?? []) fail(`${name}: ${k} still holds a template <placeholder>`);
    for (const k of ['PG_DATABASE_URL', 'REDIS_URL']) {
      if (envFileKeys[name] && !fromFiles.includes(k)) fail(`${name}: ${k} is missing from its env file`);
    }
    for (const [k, login] of Object.entries(envFileKeys[name]?.dbUsers ?? {})) {
      if (login !== OWNER_LOGIN) fail(`${name}: ${k} logs in as "${login}" (allowed: ${OWNER_LOGIN})`);
    }
  }
  for (const name of ['rab-api', 'rab-worker']) {
    const a = services[name];
    const b = production?.services?.[name];
    if (!a || !b) {
      fail(`${name}: missing`);
      continue;
    }
    for (const key of RUNTIME_KEYS) {
      const value = key === 'volumes' ? withoutCa(a.volumes) : a[key];
      const expected = key === 'volumes' ? withoutCa(b.volumes) : b[key];
      if (stable(value) !== stable(expected)) fail(`${name}.${key} differs from docker-compose.production.yml in the deployed model`);
    }
    // The approval mode is the operator's compose.env opt-in (BC-11/C4): validated, not compared with the reference render.
    for (const key of PINNED_ENV.filter((k) => k !== 'STORAGE_KEY_PREFIX' && k !== 'CREWFLOW_MIGRATION_APPROVAL_MODE')) {
      if (stable(envOf(a)[key]) !== stable(envOf(b)[key])) fail(`${name}.environment.${key} is overridden in the deployed model`);
    }
    if (name === 'rab-api' && !['none', 'token'].includes(String(envOf(a).CREWFLOW_MIGRATION_APPROVAL_MODE ?? ''))) fail('rab-api: CREWFLOW_MIGRATION_APPROVAL_MODE is not none or token in the deployed model');
    if (envOf(a).CREWFLOW_RUNTIME_ISOLATION !== 'enforce') fail(`${name}: CREWFLOW_RUNTIME_ISOLATION is not "enforce" in the deployed model`);
    const deps = (s) => Object.fromEntries(Object.entries(s.depends_on ?? {}).map(([k, v]) => [k, v.condition]));
    if (stable(deps(a)) !== stable(deps(b))) fail(`${name}.depends_on differs from docker-compose.production.yml`);
    for (const p of a.ports ?? []) {
      if (!p.host_ip || p.host_ip === '0.0.0.0' || p.host_ip === '::') fail(`${name}: port ${p.target} is published on every interface (CREWFLOW_API_BIND)`);
    }
  }
  // O3: an override must not bring a release step back (a second migrating process next to the API).
  if (services['rab-migrate']) fail('rab-migrate: present in the deployed model (O3: the API migrates on start)');
  const fileNames = (svc) => (svc?.env_file ?? []).map((e) => baseName(typeof e === 'string' ? e : e.path));
  const ops = services['rab-ops'];
  if (ops) {
    if (ops.image !== services['rab-api']?.image) fail('rab-ops: image differs from rab-api\'s in the deployed model');
  }
  if (services['rab-worker'] && services['rab-worker'].image !== services['rab-api']?.image) fail('rab-worker: image differs from rab-api\'s in the deployed model (O2: one image)');
  if (ops) {
    if (stable(ops.profiles) !== stable(['ops'])) fail('rab-ops: not in (only) the "ops" profile in the deployed model');
    if (stable(fileNames(ops)) !== stable(['.env.ops'])) fail('rab-ops: must read .env.ops only in the deployed model');
    if (!ops.read_only || stable(ops.cap_drop) !== stable(['ALL']) || !(ops.security_opt ?? []).includes('no-new-privileges:true')) fail('rab-ops: not read-only / cap_drop ALL / no-new-privileges in the deployed model');
    if ((ops.ports ?? []).length) fail('rab-ops: publishes a port');
  }
  const redis = services['rab-redis'];
  if (redis) {
    if ((redis.ports ?? []).length) fail('rab-redis: publishes a port');
    if (!(redis.volumes ?? []).some((v) => v.target === '/run/secrets/redis-users.acl' && v.read_only)) fail('rab-redis: ACL file not mounted read-only');
    for (const pr of redisFlagProblems(redis, ' in the deployed model')) fail(pr);
    if (!redis.mem_limit) fail('rab-redis: no memory limit in the deployed model');
  }
  // Service-wide, as in the static mode: no privileged container, no host namespace, no Docker socket, no build.
  for (const [name, svc] of Object.entries(services)) {
    if (svc.privileged) fail(`${name}: privileged in the deployed model`);
    if (svc.network_mode === 'host' || svc.pid === 'host' || svc.ipc === 'host' || svc.userns_mode === 'host') fail(`${name}: host namespace in the deployed model`);
    if (svc.build !== undefined) fail(`${name}: has a build section in the deployed model`);
    for (const v of svc.volumes ?? []) {
      if (/docker\.sock/.test(String(v.source ?? '')) || /docker\.sock/.test(String(v.target ?? ''))) fail(`${name}: mounts the Docker socket in the deployed model`);
    }
    // The root launcher (and its SETUID/SETGID/KILL) is retired: no service adds a capability or a device.
    if ((svc.devices ?? []).length || (svc.cap_add ?? []).length) fail(`${name}: adds devices or capabilities in the deployed model`);
  }
  return problems;
}

function render(files, { projectDirectory, env, resolveEnvFiles }) {
  const args = ['compose', '-p', 'crewflow-image-verify', '--project-directory', projectDirectory, ...files.flatMap((f) => ['-f', f]),
    '--profile', 'ops', 'config', '--format', 'json', ...(resolveEnvFiles ? [] : ['--no-env-resolution'])];
  const out = execFileSync('docker', args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
  return JSON.parse(out);
}

/**
 * Marker variables planted in the sentinel env files. Compose versions render env_file differently: v5 keeps the env_file
 * entries under --no-env-resolution, while v2.38/v2.39 resolve the files even then and omit the key. A marker in the
 * RESOLVED environment proves which file a service really reads, whatever the Compose version.
 */
const ENV_FILE_MARKERS = Object.freeze({
  'database.env': 'CREWFLOW_VERIFY_FROM_DATABASE_ENV', 'runtime.env': 'CREWFLOW_VERIFY_FROM_RUNTIME_ENV',
  '.env.migrate': 'CREWFLOW_VERIFY_FROM_ENV_MIGRATE', '.env.ops': 'CREWFLOW_VERIFY_FROM_ENV_OPS',
});

/**
 * Normalises `files` (a --no-env-resolution render) in place: a service with no env_file entries, whose resolved
 * environment (in `resolved`) carries a sentinel file's marker, gets that file as its env_file. A service that does not read
 * a sentinel file gets nothing, so every "must read" check still fails for it. Entries Compose did report are kept.
 */
function attachEnvFilesFromMarkers(files, resolved, dir) {
  for (const [name, svc] of Object.entries(files?.services ?? {})) {
    if ((svc.env_file ?? []).length) continue;
    const env = resolved?.services?.[name]?.environment ?? {};
    const inferred = Object.entries(ENV_FILE_MARKERS).filter(([, marker]) => env[marker] !== undefined).map(([file]) => ({ path: path.join(dir, file), required: true }));
    if (inferred.length) svc.env_file = inferred;
  }
  return files;
}

/** Renders the three models checkVariant takes (throw-away project directory with sentinel env files). */
function renderModels(variantPath = VARIANT) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewflow-image-verify-'));
  try {
    // Owner login: the shared database.env and runtime.env in a sentinel secret directory. A separated-mode .env.migrate
    // (migrator sentinel) still exists in the project directory, so a file that names it renders and then fails.
    const secrets = path.join(dir, 'secrets');
    fs.mkdirSync(secrets);
    fs.writeFileSync(path.join(secrets, 'database.env'), `PG_DATABASE_URL=postgresql://${OWNER_LOGIN}:${SENTINEL_OWNER_PW}@db-direct.example:5432/rab?sslmode=verify-full\n${ENV_FILE_MARKERS['database.env']}=1\n`);
    fs.writeFileSync(path.join(secrets, 'runtime.env'), `APP_SECRET=sentinel-runtime\nREDIS_URL=${SENTINEL_RUNTIME_REDIS_URL}\n${ENV_FILE_MARKERS['runtime.env']}=1\n`);
    fs.writeFileSync(path.join(dir, '.env.migrate'), `PG_DATABASE_URL=postgresql://crewflow_migrator:${SENTINEL_MIGRATOR_PW}@db-direct.example:5432/rab?sslmode=verify-full\n${ENV_FILE_MARKERS['.env.migrate']}=1\n`);
    fs.writeFileSync(path.join(dir, '.env.ops'), `CREWFLOW_OPS_RUN=one-off\nPG_OPS_APP_DATABASE_URL=postgresql://crewflow_app:${SENTINEL_OPS_PW}@db-direct.example:5432/rab?sslmode=verify-full\n${ENV_FILE_MARKERS['.env.ops']}=1\n`);
    // Only what the files require; nothing inherited from this machine's CREWFLOW_* / DATABASE_* / REDIS_URL.
    const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CREWFLOW_|DATABASE_|REDIS_URL|PG_|COMPOSE_|DB_TARGET)/.test(k)));
    const env = {
      ...base,
      CREWFLOW_IMAGE_DIGEST: SENTINEL_DIGEST,
      CREWFLOW_REDIS_IMAGE: `redis@sha256:${'0c'.repeat(32)}`,
      CREWFLOW_SECRETS_DIR: secrets.split(path.sep).join('/'),
      CREWFLOW_PG_CA_FILE: '/etc/crewflow/pg-ca.crt',
    };
    const variant = render([variantPath], { projectDirectory: dir, env, resolveEnvFiles: true });
    const rawFiles = render([variantPath], { projectDirectory: dir, env, resolveEnvFiles: false });
    // Whether this Compose reports env_file under --no-env-resolution (rab-migrate declares one in the committed file).
    const composeReportsEnvFiles = (rawFiles.services?.['rab-migrate']?.env_file ?? []).length > 0;
    const variantFiles = attachEnvFilesFromMarkers(rawFiles, variant, dir);
    const production = render([PRODUCTION], { projectDirectory: dir, env, resolveEnvFiles: false });
    return { variant, production, variantFiles, composeReportsEnvFiles };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function staticMode() {
  const { variant, production, variantFiles } = renderModels();
  return checkVariant(variant, production, variantFiles);
}

function environmentMode(argv) {
  const many = (flag) => argv.flatMap((a, i) => (a === flag && argv[i + 1] ? [argv[i + 1]] : []));
  const files = [VARIANT, ...many('--compose').map((f) => path.resolve(f))];
  const projectDirectory = path.resolve(many('--project-directory')[0] ?? path.dirname(VARIANT));
  const envFileArgs = many('--env-file');
  const env = { ...process.env };
  for (const f of envFileArgs) {
    for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (m && !/^\s*#/.test(line)) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  const allowed = [DEFAULT_APP_REPOSITORY, ...many('--allow-repository')];
  for (const k of ['CREWFLOW_IMAGE_DIGEST']) {
    if (!DIGEST.test(String(env[k] ?? ''))) return { problems: [`${k} is not sha256:<64 hex>`], lines: [] };
  }
  // The env_file checks below need a Compose that reports env_file under --no-env-resolution (v5 does; v2.38/v2.39
  // resolve the files and drop the key). Probe it on the committed variant with marker files; refuse rather than skip.
  const probe = renderModels();
  if (!probe.composeReportsEnvFiles) {
    let version = 'unknown';
    try {
      version = execFileSync('docker', ['compose', 'version', '--short'], { encoding: 'utf8' }).trim();
    } catch {
      // keep "unknown"
    }
    return { problems: [`this Docker Compose (${version}) does not report env_file under --no-env-resolution, so the deployed model's credential isolation cannot be verified with it. Run the environment preflight with Docker Compose v5 (verified 5.6.1). Static mode is unaffected.`], lines: [] };
  }
  // Rendering without env_file resolution: the env files hold secrets and are not needed for these checks (compose gives
  // `environment:` precedence over env_file, so an env file cannot change a committed value such as the enforce mode).
  const model = render(files, { projectDirectory, env, resolveEnvFiles: false });
  const images = checkResolvedImages(model, allowed);
  const production = probe.production;
  // The runtime services' env files: variable NAMES, unfilled placeholders, and the login part of database URLs only.
  const envFileKeys = {};
  const skippedEnvFiles = [];
  for (const name of ['rab-api', 'rab-worker']) {
    const paths = (model.services?.[name]?.env_file ?? []).map((e) => (typeof e === 'string' ? e : e.path));
    if (!paths.length) {
      // G7: never skip these checks silently. Without an env file the service would also start without credentials.
      skippedEnvFiles.push(`${name}: no env_file in the deployed model, so its credential checks cannot run (the image compose names database.env and runtime.env)`);
      continue;
    }
    const entry = { names: [], unfilled: [], dbUsers: {} };
    for (const p of paths) {
      let text;
      try {
        text = fs.readFileSync(p, 'utf8');
      } catch {
        entry.unfilled.push(`(env file ${baseName(p)} not readable)`);
        continue;
      }
      for (const line of text.split(/\r?\n/)) {
        const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
        if (!m || /^\s*#/.test(line)) continue;
        entry.names.push(m[1]);
        if (/<[^>]*>/.test(m[2])) entry.unfilled.push(m[1]);
        if (/DATABASE_URL$/.test(m[1])) {
          try {
            entry.dbUsers[m[1]] = decodeURIComponent(new URL(m[2].replace(/^(['"])(.*)\1$/, '$2')).username);
          } catch {
            entry.unfilled.push(`${m[1]} (not a URL)`);
          }
        }
      }
    }
    envFileKeys[name] = entry;
  }
  return { problems: [...images.problems, ...skippedEnvFiles, ...checkDeployment(model, production, envFileKeys)], lines: images.lines };
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  try {
    execFileSync('docker', ['compose', 'version'], { stdio: 'ignore' });
  } catch {
    console.error('docker compose is not available');
    process.exit(2);
  }
  let result;
  try {
    result = argv.includes('--environment') ? environmentMode(argv) : { problems: staticMode(), lines: [] };
  } catch (e) {
    // compose's own message (e.g. a missing required variable); it names variables, never values.
    console.error(`render failed: ${String(e.stderr || e.message).trim().split('\n').slice(-3).join(' | ')}`);
    process.exit(1);
  }
  for (const l of result.lines) console.log(l);
  if (result.problems.length) {
    for (const p of result.problems) console.error(`FAIL ${p}`);
    process.exit(1);
  }
  console.log(argv.includes('--environment') ? 'OK: every image is an allowed repository pinned by digest, and the deployed model keeps every runtime control' : 'OK: docker-compose.image.yml is image-only, digest-pinned and keeps every H6 runtime key and the credential isolation');
}

module.exports = { checkVariant, checkResolvedImages, checkDeployment, DIGEST_REF, RUNTIME_KEYS, SENTINEL_MIGRATOR_PW, SENTINEL_OPS_PW, SENTINEL_OWNER_PW, renderModels, staticMode };
