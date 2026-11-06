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

const { checkVariant, checkResolvedImages, renderModels, SENTINEL_MIGRATOR_PW, RUNTIME_KEYS } = require('./verify-image-compose.cjs');

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
  mutate(m.variant, m.variantFiles);
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
    // The read-only PostgreSQL CA bind (image file only) is the one intended difference.
    const noCa = (vols) => {
      const rest = (vols ?? []).filter((v) => !(v.type === 'bind' && v.target === '/run/crewflow/pg-ca.crt' && v.read_only === true));
      return rest.length ? rest : undefined;
    };
    for (const key of RUNTIME_KEYS) {
      const a = key === 'volumes' ? noCa(m.variant.services[svc][key]) : m.variant.services[svc][key];
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
  ['a release step brought back (O3)', (v) => { v.services['rab-migrate'] = structuredClone(v.services['rab-ops']); delete v.services['rab-migrate'].profiles; }, /rab-migrate: present/],
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
  ['the deprecated upgrade policy committed (O3 C3)', (v) => { v.services['rab-api'].environment.CREWFLOW_UPGRADE_FAILURE_POLICY = 'refuse'; }, /rab-api: commits the deprecated CREWFLOW_UPGRADE_FAILURE_POLICY/],
  ['a provisioner URL on the Worker', (v) => { v.services['rab-worker'].environment.CREWFLOW_PROVISIONER_DATABASE_URL = 'postgresql://crewflow:x@h/rab'; }, /rab-worker: sets CREWFLOW_PROVISIONER_DATABASE_URL/],
  ['the mode switch on the API', (v) => { v.services['rab-api'].environment.CREWFLOW_DB_MODE = 'twenty'; }, /rab-api: sets CREWFLOW_DB_MODE/],
  ['Redis evicting', (v) => { const c = v.services['rab-redis'].command; c[c.indexOf('--maxmemory-policy') + 1] = 'allkeys-lru'; }, /rab-redis: command lacks --maxmemory-policy noeviction/],
  ['Redis without the ACL file', (v) => { const c = v.services['rab-redis'].command; c.splice(c.indexOf('--aclfile'), 2); }, /rab-redis: command lacks --aclfile/],
  ['OpenShip import guard removed', (v) => { v.services['rab-ops'].volumes = []; }, /OpenShip import guard is missing/],
  ['rab-ops started by up', (v) => { delete v.services['rab-ops'].profiles; }, /rab-ops: not in \(only\) the "ops" profile/],
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
});

// Review G1: overrides on rab-redis and rab-ops are re-checked in the deployed model (O3: and none may add a rab-migrate).
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
  ['an override turns the combined shift scan on', (v) => { v.services['rab-worker'].environment.WORKER_SHIFT_SCAN_MODE = 'combined'; }, /rab-worker\.environment\.WORKER_SHIFT_SCAN_MODE is overridden in the deployed model/],
  ['an override adds a rab-migrate (O3)', (v) => { v.services['rab-migrate'] = structuredClone(v.services['rab-ops']); delete v.services['rab-migrate'].profiles; }, /rab-migrate: present in the deployed model/],
  ['rab-worker on another image (O2: one image)', (v) => { v.services['rab-worker'].image = `adhin007/adolphus@sha256:${'9'.repeat(64)}`; }, /rab-worker: image differs from rab-api's in the deployed model/],
  ['rab-ops without its profile', (v) => { delete v.services['rab-ops'].profiles; }, /rab-ops: not in \(only\) the "ops" profile/],
  ['rab-ops with a writable root', (v) => { v.services['rab-ops'].read_only = false; }, /rab-ops: not read-only/],
  ['rab-ops privileged', (v) => { v.services['rab-ops'].privileged = true; }, /rab-ops: privileged/],
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
// --no-env-resolution). A REAL variant file in which rab-ops no longer reads its env file must still fail.
test('a variant file whose rab-ops reads no env file fails, whatever the Compose version', { skip }, () => {
  const fsx = require('node:fs');
  const os = require('node:os');
  const pathx = require('node:path');
  const src = fsx.readFileSync(pathx.join(__dirname, '../docker-compose.image.yml'), 'utf8');
  const weakened = src.replace(/\n    env_file:\n      - \.env\.ops\n/, '\n');
  assert.notEqual(weakened, src, 'the fixture edit did not apply');
  const dir = fsx.mkdtempSync(pathx.join(os.tmpdir(), 'crewflow-image-verify-test-'));
  try {
    // renderModels() renders in its own throw-away project directory, so the copy's location does not change any path.
    const copy = pathx.join(dir, 'docker-compose.image.yml');
    fsx.writeFileSync(copy, weakened);
    try {
      const m = renderModels(copy);
      const problems = checkVariant(m.variant, m.production, m.variantFiles);
      assertRefused(problems, /rab-ops: must read \.env\.ops only/);
      assertRefused(checkDeployment(m.variantFiles, m.production), /rab-ops: must read \.env\.ops only in the deployed model/);
    } finally {
      fsx.rmSync(copy, { force: true });
    }
  } finally {
    fsx.rmSync(dir, { recursive: true, force: true });
  }
});
