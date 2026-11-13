'use strict';
/**
 * X1.9 (S10 / DEAD-08): compose-credential-isolation.cjs fails closed when its YAML parser is unavailable, instead of
 * skipping the env_file checks with a note and exiting 0.
 *
 *   node --test packages/rab-docker/scripts/compose-credential-isolation.test.cjs
 *
 * No docker needed: the parser check runs (and refuses) before docker compose is called; the positive cases parse the
 * committed compose files directly.
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');

const isolation = require('./compose-credential-isolation.cjs');

const REPO = path.resolve(__dirname, '../../..');

function captureOutput(fn) {
  const lines = [];
  const original = { log: console.log, error: console.error };
  console.log = (...args) => lines.push(args.join(' '));
  console.error = (...args) => lines.push(args.join(' '));
  try {
    return { result: fn(), lines };
  } finally {
    console.log = original.log;
    console.error = original.error;
  }
}

const throwingRequire = () => {
  throw Object.assign(new Error("Cannot find module 'yaml'"), { code: 'MODULE_NOT_FOUND' });
};

test('parser unavailable (the module cannot be loaded): a FAILED check and exit 1, never a skip', () => {
  const dockerCalls = [];
  const recordingExec = (...args) => {
    dockerCalls.push(args);
    throw new Error('docker must not be called when the parser is missing');
  };
  const { result, lines } = captureOutput(() =>
    isolation.main({ loadYaml: () => isolation.loadYamlParser(throwingRequire), execFileSync: recordingExec }),
  );
  assert.equal(result, 1);
  assert.ok(lines.some((l) => /^\[compose-isolation\] FAIL the yaml parser/.test(l)), 'the parser failure is reported as a FAIL');
  assert.ok(lines.some((l) => /1 check\(s\) failed/.test(l)), 'the summary counts the failure');
  assert.ok(!lines.some((l) => /not checked|note |all checks passed/.test(l)), 'no "skipped" note and no pass summary');
  assert.equal(dockerCalls.length, 0, 'refuses before docker is consulted (no docker call at all)');
});

test('parser present but broken (no parse function): also a failure', () => {
  assert.equal(isolation.loadYamlParser(() => ({})), null);
  const { result } = captureOutput(() => isolation.main({ loadYaml: () => isolation.loadYamlParser(() => ({ notParse: true })) }));
  assert.equal(result, 1);
});

test('the declared yaml devDependency loads from the repository root, with the exact version the root package.json pins', () => {
  const YAML = isolation.loadYamlParser();
  assert.ok(YAML && typeof YAML.parse === 'function', 'yaml resolves from the repository root');
  const root = require(path.join(REPO, 'package.json'));
  assert.match(root.devDependencies?.yaml ?? '', /^\d+\.\d+\.\d+$/, 'root devDependencies.yaml is declared with an exact version');
  const installed = require(require.resolve('yaml/package.json', { paths: [REPO] })).version;
  assert.equal(installed, root.devDependencies.yaml);
});

test('with the real parser, the env_file names are read from the committed compose files (the checks have input)', () => {
  const YAML = isolation.loadYamlParser();
  const names = (files, re) => (files ?? []).some((f) => re.test(f));
  const MIGRATE = /(^|\/)\.env\.migrate$/;
  const OPS = /(^|\/)\.env\.ops$/;
  for (const rel of ['packages/rab-docker/docker-compose.production.yml', 'packages/rab-docker/docker-compose.local-build.yml']) {
    const raw = isolation.rawEnvFiles(rel, YAML);
    // rab-ops removal (PR 2): the operations container is gone and nothing names .env.ops.
    assert.ok(!('rab-ops' in raw), `${rel}: has no rab-ops service`);
    assert.ok(Object.values(raw).every((files) => !names(files, OPS)), `${rel}: nothing names .env.ops`);
    for (const runtime of ['rab-api', 'rab-worker']) {
      assert.ok(runtime in raw, `${rel}: ${runtime} is parsed`);
      assert.ok(!names(raw[runtime], MIGRATE) && !names(raw[runtime], OPS), `${rel}: ${runtime} names neither`);
    }
    assert.ok(Object.values(raw).every((files) => !names(files, MIGRATE)), `${rel}: nothing names .env.migrate (O3)`);
  }
  // Part F2 (X2.3): dev and QA are on Part A's setup (bundled db + db-setup, the API migrates on start): no migrate service.
  for (const rel of ['packages/rab-docker/docker-compose.yml', 'packages/rab-docker/docker-compose.qa.yml']) {
    const raw = isolation.rawEnvFiles(rel, YAML);
    assert.ok(!('migrate' in raw), `${rel}: has no migrate service`);
    for (const svc of ['db', 'db-setup']) assert.ok(svc in raw, `${rel}: ${svc} is parsed`);
    assert.ok(Object.values(raw).every((files) => !names(files, MIGRATE) && !names(files, OPS)), `${rel}: nothing names .env.migrate or .env.ops`);
    for (const runtime of ['server', 'worker']) assert.ok(runtime in raw, `${rel}: ${runtime} is parsed`);
  }
});

// ---- Part F2 (X2.3): the Part A contract (dbSetupContractChecks) and the bundled-db parity (bundledDbParityChecks).
const failedLabels = (checks) => checks.filter(([ok]) => !ok).map(([, label]) => label);
const refusedBy = (checks, re) => {
  const f = failedLabels(checks);
  assert.ok(f.some((l) => re.test(l)), `expected a failed check matching ${re}; failed: ${JSON.stringify(f)}`);
};
const vol = (source, target, readOnly) => ({ type: 'volume', source, target, ...(readOnly ? { read_only: true } : {}) });
const partA = () => ({
  db: { image: 'postgres@sha256:x', environment: { POSTGRES_PASSWORD: 'p' } },
  'db-setup': {
    entrypoint: ['./db-setup.sh'],
    restart: 'no',
    user: '1000:1000',
    read_only: true,
    environment: { PG_DATABASE_URL: 'postgresql://postgres:p@db:5432/crewflow?sslmode=verify-full', NODE_ENV: 'development' },
    volumes: [vol('crewflow-db-ca', '/run/crewflow/db-ca', true), vol('crewflow-db-target', '/run/crewflow/db-target', false)],
    depends_on: { db: { condition: 'service_healthy' } },
  },
  server: {
    entrypoint: ['./api-prestart.sh'],
    environment: { PG_DATABASE_URL: '', NODE_ENV: 'development' },
    volumes: [vol('crewflow-db-ca', '/run/crewflow/db-ca', true), vol('crewflow-db-target', '/run/crewflow/db-target', true)],
    depends_on: { 'db-setup': { condition: 'service_completed_successfully' } },
  },
  worker: {
    entrypoint: ['./worker-start.sh'],
    environment: { PG_DATABASE_URL: '' },
    volumes: [vol('crewflow-db-target', '/run/crewflow/db-target', true)],
  },
});
const RUNTIME = ['server', 'worker'];

test('Part F2: the Part A contract shape passes every dbSetupContractChecks check', () => {
  assert.deepEqual(failedLabels(isolation.dbSetupContractChecks('f.yml', partA(), RUNTIME)), []);
});

test('DENIAL (Part F2): a missing db-setup, or one that is not the one-shot ./db-setup.sh shape, fails', () => {
  const none = partA();
  delete none['db-setup'];
  refusedBy(isolation.dbSetupContractChecks('f.yml', none, RUNTIME), /has the one-shot db-setup service/);
  const cases = [
    [(s) => { s['db-setup'].entrypoint = ['node', 'x.js']; }, /db-setup runs exactly \.\/db-setup\.sh/],
    [(s) => { s['db-setup'].command = ['sh']; }, /db-setup runs exactly \.\/db-setup\.sh/],
    [(s) => { s['db-setup'].restart = 'unless-stopped'; }, /db-setup restart is "no"/],
    [(s) => { s['db-setup'].ports = [{ target: 5432 }]; }, /db-setup publishes no port/],
    [(s) => { delete s['db-setup'].depends_on; }, /db-setup starts after a healthy db/],
    [(s) => { s['db-setup'].volumes[1].read_only = true; }, /db-setup mounts the target volume writable/],
    [(s) => { s['db-setup'].volumes[0].read_only = false; }, /db-setup mounts the db CA read-only/],
    [(s) => { s['db-setup'].environment.APP_SECRET = ''; }, /db-setup has no APP_SECRET/],
    [(s) => { s['db-setup'].user = '0:0'; }, /db-setup runs as 1000:1000/],
  ];
  for (const [edit, re] of cases) {
    const s = partA();
    edit(s);
    refusedBy(isolation.dbSetupContractChecks('f.yml', s, RUNTIME), re);
  }
});

test('DENIAL (Part F2): an app service with a database URL, the wrong PID 1, compose init or a writable target fails', () => {
  for (const name of RUNTIME) {
    for (const [edit, re] of [
      [(s) => { s[name].environment.PG_DATABASE_URL = 'postgres://crewflow_owner:x@db:5432/crewflow'; }, new RegExp(`${name} has no PG_DATABASE_URL value`)],
      [(s) => { s[name].environment.SOME_URL = 'postgresql://u:p@db/x'; }, new RegExp(`${name} carries no database URL in any variable \\(found in SOME_URL\\)`)],
      [(s) => { s[name].entrypoint = ['/sbin/tini', '--']; s[name].command = ['node', 'main.js']; }, new RegExp(`${name} runs \\./(api-prestart|worker-start)\\.sh as PID 1`)],
      [(s) => { s[name].init = true; }, new RegExp(`${name} has no compose init`)],
      [(s) => { s[name].volumes = s[name].volumes.map((v) => (v.target === '/run/crewflow/db-target' ? { ...v, read_only: false } : v)); }, new RegExp(`${name} mounts db-setup's target volume read-only`)],
    ]) {
      const s = partA();
      edit(s);
      const checks = isolation.dbSetupContractChecks('f.yml', s, RUNTIME);
      refusedBy(checks, re);
      assert.ok(!JSON.stringify(failedLabels(checks)).includes('crewflow_owner:x'), 'a failed-check label never prints a value');
    }
  }
  const s = partA();
  delete s.server.depends_on;
  refusedBy(isolation.dbSetupContractChecks('f.yml', s, RUNTIME), /server starts only after db-setup completed successfully/);
});

test('DENIAL (Part F2): a dev/QA db that renders differently from production (or is missing) fails the parity check', () => {
  const prod = { image: 'postgres@sha256:x', command: ['postgres', '-c', 'ssl=on'], user: '999:999', read_only: true };
  assert.deepEqual(failedLabels(isolation.bundledDbParityChecks('dev.yml', { db: structuredClone(prod) }, prod)), []);
  refusedBy(isolation.bundledDbParityChecks('dev.yml', { db: { ...prod, command: ['postgres'] } }, prod), /differs in command/);
  refusedBy(isolation.bundledDbParityChecks('dev.yml', { db: { ...prod, ports: [{ target: 5432 }] } }, prod), /differs in ports/);
  refusedBy(isolation.bundledDbParityChecks('dev.yml', { db: { ...prod, read_only: false } }, prod), /differs in read_only/);
  refusedBy(isolation.bundledDbParityChecks('dev.yml', {}, prod), /has a bundled db rendered like/);
  refusedBy(isolation.bundledDbParityChecks('dev.yml', { db: prod }, null), /has a bundled db rendered like/);
});

test('a compose file the parser cannot read is a FAILED check, not a skip', (t) => {
  const brokenParser = {
    parse: () => {
      throw new Error('Nested mappings are not allowed in compact mappings');
    },
  };
  const { result, lines } = captureOutput(() => isolation.main({ loadYaml: () => brokenParser }));
  // Exit 2 = docker compose missing on this machine (the real check then exits 2 too; CI has docker compose).
  if (result === 2) {
    t.skip('docker compose is not available here');
    return;
  }
  assert.equal(result, 1);
  for (const [rel] of isolation.FILES) {
    assert.ok(lines.some((l) => l.startsWith(`[compose-isolation] FAIL ${rel}: the committed YAML parses`)), `${rel}: a parse FAIL is reported`);
  }
  assert.ok(!lines.some((l) => /all checks passed/.test(l)));
});

test('a parser that returns no services is a FAILED input check for every file (the env_file checks would have no input)', (t) => {
  const emptyParser = { parse: () => ({ services: {} }) };
  const { result, lines } = captureOutput(() => isolation.main({ loadYaml: () => emptyParser }));
  // Exit 2 = docker compose missing on this machine (the real check then exits 2 too; CI has docker compose).
  if (result === 2) {
    t.skip('docker compose is not available here');
    return;
  }
  assert.equal(result, 1);
  for (const [rel] of isolation.FILES) {
    assert.ok(
      lines.some((l) => l.startsWith(`[compose-isolation] FAIL ${rel}: the parsed YAML lists every rendered service`)),
      `${rel}: the empty parse is reported as a FAIL`,
    );
  }
  assert.ok(!lines.some((l) => /all checks passed/.test(l)));
});
