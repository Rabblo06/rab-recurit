import { NativeReportDocument, nativeRenderRequest } from '../../queues/rab-reports/native/render-native';
import { NativeRenderPool } from '../../queues/rab-reports/native/runtime/render-pool';
import { extractPdf } from './extract';
import { buildFixtures, FixtureDocument } from './fixtures';
import { seamDocument } from './renderers';

/**
 * RENDER ISOLATION over the real documents: a native PDF is a function of its own input only, never of what the render
 * thread printed before (another tenant's document included).
 *
 * Regression for the pdf-equality flake of 2026-11-05/06 (PR #78 hostile/final-timesheet; PR #80
 * hostile/final-timesheet-original and hostile/pre-shift-report; both passed on re-run). The pool hands documents to
 * threads in whatever order they finish, and a thread that had embedded "Ż" (the unicode statement's "Łucja Żak") before
 * it ever laid out a regular "Z" kept a "Z" glyph with no code points in fontkit's per-font cache. Every later document
 * on that thread then broke the hostile note one glyph late ("<<" split over two lines, the line spread out) and left
 * "Z" out of the text layer (ToUnicode "<>"). See runtime/glyph-cache.ts.
 *
 * Each case pins the thread history instead of leaving it to scheduling: one thread renders the document first ("fresh"),
 * another renders the history first and then the same document; the bytes must be identical. Without the per-render
 * glyph-cache reset the hostile documents fail here on every run, not one CI run in many.
 *
 *   npx jest -c packages/rab-worker/src/__tests__/pdf-equality/jest.config.ts pdf-native-determinism
 */
jest.setTimeout(10 * 60_000);

const quiet = { log: () => undefined, warn: () => undefined };
const request = (f: FixtureDocument) => nativeRenderRequest(seamDocument(f.doc) as NativeReportDocument);

/** The hostile note's text as printed: these two runs are where the shifted string indices showed. */
const HOSTILE_NOTE_RUNS = ['ZW[a□b□c□d□e] %PDF-1.4 endstream endobj', '<< /JavaScript >>'];

describe('native render isolation: same document → same bytes, whatever the thread printed before', () => {
  let fixtures: FixtureDocument[];
  const pools: NativeRenderPool[] = [];
  const pool = () => {
    const p = new NativeRenderPool({ size: 1, logger: quiet });
    pools.push(p);
    return p;
  };

  beforeAll(async () => {
    fixtures = await buildFixtures({ scenarios: ['hostile', 'unicode', 'one-row'] });
  });
  afterEach(async () => {
    await Promise.all(pools.splice(0).map((p) => p.destroy()));
  });

  const byScenario = (scenario: string) => fixtures.filter((f) => f.scenario === scenario);
  const hostile = () => byScenario('hostile').filter((f) => f.kind !== 'approved-shift-statement');

  it.each(['final-timesheet-original', 'final-timesheet', 'pre-shift-report'])(
    'hostile/%s after the unicode statement on the same thread: identical to a fresh thread, note printed in full',
    async (kind) => {
      // The unicode statement prints "Łucja Żak" and no plain regular "Z": the history the CI pool happened to produce.
      const statement = fixtures.find((f) => f.id === 'unicode/approved-shift-statement')!;
      const target = hostile().find((f) => f.kind === kind)!;
      const fresh = await pool().render(request(target));
      const aged = pool();
      await aged.render(request(statement));
      const after = await aged.render(request(target));

      const text = (pdf: Buffer) => extractPdf(pdf).text.replace(/\s+/g, ' ');
      for (const run of HOSTILE_NOTE_RUNS) expect({ run, fresh: text(fresh).includes(run) }).toEqual({ run, fresh: true });
      for (const run of HOSTILE_NOTE_RUNS) expect({ run, after: text(after).includes(run) }).toEqual({ run, after: true });
      expect(after.equals(fresh)).toBe(true);
    },
  );

  it('every hostile, unicode and one-row document is the same bytes whichever of them the thread printed first', async () => {
    const alone = new Map<string, Buffer>();
    for (const f of fixtures) {
      const p = pool(); // one thread at a time: never more than one 384 MB render thread alive in this test
      alone.set(f.id, await p.render(request(f)));
      await p.destroy();
    }
    const differ: string[] = [];
    for (const first of fixtures) {
      const p = pool();
      await p.render(request(first));
      for (const f of fixtures) {
        if (f !== first && !(await p.render(request(f))).equals(alone.get(f.id)!)) differ.push(`${f.id} after ${first.id}`);
      }
      await p.destroy();
    }
    expect(differ).toEqual([]);
  });
});
