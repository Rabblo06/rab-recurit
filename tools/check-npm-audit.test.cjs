'use strict';
// node --test tools/check-npm-audit.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const { readFileSync } = fs;
const { join, dirname } = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  inRange,
  fixShipped,
  productionPaths,
  validateRegister,
  parseAudit,
  evaluate,
  MAX_DAYS,
} = require('./check-npm-audit.cjs');
const check = require('./check-npm-audit.cjs');

const entry = (over = {}) => ({
  id: 'GHSA-fc5q-39xc-vjpf',
  package: 'picomatch',
  severity: 'high',
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

// ---- Review of #229: F5, F6, F7, F8, F3, F4 (pure functions) ----

/** `yarn config get <key> --json` as yarn 4.13 prints it with this repository's .yarnrc.yml. */
const CONFIG_DEFAULTS = {
  npmAuditIgnoreAdvisories: '[]',
  npmAuditExcludePackages: '[]',
  npmAuditRegistry: 'null',
  npmRegistryServer: '"https://registry.yarnpkg.com"',
  httpsProxy: 'null',
  httpProxy: 'null',
  httpsCaFilePath: 'null',
  enableStrictSsl: 'true',
  networkSettings: 'undefined', // what yarn 4.13 prints for the unset MAP
};
/** `yarn plugin runtime --json` as yarn 4.13 prints it here (abridged): the core plus built-ins only. */
const PLUGINS_DEFAULT = [
  '{"name":"@@core","builtin":false}',
  '{"name":"@yarnpkg/plugin-essentials","builtin":true}',
  '{"name":"@yarnpkg/plugin-npm-cli","builtin":true}',
].join('\n');
/** A spawnSync-shaped yarn for `config get` and `plugin runtime`; `values` overrides keys (and `__plugins`). */
const configYarn = (values) => (args) => ({
  status: 0,
  stdout:
    args[0] === 'plugin'
      ? `${values.__plugins ?? PLUGINS_DEFAULT}\n`
      : `${values[args[2]] ?? CONFIG_DEFAULTS[args[2]]}\n`,
  stderr: '',
});

test('F7: a date must round-trip, so 2026-02-30 is refused', () => {
  assert.equal(check.isoDate('2026-02-28'), Date.parse('2026-02-28T00:00:00Z'));
  assert.equal(check.isoDate('2026-02-30'), null);
  assert.equal(check.isoDate('2026-13-01'), null);
  assert.equal(check.isoDate('2026-11-31'), null);
  assert.equal(check.isoDate(20261117), null);
  const errs = validateRegister(
    register(entry({ decided_on: '2026-11-31', expires: '2026-12-17' })),
    '2026-11-20',
  ).errors.join();
  assert.match(errs, /decided_on must be a real date/);
  assert.match(
    validateRegister(
      register(entry({ expires: '2026-12-32' })),
      '2026-11-20',
    ).errors.join(),
    /expires must be a real date/,
  );
});

test('F6: an entry records the decided severity; a finding rated above it is undecided', () => {
  const errs = (d) => validateRegister(register(d), '2026-11-20').errors.join();
  const { severity, ...noSeverity } = entry();
  assert.equal(severity, 'high');
  assert.match(errs(noSeverity), /severity/);
  assert.match(errs(entry({ severity: 'moderate' })), /severity/);
  assert.match(errs(entry({ severity: 'HIGH' })), /severity/);
  const ok = {
    published: () => PUBLISHED,
    advisory: () => advisory(),
    production: () => [],
  };
  const high = validateRegister(register(entry()), '2026-11-20').valid;
  let r = evaluate([finding({ severity: 'critical' })], high, ok);
  assert.equal(r.decided.length, 0);
  assert.match(r.undecided[0].reason, /critical is above the high/);
  r = evaluate([finding({ severity: 'surprising' })], high, ok);
  assert.match(r.undecided[0].reason, /unknown severity/);
  // A critical decision covers a high finding (the recorded severity is an upper bound).
  const crit = validateRegister(
    register(entry({ severity: 'critical' })),
    '2026-11-20',
  ).valid;
  assert.equal(evaluate([finding()], crit, ok).decided.length, 1);
});

test('F5: a finding with no Tree Versions cannot be evaluated and is undecided', () => {
  const { valid } = validateRegister(register(entry()), '2026-11-20');
  const r = evaluate([finding({ treeVersions: [] })], valid, {
    published: () => PUBLISHED,
    advisory: () => advisory(),
    production: () => [],
  });
  assert.equal(r.decided.length, 0);
  assert.match(r.undecided[0].reason, /cannot evaluate: .*no Tree Versions/);
});

test('F8: entries with 7 days or fewer left are reported (the expiry day is 0)', () => {
  const { valid } = validateRegister(register(entry()), '2026-11-20');
  assert.deepEqual(check.expiringSoon(valid, '2026-12-09'), []);
  assert.deepEqual(check.expiringSoon(valid, '2026-12-10'), [
    { id: 'GHSA-fc5q-39xc-vjpf', expires: '2026-12-17', left: 7 },
  ]);
  assert.equal(check.expiringSoon(valid, '2026-12-17')[0].left, 0);
});

test('F4: spawnFailure refuses a spawn error, a signal and an exit status outside the allowed set', () => {
  assert.equal(check.spawnFailure({ status: 0 }, [0, 1]), null);
  assert.equal(check.spawnFailure({ status: 1 }, [0, 1]), null);
  assert.match(
    check.spawnFailure(
      { error: new Error('spawn yarn ENOENT'), status: null },
      [0, 1],
    ),
    /could not run/,
  );
  assert.match(
    check.spawnFailure({ signal: 'SIGKILL', status: null }, [0, 1]),
    /killed by SIGKILL/,
  );
  assert.match(check.spawnFailure({ status: 2 }, [0, 1]), /exited 2/);
  assert.match(check.spawnFailure({ status: null }, [0, 1]), /exited null/);
});

test('F3: an ignore list in yarn config or any YARN_NPM_AUDIT_* variable is a problem', () => {
  const yarnWith = configYarn;
  assert.deepEqual(check.auditConfigProblems(yarnWith({}), {}), []);
  assert.match(
    check
      .auditConfigProblems(
        yarnWith({ npmAuditIgnoreAdvisories: '["GHSA-fc5q-39xc-vjpf"]' }),
        {},
      )
      .join(),
    /npmAuditIgnoreAdvisories must be empty/,
  );
  assert.match(
    check
      .auditConfigProblems(
        yarnWith({ npmAuditExcludePackages: '["picomatch"]' }),
        {},
      )
      .join(),
    /npmAuditExcludePackages must be empty/,
  );
  assert.match(
    check
      .auditConfigProblems(yarnWith({}), {
        YARN_NPM_AUDIT_REGISTRY: 'https://x',
      })
      .join(),
    /YARN_NPM_AUDIT_REGISTRY is set/,
  );
  assert.match(
    check
      .auditConfigProblems(
        () => ({ status: 1, stdout: '', stderr: 'Usage Error' }),
        {},
      )
      .join(),
    /yarn config get npmAuditIgnoreAdvisories exited 1/,
  );
  assert.match(
    check
      .auditConfigProblems(yarnWith({ npmAuditIgnoreAdvisories: 'nope' }), {})
      .join(),
    /unparseable/,
  );
});

test('F1 helpers: CHANGED TOGETHER paths and the decision-only test', () => {
  const R = check.REGISTER_REL;
  const together = [
    'yarn.lock',
    'package.json',
    'packages/rab-server/package.json',
    '.yarnrc.yml',
    '.yarn/releases/yarn-4.13.0.cjs',
    'tools/check-npm-audit.cjs',
    'packages/rab-docker/rab/runtime-deps.cjs',
    '.github/workflows/ci-security.yaml',
    '.github/workflows/npm-audit-weekly.yaml',
  ];
  assert.deepEqual(check.registerChangedWith(['yarn.lock']), []);
  assert.deepEqual(
    check.registerChangedWith([
      R,
      ...together,
      'THREAT-MODEL.md',
      'packages/rab-server/src/main.ts',
    ]),
    together,
  );
  assert.equal(check.isDecisionOnly([R]), true);
  assert.equal(check.isDecisionOnly([R, 'THREAT-MODEL.md']), true);
  assert.equal(check.isDecisionOnly(['THREAT-MODEL.md']), false);
  assert.equal(check.isDecisionOnly([R, 'README.md']), false);
  assert.equal(check.isDecisionOnly([]), false);
  const a = entry();
  assert.deepEqual(
    check.newOrChangedEntries(register(a), register({ ...a })),
    [],
  );
  assert.equal(
    check.newOrChangedEntries(
      register(a),
      register({ ...a, expires: '2026-12-16' }),
    ).length,
    1,
  );
  assert.deepEqual(check.newOrChangedEntries(register(), register(a)), [a]);
});

// ---- End to end, in throwaway git repositories (main(argv, deps)): the base ref decides (F1). ----

const PR_URL = 'https://github.com/Rabblo06/rab-recurit/pull/777';
const auditLine = (over = {}) =>
  JSON.stringify({
    value: 'picomatch',
    children: {
      ID: 1247710,
      Issue: 'ReDoS',
      URL: 'https://github.com/advisories/GHSA-fc5q-39xc-vjpf',
      Severity: 'high',
      'Vulnerable Versions': '<=4.0.7',
      'Tree Versions': ['2.3.2', '4.0.5'],
      Dependents: [],
      ...over,
    },
  });
/** A spawnSync-shaped yarn: `config` overrides `yarn config get`, `audit` replaces the audit result. */
const fakeYarn =
  ({ config = {}, audit } = {}) =>
  (args) => {
    if (args[0] === 'config' || args[0] === 'plugin')
      return configYarn(config)(args);
    if (args[0] === 'npm' && args[1] === 'audit')
      return audit || { status: 1, stdout: `${auditLine()}\n`, stderr: '' };
    if (args[0] === 'npm' && args[1] === 'info')
      return {
        status: 0,
        stdout: JSON.stringify({ versions: PUBLISHED }),
        stderr: '',
      };
    throw new Error(`unexpected yarn ${args.join(' ')}`);
  };
const registerDoc = (...decisions) =>
  `${JSON.stringify(register(...decisions), null, 2)}\n`;

function fixtureRepo(t) {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'npm-audit-'));
  const event = `${dir}-event.json`;
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(event, { force: true });
  });
  // Identity, signing and line endings pinned so the user's git config cannot change the fixture.
  const git = (...args) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=fixture',
        '-c',
        'user.email=fixture@example.invalid',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'core.autocrlf=false',
        ...args,
      ],
      { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  const write = (rel, body) => {
    fs.mkdirSync(dirname(join(dir, rel)), { recursive: true });
    fs.writeFileSync(join(dir, rel), body);
  };
  const commit = (msg) => {
    git('add', '-A');
    git('commit', '-q', '--allow-empty', '-m', msg);
  };
  git('init', '-q', '--initial-branch=main');
  fs.writeFileSync(
    event,
    JSON.stringify({ pull_request: { html_url: PR_URL } }),
  );
  return { dir, git, write, commit, event };
}

