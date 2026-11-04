import { QrImageService } from '@rab/server/modules/attendance/services/qr-image.service';

import { checkAgainstInput, CheckOptions, compareExtractions, ComparisonResult, countValue, formatReport } from './checker';
import { DocumentExpectation, expectationFor, renderCall, ReportDocument } from './documents';
import { compact, PdfExtraction } from './extract';
import { buildFixtures, FixtureDocument, fixtureAttendanceQr, fixtureIds, fixtureQrTokens, scenarioSeeds, shiftEntity } from './fixtures';
import { loadGlyphTransform } from './glyph-transform';
import { extractFixture, outDir, RENDER_CONCURRENCY, saveArtifact, verifyShiftQr } from './harness';
import { clippingEvidence, F_PDF_1, F_PDF_1_FIXTURES, F_PDF_1_PRESENT, F_PDF_1_SHAPES, fixedColumnProblems, NOTES_LINE_BREAKS_IN_TEMPLATE } from './known-findings';
import { MODE, NATIVE_ONLY } from './mode';
import { nativeExpectation } from './native-reference';
import { chromiumRenderer, loadNativeRenderer, mapLimit, Renderer, renderHtmlWithChromium } from './renderers';
import { dropLastPage, swapOneGlyph } from './tamper';

/**
 * SELF-TEST of the PDF equality harness. Proves the extractor + checker are
 *   (1) not flaky — two independent renders of every fixture compare EQUAL;
 *   (2) not blind — a deliberately altered PDF (byte-level glyph swap, a dropped page, a lost footer, or a re-render from
 *       an input with one business value changed) compares UNEQUAL, on the check that should catch it.
 *
 * The renderer under self-test follows PDF_EQUALITY_MODE (mode.ts): Chromium in `compare` mode (today's renderer, and the
 * reference for native), the native renderer in `native-only` mode (P5: no Chromium; the two native renders must also be
 * BYTE-IDENTICAL, D7 deterministic output). The native side is held to F1 (□ markers) and react-pdf's forced-break
 * hyphens, exactly as in the equality suite.
 *
 * Run (no database needed):
 *   bash C:/rab-ai-wt/setup/heavy-run.sh pdf-tests npx jest -c packages/rab-worker/src/__tests__/pdf-equality/jest.config.ts pdf-equality.selftest
 * Switches: PDF_EQUALITY_MODE, PDF_EQUALITY_OUT (artifact dir, default <tmp>/rab-pdf-equality), PDF_EQUALITY_CONCURRENCY
 * (renders in flight, default 3), CHROMIUM_EXECUTABLE_PATH (system Chromium, as in the Worker image). The PDFs and
 * `report.txt` land in <out>/selftest.
 */
jest.setTimeout(30 * 60_000);

const OUT = outDir('selftest');
const IDS = fixtureIds();
const nativeOrUnavailable = loadNativeRenderer();
if (NATIVE_ONLY && 'unavailable' in nativeOrUnavailable) throw new Error(`PDF_EQUALITY_MODE=native-only but ${nativeOrUnavailable.unavailable}`);
const renderer: Renderer = NATIVE_ONLY ? (nativeOrUnavailable as Renderer) : chromiumRenderer;
const N1 = `${renderer.name}#1`;
const N2 = `${renderer.name}#2`;
const SELF_NAMES = [N1, N2, 'original', 'altered'];
/** Chromium line-break gaps are INFO only where this tree's template does not keep them yet (pinned below). */
const LINE_BREAKS_PENDING = !NATIVE_ONLY && !NOTES_LINE_BREAKS_IN_TEMPLATE;
const OPTIONS: CheckOptions = NATIVE_ONLY ? { boundsStrict: SELF_NAMES, forcedBreakHyphens: SELF_NAMES } : { lineBreaksInfo: LINE_BREAKS_PENDING ? SELF_NAMES : [] };
let fixtures: Map<string, FixtureDocument>;
const renders = new Map<string, [Buffer, Buffer]>();
const expectations = new Map<string, DocumentExpectation>();
const results: ComparisonResult[] = [];

