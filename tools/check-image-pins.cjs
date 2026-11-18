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

// docker run/create options that take a value as the NEXT word (when not written --opt=value). Anything else that starts
// with '-' must be a known flag, or the command is refused: guessing would let an image hide behind an option.
const VALUE_OPTS = new Set([
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
const FLAG_OPTS = new Set([
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
  '-a',
  '--all-tags',
]);

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

// The image word of every docker run/create/pull in a script: [{ image, command }], or { problem }.
function dockerImages(script) {
  const out = [];
  const joined = script.replace(/\\\r?\n/g, ' ');
  for (const raw of joined.split(/\r?\n/)) {
    const line = raw.replace(/^\s+/, '');
    if (line === '' || line.startsWith('#')) continue;
    for (const seg of line.split(/&&|\|\||;|\|/)) {
      const m =
        /(?:^|\s)docker\s+(?:(container)\s+(run|create)|(image)\s+(pull)|(run|create|pull))(?=\s|$)(.*)$/.exec(
          seg,
        );
      if (!m) continue;
      const sub = m[2] || m[4] || m[5];
      const command = seg.trim();
      const w = words(m[6]);
      if (!w) {
        out.push({ command, problem: 'unbalanced quotes' });
        continue;
      }
      let image = null;
      let problem = null;
      for (let i = 0; i < w.length; i++) {
        const t = w[i];
        if (t === '--') {
          image = w[i + 1] || null;
          break;
        }
        if (!t.startsWith('-') || t === '-') {
          image = t;
          break;
        }
        if (t.startsWith('--') && t.includes('=')) continue;
        if (VALUE_OPTS.has(t)) {
          i++;
          continue;
        }
        if (FLAG_OPTS.has(t)) continue;
        problem = `docker ${sub} option ${t} is not known to this check (add it to VALUE_OPTS or FLAG_OPTS)`;
        break;
      }
      if (!problem && !image) problem = `no image found in: docker ${sub}`;
      out.push(problem ? { command, problem } : { command, image });
    }
  }
  return out;
}

// Variables a script assigns from ref.sh: { VAR: '<name>' }. The name may be built from `${{ matrix.pg }}` or a shell
// variable; ref.sh itself refuses at run time a name with no pinned manifest, and a LITERAL name is checked here too.
function refShAssignments(script) {
  const out = {};
  const re =
    /(?:^|[\s;])([A-Za-z_][A-Za-z0-9_]*)="\$\(bash\s+"?(?:\$\{GITHUB_WORKSPACE\}\/|\$GITHUB_WORKSPACE\/)?\.github\/ci-images\/ref\.sh"?\s+(?:"([^"]*)"|([^\s")]+))\s*\)"/g;
  for (const m of script.matchAll(re))
    out[m[1]] = m[2] !== undefined ? m[2] : m[3];
  return out;
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
            if (!assigned[name].includes('$') && !ciImages.has(assigned[name]))
              problems.push(
                `${at}: ref.sh ${assigned[name]} has no .github/ci-images/${assigned[name]}/image.yaml`,
              );
            continue;
          }
          const ev = Object.prototype.hasOwnProperty.call(env, name)
            ? env[name]
            : undefined;
          if (
            typeof ev === 'string' &&
            !ev.includes('${{') &&
            PINNED_RE.test(ev.trim())
          ) {
            recordPin(ev.trim());
            continue;
          }
          problems.push(
            `${at}: docker image $${name} is neither set from .github/ci-images/ref.sh in this script nor a pinned literal env value`,
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

module.exports = { check, dockerImages, words, refShAssignments, PINNED_RE };

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