/** `main` holds `baseRegister` (null = no register file); then branch `pr` is checked out. */
function seed(t, baseRegister) {
  const r = fixtureRepo(t);
  r.write('README.md', 'fixture\n');
  r.write('yarn.lock', '# fixture\n');
  if (baseRegister !== null) r.write(check.REGISTER_REL, baseRegister);
  r.commit('base');
  r.git('checkout', '-q', '-b', 'pr');
  return r;
}

async function run(argv, r, over = {}) {
  const out = [];
  const saved = [console.log, console.error];
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => out.push(a.join(' '));
  try {
    const code = await check.main(argv, {
      root: r.dir,
      env: { GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: r.event },
      today: '2026-11-20',
      yarn: fakeYarn(),
      fetchAdvisory: async () => advisory(),
      production: () => [],
      ...over,
    });
    return { code, out: out.join('\n') };
  } finally {
    [console.log, console.error] = saved;
  }
}

const prEntry = (over = {}) => entry({ owner_decision_ref: PR_URL, ...over });

test('F1: an entry present only in the head does not cover the finding on a non-decision PR', async (t) => {
  const r = seed(t, registerDoc());
  r.write(check.REGISTER_REL, registerDoc(prEntry()));
  r.write('packages/x/src/a.ts', 'export const a = 1;\n');
  r.commit('approve and change code in one PR');
  const { code, out } = await run(['--base', 'main'], r);
  assert.equal(code, 1, out);
  assert.match(out, /decisions in force: .* from main \(base ref/);
  assert.match(out, /GHSA-fc5q-39xc-vjpf picomatch .*no owner decision/);
  // The same entry on the base covers it.
  const r2 = seed(t, registerDoc(prEntry()));
  r2.write('packages/x/src/a.ts', 'export const a = 1;\n');
  r2.commit('code only');
  const ok = await run(['--base', 'main'], r2);
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /1 decided, 0 undecided; 0 register error/);
});

