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
  'DOTENV_CONFIG_PATH',
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

const ADMIN_PW = 'x18-sentinel-admin-pw';
const ADMIN_SENTINEL = `postgres://x18_superuser:${ADMIN_PW}@127.0.0.1:15436/x18_ai_e2e`;
const APP_SENTINEL = 'postgres://x18_owner:x18-sentinel-app-pw@127.0.0.1:15436/x18_ai_e2e';
const ROLES = ['seed', 'api', 'worker', 'vite', 'playwright'];

/**
 * The superuser credential in every form the X1.8 security review showed reaching the children, under names no list knows.
 * Each must reach the seed only.
 */
const ADMIN_VARIANTS = {
  X18_UNLISTED_SUPERUSER_URL: ADMIN_SENTINEL,
  X18_ALIAS_SCHEME: ADMIN_SENTINEL.replace('postgres://', 'postgresql://'),
  X18_ALIAS_QUERY: `${ADMIN_SENTINEL}?sslmode=disable`,
  X18_ALIAS_LOCALHOST: ADMIN_SENTINEL.replace('127.0.0.1', 'localhost'),
  X18_ALIAS_KEYWORDS: `host=127.0.0.1 port=15436 user=x18_superuser password=${ADMIN_PW} dbname=x18_ai_e2e`,
  POSTGRES_PASSWORD: ADMIN_PW,
  POSTGRES_USER: 'x18_superuser',
};

/**
 * Runs run-ai-e2e.sh with stubbed node/curl/powershell.exe. Returns { status, stdout, spawned: { role: { NAME: value } },
 * cwdDotenv: { role: true when the child's working directory held a .env }, cwd: { role: working directory } }.
 */
