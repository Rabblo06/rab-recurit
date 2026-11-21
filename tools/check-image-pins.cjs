#!/usr/bin/env node
'use strict';
// node tools/check-image-pins.cjs [--root DIR]
//
// Supply-chain gate (ci-security `deployment-config`): every container image a workflow or composite action under
// .github/ pulls is pinned by digest. A tag (`redis:7-alpine`) is mutable: whoever controls it changes what CI runs.
//
//   1. Every `image:` key anywhere in .github/workflows/**, .github/actions/** and .github/ci-images/** whose value is a
//      string (job `container.image`, `services.<id>.image`, the ci-images manifests), and every `container:` given as a
//      string, must be `<repo>[:<tag>]@sha256:<64 hex>`. A `${{ }}` expression is refused: it cannot be checked here.
//      These are exactly the keys Dependabot's docker ecosystem reads, so whatever it can renew is pinned.
//   2. .github/ci-images/<name>/image.yaml holds exactly one top-level `image: <repo>:<tag>@sha256:<64 hex>` (the tag is
//      required there: Dependabot needs it to find the next digest of the same tag), read by .github/ci-images/ref.sh.
//   3. Every `docker|podman|nerdctl run|create|pull` (also `container run|create`, `image pull`) in a `run:` script names
//      its image as either a pinned literal, a "$VAR" set exactly once in the same script, before the command, from
//      `.github/ci-images/ref.sh <name>` (and <name> exists), or a "$VAR" from a workflow/job/step `env:` whose literal
//      value is pinned, which the script never redefines and which no step of the job (nor a local composite action it
//      uses) writes to $GITHUB_ENV. `skopeo copy|sync|inspect|delete` may name only pinned literal docker:// references.
//      The tool is found wherever it is a command word: in $( ), backticks, a subshell, by path (/usr/bin/docker, \docker),
//      quoted ("docker"), inside sh -c "..." / bash -c '...'. Refused: the tool reached through a variable, an alias or
//      `$(command -v docker)`; a subcommand that is not a bare literal word (`docker "run"`, `docker $SUB`, a wrapper
//      `d() { docker "$@"; }`); and anything else this check cannot place (an unknown option, a global option before the
//      subcommand, unbalanced quotes, an expression). Deliberate obfuscation (`d""ocker`, `source some-file.sh`) is beyond
//      a static check; code review is the control for it (CODEOWNERS owns .github/ and tools/).
//   4. One tag, one digest: two different digests for the same `<repo>:<tag>` across .github/ fail (a partial update).
//
// `uses: docker://...` is tools/check-action-pins.cjs's job (#236). Dependencies: Node built-ins and the root devDependency
// `yaml`; without it the check fails, never skips.

const fs = require('node:fs');
const path = require('node:path');

let YAML;
try {
  YAML = require('yaml');
} catch (e) {
  console.error(
    `check-image-pins: cannot load the YAML parser ('yaml', a root devDependency): ${e.message}`,
  );
  process.exit(1);
}

const SCAN_DIRS = ['.github/workflows', '.github/actions', '.github/ci-images'];
const DIGEST = '@sha256:[0-9a-f]{64}';
const REPO =
  '[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?(?:\\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*';
const TAG = ':[A-Za-z0-9_][A-Za-z0-9._-]{0,127}';
const PINNED_RE = new RegExp(`^${REPO}(?:${TAG})?${DIGEST}$`);
const PINNED_WITH_TAG_RE = new RegExp(`^${REPO}${TAG}${DIGEST}$`);
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

