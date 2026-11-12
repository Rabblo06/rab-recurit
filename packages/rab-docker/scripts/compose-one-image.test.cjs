'use strict';
// Self-tests for compose-one-image.cjs: the denial cases first (owner decision 2026-11-11, "deploy exactly like Twenty").
//   node --test packages/rab-docker/scripts/compose-one-image.test.cjs
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { checkModel } = require('./compose-one-image.cjs');

const IMG = '${CREWFLOW_IMAGE_REPOSITORY:-adhin007/adolphus}@${CREWFLOW_IMAGE_TAG:?CREWFLOW_IMAGE_TAG must be a digest}';

function good() {
  return {
    services: {
      'rab-redis': { image: 'redis@sha256:x' },
      'rab-api': {
        image: IMG,
        environment: { CREWFLOW_MIGRATE_ON_START: 'true' },
        depends_on: { 'rab-redis': { condition: 'service_healthy' } },
        stop_grace_period: '40s',
      },
      'rab-worker': {
        image: IMG,
        environment: { DISABLE_DB_MIGRATIONS: 'true', DISABLE_CRON_JOBS_REGISTRATION: 'true' },
        depends_on: {
          'rab-redis': { condition: 'service_healthy' },
          'rab-api': { condition: 'service_healthy', restart: true },
        },
      },
    },
  };
}
const refused = (model, re) => {
  const problems = checkModel(model, 'fixture');
  assert.ok(problems.some((p) => re.test(p)), `expected a problem matching ${re}, got: ${JSON.stringify(problems)}`);
};

test('the committed shape passes', () => {
  assert.deepEqual(checkModel(good(), 'fixture'), []);
});

test('DENIAL: separate image variables for the API and the Worker', () => {
  const m = good();
  m.services['rab-worker'].image = '${CREWFLOW_IMAGE_REPOSITORY:-adhin007/adolphus}@${CREWFLOW_WORKER_IMAGE_TAG}';
  refused(m, /rab-worker: image differs from rab-api/);
  refused(m, /CREWFLOW_WORKER_IMAGE_TAG/);
});

test('DENIAL: a separate API tag variable (an API-only deploy path)', () => {
  const m = good();
  m.services['rab-api'].image = 'adhin007/adolphus@${CREWFLOW_API_IMAGE_TAG}';
  refused(m, /rab-api: image must be/);
  refused(m, /image differs from rab-api/);
});

test('DENIAL: a plain tag instead of a digest', () => {
  const m = good();
  for (const n of ['rab-api', 'rab-worker']) m.services[n].image = 'adhin007/adolphus:${CREWFLOW_IMAGE_TAG}';
  refused(m, /rab-api: image must be/);
});

test('DENIAL: a hard-coded image (no variable) on one service', () => {
  const m = good();
  m.services['rab-worker'].image = `adhin007/adolphus@sha256:${'a'.repeat(64)}`;
  refused(m, /rab-worker: image must be/);
});

test('DENIAL: a rab-ops service is present (removed in rab-ops removal PR 2; it must not come back)', () => {
  // Even on the identical image and with no profile, the service itself is refused.
  const m = good();
  m.services['rab-ops'] = { image: IMG };
  refused(m, /rab-ops: service must not exist/);
  // ...and the old shape (the ops profile) is refused on both counts.
  m.services['rab-ops'] = { image: IMG, profiles: ['ops'] };
  refused(m, /rab-ops: service must not exist/);
  refused(m, /rab-ops: an "ops" profile service must not exist/);
});

test('DENIAL: any service under an "ops" profile, whatever its name', () => {
  const m = good();
  m.services['operations'] = { image: IMG, profiles: ['ops'] };
  refused(m, /operations: an "ops" profile service must not exist/);
});

test('DENIAL: a build section on a deploy service', () => {
  const m = good();
  m.services['rab-api'].build = { context: '../..', dockerfile: 'packages/rab-docker/rab/Dockerfile' };
  refused(m, /rab-api: has a build section/);
});

