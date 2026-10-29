#!/usr/bin/env node
/**
 * Fails when a web spec runs in NO CI job, or in more than one.
 *
 * Every *.spec.ts under web/ must be collected by exactly one of the Playwright configs that .github/workflows/ci-e2e.yaml
 * runs (each job runs exactly one of these):
 *   web-mocked     playwright.config.ts            mocked API, its own Vite
 *   web-isolated   playwright.isolated.config.ts   mocked API, isolated Vite on :5174
 *   web-live       playwright.live.config.ts       real API + PostgreSQL + Redis (live/run-live.sh)
 *   web-ai-visual  web/ai/playwright.<suite>.config.ts for every suite web/ai/run-ai-visual.sh runs by default
 * A spec in no job silently never runs; a spec in two jobs runs against the wrong stack in one of them.
 * Uses `playwright test --list` (loads the specs, starts no server, launches no browser).
 *
 *   node packages/rab-e2e-testing/check-spec-coverage.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const E2E_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(E2E_DIR, '../..');
const CLI = path.join(ROOT, 'node_modules/@playwright/test/cli.js');
const WEB = path.join(E2E_DIR, 'web');

function specFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...specFiles(p));
    else if (name.endsWith('.spec.ts')) out.push(p);
  }
  return out;
}

function listedFiles(config) {
  let raw;
  try {
    raw = execFileSync(process.execPath, [CLI, 'test', '--list', '--reporter=json', '-c', config], {
      cwd: E2E_DIR,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, FORCE_COLOR: '0', CI: process.env.CI ?? '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    // `--list` exits non-zero when a config matches no test at all; that is a finding, not a crash.
    raw = error.stdout ?? '';
    if (!raw.trim().startsWith('{')) throw new Error(`playwright --list failed for ${config}: ${String(error.stderr ?? error.message).slice(0, 2000)}`);
  }
  const report = JSON.parse(raw.slice(raw.indexOf('{')));
  const rootDir = report.config?.rootDir ?? E2E_DIR;
  const files = new Set();
  const walk = (suites) => {
    for (const s of suites ?? []) {
      if (s.file && ((s.specs ?? []).length || (s.suites ?? []).length)) files.add(path.resolve(rootDir, s.file));
      walk(s.suites);
    }
  };
  walk(report.suites);
  for (const e of report.errors ?? []) console.error(`  [${path.basename(config)}] load error: ${(e.message ?? '').split('\n')[0]}`);
  if ((report.errors ?? []).length) throw new Error(`${config} has load errors`);
  return files;
}

function aiVisualConfigs() {
  const script = readFileSync(path.join(WEB, 'ai/run-ai-visual.sh'), 'utf8');
  const m = script.match(/SUITES="\$\{AI_SUITES:-([^}]*)\}"/);
  if (!m) throw new Error('web/ai/run-ai-visual.sh: could not find its default suite list (SUITES="${AI_SUITES:-...}")');
  return m[1].trim().split(/\s+/).map((suite) => {
    const config = path.join(WEB, `ai/playwright.${suite}.config.ts`);
    if (!existsSync(config)) throw new Error(`run-ai-visual.sh runs suite "${suite}" but ${path.relative(E2E_DIR, config)} does not exist`);
    return config;
  });
}

// web-live is credited with what playwright.live.config.ts matches; the runner must run exactly that set, so both have to
// read the one list in live/live-specs.json (a spec listed in the config but not run by the runner would pass this check).
const runner = readFileSync(path.join(E2E_DIR, 'live/run-live.sh'), 'utf8');
const liveConfig = readFileSync(path.join(E2E_DIR, 'playwright.live.config.ts'), 'utf8');
if (!runner.includes('live-specs.json') || !liveConfig.includes('live/live-specs.json') || /^\s*(CONSOLE|QA)_SPECS=\([a-z]/m.test(runner)) {
  console.error('live/run-live.sh and playwright.live.config.ts must both take their spec lists from live/live-specs.json');
  process.exit(1);
}

const jobs = [
  ['web-mocked', [path.join(E2E_DIR, 'playwright.config.ts')]],
  ['web-isolated', [path.join(E2E_DIR, 'playwright.isolated.config.ts')]],
  ['web-live', [path.join(E2E_DIR, 'playwright.live.config.ts')]],
  ['web-ai-visual', aiVisualConfigs()],
];

const owners = new Map(specFiles(WEB).map((f) => [path.resolve(f), []]));
for (const [job, configs] of jobs) {
  for (const config of configs) {
    for (const file of listedFiles(config)) {
      if (!owners.has(file)) owners.set(file, []);
      if (!owners.get(file).includes(job)) owners.get(file).push(job);
    }
  }
}

let problems = 0;
const rel = (f) => path.relative(E2E_DIR, f).split(path.sep).join('/');
for (const [file, inJobs] of [...owners].sort(([a], [b]) => a.localeCompare(b))) {
  const status = inJobs.length === 1 ? 'ok  ' : inJobs.length === 0 ? 'NONE' : 'DUP ';
  if (inJobs.length !== 1) problems++;
  console.log(`${status} ${rel(file).padEnd(60)} ${inJobs.join(', ') || '(no CI job runs this spec)'}`);
}
if (problems) {
  console.error(`\n${problems} spec file(s) are not run by exactly one CI job. Fix the configs' testMatch/testIgnore, never by deleting or skipping a spec.`);
  process.exit(1);
}
console.log(`\nall ${owners.size} web spec files run in exactly one CI job`);
