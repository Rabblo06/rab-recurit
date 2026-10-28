#!/usr/bin/env node
/**
 * Third-party licence gate (ci-security "constraints-and-licenses").
 *
 * Why not `license-checker --production` from the root: the root package is the private workspace root with no runtime
 * dependencies of its own, so that command checked nothing but the root package itself (and failed on its UNLICENSED
 * marker); from a workspace directory it cannot follow Yarn's hoisted node_modules and finds nothing. This script walks
 * the REAL production dependency closure of every shipped first-party workspace (dependencies + installed
 * optionalDependencies + peerDependencies, recursively, resolved with Node's node_modules lookup) and checks the
 * licence of every THIRD-PARTY package found against the allowlist. First-party packages (private workspace packages)
 * are not third-party and carry no open-source licence; they are listed, not licence-checked.
 *
 *   node tools/check-licences.mjs            # exit 1 on any third-party package outside the allowlist or without a licence
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
// The CI allowlist as it was, plus two permissive OSI-approved licences found once third-party packages were actually
// checked (owner-vetoable, PR #19): MIT-0 (MIT without the attribution clause: nodemailer, postal-mime) and BlueOak-1.0.0
// (a permissive model licence: lru-cache, minipass, glob's helpers).
const ALLOW = ['MIT', 'ISC', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'CC0-1.0', 'Unlicense', 'Python-2.0', 'MIT-0', 'BlueOak-1.0.0'];
/** First-party workspaces whose production dependencies ship (server/worker images, the web bundle, shared libraries). */
const SHIPPED = ['rab-server', 'rab-worker', 'rab-front', 'rab-shared', 'rab-ui', 'rab-emails', 'rab-utils'];

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

/** Node's lookup: <dir>/node_modules/<name>, then each parent directory. */
function findPackageDir(fromDir, name) {
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, 'node_modules', name, 'package.json');
    if (existsSync(candidate)) return realpathSync(dirname(candidate));
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** SPDX-ish: "A OR B" passes if any alternative passes; "A AND B" needs all; parentheses and "WITH" exceptions tolerated. */
function licenceAllowed(expr) {
  const e = expr.replace(/[()]/g, ' ').replace(/\s+WITH\s+\S+/gi, '').trim();
  if (/\sOR\s/i.test(e)) return e.split(/\s+OR\s+/i).some((x) => licenceAllowed(x));
  if (/\sAND\s/i.test(e)) return e.split(/\s+AND\s+/i).every((x) => licenceAllowed(x));
  return ALLOW.includes(e.trim());
}

function licenceOf(pkg) {
  if (typeof pkg.license === 'string') return pkg.license;
  if (pkg.license && typeof pkg.license.type === 'string') return pkg.license.type;
  if (Array.isArray(pkg.licenses) && pkg.licenses.length) {
    return pkg.licenses.map((l) => (typeof l === 'string' ? l : l.type)).filter(Boolean).join(' OR ');
  }
  return null;
}

const seen = new Map(); // realpath -> { name, version, licence, firstParty, via }
const missing = [];
function visit(dir, via) {
  const pkg = readJson(join(dir, 'package.json'));
  const key = dir;
  if (seen.has(key)) return;
  const firstParty = pkg.private === true && (pkg.name?.startsWith('@rab/') || dir.startsWith(join(ROOT, 'packages')));
  seen.set(key, { name: pkg.name, version: pkg.version, licence: licenceOf(pkg), firstParty, via });
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.optionalDependencies ?? {}), ...(pkg.peerDependencies ?? {}) };
  for (const name of Object.keys(deps)) {
    const child = findPackageDir(dir, name);
    if (!child) {
      // An optional or peer dependency that is not installed does not ship; a missing regular dependency is reported.
      if (pkg.dependencies?.[name] && !pkg.optionalDependencies?.[name]) missing.push(`${name} (required by ${pkg.name})`);
      continue;
    }
    visit(child, pkg.name);
  }
}

for (const ws of SHIPPED) {
  const dir = join(ROOT, 'packages', ws);
  if (existsSync(join(dir, 'package.json'))) visit(realpathSync(dir), '(workspace)');
}

const thirdParty = [...seen.values()].filter((p) => !p.firstParty);
const firstParty = [...seen.values()].filter((p) => p.firstParty);
const violations = thirdParty.filter((p) => !p.licence || !licenceAllowed(p.licence));
const counts = new Map();
for (const p of thirdParty) counts.set(p.licence ?? '(none)', (counts.get(p.licence ?? '(none)') ?? 0) + 1);

console.log(`first-party workspaces (not licence-checked): ${firstParty.map((p) => p.name).sort().join(', ')}`);
console.log(`third-party production packages checked: ${thirdParty.length}`);
for (const [l, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${l}`);
if (missing.length) {
  console.error(`declared production dependencies not installed (${missing.length}):\n  ${missing.join('\n  ')}`);
}
if (violations.length) {
  console.error(`\n${violations.length} third-party package(s) outside the allowlist (${ALLOW.join(', ')}):`);
  for (const v of violations.sort((a, b) => a.name.localeCompare(b.name))) {
    console.error(`  ${v.name}@${v.version}: ${v.licence ?? '(no licence field)'}   (via ${v.via})`);
  }
  process.exit(1);
}
if (missing.length) process.exit(1);
console.log('licence check passed');
