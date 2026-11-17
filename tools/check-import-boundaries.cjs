#!/usr/bin/env node
/**
 * Import-boundary ratchet (untangle wave 1; docs/plans/untangle/cross-cutting.md F7, COMBINED-PLAN.md R3).
 *
 * Three boundary rules from CLAUDE.md exist only in prose; nothing checks them, so they drift. This check stops NEW
 * violations while the wave-3 and wave-5 PRs remove the existing ones. Rules, per production import edge:
 *   engine-to-modules         a file under packages/rab-server/src/engine/ imports a file under packages/rab-server/src/modules/
 *                             (CLAUDE.md: "engine/ never imports from modules/");
 *   worker-deep-import        a file under packages/rab-worker/src/ imports any rab-server file (`@rab/server/...`, the bare
 *                             `@rab/server`, or a relative path into packages/rab-server/) other than the declared worker
 *                             surface WORKER_SURFACE (packages/rab-server/src/engine/worker-shared/, the folder the server
 *                             already keeps for the Worker's contracts). F5 replaces that surface with explicit entry points.
 *                             The surface cannot launder modules/ code: it sits under engine/, so the first rule refuses any
 *                             import it makes into modules/;
 *   front-feature-to-feature  packages/rab-front/src/features/<a>/ imports packages/rab-front/src/features/<b>/, a != b
 *                             (CLAUDE.md "Client apps": each feature folder is self-contained);
 *   mobile-feature-to-feature packages/rab-mobile/lib/features/<a>/ imports packages/rab-mobile/lib/features/<b>/, a != b.
 *
 * Scope: tracked production files (git ls-files). Specs, __tests__/, test helpers, fixtures, test kits and jest setup are
 * not scanned: the rules are about the production dependency direction, and a test has no other place to import from
 * until the module surfaces exist. TS/TSX/JS imports are read with the repository's `typescript` (ts.preProcessFile:
 * `import`, `import type`, `export … from`, `import()` and `require()`; comments and strings are never mistaken for an
 * import). Dart imports are read line by line (`import` / `export` / `part`, `package:rab_staff/` = lib/).
 *
 * Ratchet: tools/import-boundaries.baseline.json records, per rule and importing file, how many violating import edges
 * exist today. The check FAILS when a file has MORE edges than its baseline (a new violation: import through the owning
 * surface instead) and also when it has FEWER (a stale baseline: lower the entry, or delete it at zero, in the same PR).
 * In a pull request the baseline itself may only shrink against the base branch (--base). Counts are per file, so a
 * moved TARGET (e.g. an entity that moves from modules/ into engine/) does not churn the Worker's entries.
 *
 *   node tools/check-import-boundaries.cjs                    # exit 1 on a new violation or a stale baseline entry
 *   node tools/check-import-boundaries.cjs --list             # print every violating edge (for the fix PRs)
 *   node tools/check-import-boundaries.cjs --write-baseline   # rewrite the baseline; refuses to GROW any entry
 *   node tools/check-import-boundaries.cjs --base origin/main # the committed baseline only shrinks against that ref
 *
 * LIMITS (stated): a path computed at run time (`require(variable)`), a TS path alias (none is configured in these
 * packages today) and a Dart conditional import are not seen. Renaming a file that carries baseline debt shows as a new
 * entry: clear the debt in that PR, or keep the old file name.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const BASELINE_REL = 'tools/import-boundaries.baseline.json';
const BASELINE_FILE = path.join(ROOT, BASELINE_REL);
const RULES = Object.freeze(['engine-to-modules', 'worker-deep-import', 'front-feature-to-feature', 'mobile-feature-to-feature']);

const SERVER = 'packages/rab-server/';
const SERVER_ENGINE = 'packages/rab-server/src/engine/';
const SERVER_MODULES = 'packages/rab-server/src/modules/';
const WORKER_SRC = 'packages/rab-worker/src/';
/** The only rab-server folder Worker production code may import (until F5's worker entry points replace it). */
const WORKER_SURFACE = Object.freeze(['packages/rab-server/src/engine/worker-shared/']);
const FRONT_FEATURE = /^packages\/rab-front\/src\/features\/([^/]+)\//;
const MOBILE_FEATURE = /^packages\/rab-mobile\/lib\/features\/([^/]+)\//;
const SCANNED = /^(?:packages\/rab-server\/src\/engine\/|packages\/rab-worker\/src\/|packages\/rab-front\/src\/features\/|packages\/rab-mobile\/lib\/features\/)/;
const CODE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|dart)$/;

