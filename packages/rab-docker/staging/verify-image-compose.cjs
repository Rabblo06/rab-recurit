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
 *     throw-away project directory (sentinel database.env / runtime.env, and the retired .env.migrate / .env.ops so a file
 *     that still names them renders and then fails; dummy digests; no real .env is read) and checks the rendered models
 *     (checkVariant below). rab-ops removal (PR 2): there is no rab-ops service; one by that name or under the "ops"
 *     profile, a service naming .env.ops, or a PG_OPS_* / CREWFLOW_OPS_* name on rab-api / rab-worker fails. The OpenShip
 *     import guard (the one long-form tmpfs) is on rab-api, in the variant only.
 *
 *   node packages/rab-docker/staging/verify-image-compose.cjs --environment [--env-file <file>]... [--compose <extra file>]...
 *          [--project-directory <dir>] [--allow-repository <repo>]...
 *     ENVIRONMENT: the operator's preflight on the deployment host. Renders the variant (plus any override, e.g.
 *     staging/docker-compose.staging.yml) with the REAL interpolation environment (process env + --env-file) and checks
 *     that every image resolved to repository@sha256:<64 hex> from an allowed repository (default adhin007/adolphus for
 *     the application images; Redis: any repository, digest required). Prints image references and check names only.
 *
 * DB-SETUP (database setup like Twenty, owner decisions D1 a / D3 / D4 / D5): both files carry the bundled database `db`,
 * and its definition (image, entrypoint, command, environment, volumes, network, health check and every H6 key) must be
 * IDENTICAL in the two files. PR #125 option 2: PG_DATABASE_URL is the ONE database setting (an admin URL, an existing
 * crewflow_owner URL, or unset = the bundled db), committed ONLY on the one-shot db-setup service as
 * ${PG_DATABASE_URL:-<the bundled db>} (compose.env); db-setup's runtime keys, volumes and depends_on are identical in the
 * two files. rab-api and rab-worker pin PG_DATABASE_URL to the literal empty string (never a URL, the crewflow_owner one
 * included) and hold no postgres:// value anywhere in their definition (they read db-setup's target volume, read-only).
 * It must never come from an env file; in the deployed model db-setup's URL must be verify-full and never a former
 * separated login (T-1 accepts a provider admin login). Only the login part of the URL is ever read.
 *
 * Exit 0 = every check passed, 1 = a check failed, 2 = usage error or docker compose unavailable.
 * Never prints an environment value other than image references (which are not secrets).
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '../../..');
// The bundled db's environment rules, one definition for the committed and the deployed model (PR #125 review, finding 6).
const { bundledDbEnvironmentProblems, credentialMountProblems } = require('../scripts/compose-owner-login.cjs');
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
  // Security review L3: other ways to mount or shadow files (db-setup's password volume included).
  'volumes_from', 'secrets', 'configs',
];
/** Committed environment keys that must keep the production file's value on rab-api / rab-worker. */
const PINNED_ENV = ['NODE_ENV', 'RAB_RUNTIME_ENV', 'AI_ENABLED', 'HWS_RUNTIME_ENABLED', 'STORAGE_DRIVER', 'STORAGE_KEY_PREFIX',
  'S3_FORCE_PATH_STYLE', 'S3_SERVER_SIDE_ENCRYPTION', 'CREWFLOW_PROVISIONER_ENABLED', 'WORKSPACE_PROVISIONER_INTERVAL_SECONDS',
  'PG_POOL_MAX_CONNECTIONS', 'WORKER_SCHEDULER', 'CREWFLOW_MIGRATE_ON_START', 'CREWFLOW_MIGRATION_APPROVAL_MODE',
  'CREWFLOW_UPGRADE_FAILURE_POLICY', 'CREWFLOW_UPGRADE_FAILURE', 'DISABLE_DB_MIGRATIONS', 'DISABLE_CRON_JOBS_REGISTRATION',
  'CREWFLOW_WORKER_SCHEMA_WAIT_SECONDS', 'WORKER_FAST_PUBLISH_NOTIFY', 'WORKER_EMAIL_DISPATCH_INTERVAL_SECONDS',
  'WORKER_TIMER_TRIGGERS', 'WORKER_TIMER_TRIGGER_KINDS', 'WORKER_OFFER_EXPIRY_INTERVAL_SECONDS',
  'WORKER_MANAGER_CONFIRMATION_TIMEOUT_INTERVAL_SECONDS', 'WORKER_LATE_CLOCK_IN_INTERVAL_SECONDS',
  'WORKER_SHIFT_MONITOR_INTERVAL_SECONDS', 'WORKER_SHIFT_SCAN_MODE', 'WORKER_SHIFT_STATEMENT_DISPATCH_INTERVAL_SECONDS'];
/**
 * Notification delivery (owner decision 2026-11-06): committed on rab-api AND rab-worker with exactly these values, in both
 * compose files (PINNED_ENV alone would accept the two files drifting together). The API registers the email scheduler with
 * its own interval and the consume-only Worker never compares intervals, so the two services must agree.
 */
const NOTIFICATION_DELIVERY = Object.freeze({ WORKER_FAST_PUBLISH_NOTIFY: 'true', WORKER_EMAIL_DISPATCH_INTERVAL_SECONDS: '30' });
/**
 * Phase D switches (owner decision 2026-11-06): timer triggers on for all four (listed) kinds and the safety-sweep
 * intervals, committed on rab-api AND rab-worker with exactly these values in both compose files, for the same reason as
 * the email sweep. The shift monitor and the combined-scan mode stay at the code default: never committed otherwise.
 * Mirrors PHASE_D_SWITCHES / PHASE_D_UNCHANGED in scripts/compose-owner-login.cjs (a test asserts the two agree).
 */
