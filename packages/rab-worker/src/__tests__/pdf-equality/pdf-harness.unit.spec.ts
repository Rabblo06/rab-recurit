import { readFileSync } from 'fs';
import { join } from 'path';

import { layoutLines, TextRun } from '../helpers/pdf-layout';
import { checkAgainstDocument, checkAgainstInput, compareExtractions, countValue, forcedBreakOccurrences, lineBreakProblems, markerFieldCount, permutedOccurrences } from './checker';
import { DOCUMENT_FILES, DOCUMENT_SPECS, DocumentExpectation, DocumentKind } from './documents';
import { Continuation, overlappingRuns, pageContinuations, PdfExtraction } from './extract';
import { loadGlyphTransform } from './glyph-transform';
import { F_PDF_1_PRESENT, NOTES_LINE_BREAKS_IN_TEMPLATE } from './known-findings';
import { equalityMode } from './mode';
import { footerTexts, htmlText, htmlTextNodes, joinLineBreaks, markerOccurrences, tokensJoiningForcedBreaks } from './native-reference';
import { guardNetwork, NetworkDeniedError, renderGuarded } from './network-guard';

// The real module object (what the guard patches), not an `import * as` copy.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const net = require('net') as typeof import('net');

/**
 * Regression self-tests of the harness's own extraction and matching (no rendering, no browser). Each pins a fix made
 * after the first Linux CI run of ci-pdf-equality (2026-11-04) and proves the fix did not make the oracle blind.
 *
 *   bash C:/rab-ai-wt/setup/heavy-run.sh pdf-tests npx jest -c packages/rab-worker/src/__tests__/pdf-equality/jest.config.ts pdf-harness.unit
 */

/** Runs of one line at y = 100, drawn left to right at the given x, 5 pt per character. */
function line(pieces: Array<[number, string]>): TextRun[] {
  return pieces.map(([x, text]) => ({ text, x, y: 100, endX: x + 5 * [...text].length, size: 10 }));
}

/** A minimal extraction: one page per entry, each a list of lines (one block per line). */
function extraction(pages: string[][], continuations: Continuation[] = []): PdfExtraction {
  return {
    pageCount: pages.length,
    pages: pages.map((lines, i) => ({
      number: i + 1,
      lines,
      lineSegments: lines.map((l) => [l]),
      text: lines.join('\n'),
      blocks: lines,
      blockLines: lines.map((l) => [l]),
      footer: null,
      footerNumbering: null,
      tableHeaderLines: [],
      imagePlacements: 0,
    })),
    text: pages.map((p) => p.join('\n')).join('\n\f\n'),
    imageCount: 0,
    images: [],
    qrPayloads: [],
    continuations,
    activeContentKeys: [],
    outOfPageRuns: pages.map(() => 0),
    overlaps: pages.map(() => []),
    pageSizes: pages.map((): [number, number] => [595, 842]),
    oracle: { pageCount: pages.length, images: [], agrees: true, detail: '' },
  };
}

describe('right-to-left runs read in logical order (pdf-layout logicalOrder)', () => {
  it('a three-word Arabic name drawn as one run per word, right to left, reads logically', () => {
    // Skia draws "محمد عبد الله" as الله | ' ' | عبد | ' ' | محمد from left to right.
    const [l] = layoutLines(line([[0, 'الله'], [20, ' '], [25, 'عبد'], [40, ' '], [45, 'محمد']]));
    expect(l!.text).toBe('محمد عبد الله');
  });

  it('LTR text around an RTL phrase stays put; punctuation after the phrase keeps the paragraph direction', () => {
    // Logical "Croeso مرحبا بكم. Bring": visual Croeso | بكم | مرحبا | . Bring
    const [l] = layoutLines(line([[0, 'Croeso'], [30, ' '], [35, 'بكم'], [50, ' '], [55, 'مرحبا'], [80, '.'], [85, ' '], [90, 'Bring']]));
    expect(l!.text).toBe('Croeso مرحبا بكم. Bring');
  });

  it('pure left-to-right lines are unchanged, including implied spaces from gaps', () => {
    const [l] = layoutLines(line([[0, 'Total'], [27, 'worked'], [60, 'hours:'], [92, '4h'], [104, '30m']]));
    expect(l!.text).toBe('Total worked hours: 4h 30m');
  });

  it('a character-reversed Arabic name is NOT turned back into the original (the reorder is not blind)', () => {
    const reversed = [...'محمد عبد الله'].reverse().join(''); // "هللا دبع دمحم", what the bidi alteration renders
    const words = reversed.split(' ');
    // Drawn right to left: last logical word leftmost.
    const [l] = layoutLines(line([[0, words[2]!], [20, ' '], [25, words[1]!], [40, ' '], [45, words[0]!]]));
    expect(l!.text).toBe(reversed);
    expect(l!.text).not.toBe('محمد عبد الله');
  });
});

