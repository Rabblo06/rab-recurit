#!/usr/bin/env node
'use strict';
/**
 * Phase B (P7, B6-A exit gate "no migrator credential in the API/Worker environment"): renders the committed compose files
 * with `docker compose config --format json` and asserts that the migration credential reaches the one-off migration
 * service ONLY.
 *
 *   node packages/rab-docker/scripts/compose-credential-isolation.cjs
 *
 * For each file it renders in a throw-away project directory (so no real .env, .env.migrate or ../rab-server/.env of
 * this machine is ever read), with a sentinel .env.migrate holding a dummy migrator URL and dummy values for every
 * required interpolation variable. Then, from the rendered model:
 *   - the migration service (rab-migrate / migrate) carries the sentinel PG_DATABASE_URL (it really reads .env.migrate);
 *   - the API and Worker services: no env_file entry naming .env.migrate, no environment value containing the sentinel
 *     password or the migrator login name, and none of the migration-authority names (CREWFLOW_MIGRATION_APPROVED,
 *     CREWFLOW_MIGRATION_DATABASE_URL, ALLOW_PRODUCTION_DB_COMMANDS, DATABASE_URL_UNPOOLED with a value);
 *   - the production file (O3, owner decisions C1-C5: the API migrates on start): there is NO migration service, nothing
 *     names .env.migrate, nothing depends on a rab-migrate, and the runtime services carry no migration credential or
 *     authority and no legacy DATABASE_URL / DATABASE_DIRECT_URL key. Since OWNER-DB-ULTIMATE.md Part F2 (X2.3) the dev and
 *     QA files follow the same lifecycle: no `migrate` service either.
 *
 * rab-ops removal (PR 2): the separated operations container `rab-ops` and its .env.ops are retired; operations run as
 * one-off owner-login commands of the API image. The refusals stay, so neither can come back unnoticed. A sentinel .env.ops
 * (a crewflow_app URL with its own sentinel password, a migrator URL, the operator label) is still planted in the
 * throw-away project and every file is rendered with EVERY profile enabled (`--profile '*'`, security review of PR #124:
 * a service re-added under any profile, e.g. `rab-maint` with `profiles: ["maint"]` reading .env.ops, is rendered, not
 * hidden), and in every file:
 *   - no service is named rab-ops and no service has the "ops" profile; in the production files (production.yml,
 *     local-build.yml) no service has any profile at all (every service starts with the stack);
 *   - no service names .env.ops, carries a value of the ops sentinel, or holds any ops-only name (CREWFLOW_OPS_*, PG_OPS_*).
 * opsRefusalChecks() is the pure part; compose-credential-isolation.ops.test.cjs proves each refusal.
 *
 * DB-SETUP (owner decisions D1 a / D4, T-2): the bundled database's superuser password, PG_DATABASE_PASSWORD, is a compose
 * interpolation value only. Rendered with a sentinel value (and PG_DATABASE_URL unset, so the bundled defaults are rendered),
 * in every file: no service has a PG_DATABASE_PASSWORD key, and the sentinel appears only in the bundled `db` service's
 * POSTGRES_PASSWORD and in db-setup's bundled superuser URL. dbPasswordChecks() is the pure part.
 * Owner decision 2026-11-18 (Twenty's way): the bundled crewflow_owner password, PG_DATABASE_APP_PASSWORD (dev / QA:
 * CREWFLOW_DEV_DB_APP_PASSWORD / CREWFLOW_QA_DB_APP_PASSWORD), is a compose interpolation value only too: rendered with its
 * own sentinel, it appears ONLY inside PG_DATABASE_URL of db-setup, the API and the Worker, and no service has the key itself
 * (appPasswordChecks, pure).
 *
 * The files with a bundled `db` (production, dev, QA) are checked for the database-setup contract (dbSetupContractChecks,
 * pure; owner decision 2026-11-18, Twenty's way): a one-shot db-setup (entrypoint ./db-setup.sh after a healthy db, or in
 * production the wait-for-db wrapper with no depends_on (db-setup-wait.cjs, owner instruction 2026-11-18), restart "no", no
 * port, the CA read-only, no APP_SECRET) with PG_DATABASE_URL = a crewflow_owner URL (sslmode=verify-full); the
 * API and the Worker on ./api-prestart.sh / ./worker-start.sh (no compose init) with EXACTLY db-setup's PG_DATABASE_URL, no
 * other database URL in any variable, PG_ADMIN_URL pinned to "" and the CA read-only; the API waits for db-setup to
 * complete. No file carries a credential any more: the retired crewflow-db-target volume (db-setup's target + password
 * files) is refused in EVERY file, as a volume or as any mount at /run/crewflow/db-target (retiredTargetVolumeChecks). The
 * dev and QA `db` services must render EXACTLY as production's `db` (bundledDbParityChecks, pure): they are verbatim
 * copies, so a drift in either direction (TLS, authentication, hardening, image) fails here. db-setup, the API and the
 * Worker run one image.
 * Security review of F2 (pure parts, each with denial tests): the crewflow-db network and the two db volumes match
 * production's (internal; never external or custom-named); the committed db TEXT matches production's (rawDbTextParityChecks);
 * only db mounts the data volume (dbVolumeMountChecks); in dev and QA db-setup's two URLs are pinned to host `db` (the
 * crewflow_owner one also on server / worker) and the file never names production's PG_DATABASE_PASSWORD /
 * PG_DATABASE_APP_PASSWORD (nonProductionDbSetupChecks); and the db entrypoint takes the one-server-per-volume kernel lock
 * before anything else (dbServerLockChecks, M1).
 * Exit 0 = all checks passed, 1 = a check failed, 2 = docker compose is unavailable (CI must have it).
 * Prints service names, variable NAMES and check results only; never a value.
 *
 * X1.9 (S10 / DEAD-08): which service NAMES .env.migrate / .env.ops is read from the committed YAML with the `yaml` package,
 * a declared root devDependency (exact version). The check used to skip those checks, with only a note and exit 0, when
 * `yaml` could not be loaded, so a missing parser silently passed the gate. A missing or broken parser, or a compose file
 * it cannot parse, is now a FAILED check (exit 1, before docker runs): a security check that cannot run has not passed.
 * compose-credential-isolation.test.cjs injects a failing loader to prove it.
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { dbSetupEntrypointForm, dbSetupStartProblems, WAIT_SECONDS_DEFAULT } = require('./db-setup-wait.cjs');

const REPO = path.resolve(__dirname, '../../..');
const SENTINEL_PASSWORD = 'SENTINEL-MIGRATOR-PW-0f3a9c'; // gitleaks:allow (synthetic marker the check plants, not a credential)
const SENTINEL_URL = `postgresql://crewflow_migrator:${SENTINEL_PASSWORD}@db-direct.example:5432/rab?sslmode=verify-full`;
const MIGRATION_AUTHORITY = ['CREWFLOW_MIGRATION_APPROVED', 'CREWFLOW_MIGRATION_DATABASE_URL', 'ALLOW_PRODUCTION_DB_COMMANDS', 'DATABASE_URL_UNPOOLED'];
// Phase B (ops): the one-off operations container. Its own sentinel password marks every value that came from .env.ops.
const OPS_SENTINEL_PASSWORD = 'SENTINEL-OPS-APP-PW-7c21de'; // gitleaks:allow (synthetic marker, not a credential)
const OPS_SENTINEL_APP_URL = `postgresql://crewflow_app:${OPS_SENTINEL_PASSWORD}@db-direct.example:5432/rab?sslmode=verify-full`;
// DB-SETUP: the bundled db's superuser password (synthetic marker, not a credential).
const DB_SENTINEL_PASSWORD = 'SENTINELDBPW0b7e41c9d2a8f3561e'; // gitleaks:allow (synthetic marker, not a credential)
// Owner decision 2026-11-18: the bundled crewflow_owner password (synthetic marker, not a credential; URL-safe hex-like).
const APP_SENTINEL_PASSWORD = 'SENTINELAPPPW7d2c90e1b4a6f8c35'; // gitleaks:allow (synthetic marker, not a credential)
// Transaction pooler support (owner instruction 2026-11-19): PG_DATABASE_SESSION_URL, the optional direct session connection of
// the same crewflow_owner login. A sentinel of its own, so where it lands is checked separately from PG_DATABASE_URL.
const SESSION_SENTINEL_PASSWORD = 'SENTINELSESSIONPW4e9b1c7a03d5f'; // gitleaks:allow (synthetic marker, not a credential)
const SESSION_SENTINEL_URL = `postgresql://crewflow_owner:${SESSION_SENTINEL_PASSWORD}@db-session.example:5432/crewflow?sslmode=verify-full`;
const SESSION_URL_KEY = 'PG_DATABASE_SESSION_URL';
const OPS_ONLY_NAMES = ['CREWFLOW_OPS_RUN', 'PG_OPS_APP_DATABASE_URL', 'CREWFLOW_OPS_ACTOR_SOURCE', 'CREWFLOW_OPS_ACTOR_ID', 'CREWFLOW_OPS_CHANGE_REF'];

const PRODUCTION_FILE = 'packages/rab-docker/docker-compose.production.yml';
/**
 * [compose file, migration service (null = none, O3), runtime services [api, worker], production?, bundled db + db-setup?]
 * Part F2 (X2.3): dev and QA run Part A's setup (bundled db + db-setup, the API migrates on start), so neither has a
 * migration service any more. The production file is listed first: its rendered `db` is the reference for the parity check.
 */