const PHASE_D_SWITCHES = Object.freeze({
  WORKER_TIMER_TRIGGERS: 'on',
  WORKER_TIMER_TRIGGER_KINDS: 'offer-expiry,manager-confirmation,no-show,late-clock-in',
  WORKER_OFFER_EXPIRY_INTERVAL_SECONDS: '300',
  WORKER_MANAGER_CONFIRMATION_TIMEOUT_INTERVAL_SECONDS: '120',
  WORKER_LATE_CLOCK_IN_INTERVAL_SECONDS: '300',
});
const PHASE_D_UNCHANGED = Object.freeze({ WORKER_SHIFT_MONITOR_INTERVAL_SECONDS: '300', WORKER_SHIFT_SCAN_MODE: 'separate' });
/**
 * Pay-statement dispatch sweep (owner decision 2026-11-11, Phase X J1a): 30 s, committed on rab-api AND rab-worker with
 * exactly this value in both compose files, for the same reason as the email sweep. Mirrors STATEMENT_DISPATCH in
 * scripts/compose-owner-login.cjs (a test asserts the two agree).
 */
const STATEMENT_DISPATCH = Object.freeze({ WORKER_SHIFT_STATEMENT_DISPATCH_INTERVAL_SECONDS: '30' });
/**
 * Phase X J2 (S0-J SJ-03): once PUSH_ENABLED / REALTIME_ENABLED is on, the sweep rule applies. Push: 30 s committed on
 * rab-api AND rab-worker (owner rule 2026-11-06). Realtime: no owner value yet, so only "identical on both" (`value: null`).
 * The switch must be the same on both services, and neither interval may come from an env file. Mirrors FEATURE_SWEEPS in
 * scripts/compose-owner-login.cjs (a test asserts the two agree).
 */
const FEATURE_SWEEPS = Object.freeze({
  PUSH_ENABLED: Object.freeze({ key: 'WORKER_PUSH_DISPATCH_INTERVAL_SECONDS', value: '30', decision: 'owner rule 2026-11-06' }),
  REALTIME_ENABLED: Object.freeze({ key: 'WORKER_REALTIME_OUTBOX_PUBLISH_INTERVAL_SECONDS', value: null, decision: 'value not yet decided by the owner' }),
});
const switchedOn = (v) => String(v ?? '') === 'true';
/** The only values a feature switch may carry (after Compose's own normalisation); anything else is refused (fail closed). */
const SWITCH_VALUES = Object.freeze(['true', 'false']);
/**
 * The value Docker Compose gives a service for one env-file value (review J2-1): quoted → the text between the quotes
 * (then only blanks or a `#` comment); unquoted → everything before the first blank-then-`#`, trimmed. null when ambiguous
 * (unterminated quote, text after the closing quote). Mirrors composeEnvValue in scripts/compose-owner-login.cjs.
 */
function composeEnvValue(raw) {
  const v = String(raw ?? '').trim();
  const q = v[0];
  if (q === '"' || q === "'") {
    const end = v.indexOf(q, 1);
    if (end < 0) return null;
    const rest = v.slice(end + 1).trim();
    return rest === '' || rest.startsWith('#') ? v.slice(1, end) : null;
  }
  const comment = v.search(/\s#/);
  return (comment >= 0 ? v.slice(0, comment) : v).trim();
}
/**
 * One env file's text → what environment mode may know of it: variable NAMES, unfilled placeholders, the login part of
 * database URLs and the two non-secret feature switches (Phase X J2), never another value. Lines are read as Compose reads
 * them: an optional `export ` prefix (review J2-2), quotes and inline ` #` comments (J2-1). A switch Compose would read
 * ambiguously is recorded as null, which the rule refuses. `entry` accumulates over a service's files.
 */
function readEnvFileKeys(text, entry = { names: [], unfilled: [], dbUsers: {}, switches: {} }) {
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || /^\s*#/.test(line)) continue;
    entry.names.push(m[1]);
    const value = composeEnvValue(m[2]);
    if (Object.hasOwn(FEATURE_SWEEPS, m[1])) entry.switches[m[1]] = value;
    if (/<[^>]*>/.test(m[2])) entry.unfilled.push(m[1]);
    if (/DATABASE_URL$/.test(m[1])) {
      try {
        entry.dbUsers[m[1]] = decodeURIComponent(new URL(value ?? '').username);
      } catch {
        entry.unfilled.push(`${m[1]} (not a URL)`);
      }
    }
  }
  return entry;
}
/** The J2 rule on the two service environments plus each service's switch values (from the model or its env files). */
function featureSweepProblems(apiEnv, workerEnv, switches = {}, where = '') {
  const problems = [];
  for (const [flag, rule] of Object.entries(FEATURE_SWEEPS)) {
    // Fail closed (review J2-1): whatever the service receives must be exactly true or false (null = unreadable).
    for (const name of ['rab-api', 'rab-worker']) {
      const env = name === 'rab-api' ? apiEnv : workerEnv;
      const v = env?.[flag] !== undefined ? env[flag] : (Object.hasOwn(switches[name] ?? {}, flag) ? switches[name][flag] : undefined);
      if (v !== undefined && !SWITCH_VALUES.includes(String(v))) problems.push(`${name}: ${flag} must be exactly true or false${where}`);
    }
    const on = (name, env) => switchedOn(env?.[flag] ?? switches[name]?.[flag]);
    const apiOn = on('rab-api', apiEnv);
    const workerOn = on('rab-worker', workerEnv);
    if (apiOn !== workerOn) problems.push(`${flag} differs between rab-api and rab-worker${where}`);
    if (!apiOn && !workerOn) continue;
    if (rule.value !== null) {
      for (const [name, env] of [['rab-api', apiEnv], ['rab-worker', workerEnv]]) {
        if (String(env?.[rule.key] ?? '') !== rule.value) problems.push(`${name}: ${flag}=true needs ${rule.key}="${rule.value}" committed${where} (${rule.decision})`);
      }
    } else if (String(apiEnv?.[rule.key] ?? '') !== String(workerEnv?.[rule.key] ?? '')) {
      problems.push(`${flag}=true: ${rule.key} differs between rab-api and rab-worker${where}`);
    }
  }
  return problems;
}
const MIGRATION_AUTHORITY = ['CREWFLOW_MIGRATION_APPROVED', 'CREWFLOW_MIGRATION_DATABASE_URL', 'CREWFLOW_MIGRATION_PHASE',
  'ALLOW_PRODUCTION_DB_COMMANDS', 'DATABASE_URL_UNPOOLED', 'CREWFLOW_DEPLOYMENT_IDENTITY_BOOTSTRAP',
  'CREWFLOW_BOOTSTRAP_PASSWORD', 'CREWFLOW_APP_BOOTSTRAP_PASSWORD', 'CREWFLOW_WORKER_BOOTSTRAP_PASSWORD', 'CREWFLOW_MIGRATOR_PASSWORD',
  // Owner login: no second database identity and no mode switch on any service.
  'CREWFLOW_PROVISIONER_DATABASE_URL', 'PG_WORKER_DATABASE_URL', 'CREWFLOW_PRESTART_MIGRATION_DATABASE_URL', 'DB_TARGET',
  'CREWFLOW_DB_MODE'];
