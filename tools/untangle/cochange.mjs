#!/usr/bin/env node
// Co-change ("logical coupling") across packages/folders from git history.
// Usage: node cochange.mjs <repo-root> [--out dir] [--max-files 40] [--min 5]   (--out defaults to <os tmpdir>/untangle)
// A pair counts once per non-merge commit that touches both. Commits touching more than --max-files code files are
// skipped (bulk renames/formatting). Only pairs in DIFFERENT folders (unitOf) are reported; file pairs must also differ
// in package or top folder. confidence = co / min(nA, nB); lift-ish jaccard = co / (nA + nB - co).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const ROOT = path.resolve(args[0] || '.');
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const OUT = path.resolve(opt('--out', path.join(os.tmpdir(), 'untangle')));
const MAXF = Number(opt('--max-files', 40));
const MIN = Number(opt('--min', 5));

const log = execFileSync('git', ['-C', ROOT, 'log', '--no-merges', '--name-only', '--pretty=format:@@%h %s'], { encoding: 'utf8', maxBuffer: 1 << 28 });
const skip = (f) => /(^|\/)(yarn\.lock|package-lock\.json|pubspec\.lock)$|\.(png|webp|jpg|svg|ttf|woff2?|mp4|vtt|ico)$|security-posture\.golden|\/docs\/HANDOFF\.md$|^docs\/HANDOFF|HANDOFF\.md$/.test(f);

function unitOf(f) {
  const p = f.split('/');
  if (p[0] !== 'packages') return p.length > 1 ? `${p[0]}/${p[1]}`.replace(/\/[^/]*\.[^/]*$/, '') : p[0];
  const pkg = p[1].replace(/^rab-/, '');
  const r = p.slice(2);
  if (pkg === 'server') {
    if (r[1] === 'engine' && r[2] === 'core-modules') return `server/engine/${r[3]}`;
    if (r[1] === 'engine') return `server/engine/${r[2]}`;
    if (r[1] === 'modules') return `server/modules/${r[2]}`;
    if (r[1] === 'database' && r[2] === 'typeorm') return `server/database/typeorm/${r[3]}`;
    if (r[1] === 'database') return `server/database/${r[2]}`;
    if (r[1] === '__tests__') return `server/__tests__/${r[2]}`;
    return `server/${r.length > 2 ? r[1] : '(root)'}`;
  }
  if (pkg === 'worker') {
    if (r[1] === 'queues' || r[1] === 'core' || r[1] === '__tests__') return `worker/${r[1]}/${r[2]}`;
    return `worker/${r.length > 2 ? r[1] : '(root)'}`;
  }
  if (pkg === 'front') {
    if (r[1] === 'features' || r[1] === 'shared') return r.length > 3 ? `front/${r[1]}/${r[2]}` : `front/${r[1]}`;
    return `front/${r.length > 2 ? r[1] : '(root)'}`;
  }
  if (pkg === 'mobile') {
    if (r[0] === 'lib' && (r[1] === 'features' || r[1] === 'core')) return `mobile/${r[1]}/${r[2]}`;
    return `mobile/${r[0] === 'lib' ? (r.length > 2 ? r[1] : '(root)') : r[0]}`;
  }
  if (pkg === 'iphone') {
    if (r[0] === 'Crewflow' && (r[1] === 'Features' || r[1] === 'Core')) return `iphone/${r[1]}/${r[2]}`;
    return `iphone/${r[0] === 'Crewflow' ? r[1] : r[0]}`;
  }
  if (pkg === 'docker' || pkg === 'e2e-testing' || pkg === 'docs') return r.length > 1 ? `${pkg}/${r[0]}` : pkg;
  return r.length > 2 ? `${pkg}/${r[1]}` : pkg;
}
const topOf = (f) => (f.startsWith('packages/') ? f.split('/')[1] : f.split('/')[0]);