test('DENIAL: the Worker does not wait for a healthy API', () => {
  const m = good();
  m.services['rab-worker'].depends_on['rab-api'] = { condition: 'service_started', restart: true };
  refused(m, /depend on rab-api with condition service_healthy/);
  delete m.services['rab-worker'].depends_on['rab-api'];
  refused(m, /depend on rab-api with condition service_healthy/);
});

test('DENIAL: no restart: true (an old Worker could run beside a new API)', () => {
  const m = good();
  delete m.services['rab-worker'].depends_on['rab-api'].restart;
  refused(m, /restart: true/);
});

test('DENIAL: the Worker does not wait for a healthy Redis', () => {
  const m = good();
  delete m.services['rab-worker'].depends_on['rab-redis'];
  refused(m, /rab-redis/);
});

test('DENIAL: the API waits for the Worker (wrong order)', () => {
  const m = good();
  m.services['rab-api'].depends_on['rab-worker'] = { condition: 'service_started' };
  refused(m, /must not depend on rab-worker/);
});

test('DENIAL: the API does not migrate, or carries the Worker-only switches', () => {
  const m = good();
  m.services['rab-api'].environment = { CREWFLOW_MIGRATE_ON_START: 'false', DISABLE_CRON_JOBS_REGISTRATION: 'true' };
  refused(m, /CREWFLOW_MIGRATE_ON_START/);
  refused(m, /rab-api: DISABLE_CRON_JOBS_REGISTRATION must not be set/);
});

test('DENIAL: the Worker migrates or registers schedulers', () => {
  const m = good();
  m.services['rab-worker'].environment = { DISABLE_DB_MIGRATIONS: 'false' };
  refused(m, /rab-worker: DISABLE_DB_MIGRATIONS must be "true"/);
  refused(m, /rab-worker: DISABLE_CRON_JOBS_REGISTRATION must be "true"/);
});

test('DENIAL: the API stop window below 40 s', () => {
  const m = good();
  m.services['rab-api'].stop_grace_period = '35s';
  refused(m, /stop_grace_period below 40s/);
});