// Per subcommand: options that take a value as the NEXT word (when not written --opt=value), and flags. Anything else that
// starts with '-' is refused: guessing would let an image hide behind an option.
const RUN_VALUE_OPTS = new Set([
  '-a',
  '--attach',
  '--name',
  '-p',
  '--publish',
  '-v',
  '--volume',
  '-e',
  '--env',
  '--env-file',
  '-w',
  '--workdir',
  '-u',
  '--user',
  '--network',
  '--net',
  '--entrypoint',
  '--platform',
  '--mount',
  '-l',
  '--label',
  '--label-file',
  '--tmpfs',
  '--add-host',
  '--health-cmd',
  '--health-interval',
  '--health-retries',
  '--health-timeout',
  '--health-start-period',
  '-m',
  '--memory',
  '--cpus',
  '--shm-size',
  '--ulimit',
  '--cap-add',
  '--cap-drop',
  '--security-opt',
  '--restart',
  '-h',
  '--hostname',
  '--ipc',
  '--pid',
  '--log-driver',
  '--log-opt',
  '--dns',
  '--device',
  '--gpus',
  '--stop-signal',
  '--stop-timeout',
  '--cidfile',
  '--pull',
  '--network-alias',
  '--expose',
  '--group-add',
  '--userns',
  '--uts',
]);
const RUN_FLAGS = new Set([
  '-d',
  '--detach',
  '-i',
  '--interactive',
  '-t',
  '--tty',
  '-it',
  '-ti',
  '-dit',
  '-itd',
  '--rm',
  '--init',
  '--privileged',
  '--read-only',
  '-P',
  '--publish-all',
  '-q',
  '--quiet',
  '--no-healthcheck',
  '--disable-content-trust',
]);
const PULL_VALUE_OPTS = new Set(['--platform']);
const PULL_FLAGS = new Set([
  '-a',
  '--all-tags',
  '-q',
  '--quiet',
  '--disable-content-trust',
]);
const OPTS = {
  run: [RUN_VALUE_OPTS, RUN_FLAGS],
  create: [RUN_VALUE_OPTS, RUN_FLAGS],
  pull: [PULL_VALUE_OPTS, PULL_FLAGS],
};

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

// Shell-ish word splitting of one command line: quotes removed, $(...) kept whole. Approximate, used only to find the
// image word; a form it cannot place makes the caller refuse, never accept.
function words(line) {
  const out = [];
  let cur = '';
  let has = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'") {
      const j = line.indexOf("'", i + 1);
      if (j < 0) return null;
      cur += line.slice(i + 1, j);
      has = true;
      i = j;
    } else if (c === '"') {
      let j = i + 1;
      let depth = 0;
      for (; j < line.length; j++) {
        if (line[j] === '\\') j++;
        else if (line.startsWith('$(', j)) depth++;
        else if (line[j] === ')' && depth > 0) depth--;
        else if (line[j] === '"' && depth === 0) break;
      }
      if (j >= line.length) return null;
      cur += line.slice(i + 1, j);
      has = true;
      i = j;
    } else if (/\s/.test(c)) {
      if (has) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}

