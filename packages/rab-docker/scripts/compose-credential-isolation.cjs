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
 * interpolation value only. Rendered with a sentinel value (and PG_DATABASE_URL unset, so the bundled default is rendered),
 * in every file: no service has a PG_DATABASE_PASSWORD key, and the sentinel appears only in the bundled `db` service's
 * POSTGRES_PASSWORD and, inside the default admin URL, in the one-shot `db-setup` service's PG_DATABASE_URL (PR #125 option
 * A: rab-api and rab-worker never carry it, nor any database URL). dbPasswordChecks() is the pure part.
 *
 * Part F2 (X2.3, dev and QA on Part A's setup): the files with a bundled `db` (production, dev, QA) are checked for the
 * Part A contract itself (dbSetupContractChecks, pure): a one-shot db-setup (entrypoint ./db-setup.sh, restart "no", no
 * port, the target volume writable and the CA read-only, after a healthy db, no APP_SECRET); the API and the Worker on
 * ./api-prestart.sh / ./worker-start.sh (no compose init), with no database URL anywhere in their environment (an empty
 * PG_DATABASE_URL only) and db-setup's target volume mounted read-only; the API waits for db-setup to complete. And the dev
 * and QA `db` services must render EXACTLY as production's `db` (bundledDbParityChecks, pure): they are verbatim copies,
 * so a drift in either direction (TLS, authentication, hardening, image) fails here. db-setup, the API and the Worker run
 * one image.
 * Security review of F2 (pure parts, each with denial tests): the crewflow-db network and the three db volumes match
 * production's (internal; never external or custom-named); the committed db TEXT matches production's (rawDbTextParityChecks);
 * only db mounts the data volume and only db-setup + the API/Worker the setup volume (dbVolumeMountChecks); in dev and QA
 * db-setup's URL is pinned to host `db` and the file never names PG_DATABASE_PASSWORD (nonProductionDbSetupChecks); and the
 * db entrypoint takes the one-server-per-volume kernel lock before anything else (dbServerLockChecks, M1).
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

const REPO = path.resolve(__dirname, '../../..');
const SENTINEL_PASSWORD = 'SENTINEL-MIGRATOR-PW-0f3a9c'; // gitleaks:allow (synthetic marker the check plants, not a credential)
const SENTINEL_URL = `postgresql://crewflow_migrator:${SENTINEL_PASSWORD}@db-direct.example:5432/rab?sslmode=verify-full`;
const MIGRATION_AUTHORITY = ['CREWFLOW_MIGRATION_APPROVED', 'CREWFLOW_MIGRATION_DATABASE_URL', 'ALLOW_PRODUCTION_DB_COMMANDS', 'DATABASE_URL_UNPOOLED'];
// Phase B (ops): the one-off operations container. Its own sentinel password marks every value that came from .env.ops.
const OPS_SENTINEL_PASSWORD = 'SENTINEL-OPS-APP-PW-7c21de'; // gitleaks:allow (synthetic marker, not a credential)
const OPS_SENTINEL_APP_URL = `postgresql://crewflow_app:${OPS_SENTINEL_PASSWORD}@db-direct.example:5432/rab?sslmode=verify-full`;
// DB-SETUP: the bundled db's superuser password (synthetic marker, not a credential).
const DB_SENTINEL_PASSWORD = 'SENTINELDBPW0b7e41c9d2a8f3561e'; // gitleaks:allow (synthetic marker, not a credential)
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
 * DB-SETUP: where the bundled db's password may appear in one rendered model. Pure: [ok, label] pairs. Only the `db`
 * service's POSTGRES_PASSWORD and (option A) the `db-setup` service's PG_DATABASE_URL may hold it; no service may have a
 * PG_DATABASE_PASSWORD key; nothing else in any other service's definition (health check, command, labels) holds it.
 */
function dbPasswordChecks(rel, services) {
  const out = [];
  for (const [name, svc] of Object.entries(services)) {
    const env = envOf(svc ?? {});
    out.push([!Object.prototype.hasOwnProperty.call(env, 'PG_DATABASE_PASSWORD'), `${rel}: ${name} has no PG_DATABASE_PASSWORD variable (a compose interpolation value only)`]);
    const allowedKey = name === 'db' ? 'POSTGRES_PASSWORD' : name === 'db-setup' ? 'PG_DATABASE_URL' : null;
    const holders = Object.entries(env).filter(([k, v]) => String(v ?? '').includes(DB_SENTINEL_PASSWORD) && k !== allowedKey).map(([k]) => k);
    out.push([holders.length === 0, `${rel}: ${name} carries the bundled db's password only as db's POSTGRES_PASSWORD or db-setup's PG_DATABASE_URL${holders.length ? ` (found in ${holders.join(', ')})` : ''}`]);
    // Outside the environment (health check, command, entrypoint, labels): never, in any service.
    const rest = { ...(svc ?? {}) };
    delete rest.environment;
    out.push([!JSON.stringify(rest).includes(DB_SENTINEL_PASSWORD), `${rel}: ${name} carries the bundled db's password nowhere outside its environment (health check, command, labels)`]);
  }
  return out;
}

const DB_SETUP_TARGET_DIR = '/run/crewflow/db-target';
const DB_CA_DIR = '/run/crewflow/db-ca';
const DB_URL_VALUE = /postgres(ql)?:\/\//i;
const mountAt = (svc, target) => (svc?.volumes ?? []).find((v) => v && typeof v === 'object' && v.target === target);

/**
 * Part F2 (X2.3): Part A's database-setup contract in one rendered model (Twenty Helm model, twentyhq/twenty@eedb0a73
 * helm/twenty/templates/deployment-server.yaml:81-130, deployment-worker.yaml:76-90). Pure: [ok, label] pairs.
 * `runtimeNames` = [api, worker]. Labels name services and variables only, never a value.
 */
function dbSetupContractChecks(rel, services, [apiName, workerName]) {
  const out = [];
  const setup = services['db-setup'];
  out.push([Boolean(setup), `${rel}: has the one-shot db-setup service`]);
  if (setup) {
    out.push([JSON.stringify(setup.entrypoint ?? null) === JSON.stringify(['./db-setup.sh']) && !setup.command, `${rel}: db-setup runs exactly ./db-setup.sh (entrypoint, no command)`]);
    out.push([String(setup.restart ?? 'no') === 'no', `${rel}: db-setup restart is "no" (one-shot)`]);
    out.push([!(setup.ports ?? []).length, `${rel}: db-setup publishes no port`]);
    out.push([setup.depends_on?.db?.condition === 'service_healthy', `${rel}: db-setup starts after a healthy db`]);
    const target = mountAt(setup, DB_SETUP_TARGET_DIR);
    out.push([Boolean(target) && target.read_only !== true, `${rel}: db-setup mounts the target volume writable at ${DB_SETUP_TARGET_DIR}`]);
    out.push([mountAt(setup, DB_CA_DIR)?.read_only === true, `${rel}: db-setup mounts the db CA read-only`]);
    out.push([!Object.prototype.hasOwnProperty.call(setup.environment ?? {}, 'APP_SECRET'), `${rel}: db-setup has no APP_SECRET (never part of a database credential)`]);
    out.push([String(setup.user ?? '') === '1000:1000' && setup.read_only === true, `${rel}: db-setup runs as 1000:1000 with a read-only root`]);
  }
  for (const [name, entrypoint] of [[apiName, './api-prestart.sh'], [workerName, './worker-start.sh']]) {
    const svc = services[name];
    if (!svc) continue; // reported by the "service exists" check
    out.push([JSON.stringify(svc.entrypoint ?? null) === JSON.stringify([entrypoint]) && !svc.command, `${rel}: ${name} runs ${entrypoint} as PID 1 (entrypoint, no command)`]);
    out.push([svc.init !== true, `${rel}: ${name} has no compose init (${entrypoint} execs tini itself)`]);
    const env = envOf(svc);
    out.push([String(env.PG_DATABASE_URL ?? '') === '', `${rel}: ${name} has no PG_DATABASE_URL value (it builds the crewflow_owner URL from db-setup's files)`]);
    const urls = Object.entries(env).filter(([, v]) => DB_URL_VALUE.test(String(v ?? ''))).map(([k]) => k);
    out.push([urls.length === 0, `${rel}: ${name} carries no database URL in any variable${urls.length ? ` (found in ${urls.join(', ')})` : ''}`]);
    out.push([mountAt(svc, DB_SETUP_TARGET_DIR)?.read_only === true, `${rel}: ${name} mounts db-setup's target volume read-only`]);
  }
  if (services[apiName]) {
    out.push([services[apiName].depends_on?.['db-setup']?.condition === 'service_completed_successfully', `${rel}: ${apiName} starts only after db-setup completed successfully`]);
  }
  // Security review I6: db-setup, the API and the Worker run ONE image (they cannot drift apart).
  const images = [setup, services[apiName], services[workerName]].map((s) => String(s?.image ?? ''));
  out.push([images[0] !== '' && images.every((i) => i === images[0]), `${rel}: db-setup, ${apiName} and ${workerName} run the same image`]);
  return out;
}

/**
 * Owner decision 2026-11-14 (#136 b): the dev database survives `docker compose down -v`. ONLY the dev file's db DATA volume
 * is external, with this exact dev-only name (never rab_devdb_data, the previous dev database). QA (throwaway) and the
 * production files keep project-scoped volumes; the CA and setup volumes stay project-scoped everywhere (a lost CA or
 * password file is recovered by the next `up`).
 */
const DEV_DB_DATA_VOLUME = 'crewflow_dev_db_data';
const EXTERNAL_DB_VOLUMES = Object.freeze({ 'packages/rab-docker/docker-compose.yml': Object.freeze({ 'crewflow-db-data': DEV_DB_DATA_VOLUME }) });

/** The throw-away Compose project every file is rendered under (render()). */
const RENDER_PROJECT = 'compose-isolation-check';
/** The bundled db's top-level resources, compared with production's (security review of F2, L2-1). */
const DB_NETWORK = 'crewflow-db';
const DB_VOLUME_KEYS = Object.freeze(['crewflow-db-data', 'crewflow-db-ca', 'crewflow-db-target']);
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
 * identically): the `db` service; the crewflow-db network (internal, no custom name); and the three db volumes (never
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
 * replaced by a placeholder. Returns null when the file has no `db` service.
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
    .replace(/^(\s*POSTGRES_PASSWORD: )\$\{[A-Z0-9_]+:\?[^}\n]*\}$/m, '$1${PASSWORD}');
}

