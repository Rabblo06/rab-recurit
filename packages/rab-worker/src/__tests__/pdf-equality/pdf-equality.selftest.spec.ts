import { QrImageService } from '@rab/server/modules/attendance/services/qr-image.service';

import { renderHtmlToPdf } from '../../queues/rab-reports/render-pdf.util';
import { checkAgainstInput, compareExtractions, ComparisonResult, formatReport } from './checker';
import { expectationFor, renderCall, ReportDocument } from './documents';
import { buildFixtures, FixtureDocument, fixtureAttendanceQr, fixtureIds, fixtureQrTokens, scenarioSeeds, shiftEntity } from './fixtures';
import { extractFixture, outDir, RENDER_CONCURRENCY, saveArtifact, verifyShiftQr } from './harness';
import { chromiumRenderer, mapLimit } from './renderers';
import { dropLastPage, swapOneGlyph } from './tamper';

/**
 * SELF-TEST of the PDF equality harness (renderer migration Chromium → native). Proves the extractor + checker are
 *   (1) not flaky — two independent Chromium renders of every fixture compare EQUAL;
 *   (2) not blind — a deliberately altered PDF (byte-level glyph swap, a dropped page, a lost footer, or a re-render from
 *       an input with one business value changed) compares UNEQUAL, on the check that should catch it.
 *
 * Run (no database needed):
 *   bash C:/rab-ai-wt/setup/heavy-run.sh pdf-tests npx jest -c packages/rab-worker/src/__tests__/pdf-equality/jest.config.ts pdf-equality.selftest
 * Switches: PDF_EQUALITY_OUT (artifact dir, default <tmp>/rab-pdf-equality), PDF_EQUALITY_CONCURRENCY (renders in flight,
 * default 3), CHROMIUM_EXECUTABLE_PATH (system Chromium, as in the Worker image). The PDFs and `report.txt` land in
 * <out>/selftest.
 */
jest.setTimeout(30 * 60_000);

const OUT = outDir('selftest');
const IDS = fixtureIds();
let fixtures: Map<string, FixtureDocument>;
const renders = new Map<string, [Buffer, Buffer]>();
const results: ComparisonResult[] = [];

beforeAll(async () => {
  fixtures = new Map((await buildFixtures()).map((f) => [f.id, f]));
  await mapLimit([...fixtures.values()], RENDER_CONCURRENCY, async (f) => {
    const first = await chromiumRenderer.render(f.doc);
    const second = await chromiumRenderer.render(f.doc);
    renders.set(f.id, [first, second]);
    saveArtifact(OUT, f.id, 'chromium-1.pdf', first);
  });
});

afterAll(() => {
  if (results.length) saveArtifact(OUT, 'report', 'txt', formatReport(results, 'PDF equality self-test (Chromium vs Chromium, then altered PDFs)'));
});

it('builds exactly the documented fixture matrix', () => {
  expect([...fixtures.keys()].sort()).toEqual([...IDS].sort());
});

