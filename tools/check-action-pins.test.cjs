'use strict';
// node --test tools/check-action-pins.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { scan, scanSource, classify, makeApi, verifyRemote } = require('./check-action-pins.cjs');

const SHA = 'cf430e030ddbb5b0abf93d22962f4752f3646cd9';
const SHA2 = '0e4a8c6effa4802afeda77dc8d303f8176d7dfad';
const TAG_OBJ = '15192bc058cc28a13dbf6cde61f19e18988b7af6';
const DIGEST = 'a'.repeat(64);
const msgs = (src) => scanSource('w.yaml', src).problems.map((p) => `${p.line}:${p.message}`);

test('a full commit SHA with a vX.Y.Z comment passes; local actions and docker digests are exempt', () => {
  const src = [
    'jobs:',
    '  a:',
    '    uses: ./.github/workflows/changed-files.yaml',
    '    steps:',
    `      - uses: actions/upload-artifact@${SHA} # v7.0.2`,
    `      - uses: 'github/codeql-action/init@${SHA}' # v4.39.3`,
    `      - uses: "owner/repo/.github/workflows/x.yml@${SHA}"   #   v1.2.3-rc.1`,
    '      - uses: ./.github/actions/yarn-install',
    `      - uses: docker://alpine:3.20@sha256:${DIGEST}`,
    `      - uses: docker://ghcr.io/o/i@sha256:${DIGEST}`,
  ].join('\n');
  const { refs, problems } = scanSource('w.yaml', src);
  assert.deepEqual(problems, []);
  assert.deepEqual(
    refs.map((r) => r.kind),
    ['local', 'remote', 'remote', 'remote', 'local', 'docker', 'docker'],
  );
  assert.deepEqual(refs[2], { file: 'w.yaml', line: 6, value: `github/codeql-action/init@${SHA}`, kind: 'remote', repo: 'github/codeql-action', sha: SHA, tag: 'v4.39.3' });
});

test('tags, branches, short and upper-case SHAs are refused', () => {
  for (const ref of ['v4', 'v4.6.2', 'main', SHA.slice(0, 7), SHA.slice(0, 39), SHA.toUpperCase(), `${SHA}0`]) {
    const p = msgs(`steps:\n  - uses: actions/checkout@${ref} # v4.4.0`);
    assert.equal(p.length, 1, ref);
    assert.match(p[0], /not pinned to a full 40-character commit SHA/, ref);
  }
});

test('a SHA without a "# vX.Y.Z" comment (or with a moving major-only comment) is refused', () => {
  assert.match(msgs(`- uses: a/b@${SHA}`)[0], /needs a "# vX.Y.Z" comment .*none/);
  assert.match(msgs(`- uses: a/b@${SHA} # v4`)[0], /needs a "# vX.Y.Z" comment .*"# v4"/);
  assert.match(msgs(`- uses: a/b@${SHA} # latest`)[0], /needs a "# vX.Y.Z" comment/);
});

test('docker references without a digest, and unknown references, are refused', () => {
  assert.match(msgs('- uses: docker://alpine:3.20')[0], /not pinned by digest/);
  assert.match(msgs('- uses: docker://alpine@sha256:abc')[0], /not pinned by digest/);
  assert.match(msgs(`- uses: ../outside@${SHA} # v1.0.0`)[0], /not a recognised action reference/);
  assert.match(msgs('- uses: actions/checkout')[0], /not a recognised action reference/);
});

test('forms the scanner cannot read fail closed instead of being skipped', () => {
  assert.match(msgs(`- { name: x, uses: actions/checkout@v4 }`)[0], /unrecognised "uses:" form/);
  assert.match(msgs('- uses:\n    actions/checkout@v4')[0], /unrecognised "uses:" form/);
  assert.match(msgs('- uses: *checkout')[0], /literal reference/);
  assert.match(msgs(`- "uses": actions/checkout@v4`)[0], /unrecognised "uses:" form/);
});

test('"uses:" text inside a run block, and in comments, is not a step', () => {
  const src = [
    'steps:',
    '  - run: |',
    '      echo "uses: actions/checkout@v4"',
    '',
    '        uses: still-inside-the-block@main',
    '  - name: next',
    `    uses: a/b@${SHA} # v1.0.0`,
    '  # - uses: actions/checkout@v4',
    `  - uses: a/b@${SHA} # v1.0.0 (uses: x@main in a trailing comment)`,
    '  - with:',
    '      script: >-',
    '        uses: also@text',
    '    uses: actions/checkout@main',
  ].join('\n');
  const r = scanSource('w.yaml', src);
  assert.deepEqual(r.refs.map((x) => x.line), [7, 9, 13]);
  assert.deepEqual(r.problems.map((p) => p.line), [13]);
});