/** Pure: [ok, label] comparing two committed `db` texts (rawDbServiceText of each). */
function rawDbTextParityChecks(rel, text, productionText) {
  const mine = rawDbServiceText(text);
  const theirs = rawDbServiceText(productionText);
  return [[mine !== null && theirs !== null && mine === theirs, `${rel}: the committed db service text is ${PRODUCTION_FILE}'s, word for word (after $$ -> $ and the password variable)`]];
}

/**
 * Part F2 security review, L2-2: only db mounts the data volume; only db-setup and the API/Worker mount the setup (target)
 * volume. Pure: [ok, label] pairs over a rendered model's services.
 */
function dbVolumeMountChecks(rel, services, runtimeNames) {
  const allowed = { 'crewflow-db-data': ['db'], 'crewflow-db-target': ['db-setup', ...runtimeNames] };
  const violations = [];
  for (const [name, svc] of Object.entries(services)) {
    for (const [source, who] of Object.entries(allowed)) {
      const mounts = (svc?.volumes ?? []).some((v) => v && typeof v === 'object' && v.source === source);
      if (mounts && !who.includes(name)) violations.push(`${name} mounts ${source}`);
    }
  }
  return [[violations.length === 0, `${rel}: only db mounts crewflow-db-data and only db-setup, ${runtimeNames.join(', ')} mount crewflow-db-target${violations.length ? ` (${violations.join('; ')})` : ''}`]];
}

