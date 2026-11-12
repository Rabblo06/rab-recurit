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
    assert.ok(names(raw['rab-ops'], OPS), `${rel}: rab-ops names .env.ops`);
    for (const runtime of ['rab-api', 'rab-worker']) {
      assert.ok(runtime in raw, `${rel}: ${runtime} is parsed`);
      assert.ok(!names(raw[runtime], MIGRATE) && !names(raw[runtime], OPS), `${rel}: ${runtime} names neither`);
    }
    assert.ok(Object.values(raw).every((files) => !names(files, MIGRATE)), `${rel}: nothing names .env.migrate (O3)`);
  }
  for (const rel of ['packages/rab-docker/docker-compose.yml', 'packages/rab-docker/docker-compose.qa.yml']) {
    const raw = isolation.rawEnvFiles(rel, YAML);
    assert.ok(names(raw.migrate, MIGRATE), `${rel}: migrate names .env.migrate`);
    for (const runtime of ['server', 'worker']) {
      assert.ok(runtime in raw, `${rel}: ${runtime} is parsed`);
      assert.ok(!names(raw[runtime], MIGRATE), `${rel}: ${runtime} does not name .env.migrate`);
    }
  }
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