describe('values over a page break (extract pageContinuations + checker countValue)', () => {
  const block = (x: number, top: number, bottom: number, text: string) => ({ x, top, bottom, text });

  it('chains the lowest block of a page to the highest of the next page in the same column, footer excluded', () => {
    const c = pageContinuations([
      { blocks: [block(34.5, 553, 53, 'Paragraph 35: arrive via the'), block(436.5, 553, 400, 'Sign-off'), block(34, 16, 16, 'Footer · Page 1 of 2')], footerY: 16, hasTableHeader: false },
      { blocks: [block(34.5, 553, 266, 'loading bay. Corrected entries: 0'), block(34, 16, 16, 'Footer · Page 2 of 2')], footerY: 16, hasTableHeader: false },
    ]);
    expect(c).toEqual([{ pages: [1, 2], parts: ['Paragraph 35: arrive via the', 'loading bay. Corrected entries: 0'] }]);
  });

  it('chains over three pages when the middle page is one flowing block', () => {
    const c = pageContinuations([
      { blocks: [block(30, 500, 50, 'a b')], footerY: null, hasTableHeader: false },
      { blocks: [block(30, 550, 40, 'c d')], footerY: null, hasTableHeader: false },
      { blocks: [block(30, 550, 300, 'e f')], footerY: null, hasTableHeader: false },
    ]);
    expect(c).toEqual([{ pages: [1, 2, 3], parts: ['a b', 'c d', 'e f'] }]);
  });

  it('does not chain into a page that repeats the table header (rows never split), nor across columns', () => {
    expect(
      pageContinuations([
        { blocks: [block(68, 120, 80, 'Row 4 name')], footerY: null, hasTableHeader: true },
        { blocks: [block(68, 524, 500, 'Row 5 name')], footerY: null, hasTableHeader: true },
      ]),
    ).toEqual([]);
    expect(
      pageContinuations([
        { blocks: [block(34.5, 300, 50, 'left column')], footerY: null, hasTableHeader: false },
        { blocks: [block(436.5, 550, 400, 'right column')], footerY: null, hasTableHeader: false },
      ]),
    ).toEqual([]);
  });

  it('counts a value that straddles the break exactly once, and never double-counts one inside a part', () => {
    const parts = ['NOTES Paragraph 1: arrive via the loading', 'bay, sign the visitor book. Paragraph 2: collect lanyards'];
    const x = extraction([[parts[0]!], [parts[1]!]], [{ pages: [1, 2], parts }]);
    expect(countValue(x, 'Paragraph 1: arrive via the loading bay, sign the visitor book.')).toBe(1);
    expect(countValue(x, 'Paragraph 2: collect lanyards')).toBe(1); // inside part 2 only
    expect(countValue(x, 'Paragraph 1: arrive via the loading bay, sign the visitor BOOK.')).toBe(0); // one character off
    // Without the continuation the straddling value is not found: the chain is what finds it.
    expect(countValue(extraction([[parts[0]!], [parts[1]!]]), 'Paragraph 1: arrive via the loading bay, sign the visitor book.')).toBe(0);
  });
});

describe('values with explicit bidi controls (checker permutedOccurrences)', () => {
  const value = 'Isolates[\u2066a\u2067b\u2068c\u2069] RLO[\u202Egnp.exe]';
  // What Chromium on Linux prints for it (CI, 2026-11-04): the unterminated RLI and the RLO reorder the runs.
  const printedOnLinux = 'Isolates[\u2066a\u2067\u202Egnp.exe][b\u2068c\u2069] RLO';

  it('is found once when its characters are printed contiguously in the order the bidi controls produce', () => {
    expect(countValue(extraction([[`${printedOnLinux} REF-14`]]), value)).toBe(1);
    expect(countValue(extraction([[value]]), value)).toBe(1); // logical order still counts
  });

  it('is NOT found when one character is missing, changed or added, or when it is not contiguous', () => {
    expect(countValue(extraction([[printedOnLinux.replace('p', '')]]), value)).toBe(0);
    expect(countValue(extraction([[printedOnLinux.replace('p', 'q')]]), value)).toBe(0);
    expect(countValue(extraction([['Isolates[agnp.exe] [bc] RL', 'O']]), value)).toBe(0); // split over two lines and blocks
  });

  it('counts every printing (non-overlapping windows)', () => {
    expect(permutedOccurrences('abcXcbaYbac', 'abc')).toBe(3);
    expect(permutedOccurrences('aabbcc', 'abc')).toBe(0);
  });

  it('a value WITHOUT bidi controls still has to be printed in order', () => {
    expect(countValue(extraction([['Morgan Manager']]), 'Manager Morgan')).toBe(0);
    expect(countValue(extraction([['naMorgan Mager']]), 'Morgan Manager')).toBe(0);
  });
});

/** One page whose blocks are given as their lines (for line-end rules). */
function blockExtraction(blocks: string[][]): PdfExtraction {
  const x = extraction([blocks.flat()]);
  x.pages[0]!.blocks = blocks.map((ls) => ls.join(' '));
  x.pages[0]!.blockLines = blocks;
  return x;
}

describe('F1 on the native side: □ for each unprintable character (owner decision F1)', () => {
  const nativeValue = 'Nul□l By□te'; // F1 of "Nul\u0000l By\u0000te"

  it('the □ is required, character for character: a wrong character or a missing □ fails', () => {
    expect(countValue(extraction([[`row 5 ${nativeValue} REF-4`]]), nativeValue)).toBe(1);
    expect(countValue(extraction([['row 5 Nul?l By□te REF-4']]), nativeValue)).toBe(0); // another character in its place
    expect(countValue(extraction([['row 5 Null By□te REF-4']]), nativeValue)).toBe(0); // the □ missing
    expect(countValue(extraction([['row 5 Nul\u0000l By□te REF-4']]), nativeValue)).toBe(0); // the raw NUL printed (invisible)
    expect(countValue(extraction([['row 5 Nul□□l By□te REF-4']]), nativeValue)).toBe(0); // one □ too many
  });

  it('the transform is the runtime GlyphCoverage (when this tree has the native renderer)', async () => {
    const glyphs = await loadGlyphTransform();
    if ('unavailable' in glyphs) {
      expect(glyphs.unavailable).toMatch(/no native glyph-coverage runtime/);
      return;
    }
    expect(glyphs.marker).toBe('□');
    const [nul, arabic, emoji, crlf, latin] = await glyphs.transform(['Nul\u0000l', 'محمد', 'Chef 👩‍🍳', 'a\r\nb\tc', 'Zażółć Ŵyn']);
    expect(nul).toBe('Nul□l');
    expect(arabic).toBe('□□□□');
    expect(emoji).toBe('Chef □□□');
    expect(crlf).toBe('a\nb c');
    expect(latin).toBe('Zażółć Ŵyn');
  });
});

