import { inspectPdfLayout, LayoutPage, TextRun } from '../../../__tests__/helpers/pdf-layout';
import { buildFixtures, FixtureDocument } from '../../../__tests__/pdf-equality/fixtures';
import { seamDocument } from '../../../__tests__/pdf-equality/renderers';
import { renderReportPdf, ReportDocument } from '../render-pdf.util';
import { shutdownRenderPool } from './runtime/render-pool';

/**
 * Owner decision D6 (approved WITH CONDITIONS, 2026-11-04) and "notes keep their line breaks", proven on the native
 * output of all three production documents, through the production seam (`renderReportPdf`, PDF_RENDERER=native,
 * render pool) and the position-aware PDF reader:
 *   - no name is truncated and no character disappears or is added: every name prints in full, character for
 *     character, and a hyphenated name wraps only after its OWN hyphen (no second "-");
 *   - nothing escapes the page: every text run lies inside the page box;
 *   - nothing overlaps: no two text runs on a page share any area (a long token or name never draws over a neighbour);
 *   - the shift notes keep their typed line breaks (pre-line) and every other field stays one flowing line.
 * Fixtures: the PDF equality harness's long-text and unbroken-token scenarios (80-character hyphenated names, a 10 KB
 * note, a 1,000-character token, an 80-character unbroken name), plus a variant with a hyphenated name
 * that has no space at all (88 characters; it can only wrap at its hyphens) and multi-line notes.
 */
jest.setTimeout(180_000);

const NO_SPACE_NAME = 'Fitzgerald-Montgomery-Worthington-Hohenzollern-Sigmaringen-Cholmondeley-Featherstonehaugh';
const NOTES_LINES = ['First line of the notes: arrive via the loading bay', 'Second line: bring photo ID', '', 'After a blank line: brief the team'];

const strip = (s: string) => s.replace(/\s+/g, '');
const tableKind = (d: ReportDocument) => d.kind === 'final-timesheet' || d.kind === 'pre-shift';

/** The same document with the no-space hyphenated name on its first staff row (or as the statement's staff name) and multi-line notes. */
function hyphenVariant(f: FixtureDocument): ReportDocument {
  const doc = seamDocument(f.doc);
  switch (doc.kind) {
    case 'final-timesheet':
      return { kind: doc.kind, data: { ...doc.data, notes: NOTES_LINES.join('\n'), staff: doc.data.staff.map((r, i) => (i === 0 ? { ...r, name: NO_SPACE_NAME } : r)) } };
    case 'pre-shift':
      return { kind: doc.kind, data: { ...doc.data, notes: NOTES_LINES.join('\n'), staff: doc.data.staff.map((r, i) => (i === 0 ? { ...r, name: NO_SPACE_NAME } : r)) } };
    case 'approved-shift-statement':
      return { kind: doc.kind, data: { ...doc.data, staffName: NO_SPACE_NAME } };
  }
}

/** Every name the document prints for a person (staff rows, the statement's staff and approver). */
function personNames(doc: ReportDocument): string[] {
  switch (doc.kind) {
    case 'final-timesheet':
    case 'pre-shift':
      return doc.data.staff.map((r) => r.name);
    case 'approved-shift-statement':
      return [doc.data.staffName, ...(doc.data.approvedByName ? [doc.data.approvedByName] : [])];
  }
}

const printed = (runs: readonly TextRun[]) => runs.filter((r) => r.text.trim().length > 0);

function outsidePage(page: LayoutPage): TextRun[] {
  return printed(page.runs).filter((r) => r.x < -0.5 || r.endX > page.width + 0.5 || r.y < -0.5 || r.y > page.height + 0.5);
}

/**
 * Pairs of text segments (a line's column-separated pieces: a cell, a footer half; adjacent glyph runs joined, so a
 * kerned pair such as "Te" is one piece) whose boxes (advance width × [baseline − 0.2 em, baseline + 0.75 em]) share
 * more than a hairline.
 */
function overlaps(page: LayoutPage): string[] {
  const segments = page.lines.flatMap((l) => l.segments).filter((s) => s.text.trim().length > 0);
  const boxes = segments.map((r) => ({ r, x0: r.x, x1: r.endX, y0: r.y - 0.2 * r.size, y1: r.y + 0.75 * r.size }));
  const out: string[] = [];
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!;
      const b = boxes[j]!;
      const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
      const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
      if (w > 0.5 && h > 0.5) out.push(`"${a.r.text.slice(0, 30)}" × "${b.r.text.slice(0, 30)}"`);
    }
  return out;
}

let fixtures: FixtureDocument[] = [];
const rendered = new Map<string, { doc: ReportDocument; pages: LayoutPage[] }>();

beforeAll(async () => {
  fixtures = await buildFixtures({ scenarios: ['long-text', 'unbroken-token'] });
  const docs: Array<[string, ReportDocument]> = [
    ...fixtures.map((f): [string, ReportDocument] => [f.id, seamDocument(f.doc)]),
    ...fixtures.filter((f) => f.scenario === 'long-text').map((f): [string, ReportDocument] => [`${f.id}+no-space-hyphenated-name`, hyphenVariant(f)]),
  ];
  for (const [id, doc] of docs) {
    const pdf = await renderReportPdf(doc, { PDF_RENDERER: 'native' });
    rendered.set(id, { doc, pages: inspectPdfLayout(pdf).pages });
  }
});