/** The one runtime login. */
const OWNER_LOGIN = 'crewflow_owner';
/**
 * DB-SETUP T-1: PG_DATABASE_URL is the database ADMIN URL (or crewflow_owner, passed through). Still never one of the former
 * separated logins / schema roles (mirrors NOT_THE_APP_LOGIN in scripts/compose-owner-login.cjs; a test asserts the two agree).
 */
const NOT_THE_APP_LOGIN = Object.freeze(['crewflow', 'crewflow_app', 'crewflow_worker', 'crewflow_migrator', 'rab_owner', 'rab_secure_owner', 'rab_app']);
/** DB-SETUP: the bundled database service; its whole definition must be identical in the two compose files. */
const DB_SERVICE = 'db';
/**
 * DB-SETUP PID 1 (lead decision 2026-11-12): each app service's ENTRYPOINT is its cleaning script (PID 1), which execs the
 * image's tini only once the environment is clean; no command, no compose init (docker-init at PID 1 keeps the admin URL).
 */
const PID1_ENTRYPOINTS = Object.freeze({ 'rab-api': './api-prestart.sh', 'rab-worker': './worker-start.sh', 'db-setup': './db-setup.sh' });
/** PR #125 options A and 2: the one-shot setup service (the only service with PG_DATABASE_URL) and its target volume. */
const DB_SETUP_SERVICE = 'db-setup';
const DB_TARGET_VOLUME = 'crewflow-db-target';
const DB_TARGET_DIR = '/run/crewflow/db-target';
/** db-setup keys that must be identical in the two files (besides RUNTIME_KEYS; the image differs only by its default). */
const DB_SETUP_KEYS = [...RUNTIME_KEYS, 'networks', 'ports', 'profiles', 'build'];
const isPgUrlText = (v) => /postgres(ql)?:\/\//i.test(String(v ?? ''));
/**
 * Option 2, both models: rab-api / rab-worker pin PG_DATABASE_URL to the literal empty string (any value, a crewflow_owner
 * URL included, is refused) and nothing in their definition holds a postgres:// value; they mount the target volume
 * read-only. db-setup mounts it writable, restart "no", rab-api waits for it.
 */
function optionAProblems(services, where = '') {
  const out = [];
  for (const name of ['rab-api', 'rab-worker']) {
    const svc = services[name];
    if (!svc) continue;
    // Option 2: pinned empty (the crewflow_owner URL comes from db-setup's target file); never a URL, crewflow_owner included.
    const url = envOf(svc).PG_DATABASE_URL;
    if (url === undefined) out.push(`${name}: PG_DATABASE_URL is not pinned to ""${where} (an env-file value would reach it)`);
    else if (String(url) !== '') out.push(`${name}: PG_DATABASE_URL is not empty${where} (option 2: only db-setup receives a database URL, in any form)`);
    if (isPgUrlText(JSON.stringify(svc))) out.push(`${name}: holds a postgres:// value somewhere in its definition${where} (option 2: never)`);
    if (!(svc.volumes ?? []).some((v) => v.type === 'volume' && v.source === DB_TARGET_VOLUME && v.target === DB_TARGET_DIR && v.read_only === true)) out.push(`${name}: does not mount db-setup's target volume read-only${where}`);
  }
  const setup = services[DB_SETUP_SERVICE];
  if (!setup) out.push(`${DB_SETUP_SERVICE}: missing${where} (option 2: the only service with PG_DATABASE_URL)`);
  else {
    if (setup.restart !== 'no') out.push(`${DB_SETUP_SERVICE}: restart is not "no"${where} (a one-shot)`);
    if ((setup.ports ?? []).length) out.push(`${DB_SETUP_SERVICE}: publishes a port${where}`);
    if (!(setup.volumes ?? []).some((v) => v.type === 'volume' && v.source === DB_TARGET_VOLUME && v.target === DB_TARGET_DIR && v.read_only !== true)) out.push(`${DB_SETUP_SERVICE}: does not mount the target volume writable${where}`);
    const deps = setup.depends_on ?? {};
    if (stable(Object.keys(deps)) !== stable([DB_SERVICE]) || deps[DB_SERVICE]?.condition !== 'service_healthy') out.push(`${DB_SETUP_SERVICE}: depends_on must be exactly a healthy ${DB_SERVICE}${where}`);
    if (setup.image !== services['rab-api']?.image) out.push(`${DB_SETUP_SERVICE}: image differs from rab-api's${where} (O2: one image)`);
    // Twenty Helm model (OWNER-DB-FINAL.md Part A): APP_SECRET is never part of a database credential; db-setup never has it.
    if (Object.prototype.hasOwnProperty.call(envOf(setup), 'APP_SECRET')) out.push(`${DB_SETUP_SERVICE}: has APP_SECRET${where} (never part of a database credential)`);
  }
  if (services['rab-api']?.depends_on?.[DB_SETUP_SERVICE]?.condition !== 'service_completed_successfully') out.push(`rab-api: does not wait for ${DB_SETUP_SERVICE} (service_completed_successfully)${where}`);
  for (const [name, svc] of Object.entries(services)) {
    if (!['rab-api', 'rab-worker', DB_SETUP_SERVICE].includes(name) && (svc.volumes ?? []).some((v) => v.source === DB_TARGET_VOLUME)) out.push(`${name}: mounts db-setup's target volume${where}`);
    // The crewflow_owner password file lives on that volume: nothing else may be mounted at (or under) its path.
    for (const v of svc.volumes ?? []) {
      const t = String(v.target ?? '');
      if ((t === DB_TARGET_DIR || t.startsWith(`${DB_TARGET_DIR}/`)) && !(v.type === 'volume' && v.source === DB_TARGET_VOLUME && ['rab-api', 'rab-worker', DB_SETUP_SERVICE].includes(name))) {
        out.push(`${name}: mounts something at ${t}${where} (db-setup's volume holds the crewflow_owner password file)`);
      }
    }
    if (name !== DB_SETUP_SERVICE && Object.prototype.hasOwnProperty.call(envOf(svc), 'PG_DATABASE_URL') && !['rab-api', 'rab-worker'].includes(name)) out.push(`${name}: has PG_DATABASE_URL${where} (only db-setup; rab-api / rab-worker pin it empty)`);
  }
  return out;
}
const hasCommand = (svc) => (Array.isArray(svc?.command) ? svc.command.length > 0 : svc?.command !== undefined && svc?.command !== null);
function pid1Problems(services, where = '') {
  const out = [];
  for (const [name, script] of Object.entries(PID1_ENTRYPOINTS)) {
    const svc = services[name];
    if (!svc) continue;
    if (stable(svc.entrypoint) !== stable([script])) out.push(`${name}: entrypoint is not exactly ${script}${where} (DB-SETUP PID 1)`);
    if (hasCommand(svc)) out.push(`${name}: has a command${where} (${script}, the entrypoint, takes none)`);
    if (svc.init === true) out.push(`${name}: init: true${where} (docker-init would be PID 1 with the admin URL)`);
  }
  return out;
}
const DB_KEYS = [...RUNTIME_KEYS, 'image', 'environment', 'networks', 'ports', 'stop_signal', 'depends_on', 'profiles', 'env_file', 'build'];
const OPS_ONLY = ['CREWFLOW_OPS_RUN', 'PG_OPS_APP_DATABASE_URL', 'CREWFLOW_OPS_ACTOR_SOURCE', 'CREWFLOW_OPS_ACTOR_ID', 'CREWFLOW_OPS_CHANGE_REF'];
const LEGACY_DB = ['DATABASE_URL', 'DATABASE_DIRECT_URL', 'DB_POOL_MAX'];

