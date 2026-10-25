import * as fs from 'fs';
import * as path from 'path';

/**
 * T5-C1 (PHASE5_TWENTY_PLAN §2.2): writes happen only through approved proposals.
 *   1. In production code (rab-server + rab-worker), `AiProposalExecutorService` is the ONLY caller of a write tool's
 *      `apply(` — every other `.apply(` call site is an explicitly reviewed non-AI one (Nest middleware, the HWS backfill).
 *      A new `.apply(` anywhere fails this test until it is reviewed and listed here.
 *   2. Tests never call a write tool's apply directly either (they go through the approval route or the executor).
 *   3. No write definition reaches the model's tool set: nothing under modules/ai/tools or modules/ai/gateway imports the
 *      write tools, and the write-tool file has no `run` / `execute`.
 */
const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const PROD_ROOTS = ['packages/rab-server/src', 'packages/rab-worker/src'];
const CODE = new Set(['.ts', '.js', '.cjs', '.mjs']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-cjs', 'dist-esm', 'build', '.git', 'coverage']);
const EXECUTOR = 'packages/rab-server/src/modules/ai/actions/ai-proposal-executor.service.ts';
const WRITE_TOOLS = 'packages/rab-server/src/modules/ai/actions/ai-write-tools.ts';
/** Reviewed `.apply(` call sites that are NOT AI write tools (file → exact receiver text). */
const REVIEWED_APPLY_CALLS: Record<string, string[]> = {
  'packages/rab-server/src/app.module.ts': ['consumer.apply('],
  'packages/rab-server/src/engine/core-modules/workspace-host/workspace-host.module.ts': ['consumer.apply('],
  'packages/rab-server/src/command/hws-backfill.command.ts': ['this.backfill.apply('],
  [EXECUTOR]: ['tool.apply('],
};

function* walk(entry: string): Generator<string> {
  if (!fs.existsSync(entry)) return;
  if (fs.statSync(entry).isFile()) {
    yield entry;
    return;
  }
  for (const name of fs.readdirSync(entry)) {
    if (SKIP_DIRS.has(name)) continue;
    yield* walk(path.join(entry, name));
  }
}

const rel = (abs: string) => path.relative(REPO_ROOT, abs).replace(/\\/g, '/');
const isTest = (file: string) => /\.(spec|test)\.[cm]?[jt]s$/.test(file) || file.includes('/__tests__/');
const files = PROD_ROOTS.flatMap((root) => [...walk(path.join(REPO_ROOT, root))])
  .filter((f) => CODE.has(path.extname(f)))
  .map((abs) => ({ file: rel(abs), text: fs.readFileSync(abs, 'utf8') }));

describe('T5-C1 static: write tools are applied only by the proposal executor', () => {
  it('scans the sources (sanity)', () => {
    expect(files.length).toBeGreaterThan(500);
    expect(files.some((f) => f.file === EXECUTOR)).toBe(true);
  });

  it('every production `.apply(` call site is the executor or a reviewed non-AI call', () => {
    const found: Record<string, string[]> = {};
    for (const { file, text } of files.filter((f) => !isTest(f.file))) {
      const calls = [...text.matchAll(/([A-Za-z_$][\w$.]*)\.apply\(/g)].map((m) => `${m[1]}.apply(`);
      if (calls.length) found[file] = calls;
    }
    expect(found).toEqual(REVIEWED_APPLY_CALLS);
    expect(found[EXECUTOR]).toHaveLength(1);
  });

  it('tests never call a write tool apply() directly', () => {
    const offenders = files
      .filter((f) => isTest(f.file))
      .flatMap(({ file, text }) => [...text.matchAll(/\b(?:tool|tools|def|definition|writeTool|write)\w*(?:\.get\([^)]*\)!?)?\.apply\(/gi)].map((m) => `${file}: ${m[0]}`));
    expect(offenders).toEqual([]);
  });

  it('no write definition reaches the model tool set: tools/ and gateway/ never import the actions folder', () => {
    const offenders = files
      .filter((f) => /packages\/rab-server\/src\/modules\/ai\/(tools|gateway|prompt)\//.test(f.file) && !isTest(f.file))
      .filter((f) => /from ['"][^'"]*\/actions\//.test(f.text) || /ai-write-tools/.test(f.text))
      .map((f) => f.file);
    expect(offenders).toEqual([]);
    const writeTools = files.find((f) => f.file === WRITE_TOOLS)!.text;
    expect(writeTools).not.toMatch(/\b(run|execute)\s*\(/);
    expect(writeTools).not.toMatch(/\b(run|execute)\s*:/);
  });
});