const FILES = [
  [PRODUCTION_FILE, null, ['rab-api', 'rab-worker'], true, true],
  // LOCAL/DEV ONLY build-from-source copy of the production contract (owner decision 2026-11-11): same credential rules.
  // Not yet on Part A's setup (it still takes a crewflow_owner URL per service), so the db-setup contract is not checked.
  ['packages/rab-docker/docker-compose.local-build.yml', null, ['rab-api', 'rab-worker'], true, false],
  ['packages/rab-docker/docker-compose.yml', null, ['server', 'worker'], false, true],
  ['packages/rab-docker/docker-compose.qa.yml', null, ['server', 'worker'], false, true],
];

// Dummy values for every `${VAR:?}` the files require (never real secrets).
const DUMMY_ENV = {
  CREWFLOW_IMAGE_TAG: `sha256:${'0'.repeat(64)}`,
  QA_APP_SECRET: 'dummy-dummy-dummy-dummy-dummy-dummy',
  // docker-compose.production.yml's REQUIRED list (x-crewflow-required-env, owner request 2026-11-12: OpenShip shows every
  // variable). PG_DATABASE_URL is deliberately NOT set: db-setup then renders the bundled default admin URL, built from
  // the PG_DATABASE_PASSWORD sentinel below, so its spread is checked (option A).
  APP_SECRET: 'dummy-dummy-dummy-dummy-dummy-dummy',
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
  // DB-SETUP: the bundled db's password; a sentinel so its spread is checked. Production names it PG_DATABASE_PASSWORD; dev
  // and QA have their own variables (security review L4), given the SAME sentinel so the db services render identically.
  PG_DATABASE_PASSWORD: DB_SENTINEL_PASSWORD,
  CREWFLOW_DEV_DB_PASSWORD: DB_SENTINEL_PASSWORD,
  CREWFLOW_QA_DB_PASSWORD: DB_SENTINEL_PASSWORD,
  // Owner decision 2026-11-18: the bundled crewflow_owner password (production's name and dev / QA's own), one sentinel.
  PG_DATABASE_APP_PASSWORD: APP_SENTINEL_PASSWORD,
  CREWFLOW_DEV_DB_APP_PASSWORD: APP_SENTINEL_PASSWORD,
  CREWFLOW_QA_DB_APP_PASSWORD: APP_SENTINEL_PASSWORD,
  // The optional session URL, set so that every service it reaches is visible in the rendered model.
  [SESSION_URL_KEY]: SESSION_SENTINEL_URL,
};

let failures = 0;
const check = (ok, label) => {
  console.log(`[compose-isolation] ${ok ? 'PASS' : 'FAIL'} ${label}`);
  if (!ok) failures += 1;
};