test('F1: a decision-only PR (register + THREAT-MODEL.md) uses the head decisions; a new entry must cite this PR', async (t) => {
  const r = seed(t, registerDoc());
  r.write(check.REGISTER_REL, registerDoc(prEntry()));
  r.write('THREAT-MODEL.md', '## entry\n');
  r.commit('decision only');
  const ok = await run(['--base', 'main'], r);
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /from the head \(decision-only PR against main\)/);

  const wrongRef = seed(t, registerDoc());
  wrongRef.write(
    check.REGISTER_REL,
    registerDoc(
      entry({
        owner_decision_ref: 'https://github.com/Rabblo06/rab-recurit/pull/229',
      }),
    ),
  );
  wrongRef.commit('decision citing another PR');
  const bad = await run(['--base', 'main'], wrongRef);
  assert.equal(bad.code, 1);
  assert.match(
    bad.out,
    /must have owner_decision_ref https:\/\/github\.com\/Rabblo06\/rab-recurit\/pull\/777/,
  );

  // A changed entry (here: a renewal that keeps the old reference) is a new decision too.
  const renew = seed(t, registerDoc(entry()));
  renew.write(
    check.REGISTER_REL,
    registerDoc(entry({ decided_on: '2026-11-19', expires: '2026-12-19' })),
  );
  renew.commit('renewal keeping the old reference');
  assert.equal((await run(['--base', 'main'], renew)).code, 1);

  // Without the event payload the PR URL cannot be verified: fail closed.
  const noEvent = await run(['--base', 'main'], r, {
    env: { GITHUB_EVENT_NAME: 'pull_request' },
  });
  assert.equal(noEvent.code, 1);
  assert.match(noEvent.out, /GITHUB_EVENT_PATH is not set/);

  // Removing an entry needs no URL.
  const removal = seed(t, registerDoc(entry()));
  removal.write(check.REGISTER_REL, registerDoc());
  removal.commit('remove the entry');
  const rm = await run(['--base', 'main'], removal, {
    yarn: fakeYarn({ audit: { status: 0, stdout: '', stderr: '' } }),
  });
  assert.equal(rm.code, 0, rm.out);
});