/** The expectation of the renderer under self-test: the input's values, F1-transformed for the native renderer. */
async function expectationOf(doc: ReportDocument): Promise<DocumentExpectation> {
  const e = expectationFor(doc);
  if (!NATIVE_ONLY) return e;
  const glyphs = await loadGlyphTransform();
  if ('unavailable' in glyphs) throw new Error(`native-only mode but the F1 glyph transform is unavailable: ${glyphs.unavailable}`);
  return nativeExpectation(e, glyphs.transform);
}

beforeAll(async () => {
  fixtures = new Map((await buildFixtures()).map((f) => [f.id, f]));
  await mapLimit([...fixtures.values()], RENDER_CONCURRENCY, async (f) => {
    const first = await renderer.render(f.doc);
    const second = await renderer.render(f.doc);
    renders.set(f.id, [first, second]);
    expectations.set(f.id, await expectationOf(f.doc));
    saveArtifact(OUT, f.id, `${renderer.name}-1.pdf`, first);
  });
});

afterAll(() => {
  if (results.length) saveArtifact(OUT, 'report', 'txt', formatReport(results, `PDF equality self-test (${MODE}: ${renderer.name} vs ${renderer.name}, then altered PDFs)`));
});

it('builds exactly the documented fixture matrix', () => {
  expect([...fixtures.keys()].sort()).toEqual([...IDS].sort());
});

describe(`${renderer.name} vs ${renderer.name}: every fixture compares equal (the checker is not flaky)`, () => {
  const selfCompare = (id: string) => {
    const f = fixtures.get(id)!;
    const [a, b] = renders.get(id)!;
    const r = compareExtractions(id, expectations.get(id)!, extractFixture(f, a), extractFixture(f, b), [N1, N2], OPTIONS);
    results.push(r);
    if (!r.ok) throw new Error(formatReport([r]));
  };
  const findingIds = NATIVE_ONLY ? [] : Object.keys(F_PDF_1_FIXTURES);
  it.each(IDS.filter((id) => !findingIds.includes(id)))('%s', selfCompare);

  if (NATIVE_ONLY) {
    // D7: the native renderer's output is deterministic (creationDate = generatedAt, frozen thread clock).
    it.each(IDS)('%s: the two native renders are byte-identical (D7)', (id) => {
      const [a, b] = renders.get(id)!;
      expect(a.equals(b)).toBe(true);
    });
  } else if (!F_PDF_1_PRESENT) {
    // F-PDF-1 FIXED in this tree's template (known-findings.ts): the right-hand column, the sign-off and the total are
    // printed, all 1,000 token characters are printed, and nothing is outside the page — on both Chromium renders.
    it.each(Object.entries(F_PDF_1_SHAPES))(`%s: ${F_PDF_1} is fixed — every column, the sign-off and the total printed, inside the page`, (id, shape) => {
      const f = fixtures.get(id)!;
      for (const [k, pdf] of renders.get(id)!.entries()) expect(fixedColumnProblems(f.doc, extractFixture(f, pdf), `chromium#${k + 1}`, shape.droppedHeading)).toEqual([]);
    });
  } else if (findingIds.length) {
    // KNOWN FINDING F-PDF-1 (known-findings.ts): Chromium drops the notes' tail and the right-hand column. The assertion is
    // unchanged; `test.failing` turns RED the day the template stops dropping text — then make these plain `it`s again.
    test.failing.each(findingIds)(`%s — KNOWN FINDING ${F_PDF_1}`, selfCompare);

    // …and exactly that, nothing else, fails on those fixtures (so `test.failing` cannot hide another defect).
    it.each(Object.entries(F_PDF_1_FIXTURES))(`%s: ${F_PDF_1} — evidence, and no other failure`, (id, known) => {
      const f = fixtures.get(id)!;
      for (const [k, pdf] of renders.get(id)!.entries()) {
        const name = `chromium#${k + 1}`;
        const e = clippingEvidence(f.doc, extractFixture(f, pdf), name, known.droppedHeading);
        expect(e.failing).toEqual([`values-present(${name})`, ...(known.parseBack ? [`parse-back(${name})`] : [])]);
        expect(e.missing).toEqual(known.missing);
        expect(e.parseBack).toBe(known.parseBack);
        expect(e.tokenCharsPrinted).toBeGreaterThan(0);
        expect(e.tokenCharsPrinted).toBeLessThan(1000);
        expect(e.droppedHeadingPrinted).toBe(false);
      }
    });
  }
});