afterAll(() => shutdownRenderPool());

describe('D6 conditions on the native output of every document', () => {
  it('renders the fixtures (all three documents, both scenarios, plus the hyphen variants)', () => {
    const kinds = new Set([...rendered.values()].map((r) => r.doc.kind));
    expect([...kinds].sort()).toEqual(['approved-shift-statement', 'final-timesheet', 'pre-shift']);
    expect(rendered.size).toBeGreaterThanOrEqual(8);
  });

  it('no text escapes the page', () => {
    for (const [id, { pages }] of rendered) pages.forEach((p, n) => expect({ id, page: n + 1, outside: outsidePage(p).map((r) => r.text.slice(0, 40)) }).toEqual({ id, page: n + 1, outside: [] }));
  });

  it('no two text runs overlap (no table cell, name or token drawn over another)', () => {
    for (const [id, { pages }] of rendered) pages.forEach((p, n) => expect({ id, page: n + 1, overlaps: overlaps(p) }).toEqual({ id, page: n + 1, overlaps: [] }));
  });

  it('every name is printed in full, character for character (no truncation, nothing dropped or added)', () => {
    for (const [id, { doc, pages }] of rendered) {
      // Blocks: a wrapped cell's lines joined, so a name beside another column reads as one piece.
      const all = strip(pages.flatMap((p) => p.blocks.map((b) => b.text)).join(' '));
      for (const name of personNames(doc)) {
        // An over-long unbroken name may be force-broken with a visible "-" (accepted D6 delta): compare without the
        // break hyphens only when the name itself has no hyphen; a hyphenated name must print exactly.
        const hay = name.includes('-') ? all : all.replace(/-/g, '');
        expect({ id, name, found: hay.includes(strip(name)) }).toEqual({ id, name, found: true });
      }
    }
  });

  it('the no-space hyphenated name wraps only after its own hyphens, with no second "-"', () => {
    const variants = [...rendered].filter(([id]) => id.endsWith('+no-space-hyphenated-name'));
    expect(variants.length).toBeGreaterThanOrEqual(3);
    for (const [id, { doc, pages }] of variants) {
      const block = pages.flatMap((p) => p.blocks).find((b) => strip(b.lines.join('')).includes(NO_SPACE_NAME));
      expect({ id, block: Boolean(block) }).toEqual({ id, block: true });
      if (tableKind(doc)) {
        // In the narrow Staff column it cannot fit on one line: it wraps, and every line but the last ends in one of
        // the name's own hyphens; the lines put together are the name exactly (no "--", no forced break, nothing lost).
        const nameParts: string[] = [];
        let acc = '';
        for (const line of block!.lines.map((l) => l.trim())) {
          if (acc === NO_SPACE_NAME) break;
          acc += line;
          nameParts.push(line);
        }
        expect(acc).toBe(NO_SPACE_NAME);
        expect(nameParts.length).toBeGreaterThan(1);
        for (const p of nameParts.slice(0, -1)) expect(p.endsWith('-') && !p.endsWith('--')).toBe(true);
      }
    }
  });

  it('the notes keep their typed line breaks (pre-line); each line is its own printed line, in order', () => {
    const variants = [...rendered].filter(([id, r]) => id.endsWith('+no-space-hyphenated-name') && tableKind(r.doc));
    expect(variants.length).toBeGreaterThanOrEqual(2);
    for (const [id, { pages }] of variants) {
      const lines = pages.flatMap((p) => p.lines.flatMap((l) => l.segments.map((s) => s.text.trim())));
      const at = NOTES_LINES.filter(Boolean).map((t) => lines.indexOf(t));
      expect({ id, at: at.map((i) => i >= 0) }).toEqual({ id, at: at.map(() => true) });
      expect([...at].sort((a, b) => a - b)).toEqual(at);
    }
  });
});

describe('the geometry checks catch what they claim to (positive controls)', () => {
  const page = (segments: Array<{ x: number; endX: number; y: number; text: string }>): LayoutPage => ({
    width: 595,
    height: 842,
    runs: segments.map((s) => ({ ...s, size: 10 })),
    lines: segments.map((s) => ({ y: s.y, size: 10, text: s.text, segments: [{ ...s, size: 10 }] })),
    blocks: [],
    images: [],
  });

  it('two cells drawn over each other are an overlap; side by side and stacked lines are not', () => {
    expect(overlaps(page([{ x: 0, endX: 50, y: 100, text: 'name' }, { x: 40, endX: 90, y: 100, text: 'ref' }]))).toHaveLength(1);
    expect(overlaps(page([{ x: 0, endX: 50, y: 100, text: 'name' }, { x: 50, endX: 90, y: 100, text: 'ref' }]))).toHaveLength(0);
    expect(overlaps(page([{ x: 0, endX: 50, y: 100, text: 'line 1' }, { x: 0, endX: 50, y: 88, text: 'line 2' }]))).toHaveLength(0);
  });

  it('a run past the right edge or below the page is outside it', () => {
    expect(outsidePage(page([{ x: 560, endX: 600, y: 100, text: 'over' }]))).toHaveLength(1);
    expect(outsidePage(page([{ x: 10, endX: 60, y: -4, text: 'below' }]))).toHaveLength(1);
    expect(outsidePage(page([{ x: 10, endX: 585, y: 100, text: 'inside' }]))).toHaveLength(0);
  });
});