describe("react-pdf's forced-break hyphen (native side only)", () => {
  it('a "-" that ends a line inside a block may be skipped when the value has none there', () => {
    const x = blockExtraction([['Token: A1b2C3-', 'd4E5A1b2-', 'C3d4E5']]);
    expect(countValue(x, 'Token: A1b2C3d4E5A1b2C3d4E5', { forcedBreakHyphens: true })).toBe(1);
    expect(countValue(x, 'Token: A1b2C3d4E5A1b2C3d4E5')).toBe(0); // Chromium side: never optional
  });

  it('a hyphen that IS in the value is required: present in the PDF passes, missing from it fails', () => {
    expect(countValue(blockExtraction([['Montgomery Worthington-', 'Smythe III']]), 'Worthington-Smythe', { forcedBreakHyphens: true })).toBe(1);
    expect(countValue(blockExtraction([['Montgomery Worthington', 'Smythe III']]), 'Worthington-Smythe', { forcedBreakHyphens: true })).toBe(0);
  });

  it('only a hyphen at the END of a line, with the block carrying on, is optional', () => {
    expect(forcedBreakOccurrences(['ab-c', 'd'], 'abcd')).toBe(0); // mid-line
    expect(forcedBreakOccurrences(['ab', 'cd-'], 'abcd')).toBe(1); // last line: its hyphen is not skipped, just not needed
    expect(forcedBreakOccurrences(['ab', 'cd-'], 'abcd-x')).toBe(0);
    expect(countValue(blockExtraction([['Token: A1b2C3-'], ['d4E5']]), 'Token: A1b2C3d4E5', { forcedBreakHyphens: true })).toBe(0); // two blocks
    expect(forcedBreakOccurrences(['xA1-', 'B2yA1-', 'B2'], 'A1B2')).toBe(2);
  });

  it('words: a forced break is joined only when the document has the word without the hyphen', () => {
    const x = blockExtraction([['Token: A1b2-', 'C3d4-', 'E5 end'], ['Worthington-', 'Smythe']]);
    const words = tokensJoiningForcedBreaks(x, ['Token:', 'A1b2C3d4E5', 'end', 'Worthington-Smythe']).sort();
    expect(words).toEqual(['A1b2C3d4E5', 'Smythe', 'Token:', 'Worthington-', 'end'].sort()); // the real hyphen is NOT joined away
  });
});

describe('F-PDF-1 interplay: native counted against the document, not against Chromium', () => {
  const expect_: DocumentExpectation = {
    kind: 'final-timesheet',
    spec: { ...DOCUMENT_SPECS['final-timesheet'], tableHeader: null, hasFooter: false },
    values: [{ label: 'row 1 worked; total', value: '4h 30m', min: 1 }],
    qrPayloads: [],
    rowMarkers: [],
    multiLine: [],
    parseBack: { durations: [], breaks: [], fields: [] },
  };
  const chromium = extraction([['row 1 4h 30m']]); // the total is clipped away (F-PDF-1)
  const native = extraction([['row 1 4h 30m', 'Total worked hours: 4h 30m']]);
  const ref = (n: number, words: string[]) => ({ label: 'document', count: () => n, tokens: words });
  const words = ['row', '1', '4h', '30m', 'Total', 'worked', 'hours:', '4h', '30m'];
  const check = (r: ReturnType<typeof compareExtractions>, name: string) => r.findings.find((f) => f.check === name)!;

  it('equal to the document passes even though Chromium printed it once', () => {
    const r = compareExtractions('t', expect_, chromium, native, ['chromium', 'native'], { referenceB: ref(2, words) });
    expect(check(r, 'values-equal').ok).toBe(true);
    expect(check(r, 'tokens').ok).toBe(true);
  });

  it('a native count or word that differs from the document still fails', () => {
    const r = compareExtractions('t', expect_, chromium, native, ['chromium', 'native'], { referenceB: ref(3, [...words, 'extra']) });
    expect(check(r, 'values-equal').ok).toBe(false);
    expect(check(r, 'tokens').ok).toBe(false);
  });

  it('without a reference, native is compared with Chromium (and the clipped total is a difference)', () => {
    expect(check(compareExtractions('t', expect_, chromium, native), 'values-equal').ok).toBe(false);
  });

  it('a value that F1 makes all □ is count-compared exactly, as a whole field (no longer exempt)', () => {
    const e = (value: string): DocumentExpectation => ({ ...expect_, values: [{ label: 'v', value, min: 1 }] });
    const x = extraction([['□□ □□□ Kraków □']]); // "□ □□" is NOT printed as a field here: only inside longer marker runs
    const opaque = compareExtractions('t', e('□ □□'), x, x, ['chromium', 'native'], { referenceB: ref(1, ['□□', '□□□', 'Kraków', '□']) });
    expect(check(opaque, 'values-equal').ok).toBe(false);
    expect(check(opaque, 'values-equal').detail).not.toMatch(/not count-compared/);
    expect(check(opaque, 'values-present(native)').ok).toBe(false);
    const printed = extraction([['□ □□', 'Kraków □']]);
    const ok = compareExtractions('t', e('□ □□'), printed, printed, ['chromium', 'native'], { referenceB: ref(1, ['□', '□□', 'Kraków', '□']) });
    expect(check(ok, 'values-equal').ok).toBe(true);
    expect(check(ok, 'values-present(native)').ok).toBe(true);
    const twice = compareExtractions('t', e('□ □□'), printed, printed, ['chromium', 'native'], { referenceB: ref(2, ['□', '□□', 'Kraków', '□']) });
    expect(check(twice, 'values-equal').ok).toBe(false); // the document prints it twice, the render once
  });

  it("the document's text-transform: uppercase classes are applied, as the template prints them", () => {
    const html = '<html><head><style>.doc-title { font-weight: 700; text-transform: uppercase; } .x { color: red; }</style></head><body><div class="doc-title">Final timesheet</div><div class="x">Kept</div></body></html>';
    expect(htmlText(html).replace(/\s+/g, ' ').trim()).toBe('FINAL TIMESHEET Kept');
  });

  it('the document text is the HTML body (no <title>, entities decoded) plus the footer once per page', () => {
    const t = htmlText('<html><head><title>Venue X</title></head><body><p>Total worked hours: 4h 30m</p><p>Tom &amp; Jerry&#x3C;b&#62;</p></body></html>');
    expect(t).not.toContain('Venue X');
    expect(t.replace(/\s+/g, ' ')).toContain('Total worked hours: 4h 30m');
    expect(t).toContain('Tom & Jerry<b>');
    expect(footerTexts('<div><span>WS</span> Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>', 2).map((s) => s.replace(/\s+/g, ' ').trim())).toEqual([
      'WS Page 1 of 2',
      'WS Page 2 of 2',
    ]);
  });
});