test('F1: the register changed together with yarn.lock (or a package.json, the tool, the workflow) fails CHANGED TOGETHER', async (t) => {
  for (const other of [
    'yarn.lock',
    'packages/rab-server/package.json',
    'tools/check-npm-audit.cjs',
    '.github/workflows/ci-security.yaml',
  ]) {
    const r = seed(t, registerDoc(prEntry()));
    r.write(
      check.REGISTER_REL,
      registerDoc(
        prEntry({ reason: 'An edited reason, still long enough to be valid.' }),
      ),
    );
    r.write(other, '# changed\n');
    r.commit(`register + ${other}`);
    const { code, out } = await run(['--base', 'main'], r);
    assert.equal(code, 1, other);
    assert.ok(
      out.includes(
        `CHANGED TOGETHER tools/npm-audit-decisions.json and ${other}`,
      ),
      `${other}\n${out}`,
    );
  }
  // Uncommitted edits to tracked files count too.
  const u = seed(t, registerDoc());
  u.write(check.REGISTER_REL, registerDoc(prEntry()));
  u.write('yarn.lock', '# uncommitted\n');
  const { code, out } = await run(['--base', 'main'], u);
  assert.equal(code, 1);
  assert.match(out, /CHANGED TOGETHER/);
});

test('follow-up 1: a pure removal may go with yarn.lock (exit 0); an addition with yarn.lock still fails', async (t) => {
  const other = entry({ id: 'GHSA-2222-3333-4444', package: 'other' });
  const removal = seed(t, registerDoc(prEntry(), other));
  removal.write(check.REGISTER_REL, registerDoc(prEntry()));
  removal.write('yarn.lock', '# upgraded\n');
  removal.commit('removes an entry in the upgrade PR');
  const rm = await run(['--base', 'main'], removal);
  assert.equal(rm.code, 0, rm.out);
  assert.doesNotMatch(rm.out, /CHANGED TOGETHER/);
  const addition = seed(t, registerDoc(prEntry()));
  addition.write(
    check.REGISTER_REL,
    registerDoc(prEntry(), { ...other, owner_decision_ref: PR_URL }),
  );
  addition.write('yarn.lock', '# changed\n');
  addition.commit('adds an entry in a lockfile PR');
  const add = await run(['--base', 'main'], addition);
  assert.equal(add.code, 1);
  assert.match(
    add.out,
    /CHANGED TOGETHER tools\/npm-audit-decisions\.json and yarn\.lock/,
  );
  // The yarn-install action is on the list (follow-up 4).
  assert.deepEqual(
    check.registerChangedWith([
      check.REGISTER_REL,
      '.github/actions/yarn-install/action.yml',
    ]),
    ['.github/actions/yarn-install/action.yml'],
  );
});