/** Matched against the REPO-RELATIVE path (forward slashes). */
const TEST_FILE = [
  /\.(?:spec|test|e2e-spec)\.[cm]?[jt]sx?$/, /_test\.dart$/, /\.d\.ts$/, /\.stories\.[jt]sx?$/,
  /(?:^|\/)(?:__tests__|__mocks__|test|tests|testing|fixtures|test-helpers|test-utils)\//,
  /(?:^|\/)jest[-.][^/]*$/, /(?:^|\/)setup-tests\.[jt]s$/, /TestKit\.[jt]sx?$/,
];
const isTestFile = (rel) => TEST_FILE.some((re) => re.test(rel));

const PKG_ALIAS = Object.freeze({
  '@rab/server': 'packages/rab-server/src',
  '@rab/worker': 'packages/rab-worker/src',
  '@rab/shared': 'packages/rab-shared/src',
  '@rab/ui': 'packages/rab-ui/src',
  '@rab/emails': 'packages/rab-emails/src',
  '@rab/utils': 'packages/rab-utils/src',
});
const EXTS = ['', '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.dart', '/index.ts', '/index.tsx', '/index.js'];

function loadTypeScript(root = ROOT) {
  try {
    return require(require.resolve('typescript', { paths: [root] }));
  } catch {
    return null;
  }
}

/** Import specifiers of one source file (TS/JS through the TypeScript pre-processor, Dart by line). */
function specifiersOf(rel, src, ts) {
  if (rel.endsWith('.dart')) {
    const out = [];
    for (const m of src.matchAll(/^\s*(?:import|export|part)\s+['"]([^'"]+)['"]/gm)) out.push(m[1]);
    return out;
  }
  if (!ts) throw new Error('check-import-boundaries needs the repository\'s `typescript` (run yarn install).');
  return ts.preProcessFile(src, true, true).importedFiles.map((f) => f.fileName);
}

/**
 * Repo-relative target of a specifier, or null for an external package / SDK import. A workspace alias that does not
 * resolve to a tracked file still returns its mapped path, so an import of a missing server file is never ignored.
 */
function resolveSpecifier(fromRel, spec, fileSet) {
  const tryResolve = (base) => {
    const b = path.posix.normalize(base);
    for (const e of EXTS) if (fileSet.has(b + e)) return b + e;
    const js = /^(.*)\.(?:js|mjs|cjs|jsx)$/.exec(b); // NodeNext `.js` specifiers that name a .ts source
    if (js) for (const e of ['.ts', '.tsx', '.mts', '.cts']) if (fileSet.has(js[1] + e)) return js[1] + e;
    return null;
  };
  if (spec.startsWith('dart:')) return null;
  if (spec.startsWith('package:')) {
    if (!spec.startsWith('package:rab_staff/')) return null;
    const sub = `packages/rab-mobile/lib/${spec.slice('package:rab_staff/'.length)}`;
    return tryResolve(sub) || path.posix.normalize(sub);
  }
  if (spec.startsWith('.')) {
    const joined = path.posix.join(path.posix.dirname(fromRel), spec);
    return tryResolve(joined) || path.posix.normalize(joined);
  }
  for (const [alias, dir] of Object.entries(PKG_ALIAS)) {
    if (spec === alias) return `${dir}/index.ts`;
    if (spec.startsWith(`${alias}/`)) {
      const sub = `${dir}/${spec.slice(alias.length + 1).replace(/^(?:src|dist|dist-cjs|dist-esm)\//, '')}`;
      return tryResolve(sub) || path.posix.normalize(sub);
    }
  }
  return null;
}

/** The rule an edge breaks, or null. */
function classify(fromRel, toRel) {
  if (!toRel || isTestFile(fromRel)) return null;
  if (fromRel.startsWith(SERVER_ENGINE) && toRel.startsWith(SERVER_MODULES)) return 'engine-to-modules';
  if (fromRel.startsWith(WORKER_SRC) && toRel.startsWith(SERVER) && !WORKER_SURFACE.some((p) => toRel.startsWith(p))) return 'worker-deep-import';
  const ff = FRONT_FEATURE.exec(fromRel);
  const ft = FRONT_FEATURE.exec(toRel);
  if (ff && ft && ff[1] !== ft[1]) return 'front-feature-to-feature';
  const mf = MOBILE_FEATURE.exec(fromRel);
  const mt = MOBILE_FEATURE.exec(toRel);
  if (mf && mt && mf[1] !== mt[1]) return 'mobile-feature-to-feature';
  return null;
}

