'use strict';
// node --test tools/check-npm-audit.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const {
  inRange,
  fixShipped,
  productionPaths,
  validateRegister,
  parseAudit,
  evaluate,
  MAX_DAYS,
} = require('./check-npm-audit.cjs');

const entry = (over = {}) => ({
  id: 'GHSA-fc5q-39xc-vjpf',
  package: 'picomatch',
  decision: 'accepted-risk',
  owner_decision_ref: 'https://github.com/Rabblo06/rab-recurit/pull/123',
  decided_by: 'owner',
  decided_on: '2026-11-17',
  expires: '2026-12-17',
  reason:
    'No fix in any major; build tooling only; not in the production closure.',
  drop_when: 'When any picomatch release fixes it.',
  ...over,
});
const register = (...decisions) => ({ schema: 2, decisions });
const finding = (over = {}) => ({
  pkg: 'picomatch',
  id: 'GHSA-fc5q-39xc-vjpf',
  url: 'https://github.com/advisories/GHSA-fc5q-39xc-vjpf',
  issue: 'ReDoS',
  severity: 'high',
  range: '<=4.0.7',
  treeVersions: ['2.3.2', '4.0.5'],
  ...over,
});
const PUBLISHED = ['1.2.0', '2.3.1', '2.3.2', '3.0.2', '4.0.5', '4.0.7'];
const advisory = (fixed = null) => ({
  vulnerabilities: [
    {
      package: { name: 'picomatch' },
      vulnerable_version_range: '<= 4.0.7',
      first_patched_version: fixed,
    },
  ],
});

test('inRange evaluates comparator sets, alternatives and the advisory API spacing; refuses what it cannot evaluate', () => {
  assert.equal(inRange('4.0.7', '<=4.0.7'), true);
  assert.equal(inRange('4.0.7', '<= 4.0.7'), true);
  assert.equal(inRange('4.0.8', '<=4.0.7'), false);
  assert.equal(inRange('2.3.2', '>=2.0.0 <2.3.2 || >=4.0.0 <4.0.4'), false);
  assert.equal(inRange('4.0.3', '>=2.0.0 <2.3.2 || >=4.0.0 <4.0.4'), true);
  assert.throws(() => inRange('4.0.0', '^4.0.0'));
  assert.throws(() => inRange('4.0.0-rc.1', '<=4.0.7'));
});

test('the exception lapses when a fix ships in ANY major or the advisory gets a first_patched_version', () => {
  assert.equal(
    fixShipped(
      'picomatch',
      ['2.3.2', '4.0.5'],
      '<=4.0.7',
      PUBLISHED,
      advisory(),
    ),
    null,
  );
  assert.match(
    fixShipped(
      'picomatch',
      ['2.3.2', '4.0.5'],
      '<=4.0.7',
      PUBLISHED,
      advisory('4.0.8'),
    ),
    /first_patched_version 4\.0\.8/,
  );
  assert.match(
    fixShipped(
      'picomatch',
      ['2.3.2', '4.0.5'],
      '<=4.0.7',
      [...PUBLISHED, '4.0.8'],
      advisory(),
    ),
    /4\.0\.8/,
  );
  // A fix only in a NEW major still lapses it (any major), even for the 2.x tree version.
  assert.match(
    fixShipped(
      'picomatch',
      ['2.3.2'],
      '<=4.0.7',
      [...PUBLISHED, '5.0.0'],
      advisory(),
    ),
    /5\.0\.0/,
  );
  // A prerelease is not a fix; an older unaffected release is not a fix.
  assert.equal(
    fixShipped(
      'picomatch',
      ['2.3.2'],
      '<=4.0.7',
      [...PUBLISHED, '4.0.8-rc.1'],
      advisory(),
    ),
    null,
  );
  assert.equal(
    fixShipped(
      'picomatch',
      ['2.3.2'],
      '>=2.0.0 <=4.0.7',
      PUBLISHED,
      advisory(),
    ),
    null,
  );
  assert.throws(() =>
    fixShipped('picomatch', ['2.3.2'], '<=4.0.7', PUBLISHED, {
      vulnerabilities: [{ package: { name: 'other' } }],
    }),
  );
  assert.throws(() =>
    fixShipped('picomatch', ['2.3.2'], '<=4.0.7', PUBLISHED, {}),
  );
});