test('follow-up 2: the audit connection is pinned (proxy, CA, TLS, per-host settings, plugins, env)', () => {
  const problems = (values, env = {}) =>
    check.auditConfigProblems(configYarn(values), env).join('\n');
  assert.equal(problems({}), '');
  assert.equal(problems({ networkSettings: '{}' }), '');
  const cases = [
    [{ httpsProxy: '"http://proxy.invalid:3128"' }, /httpsProxy must be unset/],
    [{ httpProxy: '"http://proxy.invalid:3128"' }, /httpProxy must be unset/],
    [
      { httpsCaFilePath: '"/tmp/evil-ca.pem"' },
      /httpsCaFilePath must be unset/,
    ],
    [{ enableStrictSsl: 'false' }, /enableStrictSsl must be true/],
    [
      {
        networkSettings:
          '{"registry.yarnpkg.com":{"httpsProxy":"http://proxy.invalid:3128"}}',
      },
      /networkSettings must be empty/,
    ],
    [{ networkSettings: 'nope' }, /networkSettings: unparseable/],
    [
      {
        __plugins: `${PLUGINS_DEFAULT}\n{"name":"plugin-evil","builtin":false}`,
      },
      /plugins must be \[\] \(built-ins only\), found plugin-evil/,
    ],
    [{ __plugins: 'not json' }, /yarn plugin runtime: unparseable/],
  ];
  for (const [values, re] of cases)
    assert.match(problems(values), re, JSON.stringify(values));
  for (const k of [
    'YARN_HTTPS_PROXY',
    'YARN_HTTP_PROXY',
    'NODE_EXTRA_CA_CERTS',
  ]) {
    assert.match(problems({}, { [k]: 'x' }), new RegExp(`${k} is set`), k);
  }
  assert.match(
    problems({}, { NODE_TLS_REJECT_UNAUTHORIZED: '0' }),
    /NODE_TLS_REJECT_UNAUTHORIZED=0 disables TLS/,
  );
  assert.equal(problems({}, { NODE_TLS_REJECT_UNAUTHORIZED: '1' }), '');
  // `plugin runtime` failing is a problem too (fail closed).
  assert.match(
    check
      .auditConfigProblems(
        (args) =>
          args[0] === 'plugin'
            ? { status: 1, stdout: '', stderr: 'boom' }
            : configYarn({})(args),
        {},
      )
      .join(),
    /yarn plugin runtime exited 1/,
  );
});

test('follow-up 3: an unknown argument exits 1, so a typo cannot turn --fail-on-expiring off', async (t) => {
  const r = seed(t, registerDoc(prEntry()));
  let audited = false;
  const yarn = (args) => {
    if (args[1] === 'audit') audited = true;
    return fakeYarn()(args);
  };
  for (const argv of [
    ['--fail-on-expire'],
    ['--fail-on-expiring', '--verbose'],
    ['extra'],
  ]) {
    const { code, out } = await run(argv, r, {
      env: { GITHUB_EVENT_NAME: 'schedule' },
      yarn,
    });
    assert.equal(code, 1, argv.join(' '));
    assert.match(out, /unknown argument/);
  }
  assert.equal(audited, false);
  // The known arguments still work.
  assert.equal(
    (
      await run(['--fail-on-expiring'], r, {
        env: { GITHUB_EVENT_NAME: 'schedule' },
      })
    ).code,
    0,
  );
});

test('F1: an unknown ref, a non-ref argument or a shallow clone fails closed (throws, never passes)', async (t) => {
  const r = seed(t, registerDoc(prEntry()));
  r.write('src.ts', 'x\n');
  r.commit('pr work');
  await assert.rejects(
    run(['--base', 'origin/does-not-exist'], r),
    /--base: git merge-base .* failed/,
  );
  await assert.rejects(
    run(['--base', '--output=/tmp/x'], r),
    /not a plain git ref/,
  );
  await assert.rejects(run(['--base', 'main..pr'], r), /not a plain git ref/);
  await assert.rejects(run(['--base'], r), /--base needs a git ref/);
  assert.throws(
    () => check.gitShowAt('origin/does-not-exist', check.REGISTER_REL, r.dir),
    /git show .* failed/,
  );
  assert.throws(
    () => check.readRegisterAt('origin/does-not-exist', r.dir),
    /git show .* failed/,
  );
  // Shallow (depth 1): the PR head and main have no merge-base in the clone.
  const shallow = fs.mkdtempSync(join(os.tmpdir(), 'npm-audit-shallow-'));
  t.after(() => fs.rmSync(shallow, { recursive: true, force: true }));
  execFileSync(
    'git',
    [
      'clone',
      '-q',
      '--depth',
      '1',
      '--no-single-branch',
      '--branch',
      'pr',
      `file://${r.dir.replace(/\\/g, '/')}`,
      shallow,
    ],
    { stdio: 'ignore' },
  );
  await assert.rejects(
    run(['--base', 'origin/main'], { ...r, dir: shallow }),
    /--base: git merge-base origin\/main HEAD failed/,
  );
});

