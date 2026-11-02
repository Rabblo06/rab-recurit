'use strict';
/**
 * X1.3 / audit DBT-12 regression: the AI e2e harness (run-ai-e2e.sh) must not hand the test superuser URL (or any other
 * TEST_* login, role bootstrap password or command authority) to the API, the Worker, Vite or Playwright. Only the seed
 * keeps the admin connection.
 *
 *   node --test packages/rab-e2e-testing/ai/run-ai-e2e-env.test.cjs
 *
 * 1. Runs the harness's OWN launch functions (runtime-env.sh, sourced exactly as run-ai-e2e.sh sources it) around a node
 *    child that reports the NAMES in its environment, with every stripped name planted in the parent shell. Asserts the
 *    names are absent in the child (and, as a control, present without the wrapper). Values are synthetic and never printed:
 *    the child reports names only.
 * 2. Asserts run-ai-e2e.sh starts the API and the Worker only through ai_e2e_runtime_exec, and Vite and Playwright only
 *    through ai_e2e_client_exec, so the functions under test are the ones the harness really uses.
 * Needs bash (Git Bash on Windows) and node; no database, no network.
 */
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const HERE = __dirname;
const RUNTIME_ENV = path.join(HERE, 'runtime-env.sh');
const HARNESS = path.join(HERE, 'run-ai-e2e.sh');

const RUNTIME_STRIPPED = [
  'TEST_DATABASE_URL',
  'TEST_DATABASE_URL_UNPOOLED',
  'TEST_DATABASE_CREWFLOW_URL',
  'TEST_DATABASE_WORKER_URL',
  'MIGRATION_SECURITY_ADMIN_URL',
  'CREWFLOW_BOOTSTRAP_PASSWORD',
  'CREWFLOW_APP_BOOTSTRAP_PASSWORD',
  'CREWFLOW_WORKER_BOOTSTRAP_PASSWORD',
  'CREWFLOW_MIGRATOR_PASSWORD',
  'DATABASE_URL',
  'DATABASE_URL_UNPOOLED',
  'DATABASE_DIRECT_URL',
  'DB_TARGET',
  'ALLOW_PRODUCTION_DB_COMMANDS',
];
const CLIENT_ONLY_STRIPPED = ['PG_DATABASE_URL', 'APP_SECRET'];

// Synthetic values (never credentials, never printed).
const planted = Object.fromEntries(
  [...RUNTIME_STRIPPED, ...CLIENT_ONLY_STRIPPED].map((name) => [name, `postgres://x1-sentinel-${name.toLowerCase()}@127.0.0.1:1/never`]),
);

// The child prints only the sorted NAMES of its environment, as JSON.
const NAMES_PROBE = `process.stdout.write(JSON.stringify(Object.keys(process.env).sort()))`;

function bashPath(p) {
  // Git Bash on Windows reads C:/... paths; forward slashes work on every platform.
  return p.replace(/\\/g, '/');
}

/** Runs `<launcher> node -e <probe>` in bash with the planted environment; returns the child's variable names. */
function childNames(launcher) {
  const script = [
    'set -euo pipefail',
    `source "${bashPath(RUNTIME_ENV)}"`,
    `(${launcher ? `${launcher} ` : 'exec '}node -e "$PROBE")`,
  ].join('\n');
  const result = spawnSync('bash', ['-c', script], {
    env: { ...process.env, ...planted, PROBE: NAMES_PROBE },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `bash launcher failed (exit ${result.status}); stderr length ${String(result.stderr ?? '').length}`);
  return new Set(JSON.parse(result.stdout));
}

test('control: without a launcher function the child inherits every planted name (the probe can see them)', () => {
  const names = childNames(null);
  for (const name of [...RUNTIME_STRIPPED, ...CLIENT_ONLY_STRIPPED]) assert.ok(names.has(name), `${name} should be inherited by a plain child`);
});

test('ai_e2e_runtime_exec (API, Worker): no test superuser URL, TEST_* login, bootstrap password or command authority', () => {
  const names = childNames('ai_e2e_runtime_exec');
  const leaked = RUNTIME_STRIPPED.filter((name) => names.has(name));
  assert.deepEqual(leaked, [], `runtime child inherited: ${leaked.join(', ')}`);
  // The API and the Worker connect through PG_DATABASE_URL (the restricted login) and need APP_SECRET: kept.
  assert.ok(names.has('PG_DATABASE_URL') && names.has('APP_SECRET'), 'the runtime child keeps PG_DATABASE_URL and APP_SECRET');
});

test('ai_e2e_client_exec (Vite, Playwright): additionally no PG_DATABASE_URL and no APP_SECRET', () => {
  const names = childNames('ai_e2e_client_exec');
  const leaked = [...RUNTIME_STRIPPED, ...CLIENT_ONLY_STRIPPED].filter((name) => names.has(name));
  assert.deepEqual(leaked, [], `client child inherited: ${leaked.join(', ')}`);
});

test('runtime-env.sh strips exactly the names this test plants (no silent shrink of the list)', () => {
  const src = fs.readFileSync(RUNTIME_ENV, 'utf8');
  const list = (name) => {
    const m = new RegExp(`${name}=\\(([^)]*)\\)`).exec(src);
    assert.ok(m, `${name} array not found`);
    return m[1].split(/\s+/).filter(Boolean).sort();
  };
  assert.deepEqual(list('AI_E2E_STRIPPED_NAMES'), [...RUNTIME_STRIPPED].sort());
  assert.deepEqual(list('AI_E2E_CLIENT_STRIPPED_NAMES'), [...CLIENT_ONLY_STRIPPED].sort());
});

test('run-ai-e2e.sh starts the API and Worker through ai_e2e_runtime_exec and Vite and Playwright through ai_e2e_client_exec', () => {
  const lines = fs.readFileSync(HARNESS, 'utf8').split('\n');
  assert.ok(lines.some((l) => /^source "\$ROOT\/packages\/rab-e2e-testing\/ai\/runtime-env\.sh"$/.test(l)), 'the harness sources runtime-env.sh');
  const launchOf = (marker) => {
    const hits = lines.filter((l) => l.includes(marker) && !l.trimStart().startsWith('#'));
    assert.equal(hits.length, 1, `exactly one launch line for ${marker}`);
    return hits[0];
  };
  assert.match(launchOf('boot-api.e2e.ts'), /ai_e2e_runtime_exec "\$\{TS_NODE\[@\]\}"/);
  assert.match(launchOf('boot-worker.e2e.ts'), /ai_e2e_runtime_exec "\$\{TS_NODE\[@\]\}"/);
  assert.match(launchOf('vite/bin/vite.js'), /ai_e2e_client_exec node /);
  assert.match(launchOf('@playwright/test/cli.js'), /ai_e2e_client_exec node /);
  // No other process start that could bypass the functions: the only plain `exec` / `node` starts left are the seed's.
  const bare = lines.filter((l) => /\bexec\s+("\$\{TS_NODE|node\b)/.test(l));
  assert.deepEqual(bare, [], 'no bare exec of a node child');
  const seed = lines.filter((l) => l.includes('seed-ai-e2e.ts'));
  assert.ok(seed.length >= 1, 'the seed still runs (it keeps the admin connection)');
});
