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
 * Approved growth: the ONLY way an entry may grow against the base branch is an owner-dated entry in
 * tools/import-boundaries.approved.json. --base reads that file FROM THE BASE REF (git show), never from the head being
 * checked, so an approval takes effect only once it is on the base branch: it must merge in its own PR before any PR can
 * use it. --base also fails when the diff since the merge-base changes the approvals file together with any
 * tools/*.baseline.json, except when that change only deletes, exactly, the entries this PR uses (the using PR consumes
 * its own approval; nothing else in the file may change). An entry { rule, file, from, to } lets exactly that rule and file go from exactly `from` (0 = the
 * file has no entry at the base) to exactly `to`; any other count, file or rule still fails. An optional `target` (the
 * resolved import target, exactly as --list prints it) pins the growth to that import: --base requires the head file to
 * have at least `to - from` more edges of that rule to `target` than the base file, and the tree check requires, while
 * the file's count is above `from`, at least one edge of that rule from the file to `target`. An entry whose `from` no
 * longer equals the base branch's count is STALE and fails --base while the head still lists it (by rule and file), so it
 * must be deleted: by the using PR itself, or by any later PR (deleting it is never blocked). If the base ref (main) has
 * no baseline file, --base fails closed; any other base without one is "nothing to compare".
 *
 *   node tools/check-import-boundaries.cjs                    # exit 1 on a new violation, a stale baseline entry or a
 *                                                             # grown file without its approved `target`
 *   node tools/check-import-boundaries.cjs --list             # print every violating edge (for the fix PRs)
 *   node tools/check-import-boundaries.cjs --write-baseline   # rewrite the baseline; refuses to GROW any entry
 *   node tools/check-import-boundaries.cjs --base origin/main # the committed baseline only shrinks against that ref
 *
 * --base takes a plain ref: [A-Za-z0-9._/-] (no leading '-', no '..'), optionally followed by ancestry suffixes `~N` / `^N`
 * (HEAD~1, origin/main^2). No other revision syntax (`@{...}`, `^{...}`, `:`, a leading `^`, ranges) is accepted. git runs
 * with LC_ALL=C (LANGUAGE unset), so the one tolerated failure ("path ... does not exist in ...") is matched in English.
 *
 * LIMITS (stated): a path computed at run time (`require(variable)`), a TS path alias or a bare `baseUrl` specifier (none
 * is configured in these packages today) and a Dart conditional import are not seen. Renaming a file that carries baseline debt shows as a new
 * entry: clear the debt in that PR, or keep the old file name.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const BASELINE_REL = 'tools/import-boundaries.baseline.json';
const BASELINE_FILE = path.join(ROOT, BASELINE_REL);
const APPROVALS_REL = 'tools/import-boundaries.approved.json';
/** Every ratchet baseline in tools/ (this one and the others): the approvals file may not change in the same PR as any. */
const RATCHET_BASELINE = /^tools\/[^/]+\.baseline\.json$/;
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
    return require(require.resolve('typescript', { paths: [root, ROOT] }));
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

/** git's environment: LC_ALL=C and no LANGUAGE, so its messages are English whatever the caller's locale. */
function gitEnv() {
  const env = { ...process.env, LC_ALL: 'C' };
  delete env.LANGUAGE;
  return env;
}

function git(args, root) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', env: gitEnv(), stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 });
}

