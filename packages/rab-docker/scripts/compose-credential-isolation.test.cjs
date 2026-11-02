'use strict';
/**
 * X1.6 (cleanup audit DEAD-08): compose-credential-isolation.cjs fails closed when its YAML parser is unavailable, instead
 * of skipping the env_file checks with a note.
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

function captureLog(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    return { result: fn(), lines };
  } finally {
    console.log = original;
  }
}

test('parser unavailable (the module cannot be loaded): a FAILED check and exit 1, never a skip', () => {
  const { result, lines } = captureLog(() =>
    isolation.main({
      loadYaml: () =>
        isolation.loadYamlParser(() => {
          throw Object.assign(new Error("Cannot find module 'yaml'"), { code: 'MODULE_NOT_FOUND' });
        }),
    }),
  );
  assert.equal(result, 1);
  assert.ok(lines.some((l) => /^\[compose-isolation\] FAIL the yaml parser/.test(l)), 'the parser failure is reported as a FAIL');
  assert.ok(!lines.some((l) => /not checked|note /.test(l)), 'no "skipped" note');
});

test('parser present but broken (no parse function): also a failure', () => {
  assert.equal(isolation.loadYamlParser(() => ({})), null);
  const { result } = captureLog(() => isolation.main({ loadYaml: () => isolation.loadYamlParser(() => ({ notParse: true })) }));
  assert.equal(result, 1);
});

test('the declared yaml devDependency loads from the repository root, with the exact version the root package.json pins', () => {
  const YAML = isolation.loadYamlParser();
  assert.ok(YAML && typeof YAML.parse === 'function', 'yaml resolves from the repository root');
  const root = require(path.resolve(__dirname, '../../../package.json'));
  assert.match(root.devDependencies.yaml ?? '', /^\d+\.\d+\.\d+$/, 'root devDependencies.yaml is an exact version');
  const installed = require(require.resolve('yaml/package.json', { paths: [path.resolve(__dirname, '../../..')] })).version;
  assert.equal(installed, root.devDependencies.yaml);
});

test('with the real parser, the env_file names are read from the committed compose files (the checks have input)', () => {
  const YAML = isolation.loadYamlParser();
  const production = isolation.rawEnvFiles('packages/rab-docker/docker-compose.production.yml', YAML);
  assert.ok((production['rab-migrate'] ?? []).some((f) => /(^|\/)\.env\.migrate$/.test(f)), 'rab-migrate names .env.migrate');
  assert.ok((production['rab-ops'] ?? []).some((f) => /(^|\/)\.env\.ops$/.test(f)), 'rab-ops names .env.ops');
  for (const runtime of ['rab-api', 'rab-worker']) {
    assert.ok(!(production[runtime] ?? []).some((f) => /\.env\.(migrate|ops)$/.test(f)), `${runtime} names neither`);
  }
});