test('classify() extracts the repository of sub-path actions and reusable workflows', () => {
  assert.equal(classify(`github/codeql-action/upload-sarif@${SHA}`, 'v4.39.3').repo, 'github/codeql-action');
  assert.equal(classify(`o/r/.github/workflows/w.yaml@${SHA}`, 'v1.0.0').repo, 'o/r');
});

test('scan() walks .github/workflows and .github/actions (nested composite actions included)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pins-'));
  fs.mkdirSync(path.join(root, '.github/workflows'), { recursive: true });
  fs.mkdirSync(path.join(root, '.github/actions/a/b'), { recursive: true });
  fs.writeFileSync(path.join(root, '.github/workflows/ok.yml'), `steps:\n  - uses: a/b@${SHA} # v1.0.0\n`);
  fs.writeFileSync(path.join(root, '.github/actions/a/b/action.yaml'), 'runs:\n  steps:\n    - uses: actions/setup-node@v4\n');
  fs.writeFileSync(path.join(root, '.github/actions/a/README.md'), '- uses: actions/setup-node@v4\n');
  const r = scan(root);
  assert.equal(r.files.length, 2);
  assert.deepEqual(r.problems.map((p) => `${p.file}:${p.line}`), ['.github/actions/a/b/action.yaml:3']);
  assert.equal(scan(fs.mkdtempSync(path.join(os.tmpdir(), 'pins-empty-'))).problems.length, 1, 'an empty tree fails');
});

test('this repository: every uses is pinned (offline half)', () => {
  const r = scan();
  assert.deepEqual(r.problems, []);
  assert.ok(r.refs.filter((x) => x.kind === 'remote').length > 20);
});

// --- remote ----------------------------------------------------------------------------------------------------------

// A fake GitHub API: commits, tag objects and refs of one repository.
function fakeGitHub({ commits = [], tagObjects = {}, refs = {}, failPaths = [] }) {
  const calls = [];
  const fetchImpl = async (url) => {
    const p = url.replace('https://api.github.com', '');
    calls.push(p);
    const json = (status, body) => ({ status, json: async () => body });
    if (failPaths.some((f) => p.includes(f))) return json(500, {});
    let m;
    if ((m = /^\/repos\/o\/r\/git\/commits\/(\w+)$/.exec(p))) return commits.includes(m[1]) ? json(200, { sha: m[1] }) : json(404, null);
    if ((m = /^\/repos\/o\/r\/git\/tags\/(\w+)$/.exec(p))) return tagObjects[m[1]] ? json(200, tagObjects[m[1]]) : json(404, null);
    if ((m = /^\/repos\/o\/r\/git\/ref\/tags\/(.+)$/.exec(p))) {
      const t = decodeURIComponent(m[1]);
      return refs[t] ? json(200, { ref: `refs/tags/${t}`, object: refs[t] }) : json(404, null);
    }
    return json(404, null);
  };
  return { get: makeApi({ token: 't', fetchImpl, retries: 1, sleep: async () => {} }), calls };
}
const ref = (sha, tag, line = 1) => ({ file: 'w.yaml', line, kind: 'remote', repo: 'o/r', sha, tag });

test('remote: a commit whose comment tag (lightweight or annotated) points at it passes', async () => {
  const { get } = fakeGitHub({
    commits: [SHA, SHA2],
    tagObjects: { [TAG_OBJ]: { tag: 'v3.0.4', object: { type: 'commit', sha: SHA2 } } },
    refs: { 'v7.0.2': { type: 'commit', sha: SHA }, 'v3.0.4': { type: 'tag', sha: TAG_OBJ } },
  });
  assert.deepEqual(await verifyRemote([ref(SHA, 'v7.0.2'), ref(SHA2, 'v3.0.4')], get), []);
});

test('remote: a TAG OBJECT SHA is refused and the commit to pin is named (the old dorny/paths-filter pin)', async () => {
  const { get } = fakeGitHub({
    commits: [SHA2],
    tagObjects: { [TAG_OBJ]: { tag: 'v3', object: { type: 'commit', sha: SHA2 } } },
  });
  const p = await verifyRemote([ref(TAG_OBJ, 'v3.0.4', 4), ref(TAG_OBJ, 'v3.0.4', 9)], get);
  assert.equal(p.length, 2, 'every line using it is reported');
  assert.match(p[0].message, new RegExp(`TAG OBJECT \\(tag "v3"\\).*: ${SHA2}$`));
});