/** Violating edges of one file: [{ rule, file, target, spec }]. */
function scanSource(rel, src, fileSet, ts) {
  if (!SCANNED.test(rel) || !CODE.test(rel) || isTestFile(rel)) return [];
  const out = [];
  for (const spec of specifiersOf(rel, src, ts)) {
    const target = resolveSpecifier(rel, spec, fileSet);
    const rule = classify(rel, target);
    if (rule) out.push({ rule, file: rel, target, spec });
  }
  return out;
}

function listFiles(root = ROOT) {
  return execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 1 << 28 }).split('\0').filter(Boolean);
}

function scan(root = ROOT) {
  const files = listFiles(root);
  const fileSet = new Set(files);
  const ts = loadTypeScript(root);
  const sites = [];
  for (const rel of files) {
    if (!SCANNED.test(rel) || !CODE.test(rel) || isTestFile(rel)) continue;
    let src;
    try {
      src = fs.readFileSync(path.join(root, rel), 'utf8');
    } catch {
      continue; // tracked but deleted in the working tree
    }
    sites.push(...scanSource(rel, src, fileSet, ts));
  }
  return sites;
}

/** { rule: { file: count } }, keys sorted. */
function countsOf(sites) {
  const counts = {};
  for (const s of sites) {
    counts[s.rule] ??= {};
    counts[s.rule][s.file] = (counts[s.rule][s.file] ?? 0) + 1;
  }
  return sortCounts(counts);
}

function sortCounts(counts) {
  const out = {};
  for (const rule of RULES) {
    if (!counts[rule]) continue;
    out[rule] = {};
    for (const f of Object.keys(counts[rule]).sort()) out[rule][f] = counts[rule][f];
  }
  return out;
}

/** Tree vs baseline: `grown` = new violations (fail), `stale` = baseline above the current count (fail: lower it). */
function compare(current, baseline) {
  const grown = [];
  const stale = [];
  for (const rule of RULES) {
    const cur = current[rule] ?? {};
    const base = baseline[rule] ?? {};
    for (const file of new Set([...Object.keys(cur), ...Object.keys(base)])) {
      const c = cur[file] ?? 0;
      const b = base[file] ?? 0;
      if (c > b) grown.push({ rule, file, current: c, baseline: b });
      else if (c < b) stale.push({ rule, file, current: c, baseline: b });
    }
  }
  return { grown, stale };
}

/** The committed baseline vs the base branch's: an entry above the base, or a new entry, has grown (fail). */
function compareToBase(base, head) {
  const grown = [];
  for (const rule of RULES) {
    const h = head[rule] ?? {};
    const b = base[rule] ?? {};
    for (const file of Object.keys(h)) {
      if (!(file in b)) grown.push({ rule, file, base: 0, head: h[file], newKey: true });
      else if (h[file] > b[file]) grown.push({ rule, file, base: b[file], head: h[file], newKey: false });
    }
  }
  return { grown };
}

function parseBaseline(text, label) {
  const doc = JSON.parse(text);
  const rules = doc && typeof doc === 'object' ? doc.rules : undefined;
  if (!rules || typeof rules !== 'object' || Array.isArray(rules)) throw new Error(`${label}: expected an object with a "rules" object`);
  for (const [rule, files] of Object.entries(rules)) {
    if (!RULES.includes(rule)) throw new Error(`${label}: unknown rule "${rule}"`);
    if (!files || typeof files !== 'object' || Array.isArray(files)) throw new Error(`${label}: rule "${rule}" must map files to counts`);
    for (const [file, n] of Object.entries(files)) {
      if (!Number.isInteger(n) || n < 1) throw new Error(`${label}: ${rule} ${file} must be a positive integer (delete the entry at zero)`);
    }
  }
  return rules;
}

function readBaseline(file = BASELINE_FILE) {
  if (!fs.existsSync(file)) return null;
  return parseBaseline(fs.readFileSync(file, 'utf8'), path.basename(file));
}

