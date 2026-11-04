'use strict';
/**
 * FULL-mode tests for compose-owner-login.cjs: the in-place owner-login contract of docker-compose.image.yml and its
 * overrides (migrate-on-start, local-db, staging).
 *
 *   node --test packages/rab-docker/scripts/compose-owner-login.full.test.cjs
 *
 * Renders every combination once with `docker compose` (reported as skipped without it; CI requires it); every negative
 * case mutates a COPY of a rendered model, so each one proves the gate refuses one specific weakening.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

const gate = require('./compose-owner-login.cjs');
const { COMBOS, checkModel, renderModels } = gate;

const assertRefused = (problems, pattern) => {
  assert.ok(problems.some((p) => pattern.test(p)), `expected a problem matching ${pattern}; got: ${problems.join(' | ') || '(none)'}`);
};
let composeAvailable = true;
try {
  execFileSync('docker', ['compose', 'version'], { stdio: 'ignore' });
} catch {
  composeAvailable = false;
}
const skip = composeAvailable ? false : 'docker compose is not available';
let models;
const combo = (name) => COMBOS.find((c) => c.name === name);
const fresh = (name) => {
  models ??= renderModels();
  return structuredClone(models[name]);
};
const problemsAfter = (name, mutate) => {
  const m = fresh(name);
  mutate(m.services, m);
  return checkModel(m, combo(name));
};
const REL = 'release+local-db';
const APP = ['rab-api', 'rab-worker', 'rab-migrate'];

test('every committed combination passes every check', { skip }, () => {
  for (const c of COMBOS) assert.deepEqual(checkModel(fresh(c.name), c), [], c.name);
});

test('one credential: a different or missing PG_DATABASE_URL on any app service is refused', { skip }, () => {
  for (const svc of APP) {
    assertRefused(problemsAfter(REL, (s) => { s[svc].environment.PG_DATABASE_URL = gate.SENTINEL_URL.replace('db-direct', 'db-other'); }), /PG_DATABASE_URL differs/);
    assertRefused(problemsAfter(REL, (s) => { delete s[svc].environment.PG_DATABASE_URL; }), new RegExp(`${svc}: PG_DATABASE_URL is missing`));
  }
});

test('no second identity, no mode switch, no role password, no token on any service', { skip }, () => {
  const url = 'postgresql://crewflow_migrator:x@db:5432/crewflow';
  for (const [key, value, re] of [
    ['CREWFLOW_PROVISIONER_DATABASE_URL', url, /CREWFLOW_PROVISIONER_DATABASE_URL/],
    ['PG_WORKER_DATABASE_URL', url, /PG_WORKER_DATABASE_URL/],
    ['CREWFLOW_MIGRATION_DATABASE_URL', url, /CREWFLOW_MIGRATION_DATABASE_URL/],
    ['PG_OPS_APP_DATABASE_URL', url, /PG_OPS_APP_DATABASE_URL/],
    ['PG_DATABASE_REPLICA_URL', url, /PG_DATABASE_REPLICA_URL/],
    ['SENTRY_DSN', url, /SENTRY_DSN holds a PostgreSQL URL/],
    ['CREWFLOW_DB_MODE', 'twenty', /CREWFLOW_DB_MODE .*no mode switch/],
    ['CREWFLOW_WORKER_BOOTSTRAP_PASSWORD', 'x', /role password/],
    ['CREWFLOW_MIGRATION_APPROVED', 'pending-1-x', /CREWFLOW_MIGRATION_APPROVED/],
    ['DB_TARGET', 'production', /DB_TARGET/],
    ['ALLOW_PRODUCTION_DB_COMMANDS', 'true', /ALLOW_PRODUCTION_DB_COMMANDS/],
  ]) {
    for (const svc of APP) assertRefused(problemsAfter(REL, (s) => { s[svc].environment[key] = value; }), re);
  }
});

test('separated-mode env files never reach a service; runtime secrets never reach the release step', { skip }, () => {
  for (const svc of APP) assertRefused(problemsAfter(REL, (s) => { s[svc].environment.X = gate.SENTINEL_LEGACY_PW; }), /separated-mode env file/);
  assertRefused(problemsAfter(REL, (s) => { s['rab-migrate'].environment.APP_SECRET = gate.SENTINEL_APP_SECRET; }), /rab-migrate: received a runtime secret/);
  assertRefused(problemsAfter(REL, (s) => { s['rab-redis'].environment = { X: gate.SENTINEL_OWNER_PW }; }), /rab-redis: received the database credential/);
  assertRefused(problemsAfter(REL, (s) => { delete s['rab-worker'].environment.APP_SECRET; }), /rab-worker: does not read runtime.env/);
});

test('hardening: each H1-H6 key is required on every service', { skip }, () => {
  for (const svc of ['rab-api', 'rab-worker', 'rab-redis', 'rab-migrate', 'rab-postgres']) {
    for (const [mutate, re] of [
      [(s) => { s[svc].read_only = false; }, 'read_only'],
      [(s) => { s[svc].cap_drop = []; }, 'cap_drop ALL'],
      [(s) => { s[svc].cap_add = ['SETUID']; }, 'adds capabilities'],
      [(s) => { s[svc].security_opt = []; }, 'security_opt'],
      [(s) => { s[svc].user = '0:0'; }, 'user "0:0" is root'],
      [(s) => { delete s[svc].user; }, 'no explicit user'],
      [(s) => { delete s[svc].pids_limit; }, 'pids_limit'],
      [(s) => { delete s[svc].mem_limit; }, 'mem_limit'],
      [(s) => { delete s[svc].cpus; }, 'cpus'],
      [(s) => { delete s[svc].logging; }, 'logging'],
      [(s) => { delete s[svc].stop_grace_period; }, 'stop_grace_period'],
      [(s) => { s[svc].build = { context: '.' }; }, 'has a build section'],
      [(s) => { s[svc].image = 'adhin007/adolphus:latest'; }, 'image is not pinned by digest'],
      [(s) => { s[svc].privileged = true; }, 'privileged'],
      [(s) => { s[svc].network_mode = 'host'; }, 'network_mode is host'],
      [(s) => { (s[svc].volumes ??= []).push({ type: 'bind', source: '/var/run/docker.sock', target: '/var/run/docker.sock', read_only: true }); }, 'mounts the Docker socket'],
      [(s) => { (s[svc].volumes ??= []).push({ type: 'bind', source: '/srv', target: '/srv' }); }, 'bind mount to /srv is writable'],
    ]) assertRefused(problemsAfter(REL, mutate), new RegExp(`${svc}: ${re}`));
  }
  for (const svc of ['rab-api', 'rab-worker', 'rab-redis']) {
    assertRefused(problemsAfter(REL, (s) => { delete s[svc].healthcheck; }), new RegExp(`${svc}: no health check`));
    assertRefused(problemsAfter(REL, (s) => { s[svc].restart = 'no'; }), new RegExp(`${svc}: restart`));
  }
});

test('ports: only rab-api publishes, never on every interface', { skip }, () => {
  assertRefused(problemsAfter('release', (s) => { s['rab-api'].ports[0].host_ip = '0.0.0.0'; }), /published on every interface/);
  assertRefused(problemsAfter('release', (s) => { delete s['rab-api'].ports[0].host_ip; }), /published on every interface/);
  assertRefused(problemsAfter('release', (s) => { s['rab-redis'].ports = [{ target: 6379, host_ip: '127.0.0.1', published: '6379' }]; }), /rab-redis: publishes a port/);
});

test('controlled release: API never migrates, token, waits for the same-image one-off rab-migrate', { skip }, () => {
  assertRefused(problemsAfter('release', (s) => { s['rab-api'].environment.CREWFLOW_MIGRATE_ON_START = 'true'; }), /must be "false" in the controlled release/);
  assertRefused(problemsAfter('release', (s) => { s['rab-api'].environment.CREWFLOW_MIGRATION_APPROVAL_MODE = 'none'; }), /must be "token" in the controlled release/);
  assertRefused(problemsAfter('release', (s) => { delete s['rab-api'].depends_on['rab-migrate']; }), /rab-api: does not wait for rab-migrate/);
  assertRefused(problemsAfter('release', (s) => { s['rab-migrate'].image = `x/y@sha256:${'9'.repeat(64)}`; }), /rab-migrate: image differs from rab-api/);
  assertRefused(problemsAfter('release', (s) => { s['rab-migrate'].restart = 'unless-stopped'; }), /rab-migrate: restart/);
  assertRefused(problemsAfter('release', (s) => { s['rab-migrate'].command = ['node', 'x.js']; }), /not deploy-prepare\.js/);
  assertRefused(problemsAfter('release', (s) => { s['rab-migrate'].environment.CREWFLOW_MIGRATION_APPROVAL_MODE = 'none'; }), /rab-migrate: CREWFLOW_MIGRATION_APPROVAL_MODE/);
  assertRefused(problemsAfter('release', (s) => { s['rab-migrate'].profiles = ['release']; }), /rab-migrate: has profiles/);
  assertRefused(problemsAfter('release', (s) => { s['rab-migrate'].volumes = s['rab-migrate'].volumes.filter((v) => v.type !== 'tmpfs'); }), /long-form tmpfs/);
  assertRefused(problemsAfter('release', (s) => { delete s['rab-migrate']; }), /services are/);
  for (const svc of APP) assertRefused(problemsAfter('release', (s) => { delete s[svc].environment.CREWFLOW_UPGRADE_FAILURE_POLICY; }), new RegExp(`${svc}: CREWFLOW_UPGRADE_FAILURE_POLICY`));
  for (const svc of ['rab-api', 'rab-worker']) assertRefused(problemsAfter('release', (s) => { s[svc].environment.CREWFLOW_RUNTIME_ISOLATION = 'warn'; }), new RegExp(`${svc}: CREWFLOW_RUNTIME_ISOLATION`));
});

test('migrate-on-start: the API migrates with a fresh-install start_period and nothing waits for rab-migrate', { skip }, () => {
  assertRefused(problemsAfter('migrate-on-start', (s) => { s['rab-api'].environment.CREWFLOW_MIGRATE_ON_START = 'false'; }), /must set CREWFLOW_MIGRATE_ON_START "true"/);
  assertRefused(problemsAfter('migrate-on-start', (s) => { s['rab-api'].healthcheck.start_period = '30s'; }), /start_period below 600s/);
  assertRefused(problemsAfter('migrate-on-start', (s) => { s['rab-worker'].depends_on['rab-migrate'] = { condition: 'service_completed_successfully' }; }), /still depend on rab-migrate/);
  assertRefused(problemsAfter('migrate-on-start', (s) => { s['rab-worker'].environment.CREWFLOW_MIGRATE_ON_START = 'true'; }), /the Worker never migrates/);
});

test('Worker: 1000:1000, main.js, tmpfs, jobs-only health, after a healthy API, >= 45 s grace', { skip }, () => {
  assertRefused(problemsAfter('release', (s) => { s['rab-worker'].user = '10001:10001'; }), /rab-worker: user is "10001:10001"/);
  for (const c of ['release', 'migrate-on-start', 'staging']) assertRefused(problemsAfter(c, (s) => { delete s['rab-worker'].init; }), /rab-worker: init: true is missing/);
  assertRefused(problemsAfter('release', (s) => { s['rab-worker'].command = ['node', '/opt/crewflow-bundle/start-worker-bundle.cjs']; }), /no root launcher/);
  assertRefused(problemsAfter('release', (s) => { s['rab-worker'].tmpfs = []; }), /tmpfs \/tmp\/crewflow-jobs is missing/);
  assertRefused(problemsAfter('release', (s) => { s['rab-worker'].healthcheck.test = ['CMD', 'node', '/opt/crewflow-bundle/worker-bundle-health.cjs']; }), /not jobs-only/);
  assertRefused(problemsAfter('release', (s) => { delete s['rab-worker'].depends_on['rab-api']; }), /does not wait for a healthy rab-api/);
  assertRefused(problemsAfter('release', (s) => { s['rab-worker'].stop_grace_period = '30s'; }), /stop_grace_period below 45s/);
  assertRefused(problemsAfter('release', (s) => { s['rab-worker'].environment.HOME = '/tmp/crewflow-jobs'; }), /HOME must be \/nonexistent/);
  assertRefused(problemsAfter('release', (s) => { s['rab-worker'].environment.NODE_OPTIONS = '--inspect'; }), /NODE_OPTIONS/);
});

test('Redis: AOF, noeviction, ACL', { skip }, () => {
  const set = (flag, value) => (s) => { const c = s['rab-redis'].command; c[c.indexOf(flag) + 1] = value; };
  assertRefused(problemsAfter('release', set('--appendonly', 'no')), /--appendonly yes/);
  assertRefused(problemsAfter('release', set('--maxmemory-policy', 'allkeys-lru')), /noeviction/);
  assertRefused(problemsAfter('release', (s) => { s['rab-redis'].command = s['rab-redis'].command.filter((t) => t !== '--aclfile'); }), /--aclfile/);
});

test('staging: own project name and storage prefix', { skip }, () => {
  assertRefused(problemsAfter('staging', (s, m) => { m.name = 'rab-production'; }), /expected crewflow-staging/);
  assertRefused(problemsAfter('staging', (s) => { s['rab-api'].environment.STORAGE_KEY_PREFIX = 'production'; }), /STORAGE_KEY_PREFIX is not staging/);
});

test('bundled database under the full contract: superuser login refused, every app service waits', { skip }, () => {
  assertRefused(problemsAfter(REL, (s) => {
    for (const svc of APP) s[svc].environment.PG_DATABASE_URL = gate.SENTINEL_URL.replace('crewflow_owner', 'postgres');
  }), /logs in as the bundled superuser/);
  assertRefused(problemsAfter(REL, (s) => { delete s['rab-migrate'].depends_on['rab-postgres']; }), /rab-migrate: does not wait for a healthy rab-postgres/);
});
