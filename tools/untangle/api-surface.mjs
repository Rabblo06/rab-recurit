#!/usr/bin/env node
// Which server REST routes are called by which clients (front, mobile, iphone, e2e), each with its own hand-written
// path string and response type. Usage: node api-surface.mjs <repo-root> [--out dir]   (--out defaults to <os tmpdir>/untangle)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const args = process.argv.slice(2);
const ROOT = path.resolve(args[0] || '.');
const OUT = path.resolve(args.includes('--out') ? args[args.indexOf('--out') + 1] : path.join(os.tmpdir(), 'untangle'));
const files = execFileSync('git', ['-C', ROOT, 'ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const test = (f) => /(\.spec\.|\.test\.|_test\.dart|\/__tests__\/|\/test\/|Tests\/)/.test(f);

// --- server routes
const routes = [];
for (const f of files.filter((f) => /rab-server\/src\/.*\.controller\.ts$/.test(f) && !test(f))) {
  const s = read(f);
  const ctrlRe = /@Controller\(\s*(?:'([^']*)'|\{[^}]*path:\s*'([^']*)'[^}]*\})?\s*\)\s*(?:@[^\n]*\n\s*)*export class (\w+)/g;
  let m; const ctrls = [];
  while ((m = ctrlRe.exec(s))) ctrls.push({ at: m.index, prefix: m[1] ?? m[2] ?? '', name: m[3] });
  const mRe = /@(Get|Post|Put|Patch|Delete|Sse|All)\(\s*(?:'([^']*)')?\s*\)/g;
  while ((m = mRe.exec(s))) {
    const c = [...ctrls].reverse().find((c) => c.at < m.index) || ctrls[0] || { prefix: '' };
    const p = ('/' + [c.prefix, m[2] || ''].filter(Boolean).join('/')).replace(/\/+/g, '/').replace(/\/$/, '');
    routes.push({ method: m[1].toUpperCase(), path: p, file: f });
  }
}
const norm = (p) => p.replace(/^\/rest\/v1/, '').replace(/:[A-Za-z_]+/g, ':x').replace(/\/$/, '') || '/';
const routeKeys = new Map();
for (const r of routes) routeKeys.set(norm(r.path), r);
// regex for each route: :x matches one segment (or an interpolation)
const routeRes = [...routeKeys.keys()].map((k) => ({ k, re: new RegExp('^' + k.split('/').map((seg) => (seg === ':x' ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/') + '$') }));

// --- client path literals
const CLIENTS = {
  front: (f) => f.startsWith('packages/rab-front/src/') && /\.tsx?$/.test(f),
  mobile: (f) => f.startsWith('packages/rab-mobile/lib/') && f.endsWith('.dart'),
  iphone: (f) => f.startsWith('packages/rab-iphone/Crewflow/') && f.endsWith('.swift'),
  e2e: (f) => f.startsWith('packages/rab-e2e-testing/') && /\.(ts|mjs|cjs)$/.test(f),
  worker: (f) => f.startsWith('packages/rab-worker/src/') && f.endsWith('.ts'),
};
const used = new Map(); // routeKey -> {client -> Set(file)}
const unmatched = {};
for (const [client, pred] of Object.entries(CLIENTS)) {
  unmatched[client] = new Set();
  for (const f of files.filter((f) => pred(f) && !test(f))) {
    const s = read(f);
    for (const m of s.matchAll(/["'`]((?:\/rest\/v1)?\/[a-z][A-Za-z0-9_\-./${}():\\]*)["'`?]/g)) {
      let p = m[1]
        .replace(/\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_.]*|\\\([^)]*\)/g, 'X')
        .replace(/\?.*$/, '')
        .replace(/^\/rest\/v1/, '')
        .replace(/\/$/, '');
      if (!p || p.includes('.') || p.startsWith('/assets')) continue;
      const hit = routeRes.find((r) => r.re.test(p));
      if (hit) {
        if (!used.has(hit.k)) used.set(hit.k, {});
        (used.get(hit.k)[client] ||= new Set()).add(f);
      } else if (p.split('/').length > 2) unmatched[client].add(p);
    }
  }
}
const L = [];
L.push(`server routes: ${routes.length} (${routeKeys.size} distinct)`);
const multi = [...used.entries()].filter(([, v]) => ['front', 'mobile', 'iphone'].filter((c) => v[c]).length >= 2);
const byClient = (c) => [...used.values()].filter((v) => v[c]).length;
L.push(`routes referenced: front=${byClient('front')} mobile=${byClient('mobile')} iphone=${byClient('iphone')} e2e=${byClient('e2e')}`);
L.push(`routes referenced by 2+ of front/mobile/iphone: ${multi.length}; by all three: ${multi.filter(([, v]) => v.front && v.mobile && v.iphone).length}`);
L.push('');
for (const [k, v] of multi.sort()) L.push(`${k}\t${['front', 'mobile', 'iphone', 'e2e'].filter((c) => v[c]).map((c) => `${c}(${v[c].size})`).join(' ')}`);
L.push('', '## client path literals with no matching server route (possible drift or non-REST)');
for (const [c, set] of Object.entries(unmatched)) if (c !== 'worker' && c !== 'e2e') L.push(`${c}: ${[...set].sort().slice(0, 40).join('  ')}`);
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'api-surface.txt'), L.join('\n') + '\n');
console.log(L.slice(0, 4).join('\n'));
console.log('wrote', path.join(OUT, 'api-surface.txt'));
