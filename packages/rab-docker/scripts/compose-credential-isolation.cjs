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
 *     authority and no legacy DATABASE_URL / DATABASE_DIRECT_URL key. The dev and QA files keep their one-off `migrate`.
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
 * interpolation value only. Rendered with a sentinel value, in every file: no service has a PG_DATABASE_PASSWORD key, and
 * the sentinel appears only in the bundled `db` service's POSTGRES_PASSWORD (the production files render PG_DATABASE_URL
 * from the dummy external URL, so the runtime services must not carry it at all). dbPasswordChecks() is the pure part.
 * Exit 0 = all checks passed, 1 = a check failed, 2 = docker compose is unavailable (CI must have it).
 * Prints service names, variable NAMES and check results only; never a value.
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

/** [compose file, migration service (null = none, O3), runtime services, production?] */
const FILES = [
  ['packages/rab-docker/docker-compose.production.yml', null, ['rab-api', 'rab-worker'], true],
  // LOCAL/DEV ONLY build-from-source copy of the production contract (owner decision 2026-11-11): same credential rules.
  ['packages/rab-docker/docker-compose.local-build.yml', null, ['rab-api', 'rab-worker'], true],
  ['packages/rab-docker/docker-compose.yml', 'migrate', ['server', 'worker'], false],
  ['packages/rab-docker/docker-compose.qa.yml', 'migrate', ['server', 'worker'], false],
];

// Dummy values for every `${VAR:?}` the files require (never real secrets).
const DUMMY_ENV = {
  CREWFLOW_IMAGE_TAG: `sha256:${'0'.repeat(64)}`,
  DEVDB_SUPERUSER_PASSWORD: 'dummy',
  DEVDB_URL: 'postgres://crewflow_app:dummy-app@devdb:5432/rab',
  CREWFLOW_BOOTSTRAP_PASSWORD: 'dummy',
  QA_POSTGRES_SUPERUSER_PASSWORD: 'dummy',
  QA_CREWFLOW_PASSWORD: 'dummy',
  QA_CREWFLOW_APP_PASSWORD: 'dummy',
  QA_APP_SECRET: 'dummy-dummy-dummy-dummy-dummy-dummy',
  // docker-compose.production.yml's REQUIRED list (x-crewflow-required-env, owner request 2026-11-12: OpenShip shows every
  // variable). The owner-login URL shape, never the migrator login or a sentinel.
  PG_DATABASE_URL: 'postgresql://crewflow_owner:dummy@db-direct.example:5432/rab?sslmode=verify-full',
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
  // DB-SETUP: the bundled db's password (production.yml's db requires it); a sentinel so its spread is checked.
  PG_DATABASE_PASSWORD: DB_SENTINEL_PASSWORD,
};

let failures = 0;
const check = (ok, label) => {
  console.log(`[compose-isolation] ${ok ? 'PASS' : 'FAIL'} ${label}`);
  if (!ok) failures += 1;
};