const SENTINEL_MIGRATOR_PW = 'SENTINEL-IMAGE-MIGRATOR-PW-5b1e'; // gitleaks:allow (synthetic marker planted by this check)
const SENTINEL_OPS_PW = 'SENTINEL-IMAGE-OPS-PW-93ad'; // gitleaks:allow (synthetic marker planted by this check)
const SENTINEL_OWNER_PW = 'SENTINEL-IMAGE-OWNER-PW-c41d'; // gitleaks:allow (synthetic marker planted by this check)
const SENTINEL_RUNTIME_REDIS_URL = 'redis://crewflow:sentinel-runtime-c41d@rab-redis:6379'; // gitleaks:allow (synthetic)
const SENTINEL_DIGEST = `sha256:${'5e'.repeat(32)}`;
/**
 * Interpolation values for docker-compose.production.yml's REQUIRED list (x-crewflow-required-env, `${KEY:?}`; owner request
 * 2026-11-12: OpenShip shows every variable), so the reference model renders. Dummies, never secrets. The variant reads
 * these names from its env files (an interpolation value never reaches an env_file entry).
 */
const PRODUCTION_REQUIRED_DUMMIES = Object.freeze({
  // DB-SETUP: the bundled db's superuser password (both files' db require it; db-setup's default admin URL is built from it).
  PG_DATABASE_PASSWORD: 'dummy-production-required-db-password-0000',
  APP_SECRET: 'dummy-production-required-app-secret',
  APP_URL: 'https://app.example.com',
  ACCOUNTS_URL: 'https://app.example.com',
  CORS_ORIGINS: 'https://app.example.com',
  TRUSTED_PROXY_CIDRS: '10.0.0.1/32',
  EMAIL_DRIVER: 'SMTP',
  S3_BUCKET: 'dummy',
  S3_REGION: 'auto',
  S3_ENDPOINT: 'https://s3.example.com',
  S3_ACCESS_KEY_ID: 'dummy',
  S3_SECRET_ACCESS_KEY: 'dummy',
  CREWFLOW_AUDIT_SINK: 'stdout',
});

const stable = (v) => JSON.stringify(v ?? null, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));
const envOf = (svc) => svc?.environment ?? {};
const baseName = (p) => String(p).split(/[\\/]/).pop();
/** The one bind every app service has: the PostgreSQL CA, read-only (verify-full). */
const caMount = (v) => v.type === 'bind' && v.target === '/run/crewflow/pg-ca.crt' && v.read_only === true;
const withoutCa = (vols) => {
  const rest = (vols ?? []).filter((v) => !caMount(v));
  return rest.length ? rest : undefined;
};
/**
 * The OpenShip IMPORT GUARD (rab-ops removal PR 2, plan §6(a); docs/release/OPENSHIP-COMPATIBILITY.md): ONE long-form tmpfs
 * on rab-api in docker-compose.image.yml only, exactly /tmp, 16 MiB, mode 0555 (root-owned and not writable by the API's
 * uid 1000, so it adds no writable path). OpenShip refuses a `type: tmpfs` volume, so it can never import the variant and
 * silently drop its H6 keys. It moved here from the removed rab-ops (before that, the removed rab-migrate). It is the one
 * allowed difference from docker-compose.production.yml besides the CA bind, and only in that exact shape: a changed guard
 * (another target, size, mode or option) is not the guard, so it fails both the guard check and the production
 * comparison. production.yml must stay importable by OpenShip, so it never carries a long-form tmpfs.
 */