test('remote: an unknown SHA, a missing comment tag and a mislabelled comment are refused', async () => {
  const { get } = fakeGitHub({ commits: [SHA, SHA2], refs: { 'v1.0.0': { type: 'commit', sha: SHA2 } } });
  const p = await verifyRemote([ref('b'.repeat(40), 'v1.0.0'), ref(SHA, 'v9.9.9'), ref(SHA, 'v1.0.0')], get);
  assert.deepEqual(
    p.map((x) => x.message.replace(/^o\/r@\w+: /, '')),
    ['no such commit in o/r', 'the comment names "v9.9.9", which is not a tag of o/r', `the comment says "v1.0.0", but v1.0.0 is commit ${SHA2}`],
  );
});

test('remote: an API failure fails closed; each distinct pin is looked up once', async () => {
  const failing = fakeGitHub({ commits: [SHA], failPaths: ['/git/commits/'] });
  const p = await verifyRemote([ref(SHA, 'v1.0.0')], failing.get);
  assert.match(p[0].message, /verification failed \(fail closed\): GET .* HTTP 500/);

  const ok = fakeGitHub({ commits: [SHA], refs: { 'v1.0.0': { type: 'commit', sha: SHA } } });
  await verifyRemote([ref(SHA, 'v1.0.0', 1), ref(SHA, 'v1.0.0', 2), ref(SHA, 'v1.0.0', 3)], ok.get);
  assert.equal(ok.calls.length, 2);
});

test('remote: no token is an error, never a silent skip', () => {
  assert.throws(() => makeApi({ token: '' }), /GITHUB_TOKEN/);
});

// --- review of PR #236: forms that YAML decodes as `uses` but a line scanner alone would miss ----------------------

const BS = String.fromCharCode(92);
const allMsgs = (src) => scanSource('w.yaml', src).problems.map((p) => p.message);

test('an escaped quoted key that decodes to "uses" is refused (x73 and u0075 escapes, with and without a dash)', () => {
  for (const src of [
    `steps:\n  - "u${BS}x73es": actions/checkout@v4\n`,
    `steps:\n  - "${BS}u0075ses": actions/checkout@v4\n`,
    `jobs:\n  x:\n    "u${BS}x73es": o/r/.github/workflows/x.yml@main\n`,
  ]) {
    const m = allMsgs(src);
    assert.ok(m.some((x) => /quoted key with an escape sequence/.test(x)), src);
    assert.ok(m.some((x) => /YAML parser reads a "uses: .*@(v4|main)"/.test(x)), `cross-check also catches it: ${src}`);
  }
});

test('an explicit "? uses" key is refused', () => {
  const m = allMsgs('steps:\n  - ? uses\n    : actions/checkout@v4\n');
  assert.ok(m.some((x) => /explicit "\? key"/.test(x)));
  assert.ok(m.some((x) => /YAML parser reads a "uses: actions\/checkout@v4"/.test(x)));
});

test('a block-scalar indicator inside an open flow collection does not hide the next lines', () => {
  for (const src of [
    'jobs:\n  b:\n    runs-on: x\n    steps:\n      - {name: x:|\n         , uses: evil/act@main}\n',
    'jobs:\n  b:\n    runs-on: x\n    steps:\n      - name: a\n        with: {k: v:>\n          }\n        uses: evil/act@main\n',
  ]) {
    const m = allMsgs(src);
    assert.ok(m.some((x) => /block-scalar indicator inside an open/.test(x)), src);
    assert.ok(m.some((x) => /evil\/act@main/.test(x)), src);
  }
});

test('YAML cross-check: aliases, << merges, escaped values and unparseable files fail', () => {
  assert.ok(allMsgs(`x: &s\n  uses: a/b@${SHA}\nsteps:\n  - <<: *s\n`).some((x) => /YAML parser reads a "uses: a\/b@/.test(x)), 'merge');
  assert.ok(allMsgs(`a: &s {uses: a/b@main}\nsteps:\n  - *s\n`).some((x) => /YAML parser reads/.test(x)), 'alias');
  assert.ok(allMsgs(`steps:\n  - uses: "actions/checkout@${BS}x764"\n`).some((x) => /value with an escape sequence/.test(x)));
  assert.ok(allMsgs('steps:\n  - uses: a/b@main\n bad: [\n').some((x) => /YAML does not parse/.test(x)));
  assert.ok(allMsgs(`a:\n  uses: x/y@${SHA} # v1.0.0\n  uses: x/y@main\n`).some((x) => /YAML does not parse/.test(x)), 'duplicate key');
});

test('local actions: only ./.github/actions/ and ./.github/workflows/ are exempt', () => {
  assert.deepEqual(msgs('- uses: ./.github/actions/yarn-install\n- uses: ./.github/workflows/changed-files.yaml'), []);
  for (const v of ['./node_modules/evil', './tools/x', './.github/actions/../../node_modules/x', './.github/other/a']) {
    assert.match(msgs(`- uses: ${v}`)[0], /local reference outside/, v);
  }
});
