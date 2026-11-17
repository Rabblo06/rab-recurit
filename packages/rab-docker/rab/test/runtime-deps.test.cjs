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

// ---------------------------------------------------------------------------------------------------------------------
// prune: node-gyp (injected by Yarn into every native package's lockfile entry, kept by `focus --production`) and the
// install-time-only tree that hangs off it leave the runtime node_modules; anything a runtime package also reaches stays.

const { RUNTIME_PRUNE } = require('../runtime-deps.cjs');

/**
 * An installed tree plus its lockfile. `packages`: { 'dir/path': { name, version, deps, lockDeps, bin, files } };
 * `workspaces`: { '@rab/server': manifest } become links from node_modules/@rab/<x> to <root>/packages/<x>.
 */
function installed(packages, workspaces) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-prune-'));
  const nm = path.join(root, 'node_modules');
  fs.mkdirSync(path.join(nm, '.bin'), { recursive: true });
  const lock = ['# This file is generated by running "yarn install" inside your project.', '', '__metadata:', '  version: 8', ''];
  const seen = new Set();
  for (const [dir, p] of Object.entries(packages)) {
    const version = p.version || '1.0.0';
    const abs = path.join(nm, ...dir.split('/'));
    fs.mkdirSync(abs, { recursive: true });
    fs.writeFileSync(path.join(abs, 'package.json'), JSON.stringify({ name: p.name, version, dependencies: p.deps || {}, bin: p.bin }));
    for (const [f, src] of Object.entries(p.files || { 'index.js': 'module.exports = 1;\n' })) fs.writeFileSync(path.join(abs, f), src);
    if (p.bin && !dir.includes('/node_modules/')) {
      const target = typeof p.bin === 'string' ? p.bin : Object.values(p.bin)[0];
      fs.symlinkSync(path.relative(path.join(nm, '.bin'), path.join(abs, target)), path.join(nm, '.bin', p.name));
    }
    if (seen.has(`${p.name}@${version}`)) continue;
    seen.add(`${p.name}@${version}`);
    const deps = [...Object.keys(p.deps || {}), ...(p.lockDeps || [])];
    lock.push(`"${p.name}@npm:^${version}":`, `  version: ${version}`, `  resolution: "${p.name}@npm:${version}"`);
    if (deps.length) lock.push('  dependencies:', ...deps.map((d) => `    ${d.startsWith('@') ? `"${d}"` : d}: "npm:latest"`));
    lock.push('  languageName: node', '  linkType: hard', '');
  }
  for (const [name, manifest] of Object.entries(workspaces)) {
    const short = name.split('/')[1];
    const ws = path.join(root, 'packages', short);
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ name, version: '0.0.0', ...manifest }));
    fs.mkdirSync(path.join(nm, '@rab'), { recursive: true });
    fs.symlinkSync(path.relative(path.join(nm, '@rab'), ws), path.join(nm, '@rab', short), 'junction');
    // A workspace's lockfile entry lists its devDependencies too: prune must not take them as runtime edges.
    lock.push(`"${name}@workspace:packages/${short}":`, '  version: 0.0.0-use.local', `  resolution: "${name}@workspace:packages/${short}"`);
    const all = { ...(manifest.dependencies || {}), ...(manifest.devDependencies || {}) };
    if (Object.keys(all).length) lock.push('  dependencies:', ...Object.keys(all).map((d) => `    ${d.startsWith('@') ? `"${d}"` : d}: "npm:latest"`));
    lock.push('  languageName: unknown', '  linkType: soft', '');
  }
  fs.writeFileSync(path.join(root, 'yarn.lock'), lock.join('\n'));
  const dist = path.join(root, 'dist');
  fs.mkdirSync(dist);
  fs.writeFileSync(path.join(dist, 'main.js'), "'use strict';\nrequire('argon2');\nrequire('bullmq');\nrequire('jsonwebtoken');\n");
  return { root, nm, dist, lockfile: path.join(root, 'yarn.lock') };
}

