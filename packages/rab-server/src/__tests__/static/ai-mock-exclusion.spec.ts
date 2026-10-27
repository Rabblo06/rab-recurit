import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * T-X2 (docs/ai/PHASE1_TWENTY_PLAN.md §5, C6): the deterministic mock is TEST-ONLY and absent from the production build.
 *
 *   1. Source scan: no production source (anything tsconfig.app.json compiles — i.e. not under src/__tests__, not a
 *      *.spec/test file, not a jest-* setup file) of rab-server or rab-worker imports the mock, `ai/test` or
 *      `MockLanguageModelV3`, or even contains the mock's id prefix `crewflow-mock`.
 *   2. Build: `tsc -p packages/rab-server/tsconfig.app.json` into a fresh temporary directory, then the same marker grep
 *      the image check uses (tools/check-ai-mock-exclusion.cjs) must find nothing in the compiled output.
 */
const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const ROOTS = ['packages/rab-server/src', 'packages/rab-worker/src'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-cjs', 'dist-esm', 'build', 'coverage']);
const isTestPath = (rel: string) => /(\/__tests__\/|\.spec\.|\.test\.|\/jest-[a-z-]+\.ts$)/.test(rel);

function* walk(dir: string): Generator<string> {
  for (const name of fs.readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) yield* walk(full);
    else if (/\.(ts|js|cjs|mjs|json)$/.test(name)) yield full;
  }
}

describe('T-X2 the in-process mock never reaches production code or the build', () => {
  it('the mock lives under src/__tests__/support/ai (and nowhere in modules/ or engine/)', () => {
    expect(fs.existsSync(path.join(REPO_ROOT, 'packages/rab-server/src/__tests__/support/ai/deterministic-mock-model.ts'))).toBe(true);
    expect(fs.existsSync(path.join(REPO_ROOT, 'packages/rab-server/src/modules/ai/gateway/deterministic-mock-model.ts'))).toBe(false);
    const app = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'packages/rab-server/tsconfig.app.json'), 'utf8')) as { exclude: string[] };
    expect(app.exclude).toEqual(expect.arrayContaining(['src/__tests__/**', '**/*.spec.ts']));
  });

  it('source scan: no production file imports deterministic-mock-model, ai/test or MockLanguageModelV3, or contains crewflow-mock', () => {
    const offenders: string[] = [];
    let scanned = 0;
    for (const root of ROOTS) {
      for (const file of walk(path.join(REPO_ROOT, root))) {
        const rel = path.relative(REPO_ROOT, file).replace(/\\/g, '/');
        if (isTestPath(rel)) continue;
        scanned += 1;
        const text = fs.readFileSync(file, 'utf8');
        if (/deterministic-mock-model|['"]ai\/test['"]|MockLanguageModelV3|DeterministicMockModel|crewflow-mock/.test(text)) offenders.push(rel);
      }
    }
    expect(scanned).toBeGreaterThan(300);
    expect(offenders).toEqual([]);
  });

  it('build: the compiled app (tsc -p tsconfig.app.json into a fresh directory) contains no test-model marker', () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'crewflow-ai-mock-exclusion-'));
    try {
      execFileSync(process.execPath, [path.join(REPO_ROOT, 'node_modules/typescript/bin/tsc'), '-p', path.join(REPO_ROOT, 'packages/rab-server/tsconfig.app.json'), '--outDir', out], { cwd: REPO_ROOT, stdio: 'pipe' });
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { scan } = require(path.join(REPO_ROOT, 'tools/check-ai-mock-exclusion.cjs')) as { scan: (dir: string) => { files: number; offenders: string[] } };
      const result = scan(out);
      expect(result.files).toBeGreaterThan(300);
      expect(result.offenders).toEqual([]);
      // The catalogue facts ship with the build (resolveJsonModule emits the JSON next to catalog.js).
      expect(fs.existsSync(path.join(out, 'engine/core-modules/ai/models/ai-models.json'))).toBe(true);
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  }, 300_000);
});
