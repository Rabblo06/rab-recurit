#!/usr/bin/env node
'use strict';
/**
 * PDF renderer migration P5: fail CI if the Worker (or the server code it imports) depends on a browser again.
 *
 * Scope is deliberately NARROW: only @rab/worker and @rab/server, the code the Worker image runs. The web e2e suite
 * (packages/rab-e2e-testing, `@playwright/test`), the marketing site (packages/rab-website) and the docs tooling
 * (packages/rab-docs) legitimately drive a browser on CI runners and are not checked here. The runtime images are guarded
 * separately (the one image's rab/Dockerfile `--forbid`, security-floors `apk-absent:chromium`, image_gate.py
 * `forbidden_apk` / `forbidden_npm` / `sbom_must_not_include`).
 *
 * Fails (exit 1) when
 *   - packages/rab-worker/package.json or packages/rab-server/package.json declares a browser package in any dependency
 *     section (dependencies, devDependencies, optionalDependencies, peerDependencies);
 *   - any .ts/.tsx/.js/.cjs/.mjs file under packages/rab-worker/src or packages/rab-server/src, tests INCLUDED, imports or
 *     requires one. Tests are included on purpose: playwright stays installed in the monorepo through
 *     @rab/e2e-testing's @playwright/test, so a Worker test that imports it would still resolve locally and quietly need
 *     a Chromium the Worker CI no longer installs.
 *
 *   node tools/check-no-browser-in-worker.cjs [repo root]
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const PACKAGES = ['packages/rab-worker', 'packages/rab-server'];
const BROWSER = /^(playwright|playwright-core|@playwright\/.+|chromium-bidi|puppeteer|puppeteer-core|@sparticuz\/chromium|chrome-launcher)$/;
const SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const SPEC = /\b(?:require|import)\s*\(\s*(['"])([^'"\n]+)\1\s*\)|\b(?:import|export)\s[^'"\n;]*?\bfrom\s*(['"])([^'"\n]+)\3|^\s*import\s*(['"])([^'"\n]+)\5/gm;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-esm', 'dist-cjs', 'coverage', '.nx']);

const problems = [];

/** Package name of a module specifier ('playwright/lib/x' -> 'playwright', '@a/b/c' -> '@a/b'). */
function packageOf(spec) {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function* sourceFiles(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* sourceFiles(p);
    else if (/\.(c|m)?[jt]sx?$/.test(e.name) && !e.name.endsWith('.d.ts')) yield p;
  }
}

let files = 0;
for (const pkg of PACKAGES) {
  const manifest = path.join(ROOT, pkg, 'package.json');
  if (!fs.existsSync(manifest)) {
    problems.push(`${pkg}/package.json is missing (the guard cannot run)`);
    continue;
  }
  const json = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  for (const section of SECTIONS) {
    for (const name of Object.keys(json[section] || {})) {
      if (BROWSER.test(name)) problems.push(`${pkg}/package.json ${section} declares ${name}`);
    }
  }
  const src = path.join(ROOT, pkg, 'src');
  if (!fs.existsSync(src)) {
    problems.push(`${pkg}/src is missing (the guard cannot run)`);
    continue;
  }
  for (const file of sourceFiles(src)) {
    files += 1;
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(SPEC)) {
      const spec = m[2] || m[4] || m[6];
      // Comment text is not code (JSDoc may quote an import).
      const lineStart = text.lastIndexOf('\n', m.index) + 1;
      if (/^\s*(\*|\/\/|\/\*)/.test(text.slice(lineStart, m.index))) continue;
      if (BROWSER.test(packageOf(spec))) {
        const line = text.slice(0, m.index).split('\n').length;
        problems.push(`${path.relative(ROOT, file).split(path.sep).join('/')}:${line} imports ${spec}`);
      }
    }
  }
}

if (files === 0) problems.push('no source files scanned (wrong root?)');
if (problems.length) {
  console.error('check-no-browser-in-worker: FAIL - the Worker must render PDFs natively, without a browser (P5):');
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`check-no-browser-in-worker: OK (${PACKAGES.join(', ')}: manifests clean, ${files} source files import no browser package)`);
