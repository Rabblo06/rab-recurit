'use strict';
/**
 * H3 runtime-dependency gates for the API and Worker images. Run at BUILD time through a bind mount, like
 * security-floors.sh and module-paths-gate.cjs: this file is never copied into an image. Dependency-free (Node built-ins
 * only), because it runs in the final stages, which have no package manager.
 *
 *   node runtime-deps.cjs check <node_modules> --scan <dir>... [--forbid <name>|<prefix*>...] [--allow <name>...]
 *     Fails unless
 *       - every literal bare-specifier require("x") / import("x") / top-level `import … from "x"` in the .js/.cjs files
 *         under each --scan directory resolves, from that file, with Node's own resolver (package "exports" honoured).
 *         This is the runtime closure of the code the image starts: a production-only node_modules that dropped a
 *         package some compiled file still loads fails the BUILD, not the first job that reaches that file;
 *       - no package directory anywhere in <node_modules> (nested node_modules included) is one of the --forbid names
 *         (build tooling, test runners, the browser driver). A name ending in `*` is a prefix: `@nx/*` is a whole scope,
 *         `@swc/core-*` every package whose name starts with `@swc/core-` (e.g. the per-platform SWC binaries);
 *       - `--allow` names EXACT packages exempt from a --forbid scope (review L-4: `--forbid '@swc/*' --allow @swc/helpers`
 *         bans the whole SWC scope, future packages included, except the one runtime helper library). An allowed package
 *         is exempt only when both its directory name and its package.json name are exactly the allowed name. An --allow
 *         with a wildcard, or one that no --forbid entry covers, is refused (fail closed: an exception must be an
 *         exception to something).
 *     Prints the package-directory count and the number of distinct name@version pairs (the image's package count).
 *
 *   node runtime-deps.cjs worker-delta <api node_modules> <worker node_modules> <out dir>
 *     The Worker image is built FROM the API image and adds only what the Worker needs on top of it. Fails unless every
 *     package directory and workspace symlink of the API tree exists at the SAME path in the Worker tree with the SAME
 *     name@version / link target (the Worker's production closure is a strict superset of the API's, laid out
 *     identically, so the API layer can be reused unchanged); fails if a package the Worker adds has an install script
 *     or a native build (binding.gyp), because the stage that resolved it ran with lifecycle scripts disabled. Copies
 *     only the added package directories (symlinks verbatim) into <out dir>, at the same relative paths. <out dir>/node_modules
 *     always exists afterwards, empty when the Worker adds nothing (the Dockerfile COPYs it unconditionally).
 */
const fs = require('node:fs');
const path = require('node:path');
const { builtinModules } = require('node:module');

const BUILTINS = new Set(builtinModules);
const fail = (msg) => {
  console.error(`runtime-deps: FAIL: ${msg}`);
  process.exitCode = 1;
};

/** Every package directory under a node_modules tree: Map<relative path, "name@version" | "link:<target>">. */
function packageTree(root) {
  const out = new Map();
  const visit = (abs, rel) => {
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink()) {
      out.set(rel, `link:${fs.readlinkSync(abs)}`);
      return;
    }
    if (!st.isDirectory()) return;
    const pj = path.join(abs, 'package.json');
    if (fs.existsSync(pj)) {
      const j = JSON.parse(fs.readFileSync(pj, 'utf8'));
      out.set(rel, `${j.name}@${j.version}`);
    } else {
      out.set(rel, 'dir:no-package.json');
    }
    const nested = path.join(abs, 'node_modules');
    if (fs.existsSync(nested)) walk(nested, `${rel}/node_modules`);
  };
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir)) {
      if (e.startsWith('.')) continue; // .bin, .yarn-state.yml, .package-lock.json: not packages
      const abs = path.join(dir, e);
      if (e.startsWith('@') && fs.lstatSync(abs).isDirectory()) {
        for (const s of fs.readdirSync(abs)) visit(path.join(abs, s), `${rel}/${e}/${s}`);
      } else visit(abs, `${rel}/${e}`);
    }
  };
  walk(root, 'node_modules');
  return out;
}

/** Package name of a packageTree() value, or null for a workspace link / directory without package.json. */
const nameOf = (value) => (value.startsWith('link:') || value.startsWith('dir:') ? null : value.slice(0, value.lastIndexOf('@')));

/** Every .js / .cjs file under dir, recursively (the compiled runtime code to scan). */
function* jsFiles(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* jsFiles(p);
    else if (/\.c?js$/.test(e.name)) yield p;
  }
}

