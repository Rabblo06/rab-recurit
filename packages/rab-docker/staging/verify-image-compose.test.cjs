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

const { checkVariant, checkResolvedImages, renderModels, SENTINEL_MIGRATOR_PW, SENTINEL_OPS_PW, SENTINEL_OWNER_PW, RUNTIME_KEYS } = require('./verify-image-compose.cjs');

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
  ['a strict switch committed as a typo (X3.1)', (v) => { v.services['rab-worker'].environment.WORKER_FAST_PUBLISH_NOTIFY = 'True'; }, /rab-worker: WORKER_FAST_PUBLISH_NOTIFY must be exactly true or false/],
  ['Redis ACL mount removed', (v) => { v.services['rab-redis'].volumes = v.services['rab-redis'].volumes.filter((x) => !/acl/.test(x.target)); }, /ACL file not mounted/],
  ['migration credential reaches the API', (v) => { v.services['rab-api'].environment.PG_DATABASE_URL = `postgresql://crewflow_migrator:${SENTINEL_MIGRATOR_PW}@h:5432/rab`; }, /rab-api: PG_DATABASE_URL carries a migration\/ops credential/],
  // Owner decision 2026-11-18 (Twenty's way): one crewflow_owner PG_DATABASE_URL on db-setup, rab-api and rab-worker.
  ["an env file's PG_DATABASE_URL wins on the API", (v) => { v.services['rab-api'].environment.PG_DATABASE_URL = `postgresql://crewflow_owner:${SENTINEL_OWNER_PW}@db-direct.example:5432/rab?sslmode=verify-full`; }, /rab-api: PG_DATABASE_URL carries a value from an env file's PG_DATABASE_URL/],
  ["an admin URL as the Worker's PG_DATABASE_URL", (v) => { v.services['rab-worker'].environment.PG_DATABASE_URL = 'postgresql://postgres:x@db:5432/crewflow?sslmode=verify-full'; }, /rab-worker: PG_DATABASE_URL does not log in as crewflow_owner/],
  ['the API on another crewflow_owner URL than db-setup', (v) => { v.services['rab-api'].environment.PG_DATABASE_URL = 'postgresql://crewflow_owner:x@other:5432/crewflow?sslmode=verify-full'; }, /rab-api: PG_DATABASE_URL differs from db-setup's/],
  ['the Worker without PG_DATABASE_URL', (v) => { delete v.services['rab-worker'].environment.PG_DATABASE_URL; }, /rab-worker: PG_DATABASE_URL is not set in its environment/],
  ['db-setup with an admin URL as PG_DATABASE_URL', (v) => { v.services['db-setup'].environment.PG_DATABASE_URL = 'postgresql://postgres:x@db:5432/crewflow?sslmode=verify-full'; }, /db-setup: PG_DATABASE_URL does not log in as crewflow_owner/],
  ['the app password as a container variable', (v) => { v.services['rab-api'].environment.PG_DATABASE_APP_PASSWORD = 'x'; }, /rab-api: has PG_DATABASE_APP_PASSWORD/],
  ['the retired setup volume mounted on the Worker', (v) => { v.services['rab-worker'].volumes.push({ type: 'volume', source: 'crewflow-db-target', target: '/run/crewflow/db-target', read_only: true }); }, /rab-worker: mounts crewflow-db-target at \/run\/crewflow\/db-target/],
  ['something at the retired setup path on db-setup', (v) => { v.services['db-setup'].volumes.push({ type: 'bind', source: '/srv/x', target: '/run/crewflow/db-target/owner-password', read_only: true }); }, /db-setup: mounts something at \/run\/crewflow\/db-target\/owner-password/],
  ['a second postgres:// value on the API', (v) => { v.services['rab-api'].labels = { x: 'postgresql://crewflow_owner:x@db:5432/crewflow' }; }, /rab-api: holds a postgres:\/\/ value outside PG_DATABASE_URL/],
  ['migration approval on the Worker', (v) => { v.services['rab-worker'].environment.CREWFLOW_MIGRATION_APPROVED = 'pending-1-x'; }, /rab-worker: sets CREWFLOW_MIGRATION_APPROVED/],
  ['API reads .env.migrate', (_v, f) => { f.services['rab-api'].env_file = [{ path: '/x/.env.migrate' }]; }, /rab-api: names \.env\.migrate/],
  // Owner instruction 2026-11-18 (Twenty's Helm wait-for-db): db-setup waits for the database itself; nothing depends on db.
  ['db-setup depends on db again', (v) => { v.services['db-setup'].depends_on = { db: { condition: 'service_healthy', required: true } }; }, /db-setup: has depends_on \(db\)/],
  ['db-setup and production both depend on db again', (v, _f, p) => { for (const m of [v, p]) m.services['db-setup'].depends_on = { db: { condition: 'service_healthy', required: true } }; }, /db-setup: has depends_on \(db\)/],
  ['rab-api depends on db again', (v) => { v.services['rab-api'].depends_on.db = { condition: 'service_healthy', required: true }; }, /rab-api: depends on db/],
  ['db-setup started directly, without the wait', (v) => { v.services['db-setup'].entrypoint = ['./db-setup.sh']; }, /db-setup: must start through the wait-for-db wrapper/],
  ['the wait block edited in the compose wrapper', (v) => { v.services['db-setup'].entrypoint = v.services['db-setup'].entrypoint.map((x) => String(x).replace('"57P03"', '"57P04"')); }, /db-setup: entrypoint is neither exactly \.\/db-setup\.sh nor exactly the wait-for-db wrapper/],
  ['the wait bound changed in one file', (v) => { v.services['db-setup'].environment.CREWFLOW_DB_WAIT_SECONDS = '30'; }, /db-setup: CREWFLOW_DB_WAIT_SECONDS is not the committed|db-setup\.environment\.CREWFLOW_DB_WAIT_SECONDS differs/],
  ['the API waits for a rab-migrate again', (v) => { v.services['rab-api'].depends_on['rab-migrate'] = { condition: 'service_completed_successfully' }; }, /rab-api: depends on rab-migrate|rab-api\.depends_on differs/],
  ['API no longer migrates on start (O3 C1)', (v) => { v.services['rab-api'].environment.CREWFLOW_MIGRATE_ON_START = 'false'; }, /rab-api: CREWFLOW_MIGRATE_ON_START is not "true"/],
  ['a bogus approval mode', (v) => { v.services['rab-api'].environment.CREWFLOW_MIGRATION_APPROVAL_MODE = 'off'; }, /rab-api: CREWFLOW_MIGRATION_APPROVAL_MODE is not none or token/],
  // Owner decision 2026-11-20: AI is operator-set, default OFF (both files commit ${AI_ENABLED:-false}).
  ['AI pinned on in the variant', (v) => { v.services['rab-api'].environment.AI_ENABLED = 'true'; }, /rab-api: AI_ENABLED is not "false" when compose\.env does not set it/],
  ['AI pinned on in both files', (v, _f, p) => { for (const m of [v, p]) m.services['rab-worker'].environment.AI_ENABLED = 'true'; }, /rab-worker: AI_ENABLED is not "false" when compose\.env does not set it/],
  ['AI_ENABLED removed from the Worker', (v) => { delete v.services['rab-worker'].environment.AI_ENABLED; }, /rab-worker: AI_ENABLED is not "false"|rab-worker\.environment\.AI_ENABLED differs/],
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
  ['the removed upgrade policy committed (Part B3)', (v) => { v.services['rab-api'].environment.CREWFLOW_UPGRADE_FAILURE_POLICY = 'refuse'; }, /rab-api: commits the removed CREWFLOW_UPGRADE_FAILURE_POLICY/],
  ['the removed upgrade-failure choice committed (Part B3)', (v) => { v.services['rab-worker'].environment.CREWFLOW_UPGRADE_FAILURE = 'continue'; }, /rab-worker: commits the removed CREWFLOW_UPGRADE_FAILURE/],
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
      v.services[s].volumes = [
        { type: 'volume', source: 'crewflow-db-ca', target: '/run/crewflow/db-ca', read_only: true, volume: {} },
        { type: 'bind', source: '/etc/x/pg-ca.crt', target: '/run/crewflow/pg-ca.crt', read_only: true },
      ];
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

// CREWFLOW_BUNDLED_DB (Twenty's Helm db.enabled): the preflight accepts db with 0 replicas only for your own database.
const EXTERNAL_ADMIN_URL = 'postgresql://doadmin:not-a-secret@db-direct.example.com:5432/crewflow?sslmode=verify-full'; // gitleaks:allow
// #189 review: the env_file probe looked at the removed rab-migrate, so --environment refused on every Compose before
// checking anything. It must report env_file for the services that declare one in the committed file.
test('environment mode: the env_file probe sees the committed env files (rab-api, rab-worker, db-setup)', { skip }, () => {
  assert.equal(fresh().composeReportsEnvFiles, true);
});
const EXTERNAL_OWNER_URL = 'postgresql://crewflow_owner:not-a-secret@db-direct.example.com:5432/crewflow?sslmode=verify-full'; // gitleaks:allow
const NO_PASSWORD_BUNDLED_URL = 'postgresql://postgres:@db:5432/crewflow?sslmode=verify-full';
/**
 * The deployed db-setup / db / app services as compose renders them for a compose.env (owner decision 2026-11-18):
 * `replicas` = CREWFLOW_BUNDLED_DB; `admin` = PG_ADMIN_URL (db-setup only); `app` = PG_DATABASE_URL, which compose renders
 * identically on db-setup, rab-api and rab-worker (unset: the bundled crewflow_owner URL); `password: false` = no
 * PG_DATABASE_PASSWORD (modes b and c: db's POSTGRES_PASSWORD and the bundled superuser URL's password render empty).
 */
const bundledDb = (replicas, { admin, app, password = true } = {}) => (v) => {
  v.services.db.deploy = { ...v.services.db.deploy, replicas };
  // db-harden (owner decision 2026-11-18, M1) renders db-setup's database settings from the same compose.env variables.
  for (const admin_ of ['db-setup', 'db-harden']) {
    const e = v.services[admin_].environment;
    e.CREWFLOW_BUNDLED_DB = String(replicas);
    if (admin !== undefined) e.PG_ADMIN_URL = admin;
    if (!password) e.CREWFLOW_BUNDLED_DB_ADMIN_URL = NO_PASSWORD_BUNDLED_URL;
  }
  if (app !== undefined) for (const n of ['db-setup', 'db-harden', 'rab-api', 'rab-worker']) v.services[n].environment.PG_DATABASE_URL = app;
  if (!password) v.services.db.environment.POSTGRES_PASSWORD = '';
};
test('environment mode (owner decision 2026-11-18): the three modes pass (a bundled; b CREWFLOW_BUNDLED_DB=0 + PG_ADMIN_URL + PG_DATABASE_URL; c CREWFLOW_BUNDLED_DB=0 + PG_DATABASE_URL), b and c without PG_DATABASE_PASSWORD', { skip }, () => {
  const m = fresh();
  const e = m.variantFiles.services['db-setup'].environment;
  assert.equal(String(e.CREWFLOW_BUNDLED_DB_ADMIN_URL).includes('@db:5432/'), true);
  assert.equal(e.PG_ADMIN_URL, '');
  // PG_DATABASE_URL unset: the bundled crewflow_owner URL, built from PG_DATABASE_APP_PASSWORD, the SAME on all three.
  assert.match(String(e.PG_DATABASE_URL), /^postgresql:\/\/crewflow_owner:[^@]+@db:5432\/crewflow\?sslmode=verify-full$/);
  for (const n of ['rab-api', 'rab-worker']) assert.equal(m.variantFiles.services[n].environment.PG_DATABASE_URL, e.PG_DATABASE_URL);
  assert.deepEqual(deployed(bundledDb(1)), []);
  assert.deepEqual(deployed(bundledDb(0, { admin: EXTERNAL_ADMIN_URL, app: EXTERNAL_OWNER_URL, password: false })), []);
  assert.deepEqual(deployed(bundledDb(0, { app: EXTERNAL_OWNER_URL, password: false })), []);
  // The bundled db running beside your own database's admin + crewflow_owner URLs (the upgrade path) stays accepted.
  assert.deepEqual(deployed(bundledDb(1, { admin: EXTERNAL_ADMIN_URL, app: EXTERNAL_OWNER_URL })), []);
});
test('DENIAL environment mode (owner decision 2026-11-18): password rules, an admin URL in PG_DATABASE_URL, crewflow_owner in PG_ADMIN_URL, two databases, an empty crewflow_owner password', { skip }, () => {
  assertRefused(deployed(bundledDb(1, { password: false })), /db-setup: PG_DATABASE_PASSWORD: required for the bundled database/);
  assertRefused(deployed(bundledDb(1, { password: false })), /db: POSTGRES_PASSWORD is missing/);
  assertRefused(deployed(bundledDb(0, { admin: EXTERNAL_ADMIN_URL, app: EXTERNAL_OWNER_URL })), /db-setup: PG_DATABASE_PASSWORD: remove it with CREWFLOW_BUNDLED_DB=0/);
  // Own database, admin URL given, PG_DATABASE_URL left on the bundled default: two databases, and the bundled host.
  assertRefused(deployed(bundledDb(0, { admin: EXTERNAL_ADMIN_URL, password: false })), /db-setup: PG_ADMIN_URL and PG_DATABASE_URL name different databases/);
  assertRefused(deployed(bundledDb(0, { admin: EXTERNAL_ADMIN_URL, password: false })), /db-setup: CREWFLOW_BUNDLED_DB: 0 \(no bundled db\), but PG_DATABASE_URL names the bundled host db/);
  assertRefused(deployed(bundledDb(0, { app: EXTERNAL_ADMIN_URL, password: false })), /db-setup: PG_DATABASE_URL: is the app login and must log in as crewflow_owner/);
  assertRefused(deployed(bundledDb(0, { app: EXTERNAL_ADMIN_URL, password: false })), /rab-api: PG_DATABASE_URL does not log in as crewflow_owner in the deployed model/);
  assertRefused(deployed(bundledDb(0, { admin: EXTERNAL_OWNER_URL, app: EXTERNAL_OWNER_URL, password: false })), /db-setup: PG_ADMIN_URL: logs in as crewflow_owner/);
  assertRefused(deployed(bundledDb(1, { app: EXTERNAL_ADMIN_URL })), /db-setup: PG_DATABASE_URL: is the app login/);
  // PG_DATABASE_APP_PASSWORD unset for the bundled db: the rendered crewflow_owner URL has an empty password.
  assertRefused(deployed(bundledDb(1, { app: 'postgresql://crewflow_owner:@db:5432/crewflow?sslmode=verify-full' })), /db-setup: PG_DATABASE_URL: has no password/);
  assertRefused(deployed((v) => { v.services['db-setup'].environment.CREWFLOW_BUNDLED_DB = '0'; }), /db-setup: CREWFLOW_BUNDLED_DB differs from db's replica count/);
  for (const key of ['PG_ADMIN_URL', 'PG_DATABASE_URL', 'CREWFLOW_BUNDLED_DB', 'CREWFLOW_BUNDLED_DB_ADMIN_URL']) {
    assertRefused(deployed((v) => { delete v.services['db-setup'].environment[key]; }), new RegExp(`db-setup: ${key} is missing in the deployed model`));
  }
  // rab-api / rab-worker: PG_ADMIN_URL in their definition (any value) or from their env files is refused; so is
  // PG_DATABASE_APP_PASSWORD (a compose interpolation value only), committed or from an env file.
  for (const svc of ['rab-api', 'rab-worker']) {
    // Owner decision L-2: pinned "" (passes, as committed); any value is refused, and so is a missing pin.
    assert.equal(fresh().variantFiles.services[svc].environment.PG_ADMIN_URL, '');
    for (const value of [EXTERNAL_ADMIN_URL, 'x']) assertRefused(deployed((v) => { v.services[svc].environment.PG_ADMIN_URL = value; }), new RegExp(`${svc}: has PG_ADMIN_URL with a value in the deployed model`));
    assertRefused(deployed((v) => { delete v.services[svc].environment.PG_ADMIN_URL; }), new RegExp(`${svc}: PG_ADMIN_URL is not pinned to "" in the deployed model`));
    assertRefused(deployed((v) => { v.services[svc].environment.PG_DATABASE_APP_PASSWORD = 'x'; }), new RegExp(`${svc}: has PG_DATABASE_APP_PASSWORD in the deployed model`));
    const ok = { names: ['REDIS_URL', 'APP_SECRET'], unfilled: [], dbUsers: {} };
    const m = fresh();
    const keys = { 'rab-api': ok, 'rab-worker': ok, [svc]: { ...ok, names: [...ok.names, 'PG_ADMIN_URL'] } };
    assertRefused(checkDeployment(m.variantFiles, m.production, keys), new RegExp(`${svc}: PG_ADMIN_URL is set in an env file`));
    const keys2 = { 'rab-api': ok, 'rab-worker': ok, [svc]: { ...ok, names: [...ok.names, 'PG_DATABASE_APP_PASSWORD'] } };
    assertRefused(checkDeployment(m.variantFiles, m.production, keys2), new RegExp(`${svc}: PG_DATABASE_APP_PASSWORD reaches the container`));
  }
  const ok = { names: ['REDIS_URL', 'APP_SECRET'], unfilled: [], dbUsers: {} };
  const m = fresh();
  assertRefused(checkDeployment(m.variantFiles, m.production, { 'rab-api': ok, 'rab-worker': ok, 'db-setup': { ...ok, names: ['PG_DATABASE_APP_PASSWORD'] } }), /db-setup: PG_DATABASE_APP_PASSWORD reaches the container from an env file/);
  assertRefused(deployed((v) => { v.services['db-setup'].environment.PG_DATABASE_APP_PASSWORD = 'x'; }), /db-setup: has PG_DATABASE_APP_PASSWORD in the deployed model/);
});
test('environment mode refuses: db with 0 replicas while PG_DATABASE_URL still names the bundled db; 2 replicas; deploy.resources; scale', { skip }, () => {
  const msg = /db\.deploy\.replicas is (0|2) \(only 1, or 0 with your own database in PG_DATABASE_URL and any PG_ADMIN_URL\)/;
  assertRefused(deployed(bundledDb(0, { password: false })), msg);
  assertRefused(deployed(bundledDb(0, { admin: 'postgresql://postgres:not-a-secret@db:5432/crewflow?sslmode=verify-full', password: false })), msg); // gitleaks:allow
  assertRefused(deployed(bundledDb(0, { admin: EXTERNAL_ADMIN_URL, password: false })), msg);
  assertRefused(deployed(bundledDb(2, { admin: EXTERNAL_ADMIN_URL, app: EXTERNAL_OWNER_URL })), msg);
  assertRefused(deployed(bundledDb(0, { admin: 'not a url', password: false })), msg);
  assertRefused(deployed((v) => { v.services.db.deploy = { ...v.services.db.deploy, resources: { limits: { memory: '64g' } } }; }), /db\.deploy is overridden in the deployed model/);
  assertRefused(deployed((v) => { v.services.db.scale = 2; }), /db\.scale is overridden in the deployed model/);
});
test('environment mode refuses a Redis without AOF, noeviction or the ACL file', { skip }, () => {
  const set = (flag, value) => (v) => { const c = v.services['rab-redis'].command; c[c.indexOf(flag) + 1] = value; };
  assertRefused(deployed(set('--aclfile', '/tmp/other.acl')), /command lacks --aclfile/);
  assertRefused(deployed(set('--maxmemory-policy', 'allkeys-lru')), /noeviction/);
  assertRefused(deployed(set('--appendonly', 'no')), /--appendonly yes/);
});

test('environment mode refuses migration/ops authority, foreign logins and unfilled templates in the runtime env files', { skip }, () => {
  // DB-SETUP: PG_DATABASE_URL is a compose.env value now; the env files carry REDIS_URL and the runtime settings.
  const ok = { names: ['REDIS_URL', 'APP_SECRET'], unfilled: [], dbUsers: {} };
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
  // Owner decision 2026-11-20: AI_ENABLED in an env file would be silently overridden by the committed expression.
  assertRefused(run({ 'rab-api': ok, 'rab-worker': { ...worker, names: [...worker.names, 'AI_ENABLED'] } }), /rab-worker: AI_ENABLED is set in an env file \(set it in compose\.env/);
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
  ['a strict switch overridden with a typo in the deployed model (X3.1)', (v) => { v.services['rab-api'].environment.AUTH_MFA_ENFORCE_PLATFORM_ADMIN = 'yes'; }, /rab-api: AUTH_MFA_ENFORCE_PLATFORM_ADMIN must be exactly true or false.* in the deployed model/],
  ['a bogus approval mode in the deployed model', (v) => { v.services['rab-api'].environment.CREWFLOW_MIGRATION_APPROVAL_MODE = 'off'; }, /rab-api: CREWFLOW_MIGRATION_APPROVAL_MODE is not none or token in the deployed model/],
  // Owner decision 2026-11-20: the operator's AI switch, exactly true or false and the same on both services.
  ['AI switched on for the API only', (v) => { v.services['rab-api'].environment.AI_ENABLED = 'true'; }, /AI_ENABLED differs between rab-api and rab-worker in the deployed model/],
  ['AI switched on for the Worker only', (v) => { v.services['rab-worker'].environment.AI_ENABLED = 'true'; }, /AI_ENABLED differs between rab-api and rab-worker in the deployed model/],
  ['a bogus AI switch on both', (v) => { for (const n of ['rab-api', 'rab-worker']) v.services[n].environment.AI_ENABLED = 'yes'; }, /rab-api: AI_ENABLED is not exactly true or false in the deployed model/],
  ['AI_ENABLED removed by an override', (v) => { for (const n of ['rab-api', 'rab-worker']) delete v.services[n].environment.AI_ENABLED; }, /rab-worker: AI_ENABLED is not exactly true or false in the deployed model/],
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

test('environment mode accepts the operator AI switch (compose.env, owner decision 2026-11-20): true or false on both services', { skip }, () => {
  for (const value of ['true', 'false']) {
    const problems = deployed((v) => { for (const n of ['rab-api', 'rab-worker']) v.services[n].environment.AI_ENABLED = value; });
    assert.ok(!problems.some((p) => /AI_ENABLED/.test(p)), `${value}: ${problems.join(' | ')}`);
  }
});

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

// Security review of PR #124 (MEDIUM): a re-added operations container under ANOTHER name and profile (`rab-maint`,
// `profiles: ["maint"]`, reading .env.ops) passed every gate. Every profile is now rendered and any profile is refused, in
// the variant, in the deployed model and in docker-compose.production.yml (the reference model, the file OpenShip imports).
const addMaint = (src) => src.replace(/\nnetworks:\n/, [
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

test('DENIAL (rendered): docker-compose.image.yml with a "maint"-profile service reading .env.ops fails', { skip }, () => {
  renderWeakened(addMaint, (m) => {
    const problems = checkVariant(m.variant, m.production, m.variantFiles);
    assertRefused(problems, /services are .*rab-maint.*; expected exactly db,db-harden,db-setup,rab-api,rab-redis,rab-worker/);
    assertRefused(problems, /rab-maint: has profiles \["maint"\]/);
    assertRefused(problems, /rab-maint: carries a value of the retired \.env\.ops/);
    assertRefused(problems, /rab-maint: sets the retired CREWFLOW_OPS_RUN/);
    assertRefused(checkDeployment(m.variantFiles, m.production), /rab-maint: has profiles \["maint"\] in the deployed model/);
  });
});

test('DENIAL (rendered): docker-compose.production.yml with a "maint"-profile service reading .env.ops fails', { skip }, () => {
  const fsx = require('node:fs');
  const os = require('node:os');
  const pathx = require('node:path');
  const src = fsx.readFileSync(pathx.join(__dirname, '../docker-compose.production.yml'), 'utf8');
  const weakened = addMaint(src);
  assert.notEqual(weakened, src, 'the fixture edit did not apply');
  const dir = fsx.mkdtempSync(pathx.join(os.tmpdir(), 'crewflow-image-verify-prod-'));
  try {
    const copy = pathx.join(dir, 'docker-compose.production.yml');
    fsx.writeFileSync(copy, weakened);
    const m = renderModels(undefined, copy);
    const problems = checkVariant(m.variant, m.production, m.variantFiles);
    assertRefused(problems, /rab-maint: has profiles \["maint"\] in docker-compose\.production\.yml/);
    assertRefused(problems, /rab-maint: carries a value of the retired \.env\.ops in docker-compose\.production\.yml/);
    assertRefused(problems, /rab-maint: sets the retired CREWFLOW_OPS_RUN.* in docker-compose\.production\.yml/);
  } finally {
    fsx.rmSync(dir, { recursive: true, force: true });
  }
});

test('DENIAL: a profile-gated service under any name, in the variant, production.yml and the deployed model', { skip }, () => {
  assertRefused(problemsAfter((v) => { v.services['rab-maint'] = { ...structuredClone(v.services['rab-redis']), profiles: ['maint'] }; }), /rab-maint: has profiles/);
  assertRefused(problemsAfter((_v, _f, p) => { p.services['rab-maint'] = { image: 'x', profiles: ['maint'] }; }), /rab-maint: has profiles \["maint"\] in docker-compose\.production\.yml/);
  assertRefused(problemsAfter((_v, _f, p) => { p.services['rab-api'].environment.CREWFLOW_OPS_RUN = 'one-off'; }), /rab-api: sets the retired CREWFLOW_OPS_RUN in docker-compose\.production\.yml/);
  assertRefused(deployed((v) => { v.services['rab-maint'] = { ...structuredClone(v.services['rab-redis']), profiles: ['maint'] }; }), /rab-maint: has profiles \["maint"\] in the deployed model/);
});

test('a variant file that adds rab-ops back (ops profile, .env.ops) fails, statically and in the deployed model', { skip }, () => {
  renderWeakened(
    // The first top-level key after `services:` (DB-SETUP added `networks:` before `volumes:`).
    (src) => src.replace(/\nnetworks:\n/, [
      '',
      '  rab-ops:',
      '    image: ${CREWFLOW_IMAGE_REPOSITORY:-adhin007/adolphus}@${CREWFLOW_IMAGE_TAG:?digest}',
      '    profiles: ["ops"]',
      '    env_file:',
      '      - .env.ops',
      '',
      'networks:',
      '',
    ].join('\n')),
    (m) => {
      const problems = checkVariant(m.variant, m.production, m.variantFiles);
      assertRefused(problems, /services are .*rab-ops.*; expected exactly db,db-harden,db-setup,rab-api,rab-redis,rab-worker/);
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

// DB-SETUP (owner decisions D1 a / D3 / D4 / D5, T-1 / T-2 / T-5).
test('DENIAL DB-SETUP static: the bundled db must be identical in both files, unpublished, internal; the Worker runs worker-start.sh', { skip }, () => {
  for (const [label, mutate, pattern] of [
    ['db missing in the variant', (v) => { delete v.services.db; }, /services are .*expected exactly db,db-harden,db-setup,rab-api,rab-redis,rab-worker|db: missing in the variant/],
    ['db read-only root dropped', (v) => { v.services.db.read_only = false; }, /db\.read_only differs from docker-compose\.production\.yml/],
    ['db published', (v) => { v.services.db.ports = [{ target: 5432, host_ip: '127.0.0.1', published: '5432' }]; }, /db: publishes a port|db\.ports differs/],
    ['db password from somewhere else', (v) => { v.services.db.environment.POSTGRES_PASSWORD = 'postgres'; }, /db\.environment differs/],
    ['db trust auth', (v) => { v.services.db.environment.POSTGRES_HOST_AUTH_METHOD = 'trust'; }, /db\.environment differs/],
    ['db TLS off', (v) => { v.services.db.command = ['postgres']; }, /db\.command differs/],
    ['db certificate step removed', (v) => { delete v.services.db.entrypoint; }, /db\.entrypoint differs/],
    ['db on the default network', (v) => { v.services.db.networks = { default: null, 'crewflow-db': null }; }, /db: must be on the internal crewflow-db network only|db\.networks differs/],
    ['db network not internal', (v) => { v.networks['crewflow-db'].internal = false; }, /crewflow-db is not internal/],
    ['db image by another digest', (v) => { v.services.db.image = `postgres@sha256:${'0'.repeat(64)}`; }, /db\.image differs/],
    ['db replica count differs (CREWFLOW_BUNDLED_DB)', (v) => { v.services.db.deploy = { ...v.services.db.deploy, replicas: 2 }; }, /db\.deploy differs/],
    ['db scaled another way', (v) => { v.services.db.scale = 2; }, /db\.scale differs/],
    ['the Worker started without worker-start.sh', (v) => { delete v.services['rab-worker'].entrypoint; v.services['rab-worker'].command = ['node', 'packages/rab-worker/dist/main.js']; }, /rab-worker: entrypoint is not exactly \.\/worker-start\.sh/],
    ['the API started without api-prestart.sh as PID 1', (v) => { v.services['rab-api'].entrypoint = ['/sbin/tini', '-s', '--']; v.services['rab-api'].command = ['./api-prestart.sh']; }, /rab-api: entrypoint is not exactly \.\/api-prestart\.sh/],
    ['compose init on the Worker (docker-init keeps the admin URL)', (v) => { v.services['rab-worker'].init = true; }, /rab-worker: init: true/],
    ['a command on the API', (v) => { v.services['rab-api'].command = ['node', 'x.js']; }, /rab-api: has a command/],
  ]) {
    const m = fresh();
    mutate(m.variant);
    assertRefused(checkVariant(m.variant, m.production, m.variantFiles), pattern);
    assert.ok(label);
  }
});

test('DENIAL DB-SETUP environment mode: PG_DATABASE_URL never from an env file, identical, verify-full, never a former separated login; db not weakened', { skip }, () => {
  const ok = { names: ['REDIS_URL', 'APP_SECRET'], unfilled: [], dbUsers: {} };
  const run = (keys, mutate = () => {}) => {
    const m = fresh();
    mutate(m.variantFiles);
    return checkDeployment(m.variantFiles, m.production, keys);
  };
  assert.deepEqual(run({ 'rab-api': ok, 'rab-worker': ok }), []);
  assertRefused(run({ 'rab-api': { ...ok, names: [...ok.names, 'PG_DATABASE_URL'] }, 'rab-worker': ok }), /rab-api: PG_DATABASE_URL is set in an env file/);
  assertRefused(run({ 'rab-api': ok, 'rab-worker': { ...ok, names: [...ok.names, 'PG_DATABASE_PASSWORD'] } }), /rab-worker: PG_DATABASE_PASSWORD reaches the container/);
  assertRefused(run({ 'rab-api': ok, 'rab-worker': ok }, (v) => { v.services['rab-api'].environment.PG_DATABASE_PASSWORD = 'x'; }), /rab-api: PG_DATABASE_PASSWORD reaches the container/);
  // Owner decision 2026-11-18: db-setup's PG_ADMIN_URL (a provider admin login is accepted) beside the crewflow_owner URL
  // that db-setup, rab-api and rab-worker all carry; a former separated login, or TLS below verify-full, is not accepted;
  // an env-file value or the password is refused there too.
  const owner = 'postgresql://crewflow_owner:x@db-direct.example:5432/d?sslmode=verify-full';
  const setUrls = ({ admin, app = owner }) => (v) => {
    if (admin !== undefined) for (const n of ['db-setup', 'db-harden']) v.services[n].environment.PG_ADMIN_URL = admin;
    for (const n of ['db-setup', 'db-harden', 'rab-api', 'rab-worker']) v.services[n].environment.PG_DATABASE_URL = app;
  };
  assert.deepEqual(run({ 'rab-api': ok, 'rab-worker': ok }, setUrls({ admin: 'postgresql://doadmin:x@db-direct.example:5432/d?sslmode=verify-full' })), []);
  for (const login of ['crewflow_app', 'crewflow_migrator', 'crewflow']) {
    assertRefused(run({ 'rab-api': ok, 'rab-worker': ok }, setUrls({ admin: `postgresql://${login}:x@db-direct.example:5432/d?sslmode=verify-full` })), /db-setup: PG_ADMIN_URL: logs in as a former separated login/);
    assertRefused(run({ 'rab-api': ok, 'rab-worker': ok }, setUrls({ app: `postgresql://${login}:x@db-direct.example:5432/d?sslmode=verify-full` })), /db-setup: PG_DATABASE_URL: logs in as a former separated login/);
  }
  // Owner rule 2026-11-19: require / verify-ca / verify-full all mean full verification; disable / prefer / none are refused.
  assertRefused(run({ 'rab-api': ok, 'rab-worker': ok }, setUrls({ admin: 'postgresql://doadmin:x@db-direct.example:5432/d?sslmode=prefer' })), /db-setup: PG_ADMIN_URL: sslmode must be require, verify-ca or verify-full/);
  assertRefused(run({ 'rab-api': ok, 'rab-worker': ok }, setUrls({ app: 'postgresql://crewflow_owner:x@db-direct.example:5432/d?sslmode=disable' })), /db-setup: PG_DATABASE_URL: sslmode must be require, verify-ca or verify-full/);
  // Owner rule 2026-11-19 (provider-neutral): no address rule for a pooler here; db-setup refuses one by its capability checks.
  assert.ok(!run({ 'rab-api': ok, 'rab-worker': ok }, setUrls({ admin: 'postgresql://doadmin:x@pool.internal.example:6432/d?sslmode=verify-full', app: 'postgresql://crewflow_owner:x@pool.internal.example:6432/d?sslmode=verify-full' })).some((p) => /pooler/.test(p)));
  assertRefused(run({ 'rab-api': ok, 'rab-worker': ok }, (v) => { delete v.services['db-setup'].environment.PG_DATABASE_URL; }), /db-setup: PG_DATABASE_URL is missing/);
  assertRefused(run({ 'rab-api': ok, 'rab-worker': ok }, (v) => { delete v.services['db-setup'].environment.PG_DATABASE_URL; }), /db-setup: PG_DATABASE_URL is not set in the deployed model/);
  assertRefused(run({ 'rab-api': ok, 'rab-worker': ok, 'db-setup': { ...ok, names: [...ok.names, 'PG_ADMIN_URL'] } }), /db-setup: PG_ADMIN_URL is set in an env file/);
  assertRefused(run({ 'rab-api': ok, 'rab-worker': ok, 'db-setup': { ...ok, names: [...ok.names, 'PG_DATABASE_ADMIN_URL'] } }), /db-setup: PG_DATABASE_ADMIN_URL is set in an env file/);
  assertRefused(run({ 'rab-api': ok, 'rab-worker': ok, 'db-setup': { ...ok, names: [...ok.names, 'PG_DATABASE_URL'] } }), /db-setup: PG_DATABASE_URL is set in an env file/);
  assertRefused(run({ 'rab-api': ok, 'rab-worker': ok, 'db-setup': { ...ok, names: [...ok.names, 'PG_DATABASE_PASSWORD'] } }), /db-setup: PG_DATABASE_PASSWORD reaches the container/);
  // DENIAL: an override that hands rab-api / rab-worker another database URL than db-setup's (an admin URL, another
  // crewflow_owner URL, anything), drops it, smuggles a second postgres:// value, or mounts the retired setup volume.
  for (const svc of ['rab-api', 'rab-worker']) {
    for (const url of ['postgresql://postgres:x@db:5432/crewflow?sslmode=verify-full', 'postgresql://doadmin:x@db-direct.example:5432/d?sslmode=verify-full', 'x']) {
      assertRefused(run({ 'rab-api': ok, 'rab-worker': ok }, (v) => { v.services[svc].environment.PG_DATABASE_URL = url; }), new RegExp(`${svc}: PG_DATABASE_URL does not log in as crewflow_owner in the deployed model`));
    }
    assertRefused(run({ 'rab-api': ok, 'rab-worker': ok }, (v) => { v.services[svc].environment.PG_DATABASE_URL = owner; }), new RegExp(`${svc}: PG_DATABASE_URL differs from db-setup's in the deployed model`));
    assertRefused(run({ 'rab-api': ok, 'rab-worker': ok }, (v) => { delete v.services[svc].environment.PG_DATABASE_URL; }), new RegExp(`${svc}: PG_DATABASE_URL is not set in its environment in the deployed model`));
    assertRefused(run({ 'rab-api': ok, 'rab-worker': ok }, (v) => { v.services[svc].environment.PG_DATABASE_URL = ''; }), new RegExp(`${svc}: PG_DATABASE_URL is not set in its environment in the deployed model`));
    assertRefused(run({ 'rab-api': ok, 'rab-worker': ok }, (v) => { v.services[svc].healthcheck.test = ['CMD', 'psql', 'postgresql://postgres:x@db/crewflow']; }), new RegExp(`${svc}: holds a postgres:// value outside PG_DATABASE_URL somewhere in its definition in the deployed model`));
    assertRefused(run({ 'rab-api': ok, 'rab-worker': ok }, (v) => { v.services[svc].environment.OTHER_DATABASE_URL = 'postgresql://crewflow_owner:x@db:5432/crewflow'; }), new RegExp(`${svc}: holds a postgres:// value outside PG_DATABASE_URL`));
    assertRefused(run({ 'rab-api': ok, 'rab-worker': ok }, (v) => { v.services[svc].volumes = [...v.services[svc].volumes, { type: 'volume', source: 'crewflow-db-target', target: '/run/crewflow/db-target', read_only: true, volume: {} }]; }), new RegExp(`${svc}: mounts crewflow-db-target at /run/crewflow/db-target in the deployed model`));
  }
  // The same crewflow_owner URL on all three passes; db-setup alone with another one is refused (the apps differ from it).
  assert.deepEqual(run({ 'rab-api': ok, 'rab-worker': ok }, setUrls({ app: 'postgresql://crewflow_owner:another-bundled-password@db:5432/crewflow?sslmode=verify-full' })), []);
  assertRefused(run({ 'rab-api': ok, 'rab-worker': ok }, (v) => { v.services['rab-api'].environment.PG_DATABASE_URL = owner; }), /PG_DATABASE_URL differs between rab-api and rab-worker/);
  assertRefused(run({ 'rab-api': ok, 'rab-worker': ok }, (v) => { v.services['db-setup'].environment.PG_DATABASE_URL = owner; }), /rab-api: PG_DATABASE_URL differs from db-setup's in the deployed model/);
  assertRefused(run({ 'rab-api': ok, 'rab-worker': ok }, (v) => { v.services['db-setup'].volumes = [...v.services['db-setup'].volumes, { type: 'volume', source: 'crewflow-db-target', target: '/run/crewflow/db-target', volume: {} }]; }), /db-setup: mounts crewflow-db-target at \/run\/crewflow\/db-target in the deployed model/);
  assertRefused(run({ 'rab-api': ok, 'rab-worker': ok }, (v) => { delete v.services['db-setup']; }), /db-setup: missing in the deployed model/);
  // Twenty Helm model: db-setup never has APP_SECRET (committed or from an env file); nothing but its volume at the password path.
  assertRefused(run({ 'rab-api': ok, 'rab-worker': ok }, (v) => { v.services['db-setup'].environment.APP_SECRET = 'x'; }), /db-setup: has APP_SECRET in the deployed model/);
  assertRefused(run({ 'rab-api': ok, 'rab-worker': ok, 'db-setup': { ...ok, names: ['APP_SECRET'] } }), /db-setup: APP_SECRET reaches the container from an env file/);
  assertRefused(run({ 'rab-api': ok, 'rab-worker': ok }, (v) => { v.services['rab-redis'].volumes = [...(v.services['rab-redis'].volumes ?? []), { type: 'bind', source: '/x', target: '/run/crewflow/db-target/owner-password', read_only: true }]; }), /rab-redis: mounts something at \/run\/crewflow\/db-target\/owner-password in the deployed model/);
  assertRefused(run({ 'rab-api': ok, 'rab-worker': ok }, (v) => { v.services['db-setup'].restart = 'unless-stopped'; }), /db-setup: restart is not "no" in the deployed model/);
  assertRefused(run({ 'rab-api': ok, 'rab-worker': ok }, (v) => { v.services['db-setup'].read_only = false; }), /db-setup\.read_only differs from docker-compose\.production\.yml in the deployed model/);
  assertRefused(run({ 'rab-api': ok, 'rab-worker': ok }, (v) => { v.services['db-setup'].ports = [{ target: 1, published: '1', host_ip: '127.0.0.1' }]; }), /db-setup: publishes a port in the deployed model/);
  assertRefused(run({ 'rab-api': ok, 'rab-worker': ok }, (v) => { delete v.services['rab-api'].depends_on['db-setup']; }), /rab-api: does not wait for db-setup/);
  assertRefused(run({ 'rab-api': ok, 'rab-worker': ok }, (v) => { v.services['rab-redis'].environment = { PG_DATABASE_URL: 'x' }; }), /rab-redis: has PG_DATABASE_URL in the deployed model/);
  assertRefused(run({ 'rab-api': ok, 'rab-worker': ok }, (v) => { v.services['rab-redis'].environment = { PG_DATABASE_APP_PASSWORD: 'x' }; }), /rab-redis: has PG_DATABASE_APP_PASSWORD in the deployed model/);
  assertRefused(run({ 'rab-api': ok, 'rab-worker': ok }, (v) => { v.services.db.read_only = false; }), /db\.read_only is overridden in the deployed model/);
  assertRefused(run({ 'rab-api': ok, 'rab-worker': ok }, (v) => { v.services.db.ports = [{ target: 5432, published: '5432' }]; }), /db: publishes a port in the deployed model|db\.ports is overridden/);
  assertRefused(run({ 'rab-api': ok, 'rab-worker': ok }, (v) => { delete v.services.db; }), /db: missing in the deployed model/);
  assertRefused(run({ 'rab-api': ok, 'rab-worker': ok }, (v) => { v.services['rab-worker'].entrypoint = ['node', 'packages/rab-worker/dist/main.js']; }), /rab-worker: entrypoint is not exactly \.\/worker-start\.sh in the deployed model/);
  assertRefused(run({ 'rab-api': ok, 'rab-worker': ok }, (v) => { v.services['rab-worker'].init = true; }), /rab-worker: init: true in the deployed model/);
  assertRefused(run({ 'rab-api': ok, 'rab-worker': ok }, (v) => { delete v.services['rab-api'].entrypoint; }), /rab-api: entrypoint is not exactly \.\/api-prestart\.sh in the deployed model/);
  // The bundled db's image: the official postgres repository by digest only.
  const { checkResolvedImages } = require('./verify-image-compose.cjs');
  const d = `sha256:${'a'.repeat(64)}`;
  assert.deepEqual(checkResolvedImages({ services: { db: { image: `postgres@${d}` } } }).problems, []);
  assert.match(checkResolvedImages({ services: { db: { image: `evil/postgres@${d}` } } }).problems.join(), /not the official postgres image/);
  assert.match(checkResolvedImages({ services: { db: { image: 'postgres:16' } } }).problems.join(), /not repository@sha256/);
});

// ---- db-harden (owner decision 2026-11-18, security review of PR #246, M1): the one-shot CREATEROLE hardening.
const verifierRules = require('./verify-image-compose.cjs');
const H_IMG = `adhin007/adolphus@sha256:${'a'.repeat(64)}`;
const H_OWNER = 'postgresql://crewflow_owner:not-a-secret@db:5432/crewflow?sslmode=verify-full'; // gitleaks:allow
const H_BUNDLED = 'postgresql://postgres:not-a-secret@db:5432/crewflow?sslmode=verify-full'; // gitleaks:allow
const H_TIMEOUT = 'CREWFLOW_DB_HARDEN_TIMEOUT_SECONDS';
const H_WAIT = require('../scripts/db-setup-wait.cjs');
const hDbEnv = () => ({ PG_ADMIN_URL: '', PG_DATABASE_URL: H_OWNER, CREWFLOW_BUNDLED_DB: '1', CREWFLOW_BUNDLED_DB_ADMIN_URL: H_BUNDLED, NODE_ENV: 'production', RAB_RUNTIME_ENV: 'production' });
/** A hand-built model of the four services the rules look at (no rendering): the committed shape. */
const hardenModel = () => ({
  // db-setup: the wait-for-db wrapper with no depends_on (owner instruction 2026-11-18); db-harden: db-setup.sh's own wait.
  'db-setup': { image: H_IMG, entrypoint: ['/bin/sh', '-c', H_WAIT.waitWrapperScript().split('$').join('$$'), 'db-setup'], restart: 'no', user: '1000:1000', read_only: true, environment: { ...hDbEnv(), CREWFLOW_DB_WAIT_SECONDS: '170' } },
  'db-harden': { image: H_IMG, entrypoint: ['./db-setup.sh', 'harden'], restart: 'no', user: '1000:1000', read_only: true, environment: { ...hDbEnv(), [H_TIMEOUT]: '1200', CREWFLOW_DB_WAIT_SECONDS: '170' } },
  'rab-api': { image: H_IMG, entrypoint: ['./api-prestart.sh'], depends_on: { 'db-setup': { condition: 'service_completed_successfully' } }, environment: { PG_ADMIN_URL: '', PG_DATABASE_URL: H_OWNER } },
  'rab-worker': { image: H_IMG, entrypoint: ['./worker-start.sh'], environment: { PG_ADMIN_URL: '', PG_DATABASE_URL: H_OWNER } },
});
const hardenRules = (mutate = () => {}) => {
  const s = hardenModel();
  mutate(s);
  return [...verifierRules.optionAProblems(s), ...verifierRules.pid1Problems(s)];
};

test('M1: the hand-built committed shape passes; db-harden is a known service and the second admin service', () => {
  assert.deepEqual(hardenRules(), []);
  assert.deepEqual([...verifierRules.ADMIN_SERVICES], ['db-setup', 'db-harden']);
  assert.deepEqual(verifierRules.PID1_ENTRYPOINTS['db-harden'], ['./db-setup.sh', 'harden']);
  // Its admin URL may carry a value, the same as db-setup's (mode b); nothing else gets one.
  const ext = 'postgresql://doadmin:not-a-secret@db-direct.example.com:5432/crewflow?sslmode=verify-full'; // gitleaks:allow
  assert.deepEqual(hardenRules((s) => { s['db-setup'].environment.PG_ADMIN_URL = ext; s['db-harden'].environment.PG_ADMIN_URL = ext; }), []);
  assert.match(hardenRules((s) => { s.backup = { environment: { PG_ADMIN_URL: ext } }; }).join(' | '), /backup: has PG_ADMIN_URL \(only db-setup and db-harden\)/);
  assert.match(hardenRules((s) => { s.backup = { environment: { PG_DATABASE_URL: H_OWNER } }; }).join(' | '), /backup: has PG_DATABASE_URL \(only db-setup, db-harden, rab-api and rab-worker\)/);
});

test('DENIAL M1 (no rendering): db-harden missing, with depends_on, waited for, another entrypoint/image/shape, other database settings, a bad timeout', () => {
  const cases = [
    [(s) => { delete s['db-harden']; }, /db-harden: missing/],
    [(s) => { s['db-harden'].depends_on = { db: { condition: 'service_healthy' } }; }, /db-harden: has depends_on/],
    [(s) => { s['db-harden'].depends_on = ['db']; }, /db-harden: has depends_on/],
    [(s) => { s['rab-api'].depends_on['db-harden'] = { condition: 'service_completed_successfully' }; }, /rab-api: depends on db-harden/],
    [(s) => { s['rab-worker'].depends_on = ['db-harden']; }, /rab-worker: depends on db-harden/],
    [(s) => { s['db-harden'].entrypoint = ['./db-setup.sh']; }, /db-harden: entrypoint is not exactly \.\/db-setup\.sh harden/],
    [(s) => { s['db-harden'].command = ['harden']; }, /db-harden: has a command/],
    [(s) => { s['db-harden'].init = true; }, /db-harden: init: true/],
    [(s) => { s['db-harden'].image = `adhin007/adolphus@sha256:${'b'.repeat(64)}`; }, /db-harden: image differs from db-setup's or rab-api's/],
    [(s) => { s['db-harden'].restart = 'unless-stopped'; }, /db-harden: restart is not "no"/],
    [(s) => { s['db-harden'].ports = [{ target: 5432 }]; }, /db-harden: publishes a port/],
    [(s) => { s['db-harden'].profiles = ['ops']; }, /db-harden: has a profile/],
    [(s) => { s['db-harden'].user = '0:0'; }, /db-harden: does not run as 1000:1000 with a read-only root/],
    [(s) => { s['db-harden'].read_only = false; }, /db-harden: does not run as 1000:1000 with a read-only root/],
    [(s) => { delete s['db-harden'].environment[H_TIMEOUT]; }, /db-harden: CREWFLOW_DB_HARDEN_TIMEOUT_SECONDS is not set/],
    [(s) => { s['db-harden'].environment[H_TIMEOUT] = '30'; }, /db-harden: CREWFLOW_DB_HARDEN_TIMEOUT_SECONDS is not a whole number of seconds from 60 to 7200/],
    [(s) => { s['db-harden'].environment[H_TIMEOUT] = '7201'; }, /db-harden: CREWFLOW_DB_HARDEN_TIMEOUT_SECONDS is not a whole number/],
    [(s) => { s['db-harden'].environment[H_TIMEOUT] = '1200s'; }, /db-harden: CREWFLOW_DB_HARDEN_TIMEOUT_SECONDS is not a whole number/],
    [(s) => { s['rab-api'].environment[H_TIMEOUT] = '1200'; }, /rab-api: has CREWFLOW_DB_HARDEN_TIMEOUT_SECONDS/],
    [(s) => { s['db-harden'].environment.APP_SECRET = 'x'; }, /db-harden: has APP_SECRET/],
    [(s) => { s['db-harden'].environment.PG_DATABASE_APP_PASSWORD = 'x'; }, /db-harden: has PG_DATABASE_APP_PASSWORD/],
    [(s) => { s['db-harden'].environment.NODE_ENV = 'development'; }, /db-harden: NODE_ENV is not "production"/],
    [(s) => { delete s['db-harden'].environment.RAB_RUNTIME_ENV; }, /db-harden: RAB_RUNTIME_ENV is not "production"/],
    // EXACTLY db-setup's database settings: another value, a missing key, an admin URL db-setup does not have.
    [(s) => { s['db-harden'].environment.PG_ADMIN_URL = 'postgresql://doadmin:x@elsewhere:5432/crewflow?sslmode=verify-full'; }, /db-harden: PG_ADMIN_URL is not db-setup's/],
    [(s) => { s['db-harden'].environment.PG_DATABASE_URL = 'postgresql://crewflow_owner:x@other:5432/crewflow?sslmode=verify-full'; }, /db-harden: PG_DATABASE_URL is not db-setup's/],
    [(s) => { delete s['db-harden'].environment.CREWFLOW_BUNDLED_DB; }, /db-harden: CREWFLOW_BUNDLED_DB is not db-setup's/],
    [(s) => { s['db-harden'].environment.CREWFLOW_BUNDLED_DB_ADMIN_URL = 'postgresql://postgres:z@db:5432/crewflow?sslmode=verify-full'; }, /db-harden: CREWFLOW_BUNDLED_DB_ADMIN_URL is not db-setup's/],
  ];
  for (const [mutate, pattern] of cases) assertRefused(hardenRules(mutate), pattern);
});

// Rendered (docker compose): the committed files and an override, held to the same rules.
test('DENIAL M1 (rendered): db-harden is the same one-shot in both files, reads database.env only, and an override cannot reshape it', { skip }, () => {
  const m0 = fresh();
  for (const model of [m0.variant, m0.production]) {
    assert.deepEqual(model.services['db-harden'].entrypoint, ['./db-setup.sh', 'harden']);
    assert.equal(model.services['db-harden'].depends_on, undefined);
  }
  for (const [mutate, pattern] of [
    [(v) => { delete v.services['db-harden']; }, /services are .*expected exactly db,db-harden,db-setup/],
    [(_v, _f, p) => { delete p.services['db-harden']; }, /db-harden: missing in docker-compose\.production\.yml/],
    [(v) => { v.services['db-harden'].stop_grace_period = '10s'; }, /db-harden\.stop_grace_period differs from docker-compose\.production\.yml/],
    [(v) => { v.services['db-harden'].environment[H_TIMEOUT] = '600'; }, /db-harden\.environment\.CREWFLOW_DB_HARDEN_TIMEOUT_SECONDS differs from docker-compose\.production\.yml/],
    [(v) => { v.services['db-harden'].depends_on = { db: { condition: 'service_healthy', required: true } }; }, /db-harden\.depends_on differs from docker-compose\.production\.yml/],
    [(_v, f) => { f.services['db-harden'].env_file = [{ path: '/x/database.env' }, { path: '/x/runtime.env' }]; }, /db-harden: must read database\.env only/],
    [(v) => { v.services['rab-api'].depends_on['db-harden'] = { condition: 'service_completed_successfully', required: true }; }, /rab-api: depends on db-harden/],
  ]) assertRefused(problemsAfter(mutate), pattern);
  const ok = { names: ['REDIS_URL', 'APP_SECRET'], unfilled: [], dbUsers: {} };
  const dep = (keys, mutate = () => {}) => {
    const m = fresh();
    mutate(m.variantFiles);
    return checkDeployment(m.variantFiles, m.production, { 'rab-api': ok, 'rab-worker': ok, ...keys });
  };
  assert.deepEqual(dep({ 'db-harden': { names: [], unfilled: [], dbUsers: {} } }), []);
  for (const key of ['PG_ADMIN_URL', 'PG_DATABASE_URL', H_TIMEOUT]) assertRefused(dep({ 'db-harden': { names: [key], unfilled: [], dbUsers: {} } }), new RegExp(`db-harden: ${key} is set in an env file`));
  assertRefused(dep({ 'db-harden': { names: ['APP_SECRET'], unfilled: [], dbUsers: {} } }), /db-harden: APP_SECRET reaches the container from an env file/);
  assertRefused(dep({ 'db-harden': { names: ['PG_DATABASE_APP_PASSWORD'], unfilled: [], dbUsers: {} } }), /db-harden: PG_DATABASE_APP_PASSWORD reaches the container from an env file/);
  assertRefused(dep({}, (v) => { v.services['db-harden'].read_only = false; }), /db-harden\.read_only differs from docker-compose\.production\.yml in the deployed model/);
  assertRefused(dep({}, (v) => { v.services['db-harden'].depends_on = { db: { condition: 'service_healthy', required: true } }; }), /db-harden\.depends_on is added in the deployed model/);
  assertRefused(dep({}, (v) => { v.services['rab-worker'].depends_on['db-harden'] = { condition: 'service_started', required: true }; }), /rab-worker: depends on db-harden in the deployed model/);
});

test('DB-SETUP: the verifier and the owner-login gate refuse the same former separated logins', () => {
  const gate = require('../scripts/compose-owner-login.cjs');
  const verifier = require('./verify-image-compose.cjs');
  assert.deepEqual([...verifier.NOT_THE_APP_LOGIN].sort(), [...gate.NOT_THE_APP_LOGIN].sort());
});

test('DENIAL PR #125 finding 6: environment mode applies the bundled db environment rules to the deployed model', { skip }, () => {
  const ok = { names: ['REDIS_URL', 'APP_SECRET'], unfilled: [], dbUsers: {} };
  const run = (mutate) => {
    const m = fresh();
    mutate(m.variantFiles);
    return checkDeployment(m.variantFiles, m.production, { 'rab-api': ok, 'rab-worker': ok });
  };
  // The render's dummy password is real-shaped (32+ URL-safe), so the committed shape passes.
  assert.deepEqual(run(() => {}), []);
  for (const [mutate, re] of [
    [(v) => { v.services.db.environment.POSTGRES_HOST_AUTH_METHOD = 'trust'; }, /db: POSTGRES_HOST_AUTH_METHOD is set .* in the deployed model/],
    [(v) => { v.services.db.environment.POSTGRES_INITDB_ARGS = '--auth-local=peer'; }, /db: POSTGRES_INITDB_ARGS must be exactly .* in the deployed model/],
    [(v) => { v.services.db.environment.PGDATA = '/var/lib/postgresql/data'; }, /db: PGDATA must be .* in the deployed model/],
    [(v) => { v.services.db.environment.POSTGRES_PASSWORD = 'postgres'; }, /db: POSTGRES_PASSWORD is missing or not 32\+ URL-safe .* in the deployed model/],
    [(v) => { v.services.db.environment.PG_DATABASE_URL = 'postgresql://x:y@db/z'; }, /db: has PG_DATABASE_URL in the deployed model|db: PG_DATABASE_URL holds a PostgreSQL URL in the deployed model/],
    [(v) => { v.services.db.environment.POSTGRES_USER = 'crewflow_owner'; }, /db: the superuser is the app login .* in the deployed model/],
    [(v) => { v.services.db.environment.EXTRA = 'x'; }, /db: environment has EXTRA \(only .* in the deployed model/],
  ]) assertRefused(run(mutate), re);
});

// Security review L3 (the shared rule, compose-owner-login.cjs credentialMountProblems): each fixture must fail, in the
// variant and in the deployed model.
const L3_VARIANT_FIXTURES = [
  [(v) => { v.services['rab-redis'].volumes_from = ['db-setup']; }, /rab-redis: has volumes_from/],
  [(v) => { v.services['rab-api'].secrets = [{ source: 'x', target: '/run/crewflow/db-target/owner-password' }]; }, /rab-api: a secrets entry targets \/run\/crewflow|rab-api\.secrets differs/],
  [(v) => { v.services['db-setup'].configs = [{ source: 'x', target: '/run/crewflow/db-target/target.json' }]; }, /db-setup: a configs entry targets \/run\/crewflow/],
  [(v) => { v.services['rab-redis'].volumes.push({ type: 'bind', source: '/var/lib/docker/volumes/p_crewflow-db-target/_data', target: '/x', read_only: true }); }, /rab-redis: binds a path inside Docker's volume store/],
  [(v) => { v.services['rab-worker'].tmpfs = [...(v.services['rab-worker'].tmpfs ?? []), '/run/crewflow/db-target']; }, /rab-worker: a tmpfs at \/run\/crewflow\/db-target|rab-worker\.tmpfs differs/],
  [(v) => { v.services['rab-redis'].user = '1000:1000'; }, /rab-redis: user is "1000:1000", expected 999:<gid>/],
];
test('DENIAL security review L3: the variant and the production reference refuse every other path to the password volume', { skip }, () => {
  for (const [mutate, pattern] of L3_VARIANT_FIXTURES) assertRefused(problemsAfter((v) => mutate(v)), pattern);
  // The production reference: the mount rules apply (its rab-redis has no `user:`, so the uid rule is the variant's).
  assertRefused(problemsAfter((_v, _f, p) => { p.services['rab-redis'].volumes_from = ['db-setup']; }), /rab-redis: has volumes_from in docker-compose\.production\.yml/);
  assertRefused(problemsAfter((_v, _f, p) => { p.services['rab-api'].tmpfs = ['/run/crewflow/db-target']; }), /rab-api: a tmpfs at \/run\/crewflow\/db-target in docker-compose\.production\.yml/);
});
test('DENIAL security review L3: the deployed model refuses the same paths (an override cannot add them)', { skip }, () => {
  for (const [mutate, pattern] of [
    [(v) => { v.services['rab-redis'].volumes_from = ['db-setup']; }, /rab-redis: has volumes_from in the deployed model/],
    [(v) => { v.services['rab-api'].secrets = [{ source: 'x', target: '/run/crewflow/db-target/owner-password' }]; }, /rab-api: a secrets entry targets \/run\/crewflow in the deployed model/],
    [(v) => { v.services['rab-redis'].volumes.push({ type: 'bind', source: '/var/lib/docker/volumes/v/_data', target: '/x', read_only: true }); }, /rab-redis: binds a path inside Docker's volume store in the deployed model/],
    [(v) => { v.services['rab-api'].tmpfs = ['/run/crewflow/db-target:size=1m']; }, /rab-api: a tmpfs at \/run\/crewflow\/db-target in the deployed model/],
    [(v) => { v.services['rab-redis'].user = '1000:1000'; }, /rab-redis: user is "1000:1000" in the deployed model, expected 999:<gid>/],
  ]) assertRefused(deployed(mutate), pattern);
});

// Security re-review F2: the deployed model cannot reach the password volume through an added service.
test('DENIAL security review F2: volume aliases, driver_opts binds, namespace sharing, Docker-root ancestor binds, extra services as uid 0/1000', { skip }, () => {
  // A fully hardened added service (R4), so each fixture below tests exactly one route.
  const extra = (v, s) => {
    v.services.backup = { image: v.services['rab-api'].image, user: '2000:2000', cap_drop: ['ALL'], security_opt: ['no-new-privileges:true'], ...s };
  };
  for (const [mutate, pattern] of [
    [(v) => { v.volumes.bk = { external: true, name: 'rab-production_crewflow-db-target' }; extra(v, { volumes: [{ type: 'volume', source: 'bk', target: '/x', read_only: true }] }); }, /volume bk: (names db-setup's password volume|declares the retired crewflow-db-target volume) in the deployed model/],
    [(v) => { v.volumes.bk = { name: 'other', driver_opts: { type: 'none', o: 'bind', device: '/var/lib/docker/volumes' } }; extra(v, { volumes: [{ type: 'volume', source: 'bk', target: '/x' }] }); }, /volume bk: is a host bind through driver_opts in the deployed model/],
    [(v) => { v.volumes['crewflow-db-target'] = { external: true }; }, /volume crewflow-db-target: declares the retired crewflow-db-target volume in the deployed model/],
    [(v) => { extra(v, { pid: 'service:rab-api' }); }, /backup: pid shares the namespace of rab-api in the deployed model/],
    [(v) => { extra(v, { ipc: 'service:db-setup' }); }, /backup: ipc shares the namespace of db-setup in the deployed model/],
    [(v) => { extra(v, { network_mode: 'service:rab-worker' }); }, /backup: network_mode shares the namespace of rab-worker in the deployed model/],
    [(v) => { extra(v, { pid: 'container:rab-production-rab-api-1' }); }, /backup: pid joins another container's namespace in the deployed model/],
    [(v) => { extra(v, { user: '1000:0', volumes: [{ type: 'bind', source: '/', target: '/host', read_only: true }] }); }, /backup: binds an ancestor of Docker's root directory in the deployed model/],
    [(v) => { extra(v, { user: '1000:0', volumes: [{ type: 'bind', source: '/', target: '/host', read_only: true }] }); }, /backup: an added service must run as a numeric uid other than 0 and 1000 in the deployed model/],
    [(v) => { extra(v, { volumes: [{ type: 'bind', source: '/var/lib', target: '/x', read_only: true }] }); }, /backup: binds an ancestor of Docker's root directory/],
    [(v) => { extra(v, { volumes: [{ type: 'bind', source: '/var/', target: '/x', read_only: true }] }); }, /backup: binds an ancestor of Docker's root directory/],
    [(v) => { extra(v, { volumes: [{ type: 'bind', source: '/home/ops/.local/share', target: '/x', read_only: true }] }); }, /backup: binds an ancestor of Docker's root directory/],
    [(v) => { extra(v, { user: '0' }); }, /backup: an added service must run as a numeric uid other than 0 and 1000/],
    [(v) => { extra(v, { user: undefined }); }, /backup: an added service must run as a numeric uid other than 0 and 1000/],
  ]) assertRefused(deployed(mutate), pattern);
  // An added service as another uid, mounting nothing of ours, is not refused by these rules.
  const ok = deployed((v) => extra(v, { volumes: [{ type: 'bind', source: '/srv/backups', target: '/b', read_only: true }] }));
  assert.ok(!ok.some((p) => /backup: (an added service|binds an ancestor|pid|ipc|network_mode)|volume /.test(p)), ok.join(' | '));
  // The variant and the production reference: the same volume rules.
  assertRefused(problemsAfter((v) => { v.volumes.bk = { external: true, name: 'x_crewflow-db-target' }; }), /volume bk: (names db-setup's password volume|declares the retired crewflow-db-target volume)/);
  // Owner decision 2026-11-18: the retired setup volume itself, in the variant and the production reference.
  assertRefused(problemsAfter((v) => { v.volumes['crewflow-db-target'] = {}; }), /volume crewflow-db-target: declares the retired crewflow-db-target volume/);
  assertRefused(problemsAfter((_v, _f, p) => { p.services['rab-worker'].volumes = [...(p.services['rab-worker'].volumes ?? []), { type: 'volume', source: 'crewflow-db-target', target: '/run/crewflow/db-target', read_only: true }]; }), /rab-worker: mounts crewflow-db-target at \/run\/crewflow\/db-target in docker-compose\.production\.yml/);
  assertRefused(problemsAfter((_v, _f, p) => { p.volumes.bk = { driver_opts: { o: 'rw,bind', device: '/' } }; }), /volume bk: is a host bind through driver_opts in docker-compose\.production\.yml/);
});

// Security re-review R3 / R4 / I4: the deployed model, one DENIAL fixture per route.
test('DENIAL security review R3/R4/I4: uid parsing, Docker root binds, added-service hardening, groups, host runtime paths, volume drivers, the password volume name', { skip }, () => {
  const hardened = { image: undefined, user: '2000:2000', cap_drop: ['ALL'], security_opt: ['no-new-privileges:true'] };
  const extra = (v, s) => {
    v.services.backup = { ...hardened, image: v.services['rab-api'].image, ...s };
  };
  const m = fresh();
  const run = (mutate, opts) => {
    const mm = structuredClone(m);
    mutate(mm.variantFiles);
    return checkDeployment(mm.variantFiles, mm.production, {}, opts);
  };
  for (const [mutate, pattern, opts] of [
    // R3: canonical decimal uids only
    [(v) => extra(v, { user: '01000:2000' }), /backup: an added service must run as a numeric uid other than 0 and 1000/],
    [(v) => extra(v, { user: '00' }), /backup: an added service must run as a numeric uid other than 0 and 1000/],
    [(v) => extra(v, { user: '0000:2000' }), /backup: an added service must run as a numeric uid other than 0 and 1000/],
    // R3: Docker's root from `docker info` (mocked), its ancestors and descendants
    [(v) => extra(v, { volumes: [{ type: 'bind', source: '/srv/docker-data/volumes/x/_data', target: '/x', read_only: true }] }), /backup: binds Docker's root directory, an ancestor or a descendant of it in the deployed model/, { dockerRoot: '/srv/docker-data' }],
    [(v) => extra(v, { volumes: [{ type: 'bind', source: '/srv', target: '/x', read_only: true }] }), /backup: binds Docker's root directory, an ancestor or a descendant of it/, { dockerRoot: '/srv/docker-data' }],
    [(v) => extra(v, { volumes: [{ type: 'bind', source: '/srv/docker-data', target: '/x', read_only: true }] }), /backup: binds Docker's root directory, an ancestor or a descendant of it/, { dockerRoot: '/srv/docker-data' }],
    // R4: added-service hardening
    [(v) => extra(v, { cap_drop: [] }), /backup: an added service must drop all capabilities/],
    [(v) => extra(v, { cap_add: ['DAC_READ_SEARCH'] }), /backup: an added service adds capabilities/],
    [(v) => extra(v, { security_opt: [] }), /backup: an added service must set security_opt no-new-privileges:true/],
    [(v) => extra(v, { privileged: true }), /backup: an added service is privileged/],
    [(v) => extra(v, { pid: 'host' }), /backup: an added service uses the host pid/],
    [(v) => extra(v, { devices: ['/dev/sda:/dev/sda'] }), /backup: an added service maps host devices/],
    [(v) => extra(v, { networks: { 'crewflow-db': null } }), /backup: an added service is on the bundled database's crewflow-db network/],
    [(v) => extra(v, { group_add: ['disk'] }), /backup: group_add on an added service/],
    [(v) => extra(v, { user: '2000:0' }), /backup: an added service must not run with group 0/],
    [(v) => extra(v, { user: '2000:docker' }), /backup: an added service must not run with group 0 or a non-numeric group/],
    [(v) => extra(v, { volumes: [{ type: 'bind', source: '/var/run/containerd', target: '/x', read_only: true }] }), /backup: binds a path under \/run or \/var\/run/],
    [(v) => extra(v, { volumes: [{ type: 'bind', source: '/run/user/1000', target: '/x', read_only: true }] }), /backup: binds a path under \/run or \/var\/run/],
    [(v) => extra(v, { volumes: [{ type: 'bind', source: '/srv/podman.sock', target: '/x.sock', read_only: true }] }), /backup: binds a socket \(\*\.sock\)/],
    // R4: any volume's driver / driver options
    [(v) => { v.volumes.extra = { name: 'x', driver_opts: { type: 'tmpfs', device: 'tmpfs' } }; }, /volume extra: has driver options or a non-local driver in the deployed model/],
    [(v) => { v.volumes.extra = { name: 'x', driver: 'rexray/ebs' }; }, /volume extra: has driver options or a non-local driver/],
    // I4 (owner decision 2026-11-18): the retired password volume is refused whatever its name
    [(v) => { v.volumes['crewflow-db-target'] = { name: 'somebody-elses-volume' }; }, /volume crewflow-db-target: declares the retired crewflow-db-target volume in the deployed model/],
  ]) assertRefused(run(mutate, opts), pattern);
  // A fully hardened added service with an unrelated bind passes these rules.
  const ok = run((v) => extra(v, { volumes: [{ type: 'bind', source: '/srv/backups', target: '/b', read_only: true }] }), { dockerRoot: '/srv/docker-data' });
  assert.ok(!ok.some((p) => /^backup: (an added service|group_add|binds)|^volume /.test(p)), ok.join(' | '));
});

// L-2: the --environment preflight runs the app's CA rules (pg-ca-pem.cjs) on CREWFLOW_PG_CA_FILE before a deploy, so a CA
// file the stricter boot validation now refuses (a CRL or TRUSTED CERTIFICATE block, a bundled key, over 256 KiB, not a
// regular file) is caught on the host, not by a crash-looping API.
test('environment preflight: CREWFLOW_PG_CA_FILE is held to the boot rules of PG_SSL_CA_CERT_PATH', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { pgCaFileEnvironmentProblems } = require('./verify-image-compose.cjs');
  const ca = /export const TEST_CA_A = `([^`]+)`/.exec(fs.readFileSync(path.join(__dirname, '../../rab-server/src/database/postgres/__tests__/fixtures/pg-test-ca.ts'), 'utf8'))[1];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-ca-preflight-'));
  try {
    const write = (name, text) => (fs.writeFileSync(path.join(dir, name), text), name);
    const problems = (file) => pgCaFileEnvironmentProblems({ CREWFLOW_PG_CA_FILE: file }, dir);
    assert.deepEqual(pgCaFileEnvironmentProblems({}, dir), []);
    assert.deepEqual(pgCaFileEnvironmentProblems({ CREWFLOW_PG_CA_FILE: '' }, dir), []);
    assert.deepEqual(problems(write('ok.pem', ca)), []);
    assert.deepEqual(problems(path.join(dir, 'ok.pem')), [], 'an absolute path');
    const crl = write('with-crl.pem', `${ca}-----BEGIN X509 CRL-----\nMIIBFjCBvQIBATAKBggqhkjOPQQDAjAiMSAwHgYDVQQDDBdjcmV3Zmxvdw==\n-----END X509 CRL-----\n`);
    assert.match(problems(crl).join(' | '), /CREWFLOW_PG_CA_FILE \(mounted as PG_SSL_CA_CERT_PATH\) contains a "X509 CRL" PEM block; only CERTIFICATE blocks are accepted\. rab-api and rab-worker would refuse to start\./);
    assert.match(problems(write('trusted.pem', ca.replace(/CERTIFICATE/g, 'TRUSTED CERTIFICATE'))).join(' | '), /"TRUSTED CERTIFICATE" PEM block/);
    const KEY_LABEL = ['PRIVATE', 'KEY'].join(' '); // built, so no secret scanner mistakes the fixture for a key
    assert.match(problems(write('key.pem', `${ca}-----BEGIN ${KEY_LABEL}-----\nMIGH\n-----END ${KEY_LABEL}-----\n`)).join(' | '), /contains a PRIVATE KEY block/);
    assert.match(problems(write('big.pem', ca.repeat(500))).join(' | '), /larger than 256 KiB/);
    fs.mkdirSync(path.join(dir, 'a-dir'));
    assert.match(problems('a-dir').join(' | '), /is not a regular file/);
    assert.match(problems('missing.pem').join(' | '), /cannot be read/);
    for (const p of problems(crl)) assert.ok(!/MII/.test(p), 'never the file content');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