describe('network guard (network-guard.ts)', () => {
  it('deny mode refuses and records net.connect, Socket#connect, http.get and fetch; restore() puts the originals back', async () => {
    const before = { connect: net.connect, socketConnect: net.Socket.prototype.connect, fetch: globalThis.fetch };
    const guard = guardNetwork('deny');
    try {
      expect(() => net.connect(9, '127.0.0.1')).toThrow(NetworkDeniedError);
      expect(() => new net.Socket().connect(9, '127.0.0.1')).toThrow(NetworkDeniedError);
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      expect(() => (require('http') as typeof import('http')).get('http://127.0.0.1:9/x')).toThrow(NetworkDeniedError);
      if (typeof globalThis.fetch === 'function') expect(() => globalThis.fetch('http://127.0.0.1:9/f')).toThrow(NetworkDeniedError);
      expect(guard.attempts.map((a) => a.api)).toEqual(expect.arrayContaining(['net.connect', 'net.Socket.connect', 'http.get']));
    } finally {
      guard.restore();
    }
    expect(net.connect).toBe(before.connect);
    expect(net.Socket.prototype.connect).toBe(before.socketConnect);
    expect(globalThis.fetch).toBe(before.fetch);
  });

  it('record mode lets the call through and records it; renderGuarded returns the attempts', async () => {
    const { attempts } = await renderGuarded('record', async () => {
      const s = net.connect({ port: 9, host: '127.0.0.1' });
      s.on('error', () => undefined);
      s.destroy();
      return Buffer.from('%PDF-');
    });
    expect(attempts.map((a) => a.api)).toContain('net.connect');
  });
});

/** One page whose lines are given as their column segments (one cell / field each). */
function segmentExtraction(lines: string[][]): PdfExtraction {
  const x = extraction([lines.map((segments) => segments.join(' '))]);
  x.pages[0]!.lineSegments = lines;
  return x;
}

/** The 166×70 logo, so a synthetic extraction passes `logo-166x70`. */
function withLogo(x: PdfExtraction): PdfExtraction {
  x.images = [{ width: 166, height: 70, placements: 1, undecodable: null, qrPayload: null }];
  x.imageCount = 1;
  return x;
}

const findingOf = (r: { findings: Array<{ check: string; ok: boolean; info?: boolean; detail: string }> }, check: string) => r.findings.find((f) => f.check === check)!;