function render(rel, exec = execFileSync) {
  // Project directory = a scratch copy location: env_file and `.env` resolve there, never against the real checkout.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-isolation-'));
  const project = path.join(tmp, 'rab-docker');
  fs.mkdirSync(project);
  fs.mkdirSync(path.join(tmp, 'rab-server'));
  fs.writeFileSync(path.join(tmp, 'rab-server', '.env'), '');
  fs.writeFileSync(path.join(project, '.env'), '');
  fs.writeFileSync(path.join(project, '.env.migrate'), `PG_DATABASE_URL=${SENTINEL_URL}\nCREWFLOW_MIGRATION_APPROVED=pending-1-${'0'.repeat(64)}\n`, { mode: 0o600 });
  fs.writeFileSync(
    path.join(project, '.env.ops'),
    [
      'CREWFLOW_OPS_RUN=one-off',
      `PG_OPS_APP_DATABASE_URL=${OPS_SENTINEL_APP_URL}`,
      `PG_DATABASE_URL=${SENTINEL_URL}`,
      'CREWFLOW_OPS_ACTOR_SOURCE=github-actions',
      `CREWFLOW_OPS_ACTOR_ID=${OPS_SENTINEL_PASSWORD}-actor`,
      `CREWFLOW_OPS_CHANGE_REF=${OPS_SENTINEL_PASSWORD}-ref`,
    ].join('\n') + '\n',
    { mode: 0o600 },
  );
  try {
    const out = exec(
      'docker',
      ['compose', '--project-directory', project, '-p', 'compose-isolation-check', '-f', path.join(REPO, rel), '--profile', '*', 'config', '--format', 'json'],
      { env: { ...process.env, ...DUMMY_ENV, CREWFLOW_MIGRATION_DATABASE_URL: '', CREWFLOW_MIGRATION_APPROVED: '' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return JSON.parse(out);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const envOf = (svc) => svc.environment ?? {};

/**
 * rab-ops removal (PR 2): the retired operations container and its environment must not come back. Pure: returns
 * [ok, label] pairs for one rendered model (`services`) and the env_file names read from the committed YAML (`raw`).
 * X1.9: `raw` is required. main() never calls this without it (a missing parser or an unparsable file fails first); a null
 * `raw` here is itself a FAILED check, never a skipped env_file-name check.
 */
function opsRefusalChecks(rel, services, raw, { production = false } = {}) {
  const out = [];
  const namesOpsFile = (name) => (raw?.[name] ?? []).some((f) => /(^|\/)\.env\.ops$/.test(f));
  out.push([Boolean(raw), `${rel}: the env_file names were read from the committed YAML (the .env.ops check has input)`]);
  out.push([!services['rab-ops'], `${rel}: has no rab-ops service (removed; operations run as one-off owner-login commands of rab-api)`]);
  for (const [name, svc] of Object.entries(services)) {
    const env = envOf(svc ?? {});
    const values = Object.values(env).map((v) => String(v ?? ''));
    out.push([!(Array.isArray(svc?.profiles) && svc.profiles.includes('ops')), `${rel}: ${name} has no "ops" profile (the rab-ops container was removed)`]);
    if (production) out.push([!(Array.isArray(svc?.profiles) && svc.profiles.length), `${rel}: ${name} has no profile (a production file has no profile-gated service)`]);
    out.push([!namesOpsFile(name), `${rel}: ${name} does not name .env.ops`]);
    out.push([!values.some((v) => v.includes(OPS_SENTINEL_PASSWORD)), `${rel}: ${name} carries no value of the ops environment`]);
    const held = OPS_ONLY_NAMES.filter((k) => String(env[k] ?? '').trim() !== '');
    out.push([held.length === 0, `${rel}: ${name} holds no ops-only variable${held.length ? ` (${held.join(', ')})` : ''}`]);
  }
  return out;
}

/**
 * DB-SETUP: where the bundled db's superuser password may appear in one rendered model. Pure: [ok, label] pairs. Only the
 * `db` service's POSTGRES_PASSWORD and db-setup's superuser URL (production: CREWFLOW_BUNDLED_DB_ADMIN_URL; dev / QA: the
 * pinned PG_ADMIN_URL) may hold it; no service may have a PG_DATABASE_PASSWORD key; nothing else in any other service's
 * definition (health check, command, labels) holds it.
 */
function dbPasswordChecks(rel, services) {
  const out = [];
  for (const [name, svc] of Object.entries(services)) {
    const env = envOf(svc ?? {});
    out.push([!Object.prototype.hasOwnProperty.call(env, 'PG_DATABASE_PASSWORD'), `${rel}: ${name} has no PG_DATABASE_PASSWORD variable (a compose interpolation value only)`]);
    // db-setup: production's bundled URL (CREWFLOW_BUNDLED_DB_ADMIN_URL), or dev / QA's pinned PG_ADMIN_URL (owner decision
    // 2026-11-17: the admin URL is PG_ADMIN_URL; PG_DATABASE_URL is only ever crewflow_owner).
    // db-harden (owner decision 2026-11-18, M1) holds exactly db-setup's database settings.
    const allowedKeys = name === 'db' ? ['POSTGRES_PASSWORD'] : ADMIN_SERVICES.includes(name) ? ['CREWFLOW_BUNDLED_DB_ADMIN_URL', 'PG_ADMIN_URL'] : [];
    const holders = Object.entries(env).filter(([k, v]) => String(v ?? '').includes(DB_SENTINEL_PASSWORD) && !allowedKeys.includes(k)).map(([k]) => k);
    out.push([holders.length === 0, `${rel}: ${name} carries the bundled db's password only as db's POSTGRES_PASSWORD or the bundled admin URL of db-setup / db-harden${holders.length ? ` (found in ${holders.join(', ')})` : ''}`]);
    // Outside the environment (health check, command, entrypoint, labels): never, in any service.
    const rest = { ...(svc ?? {}) };
    delete rest.environment;
    out.push([!JSON.stringify(rest).includes(DB_SENTINEL_PASSWORD), `${rel}: ${name} carries the bundled db's password nowhere outside its environment (health check, command, labels)`]);
  }
  return out;
}

/**
 * The services that may hold the admin login: the one-shot db-setup, and the one-shot CREATEROLE hardening db-harden (owner
 * decision 2026-11-18, security review of PR #246, M1: the same image, entrypoint `./db-setup.sh harden`, db-setup's database
 * settings, NO depends_on, and nothing depends on it).
 */
const ADMIN_SERVICES = Object.freeze(['db-setup', 'db-harden']);
const HARDEN_ENTRYPOINT = Object.freeze(['./db-setup.sh', 'harden']);

/** The retired setup volume (PR #125 option 2): db-setup's target file and crewflow_owner password file. Never again. */
const RETIRED_TARGET_VOLUME = 'crewflow-db-target';
const RETIRED_TARGET_DIR = '/run/crewflow/db-target';
const DB_CA_DIR = '/run/crewflow/db-ca';
const DB_URL_VALUE = /postgres(ql)?:\/\//i;
const OWNER_LOGIN = 'crewflow_owner';
const mountAt = (svc, target) => (svc?.volumes ?? []).find((v) => v && typeof v === 'object' && v.target === target);
const underTargetDir = (t) => {
  const n = String(t ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
  return n === RETIRED_TARGET_DIR || n.startsWith(`${RETIRED_TARGET_DIR}/`);
};
/** The login and sslmode of a rendered URL value, or null when it is not a URL. Never returns the password. */
function urlFacts(value) {
  try {
    const u = new URL(String(value ?? ''));
    return { login: decodeURIComponent(u.username), host: u.hostname, sslmode: u.searchParams.get('sslmode'), password: u.password !== '' };
  } catch {
    return null;
  }
}

/**
 * Owner decision 2026-11-18: where the bundled crewflow_owner password may appear in one rendered model (rendered with
 * APP_SENTINEL_PASSWORD). Pure: [ok, label] pairs. Only PG_DATABASE_URL of db-setup and of `runtimeNames` (the API and the
 * Worker) may hold it; no service has a PG_DATABASE_APP_PASSWORD (or dev / QA app-password) key; nothing outside a
 * service's environment holds it.
 */
function appPasswordChecks(rel, services, runtimeNames) {
  const out = [];
  const holdersAllowed = [...ADMIN_SERVICES, ...runtimeNames];
  for (const [name, svc] of Object.entries(services)) {
    const env = envOf(svc ?? {});
    const keys = ['PG_DATABASE_APP_PASSWORD', 'CREWFLOW_DEV_DB_APP_PASSWORD', 'CREWFLOW_QA_DB_APP_PASSWORD'].filter((k) => Object.prototype.hasOwnProperty.call(env, k));
    out.push([keys.length === 0, `${rel}: ${name} has no crewflow_owner password variable (a compose interpolation value only)${keys.length ? ` (found ${keys.join(', ')})` : ''}`]);
    const allowedKeys = holdersAllowed.includes(name) ? ['PG_DATABASE_URL'] : [];
    const holders = Object.entries(env).filter(([k, v]) => String(v ?? '').includes(APP_SENTINEL_PASSWORD) && !allowedKeys.includes(k)).map(([k]) => k);
    out.push([holders.length === 0, `${rel}: ${name} carries the crewflow_owner password only inside PG_DATABASE_URL of db-setup, db-harden, ${runtimeNames.join(', ')}${holders.length ? ` (found in ${holders.join(', ')})` : ''}`]);
    const rest = { ...(svc ?? {}) };
    delete rest.environment;
    out.push([!JSON.stringify(rest).includes(APP_SENTINEL_PASSWORD), `${rel}: ${name} carries the crewflow_owner password nowhere outside its environment (health check, command, labels)`]);
  }
  return out;
}

/**
 * Transaction pooler support (owner instruction 2026-11-19): PG_DATABASE_SESSION_URL in one rendered model (rendered with
 * SESSION_SENTINEL_URL). Pure: [ok, label] pairs. Only the runtime services and db-setup / db-harden may have the variable,
 * and only under that name; where any of them has it, all four have it with the SAME value (the one compose.env value);
 * `required` (the production file): all four must have it. No other service, variable or non-environment field holds the
 * sentinel. Labels name services and variables only.
 */
function sessionUrlChecks(rel, services, runtimeNames, { required = false } = {}) {
  const out = [];
  const allowed = [...ADMIN_SERVICES, ...runtimeNames];
  for (const [name, svc] of Object.entries(services)) {
    const env = envOf(svc ?? {});
    const may = allowed.includes(name);
    out.push([may || !Object.prototype.hasOwnProperty.call(env, SESSION_URL_KEY), `${rel}: ${name} has no ${SESSION_URL_KEY} (only ${allowed.join(', ')} may)`]);
    const holders = Object.entries(env).filter(([k, v]) => String(v ?? '').includes(SESSION_SENTINEL_PASSWORD) && !(may && k === SESSION_URL_KEY)).map(([k]) => k);
    out.push([holders.length === 0, `${rel}: ${name} carries the session URL only as ${SESSION_URL_KEY} of ${allowed.join(', ')}${holders.length ? ` (found in ${holders.join(', ')})` : ''}`]);
    const rest = { ...(svc ?? {}) };
    delete rest.environment;
    out.push([!JSON.stringify(rest).includes(SESSION_SENTINEL_PASSWORD), `${rel}: ${name} carries the session URL nowhere outside its environment (health check, command, labels)`]);
  }
  const present = allowed.filter((n) => services[n] && Object.prototype.hasOwnProperty.call(envOf(services[n]), SESSION_URL_KEY));
  if (required) out.push([present.length === allowed.filter((n) => services[n]).length, `${rel}: ${allowed.join(', ')} all pass the optional ${SESSION_URL_KEY}${present.length ? '' : ' (none does)'}`]);
  const values = new Set(present.map((n) => String(envOf(services[n])[SESSION_URL_KEY] ?? '')));
  out.push([values.size <= 1, `${rel}: every ${SESSION_URL_KEY} is the same value (one compose.env value)`]);
  if (required) out.push([values.size === 1 && values.has(SESSION_SENTINEL_URL), `${rel}: ${SESSION_URL_KEY} is exactly the compose.env value (no default, nothing pinned)`]);
  return out;
}

/**
 * Owner decision 2026-11-18 (Twenty's way): the retired setup volume never comes back, in ANY file. Pure: [ok, label] pairs
 * over a rendered model: no top-level volume named (or keyed) crewflow-db-target, and no service mounts it or anything at
 * /run/crewflow/db-target (a volume, a bind or a tmpfs).
 */
function retiredTargetVolumeChecks(rel, model) {
  const vols = model?.volumes && typeof model.volumes === 'object' ? model.volumes : {};
  const named = Object.entries(vols).filter(([k, v]) => k === RETIRED_TARGET_VOLUME || String(v?.name ?? '').endsWith(RETIRED_TARGET_VOLUME)).map(([k]) => k);
  const mounts = [];
  for (const [name, svc] of Object.entries(model?.services ?? {})) {
    for (const v of svc?.volumes ?? []) {
      if (v && typeof v === 'object' && (v.source === RETIRED_TARGET_VOLUME || underTargetDir(v.target))) mounts.push(`${name} mounts ${v.source ?? '?'} at ${v.target ?? '?'}`);
    }
    const tmpfs = svc?.tmpfs === undefined || svc?.tmpfs === null ? [] : Array.isArray(svc.tmpfs) ? svc.tmpfs : [svc.tmpfs];
    for (const t of tmpfs) if (underTargetDir(String(t).split(':')[0])) mounts.push(`${name} has a tmpfs at ${String(t).split(':')[0]}`);
  }
  return [
    [named.length === 0, `${rel}: declares no ${RETIRED_TARGET_VOLUME} volume (retired: no file carries a credential)${named.length ? ` (found ${named.join(', ')})` : ''}`],
    [mounts.length === 0, `${rel}: no service mounts anything at ${RETIRED_TARGET_DIR} (retired setup volume)${mounts.length ? ` (${mounts.join('; ')})` : ''}`],
  ];
}

/**
 * The database-setup contract in one rendered model (owner decision 2026-11-18, Twenty's way: twentyhq/twenty@eedb0a73
 * helm/twenty/templates/deployment-server.yaml:82-155, deployment-worker.yaml:81-88). Pure: [ok, label] pairs.
 * `runtimeNames` = [api, worker]. Labels name services and variables only, never a value.
 */
function dbSetupContractChecks(rel, services, [apiName, workerName], { requireHarden = false } = {}) {
  const out = [];
  const setup = services['db-setup'];
  out.push([Boolean(setup), `${rel}: has the one-shot db-setup service`]);
  let setupUrl = null;
  if (setup) {
    // Owner instruction 2026-11-18 (Twenty's Helm wait-for-db): ./db-setup.sh directly (dev, QA: depends_on a healthy db), or
    // the wait-for-db wrapper (the block of rab/db-setup.sh, then exec ./db-setup.sh) with NO depends_on (production: with
    // CREWFLOW_BUNDLED_DB=0 there is no db container to depend on). Never anything else.
    out.push([dbSetupEntrypointForm(setup.entrypoint) !== null && !setup.command, `${rel}: db-setup runs exactly ./db-setup.sh or exactly the wait-for-db wrapper (entrypoint, no command)`]);
    out.push([String(setup.restart ?? 'no') === 'no', `${rel}: db-setup restart is "no" (one-shot)`]);
    out.push([!(setup.ports ?? []).length, `${rel}: db-setup publishes no port`]);
    const start = dbSetupStartProblems(services, { requireWait: rel === PRODUCTION_FILE, renderedWait: WAIT_SECONDS_DEFAULT });
    out.push([start.length === 0, `${rel}: db-setup waits for the database itself (wrapper, no depends_on${rel === PRODUCTION_FILE ? ', required here' : ''}) or starts after a healthy db${start.length ? ` (${start.join('; ')})` : ''}`]);
    out.push([mountAt(setup, DB_CA_DIR)?.read_only === true, `${rel}: db-setup mounts the db CA read-only`]);
    out.push([!Object.prototype.hasOwnProperty.call(setup.environment ?? {}, 'APP_SECRET'), `${rel}: db-setup has no APP_SECRET (never part of a database credential)`]);
    out.push([String(setup.user ?? '') === '1000:1000' && setup.read_only === true, `${rel}: db-setup runs as 1000:1000 with a read-only root`]);
    setupUrl = envOf(setup).PG_DATABASE_URL;
    const f = urlFacts(setupUrl);
    out.push([Boolean(f) && f.login === OWNER_LOGIN && f.password && f.sslmode === 'verify-full', `${rel}: db-setup's PG_DATABASE_URL is a crewflow_owner URL with a password and sslmode=verify-full (the app login, never an admin URL)`]);
  }
  for (const [name, entrypoint] of [[apiName, './api-prestart.sh'], [workerName, './worker-start.sh']]) {
    const svc = services[name];
    if (!svc) continue; // reported by the "service exists" check
    out.push([JSON.stringify(svc.entrypoint ?? null) === JSON.stringify([entrypoint]) && !svc.command, `${rel}: ${name} runs ${entrypoint} as PID 1 (entrypoint, no command)`]);
    out.push([svc.init !== true, `${rel}: ${name} has no compose init (${entrypoint} execs tini itself)`]);
    const env = envOf(svc);
    out.push([setupUrl !== null && setupUrl !== undefined && String(setupUrl) !== '' && String(env.PG_DATABASE_URL ?? '') === String(setupUrl), `${rel}: ${name}'s PG_DATABASE_URL is exactly db-setup's (the crewflow_owner URL db-setup created or checked)`]);
    // PG_DATABASE_SESSION_URL is the one other URL a runtime service may hold (sessionUrlChecks: same login, same value).
    const urls = Object.entries(env).filter(([k, v]) => k !== 'PG_DATABASE_URL' && k !== SESSION_URL_KEY && DB_URL_VALUE.test(String(v ?? ''))).map(([k]) => k);
    out.push([urls.length === 0, `${rel}: ${name} carries no other database URL in any variable${urls.length ? ` (found in ${urls.join(', ')})` : ''}`]);
    out.push([Object.prototype.hasOwnProperty.call(env, 'PG_ADMIN_URL') && String(env.PG_ADMIN_URL ?? '') === '', `${rel}: ${name} pins PG_ADMIN_URL to "" (the admin login reaches db-setup only)`]);
    out.push([mountAt(svc, DB_CA_DIR)?.read_only === true, `${rel}: ${name} mounts the db CA read-only`]);
  }
  if (services[apiName]) {
    out.push([services[apiName].depends_on?.['db-setup']?.condition === 'service_completed_successfully', `${rel}: ${apiName} starts only after db-setup completed successfully`]);
  }
  // PG_ADMIN_URL with a value: db-setup and db-harden only.
  const admins = Object.entries(services).filter(([n, svc]) => !ADMIN_SERVICES.includes(n) && String(envOf(svc ?? {}).PG_ADMIN_URL ?? '') !== '').map(([n]) => n);
  out.push([admins.length === 0, `${rel}: only db-setup / db-harden have a PG_ADMIN_URL value${admins.length ? ` (found on ${admins.join(', ')})` : ''}`]);
  out.push(...dbHardenContractChecks(rel, services, apiName, { required: requireHarden }));
  // Security review I6: db-setup, the API and the Worker run ONE image (they cannot drift apart).
  const images = [setup, services[apiName], services[workerName]].map((s) => String(s?.image ?? ''));
  out.push([images[0] !== '' && images.every((i) => i === images[0]), `${rel}: db-setup, ${apiName} and ${workerName} run the same image`]);
  return out;
}

/**
 * Owner decision 2026-11-18 (security review of PR #246, M1): the one-shot db-harden service in one rendered model. Pure:
 * [ok, label] pairs. `required`: the production file must have it; the dev / QA files may omit it (when present, the same
 * rules). It runs `./db-setup.sh harden` on db-setup's image, with EXACTLY db-setup's database settings (PG_ADMIN_URL,
 * PG_DATABASE_URL, CREWFLOW_BUNDLED_DB_ADMIN_URL), restart "no", no port, the CA read-only, no APP_SECRET, 1000:1000 with a
 * read-only root, and NO depends_on (it polls by itself; OpenShip drops conditions). No service may depend on it.
 */
function dbHardenContractChecks(rel, services, apiName, { required = false } = {}) {
  const out = [];
  const waiters = Object.entries(services).filter(([, svc]) => {
    const deps = svc?.depends_on;
    return (Array.isArray(deps) ? deps : Object.keys(deps ?? {})).includes('db-harden');
  }).map(([n]) => n);
  out.push([waiters.length === 0, `${rel}: no service depends on db-harden (it never blocks ${apiName} or the Worker)${waiters.length ? ` (found on ${waiters.join(', ')})` : ''}`]);
  const h = services['db-harden'];
  if (!h) {
    if (required) out.push([false, `${rel}: has the one-shot db-harden service (owner decision 2026-11-18, M1)`]);
    return out;
  }
  const setup = services['db-setup'] ?? {};
  const env = envOf(h);
  const setupEnv = envOf(setup);
  out.push([JSON.stringify(h.entrypoint ?? null) === JSON.stringify(HARDEN_ENTRYPOINT) && !h.command, `${rel}: db-harden runs exactly ./db-setup.sh harden (entrypoint, no command)`]);
  out.push([String(h.image ?? '') !== '' && String(h.image) === String(setup.image ?? ''), `${rel}: db-harden runs db-setup's image`]);
  out.push([String(h.restart ?? 'no') === 'no', `${rel}: db-harden restart is "no" (one-shot)`]);
  out.push([!(h.ports ?? []).length, `${rel}: db-harden publishes no port`]);
  const deps = h.depends_on;
  out.push([!deps || (Array.isArray(deps) ? deps.length === 0 : Object.keys(deps).length === 0), `${rel}: db-harden has no depends_on (it waits for the database and the ledger by itself)`]);
  out.push([mountAt(h, DB_CA_DIR)?.read_only === true, `${rel}: db-harden mounts the db CA read-only`]);
  out.push([!Object.prototype.hasOwnProperty.call(env, 'APP_SECRET'), `${rel}: db-harden has no APP_SECRET`]);
  out.push([String(h.user ?? '') === '1000:1000' && h.read_only === true, `${rel}: db-harden runs as 1000:1000 with a read-only root`]);
  for (const key of ['PG_ADMIN_URL', 'PG_DATABASE_URL', 'CREWFLOW_BUNDLED_DB_ADMIN_URL', SESSION_URL_KEY]) {
    out.push([Object.prototype.hasOwnProperty.call(env, key) === Object.prototype.hasOwnProperty.call(setupEnv, key) && String(env[key] ?? '') === String(setupEnv[key] ?? ''), `${rel}: db-harden's ${key} is exactly db-setup's`]);
  }
  return out;
}

/**
 * Owner decision 2026-11-14 (#136 b): the dev database survives `docker compose down -v`. ONLY the dev file's db DATA volume
 * is external, with this exact dev-only name (never rab_devdb_data, the previous dev database). QA (throwaway) and the
 * production files keep project-scoped volumes; the CA volume stays project-scoped everywhere (a lost CA is recovered by
 * the next `up`).
 */
const DEV_DB_DATA_VOLUME = 'crewflow_dev_db_data';
const EXTERNAL_DB_VOLUMES = Object.freeze({ 'packages/rab-docker/docker-compose.yml': Object.freeze({ 'crewflow-db-data': DEV_DB_DATA_VOLUME }) });

/** The throw-away Compose project every file is rendered under (render()). */
const RENDER_PROJECT = 'compose-isolation-check';
/** The bundled db's top-level resources, compared with production's (security review of F2, L2-1). */
const DB_NETWORK = 'crewflow-db';
const DB_VOLUME_KEYS = Object.freeze(['crewflow-db-data', 'crewflow-db-ca']);
/** Strips the throw-away project prefix from a rendered resource name, so a custom `name:` stands out. */
const unprefixed = (resource) => {
  if (!resource || typeof resource !== 'object') return resource ?? null;
  const out = { ...resource };
  if (typeof out.name === 'string' && out.name.startsWith(`${RENDER_PROJECT}_`)) out.name = out.name.slice(RENDER_PROJECT.length + 1);
  return out;
};

/**
 * Part F2 (X2.3): the dev and QA `db` services are verbatim copies of production's. Pure: [ok, label] pairs comparing the
 * two rendered models (same throw-away project, dummy values and password sentinel, so identical text renders
 * identically): the `db` service; the crewflow-db network (internal, no custom name); and the two db volumes (never
 * external, no custom name), EXCEPT the volumes `externalVolumes` names ({key: exact external name}): those must be
 * external with exactly that name (owner decision 2026-11-14: the dev data volume, DEV_EXTERNAL_DB_VOLUMES). Names the
 * differing keys only, never a value.
 */
function bundledDbParityChecks(rel, model, productionModel, externalVolumes = {}) {
  const db = model?.services?.db;
  const productionDb = productionModel?.services?.db;
  if (!db || !productionDb) return [[false, `${rel}: has a bundled db rendered like ${PRODUCTION_FILE}'s (missing: ${!db ? rel : PRODUCTION_FILE})`]];
  const out = [];
  const keys = [...new Set([...Object.keys(db), ...Object.keys(productionDb)])].sort();
  const differ = keys.filter((k) => JSON.stringify(db[k] ?? null) !== JSON.stringify(productionDb[k] ?? null));
  out.push([differ.length === 0, `${rel}: db renders exactly as ${PRODUCTION_FILE}'s db${differ.length ? ` (differs in ${differ.join(', ')})` : ''}`]);
  const net = unprefixed(model.networks?.[DB_NETWORK]);
  out.push([
    Boolean(net) && net.internal === true && !net.external && net.name === DB_NETWORK && JSON.stringify(net) === JSON.stringify(unprefixed(productionModel.networks?.[DB_NETWORK])),
    `${rel}: the ${DB_NETWORK} network is production's (internal, not external, no custom name)`,
  ]);
  for (const key of DB_VOLUME_KEYS) {
    const vol = unprefixed(model.volumes?.[key]);
    const externalName = externalVolumes[key];
    if (externalName) {
      const keys = Object.keys(vol ?? {}).sort();
      out.push([
        Boolean(vol) && vol.external === true && vol.name === externalName && JSON.stringify(keys) === JSON.stringify(['external', 'name']),
        `${rel}: the ${key} volume is external with exactly the name ${externalName} (survives \`down -v\`; owner decision 2026-11-14)`,
      ]);
      continue;
    }
    out.push([
      Boolean(vol) && !vol.external && vol.name === key && JSON.stringify(vol) === JSON.stringify(unprefixed(productionModel.volumes?.[key])),
      `${rel}: the ${key} volume is production's (project-scoped, not external, no custom name)`,
    ]);
  }
  return out;
}

/**
 * Part F2 security review, L2-4: the committed TEXT of a file's `db` service (from `  db:` to the next service or top-level
 * key), normalised: `$$` -> `$`, and the POSTGRES_PASSWORD interpolation (dev and QA use their own variable name, L4)
 * replaced by a placeholder (production's `${PG_DATABASE_PASSWORD:-}` since 2026-11-17, dev / QA's `${..._DB_PASSWORD:?...}`).
 * Returns null when the file has no `db` service.
 */
function rawDbServiceText(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.indexOf('  db:');
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !/^( {2}\S|\S)/.test(lines[end])) end += 1;
  while (end > start + 1 && lines[end - 1].trim() === '') end -= 1;
  return lines
    .slice(start, end)
    .join('\n')
    .split('$$')
    .join('$')
    .replace(/^(\s*POSTGRES_PASSWORD: )\$\{[A-Z0-9_]+:[?-][^}\n]*\}$/m, '$1${PASSWORD}');
}

/** Pure: [ok, label] comparing two committed `db` texts (rawDbServiceText of each). */
function rawDbTextParityChecks(rel, text, productionText) {
  const mine = rawDbServiceText(text);
  const theirs = rawDbServiceText(productionText);
  return [[mine !== null && theirs !== null && mine === theirs, `${rel}: the committed db service text is ${PRODUCTION_FILE}'s, word for word (after $$ -> $ and the password variable)`]];
}

/**
 * Part F2 security review, L2-2: only db mounts the data volume (the retired setup volume is refused in every file by
 * retiredTargetVolumeChecks). Pure: [ok, label] pairs over a rendered model's services.
 */
function dbVolumeMountChecks(rel, services) {
  const allowed = { 'crewflow-db-data': ['db'] };
  const violations = [];
  for (const [name, svc] of Object.entries(services)) {
    for (const [source, who] of Object.entries(allowed)) {
      const mounts = (svc?.volumes ?? []).some((v) => v && typeof v === 'object' && v.source === source);
      if (mounts && !who.includes(name)) violations.push(`${name} mounts ${source}`);
    }
  }
  return [[violations.length === 0, `${rel}: only db mounts crewflow-db-data${violations.length ? ` (${violations.join('; ')})` : ''}`]];
}

/**
 * Part F2 security review, L2-3 and L4 (and owner decision 2026-11-18): in a NON-production file db-setup's two URLs are
 * PINNED to the bundled db: PG_ADMIN_URL (the superuser) and PG_DATABASE_URL (crewflow_owner), never the `${PG_ADMIN_URL...}`
 * / `${PG_DATABASE_URL...}` interpolation production offers for your own database; both render with host exactly `db`, and
 * PG_DATABASE_URL's login is crewflow_owner. The API and the Worker (`runtimeNames`) carry the same pinned PG_DATABASE_URL
 * text. The file never interpolates production's PG_DATABASE_PASSWORD / PG_DATABASE_APP_PASSWORD (dev and QA have their own
 * hex-only variables). `rawDoc` is the parsed, uninterpolated YAML (comments are not part of it). Pure; labels never print a
 * value.
 */
function nonProductionDbSetupChecks(rel, services, rawDoc, runtimeNames = []) {
  const out = [];
  const rawEnv = rawDoc?.services?.['db-setup']?.environment ?? {};
  const pinned = (raw) => raw !== '' && !raw.includes('${PG_ADMIN_URL') && !raw.includes('${PG_DATABASE_URL');
  const rawAdmin = String(rawEnv.PG_ADMIN_URL ?? '');
  const rawApp = String(rawEnv.PG_DATABASE_URL ?? '');
  out.push([pinned(rawAdmin), `${rel}: db-setup's PG_ADMIN_URL is pinned (no \${PG_ADMIN_URL} / \${PG_DATABASE_URL} interpolation: no external-database mode)`]);
  out.push([pinned(rawApp), `${rel}: db-setup's PG_DATABASE_URL is pinned (no \${PG_ADMIN_URL} / \${PG_DATABASE_URL} interpolation: no external-database mode)`]);
  const admin = urlFacts(services['db-setup']?.environment?.PG_ADMIN_URL);
  out.push([admin?.host === 'db', `${rel}: db-setup's rendered PG_ADMIN_URL host is exactly db (the bundled database)`]);
  const app = urlFacts(services['db-setup']?.environment?.PG_DATABASE_URL);
  out.push([app?.host === 'db' && app?.login === OWNER_LOGIN, `${rel}: db-setup's rendered PG_DATABASE_URL is crewflow_owner at host db (the bundled database)`]);
  for (const name of runtimeNames) {
    const raw = String(rawDoc?.services?.[name]?.environment?.PG_DATABASE_URL ?? '');
    out.push([raw !== '' && raw === rawApp, `${rel}: ${name}'s committed PG_DATABASE_URL is db-setup's pinned crewflow_owner URL, word for word`]);
  }
  const text = JSON.stringify(rawDoc ?? {});
  out.push([!text.includes('${PG_DATABASE_PASSWORD'), `${rel}: never interpolates PG_DATABASE_PASSWORD (production's variable; this file has its own)`]);
  out.push([!text.includes('${PG_DATABASE_APP_PASSWORD'), `${rel}: never interpolates PG_DATABASE_APP_PASSWORD (production's variable; this file has its own)`]);
  return out;
}

/**
 * Part F2 security review, M1: ONE server per data volume. The rendered db entrypoint takes a kernel lock on a file in the
 * data volume (`flock -n` on fd 8) before it touches the volume or starts the image's entrypoint. Pure.
 */
function dbServerLockChecks(rel, services) {
  const entry = (services.db?.entrypoint ?? []).map(String).join('\n');
  const lockAt = entry.indexOf('exec 8>/var/lib/postgresql/.crewflow-server.lock');
  const flockAt = entry.search(/flock -n 8 \|\| \{[^}]*exit 1; \}/);
  const firstUse = Math.min(...['openssl', 'printf', 'exec docker-entrypoint.sh'].map((m) => (entry.indexOf(m) < 0 ? Infinity : entry.indexOf(m))));
  return [[lockAt >= 0 && flockAt > lockAt && flockAt < firstUse, `${rel}: db takes the one-server lock (flock -n on the data volume) before it touches the volume or starts postgres`]];
}

/** The YAML parser (the root devDependency `yaml`), or null when it cannot be loaded. `requireFn` is the test seam. */
function loadYamlParser(requireFn = require) {
  try {
    const YAML = requireFn(requireFn.resolve ? requireFn.resolve('yaml', { paths: [REPO] }) : 'yaml');
    return YAML && typeof YAML.parse === 'function' ? YAML : null;
  } catch {
    return null;
  }
}

/**
 * `config` inlines env_file contents into `environment` and drops the key, so which service NAMES .env.migrate is read
 * from the committed YAML itself, with the `yaml` parser (required: see the header, X1.9).
 */
function rawEnvFiles(rel, YAML = loadYamlParser()) {
  if (!YAML || typeof YAML.parse !== 'function') throw new Error('the yaml parser (root devDependency "yaml") did not load');
  const doc = YAML.parse(fs.readFileSync(path.join(REPO, rel), 'utf8'), { merge: true });
  const out = {};
  for (const [name, svc] of Object.entries(doc.services ?? {})) {
    const list = svc.env_file === undefined ? [] : Array.isArray(svc.env_file) ? svc.env_file : [svc.env_file];
    out[name] = list.map((e) => (typeof e === 'string' ? e : e.path ?? ''));
  }
  return out;
}

/**
 * Runs every check and returns the exit code. Test seams: `options.loadYaml` (the parser loader) and `options.execFileSync`
 * (every docker call: `docker compose version` and each render).
 */
function main(options = {}) {
  failures = 0;
  const exec = options.execFileSync ?? execFileSync;
  // X1.9: fail closed BEFORE anything else when the parser is unavailable (never a silent skip of the env_file checks).
  const YAML = (options.loadYaml ?? loadYamlParser)();
  if (!YAML) {
    check(false, 'the yaml parser (root devDependency "yaml") loads, so the env_file checks can run: it did not. Run `yarn install`.');
    console.log('[compose-isolation] 1 check(s) failed');
    return 1;
  }
  try {
    exec('docker', ['compose', 'version'], { stdio: 'ignore' });
  } catch {
    console.error('[compose-isolation] docker compose is not available');
    return 2;
  }
  let productionModel = null;
  let productionText = null;
  for (const [rel, migrateName, runtimeNames, production, dbSetup] of FILES) {
    let model;
    try {
      model = render(rel, exec);
    } catch (error) {
      check(false, `${rel}: docker compose config renders (${String(error.stderr ?? error.message).split('\n')[0].replace(SENTINEL_PASSWORD, '***')})`);
      continue;
    }
    const services = model.services ?? {};
    let raw;
    try {
      raw = rawEnvFiles(rel, YAML);
    } catch (error) {
      check(false, `${rel}: the committed YAML parses, so the env_file checks can run (${String(error.message).split('\n')[0]})`);
      continue;
    }
    // The env_file checks have input: every rendered service is a service of the committed YAML the parser read.
    const unparsed = Object.keys(services).filter((name) => !Object.prototype.hasOwnProperty.call(raw, name));
    check(unparsed.length === 0, `${rel}: the parsed YAML lists every rendered service${unparsed.length ? ` (missing: ${unparsed.join(', ')})` : ''}`);
    const namesMigrateFile = (name) => (raw[name] ?? []).some((f) => /(^|\/)\.env\.migrate$/.test(f));
    // rab-ops removal (PR 2): no service (runtime, migrate, or the dev/QA files) carries anything of the ops environment.
    for (const [ok, label] of opsRefusalChecks(rel, services, raw, { production })) check(ok, label);
    for (const [ok, label] of dbPasswordChecks(rel, services)) check(ok, label);
    for (const [ok, label] of appPasswordChecks(rel, services, runtimeNames)) check(ok, label);
    for (const [ok, label] of sessionUrlChecks(rel, services, runtimeNames, { required: rel === PRODUCTION_FILE })) check(ok, label);
    for (const [ok, label] of retiredTargetVolumeChecks(rel, model)) check(ok, label);
    if (dbSetup) {
      for (const [ok, label] of dbSetupContractChecks(rel, services, runtimeNames, { requireHarden: rel === PRODUCTION_FILE })) check(ok, label);
      for (const [ok, label] of dbVolumeMountChecks(rel, services)) check(ok, label);
      for (const [ok, label] of dbServerLockChecks(rel, services)) check(ok, label);
      const text = fs.readFileSync(path.join(REPO, rel), 'utf8');
      if (rel === PRODUCTION_FILE) {
        productionModel = model;
        productionText = text;
        // Against itself: production's own network is internal and its db volumes are project-scoped (never external).
        for (const [ok, label] of bundledDbParityChecks(rel, model, model)) check(ok, label);
      } else {
        for (const [ok, label] of bundledDbParityChecks(rel, model, productionModel, EXTERNAL_DB_VOLUMES[rel] ?? {})) check(ok, label);
        for (const [ok, label] of rawDbTextParityChecks(rel, text, productionText ?? '')) check(ok, label);
        for (const [ok, label] of nonProductionDbSetupChecks(rel, services, YAML.parse(text, { merge: true }), runtimeNames)) check(ok, label);
      }
    }
    const migrate = migrateName ? services[migrateName] : undefined;
    // A migration service (none is committed today): on an owner-login file nothing may read .env.migrate.
    const ownerLogin = rel === 'packages/rab-docker/docker-compose.production.yml' || rel === 'packages/rab-docker/docker-compose.local-build.yml';
    if (migrateName) check(Boolean(migrate), `${rel}: service ${migrateName} exists`);
    else {
      // O3: the API migrates on start; a migration service would be a second migrating process.
      for (const name of ['rab-migrate', 'migrate']) check(!services[name], `${rel}: has no ${name} service (O3: the API migrates on start)`);
      check(Object.values(raw).every((files) => !files.some((f) => /\.env\.migrate$/.test(f))), `${rel}: no service names .env.migrate`);
    }
    if (migrate) {
      if (ownerLogin) {
        // Owner-login deployment (owner's final decision 2026-11-04): ONE login, no .env.migrate. The owner-login contract
        // (one identical PG_DATABASE_URL, no second identity) is scripts/compose-owner-login.cjs; here: nothing reads it.
        check(envOf(migrate).PG_DATABASE_URL !== SENTINEL_URL, `${rel}: ${migrateName} does not read .env.migrate (owner login)`);
        check(!namesMigrateFile(migrateName), `${rel}: ${migrateName} names no .env.migrate (owner login)`);
      } else {
        check(envOf(migrate).PG_DATABASE_URL === SENTINEL_URL, `${rel}: ${migrateName} receives PG_DATABASE_URL from .env.migrate`);
        check(namesMigrateFile(migrateName), `${rel}: ${migrateName} names .env.migrate as its env_file`);
      }
      check(String(migrate.restart ?? 'no') === 'no', `${rel}: ${migrateName} restart is "no"`);
    }
    for (const name of runtimeNames) {
      const svc = services[name];
      check(Boolean(svc), `${rel}: service ${name} exists`);
      if (!svc) continue;
      const env = envOf(svc);
      const values = Object.values(env).map((v) => String(v ?? ''));
      check(!namesMigrateFile(name), `${rel}: ${name} does not name .env.migrate`);
      check(Object.entries(raw).every(([other, files]) => other === migrateName || !files.some((f) => /\.env\.migrate$/.test(f))), `${rel}: no service but ${migrateName} names .env.migrate`);
      check(!values.some((v) => v.includes(SENTINEL_PASSWORD)), `${rel}: ${name} carries no value of the migration credential`);
      check(!values.some((v) => v.includes('crewflow_migrator')), `${rel}: ${name} carries no migrator login`);
      const authority = MIGRATION_AUTHORITY.filter((k) => String(env[k] ?? '').trim() !== '');
      check(authority.length === 0, `${rel}: ${name} holds no migration authority${authority.length ? ` (${authority.join(', ')})` : ''}`);
      if (migrateName) {
        const dep = (svc.depends_on ?? {})[migrateName];
        check(dep?.condition === 'service_completed_successfully', `${rel}: ${name} depends on ${migrateName} completing successfully`);
      } else {
        check(!(svc.depends_on ?? {})['rab-migrate'], `${rel}: ${name} does not depend on a rab-migrate (O3)`);
      }
      if (production) {
        const legacy = ['DATABASE_URL', 'DATABASE_DIRECT_URL', 'DB_POOL_MAX'].filter((k) => k in env);
        check(legacy.length === 0, `${rel}: ${name} declares no legacy database name${legacy.length ? ` (${legacy.join(', ')})` : ''}`);
      }
    }
    if (production && migrate) {
      check(!migrate.profiles || migrate.profiles.length === 0, `${rel}: ${migrateName} has no profile (it always runs first)`);
      check(JSON.stringify(migrate.command ?? []).includes('deploy-prepare.js'), `${rel}: ${migrateName} runs deploy-prepare.js`);
    }
    if (production) {
      if (ownerLogin) check(!('CREWFLOW_PROVISIONER_ENABLED' in (services['rab-worker']?.environment ?? {})), `${rel}: rab-worker sets no separated provisioner switch (in-process provisioning, owner login)`);
      else check(services['rab-worker']?.environment?.CREWFLOW_PROVISIONER_ENABLED === 'true', `${rel}: rab-worker keeps CREWFLOW_PROVISIONER_ENABLED "true" (gate G2 not passed)`);
    }
  }
  console.log(`[compose-isolation] ${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`);
  return failures === 0 ? 0 : 1;
}

module.exports = {
  loadYamlParser,
  rawEnvFiles,
  main,
  FILES,
  opsRefusalChecks,
  dbPasswordChecks,
  appPasswordChecks,
  sessionUrlChecks,
  SESSION_SENTINEL_URL,
  retiredTargetVolumeChecks,
  dbSetupContractChecks,
  dbHardenContractChecks,
  ADMIN_SERVICES,
  bundledDbParityChecks,
  DEV_DB_DATA_VOLUME,
  EXTERNAL_DB_VOLUMES,
  rawDbServiceText,
  rawDbTextParityChecks,
  dbVolumeMountChecks,
  nonProductionDbSetupChecks,
  dbServerLockChecks,
  PRODUCTION_FILE,
  DB_SENTINEL_PASSWORD,
  APP_SENTINEL_PASSWORD,
  render,
  OPS_ONLY_NAMES,
  OPS_SENTINEL_PASSWORD,
  OPS_SENTINEL_APP_URL,
};

if (require.main === module) process.exit(main());
