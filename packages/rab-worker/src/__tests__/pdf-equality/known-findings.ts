import { DOCUMENT_CSS } from '@rab/server/modules/attendance/templates/adolphus-document';

import { checkAgainstInput, countValue } from './checker';
import { expectationFor, ReportDocument } from './documents';
import { compact, PdfExtraction } from './extract';

/**
 * KNOWN FINDING F-PDF-1 — the current Chromium templates DROP TEXT when the shift notes hold a long unbroken token
 * (found by this harness on CI, ubuntu, 2026-11-04; reproduced in mcr.microsoft.com/playwright:v1.64.1-noble).
 *
 * `DOCUMENT_CSS` (rab-server `modules/attendance/templates/adolphus-document.ts`) lays the bottom of the final timesheet
 * and of the pre-shift roster out as `.bottom { display: flex }` with `.bottom > div { flex: 1 }`. A flex item's
 * `min-width` is `auto`, so a word that cannot break (the fixture: "Token: " + 1,000 characters, P0 plan §8 P3) makes the
 * NOTES column as wide as the word. That pushes the right-hand column past the page's right edge, and Chromium's print
 * layout clips everything outside the page box, so it is not in the PDF at all (no glyphs, no text layer):
 *   - the token is cut at the right margin (x = 810 pt of 842.88): 237 of its 1,000 characters are printed;
 *   - final timesheet (both variants): the whole MANAGER SIGN-OFF column is gone: "Reviewed by <finalised by> -
 *     Finalised at …", "Signed off as "<typed sign-off>"", the not-a-signature note, and "Total worked hours: 4h 30m";
 *   - pre-shift roster: the BEFORE-SHIFT DOCUMENT column is gone.
 * Nothing fails or warns: the job stores a final timesheet without its sign-off and total. Business impact: a document
 * that is evidence of the manager's sign-off and of the payable total silently omits both whenever a note (free text)
 * holds a long URL, reference or pasted token. Fix belongs in the template (e.g. `.bottom > div { min-width: 0;
 * overflow-wrap: anywhere }`), not in this harness; the native renderer must wrap the token (P0 plan §8 P3).
 *
 * The suites keep the full assertion for these fixtures as `test.failing` (so the day the template is fixed they turn
 * RED and must become plain tests again), and `clippingEvidence` pins exactly what is missing, so that `test.failing`
 * cannot hide any OTHER failure on the same fixtures.
 */
export const F_PDF_1 = 'F-PDF-1 (Chromium: unbroken token in notes clips the notes and drops the right-hand column)';

/**
 * Whether THIS tree's template still has the F-PDF-1 cause: `.bottom > div` without `min-width: 0` (the fix, branch
 * fix/pdf-notes-column-and-line-breaks, adds `min-width: 0; overflow-wrap: anywhere`). Where it is fixed the finding no
 * longer applies: F_PDF_1_FIXTURES is empty, so the unbroken-token fixtures run as PLAIN tests with the full assertion
 * (a fix that does not really stop the clipping fails them), and Chromium is again the native renderer's reference there.
 */
export const F_PDF_1_PRESENT = !/\.bottom\s*>\s*div\s*\{[^}]*min-width\s*:\s*0/.test(DOCUMENT_CSS);

export interface ClippingExpectation {
  /** Labels of the business values that are not printed. */
  missing: string[];
  /** The parse-back problems (exact text). */
  parseBack: string | null;
  /** The heading of the right-hand `.bottom` column that is dropped. */
  droppedHeading: string;
}

export const F_PDF_1_SHAPES: Readonly<Record<string, ClippingExpectation>> = Object.freeze({
  'unbroken-token/final-timesheet-original': {
    missing: ['shift notes'],
    parseBack: 'durations: stored minutes not printed 270; printed but not stored ; total worked hours: printed 0× (want exactly once)',
    droppedHeading: 'MANAGER SIGN-OFF',
  },
  'unbroken-token/final-timesheet': {
    missing: ['shift notes', 'finalised by (signature name)', 'typed sign-off (signature name)'],
    parseBack: 'durations: stored minutes not printed 270; printed but not stored ; total worked hours: printed 0× (want exactly once)',
    droppedHeading: 'MANAGER SIGN-OFF',
  },
  'unbroken-token/pre-shift-report': { missing: ['shift notes'], parseBack: null, droppedHeading: 'BEFORE-SHIFT DOCUMENT' },
});

/** The fixtures F-PDF-1 affects, with the exact shape of the clipping — empty once the template is fixed. */
export const F_PDF_1_FIXTURES: Readonly<Record<string, ClippingExpectation>> = F_PDF_1_PRESENT ? F_PDF_1_SHAPES : Object.freeze({});