describe('□-name assertion: F1 marker values are counted exactly, as whole fields (owner instruction, FINAL brief)', () => {
  it('a marker-only value is a whole field, or whole tokens next to visible text — never part of a longer marker run', () => {
    expect(markerOccurrences('□ □□', '□ □□')).toBe(1);
    expect(markerOccurrences('Staff: □ □□ (ŚT-2012)', '□ □□')).toBe(1);
    expect(markerOccurrences('□□ □□□', '□ □□')).toBe(0);
    expect(markerOccurrences('C1[□□] Lone[□]surrogate', '□□')).toBe(0);
    expect(markerOccurrences('C1[□□] Lone[□]surrogate', '□')).toBe(0);
    expect(markerOccurrences('□□ □ □□', '□ □□')).toBe(0); // next to another marker token: ambiguous, so not a printing
    expect(markerOccurrences('□ □□', '□□')).toBe(0);
    expect(markerOccurrences('□ □□ and □ □□', '□ □□')).toBe(2);
  });

  it('a value mixing markers and visible text is anchored by the text, and its edge markers may not be extended', () => {
    expect(markerOccurrences('Chef □□□ Emoji □', 'Chef □□□ Emoji □')).toBe(1);
    expect(markerOccurrences('Chef □□□□ Emoji □', 'Chef □□□ Emoji □')).toBe(0); // one marker too many
    expect(markerOccurrences('Chef □□ Emoji □', 'Chef □□□ Emoji □')).toBe(0); // one marker missing
    expect(markerOccurrences('Emoji □□', 'Emoji □')).toBe(0);
    expect(markerOccurrences('row 5 Nul□l By□te REF-4', 'Nul□l By□te')).toBe(1);
  });

  it('fields are located by line and x position: a value is never matched across two neighbouring cells', () => {
    expect(markerFieldCount(segmentExtraction([['□', '□□', 'ŚT-2012']]), '□ □□')).toBe(0); // two cells "□" | "□□"
    expect(markerFieldCount(segmentExtraction([['□ □□', 'ŚT-2012'], ['□ □□', 'ŚT-2014']]), '□ □□')).toBe(2); // two rows, exact
    expect(markerFieldCount(segmentExtraction([['□□', '□ □□']]), '□□')).toBe(1); // the first cell only
    // countValue (values-present, values-equal) uses this for every value holding □.
    expect(countValue(segmentExtraction([['□', '□□', 'ŚT-2012']]), '□ □□')).toBe(0);
    expect(countValue(segmentExtraction([['□ □□', 'ŚT-2012']]), '□ □□')).toBe(1);
  });

  it('a field wrapped over whole lines of one cell counts once; part of a cell does not', () => {
    const x = blockExtraction([['□', '□□'], ['□□ □', '□□ x']]);
    expect(markerFieldCount(x, '□ □□')).toBe(1);
    expect(markerFieldCount(blockExtraction([['□□', '□']]), '□ □□')).toBe(0); // "□□ □" is not "□ □□"
    // A forced break inside a long value (react-pdf's "-") may stand for nothing — native side only, whole lines only.
    const forced = blockExtraction([['C1[□□] Lone[□]sur-', 'rogate']]);
    expect(markerFieldCount(forced, 'C1[□□] Lone[□]surrogate', { forcedBreakHyphens: true })).toBe(1);
    expect(markerFieldCount(forced, 'C1[□□] Lone[□]surrogate')).toBe(0);
    expect(markerFieldCount(forced, 'C1[□□] Lone[□]surogate', { forcedBreakHyphens: true })).toBe(0);
  });

  it('unsupported-glyph detection is not weakened: the raw characters (no marker), a lost space or a missing marker fail', () => {
    expect(countValue(segmentExtraction([['王 小明', 'ŚT-2012']]), '□ □□')).toBe(0);
    expect(countValue(segmentExtraction([['□□□', 'ŚT-2012']]), '□ □□')).toBe(0);
    expect(countValue(segmentExtraction([['□ □', 'ŚT-2012']]), '□ □□')).toBe(0);
  });

  it('the document reference counts the same way, over its HTML text nodes (one field each)', () => {
    expect(htmlTextNodes('<body><td>王 小明</td><td>ŚT-2012</td><div>x<b>y &amp; z</b></div></body>')).toEqual(['王 小明', 'ŚT-2012', 'x', 'y & z']);
  });
});

