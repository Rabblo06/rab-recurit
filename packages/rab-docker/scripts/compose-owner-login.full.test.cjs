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
  assertRefused(problemsAfter(DEF, (s) => { s['rab-api'].environment.CREWFLOW_MIGRATION_APPROVAL_MODE = 'maybe'; }), /APPROVAL_MODE must render as none or token/);
  assertRefused(problemsAfter(DEF, (s) => { delete s['rab-api'].environment.CREWFLOW_MIGRATION_APPROVAL_MODE; }), /APPROVAL_MODE must render as none or token/);
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

test('approval mode (BC-11/C4): unset in compose.env renders none; token renders token; a bogus value is refused', { skip }, () => {
  // unset -> none: the committed sentinel compose.env does not set it.
  for (const c of COMBOS) assert.equal(fresh(c.name).services['rab-api'].environment.CREWFLOW_MIGRATION_APPROVAL_MODE, 'none', c.name);
  // token -> token: rendered for real with the opt-in in compose.env, and the model passes every check.
  const tokenModels = renderModels(COMBOS, ['CREWFLOW_MIGRATION_APPROVAL_MODE=token']);
  for (const c of COMBOS) {
    assert.equal(tokenModels[c.name].services['rab-api'].environment.CREWFLOW_MIGRATION_APPROVAL_MODE, 'token', c.name);
    assert.deepEqual(checkModel(tokenModels[c.name], c), [], c.name);
  }
  // A bogus value in compose.env renders and is refused by the gate (and by the compose.env lint).
  const bogus = renderModels([combo(DEF)], ['CREWFLOW_MIGRATION_APPROVAL_MODE=off'])[DEF];
  assertRefused(checkModel(bogus, combo(DEF)), /rab-api: CREWFLOW_MIGRATION_APPROVAL_MODE must render as none or token/);
  assertRefused(gate.lintEnvText('compose', 'CREWFLOW_MIGRATION_APPROVAL_MODE=off'), /must be exactly none or token/);
  // In runtime.env it would be overridden by rab-api's committed expression: refused, naming compose.env.
  assertRefused(gate.lintEnvText('runtime', 'CREWFLOW_MIGRATION_APPROVAL_MODE=token'), /set it in compose\.env/);
});

test('BC-07: the audit sink reaches rab-api and rab-worker from runtime.env as stdout; missing or invalid is refused', { skip }, () => {
  for (const svc of APP) {
    assert.equal(fresh(DEF).services[svc].environment.CREWFLOW_AUDIT_SINK, 'stdout', svc);
    assertRefused(problemsAfter(DEF, (s) => { delete s[svc].environment.CREWFLOW_AUDIT_SINK; }), new RegExp(`${svc}: CREWFLOW_AUDIT_SINK is "", expected stdout`));
    assertRefused(problemsAfter(DEF, (s) => { s[svc].environment.CREWFLOW_AUDIT_SINK = 'none'; }), new RegExp(`${svc}: CREWFLOW_AUDIT_SINK is "none", expected stdout`));
  }
});

test('notification delivery (owner decision 2026-11-06): fast publish on and the 30 s email sweep, identical on both services', { skip }, () => {
  for (const c of COMBOS) {
    for (const svc of APP) {
      const env = fresh(c.name).services[svc].environment;
      assert.equal(env.WORKER_FAST_PUBLISH_NOTIFY, 'true', `${c.name} ${svc}`);
      assert.equal(env.WORKER_EMAIL_DISPATCH_INTERVAL_SECONDS, '30', `${c.name} ${svc}`);
      // Push and realtime keep the 2 s code default: not committed (owner decision 3).
      assert.equal(env.WORKER_PUSH_DISPATCH_INTERVAL_SECONDS, undefined, `${c.name} ${svc}`);
      assert.equal(env.WORKER_REALTIME_OUTBOX_PUBLISH_INTERVAL_SECONDS, undefined, `${c.name} ${svc}`);
    }
  }
  for (const svc of APP) {
    assertRefused(problemsAfter(DEF, (s) => { delete s[svc].environment.WORKER_FAST_PUBLISH_NOTIFY; }), new RegExp(`${svc}: WORKER_FAST_PUBLISH_NOTIFY is "", expected "true"`));
    assertRefused(problemsAfter(DEF, (s) => { s[svc].environment.WORKER_FAST_PUBLISH_NOTIFY = 'false'; }), new RegExp(`${svc}: WORKER_FAST_PUBLISH_NOTIFY is "false", expected "true"`));
    assertRefused(problemsAfter(DEF, (s) => { delete s[svc].environment.WORKER_EMAIL_DISPATCH_INTERVAL_SECONDS; }), new RegExp(`${svc}: WORKER_EMAIL_DISPATCH_INTERVAL_SECONDS is "", expected "30"`));
    // A Worker value that differs from the API's would never be noticed at runtime (the Worker's verify checks presence only).
    assertRefused(problemsAfter(DEF, (s) => { s[svc].environment.WORKER_EMAIL_DISPATCH_INTERVAL_SECONDS = '2'; }), new RegExp(`${svc}: WORKER_EMAIL_DISPATCH_INTERVAL_SECONDS is "2", expected "30"`));
  }
});