const runPrune = (t, extra = [], roots = ['--root', '@rab/worker', '@rab/server']) => {
  const r = spawnSync(process.execPath, [CLI, 'prune', t.nm, '--lockfile', t.lockfile, ...roots, ...extra], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};
const has = (t, rel) => fs.existsSync(path.join(t.nm, ...rel.split('/')));

/**
 * The shape the real focused install has (measured: a local `yarn workspaces focus @rab/server --production` of this
 * lockfile): argon2 and node-addon-api carry node-gyp in their LOCKFILE entries only (Yarn injected it), and so does
 * msgpackr-extract on the Worker path (bullmq > msgpackr > msgpackr-extract); node-gyp brings tinyglobby -> fdir +
 * picomatch@4 (hoisted to the top level), tar, a nested undici@8, which, graceful-fs and semver. semver is ALSO reached
 * by a runtime package (jsonwebtoken), picomatch@2 is a runtime package's own nested copy, and node-gyp-build's bin.js
 * (an install-time CLI) requires node-gyp.
 */
const imageShape = (overrides = {}) =>
  installed(
    {
      argon2: { name: 'argon2', version: '0.41.1', deps: { 'node-gyp-build': '^4', 'node-addon-api': '^8' }, lockDeps: ['node-gyp'] },
      'node-addon-api': { name: 'node-addon-api', version: '8.1.0', lockDeps: ['node-gyp'] },
      'node-gyp-build': {
        name: 'node-gyp-build',
        version: '4.8.4',
        bin: { 'node-gyp-build': './bin.js' },
        files: { 'index.js': "module.exports = require('./node-gyp-build.js');\n", 'node-gyp-build.js': 'module.exports = 1;\n', 'bin.js': "try { require('node-gyp/package.json'); } catch (_) {}\n" },
      },
      bullmq: { name: 'bullmq', version: '5.0.0', deps: { msgpackr: '^1' } },
      msgpackr: { name: 'msgpackr', version: '1.11.0', deps: { 'msgpackr-extract': '^3' } },
      'msgpackr-extract': { name: 'msgpackr-extract', version: '3.0.4', lockDeps: ['node-gyp'] },
      'node-gyp': { name: 'node-gyp', version: '13.0.1', deps: { semver: '^7', tar: '^7', tinyglobby: '^0.2', undici: '^8', which: '^7', 'graceful-fs': '^4', '@npmcli/agent': '^3' }, bin: { 'node-gyp': 'cli.js' }, files: { 'cli.js': '' } },
      'node-gyp/node_modules/undici': { name: 'undici', version: '8.12.3' },
      semver: { name: 'semver', version: '7.7.0' },
      tar: { name: 'tar', version: '7.5.22', deps: { chownr: '^3' } },
      chownr: { name: 'chownr', version: '3.0.0' },
      'graceful-fs': { name: 'graceful-fs', version: '4.2.11' },
      tinyglobby: { name: 'tinyglobby', version: '0.2.17', deps: { fdir: '^6', picomatch: '^4' } },
      fdir: { name: 'fdir', version: '6.5.0', deps: {}, lockDeps: ['picomatch'] },
      picomatch: { name: 'picomatch', version: '4.0.5' },
      which: { name: 'which', version: '7.0.0', deps: { isexe: '^4' } },
      isexe: { name: 'isexe', version: '4.0.0' },
      '@npmcli/agent': { name: '@npmcli/agent', version: '3.0.0' },
      undici: { name: 'undici', version: '6.29.1' },
      jsonwebtoken: { name: 'jsonwebtoken', version: '9.0.2', deps: { semver: '^7' } },
      micromatch: { name: 'micromatch', version: '4.0.8', deps: { picomatch: '^2' } },
      'micromatch/node_modules/picomatch': { name: 'picomatch', version: '2.3.2' },
      'micromatch/node_modules/which': { name: 'which', version: '2.0.2' },
      ...overrides,
    },
    {
      '@rab/server': { dependencies: { argon2: '^0.41.1', jsonwebtoken: '^9', micromatch: '^4', undici: '^6' }, devDependencies: { tar: '^7' } },
      '@rab/worker': { dependencies: { bullmq: '^5', '@rab/server': 'workspace:*' } },
    },
  );

const NODE_GYP_ONLY = ['node-gyp', 'node-gyp/node_modules/undici', 'tinyglobby', 'fdir', 'picomatch', 'tar', 'chownr', 'graceful-fs', 'which', 'isexe', '@npmcli/agent'];
const RUNTIME = ['argon2', 'node-addon-api', 'node-gyp-build', 'bullmq', 'msgpackr', 'msgpackr-extract', 'jsonwebtoken', 'semver', 'micromatch', 'micromatch/node_modules/picomatch', 'undici'];

test('RUNTIME_PRUNE is exported, exact names only, and requiring the file has no side effects', () => {
  assert.deepEqual([...RUNTIME_PRUNE], ['node-gyp']);
  assert.ok(Object.isFrozen(RUNTIME_PRUNE));
  for (const n of RUNTIME_PRUNE) assert.doesNotMatch(n, /\*/);
  const r = spawnSync(process.execPath, ['-e', `const m = require(${JSON.stringify(CLI)}); console.log(Object.keys(m).join(','))`], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'RUNTIME_PRUNE');
  assert.equal(r.stderr, '');
});

test('prune removes node-gyp and everything only it reaches (tinyglobby, hoisted picomatch@4, tar, undici@8, ...), through both production paths', () => {
  const t = imageShape();
  try {
    const r = runPrune(t);
    assert.equal(r.code, 0, r.out);
    for (const gone of NODE_GYP_ONLY) assert.equal(has(t, gone), false, `${gone} should be pruned\n${r.out}`);
    assert.equal(fs.existsSync(path.join(t.nm, '@npmcli')), false, 'the emptied scope directory goes too');
    assert.equal(fs.existsSync(path.join(t.nm, '.bin', 'node-gyp')), false, 'the dangling .bin link goes too');
    assert.equal(fs.existsSync(path.join(t.nm, '.bin', 'node-gyp-build')), true, 'a kept package keeps its .bin link');
    assert.match(r.out, /removes node_modules\/node-gyp \(node-gyp@13\.0\.1\)/);
    assert.match(r.out, /removes node_modules\/picomatch \(picomatch@4\.0\.5\)/);
    assert.match(r.out, /removes node_modules\/tinyglobby \(tinyglobby@0\.2\.17\)/);
    // The compiled code still resolves everything it imports, and the image's --forbid is satisfied.
    const c = spawnSync(process.execPath, [CLI, 'check', t.nm, '--scan', t.dist, '--forbid', 'node-gyp', 'tinyglobby'], { encoding: 'utf8' });
    assert.equal(c.status, 0, `${c.stdout}${c.stderr}`);
  } finally {
    fs.rmSync(t.root, { recursive: true, force: true });
  }
});

test('prune keeps what a runtime package also reaches: shared semver, picomatch@2, undici@6, and the native packages themselves', () => {
  const t = imageShape();
  try {
    const r = runPrune(t);
    assert.equal(r.code, 0, r.out);
    for (const kept of RUNTIME) assert.equal(has(t, kept), true, `${kept} must stay\n${r.out}`);
    assert.equal(JSON.parse(fs.readFileSync(path.join(t.nm, 'undici', 'package.json'), 'utf8')).version, '6.29.1');
    assert.equal(has(t, 'micromatch/node_modules/which'), false, 'a nested copy nothing resolves to is pruned on its own');
  } finally {
    fs.rmSync(t.root, { recursive: true, force: true });
  }
});

test('prune never takes a workspace devDependency (listed in its lockfile entry) as a runtime root', () => {
  const t = imageShape();
  try {
    assert.equal(runPrune(t).code, 0);
    assert.equal(has(t, 'tar'), false, 'tar is only a devDependency of the workspace besides node-gyp');
  } finally {
    fs.rmSync(t.root, { recursive: true, force: true });
  }
});

test('prune follows lockfile-only edges (what Yarn injects or a packageExtension adds), not just package.json', () => {
  const t = imageShape({ jsonwebtoken: { name: 'jsonwebtoken', version: '9.0.2', lockDeps: ['semver', 'tinyglobby'] } });
  try {
    const r = runPrune(t);
    assert.equal(r.code, 0, r.out);
    for (const kept of ['semver', 'tinyglobby', 'fdir', 'picomatch']) assert.equal(has(t, kept), true, `${kept}\n${r.out}`);
    assert.equal(has(t, 'node-gyp'), false);
  } finally {
    fs.rmSync(t.root, { recursive: true, force: true });
  }
});

test('prune refuses (and removes nothing) when kept runtime code loads a package only node-gyp declared', () => {
  const t = imageShape({ jsonwebtoken: { name: 'jsonwebtoken', version: '9.0.2', deps: { semver: '^7' }, files: { 'index.js': "const g = require('graceful-fs');\n" } } });
  try {
    const r = runPrune(t);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /kept package jsonwebtoken@9\.0\.2 loads graceful-fs .* which prune would remove/);
    assert.equal(has(t, 'node-gyp'), true, 'nothing is removed when the prune refuses');
  } finally {
    fs.rmSync(t.root, { recursive: true, force: true });
  }
});

