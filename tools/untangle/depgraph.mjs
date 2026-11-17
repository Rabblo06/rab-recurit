#!/usr/bin/env node
// Crewflow cross-package dependency graph.
// Usage: node depgraph.mjs <repo-root> [--out <dir>] [--since "6 months ago"]   (--out defaults to <os tmpdir>/untangle)
// Parses TS/TSX/JS imports (regex), Dart imports, and Swift type references (best effort: one module,
// so an edge = a file mentions a type declared in another folder). Writes graph.json + report.txt to --out.
// Read-only on the repo: it only runs `git ls-files` and `git log`.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const ROOT = path.resolve(args[0] || '.');
const OUT = path.resolve(args.includes('--out') ? args[args.indexOf('--out') + 1] : path.join(os.tmpdir(), 'untangle'));
const SINCE = args.includes('--since') ? args[args.indexOf('--since') + 1] : '6 months ago';

const git = (a) => execFileSync('git', ['-C', ROOT, ...a], { encoding: 'utf8', maxBuffer: 1 << 28 });
const files = git(['ls-files']).split('\n').filter(Boolean);
const fileSet = new Set(files);
const CODE = /\.(ts|tsx|js|mjs|cjs|dart|swift)$/;
const codeFiles = files.filter((f) => CODE.test(f) && !f.includes('/node_modules/') && !/\.d\.ts$/.test(f));

const isTest = (f) =>
  /(\.spec\.|\.test\.|_test\.dart$|\/__tests__\/|\/test\/|Tests\/|UITests\/|jest-|setup-tests|\/e2e|rab-e2e-testing\/|test-helpers|\/fixtures\/|\.stories\.)/.test(f);

// ---------- folder ("unit") naming ----------
function unitOf(f) {
  const p = f.split('/');
  if (p[0] === 'tools') return 'tools';
  if (p[0] !== 'packages') return 'root';
  const pkg = p[1].replace(/^rab-/, '');
  const rest = p.slice(2);
  const take = (n) => `${pkg}/${rest.slice(0, n).join('/')}`;
  if (pkg === 'server') {
    // src/engine/core-modules/<x>, src/modules/<x>, src/database/<x>, src/engine/<x>, src/command, src/__tests__
    if (rest[1] === 'engine' && rest[2] === 'core-modules') return `server/engine/${rest[3]}`;
    if (rest[1] === 'engine') return `server/engine/${rest[2]}`;
    if (rest[1] === 'modules') return `server/modules/${rest[2]}`;
    if (rest[1] === 'database') return rest.length > 3 ? `server/database/${rest[2]}` : 'server/database';
    if (rest.length <= 2) return 'server/(root)';
    return `server/${rest[1]}`;
  }
  if (pkg === 'worker') {
    if (rest[1] === 'queues' || rest[1] === 'core') return rest.length > 3 ? `worker/${rest[1]}/${rest[2]}` : `worker/${rest[1]}`;
    if (rest.length <= 2) return 'worker/(root)';
    return `worker/${rest[1]}`;
  }
  if (pkg === 'front') {
    if (rest[1] === 'features' || rest[1] === 'shared') return rest.length > 3 ? `front/${rest[1]}/${rest[2]}` : `front/${rest[1]}`;
    if (rest.length <= 2) return 'front/(root)';
    return `front/${rest[1]}`;
  }
  if (pkg === 'mobile') {
    if (rest[0] === 'lib' && (rest[1] === 'features' || rest[1] === 'core')) return `mobile/${rest[1]}/${rest[2]}`;
    if (rest[0] === 'lib') return rest.length <= 2 ? 'mobile/(root)' : `mobile/${rest[1]}`;
    return `mobile/${rest[0]}`;
  }
  if (pkg === 'iphone') {
    if (rest[0] === 'Crewflow' && (rest[1] === 'Features' || rest[1] === 'Core')) return `iphone/${rest[1]}/${rest[2]}`;
    if (rest[0] === 'Crewflow') return `iphone/${rest[1]}`;
    return `iphone/${rest[0]}`;
  }
  if (pkg === 'shared' || pkg === 'ui' || pkg === 'emails' || pkg === 'utils') return rest.length > 2 ? `${pkg}/${rest[1]}` : `${pkg}`;
  return rest.length > 1 ? `${pkg}/${rest[0]}` : pkg;
}
const pkgOf = (f) => (f.startsWith('packages/') ? f.split('/')[1].replace(/^rab-/, '') : f.split('/')[0]);