const IMPORT_GUARD_SERVICE = 'rab-api';
const IMPORT_GUARD_BYTES = 16 * 1024 * 1024;
const IMPORT_GUARD_MODE = 0o555;
const longFormTmpfs = (v) => v?.type === 'tmpfs';
const importGuardMount = (v) => longFormTmpfs(v)
  && v.target === '/tmp'
  && Object.keys(v).every((k) => ['type', 'target', 'tmpfs'].includes(k))
  && Object.keys(v.tmpfs ?? {}).every((k) => ['size', 'mode'].includes(k))
  && Number(v.tmpfs?.size) === IMPORT_GUARD_BYTES
  && Number(v.tmpfs?.mode) === IMPORT_GUARD_MODE;
/** The variant's volumes for the production comparison: the CA bind, and on rab-api the exact import guard, left out. */
const comparableVariantVolumes = (name, vols) => withoutCa(name === IMPORT_GUARD_SERVICE ? (vols ?? []).filter((v) => !importGuardMount(v)) : vols);
/**
 * rab-ops removal (PR 2): the retired operations container must not come back, by name, under the "ops" profile, or under
 * ANY name and profile (security review of PR #124, MEDIUM: a `rab-maint` with `profiles: ["maint"]` reading .env.ops
 * passed every gate). Every render enables every profile (`--profile '*'`), and on EVERY service: no profile at all (a
 * deploy file starts every service with the stack; profiles, not a service allowlist, so a new always-on service needs no
 * gate change), no value of the .env.ops sentinel and none of the retired ops names. `env` is each service's RESOLVED
 * environment, so a service that reads .env.ops is caught by its values whatever the Compose version.
 */