test('prune refuses a tree that is not the lockfile install, a stale --drop and a wildcard --drop', () => {
  let t = imageShape();
  try {
    fs.writeFileSync(path.join(t.nm, 'semver', 'package.json'), JSON.stringify({ name: 'semver', version: '9.9.9' }));
    const r = runPrune(t);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /semver@9\.9\.9\) has no entry in/);
    assert.equal(has(t, 'node-gyp'), true);
  } finally {
    fs.rmSync(t.root, { recursive: true, force: true });
  }
  t = imageShape();
  try {
    assert.match(runPrune(t, ['--drop', 'left-pad']).out, /--drop left-pad is not installed/);
    assert.match(runPrune(t, ['--drop', '@npmcli/*']).out, /--drop takes exact package names/);
    assert.equal(has(t, 'node-gyp'), true);
  } finally {
    fs.rmSync(t.root, { recursive: true, force: true });
  }
});

test('the final check fails if node-gyp or tinyglobby comes back into the image, at the top level or nested', () => {
  for (const pkg of ['node-gyp', 'tinyglobby']) {
    const r = check(tree({ [pkg]: pkg, semver: 'semver' }), ['--forbid', 'node-gyp', 'tinyglobby']);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, new RegExp(`forbidden package in the runtime image: node_modules/${pkg} .* matches ${pkg}`));
  }
  const nested = check(tree({ argon2: 'argon2', 'argon2/node_modules/node-gyp': 'node-gyp' }), ['--forbid', 'node-gyp', 'tinyglobby']);
  assert.equal(nested.code, 1, nested.out);
  assert.match(nested.out, /node_modules\/argon2\/node_modules\/node-gyp/);
});