describe('D6 hyphen wrap: accepted only when the joined text is identical and every other check passes', () => {
  const name = 'Maximilian Montgomery-Fitzgerald Worthington-Smythe III';
  const words = ['Maximilian', 'Montgomery-Fitzgerald', 'Worthington-Smythe', 'III', 'REF-1'];
  const e: DocumentExpectation = {
    kind: 'final-timesheet',
    spec: { ...DOCUMENT_SPECS['final-timesheet'], tableHeader: null, hasFooter: false },
    values: [{ label: 'row 1 name', value: name, min: 1 }],
    qrPayloads: [],
    rowMarkers: [],
    multiLine: [],
    parseBack: { durations: [], breaks: [], fields: [] },
  };
  const chromiumWrapped = () => withLogo(blockExtraction([['Maximilian Montgomery-Fitzgerald Worthington-', 'Smythe III'], ['REF-1']]));
  const nativeWhole = () => withLogo(blockExtraction([['Maximilian Montgomery-Fitzgerald', 'Worthington-Smythe III'], ['REF-1']]));
  const opts = { documentWords: { a: words, b: words }, forcedBreakHyphens: ['native'] };

  it('Chromium "Worthington-" + "Smythe" equals native "Worthington-Smythe": accepted, and reported as D6', () => {
    const r = compareExtractions('t', e, chromiumWrapped(), nativeWhole(), ['chromium', 'native'], opts);
    expect(findingOf(r, 'tokens').ok).toBe(true);
    expect(findingOf(r, 'tokens').detail).toMatch(/^D6 hyphen wrap: /);
    expect(findingOf(r, 'd6-hyphen-wrap')).toMatchObject({ ok: true, info: true });
    expect(r.ok).toBe(true);
  });

  it('the other way round (native breaks at the existing hyphen) is accepted the same way', () => {
    const r = compareExtractions('t', e, nativeWhole(), chromiumWrapped(), ['chromium', 'native'], opts);
    expect(findingOf(r, 'tokens').ok).toBe(true);
    expect(r.ok).toBe(true);
  });

  it('a truncated name fails: native "Worthington-Smyth", or the wrapped pieces "Worthington-" + "Smyth"', () => {
    const truncated = withLogo(blockExtraction([['Maximilian Montgomery-Fitzgerald', 'Worthington-Smyth III'], ['REF-1']]));
    const r = compareExtractions('t', e, chromiumWrapped(), truncated, ['chromium', 'native'], opts);
    expect(findingOf(r, 'tokens').ok).toBe(false);
    expect(findingOf(r, 'values-present(native)').ok).toBe(false);
    const wrappedTruncated = withLogo(blockExtraction([['Maximilian Montgomery-Fitzgerald Worthington-', 'Smyth III'], ['REF-1']]));
    const r2 = compareExtractions('t', e, nativeWhole(), wrappedTruncated, ['chromium', 'native'], opts);
    expect(findingOf(r2, 'tokens').ok).toBe(false);
    expect(r2.ok).toBe(false);
  });

  it('a dropped character fails, on either side of the hyphen', () => {
    for (const printed of ['Worthngton-Smythe', 'Worthington-Smyte', 'WorthingtonSmythe']) {
      const native = withLogo(blockExtraction([['Maximilian Montgomery-Fitzgerald', `${printed} III`], ['REF-1']]));
      const r = compareExtractions('t', e, chromiumWrapped(), native, ['chromium', 'native'], opts);
      expect(findingOf(r, 'tokens').ok).toBe(false);
      expect(r.ok).toBe(false);
    }
  });

  it('without the document words no line break is rejoined, so the difference fails (it is never accepted silently)', () => {
    const r = compareExtractions('t', e, chromiumWrapped(), nativeWhole(), ['chromium', 'native'], { forcedBreakHyphens: ['native'] });
    expect(findingOf(r, 'tokens').ok).toBe(false);
  });

  it('D6 is NOT accepted when another check fails (here: text drawn over other text); the tokens finding names it', () => {
    const native = nativeWhole();
    native.overlaps = [[{ a: 'Worthington-Smythe', b: 'REF-1', overlapX: 12, dy: 0 }]];
    const r = compareExtractions('t', e, chromiumWrapped(), native, ['chromium', 'native'], opts);
    expect(findingOf(r, 'no-overlap(native)').ok).toBe(false);
    expect(findingOf(r, 'tokens').ok).toBe(false);
    expect(findingOf(r, 'tokens').detail).toMatch(/D6 hyphen-wrap difference NOT accepted: other checks fail \(no-overlap\(native\)\)/);
    expect(r.findings.some((f) => f.check === 'd6-hyphen-wrap')).toBe(false);
  });

  it('a hyphen that is not in the document is never joined as D6', () => {
    const x = blockExtraction([['Reviewed by Morgan Duty-', 'Manager today']]);
    expect(joinLineBreaks(x, ['Reviewed', 'by', 'Morgan', 'Duty', 'Manager', 'today'], { forcedBreaks: false, d6: true }).d6).toEqual([]);
    expect(joinLineBreaks(x, ['Reviewed', 'by', 'Morgan', 'Duty-Manager', 'today'], { forcedBreaks: false, d6: true }).d6).toEqual(['Duty-Manager']);
  });

  it("Chromium's unhyphenated overflow-wrap break of a long token rejoins (not D6); whole words never merge", () => {
    const token = 'A1b2C3d4E5'.repeat(3);
    const x = blockExtraction([[`Token: ${token.slice(0, 12)}`, token.slice(12, 25), `${token.slice(25)} end`], ['go in', 'to town']]);
    const doc = ['Token:', token, 'end', 'go', 'in', 'to', 'town', 'into'];
    const joined = joinLineBreaks(x, doc, { forcedBreaks: false, d6: true, unhyphenated: true });
    expect([...joined.tokens].sort()).toEqual(['Token:', token, 'end', 'go', 'in', 'to', 'town'].sort());
    expect(joined.d6).toEqual([]);
    const truncated = blockExtraction([[`Token: ${token.slice(0, 12)}`, token.slice(13, 25), `${token.slice(25)} end`]]); // one character dropped
    expect(joinLineBreaks(truncated, doc, { forcedBreaks: false, d6: true, unhyphenated: true }).tokens).not.toContain(token);
    expect(joinLineBreaks(x, doc, { forcedBreaks: false, d6: true }).tokens).not.toContain(token); // off unless asked
  });

  it('native-only mode (checkAgainstDocument) applies the same rule against the document, never against Chromium', () => {
    const reference = { label: 'document', count: (v: string) => (v === name ? 1 : 0), tokens: words, footers: [] };
    const r = checkAgainstDocument('t', e, chromiumWrapped(), 'native', reference, { images: 1, forcedBreakHyphens: ['native'] });
    expect(findingOf(r, 'tokens').ok).toBe(true);
    expect(findingOf(r, 'd6-hyphen-wrap')).toMatchObject({ ok: true, info: true });
    expect(r.ok).toBe(true);
    const truncated = withLogo(blockExtraction([['Maximilian Montgomery-Fitzgerald Worthington-', 'Smyth III'], ['REF-1']]));
    expect(checkAgainstDocument('t', e, truncated, 'native', reference, { images: 1, forcedBreakHyphens: ['native'] }).ok).toBe(false);
  });
});

