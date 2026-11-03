#!/usr/bin/env node
'use strict';
/**
 * Verifies packages/rab-docker/docker-compose.image.yml, the image-based, digest-pinned variant of the production compose
 * file (owner decisions R1/R5, 2026-11-03). Two modes:
 *
 *   node packages/rab-docker/staging/verify-image-compose.cjs
 *     STATIC: renders the variant and docker-compose.production.yml with `docker compose config --format json` in a
 *     throw-away project directory (sentinel .env.migrate / .env.ops, dummy digests; no real .env of this machine is read)
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
  'PG_POOL_MAX_CONNECTIONS', 'WORKER_SCHEDULER'];
const MIGRATION_AUTHORITY = ['CREWFLOW_MIGRATION_APPROVED', 'CREWFLOW_MIGRATION_DATABASE_URL', 'CREWFLOW_MIGRATION_PHASE',
  'ALLOW_PRODUCTION_DB_COMMANDS', 'DATABASE_URL_UNPOOLED', 'CREWFLOW_DEPLOYMENT_IDENTITY_BOOTSTRAP',
  'CREWFLOW_BOOTSTRAP_PASSWORD', 'CREWFLOW_APP_BOOTSTRAP_PASSWORD'];
const OPS_ONLY = ['CREWFLOW_OPS_RUN', 'PG_OPS_APP_DATABASE_URL', 'CREWFLOW_OPS_ACTOR_SOURCE', 'CREWFLOW_OPS_ACTOR_ID', 'CREWFLOW_OPS_CHANGE_REF'];
const LEGACY_DB = ['DATABASE_URL', 'DATABASE_DIRECT_URL', 'DB_POOL_MAX'];

const SENTINEL_MIGRATOR_PW = 'SENTINEL-IMAGE-MIGRATOR-PW-5b1e'; // gitleaks:allow (synthetic marker planted by this check)
const SENTINEL_OPS_PW = 'SENTINEL-IMAGE-OPS-PW-93ad'; // gitleaks:allow (synthetic marker planted by this check)
const SENTINEL_DIGEST = `sha256:${'5e'.repeat(32)}`;

const stable = (v) => JSON.stringify(v ?? null, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));
const envOf = (svc) => svc?.environment ?? {};
const baseName = (p) => String(p).split(/[\\/]/).pop();

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
  const expected = ['rab-api', 'rab-migrate', 'rab-ops', 'rab-redis', 'rab-worker'];
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
  if (services['rab-worker'] && services['rab-worker'].image === apiImage) fail('rab-worker: uses the API image (the Worker bundle is a separate image)');

  // 2. Every H6 runtime key identical to the production file.
  for (const name of ['rab-api', 'rab-worker']) {
    const a = services[name];
    const b = production?.services?.[name];
    if (!a || !b) {
      fail(`${name}: missing in ${a ? 'docker-compose.production.yml' : 'the variant'}`);
      continue;
    }
    for (const key of RUNTIME_KEYS) {
      if (stable(a[key]) !== stable(b[key])) fail(`${name}.${key} differs from docker-compose.production.yml: ${stable(a[key])} vs ${stable(b[key])}`);
    }
    for (const key of PINNED_ENV) {
      if (stable(envOf(a)[key]) !== stable(envOf(b)[key])) fail(`${name}.environment.${key} differs from docker-compose.production.yml`);
    }
    // depends_on: same services and conditions (the production file's, without build-only additions).
    const deps = (s) => Object.fromEntries(Object.entries(s.depends_on ?? {}).map(([k, v]) => [k, v.condition]));
    if (stable(deps(a)) !== stable(deps(b))) fail(`${name}.depends_on differs from docker-compose.production.yml: ${stable(deps(a))} vs ${stable(deps(b))}`);
    // 3. Fail-closed isolation.
    if (envOf(a).CREWFLOW_RUNTIME_ISOLATION !== 'enforce') fail(`${name}: CREWFLOW_RUNTIME_ISOLATION is not "enforce"`);
    // 4. Infrastructure hardening: REDIS_URL is never committed (it carries the ACL password).
    if (Object.prototype.hasOwnProperty.call(envOf(a), 'REDIS_URL')) fail(`${name}: REDIS_URL is committed (enter it from the secret store)`);
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
    if (!vols.some((v) => v.target === '/usr/local/etc/redis/redis.conf' && v.read_only)) fail('rab-redis: config file not mounted read-only');
    if (stable(redis.command) !== stable(['redis-server', '/usr/local/etc/redis/redis.conf'])) fail('rab-redis: not started from the reviewed config file');
    if (!redis.mem_limit) fail('rab-redis: no memory limit');
  }

  // 7. Credential isolation (same rules as scripts/compose-credential-isolation.cjs for the production file).
  const migrate = services['rab-migrate'];
  if (migrate) {
    if (!envFiles('rab-migrate').some((f) => baseName(f) === '.env.migrate')) fail('rab-migrate: does not read .env.migrate');
    if (!String(envOf(migrate).PG_DATABASE_URL ?? '').includes(SENTINEL_MIGRATOR_PW)) fail('rab-migrate: the .env.migrate credential does not reach it');
    if (migrate.restart !== 'no') fail('rab-migrate: restart is not "no"');
    if ((migrate.profiles ?? []).length) fail('rab-migrate: has a profile (it must run on every up)');
    if (!/deploy-prepare\.js$/.test(stable(migrate.command).replace(/"\]$/, ''))) fail('rab-migrate: does not run deploy-prepare.js');
    if (envOf(migrate).DB_TARGET !== 'production') fail('rab-migrate: DB_TARGET is not production');
    if (!migrate.read_only || stable(migrate.cap_drop) !== stable(['ALL']) || !(migrate.security_opt ?? []).includes('no-new-privileges:true')) fail('rab-migrate: not read-only / cap_drop ALL / no-new-privileges');
    if (!(migrate.volumes ?? []).some((v) => v.type === 'tmpfs' && v.target === '/tmp')) fail('rab-migrate: the long-form tmpfs /tmp (OpenShip import guard) is missing');
  }
  const ops = services['rab-ops'];
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
    const env = envOf(svc);
    for (const [k, v] of Object.entries(env)) {
      const value = String(v ?? '');
      if (value.includes(SENTINEL_MIGRATOR_PW) || value.includes(SENTINEL_OPS_PW) || /crewflow_migrator/.test(value)) fail(`${name}: ${k} carries a migration/ops credential`);
    }
    for (const k of [...MIGRATION_AUTHORITY, ...OPS_ONLY, ...LEGACY_DB]) {
      if (Object.prototype.hasOwnProperty.call(env, k)) fail(`${name}: sets ${k}`);
    }
    if (svc.depends_on?.['rab-migrate']?.condition !== 'service_completed_successfully') fail(`${name}: does not wait for rab-migrate (service_completed_successfully)`);
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
 */