test('the image prunes in BOTH dependency stages before they meet (RUNTIME_PRUNE, no --drop override) and forbids node-gyp', () => {
  const dockerfile = fs.readFileSync(path.join(__dirname, '..', 'Dockerfile'), 'utf8');
  const stage = (name) => {
    const start = dockerfile.indexOf(` AS ${name}\n`);
    assert.ok(start > 0, name);
    return dockerfile.slice(start, dockerfile.indexOf('\nFROM ', start));
  };
  const api = stage('runtime-modules');
  const apiPrune = 'node /tmp/runtime-deps.cjs prune /app/node_modules --lockfile yarn.lock --root @rab/server; ';
  assert.ok(api.indexOf(apiPrune) > 0, 'API: prune with the explicit root @rab/server');
  assert.ok(api.indexOf('yarn workspaces focus @rab/server --production;') < api.indexOf(apiPrune), 'API: prune after focus');
  assert.ok(api.indexOf(apiPrune) < api.indexOf('find node_modules ! -type l -perm /022'), 'API: prune before the mode normalisation');
  assert.match(api, /--mount=type=bind,source=packages\/rab-docker\/rab\/runtime-deps\.cjs,target=\/tmp\/runtime-deps\.cjs/);
  const worker = stage('worker-modules');
  const workerPrune = 'node /tmp/runtime-deps.cjs prune /app/node_modules --lockfile yarn.lock --root @rab/worker @rab/server; ';
  assert.ok(worker.indexOf(workerPrune) > 0, 'Worker: prune with the explicit roots @rab/worker and @rab/server');
  assert.ok(worker.indexOf('yarn workspaces focus @rab/worker --production;') < worker.indexOf(workerPrune), 'Worker: prune after focus');
  assert.ok(worker.indexOf(workerPrune) < worker.indexOf('worker-delta /api/node_modules'), 'Worker: prune before the delta');
  assert.equal([...dockerfile.matchAll(/runtime-deps\.cjs prune /g)].length, 2, 'exactly the two prunes');
  assert.doesNotMatch(dockerfile, /runtime-deps\.cjs prune[^;]*--drop/, 'the image uses RUNTIME_PRUNE, the one exported list');
  const gate = dockerfile.slice(dockerfile.indexOf('node /tmp/runtime-deps.cjs check'), dockerfile.indexOf('test -f /app/node_modules/@react-pdf/renderer'));
  for (const name of [...RUNTIME_PRUNE, 'tinyglobby']) assert.ok(gate.includes(` ${name} `), `--forbid lacks ${name}`);
});