describe(`extraction regressions on real ${renderer.name} output`, () => {
  it('long-text: the 10 KB note spans pages and is counted exactly once, line by line, every line on its own printed line', () => {
    const f = fixtures.get('long-text/final-timesheet')!;
    if (f.doc.kind !== 'final-timesheet' || !f.doc.data.notes) throw new Error('long-text/final-timesheet: expected a final timesheet with notes');
    const notes = f.doc.data.notes;
    const x = extractFixture(f, renders.get(f.id)![0]);
    // Not inside any one page …
    expect(x.pages.some((p) => p.blocks.some((b) => compact(b).includes(compact(notes))) || compact(p.lines.join('')).includes(compact(notes)))).toBe(false);
    // … found exactly once, and every one of its 56 paragraphs starts a printed line.
    expect(countValue(x, notes, { forcedBreakHyphens: NATIVE_ONLY })).toBe(1);
    if (!LINE_BREAKS_PENDING) expect(checkAgainstInput(expectations.get(f.id)!, x, 'r', OPTIONS).find((c) => c.check === 'line-breaks(r)')).toMatchObject({ ok: true, info: undefined });
  });

  if (LINE_BREAKS_PENDING) {
    // PENDING in this tree (origin/main): the Chromium templates collapse notes' line breaks (white-space: normal). Owner
    // decision 2026-11-04 requires them kept; the template change (fix/pdf-notes-column-and-line-breaks) turns this RED,
    // and then NOTES_LINE_BREAKS_IN_TEMPLATE makes the check strict everywhere.
    test.failing("notes keep their line breaks in Chromium's templates (PENDING the template change)", () => {
      for (const id of ['one-row/final-timesheet', 'one-row/pre-shift-report', 'long-text/final-timesheet', 'long-text/pre-shift-report']) {
        const f = fixtures.get(id)!;
        const strict = checkAgainstInput(expectations.get(id)!, extractFixture(f, renders.get(id)![0]), 'chromium').find((c) => c.check === 'line-breaks(chromium)')!;
        expect(strict).toMatchObject({ ok: true });
      }
    });
  }

  if (!NATIVE_ONLY) {
    it('unicode: a multi-word Arabic name (drawn right to left, one run per word) reads in logical order', () => {
      const f = fixtures.get('unicode/approved-shift-statement')!;
      const x = extractFixture(f, renders.get(f.id)![0]);
      expect(countValue(x, 'محمد عبد الله')).toBeGreaterThan(0);
      expect(countValue(x, 'الله عبد محمد')).toBe(0); // the visual (left-to-right) word order
    });
  }
});

/** A clone of the input with one change: a test mutation of render INPUT, never a recomputation. */
function mutate(doc: ReportDocument, change: (d: ReportDocument) => void): ReportDocument {
  const copy = { ...doc, data: structuredClone(doc.data) } as ReportDocument;
  change(copy);
  return copy;
}

interface Alteration {
  name: string;
  fixture: string;
  /** Produces the altered PDF (or, where only an extraction can express it, the altered extraction). */
  alter: (f: FixtureDocument, original: Buffer, originalX: PdfExtraction) => Promise<Buffer | PdfExtraction>;
  /** Checks that must be among the failing ones. */
  mustFail: string[];
}

/** The pages of an extraction without their footer line: what a render that lost its footer prints (native-only mode). */
function withoutFooters(x: PdfExtraction): PdfExtraction {
  const pages = x.pages.map((p) => {
    const lines = p.lines.filter((l) => l !== p.footer);
    return { ...p, lines, lineSegments: p.lineSegments.filter((_s, i) => p.lines[i] !== p.footer), text: lines.join('\n'), blocks: p.blocks.filter((b) => b !== p.footer), footer: null, footerNumbering: null };
  });
  return { ...x, pages, text: pages.map((p) => p.text).join('\n\f\n') };
}

