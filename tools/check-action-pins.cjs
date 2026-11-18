#!/usr/bin/env node
'use strict';
// node tools/check-action-pins.cjs [--remote]
//
// Supply-chain gate (ci-security `action-pins`): every `uses:` in .github/workflows/** and .github/actions/** must name an
// immutable revision.
//   owner/repo[/path]@<ref>   <ref> is a full 40-character lowercase commit SHA, and the line carries a `# vX.Y.Z`
//                             comment naming the release it is (Dependabot reads and updates that comment).
//   docker://image@sha256:... a digest; a tag alone is mutable.
//   ./local                   exempt: it is this repository's own code at the checked-out commit.
// Anything the scanner cannot read as one of those (a flow mapping, an alias, a value on the next line) fails: a gate that
// skips what it does not understand is no gate.
//
// --remote additionally asks the GitHub API, for every distinct (repository, SHA):
//   - is the SHA a COMMIT of that repository? An annotated TAG OBJECT's SHA is also 40 hex characters and Actions accepts
//     it, but it is not what the comment claims and the offline check cannot tell the two apart (dorny/paths-filter was
//     pinned to the v3 tag object 15192bc0..., which points at the v3.0.4 commit 0e4a8c6e...). Reported with the commit
//     to pin instead.
//   - does the comment's tag exist in THAT repository and resolve (through any tag objects) to exactly the pinned commit?
//     This also rejects an "impostor" commit: a SHA that only exists in a fork is still served through the parent
//     repository's API and runnable by Actions, but no tag of the parent points at it.
// The remote half needs GITHUB_TOKEN (or GH_TOKEN) and fails closed on any lookup it cannot complete. Node built-ins only.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SCAN_DIRS = ['.github/workflows', '.github/actions'];
const SHA_RE = /^[0-9a-f]{40}$/;
const VERSION_COMMENT_RE = /^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const DOCKER_DIGEST_RE = /^docker:\/\/[^\s@]+@sha256:[0-9a-f]{64}$/;
// owner/repo, then an optional sub-path (github/codeql-action/init, a reusable workflow file), then @ref.
const REMOTE_RE = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)((?:\/[^\s@]+)?)@([^\s@]+)$/;
// One `uses:` key per line: `uses: x`, `- uses: x`, optionally quoted, optionally followed by a comment.
const USES_LINE_RE = /^(\s*)(?:-\s+)?uses\s*:\s*('[^']*'|"[^"]*"|[^\s'"#][^\s#]*)\s*(?:#\s*(.*?))?\s*$/;
// Any `uses` KEY anywhere on a line (block or flow style). Used to refuse forms USES_LINE_RE does not read.
const USES_KEY_RE = /(?:^|[\s{,[-])["']?uses["']?\s*:/;
// A key whose value is a block scalar (`run: |`, `script: >-`, `- run: |2`): the following more-indented lines are text.
const BLOCK_SCALAR_RE = /^(\s*)(?:-\s+)?[^\s#][^#]*?:\s*[|>][-+0-9]*\s*(?:#.*)?$/;

function listYamlFiles(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      if (e.code === 'ENOENT') return;
      throw e;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.ya?ml$/i.test(e.name)) out.push(p);
    }
  };
  for (const d of SCAN_DIRS) walk(path.join(root, d));
  return out.sort();
}

const unquote = (v) => (/^(['"]).*\1$/.test(v) ? v.slice(1, -1) : v);

// Classify one `uses:` value (offline). Returns { kind, problem?, repo?, sha?, tag? }.
function classify(value, comment) {
  if (value.startsWith('./')) return { kind: 'local' };
  if (value.startsWith('docker://')) {
    return DOCKER_DIGEST_RE.test(value)
      ? { kind: 'docker' }
      : { kind: 'docker', problem: `docker reference is not pinned by digest (docker://image@sha256:<64 hex>): ${value}` };
  }
  const m = REMOTE_RE.exec(value);
  if (!m || /^\.+$/.test(m[1]) || /^\.+$/.test(m[2])) return { kind: 'unknown', problem: `not a recognised action reference (owner/repo[/path]@sha, docker://, ./): ${value}` };
  const [, owner, repo, , ref] = m;
  // The comment's first word is the version; anything after it is free text.
  const out = { kind: 'remote', repo: `${owner}/${repo}`, sha: ref, tag: (comment || '').split(/\s+/)[0] };
  if (!SHA_RE.test(ref)) {
    out.problem = `${value} is not pinned to a full 40-character commit SHA (a tag or branch can be moved)`;
  } else if (!VERSION_COMMENT_RE.test(out.tag)) {
    out.problem = `${value} needs a "# vX.Y.Z" comment naming the release that SHA is (found: ${comment ? `"# ${comment}"` : 'none'})`;
  }
  return out;
}

// Scan one file's text. Returns { refs: [{file,line,value,...classify}], problems: [{file,line,message}] }.
function scanSource(file, text) {
  const refs = [];
  const problems = [];
  const lines = text.split(/\r?\n/);
  let blockIndent = -1; // >= 0 while inside a block scalar whose key sits at this indent
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;
    if (blockIndent >= 0) {
      if (line.trim() === '' || line.search(/\S/) > blockIndent) continue;
      blockIndent = -1;
    }
    if (/^\s*#/.test(line) || line.trim() === '') continue;
    const block = BLOCK_SCALAR_RE.exec(line);
    if (block) {
      const lead = line.match(/^(\s*)(-\s+)?/);
      blockIndent = lead[1].length + (lead[2] ? lead[2].length : 0);
    }
    const codePart = line.replace(/\s#.*$/, '');
    if (!USES_KEY_RE.test(codePart)) continue;
    const m = USES_LINE_RE.exec(line);
    if (!m) {
      problems.push({ file, line: lineNo, message: `unrecognised "uses:" form (write it as "uses: owner/repo@<sha> # vX.Y.Z"): ${line.trim()}` });
      continue;
    }
    const value = unquote(m[2]);
    if (value.startsWith('*') || value.startsWith('&') || value.startsWith('!')) {
      problems.push({ file, line: lineNo, message: `"uses:" must be a literal reference, not a YAML alias/anchor/tag: ${line.trim()}` });
      continue;
    }
    const c = classify(value, (m[3] || '').trim());
    refs.push({ file, line: lineNo, value, ...c });
    if (c.problem) problems.push({ file, line: lineNo, message: c.problem });
  }
  return { refs, problems };
}

function scan(root = ROOT) {
  const refs = [];
  const problems = [];
  const files = listYamlFiles(root);
  if (files.length === 0) problems.push({ file: root, line: 0, message: 'no workflow or action files found (wrong root?)' });
  for (const f of files) {
    const rel = path.relative(root, f).split(path.sep).join('/');
    const r = scanSource(rel, fs.readFileSync(f, 'utf8'));
    refs.push(...r.refs);
    problems.push(...r.problems);
  }
  return { files, refs, problems };
}

// --- remote verification -------------------------------------------------------------------------------------------

function makeApi({ token, fetchImpl = globalThis.fetch, base = 'https://api.github.com', retries = 3, sleep } = {}) {
  if (!token) throw new Error('GITHUB_TOKEN (or GH_TOKEN) is required for --remote');
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  // Returns { status, body } for 200/404/422; throws on anything else after retries (fail closed).
  return async function get(apiPath) {
    let last;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetchImpl(`${base}${apiPath}`, {
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'check-action-pins',
          },
        });
        if (res.status === 200) return { status: 200, body: await res.json() };
        if (res.status === 404 || res.status === 422) return { status: res.status, body: null };
        last = new Error(`GET ${apiPath}: HTTP ${res.status}`);
        if (res.status < 500 && res.status !== 429 && res.status !== 403) break;
      } catch (e) {
        last = new Error(`GET ${apiPath}: ${e.message}`);
      }
      if (attempt < retries) await wait(500 * 2 ** attempt);
    }
    throw last;
  };
}

// Resolve a tag name in a repository to the commit it finally points at, or null if the tag does not exist.
async function resolveTag(get, repo, tag) {
  const ref = await get(`/repos/${repo}/git/ref/tags/${encodeURIComponent(tag)}`);
  if (ref.status !== 200) return null;
  let obj = ref.body.object;
  for (let depth = 0; obj && obj.type === 'tag'; depth++) {
    if (depth >= 5) throw new Error(`${repo} tag ${tag}: tag chain deeper than 5`);
    const t = await get(`/repos/${repo}/git/tags/${obj.sha}`);
    if (t.status !== 200) throw new Error(`${repo} tag ${tag}: tag object ${obj.sha} not readable`);
    obj = t.body.object;
  }
  if (!obj || obj.type !== 'commit') throw new Error(`${repo} tag ${tag} does not point at a commit`);
  return obj.sha;
}

// Verify every remote ref. Returns problems [{file,line,message}].
async function verifyRemote(refs, get) {
  const problems = [];
  const byKey = new Map();
  for (const r of refs) {
    if (r.kind !== 'remote' || r.problem) continue;
    const key = `${r.repo}@${r.sha}#${r.tag}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(r);
  }
  for (const group of byKey.values()) {
    const { repo, sha, tag } = group[0];
    const report = (message) => group.forEach((r) => problems.push({ file: r.file, line: r.line, message }));
    try {
      const commit = await get(`/repos/${repo}/git/commits/${sha}`);
      if (commit.status !== 200) {
        const tagObj = await get(`/repos/${repo}/git/tags/${sha}`);
        if (tagObj.status === 200) {
          const target = tagObj.body.object || {};
          report(
            `${repo}@${sha} is an annotated TAG OBJECT (tag "${tagObj.body.tag}"), not a commit; pin the commit it points at` +
              (target.type === 'commit' ? `: ${target.sha}` : ` (it points at a ${target.type} ${target.sha})`),
          );
        } else {
          report(`${repo}@${sha}: no such commit in ${repo}`);
        }
        continue;
      }
      const tagCommit = await resolveTag(get, repo, tag);
      if (tagCommit === null) report(`${repo}@${sha}: the comment names "${tag}", which is not a tag of ${repo}`);
      else if (tagCommit !== sha) report(`${repo}@${sha}: the comment says "${tag}", but ${tag} is commit ${tagCommit}`);
    } catch (e) {
      report(`${repo}@${sha}: verification failed (fail closed): ${e.message}`);
    }
  }
  return problems;
}

function printProblems(problems) {
  const gha = process.env.GITHUB_ACTIONS === 'true';
  for (const p of problems) {
    if (gha) console.log(`::error file=${p.file},line=${p.line}::${p.message}`);
    else console.error(`${p.file}:${p.line}: ${p.message}`);
  }
}

async function main(argv) {
  const remote = argv.includes('--remote');
  const { files, refs, problems } = scan(ROOT);
  const remoteRefs = refs.filter((r) => r.kind === 'remote');
  console.log(
    `check-action-pins: ${files.length} files, ${refs.length} uses (${remoteRefs.length} remote, ` +
      `${refs.filter((r) => r.kind === 'local').length} local, ${refs.filter((r) => r.kind === 'docker').length} docker)`,
  );
  if (remote) {
    let get;
    try {
      get = makeApi({ token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN });
    } catch (e) {
      problems.push({ file: '-', line: 0, message: e.message });
    }
    if (get) {
      const distinct = new Set(remoteRefs.map((r) => `${r.repo}@${r.sha}`)).size;
      problems.push(...(await verifyRemote(refs, get)));
      console.log(`check-action-pins: resolved ${distinct} distinct repository@sha pins on GitHub`);
    }
  }
  if (problems.length) {
    printProblems(problems);
    console.error(`check-action-pins: ${problems.length} problem(s)`);
    return 1;
  }
  console.log('check-action-pins: every action is pinned to a commit SHA' + (remote ? ' that matches its version tag' : ''));
  return 0;
}

module.exports = { scan, scanSource, classify, listYamlFiles, makeApi, resolveTag, verifyRemote };

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`check-action-pins: ${e.stack || e}`);
      process.exit(1);
    },
  );
}