// Review L1: the undeclared-dependency scan has no blind spot for bin-as-main, bare side-effect imports or code behind a
// comment; each refuses (exit 1) and removes nothing. Review L2: the roots are explicit and must exist.

/** Runs prune on imageShape(overrides) and asserts it refused, named graceful-fs, and removed nothing. */
function assertRefusesGracefulFs(overrides, pkg) {
  const t = imageShape(overrides);
  try {
    const before = fs.readdirSync(t.nm).sort();
    const r = runPrune(t);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, new RegExp(`kept package ${pkg.replace('.', '\\.')}@\\S+ loads graceful-fs .* which prune would remove`));
    assert.deepEqual(fs.readdirSync(t.nm).sort(), before, 'nothing is removed when the prune refuses');
    assert.equal(has(t, 'node-gyp'), true);
    assert.equal(has(t, 'graceful-fs'), true);
  } finally {
    fs.rmSync(t.root, { recursive: true, force: true });
  }
}

test('L1: a bin file that is ALSO the package main is runtime code: requiring graceful-fs refuses', () => {
  assertRefusesGracefulFs(
    {
      jsonwebtoken: {
        name: 'jsonwebtoken',
        version: '9.0.2',
        deps: { semver: '^7' },
        bin: { jwt: './index.js' },
        files: { 'index.js': "#!/usr/bin/env node\nconst g = require('graceful-fs');\nmodule.exports = g;\n" },
      },
    },
    'jsonwebtoken',
  );
});

test('L1: a bin file that is an exports target is runtime code too', () => {
  const t = imageShape({
    jsonwebtoken: { name: 'jsonwebtoken', version: '9.0.2', deps: { semver: '^7' }, bin: { jwt: './cli.js' }, files: { 'index.js': 'module.exports = 1;\n', 'cli.js': "require('graceful-fs');\n" } },
  });
  try {
    const pj = path.join(t.nm, 'jsonwebtoken', 'package.json');
    fs.writeFileSync(pj, JSON.stringify({ ...JSON.parse(fs.readFileSync(pj, 'utf8')), exports: { '.': './index.js', './cli': { require: './cli.js' } } }));
    const r = runPrune(t);
    assert.equal(r.code, 1, r.out);
    assert.equal(has(t, 'graceful-fs'), true);
  } finally {
    fs.rmSync(t.root, { recursive: true, force: true });
  }
});