// A container tool as a command word: docker, podman, nerdctl (same run/create/pull syntax) and skopeo (copy/sync/inspect/
// delete with docker:// references). Found after start of line, whitespace, ; & | ( $ " ' ` / or \ (so `$(docker`,
// `"docker"`, `/usr/bin/docker`, `\docker`, `sh -c "docker`, `bash -c 'docker` are all found), and followed by whitespace
// (after an optional closing quote). `rab-docker`, `dockerfile`, `docker-compose` are not command words. Deliberate
// obfuscation (`d""ocker`, `do\cker`, a script pulled in with `source`) is out of reach of a static check; review is the
// control for that.
const TOOL_WORD_RE =
  /(^|[\s;&|($"'`/\\])(docker|podman|nerdctl|skopeo)(?=["']?(?:[ \t]|$))/gm;
const RUNNERS = new Set(['docker', 'podman', 'nerdctl']);
const SKOPEO_IMAGE_SUBS = new Set(['copy', 'sync', 'inspect', 'delete']);
// A lookup of the tool (`command -v docker`, `which skopeo`), not a call. `$(command -v docker)` USED as a command is
// refused by TOOL_INDIRECT_RES below.
const LOOKUP_BEFORE_RE =
  /(?:command\s+-[vV]|which|type(?:\s+-[aptfP]+)?|hash)\s+$/;
// A container tool reached through a variable, an alias, a lookup or a variable command: refused, because the check
// cannot see what such a command runs.
const TOOL = '(?:docker|podman|nerdctl|skopeo)';
const TOOL_INDIRECT_RES = [
  new RegExp(
    `(?:^|[\\s;&|(\`])(?:alias\\s+|export\\s+|local\\s+|readonly\\s+|typeset\\s+|declare\\s+(?:-\\w+\\s+)*)?[A-Za-z_][A-Za-z0-9_]*=["']?(?:[^\\s"';|&()]*\\/)?${TOOL}["']?(?=[\\s;&|)\`]|$)`,
    'm',
  ),
  new RegExp(
    `\\$\\(\\s*(?:command\\s+-v|which|type\\s+-[pP])\\s+${TOOL}\\s*\\)`,
  ),
  /\$\{?[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\}?["']?\s+(?:(?:container|image)\s+)?(?:run|create|pull|copy|sync)(?=[\s;&|)`"']|$)/m,
];

// Quote context at index p: the quote of the innermost $( ) / backtick frame ('"', "'" or null).
function enclosingQuote(text, p) {
  const stack = [{ q: null, tick: false }];
  for (let i = 0; i < p; i++) {
    const f = stack[stack.length - 1];
    const c = text[i];
    if (f.q === "'") {
      if (c === "'") f.q = null;
      continue;
    }
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '$' && text[i + 1] === '(') {
      stack.push({ q: null, tick: false });
      i++;
    } else if (c === '`') {
      if (f.tick && f.q === null) stack.pop();
      else stack.push({ q: null, tick: true });
    } else if (c === ')' && f.q === null && !f.tick && stack.length > 1) {
      stack.pop();
    } else if (c === '"') {
      f.q = f.q === '"' ? null : '"';
    } else if (c === "'" && f.q === null) {
      f.q = "'";
    }
  }
  return stack[stack.length - 1].q;
}

// End of the simple command that starts at `from`, inside an enclosing quote `enc` (or none): an unquoted ; & | newline
// backtick, a ) closing an outer $( , or the quote that closes `enc`. -1 when a quote of its own never closes.
function commandEnd(text, from, enc) {
  const stack = [{ q: null }];
  for (let i = from; i < text.length; i++) {
    const f = stack[stack.length - 1];
    const c = text[i];
    if (f.q === "'") {
      if (c === "'") f.q = null;
      continue;
    }
    if (f.q === '"') {
      if (c === '\\') i++;
      else if (c === '$' && text[i + 1] === '(') {
        stack.push({ q: null });
        i++;
      } else if (c === '"') f.q = null;
      continue;
    }
    if (c === '\\') {
      // \" inside an enclosing "..." opens a quote of the inner shell
      if (enc === '"' && text[i + 1] === '"') f.q = '"';
      i++;
      continue;
    }
    if (stack.length === 1 && c === enc) return i;
    if (c === '"' || c === "'") f.q = c;
    else if (c === '$' && text[i + 1] === '(') {
      stack.push({ q: null });
      i++;
    } else if (c === ')') {
      if (stack.length === 1) return i;
      stack.pop();
    } else if (stack.length === 1 && /[;&|\n`]/.test(c)) return i;
  }
  return stack.length === 1 && stack[0].q === null ? text.length : -1;
}

// Every container image a script's docker/podman/nerdctl run|create|pull or skopeo copy|sync|inspect|delete names:
// [{ index, command, image }] or [{ index, command, problem }]. A form the parser cannot place is a problem, never
// skipped: a subcommand that is not a literal word (`docker "run"`, `docker $SUB`, `docker "$@"` in a wrapper function),
// a global option before the subcommand, unbalanced quotes, an unknown option, a missing image.
function dockerImages(script) {
  const out = [];
  const text = script
    .replace(/\\\r?\n/g, ' ')
    .split(/\r?\n/)
    .map((l) => (/^\s*#/.test(l) ? '' : l))
    .join('\n');
  for (const re of TOOL_INDIRECT_RES) {
    const m = re.exec(text);
    if (m) {
      out.push({
        index: m.index,
        command: m[0].trim(),
        problem:
          'a container tool invoked through a variable, alias or lookup cannot be checked; call it directly',
      });
    }
  }
  // The next raw word at `from` (after blanks): null when the command ends there.
  const nextWord = (from) => {
    const ws = /^[ \t]*/.exec(text.slice(from))[0];
    const start = from + ws.length;
    const after = text.slice(start);
    if (after === '' || /^[;&|)\n]/.test(after)) return null;
    const raw = /^[^\s;&|)]+/.exec(after)[0];
    return { raw, end: start + raw.length };
  };
  for (const m of text.matchAll(TOOL_WORD_RE)) {
    const tool = m[2];
    const at = m.index + m[1].length;
    const lineStart = text.lastIndexOf('\n', at - 1) + 1;
    if (LOOKUP_BEFORE_RE.test(text.slice(lineStart, at))) continue;
    let i = at + tool.length;
    if (text[i] === '"' || text[i] === "'") i++;
    const enc = enclosingQuote(text, at);
    const refuse = (problem, upTo) => {
      const e = commandEnd(text, at + tool.length, enc);
      out.push({
        index: at,
        command: text
          .slice(at, upTo !== undefined ? upTo : e < 0 ? text.length : e)
          .trim(),
        problem,
      });
    };
    let w1 = nextWord(i);
    if (!w1) continue; // the bare tool name, nothing to run
    if (w1.raw.startsWith('-')) {
      // docker --context x run ...: global options are not parsed; refused when an image subcommand follows.
      const end0 = commandEnd(text, i, enc);
      const tail = text.slice(i, end0 < 0 ? text.length : end0);
      if (
        /(?:^|\s)(?:run|create|pull|copy|sync|inspect|delete)(?=\s|$)/.test(
          tail,
        )
      ) {
        refuse(
          `${tool} global option ${w1.raw} before the subcommand is not supported by this check`,
        );
      }
      continue;
    }
    if (!/^[A-Za-z]+$/.test(w1.raw)) {
      refuse(
        `${tool} subcommand ${w1.raw} is not a literal word; this check cannot tell what it runs`,
      );
      continue;
    }
    let sub = w1.raw;
    let argsFrom = w1.end;
    if (RUNNERS.has(tool) && (sub === 'container' || sub === 'image')) {
      const w2 = nextWord(argsFrom);
      if (!w2) continue;
      if (!/^[A-Za-z]+$/.test(w2.raw)) {
        refuse(
          `${tool} ${sub} subcommand ${w2.raw} is not a literal word; this check cannot tell what it runs`,
        );
        continue;
      }
      if (
        (sub === 'container' && !['run', 'create'].includes(w2.raw)) ||
        (sub === 'image' && w2.raw !== 'pull')
      )
        continue;
      sub = w2.raw;
      argsFrom = w2.end;
    } else if (RUNNERS.has(tool) && !['run', 'create', 'pull'].includes(sub)) {
      continue;
    } else if (tool === 'skopeo' && !SKOPEO_IMAGE_SUBS.has(sub)) {
      continue;
    }
    const end = commandEnd(text, argsFrom, enc);
    const command = text.slice(at, end < 0 ? text.length : end).trim();
    if (end < 0) {
      out.push({ index: at, command, problem: 'unbalanced quotes' });
      continue;
    }
    let args = text.slice(argsFrom, end);
    if (enc === '"') args = args.replace(/\\(["\\$`])/g, '$1');
    const w = words(args);
    if (!w) {
      out.push({ index: at, command, problem: 'unbalanced quotes' });
      continue;
    }
    if (tool === 'skopeo') {
      // Every registry reference must be a pinned literal docker://<repo>[:<tag>]@sha256:<digest>; local transports
      // (oci:, dir:, docker-archive:, ...) are files of this run. A variable or expression cannot be checked.
      let bad = null;
      for (const t of w) {
        if (t.includes('$'))
          bad = `skopeo ${sub} argument ${t} cannot be verified`;
        else if (
          t.startsWith('docker://') &&
          !PINNED_RE.test(t.slice('docker://'.length))
        )
          bad = `skopeo ${sub} reference ${t} is not pinned by digest`;
        if (bad) break;
      }
      out.push(
        bad
          ? { index: at, command, problem: bad }
          : { index: at, command, skopeo: true },
      );
      continue;
    }
    const [valueOpts, flags] = OPTS[sub];
    let image = null;
    let problem = null;
    for (let k = 0; k < w.length; k++) {
      const t = w[k];
      if (t === '--') {
        image = w[k + 1] || null;
        break;
      }
      if (!t.startsWith('-') || t === '-') {
        image = t;
        break;
      }
      if (t.startsWith('--') && t.includes('=')) continue;
      if (valueOpts.has(t)) {
        k++;
        continue;
      }
      if (flags.has(t)) continue;
      problem = `${tool} ${sub} option ${t} is not known to this check (add it to the option tables)`;
      break;
    }
    if (!problem && !image) problem = `no image found in: ${tool} ${sub}`;
    out.push(
      problem ? { index: at, command, problem } : { index: at, command, image },
    );
  }
  return out;
}

// Variables a script assigns from ref.sh: { VAR: { name: '<image name>', index } }. The name may be built from
// `${{ matrix.pg }}` or a shell variable; ref.sh itself refuses at run time a name with no pinned manifest, and a LITERAL
// name is checked here too.
function refShAssignments(script) {
  const out = {};
  const re =
    /(?:^|[\s;])([A-Za-z_][A-Za-z0-9_]*)="\$\(bash\s+"?(?:\$\{GITHUB_WORKSPACE\}\/|\$GITHUB_WORKSPACE\/)?\.github\/ci-images\/ref\.sh"?\s+(?:"([^"]*)"|([^\s")]+))\s*\)"/g;
  for (const m of script.matchAll(re)) {
    out[m[1]] = { name: m[2] !== undefined ? m[2] : m[3], index: m.index };
  }
  return out;
}

// How many times a script (re)defines a variable: plain, export/local/declare/readonly/typeset assignments, read /
// mapfile / printf -v / for ... in targets, ${VAR=..} / ${VAR:=..}, unset, and any nameref (declare -n) at all. A
// variable the script defines more than once (ref.sh) or at all (env) is not trusted to hold the pinned image.
function definitions(script, name) {
  const n = name.replace(/[^A-Za-z0-9_]/g, '');
  const res = [
    new RegExp(
      `(?:^|[\\s;&|(\`])(?:export\\s+|local\\s+|readonly\\s+|typeset\\s+|declare\\s+(?:-\\w+\\s+)*)?${n}(?:\\[[^\\]]*\\])?\\+?=`,
      'gm',
    ),
    new RegExp(
      `\\b(?:read|mapfile|readarray)\\b[^;&|\\n]*\\s${n}(?=[\\s;&|)]|$)`,
      'gm',
    ),
    new RegExp(`\\bprintf\\s+-v\\s*${n}\\b`, 'g'),
    new RegExp(`\\bfor\\s+${n}\\s+in\\b`, 'g'),
    new RegExp(`\\$\\{${n}:?=`, 'g'),
    new RegExp(`\\bunset\\s+(?:-v\\s+)?${n}\\b`, 'g'),
    /\b(?:declare|typeset|local)\s+-\w*n\w*\b/g,
  ];
  return res.reduce((a, r) => a + [...script.matchAll(r)].length, 0);
}

// Line of the next occurrence of `needle` in `text` (successive calls with the same needle walk forward, so repeated
// identical values report their own lines). 0 when not found.
function locator(text) {
  const seen = new Map();
  return (needle) => {
    const from = seen.has(needle) ? seen.get(needle) + 1 : 0;
    let i = text.indexOf(needle, from);
    if (i < 0) i = text.indexOf(needle);
    if (i < 0) return 0;
    seen.set(needle, i);
    return text.slice(0, i).split('\n').length;
  };
}

// Names a script may write to $GITHUB_ENV (every NAME= / NAME<< in a script that mentions GITHUB_ENV; an
// over-approximation on purpose). A later step of the job sees such a value instead of the `env:` literal this check
// read, so an env name any step of the job (or a local composite action it uses) writes there is not trusted.
function githubEnvWrites(script) {
  if (typeof script !== 'string' || !script.includes('GITHUB_ENV')) return [];
  return [...script.matchAll(/([A-Za-z_][A-Za-z0-9_]*)(?:=|<<)/g)].map(
    (m) => m[1],
  );
}

function check(root) {
  const problems = [];
  const pins = new Map(); // repo:tag -> Set(digest)
  const ciImages = new Set();
  const ciDir = path.join(root, '.github/ci-images');
  if (fs.existsSync(ciDir)) {
    for (const e of fs.readdirSync(ciDir, { withFileTypes: true }))
      if (e.isDirectory()) ciImages.add(e.name);
  }
  const files = listYamlFiles(root);
  // GITHUB_ENV writes of each local composite action, keyed by its `uses:` path (./.github/actions/<name>).
  const actionEnvWrites = new Map();
  for (const file of files) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    const am = /^(\.github\/actions\/[^/]+)\/action\.ya?ml$/.exec(rel);
    if (!am) continue;
    let doc;
    try {
      doc = YAML.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue; // reported as unparseable below
    }
    const names = new Set();
    for (const st of (doc &&
      doc.runs &&
      Array.isArray(doc.runs.steps) &&
      doc.runs.steps) ||
      []) {
      for (const n of githubEnvWrites(st && st.run)) names.add(n);
    }
    actionEnvWrites.set(`./${am[1]}`, names);
  }
  let images = 0;
  let dockerCmds = 0;

  const recordPin = (ref) => {
    const at = ref.indexOf('@sha256:');
    const name = ref.slice(0, at);
    const lastSlash = name.lastIndexOf('/');
    if (name.indexOf(':', lastSlash + 1) < 0) return; // digest only, no tag
    if (!pins.has(name)) pins.set(name, new Set());
    pins.get(name).add(ref.slice(at + 1));
  };

  for (const file of files) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    const text = fs.readFileSync(file, 'utf8');
    const lineOf = locator(text);
    let docs;
    try {
      docs = YAML.parseAllDocuments(text);
    } catch (e) {
      problems.push(`${rel}: not parseable YAML: ${e.message}`);
      continue;
    }
    const broken = docs.find((d) => d.errors && d.errors.length);
    if (broken) {
      problems.push(`${rel}: not parseable YAML: ${broken.errors[0].message}`);
      continue;
    }
    const values = docs.map((d) => d.toJS({ maxAliasCount: -1 }));

    const checkImage = (value, where) => {
      images++;
      const v = value.trim();
      if (v.includes('${{'))
        problems.push(
          `${rel}:${lineOf(value)}: ${where} is an expression (${v}); pin a literal <repo>:<tag>@sha256:<digest>`,
        );
      else if (!PINNED_RE.test(v))
        problems.push(
          `${rel}:${lineOf(value)}: ${where} ${v} is not pinned by digest (<repo>:<tag>@sha256:<64 hex>)`,
        );
      else recordPin(v);
    };

    // 1. every string `image:` key, every string `container:`.
    const walk = (node, trail) => {
      if (Array.isArray(node))
        return node.forEach((n, i) => walk(n, `${trail}[${i}]`));
      if (!node || typeof node !== 'object') return;
      for (const [k, v] of Object.entries(node)) {
        if (k === 'image' && typeof v === 'string')
          checkImage(v, `${trail}.image`);
        else if (k === 'container' && typeof v === 'string')
          checkImage(v, `${trail}.container`);
        walk(v, `${trail}.${k}`);
      }
    };
    values.forEach((v) => walk(v, ''));

    // 2. the ci-images manifests.
    const ci = /^\.github\/ci-images\/([^/]+)\/image\.ya?ml$/.exec(rel);
    if (rel.startsWith('.github/ci-images/')) {
      const v = values[0];
      if (
        !ci ||
        values.length !== 1 ||
        !v ||
        typeof v !== 'object' ||
        Array.isArray(v) ||
        Object.keys(v).join() !== 'image'
      ) {
        problems.push(
          `${rel}: a CI image manifest is .github/ci-images/<name>/image.yaml with exactly one key, image`,
        );
      } else if (!NAME_RE.test(ci[1])) {
        problems.push(`${rel}: bad CI image name ${ci[1]}`);
      } else if (
        typeof v.image !== 'string' ||
        !PINNED_WITH_TAG_RE.test(v.image.trim())
      ) {
        problems.push(
          `${rel}: image must be <repo>:<tag>@sha256:<64 hex> (the tag lets Dependabot renew the digest)`,
        );
      }
    }

    // 3. docker run/create/pull in run: scripts, with the env in scope.
    const scripts = [];
    const stepsOf = (steps, env) => {
      if (!Array.isArray(steps)) return;
      // Names any step of this job (or composite action) writes to $GITHUB_ENV, including local actions it uses.
      const written = new Set();
      for (const s of steps) {
        if (!s || typeof s !== 'object') continue;
        for (const n of githubEnvWrites(s.run)) written.add(n);
        if (typeof s.uses === 'string') {
          const key = s.uses.replace(/\/+$/, '');
          for (const n of actionEnvWrites.get(key) || []) written.add(n);
        }
      }
      for (const s of steps) {
        if (s && typeof s.run === 'string')
          scripts.push({
            script: s.run,
            env: { ...env, ...(s.env || {}) },
            written,
          });
      }
    };
    for (const v of values) {
      if (!v || typeof v !== 'object') continue;
      if (v.jobs && typeof v.jobs === 'object') {
        for (const job of Object.values(v.jobs)) {
          if (job && typeof job === 'object')
            stepsOf(job.steps, { ...(v.env || {}), ...(job.env || {}) });
        }
      }
      if (v.runs && typeof v.runs === 'object') stepsOf(v.runs.steps, {});
    }
    for (const { script, env, written } of scripts) {
      const assigned = refShAssignments(script);
      for (const d of dockerImages(script)) {
        dockerCmds++;
        const at = `${rel}:${lineOf(d.command.split(/\s+/).slice(0, 3).join(' '))}`;
        if (d.problem) {
          problems.push(`${at}: ${d.problem} (${d.command})`);
          continue;
        }
        if (d.skopeo) continue; // every docker:// reference was a pinned literal
        const img = d.image;
        const varM =
          /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/.exec(
            img,
          );
        if (varM) {
          const name = varM[1] || varM[2];
          if (Object.prototype.hasOwnProperty.call(assigned, name)) {
            const a = assigned[name];
            if (definitions(script, name) !== 1)
              problems.push(
                `${at}: docker image $${name} is set from ref.sh but redefined elsewhere in the script; it is not trusted`,
              );
            else if (a.index > d.index)
              problems.push(
                `${at}: docker image $${name} is used before it is set from ref.sh`,
              );
            else if (!a.name.includes('$') && !ciImages.has(a.name))
              problems.push(
                `${at}: ref.sh ${a.name} has no .github/ci-images/${a.name}/image.yaml`,
              );
            continue;
          }
          const ev = Object.prototype.hasOwnProperty.call(env, name)
            ? env[name]
            : undefined;
          if (
            typeof ev === 'string' &&
            !ev.includes('${{') &&
            PINNED_RE.test(ev.trim()) &&
            definitions(script, name) === 0 &&
            !written.has(name)
          ) {
            recordPin(ev.trim());
            continue;
          }
          problems.push(
            `${at}: docker image $${name} is neither set once from .github/ci-images/ref.sh in this script nor a pinned literal env value that no script of the job redefines or writes to $GITHUB_ENV`,
          );
          continue;
        }
        if (img.includes('${{') || img.includes('$'))
          problems.push(
            `${at}: docker image ${img} cannot be verified; use "$(bash .github/ci-images/ref.sh <name>)"`,
          );
        else if (!PINNED_RE.test(img))
          problems.push(`${at}: docker image ${img} is not pinned by digest`);
        else recordPin(img);
      }
    }
  }

  // 4. one tag, one digest.
  for (const [name, digests] of pins) {
    if (digests.size > 1)
      problems.push(
        `${name} is pinned to ${digests.size} different digests across .github/: ${[...digests].join(', ')}`,
      );
  }
  return { problems, files: files.length, images, dockerCmds };
}

module.exports = {
  check,
  dockerImages,
  words,
  refShAssignments,
  definitions,
  githubEnvWrites,
  PINNED_RE,
};

if (require.main === module) {
  const i = process.argv.indexOf('--root');
  const root =
    i > 0 ? path.resolve(process.argv[i + 1]) : path.resolve(__dirname, '..');
  let r;
  try {
    r = check(root);
  } catch (e) {
    console.error(`check-image-pins: ${e.stack || e.message}`);
    process.exit(1);
  }
  for (const p of r.problems) console.error(`::error::${p}`);
  if (r.problems.length) {
    console.error(`check-image-pins: ${r.problems.length} problem(s)`);
    process.exit(1);
  }
  console.log(
    `check-image-pins: OK - ${r.files} YAML files, ${r.images} image keys, ${r.dockerCmds} docker run/create/pull, all pinned by digest`,
  );
}
