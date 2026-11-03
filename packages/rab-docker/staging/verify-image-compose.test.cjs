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
    for (const key of RUNTIME_KEYS) assert.deepEqual(m.variant.services[svc][key], m.production.services[svc][key], `${svc}.${key}`);
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
  ['rab-worker extra capability', (v) => { v.services['rab-worker'].cap_add.push('CHOWN'); }, /rab-worker\.cap_add differs/],
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
