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
  ['rab-migrate on another image than rab-api', (v) => { v.services['rab-migrate'].image = `adhin007/adolphus@sha256:${'2'.repeat(64)}`; }, /rab-migrate: image differs/],
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
  ['API does not wait for rab-migrate', (v) => { delete v.services['rab-api'].depends_on['rab-migrate']; }, /rab-api: does not wait for rab-migrate|rab-api\.depends_on differs/],
  ['rab-migrate restarts', (v) => { v.services['rab-migrate'].restart = 'always'; }, /rab-migrate: restart/],
  ['rab-migrate writable root', (v) => { v.services['rab-migrate'].read_only = false; }, /rab-migrate: not read-only/],
  ['rab-migrate on another login than the API', (v) => { v.services['rab-migrate'].environment.PG_DATABASE_URL = 'postgresql://crewflow_owner:other@h:5432/rab'; }, /PG_DATABASE_URL differs from rab-api's|credential does not reach it/],
  ['rab-migrate reads runtime.env', (v, f) => { v.services['rab-migrate'].environment.APP_SECRET = 'x'; f.services['rab-migrate'].env_file = [{ path: '/s/database.env' }, { path: '/s/runtime.env' }]; }, /rab-migrate: (reads the runtime secrets|must read database.env only)/],
  ['rab-migrate back on .env.migrate', (_v, f) => { f.services['rab-migrate'].env_file = [{ path: '/x/.env.migrate' }]; }, /rab-migrate: must read database.env only/],
  ['rab-migrate with DB_TARGET', (v) => { v.services['rab-migrate'].environment.DB_TARGET = 'production'; }, /rab-migrate: sets DB_TARGET/],
  ['rab-migrate without token approval', (v) => { v.services['rab-migrate'].environment.CREWFLOW_MIGRATION_APPROVAL_MODE = 'none'; }, /rab-migrate: CREWFLOW_MIGRATION_APPROVAL_MODE/],
  ['API migrates on start', (v) => { v.services['rab-api'].environment.CREWFLOW_MIGRATE_ON_START = 'true'; }, /rab-api\.environment\.CREWFLOW_MIGRATE_ON_START differs/],
  ['a provisioner URL on the Worker', (v) => { v.services['rab-worker'].environment.CREWFLOW_PROVISIONER_DATABASE_URL = 'postgresql://crewflow:x@h/rab'; }, /rab-worker: sets CREWFLOW_PROVISIONER_DATABASE_URL/],
  ['the mode switch on the API', (v) => { v.services['rab-api'].environment.CREWFLOW_DB_MODE = 'twenty'; }, /rab-api: sets CREWFLOW_DB_MODE/],
  ['Redis evicting', (v) => { const c = v.services['rab-redis'].command; c[c.indexOf('--maxmemory-policy') + 1] = 'allkeys-lru'; }, /rab-redis: command lacks --maxmemory-policy noeviction/],
  ['Redis without the ACL file', (v) => { const c = v.services['rab-redis'].command; c.splice(c.indexOf('--aclfile'), 2); }, /rab-redis: command lacks --aclfile/],
  ['OpenShip import guard removed', (v) => { v.services['rab-migrate'].volumes = []; }, /OpenShip import guard/],
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

// Review G1: overrides on rab-redis, rab-migrate and rab-ops are re-checked in the deployed model.
const otherWeakenings = [
  ['rab-redis privileged', (v) => { v.services['rab-redis'].privileged = true; }, /rab-redis: privileged/],
  ['rab-redis on the host network', (v) => { v.services['rab-redis'].network_mode = 'host'; }, /rab-redis: host namespace/],
  ['rab-redis started without noeviction and the ACL', (v) => { v.services['rab-redis'].command = ['redis-server', '--appendonly', 'yes']; }, /rab-redis: command lacks --maxmemory-policy noeviction/],
  ['rab-redis without a memory limit', (v) => { delete v.services['rab-redis'].mem_limit; }, /rab-redis: no memory limit/],
  ['the Docker socket in rab-migrate', (v) => { v.services['rab-migrate'].volumes.push({ type: 'bind', source: '/var/run/docker.sock', target: '/var/run/docker.sock' }); }, /rab-migrate: mounts the Docker socket/],
  ['rab-migrate on another image', (v) => { v.services['rab-migrate'].image = `adhin007/adolphus@sha256:${'9'.repeat(64)}`; }, /rab-migrate: image differs/],
  ['rab-migrate with DB_TARGET=local', (v) => { v.services['rab-migrate'].environment.DB_TARGET = 'local'; }, /rab-migrate: sets DB_TARGET/],
  ['rab-migrate without database.env', (v) => { v.services['rab-migrate'].env_file = []; }, /rab-migrate: must read database.env only/],
  ['rab-ops without its profile', (v) => { delete v.services['rab-ops'].profiles; }, /rab-ops: not in \(only\) the "ops" profile/],
  ['rab-ops with a writable root', (v) => { v.services['rab-ops'].read_only = false; }, /rab-ops: not read-only/],
  ['rab-ops privileged', (v) => { v.services['rab-ops'].privileged = true; }, /rab-ops: privileged/],
  ['an extra capability on rab-redis', (v) => { v.services['rab-redis'].cap_add = ['SYS_ADMIN']; }, /rab-redis: adds devices or capabilities/],
  ['the retired launcher capabilities back on the Worker', (v) => { v.services['rab-worker'].cap_add = ['SETUID', 'SETGID', 'KILL']; }, /rab-worker: adds devices or capabilities/],
];
for (const [name, mutate, pattern] of otherWeakenings) {
  test(`environment mode refuses: ${name}`, { skip }, () => assertRefused(deployed(mutate), pattern));
}

// Compose-version independence (CI runs Compose v2.38, which resolves env files and drops env_file even under
// --no-env-resolution). A REAL variant file in which rab-migrate / rab-ops no longer read their env file must still fail.
test('a variant file whose rab-migrate and rab-ops read no env file fails, whatever the Compose version', { skip }, () => {
  const migrateEnvFile = /(\n  rab-migrate:\n[\s\S]*?)\n    env_file:\n      - path: [^\n]*\/database\.env\n        required: true\n/;
  const fsx = require('node:fs');
  const os = require('node:os');
  const pathx = require('node:path');
  const src = fsx.readFileSync(pathx.join(__dirname, '../docker-compose.image.yml'), 'utf8');
  const weakened = src.replace(migrateEnvFile, '$1\n').replace(/\n    env_file:\n      - \.env\.ops\n/, '\n');
  assert.notEqual(weakened, src, 'the fixture edit did not apply');
  const dir = fsx.mkdtempSync(pathx.join(os.tmpdir(), 'crewflow-image-verify-test-'));
  try {
    // renderModels() renders in its own throw-away project directory, so the copy's location does not change any path.
    const copy = pathx.join(dir, 'docker-compose.image.yml');
    fsx.writeFileSync(copy, weakened);
    try {
      const m = renderModels(copy);
      const problems = checkVariant(m.variant, m.production, m.variantFiles);
      assertRefused(problems, /rab-migrate: must read database.env only/);
      assertRefused(problems, /rab-ops: must read \.env\.ops only/);
      assertRefused(checkDeployment(m.variantFiles, m.production), /rab-migrate: must read database.env only in the deployed model/);
    } finally {
      fsx.rmSync(copy, { force: true });
    }
  } finally {
    fsx.rmSync(dir, { recursive: true, force: true });
  }
});