function listFiles(root = ROOT) {
  return git(['ls-files', '-z'], root).split('\0').filter(Boolean);
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

/**
 * The committed baseline vs the base branch's: an entry above the base, or a new entry, has grown (fail), unless one
 * approval (main() passes the BASE ref's list, readApprovalsAt) names that rule and file, the base count equals its `from`
 * (absent = 0) and the head count equals its `to` exactly. `staleApproved` = approvals whose `from` no longer equals the
 * base count AND that are still listed (by rule and file) in `stillListed`, the head's validated approvals (fail: delete
 * them). A head that deletes a stale entry therefore clears the failure, while growth is still accepted only through
 * the base list: removing an entry in the head can never accept a growth. `used` = the approvals that accepted a growth
 * (verifyTargets checks their `target`).
 */
function compareToBase(base, head, approved, stillListed = approved) {
  validateApprovedGrowth(approved);
  validateApprovedGrowth(stillListed);
  const listed = (a) => stillListed.some((h) => h.rule === a.rule && h.file === a.file);
  const grown = [];
  const staleApproved = [];
  const used = [];
  const approvalOf = (rule, file) => approved.find((a) => a.rule === rule && a.file === file);
  for (const rule of RULES) {
    const h = head[rule] ?? {};
    const b = base[rule] ?? {};
    for (const file of Object.keys(h)) {
      const baseCount = file in b ? b[file] : 0;
      if (h[file] <= baseCount) continue;
      const a = approvalOf(rule, file);
      if (a && a.from === baseCount && a.to === h[file]) {
        used.push(a);
        continue;
      }
      grown.push({ rule, file, base: baseCount, head: h[file], newKey: !(file in b) });
    }
  }
  for (const a of approved) {
    const baseCount = (base[a.rule] ?? {})[a.file] ?? 0;
    if (baseCount !== a.from && listed(a)) staleApproved.push({ ...a, base: baseCount });
  }
  return { grown, staleApproved, used };
}

const edgesTo = (sites, a) => sites.filter((s) => s.rule === a.rule && s.file === a.file && s.target === a.target).length;

/**
 * Tree check: an approval with a `target` whose file's count for that rule is above `from` (the growth is in the tree)
 * must have at least one edge of that rule from that file to `target`. Returns the approvals that do not.
 */
function checkApprovalTargets(approved, sites, current) {
  const missing = [];
  for (const a of approved) {
    if (!a.target) continue;
    const count = (current[a.rule] ?? {})[a.file] ?? 0;
    if (count > a.from && edgesTo(sites, a) === 0) missing.push({ ...a, current: count });
  }
  return missing;
}

/**
 * --base: each used approval with a `target` must be spent on that import. The head file (working tree) needs at least
 * `to - from` more edges of that rule to `target` than the file at the base ref (absent there = 0 edges), so another
 * import in the same file cannot fill the approved slot. Returns the approvals that fail, with `added`.
 */
function verifyTargets(used, ref, root = ROOT) {
  const withTarget = used.filter((a) => a.target);
  if (!withTarget.length) return [];
  const fileSet = new Set(listFiles(root));
  const ts = loadTypeScript(root);
  const wrong = [];
  for (const a of withTarget) {
    let headSrc = '';
    try {
      headSrc = fs.readFileSync(path.join(root, a.file), 'utf8');
    } catch {
      // missing in the working tree: 0 edges, so the approval fails (fail closed)
    }
    const baseSrc = gitShowAt(ref, a.file, root) ?? '';
    const added = edgesTo(scanSource(a.file, headSrc, fileSet, ts), a) - edgesTo(scanSource(a.file, baseSrc, fileSet, ts), a);
    if (added < a.to - a.from) wrong.push({ ...a, added });
  }
  return wrong;
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

/**
 * A plain ref name, optionally followed by ancestry suffixes (`~N`, `^N`). Safe because git runs without a shell and the
 * suffixes only walk to an ancestor commit; `@{...}`, `^{...}`, `:`, ranges, a leading `^` or `-` are all refused.
 */
const PLAIN_REF = /^[A-Za-z0-9._/-]{1,200}(?:[~^][0-9]{0,4}){0,20}$/;

function assertPlainRef(ref) {
  if (typeof ref !== 'string' || !PLAIN_REF.test(ref) || ref.startsWith('-') || ref.includes('..')) throw new Error(`--base: not a plain git ref: ${JSON.stringify(ref)}`);
  return ref;
}

/** `rel` as committed at `ref` (git show, no shell), or null when the ref exists but has no such path. */
function gitShowAt(ref, rel, root = ROOT) {
  assertPlainRef(ref);
  try {
    return git(['show', `${ref}:${rel}`], root);
  } catch (error) {
    // Only "the ref exists but has no such path" means absent. Any other failure (an unknown ref, a shallow clone without
    // the base branch, git missing) fails closed: the shrink-only rule must never pass unchecked.
    const stderr = String(error.stderr ?? '');
    if (/does not exist in|exists on disk, but not in/.test(stderr)) return null;
    throw new Error(`--base: git show ${ref}:${rel} failed: ${stderr.trim().split('\n')[0] || error.message}`);
  }
}

/** The baseline as committed at `ref`, or null when that ref has no baseline file yet. */
function readBaselineAt(ref, root = ROOT) {
  const text = gitShowAt(ref, BASELINE_REL, root);
  return text === null ? null : parseBaseline(text, `${ref}:${BASELINE_REL}`);
}

/** The approvals document as committed at `ref`, or an empty one when that ref has no approvals file. */
function readApprovalsDocumentAt(ref, root = ROOT) {
  const text = gitShowAt(ref, APPROVALS_REL, root);
  return text === null ? Object.freeze({ comment: undefined, approved: Object.freeze([]) }) : parseApprovalsDocument(text, `${ref}:${APPROVALS_REL}`);
}

/** The approvals as committed at `ref` (the list --base decides with), or [] when that ref has no approvals file. */
function readApprovalsAt(ref, root = ROOT) {
  return readApprovalsDocumentAt(ref, root).approved;
}

/** The working tree's approvals document (validated). Missing = an error (fail closed). */
function readApprovalsDocument(root = ROOT) {
  const file = path.join(root, APPROVALS_REL);
  if (!fs.existsSync(file)) throw new Error(`${APPROVALS_REL} is missing`);
  return parseApprovalsDocument(fs.readFileSync(file, 'utf8'), APPROVALS_REL);
}

/** The working tree's approvals (validated; the tree check reads their targets). Missing = an error (fail closed). */
function readApprovals(root = ROOT) {
  return readApprovalsDocument(root).approved;
}

/** Deterministic JSON (object keys sorted at every level), for deep equality of approvals documents. */
const canonical = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));