function render(rel) {
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
    const out = execFileSync(
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
 * [ok, label] pairs for one rendered model (`services`) and the env_file names read from the committed YAML (`raw`, or
 * null when the yaml package is unavailable; the env_file-name check is then skipped, as for .env.migrate).
 */
function opsRefusalChecks(rel, services, raw, { production = false } = {}) {
  const out = [];
  const namesOpsFile = (name) => (raw?.[name] ?? []).some((f) => /(^|\/)\.env\.ops$/.test(f));
  out.push([!services['rab-ops'], `${rel}: has no rab-ops service (removed; operations run as one-off owner-login commands of rab-api)`]);
  for (const [name, svc] of Object.entries(services)) {
    const env = envOf(svc ?? {});
    const values = Object.values(env).map((v) => String(v ?? ''));
    out.push([!(Array.isArray(svc?.profiles) && svc.profiles.includes('ops')), `${rel}: ${name} has no "ops" profile (the rab-ops container was removed)`]);
    if (production) out.push([!(Array.isArray(svc?.profiles) && svc.profiles.length), `${rel}: ${name} has no profile (a production file has no profile-gated service)`]);
    if (raw) out.push([!namesOpsFile(name), `${rel}: ${name} does not name .env.ops`]);
    out.push([!values.some((v) => v.includes(OPS_SENTINEL_PASSWORD)), `${rel}: ${name} carries no value of the ops environment`]);
    const held = OPS_ONLY_NAMES.filter((k) => String(env[k] ?? '').trim() !== '');
    out.push([held.length === 0, `${rel}: ${name} holds no ops-only variable${held.length ? ` (${held.join(', ')})` : ''}`]);
  }
  return out;
}

/**
 * DB-SETUP: where the bundled db's password may appear in one rendered model. Pure: [ok, label] pairs. Only the `db`
 * service's POSTGRES_PASSWORD may hold it; no service may have a PG_DATABASE_PASSWORD key.
 */
function dbPasswordChecks(rel, services) {
  const out = [];
  for (const [name, svc] of Object.entries(services)) {
    const env = envOf(svc ?? {});
    out.push([!Object.prototype.hasOwnProperty.call(env, 'PG_DATABASE_PASSWORD'), `${rel}: ${name} has no PG_DATABASE_PASSWORD variable (a compose interpolation value only)`]);
    const holders = Object.entries(env).filter(([k, v]) => String(v ?? '').includes(DB_SENTINEL_PASSWORD) && !(name === 'db' && k === 'POSTGRES_PASSWORD')).map(([k]) => k);
    out.push([holders.length === 0, `${rel}: ${name} carries the bundled db's password only as db's POSTGRES_PASSWORD${holders.length ? ` (found in ${holders.join(', ')})` : ''}`]);
  }
  return out;
}

/**
 * `config` inlines env_file contents into `environment` and drops the key, so which service NAMES .env.migrate is read
 * from the committed YAML itself (the `yaml` package of the monorepo; skipped, and said so, when it is not installed).
 */
function rawEnvFiles(rel) {
  let YAML;
  try {
    YAML = require(require.resolve('yaml', { paths: [REPO] }));
  } catch {
    return null;
  }
  const doc = YAML.parse(fs.readFileSync(path.join(REPO, rel), 'utf8'), { merge: true });
  const out = {};
  for (const [name, svc] of Object.entries(doc.services ?? {})) {
    const list = svc.env_file === undefined ? [] : Array.isArray(svc.env_file) ? svc.env_file : [svc.env_file];
    out[name] = list.map((e) => (typeof e === 'string' ? e : e.path ?? ''));
  }
  return out;
}

function main() {
  try {
    execFileSync('docker', ['compose', 'version'], { stdio: 'ignore' });
  } catch {
    console.error('[compose-isolation] docker compose is not available');
    process.exit(2);
  }
  for (const [rel, migrateName, runtimeNames, production] of FILES) {
    let model;
    try {
      model = render(rel);
    } catch (error) {
      check(false, `${rel}: docker compose config renders (${String(error.stderr ?? error.message).split('\n')[0].replace(SENTINEL_PASSWORD, '***')})`);
      continue;
    }
    const services = model.services ?? {};
    const raw = rawEnvFiles(rel);
    if (raw === null) console.log(`[compose-isolation] note ${rel}: the yaml package is not installed; env_file names not checked`);
    const namesMigrateFile = (name) => (raw?.[name] ?? []).some((f) => /(^|\/)\.env\.migrate$/.test(f));
    // rab-ops removal (PR 2): no service (runtime, migrate, or the dev/QA files) carries anything of the ops environment.
    for (const [ok, label] of opsRefusalChecks(rel, services, raw, { production })) check(ok, label);
    for (const [ok, label] of dbPasswordChecks(rel, services)) check(ok, label);
    const migrate = migrateName ? services[migrateName] : undefined;
    // The production file is on the owner login (single URL); the dev and QA files keep the separated contract.
    const ownerLogin = rel === 'packages/rab-docker/docker-compose.production.yml' || rel === 'packages/rab-docker/docker-compose.local-build.yml';
    if (migrateName) check(Boolean(migrate), `${rel}: service ${migrateName} exists`);
    else {
      // O3: the API migrates on start; a migration service would be a second migrating process.
      for (const name of ['rab-migrate', 'migrate']) check(!services[name], `${rel}: has no ${name} service (O3: the API migrates on start)`);
      if (raw) check(Object.values(raw).every((files) => !files.some((f) => /\.env\.migrate$/.test(f))), `${rel}: no service names .env.migrate`);
    }
    if (migrate) {
      if (ownerLogin) {
        // Owner-login deployment (owner's final decision 2026-11-04): ONE login, no .env.migrate. The owner-login contract
        // (one identical PG_DATABASE_URL, no second identity) is scripts/compose-owner-login.cjs; here: nothing reads it.
        check(envOf(migrate).PG_DATABASE_URL !== SENTINEL_URL, `${rel}: ${migrateName} does not read .env.migrate (owner login)`);
        if (raw) check(!namesMigrateFile(migrateName), `${rel}: ${migrateName} names no .env.migrate (owner login)`);
      } else {
        check(envOf(migrate).PG_DATABASE_URL === SENTINEL_URL, `${rel}: ${migrateName} receives PG_DATABASE_URL from .env.migrate`);
        if (raw) check(namesMigrateFile(migrateName), `${rel}: ${migrateName} names .env.migrate as its env_file`);
      }
      check(String(migrate.restart ?? 'no') === 'no', `${rel}: ${migrateName} restart is "no"`);
    }
    for (const name of runtimeNames) {
      const svc = services[name];
      check(Boolean(svc), `${rel}: service ${name} exists`);
      if (!svc) continue;
      const env = envOf(svc);
      const values = Object.values(env).map((v) => String(v ?? ''));
      if (raw) check(!namesMigrateFile(name), `${rel}: ${name} does not name .env.migrate`);
      if (raw) check(Object.entries(raw).every(([other, files]) => other === migrateName || !files.some((f) => /\.env\.migrate$/.test(f))), `${rel}: no service but ${migrateName} names .env.migrate`);
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
  process.exit(failures === 0 ? 0 : 1);
}

module.exports = { opsRefusalChecks, dbPasswordChecks, DB_SENTINEL_PASSWORD, render, rawEnvFiles, OPS_ONLY_NAMES, OPS_SENTINEL_PASSWORD, OPS_SENTINEL_APP_URL };
if (require.main === module) main();