/**
 * The F-PDF-1 fixtures once the template IS fixed (F_PDF_1_PRESENT false): what the fix must deliver, asserted as plain
 * tests on every Chromium render (pdf-equality.selftest.spec.ts, pdf-hostile-text.spec.ts). Problems (empty = fixed):
 *   - the right-hand column is printed: its heading ("MANAGER SIGN-OFF" / "BEFORE-SHIFT DOCUMENT");
 *   - final timesheet: "Total worked hours" printed exactly once and equal to the stored minutes, and on the finalised
 *     variant the sign-off names ("Reviewed by …", the typed sign-off) — via `checkAgainstInput` (values, parse-back);
 *   - all 1,000 characters of the token are printed, and no text is drawn outside the page.
 */
export function fixedColumnProblems(doc: ReportDocument, x: PdfExtraction, name: string, heading: string): string[] {
  const problems = checkAgainstInput(expectationFor(doc), x, name)
    .filter((f) => !f.ok && !f.info && /^(values-present|parse-back)\(/.test(f.check))
    .map((f) => `${f.check}: ${f.detail}`);
  if (!compact(x.text).includes(compact(heading))) problems.push(`the ${heading} column is not printed`);
  const e = clippingEvidence(doc, x, name, heading);
  // Read in page text order AND block by block: once the notes column keeps its width (the fix), the 1,000-character
  // token wraps over ~13 lines of the left column, and the page's reading order interleaves the right-hand column's
  // lines (sign-off, "Reviewed by …") between them. Inside the notes paragraph's own block the token is contiguous.
  const printed = Math.max(e.tokenCharsPrinted, tokenCharsInBlocks(doc, x));
  if (printed !== 1000) problems.push(`${printed} of the 1,000 token characters printed in order after "Token:"`);
  const outside = x.outOfPageRuns.reduce((a, b) => a + b, 0);
  if (outside) problems.push(`${outside} text run(s) drawn outside the page`);
  return problems;
}

/**
 * Whether THIS tree's templates keep the notes' line breaks (owner decision 2026-11-04; Agent C's branch
 * fix/pdf-notes-column-and-line-breaks: `.notes-text { white-space: pre-line }`). Where they do not (origin/main), the
 * Chromium renders' `line-breaks` check is INFO and pinned by one `test.failing` (pdf-equality.selftest.spec.ts), so
 * the gap stays visible; the native renderer is always held to it.
 */
export const NOTES_LINE_BREAKS_IN_TEMPLATE = /\.notes-text\s*\{[^}]*white-space\s*:\s*pre-line/.test(DOCUMENT_CSS);

export interface ClippingEvidence {
  /** Failing (non-INFO) checks of `checkAgainstInput`. */
  failing: string[];
  missing: string[];
  parseBack: string | null;
  /** How many characters of the 1,000-character token are printed after "Token:". */
  tokenCharsPrinted: number;
  droppedHeadingPrinted: boolean;
}

/** How many token characters follow "Token:" in order inside one block (paragraph) of the render, at most. */
function tokenCharsInBlocks(doc: ReportDocument, x: PdfExtraction): number {
  const token = doc.data && 'notes' in doc.data ? compact(String(doc.data.notes ?? '')).replace(/^Token:/, '') : '';
  let best = 0;
  for (const block of x.pages.flatMap((p) => p.blocks)) {
    const text = compact(block);
    const at = text.indexOf('Token:');
    if (at < 0) continue;
    let printed = 0;
    while (printed < token.length && text[at + 6 + printed] === token[printed]) printed++;
    best = Math.max(best, printed);
  }
  return best;
}

/** What one Chromium render of an F-PDF-1 fixture actually prints, in the shape of `ClippingExpectation`. */
export function clippingEvidence(doc: ReportDocument, x: PdfExtraction, name: string, droppedHeading: string): ClippingEvidence {
  const expect = expectationFor(doc);
  const findings = checkAgainstInput(expect, x, name).filter((f) => !f.ok && !f.info);
  const token = doc.data && 'notes' in doc.data ? compact(String(doc.data.notes ?? '')).replace(/^Token:/, '') : '';
  const text = compact(x.text);
  const at = text.indexOf('Token:');
  let printed = 0;
  if (at >= 0) while (printed < token.length && text[at + 6 + printed] === token[printed]) printed++;
  return {
    failing: findings.map((f) => f.check),
    missing: expect.values.filter((v) => countValue(x, v.value) < v.min).map((v) => v.label),
    parseBack: findings.find((f) => f.check === `parse-back(${name})`)?.detail ?? null,
    tokenCharsPrinted: printed,
    droppedHeadingPrinted: text.includes(compact(droppedHeading)),
  };
}