describe('text drawn over other text (extract overlappingRuns; checker no-overlap)', () => {
  const run = (text: string, x: number, y: number, size = 10) => ({ text, x, y, endX: x + 5 * [...text].length, size });

  it('two runs on one baseline that intersect overlap; touching or kerned runs do not', () => {
    expect(overlappingRuns([run('Hello', 0, 100), run('World', 15, 100)])).toHaveLength(1);
    expect(overlappingRuns([run('Hello', 0, 100), run('World', 25, 100)])).toEqual([]);
    expect(overlappingRuns([run('Hello', 0, 100), run('World', 24.5, 100)])).toEqual([]);
  });

  it('a kerned pair drawn glyph by glyph (the measured "Y" / "," at 16.5 pt, 1.1 pt kern) is ONE piece of text, not an overlap', () => {
    // As pdfkit and Skia both drew it on long-text page 1 (runs consecutive in the content stream, one baseline).
    const y = { text: 'Y', x: 100, endX: 111, y: 484.83, size: 16.5 };
    const comma = { text: ',', x: 109.9, endX: 114.48, y: 484.83, size: 16.5 };
    expect(overlappingRuns([y, comma])).toEqual([]);
    // Teeth: the same two glyphs are an overlap when they are NOT one continued piece of text — drawn apart in the
    // stream (another run in between), or the second starting further back than a kern (one cell running into another).
    const elsewhere = { text: 'Other', x: 300, endX: 340, y: 200, size: 10 };
    expect(overlappingRuns([y, elsewhere, comma])).toHaveLength(1);
    expect(overlappingRuns([run('Long cell text', 0, 100), run('Next', 50, 100)])).toHaveLength(1); // starts 20 pt back
    expect(overlappingRuns([run('Hello', 0, 100), run('Wor', 25, 100), run('ld', 40, 100), run('Hello', 30, 100)])).toHaveLength(1);
  });

  it('a line drawn into the line above overlaps; ordinary line spacing does not; blank runs never count', () => {
    expect(overlappingRuns([run('abcdef', 0, 100), run('ghijkl', 0, 97)])).toHaveLength(1);
    expect(overlappingRuns([run('abcdef', 0, 100), run('ghijkl', 0, 88)])).toEqual([]);
    expect(overlappingRuns([run('abcdef', 0, 100), run('      ', 0, 100)])).toEqual([]);
  });

  it('is a failure for the native renderer and INFO for Chromium', () => {
    const x = extraction([['a']]);
    x.overlaps = [[{ a: 'a', b: 'b', overlapX: 5, dy: 0 }]];
    const e: DocumentExpectation = { kind: 'approved-shift-statement', spec: DOCUMENT_SPECS['approved-shift-statement'], values: [], qrPayloads: [], rowMarkers: [], multiLine: [], parseBack: { durations: [], breaks: [], fields: [] } };
    expect(checkAgainstInput(e, x, 'native').find((f) => f.check === 'no-overlap(native)')).toMatchObject({ ok: false });
    expect(checkAgainstInput(e, x, 'chromium').find((f) => f.check === 'no-overlap(chromium)')).toMatchObject({ ok: true, info: true });
  });
});

