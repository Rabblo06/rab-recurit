'use strict';
// node --test tools/create-github-release.test.cjs
//
// cd-deploy-tag only runs on a pushed tag, so its `gh release create` would otherwise first execute on a real release.
// These tests run the script on every PR: a dry run, a run against a recording `gh` (exact argv and notes), the refusals,
// the installed gh's own flag list (every flag the script passes must exist), and the workflow wiring.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'tools/create-github-release.sh');
const WORKFLOW = path.join(ROOT, '.github/workflows/cd-deploy-tag.yaml');
const SHA = '0123456789abcdef0123456789abcdef01234567';
const ENV = { TAG: 'v1.2.3', GITHUB_REPOSITORY: 'Owner/repo', GITHUB_SHA: SHA };
const toPosix = (p) => p.split(path.sep).join('/');

// A `gh` that records its argv (one per line) and the notes file it was given, then succeeds.
function fakeGh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-gh-'));
  const log = path.join(dir, 'argv');
  const notes = path.join(dir, 'notes');
  fs.writeFileSync(
    path.join(dir, 'gh'),
    [
      '#!/usr/bin/env bash',
      `printf '%s\\n' "$@" > '${toPosix(log)}'`,
      'prev=""',
      `for a in "$@"; do [ "$prev" = "--notes-file" ] && cp "$a" '${toPosix(notes)}'; prev="$a"; done`,
      'exit 0',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return { dir, log, notes };
}

function run(env, extraPath) {
  const base = { ...process.env };
  delete base.DRY_RUN;
  for (const k of Object.keys(ENV)) delete base[k];
  if (extraPath) base.PATH = `${extraPath}${path.delimiter}${base.PATH}`;
  return spawnSync('bash', [toPosix(SCRIPT)], { env: { ...base, ...env }, encoding: 'utf8' });
}

test('gh release create gets exactly: the tag, --repo, --verify-tag, --title <tag>, --generate-notes, our notes', () => {
  const gh = fakeGh();
  const r = run(ENV, gh.dir);
  assert.equal(r.status, 0, r.stderr);
  const argv = fs.readFileSync(gh.log, 'utf8').trimEnd().split('\n');
  const notesArg = argv[argv.indexOf('--notes-file') + 1];
  assert.deepEqual(argv, [
    'release', 'create', 'v1.2.3', '--repo', 'Owner/repo', '--verify-tag', '--title', 'v1.2.3', '--generate-notes',
    '--notes-file', notesArg,
  ]);
  const notes = fs.readFileSync(gh.notes, 'utf8');
  assert.ok(notes.startsWith(`Release image (API + Worker, one image): \`docker.io/adhin007/adolphus:${SHA}\`, published by\n`));
  assert.match(notes, /set `CREWFLOW_IMAGE_TAG=sha256:<index digest>` in `compose.env`/);
  assert.match(notes, /Rollback: `CREWFLOW_IMAGE_TAG=<previous digest>`, then the same command; both go back together\.\n$/);
  assert.doesNotMatch(notes, /\$\(|\$\{/, 'no unexpanded shell in the notes');
});

test('DRY_RUN=1 prints the command and the notes and never calls gh', () => {
  const gh = fakeGh();
  const r = run({ ...ENV, DRY_RUN: '1' }, gh.dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^dry run: gh release create v1\.2\.3 --repo Owner\/repo --verify-tag --title v1\.2\.3 --generate-notes --notes-file \S+/);
  assert.match(r.stdout, new RegExp(`adolphus:${SHA}`));
  assert.equal(fs.existsSync(gh.log), false);
});

test('bad or missing inputs are refused before gh runs', () => {
  const cases = [
    { ...ENV, TAG: '' },
    { ...ENV, TAG: 'main' },
    { ...ENV, TAG: '--draft' },
    { ...ENV, TAG: 'v1.2' },
    { ...ENV, GITHUB_SHA: 'abc' },
    { ...ENV, GITHUB_REPOSITORY: 'a/b c' },
    { TAG: 'v1.2.3', GITHUB_REPOSITORY: 'Owner/repo' },
  ];
  for (const env of cases) {
    const gh = fakeGh();
    const r = run(env, gh.dir);
    assert.notEqual(r.status, 0, JSON.stringify(env));
    assert.equal(fs.existsSync(gh.log), false, JSON.stringify(env));
  }
  const gh = fakeGh();
  assert.equal(run({ ...ENV, TAG: 'v1.2.3-rc.1' }, gh.dir).status, 0, 'a suffixed version tag is accepted');
});

test('the installed gh knows every flag the script passes (static check of the real CLI)', (t) => {
  const help = spawnSync('gh', ['release', 'create', '--help'], { encoding: 'utf8' });
  if (help.error || help.status !== 0) {
    if (process.env.CI) assert.fail('gh is preinstalled on GitHub runners; it must be found here');
    t.skip('gh not installed locally');
    return;
  }
  const text = help.stdout;
  for (const flag of ['--repo', '--verify-tag', '--title', '--generate-notes', '--notes-file']) {
    assert.match(text, new RegExp(`(^|\\s)${flag}\\b`, 'm'), flag);
  }
  assert.match(text, /prepended to\s+automatically generated notes/, 'gh still prepends our notes to the generated ones');
});

test('cd-deploy-tag: no third-party release action, least privilege, no persisted checkout credential', () => {
  const y = fs.readFileSync(WORKFLOW, 'utf8');
  assert.doesNotMatch(y, /action-gh-release/);
  assert.match(y, /^permissions: \{\}$/m, 'nothing at the workflow level');
  const perms = [...y.matchAll(/^ {4}permissions:\n((?: {6}.*\n)+)/gm)].map((m) => m[1].replace(/\s*#.*$/gm, '').trim());
  assert.deepEqual(perms, ['contents: write'], 'the release job writes contents and nothing else');
  assert.match(y, /uses: actions\/checkout@[0-9a-f]{40} # v\S+\n\s+with:\n\s+persist-credentials: false\n/);
  assert.match(y, /GH_TOKEN: \$\{\{ github\.token \}\}\n\s+TAG: \$\{\{ github\.ref_name \}\}\n\s+run: bash tools\/create-github-release\.sh\n/);
  assert.doesNotMatch(y, /DRY_RUN/);
});
