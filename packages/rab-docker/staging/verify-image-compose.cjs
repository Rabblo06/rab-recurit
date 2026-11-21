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
 * IDENTICAL in the two files. Owner decision 2026-11-18 (Twenty's way): PG_DATABASE_URL is ALWAYS the crewflow_owner URL
 * (your own, or the bundled db's built from PG_DATABASE_APP_PASSWORD), and db-setup, rab-api and rab-worker receive the SAME
 * value (compose.env); PG_ADMIN_URL (an admin URL) is committed ONLY on the one-shot db-setup service; db-setup's database
 * environment, runtime keys, volumes and depends_on are identical in the two files; db-setup starts through the wait-for-db
 * wrapper with NO depends_on and nothing depends on db (owner instruction 2026-11-18, Twenty's Helm wait-for-db;
 * db-setup-wait.cjs). rab-api and rab-worker pin PG_ADMIN_URL
 * to the literal empty string, carry exactly db-setup's crewflow_owner PG_DATABASE_URL, and hold no OTHER postgres:// value
 * anywhere in their definition. No file carries a credential: the retired crewflow-db-target volume (and any mount at
 * /run/crewflow/db-target) is refused everywhere. Neither URL may come from an env file, and PG_DATABASE_APP_PASSWORD never
 * reaches a container; in the deployed model the --environment preflight applies compose-owner-login.cjs
 * dbSettingsProblems (the three modes, PG_DATABASE_PASSWORD exactly while the bundled db runs, sslmode require / verify-ca /
 * verify-full (all full verification), the login rules). A connection pooler is refused by db-setup's capability checks, never
 * by its address. Only the login part of a URL is ever read.
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
const { bundledDbEnvironmentProblems, credentialMountProblems, topLevelVolumeProblems, strictSwitchProblems, dbSettingsProblems, DB_SETUP_DB_KEYS, ADMIN_URL_KEY, RETIRED_ADMIN_URL_KEYS, HARDEN_TIMEOUT_KEY, hardenTimeoutOk, AI_ENABLED_KEY, AI_ENABLED_EXPR, AI_ENABLED_DEFAULT } = require('../scripts/compose-owner-login.cjs');
const { pgCaFileProblem } = require('../scripts/pg-ca-pem.cjs');
const { dbSetupStartProblems, WAIT_SECONDS_KEY, WAIT_SECONDS_DEFAULT } = require('../scripts/db-setup-wait.cjs');
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
/**
 * Committed environment keys that must keep the production file's value on rab-api / rab-worker. AI_ENABLED (owner decision
 * 2026-11-20) is compared in the reference render only (both files commit ${AI_ENABLED:-false}, so both render false there);
 * in the deployed model it is the operator's compose.env value: exactly true or false, the same on both services.
 */
const PINNED_ENV = ['NODE_ENV', 'RAB_RUNTIME_ENV', 'AI_ENABLED', 'HWS_RUNTIME_ENABLED', 'CREWFLOW_HWS_CUTOVER_BACKUP_MARKER', 'STORAGE_DRIVER', 'STORAGE_KEY_PREFIX',
  'S3_FORCE_PATH_STYLE', 'S3_SERVER_SIDE_ENCRYPTION', 'CREWFLOW_PROVISIONER_ENABLED', 'WORKSPACE_PROVISIONER_INTERVAL_SECONDS',
  'PG_POOL_MAX_CONNECTIONS', 'WORKER_SCHEDULER', 'CREWFLOW_MIGRATE_ON_START', 'CREWFLOW_MIGRATION_APPROVAL_MODE',
  'DISABLE_DB_MIGRATIONS', 'DISABLE_CRON_JOBS_REGISTRATION',
  'CREWFLOW_WORKER_SCHEMA_WAIT_SECONDS', 'WORKER_FAST_PUBLISH_NOTIFY', 'WORKER_EMAIL_DISPATCH_INTERVAL_SECONDS',
  'WORKER_TIMER_TRIGGERS', 'WORKER_TIMER_TRIGGER_KINDS', 'WORKER_OFFER_EXPIRY_INTERVAL_SECONDS',
  'WORKER_MANAGER_CONFIRMATION_TIMEOUT_INTERVAL_SECONDS', 'WORKER_LATE_CLOCK_IN_INTERVAL_SECONDS',
  'WORKER_SHIFT_MONITOR_INTERVAL_SECONDS', 'WORKER_SHIFT_SCAN_MODE', 'WORKER_SHIFT_STATEMENT_DISPATCH_INTERVAL_SECONDS'];
/**
 * PINNED_ENV keys that are OPTIONAL on one service and committed there as ${KEY:-} (an EMPTY default, so OpenShip shows
 * "fallback default" instead of "needs value"): rab-api's PG_POOL_MAX_CONNECTIONS (the Worker pins "12"). Docker Compose
 * renders that as "" where the image file has no key at all, and every reader treats "" as unset (pg-config.ts present()),
 * so for these keys alone "" and "not set" compare equal. Any other value is still compared exactly.
 */
const BLANK_IS_UNSET_PINNED_ENV = Object.freeze(['PG_POOL_MAX_CONNECTIONS']);
/** The value of a PINNED_ENV key as the comparison sees it (see BLANK_IS_UNSET_PINNED_ENV). */
const pinnedEnvValue = (env, key) => (BLANK_IS_UNSET_PINNED_ENV.includes(key) && env[key] === '' ? undefined : env[key]);
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
    if (/(DATABASE|ADMIN)_URL$/.test(m[1])) {
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
 * PG_DATABASE_URL is the crewflow_owner URL and PG_ADMIN_URL the database admin URL. Neither is ever one of the former
 * separated logins / schema roles (mirrors NOT_THE_APP_LOGIN in scripts/compose-owner-login.cjs; a test asserts the two agree).
 */
const NOT_THE_APP_LOGIN = Object.freeze(['crewflow', 'crewflow_app', 'crewflow_worker', 'crewflow_migrator', 'rab_owner', 'rab_secure_owner', 'rab_app']);
/** DB-SETUP: the bundled database service; its whole definition must be identical in the two compose files. */
const DB_SERVICE = 'db';
/**
 * DB-SETUP PID 1 (lead decision 2026-11-12): each app service's ENTRYPOINT is its cleaning script (PID 1), which execs the
 * image's tini only once the environment is clean; no command, no compose init (docker-init at PID 1 keeps the admin URL).
 */
const PID1_ENTRYPOINTS = Object.freeze({ 'rab-api': ['./api-prestart.sh'], 'rab-worker': ['./worker-start.sh'], 'db-setup': ['./db-setup.sh'], 'db-harden': ['./db-setup.sh', 'harden'] });
/** The one-shot setup service (with db-harden, the only services with an admin URL). */
const DB_SETUP_SERVICE = 'db-setup';
/**
 * The one-shot CREATEROLE hardening (owner decision 2026-11-18, security review of PR #246, M1): db-setup's image and database
 * settings, entrypoint `./db-setup.sh harden`, NO depends_on, and nothing depends on it.
 */
const DB_HARDEN_SERVICE = 'db-harden';
/** The services that may hold the admin URL (PG_ADMIN_URL with a value, the bundled superuser URL). */
const ADMIN_SERVICES = Object.freeze([DB_SETUP_SERVICE, DB_HARDEN_SERVICE]);
/** The retired setup volume (PR #125 option 2: db-setup's target and crewflow_owner password files). Never again. */
const RETIRED_TARGET_VOLUME = 'crewflow-db-target';
const RETIRED_TARGET_DIR = '/run/crewflow/db-target';
/** The variable compose interpolates into the bundled PG_DATABASE_URL (owner decision 2026-11-18); never a container's. */
const APP_PASSWORD_KEY = 'PG_DATABASE_APP_PASSWORD';
/** db-setup keys that must be identical in the two files (besides RUNTIME_KEYS; the image differs only by its default). */
const DB_SETUP_KEYS = [...RUNTIME_KEYS, 'networks', 'ports', 'profiles', 'build'];
/** The six services of the committed files (anything else in a deployed model was added by an override). */
const KNOWN_SERVICES = ['db', 'db-harden', 'db-setup', 'rab-api', 'rab-redis', 'rab-worker'];
const isPgUrlText = (v) => /postgres(ql)?:\/\//i.test(String(v ?? ''));
/** The login of a URL value, or null when it is not a URL. Never returns the password. */
const urlLogin = (value) => {
  try {
    return decodeURIComponent(new URL(String(value ?? '')).username);
  } catch {
    return null;
  }
};
const underRetiredTarget = (t) => {
  const n = String(t ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
  return n === RETIRED_TARGET_DIR || n.startsWith(`${RETIRED_TARGET_DIR}/`);
};
/**
 * Owner decision 2026-11-18 (Twenty's way), both models: db-setup, rab-api and rab-worker carry the SAME PG_DATABASE_URL, a
 * crewflow_owner URL; rab-api / rab-worker pin PG_ADMIN_URL to "" and hold no OTHER postgres:// value anywhere in their
 * definition; db-setup is a one-shot after a healthy db that rab-api waits for. The retired crewflow-db-target volume is
 * refused on every service, as a mount source or as anything at /run/crewflow/db-target (volume, bind or tmpfs).
 */
function optionAProblems(services, where = '', { renderedWait = WAIT_SECONDS_DEFAULT } = {}) {
  const out = [];
  const setup = services[DB_SETUP_SERVICE];
  const setupUrl = setup ? envOf(setup).PG_DATABASE_URL : undefined;
  for (const name of ['rab-api', 'rab-worker']) {
    const svc = services[name];
    if (!svc) continue;
    const env = envOf(svc);
    const url = env.PG_DATABASE_URL;
    // Owner requirement 2026-11-17 + owner decision L-2: PG_ADMIN_URL pinned to the literal empty string (any value refused),
    // never the retired name nor db-setup's bundled-db URL.
    const admin = env[ADMIN_URL_KEY];
    if (admin === undefined) out.push(`${name}: ${ADMIN_URL_KEY} is not pinned to ""${where} (an env-file value would reach it; owner decision L-2)`);
    else if (String(admin) !== '') out.push(`${name}: has ${ADMIN_URL_KEY} with a value${where} (the database admin URL reaches db-setup / db-harden only; rab-api / rab-worker pin it to "")`);
    for (const key of [...RETIRED_ADMIN_URL_KEYS, 'CREWFLOW_BUNDLED_DB_ADMIN_URL', APP_PASSWORD_KEY]) if (Object.prototype.hasOwnProperty.call(env, key)) out.push(`${name}: has ${key}${where} (compose / db-setup input only)`);
    // The crewflow_owner URL, from compose.env: committed here (an env-file value never wins), the same as db-setup's.
    if (url === undefined || String(url) === '') out.push(`${name}: PG_DATABASE_URL is not set in its environment${where} (the crewflow_owner URL, committed from compose.env)`);
    else {
      if (urlLogin(url) !== OWNER_LOGIN) out.push(`${name}: PG_DATABASE_URL does not log in as ${OWNER_LOGIN}${where} (it is always the app login, never an admin URL)`);
      if (setup && String(url) !== String(setupUrl ?? '')) out.push(`${name}: PG_DATABASE_URL differs from db-setup's${where} (rab-api / rab-worker use exactly the crewflow_owner URL db-setup created or checked)`);
    }
    const rest = { ...svc, environment: Object.fromEntries(Object.entries(env).filter(([k]) => k !== 'PG_DATABASE_URL')) };
    if (isPgUrlText(JSON.stringify(rest))) out.push(`${name}: holds a postgres:// value outside PG_DATABASE_URL somewhere in its definition${where} (never a second database credential)`);
  }
  if (!setup) out.push(`${DB_SETUP_SERVICE}: missing${where} (the only service with an admin login)`);
  else {
    if (setup.restart !== 'no') out.push(`${DB_SETUP_SERVICE}: restart is not "no"${where} (a one-shot)`);
    if ((setup.ports ?? []).length) out.push(`${DB_SETUP_SERVICE}: publishes a port${where}`);
    if (setupUrl === undefined || String(setupUrl) === '') out.push(`${DB_SETUP_SERVICE}: PG_DATABASE_URL is not set${where} (always the crewflow_owner URL)`);
    else if (urlLogin(setupUrl) !== OWNER_LOGIN) out.push(`${DB_SETUP_SERVICE}: PG_DATABASE_URL does not log in as ${OWNER_LOGIN}${where} (an admin URL goes in ${ADMIN_URL_KEY})`);
    if (Object.prototype.hasOwnProperty.call(envOf(setup), APP_PASSWORD_KEY)) out.push(`${DB_SETUP_SERVICE}: has ${APP_PASSWORD_KEY}${where} (compose interpolates it into PG_DATABASE_URL; never a container variable)`);
    // Owner instruction 2026-11-18 (Twenty's Helm wait-for-db): the wait-for-db wrapper (db-setup-wait.cjs), NO depends_on,
    // and rab-api never depends on db (with CREWFLOW_BUNDLED_DB=0 there is no db container; OpenShip skipped the dependent).
    out.push(...dbSetupStartProblems(services, { requireWait: true, renderedWait, where }));
    if (setup.image !== services['rab-api']?.image) out.push(`${DB_SETUP_SERVICE}: image differs from rab-api's${where} (O2: one image)`);
    // APP_SECRET is never part of a database credential; db-setup never has it.
    if (Object.prototype.hasOwnProperty.call(envOf(setup), 'APP_SECRET')) out.push(`${DB_SETUP_SERVICE}: has APP_SECRET${where} (never part of a database credential)`);
  }
  if (services['rab-api']?.depends_on?.[DB_SETUP_SERVICE]?.condition !== 'service_completed_successfully') out.push(`rab-api: does not wait for ${DB_SETUP_SERVICE} (service_completed_successfully)${where}`);
  for (const [name, svc] of Object.entries(services)) {
    // Owner decision 2026-11-18: no file carries a credential; the retired setup volume never comes back.
    for (const v of svc.volumes ?? []) {
      if (v.source === RETIRED_TARGET_VOLUME || underRetiredTarget(v.target)) out.push(`${name}: mounts ${v.source === RETIRED_TARGET_VOLUME ? RETIRED_TARGET_VOLUME : 'something'} at ${String(v.target ?? '')}${where} (the retired setup volume: no file carries a credential)`);
    }
    if (!['rab-api', 'rab-worker', ...ADMIN_SERVICES].includes(name) && Object.prototype.hasOwnProperty.call(envOf(svc), 'PG_DATABASE_URL')) out.push(`${name}: has PG_DATABASE_URL${where} (only db-setup, db-harden, rab-api and rab-worker)`);
    if (!ADMIN_SERVICES.includes(name) && !['rab-api', 'rab-worker'].includes(name) && Object.prototype.hasOwnProperty.call(envOf(svc), ADMIN_URL_KEY)) out.push(`${name}: has ${ADMIN_URL_KEY}${where} (only db-setup and db-harden)`);
    if (!['rab-api', 'rab-worker', DB_SETUP_SERVICE].includes(name) && Object.prototype.hasOwnProperty.call(envOf(svc), APP_PASSWORD_KEY)) out.push(`${name}: has ${APP_PASSWORD_KEY}${where} (compose interpolation only)`);
  }
  out.push(...dbHardenProblems(services, where));
  return out;
}
const hasDeps = (deps) => (Array.isArray(deps) ? deps.length > 0 : Object.keys(deps ?? {}).length > 0);
/**
 * Owner decision 2026-11-18 (security review of PR #246, M1), both models: the one-shot db-harden service. The only other
 * service with the admin login: db-setup's image (and rab-api's: O2), EXACTLY db-setup's database settings
 * (DB_SETUP_DB_KEYS), its own bounded wait (CREWFLOW_DB_HARDEN_TIMEOUT_SECONDS, 60-7200, on no other service), restart "no",
 * no port, no profile, no APP_SECRET, production NODE_ENV / RAB_RUNTIME_ENV, uid 1000 with a read-only root, and NO
 * depends_on (it polls by itself; OpenShip drops conditions). No service may depend on it (it never blocks rab-api). Its
 * entrypoint is held by pid1Problems. Pure: names keys, never prints a value.
 */
function dbHardenProblems(services, where = '') {
  const out = [];
  for (const [name, svc] of Object.entries(services)) {
    const deps = svc?.depends_on;
    if ((Array.isArray(deps) ? deps : Object.keys(deps ?? {})).includes(DB_HARDEN_SERVICE)) out.push(`${name}: depends on ${DB_HARDEN_SERVICE}${where} (nothing waits for it; it never blocks rab-api or the Worker)`);
    if (name !== DB_HARDEN_SERVICE && Object.prototype.hasOwnProperty.call(envOf(svc), HARDEN_TIMEOUT_KEY)) out.push(`${name}: has ${HARDEN_TIMEOUT_KEY}${where} (db-harden's own setting)`);
  }
  const h = services[DB_HARDEN_SERVICE];
  if (!h) {
    out.push(`${DB_HARDEN_SERVICE}: missing${where} (the one-shot CREATEROLE hardening, owner decision 2026-11-18 M1)`);
    return out;
  }
  const setup = services[DB_SETUP_SERVICE] ?? {};
  const env = envOf(h);
  const senv = envOf(setup);
  if (hasDeps(h.depends_on)) out.push(`${DB_HARDEN_SERVICE}: has depends_on${where} (it waits for the database and the ledger by itself)`);
  if (h.restart !== 'no') out.push(`${DB_HARDEN_SERVICE}: restart is not "no"${where} (a one-shot)`);
  if ((h.ports ?? []).length) out.push(`${DB_HARDEN_SERVICE}: publishes a port${where}`);
  if ((h.profiles ?? []).length) out.push(`${DB_HARDEN_SERVICE}: has a profile${where} (it always runs)`);
  if (!h.image || h.image !== setup.image || h.image !== services['rab-api']?.image) out.push(`${DB_HARDEN_SERVICE}: image differs from db-setup's or rab-api's${where} (O2: one image)`);
  if (String(h.user ?? '') !== '1000:1000' || h.read_only !== true) out.push(`${DB_HARDEN_SERVICE}: does not run as 1000:1000 with a read-only root${where}`);
  for (const key of DB_SETUP_DB_KEYS) {
    const same = Object.prototype.hasOwnProperty.call(env, key) === Object.prototype.hasOwnProperty.call(senv, key) && String(env[key] ?? '') === String(senv[key] ?? '');
    if (!same) out.push(`${DB_HARDEN_SERVICE}: ${key} is not db-setup's${where} (exactly db-setup's database settings)`);
  }
  if (!Object.prototype.hasOwnProperty.call(env, HARDEN_TIMEOUT_KEY)) out.push(`${DB_HARDEN_SERVICE}: ${HARDEN_TIMEOUT_KEY} is not set${where} (committed as \${${HARDEN_TIMEOUT_KEY}:-1200})`);
  else if (!hardenTimeoutOk(env[HARDEN_TIMEOUT_KEY])) out.push(`${DB_HARDEN_SERVICE}: ${HARDEN_TIMEOUT_KEY} is not a whole number of seconds from 60 to 7200${where}`);
  if (Object.prototype.hasOwnProperty.call(env, 'APP_SECRET')) out.push(`${DB_HARDEN_SERVICE}: has APP_SECRET${where} (never part of a database credential)`);
  for (const key of ['NODE_ENV', 'RAB_RUNTIME_ENV']) if (String(env[key] ?? '') !== 'production') out.push(`${DB_HARDEN_SERVICE}: ${key} is not "production"${where}`);
  return out;
}
const hasCommand = (svc) => (Array.isArray(svc?.command) ? svc.command.length > 0 : svc?.command !== undefined && svc?.command !== null);
function pid1Problems(services, where = '') {
  const out = [];
  for (const [name, entrypoint] of Object.entries(PID1_ENTRYPOINTS)) {
    const svc = services[name];
    if (!svc) continue;
    const script = entrypoint.join(' ');
    // db-setup: the wait-for-db wrapper execs ./db-setup.sh as the same PID 1 (checked exactly by dbSetupStartProblems).
    if (name !== DB_SETUP_SERVICE && stable(svc.entrypoint) !== stable(entrypoint)) out.push(`${name}: entrypoint is not exactly ${script}${where} (DB-SETUP PID 1)`);
    if (hasCommand(svc)) out.push(`${name}: has a command${where} (${script}, the entrypoint, takes none)`);
    if (svc.init === true) out.push(`${name}: init: true${where} (docker-init would be PID 1 with the admin URL)`);
  }
  return out;
}
// deploy: the bundled db's replica count (CREWFLOW_BUNDLED_DB, Twenty's Helm db.enabled) must be the same in both files.
const DB_KEYS = [...RUNTIME_KEYS, 'image', 'environment', 'networks', 'ports', 'stop_signal', 'depends_on', 'profiles', 'env_file', 'build', 'deploy', 'scale'];
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
  // DB-SETUP: the bundled db's superuser password (mode a; both files' db and db-setup's bundled URL use it; owner decision
  // 2026-11-17: no `:?` any more, so the reference model also renders without it).
  PG_DATABASE_PASSWORD: 'dummy-production-required-db-password-0000',
  // Owner decision 2026-11-18: the bundled crewflow_owner password (mode a), interpolated into PG_DATABASE_URL of db-setup,
  // rab-api and rab-worker. Also not `:?` (your own database does not need it).
  PG_DATABASE_APP_PASSWORD: 'dummy-production-required-app-password-0000',
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
/**
 * Release 0.7.0 (Part C3): rab-api's HWS cutover backup directory, read-only. Like the CA, its SOURCE is the operator's
 * (CREWFLOW_HWS_CUTOVER_BACKUP_DIR in compose.env; /dev/null when unset), so only the target and read-only are compared: a
 * writable one is not this mount and still fails the comparison.
 */
const backupMount = (name, v) => name === 'rab-api' && v.type === 'bind' && v.target === '/run/crewflow/hws-cutover-backup' && v.read_only === true;
const withoutCa = (vols, name = null) => {
  const rest = (vols ?? []).filter((v) => !caMount(v) && !backupMount(name, v));
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
const comparableVariantVolumes = (name, vols) => withoutCa(name === IMPORT_GUARD_SERVICE ? (vols ?? []).filter((v) => !importGuardMount(v)) : vols, name);
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
  const expected = ['db', 'db-harden', 'db-setup', 'rab-api', 'rab-redis', 'rab-worker'];
  if (stable(names) !== stable(expected)) fail(`services are ${names.join(',')}; expected exactly ${expected.join(',')}`);
  // PR #125 option A: db-setup is the same one-shot in both files, and the app services never hold a database URL.
  for (const pr of optionAProblems(services)) fail(pr);
  for (const pr of optionAProblems(production?.services ?? {}, ' in docker-compose.production.yml')) fail(pr);
  // Security review L3: volumes_from, secrets/configs, Docker-volume-store binds, tmpfs, rab-redis's uid (one definition).
  for (const pr of credentialMountProblems(services)) fail(pr);
  for (const pr of credentialMountProblems(production?.services ?? {}, ' in docker-compose.production.yml', { redisUser: false })) fail(pr);
  for (const pr of topLevelVolumeProblems(variant)) fail(pr);
  for (const pr of topLevelVolumeProblems(production, ' in docker-compose.production.yml')) fail(pr);
  // db-setup and db-harden (owner decision 2026-11-18, M1): each the same one-shot in both files.
  for (const admin of ADMIN_SERVICES) {
    const vset = services[admin];
    const pset = production?.services?.[admin];
    if (!vset || !pset) continue;
    for (const key of DB_SETUP_KEYS) {
      const av = key === 'volumes' ? withoutCa(vset.volumes) : vset[key];
      const bv = key === 'volumes' ? withoutCa(pset.volumes) : pset[key];
      if (stable(av) !== stable(bv)) fail(`${admin}.${key} differs from docker-compose.production.yml: ${stable(av)} vs ${stable(bv)}`);
    }
    const envKeys = [...DB_SETUP_DB_KEYS, WAIT_SECONDS_KEY, 'NODE_ENV', 'RAB_RUNTIME_ENV', ...(admin === DB_HARDEN_SERVICE ? [HARDEN_TIMEOUT_KEY] : [])];
    for (const key of envKeys) if (stable(envOf(vset)[key]) !== stable(envOf(pset)[key])) fail(`${admin}.environment.${key} differs from docker-compose.production.yml`);
    const deps = (x) => Object.fromEntries(Object.entries(x.depends_on ?? {}).map(([k, v]) => [k, v.condition]));
    if (stable(deps(vset)) !== stable(deps(pset))) fail(`${admin}.depends_on differs from docker-compose.production.yml`);
    const files = envFiles(admin).map(baseName);
    // Twenty Helm model: database.env ONLY (the TLS settings); never runtime.env (no APP_SECRET, no runtime secret).
    if (stable(files) !== stable(['database.env'])) fail(`${admin}: must read database.env only (got ${files.join(', ') || 'none'}; never runtime.env)`);
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
      const bv = key === 'volumes' ? withoutCa(b.volumes, name) : b[key];
      if (stable(av) !== stable(bv)) fail(`${name}.${key} differs from docker-compose.production.yml: ${stable(av)} vs ${stable(bv)}`);
    }
    for (const key of PINNED_ENV) {
      if (stable(pinnedEnvValue(envOf(a), key)) !== stable(pinnedEnvValue(envOf(b), key))) fail(`${name}.environment.${key} differs from docker-compose.production.yml`);
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
  // Owner decision 2026-11-20: AI is operator-set, default OFF. The reference render sets no AI_ENABLED, so a committed
  // ${AI_ENABLED:-false} renders false; a literal "true" (or another default) does not.
  for (const name of ['rab-api', 'rab-worker']) {
    const v = envOf(services[name])[AI_ENABLED_KEY];
    if (String(v ?? '') !== AI_ENABLED_DEFAULT) fail(`${name}: ${AI_ENABLED_KEY} is not "${AI_ENABLED_DEFAULT}" when compose.env does not set it (commit ${AI_ENABLED_EXPR}: operator-set, default off)`);
  }
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
    // Phase X3.1: every strict on/off switch committed for the service is exactly true or false (list read from
    // environment-variables.ts by the owner-login gate; rab-api and rab-worker refuse anything else at boot).
    for (const pr of strictSwitchProblems(name, envOf(services[name]))) fail(pr);
    for (const removed of ['CREWFLOW_UPGRADE_FAILURE', 'CREWFLOW_UPGRADE_FAILURE_POLICY']) {
      if (removed in envOf(services[name])) fail(`${name}: commits the removed ${removed} (OWNER-DB-ULTIMATE Part B3)`);
    }
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
      // An env file's PG_DATABASE_URL (the sentinel planted in database.env) must never win over the committed value.
      if (value.includes(SENTINEL_OWNER_PW)) fail(`${name}: ${k} carries a value from an env file's PG_DATABASE_URL (the committed compose.env value must win)`);
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
/** Docker's root directory on this host (`docker info`), for the bind rule of the deployed model. Null when unknown. */
function dockerRootDir() {
  try {
    const out = execFileSync('docker', ['info', '--format', '{{.DockerRootDir}}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return out.startsWith('/') ? out : null;
  } catch {
    return null;
  }
}

/**
 * Security re-review R4: an ADDED service (not one of the five) gets the same container hardening as ours, and no route to
 * the host's privileged groups or sockets. Pure: never prints a value.
 */
function addedServiceProblems(name, svc, where) {
  const out = [];
  const user = String(svc?.user ?? '');
  const [uid, gid] = user.split(':');
  // R3: a canonical decimal uid ("01000", "00", "0000" are refused, never normalised into an allowed value).
  if (!/^(0|[1-9]\d*)$/.test(uid ?? '') || Number(uid) === 0 || Number(uid) === 1000) {
    out.push(`${name}: an added service must run as a numeric uid other than 0 and 1000${where} (user "${user}"; uid 1000 owns db-setup's password file)`);
  }
  if (gid !== undefined && (!/^(0|[1-9]\d*)$/.test(gid) || Number(gid) === 0)) out.push(`${name}: an added service must not run with group 0 or a non-numeric group${where} (user "${user}")`);
  if (svc?.group_add !== undefined && !(Array.isArray(svc.group_add) && svc.group_add.length === 0)) out.push(`${name}: group_add on an added service${where} (never: disk, docker or root groups reach the host)`);
  if (!(Array.isArray(svc?.cap_drop) && svc.cap_drop.includes('ALL'))) out.push(`${name}: an added service must drop all capabilities (cap_drop: [ALL])${where}`);
  if (Array.isArray(svc?.cap_add) && svc.cap_add.length) out.push(`${name}: an added service adds capabilities${where}`);
  if (!(Array.isArray(svc?.security_opt) && svc.security_opt.includes('no-new-privileges:true'))) out.push(`${name}: an added service must set security_opt no-new-privileges:true${where}`);
  if (svc?.privileged) out.push(`${name}: an added service is privileged${where}`);
  for (const ns of ['pid', 'ipc', 'network_mode', 'userns_mode', 'uts', 'cgroup']) if (String(svc?.[ns] ?? '').startsWith('host')) out.push(`${name}: an added service uses the host ${ns}${where}`);
  if (Array.isArray(svc?.devices) && svc.devices.length) out.push(`${name}: an added service maps host devices${where}`);
  // The bundled database's internal network: only db, db-setup, db-harden, rab-api and rab-worker are on it.
  if (Object.keys(svc?.networks ?? {}).includes('crewflow-db')) out.push(`${name}: an added service is on the bundled database's crewflow-db network${where}`);
  return out;
}

/**
 * Security re-review R3/R4: binds (any service) of Docker's root directory, an ancestor or a descendant of it (the root
 * from `docker info`; host sources are resolved with realpath when they exist), of anything under /run or /var/run, and of
 * any *.sock. Pure apart from realpath.
 */
function hostBindProblems(services, where, rootDir) {
  const out = [];
  const root = rootDir ? path.posix.normalize(rootDir).replace(/\/+$/, '') || '/' : null;
  for (const [name, svc] of Object.entries(services ?? {})) {
    for (const v of Array.isArray(svc?.volumes) ? svc.volumes : []) {
      if (v?.type !== 'bind') continue;
      let source = String(v.source ?? '').replace(/\\/g, '/');
      if (!source.startsWith('/')) continue;
      try {
        source = fs.realpathSync(source);
      } catch {
        /* not on this host: judged as written */
      }
      source = path.posix.normalize(source).replace(/\/+$/, '') || '/';
      const under = (dir) => source === dir || source.startsWith(`${dir}/`);
      if (root && (under(root) || root === source || root.startsWith(source === '/' ? '/' : `${source}/`))) {
        out.push(`${name}: binds Docker's root directory, an ancestor or a descendant of it${where} (it reaches every volume, the crewflow_owner password file included)`);
      }
      if (under('/run') || under('/var/run')) out.push(`${name}: binds a path under /run or /var/run${where} (runtime sockets and secrets)`);
      if (/\.sock$/.test(source) || /\.sock$/.test(String(v.target ?? ''))) out.push(`${name}: binds a socket (*.sock)${where}`);
    }
  }
  return out;
}

/** Release 0.7.0: the first release whose image runs the HWS cutover; HWS_RUNTIME_ENABLED=true needs at least this image. */
const HWS_MIN_IMAGE_VERSION = '0.7.0';
const HWS_CUTOVER_BACKUP_TARGET = '/run/crewflow/hws-cutover-backup';
const versionAtLeast = (v, min) => {
  const a = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v ?? ''));
  const b = /^(\d+)\.(\d+)\.(\d+)$/.exec(min);
  if (!a || !b) return false;
  for (let i = 1; i <= 3; i += 1) if (Number(a[i]) !== Number(b[i])) return Number(a[i]) > Number(b[i]);
  return true;
};

/**
 * Security review of the 0.7.0 release PR, M1: HWS on is tied to an image that runs the HWS cutover. Refuses
 * HWS_RUNTIME_ENABLED=true on rab-api / rab-worker unless the resolved image's baked CREWFLOW_APP_VERSION (Dockerfile ENV,
 * read with `docker image inspect` by the caller) is at least 0.7.0. Unknown version = refused (fail closed). Pure.
 */
function hwsImageProblems(services, imageAppVersion, where) {
  const out = [];
  for (const name of ['rab-api', 'rab-worker']) {
    const svc = services?.[name];
    if (!svc || String(envOf(svc).HWS_RUNTIME_ENABLED ?? '').trim().toLowerCase() !== 'true') continue;
    const version = typeof imageAppVersion === 'function' ? imageAppVersion(String(svc.image ?? '')) : null;
    if (!versionAtLeast(version, HWS_MIN_IMAGE_VERSION)) {
      out.push(`${name}: HWS_RUNTIME_ENABLED=true needs a ${HWS_MIN_IMAGE_VERSION} or later image (the release that runs the HWS cutover)${where}; the image reports CREWFLOW_APP_VERSION=${version ?? 'unknown'}`);
    }
  }
  return out;
}

/**
 * Security review of the 0.7.0 release PR, L2 (+ re-check R1): the rab-api HWS cutover backup bind. Its source is the
 * operator's (CREWFLOW_HWS_CUTOVER_BACKUP_DIR) and must be exactly /dev/null (unset), or an existing directory that:
 *   - is not the project directory, CREWFLOW_SECRETS_DIR, a service env file's directory or a --env-file's directory (nor an
 *     ancestor of one);
 *   - is not under /etc, /root, /home, /proc, /sys, /dev, /tmp or /boot;
 *   - holds only regular files (no symlink, no directory) named marker.json or *.dump.
 * Read-only is enforced by the volume comparison. Pure apart from realpath / stat / readdir.
 */
function backupBindProblems(services, { projectDirectory = null, secretsDir = null, envFiles = [] } = {}, where = '') {
  const out = [];
  const api = services?.['rab-api'];
  const norm = (p) => {
    let x = String(p ?? '').replace(/\\/g, '/');
    // A POSIX absolute path (the deploy host); a drive-letter path only so the suite also runs on a developer's Windows host.
    if (!x.startsWith('/') && !/^[A-Za-z]:\//.test(x)) return null;
    try {
      x = fs.realpathSync(x);
    } catch {
      /* judged as written */
    }
    return path.posix.normalize(x.replace(/\\/g, '/')).replace(/\/+$/, '') || '/';
  };
  for (const v of Array.isArray(api?.volumes) ? api.volumes : []) {
    if (v?.target !== HWS_CUTOVER_BACKUP_TARGET) continue;
    if (v.type !== 'bind') {
      out.push(`rab-api: the HWS cutover backup mount must be a bind${where}`);
      continue;
    }
    const raw = String(v.source ?? '');
    if (raw === '/dev/null') continue;
    const source = norm(raw);
    if (!source) {
      out.push(`rab-api: the HWS cutover backup directory must be an absolute path${where}`);
      continue;
    }
    let isDir = false;
    try {
      isDir = fs.statSync(source).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) out.push(`rab-api: the HWS cutover backup source is neither /dev/null nor an existing directory${where}`);
    const under = (dir) => source === dir || source.startsWith(`${dir}/`);
    for (const dir of ['/etc', '/root', '/home', '/proc', '/sys', '/dev', '/tmp', '/boot']) if (under(dir)) out.push(`rab-api: the HWS cutover backup directory is under ${dir}${where}`);
    if (isDir) {
      // Re-check R1: only the dump(s) and the marker; nothing else of the host is exposed through this mount.
      let entries = [];
      try {
        entries = fs.readdirSync(source, { withFileTypes: true });
      } catch {
        out.push(`rab-api: the HWS cutover backup directory cannot be listed${where}`);
      }
      const stray = entries.filter((e) => !e.isFile() || !(e.name === 'marker.json' || /\.dump$/.test(e.name)));
      if (stray.length) out.push(`rab-api: the HWS cutover backup directory holds something other than regular marker.json / *.dump files (${stray.length} entr${stray.length === 1 ? 'y' : 'ies'})${where}`);
    }
    if (source === '/') out.push(`rab-api: the HWS cutover backup directory is the host root${where}`);
    const envDirs = [];
    for (const svc of Object.values(services ?? {})) {
      for (const e of svc?.env_file ?? []) {
        const file = norm(typeof e === 'string' ? e : e?.path);
        if (file) envDirs.push(path.posix.dirname(file));
      }
    }
    const protectedDirs = [
      ['the project directory', norm(projectDirectory)],
      ['CREWFLOW_SECRETS_DIR', norm(secretsDir)],
      ...envDirs.map((d) => ['an env file directory', d]),
      ...(envFiles ?? []).map((f) => norm(f)).filter(Boolean).map((f) => ['an --env-file directory', path.posix.dirname(f)]),
    ];
    for (const [label, dir] of protectedDirs) {
      if (!dir) continue;
      if (dir === source || dir.startsWith(source === '/' ? '/' : `${source}/`)) out.push(`rab-api: the HWS cutover backup directory is ${label} or an ancestor of it${where}`);
    }
  }
  return out;
}

function checkDeployment(merged, production, envFileKeys = {}, { dockerRoot = undefined, imageAppVersion = null, projectDirectory = null, secretsDir = null, envFiles = [] } = {}) {
  const problems = [];
  const fail = (m) => problems.push(m);
  const services = merged?.services ?? {};
  for (const pr of hwsImageProblems(services, imageAppVersion, ' in the deployed model')) fail(pr);
  for (const pr of backupBindProblems(services, { projectDirectory, secretsDir, envFiles }, ' in the deployed model')) fail(pr);
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
    // Owner decision 2026-11-18: PG_DATABASE_URL is a compose.env value (the same on db-setup, rab-api and rab-worker); an
    // env file's value would be silently overridden, and the bundled db's passwords never belong in an env file.
    if (fromFiles.includes('PG_DATABASE_URL')) fail(`${name}: PG_DATABASE_URL is set in an env file (set it in compose.env: db-setup, rab-api and rab-worker take the same value)`);
    if (fromFiles.includes(APP_PASSWORD_KEY) || Object.prototype.hasOwnProperty.call(envOf(svc), APP_PASSWORD_KEY)) fail(`${name}: ${APP_PASSWORD_KEY} reaches the container (compose.env only)`);
    // Owner requirement 2026-11-17: an env file of rab-api / rab-worker carrying PG_ADMIN_URL would hand them the admin URL.
    for (const key of [ADMIN_URL_KEY, ...RETIRED_ADMIN_URL_KEYS]) if (fromFiles.includes(key)) fail(`${name}: ${key} is set in an env file (rab-api / rab-worker NEVER receive the admin URL; set PG_ADMIN_URL in compose.env, db-setup / db-harden only)`);
    if (fromFiles.includes('PG_DATABASE_PASSWORD') || Object.prototype.hasOwnProperty.call(envOf(svc), 'PG_DATABASE_PASSWORD')) fail(`${name}: PG_DATABASE_PASSWORD reaches the container (compose.env only)`);
    for (const [k, login] of Object.entries(envFileKeys[name]?.dbUsers ?? {})) {
      if (NOT_THE_APP_LOGIN.includes(login)) fail(`${name}: ${k} logs in as "${login}" (a former separated login)`);
    }
  }
  if (String(envOf(services['rab-api']).PG_DATABASE_URL ?? '') !== String(envOf(services['rab-worker']).PG_DATABASE_URL ?? '')) fail('PG_DATABASE_URL differs between rab-api and rab-worker in the deployed model');
  // Owner decision 2026-11-18: one crewflow_owner URL on db-setup, rab-api and rab-worker; no admin URL on the app services.
  for (const pr of optionAProblems(services, ' in the deployed model', { renderedWait: null })) fail(pr);
  for (const pr of credentialMountProblems(services, ' in the deployed model')) fail(pr);
  // Security re-review F2: an override may add services; none of them may run as root or as uid 1000 (the app's uid),
  // whatever it mounts.
  for (const [name, svc] of Object.entries(services)) {
    if (KNOWN_SERVICES.includes(name)) continue;
    for (const pr of addedServiceProblems(name, svc, ' in the deployed model')) fail(pr);
  }
  for (const pr of hostBindProblems(services, ' in the deployed model', dockerRoot === undefined ? '/var/lib/docker' : dockerRoot)) fail(pr);
  for (const pr of topLevelVolumeProblems(merged, ' in the deployed model', { strict: true })) fail(pr);
  const setup = services[DB_SETUP_SERVICE];
  const pset = production?.services?.[DB_SETUP_SERVICE];
  // db-setup's own database (PG_ADMIN_URL or PG_DATABASE_URL at a host other than the bundled db): decides whether the
  // bundled db may be off.
  let ownDatabase = false;
  if (setup) {
    const fromFiles = envFileKeys[DB_SETUP_SERVICE]?.names ?? [];
    if (fromFiles.includes('PG_DATABASE_URL')) fail(`${DB_SETUP_SERVICE}: PG_DATABASE_URL is set in an env file (set it in compose.env; the committed default would silently override it)`);
    for (const key of [ADMIN_URL_KEY, ...RETIRED_ADMIN_URL_KEYS]) if (fromFiles.includes(key)) fail(`${DB_SETUP_SERVICE}: ${key} is set in an env file (set PG_ADMIN_URL in compose.env; the committed value would silently override it)`);
    if (fromFiles.includes('PG_DATABASE_PASSWORD') || Object.prototype.hasOwnProperty.call(envOf(setup), 'PG_DATABASE_PASSWORD')) fail(`${DB_SETUP_SERVICE}: PG_DATABASE_PASSWORD reaches the container (compose.env only)`);
    if (fromFiles.includes(APP_PASSWORD_KEY)) fail(`${DB_SETUP_SERVICE}: ${APP_PASSWORD_KEY} reaches the container from an env file (compose.env only)`);
    if (fromFiles.includes('APP_SECRET')) fail(`${DB_SETUP_SERVICE}: APP_SECRET reaches the container from an env file (db-setup reads database.env only)`);
    for (const [k, login] of Object.entries(envFileKeys[DB_SETUP_SERVICE]?.dbUsers ?? {})) {
      if (NOT_THE_APP_LOGIN.includes(login)) fail(`${DB_SETUP_SERVICE}: ${k} logs in as "${login}" (a former separated login)`);
    }
    // The three modes (owner decision 2026-11-18), the SAME rule as the compose.env lint (dbSettingsProblems): PG_DATABASE_URL
    // only crewflow_owner; PG_ADMIN_URL never crewflow_owner; sslmode require / verify-ca / verify-full (a pooler is refused by
    // db-setup's capability checks, never by address); PG_DATABASE_PASSWORD (inside
    // db-setup's bundled URL) exactly while the bundled db runs.
    const senv = envOf(setup);
    for (const key of DB_SETUP_DB_KEYS) if (!Object.prototype.hasOwnProperty.call(senv, key)) fail(`${DB_SETUP_SERVICE}: ${key} is missing in the deployed model`);
    const bundled = String(services[DB_SERVICE]?.deploy?.replicas ?? 1) === '0' ? '0' : '1';
    if (String(senv.CREWFLOW_BUNDLED_DB ?? '1') !== bundled) fail(`${DB_SETUP_SERVICE}: CREWFLOW_BUNDLED_DB differs from db's replica count in the deployed model`);
    let passwordSet = false;
    try { passwordSet = new URL(String(senv.CREWFLOW_BUNDLED_DB_ADMIN_URL ?? '')).password !== ''; } catch { /* missing: reported above */ }
    for (const msg of dbSettingsProblems({ adminUrl: senv[ADMIN_URL_KEY], appUrl: senv.PG_DATABASE_URL, bundled, passwordSet })) fail(`${DB_SETUP_SERVICE}: ${msg} (deployed model)`);
    // Your own database: the crewflow_owner URL (and any admin URL) names a host other than the bundled db.
    const hostOf = (u) => { try { return new URL(String(u ?? '')).hostname; } catch { return ''; } };
    const hosts = [senv.PG_DATABASE_URL, senv[ADMIN_URL_KEY]].filter((u) => u !== undefined && String(u) !== '').map(hostOf);
    ownDatabase = hosts.length > 0 && hosts.every((h) => h !== '' && h !== DB_SERVICE);
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
  // Owner decision 2026-11-18 (M1): db-harden reads database.env only and takes its database settings from compose.env,
  // exactly as db-setup (optionAProblems holds them equal); an override must not change its shape.
  const harden = services[DB_HARDEN_SERVICE];
  const phard = production?.services?.[DB_HARDEN_SERVICE];
  if (harden) {
    const fromFiles = envFileKeys[DB_HARDEN_SERVICE]?.names ?? [];
    if (fromFiles.includes('PG_DATABASE_URL')) fail(`${DB_HARDEN_SERVICE}: PG_DATABASE_URL is set in an env file (set it in compose.env; the committed default would silently override it)`);
    for (const key of [ADMIN_URL_KEY, ...RETIRED_ADMIN_URL_KEYS]) if (fromFiles.includes(key)) fail(`${DB_HARDEN_SERVICE}: ${key} is set in an env file (set PG_ADMIN_URL in compose.env; the committed value would silently override it)`);
    if (fromFiles.includes(HARDEN_TIMEOUT_KEY)) fail(`${DB_HARDEN_SERVICE}: ${HARDEN_TIMEOUT_KEY} is set in an env file (set it in compose.env; the committed default would silently override it)`);
    if (fromFiles.includes('PG_DATABASE_PASSWORD') || Object.prototype.hasOwnProperty.call(envOf(harden), 'PG_DATABASE_PASSWORD')) fail(`${DB_HARDEN_SERVICE}: PG_DATABASE_PASSWORD reaches the container (compose.env only)`);
    if (fromFiles.includes(APP_PASSWORD_KEY)) fail(`${DB_HARDEN_SERVICE}: ${APP_PASSWORD_KEY} reaches the container from an env file (compose.env only)`);
    if (fromFiles.includes('APP_SECRET')) fail(`${DB_HARDEN_SERVICE}: APP_SECRET reaches the container from an env file (db-harden reads database.env only)`);
    for (const [k, login] of Object.entries(envFileKeys[DB_HARDEN_SERVICE]?.dbUsers ?? {})) {
      if (NOT_THE_APP_LOGIN.includes(login)) fail(`${DB_HARDEN_SERVICE}: ${k} logs in as "${login}" (a former separated login)`);
    }
    if (phard) {
      for (const key of DB_SETUP_KEYS) {
        const av = key === 'volumes' ? withoutCa(harden.volumes) : harden[key];
        const bv = key === 'volumes' ? withoutCa(phard.volumes) : phard[key];
        if (stable(av) !== stable(bv)) fail(`${DB_HARDEN_SERVICE}.${key} differs from docker-compose.production.yml in the deployed model`);
      }
      if (hasDeps(harden.depends_on)) fail(`${DB_HARDEN_SERVICE}.depends_on is added in the deployed model (it has none)`);
    }
  }
  // DB-SETUP: the bundled db as committed (an override must not weaken it), and the Worker wrapper.
  const ddb = services[DB_SERVICE];
  const pdb = production?.services?.[DB_SERVICE];
  if (!ddb) fail(`${DB_SERVICE}: missing in the deployed model`);
  else if (pdb) {
    for (const key of DB_KEYS.filter((k) => k !== 'environment' && k !== 'image' && k !== 'deploy')) if (stable(ddb[key]) !== stable(pdb[key])) fail(`${DB_SERVICE}.${key} is overridden in the deployed model`);
    // CREWFLOW_BUNDLED_DB (Twenty's Helm db.enabled): the deploy section is the reference render's except replicas, which is
    // 1, or 0 only when db-setup's PG_DATABASE_URL names your own database (any host but the bundled `db`).
    const withoutReplicas = (d) => { const { replicas: _r, ...rest } = d ?? {}; return rest; };
    if (stable(withoutReplicas(ddb.deploy)) !== stable(withoutReplicas(pdb.deploy))) fail(`${DB_SERVICE}.deploy is overridden in the deployed model (only deploy.replicas may differ)`);
    const replicas = ddb.deploy?.replicas;
    if (!(replicas === 1 || (replicas === 0 && ownDatabase))) fail(`${DB_SERVICE}.deploy.replicas is ${replicas === undefined ? 'unset' : replicas} (only 1, or 0 with your own database in PG_DATABASE_URL and any PG_ADMIN_URL)`);
    // PR #125 review, finding 6: the deployed db's environment holds the real password, so it is not compared with the
    // reference render; it is checked against the same rules as the committed one (names and rules only, never a value).
    // Owner decision 2026-11-17: the password is required only while the bundled db runs (replicas 1).
    for (const msg of bundledDbEnvironmentProblems(ddb.environment ?? {}, { requirePassword: replicas !== 0 })) fail(`${msg} in the deployed model`);
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
      const expected = key === 'volumes' ? withoutCa(b.volumes, name) : b[key];
      if (stable(value) !== stable(expected)) fail(`${name}.${key} differs from docker-compose.production.yml in the deployed model`);
    }
    // The approval mode is the operator's compose.env opt-in (BC-11/C4): validated, not compared with the reference render.
    // AI_ENABLED (owner decision 2026-11-20) is the operator's compose.env switch: validated below, not compared.
    for (const key of PINNED_ENV.filter((k) => k !== 'STORAGE_KEY_PREFIX' && k !== 'CREWFLOW_MIGRATION_APPROVAL_MODE' && k !== AI_ENABLED_KEY)) {
      if (stable(pinnedEnvValue(envOf(a), key)) !== stable(pinnedEnvValue(envOf(b), key))) fail(`${name}.environment.${key} is overridden in the deployed model`);
    }
    if (name === 'rab-api' && !['none', 'token'].includes(String(envOf(a).CREWFLOW_MIGRATION_APPROVAL_MODE ?? ''))) fail('rab-api: CREWFLOW_MIGRATION_APPROVAL_MODE is not none or token in the deployed model');
    if (!SWITCH_VALUES.includes(String(envOf(a)[AI_ENABLED_KEY] ?? ''))) fail(`${name}: ${AI_ENABLED_KEY} is not exactly true or false in the deployed model (compose.env; unset = false)`);
    if ((envFileKeys[name]?.names ?? []).includes(AI_ENABLED_KEY)) fail(`${name}: ${AI_ENABLED_KEY} is set in an env file (set it in compose.env; the committed ${AI_ENABLED_EXPR} would silently override it)`);
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
  // Owner decision 2026-11-20: one AI switch for both services (the Worker refuses every queued turn while it is false).
  if (services['rab-api'] && services['rab-worker'] && String(envOf(services['rab-api'])[AI_ENABLED_KEY] ?? '') !== String(envOf(services['rab-worker'])[AI_ENABLED_KEY] ?? '')) fail(`${AI_ENABLED_KEY} differs between rab-api and rab-worker in the deployed model (one compose.env value for both)`);
  // Phase X J2 (SJ-03): the switches come from the env files (or a compose value); the intervals must be committed.
  const switchesFromFiles = Object.fromEntries(['rab-api', 'rab-worker'].map((n) => [n, envFileKeys[n]?.switches ?? {}]));
  for (const pr of featureSweepProblems(envOf(services['rab-api']), envOf(services['rab-worker']), switchesFromFiles, ' in the deployed model')) fail(pr);
  for (const name of ['rab-api', 'rab-worker']) for (const pr of strictSwitchProblems(name, envOf(services[name]))) fail(`${pr} in the deployed model`);
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
    const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CREWFLOW_|DATABASE_|REDIS_URL|PG_|COMPOSE_|DB_TARGET|AI_ENABLED$)/.test(k)));
    const env = {
      ...base,
      ...PRODUCTION_REQUIRED_DUMMIES,
      CREWFLOW_IMAGE_TAG: SENTINEL_DIGEST,
      CREWFLOW_REDIS_IMAGE: `redis@sha256:${'0c'.repeat(32)}`,
      CREWFLOW_SECRETS_DIR: secrets.split(path.sep).join('/'),
    };
    const variant = render([variantPath], { projectDirectory: dir, env, resolveEnvFiles: true });
    const rawFiles = render([variantPath], { projectDirectory: dir, env, resolveEnvFiles: false });
    // Whether this Compose reports env_file under --no-env-resolution. The probe looks at the services that declare one in
    // the committed file (rab-api, rab-worker, db-setup); it used to look at rab-migrate, which O3 removed, so on every
    // Compose the preflight refused with "does not report env_file" before checking anything (found in the #189 review).
    const composeReportsEnvFiles = ['rab-api', 'rab-worker', DB_SETUP_SERVICE].every((n) => (rawFiles.services?.[n]?.env_file ?? []).length > 0);
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

/**
 * The external database's CA file (CREWFLOW_PG_CA_FILE in compose.env, mounted read-only as /run/crewflow/pg-ca.crt and read
 * through PG_SSL_CA_CERT_PATH): the app's own boot rules (pg-ca-pem.cjs, the parity-tested port of pg-tls.ts), checked here
 * before a deploy instead of at the API's first boot. Unset or empty = nothing to check (the compose file mounts /dev/null).
 * A relative path is resolved like Compose does, against the project directory. Names only, never the file's content.
 */
function pgCaFileEnvironmentProblems(env, projectDirectory) {
  const file = String(env.CREWFLOW_PG_CA_FILE ?? '').trim();
  if (!file) return [];
  const problem = pgCaFileProblem(path.resolve(projectDirectory, file), 'CREWFLOW_PG_CA_FILE (mounted as PG_SSL_CA_CERT_PATH)');
  return problem ? [`${problem} rab-api and rab-worker would refuse to start.`] : [];
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
  for (const name of ['rab-api', 'rab-worker', DB_SETUP_SERVICE, DB_HARDEN_SERVICE]) {
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
  return {
    problems: [
      ...images.problems,
      ...skippedEnvFiles,
      ...pgCaFileEnvironmentProblems(env, projectDirectory),
      ...checkDeployment(model, production, envFileKeys, {
        dockerRoot: dockerRootDir() ?? '/var/lib/docker',
        imageAppVersion: imageAppVersionOf,
        projectDirectory,
        secretsDir: env.CREWFLOW_SECRETS_DIR ?? null,
        envFiles: envFileArgs.map((f) => path.resolve(f)),
      }),
    ],
    lines: images.lines,
  };
}

/** The resolved image's baked CREWFLOW_APP_VERSION (`docker image inspect`; pull the release first). Null when unknown. */
function imageAppVersionOf(ref) {
  if (!ref) return null;
  try {
    const envs = JSON.parse(execFileSync('docker', ['image', 'inspect', '--format', '{{json .Config.Env}}', ref], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
    const hit = (Array.isArray(envs) ? envs : []).find((e) => String(e).startsWith('CREWFLOW_APP_VERSION='));
    return hit ? String(hit).slice('CREWFLOW_APP_VERSION='.length) : null;
  } catch {
    return null;
  }
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
  hwsImageProblems, backupBindProblems, HWS_MIN_IMAGE_VERSION,
  NOT_THE_APP_LOGIN, PINNED_ENV, BLANK_IS_UNSET_PINNED_ENV, pinnedEnvValue, DB_SERVICE, DB_SETUP_SERVICE, DB_HARDEN_SERVICE, ADMIN_SERVICES, PID1_ENTRYPOINTS, optionAProblems, dbHardenProblems, pid1Problems, checkVariant, checkResolvedImages, checkDeployment, DIGEST_REF, RUNTIME_KEYS, NOTIFICATION_DELIVERY, PHASE_D_SWITCHES, PHASE_D_UNCHANGED, STATEMENT_DISPATCH, FEATURE_SWEEPS, SWITCH_VALUES, featureSweepProblems, composeEnvValue, readEnvFileKeys, pgCaFileEnvironmentProblems, SENTINEL_MIGRATOR_PW, SENTINEL_OPS_PW, SENTINEL_OWNER_PW, renderModels, staticMode };