describe('notes keep their line breaks (checker line-breaks; owner decision 2026-11-04)', () => {
  const note = 'Black tie.\nReport to the staff entrance at 16:45.\r\n\r\nAsk for Jamie on arrival.';

  it('every line of the note starts a printed line, in order: no problem', () => {
    expect(lineBreakProblems(blockExtraction([['NOTES'], ['Black tie.', 'Report to the staff entrance at 16:45.'], ['Ask for Jamie on arrival.']]), note)).toEqual([]);
  });

  it('collapsed into running text (today\'s HTML white-space: normal), the later lines start mid-line: fails', () => {
    const problems = lineBreakProblems(blockExtraction([['Black tie. Report to the staff entrance at 16:45. Ask for', 'Jamie on arrival.']]), note);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/line 2 of 3/);
  });

  it('lines out of order fail', () => {
    expect(lineBreakProblems(blockExtraction([['Report to the staff entrance at 16:45.'], ['Black tie.'], ['Ask for Jamie on arrival.']]), note)).toHaveLength(1);
  });

  it('a line wrapped inside its cell, or cut by a page break after its first printed line, still starts a line', () => {
    const x = extraction([
      ['Black tie.', 'Report to the staff'],
      ['entrance at 16:45.', 'Ask for Jamie on arrival.'],
    ]);
    expect(lineBreakProblems(x, note)).toEqual([]);
    expect(lineBreakProblems(blockExtraction([['Black tie.'], ['Report to the staff', 'entrance at 16:45.'], ['Ask for Jamie on', 'arrival.']]), note)).toEqual([]);
  });

  it('the note is counted line by line: once when every line is printed, zero when any line is missing or altered', () => {
    const lines = [['Black tie.'], ['Report to the staff entrance at 16:45.'], ['Ask for Jamie on arrival.']];
    expect(countValue(blockExtraction(lines), note)).toBe(1);
    expect(countValue(blockExtraction([lines[0]!, lines[2]!]), note)).toBe(0);
    expect(countValue(blockExtraction([lines[0]!, ['Report to the staff entrance at 16:46.'], lines[2]!]), note)).toBe(0);
    expect(countValue(blockExtraction([...lines, ...lines]), note)).toBe(2);
  });

  it('checkAgainstInput fails line-breaks(<render>) for a collapsed note and passes a kept one', () => {
    const e: DocumentExpectation = {
      kind: 'approved-shift-statement',
      spec: DOCUMENT_SPECS['approved-shift-statement'],
      values: [],
      qrPayloads: [],
      rowMarkers: [],
      multiLine: [{ label: 'shift notes', value: note, min: 1 }],
      parseBack: { durations: [], breaks: [], fields: [] },
    };
    const kept = blockExtraction([['Black tie.'], ['Report to the staff entrance at 16:45.'], ['Ask for Jamie on arrival.']]);
    const collapsed = blockExtraction([['Black tie. Report to the staff entrance at 16:45. Ask for Jamie on arrival.']]);
    expect(checkAgainstInput(e, kept, 'native').find((f) => f.check === 'line-breaks(native)')).toMatchObject({ ok: true });
    expect(checkAgainstInput(e, collapsed, 'native').find((f) => f.check === 'line-breaks(native)')).toMatchObject({ ok: false });
    // Only a render named in lineBreaksInfo (Chromium on a tree whose template does not keep them yet) reports it as INFO.
    expect(checkAgainstInput(e, collapsed, 'chromium', { lineBreaksInfo: ['chromium'] }).find((f) => f.check === 'line-breaks(chromium)')).toMatchObject({ ok: true, info: true });
    expect(checkAgainstInput(e, collapsed, 'native', { lineBreaksInfo: ['chromium'] }).find((f) => f.check === 'line-breaks(native)')).toMatchObject({ ok: false });
  });

  it('F1 turning CRLF into LF is not a printed difference (no document reference needed); a □ or any other change still is', () => {
    const base = (value: string): DocumentExpectation => ({
      kind: 'approved-shift-statement',
      spec: DOCUMENT_SPECS['approved-shift-statement'],
      values: [{ label: 'shift notes', value, min: 1 }],
      qrPayloads: [],
      rowMarkers: [],
      multiLine: [],
      parseBack: { durations: [], breaks: [], fields: [] },
    });
    const x = blockExtraction([['Black tie.'], ['Report to the staff entrance at 16:45.'], ['Ask for Jamie on arrival.']]);
    expect(() => compareExtractions('t', base(note), x, x, ['chromium', 'native'], { expectB: base(note.replace(/\r\n/g, '\n')) })).not.toThrow();
    expect(() => compareExtractions('t', base(note), x, x, ['chromium', 'native'], { expectB: base(note.replace('tie', 't□e')) })).toThrow(/referenceB is required/);
    expect(() => compareExtractions('t', base(note), x, x, ['chromium', 'native'], { expectB: base(note.replace(/\r\n/g, ' ')) })).toThrow(/referenceB is required/);
  });

  it('the pending flag follows the template: origin/main collapses notes, the fixed template keeps them (known-findings.ts)', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DOCUMENT_CSS } = require('@rab/server/modules/attendance/templates/adolphus-document') as { DOCUMENT_CSS: string };
    expect(NOTES_LINE_BREAKS_IN_TEMPLATE).toBe(/\.notes-text\s*\{[^}]*white-space\s*:\s*pre-line/.test(DOCUMENT_CSS));
    expect(F_PDF_1_PRESENT).toBe(!/\.bottom\s*>\s*div\s*\{[^}]*min-width\s*:\s*0/.test(DOCUMENT_CSS));
  });
});

describe('PDF_EQUALITY_MODE (mode.ts): chosen by the workflow, never guessed', () => {
  it('compare by default; native-only when asked; anything else refuses to run', () => {
    expect(equalityMode({})).toBe('compare');
    expect(equalityMode({ PDF_EQUALITY_MODE: 'compare' })).toBe('compare');
    expect(equalityMode({ PDF_EQUALITY_MODE: 'native-only' })).toBe('native-only');
    for (const value of ['native', 'NATIVE-ONLY', ' native-only', 'chromium', '1', 'true']) {
      expect(() => equalityMode({ PDF_EQUALITY_MODE: value })).toThrow(/PDF_EQUALITY_MODE must be/);
    }
  });
});

describe('file kinds and filenames (documents.ts DOCUMENT_FILES) are exactly what the jobs store', () => {
  const JOBS = join(__dirname, '..', '..', 'queues', 'rab-reports');
  /** Every `files.putObject({ … })` of a job: its FileKind and the filename expression, from the job's source. */
  const uploads = (job: string) =>
    readFileSync(join(JOBS, job), 'utf8')
      .split('putObject(')
      .slice(1)
      .map((call) => ({ kind: /kind:\s*FileKind\.(\w+)/.exec(call)?.[1] ?? '', filename: /filename:\s*('[^']*'|`[^`]*`)/.exec(call)?.[1] ?? '' }));

  it.each(Object.keys(DOCUMENT_FILES) as DocumentKind[])('%s', (kind) => {
    const spec = DOCUMENT_FILES[kind];
    const doc = kind === 'approved-shift-statement' ? { kind, data: { statementReference: 'ASS-20261020-0F1E2D3C' } } : { kind };
    const filename = spec.filename(doc as never);
    const source = kind === 'approved-shift-statement' ? '`approved-shift-statement-${prepared.data.statementReference}.pdf`' : `'${filename}'`;
    expect(uploads(spec.job)).toContainEqual({ kind: spec.fileKind, filename: source });
    if (kind === 'approved-shift-statement') expect(filename).toBe('approved-shift-statement-ASS-20261020-0F1E2D3C.pdf');
  });
});
