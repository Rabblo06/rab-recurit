'use strict';
/**
 * Tests for verify-image-compose.cjs (the digest-pinned image compose variant).
 *
 *   node --test packages/rab-docker/staging/verify-image-compose.test.cjs
 *
 * Needs `docker compose` (renders the committed files once); every negative case mutates a copy of that rendered model,
 * so each one proves the verifier refuses one specific weakening.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

const { checkVariant, checkResolvedImages, renderModels, SENTINEL_MIGRATOR_PW, SENTINEL_OPS_PW, RUNTIME_KEYS } = require('./verify-image-compose.cjs');

/** The five retired separated-mode operations names (rab-ops removal PR 2, plan §2.6): every one stays refused. */
const RETIRED_OPS_NAMES = ['CREWFLOW_OPS_RUN', 'PG_OPS_APP_DATABASE_URL', 'CREWFLOW_OPS_ACTOR_SOURCE', 'CREWFLOW_OPS_ACTOR_ID', 'CREWFLOW_OPS_CHANGE_REF'];
/** rab-api's OpenShip import guard as Compose renders it (docker-compose.image.yml only). */
const isGuard = (v) => v?.type === 'tmpfs' && v.target === '/tmp';
const guardOf = (v) => v.services['rab-api'].volumes.find(isGuard);

let composeAvailable = true;
try {
  execFileSync('docker', ['compose', 'version'], { stdio: 'ignore' });
} catch {
  composeAvailable = false;
}
const skip = composeAvailable ? false : 'docker compose is not available';
let models;
const fresh = () => {
  models ??= renderModels();
  return structuredClone(models);
};
/** Applies `mutate` to a fresh copy of the rendered models and returns the verifier's problems. */
const problemsAfter = (mutate) => {
  const m = fresh();
  mutate(m.variant, m.variantFiles, m.production);
  return checkVariant(m.variant, m.production, m.variantFiles);
};
const assertRefused = (problems, pattern) => {
  assert.ok(problems.some((p) => pattern.test(p)), `expected a problem matching ${pattern}; got: ${problems.join(' | ') || '(none)'}`);
};

test('the committed variant passes every check', { skip }, () => {
  const m = fresh();
  assert.deepEqual(checkVariant(m.variant, m.production, m.variantFiles), []);
});

test('the variant and the production file declare the same runtime keys for rab-api and rab-worker', { skip }, () => {
  const m = fresh();
  for (const svc of ['rab-api', 'rab-worker']) {
    // The intended differences (image file only): the read-only PostgreSQL CA bind, and rab-api's OpenShip import guard.
    const noCa = (vols) => {
      const rest = (vols ?? []).filter((v) => !(v.type === 'bind' && v.target === '/run/crewflow/pg-ca.crt' && v.read_only === true));
      return rest.length ? rest : undefined;
    };
    const noGuard = (vols) => (svc === 'rab-api' ? (vols ?? []).filter((v) => !isGuard(v)) : vols);
    for (const key of RUNTIME_KEYS) {
      const a = key === 'volumes' ? noCa(noGuard(m.variant.services[svc][key])) : m.variant.services[svc][key];
      const b = key === 'volumes' ? noCa(m.production.services[svc][key]) : m.production.services[svc][key];
      assert.deepEqual(a, b, `${svc}.${key}`);
    }
  }
});