const PACKAGE_NAME = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*(\/.*)?$/i;
const SPECIFIER =/\b(?:require|import)\s*\(\s*(['"])([^'"\n]+)\1\s*\)|^\s*(?:import|export)\s[^'"\n]*?\bfrom\s*(['"])([^'"\n]+)\3/gm;

/**
 * `check <node_modules> --scan <dir>... [--forbid <name>...]`: fails (exit code 1) on any unresolvable bare import in the
 * scanned files or any forbidden package anywhere in the tree; prints the package counts. See the file header.
 */
function check(args) {
  const nm = path.resolve(args[0]);
  const scan = [];
  const forbid = [];
  const allow = [];
  let list = null;
  for (const a of args.slice(1)) {
    if (a === '--scan') list = scan;
    else if (a === '--forbid') list = forbid;
    else if (a === '--allow') list = allow;
    else if (list) list.push(a);
    else throw new Error(`unexpected argument ${a}`);
  }
  if (!fs.existsSync(nm)) throw new Error(`${nm} does not exist`);
  if (scan.length === 0) throw new Error('nothing to --scan');
  const forbidden = (n) => forbid.some((f) => (f.endsWith('*') ? n.startsWith(f.slice(0, -1)) : n === f));
  for (const a of allow) {
    if (a.includes('*')) throw new Error(`--allow takes exact package names only, not ${a}`);
    if (!forbidden(a)) throw new Error(`--allow ${a} is not covered by any --forbid entry`);
  }

  let files = 0;
  let specifiers = 0;
  const unresolved = [];
  for (const root of scan) {
    if (!fs.statSync(root).isDirectory()) throw new Error(`--scan ${root} is not a directory`);
    for (const file of jsFiles(root)) {
      files += 1;
      const src = fs.readFileSync(file, 'utf8');
      for (const m of src.matchAll(SPECIFIER)) {
        const spec = m[2] || m[4];
        if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) continue;
        // Comment text is not code: tsc keeps JSDoc, which may quote a require() ("`require('@nestjs/...')` calls").
        const lineStart = src.lastIndexOf('\n', m.index) + 1;
        if (/^\s*(\*|\/\/|\/\*)/.test(src.slice(lineStart, m.index))) continue;
        if (!PACKAGE_NAME.test(spec)) continue; // not a package name at all (e.g. "@scope/..."), so never a real import
        if (BUILTINS.has(spec) || BUILTINS.has(spec.split('/')[0])) continue;
        specifiers += 1;
        try {
          require.resolve(spec, { paths: [path.dirname(file)] });
        } catch (e) {
          unresolved.push(`${path.relative(process.cwd(), file)}: ${spec} (${e.code || e.message.split('\n')[0]})`);
        }
      }
    }
  }
  if (files === 0) fail('the --scan directories contain no .js files');
  for (const u of unresolved) fail(`unresolvable runtime import: ${u}`);

  const tree = packageTree(nm);
  const versions = new Set();
  for (const [rel, value] of tree) {
    const name = nameOf(value);
    if (name) versions.add(value);
    const dirName = rel.replace(/^.*node_modules\//, '');
    if (allow.includes(dirName) && name === dirName) continue; // an exact, named exception (both names must agree)
    for (const f of forbid) {
      const hit = f.endsWith('*') ? dirName.startsWith(f.slice(0, -1)) || (name || '').startsWith(f.slice(0, -1)) : dirName === f || name === f;
      if (hit) fail(`forbidden package in the runtime image: ${rel} (${value}) matches ${f}`);
    }
  }
  console.log(
    `runtime-deps: scanned ${files} files, ${specifiers} bare imports, ${unresolved.length} unresolved; ` +
      `${tree.size} package directories, ${versions.size} distinct name@version; forbidden names checked: ${forbid.length}; exact exceptions: ${allow.length ? allow.join(', ') : 'none'}`,
  );
}

/**
 * `worker-delta <api node_modules> <worker node_modules> <out dir>`: fails unless the API tree is a same-path, same-version
 * subset of the Worker tree and every added package needs no install script or native build; copies only the additions.
 */
function workerDelta([apiNm, workerNm, outDir]) {
  if (!apiNm || !workerNm || !outDir) throw new Error('usage: worker-delta <api node_modules> <worker node_modules> <out dir>');
  const api = packageTree(path.resolve(apiNm));
  const worker = packageTree(path.resolve(workerNm));
  for (const [rel, value] of api) {
    const w = worker.get(rel);
    if (w !== value) fail(`API package ${rel} (${value}) is ${w === undefined ? 'missing from' : `${w} in`} the Worker tree`);
  }
  if (process.exitCode) return;
  const added = [...worker.keys()].filter((rel) => !api.has(rel)).sort();
  // Copy only the top-most added directories: a nested one is copied with its parent.
  const roots = added.filter((rel) => !added.some((other) => other !== rel && rel.startsWith(`${other}/`)));
  fs.mkdirSync(path.join(outDir, 'node_modules'), { recursive: true });
  for (const rel of roots) {
    const src = path.join(path.resolve(workerNm), '..', rel);
    const value = worker.get(rel);
    if (!value.startsWith('link:')) {
      for (const dir of [src, ...added.filter((r) => r.startsWith(`${rel}/`)).map((r) => path.join(path.resolve(workerNm), '..', r))]) {
        if (fs.lstatSync(dir).isSymbolicLink()) continue;
        const j = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
        const scripts = Object.keys(j.scripts || {}).filter((s) => ['preinstall', 'install', 'postinstall'].includes(s));
        if (scripts.length) fail(`Worker-only package ${j.name}@${j.version} has lifecycle scripts (${scripts.join(', ')}); this stage runs none`);
        if (fs.existsSync(path.join(dir, 'binding.gyp'))) fail(`Worker-only package ${j.name}@${j.version} is a native build (binding.gyp)`);
      }
    }
    const dst = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.cpSync(src, dst, { recursive: true, verbatimSymlinks: true });
    console.log(`runtime-deps: Worker adds ${rel} (${value})`);
  }
  if (roots.length === 0) console.log('runtime-deps: the Worker adds no package to the API tree');
  console.log(`runtime-deps: API tree ${api.size} package directories, Worker tree ${worker.size}; ${added.length} added (${roots.length} copied roots)`);
}

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd === 'check') check(rest);
  else if (cmd === 'worker-delta') workerDelta(rest);
  else throw new Error('usage: runtime-deps.cjs check|worker-delta …');
} catch (e) {
  fail(e.message);
}