function checkDeployment(merged, production, redisConf) {
  const problems = [];
  const fail = (m) => problems.push(m);
  const services = merged?.services ?? {};
  const caMount = (v) => v.type === 'bind' && v.target === '/run/crewflow/pg-ca.crt' && v.read_only === true;
  for (const name of ['rab-api', 'rab-worker']) {
    const a = services[name];
    const b = production?.services?.[name];
    if (!a || !b) {
      fail(`${name}: missing`);
      continue;
    }
    for (const key of RUNTIME_KEYS) {
      const value = key === 'volumes' ? (a.volumes ?? []).filter((v) => !caMount(v)) : a[key];
      const expected = key === 'volumes' ? b.volumes ?? [] : b[key];
      if (stable(key === 'volumes' && !value.length ? undefined : value) !== stable(key === 'volumes' && !expected.length ? undefined : expected)) {
        fail(`${name}.${key} differs from docker-compose.production.yml in the deployed model`);
      }
    }
    for (const key of PINNED_ENV.filter((k) => k !== 'STORAGE_KEY_PREFIX')) {
      if (stable(envOf(a)[key]) !== stable(envOf(b)[key])) fail(`${name}.environment.${key} is overridden in the deployed model`);
    }
    if (envOf(a).CREWFLOW_RUNTIME_ISOLATION !== 'enforce') fail(`${name}: CREWFLOW_RUNTIME_ISOLATION is not "enforce" in the deployed model`);
    const deps = (s) => Object.fromEntries(Object.entries(s.depends_on ?? {}).map(([k, v]) => [k, v.condition]));
    if (stable(deps(a)) !== stable(deps(b))) fail(`${name}.depends_on differs from docker-compose.production.yml`);
    for (const p of a.ports ?? []) {
      if (!p.host_ip || p.host_ip === '0.0.0.0' || p.host_ip === '::') fail(`${name}: port ${p.target} is published on every interface (CREWFLOW_API_BIND)`);
    }
  }
  const migrate = services['rab-migrate'];
  if (!migrate || !migrate.read_only || stable(migrate.cap_drop) !== stable(['ALL']) || !(migrate.security_opt ?? []).includes('no-new-privileges:true')) fail('rab-migrate: not read-only / cap_drop ALL / no-new-privileges in the deployed model');
  if (migrate && !(migrate.volumes ?? []).some((v) => v.type === 'tmpfs' && v.target === '/tmp')) fail('rab-migrate: the long-form tmpfs /tmp (OpenShip import guard) is missing');
  const redis = services['rab-redis'];
  if (redis) {
    if ((redis.ports ?? []).length) fail('rab-redis: publishes a port');
    if (!(redis.volumes ?? []).some((v) => v.target === '/run/secrets/redis-users.acl' && v.read_only)) fail('rab-redis: ACL file not mounted read-only');
  }
  if (redisConf === null) {
    fail('rab-redis: the mounted config file cannot be read on this host');
  } else {
    const lines = redisConf.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    if (!lines.includes('aclfile /run/secrets/redis-users.acl')) fail('rab-redis config: no `aclfile /run/secrets/redis-users.acl`');
    if (!lines.includes('maxmemory-policy noeviction')) fail('rab-redis config: maxmemory-policy is not noeviction');
    if (!lines.includes('appendonly yes')) fail('rab-redis config: AOF is not on');
    if (lines.some((l) => /^user\s+default\s+.*\bon\b/.test(l) || /^requirepass\b/.test(l))) fail('rab-redis config: enables the default user or requirepass (use the ACL file)');
  }
  return problems;
}