const weakenings = [
  ['rab-api read_only removed', (v) => { delete v.services['rab-api'].read_only; }, /rab-api\.read_only differs/],
  ['rab-api cap_drop removed', (v) => { delete v.services['rab-api'].cap_drop; }, /rab-api\.cap_drop differs/],
  ['rab-api capability added', (v) => { v.services['rab-api'].cap_add = ['NET_RAW']; }, /rab-api\.cap_add differs/],
  ['rab-api no-new-privileges removed', (v) => { v.services['rab-api'].security_opt = []; }, /rab-api\.security_opt differs/],
  ['rab-api runs as root', (v) => { v.services['rab-api'].user = '0:0'; }, /rab-api\.user differs/],
  ['rab-api PID limit removed', (v) => { delete v.services['rab-api'].pids_limit; }, /rab-api\.pids_limit differs/],
  ['rab-api memory limit raised', (v) => { v.services['rab-api'].mem_limit = '4294967296'; }, /rab-api\.mem_limit differs/],
  ['rab-api healthcheck removed', (v) => { delete v.services['rab-api'].healthcheck; }, /rab-api\.healthcheck differs/],
  ['rab-api stop grace shortened', (v) => { v.services['rab-api'].stop_grace_period = '5s'; }, /rab-api\.stop_grace_period differs/],
  ['rab-worker tmpfs dropped', (v) => { v.services['rab-worker'].tmpfs = v.services['rab-worker'].tmpfs.slice(1); }, /rab-worker\.tmpfs differs/],
  ['rab-worker extra capability', (v) => { v.services['rab-worker'].cap_add = ['CHOWN']; }, /rab-worker\.cap_add differs/],
  ['rab-worker back on the root launcher', (v) => { v.services['rab-worker'].user = '0:0'; }, /rab-worker\.user differs/],
  ['rab-worker privileged', (v) => { v.services['rab-worker'].privileged = true; }, /rab-worker: privileged/],
  ['rab-worker host PID namespace', (v) => { v.services['rab-worker'].pid = 'host'; }, /host namespace/],
  ['a build section', (v) => { v.services['rab-worker'].build = { context: '.' }; }, /rab-worker: has a build section/],
  ['an image tag instead of a digest', (v) => { v.services['rab-api'].image = 'adhin007/adolphus:latest'; }, /rab-api: image .* is not repository@sha256/],
  ['tag and digest together', (v) => { v.services['rab-api'].image = `adhin007/adolphus:v1@sha256:${'1'.repeat(64)}`; }, /rab-api: image/],
  ['a release step brought back (O3)', (v) => { v.services['rab-migrate'] = structuredClone(v.services['rab-api']); }, /rab-migrate: present/],
  ['rab-worker on another image than rab-api (O2: one image)', (v) => { v.services['rab-worker'].image = `adhin007/adolphus@sha256:${'7a'.repeat(32)}`; }, /rab-worker: image differs from rab-api/],
  ['enforce mode switched to warn', (v) => { v.services['rab-worker'].environment.CREWFLOW_RUNTIME_ISOLATION = 'warn'; }, /rab-worker: CREWFLOW_RUNTIME_ISOLATION is not "enforce"/],
  ['enforce mode removed from the API', (v) => { delete v.services['rab-api'].environment.CREWFLOW_RUNTIME_ISOLATION; }, /rab-api: CREWFLOW_RUNTIME_ISOLATION/],
  ['HWS switched on', (v) => { v.services['rab-api'].environment.HWS_RUNTIME_ENABLED = 'true'; }, /rab-api\.environment\.HWS_RUNTIME_ENABLED differs/],
  ['REDIS_URL committed', (v) => { v.services['rab-worker'].environment.REDIS_URL = 'redis://rab-redis:6379'; }, /rab-worker: REDIS_URL is committed/],
  ['API published on every interface', (v) => { v.services['rab-api'].ports[0].host_ip = '0.0.0.0'; }, /every interface/],
  ['Redis port published', (v) => { v.services['rab-redis'].ports = [{ target: 6379, published: '6379' }]; }, /rab-redis: publishes a port/],
  ['Redis ACL mount removed', (v) => { v.services['rab-redis'].volumes = v.services['rab-redis'].volumes.filter((x) => !/acl/.test(x.target)); }, /ACL file not mounted/],
  ['migration credential reaches the API', (v) => { v.services['rab-api'].environment.PG_DATABASE_URL = `postgresql://crewflow_migrator:${SENTINEL_MIGRATOR_PW}@h:5432/rab`; }, /rab-api: PG_DATABASE_URL carries a migration\/ops credential/],
  ['migration approval on the Worker', (v) => { v.services['rab-worker'].environment.CREWFLOW_MIGRATION_APPROVED = 'pending-1-x'; }, /rab-worker: sets CREWFLOW_MIGRATION_APPROVED/],
  ['API reads .env.migrate', (_v, f) => { f.services['rab-api'].env_file = [{ path: '/x/.env.migrate' }]; }, /rab-api: names \.env\.migrate/],
  ['the API waits for a rab-migrate again', (v) => { v.services['rab-api'].depends_on['rab-migrate'] = { condition: 'service_completed_successfully' }; }, /rab-api: depends on rab-migrate|rab-api\.depends_on differs/],
  ['API no longer migrates on start (O3 C1)', (v) => { v.services['rab-api'].environment.CREWFLOW_MIGRATE_ON_START = 'false'; }, /rab-api: CREWFLOW_MIGRATE_ON_START is not "true"/],
  ['a bogus approval mode', (v) => { v.services['rab-api'].environment.CREWFLOW_MIGRATION_APPROVAL_MODE = 'off'; }, /rab-api: CREWFLOW_MIGRATION_APPROVAL_MODE is not none or token/],
  ['API stops registering the schedulers (O3 C2)', (v) => { v.services['rab-api'].environment.DISABLE_CRON_JOBS_REGISTRATION = 'true'; }, /rab-api: must migrate and register/],
  ['the Worker migrates (O3 C1)', (v) => { delete v.services['rab-worker'].environment.DISABLE_DB_MIGRATIONS; }, /rab-worker: DISABLE_DB_MIGRATIONS and DISABLE_CRON_JOBS_REGISTRATION/],
  ['the Worker registers schedulers (O3 C2)', (v) => { v.services['rab-worker'].environment.DISABLE_CRON_JOBS_REGISTRATION = 'false'; }, /rab-worker: DISABLE_DB_MIGRATIONS and DISABLE_CRON_JOBS_REGISTRATION/],
  ['interval scheduler committed again', (v) => { v.services['rab-worker'].environment.WORKER_SCHEDULER = 'interval'; }, /rab-worker: commits WORKER_SCHEDULER/],
  // Owner decision 2026-11-06 (notification delivery): both values on both services, in both files.
  ['fast publish off on the API', (v) => { v.services['rab-api'].environment.WORKER_FAST_PUBLISH_NOTIFY = 'false'; }, /rab-api: WORKER_FAST_PUBLISH_NOTIFY is not "true"/],
  ['fast publish removed from the Worker', (v) => { delete v.services['rab-worker'].environment.WORKER_FAST_PUBLISH_NOTIFY; }, /rab-worker: WORKER_FAST_PUBLISH_NOTIFY is not "true"|rab-worker\.environment\.WORKER_FAST_PUBLISH_NOTIFY differs/],
  ['the API registers a 2 s email sweep', (v) => { v.services['rab-api'].environment.WORKER_EMAIL_DISPATCH_INTERVAL_SECONDS = '2'; }, /rab-api: WORKER_EMAIL_DISPATCH_INTERVAL_SECONDS is not "30"/],
  ['the Worker disagrees with the API on the email sweep', (v) => { v.services['rab-worker'].environment.WORKER_EMAIL_DISPATCH_INTERVAL_SECONDS = '60'; }, /rab-worker: WORKER_EMAIL_DISPATCH_INTERVAL_SECONDS is not "30"/],
  // Owner decision 2026-11-06 (Phase D switches): every value on both services, in both files; the shift monitor and the
  // combined-scan mode stay at the code default.
  ['timer triggers off on the API', (v) => { v.services['rab-api'].environment.WORKER_TIMER_TRIGGERS = 'off'; }, /rab-api: WORKER_TIMER_TRIGGERS is not "on"/],
  ['timer triggers in shadow on the Worker', (v) => { v.services['rab-worker'].environment.WORKER_TIMER_TRIGGERS = 'shadow'; }, /rab-worker: WORKER_TIMER_TRIGGERS is not "on"|rab-worker\.environment\.WORKER_TIMER_TRIGGERS differs/],
  ['the trigger kind list removed (unset = every kind, future ones included)', (v) => { delete v.services['rab-api'].environment.WORKER_TIMER_TRIGGER_KINDS; }, /rab-api: WORKER_TIMER_TRIGGER_KINDS is not "offer-expiry,manager-confirmation,no-show,late-clock-in"|rab-api\.environment\.WORKER_TIMER_TRIGGER_KINDS differs/],
  ['the API registers a 60 s offer-expiry sweep', (v) => { v.services['rab-api'].environment.WORKER_OFFER_EXPIRY_INTERVAL_SECONDS = '60'; }, /rab-api: WORKER_OFFER_EXPIRY_INTERVAL_SECONDS is not "300"/],
  ['the Worker disagrees with the API on the manager-confirmation sweep', (v) => { v.services['rab-worker'].environment.WORKER_MANAGER_CONFIRMATION_TIMEOUT_INTERVAL_SECONDS = '300'; }, /rab-worker: WORKER_MANAGER_CONFIRMATION_TIMEOUT_INTERVAL_SECONDS is not "120"/],
  ['the late clock-in sweep removed from the API', (v) => { delete v.services['rab-api'].environment.WORKER_LATE_CLOCK_IN_INTERVAL_SECONDS; }, /rab-api: WORKER_LATE_CLOCK_IN_INTERVAL_SECONDS is not "300"|rab-api\.environment\.WORKER_LATE_CLOCK_IN_INTERVAL_SECONDS differs/],
  ['the combined shift scan committed', (v) => { v.services['rab-worker'].environment.WORKER_SHIFT_SCAN_MODE = 'combined'; }, /rab-worker: WORKER_SHIFT_SCAN_MODE is committed as "combined"/],
  ['a slower shift monitor committed', (v) => { v.services['rab-api'].environment.WORKER_SHIFT_MONITOR_INTERVAL_SECONDS = '600'; }, /rab-api: WORKER_SHIFT_MONITOR_INTERVAL_SECONDS is committed as "600"/],
  // Owner decision 2026-11-11 (J1a): the 30 s pay-statement sweep on both services, in both files.
  ['the pay-statement sweep removed from the API (5 s code default)', (v) => { delete v.services['rab-api'].environment.WORKER_SHIFT_STATEMENT_DISPATCH_INTERVAL_SECONDS; }, /rab-api: WORKER_SHIFT_STATEMENT_DISPATCH_INTERVAL_SECONDS is not "30"/],
  ['the pay-statement sweep removed from the Worker', (v) => { delete v.services['rab-worker'].environment.WORKER_SHIFT_STATEMENT_DISPATCH_INTERVAL_SECONDS; }, /rab-worker: WORKER_SHIFT_STATEMENT_DISPATCH_INTERVAL_SECONDS is not "30"/],
  ['the API registers a 5 s pay-statement sweep', (v) => { v.services['rab-api'].environment.WORKER_SHIFT_STATEMENT_DISPATCH_INTERVAL_SECONDS = '5'; }, /rab-api: WORKER_SHIFT_STATEMENT_DISPATCH_INTERVAL_SECONDS is not "30"/],
  ['the Worker disagrees with the API on the pay-statement sweep', (v) => { v.services['rab-worker'].environment.WORKER_SHIFT_STATEMENT_DISPATCH_INTERVAL_SECONDS = '60'; }, /rab-worker: WORKER_SHIFT_STATEMENT_DISPATCH_INTERVAL_SECONDS is not "30"/],
  ['both files drift together to 5 s', (v, _f, p) => { for (const m of [v, p]) for (const n of ['rab-api', 'rab-worker']) m.services[n].environment.WORKER_SHIFT_STATEMENT_DISPATCH_INTERVAL_SECONDS = '5'; }, /rab-api: WORKER_SHIFT_STATEMENT_DISPATCH_INTERVAL_SECONDS is not "30"/],
  ['the deprecated upgrade policy committed (O3 C3)', (v) => { v.services['rab-api'].environment.CREWFLOW_UPGRADE_FAILURE_POLICY = 'refuse'; }, /rab-api: commits the deprecated CREWFLOW_UPGRADE_FAILURE_POLICY/],
  ['a provisioner URL on the Worker', (v) => { v.services['rab-worker'].environment.CREWFLOW_PROVISIONER_DATABASE_URL = 'postgresql://crewflow:x@h/rab'; }, /rab-worker: sets CREWFLOW_PROVISIONER_DATABASE_URL/],
  ['the mode switch on the API', (v) => { v.services['rab-api'].environment.CREWFLOW_DB_MODE = 'twenty'; }, /rab-api: sets CREWFLOW_DB_MODE/],
  ['Redis evicting', (v) => { const c = v.services['rab-redis'].command; c[c.indexOf('--maxmemory-policy') + 1] = 'allkeys-lru'; }, /rab-redis: command lacks --maxmemory-policy noeviction/],
  ['Redis without the ACL file', (v) => { const c = v.services['rab-redis'].command; c.splice(c.indexOf('--aclfile'), 2); }, /rab-redis: command lacks --aclfile/],
  // The OpenShip import guard (rab-ops removal PR 2 moved it to rab-api): removed, or changed in any way, it fails.
  ['OpenShip import guard removed from rab-api', (v) => { v.services['rab-api'].volumes = v.services['rab-api'].volumes.filter((x) => !isGuard(x)); }, /rab-api: no long-form tmpfs at \/tmp .*import guard is missing/],
  ['import guard made writable (mode 1777)', (v) => { guardOf(v).tmpfs.mode = 0o1777; }, /import guard is missing or changed/],
  ['import guard made writable (mode 1777): not ignored by the production comparison', (v) => { guardOf(v).tmpfs.mode = 0o1777; }, /rab-api\.volumes differs/],
  ['import guard enlarged', (v) => { guardOf(v).tmpfs.size = String(64 * 1024 * 1024); }, /rab-api\.volumes differs/],
  ['import guard moved to another path', (v) => { guardOf(v).target = '/var/tmp'; }, /import guard is missing or changed/],
  ['import guard with an extra option', (v) => { guardOf(v).read_only = false; }, /rab-api\.volumes differs/],
  ['import guard moved to rab-worker', (v) => { const g = guardOf(v); v.services['rab-api'].volumes = v.services['rab-api'].volumes.filter((x) => x !== g); v.services['rab-worker'].volumes.push(g); }, /import guard is missing|rab-worker\.volumes differs/],
  ['a second, writable tmpfs next to the guard', (v) => { v.services['rab-api'].volumes.push({ type: 'tmpfs', target: '/srv/scratch', tmpfs: { size: '1048576' } }); }, /rab-api\.volumes differs/],
  ['a long-form tmpfs in docker-compose.production.yml (OpenShip could no longer import it)', (_v, _f, p) => { p.services['rab-api'].volumes = [{ type: 'tmpfs', target: '/tmp', tmpfs: { size: '16777216', mode: 365 } }]; }, /docker-compose\.production\.yml: rab-api has a long-form tmpfs/],
  // rab-ops removal (PR 2): the operations container and its environment stay refused (plan §2.6).
  ['a rab-ops service added back (no profile)', (v) => { v.services['rab-ops'] = structuredClone(v.services['rab-api']); }, /rab-ops: present \(removed/],
  ['a rab-ops service added back under the ops profile', (v) => { v.services['rab-ops'] = { ...structuredClone(v.services['rab-api']), profiles: ['ops'] }; }, /rab-ops: has the "ops" profile/],
  ['any service under the ops profile', (v) => { v.services['rab-tools'] = { ...structuredClone(v.services['rab-api']), profiles: ['ops'] }; }, /rab-tools: has the "ops" profile/],
  ['the API reads .env.ops', (_v, f) => { f.services['rab-api'].env_file = [{ path: '/x/.env.ops' }]; }, /rab-api: names \.env\.migrate or \.env\.ops/],
  ['Redis reads .env.ops', (_v, f) => { f.services['rab-redis'].env_file = [{ path: '/x/.env.ops' }]; }, /rab-redis: names \.env\.ops/],
  ['an ops credential (the .env.ops sentinel) reaches the Worker', (v) => { v.services['rab-worker'].environment.SOME_URL = `postgresql://crewflow_app:${SENTINEL_OPS_PW}@h:5432/rab`; }, /rab-worker: SOME_URL carries a migration\/ops credential/],
  ['a service waits for a rab-ops', (v) => { v.services['rab-worker'].depends_on['rab-ops'] = { condition: 'service_started' }; }, /rab-worker: depends on rab-ops/],
  ...RETIRED_OPS_NAMES.flatMap((k) => ['rab-api', 'rab-worker'].map((svc) => [
    `${svc} sets the retired ${k}`, (v) => { v.services[svc].environment[k] = 'one-off'; }, new RegExp(`${svc}: sets ${k}`),
  ])),
];
for (const [name, mutate, pattern] of weakenings) {
  test(`refuses: ${name}`, { skip }, () => assertRefused(problemsAfter(mutate), pattern));
}

test('environment mode: digest references from the release repository pass; tags and foreign repositories fail', () => {
  const d = (c) => `sha256:${c.repeat(64)}`;
  const ok = { services: { 'rab-api': { image: `adhin007/adolphus@${d('a')}` }, 'rab-worker': { image: `docker.io/adhin007/adolphus@${d('b')}` }, 'rab-redis': { image: `redis@${d('c')}` } } };
  assert.deepEqual(checkResolvedImages(ok).problems, []);
  const tag = { services: { 'rab-api': { image: 'adhin007/adolphus:1.0' } } };
  assert.match(checkResolvedImages(tag).problems.join(), /not repository@sha256/);
  const foreign = { services: { 'rab-api': { image: `evil/adolphus@${d('a')}` } } };
  assert.match(checkResolvedImages(foreign).problems.join(), /not an allowed release repository/);
  assert.deepEqual(checkResolvedImages(foreign, ['adhin007/adolphus', 'evil/adolphus']).problems, []);
  const built = { services: { 'rab-api': { image: `adhin007/adolphus@${d('a')}`, build: { context: '.' } } } };
  assert.match(checkResolvedImages(built).problems.join(), /build section/);
});

const { checkDeployment } = require('./verify-image-compose.cjs');
const deployed = (mutate = () => {}) => {
  const m = fresh();
  mutate(m.variantFiles);
  return checkDeployment(m.variantFiles, m.production);
};
test('environment mode: the deployed model passes, with the staging CA bind and prefix allowed', { skip }, () => {
  assert.deepEqual(deployed((v) => {
    for (const s of ['rab-api', 'rab-worker']) {
      v.services[s].volumes = [{ type: 'bind', source: '/etc/x/pg-ca.crt', target: '/run/crewflow/pg-ca.crt', read_only: true }];
      v.services[s].environment.STORAGE_KEY_PREFIX = 'staging';
    }
  }), []);
});
const deployedWeakenings = [
  ['an override switches enforce to warn', (v) => { v.services['rab-api'].environment.CREWFLOW_RUNTIME_ISOLATION = 'warn'; }, /CREWFLOW_RUNTIME_ISOLATION/],
  ['an override makes the root writable', (v) => { v.services['rab-worker'].read_only = false; }, /rab-worker\.read_only/],
  ['CREWFLOW_API_BIND=0.0.0.0', (v) => { v.services['rab-api'].ports[0].host_ip = '0.0.0.0'; }, /every interface/],
  ['a writable bind mount on the API', (v) => { v.services['rab-api'].volumes = [{ type: 'bind', source: '/srv', target: '/srv' }]; }, /rab-api\.volumes/],
  ['the CA mounted writable', (v) => { v.services['rab-api'].volumes = [{ type: 'bind', source: '/x', target: '/run/crewflow/pg-ca.crt' }]; }, /rab-api\.volumes/],
  ['HWS switched on by an override', (v) => { v.services['rab-worker'].environment.HWS_RUNTIME_ENABLED = 'true'; }, /HWS_RUNTIME_ENABLED/],
];
for (const [name, mutate, pattern] of deployedWeakenings) {
  test(`environment mode refuses: ${name}`, { skip }, () => assertRefused(deployed(mutate), pattern));
}
test('environment mode refuses a Redis without AOF, noeviction or the ACL file', { skip }, () => {
  const set = (flag, value) => (v) => { const c = v.services['rab-redis'].command; c[c.indexOf(flag) + 1] = value; };
  assertRefused(deployed(set('--aclfile', '/tmp/other.acl')), /command lacks --aclfile/);
  assertRefused(deployed(set('--maxmemory-policy', 'allkeys-lru')), /noeviction/);
  assertRefused(deployed(set('--appendonly', 'no')), /--appendonly yes/);
});

test('environment mode refuses migration/ops authority, foreign logins and unfilled templates in the runtime env files', { skip }, () => {
  const ok = { names: ['PG_DATABASE_URL', 'REDIS_URL', 'APP_SECRET'], unfilled: [], dbUsers: { PG_DATABASE_URL: 'crewflow_owner' } };
  const worker = { ...ok };
  const run = (keys, mutate = () => {}) => {
    const m = fresh();
    mutate(m.variantFiles);
    return checkDeployment(m.variantFiles, m.production, keys);
  };
  assert.deepEqual(run({ 'rab-api': ok, 'rab-worker': worker }), []);
  assertRefused(run({ 'rab-api': { ...ok, names: [...ok.names, 'CREWFLOW_MIGRATION_APPROVED'] }, 'rab-worker': worker }), /rab-api: sets CREWFLOW_MIGRATION_APPROVED/);
  assertRefused(run({ 'rab-api': ok, 'rab-worker': { ...worker, names: [...worker.names, 'DATABASE_URL'] } }), /rab-worker: sets DATABASE_URL/);
  assertRefused(run({ 'rab-api': { ...ok, dbUsers: { PG_DATABASE_URL: 'crewflow_migrator' } }, 'rab-worker': worker }), /logs in as "crewflow_migrator"/);
  assertRefused(run({ 'rab-api': { ...ok, dbUsers: { PG_DATABASE_URL: 'crewflow_app' } }, 'rab-worker': worker }), /rab-api: PG_DATABASE_URL logs in as "crewflow_app"/);
  assertRefused(run({ 'rab-api': ok, 'rab-worker': { ...worker, dbUsers: { PG_DATABASE_URL: 'crewflow_worker' } } }), /rab-worker: PG_DATABASE_URL logs in as "crewflow_worker"/);
  assertRefused(run({ 'rab-api': ok, 'rab-worker': { ...worker, names: [...worker.names, 'CREWFLOW_PROVISIONER_DATABASE_URL'] } }), /rab-worker: sets CREWFLOW_PROVISIONER_DATABASE_URL/);
  assertRefused(run({ 'rab-api': { ...ok, unfilled: ['APP_SECRET'] }, 'rab-worker': worker }), /APP_SECRET still holds a template/);
  assertRefused(run({ 'rab-api': ok, 'rab-worker': { ...worker, names: ['PG_DATABASE_URL'] } }), /rab-worker: REDIS_URL is missing/);
  assertRefused(run({ 'rab-api': ok, 'rab-worker': worker }, (v) => { v.services['rab-api'].env_file = [{ path: '/x/.env.migrate' }]; }), /rab-api: names \.env\.migrate/);
  assertRefused(run({ 'rab-api': ok, 'rab-worker': worker }, (v) => { v.services['rab-worker'].environment.CREWFLOW_MIGRATION_PHASE = 'B'; }), /rab-worker: sets CREWFLOW_MIGRATION_PHASE/);
  // rab-ops removal (PR 2): every retired ops name in an env file, and .env.ops itself, stay refused.
  for (const k of RETIRED_OPS_NAMES) {
    assertRefused(run({ 'rab-api': { ...ok, names: [...ok.names, k] }, 'rab-worker': worker }), new RegExp(`rab-api: sets ${k} in the deployed model`));
    assertRefused(run({ 'rab-api': ok, 'rab-worker': { ...worker, names: [...worker.names, k] } }), new RegExp(`rab-worker: sets ${k} in the deployed model`));
  }
  assertRefused(run({ 'rab-api': ok, 'rab-worker': worker }, (v) => { v.services['rab-worker'].env_file = [{ path: '/x/.env.ops' }]; }), /rab-worker: names \.env\.migrate or \.env\.ops in the deployed model/);
});

// Review G1: overrides on rab-redis are re-checked in the deployed model (O3: none may add a rab-migrate; rab-ops removal
// PR 2: none may add a rab-ops back).
const otherWeakenings = [
  ['rab-redis privileged', (v) => { v.services['rab-redis'].privileged = true; }, /rab-redis: privileged/],
  ['rab-redis on the host network', (v) => { v.services['rab-redis'].network_mode = 'host'; }, /rab-redis: host namespace/],
  ['rab-redis started without noeviction and the ACL', (v) => { v.services['rab-redis'].command = ['redis-server', '--appendonly', 'yes']; }, /rab-redis: command lacks --maxmemory-policy noeviction/],
  ['rab-redis without a memory limit', (v) => { delete v.services['rab-redis'].mem_limit; }, /rab-redis: no memory limit/],
  ['a bogus approval mode in the deployed model', (v) => { v.services['rab-api'].environment.CREWFLOW_MIGRATION_APPROVAL_MODE = 'off'; }, /rab-api: CREWFLOW_MIGRATION_APPROVAL_MODE is not none or token in the deployed model/],
  ['an override turns fast publish off on the Worker', (v) => { v.services['rab-worker'].environment.WORKER_FAST_PUBLISH_NOTIFY = 'false'; }, /rab-worker: WORKER_FAST_PUBLISH_NOTIFY is not "true" in the deployed model/],
  ['an override sets the API email sweep back to 2 s', (v) => { v.services['rab-api'].environment.WORKER_EMAIL_DISPATCH_INTERVAL_SECONDS = '2'; }, /rab-api: WORKER_EMAIL_DISPATCH_INTERVAL_SECONDS is not "30" in the deployed model/],
  ['an override turns the timer triggers off on the Worker', (v) => { v.services['rab-worker'].environment.WORKER_TIMER_TRIGGERS = 'off'; }, /rab-worker: WORKER_TIMER_TRIGGERS is not "on" in the deployed model/],
  ['an override sets the API offer-expiry sweep back to 60 s', (v) => { v.services['rab-api'].environment.WORKER_OFFER_EXPIRY_INTERVAL_SECONDS = '60'; }, /rab-api: WORKER_OFFER_EXPIRY_INTERVAL_SECONDS is not "300" in the deployed model/],
  ['an override sets the API pay-statement sweep back to 5 s', (v) => { v.services['rab-api'].environment.WORKER_SHIFT_STATEMENT_DISPATCH_INTERVAL_SECONDS = '5'; }, /rab-api: WORKER_SHIFT_STATEMENT_DISPATCH_INTERVAL_SECONDS is not "30" in the deployed model/],
  ['an override removes the Worker pay-statement sweep', (v) => { delete v.services['rab-worker'].environment.WORKER_SHIFT_STATEMENT_DISPATCH_INTERVAL_SECONDS; }, /rab-worker: WORKER_SHIFT_STATEMENT_DISPATCH_INTERVAL_SECONDS is not "30" in the deployed model/],
  ['an override turns the combined shift scan on', (v) => { v.services['rab-worker'].environment.WORKER_SHIFT_SCAN_MODE = 'combined'; }, /rab-worker\.environment\.WORKER_SHIFT_SCAN_MODE is overridden in the deployed model/],
  ['an override adds a rab-migrate (O3)', (v) => { v.services['rab-migrate'] = structuredClone(v.services['rab-api']); }, /rab-migrate: present in the deployed model/],
  ['rab-worker on another image (O2: one image)', (v) => { v.services['rab-worker'].image = `adhin007/adolphus@sha256:${'9'.repeat(64)}`; }, /rab-worker: image differs from rab-api's in the deployed model/],
  ['an override adds a rab-ops back', (v) => { v.services['rab-ops'] = structuredClone(v.services['rab-api']); }, /rab-ops: present in the deployed model/],
  ['an override adds a service under the ops profile', (v) => { v.services['rab-tools'] = { ...structuredClone(v.services['rab-api']), profiles: ['ops'] }; }, /rab-tools: has the "ops" profile in the deployed model/],
  ['an override makes rab-redis read .env.ops', (v) => { v.services['rab-redis'].env_file = [{ path: '/x/.env.ops' }]; }, /rab-redis: names \.env\.ops in the deployed model/],
  ['an override changes rab-api\'s import guard (mode 1777)', (v) => { v.services['rab-api'].volumes.find(isGuard).tmpfs.mode = 0o1777; }, /rab-api\.volumes differs from docker-compose\.production\.yml in the deployed model/],
  ['an extra capability on rab-redis', (v) => { v.services['rab-redis'].cap_add = ['SYS_ADMIN']; }, /rab-redis: adds devices or capabilities/],
  ['the retired launcher capabilities back on the Worker', (v) => { v.services['rab-worker'].cap_add = ['SETUID', 'SETGID', 'KILL']; }, /rab-worker: adds devices or capabilities/],
];
for (const [name, mutate, pattern] of otherWeakenings) {
  test(`environment mode refuses: ${name}`, { skip }, () => assertRefused(deployed(mutate), pattern));
}

test('environment mode accepts the operator token opt-in (compose.env), and none', { skip }, () => {
  for (const mode of ['none', 'token']) {
    const problems = deployed((v) => { v.services['rab-api'].environment.CREWFLOW_MIGRATION_APPROVAL_MODE = mode; });
    assert.ok(!problems.some((p) => /APPROVAL_MODE/.test(p)), `${mode}: ${problems.join(' | ')}`);
  }
});

// Compose-version independence (CI runs Compose v2.38, which resolves env files and drops env_file even under
// --no-env-resolution). rab-ops removal (PR 2): a REAL variant file that adds rab-ops back under its old profile, or makes
// rab-api read the retired .env.ops, must still fail (the render enables the "ops" profile so the service is not hidden).
const renderWeakened = (edit, check) => {
  const fsx = require('node:fs');
  const os = require('node:os');
  const pathx = require('node:path');
  const src = fsx.readFileSync(pathx.join(__dirname, '../docker-compose.image.yml'), 'utf8');
  const weakened = edit(src);
  assert.notEqual(weakened, src, 'the fixture edit did not apply');
  const dir = fsx.mkdtempSync(pathx.join(os.tmpdir(), 'crewflow-image-verify-test-'));
  try {
    // renderModels() renders in its own throw-away project directory, so the copy's location does not change any path.
    const copy = pathx.join(dir, 'docker-compose.image.yml');
    fsx.writeFileSync(copy, weakened);
    check(renderModels(copy));
  } finally {
    fsx.rmSync(dir, { recursive: true, force: true });
  }
};

test('a variant file that adds rab-ops back (ops profile, .env.ops) fails, statically and in the deployed model', { skip }, () => {
  renderWeakened(
    (src) => src.replace(/\nvolumes:\n/, [
      '',
      '  rab-ops:',
      '    image: ${CREWFLOW_IMAGE_REPOSITORY:-adhin007/adolphus}@${CREWFLOW_IMAGE_TAG:?digest}',
      '    profiles: ["ops"]',
      '    env_file:',
      '      - .env.ops',
      '',
      'volumes:',
      '',
    ].join('\n')),
    (m) => {
      const problems = checkVariant(m.variant, m.production, m.variantFiles);
      assertRefused(problems, /services are .*rab-ops.*; expected exactly rab-api,rab-redis,rab-worker/);
      assertRefused(problems, /rab-ops: present \(removed/);
      assertRefused(problems, /rab-ops: has the "ops" profile/);
      assertRefused(problems, /rab-ops: names \.env\.ops/);
      assertRefused(checkDeployment(m.variantFiles, m.production), /rab-ops: present in the deployed model/);
    },
  );
});

test('a variant file whose rab-api reads .env.ops fails, whatever the Compose version', { skip }, () => {
  renderWeakened(
    (src) => src.replace(/(\n  rab-api:\n[\s\S]*?\/runtime\.env\n        required: true\n)/, '$1      - path: .env.ops\n        required: true\n'),
    (m) => {
      const problems = checkVariant(m.variant, m.production, m.variantFiles);
      assertRefused(problems, /rab-api: names \.env\.migrate or \.env\.ops/);
      assertRefused(problems, /rab-api: sets CREWFLOW_OPS_RUN/);
      assertRefused(problems, /rab-api: PG_OPS_APP_DATABASE_URL carries a migration\/ops credential/);
      assertRefused(checkDeployment(m.variantFiles, m.production), /rab-api: names \.env\.migrate or \.env\.ops in the deployed model/);
    },
  );
});

// Phase X J2 (S0-J SJ-03): the push / realtime sweep rule, enforced once the feature is switched on.
test('J2 static: push on without the committed 30 s sweep is refused; with 30 s on both it passes', { skip }, () => {
  const pushOn = (v) => { for (const s of ['rab-api', 'rab-worker']) v.services[s].environment.PUSH_ENABLED = 'true'; };
  assertRefused(problemsAfter(pushOn), /rab-api: PUSH_ENABLED=true needs WORKER_PUSH_DISPATCH_INTERVAL_SECONDS="30" committed/);
  assertRefused(problemsAfter(pushOn), /rab-worker: PUSH_ENABLED=true needs WORKER_PUSH_DISPATCH_INTERVAL_SECONDS="30" committed/);
  assertRefused(problemsAfter((v) => { pushOn(v); v.services['rab-api'].environment.WORKER_PUSH_DISPATCH_INTERVAL_SECONDS = '30'; }), /rab-worker: PUSH_ENABLED=true needs/);
  assertRefused(problemsAfter((v) => { v.services['rab-api'].environment.PUSH_ENABLED = 'true'; }), /PUSH_ENABLED differs between rab-api and rab-worker/);
  assertRefused(problemsAfter((v) => { for (const s of ['rab-api', 'rab-worker']) v.services[s].environment.REALTIME_ENABLED = 'true'; v.services['rab-api'].environment.WORKER_REALTIME_OUTBOX_PUBLISH_INTERVAL_SECONDS = '5'; }), /REALTIME_ENABLED=true: WORKER_REALTIME_OUTBOX_PUBLISH_INTERVAL_SECONDS differs/);
  const ok = problemsAfter((v) => { pushOn(v); for (const s of ['rab-api', 'rab-worker']) v.services[s].environment.WORKER_PUSH_DISPATCH_INTERVAL_SECONDS = '30'; });
  assert.ok(!ok.some((p) => /PUSH_ENABLED/.test(p)), ok.join(' | '));
});

test('J2 environment mode: push switched on in runtime.env without the committed sweep is refused; an env-file interval is refused', { skip }, () => {
  const base = { names: ['PG_DATABASE_URL', 'REDIS_URL', 'APP_SECRET', 'PUSH_ENABLED'], unfilled: [], dbUsers: { PG_DATABASE_URL: 'crewflow_owner' }, switches: { PUSH_ENABLED: 'true' } };
  const run = (keys, mutate = () => {}) => {
    const m = fresh();
    mutate(m.variantFiles);
    return checkDeployment(m.variantFiles, m.production, keys);
  };
  const both = { 'rab-api': base, 'rab-worker': base };
  assertRefused(run(both), /rab-api: PUSH_ENABLED=true needs WORKER_PUSH_DISPATCH_INTERVAL_SECONDS="30" committed in the deployed model/);
  assertRefused(run(both), /rab-worker: PUSH_ENABLED=true needs WORKER_PUSH_DISPATCH_INTERVAL_SECONDS="30" committed in the deployed model/);
  // The interval entered in runtime.env instead of the compose files: refused (it must be committed on both services).
  const viaFile = { ...base, names: [...base.names, 'WORKER_PUSH_DISPATCH_INTERVAL_SECONDS'] };
  assertRefused(run({ 'rab-api': viaFile, 'rab-worker': viaFile }), /rab-api: WORKER_PUSH_DISPATCH_INTERVAL_SECONDS is set in an env file/);
  // Push on in one service's env file only.
  assertRefused(run({ 'rab-api': base, 'rab-worker': { ...base, switches: {} } }), /PUSH_ENABLED differs between rab-api and rab-worker in the deployed model/);
  // Committed 30 s on both services: the rule holds.
  const committed = run(both, (v) => { for (const s of ['rab-api', 'rab-worker']) v.services[s].environment.WORKER_PUSH_DISPATCH_INTERVAL_SECONDS = '30'; });
  assert.ok(!committed.some((p) => /PUSH_ENABLED|PUSH_DISPATCH/.test(p)), committed.join(' | '));
  // Push off: nothing to enforce.
  const off = { ...base, switches: { PUSH_ENABLED: 'false' } };
  const offProblems = run({ 'rab-api': off, 'rab-worker': off });
  assert.ok(!offProblems.some((p) => /PUSH_/.test(p)), offProblems.join(' | '));
  // Review J2-1 (fail closed): any other text, or a value Compose would read ambiguously (null), is refused.
  for (const value of ['TRUE', '1', '', 'yes', null]) {
    const bad = { ...base, switches: { PUSH_ENABLED: value } };
    assertRefused(run({ 'rab-api': bad, 'rab-worker': bad }), /rab-api: PUSH_ENABLED must be exactly true or false in the deployed model/);
  }
  // Realtime on: the interval must be identical on both (its value is not decided yet, so it is not pinned).
  const rt = { ...base, names: [...base.names, 'REALTIME_ENABLED'], switches: { REALTIME_ENABLED: 'true' } };
  assertRefused(run({ 'rab-api': rt, 'rab-worker': rt }, (v) => { v.services['rab-worker'].environment.WORKER_REALTIME_OUTBOX_PUBLISH_INTERVAL_SECONDS = '10'; }), /REALTIME_ENABLED=true: WORKER_REALTIME_OUTBOX_PUBLISH_INTERVAL_SECONDS differs between rab-api and rab-worker in the deployed model/);
  const rtSame = run({ 'rab-api': rt, 'rab-worker': rt });
  assert.ok(!rtSame.some((p) => /REALTIME/.test(p)), rtSame.join(' | '));
});

// Review of #97: J2-1 (switch values read as Compose reads them, fail closed), J2-2 (`export ` prefix), J2-3 (push interval gaps).
const { readEnvFileKeys } = require('./verify-image-compose.cjs');
const ENV_OK = 'PG_DATABASE_URL=postgresql://crewflow_owner:x@db.example:5432/crewflow?sslmode=verify-full\nREDIS_URL=redis://crewflow:x@rab-redis:6379\nAPP_SECRET=s\n';
const deployedWith = (text, mutate = () => {}) => {
  const m = fresh();
  mutate(m.variantFiles);
  const keys = { 'rab-api': readEnvFileKeys(text), 'rab-worker': readEnvFileKeys(text) };
  return checkDeployment(m.variantFiles, m.production, keys);
};
const commitPush = (value) => (v) => { for (const s of ['rab-api', 'rab-worker']) v.services[s].environment.WORKER_PUSH_DISPATCH_INTERVAL_SECONDS = value; };

test('J2-1 environment mode: a commented or quoted "true" switches push ON (as Compose gives the app); garbage is refused', { skip }, () => {
  for (const line of ['PUSH_ENABLED=true # on', 'PUSH_ENABLED="true"', "PUSH_ENABLED='true' # on", 'export PUSH_ENABLED=true']) {
    assert.equal(readEnvFileKeys(`${ENV_OK}${line}\n`).switches.PUSH_ENABLED, 'true', line);
    assertRefused(deployedWith(`${ENV_OK}${line}\n`), /rab-api: PUSH_ENABLED=true needs WORKER_PUSH_DISPATCH_INTERVAL_SECONDS="30" committed in the deployed model/);
    const ok = deployedWith(`${ENV_OK}${line}\n`, commitPush('30'));
    assert.ok(!ok.some((p) => /PUSH_/.test(p)), `${line}: ${ok.join(' | ')}`);
  }
  for (const line of ['PUSH_ENABLED=yes', 'PUSH_ENABLED=TRUE', 'PUSH_ENABLED=1', 'PUSH_ENABLED="true', 'PUSH_ENABLED="true" x', 'PUSH_ENABLED=']) {
    assertRefused(deployedWith(`${ENV_OK}${line}\n`), /rab-api: PUSH_ENABLED must be exactly true or false in the deployed model/);
  }
  const off = deployedWith(`${ENV_OK}PUSH_ENABLED=false # off\n`);
  assert.ok(!off.some((p) => /PUSH_/.test(p)), off.join(' | '));
});

test('J2-2 environment mode: `export KEY=value` lines are read (Compose accepts them), so the older name and credential checks see them too', { skip }, () => {
  const keys = readEnvFileKeys(`${ENV_OK}export DATABASE_URL=postgresql://crewflow_migrator:x@h:5432/rab\nexport PUSH_ENABLED=true\n  export   CREWFLOW_MIGRATION_APPROVED=x\n`);
  assert.ok(keys.names.includes('DATABASE_URL') && keys.names.includes('CREWFLOW_MIGRATION_APPROVED') && keys.names.includes('PUSH_ENABLED'));
  assert.equal(keys.dbUsers.DATABASE_URL, 'crewflow_migrator');
  assert.equal(keys.dbUsers.PG_DATABASE_URL, 'crewflow_owner');
  const problems = deployedWith(`${ENV_OK}export DATABASE_URL=postgresql://crewflow_migrator:x@h:5432/rab\n`);
  assertRefused(problems, /rab-api: sets DATABASE_URL in the deployed model/);
  assertRefused(deployedWith(`export PG_DATABASE_URL=postgresql://crewflow_app:x@h:5432/rab\nREDIS_URL=r\nAPP_SECRET=s\n`), /rab-api: PG_DATABASE_URL logs in as "crewflow_app"/);
  // The unchanged cases still behave: comments are skipped, a placeholder is reported, a non-URL database value is reported.
  const plain = readEnvFileKeys('# PUSH_ENABLED=true\nAPP_SECRET=<fill me>\nPG_DATABASE_URL=not-a-url\n');
  assert.deepEqual(plain.names, ['APP_SECRET', 'PG_DATABASE_URL']);
  assert.deepEqual(plain.switches, {});
  assert.deepEqual(plain.unfilled, ['APP_SECRET', 'PG_DATABASE_URL (not a URL)']);
});

test('J2-3: with push on the verifier refuses a 2 s push sweep on either service and two different values', { skip }, () => {
  const pushOn = (v) => { for (const s of ['rab-api', 'rab-worker']) v.services[s].environment.PUSH_ENABLED = 'true'; };
  const set = (api, worker) => (v) => {
    v.services['rab-api'].environment.WORKER_PUSH_DISPATCH_INTERVAL_SECONDS = api;
    v.services['rab-worker'].environment.WORKER_PUSH_DISPATCH_INTERVAL_SECONDS = worker;
  };
  // Static mode.
  assertRefused(problemsAfter((v) => { pushOn(v); set('2', '30')(v); }), /rab-api: PUSH_ENABLED=true needs WORKER_PUSH_DISPATCH_INTERVAL_SECONDS="30"/);
  assertRefused(problemsAfter((v) => { pushOn(v); set('30', '2')(v); }), /rab-worker: PUSH_ENABLED=true needs WORKER_PUSH_DISPATCH_INTERVAL_SECONDS="30"/);
  assertRefused(problemsAfter((v) => { pushOn(v); set('2', '2')(v); }), /rab-api: PUSH_ENABLED=true needs WORKER_PUSH_DISPATCH_INTERVAL_SECONDS="30"/);
  const differ = problemsAfter((v) => { pushOn(v); set('30', '60')(v); });
  assertRefused(differ, /rab-worker: PUSH_ENABLED=true needs WORKER_PUSH_DISPATCH_INTERVAL_SECONDS="30"/);
  // Environment mode (push switched on in the env files).
  const on = `${ENV_OK}PUSH_ENABLED=true\n`;
  assertRefused(deployedWith(on, set('2', '30')), /rab-api: PUSH_ENABLED=true needs WORKER_PUSH_DISPATCH_INTERVAL_SECONDS="30" committed in the deployed model/);
  assertRefused(deployedWith(on, set('30', '2')), /rab-worker: PUSH_ENABLED=true needs WORKER_PUSH_DISPATCH_INTERVAL_SECONDS="30" committed in the deployed model/);
  assertRefused(deployedWith(on, set('30', '60')), /rab-worker: PUSH_ENABLED=true needs WORKER_PUSH_DISPATCH_INTERVAL_SECONDS="30" committed in the deployed model/);
  const ok = deployedWith(on, set('30', '30'));
  assert.ok(!ok.some((p) => /PUSH_/.test(p)), ok.join(' | '));
});
