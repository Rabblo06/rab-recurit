'use strict';
// node --test tools/create-github-release.test.cjs
//
// cd-deploy-tag only runs on a pushed tag, so its gh calls would otherwise first execute on a real release. These tests
// run the script on every PR: a dry run, runs against a recording `gh` (release missing -> exact `create --draft` argv and
// notes; release already published or drafted -> nothing created; lookup failure -> fail closed), the refusals, the
// alignment with publish-image's release guard, the installed gh's own flag list, and the workflow wiring.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'tools/create-github-release.sh');
const WORKFLOW = path.join(ROOT, '.github/workflows/cd-deploy-tag.yaml');
const PUBLISH = path.join(ROOT, '.github/workflows/publish-image.yaml');
const GUARD = path.join(ROOT, 'packages/rab-docker/scripts/image-security/release_guard.py');
const SHA = '0123456789abcdef0123456789abcdef01234567';
const ENV = { TAG: 'rab/v1.2.3', GITHUB_REPOSITORY: 'Owner/repo', GITHUB_SHA: SHA };
const URL = 'https://github.com/Owner/repo/releases/tag/rab/v1.2.3';
const toPosix = (p) => p.split(path.sep).join('/');

// A `gh` that records every call (argv, one per line, in calls/<n>) and the notes file it was given.
//   release view   -> FAKE_VIEW: missing ("release not found", exit 1) | published | draft | error (HTTP 502, exit 1)
//   release create -> exit 0
function fakeGh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-gh-'));
  const calls = path.join(dir, 'calls');
  const notes = path.join(dir, 'notes');
  fs.mkdirSync(calls);
  fs.writeFileSync(
    path.join(dir, 'gh'),
    [
      '#!/usr/bin/env bash',
      `n=$(ls '${toPosix(calls)}' | wc -l)`,
      `printf '%s\\n' "$@" > '${toPosix(calls)}'/$((n + 1))`,
      'prev=""',
      `for a in "$@"; do [ "$prev" = "--notes-file" ] && cp "$a" '${toPosix(notes)}'; prev="$a"; done`,
      'if [ "$1 $2" = "release view" ]; then',
      '  case "${FAKE_VIEW:-missing}" in',
      '    missing) echo "release not found" >&2; exit 1 ;;',
      `    published) echo "false ${URL}"; exit 0 ;;`,
      `    draft) echo "true ${URL}"; exit 0 ;;`,
      '    *) echo "HTTP 502: Bad Gateway (https://api.github.com/repos/Owner/repo/releases/tags/rab/v1.2.3)" >&2; exit 1 ;;',
      '  esac',
      'fi',
      'exit 0',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  const read = () =>
    fs
      .readdirSync(calls)
      .sort((a, b) => a - b)
      .map((f) => fs.readFileSync(path.join(calls, f), 'utf8').trimEnd().split('\n'));
  return { dir, notes, calls: read };
}

function run(env, extraPath) {
  const base = { ...process.env };
  for (const k of ['DRY_RUN', 'FAKE_VIEW', 'GITHUB_STEP_SUMMARY', ...Object.keys(ENV)]) delete base[k];
  if (extraPath) base.PATH = `${extraPath}${path.delimiter}${base.PATH}`;
  return spawnSync('bash', [toPosix(SCRIPT)], { env: { ...base, ...env }, encoding: 'utf8' });
}

const VIEW = ['release', 'view', 'rab/v1.2.3', '--repo', 'Owner/repo', '--json', 'isDraft,url', '--jq', '"\\(.isDraft) \\(.url)"'];

test('no release yet: one lookup, then gh release create --draft with the tag, title "Crewflow vX.Y.Z" and our notes', () => {
  const gh = fakeGh();
  const summary = path.join(gh.dir, 'summary.md');
  const r = run({ ...ENV, FAKE_VIEW: 'missing', GITHUB_STEP_SUMMARY: summary }, gh.dir);
  assert.equal(r.status, 0, r.stderr);
  const [view, create, ...rest] = gh.calls();
  assert.deepEqual(rest, []);
  assert.deepEqual(view, VIEW);
  const notesArg = create[create.indexOf('--notes-file') + 1];
  assert.deepEqual(create, [
    'release', 'create', 'rab/v1.2.3', '--repo', 'Owner/repo', '--verify-tag', '--draft', '--title', 'Crewflow v1.2.3',
    '--generate-notes', '--notes-file', notesArg,
  ]);
  const notes = fs.readFileSync(gh.notes, 'utf8');
  assert.ok(notes.startsWith(`Release image (API + Worker, one image): \`docker.io/adhin007/adolphus:${SHA}\`, published by\n`));
  assert.match(notes, /set `CREWFLOW_IMAGE_TAG=sha256:<index digest>` in `compose.env`/);
  assert.match(notes, /Rollback: `CREWFLOW_IMAGE_TAG=<previous digest>`, then the same command; both go back together\.\n$/);
  assert.doesNotMatch(notes, /\$\(|\$\{/, 'no unexpanded shell in the notes');
  // The hand-over is written where the owner sees it: publish the draft by hand, nothing started yet.
  const s = fs.readFileSync(summary, 'utf8');
  assert.match(s, /### rab\/v1\.2\.3: draft release created/);
  assert.match(s, /`publish-image` has NOT started/);
  assert.match(s, /\*\*Publish release\*\*/);
});

test('a prerelease tag (rab/vX.Y.Z-suffix) is drafted as a prerelease, like rab/v0.2.0-beta', () => {
  const gh = fakeGh();
  const r = run({ ...ENV, TAG: 'rab/v1.2.3-rc.1', FAKE_VIEW: 'missing' }, gh.dir);
  assert.equal(r.status, 0, r.stderr);
  const create = gh.calls()[1];
  assert.equal(create[2], 'rab/v1.2.3-rc.1');
  assert.equal(create[create.indexOf('--title') + 1], 'Crewflow v1.2.3-rc.1');
  assert.equal(create.at(-1), '--prerelease');
});

test('a release that already exists (published by a person, or a draft) is left alone: no create', () => {
  for (const [state, word] of [['published', 'published'], ['draft', 'draft']]) {
    const gh = fakeGh();
    const summary = path.join(gh.dir, 'summary.md');
    const r = run({ ...ENV, FAKE_VIEW: state, GITHUB_STEP_SUMMARY: summary }, gh.dir);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(gh.calls(), [VIEW], state);
    assert.ok(r.stdout.includes(`a ${word} release for rab/v1.2.3 already exists (${URL}); nothing to do`), r.stdout);
    assert.match(fs.readFileSync(summary, 'utf8'), new RegExp(`a ${word} release already exists`));
  }
});

test('a lookup that fails for any reason other than "release not found" fails the job and creates nothing', () => {
  const gh = fakeGh();
  const r = run({ ...ENV, FAKE_VIEW: 'error' }, gh.dir);
  assert.notEqual(r.status, 0);
  assert.deepEqual(gh.calls(), [VIEW]);
  assert.match(r.stdout, /::error::could not tell whether a release for rab\/v1\.2\.3 exists: HTTP 502/);
});

test('DRY_RUN=1 prints both commands and the notes and never calls gh', () => {
  const gh = fakeGh();
  const r = run({ ...ENV, DRY_RUN: '1' }, gh.dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^dry run: gh release view rab\/v1\.2\.3 --repo Owner\/repo --json isDraft,url --jq /m);
  assert.match(
    r.stdout,
    /^dry run: gh release create rab\/v1\.2\.3 --repo Owner\/repo --verify-tag --draft --title Crewflow v1\.2\.3 --generate-notes --notes-file \S+$/m,
  );
  assert.match(r.stdout, new RegExp(`adolphus:${SHA}`));
  assert.deepEqual(gh.calls(), []);
});

test('bad or missing inputs are refused before gh runs (a bare vX.Y.Z tag included)', () => {
  const cases = [
    { ...ENV, TAG: '' },
    { ...ENV, TAG: 'main' },
    { ...ENV, TAG: '--draft' },
    { ...ENV, TAG: 'v1.2.3' },
    { ...ENV, TAG: 'rab/v1.2' },
    { ...ENV, TAG: 'rab/v1.2.3+build' },
    { ...ENV, TAG: 'other/rab/v1.2.3' },
    { ...ENV, GITHUB_SHA: 'abc' },
    { ...ENV, GITHUB_REPOSITORY: 'a/b c' },
    { TAG: 'rab/v1.2.3', GITHUB_REPOSITORY: 'Owner/repo' },
  ];
  for (const env of cases) {
    const gh = fakeGh();
    const r = run(env, gh.dir);
    assert.notEqual(r.status, 0, JSON.stringify(env));
    assert.deepEqual(gh.calls(), [], JSON.stringify(env));
  }
});

test("the script accepts exactly the tags publish-image's release guard accepts (RELEASE_TAG)", () => {
  const src = fs.readFileSync(GUARD, 'utf8');
  const m = /^RELEASE_TAG = re\.compile\(r'([^']+)'\)$/m.exec(src);
  assert.ok(m, 'release_guard.py RELEASE_TAG not found');
  const guard = new RegExp(`^(?:${m[1]})$`); // Python fullmatch
  const samples = ['rab/v0.6.0', 'rab/v0.2.0-beta', 'rab/v0.1.0-beta.1', 'rab/v10.20.30-rc.1', 'v0.6.0', 'rab/v0.6', 'rab/v0.6.0+b', 'rab/v0.6.0-', 'rab/vx.y.z', 'rab/v0.6.0/x'];
  for (const tag of samples) {
    const gh = fakeGh();
    const ok = run({ ...ENV, TAG: tag, DRY_RUN: '1' }, gh.dir).status === 0;
    assert.equal(ok, guard.test(tag), tag);
  }
});

test('the installed gh knows every flag the script passes (static check of the real CLI)', (t) => {
  const create = spawnSync('gh', ['release', 'create', '--help'], { encoding: 'utf8' });
  const view = spawnSync('gh', ['release', 'view', '--help'], { encoding: 'utf8' });
  if (create.error || create.status !== 0 || view.error || view.status !== 0) {
    if (process.env.CI) assert.fail('gh is preinstalled on GitHub runners; it must be found here');
    t.skip('gh not installed locally');
    return;
  }
  for (const flag of ['--repo', '--verify-tag', '--draft', '--prerelease', '--title', '--generate-notes', '--notes-file']) {
    assert.match(create.stdout, new RegExp(`(^|\\s)${flag}\\b`, 'm'), `release create ${flag}`);
  }
  assert.match(create.stdout, /prepended to\s+automatically generated notes/, 'gh still prepends our notes to the generated ones');
  for (const flag of ['--repo', '--json', '--jq']) assert.match(view.stdout, new RegExp(`(^|\\s)${flag}\\b`, 'm'), `release view ${flag}`);
  assert.match(view.stdout, /\bisDraft\b/, 'release view --json still offers isDraft');
});

test('cd-deploy-tag: rab/v tags, no third-party release action, least privilege, no persisted checkout credential', () => {
  const y = fs.readFileSync(WORKFLOW, 'utf8');
  assert.match(y, /^on:\n {2}push:\n {4}tags:\n {6}- 'rab\/v\*\.\*\.\*'\n\n/m, 'triggered by rab/vX.Y.Z tags only');
  assert.doesNotMatch(y, /- 'v\*/);
  assert.doesNotMatch(y, /action-gh-release/);
  assert.match(y, /^permissions: \{\}$/m, 'nothing at the workflow level');
  const perms = [...y.matchAll(/^ {4}permissions:\n((?: {6}.*\n)+)/gm)].map((m) => m[1].replace(/\s*#.*$/gm, '').trim());
  assert.deepEqual(perms, ['contents: write'], 'the release job writes contents and nothing else (no actions: write)');
  assert.match(y, /uses: actions\/checkout@[0-9a-f]{40} # v\S+\n\s+with:\n\s+persist-credentials: false\n/);
  assert.match(y, /GH_TOKEN: \$\{\{ github\.token \}\}\n\s+TAG: \$\{\{ github\.ref_name \}\}\n\s+run: bash tools\/create-github-release\.sh\n/);
  assert.doesNotMatch(y, /DRY_RUN/);
});

test('publish-image starts from a published release (what the owner does with the draft) and a dispatch, nothing else', () => {
  const y = fs.readFileSync(PUBLISH, 'utf8');
  assert.match(y, /^on:\n {2}release:\n {4}types: \[published\]\n {2}workflow_dispatch:\n/m);
});