test('L1: an install-time-only bin file is tolerated ONLY for a --drop name, never for anything else it would remove', () => {
  // node-gyp-build's bin.js -> node-gyp (a --drop name): tolerated and reported.
  const ok = imageShape();
  try {
    const r = runPrune(ok);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /prune tolerates node_modules[\\/]node-gyp-build[\\/]bin\.js -> node-gyp\/package\.json/);
    assert.match(r.out, /1 tolerated install-time bin hits/);
  } finally {
    fs.rmSync(ok.root, { recursive: true, force: true });
  }
  // The same bin-only file loading graceful-fs (pruned, but not a --drop name): refused.
  assertRefusesGracefulFs(
    {
      'node-gyp-build': {
        name: 'node-gyp-build',
        version: '4.8.4',
        bin: { 'node-gyp-build': './bin.js' },
        files: { 'index.js': 'module.exports = 1;\n', 'bin.js': "require('graceful-fs');\n" },
      },
    },
    'node-gyp-build',
  );
});

test("L1: a bare side-effect import (import 'graceful-fs';) refuses", () => {
  assertRefusesGracefulFs(
    { jsonwebtoken: { name: 'jsonwebtoken', version: '9.0.2', deps: { semver: '^7' }, files: { 'index.mjs': "import 'graceful-fs';\nexport default 1;\n", 'index.js': 'module.exports = 1;\n' } } },
    'jsonwebtoken',
  );
});

test("L1: code on a line that starts with a comment (/*! x */ require('graceful-fs')) is scanned and refuses", () => {
  assertRefusesGracefulFs(
    { jsonwebtoken: { name: 'jsonwebtoken', version: '9.0.2', deps: { semver: '^7' }, files: { 'index.js': "/*! x */ require('graceful-fs')\n" } } },
    'jsonwebtoken',
  );
});

test('L2: --root is required, and a --root without its workspace link refuses and removes nothing', () => {
  let t = imageShape();
  try {
    const none = runPrune(t, [], []);
    assert.equal(none.code, 1, none.out);
    assert.match(none.out, /prune needs at least one --root/);
    assert.equal(has(t, 'node-gyp'), true);
  } finally {
    fs.rmSync(t.root, { recursive: true, force: true });
  }
  t = imageShape();
  try {
    fs.rmSync(path.join(t.nm, '@rab', 'server'), { recursive: false, force: true });
    const before = fs.readdirSync(t.nm).sort();
    const r = runPrune(t, [], ['--root', '@rab/server']);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /--root @rab\/server is not a workspace link in .* \(missing\)/);
    assert.deepEqual(fs.readdirSync(t.nm).sort(), before);
    assert.equal(has(t, 'node-gyp'), true);
  } finally {
    fs.rmSync(t.root, { recursive: true, force: true });
  }
  t = imageShape();
  try {
    const r = runPrune(t, [], ['--root', 'argon2']);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /--root argon2 is not a workspace link .*argon2@0\.41\.1/);
    assert.equal(has(t, 'node-gyp'), true);
  } finally {
    fs.rmSync(t.root, { recursive: true, force: true });
  }
});

test('L2: only the named roots count: the API root alone prunes what only the Worker reaches', () => {
  const t = imageShape();
  try {
    const r = runPrune(t, [], ['--root', '@rab/server']);
    assert.equal(r.code, 0, r.out);
    for (const gone of ['bullmq', 'msgpackr', 'msgpackr-extract', 'node-gyp']) assert.equal(has(t, gone), false, `${gone}\n${r.out}`);
    for (const kept of ['argon2', 'jsonwebtoken', 'semver']) assert.equal(has(t, kept), true, `${kept}\n${r.out}`);
    assert.match(r.out, /roots: @rab\/server/);
  } finally {
    fs.rmSync(t.root, { recursive: true, force: true });
  }
});