const ALTERATIONS: Alteration[] = [
  { name: 'byte-level: one glyph swapped in a content stream', fixture: 'one-row/final-timesheet', alter: async (_f, pdf) => swapOneGlyph(pdf), mustFail: ['tokens'] },
  { name: 'byte-level: last page removed from the page tree', fixture: 'rows-45/final-timesheet', alter: async (_f, pdf) => dropLastPage(pdf), mustFail: ['page-count', 'footer-numbering(altered)'] },
  NATIVE_ONLY
    ? { name: 'footer lost (every footer line removed from the extraction)', fixture: 'rows-45/pre-shift-report', alter: async (_f, _pdf, x) => withoutFooters(x), mustFail: ['footer-numbering(altered)'] }
    : {
        name: 'footer lost (rendered without the footer template)',
        fixture: 'rows-45/pre-shift-report',
        alter: async (f) => renderHtmlWithChromium(renderCall(f.doc).html, { landscape: true }),
        mustFail: ['footer-numbering(altered)'],
      },
  {
    name: 'worked minutes of row 10 changed by +1 minute',
    fixture: 'rows-45/final-timesheet',
    alter: async (f) => renderer.render(mutate(f.doc, (d) => d.kind === 'final-timesheet' && (d.data.staff[9]!.workedMinutes = (d.data.staff[9]!.workedMinutes ?? 0) + 1))),
    mustFail: ['tokens'],
  },
  {
    name: 'approved gross changed by +1p',
    fixture: 'one-row/approved-shift-statement',
    alter: async (f) => renderer.render(mutate(f.doc, (d) => d.kind === 'approved-shift-statement' && (d.data.amountPence += 1))),
    mustFail: ['values-present(altered)', 'values-equal', 'tokens'],
  },
  {
    name: 'clock-out time of row 1 moved by one minute',
    fixture: 'midnight/final-timesheet',
    alter: async (f) =>
      renderer.render(
        mutate(f.doc, (d) => {
          if (d.kind !== 'final-timesheet') return;
          const s = d.data.staff[0]!;
          s.clockOutAt = new Date(new Date(s.clockOutAt!).getTime() + 60_000).toISOString();
        }),
      ),
    mustFail: ['tokens'],
  },
  {
    name: 'typed sign-off (signature name) changed',
    fixture: 'unicode/final-timesheet',
    alter: async (f) => renderer.render(mutate(f.doc, (d) => d.kind === 'final-timesheet' && (d.data.signedOffName = 'Someone Else'))),
    mustFail: ['values-present(altered)', 'values-equal', 'tokens'],
  },
  {
    name: 'last staff row removed',
    fixture: 'rows-45/pre-shift-report',
    alter: async (f) => renderer.render(mutate(f.doc, (d) => d.kind === 'pre-shift-report' && d.data.staff.pop())),
    mustFail: ['values-present(altered)', 'values-equal', 'tokens'],
  },
  {
    name: 'QR encodes a different (validly signed) token',
    fixture: 'one-row/pre-shift-report',
    alter: async (f) => {
      const other = fixtureQrTokens.sign({ shiftId: '00000000-0000-4000-8000-000000000000', venueId: '00000000-0000-4000-8000-000000000001', ver: 2 }, 3600);
      const png = await new QrImageService().generatePng(other);
      return renderer.render(mutate(f.doc, (d) => d.kind === 'pre-shift-report' && (d.data.qrPngBase64 = png.toString('base64'))));
    },
    mustFail: ['qr-payloads(altered)', 'qr-equal'],
  },
  {
    // Native prints Arabic as F1 markers (no glyphs), so a reversed Arabic name would print the same markers: native-only
    // reverses a Latin name instead. Either way the wrong character order must be caught.
    name: NATIVE_ONLY ? 'Polish name reversed (wrong character order)' : 'Arabic name reversed (wrong bidi order)',
    fixture: 'unicode/pre-shift-report',
    alter: async (f) =>
      renderer.render(
        mutate(f.doc, (d) => {
          if (d.kind !== 'pre-shift-report') return;
          const row = d.data.staff.find((s) => (NATIVE_ONLY ? /Łukasz/ : /[\u0600-\u06ff]/).test(s.name))!;
          row.name = [...row.name].reverse().join('');
        }),
      ),
    mustFail: ['values-present(altered)', 'tokens'],
  },
  // Only where the renderer under test keeps line breaks (native; Chromium once its template does).
  ...(LINE_BREAKS_PENDING
    ? []
    : [
        {
          name: 'a multi-line note printed with its line breaks collapsed',
          fixture: 'one-row/final-timesheet',
          alter: async (f: FixtureDocument) => renderer.render(mutate(f.doc, (d) => d.kind === 'final-timesheet' && (d.data.notes = d.data.notes!.replace(/\s*[\r\n]+\s*/g, ' ')))),
          mustFail: ['line-breaks(altered)'],
        } satisfies Alteration,
      ]),
];

