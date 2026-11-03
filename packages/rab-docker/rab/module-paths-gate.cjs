'use strict';
/**
 * Build-time gate (security review H1-M1), run AS THE RUNTIME USER inside the image:
 *
 *   node module-paths-gate.cjs            (bind-mounted by the Dockerfiles; never shipped in an image)
 *
 * Node's CommonJS loader searches, besides each file's node_modules chain, require('module').globalPaths:
 * $HOME/.node_modules, $HOME/.node_libraries, <prefix>/lib/node, plus NODE_PATH. If the runtime user can create or write
 * any of them, it can plant a module (e.g. pg-native, which TypeORM's Postgres driver tries to load at every start) and
 * get persistent code execution after a restart. This gate fails the build (exit 1) if any module search path, or the
 * nearest existing ancestor of one that does not exist yet, is writable by the current user, or if planting
 * $HOME/.node_modules/pg-native succeeds. Any unexpected error also fails (fail closed).
 */
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');

const ENTRY_DIRS = [
  '/app',
  '/app/packages/rab-server/dist',
  '/app/packages/rab-worker/dist',
  '/app/packages/rab-shared/dist-cjs',
  '/app/packages/rab-ui/dist-cjs',
  '/app/packages/rab-emails/dist',
  '/opt/crewflow-bundle',
];

function nearestExisting(p) {
  let cur = path.resolve(p);
  while (!fs.existsSync(cur)) {
    const up = path.dirname(cur);
    if (up === cur) return cur;
    cur = up;
  }
  return cur;
}

function writable(p) {
  try {
    fs.accessSync(p, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

try {
  const who = `uid=${process.getuid()} gid=${process.getgid()} HOME=${process.env.HOME ?? '(unset)'}`;
  const searchPaths = new Set([...Module.globalPaths, ...(process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean)]);
  for (const dir of ENTRY_DIRS) {
    if (!fs.existsSync(dir)) continue;
    for (const p of Module._nodeModulePaths(dir)) searchPaths.add(p);
  }
  const bad = [];
  for (const p of searchPaths) {
    const anchor = nearestExisting(p);
    if (writable(anchor)) bad.push(`${p} (writable: ${anchor})`);
  }
  // The concrete attack: plant a module the API loads on start.
  const home = process.env.HOME;
  if (home) {
    const plant = path.join(home, '.node_modules', 'pg-native');
    let planted = false;
    try {
      fs.mkdirSync(plant, { recursive: true });
      fs.writeFileSync(path.join(plant, 'index.js'), 'module.exports = {};\n');
      planted = true;
    } catch {
      // expected: EACCES / EROFS / ENOENT
    }
    if (planted) {
      bad.push(`planted ${plant}/index.js`);
      fs.rmSync(path.join(home, '.node_modules'), { recursive: true, force: true });
    }
  }
  if (bad.length > 0) {
    console.error(`module-paths-gate: FATAL (${who}) - writable Node module search path(s):\n  ${bad.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`module-paths-gate: OK (${who}) - ${searchPaths.size} module search paths, none writable; pg-native plant refused`);
} catch (error) {
  console.error(`module-paths-gate: FATAL - ${error && error.message}`);
  process.exit(1);
}
