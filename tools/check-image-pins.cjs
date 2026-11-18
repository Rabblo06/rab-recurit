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
//   3. Every `docker run|create|pull` (also `docker container run|create`, `docker image pull`) in a `run:` script names
//      its image as either a pinned literal, a "$VAR" whose value is set in the same script from
//      `.github/ci-images/ref.sh <name>` (and <name> exists), or a "$VAR" from a workflow/job/step `env:` whose literal
//      value is pinned. Anything this check cannot read (an unknown docker option, an expression) fails.
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

// `docker` as a command word: after start of line, whitespace, ; & | ( $ " ' ` or / (so `$(docker`, `"docker"`,
// `/usr/bin/docker`, `sh -c "docker`, `bash -c 'docker` are all found), and followed by whitespace (after an optional
// closing quote). `rab-docker`, `dockerfile`, `docker-compose` are not command words.
const DOCKER_WORD_RE = /(^|[\s;&|($"'`/])docker(?=["']?(?:[ \t]|$))/gm;
// docker reached through a variable or an alias: refused, because the check cannot see what such a command runs.
const DOCKER_INDIRECT_RES = [
  /(?:^|[\s;&|(`])(?:alias\s+|export\s+|local\s+|readonly\s+|typeset\s+|declare\s+(?:-\w+\s+)*)?[A-Za-z_][A-Za-z0-9_]*=["']?(?:[^\s"';|&()]*\/)?docker["']?(?=[\s;&|)`]|$)/m,
  /\$\(\s*(?:command\s+-v|which|type\s+-[pP])\s+docker\s*\)/,
  /\$\{?[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\}?["']?\s+(?:(?:container|image)\s+)?(?:run|create|pull)(?=[\s;&|)`"']|$)/m,
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

// Every docker run/create/pull in a script: [{ index, command, image }] or [{ index, command, problem }]. A form the
// parser cannot place is a problem, never skipped.
function dockerImages(script) {
  const out = [];
  const text = script
    .replace(/\\\r?\n/g, ' ')
    .split(/\r?\n/)
    .map((l) => (/^\s*#/.test(l) ? '' : l))
    .join('\n');
  for (const re of DOCKER_INDIRECT_RES) {
    const m = re.exec(text);
    if (m) {
      out.push({
        index: m.index,
        command: m[0].trim(),
        problem:
          'docker invoked through a variable, alias or lookup cannot be checked; call docker directly',
      });
    }
  }
  for (const m of text.matchAll(DOCKER_WORD_RE)) {
    const at = m.index + m[1].length;
    let i = at + 'docker'.length;
    if (text[i] === '"' || text[i] === "'") i++;
    const enc = enclosingQuote(text, at);
    const sm =
      /^[ \t]+(?:(container)[ \t]+)?(?:(image)[ \t]+)?([^\s"';&|)`]+)/.exec(
        text.slice(i),
      );
    if (!sm) continue;
    const sub = sm[3];
    if (sub.startsWith('-')) {
      // docker --context x run ...: global options are not parsed; refused when a run/create/pull follows.
      const end0 = commandEnd(text, i, enc);
      const tail = text.slice(i, end0 < 0 ? text.length : end0);
      if (/(?:^|\s)(?:run|create|pull)(?=\s|$)/.test(tail)) {
        out.push({
          index: at,
          command: `docker${tail}`.trim(),
          problem: `docker global option ${sub} before the subcommand is not supported by this check`,
        });
      }
      continue;
    }
    if (sm[1] && !['run', 'create'].includes(sub)) continue;
    if (sm[2] && sub !== 'pull') continue;
    if (!['run', 'create', 'pull'].includes(sub)) continue;
    const argsFrom = i + sm[0].length;
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
      problem = `docker ${sub} option ${t} is not known to this check (add it to the option tables)`;
      break;
    }
    if (!problem && !image) problem = `no image found in: docker ${sub}`;
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
      for (const s of steps) {
        if (s && typeof s.run === 'string')
          scripts.push({ script: s.run, env: { ...env, ...(s.env || {}) } });
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
    for (const { script, env } of scripts) {
      const assigned = refShAssignments(script);
      for (const d of dockerImages(script)) {
        dockerCmds++;
        const at = `${rel}:${lineOf(d.command.split(/\s+/).slice(0, 3).join(' '))}`;
        if (d.problem) {
          problems.push(`${at}: ${d.problem} (${d.command})`);
          continue;
        }
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
            definitions(script, name) === 0
          ) {
            recordPin(ev.trim());
            continue;
          }
          problems.push(
            `${at}: docker image $${name} is neither set once from .github/ci-images/ref.sh in this script nor a pinned literal env value the script leaves alone`,
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