function dockerCompose() {
  try {
    execFileSync('docker', ['compose', 'version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test('DENIAL (rendered): a real compose file with two image variables fails the CLI', { skip: !dockerCompose() && 'docker compose not available' }, () => {
  // The CLI renders the committed files; prove the rendered path catches a real file by checking one directly.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'one-image-'));
  try {
    const file = path.join(dir, 'c.yml');
    fs.writeFileSync(file, [
      'services:',
      '  rab-redis: { image: redis }',
      '  rab-api: { image: "r@${CREWFLOW_API_IMAGE_TAG}", stop_grace_period: 40s, environment: { CREWFLOW_MIGRATE_ON_START: "true" } }',
      '  rab-worker:',
      '    image: "r@${CREWFLOW_WORKER_IMAGE_TAG}"',
      '    environment: { DISABLE_DB_MIGRATIONS: "true", DISABLE_CRON_JOBS_REGISTRATION: "true" }',
      '    depends_on: { rab-api: { condition: service_healthy, restart: true }, rab-redis: { condition: service_healthy } }',
      '',
    ].join('\n'));
    const out = execFileSync('docker', ['compose', '--project-directory', dir, '-f', file, 'config', '--no-interpolate', '--format', 'json'], { encoding: 'utf8' });
    refused(JSON.parse(out), /rab-worker: image differs from rab-api/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('DENIAL (rendered): a profile-gated rab-ops is rendered by the CLI (--profile *) and refused', { skip: !dockerCompose() && 'docker compose not available' }, () => {
  const { render } = require('./compose-one-image.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'one-image-ops-'));
  try {
    const file = path.join(dir, 'c.yml');
    const img = 'r@${CREWFLOW_IMAGE_TAG:?digest}';
    fs.writeFileSync(file, [
      'services:',
      '  rab-redis: { image: redis }',
      `  rab-api: { image: "${img}", stop_grace_period: 40s, environment: { CREWFLOW_MIGRATE_ON_START: "true" } }`,
      '  rab-worker:',
      `    image: "${img}"`,
      '    environment: { DISABLE_DB_MIGRATIONS: "true", DISABLE_CRON_JOBS_REGISTRATION: "true" }',
      '    depends_on: { rab-api: { condition: service_healthy, restart: true }, rab-redis: { condition: service_healthy } }',
      '  rab-ops:',
      `    image: "${img}"`,
      '    profiles: ["ops"]',
      '',
    ].join('\n'));
    // render() joins each file onto packages/rab-docker, so it is given the temp file's path relative to that directory.
    const rel = path.relative(path.resolve(__dirname, '..'), file);
    refused(render([rel]), /rab-ops: service must not exist/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- Owner decision 2026-11-12: docker-compose.production.yml pins the release digest as the image default, so OpenShip
// deploys without anyone typing CREWFLOW_IMAGE_TAG. Only a full sha256 digest; every other deploy file keeps no default.
const { allowsDefaultDigest, DEPLOY_COMBOS, PINNED_DIGEST_IMAGE_REF } = require('./compose-one-image.cjs');
const DIGEST = `sha256:${'d7'.repeat(32)}`;
const withDefault = (value) => `\${CREWFLOW_IMAGE_REPOSITORY:-adhin007/adolphus}@\${CREWFLOW_IMAGE_TAG:-${value}}`;
const allImages = (m, image) => {
  for (const n of ['rab-api', 'rab-worker']) m.services[n].image = image;
  return m;
};
const PROD = { allowDefaultDigest: true };

test('production.yml: a full sha256 release digest as the default passes', () => {
  assert.deepEqual(checkModel(allImages(good(), withDefault(DIGEST)), 'fixture', PROD), []);
  // The strict form (no default) is still accepted there too.
  assert.deepEqual(checkModel(good(), 'fixture', PROD), []);
});

test('DENIAL: any default on a file that must stay strict (docker-compose.image.yml and its overlays)', () => {
  refused(allImages(good(), withDefault(DIGEST)), /image must be .*no default/);
});

for (const [label, value] of [
  ['latest', 'latest'],
  ['a tag', 'v1.2.3'],
  ['a short digest', `sha256:${'d7'.repeat(16)}`],
  ['63 hex characters', `sha256:${'a'.repeat(63)}`],
  ['65 hex characters', `sha256:${'a'.repeat(65)}`],
  ['upper-case hex', `sha256:${'D7'.repeat(32)}`],
  ['another algorithm', `sha512:${'a'.repeat(128)}`],
  ['a bare hex string', 'a'.repeat(64)],
  ['an empty default', ''],
  ['a nested variable', '${OTHER_TAG}'],
]) {
  test(`DENIAL: production.yml default that is ${label}`, () => {
    const problems = checkModel(allImages(good(), withDefault(value)), "fixture", PROD);
    assert.ok(problems.some((p) => /rab-api: .*never a tag or latest/.test(p)), JSON.stringify(problems));
    // ...and with allowDefaultDigest off as well.
    refused(allImages(good(), withDefault(value)), /image must be/);
  });
}

test('DENIAL: production.yml default without the colon (`-`) or with `:+` / `?`', () => {
  for (const op of ['-', ':+', '?']) {
    const image = `\${CREWFLOW_IMAGE_REPOSITORY:-adhin007/adolphus}@\${CREWFLOW_IMAGE_TAG${op}${DIGEST}}`;
    const problems = checkModel(allImages(good(), image), 'fixture', PROD);
    assert.ok(problems.some((p) => /never a tag or latest/.test(p)), `${op}: ${JSON.stringify(problems)}`);
  }
});

test('DENIAL: rab-api and rab-worker with different default digests (one expression for both)', () => {
  const m = allImages(good(), withDefault(DIGEST));
  m.services['rab-worker'].image = withDefault(`sha256:${'e8'.repeat(32)}`);
  const problems = checkModel(m, 'fixture', PROD);
  assert.ok(problems.some((p) => /rab-worker: image differs from rab-api/.test(p)), JSON.stringify(problems));
});

test('DENIAL: one service with the default, another without (one expression for both)', () => {
  const m = good();
  m.services['rab-api'].image = withDefault(DIGEST);
  const problems = checkModel(m, 'fixture', PROD);
  assert.ok(problems.some((p) => /rab-worker: image differs from rab-api/.test(p)), JSON.stringify(problems));
});

test('only the production.yml combination may carry a default', () => {
  const allowed = DEPLOY_COMBOS.filter(allowsDefaultDigest).map((c) => c.join(' + '));
  assert.deepEqual(allowed, ['docker-compose.production.yml']);
  assert.equal(allowsDefaultDigest(['docker-compose.production.yml', 'docker-compose.local-db.yml']), false);
  assert.ok(PINNED_DIGEST_IMAGE_REF.test(withDefault(DIGEST)));
});

test('committed files: production.yml pins one full digest on every app service; image.yml has no default', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const imageLines = (text) => [...text.matchAll(/^\s+image:\s*(\S+@\$\{CREWFLOW_IMAGE_TAG[^}]*\})\s*$/gm)].map((m) => m[1]);
  const prod = imageLines(read('docker-compose.production.yml'));
  assert.equal(prod.length, 2, 'rab-api and rab-worker (rab-ops was removed)');
  assert.equal(new Set(prod).size, 1, 'the same expression on every app service');
  assert.ok(PINNED_DIGEST_IMAGE_REF.test(prod[0]), prod[0]);
  const image = imageLines(read('docker-compose.image.yml'));
  assert.ok(image.length >= 2, 'the image compose app services');
  for (const line of image) {
    assert.ok(!/CREWFLOW_IMAGE_TAG:?-/.test(line), `docker-compose.image.yml must keep no default: ${line}`);
    assert.ok(/CREWFLOW_IMAGE_TAG:\?/.test(line), `docker-compose.image.yml must require the digest: ${line}`);
  }
});

// ---- Security review of PR #124 (MEDIUM): a re-added operations container under ANOTHER name and profile (`rab-maint`,
// `profiles: ["maint"]`, reading .env.ops) passed every gate. Any profile-gated service in a deploy file is now refused.
test('DENIAL: a service with any non-empty profiles, whatever its name or profile', () => {
  for (const profiles of [['maint'], ['db'], ['ops', 'maint']]) {
    const m = good();
    m.services['rab-maint'] = { image: 'redis@sha256:x', profiles };
    refused(m, /rab-maint: has profiles/);
  }
  const m = good();
  m.services['rab-db'] = { image: 'postgres@sha256:x' }; // an always-on service is not refused by the profile rule
  assert.ok(!checkModel(m, 'fixture').some((p) => /has profiles/.test(p)));
});

/** A copy of a committed deploy file with `rab-maint` (profile "maint", reading .env.ops) added before `volumes:`. */
function withMaintService(file) {
  const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const weakened = src.replace(/\nvolumes:\n/, [
    '',
    '  rab-maint:',
    '    image: ${CREWFLOW_IMAGE_REPOSITORY:-adhin007/adolphus}@${CREWFLOW_IMAGE_TAG:?digest}',
    '    profiles: ["maint"]',
    '    env_file:',
    '      - .env.ops',
    '',
    'volumes:',
    '',
  ].join('\n'));
  assert.notEqual(weakened, src, `${file}: the fixture edit did not apply`);
  return weakened;
}

for (const file of ['docker-compose.production.yml', 'docker-compose.image.yml']) {
  test(`DENIAL (rendered): ${file} with a "maint"-profile service reading .env.ops fails the CLI render`, { skip: !dockerCompose() && 'docker compose not available' }, () => {
    const { render } = require('./compose-one-image.cjs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'one-image-maint-'));
    try {
      const copy = path.join(dir, file);
      fs.writeFileSync(copy, withMaintService(file));
      const problems = checkModel(render([path.relative(path.resolve(__dirname, '..'), copy)]), file, { allowDefaultDigest: file === 'docker-compose.production.yml' });
      assert.ok(problems.some((p) => /rab-maint: has profiles \["maint"\]/.test(p)), JSON.stringify(problems));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