// A yarn.lock in miniature: a prod chain through an injected node-gyp, a dev-only chain, a workspace whose lockfile
// entry would merge its devDependencies, and a resolutions override.
const LOCK = {
  __metadata: { version: 8 },
  'argon2@npm:^0.41.1': {
    resolution: 'argon2@npm:0.41.1',
    dependencies: { 'node-gyp': 'npm:latest' },
  },
  'node-gyp@npm:latest': {
    resolution: 'node-gyp@npm:13.0.1',
    dependencies: { tinyglobby: 'npm:^0.2.12' },
  },
  'tinyglobby@npm:^0.2.12': {
    resolution: 'tinyglobby@npm:0.2.17',
    dependencies: { picomatch: 'npm:^4.0.4' },
  },
  'picomatch@npm:^4.0.4': { resolution: 'picomatch@npm:4.0.5' },
  'ts-node-dev@npm:^2.0.0': {
    resolution: 'ts-node-dev@npm:2.0.0',
    dependencies: { anymatch: 'npm:~3.1.2' },
  },
  'anymatch@npm:~3.1.2': {
    resolution: 'anymatch@npm:3.1.3',
    dependencies: { picomatch: 'npm:^2.0.4' },
  },
  'picomatch@npm:^2.0.4': { resolution: 'picomatch@npm:2.3.2' },
  'multer@npm:2.5.0': { resolution: 'multer@npm:2.5.0' },
  'express@npm:^5.0.0': {
    resolution: 'express@npm:5.0.0',
    dependencies: { multer: 'npm:2.2.0' },
  },
};
const WORKSPACES = new Map([
  [
    '@rab/server',
    {
      name: '@rab/server',
      dependencies: {
        argon2: '^0.41.1',
        '@rab/shared': 'workspace:*',
        express: '^5.0.0',
      },
      devDependencies: { 'ts-node-dev': '^2.0.0' },
    },
  ],
  [
    '@rab/worker',
    {
      name: '@rab/worker',
      dependencies: { '@rab/server': 'workspace:*' },
      devDependencies: { 'ts-node-dev': '^2.0.0' },
    },
  ],
  ['@rab/shared', { name: '@rab/shared', dependencies: {} }],
]);
const walk = (over = {}) =>
  productionPaths({
    lock: LOCK,
    workspaces: WORKSPACES,
    shipped: ['@rab/worker'],
    resolutions: { multer: '2.5.0' },
    target: 'picomatch',
    ...over,
  });

test('production closure: finds the injected node-gyp chain, ignores devDependencies (also through a workspace dep)', () => {
  assert.deepEqual(walk(), [
    '@rab/worker > @rab/server > argon2@0.41.1 > node-gyp@13.0.1 > tinyglobby@0.2.17 > picomatch@4.0.5',
  ]);
});

test('production closure: a pruned package and what is reachable only through it are excluded', () => {
  assert.deepEqual(walk({ prune: ['node-gyp'] }), []);
});

test('production closure fails closed on a descriptor yarn.lock cannot resolve, resolutions applied first', () => {
  assert.throws(
    () => walk({ resolutions: {} }),
    /no entry for multer@npm:2\.2\.0/,
  );
  assert.throws(
    () => walk({ shipped: ['@rab/nope'] }),
    /workspace @rab\/nope not found/,
  );
});

test('the committed register is well formed (as of its latest decision; expiry is the check itself)', () => {
  const reg = JSON.parse(
    readFileSync(join(__dirname, 'npm-audit-decisions.json'), 'utf8'),
  );
  const asOf =
    reg.decisions
      .map((d) => d.decided_on)
      .sort()
      .pop() || '2026-01-01';
  const { valid, errors } = validateRegister(reg, asOf);
  assert.deepEqual(errors, []);
  assert.equal(valid.size, reg.decisions.length);
});