/** The baseline as committed at `ref` (git show, no shell), or null when that ref has no baseline file yet. */
function readBaselineAt(ref, root = ROOT) {
  let text;
  try {
    text = execFileSync('git', ['-C', root, 'show', `${ref}:${BASELINE_REL}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    return null;
  }
  return parseBaseline(text, `${ref}:${BASELINE_REL}`);
}

function baselineDocument(counts) {
  return {
    _comment: [
      'Import-boundary ratchet (tools/check-import-boundaries.cjs). Per rule and importing file: the number of production',
      'import edges that cross a boundary CLAUDE.md forbids (engine -> modules, Worker -> rab-server internals, feature ->',
      'feature in rab-front and rab-mobile). This file may only SHRINK: a PR that removes violations lowers or deletes its',
      'rows in the same PR. Never raise a count; import through the owning surface instead.',
    ],
    rules: sortCounts(counts),
  };
}

const total = (counts) => Object.values(counts).reduce((n, files) => n + Object.values(files).reduce((a, b) => a + b, 0), 0);

function main(argv) {
  const baseIdx = argv.indexOf('--base');
  if (baseIdx !== -1) {
    const ref = argv[baseIdx + 1];
    if (!ref) throw new Error('--base needs a git ref');
    const head = readBaseline();
    if (!head) throw new Error(`${BASELINE_REL} is missing`);
    const base = readBaselineAt(ref);
    if (!base) {
      console.log(`[import-boundaries] ${ref} has no ${BASELINE_REL} yet: nothing to compare.`);
      return 0;
    }
    const { grown } = compareToBase(base, head);
    for (const g of grown) console.log(`GROWN  ${g.rule.padEnd(25)} ${g.file}: ${g.newKey ? 'new entry' : `${g.base} ->`} ${g.head}. The baseline may only shrink against ${ref}.`);
    console.log(`[import-boundaries] baseline vs ${ref}: ${grown.length} grown entr${grown.length === 1 ? 'y' : 'ies'}.`);
    return grown.length ? 1 : 0;
  }

  const sites = scan();
  if (argv.includes('--list')) {
    for (const s of sites) console.log(`${s.rule.padEnd(25)} ${s.file} -> ${s.target}  ('${s.spec}')`);
    console.log(`[import-boundaries] ${sites.length} violating edge(s).`);
    return 0;
  }
  const current = countsOf(sites);
  const baseline = readBaseline();
  if (argv.includes('--write-baseline')) {
    if (baseline) {
      const { grown } = compare(current, baseline);
      if (grown.length) {
        for (const g of grown) console.error(`REFUSED (would grow) ${g.rule} ${g.file}: ${g.baseline} -> ${g.current}`);
        console.error('[import-boundaries] the baseline may only shrink: import through the owning surface instead.');
        return 1;
      }
    }
    fs.writeFileSync(BASELINE_FILE, JSON.stringify(baselineDocument(current), null, 2) + '\n');
    console.log(`[import-boundaries] baseline written: ${total(current)} edge(s).`);
    return 0;
  }
  if (!baseline) {
    console.error(`[import-boundaries] ${BASELINE_REL} is missing (create it once with --write-baseline).`);
    return 1;
  }
  const { grown, stale } = compare(current, baseline);
  const byFile = new Map();
  for (const s of sites) {
    const k = `${s.rule}\0${s.file}`;
    if (!byFile.has(k)) byFile.set(k, []);
    byFile.get(k).push(`${s.target} ('${s.spec}')`);
  }
  for (const g of grown) {
    console.log(`NEW    ${g.rule.padEnd(25)} ${g.file}: ${g.baseline} -> ${g.current}`);
    for (const t of byFile.get(`${g.rule}\0${g.file}`) ?? []) console.log(`         -> ${t}`);
  }
  for (const s of stale) console.log(`STALE  ${s.rule.padEnd(25)} ${s.file}: baseline ${s.baseline}, now ${s.current}. Lower the entry in ${BASELINE_REL}.`);
  const perRule = RULES.map((r) => `${r}=${Object.values(current[r] ?? {}).reduce((a, b) => a + b, 0)}`).join(' ');
  console.log(`[import-boundaries] ${perRule}; ${grown.length} new, ${stale.length} stale.`);
  if (grown.length) console.log('A new boundary violation: import through the owning surface (engine/, engine/worker-shared/, shared/) instead.');
  return grown.length || stale.length ? 1 : 0;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(`[import-boundaries] ${err.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  RULES, WORKER_SURFACE, BASELINE_REL, isTestFile, specifiersOf, resolveSpecifier, classify, scanSource, scan, countsOf,
  compare, compareToBase, parseBaseline, baselineDocument, loadTypeScript, main,
};