test('F1: a base without the register file means no decisions (only "does not exist in" is tolerated)', async (t) => {
  const r = seed(t, null);
  r.write(check.REGISTER_REL, registerDoc(prEntry()));
  r.write('src.ts', 'x\n');
  r.commit('adds the register together with code');
  assert.deepEqual(check.readRegisterAt('main', r.dir), {
    schema: 2,
    decisions: [],
  });
  const { code, out } = await run(['--base', 'main'], r);
  assert.equal(code, 1);
  assert.match(out, /no owner decision/);
});

test('F1: git runs with LC_ALL=C and no LANGUAGE; a German locale still reads a missing path as absent', (t) => {
  const env = check.gitEnv({ LANGUAGE: 'de', LC_ALL: 'de_DE.UTF-8' });
  assert.equal(env.LC_ALL, 'C');
  assert.equal('LANGUAGE' in env, false);
  const r = seed(t, null);
  const keys = ['LC_ALL', 'LC_MESSAGES', 'LANG', 'LANGUAGE'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, {
    LC_ALL: 'de_DE.UTF-8',
    LC_MESSAGES: 'de_DE.UTF-8',
    LANG: 'de_DE.UTF-8',
    LANGUAGE: 'de',
  });
  try {
    assert.equal(check.gitShowAt('main', check.REGISTER_REL, r.dir), null);
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

test('F1: without --base (push to main, schedule) the checkout decides; a pull_request run without --base is refused', async (t) => {
  const r = seed(t, registerDoc(prEntry()));
  const push = await run([], r, { env: { GITHUB_EVENT_NAME: 'push' } });
  assert.equal(push.code, 0, push.out);
  assert.match(push.out, /from the checkout \(no --base\)/);
  const pr = await run([], r);
  assert.equal(pr.code, 1);
  assert.match(pr.out, /a pull_request run must pass --base/);
});

test('F3 (end to end): a non-empty ignore list or a YARN_NPM_AUDIT_* variable exits 1 before auditing', async (t) => {
  const r = seed(t, registerDoc(prEntry()));
  let audited = false;
  const yarn = (args) => {
    if (args[1] === 'audit') audited = true;
    return fakeYarn({
      config: { npmAuditIgnoreAdvisories: '["GHSA-2222-3333-4444"]' },
    })(args);
  };
  const ignored = await run([], r, { env: {}, yarn });
  assert.equal(ignored.code, 1);
  assert.match(ignored.out, /npmAuditIgnoreAdvisories must be empty/);
  assert.equal(audited, false);
  const envVar = await run([], r, {
    env: { YARN_NPM_AUDIT_EXCLUDE_PACKAGES: 'picomatch' },
  });
  assert.equal(envVar.code, 1);
  assert.match(envVar.out, /YARN_NPM_AUDIT_EXCLUDE_PACKAGES is set/);
});

test('F4 (end to end): a yarn that cannot run, is killed or exits outside {0, 1} exits 1', async (t) => {
  const r = seed(t, registerDoc(prEntry()));
  for (const audit of [
    {
      error: new Error('spawn yarn ENOENT'),
      status: null,
      stdout: '',
      stderr: '',
    },
    { signal: 'SIGTERM', status: null, stdout: `${auditLine()}\n`, stderr: '' },
    { status: 2, stdout: `${auditLine()}\n`, stderr: '' },
  ]) {
    const { code, out } = await run([], r, {
      env: {},
      yarn: fakeYarn({ audit }),
    });
    assert.equal(code, 1, JSON.stringify(audit));
    assert.match(
      out,
      /::error::yarn npm audit (could not run|was killed|exited 2)/,
    );
  }
  // Exit 1 with a report is the normal "findings" outcome.
  assert.equal((await run([], r, { env: {} })).code, 0);
});

test('F5/F6/F8 (end to end): no Tree Versions and a higher severity fail; 7 days left warns', async (t) => {
  const r = seed(t, registerDoc(prEntry()));
  const auditOf = (over) => ({
    status: 1,
    stdout: `${auditLine(over)}\n`,
    stderr: '',
  });
  const noTree = await run([], r, {
    env: {},
    yarn: fakeYarn({ audit: auditOf({ 'Tree Versions': [] }) }),
  });
  assert.equal(noTree.code, 1);
  assert.match(noTree.out, /no Tree Versions/);
  const critical = await run([], r, {
    env: {},
    yarn: fakeYarn({ audit: auditOf({ Severity: 'critical' }) }),
  });
  assert.equal(critical.code, 1);
  assert.match(critical.out, /critical is above the high/);
  const soon = await run([], r, { env: {}, today: '2026-12-11' });
  assert.equal(soon.code, 0, soon.out);
  assert.match(
    soon.out,
    /::warning::npm-audit-decisions\.json: GHSA-fc5q-39xc-vjpf expires 2026-12-17 \(6 day\(s\) left\)/,
  );
  assert.doesNotMatch((await run([], r, { env: {} })).out, /day\(s\) left/);
});

test('workflows: the PR audit reads the base with full history; a weekly schedule runs the same check', () => {
  const repo = join(__dirname, '..');
  const sec = readFileSync(
    join(repo, '.github/workflows/ci-security.yaml'),
    'utf8',
  );
  const audit = /^ {2}audit:\n([\s\S]*?)^ {2}\S/m.exec(sec)[1];
  assert.match(audit, /fetch-depth: 0/);
  assert.match(
    audit,
    /if: github\.event_name == 'pull_request'[\s\S]*?run: node tools\/check-npm-audit\.cjs --base "origin\/\$\{GITHUB_BASE_REF\}"/,
  );
  assert.match(
    audit,
    /if: github\.event_name != 'pull_request'[\s\S]*?run: node tools\/check-npm-audit\.cjs\n/,
  );
  const weekly = readFileSync(
    join(repo, '.github/workflows/npm-audit-weekly.yaml'),
    'utf8',
  );
  assert.match(weekly, /schedule:\n\s+- cron: '[^']+'/);
  assert.match(
    weekly,
    /run: node tools\/check-npm-audit\.cjs --fail-on-expiring\n/,
  );
});

test('F1: an invalid entry in the base register fails a non-decision PR, even when the PR drops it', async (t) => {
  const stale = entry({
    id: 'GHSA-2222-3333-4444',
    package: 'other',
    decided_on: '2026-10-01',
    expires: '2026-10-30',
  });
  const r = seed(t, registerDoc(prEntry(), stale));
  r.write(check.REGISTER_REL, registerDoc(prEntry()));
  r.write('src.ts', 'x\n');
  r.commit('drops the expired entry together with code');
  const { code, out } = await run(['--base', 'main'], r);
  assert.equal(code, 1, out);
  assert.match(out, /\(main\) decision\[1\] GHSA-2222-3333-4444: EXPIRED/);
  assert.match(out, /1 decided, 0 undecided; 1 register error/);
});

// ---- Security review of #238: G1, G3, G4 ----

test('G1: adding an entry together with a src/x.ts change exits 1 (it would be in force from the next PR on)', async (t) => {
  const r = seed(t, registerDoc(prEntry()));
  const other = entry({
    id: 'GHSA-2222-3333-4444',
    package: 'other',
    owner_decision_ref: PR_URL,
  });
  r.write(check.REGISTER_REL, registerDoc(prEntry(), other));
  r.write('src/x.ts', 'export const x = 1;\n');
  r.commit('adds an entry next to code');
  const { code, out } = await run(['--base', 'main'], r);
  assert.equal(code, 1, out);
  assert.match(
    out,
    /GHSA-2222-3333-4444 added or changed outside a decision-only PR/,
  );
  // The finding itself is still decided by the base entry: the only failure is the smuggled entry.
  assert.match(out, /1 decided, 0 undecided; 1 register error/);
  // Changing an existing entry next to code is refused the same way.
  const c = seed(t, registerDoc(prEntry()));
  c.write(
    check.REGISTER_REL,
    registerDoc(
      prEntry({ reason: 'A reworded reason, still long enough to pass.' }),
    ),
  );
  c.write('src/x.ts', 'export const x = 1;\n');
  c.commit('edits an entry next to code');
  const changed = await run(['--base', 'main'], c);
  assert.equal(changed.code, 1, changed.out);
  assert.match(changed.out, /GHSA-fc5q-39xc-vjpf added or changed outside/);
});

test('G1: removing an entry together with a src/x.ts change exits 0', async (t) => {
  const other = entry({ id: 'GHSA-2222-3333-4444', package: 'other' });
  const r = seed(t, registerDoc(prEntry(), other));
  r.write(check.REGISTER_REL, registerDoc(prEntry()));
  r.write('src/x.ts', 'export const x = 1;\n');
  r.commit('removes an unused entry next to code');
  const { code, out } = await run(['--base', 'main'], r);
  assert.equal(code, 0, out);
  assert.doesNotMatch(out, /added or changed outside/);
});

test('G1: entries are compared with the merge-base, so a base that moved on does not flag an untouched entry', async (t) => {
  const other = entry({ id: 'GHSA-2222-3333-4444', package: 'other' });
  const r = seed(t, registerDoc(prEntry(), other));
  // main moves on: the other entry is removed there.
  r.git('checkout', '-q', 'main');
  r.write(check.REGISTER_REL, registerDoc(prEntry()));
  r.commit('main removes the other entry');
  r.git('checkout', '-q', 'pr');
  // The PR touches the register (drops nothing new, edits nothing) only by keeping an older copy plus code.
  r.write(
    check.REGISTER_REL,
    registerDoc(prEntry(), other).replace(/\n$/, '\n\n'),
  );
  r.write('src/x.ts', 'export const x = 1;\n');
  r.commit('whitespace in the register next to code');
  const { code, out } = await run(['--base', 'main'], r);
  assert.doesNotMatch(out, /added or changed outside/);
  assert.equal(code, 0, out);
});

test('G3: --fail-on-expiring (the weekly run) exits 1 at 7 days or fewer left; without it, only a warning', async (t) => {
  const r = seed(t, registerDoc(prEntry()));
  const env = { GITHUB_EVENT_NAME: 'schedule' };
  const warnOnly = await run([], r, { env, today: '2026-12-10' });
  assert.equal(warnOnly.code, 0, warnOnly.out);
  assert.match(warnOnly.out, /::warning::.*7 day\(s\) left/);
  const weekly = await run(['--fail-on-expiring'], r, {
    env,
    today: '2026-12-10',
  });
  assert.equal(weekly.code, 1, weekly.out);
  assert.match(
    weekly.out,
    /::error::.*expires 2026-12-17, 7 day\(s\) left \(--fail-on-expiring/,
  );
  const early = await run(['--fail-on-expiring'], r, {
    env,
    today: '2026-12-09',
  });
  assert.equal(early.code, 0, early.out);
});

test('G4: the audit registry must be the default; YARN_NPM_REGISTRY_SERVER / YARN_NPM_AUDIT_REGISTRY are refused', async (t) => {
  const yarnWith = configYarn;
  assert.deepEqual(check.auditConfigProblems(yarnWith({}), {}), []);
  assert.deepEqual(
    check.auditConfigProblems(
      yarnWith({ npmRegistryServer: '"https://registry.npmjs.org"' }),
      {},
    ),
    [],
  );
  assert.match(
    check
      .auditConfigProblems(
        yarnWith({ npmAuditRegistry: '"https://audit.example.invalid"' }),
        {},
      )
      .join(),
    /npmAuditRegistry must be unset/,
  );
  assert.match(
    check
      .auditConfigProblems(
        yarnWith({ npmRegistryServer: '"https://mirror.example.invalid"' }),
        {},
      )
      .join(),
    /npmRegistryServer must be https:\/\/registry\.yarnpkg\.com or https:\/\/registry\.npmjs\.org/,
  );
  for (const k of ['YARN_NPM_REGISTRY_SERVER', 'YARN_NPM_AUDIT_REGISTRY']) {
    assert.match(
      check.auditConfigProblems(yarnWith({}), { [k]: 'https://x' }).join(),
      new RegExp(`${k} is set`),
    );
  }
  // End to end: a non-default registry exits 1 before auditing.
  const r = seed(t, registerDoc(prEntry()));
  let audited = false;
  const yarn = (args) => {
    if (args[1] === 'audit') audited = true;
    return fakeYarn({
      config: { npmRegistryServer: '"https://mirror.example.invalid"' },
    })(args);
  };
  const res = await run([], r, { env: {}, yarn });
  assert.equal(res.code, 1);
  assert.equal(audited, false);
});

test('G3: the weekly workflow runs with --fail-on-expiring', () => {
  const weekly = readFileSync(
    join(__dirname, '..', '.github/workflows/npm-audit-weekly.yaml'),
    'utf8',
  );
  assert.match(
    weekly,
    /run: node tools\/check-npm-audit\.cjs --fail-on-expiring\n/,
  );
});