test('Phase D switches (owner decision 2026-11-06): triggers on for all four kinds and the safety sweeps, identical on both services', { skip }, () => {
  for (const c of COMBOS) {
    for (const svc of APP) {
      const env = fresh(c.name).services[svc].environment;
      assert.equal(env.WORKER_TIMER_TRIGGERS, 'on', `${c.name} ${svc}`);
      assert.equal(env.WORKER_TIMER_TRIGGER_KINDS, 'offer-expiry,manager-confirmation,no-show,late-clock-in', `${c.name} ${svc}`);
      assert.equal(env.WORKER_OFFER_EXPIRY_INTERVAL_SECONDS, '300', `${c.name} ${svc}`);
      assert.equal(env.WORKER_MANAGER_CONFIRMATION_TIMEOUT_INTERVAL_SECONDS, '120', `${c.name} ${svc}`);
      assert.equal(env.WORKER_LATE_CLOCK_IN_INTERVAL_SECONDS, '300', `${c.name} ${svc}`);
      // Unchanged by the owner: the shift monitor keeps its 300 s default and the combined scan stays off (not committed).
      assert.equal(env.WORKER_SHIFT_MONITOR_INTERVAL_SECONDS, undefined, `${c.name} ${svc}`);
      assert.equal(env.WORKER_SHIFT_SCAN_MODE, undefined, `${c.name} ${svc}`);
    }
  }
  for (const svc of APP) {
    assertRefused(problemsAfter(DEF, (s) => { delete s[svc].environment.WORKER_TIMER_TRIGGERS; }), new RegExp(`${svc}: WORKER_TIMER_TRIGGERS is "", expected "on"`));
    for (const mode of ['off', 'shadow']) {
      assertRefused(problemsAfter(DEF, (s) => { s[svc].environment.WORKER_TIMER_TRIGGERS = mode; }), new RegExp(`${svc}: WORKER_TIMER_TRIGGERS is "${mode}", expected "on"`));
    }
    // An unset kind list means "every kind the code knows", including any added later: the list stays explicit.
    assertRefused(problemsAfter(DEF, (s) => { delete s[svc].environment.WORKER_TIMER_TRIGGER_KINDS; }), new RegExp(`${svc}: WORKER_TIMER_TRIGGER_KINDS is "", expected`));
    assertRefused(problemsAfter(DEF, (s) => { s[svc].environment.WORKER_TIMER_TRIGGER_KINDS = 'offer-expiry'; }), new RegExp(`${svc}: WORKER_TIMER_TRIGGER_KINDS is "offer-expiry", expected`));
    for (const [key, other] of [['WORKER_OFFER_EXPIRY_INTERVAL_SECONDS', '60'], ['WORKER_MANAGER_CONFIRMATION_TIMEOUT_INTERVAL_SECONDS', '300'], ['WORKER_LATE_CLOCK_IN_INTERVAL_SECONDS', '120']]) {
      assertRefused(problemsAfter(DEF, (s) => { delete s[svc].environment[key]; }), new RegExp(`${svc}: ${key} is "", expected`));
      // A Worker value that differs from the API's would never be noticed at runtime (the Worker's verify checks ids only).
      assertRefused(problemsAfter(DEF, (s) => { s[svc].environment[key] = other; }), new RegExp(`${svc}: ${key} is "${other}", expected`));
    }
    assertRefused(problemsAfter(DEF, (s) => { s[svc].environment.WORKER_SHIFT_SCAN_MODE = 'combined'; }), new RegExp(`${svc}: WORKER_SHIFT_SCAN_MODE is "combined"; the owner decision 2026-11-06 keeps it at separate`));
    assertRefused(problemsAfter(DEF, (s) => { s[svc].environment.WORKER_SHIFT_MONITOR_INTERVAL_SECONDS = '600'; }), new RegExp(`${svc}: WORKER_SHIFT_MONITOR_INTERVAL_SECONDS is "600"; the owner decision 2026-11-06 keeps it at 300`));
  }
  // The code defaults written out explicitly change nothing and are accepted.
  assert.deepEqual(problemsAfter(DEF, (s) => { for (const svc of APP) Object.assign(s[svc].environment, { WORKER_SHIFT_SCAN_MODE: 'separate', WORKER_SHIFT_MONITOR_INTERVAL_SECONDS: '300' }); }), []);
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
  // Owner decision 2026-11-11 (deploy exactly like Twenty): the old Worker stops before the API is replaced; the API drains 40 s.
  for (const c of ['default', 'local-db', 'staging']) assertRefused(problemsAfter(c, (s) => { delete s['rab-worker'].depends_on['rab-api'].restart; }), /depends_on rab-api needs restart: true/);
  assertRefused(problemsAfter(DEF, (s) => { s['rab-api'].stop_grace_period = '35s'; }), /rab-api: stop_grace_period below 40s/);
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

// Phase X J2 (S0-J SJ-03): the committed compose files rendered with push / realtime switched ON in runtime.env.
test('J2: push switched on in runtime.env against the committed compose is refused until 30 s is committed on both services', { skip }, () => {
  const on = renderModels(COMBOS, [], ['PUSH_ENABLED=true']);
  for (const c of COMBOS) {
    const problems = checkModel(on[c.name], c);
    assertRefused(problems, new RegExp(`${c.name}: rab-api: PUSH_ENABLED=true needs WORKER_PUSH_DISPATCH_INTERVAL_SECONDS="30" committed`));
    assertRefused(problems, new RegExp(`${c.name}: rab-worker: PUSH_ENABLED=true needs WORKER_PUSH_DISPATCH_INTERVAL_SECONDS="30" committed`));
    // With the owner value committed on both services the rule holds.
    const fixed = structuredClone(on[c.name]);
    for (const svc of APP) fixed.services[svc].environment.WORKER_PUSH_DISPATCH_INTERVAL_SECONDS = '30';
    assert.ok(!checkModel(fixed, c).some((p) => /PUSH_/.test(p)), c.name);
    // 30 on the API only: the Worker's 2 s default would never be noticed at runtime.
    const half = structuredClone(on[c.name]);
    half.services['rab-api'].environment.WORKER_PUSH_DISPATCH_INTERVAL_SECONDS = '30';
    assertRefused(checkModel(half, c), /rab-worker: PUSH_ENABLED=true needs/);
  }
  // A compose override switching push on for one service only.
  assertRefused(problemsAfter(DEF, (s) => { s['rab-worker'].environment.PUSH_ENABLED = 'true'; }), /PUSH_ENABLED differs between rab-api and rab-worker/);
});

test('J2: realtime switched on in runtime.env renders the same (2 s default on both) and passes; a one-sided interval is refused', { skip }, () => {
  const on = renderModels([combo(DEF)], [], ['REALTIME_ENABLED=true']);
  assert.ok(!checkModel(on[DEF], combo(DEF)).some((p) => /REALTIME/.test(p)));
  const skew = structuredClone(on[DEF]);
  skew.services['rab-api'].environment.WORKER_REALTIME_OUTBOX_PUBLISH_INTERVAL_SECONDS = '10';
  assertRefused(checkModel(skew, combo(DEF)), /REALTIME_ENABLED=true: WORKER_REALTIME_OUTBOX_PUBLISH_INTERVAL_SECONDS differs between rab-api and rab-worker/);
});

test('J2: `--lint-env-file runtime` refuses PUSH_ENABLED=true while the committed compose files lack the 30 s sweep', { skip }, () => {
  const fsx = require('node:fs');
  const os = require('node:os');
  const pathx = require('node:path');
  const dir = fsx.mkdtempSync(pathx.join(os.tmpdir(), 'owner-login-j2-'));
  const file = pathx.join(dir, 'runtime.env');
  const logs = [];
  const original = console.log;
  try {
    console.log = (m) => logs.push(String(m));
    fsx.writeFileSync(file, 'CREWFLOW_AUDIT_SINK=stdout\nPUSH_ENABLED=true\n');
    assert.equal(gate.main(['--lint-env-file', 'runtime', file]), 1);
    assert.ok(logs.some((l) => /FAIL runtime env file: default: rab-api: PUSH_ENABLED=true needs WORKER_PUSH_DISPATCH_INTERVAL_SECONDS="30"/.test(l)), logs.join('\n'));
    logs.length = 0;
    fsx.writeFileSync(file, 'CREWFLOW_AUDIT_SINK=stdout\nPUSH_ENABLED=false\n');
    assert.equal(gate.main(['--lint-env-file', 'runtime', file]), 0);
  } finally {
    console.log = original;
    fsx.rmSync(dir, { recursive: true, force: true });
  }
});

// Review of #97, finding J2-1 (reproduced by the reviewer): `PUSH_ENABLED=true # on` reaches the app as "true", so the
// lint must treat it as ON; quoted values likewise; garbage is refused (fail closed), never read as off.
test('J2-1: `--lint-env-file runtime` reads switches as Compose does: commented / quoted true = ON, garbage refused', { skip }, () => {
  const fsx = require('node:fs');
  const os = require('node:os');
  const pathx = require('node:path');
  const dir = fsx.mkdtempSync(pathx.join(os.tmpdir(), 'owner-login-j2-1-'));
  const file = pathx.join(dir, 'runtime.env');
  const original = console.log;
  const lint = (line) => {
    const logs = [];
    console.log = (m) => logs.push(String(m));
    try {
      fsx.writeFileSync(file, `CREWFLOW_AUDIT_SINK=stdout\n${line}\n`);
      return { code: gate.main(['--lint-env-file', 'runtime', file]), out: logs.join('\n') };
    } finally {
      console.log = original;
    }
  };
  try {
    for (const line of ['PUSH_ENABLED=true # on', 'PUSH_ENABLED="true"', "PUSH_ENABLED='true' # on", 'export PUSH_ENABLED=true']) {
      const r = lint(line);
      assert.equal(r.code, 1, line);
      assert.match(r.out, /default: rab-api: PUSH_ENABLED=true needs WORKER_PUSH_DISPATCH_INTERVAL_SECONDS="30"/, line);
    }
    for (const line of ['PUSH_ENABLED=yes', 'PUSH_ENABLED=TRUE', 'PUSH_ENABLED="true', 'REALTIME_ENABLED=1']) {
      const r = lint(line);
      assert.equal(r.code, 1, line);
      assert.match(r.out, /_ENABLED: must be exactly true or false/, line);
    }
    assert.equal(lint('PUSH_ENABLED=false # off').code, 0);
    assert.equal(lint('REALTIME_ENABLED="false"').code, 0);
  } finally {
    console.log = original;
    fsx.rmSync(dir, { recursive: true, force: true });
  }
});

test('J2-1: the committed compose rendered with a commented runtime.env switch: Compose gives "true", the gate refuses', { skip }, () => {
  const on = renderModels([combo(DEF)], [], ['PUSH_ENABLED=true # on']);
  assert.equal(on[DEF].services['rab-api'].environment.PUSH_ENABLED, 'true'); // what the app really receives
  assertRefused(checkModel(on[DEF], combo(DEF)), /rab-api: PUSH_ENABLED=true needs WORKER_PUSH_DISPATCH_INTERVAL_SECONDS="30"/);
  // A compose value outside true/false is refused too (it would be read as off).
  assertRefused(problemsAfter(DEF, (s) => { for (const svc of APP) s[svc].environment.PUSH_ENABLED = 'yes'; }), /rab-api: PUSH_ENABLED must be exactly true or false/);
});
