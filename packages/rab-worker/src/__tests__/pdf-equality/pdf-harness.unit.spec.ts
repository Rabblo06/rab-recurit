import { layoutLines, TextRun } from '../helpers/pdf-layout';
import { countValue, permutedOccurrences } from './checker';
import { Continuation, pageContinuations, PdfExtraction } from './extract';
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
      text: lines.join('\n'),
      blocks: lines,
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
