'use strict';
/**
 * FULL-mode tests for compose-owner-login.cjs: the owner-login contract of docker-compose.image.yml (its bundled `db`, an
 * external PG_DATABASE_URL, and the staging override; DB-SETUP retired docker-compose.local-db.yml). O3 (owner decisions C1-C5): one lifecycle, the API migrates on start; there is no rab-migrate.
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
// DB-SETUP (D3): the bundled db is part of the default combination (docker-compose.local-db.yml is retired).
const REL = 'default';
const EXT = 'external';
const APP = ['rab-api', 'rab-worker'];

test('every committed combination passes every check', { skip }, () => {
  for (const c of COMBOS) assert.deepEqual(checkModel(fresh(c.name), c), [], c.name);
});

const PT = 'pass-through';
const SETUP = gate.DB_SETUP_SERVICE;

test('DENIAL option 2: rab-api / rab-worker with ANY database URL (admin, crewflow_owner, anything non-empty) are refused; the key stays pinned empty', { skip }, () => {
  for (const c of [REL, EXT, PT, 'staging']) {
    for (const svc of APP) {
      // The admin URL (bundled or external), the crewflow_owner URL (pass-through included), or any other value: refused.
      for (const url of [gate.BUNDLED_URL, gate.SENTINEL_ADMIN_URL, gate.SENTINEL_URL, gate.SENTINEL_URL.replace('db-direct', 'db-other'), 'x']) {
        assertRefused(problemsAfter(c, (s) => { s[svc].environment.PG_DATABASE_URL = url; }), new RegExp(`${svc}: PG_DATABASE_URL is not empty`));
      }
      // No key at all: an env-file value would reach it.
      assertRefused(problemsAfter(c, (s) => { delete s[svc].environment.PG_DATABASE_URL; }), new RegExp(`${svc}: PG_DATABASE_URL is not pinned to ""`));
    }
  }
});

test('DENIAL option A: a database credential anywhere in rab-api / rab-worker (healthcheck, command, labels, another key) is refused', { skip }, () => {
  for (const c of [REL, EXT, PT, 'staging']) {
    for (const svc of APP) {
      for (const secret of [gate.SENTINEL_DB_PW, gate.SENTINEL_ADMIN_PW, gate.SENTINEL_OWNER_PW]) {
        assertRefused(problemsAfter(c, (s) => { s[svc].healthcheck.test = ['CMD', 'env', `X=${secret}`, 'true']; }), new RegExp(`${svc}: carries a database credential`));
        assertRefused(problemsAfter(c, (s) => { s[svc].labels = { note: secret }; }), new RegExp(`${svc}: carries a database credential`));
        assertRefused(problemsAfter(c, (s) => { s[svc].command = ['node', secret]; }), new RegExp(`${svc}: carries a database credential`));
      }
      assertRefused(problemsAfter(c, (s) => { s[svc].healthcheck.test = ['CMD', 'psql', 'postgresql://h/db']; }), new RegExp(`${svc}: holds a postgres:// value`));
    }
  }
});

test('option 2: db-setup alone receives the database URL: the bundled admin URL by default, compose.env\'s admin URL, or the crewflow_owner URL (pass-through)', { skip }, () => {
  assert.equal(fresh(REL).services[SETUP].environment.PG_DATABASE_URL, gate.BUNDLED_URL);
  assert.equal(fresh('staging').services[SETUP].environment.PG_DATABASE_URL, gate.BUNDLED_URL);
  assert.equal(fresh(EXT).services[SETUP].environment.PG_DATABASE_URL, gate.SENTINEL_ADMIN_URL);
  assert.equal(fresh(PT).services[SETUP].environment.PG_DATABASE_URL, gate.SENTINEL_URL);
  // Option 2: rab-api / rab-worker render the literal empty pin in every combination, pass-through included.
  for (const c of [REL, EXT, PT, 'staging']) for (const svc of APP) assert.equal(fresh(c).services[svc].environment.PG_DATABASE_URL, '', `${c} ${svc}`);
  // The bundled default with TLS below verify-full, another host, or a URL that is not the compose.env value: each refused.
  for (const url of [gate.BUNDLED_URL.replace('verify-full', 'disable'), gate.BUNDLED_URL.replace('@db:', '@db.evil.example:'), gate.BUNDLED_URL.replace('postgres:', 'crewflow_owner:')]) {
    assertRefused(problemsAfter(REL, (s) => { s[SETUP].environment.PG_DATABASE_URL = url; }), /db-setup: PG_DATABASE_URL is not the committed/);
  }
  assertRefused(problemsAfter(EXT, (s) => { s[SETUP].environment.PG_DATABASE_URL = gate.BUNDLED_URL; }), /db-setup: PG_DATABASE_URL is not the committed/);
  assertRefused(problemsAfter(PT, (s) => { s[SETUP].environment.PG_DATABASE_URL = gate.SENTINEL_ADMIN_URL; }), /db-setup: PG_DATABASE_URL is not the committed/);
  // Another service with a database URL, or the admin password under another key of db-setup: refused.
  assertRefused(problemsAfter(REL, (s) => { s['rab-redis'].environment = { PG_DATABASE_URL: gate.BUNDLED_URL }; }), /rab-redis: has PG_DATABASE_URL/);
  assertRefused(problemsAfter(EXT, (s) => { s[SETUP].environment.OTHER = gate.SENTINEL_ADMIN_PW; }), /db-setup: received the database admin credential \(OTHER\)/);
  assertRefused(problemsAfter(PT, (s) => { s[SETUP].environment.OTHER = gate.SENTINEL_OWNER_PW; }), /db-setup: received the database credential \(OTHER\)/);
});

test('DENIAL Twenty Helm model: db-setup never receives APP_SECRET; nothing but db-setup\'s volume is mounted at the password-file path', { skip }, () => {
  for (const c of [REL, EXT, PT, 'staging']) {
    assert.equal('APP_SECRET' in (fresh(c).services[SETUP].environment ?? {}), false, `${c}: db-setup has APP_SECRET`);
    assertRefused(problemsAfter(c, (s) => { s[SETUP].environment.APP_SECRET = gate.SENTINEL_APP_SECRET; }), /db-setup: has APP_SECRET/);
    assertRefused(problemsAfter(c, (s) => { s[SETUP].environment.OTHER = gate.SENTINEL_APP_SECRET; }), /db-setup: received a runtime secret/);
    // A bind mount (or another volume) at / under the password-file directory, on any service: refused.
    for (const svc of ['rab-redis', 'rab-api', SETUP]) {
      assertRefused(problemsAfter(c, (s) => { s[svc].volumes = [...(s[svc].volumes ?? []), { type: 'bind', source: '/srv/stolen', target: '/run/crewflow/db-target/owner-password', read_only: true }]; }), new RegExp(`${svc}: mounts something at /run/crewflow/db-target/owner-password`));
    }
    assertRefused(problemsAfter(c, (s) => { s['rab-redis'].volumes = [...(s['rab-redis'].volumes ?? []), { type: 'volume', source: 'crewflow-db-target', target: '/run/crewflow/db-target', read_only: true }]; }), /rab-redis: (unexpected named volume|mounts something) at \/run\/crewflow\/db-target/);
    // A variable that would carry the crewflow_owner password: refused on every service.
    for (const svc of ['rab-api', 'rab-worker', SETUP]) {
      assertRefused(problemsAfter(c, (s) => { s[svc].environment.CREWFLOW_OWNER_PASSWORD = 'x'; }), new RegExp(`${svc}: environment has CREWFLOW_OWNER_PASSWORD`));
    }
  }
});

test('DENIAL option A: db-setup must keep exactly its one-shot shape', { skip }, () => {
  for (const c of [REL, EXT, PT, 'staging']) {
    const cases = [
      [(s) => { delete s[SETUP]; }, /services are .*expected/],
      [(s) => { s[SETUP].restart = 'unless-stopped'; }, /db-setup: restart is "unless-stopped", expected "no"/],
      [(s) => { s[SETUP].profiles = ['setup']; }, /db-setup: has profiles/],
      [(s) => { s[SETUP].ports = [{ target: 5432, published: '5432', host_ip: '127.0.0.1' }]; }, /db-setup: publishes a port/],
      [(s) => { s[SETUP].entrypoint = ['./api-prestart.sh']; }, /db-setup: entrypoint is not exactly \.\/db-setup\.sh/],
      [(s) => { s[SETUP].command = ['sh']; }, /db-setup: has a command/],
      [(s) => { s[SETUP].init = true; }, /db-setup: init: true/],
      [(s) => { s[SETUP].image = s[SETUP].image.replace(/sha256:0/, 'sha256:1'); }, /db-setup: image differs from rab-api/],
      [(s) => { s[SETUP].user = '0:0'; }, /db-setup: user "0:0" is root/],
      [(s) => { delete s[SETUP].read_only; }, /db-setup: read_only root filesystem is not set/],
      [(s) => { s[SETUP].cap_drop = []; }, /db-setup: cap_drop ALL is missing/],
      [(s) => { s[SETUP].security_opt = []; }, /db-setup: security_opt no-new-privileges:true is missing/],
      [(s) => { delete s[SETUP].pids_limit; }, /db-setup: pids_limit is missing/],
      [(s) => { delete s[SETUP].mem_limit; }, /db-setup: mem_limit is missing/],
      [(s) => { delete s[SETUP].depends_on; }, /db-setup: depends_on must be exactly a healthy db/],
      [(s) => { s[SETUP].depends_on.db.condition = 'service_started'; }, /db-setup: depends_on must be exactly a healthy db/],
      [(s) => { s[SETUP].depends_on['rab-redis'] = { condition: 'service_healthy' }; }, /db-setup: depends_on must be exactly a healthy db/],
      [(s) => { s[SETUP].volumes = s[SETUP].volumes.filter((v) => v.source !== gate.DB_TARGET_VOLUME); }, /db-setup: does not mount the target volume writable/],
      [(s) => { for (const v of s[SETUP].volumes) if (v.source === gate.DB_TARGET_VOLUME) v.read_only = true; }, /db-setup: the target volume must be writable here/],
      [(s) => { delete s['rab-api'].depends_on[SETUP]; }, /rab-api: does not wait for db-setup/],
      [(s) => { s['rab-api'].depends_on[SETUP].condition = 'service_started'; }, /rab-api: does not wait for db-setup/],
      [(s) => { for (const svc of APP) s[svc].volumes = s[svc].volumes.filter((v) => v.source !== gate.DB_TARGET_VOLUME); }, /rab-api: does not mount db-setup's target volume read-only/],
      [(s) => { for (const v of s['rab-worker'].volumes) if (v.source === gate.DB_TARGET_VOLUME) v.read_only = false; }, /rab-worker: db-setup's target volume must be mounted read-only/],
      [(s) => { s['rab-redis'].volumes.push({ type: 'volume', source: gate.DB_TARGET_VOLUME, target: gate.DB_TARGET_DIR, read_only: true }); }, /rab-redis: (unexpected named volume|mounts db-setup's target volume)/],
    ];
    for (const [mutate, pattern] of cases) assertRefused(problemsAfter(c, mutate), pattern);
  }
});

test('DENIAL DB-SETUP: the bundled db password reaches no container except db (POSTGRES_PASSWORD) and, inside the default URL, the app', { skip }, () => {
  for (const c of [REL, EXT, 'staging']) {
    assertRefused(problemsAfter(c, (s) => { s['rab-redis'].environment = { X: gate.SENTINEL_DB_PW }; }), /rab-redis: X carries the bundled db's password/);
    for (const svc of APP) {
      assertRefused(problemsAfter(c, (s) => { s[svc].environment.PG_DATABASE_PASSWORD = gate.SENTINEL_DB_PW; }), new RegExp(`${svc}: environment has PG_DATABASE_PASSWORD`));
      assertRefused(problemsAfter(c, (s) => { s[svc].environment.OTHER = gate.SENTINEL_DB_PW; }), new RegExp(`${svc}: OTHER carries the bundled db's password`));
    }
    assertRefused(problemsAfter(c, (s) => { s.db.environment.OTHER = gate.SENTINEL_DB_PW; }), /db: OTHER carries the bundled db's password/);
  }
  // External database: the app URL must not embed the bundled db's password at all.
  assertRefused(problemsAfter(EXT, (s) => { for (const svc of APP) s[svc].environment.PG_DATABASE_URL = gate.BUNDLED_URL; }), /PG_DATABASE_URL carries the bundled db's password/);
  // Option 2, pass-through: the crewflow_owner password never reaches rab-api / rab-worker either.
  for (const svc of APP) assertRefused(problemsAfter(PT, (s) => { s[svc].environment.PG_DATABASE_URL = gate.SENTINEL_URL; }), new RegExp(`${svc}: received the database credential \\(PG_DATABASE_URL\\)`));
});

test('DENIAL DB-SETUP T-5 / PID 1: rab-worker\'s entrypoint is exactly ./worker-start.sh, no command, no compose init', { skip }, () => {
  for (const c of [REL, EXT, 'staging']) {
    for (const ep of [undefined, ['node', 'packages/rab-worker/dist/main.js'], ['/sbin/tini', '-s', '--', './worker-start.sh'], ['sh', '-c', './worker-start.sh'], ['./worker-start.sh', 'x'], ['./api-prestart.sh']]) {
      assertRefused(problemsAfter(c, (s) => { s['rab-worker'].entrypoint = ep; }), /rab-worker: entrypoint is not exactly \.\/worker-start\.sh/);
    }
    // The pre-PID-1 shape (the script as the command under the image's tini) keeps the admin URL in tini's environment.
    assertRefused(problemsAfter(c, (s) => { delete s['rab-worker'].entrypoint; s['rab-worker'].command = ['./worker-start.sh']; }), /rab-worker: entrypoint is not exactly/);
    assertRefused(problemsAfter(c, (s) => { s['rab-worker'].command = ['node', 'packages/rab-worker/dist/main.js']; }), /rab-worker: has a command/);
    assertRefused(problemsAfter(c, (s) => { s['rab-worker'].init = true; }), /rab-worker: init: true \(docker-init would be PID 1 with the admin URL/);
  }
});

test('DENIAL DB-SETUP PID 1: rab-api\'s entrypoint is exactly ./api-prestart.sh, no command, no compose init', { skip }, () => {
  for (const c of [REL, EXT, 'staging']) {
    for (const ep of [undefined, ['/sbin/tini', '-s', '--'], ['/sbin/tini', '-s', '--', './api-prestart.sh'], ['node', 'packages/rab-server/dist/main.js'], ['./worker-start.sh']]) {
      assertRefused(problemsAfter(c, (s) => { s['rab-api'].entrypoint = ep; }), /rab-api: entrypoint is not exactly \.\/api-prestart\.sh/);
    }
    assertRefused(problemsAfter(c, (s) => { delete s['rab-api'].entrypoint; s['rab-api'].command = ['./api-prestart.sh']; }), /rab-api: entrypoint is not exactly/);
    assertRefused(problemsAfter(c, (s) => { s['rab-api'].command = ['node', 'packages/rab-server/dist/command/main.js', 'x']; }), /rab-api: has a command/);
    assertRefused(problemsAfter(c, (s) => { s['rab-api'].init = true; }), /rab-api: init: true/);
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
  for (const svc of ['rab-api', 'rab-worker', 'rab-redis', 'db']) {
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

test('pay-statement sweep (owner decision 2026-11-11, J1a): 30 s, identical on both services', { skip }, () => {
  for (const c of COMBOS) {
    for (const svc of APP) {
      assert.equal(fresh(c.name).services[svc].environment.WORKER_SHIFT_STATEMENT_DISPATCH_INTERVAL_SECONDS, '30', `${c.name} ${svc}`);
    }
  }
  const KEY = 'WORKER_SHIFT_STATEMENT_DISPATCH_INTERVAL_SECONDS';
  for (const svc of APP) {
    // Missing = the 5 s code default on that service.
    assertRefused(problemsAfter(DEF, (s) => { delete s[svc].environment[KEY]; }), new RegExp(`${svc}: ${KEY} is "", expected "30"`));
    for (const other of ['5', '60', '300']) {
      assertRefused(problemsAfter(DEF, (s) => { s[svc].environment[KEY] = other; }), new RegExp(`${svc}: ${KEY} is "${other}", expected "30"`));
    }
  }
  // A Worker value that differs from the API's would never be noticed at runtime (the Worker's verify checks presence only).
  assertRefused(problemsAfter(DEF, (s) => { s['rab-worker'].environment[KEY] = '60'; }), new RegExp(`${KEY} differs between rab-api and rab-worker`));
  assertRefused(problemsAfter(DEF, (s) => { delete s['rab-api'].environment[KEY]; }), new RegExp(`${KEY} differs between rab-api and rab-worker`));
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
  // ASSERTION CHANGE (DB-SETUP PID 1, lead decision 2026-11-12): compose's init is now REFUSED; worker-start.sh execs the
  // image's tini as PID 1 (the watchdog SIGKILL still needs a real init, and gets one, with a clean environment).
  for (const c of ['default', 'external', 'staging']) assertRefused(problemsAfter(c, (s) => { s['rab-worker'].init = true; }), /rab-worker: init: true \(docker-init/);
  assertRefused(problemsAfter(DEF, (s) => { s['rab-worker'].entrypoint = ['node', '/opt/crewflow-bundle/start-worker-bundle.cjs']; }), /entrypoint is not exactly \.\/worker-start\.sh/);
  assertRefused(problemsAfter(DEF, (s) => { s['rab-worker'].tmpfs = []; }), /tmpfs \/tmp\/crewflow-jobs is missing/);
  assertRefused(problemsAfter(DEF, (s) => { s['rab-worker'].healthcheck.test = ['CMD', 'node', '/opt/crewflow-bundle/worker-bundle-health.cjs']; }), /not jobs-only/);
  assertRefused(problemsAfter(DEF, (s) => { delete s['rab-worker'].depends_on['rab-api']; }), /does not wait for a healthy rab-api/);
  assertRefused(problemsAfter(DEF, (s) => { s['rab-worker'].stop_grace_period = '30s'; }), /stop_grace_period below 45s/);
  // Owner decision 2026-11-11 (deploy exactly like Twenty): the old Worker stops before the API is replaced; the API drains 40 s.
  for (const c of ['default', 'external', 'staging']) assertRefused(problemsAfter(c, (s) => { delete s['rab-worker'].depends_on['rab-api'].restart; }), /depends_on rab-api needs restart: true/);
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

test('bundled database under the full contract: every combination has db; rab-api waits for it healthy', { skip }, () => {
  for (const c of [REL, EXT, 'staging']) {
    assertRefused(problemsAfter(c, (s) => { delete s.db; }), /services are .*expected/);
    assertRefused(problemsAfter(c, (s) => { s['rab-api'].depends_on.db.condition = 'service_started'; }), /rab-api: does not wait for a healthy db/);
    assertRefused(problemsAfter(c, (s) => { s['rab-postgres'] = structuredClone(s.db); }), /services are .*expected/);
  }
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

// Security review of PR #124 (MEDIUM): a re-added operations container under ANOTHER name and profile (`rab-maint`,
// `profiles: ["maint"]`, reading .env.ops) passed every gate. The FULL render now enables every profile, so the exact service
// list, the "has profiles" check and the separated-mode env-file sentinel all see it. This gate renders
// docker-compose.image.yml (+ its overrides) only; docker-compose.production.yml is covered by compose-one-image.cjs,
// compose-credential-isolation.cjs and staging/verify-image-compose.cjs, each with its own rendered "maint" test.
test('DENIAL (rendered): docker-compose.image.yml with a "maint"-profile service reading .env.ops fails', { skip }, () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const src = fs.readFileSync(gate.FILES.image, 'utf8');
  const weakened = src.replace(/\nnetworks:\n/, [
    '',
    '  rab-maint:',
    '    image: ${CREWFLOW_IMAGE_REPOSITORY:-adhin007/adolphus}@${CREWFLOW_IMAGE_TAG:?digest}',
    '    profiles: ["maint"]',
    '    env_file:',
    '      - .env.ops',
    '',
    'networks:',
    '',
  ].join('\n'));
  assert.notEqual(weakened, src, 'the fixture edit did not apply');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-login-maint-'));
  try {
    const copy = path.join(dir, 'docker-compose.image.yml');
    fs.writeFileSync(copy, weakened);
    const c = { name: 'maint', files: [copy], localDb: false, staging: false };
    const problems = checkModel(renderModels([c])[c.name], c);
    assertRefused(problems, /services are \[.*rab-maint.*\], expected \[db, db-setup, rab-api, rab-redis, rab-worker\]/);
    assertRefused(problems, /rab-maint: has profiles/);
    assertRefused(problems, /rab-maint: received a value from a separated-mode env file/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