describe('altered PDFs compare unequal (the checker catches differences)', () => {
  it.each(ALTERATIONS.map((a) => [a.name, a] as const))('%s', async (_name, alteration) => {
    const f = fixtures.get(alteration.fixture)!;
    const [original] = renders.get(alteration.fixture)!;
    const originalX = extractFixture(f, original);
    const altered = await alteration.alter(f, original, originalX);
    const alteredX = Buffer.isBuffer(altered) ? extractFixture(f, altered) : altered;
    if (Buffer.isBuffer(altered)) saveArtifact(OUT, `${alteration.fixture}--altered--${alteration.name}`, 'pdf', altered);
    const r = compareExtractions(`ALTERED ${alteration.fixture}: ${alteration.name}`, expectations.get(alteration.fixture)!, originalX, alteredX, ['original', 'altered'], OPTIONS);
    results.push(r);
    const failing = r.findings.filter((x) => !x.ok && !x.info).map((x) => x.check);
    expect(r.ok).toBe(false);
    for (const check of alteration.mustFail) expect(failing).toContain(check);
  });
});

describe('QR: decoded from the PDF and verified (P0 plan §5.2 4(e))', () => {
  const rosters = IDS.filter((id) => id.endsWith('/pre-shift-report'));
  it.each(rosters)('%s: AttendanceQrService.validateQr accepts it for its shift and refuses another shift', async (id) => {
    const f = fixtures.get(id)!;
    const x = extractFixture(f, renders.get(id)![0]);
    expect(x.qrPayloads).toHaveLength(1);
    expect(await verifyShiftQr(f.scenario, x.qrPayloads[0]!)).toEqual([]);
  });

  it('an expired QR (decoded from the PDF) is refused', async () => {
    const f = fixtures.get('one-row/pre-shift-report')!;
    const payload = extractFixture(f, renders.get(f.id)![0]).qrPayloads[0]!;
    const shift = shiftEntity(scenarioSeeds().find((s) => s.id === f.scenario)!);
    const now = jest.spyOn(Date, 'now').mockReturnValue(shift.endsAt.getTime() + 24 * 60 * 60_000); // a day after the shift
    try {
      await expect(fixtureAttendanceQr.validateQr({ findOneByOrFail: async () => shift } as never, shift.id, payload)).rejects.toThrow();
    } finally {
      now.mockRestore();
    }
  });
});

/**
 * KNOWN FINDING (P0 plan §5.2 1: values adjacent to Number.MAX_SAFE_INTEGER "must be refused, not rounded"). Today
 * `formatPence` divides by 100 in floating point: formatPence(9007199254740991) prints "£90,071,992,547,409.90" (1p
 * short) and nothing refuses it. Both renderers print the view-model's `formatPence` string, so the finding holds for
 * either. `test.failing` keeps the suite green while the defect exists and turns RED the day the amount is refused or
 * printed exactly — then change it to a plain `it`.
 */
test.failing('pence adjacent to MAX_SAFE_INTEGER are refused or printed exactly', async () => {
  const f = fixtures.get('edge-values/approved-shift-statement-pence-1')!;
  const doc = mutate(f.doc, (d) => d.kind === 'approved-shift-statement' && ((d.data.amountPence = Number.MAX_SAFE_INTEGER), (d.data.payRatePence = Number.MAX_SAFE_INTEGER - 1)));
  const pdf = await renderer.render(doc).catch(() => null);
  if (pdf === null) return; // refused: the required behaviour
  const parse = checkAgainstInput(expectationFor(doc), extractFixture(f, pdf), renderer.name).find((r) => r.check === `parse-back(${renderer.name})`)!;
  expect(parse.detail).not.toMatch(/parses to/);
  expect(parse.ok).toBe(true);
});
