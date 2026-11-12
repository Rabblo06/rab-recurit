'use strict';
// Self-tests for compose-one-image.cjs: the denial cases first (owner decision 2026-11-11, "deploy exactly like Twenty").
//   node --test packages/rab-docker/scripts/compose-one-image.test.cjs
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { checkModel, checkRedisPrivate, render, DEPLOY_COMBOS, REDIS_ONLY_COMBOS } = require('./compose-one-image.cjs');

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
      'rab-ops': { image: IMG, profiles: ['ops'] },
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
  for (const n of ['rab-api', 'rab-worker', 'rab-ops']) m.services[n].image = 'adhin007/adolphus:${CREWFLOW_IMAGE_TAG}';
  refused(m, /rab-api: image must be/);
});

test('DENIAL: a hard-coded image (no variable) on one service', () => {
  const m = good();
  m.services['rab-worker'].image = `adhin007/adolphus@sha256:${'a'.repeat(64)}`;
  refused(m, /rab-worker: image must be/);
});

test('DENIAL: rab-ops on a different image', () => {
  const m = good();
  m.services['rab-ops'].image = 'adhin007/adolphus@${CREWFLOW_OPS_IMAGE_TAG}';
  refused(m, /rab-ops: image differs from rab-api/);
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

// X1.6 (owner decision 2026-11-12): Redis is protected by the private Compose network only, as in Twenty's
// packages/twenty-docker/docker-compose.yml (its `redis` service has no ports and no password). No deploy file may make it
// reachable from the host, in either port syntax, and a loopback bind is no exception.
const SHORT_PORTS = ['6379:6379', '127.0.0.1:6379:6379', '6379', '${CREWFLOW_REDIS_BIND:-127.0.0.1}:6379:6379', '0.0.0.0:16379:6379/tcp'];
const LONG_PORTS = [
  { mode: 'ingress', protocol: 'tcp', target: 6379, published: '6379' },
  { mode: 'ingress', protocol: 'tcp', target: 6379, published: '6379', host_ip: '127.0.0.1' },
  { mode: 'ingress', protocol: 'tcp', target: 6379 }, // no published port: Docker picks a random host port
];
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('X1.6: an empty ports list (e.g. `ports: !reset []`) on rab-redis passes', () => {
  const m = good();
  m.services['rab-redis'].ports = [];
  assert.deepEqual(checkModel(m, 'fixture'), []);
});

for (const entry of SHORT_PORTS) {
  test(`DENIAL (X1.6): rab-redis publishes a port, short syntax "${entry}"`, () => {
    const m = good();
    m.services['rab-redis'].ports = [entry];
    refused(m, new RegExp(`rab-redis: publishes a port \\(short syntax "${escapeRe(entry)}"\\)`));
  });
}

for (const entry of LONG_PORTS) {
  test(`DENIAL (X1.6): rab-redis publishes a port, long syntax ${JSON.stringify(entry)}`, () => {
    const m = good();
    m.services['rab-redis'].ports = [entry];
    refused(m, /rab-redis: publishes a port \(long syntax target 6379 -> /);
  });
}

test('DENIAL (X1.6): every published Redis port is reported, not only the first', () => {
  const m = good();
  m.services['rab-redis'].ports = ['6379:6379', LONG_PORTS[0]];
  const problems = checkModel(m, 'fixture').filter((p) => /rab-redis: publishes a port/.test(p));
  assert.equal(problems.length, 2, JSON.stringify(problems));
});

test('DENIAL (X1.6): rab-redis declares expose', () => {
  const m = good();
  m.services['rab-redis'].expose = ['6379'];
  refused(m, /rab-redis: declares expose \(6379\)/);
});

test('DENIAL (X1.6): rab-redis on the host network, or in another container\'s namespace', () => {
  for (const mode of ['host', 'service:rab-api', 'container:other']) {
    const m = good();
    m.services['rab-redis'].network_mode = mode;
    refused(m, new RegExp(`rab-redis: sets network_mode "${escapeRe(mode)}"`));
  }
});

test('DENIAL (X1.6): a renamed or second Redis gets the same rule (matched by name or image)', () => {
  const byImage = good();
  byImage.services.cache = { image: 'redis:7-alpine', ports: ['6380:6379'] };
  refused(byImage, /cache: publishes a port/);
  const byVariable = good();
  byVariable.services.cache = { image: '${CREWFLOW_REDIS_IMAGE:?pinned}', ports: [{ target: 6379, published: '6380' }] };
  refused(byVariable, /cache: publishes a port/);
  const byName = good();
  byName.services['redis-sessions'] = { image: 'valkey/valkey:8', expose: ['6379'] };
  refused(byName, /redis-sessions: declares expose/);
});

test('X1.6: the rule leaves rab-api\'s loopback port alone (only Redis is in scope)', () => {
  const m = good();
  m.services['rab-api'].ports = ['127.0.0.1:3000:3000'];
  assert.deepEqual(checkModel(m, 'fixture'), []);
});

test('DENIAL (X1.6): rab-redis missing (the rule must have something to check)', () => {
  const m = good();
  delete m.services['rab-redis'];
  refused(m, /rab-redis is missing/);
  assert.ok(checkRedisPrivate({ services: {} }, 'local-build').some((p) => /rab-redis is missing/.test(p)));
});

test('X1.6: checkRedisPrivate (the Redis-only rule for docker-compose.local-build.yml) refuses ports and ignores build sections', () => {
  const model = { services: { 'rab-redis': { image: 'redis:7-alpine', ports: ['6379:6379'] }, 'rab-api': { build: { context: '.' } } } };
  const problems = checkRedisPrivate(model, 'local-build');
  assert.equal(problems.length, 1, JSON.stringify(problems));
  assert.match(problems[0], /^local-build: rab-redis: publishes a port \(short syntax "6379:6379"\)/);
});

test('DENIAL (X1.6): host networking through `networks:` (list or map form), resolved in the top-level networks', () => {
  const byName = good();
  byName.services['rab-redis'].networks = ['hostnet'];
  byName.networks = { hostnet: { external: true, name: 'host' } };
  refused(byName, /rab-redis: joins network "hostnet", which is the host network/);
  const bareHost = good();
  bareHost.services['rab-redis'].networks = { host: null };
  refused(bareHost, /rab-redis: joins network "host", which is the host network/);
  for (const driver of ['host', 'macvlan', 'ipvlan']) {
    const m = good();
    m.services['rab-redis'].networks = { default: null, lan: null };
    m.networks = { default: { name: 'p_default' }, lan: { driver, name: 'p_lan' } };
    refused(m, new RegExp(`rab-redis: joins network "lan" with driver ${driver}`));
  }
});

test('X1.6: a private bridge network (the default, or a named bridge / overlay) passes', () => {
  const m = good();
  m.services['rab-redis'].networks = { default: null, backend: null, swarm: null };
  m.networks = { default: { name: 'p_default' }, backend: { driver: 'bridge', name: 'p_backend', internal: true }, swarm: { driver: 'overlay' } };
  assert.deepEqual(checkModel(m, 'fixture'), []);
});

test('DENIAL (X1.6): a Redis without "redis" in its name or image is found by command, entrypoint, health check or REDIS_URL', () => {
  const byCommand = good();
  byCommand.services['kv-cache'] = { image: `registry.example.com/team/kv@sha256:${'0'.repeat(64)}`, command: ['redis-server', '--port', '6379'], ports: ['6380:6379'] };
  refused(byCommand, /kv-cache: publishes a port/);
  const byEntrypoint = good();
  byEntrypoint.services.kv = { image: '${CACHE_IMAGE:?}', entrypoint: 'redis-server /etc/kv.conf', expose: ['6379'] };
  refused(byEntrypoint, /kv: declares expose/);
  const byHealthcheck = good();
  byHealthcheck.services.kv = { image: '${CACHE_IMAGE:?}', healthcheck: { test: ['CMD', 'redis-cli', 'ping'] }, network_mode: 'host' };
  refused(byHealthcheck, /kv: sets network_mode "host"/);
  for (const url of ['redis://cache:6379', 'rediss://cache:6380/0']) {
    const byUrl = good();
    byUrl.services['rab-worker'].environment = { ...byUrl.services['rab-worker'].environment, REDIS_URL: url };
    byUrl.services.cache = { image: '${CACHE_IMAGE:?}', ports: [{ target: 6379, published: '6380' }] };
    refused(byUrl, /cache: publishes a port/);
  }
  // Array-form environment is read too.
  const byArrayEnv = good();
  byArrayEnv.services['rab-api'].environment = ['CREWFLOW_MIGRATE_ON_START=true', 'REDIS_URL=redis://cache:6379'];
  byArrayEnv.services.cache = { image: '${CACHE_IMAGE:?}', ports: ['6380:6379'] };
  refused(byArrayEnv, /cache: publishes a port/);
});

test('X1.6: an uncommitted or unparsable REDIS_URL names no service (no false positive on the app itself)', () => {
  const m = good();
  m.services['rab-api'].environment = { ...m.services['rab-api'].environment, REDIS_URL: '${REDIS_URL:?}' };
  m.services['rab-api'].ports = ['127.0.0.1:3000:3000'];
  assert.deepEqual(checkModel(m, 'fixture'), []);
});

test('DENIAL (X1.6): another service in a Redis network namespace (network_mode service:<redis>)', () => {
  const m = good();
  m.services.sidecar = { image: 'alpine', network_mode: 'service:rab-redis', ports: ['6379:6379'] };
  refused(m, /sidecar: sets network_mode "service:rab-redis"/);
  const other = good();
  other.services.sidecar = { image: 'alpine', network_mode: 'service:rab-api' };
  assert.deepEqual(checkModel(other, 'fixture'), []);
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

// X1.6, rendered: an overlay on the REAL committed files, in both port syntaxes, through the same `docker compose config
// --no-interpolate` the CLI runs. Proves the gate refuses a real edit that publishes Redis, for
// docker-compose.production.yml (whose Redis has no password) and docker-compose.image.yml. A single file keeps a short
// entry as a string; merging files (Compose v5) normalises it to the long mapping, so the short overlay may render either way.
const OVERLAYS = {
  short: { lines: ['services:', '  rab-redis:', '    ports:', '      - "127.0.0.1:6379:6379"'], want: /rab-redis: publishes a port \((short syntax "127\.0\.0\.1:6379:6379"|long syntax target 6379 -> host 127\.0\.0\.1:6379)\)/, what: 'a short-syntax port' },
  long: { lines: ['services:', '  rab-redis:', '    ports:', '      - target: 6379', '        published: "6379"', '        host_ip: 127.0.0.1'], want: /rab-redis: publishes a port \(long syntax target 6379 -> host 127\.0\.0\.1:6379\)/, what: 'a long-syntax port' },
  expose: { lines: ['services:', '  rab-redis:', '    expose:', '      - "6379"'], want: /rab-redis: declares expose/, what: 'expose' },
  host: { lines: ['services:', '  rab-redis:', '    network_mode: host'], want: /rab-redis: sets network_mode "host"/, what: 'network_mode: host' },
  // Host networking through `networks:` (review finding on #111): an external network named `host`, or a macvlan / ipvlan
  // network, puts Redis on the host or the LAN without any `ports:` or `network_mode`.
  hostnet: { lines: ['services:', '  rab-redis:', '    networks: [hostnet]', 'networks:', '  hostnet:', '    external: true', '    name: host'], want: /rab-redis: joins network "hostnet", which is the host network/, what: 'an external network named host' },
  macvlan: { lines: ['services:', '  rab-redis:', '    networks: [default, lan]', 'networks:', '  lan:', '    driver: macvlan', '    driver_opts: { parent: eth0 }'], want: /rab-redis: joins network "lan" with driver macvlan/, what: 'a macvlan network' },
  ipvlan: { lines: ['services:', '  rab-redis:', '    networks: [default, lan]', 'networks:', '  lan:', '    driver: ipvlan', '    driver_opts: { parent: eth0 }'], want: /rab-redis: joins network "lan" with driver ipvlan/, what: 'an ipvlan network' },
  // A Redis that does not say "redis" in its name or image: found by its command, or as the app's REDIS_URL host.
  private: { lines: ['services:', '  kv-cache:', `    image: registry.example.com/team/kv@sha256:${'0'.repeat(64)}`, '    command: ["redis-server"]', '    ports: ["6380:6379"]'], want: /kv-cache: publishes a port/, what: 'a private-registry Redis (found by its command) with a port', service: 'kv-cache' },
  urlhost: { lines: ['services:', '  rab-api:', '    environment: { REDIS_URL: "redis://cache:6379" }', '  rab-worker:', '    environment: { REDIS_URL: "redis://cache:6379" }', '  cache:', '    image: ${CACHE_IMAGE:?}', '    ports: ["6380:6379"]'], want: /cache: publishes a port/, what: 'a ${CACHE_IMAGE} service named by REDIS_URL with a port', service: 'cache' },
  sidecar: { lines: ['services:', '  sidecar:', '    image: alpine', '    network_mode: "service:rab-redis"', '    ports: ["6379:6379"]'], want: /sidecar: sets network_mode "service:rab-redis"/, what: 'a sidecar in its network namespace' },
};
function withOverlay(kind, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'one-image-redis-'));
  try {
    const overlay = path.join(dir, `redis-${kind}.yml`);
    fs.writeFileSync(overlay, `${OVERLAYS[kind].lines.join('\n')}\n`);
    return fn(overlay);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const noCompose = !dockerCompose() && 'docker compose not available';

for (const base of ['docker-compose.production.yml', 'docker-compose.image.yml']) {
  test(`X1.6 (rendered): the committed ${base} passes the Redis rule`, { skip: noCompose }, () => {
    assert.deepEqual(checkRedisPrivate(render([base]), base), []);
  });
  for (const kind of Object.keys(OVERLAYS)) {
    test(`DENIAL (X1.6, rendered): ${base} + an overlay giving rab-redis ${OVERLAYS[kind].what}`, { skip: noCompose }, () => {
      withOverlay(kind, (overlay) => refused(render([base, overlay]), OVERLAYS[kind].want));
    });
  }
}

test('X1.6 (rendered): every committed deploy combination and local-build.yml still pass the Redis rule, with no network finding', { skip: noCompose }, () => {
  for (const combo of [...DEPLOY_COMBOS, ...REDIS_ONLY_COMBOS]) {
    const model = render(combo);
    assert.deepEqual(checkRedisPrivate(model, combo.join(' + ')), [], combo.join(' + '));
    assert.ok(model.services['rab-redis'], `${combo.join(' + ')}: rab-redis rendered`);
  }
});

test('DENIAL (X1.6, rendered): a single compose file keeps short-syntax Redis ports as strings, and each is refused', { skip: noCompose }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'one-image-redis-'));
  try {
    const file = path.join(dir, 'c.yml');
    fs.writeFileSync(file, ['services:', '  rab-redis:', '    image: redis:7-alpine', '    ports:', '      - "6379:6379"', '      - "${CREWFLOW_REDIS_BIND:-127.0.0.1}:6380:6379"', '      - "6379"', '      - target: 6379', '        published: "6381"', ''].join('\n'));
    const model = JSON.parse(execFileSync('docker', ['compose', '--project-directory', dir, '-f', file, 'config', '--no-interpolate', '--no-env-resolution', '--format', 'json'], { encoding: 'utf8' }));
    const problems = checkRedisPrivate(model, 'single');
    for (const re of [/short syntax "6379:6379"/, /short syntax "\$\{CREWFLOW_REDIS_BIND:-127\.0\.0\.1\}:6380:6379"/, /short syntax "6379"\)/, /long syntax target 6379 -> host 6381/]) {
      assert.ok(problems.some((p) => re.test(p)), `${re} not in ${JSON.stringify(problems)}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('DENIAL (X1.6, rendered): docker-compose.local-build.yml + a published Redis port fails the Redis-only rule', { skip: noCompose }, () => {
  assert.deepEqual(checkRedisPrivate(render(['docker-compose.local-build.yml']), 'local-build'), []);
  withOverlay('short', (overlay) => {
    const problems = checkRedisPrivate(render(['docker-compose.local-build.yml', overlay]), 'local-build');
    assert.ok(problems.some((p) => OVERLAYS.short.want.test(p)), JSON.stringify(problems));
  });
});