/**
 * Part F2 security review, L2-3 and L4: in a NON-production file db-setup's URL is pinned to the bundled db (never the
 * `${PG_DATABASE_URL...}` interpolation production offers for an external database; rendered host exactly `db`), and the
 * file never names PG_DATABASE_PASSWORD (dev and QA have their own hex-only variable). `rawDoc` is the parsed, uninterpolated
 * YAML (comments are not part of it). Pure; labels never print a value.
 */
function nonProductionDbSetupChecks(rel, services, rawDoc) {
  const out = [];
  const rawUrl = String(rawDoc?.services?.['db-setup']?.environment?.PG_DATABASE_URL ?? '');
  out.push([rawUrl !== '' && !rawUrl.includes('${PG_DATABASE_URL'), `${rel}: db-setup's PG_DATABASE_URL is pinned (no \${PG_DATABASE_URL} interpolation: no external-database mode)`]);
  let host = null;
  try {
    host = new URL(String(services['db-setup']?.environment?.PG_DATABASE_URL ?? '')).hostname;
  } catch {
    host = null;
  }
  out.push([host === 'db', `${rel}: db-setup's rendered PG_DATABASE_URL host is exactly db (the bundled database)`]);
  out.push([!JSON.stringify(rawDoc ?? {}).includes('PG_DATABASE_PASSWORD'), `${rel}: never names PG_DATABASE_PASSWORD (production's variable; this file has its own)`]);
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
    if (dbSetup) {
      for (const [ok, label] of dbSetupContractChecks(rel, services, runtimeNames)) check(ok, label);
      for (const [ok, label] of dbVolumeMountChecks(rel, services, runtimeNames)) check(ok, label);
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
        for (const [ok, label] of nonProductionDbSetupChecks(rel, services, YAML.parse(text, { merge: true }))) check(ok, label);
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
  dbSetupContractChecks,
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
  render,
  OPS_ONLY_NAMES,
  OPS_SENTINEL_PASSWORD,
  OPS_SENTINEL_APP_URL,
};

if (require.main === module) process.exit(main());