const commits = [];
for (const block of log.split('@@').filter(Boolean)) {
  const [head, ...fl] = block.split('\n');
  const fs_ = [...new Set(fl.filter((x) => x && !skip(x)))];
  if (!fs_.length) continue;
  commits.push({ head, files: fs_ });
}
const nFile = new Map(), nUnit = new Map(), pairF = new Map(), pairU = new Map();
let skipped = 0;
const inc = (m, k, h) => { let v = m.get(k); if (!v) m.set(k, (v = { n: 0, ex: [] })); v.n++; if (h && v.ex.length < 4) v.ex.push(h); };
for (const c of commits) {
  const units = [...new Set(c.files.map(unitOf))];
  for (const f of c.files) nFile.set(f, (nFile.get(f) || 0) + 1);
  for (const u of units) nUnit.set(u, (nUnit.get(u) || 0) + 1);
  if (c.files.length > MAXF) { skipped++; continue; }
  const fsSorted = [...c.files].sort();
  for (let i = 0; i < fsSorted.length; i++)
    for (let j = i + 1; j < fsSorted.length; j++) {
      const a = fsSorted[i], b = fsSorted[j];
      if (unitOf(a) === unitOf(b)) continue;
      inc(pairF, a + '\t' + b, c.head);
    }
  const us = units.sort();
  for (let i = 0; i < us.length; i++) for (let j = i + 1; j < us.length; j++) inc(pairU, us[i] + '\t' + us[j], c.head);
}
function rank(pairs, nMap, filter = () => true) {
  return [...pairs.entries()]
    .filter(([, v]) => v.n >= MIN)
    .map(([k, v]) => {
      const [a, b] = k.split('\t');
      const na = nMap.get(a), nb = nMap.get(b);
      return { a, b, co: v.n, na, nb, conf: v.n / Math.min(na, nb), jac: v.n / (na + nb - v.n), ex: v.ex };
    })
    .filter(filter)
    .sort((x, y) => y.conf * y.co - x.conf * x.co);
}
const isTestF = (f) => /(\.spec\.|\.test\.|_test\.dart|\/__tests__\/|\/test\/|Tests\/|rab-e2e-testing\/)/.test(f);
const filesCross = rank(pairF, nFile, (p) => topOf(p.a) !== topOf(p.b) && p.conf >= 0.5);
const filesCrossProd = filesCross.filter((p) => !isTestF(p.a) && !isTestF(p.b));
const isDoc = (f) => /\.(md|mdx|txt)$/.test(f) || f.startsWith('.github/') || f.startsWith('docs/');
const filesCrossCode = rank(pairF, nFile, (p) => topOf(p.a) !== topOf(p.b) && !isDoc(p.a) && !isDoc(p.b) && p.conf >= 0.4);
const filesCrossFolder = rank(pairF, nFile, (p) => topOf(p.a) === topOf(p.b) && !isTestF(p.a) && !isTestF(p.b) && p.conf >= 0.6);
const unitsCrossPkg = rank(pairU, nUnit, (p) => p.a.split('/')[0] !== p.b.split('/')[0] && p.conf >= 0.3);
const unitsSamePkg = rank(pairU, nUnit, (p) => p.a.split('/')[0] === p.b.split('/')[0] && p.conf >= 0.5);

const L = [];
const row = (p) => `${p.co}\t${p.na}/${p.nb}\tconf=${p.conf.toFixed(2)}\tjac=${p.jac.toFixed(2)}\t${p.a}  <->  ${p.b}\t| ${p.ex.slice(0, 2).join(' | ')}`;
L.push(`# co-change  commits=${commits.length} skipped(>${MAXF} files)=${skipped} min=${MIN}`);
L.push('', '## File pairs across packages, production files only (conf>=0.5)'); filesCrossProd.slice(0, 80).forEach((p) => L.push(row(p)));
L.push('', '## File pairs across packages, code only (no docs/CI), incl. tests (conf>=0.4)'); filesCrossCode.slice(0, 120).forEach((p) => L.push(row(p)));
L.push('', '## File pairs across packages incl. tests (conf>=0.5)'); filesCross.slice(0, 60).forEach((p) => L.push(row(p)));
L.push('', '## File pairs across folders in the same package, prod (conf>=0.6)'); filesCrossFolder.slice(0, 80).forEach((p) => L.push(row(p)));
L.push('', '## Folder pairs across packages (conf>=0.3)'); unitsCrossPkg.slice(0, 80).forEach((p) => L.push(row(p)));
L.push('', '## Folder pairs within a package (conf>=0.5)'); unitsSamePkg.slice(0, 80).forEach((p) => L.push(row(p)));
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'cochange-report.txt'), L.join('\n') + '\n');
console.log('wrote', path.join(OUT, 'cochange-report.txt'));