function runHarnessWithStubs({ envLines = [], parentEnv = {}, envFileInWork = false } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'x18-ai-e2e-env-'));
  try {
    const bin = path.join(tmp, 'bin');
    const probe = path.join(tmp, 'probe');
    const work = path.join(tmp, 'work');
    fs.mkdirSync(bin);
    fs.mkdirSync(probe);
    fs.mkdirSync(work);
    // `node` stub: classifies the child by its script argument, writes its environment NUL-separated, its working directory
    // and whether that directory holds a .env, and prints the line the harness waits for. It never runs anything else.
    const nodeStub = [
      '#!/usr/bin/env bash',
      'role=other',
      'for a in "$@"; do case "$a" in',
      '  *seed-ai-e2e.ts) role=seed ;; *boot-api.e2e.ts) role=api ;; *boot-worker.e2e.ts) role=worker ;;',
      '  *vite/bin/vite.js) role=vite ;; *@playwright/test/cli.js) role=playwright ;;',
      'esac; done',
      'env -0 > "$X18_PROBE_DIR/$role.env"',
      'pwd > "$X18_PROBE_DIR/$role.cwd"',
      'if [ -e .env ]; then : > "$X18_PROBE_DIR/$role.dotenv"; fi',
      'case "$role" in seed) echo "[ai-e2e-seed] stub" ;; worker) echo "rab-ai consumer ready" ;; esac',
      'exit 0',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(bin, 'node'), nodeStub, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'curl'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    // The harness's Windows cleanup ends node.exe processes by command line; the stub keeps this test away from real ones.
    fs.writeFileSync(path.join(bin, 'powershell.exe'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    // review finding 3: the env file kept in AI_E2E_WORK as `.env` (ConfigModule / dotenv load <cwd>/.env).
    const envFile = envFileInWork ? path.join(work, '.env') : path.join(tmp, 'ai-e2e.env');
    const lines = [
      `TEST_DATABASE_URL=${APP_SENTINEL}`,
      `TEST_DATABASE_URL_UNPOOLED=${ADMIN_SENTINEL}`,
      'TEST_DATABASE_CREWFLOW_URL=postgres://x18_crewflow:x18-sentinel-crewflow-pw@127.0.0.1:15436/x18_ai_e2e',
      `TEST_DATABASE_WORKER_URL=${APP_SENTINEL}`,
      `MIGRATION_SECURITY_ADMIN_URL=${ADMIN_SENTINEL}`,
      'CREWFLOW_BOOTSTRAP_PASSWORD=x18-sentinel-bootstrap',
      'REDIS_URL=redis://127.0.0.1:16391/0',
      'APP_SECRET=x18-sentinel-app-secret-0123456789abcdef',
      ...envLines,
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
    for (const name of Object.keys(env)) {
      if ([...RUNTIME_STRIPPED, ...CLIENT_ONLY_STRIPPED].includes(name) || /^(PG|POSTGRES_|X18_)/.test(name)) delete env[name];
    }
    Object.assign(env, parentEnv, { X18_PROBE_DIR: bashPath(probe) });
    const result = spawnSync('bash', [bashPath(HARNESS)], { env, encoding: 'utf8', timeout: 90_000 });
    const spawned = {};
    const cwdDotenv = {};
    const cwd = {};
    // Every child the harness started, not only the five known ones (review finding 5): an unknown one is a failure below.
    for (const file of fs.readdirSync(probe).filter((f) => f.endsWith('.env'))) {
      const role = file.slice(0, -'.env'.length);
      spawned[role] = Object.fromEntries(
        fs
          .readFileSync(path.join(probe, file), 'utf8')
          .split('\0')
          .filter(Boolean)
          .map((entry) => [entry.slice(0, entry.indexOf('=')), entry.slice(entry.indexOf('=') + 1)]),
      );
      cwdDotenv[role] = fs.existsSync(path.join(probe, `${role}.dotenv`));
      cwd[role] = fs.readFileSync(path.join(probe, `${role}.cwd`), 'utf8').trim();
    }
    return { status: result.status, stdout: String(result.stdout ?? ''), spawned, cwdDotenv, cwd, work: bashPath(work) };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Names whose value holds the planted admin password (raw), or a planted admin variant value. Names only, never values. */
function holdingAdmin(vars, needles = [ADMIN_PW]) {
  return Object.keys(vars).filter((name) => needles.some((needle) => vars[name].includes(needle)));
}

function assertOnlySeedHoldsAdmin(run, needles) {
  assert.equal(run.status, 0, `harness failed (exit ${run.status}); stdout tail: ${run.stdout.slice(-400)}`);
  assert.deepEqual(Object.keys(run.spawned).sort(), [...ROLES].sort(), 'the harness spawned exactly the five known children (no role=other)');
  // Control: the seed is the one child that keeps the admin connection (fixtures, the disposable-marker proof).
  assert.equal(run.spawned.seed.TEST_DATABASE_URL_UNPOOLED, ADMIN_SENTINEL, 'the seed keeps TEST_DATABASE_URL_UNPOOLED');
  assert.equal(run.spawned.seed.PG_DATABASE_URL, undefined, 'the seed is started without PG_DATABASE_URL');
  for (const role of Object.keys(run.spawned).filter((r) => r !== 'seed')) {
    const vars = run.spawned[role];
    assert.deepEqual(holdingAdmin(vars, needles), [], `${role} child holds the superuser credential (names only)`);
    assert.deepEqual(RUNTIME_STRIPPED.filter((name) => name in vars), [], `${role} child inherited a stripped name`);
    assert.deepEqual(Object.keys(vars).filter((name) => /^PG[A-Z0-9]*$|^POSTGRES_/.test(name)), [], `${role} child holds a libpq PG* or POSTGRES_* name`);
  }
  for (const role of ['api', 'worker']) {
    assert.equal(run.spawned[role].PG_DATABASE_URL, APP_SENTINEL, `${role} child connects through the restricted PG_DATABASE_URL only`);
    assert.equal(run.spawned[role].NODE_ENV, 'test');
  }
  for (const role of ['vite', 'playwright']) {
    const vars = run.spawned[role];
    assert.deepEqual(Object.keys(vars).filter((name) => vars[name].includes('x18-sentinel')), [], `${role} child holds a database URL or secret (names only)`);
  }
}

test('X1.8: the real run-ai-e2e.sh spawns no child but the seed with the superuser URL (asserted on each spawned env)', () => {
  assertOnlySeedHoldsAdmin(runHarnessWithStubs({ envLines: [`X18_UNLISTED_SUPERUSER_URL=${ADMIN_SENTINEL}`] }));
});

test('X1.8 review finding 2: other forms of the superuser credential (scheme, query, localhost, keywords, POSTGRES_*, PGPASSWORD) reach the seed only', () => {
  const run = runHarnessWithStubs({
    envLines: Object.entries(ADMIN_VARIANTS).map(([name, value]) => `${name}=${value}`),
    parentEnv: { PGPASSWORD: ADMIN_PW, PGUSER: 'x18_superuser', PGHOST: '127.0.0.1' },
  });
  assertOnlySeedHoldsAdmin(run);
  // Control: the variants really were in the harness's environment (the seed, started without the strip, sees them).
  for (const name of [...Object.keys(ADMIN_VARIANTS), 'PGPASSWORD']) assert.ok(name in run.spawned.seed, `control: the seed sees ${name}`);
});

test('X1.8 review finding 2: a percent-encoded admin password is matched raw and decoded', () => {
  const encodedPw = 'x18%40sentinel%2Fadm%21n';
  const decodedPw = 'x18@sentinel/adm!n';
  const admin = `postgres://x18_superuser:${encodedPw}@127.0.0.1:15436/x18_ai_e2e`;
  const run = runHarnessWithStubs({
    envLines: [`TEST_DATABASE_URL_UNPOOLED=${admin}`, `MIGRATION_SECURITY_ADMIN_URL=${admin}`, `X18_RAW_PW=${decodedPw}`, `X18_ENCODED_PW=${encodedPw}`],
  });
  assert.equal(run.status, 0, `harness failed (exit ${run.status})`);
  for (const role of Object.keys(run.spawned).filter((r) => r !== 'seed')) {
    assert.deepEqual(holdingAdmin(run.spawned[role], [encodedPw, decodedPw]), [], `${role} child holds the admin password (names only)`);
  }
  assert.ok('X18_RAW_PW' in run.spawned.seed && 'X18_ENCODED_PW' in run.spawned.seed, 'control: the seed sees both');
});

test('X1.8 re-review: source password raw, copy percent-encoded (e.g. x18%2Dsentinel%2Dadmin%2Dpw) reaches the seed only', () => {
  const encodedCopy = ADMIN_PW.split('-').join('%2D');
  const run = runHarnessWithStubs({ envLines: [`X18_ENCODED_COPY=${encodedCopy}`, `X18_ENCODED_URL=postgres://x18_superuser:${encodedCopy}@127.0.0.1:15436/x18_ai_e2e`] });
  assertOnlySeedHoldsAdmin(run);
  for (const role of Object.keys(run.spawned).filter((r) => r !== 'seed')) {
    assert.ok(!('X18_ENCODED_COPY' in run.spawned[role]) && !('X18_ENCODED_URL' in run.spawned[role]), `${role} child holds the encoded copy`);
  }
  assert.ok('X18_ENCODED_COPY' in run.spawned.seed && 'X18_ENCODED_URL' in run.spawned.seed, 'control: the seed sees both');
});

test('X1.8 re-review: a name bash cannot use as a variable (ADMIN.URL) holding the superuser URL reaches the seed only', () => {
  const run = runHarnessWithStubs({ parentEnv: { 'ADMIN.URL': ADMIN_SENTINEL, 'X18.PW': ADMIN_PW } });
  // Control: bash passes such names through to its children, so without the strip they would arrive.
  assert.ok('ADMIN.URL' in run.spawned.seed && 'X18.PW' in run.spawned.seed, 'control: the seed inherits the bash-invalid names');
  assertOnlySeedHoldsAdmin(run);
  for (const role of Object.keys(run.spawned).filter((r) => r !== 'seed')) {
    assert.ok(!('ADMIN.URL' in run.spawned[role]) && !('X18.PW' in run.spawned[role]), `${role} child holds a bash-invalid admin name`);
  }
});

test('X1.8: a short admin password (fewer than 8 characters) is not substring-matched, and "postgres" never matches a URL scheme', () => {
  const script = (adminPw) =>
    [
      'set -euo pipefail',
      `source "${bashPath(RUNTIME_ENV)}"`,
      `export TEST_DATABASE_URL_UNPOOLED='postgres://su:${adminPw}@127.0.0.1:1/x'`,
      "export PG_DATABASE_URL='postgres://owner:other-pw@127.0.0.1:1/x'",
      `export X18_HOLDS_PW='abc-${adminPw}-def'`,
      'ai_e2e_admin_value_aliases | sort | tr "\\n" " "',
    ].join('\n');
  const aliases = (adminPw) => {
    const result = spawnSync('bash', ['-c', script(adminPw)], { encoding: 'utf8' });
    assert.equal(result.status, 0);
    // Only the names this test plants (the inherited environment of the machine running the test is not under test here).
    return result.stdout.trim().split(' ').filter((name) => ['TEST_DATABASE_URL_UNPOOLED', 'PG_DATABASE_URL', 'X18_HOLDS_PW'].includes(name));
  };
  // 8+ characters: matched as a substring; the scheme of PG_DATABASE_URL does not count.
  assert.deepEqual(aliases('postgres'), ['TEST_DATABASE_URL_UNPOOLED', 'X18_HOLDS_PW']);
  // Fewer than 8: only the exact URL value is matched (substrings of a short password would strip unrelated values).
  assert.deepEqual(aliases('pw'), ['TEST_DATABASE_URL_UNPOOLED']);
});

test('X1.8: the harness refuses to start the API when the runtime URL itself carries the admin credential', () => {
  const run = runHarnessWithStubs({ envLines: [`TEST_DATABASE_URL=postgres://x18_owner:${ADMIN_PW}@127.0.0.1:15436/x18_ai_e2e`] });
  assert.equal(run.status, 2);
  assert.match(run.stdout, /refusing: PG_DATABASE_URL \(from TEST_DATABASE_URL\) holds the admin \/ superuser credential/);
  assert.deepEqual(Object.keys(run.spawned), [], 'nothing was started');
});

test('X1.8 review finding 3: an env file kept as AI_E2E_WORK/.env never reaches the API or Worker (fresh, empty working directory)', () => {
  const run = runHarnessWithStubs({ envFileInWork: true });
  assertOnlySeedHoldsAdmin(run);
  for (const role of ['api', 'worker']) {
    assert.equal(run.cwdDotenv[role], false, `${role} ran in a directory holding a .env`);
    assert.notEqual(run.cwd[role].replace(/\/$/, ''), run.work.replace(/\/$/, ''), `${role} ran in AI_E2E_WORK itself`);
    assert.match(run.cwd[role], /runtime-cwd\.[A-Za-z0-9]+$/);
  }
});
