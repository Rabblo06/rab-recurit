'use strict';
/**
 * FULL-mode tests for compose-owner-login.cjs: the owner-login contract of docker-compose.image.yml and its overrides
 * (local-db, staging). O3 (owner decisions C1-C5): one lifecycle, the API migrates on start; there is no rab-migrate.
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
const DEF = 'default';
const REL = 'local-db';
const APP = ['rab-api', 'rab-worker'];

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

test('separated-mode env files never reach a service; runtime secrets reach only rab-api and rab-worker', { skip }, () => {
  for (const svc of APP) assertRefused(problemsAfter(REL, (s) => { s[svc].environment.X = gate.SENTINEL_LEGACY_PW; }), /separated-mode env file/);
  assertRefused(problemsAfter(REL, (s) => { s['rab-redis'].environment = { X: gate.SENTINEL_APP_SECRET }; }), /rab-redis: received a runtime secret/);
  assertRefused(problemsAfter(REL, (s) => { s['rab-redis'].environment = { X: gate.SENTINEL_OWNER_PW }; }), /rab-redis: received the database credential/);
  assertRefused(problemsAfter(REL, (s) => { delete s['rab-worker'].environment.APP_SECRET; }), /rab-worker: does not read runtime.env/);
});

test('hardening: each H1-H6 key is required on every service', { skip }, () => {
  for (const svc of ['rab-api', 'rab-worker', 'rab-redis', 'rab-postgres']) {
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

test('O3 lifecycle: the API migrates on start, with no token and a fresh-install start_period; nothing waits for a rab-migrate', { skip }, () => {
  assertRefused(problemsAfter(DEF, (s) => { s['rab-api'].environment.CREWFLOW_MIGRATE_ON_START = 'false'; }), /rab-api: CREWFLOW_MIGRATE_ON_START must be "true"/);
  assertRefused(problemsAfter(DEF, (s) => { s['rab-api'].environment.CREWFLOW_MIGRATION_APPROVAL_MODE = 'token'; }), /APPROVAL_MODE must be committed as "none"/);
  assertRefused(problemsAfter(DEF, (s) => { delete s['rab-api'].environment.CREWFLOW_MIGRATION_APPROVAL_MODE; }), /APPROVAL_MODE must be committed as "none"/);
  assertRefused(problemsAfter(DEF, (s) => { s['rab-api'].environment.DISABLE_DB_MIGRATIONS = 'true'; }), /rab-api: DISABLE_DB_MIGRATIONS=true/);
  assertRefused(problemsAfter(DEF, (s) => { s['rab-api'].environment.DISABLE_CRON_JOBS_REGISTRATION = 'true'; }), /rab-api: DISABLE_CRON_JOBS_REGISTRATION=true/);
  assertRefused(problemsAfter(DEF, (s) => { s['rab-api'].healthcheck.start_period = '30s'; }), /start_period below 600s/);
  assertRefused(problemsAfter(DEF, (s) => { s['rab-worker'].depends_on['rab-migrate'] = { condition: 'service_completed_successfully' }; }), /rab-worker: depends on rab-migrate/);
  assertRefused(problemsAfter(DEF, (s) => { s['rab-migrate'] = structuredClone(s['rab-api']); }), /services are/);
  for (const svc of ['rab-api', 'rab-worker']) {
    assertRefused(problemsAfter(DEF, (s) => { s[svc].environment.CREWFLOW_UPGRADE_FAILURE_POLICY = 'refuse'; }), new RegExp(`${svc}: environment has CREWFLOW_UPGRADE_FAILURE_POLICY .*deprecated`));
    assertRefused(problemsAfter(DEF, (s) => { s[svc].environment.CREWFLOW_UPGRADE_INCOMPLETE = 'x'; }), new RegExp(`${svc}: environment has CREWFLOW_UPGRADE_INCOMPLETE`));
    assertRefused(problemsAfter(DEF, (s) => { s[svc].environment.WORKER_SCHEDULER = 'interval'; }), new RegExp(`${svc}: commits WORKER_SCHEDULER`));
    assertRefused(problemsAfter(DEF, (s) => { s[svc].environment.CREWFLOW_RUNTIME_ISOLATION = 'warn'; }), new RegExp(`${svc}: CREWFLOW_RUNTIME_ISOLATION`));
  }
  assertRefused(problemsAfter(DEF, (s) => { s['rab-api'].environment.CREWFLOW_UPGRADE_FAILURE = 'maybe'; }), /CREWFLOW_UPGRADE_FAILURE must be continue or refuse/);
  assert.deepEqual(problemsAfter(DEF, (s) => { s['rab-api'].environment.CREWFLOW_UPGRADE_FAILURE = 'refuse'; }), [], 'refuse is an allowed opt-in');
});

test('O3 C5: exactly one API, stop-then-start', { skip }, () => {
  assertRefused(problemsAfter(DEF, (s) => { s['rab-api'].deploy = { replicas: 2 }; }), /rab-api: 2 replicas/);
  assertRefused(problemsAfter(DEF, (s) => { s['rab-api'].scale = 3; }), /rab-api: 3 replicas/);
  assertRefused(problemsAfter(DEF, (s) => { s['rab-api'].deploy = { update_config: { order: 'start-first' } }; }), /start-first update/);
  assert.deepEqual(problemsAfter(DEF, (s) => { s['rab-api'].deploy = { replicas: 1 }; }), []);
});

test('the Worker: never migrates, consume-only, no schema wait, waits for a healthy API and Redis, one process as 1000:1000', { skip }, () => {
  assertRefused(problemsAfter(DEF, (s) => { delete s['rab-worker'].environment.DISABLE_DB_MIGRATIONS; }), /rab-worker: DISABLE_DB_MIGRATIONS must be "true"/);
  assertRefused(problemsAfter(DEF, (s) => { s['rab-worker'].environment.DISABLE_CRON_JOBS_REGISTRATION = 'false'; }), /rab-worker: DISABLE_CRON_JOBS_REGISTRATION must be "true"/);
  assertRefused(problemsAfter(DEF, (s) => { s['rab-worker'].environment.CREWFLOW_WORKER_SCHEMA_WAIT_SECONDS = '900'; }), /CREWFLOW_WORKER_SCHEMA_WAIT_SECONDS must be "0"/);
  assertRefused(problemsAfter(DEF, (s) => { s['rab-worker'].environment.CREWFLOW_MIGRATE_ON_START = 'true'; }), /the Worker never migrates/);
  assertRefused(problemsAfter(DEF, (s) => { delete s['rab-worker'].depends_on['rab-redis']; }), /rab-worker: does not wait for a healthy rab-redis/);
  assertRefused(problemsAfter(DEF, (s) => { s['rab-worker'].image = `x/y@sha256:${'9'.repeat(64)}`; }), /rab-worker: image differs from rab-api/);
  assertRefused(problemsAfter(DEF, (s) => { s['rab-worker'].user = '10001:10001'; }), /rab-worker: user is "10001:10001"/);
  for (const c of ['default', 'local-db', 'staging']) assertRefused(problemsAfter(c, (s) => { delete s['rab-worker'].init; }), /rab-worker: init: true is missing/);
  assertRefused(problemsAfter(DEF, (s) => { s['rab-worker'].command = ['node', '/opt/crewflow-bundle/start-worker-bundle.cjs']; }), /no root launcher/);
  assertRefused(problemsAfter(DEF, (s) => { s['rab-worker'].tmpfs = []; }), /tmpfs \/tmp\/crewflow-jobs is missing/);
  assertRefused(problemsAfter(DEF, (s) => { s['rab-worker'].healthcheck.test = ['CMD', 'node', '/opt/crewflow-bundle/worker-bundle-health.cjs']; }), /not jobs-only/);
  assertRefused(problemsAfter(DEF, (s) => { delete s['rab-worker'].depends_on['rab-api']; }), /does not wait for a healthy rab-api/);
  assertRefused(problemsAfter(DEF, (s) => { s['rab-worker'].stop_grace_period = '30s'; }), /stop_grace_period below 45s/);
  assertRefused(problemsAfter(DEF, (s) => { s['rab-worker'].environment.HOME = '/tmp/crewflow-jobs'; }), /HOME must be \/nonexistent/);
  assertRefused(problemsAfter(DEF, (s) => { s['rab-worker'].environment.NODE_OPTIONS = '--inspect'; }), /NODE_OPTIONS/);
});

test('rab-api ports: loopback only; Redis never published', { skip }, () => {
  assertRefused(problemsAfter(DEF, (s) => { s['rab-api'].ports[0].host_ip = '0.0.0.0'; }), /published on every interface/);
  assertRefused(problemsAfter(DEF, (s) => { delete s['rab-api'].ports[0].host_ip; }), /published on every interface/);
  assertRefused(problemsAfter(DEF, (s) => { s['rab-redis'].ports = [{ target: 6379, host_ip: '127.0.0.1', published: '6379' }]; }), /rab-redis: publishes a port/);
});

test('Redis: AOF, noeviction, ACL', { skip }, () => {
  const set = (flag, value) => (s) => { const c = s['rab-redis'].command; c[c.indexOf(flag) + 1] = value; };
  assertRefused(problemsAfter(DEF, set('--appendonly', 'no')), /--appendonly yes/);
  assertRefused(problemsAfter(DEF, set('--maxmemory-policy', 'allkeys-lru')), /noeviction/);
  assertRefused(problemsAfter(DEF, (s) => { s['rab-redis'].command = s['rab-redis'].command.filter((t) => t !== '--aclfile'); }), /--aclfile/);
});

test('staging: own project name and storage prefix', { skip }, () => {
  assertRefused(problemsAfter('staging', (s, m) => { m.name = 'rab-production'; }), /expected crewflow-staging/);
  assertRefused(problemsAfter('staging', (s) => { s['rab-api'].environment.STORAGE_KEY_PREFIX = 'production'; }), /STORAGE_KEY_PREFIX is not staging/);
});

test('bundled database under the full contract: superuser login refused, every app service waits', { skip }, () => {
  assertRefused(problemsAfter(REL, (s) => {
    for (const svc of APP) s[svc].environment.PG_DATABASE_URL = gate.SENTINEL_URL.replace('crewflow_owner', 'postgres');
  }), /logs in as the bundled superuser/);
  for (const svc of APP) assertRefused(problemsAfter(REL, (s) => { delete s[svc].depends_on['rab-postgres']; }), new RegExp(`${svc}: does not wait for a healthy rab-postgres`));
});
