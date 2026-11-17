'use strict';
// node --test tools/check-npm-audit.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const {
  inRange,
  fixableTreeVersions,
  validateRegister,
  parseAudit,
  evaluate,
} = require('./check-npm-audit.cjs');

const decision = (over = {}) => ({
  id: 'GHSA-fc5q-39xc-vjpf',
  packages: ['picomatch'],
  decision: 'accepted-risk',
  owner_decision_ref: 'https://github.com/Rabblo06/rab-recurit/pull/123',
  decided_by: 'owner',
  decided_on: '2026-11-17',
  expires: '2026-12-17',
  justification:
    'Build tooling only; no attacker-controlled glob pattern reaches picomatch.',
  ...over,
});
const register = (...decisions) => ({ schema: 1, decisions });
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
const PUBLISHED = ['2.3.1', '2.3.2', '3.0.2', '4.0.5', '4.0.7'];

test('inRange evaluates comparator sets and alternatives; refuses what it cannot evaluate', () => {
  assert.equal(inRange('4.0.7', '<=4.0.7'), true);
  assert.equal(inRange('4.0.8', '<=4.0.7'), false);
  assert.equal(inRange('2.3.2', '>=2.0.0 <2.3.2 || >=4.0.0 <4.0.4'), false);
  assert.equal(inRange('4.0.3', '>=2.0.0 <2.3.2 || >=4.0.0 <4.0.4'), true);
  assert.throws(() => inRange('4.0.0', '^4.0.0'));
  assert.throws(() => inRange('4.0.0-rc.1', '<=4.0.7'));
});

test('a same-major fix makes only that major fixable', () => {
  assert.deepEqual(
    fixableTreeVersions(['2.3.2', '4.0.5'], '<=4.0.7', PUBLISHED),
    [],
  );
  assert.deepEqual(
    fixableTreeVersions(['2.3.2', '4.0.5'], '<=4.0.7', [...PUBLISHED, '4.0.8']),
    ['4.0.5'],
  );
  // A fix in another major does not make 2.x fixable.
  assert.deepEqual(
    fixableTreeVersions(['2.3.2'], '<=4.0.7', [...PUBLISHED, '5.0.0']),
    [],
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

test('invalid decisions fail: expired, over 180 days, wildcard package, missing owner reference, placeholder PR', () => {
  const errs = (d, today = '2026-11-20') =>
    validateRegister(register(d), today).errors;
  assert.match(errs(decision(), '2026-12-18').join(), /EXPIRED/);
  assert.match(
    errs(decision({ expires: '2027-06-01' })).join(),
    /more than 180 days/,
  );
  assert.match(
    errs(decision({ packages: ['pico*'] })).join(),
    /exact package names/,
  );
  assert.match(
    errs(decision({ owner_decision_ref: '' })).join(),
    /owner_decision_ref/,
  );
  assert.match(
    errs(
      decision({
        owner_decision_ref: 'https://github.com/Rabblo06/rab-recurit/pull/0',
      }),
    ).join(),
    /owner_decision_ref/,
  );
  assert.match(errs(decision({ id: 'GHSA-*' })).join(), /GHSA/);
  assert.match(errs(decision({ decided_on: '2026-11-21' })).join(), /future/);
  assert.match(
    errs(decision({ decision: 'ignore' })).join(),
    /decision must be/,
  );
  assert.deepEqual(
    validateRegister(register(decision(), decision()), '2026-11-20').errors
      .length,
    1,
  );
  assert.equal(
    validateRegister(
      register(decision({ expires: '2026-12-18' })),
      '2026-12-18',
    ).valid.size,
    1,
  ); // last day valid
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

test('evaluate: decided, undecided (other advisory, other package, fixable, unevaluable) and unused', () => {
  const { valid } = validateRegister(register(decision()), '2026-11-20');
  const pub = () => PUBLISHED;
  let r = evaluate([finding()], valid, pub);
  assert.equal(r.decided.length, 1);
  assert.equal(r.undecided.length, 0);

  r = evaluate(
    [
      finding({ id: 'GHSA-2222-3333-4444' }),
      finding({ pkg: 'micromatch' }),
      finding({ id: null }),
    ],
    valid,
    pub,
  );
  assert.equal(r.undecided.length, 3);
  assert.equal(r.decided.length, 0);
  assert.deepEqual(r.unused, ['GHSA-fc5q-39xc-vjpf']);

  r = evaluate([finding()], valid, () => [...PUBLISHED, '4.0.8']);
  assert.match(r.undecided[0].reason, /FIXABLE.*4\.0\.5/);

  r = evaluate([finding({ range: '~4.0.0' })], valid, pub);
  assert.match(r.undecided[0].reason, /cannot be applied/);

  r = evaluate([finding()], valid, () => {
    throw new Error('registry down');
  });
  assert.match(r.undecided[0].reason, /registry down/);

  // An expired decision is not valid, so the finding is undecided.
  const expired = validateRegister(register(decision()), '2026-12-18').valid;
  assert.equal(evaluate([finding()], expired, pub).undecided.length, 1);
});