// ---------- resolution ----------
const EXTS = ['', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.d.ts', '/index.ts', '/index.tsx', '/index.js'];
function tryResolve(base) {
  base = path.posix.normalize(base);
  for (const e of EXTS) if (fileSet.has(base + e)) return base + e;
  // NodeNext ".js" specifiers pointing at .ts sources
  const m = base.match(/^(.*)\.(js|mjs|cjs)$/);
  if (m) for (const e of ['.ts', '.tsx', '.mts', '.cts']) if (fileSet.has(m[1] + e)) return m[1] + e;
  return null;
}
const PKG_ALIAS = {
  '@rab/shared': 'packages/rab-shared/src',
  '@rab/ui': 'packages/rab-ui/src',
  '@rab/emails': 'packages/rab-emails/src',
  '@rab/utils': 'packages/rab-utils/src',
  '@rab/server': 'packages/rab-server/src',
  '@rab/worker': 'packages/rab-worker/src',
};
function resolveTs(from, spec) {
  if (spec.startsWith('.')) return tryResolve(path.posix.join(path.posix.dirname(from), spec));
  for (const [alias, dir] of Object.entries(PKG_ALIAS)) {
    if (spec === alias) return tryResolve(dir + '/index') || dir + '/index.ts';
    if (spec.startsWith(alias + '/')) {
      let sub = spec.slice(alias.length + 1).replace(/^(src|dist|dist-cjs|dist-esm)\//, '');
      return tryResolve(`${dir}/${sub}`) || `${dir}/${sub}`;
    }
  }
  return null; // external
}
function resolveDart(from, spec) {
  if (spec.startsWith('dart:')) return null;
  if (spec.startsWith('package:rab_staff/')) return tryResolve('packages/rab-mobile/lib/' + spec.slice('package:rab_staff/'.length));
  if (spec.startsWith('package:')) return null;
  return tryResolve(path.posix.join(path.posix.dirname(from), spec));
}

// ---------- parse ----------
const TS_RE = /(?:^|[\s;])(?:import|export)\s+(?:type\s+)?(?:[^'"`;]*?\sfrom\s*)?['"]([^'"\n]+)['"]|(?:require|import)\(\s*['"]([^'"\n]+)['"]\s*\)|jest\.(?:mock|requireActual)\(\s*['"]([^'"\n]+)['"]/g;
const DART_RE = /^\s*(?:import|export|part)\s+['"]([^'"]+)['"]/gm;
const read = (f) => {
  try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { return ''; }
};

const edges = []; // {from,to,kind}
const unresolved = [];
// Swift: index declared types per file
const swiftFiles = codeFiles.filter((f) => f.endsWith('.swift'));
const swiftDecl = new Map(); // TypeName -> file
const swiftSrc = new Map();
for (const f of swiftFiles) {
  const s = read(f).replace(/\/\/.*$/gm, '');
  swiftSrc.set(f, s);
  for (const m of s.matchAll(/\b(?:struct|class|enum|protocol|actor|typealias)\s+([A-Z][A-Za-z0-9_]+)/g)) if (!swiftDecl.has(m[1])) swiftDecl.set(m[1], f);
}
for (const f of codeFiles) {
  if (f.endsWith('.swift')) {
    const s = swiftSrc.get(f);
    const seen = new Set();
    for (const m of s.matchAll(/\b([A-Z][A-Za-z0-9_]+)\b/g)) {
      const t = swiftDecl.get(m[1]);
      if (t && t !== f && !seen.has(t)) { seen.add(t); edges.push({ from: f, to: t, kind: 'swift-type' }); }
    }
    continue;
  }
  const src = read(f);
  if (f.endsWith('.dart')) {
    for (const m of src.matchAll(DART_RE)) {
      const r = resolveDart(f, m[1]);
      if (r) edges.push({ from: f, to: r, kind: 'dart' });
      else if (!m[1].startsWith('package:') && !m[1].startsWith('dart:')) unresolved.push(`${f} -> ${m[1]}`);
    }
    continue;
  }
  const noComments = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  for (const m of noComments.matchAll(TS_RE)) {
    const spec = m[1] || m[2] || m[3];
    const r = resolveTs(f, spec);
    if (r) edges.push({ from: f, to: r, kind: m[3] ? 'jest-mock' : 'ts' });
    else if (spec.startsWith('.')) unresolved.push(`${f} -> ${spec}`);
  }
}

// ---------- volatility ----------
function churn(since) {
  const out = git(['log', '--no-merges', `--since=${since}`, '--name-only', '--pretty=format:@@']);
  const perFile = new Map();
  for (const block of out.split('@@')) {
    const fs_ = block.split('\n').filter(Boolean);
    for (const x of fs_) perFile.set(x, (perFile.get(x) || 0) + 1);
  }
  return perFile;
}
const churnRecent = churn(SINCE);
const churnAll = churn('20 years ago');
// unit churn = number of commits touching any prod file in the unit (not the sum of file counts)
function unitCommits(since) {
  const out = git(['log', '--no-merges', `--since=${since}`, '--name-only', '--pretty=format:@@']);
  const m = new Map();
  for (const block of out.split('@@')) {
    const units = new Set(block.split('\n').filter((x) => x && CODE.test(x) && !isTest(x)).map(unitOf));
    for (const u of units) m.set(u, (m.get(u) || 0) + 1);
  }
  return m;
}
const uChurn = unitCommits(SINCE);
const uChurnAll = unitCommits('20 years ago');

// ---------- aggregate ----------
const prodEdges = edges.filter((e) => !isTest(e.from) && !isTest(e.to) && e.from !== e.to);
const testEdges = edges.filter((e) => isTest(e.from) && e.from !== e.to);
function aggregate(list, keyFn) {
  const m = new Map();
  for (const e of list) {
    const a = keyFn(e.from), b = keyFn(e.to);
    if (a === b) continue;
    const k = a + '\u0000' + b;
    if (!m.has(k)) m.set(k, { from: a, to: b, count: 0, samples: [] });
    const v = m.get(k);
    v.count++;
    if (v.samples.length < 3) v.samples.push(`${e.from} -> ${e.to}`);
  }
  return [...m.values()].sort((x, y) => y.count - x.count);
}
const pkgProd = aggregate(prodEdges, pkgOf);
const pkgTest = aggregate(testEdges, pkgOf);
const unitProd = aggregate(prodEdges, unitOf);

// ---------- Tarjan SCC ----------
function scc(nodes, adj) {
  let idx = 0; const st = []; const on = new Set(); const ix = new Map(); const low = new Map(); const res = [];
  const strong = (v) => {
    ix.set(v, idx); low.set(v, idx); idx++; st.push(v); on.add(v);
    for (const w of adj.get(v) || []) {
      if (!ix.has(w)) { strong(w); low.set(v, Math.min(low.get(v), low.get(w))); }
      else if (on.has(w)) low.set(v, Math.min(low.get(v), ix.get(w)));
    }
    if (low.get(v) === ix.get(v)) { const c = []; let w; do { w = st.pop(); on.delete(w); c.push(w); } while (w !== v); if (c.length > 1) res.push(c); }
  };
  for (const n of nodes) if (!ix.has(n)) strong(n);
  return res;
}
function adjOf(list) {
  const adj = new Map(); const nodes = new Set();
  for (const e of list) { nodes.add(e.from); nodes.add(e.to); if (!adj.has(e.from)) adj.set(e.from, new Set()); adj.get(e.from).add(e.to); }
  return { adj, nodes: [...nodes] };
}
const unitAdj = adjOf(unitProd);
const unitCycles = scc(unitAdj.nodes, unitAdj.adj).sort((a, b) => b.length - a.length);
const fileAdj = adjOf(prodEdges.map((e) => ({ from: e.from, to: e.to })));
const fileCycles = scc(fileAdj.nodes, fileAdj.adj).sort((a, b) => b.length - a.length);
const pkgCycles = scc(adjOf(pkgProd).nodes, adjOf(pkgProd).adj);
// shortest unit 2-cycles (direct mutual imports) are the easiest to read
const unitEdgeMap = new Map(unitProd.map((e) => [e.from + '\u0000' + e.to, e]));
const mutual = [];
for (const e of unitProd) {
  const back = unitEdgeMap.get(e.to + '\u0000' + e.from);
  if (back && e.from < e.to) mutual.push({ a: e.from, b: e.to, ab: e.count, ba: back.count, sampleAB: e.samples[0], sampleBA: back.samples[0] });
}
mutual.sort((x, y) => Math.min(y.ab, y.ba) - Math.min(x.ab, x.ba));

// ---------- rule checks ----------
const engineToModules = edges.filter((e) => e.from.includes('rab-server/src/engine/') && e.to.includes('rab-server/src/modules/'));
const front = (f) => f.match(/^packages\/rab-front\/src\/features\/([^/]+)\//)?.[1];
const mob = (f) => f.match(/^packages\/rab-mobile\/lib\/features\/([^/]+)\//)?.[1];
const featureCross = (fn, list) => aggregate(list.filter((e) => fn(e.from) && fn(e.to) && fn(e.from) !== fn(e.to)), (f) => fn(f));
const frontFeat = featureCross(front, prodEdges);
const frontFeatTest = featureCross(front, testEdges);
const mobFeat = featureCross(mob, prodEdges);
const frontShellImports = prodEdges.filter((e) => /rab-front\/src\/(features|shared)\//.test(e.from) && e.to.includes('rab-front/src/shell/'));
const frontSharedToFeature = prodEdges.filter((e) => e.from.includes('rab-front/src/shared/') && e.to.includes('rab-front/src/features/'));
const mobCoreToFeature = prodEdges.filter((e) => e.from.includes('rab-mobile/lib/core/') && e.to.includes('rab-mobile/lib/features/'));
// front/shared used by <3 features
const sharedUse = new Map();
for (const e of prodEdges) {
  const fe = front(e.from);
  if (fe && e.to.includes('rab-front/src/shared/')) { if (!sharedUse.has(e.to)) sharedUse.set(e.to, new Set()); sharedUse.get(e.to).add(fe); }
}
const sharedFiles = files.filter((f) => f.startsWith('packages/rab-front/src/shared/') && /\.tsx?$/.test(f) && !isTest(f));
const sharedUnderused = sharedFiles.map((f) => ({ f, n: (sharedUse.get(f) || new Set()).size, users: [...(sharedUse.get(f) || [])] })).filter((x) => x.n < 3);

// worker -> server deep imports
const workerToServer = aggregate(prodEdges.filter((e) => pkgOf(e.from) === 'worker' && pkgOf(e.to) === 'server'), (f) => unitOf(f));
const serverToWorker = edges.filter((e) => pkgOf(e.from) === 'server' && pkgOf(e.to) === 'worker');

// ---------- stable -> volatile ----------
// volatility = commits touching the unit's prod files in the window. Flag edges where the imported unit is at least
// 2x as volatile as the importer and has >= 10 commits in the window. Martin instability (Ce/(Ca+Ce)) reported too.
const ca = new Map(), ce = new Map();
for (const e of unitProd) { ce.set(e.from, (ce.get(e.from) || 0) + 1); ca.set(e.to, (ca.get(e.to) || 0) + 1); }
const instab = (u) => { const a = ca.get(u) || 0, c = ce.get(u) || 0; return a + c ? c / (a + c) : 0; };
const stableToVolatile = unitProd
  .map((e) => ({ ...e, vFrom: uChurn.get(e.from) || 0, vTo: uChurn.get(e.to) || 0, iFrom: instab(e.from), iTo: instab(e.to) }))
  .filter((e) => e.vTo >= 10 && e.vTo >= 2 * Math.max(1, e.vFrom))
  .sort((a, b) => b.vTo / Math.max(1, b.vFrom) - a.vTo / Math.max(1, a.vFrom));
const martinViolations = unitProd
  .map((e) => ({ ...e, iFrom: instab(e.from), iTo: instab(e.to) }))
  .filter((e) => e.iTo - e.iFrom > 0.4 && (ca.get(e.from) || 0) >= 5)
  .sort((a, b) => b.iTo - b.iFrom - (a.iTo - a.iFrom));

// ---------- write ----------
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'graph.json'), JSON.stringify({ root: ROOT, since: SINCE, pkgProd, pkgTest, unitProd, unitCycles, mutual, fileCycles, engineToModules, frontFeat, frontFeatTest, mobFeat, stableToVolatile, workerToServer, sharedUnderused, uChurn: Object.fromEntries(uChurn), uChurnAll: Object.fromEntries(uChurnAll) }, null, 1));
const L = [];
const h = (t) => L.push('', '## ' + t);
L.push(`# depgraph report  root=${ROOT}  head=${git(['rev-parse', '--short', 'HEAD']).trim()}  volatility window=${SINCE}`);
L.push(`code files=${codeFiles.length} edges=${edges.length} prod=${prodEdges.length} test=${testEdges.length} unresolved-relative=${unresolved.length}`);
h('Package graph (production)');
for (const e of pkgProd) L.push(`${e.from} -> ${e.to}  ${e.count}`);
h('Package graph (tests only)');
for (const e of pkgTest) L.push(`${e.from} -> ${e.to}  ${e.count}`);
h('Package cycles (production)');
L.push(pkgCycles.length ? pkgCycles.map((c) => c.join(' <-> ')).join('\n') : 'none');
h(`Folder cycles (production SCCs): ${unitCycles.length}`);
for (const c of unitCycles) L.push(`[${c.length}] ${c.sort().join(', ')}`);
h(`Direct mutual folder imports (A->B and B->A): ${mutual.length}`);
for (const m of mutual) L.push(`${m.a} <-> ${m.b}  (${m.ab}/${m.ba})  e.g. ${m.sampleAB} | ${m.sampleBA}`);
h(`File-level cycles (production SCCs): ${fileCycles.length}`);
for (const c of fileCycles.slice(0, 40)) L.push(`[${c.length}] ${c.slice(0, 8).join(', ')}${c.length > 8 ? ' ...' : ''}`);
h(`engine/ -> modules/ imports: ${engineToModules.length}`);
for (const e of engineToModules) L.push(`${isTest(e.from) ? '[test] ' : ''}${e.from} -> ${e.to}`);
h(`server -> worker imports: ${serverToWorker.length}`);
for (const e of serverToWorker) L.push(`${e.from} -> ${e.to}`);
h('worker -> server folders (production)');
for (const e of workerToServer) L.push(`${e.from} -> ${e.to}  ${e.count}`);
h(`rab-front feature -> feature (production): ${frontFeat.length} pairs`);
for (const e of frontFeat) L.push(`${e.from} -> ${e.to}  ${e.count}  e.g. ${e.samples.join(' ; ')}`);
h(`rab-front feature -> feature (tests): ${frontFeatTest.length} pairs`);
for (const e of frontFeatTest) L.push(`${e.from} -> ${e.to}  ${e.count}  e.g. ${e.samples[0]}`);
h(`rab-front features/shared -> shell: ${frontShellImports.length}`);
for (const e of frontShellImports) L.push(`${e.from} -> ${e.to}`);
h(`rab-front shared -> features: ${frontSharedToFeature.length}`);
for (const e of frontSharedToFeature) L.push(`${e.from} -> ${e.to}`);
h(`rab-front shared files used by <3 features: ${sharedUnderused.length}`);
for (const x of sharedUnderused) L.push(`${x.n} ${x.f} ${x.users.join(',')}`);
h(`rab-mobile feature -> feature (production): ${mobFeat.length} pairs`);
for (const e of mobFeat) L.push(`${e.from} -> ${e.to}  ${e.count}  e.g. ${e.samples.join(' ; ')}`);
h(`rab-mobile core -> features: ${mobCoreToFeature.length}`);
for (const e of mobCoreToFeature) L.push(`${e.from} -> ${e.to}`);
h(`Stable -> volatile folder edges (imported folder >=2x the commits of the importer in ${SINCE}, >=10)`);
for (const e of stableToVolatile.slice(0, 80)) L.push(`${e.from} (${e.vFrom}) -> ${e.to} (${e.vTo})  edges=${e.count}  I=${e.iFrom.toFixed(2)}->${e.iTo.toFixed(2)}  e.g. ${e.samples[0]}`);
h('Martin instability violations (importer has >=5 dependents, imported is >0.4 less stable)');
for (const e of martinViolations.slice(0, 40)) L.push(`${e.from} I=${e.iFrom.toFixed(2)} -> ${e.to} I=${e.iTo.toFixed(2)}  ${e.count}`);
h('Folder churn (commits touching prod files; window / all time)');
for (const [u, n] of [...uChurnAll.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60)) L.push(`${u}  ${uChurn.get(u) || 0} / ${n}  Ca=${ca.get(u) || 0} Ce=${ce.get(u) || 0}`);
h('Unresolved relative imports (first 30)');
L.push(...unresolved.slice(0, 30));
fs.writeFileSync(path.join(OUT, 'report.txt'), L.join('\n') + '\n');
console.log(`wrote ${path.join(OUT, 'report.txt')} and graph.json`);