test('invalid entries fail: scope, expiry, owner reference, reason and drop condition', () => {
  const errs = (d, today = '2026-11-20') =>
    validateRegister(register(d), today).errors.join();
  assert.equal(MAX_DAYS, 30);
  assert.match(errs(entry(), '2026-12-18'), /EXPIRED/);
  assert.match(errs(entry({ expires: '2026-12-18' })), /more than 30 days/);
  assert.match(errs(entry({ package: 'pico*' })), /exactly one exact package/);
  assert.match(
    errs(entry({ package: 'picomatch,micromatch' })),
    /exactly one exact package/,
  );
  assert.match(
    errs({ ...entry(), packages: ['picomatch', 'micromatch'] }),
    /one package per entry/,
  );
  assert.match(errs(entry({ decision: 'not-affected' })), /accepted-risk/);
  assert.match(
    errs(
      entry({
        owner_decision_ref: 'https://github.com/Rabblo06/rab-recurit/pull/0',
      }),
    ),
    /owner_decision_ref/,
  );
  assert.match(errs(entry({ id: 'GHSA-*' })), /GHSA/);
  assert.match(errs(entry({ decided_on: '2026-11-21' })), /future/);
  assert.match(errs(entry({ reason: 'short' })), /reason/);
  assert.match(errs(entry({ drop_when: '' })), /drop_when/);
  assert.match(
    validateRegister({ schema: 1, decisions: [] }, '2026-11-20').errors.join(),
    /schema/,
  );
  assert.equal(
    validateRegister(register(entry(), entry()), '2026-11-20').errors.length,
    1,
  );
  assert.equal(validateRegister(register(entry()), '2026-12-17').valid.size, 1); // the expiry day itself is valid
});

test('parseAudit reads yarn 4 NDJSON and fails closed on anything else', () => {
  const line = JSON.stringify({
    value: 'picomatch',
    children: {
      ID: 1247710,
      Issue: 'ReDoS',
      URL: 'https://github.com/advisories/GHSA-fc5q-39xc-vjpf',
      Severity: 'high',
      'Vulnerable Versions': '<=4.0.7',
      'Tree Versions': ['2.3.2'],
      Dependents: [],
    },
  });
  assert.deepEqual(parseAudit(`${line}\n`), [
    {
      pkg: 'picomatch',
      id: 'GHSA-fc5q-39xc-vjpf',
      url: 'https://github.com/advisories/GHSA-fc5q-39xc-vjpf',
      issue: 'ReDoS',
      severity: 'high',
      range: '<=4.0.7',
      treeVersions: ['2.3.2'],
    },
  ]);
  assert.deepEqual(parseAudit(''), []);
  assert.throws(() => parseAudit('➤ YN0035: request failed'));
  assert.throws(() => parseAudit('{"foo":1}'));
});

test('evaluate: decided only when no fix, not in production, and the entry matches advisory AND package', () => {
  const { valid } = validateRegister(register(entry()), '2026-11-20');
  const ok = {
    published: () => PUBLISHED,
    advisory: () => advisory(),
    production: () => [],
  };
  let r = evaluate([finding()], valid, ok);
  assert.equal(r.decided.length, 1);
  assert.equal(r.undecided.length, 0);

  r = evaluate(
    [
      finding({ id: 'GHSA-2222-3333-4444' }),
      finding({ pkg: 'micromatch' }),
      finding({ id: null }),
    ],
    valid,
    ok,
  );
  assert.equal(r.undecided.length, 3);
  assert.deepEqual(r.unused, ['GHSA-fc5q-39xc-vjpf']);

  r = evaluate([finding()], valid, {
    ...ok,
    production: () => [
      '@rab/server > argon2@0.41.1 > node-gyp@13.0.1 > tinyglobby@0.2.17 > picomatch@4.0.5',
    ],
  });
  assert.match(r.undecided[0].reason, /PRODUCTION closure.*\n.*node-gyp/);

  r = evaluate([finding()], valid, {
    ...ok,
    advisory: () => advisory('4.0.8'),
  });
  assert.match(r.undecided[0].reason, /FIX EXISTS/);
  r = evaluate([finding()], valid, {
    ...ok,
    published: () => [...PUBLISHED, '5.0.0'],
  });
  assert.match(r.undecided[0].reason, /FIX EXISTS/);

  for (const broken of [
    {
      published: () => {
        throw new Error('registry down');
      },
    },
    {
      advisory: () => {
        throw new Error('HTTP 503');
      },
    },
    {
      production: () => {
        throw new Error('no entry for x');
      },
    },
  ]) {
    r = evaluate([finding()], valid, { ...ok, ...broken });
    assert.match(r.undecided[0].reason, /cannot be applied/);
  }
  r = evaluate([finding({ range: '~4.0.0' })], valid, ok);
  assert.match(r.undecided[0].reason, /cannot be applied/);

  const expired = validateRegister(register(entry()), '2026-12-18').valid;
  assert.equal(evaluate([finding()], expired, ok).undecided.length, 1);
});
