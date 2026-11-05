'use strict';
/**
 * runtime-deps.cjs `check` — the H3 forbidden-package gate (review L-4: the image bans the whole `@swc/*` scope
 * with ONE exact exception, `--allow @swc/helpers`). Real temporary node_modules trees, the real CLI.
 *
 *   node --test packages/rab-docker/rab/test/runtime-deps.test.cjs
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'runtime-deps.cjs');
// The image's SWC arguments, exactly (O1: the one runtime-deps check in rab/Dockerfile).
const WORKER_ARGS = ['--forbid', '@swc/*', '@swc-node/*', '--allow', '@swc/helpers'];

/** A tree: { 'dir/name': packageJsonName } under <tmp>/node_modules, plus one scanned .js file that imports nothing. */
function tree(packages) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-deps-'));
  const nm = path.join(root, 'node_modules');
  fs.mkdirSync(nm);
  for (const [dir, name] of Object.entries(packages)) {
    const abs = path.join(nm, ...dir.split('/'));
    fs.mkdirSync(abs, { recursive: true });
    fs.writeFileSync(path.join(abs, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
  }
  const dist = path.join(root, 'dist');
  fs.mkdirSync(dist);
  fs.writeFileSync(path.join(dist, 'main.js'), "'use strict';\nmodule.exports = 1;\n");
  return { root, nm, dist };
}

function check(t, extra) {
  const r = spawnSync(process.execPath, [CLI, 'check', t.nm, '--scan', t.dist, ...extra], { encoding: 'utf8' });
  fs.rmSync(t.root, { recursive: true, force: true });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test('@swc/helpers alone passes under the scope ban with its exact exception', () => {
  const r = check(tree({ '@swc/helpers': '@swc/helpers', fontkit: 'fontkit' }), WORKER_ARGS);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /exact exceptions: @swc\/helpers/);
});

for (const pkg of ['@swc/core', '@swc/core-linux-x64-musl', '@swc/html', '@swc/html-linux-x64-musl', '@swc/css', '@swc/minifier', '@swc/wasm', '@swc/some-future-package']) {
  test(`${pkg} fails (the whole scope is banned, future packages included), even next to @swc/helpers`, () => {
    const r = check(tree({ '@swc/helpers': '@swc/helpers', [pkg]: pkg }), WORKER_ARGS);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, new RegExp(`forbidden package in the runtime image: node_modules/${pkg.replace('/', '\\/')} .* matches @swc/\\*`));
  });
}

test('a nested forbidden package under @swc/helpers is still found', () => {
  const r = check(tree({ '@swc/helpers': '@swc/helpers', '@swc/helpers/node_modules/@swc/core': '@swc/core' }), WORKER_ARGS);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /node_modules\/@swc\/helpers\/node_modules\/@swc\/core/);
});

test('a disguised package is not exempt: directory @swc/helpers whose package.json says @swc/core fails', () => {
  const r = check(tree({ '@swc/helpers': '@swc/core' }), WORKER_ARGS);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /\(@swc\/core@1\.0\.0\) matches @swc\/\*/);
});

test('a package that NAMES itself @swc/helpers from another directory is not exempt', () => {
  const r = check(tree({ '@swc/other': '@swc/helpers' }), WORKER_ARGS);
  assert.equal(r.code, 1, r.out);
});

test('without --allow, @swc/helpers is forbidden by the scope (the exception is explicit, never implied)', () => {
  const r = check(tree({ '@swc/helpers': '@swc/helpers' }), ['--forbid', '@swc/*']);
  assert.equal(r.code, 1, r.out);
});

test('an --allow with a wildcard is refused', () => {
  const r = check(tree({ '@swc/helpers': '@swc/helpers' }), ['--forbid', '@swc/*', '--allow', '@swc/*']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /--allow takes exact package names only/);
});

test('an --allow that no --forbid entry covers is refused (an exception must be an exception to something)', () => {
  const r = check(tree({ fontkit: 'fontkit' }), ['--forbid', '@swc/*', '--allow', 'fontkit']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /--allow fontkit is not covered by any --forbid entry/);
});

test('the image Dockerfile bans the whole @swc scope with exactly one exception, @swc/helpers', () => {
  const dockerfile = fs.readFileSync(path.join(__dirname, '..', 'Dockerfile'), 'utf8');
  const gate = dockerfile.slice(dockerfile.indexOf('node /tmp/runtime-deps.cjs check'), dockerfile.indexOf('test -f /app/node_modules/@react-pdf/renderer'));
  assert.match(gate, /--forbid [^;]*'@swc\/\*'/);
  assert.deepEqual([...gate.matchAll(/--allow\s+([^\s;\\]+)/g)].map((m) => m[1]), ['@swc/helpers']);
  assert.doesNotMatch(gate, /@swc\/core|@swc\/cli|@swc\/jest/); // no enumerated list left beside the scope ban
});

test('O1: ONE runtime-deps check covers the API and the Worker (the union of the former two lists)', () => {
  const dockerfile = fs.readFileSync(path.join(__dirname, '..', 'Dockerfile'), 'utf8');
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'Dockerfile.worker-bundle')), false, 'the Worker Dockerfile is retired');
  const checks = [...dockerfile.matchAll(/node \/tmp\/runtime-deps\.cjs check/g)];
  assert.equal(checks.length, 1, 'exactly one runtime-deps check');
  const gate = dockerfile.slice(dockerfile.indexOf('node /tmp/runtime-deps.cjs check'), dockerfile.indexOf('test -f /app/node_modules/@react-pdf/renderer'));
  for (const dir of ['rab-worker/dist', 'rab-server/dist', 'rab-shared/dist-cjs', 'rab-emails/dist']) assert.match(gate, new RegExp(`--scan[^;]*/app/packages/${dir.replace('/', '\/')}`), dir);
  for (const name of ['typescript', "'@nx/*'", "'@jest/*'", 'ts-node', 'tsx', 'vite', 'esbuild', "'@esbuild/*'", 'eslint', "'@swc/*'", "'@swc-node/*'", 'webpack', 'react-email', '@playwright/test', 'playwright', 'playwright-core', 'chromium-bidi']) {
    assert.ok(gate.includes(` ${name}`), `--forbid lacks ${name}`);
  }
  assert.match(dockerfile, /worker-delta \/api\/node_modules \/app\/node_modules \/worker-delta/, 'the worker-modules delta stage stays');
  assert.match(dockerfile, /COPY --from=worker-modules \/worker-delta\/node_modules\/ \.\/node_modules\//);
});
