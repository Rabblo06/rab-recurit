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
 *
 *   node runtime-deps.cjs prune <node_modules> --lockfile <yarn.lock> [--drop <name>...] [--dry-run]
 *     Removes every installed package that is unreachable from the production roots once the dependency edges to the
 *     --drop names (default: RUNTIME_PRUNE, exported by this file) are cut. Exists for node-gyp: Yarn injects
 *     `node-gyp: npm:latest` into the lockfile entry of every package with a native build (argon2, node-addon-api,
 *     msgpackr-extract, fsevents), `workspaces focus --production` keeps it, and it drags an install-time-only tree
 *     (tar, tinyglobby, picomatch 4, undici 8, ...) into an image that compiles nothing (argon2 loads its prebuilt addon
 *     through node-gyp-build). Deleting node_modules/node-gyp alone would leave that hoisted tree behind, so
 *     reachability is computed instead:
 *       - roots: every workspace link in <node_modules> (the focused workspaces), through their package.json
 *         `dependencies`, `optionalDependencies` and `peerDependencies` (never devDependencies);
 *       - edges of an installed package: its package.json `dependencies`/`optionalDependencies`/`peerDependencies`
 *         UNION the `dependencies`/`peerDependencies` of its lockfile entry (the lockfile also carries what Yarn injected
 *         or a packageExtension added), minus the --drop names; each edge is located with Node's lookup (the package's
 *         own node_modules, then each enclosing node_modules up to the root), so a nested copy is kept or pruned on its own;
 *       - a package any runtime package reaches is kept, whatever else also reaches it.
 *     Fails (and removes nothing) when an installed package has no lockfile entry (the tree is not this lockfile's
 *     install), when no workspace root exists, when a --drop name is not installed (a stale --drop), or when the code of
 *     a KEPT package literally requires/imports a package that would be removed (an undeclared dependency that only
 *     worked through hoisting; a package's `bin` files are install-time CLIs and are not scanned). Afterwards no copy
 *     of a --drop name may remain, and dangling .bin links into removed directories are deleted. --dry-run reports
 *     without removing.
 */
const fs = require('node:fs');
const path = require('node:path');
const { builtinModules } = require('node:module');

const BUILTINS = new Set(builtinModules);

/**
 * The exact package names `prune` removes as roots (its default --drop list; the image passes no --drop, so this is the
 * one source of truth). Everything that only these reach goes with them; what a runtime package also reaches stays.
 * Exported for other gates (e.g. an audit exception that must prove a package left the production closure).
 */
const RUNTIME_PRUNE = Object.freeze(['node-gyp']);
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

/** Unquotes a lockfile key or value: `"@phc/format"` -> `@phc/format`. */
const unquote = (s) => (s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s);

/**
 * Yarn Berry lockfile -> Map<"name@version", Set<dependency name>> (`dependencies` and `peerDependencies` keys). The name
 * comes from the entry's `resolution` (so an npm alias maps to the real package, as its installed package.json does);
 * entries with the same name@version (e.g. a package and its builtin patch) are merged. Workspace entries are skipped:
 * a workspace's lockfile entry also lists its devDependencies, so roots are read from the workspace package.json.
 */
function lockfileEdges(file) {
  const edges = new Map();
  let entry = null;
  let section = null;
  const flush = () => {
    if (!entry || !entry.resolution || entry.version === undefined) return;
    const res = entry.resolution;
    const at = res.indexOf('@', 1);
    if (at < 0 || res.slice(at + 1).startsWith('workspace:')) return;
    const key = `${res.slice(0, at)}@${entry.version}`;
    if (!edges.has(key)) edges.set(key, new Set());
    for (const d of entry.deps) edges.get(key).add(d);
  };
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (line === '' || line.startsWith('#')) continue;
    if (!line.startsWith(' ')) {
      flush();
      entry = line.startsWith('__metadata') ? null : { deps: [] };
      section = null;
      continue;
    }
    if (!entry) continue;
    const m = /^( +)("[^"]+"|[^:\s]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, indent, rawKey, rawValue] = m;
    const key = unquote(rawKey);
    if (indent.length === 2) {
      section = rawValue === '' ? key : null;
      if (key === 'version') entry.version = unquote(rawValue);
      if (key === 'resolution') entry.resolution = unquote(rawValue);
    } else if (indent.length === 4 && (section === 'dependencies' || section === 'peerDependencies')) {
      entry.deps.push(key);
    }
  }
  flush();
  return edges;
}