function render(files, { projectDirectory, env, resolveEnvFiles }) {
  const args = ['compose', '-p', 'crewflow-image-verify', '--project-directory', projectDirectory, ...files.flatMap((f) => ['-f', f]),
    '--profile', 'ops', 'config', '--format', 'json', ...(resolveEnvFiles ? [] : ['--no-env-resolution'])];
  const out = execFileSync('docker', args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
  return JSON.parse(out);
}

/** Renders the three models checkVariant takes (throw-away project directory with sentinel env files). */
function renderModels() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewflow-image-verify-'));
  try {
    fs.writeFileSync(path.join(dir, '.env.migrate'), `PG_DATABASE_URL=postgresql://crewflow_migrator:${SENTINEL_MIGRATOR_PW}@db-direct.example:5432/rab?sslmode=verify-full\n`);
    fs.writeFileSync(path.join(dir, '.env.ops'), `CREWFLOW_OPS_RUN=one-off\nPG_OPS_APP_DATABASE_URL=postgresql://crewflow_app:${SENTINEL_OPS_PW}@db-direct.example:5432/rab?sslmode=verify-full\n`);
    // Only what the files require; nothing inherited from this machine's CREWFLOW_* / DATABASE_* / REDIS_URL.
    const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CREWFLOW_|DATABASE_|REDIS_URL|PG_|COMPOSE_|DB_TARGET)/.test(k)));
    const env = {
      ...base,
      CREWFLOW_API_IMAGE_DIGEST: SENTINEL_DIGEST,
      CREWFLOW_WORKER_IMAGE_DIGEST: `sha256:${'7a'.repeat(32)}`,
      CREWFLOW_REDIS_IMAGE: `redis@sha256:${'0c'.repeat(32)}`,
      CREWFLOW_SECRETS_DIR: '/etc/crewflow/secrets',
      CREWFLOW_BOOTSTRAP_PASSWORD: 'dummy',
    };
    const variant = render([VARIANT], { projectDirectory: dir, env, resolveEnvFiles: true });
    const variantFiles = render([VARIANT], { projectDirectory: dir, env, resolveEnvFiles: false });
    const production = render([PRODUCTION], { projectDirectory: dir, env, resolveEnvFiles: false });
    return { variant, production, variantFiles };
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
  for (const k of ['CREWFLOW_API_IMAGE_DIGEST', 'CREWFLOW_WORKER_IMAGE_DIGEST']) {
    if (!DIGEST.test(String(env[k] ?? ''))) return { problems: [`${k} is not sha256:<64 hex>`], lines: [] };
  }
  // Rendering without env_file resolution: the env files hold secrets and are not needed for these checks (compose gives
  // `environment:` precedence over env_file, so an env file cannot change a committed value such as the enforce mode).
  const model = render(files, { projectDirectory, env, resolveEnvFiles: false });
  const images = checkResolvedImages(model, allowed);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewflow-image-verify-'));
  let production;
  try {
    production = render([PRODUCTION], { projectDirectory: dir, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }, resolveEnvFiles: false });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const confSource = (model.services?.['rab-redis']?.volumes ?? []).find((v) => v.target === '/usr/local/etc/redis/redis.conf')?.source;
  let redisConf = null;
  try {
    redisConf = confSource ? fs.readFileSync(confSource, 'utf8') : null;
  } catch {
    redisConf = null;
  }
  return { problems: [...images.problems, ...checkDeployment(model, production, redisConf)], lines: images.lines };
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

module.exports = { checkVariant, checkResolvedImages, checkDeployment, DIGEST_REF, RUNTIME_KEYS, SENTINEL_MIGRATOR_PW, SENTINEL_OPS_PW, renderModels, staticMode };