/**
 * True when the head approvals document is exactly the base document minus the approvals this PR uses (deep equality,
 * same order, same `_comment`), and it uses at least one: the using PR deletes its own consumed entries and changes
 * nothing else in the file. Any other edit, addition or removal is false.
 */
function isRemovalOfUsedOnly(baseDoc, headDoc, used) {
  if (!used.length) return false;
  const remaining = baseDoc.approved.filter((a) => !used.includes(a));
  return canonical(headDoc.comment) === canonical(baseDoc.comment) && canonical(headDoc.approved) === canonical(remaining);
}

/** `main` (also `origin/main`, `refs/heads/main`, `refs/remotes/origin/main`): the base that must have a baseline. */
const isMainRef = (ref) => ref.replace(/^refs\/(?:heads|remotes)\//, '').replace(/^origin\//, '') === 'main';

/** Paths the checkout (working tree included) changes since its merge-base with `ref`; a rename is a delete plus an add. */
function changedSinceBase(ref, root = ROOT) {
  assertPlainRef(ref);
  let mergeBase;
  try {
    mergeBase = git(['merge-base', ref, 'HEAD'], root).trim();
  } catch (error) {
    throw new Error(`--base: git merge-base ${ref} HEAD failed: ${String(error.stderr ?? '').trim().split('\n')[0] || error.message}`);
  }
  return git(['diff', '--name-only', '--no-renames', '-z', mergeBase, '--'], root).split('\0').filter(Boolean);
}

/** The ratchet baselines changed in the same diff as the approvals file ([] when the approvals file is unchanged). */
function approvalsChangedWithBaselines(changed) {
  if (!changed.includes(APPROVALS_REL)) return [];
  return changed.filter((p) => RATCHET_BASELINE.test(p));
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

const APPROVAL_KEYS = Object.freeze(['approved', 'file', 'from', 'reason', 'rule', 'to']);
const APPROVAL_OPTIONAL_KEYS = Object.freeze(['target']);
const isRepoPath = (p) => typeof p === 'string' && p.length > 0 && !/[\\:\0]/.test(p) && !p.startsWith('/') && p.split('/').every((seg) => seg && seg !== '.' && seg !== '..');

/**
 * Refuses a malformed approval list (fail closed: a typo must never widen what --base accepts). One entry (see
 * tools/import-boundaries.approved.json):
 *   { rule, file, from, to, approved: 'owner YYYY-MM-DD', reason, target? }
 * `file` is a production file the check scans; `target`, when present, is the resolved import target exactly as --list
 * prints it and must be an edge of `rule` from `file`. Each entry is used by exactly one PR; delete it once that PR has
 * merged, preferably in the using PR itself (--base reports it STALE while the head lists it). Never widen `to` in place: a new growth is a new entry in its own PR.
 */
function validateApprovedGrowth(list, label = 'approvals') {
  if (!Array.isArray(list)) throw new Error(`${label}: the approval list must be an array`);
  const seen = new Set();
  for (const e of list) {
    const where = `${label} ${JSON.stringify(e && e.file)}`;
    if (!e || typeof e !== 'object' || Array.isArray(e)) throw new Error(`${label}: every entry must be an object`);
    const keys = Object.keys(e);
    if (APPROVAL_KEYS.some((k) => !keys.includes(k)) || keys.some((k) => !APPROVAL_KEYS.includes(k) && !APPROVAL_OPTIONAL_KEYS.includes(k))) {
      throw new Error(`${where}: keys must be exactly rule, file, from, to, approved, reason (and optionally target)`);
    }
    if (!RULES.includes(e.rule)) throw new Error(`${where}: unknown rule "${e.rule}"`);
    if (!isRepoPath(e.file) || !SCANNED.test(e.file) || !CODE.test(e.file) || isTestFile(e.file)) throw new Error(`${where}: file must be a repo-relative production file the check scans`);
    if (!Number.isInteger(e.from) || e.from < 0) throw new Error(`${where}: from must be a non-negative integer`);
    if (!Number.isInteger(e.to) || e.to <= e.from) throw new Error(`${where}: to must be an integer above from`);
    if (typeof e.approved !== 'string' || !/^owner \d{4}-\d{2}-\d{2}$/.test(e.approved)) throw new Error(`${where}: approved must read "owner YYYY-MM-DD"`);
    if (typeof e.reason !== 'string' || !e.reason.trim()) throw new Error(`${where}: reason is required`);
    if ('target' in e && (!isRepoPath(e.target) || classify(e.file, e.target) !== e.rule)) throw new Error(`${where}: target must be the repo-relative path of a ${e.rule} edge from file (as --list prints it)`);
    const k = `${e.rule}\0${e.file}`;
    if (seen.has(k)) throw new Error(`${where}: duplicate entry for ${e.rule}`);
    seen.add(k);
  }
  return list;
}

/** tools/import-boundaries.approved.json: { "_comment"?: [...], "approved": [entries] } -> { comment, approved }, validated and frozen. */
function parseApprovalsDocument(text, label) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label}: not valid JSON (${error.message})`);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error(`${label}: expected an object with an "approved" array`);
  const extra = Object.keys(doc).filter((k) => k !== '_comment' && k !== 'approved');
  if (extra.length) throw new Error(`${label}: unknown key(s) ${extra.join(', ')}`);
  validateApprovedGrowth(doc.approved, label);
  return Object.freeze({ comment: doc._comment, approved: Object.freeze(doc.approved.map((e) => Object.freeze({ ...e }))) });
}

/** The validated, frozen approval list of an approvals document. */
function parseApprovals(text, label) {
  return parseApprovalsDocument(text, label).approved;
}

const total = (counts) => Object.values(counts).reduce((n, files) => n + Object.values(files).reduce((a, b) => a + b, 0), 0);

function main(argv, { root = ROOT } = {}) {
  const baselineFile = path.join(root, BASELINE_REL);
  const baseIdx = argv.indexOf('--base');
  if (baseIdx !== -1) {
    const ref = argv[baseIdx + 1];
    if (!ref) throw new Error('--base needs a git ref');
    assertPlainRef(ref);
    const head = readBaseline(baselineFile);
    if (!head) throw new Error(`${BASELINE_REL} is missing`);
    // The head copy must be well-formed (fail closed). Growth is decided with the base ref's list only; the head list
    // only decides which stale entries are still to be deleted, and whether its diff is the using PR's own removal.
    const headDoc = readApprovalsDocument(root);
    let together = approvalsChangedWithBaselines(changedSinceBase(ref, root));
    const base = readBaselineAt(ref, root);
    if (!base) {
      for (const p of together) console.log(`CHANGED TOGETHER ${APPROVALS_REL} and ${p}: an approval must merge in its own PR, before the PR that uses it.`);
      if (isMainRef(ref)) {
        // main has had the baseline since #191: its absence there is a broken or wrong checkout, never "nothing to compare".
        console.error(`[import-boundaries] ${ref} has no ${BASELINE_REL}: refusing to pass (main must have one).`);
        return 1;
      }
      console.log(`[import-boundaries] ${ref} has no ${BASELINE_REL} yet: nothing to compare.`);
      return together.length ? 1 : 0;
    }
    const baseDoc = readApprovalsDocumentAt(ref, root);
    const approved = baseDoc.approved;
    const { grown, staleApproved, used } = compareToBase(base, head, approved, headDoc.approved);
    if (together.length && isRemovalOfUsedOnly(baseDoc, headDoc, used)) {
      for (const a of used) console.log(`CONSUMED ${a.rule.padEnd(25)} ${a.file}: this PR uses the approval and deletes it from ${APPROVALS_REL} (its only change to that file).`);
      together = [];
    }
    for (const p of together) console.log(`CHANGED TOGETHER ${APPROVALS_REL} and ${p}: an approval must merge in its own PR, before the PR that uses it (the using PR may only delete the entries it uses).`);
    const wrongTarget = verifyTargets(used, ref, root);
    for (const g of grown) console.log(`GROWN  ${g.rule.padEnd(25)} ${g.file}: ${g.newKey ? 'new entry' : `${g.base} ->`} ${g.head}. The baseline may only shrink against ${ref} (growth needs an owner-dated entry in ${APPROVALS_REL} on ${ref}, merged in its own PR, for exactly this count).`);
    const inForce = approved.filter((a) => ((base[a.rule] ?? {})[a.file] ?? 0) === a.from).length;
    for (const s of staleApproved) console.log(`STALE APPROVAL ${s.rule.padEnd(25)} ${s.file}: approved from ${s.from}, ${ref} has ${s.base}. Delete this entry from ${APPROVALS_REL}.`);
    for (const w of wrongTarget) console.log(`WRONG TARGET ${w.rule.padEnd(25)} ${w.file}: approved ${w.from} -> ${w.to} for ${w.target}, but the file adds ${w.added} edge(s) to it.`);
    console.log(`[import-boundaries] baseline vs ${ref}: ${grown.length} grown entr${grown.length === 1 ? 'y' : 'ies'}, ${staleApproved.length} stale approval(s), ${inForce} approval(s) in force on ${ref}, ${used.length} used, ${wrongTarget.length} wrong target(s).`);
    return grown.length || staleApproved.length || wrongTarget.length || together.length ? 1 : 0;
  }

  const sites = scan(root);
  if (argv.includes('--list')) {
    for (const s of sites) console.log(`${s.rule.padEnd(25)} ${s.file} -> ${s.target}  ('${s.spec}')`);
    console.log(`[import-boundaries] ${sites.length} violating edge(s).`);
    return 0;
  }
  const current = countsOf(sites);
  const baseline = readBaseline(baselineFile);
  if (argv.includes('--write-baseline')) {
    if (baseline) {
      const { grown } = compare(current, baseline);
      if (grown.length) {
        for (const g of grown) console.error(`REFUSED (would grow) ${g.rule} ${g.file}: ${g.baseline} -> ${g.current}`);
        console.error('[import-boundaries] the baseline may only shrink: import through the owning surface instead.');
        return 1;
      }
    }
    fs.writeFileSync(baselineFile, JSON.stringify(baselineDocument(current), null, 2) + '\n');
    console.log(`[import-boundaries] baseline written: ${total(current)} edge(s).`);
    return 0;
  }
  if (!baseline) {
    console.error(`[import-boundaries] ${BASELINE_REL} is missing (create it once with --write-baseline).`);
    return 1;
  }
  const { grown, stale } = compare(current, baseline);
  const missingTarget = checkApprovalTargets(readApprovals(root), sites, current);
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
  for (const m of missingTarget) {
    console.log(`TARGET MISSING ${m.rule.padEnd(25)} ${m.file}: approved ${m.from} -> ${m.to} for ${m.target}, now ${m.current} with no edge to it.`);
    for (const t of byFile.get(`${m.rule}\0${m.file}`) ?? []) console.log(`         -> ${t}`);
  }
  const perRule = RULES.map((r) => `${r}=${Object.values(current[r] ?? {}).reduce((a, b) => a + b, 0)}`).join(' ');
  console.log(`[import-boundaries] ${perRule}; ${grown.length} new, ${stale.length} stale, ${missingTarget.length} approval target(s) missing.`);
  if (grown.length) console.log('A new boundary violation: import through the owning surface (engine/, engine/worker-shared/, shared/) instead.');
  return grown.length || stale.length || missingTarget.length ? 1 : 0;
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
  RULES, WORKER_SURFACE, BASELINE_REL, APPROVALS_REL, readBaselineAt, readApprovalsAt, readApprovals, parseApprovals, gitEnv,
  parseApprovalsDocument, readApprovalsDocument, readApprovalsDocumentAt, isRemovalOfUsedOnly, isMainRef,
  assertPlainRef, changedSinceBase, approvalsChangedWithBaselines, isTestFile, specifiersOf, resolveSpecifier, classify, scanSource,
  scan, countsOf, compare, compareToBase, checkApprovalTargets, verifyTargets, validateApprovedGrowth, parseBaseline,
  baselineDocument, loadTypeScript, main,
};