const retiredOpsProblems = (services, where = '') => {
  const out = [];
  if (services['rab-ops']) out.push(`rab-ops: present${where} (removed; operations run as one-off owner-login commands of rab-api)`);
  for (const [name, svc] of Object.entries(services)) {
    if (Array.isArray(svc?.profiles) && svc.profiles.includes('ops')) out.push(`${name}: has the "ops" profile${where} (the rab-ops container was removed)`);
    if (Array.isArray(svc?.profiles) && svc.profiles.length) out.push(`${name}: has profiles ${JSON.stringify(svc.profiles)}${where} (a deploy file has no profile-gated service)`);
    const env = svc?.environment ?? {};
    if (Object.values(env).some((v) => String(v ?? '').includes(SENTINEL_OPS_PW))) out.push(`${name}: carries a value of the retired .env.ops${where}`);
    const held = OPS_ONLY.filter((k) => Object.prototype.hasOwnProperty.call(env, k));
    if (held.length) out.push(`${name}: sets the retired ${held.join(', ')}${where}`);
  }
  return out;
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
 * with --no-env-resolution (keeps the env_file names); `production`: docker-compose.production.yml, env files resolved
 * (it names none, so only a re-added one, such as the retired .env.ops, contributes values). Returns failure messages.
 */
function checkVariant(variant, production, variantFiles = variant) {
  const problems = [];
  const envFiles = (name) => (variantFiles?.services?.[name]?.env_file ?? []).map((e) => (typeof e === 'string' ? e : e.path));
  const fail = (m) => problems.push(m);
  const services = variant?.services ?? {};
  const names = Object.keys(services).sort();
  // O3 (owner decisions C1-C5): no rab-migrate; the API migrates on start.
  const expected = ['db', 'db-setup', 'rab-api', 'rab-redis', 'rab-worker'];
  if (stable(names) !== stable(expected)) fail(`services are ${names.join(',')}; expected exactly ${expected.join(',')}`);
  // PR #125 option A: db-setup is the same one-shot in both files, and the app services never hold a database URL.
  for (const pr of optionAProblems(services)) fail(pr);
  for (const pr of optionAProblems(production?.services ?? {}, ' in docker-compose.production.yml')) fail(pr);
  // Security review L3: volumes_from, secrets/configs, Docker-volume-store binds, tmpfs, rab-redis's uid (one definition).
  for (const pr of credentialMountProblems(services)) fail(pr);
  for (const pr of credentialMountProblems(production?.services ?? {}, ' in docker-compose.production.yml', { redisUser: false })) fail(pr);
  const vset = services[DB_SETUP_SERVICE];
  const pset = production?.services?.[DB_SETUP_SERVICE];
  if (vset && pset) {
    for (const key of DB_SETUP_KEYS) {
      const av = key === 'volumes' ? withoutCa(vset.volumes) : vset[key];
      const bv = key === 'volumes' ? withoutCa(pset.volumes) : pset[key];
      if (stable(av) !== stable(bv)) fail(`${DB_SETUP_SERVICE}.${key} differs from docker-compose.production.yml: ${stable(av)} vs ${stable(bv)}`);
    }
    for (const key of ['PG_DATABASE_URL', 'NODE_ENV', 'RAB_RUNTIME_ENV']) if (stable(envOf(vset)[key]) !== stable(envOf(pset)[key])) fail(`${DB_SETUP_SERVICE}.environment.${key} differs from docker-compose.production.yml`);
    const deps = (x) => Object.fromEntries(Object.entries(x.depends_on ?? {}).map(([k, v]) => [k, v.condition]));
    if (stable(deps(vset)) !== stable(deps(pset))) fail(`${DB_SETUP_SERVICE}.depends_on differs from docker-compose.production.yml`);
    const files = envFiles(DB_SETUP_SERVICE).map(baseName);
    // Twenty Helm model: database.env ONLY (the TLS settings); never runtime.env (no APP_SECRET, no runtime secret).
    if (stable(files) !== stable(['database.env'])) fail(`${DB_SETUP_SERVICE}: must read database.env only (got ${files.join(', ') || 'none'}; never runtime.env)`);
  }
  for (const pr of retiredOpsProblems(services)) fail(pr);
  // DB-SETUP: the bundled db is the same service in both files (never a weaker copy in one of them), never published.
  const vdb = services[DB_SERVICE];
  const pdb = production?.services?.[DB_SERVICE];
  if (!vdb || !pdb) fail(`${DB_SERVICE}: missing in ${vdb ? 'docker-compose.production.yml' : 'the variant'}`);
  else {
    for (const key of DB_KEYS) if (stable(vdb[key]) !== stable(pdb[key])) fail(`${DB_SERVICE}.${key} differs from docker-compose.production.yml`);
    if ((vdb.ports ?? []).length) fail(`${DB_SERVICE}: publishes a port`);
    if (stable(Object.keys(vdb.networks ?? {})) !== stable(['crewflow-db'])) fail(`${DB_SERVICE}: must be on the internal crewflow-db network only`);
    if (variant?.networks?.['crewflow-db']?.internal !== true || production?.networks?.['crewflow-db']?.internal !== true) fail('network crewflow-db is not internal in both files');
  }
  // DB-SETUP T-5 / PID 1: the cleaning scripts are the entrypoints (no process keeps the admin URL).
  for (const pr of pid1Problems(services)) fail(pr);
  // docker-compose.production.yml (the file OpenShip imports) gets the same refusals.
  for (const pr of retiredOpsProblems(production?.services ?? {}, ' in docker-compose.production.yml')) fail(pr);

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
  if (services['rab-migrate'] && services['rab-migrate'].image !== apiImage) fail('rab-migrate: image differs from rab-api\'s (the migrations ship in the API image)');
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
      // Allowed differences: the read-only PostgreSQL CA bind (the image file mounts it from the host) and rab-api's exact
      // OpenShip import guard.
      const av = key === 'volumes' ? comparableVariantVolumes(name, a.volumes) : a[key];
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
  for (const name of ['rab-migrate', 'rab-redis']) {
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
    for (const [key, want] of Object.entries(NOTIFICATION_DELIVERY)) {
      if (String(envOf(services[name])[key] ?? '') !== want) fail(`${name}: ${key} is not "${want}" (owner decision 2026-11-06)`);
    }
    for (const [key, want] of Object.entries(PHASE_D_SWITCHES)) {
      if (String(envOf(services[name])[key] ?? '') !== want) fail(`${name}: ${key} is not "${want}" (owner decision 2026-11-06, Phase D switches)`);
    }
    for (const [key, keep] of Object.entries(PHASE_D_UNCHANGED)) {
      const env = envOf(services[name]);
      if (key in env && String(env[key]) !== keep) fail(`${name}: ${key} is committed as "${env[key]}"; the owner decision 2026-11-06 keeps ${keep} (leave it unset)`);
    }
    for (const [key, want] of Object.entries(STATEMENT_DISPATCH)) {
      if (String(envOf(services[name])[key] ?? '') !== want) fail(`${name}: ${key} is not "${want}" (owner decision 2026-11-11, pay-statement sweep)`);
    }
    if ('WORKER_SCHEDULER' in envOf(services[name])) fail(`${name}: commits WORKER_SCHEDULER (production runs bullmq; interval is refused)`);
    if (name === 'rab-api') for (const pr of featureSweepProblems(envOf(services['rab-api']), envOf(services['rab-worker']))) fail(pr);
    if ('CREWFLOW_UPGRADE_FAILURE_POLICY' in envOf(services[name])) fail(`${name}: commits the deprecated CREWFLOW_UPGRADE_FAILURE_POLICY (O3 C3)`);
  }
  // The OpenShip import guard (a long-form tmpfs volume; OpenShip refuses the file at import) on rab-api, in its exact shape
  // (rab-ops removal PR 2 moved it there from the removed rab-ops; see importGuardMount). docker-compose.production.yml must
  // stay importable by OpenShip: no long-form tmpfs on any of its services.
  if (!(services[IMPORT_GUARD_SERVICE]?.volumes ?? []).some(importGuardMount)) fail(`${IMPORT_GUARD_SERVICE}: no long-form tmpfs at /tmp (16 MiB, mode 0555): the OpenShip import guard is missing or changed`);
  for (const [name, svc] of Object.entries(production?.services ?? {})) {
    if ((svc.volumes ?? []).some(longFormTmpfs)) fail(`docker-compose.production.yml: ${name} has a long-form tmpfs volume (OpenShip would refuse to import the production file)`);
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
  // Every service, not only the app services: nothing names the retired .env.ops or waits for a rab-ops.
  for (const [name, svc] of Object.entries(services)) {
    if (svc.depends_on?.['rab-ops']) fail(`${name}: depends on rab-ops`);
    if (envFiles(name).some((f) => baseName(f) === '.env.ops')) fail(`${name}: names .env.ops`);
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
    // DB-SETUP: the bundled db runs the official postgres image (by digest), never another repository.
    if (name === DB_SERVICE) {
      if (!['postgres', 'library/postgres'].includes(m[1].replace(/^docker\.io\//, ''))) problems.push(`${name}: repository ${m[1]} is not the official postgres image`);
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
 * `envFileKeys`: { service: { names: [variable names], dbUsers: { VAR: login }, switches: { PUSH_ENABLED, REALTIME_ENABLED } } }
 * read from the services' env files (names, the login part of database URLs and the two non-secret feature switches only,
 * never another value), or omitted when the files are not readable here.
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
    if (envFileKeys[name] && !fromFiles.includes('REDIS_URL')) fail(`${name}: REDIS_URL is missing from its env file`);
    // DB-SETUP option 2: PG_DATABASE_URL is a compose.env value for db-setup only; in an app's env file it is pinned away
    // (and refused by the entrypoint), and the bundled db's password never belongs in an env file.
    if (fromFiles.includes('PG_DATABASE_URL')) fail(`${name}: PG_DATABASE_URL is set in an env file (set it in compose.env: it belongs to db-setup only)`);
    if (fromFiles.includes('PG_DATABASE_PASSWORD') || Object.prototype.hasOwnProperty.call(envOf(svc), 'PG_DATABASE_PASSWORD')) fail(`${name}: PG_DATABASE_PASSWORD reaches the container (compose.env only)`);
    for (const [k, login] of Object.entries(envFileKeys[name]?.dbUsers ?? {})) {
      if (NOT_THE_APP_LOGIN.includes(login)) fail(`${name}: ${k} logs in as "${login}" (a former separated login)`);
    }
  }
  if (String(envOf(services['rab-api']).PG_DATABASE_URL ?? '') !== String(envOf(services['rab-worker']).PG_DATABASE_URL ?? '')) fail('PG_DATABASE_URL differs between rab-api and rab-worker in the deployed model');
  // PR #125 option 2: the app services never hold a database URL; db-setup alone carries it.
  for (const pr of optionAProblems(services, ' in the deployed model')) fail(pr);
  for (const pr of credentialMountProblems(services, ' in the deployed model')) fail(pr);
  const setup = services[DB_SETUP_SERVICE];
  const pset = production?.services?.[DB_SETUP_SERVICE];
  if (setup) {
    const fromFiles = envFileKeys[DB_SETUP_SERVICE]?.names ?? [];
    if (fromFiles.includes('PG_DATABASE_URL')) fail(`${DB_SETUP_SERVICE}: PG_DATABASE_URL is set in an env file (set it in compose.env; the committed default would silently override it)`);
    if (fromFiles.includes('PG_DATABASE_PASSWORD') || Object.prototype.hasOwnProperty.call(envOf(setup), 'PG_DATABASE_PASSWORD')) fail(`${DB_SETUP_SERVICE}: PG_DATABASE_PASSWORD reaches the container (compose.env only)`);
    if (fromFiles.includes('APP_SECRET')) fail(`${DB_SETUP_SERVICE}: APP_SECRET reaches the container from an env file (db-setup reads database.env only)`);
    for (const [k, login] of Object.entries(envFileKeys[DB_SETUP_SERVICE]?.dbUsers ?? {})) {
      if (NOT_THE_APP_LOGIN.includes(login)) fail(`${DB_SETUP_SERVICE}: ${k} logs in as "${login}" (a former separated login)`);
    }
    let parsed = null;
    try { parsed = new URL(String(envOf(setup).PG_DATABASE_URL ?? '')); } catch { /* reported below */ }
    if (!parsed) fail(`${DB_SETUP_SERVICE}: PG_DATABASE_URL is missing or not a URL in the deployed model`);
    else {
      const login = decodeURIComponent(parsed.username);
      if (NOT_THE_APP_LOGIN.includes(login)) fail(`${DB_SETUP_SERVICE}: PG_DATABASE_URL logs in as "${login}" (a former separated login; use the database admin login or ${OWNER_LOGIN})`);
      if (parsed.searchParams.get('sslmode') !== 'verify-full') fail(`${DB_SETUP_SERVICE}: PG_DATABASE_URL is not sslmode=verify-full in the deployed model`);
    }
    if (pset) {
      for (const key of DB_SETUP_KEYS) {
        const av = key === 'volumes' ? withoutCa(setup.volumes) : setup[key];
        const bv = key === 'volumes' ? withoutCa(pset.volumes) : pset[key];
        if (stable(av) !== stable(bv)) fail(`${DB_SETUP_SERVICE}.${key} differs from docker-compose.production.yml in the deployed model`);
      }
      const deps = (x) => Object.fromEntries(Object.entries(x.depends_on ?? {}).map(([k, v]) => [k, v.condition]));
      if (stable(deps(setup)) !== stable(deps(pset))) fail(`${DB_SETUP_SERVICE}.depends_on differs from docker-compose.production.yml in the deployed model`);
    }
  }
  // DB-SETUP: the bundled db as committed (an override must not weaken it), and the Worker wrapper.
  const ddb = services[DB_SERVICE];
  const pdb = production?.services?.[DB_SERVICE];
  if (!ddb) fail(`${DB_SERVICE}: missing in the deployed model`);
  else if (pdb) {
    for (const key of DB_KEYS.filter((k) => k !== 'environment' && k !== 'image')) if (stable(ddb[key]) !== stable(pdb[key])) fail(`${DB_SERVICE}.${key} is overridden in the deployed model`);
    // PR #125 review, finding 6: the deployed db's environment holds the real password, so it is not compared with the
    // reference render; it is checked against the same rules as the committed one (names and rules only, never a value).
    for (const msg of bundledDbEnvironmentProblems(ddb.environment ?? {})) fail(`${msg} in the deployed model`);
    if ((ddb.ports ?? []).length) fail(`${DB_SERVICE}: publishes a port in the deployed model`);
  }
  for (const pr of pid1Problems(services, ' in the deployed model')) fail(pr);
  for (const name of ['rab-api', 'rab-worker']) {
    const a = services[name];
    const b = production?.services?.[name];
    if (!a || !b) {
      fail(`${name}: missing`);
      continue;
    }
    for (const key of RUNTIME_KEYS) {
      const value = key === 'volumes' ? comparableVariantVolumes(name, a.volumes) : a[key];
      const expected = key === 'volumes' ? withoutCa(b.volumes) : b[key];
      if (stable(value) !== stable(expected)) fail(`${name}.${key} differs from docker-compose.production.yml in the deployed model`);
    }
    // The approval mode is the operator's compose.env opt-in (BC-11/C4): validated, not compared with the reference render.
    for (const key of PINNED_ENV.filter((k) => k !== 'STORAGE_KEY_PREFIX' && k !== 'CREWFLOW_MIGRATION_APPROVAL_MODE')) {
      if (stable(envOf(a)[key]) !== stable(envOf(b)[key])) fail(`${name}.environment.${key} is overridden in the deployed model`);
    }
    if (name === 'rab-api' && !['none', 'token'].includes(String(envOf(a).CREWFLOW_MIGRATION_APPROVAL_MODE ?? ''))) fail('rab-api: CREWFLOW_MIGRATION_APPROVAL_MODE is not none or token in the deployed model');
    for (const [key, want] of Object.entries(NOTIFICATION_DELIVERY)) {
      if (String(envOf(a)[key] ?? '') !== want) fail(`${name}: ${key} is not "${want}" in the deployed model (owner decision 2026-11-06)`);
    }
    for (const [key, want] of Object.entries(PHASE_D_SWITCHES)) {
      if (String(envOf(a)[key] ?? '') !== want) fail(`${name}: ${key} is not "${want}" in the deployed model (owner decision 2026-11-06, Phase D switches)`);
    }
    for (const [key, want] of Object.entries(STATEMENT_DISPATCH)) {
      if (String(envOf(a)[key] ?? '') !== want) fail(`${name}: ${key} is not "${want}" in the deployed model (owner decision 2026-11-11, pay-statement sweep)`);
    }
    if (envOf(a).CREWFLOW_RUNTIME_ISOLATION !== 'enforce') fail(`${name}: CREWFLOW_RUNTIME_ISOLATION is not "enforce" in the deployed model`);
    const deps = (s) => Object.fromEntries(Object.entries(s.depends_on ?? {}).map(([k, v]) => [k, v.condition]));
    if (stable(deps(a)) !== stable(deps(b))) fail(`${name}.depends_on differs from docker-compose.production.yml`);
    for (const p of a.ports ?? []) {
      if (!p.host_ip || p.host_ip === '0.0.0.0' || p.host_ip === '::') fail(`${name}: port ${p.target} is published on every interface (CREWFLOW_API_BIND)`);
    }
  }
  // Phase X J2 (SJ-03): the switches come from the env files (or a compose value); the intervals must be committed.
  const switchesFromFiles = Object.fromEntries(['rab-api', 'rab-worker'].map((n) => [n, envFileKeys[n]?.switches ?? {}]));
  for (const pr of featureSweepProblems(envOf(services['rab-api']), envOf(services['rab-worker']), switchesFromFiles, ' in the deployed model')) fail(pr);
  for (const name of ['rab-api', 'rab-worker']) {
    for (const rule of Object.values(FEATURE_SWEEPS)) {
      if ((envFileKeys[name]?.names ?? []).includes(rule.key)) fail(`${name}: ${rule.key} is set in an env file (commit it in the compose files on both services)`);
    }
  }
  // O3: an override must not bring a release step back (a second migrating process next to the API).
  if (services['rab-migrate']) fail('rab-migrate: present in the deployed model (O3: the API migrates on start)');
  // rab-ops removal (PR 2): an override must not bring the operations container back either.
  for (const pr of retiredOpsProblems(services, ' in the deployed model')) fail(pr);
  if (services['rab-worker'] && services['rab-worker'].image !== services['rab-api']?.image) fail('rab-worker: image differs from rab-api\'s in the deployed model (O2: one image)');
  for (const [name, svc] of Object.entries(services)) {
    if ((svc.env_file ?? []).some((e) => baseName(typeof e === 'string' ? e : e.path) === '.env.ops')) fail(`${name}: names .env.ops in the deployed model`);
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
    // Every profile (review of PR #124): a profile-gated service is rendered and refused, never hidden.
    '--profile', '*', 'config', '--format', 'json', ...(resolveEnvFiles ? [] : ['--no-env-resolution'])];
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
function renderModels(variantPath = VARIANT, productionPath = PRODUCTION) {
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
      ...PRODUCTION_REQUIRED_DUMMIES,
      CREWFLOW_IMAGE_TAG: SENTINEL_DIGEST,
      CREWFLOW_REDIS_IMAGE: `redis@sha256:${'0c'.repeat(32)}`,
      CREWFLOW_SECRETS_DIR: secrets.split(path.sep).join('/'),
    };
    const variant = render([variantPath], { projectDirectory: dir, env, resolveEnvFiles: true });
    const rawFiles = render([variantPath], { projectDirectory: dir, env, resolveEnvFiles: false });
    // Whether this Compose reports env_file under --no-env-resolution (rab-migrate declares one in the committed file).
    const composeReportsEnvFiles = (rawFiles.services?.['rab-migrate']?.env_file ?? []).length > 0;
    const variantFiles = attachEnvFilesFromMarkers(rawFiles, variant, dir);
    // Resolved: production.yml names no env file, so only a re-added one (the retired .env.ops sentinel) adds values.
    const production = render([productionPath], { projectDirectory: dir, env, resolveEnvFiles: true });
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
  for (const k of ['CREWFLOW_IMAGE_TAG']) {
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
  for (const name of ['rab-api', 'rab-worker', DB_SETUP_SERVICE]) {
    const paths = (model.services?.[name]?.env_file ?? []).map((e) => (typeof e === 'string' ? e : e.path));
    if (!paths.length) {
      // G7: never skip these checks silently. Without an env file the service would also start without credentials.
      skippedEnvFiles.push(`${name}: no env_file in the deployed model, so its credential checks cannot run (the image compose names database.env and runtime.env)`);
      continue;
    }
    // `switches`: the values of the two non-secret feature switches (PUSH_ENABLED, REALTIME_ENABLED) only (Phase X J2).
    const entry = { names: [], unfilled: [], dbUsers: {}, switches: {} };
    for (const p of paths) {
      let text;
      try {
        text = fs.readFileSync(p, 'utf8');
      } catch {
        entry.unfilled.push(`(env file ${baseName(p)} not readable)`);
        continue;
      }
      readEnvFileKeys(text, entry);
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

module.exports = {
  NOT_THE_APP_LOGIN, DB_SERVICE, DB_SETUP_SERVICE, optionAProblems, checkVariant, checkResolvedImages, checkDeployment, DIGEST_REF, RUNTIME_KEYS, NOTIFICATION_DELIVERY, PHASE_D_SWITCHES, PHASE_D_UNCHANGED, STATEMENT_DISPATCH, FEATURE_SWEEPS, SWITCH_VALUES, featureSweepProblems, composeEnvValue, readEnvFileKeys, SENTINEL_MIGRATOR_PW, SENTINEL_OPS_PW, SENTINEL_OWNER_PW, renderModels, staticMode };