describe('Chromium vs Chromium: every fixture compares equal (the checker is not flaky)', () => {
  it.each(IDS)('%s', (id) => {
    const f = fixtures.get(id)!;
    const [a, b] = renders.get(id)!;
    const r = compareExtractions(id, expectationFor(f.doc), extractFixture(f, a), extractFixture(f, b), ['chromium#1', 'chromium#2']);
    results.push(r);
    if (!r.ok) throw new Error(formatReport([r]));
  });
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
  /** Produces the altered PDF from the fixture and its first Chromium render. */
  alter: (f: FixtureDocument, original: Buffer) => Promise<Buffer>;
  /** Checks that must be among the failing ones. */
  mustFail: string[];
}

const ALTERATIONS: Alteration[] = [
  { name: 'byte-level: one glyph swapped in a content stream', fixture: 'one-row/final-timesheet', alter: async (_f, pdf) => swapOneGlyph(pdf), mustFail: ['tokens'] },
  { name: 'byte-level: last page removed from the page tree', fixture: 'rows-45/final-timesheet', alter: async (_f, pdf) => dropLastPage(pdf), mustFail: ['page-count', 'footer-numbering(altered)'] },
  {
    name: 'footer lost (rendered without the footer template)',
    fixture: 'rows-45/pre-shift-report',
    alter: async (f) => renderHtmlToPdf(renderCall(f.doc).html, { landscape: true }),
    mustFail: ['footer-numbering(altered)'],
  },
  {
    name: 'worked minutes of row 10 changed by +1 minute',
    fixture: 'rows-45/final-timesheet',
    alter: async (f) => chromiumRenderer.render(mutate(f.doc, (d) => d.kind === 'final-timesheet' && (d.data.staff[9]!.workedMinutes = (d.data.staff[9]!.workedMinutes ?? 0) + 1))),
    mustFail: ['tokens'],
  },
  {
    name: 'approved gross changed by +1p',
    fixture: 'one-row/approved-shift-statement',
    alter: async (f) => chromiumRenderer.render(mutate(f.doc, (d) => d.kind === 'approved-shift-statement' && (d.data.amountPence += 1))),
    mustFail: ['values-present(altered)', 'values-equal', 'tokens'],
  },
  {
    name: 'clock-out time of row 1 moved by one minute',
    fixture: 'midnight/final-timesheet',
    alter: async (f) =>
      chromiumRenderer.render(
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
    alter: async (f) => chromiumRenderer.render(mutate(f.doc, (d) => d.kind === 'final-timesheet' && (d.data.signedOffName = 'Someone Else'))),
    mustFail: ['values-present(altered)', 'values-equal', 'tokens'],
  },
  {
    name: 'last staff row removed',
    fixture: 'rows-45/pre-shift-report',
    alter: async (f) => chromiumRenderer.render(mutate(f.doc, (d) => d.kind === 'pre-shift-report' && d.data.staff.pop())),
    mustFail: ['values-present(altered)', 'values-equal', 'tokens'],
  },
  {
    name: 'QR encodes a different (validly signed) token',
    fixture: 'one-row/pre-shift-report',
    alter: async (f) => {
      const other = fixtureQrTokens.sign({ shiftId: '00000000-0000-4000-8000-000000000000', venueId: '00000000-0000-4000-8000-000000000001', ver: 2 }, 3600);
      const png = await new QrImageService().generatePng(other);
      return chromiumRenderer.render(mutate(f.doc, (d) => d.kind === 'pre-shift-report' && (d.data.qrPngBase64 = png.toString('base64'))));
    },
    mustFail: ['qr-payloads(altered)', 'qr-equal'],
  },
  {
    name: 'Arabic name reversed (wrong bidi order)',
    fixture: 'unicode/pre-shift-report',
    alter: async (f) =>
      chromiumRenderer.render(
        mutate(f.doc, (d) => {
          if (d.kind !== 'pre-shift-report') return;
          const row = d.data.staff.find((s) => /[\u0600-\u06ff]/.test(s.name))!;
          row.name = [...row.name].reverse().join('');
        }),
      ),
    mustFail: ['values-present(altered)', 'tokens'],
  },
];

describe('altered PDFs compare unequal (the checker catches differences)', () => {
  it.each(ALTERATIONS.map((a) => [a.name, a] as const))('%s', async (_name, alteration) => {
    const f = fixtures.get(alteration.fixture)!;
    const [original] = renders.get(alteration.fixture)!;
    const altered = await alteration.alter(f, original);
    saveArtifact(OUT, `${alteration.fixture}--altered--${alteration.name}`, 'pdf', altered);
    const r = compareExtractions(`ALTERED ${alteration.fixture}: ${alteration.name}`, expectationFor(f.doc), extractFixture(f, original), extractFixture(f, altered), ['original', 'altered']);
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
 * short) and nothing refuses it. `test.failing` keeps the suite green while the defect exists and turns RED the day
 * the amount is refused or printed exactly — then change it to a plain `it`.
 */
test.failing('pence adjacent to MAX_SAFE_INTEGER are refused or printed exactly', async () => {
  const f = fixtures.get('edge-values/approved-shift-statement-pence-1')!;
  const doc = mutate(f.doc, (d) => d.kind === 'approved-shift-statement' && ((d.data.amountPence = Number.MAX_SAFE_INTEGER), (d.data.payRatePence = Number.MAX_SAFE_INTEGER - 1)));
  const pdf = await chromiumRenderer.render(doc).catch(() => null);
  if (pdf === null) return; // refused: the required behaviour
  const parse = checkAgainstInput(expectationFor(doc), extractFixture(f, pdf), 'chromium').find((r) => r.check === 'parse-back(chromium)')!;
  expect(parse.detail).not.toMatch(/parses to/);
  expect(parse.ok).toBe(true);
});
