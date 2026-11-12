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
 * Phase B (ops, owner decision): the one-off owner operations container `rab-ops` (production file, profile "ops") reads
 * packages/rab-docker/.env.ops only. A sentinel .env.ops (ops crewflow_app URL with its own sentinel password, a migrator
 * URL, the operator label) is rendered with `--profile ops`, and:
 *   - rab-ops: names .env.ops, receives PG_OPS_APP_DATABASE_URL and CREWFLOW_OPS_RUN=one-off from it, has the "ops" profile
 *     (never started by `up`), restart "no", runs dist/command/main.js, publishes no port, keeps HWS off, nothing depends on it;
 *   - every OTHER service (API, Worker, migrate, and the dev/QA files): does not name .env.ops, carries no value of the ops
 *     sentinel and none of the ops-only names (CREWFLOW_OPS_*, PG_OPS_*).
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
const OPS_ONLY_NAMES = ['CREWFLOW_OPS_RUN', 'PG_OPS_APP_DATABASE_URL', 'CREWFLOW_OPS_ACTOR_SOURCE', 'CREWFLOW_OPS_ACTOR_ID', 'CREWFLOW_OPS_CHANGE_REF'];
/** Compose files that define the one-off operations container, and its service name. */
const OPS_SERVICES = {
  'packages/rab-docker/docker-compose.production.yml': 'rab-ops',
  'packages/rab-docker/docker-compose.local-build.yml': 'rab-ops',
};

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
      ['compose', '--project-directory', project, '-p', 'compose-isolation-check', '-f', path.join(REPO, rel), '--profile', 'ops', 'config', '--format', 'json'],
      { env: { ...process.env, ...DUMMY_ENV, CREWFLOW_MIGRATION_DATABASE_URL: '', CREWFLOW_MIGRATION_APPROVED: '' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return JSON.parse(out);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const envOf = (svc) => svc.environment ?? {};

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
function rawEnvFiles(rel, YAML) {
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
  for (const [rel, migrateName, runtimeNames, production] of FILES) {
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
    const namesOpsFile = (name) => (raw[name] ?? []).some((f) => /(^|\/)\.env\.ops$/.test(f));
    const opsName = OPS_SERVICES[rel] ?? null;
    // Phase B (ops): every service but the ops one (runtime AND migrate) carries nothing of the ops environment.
    for (const [name, svc] of Object.entries(services)) {
      if (name === opsName) continue;
      const env = envOf(svc);
      const values = Object.values(env).map((v) => String(v ?? ''));
      check(!namesOpsFile(name), `${rel}: ${name} does not name .env.ops`);
      check(!values.some((v) => v.includes(OPS_SENTINEL_PASSWORD)), `${rel}: ${name} carries no value of the ops environment`);
      const held = OPS_ONLY_NAMES.filter((k) => String(env[k] ?? '').trim() !== '');
      check(held.length === 0, `${rel}: ${name} holds no ops-only variable${held.length ? ` (${held.join(', ')})` : ''}`);
      if (opsName) check(!Object.keys(svc.depends_on ?? {}).includes(opsName), `${rel}: ${name} does not depend on ${opsName}`);
    }
    if (opsName) {
      const ops = services[opsName];
      check(Boolean(ops), `${rel}: ops service ${opsName} exists (rendered with --profile ops)`);
      if (ops) {
        const env = envOf(ops);
        check(env.PG_OPS_APP_DATABASE_URL === OPS_SENTINEL_APP_URL, `${rel}: ${opsName} receives PG_OPS_APP_DATABASE_URL from .env.ops`);
        check(env.CREWFLOW_OPS_RUN === 'one-off', `${rel}: ${opsName} declares CREWFLOW_OPS_RUN=one-off from .env.ops`);
        check(namesOpsFile(opsName) && !namesMigrateFile(opsName), `${rel}: ${opsName} names .env.ops (and not .env.migrate) as its env_file`);
        check(Array.isArray(ops.profiles) && ops.profiles.length === 1 && ops.profiles[0] === 'ops', `${rel}: ${opsName} has only the "ops" profile (never started by up)`);
        check(String(ops.restart ?? 'no') === 'no', `${rel}: ${opsName} restart is "no"`);
        check(JSON.stringify(ops.entrypoint ?? []).includes('dist/command/main.js'), `${rel}: ${opsName} runs the CLI entrypoint`);
        check(!ops.ports || ops.ports.length === 0, `${rel}: ${opsName} publishes no port`);
        check(env.HWS_RUNTIME_ENABLED === 'false', `${rel}: ${opsName} keeps HWS_RUNTIME_ENABLED "false" (hws:backfill --apply needs --hws-cutover)`);
      }
    }
    const migrate = migrateName ? services[migrateName] : undefined;
    // The production file is on the owner login (single URL); the dev and QA files keep the separated contract.
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

module.exports = { loadYamlParser, rawEnvFiles, main, FILES };

if (require.main === module) process.exit(main());