/** "node_modules/a/node_modules/@s/b" -> ['a', '@s/b'] (the chain of package names a tree path is nested under). */
const chainOf = (rel) => rel.slice('node_modules/'.length).split('/node_modules/');

/** Node's lookup of `name` from a package at chain [a, b, ...]: its own node_modules first, then each enclosing one. */
function locate(tree, chain, name) {
  for (let k = chain.length; k >= 0; k -= 1) {
    const rel = `node_modules/${[...chain.slice(0, k), name].join('/node_modules/')}`;
    if (tree.has(rel)) return rel;
  }
  return null;
}

/** Bare package name of a specifier ("@s/b/sub" -> "@s/b", "a/sub" -> "a"), or null when it is not a package import. */
function packageNameOf(spec) {
  if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:') || !PACKAGE_NAME.test(spec)) return null;
  const parts = spec.split('/');
  const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  return BUILTINS.has(name) ? null : name;
}

/** Every .js/.cjs/.mjs file of ONE package directory (its nested node_modules are other packages, visited on their own). */
function* packageCode(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* packageCode(p);
    else if (e.isFile() && /\.[cm]?js$/.test(e.name)) yield p;
  }
}

/** `prune <node_modules> --lockfile <yarn.lock> [--drop <name>...] [--dry-run]`: see the file header. */
function prune(args) {
  const nm = path.resolve(args[0] || '');
  const drop = [];
  let lockfile = null;
  let dryRun = false;
  let list = null;
  for (let i = 1; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--drop') list = drop;
    else if (a === '--lockfile') {
      lockfile = args[++i];
      list = null;
    } else if (a === '--dry-run') {
      dryRun = true;
      list = null;
    } else if (list) list.push(a);
    else throw new Error(`unexpected argument ${a}`);
  }
  if (!args[0] || !fs.existsSync(nm)) throw new Error(`usage: prune <node_modules> --lockfile <yarn.lock> [--drop <name>...] (${nm} does not exist)`);
  if (!lockfile) throw new Error('prune needs --lockfile');
  if (drop.length === 0) drop.push(...RUNTIME_PRUNE);
  for (const d of drop) if (d.includes('*') || packageNameOf(d) !== d) throw new Error(`--drop takes exact package names, not ${d}`);

  const lock = lockfileEdges(path.resolve(lockfile));
  const tree = packageTree(nm);
  const base = path.dirname(nm);
  const manifest = (rel) => JSON.parse(fs.readFileSync(path.join(base, rel, 'package.json'), 'utf8'));
  const declared = (j) => [
    ...Object.keys(j.dependencies || {}),
    ...Object.keys(j.optionalDependencies || {}),
    ...Object.keys(j.peerDependencies || {}),
  ];

  // Roots: the workspace links (and, fail-safe, any directory that is not a package: it is kept, never pruned).
  const roots = [];
  const kept = new Set();
  for (const [rel, value] of tree) {
    if (value.startsWith('link:')) roots.push(rel);
    else if (value.startsWith('dir:')) kept.add(rel);
    else if (!lock.has(value)) fail(`${rel} (${value}) has no entry in ${lockfile}: the tree is not this lockfile's install`);
  }
  if (roots.length === 0) fail(`no workspace link in ${nm}: nothing to compute production reachability from`);
  for (const d of drop) if (![...tree.values()].some((v) => nameOf(v) === d)) fail(`--drop ${d} is not installed (stale --drop)`);
  if (process.exitCode) return;

  // Reachability, with the --drop edges cut. A workspace link resolves from the top level (its real path is under
  // /app/packages, whose own node_modules the Dockerfile asserts do not exist).
  const queue = [];
  const reach = (fromChain, name) => {
    if (drop.includes(name)) return;
    const rel = locate(tree, fromChain, name);
    if (rel && !kept.has(rel)) {
      kept.add(rel);
      queue.push(rel);
    }
  };
  for (const rel of roots) {
    kept.add(rel);
    const target = path.resolve(path.dirname(path.join(base, rel)), fs.readlinkSync(path.join(base, rel)));
    const j = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8'));
    for (const d of declared(j)) reach([], d);
  }
  while (queue.length) {
    const rel = queue.shift();
    const value = tree.get(rel);
    if (value.startsWith('link:')) continue; // a workspace, already a root
    const chain = chainOf(rel);
    for (const d of new Set([...declared(manifest(rel)), ...(lock.get(value) || [])])) reach(chain, d);
  }

  // Remove the top-most unreachable directories (a nested one goes with its parent).
  const doomed = [...tree.keys()].filter((rel) => !kept.has(rel)).sort();
  const doomedRoots = doomed.filter((rel) => !doomed.some((o) => o !== rel && rel.startsWith(`${o}/`)));
  const doomedSet = new Set(doomed);
  for (const d of drop) {
    for (const [rel, value] of tree) if (nameOf(value) === d && !doomedSet.has(rel)) fail(`${rel} (${value}) is a --drop package but stays reachable`);
  }

  // Undeclared-dependency guard: kept code that literally loads a package being removed would break at runtime.
  const doomedNames = new Set(doomed.flatMap((rel) => [nameOf(tree.get(rel)), chainOf(rel).pop()]));
  let scanned = 0;
  for (const rel of kept) {
    const value = tree.get(rel);
    if (value.startsWith('link:') || value.startsWith('dir:')) continue;
    const chain = chainOf(rel);
    // A package's `bin` files are install-time/command-line entry points (node-gyp-build's bin.js runs `node-gyp rebuild`
    // during an install), never loaded by require() from runtime code: they are not scanned.
    const bin = manifest(rel).bin;
    const binFiles = new Set(Object.values(typeof bin === 'string' ? { bin } : bin || {}).map((b) => path.resolve(base, rel, b)));
    for (const file of packageCode(path.join(base, rel))) {
      if (binFiles.has(path.resolve(file))) continue;
      scanned += 1;
      const src = fs.readFileSync(file, 'utf8');
      for (const m of src.matchAll(SPECIFIER)) {
        const name = packageNameOf(m[2] || m[4]);
        if (!name || !doomedNames.has(name)) continue;
        const lineStart = src.lastIndexOf('\n', m.index) + 1;
        if (/^\s*(\*|\/\/|\/\*)/.test(src.slice(lineStart, m.index))) continue;
        const target = locate(tree, chain, name);
        if (target && doomedSet.has(target)) {
          fail(`kept package ${value} loads ${name} (${path.relative(base, file)}), which prune would remove (${target})`);
        }
      }
    }
  }
  if (process.exitCode) return;

  for (const rel of doomedRoots) {
    console.log(`runtime-deps: prune ${dryRun ? 'would remove' : 'removes'} ${rel} (${tree.get(rel)})`);
    if (!dryRun) fs.rmSync(path.join(base, rel), { recursive: true, force: true });
  }
  let bins = 0;
  if (!dryRun) {
    const doomedAbs = doomedRoots.map((rel) => path.join(base, rel) + path.sep);
    // Empty scope directories, then .bin links that pointed into a removed package.
    for (const rel of doomedRoots) {
      const parent = path.dirname(path.join(base, rel));
      if (path.basename(parent).startsWith('@') && fs.existsSync(parent) && fs.readdirSync(parent).length === 0) fs.rmdirSync(parent);
    }
    const binDirs = [path.join(nm, '.bin'), ...[...kept].filter((rel) => !tree.get(rel).startsWith('link:')).map((rel) => path.join(base, rel, 'node_modules', '.bin'))];
    for (const binDir of binDirs) {
      if (!fs.existsSync(binDir)) continue;
      for (const b of fs.readdirSync(binDir)) {
        const link = path.join(binDir, b);
        if (!fs.lstatSync(link).isSymbolicLink()) continue;
        const target = path.resolve(binDir, fs.readlinkSync(link));
        if (doomedAbs.some((d) => target.startsWith(d))) {
          fs.unlinkSync(link);
          bins += 1;
        }
      }
    }
    const after = packageTree(nm);
    for (const [rel, value] of after) if (drop.includes(nameOf(value))) fail(`${rel} (${value}) is still installed after prune`);
  }
  console.log(
    `runtime-deps: prune ${dryRun ? '(dry run) ' : ''}dropped edges to ${drop.join(', ')}; ${tree.size} package directories, ` +
      `${kept.size} reachable, ${doomed.length} ${dryRun ? 'to remove' : 'removed'} (${doomedRoots.length} top-level), ${bins} .bin links removed; ` +
      `undeclared-dependency scan: ${scanned} files`,
  );
}

if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    if (cmd === 'check') check(rest);
    else if (cmd === 'worker-delta') workerDelta(rest);
    else if (cmd === 'prune') prune(rest);
    else throw new Error('usage: runtime-deps.cjs check|worker-delta|prune …');
  } catch (e) {
    fail(e.message);
  }
}

module.exports = { RUNTIME_PRUNE };
