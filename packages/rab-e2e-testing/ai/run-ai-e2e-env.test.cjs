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
 * 3. X1.8: runs the REAL run-ai-e2e.sh end to end with `node`, `curl` and `powershell.exe` replaced on PATH by stubs that
 *    record the environment each child was spawned with (seed, API, Worker, Vite, Playwright) and exit. Asserts on those
 *    spawned environments: the superuser URL reaches the seed only, under any name (including an alias the deny-list does
 *    not list), and the API and Worker get only the restricted PG_DATABASE_URL. Synthetic values only; nothing is printed.
 * Needs bash (Git Bash on Windows) and node; no database, no network.
 */
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
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
  assert.deepEqual(list('AI_E2E_STRIPPED_VALUE_SOURCES'), ['MIGRATION_SECURITY_ADMIN_URL', 'TEST_DATABASE_URL_UNPOOLED']);
});

test('X1.8: a name the deny-list does not know, holding the superuser URL, is stripped by value from both launchers', () => {
  const alias = { X18_ALIAS_OF_ADMIN_URL: planted.TEST_DATABASE_URL_UNPOOLED, X18_ALIAS_OF_MIGRATION_ADMIN: planted.MIGRATION_SECURITY_ADMIN_URL };
  const run = (launcher) => {
    const script = ['set -euo pipefail', `source "${bashPath(RUNTIME_ENV)}"`, `(${launcher} node -e "$PROBE")`].join('\n');
    const result = spawnSync('bash', ['-c', script], { env: { ...process.env, ...planted, ...alias, PROBE: NAMES_PROBE }, encoding: 'utf8' });
    assert.equal(result.status, 0, `bash launcher failed (exit ${result.status})`);
    return new Set(JSON.parse(result.stdout));
  };
  for (const launcher of ['ai_e2e_runtime_exec', 'ai_e2e_client_exec']) {
    const names = run(launcher);
    assert.ok(!names.has('X18_ALIAS_OF_ADMIN_URL') && !names.has('X18_ALIAS_OF_MIGRATION_ADMIN'), `${launcher} child inherited an admin-URL alias`);
  }
  // Control: a value that is NOT an admin value stays (PG_DATABASE_URL in the runtime child).
  assert.ok(run('ai_e2e_runtime_exec').has('PG_DATABASE_URL'));
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

// ---- 3. X1.8: the real harness, end to end, with the spawned environments recorded by PATH stubs.

const ADMIN_SENTINEL = 'postgres://x18_superuser:x18-sentinel-admin-pw@127.0.0.1:15436/x18_ai_e2e';
const APP_SENTINEL = 'postgres://x18_owner:x18-sentinel-app-pw@127.0.0.1:15436/x18_ai_e2e';
const ROLES = ['seed', 'api', 'worker', 'vite', 'playwright'];

/** Runs run-ai-e2e.sh with stubbed node/curl/powershell.exe; returns { role: { NAME: value } } for each spawned child. */
function runHarnessWithStubs() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'x18-ai-e2e-env-'));
  try {
    const bin = path.join(tmp, 'bin');
    const probe = path.join(tmp, 'probe');
    const work = path.join(tmp, 'work');
    fs.mkdirSync(bin);
    fs.mkdirSync(probe);
    // `node` stub: classifies the child by its script argument, writes its environment NUL-separated, and prints the line
    // the harness waits for (the seed log marker, the Worker ready line). It never runs anything else.
    const nodeStub = [
      '#!/usr/bin/env bash',
      'role=other',
      'for a in "$@"; do case "$a" in',
      '  *seed-ai-e2e.ts) role=seed ;; *boot-api.e2e.ts) role=api ;; *boot-worker.e2e.ts) role=worker ;;',
      '  *vite/bin/vite.js) role=vite ;; *@playwright/test/cli.js) role=playwright ;;',
      'esac; done',
      'env -0 > "$X18_PROBE_DIR/$role.env"',
      'case "$role" in seed) echo "[ai-e2e-seed] stub" ;; worker) echo "rab-ai consumer ready" ;; esac',
      'exit 0',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(bin, 'node'), nodeStub, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'curl'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    // The harness's Windows cleanup ends node.exe processes by command line; the stub keeps this test away from real ones.
    fs.writeFileSync(path.join(bin, 'powershell.exe'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    const envFile = path.join(tmp, 'ai-e2e.env');
    const lines = [
      `TEST_DATABASE_URL=${APP_SENTINEL}`,
      `TEST_DATABASE_URL_UNPOOLED=${ADMIN_SENTINEL}`,
      'TEST_DATABASE_CREWFLOW_URL=postgres://x18_crewflow:x18-sentinel-crewflow-pw@127.0.0.1:15436/x18_ai_e2e',
      `TEST_DATABASE_WORKER_URL=${APP_SENTINEL}`,
      `MIGRATION_SECURITY_ADMIN_URL=${ADMIN_SENTINEL}`,
      // A name no list knows, holding the superuser URL: only the value rule can catch it.
      `X18_UNLISTED_SUPERUSER_URL=${ADMIN_SENTINEL}`,
      'CREWFLOW_BOOTSTRAP_PASSWORD=x18-sentinel-bootstrap',
      'REDIS_URL=redis://127.0.0.1:16391/0',
      'APP_SECRET=x18-sentinel-app-secret-0123456789abcdef',
      '',
    ];
    fs.writeFileSync(envFile, lines.join('\n'));
    const env = {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
      AI_E2E_ENV: bashPath(envFile),
      AI_E2E_WORK: bashPath(work),
      AI_E2E_API_PORT: '49898',
      AI_E2E_WEB_PORT: '49899',
      X18_PROBE_DIR: bashPath(probe),
    };
    for (const name of [...RUNTIME_STRIPPED, ...CLIENT_ONLY_STRIPPED, 'X18_UNLISTED_SUPERUSER_URL']) delete env[name];
    const result = spawnSync('bash', [bashPath(HARNESS)], { env, encoding: 'utf8', timeout: 90_000 });
    assert.equal(result.status, 0, `harness failed (exit ${result.status}); stdout tail: ${String(result.stdout ?? '').slice(-400)}`);
    const out = {};
    for (const role of ROLES) {
      const file = path.join(probe, `${role}.env`);
      assert.ok(fs.existsSync(file), `the harness never spawned the ${role} child`);
      out[role] = Object.fromEntries(
        fs
          .readFileSync(file, 'utf8')
          .split('\0')
          .filter(Boolean)
          .map((entry) => [entry.slice(0, entry.indexOf('=')), entry.slice(entry.indexOf('=') + 1)]),
      );
    }
    return out;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('X1.8: the real run-ai-e2e.sh spawns no child but the seed with the superuser URL (asserted on each spawned env)', () => {
  const spawned = runHarnessWithStubs();
  const holdingAdmin = (vars) => Object.keys(vars).filter((name) => vars[name].includes('x18-sentinel-admin-pw'));

  // Control: the seed is the one child that keeps the admin connection (fixtures, the disposable-marker proof).
  assert.equal(spawned.seed.TEST_DATABASE_URL_UNPOOLED, ADMIN_SENTINEL, 'the seed keeps TEST_DATABASE_URL_UNPOOLED');
  assert.equal(spawned.seed.PG_DATABASE_URL, undefined, 'the seed is started without PG_DATABASE_URL');

  for (const role of ['api', 'worker']) {
    const vars = spawned[role];
    assert.deepEqual(holdingAdmin(vars), [], `${role} child holds the superuser URL (names only)`);
    assert.deepEqual(RUNTIME_STRIPPED.filter((name) => name in vars), [], `${role} child inherited a stripped name`);
    assert.equal(vars.PG_DATABASE_URL, APP_SENTINEL, `${role} child connects through the restricted PG_DATABASE_URL only`);
    assert.equal(vars.NODE_ENV, 'test');
  }
  for (const role of ['vite', 'playwright']) {
    const vars = spawned[role];
    const secrets = Object.keys(vars).filter((name) => vars[name].includes('x18-sentinel'));
    assert.deepEqual(secrets, [], `${role} child holds a database URL or secret (names only)`);
  }
});
