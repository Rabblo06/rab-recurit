import { chromium } from 'playwright';

import { QrImageService } from '@rab/server/modules/attendance/services/qr-image.service';
import { DOCUMENT_CSS, DocumentShiftInfo, documentFooterTemplate } from '@rab/server/modules/attendance/templates/adolphus-document';
import { FinalTimesheetData, renderFinalTimesheetHtml } from '@rab/server/modules/attendance/templates/final-timesheet.html';
import { renderPreShiftReportHtml } from '@rab/server/modules/attendance/templates/pre-shift-report.html';

import { renderHtmlToPdf, RenderPdfOptions } from '../../queues/rab-reports/render-pdf.util';
import { inspectPdf, normalisedPdfBytes } from '../helpers/pdf-inspect';

/**
 * F-PDF-1 (PDF P0 plan §15) and the notes line-break decision (owner, 2026-11-04). Real Chromium, production path:
 * every PDF here is rendered by `renderHtmlToPdf` with the options the jobs use (A4 landscape, footer, 12 mm margins)
 * and read back through the fonts' ToUnicode maps.
 *
 * Before the fix, `.bottom > div { flex: 1 }` let a long unbroken token in the shift notes widen the NOTES column; the
 * right-hand column was pushed past the page edge and Chromium left it out of the PDF without an error. The final
 * timesheet lost MANAGER SIGN-OFF ("Reviewed by …", "Signed off as …", "Total worked hours"), the pre-shift roster
 * lost BEFORE-SHIFT DOCUMENT, and only 237 of the token's 1,000 characters were printed.
 *
 * Asserted here, for both documents (both final-timesheet variants):
 *   - a 1,000-character token prints in full, and the right-hand column with every value in it is in the PDF;
 *   - nothing is laid out past the page's printable width (Chromium print layout, measured on the same HTML);
 *   - a multi-paragraph note keeps its line breaks (one PDF text line per authored line, blank lines kept);
 *   - documents with ordinary notes print byte-identically to the pre-fix stylesheet (the fix changes nothing else).
 */
jest.setTimeout(180_000);

const TZ = 'Europe/London';
const TOKEN_BODY = 'A1b2C3d4E5'.repeat(100); // 1,000 characters, no break opportunity (P0 plan §8 P3 fixture)
const TOKEN_NOTE = `Token: ${TOKEN_BODY}`;
const PARAGRAPH_NOTE = 'First paragraph, line one.\nFirst paragraph, line two.\n\nSecond paragraph after a blank line.\r\nThird line (CRLF).';
const PARAGRAPH_LINES = ['First paragraph, line one.', 'First paragraph, line two.', 'Second paragraph after a blank line.', 'Third line (CRLF).'];

const INFO: DocumentShiftInfo = {
  venueName: 'The Grand Hall',
  venueAddress: '1 Example Street, London SW1A 1AA',
  roleName: 'Bar Staff',
  department: null,
  startsAt: '2026-11-16T18:00:00.000Z',
  endsAt: '2026-11-16T23:00:00.000Z',
  contactName: 'Jamie Duty',
  contactPhone: '+44 20 7946 0000',
  shiftReference: 'SHIFT-20261116-ABCDEF',
  workspaceName: 'Adolphus Events',
  notes: null,
  timezone: TZ,
  generatedAt: '2026-11-16T15:00:00.000Z',
};
const OPTIONS: RenderPdfOptions = { footerTemplate: documentFooterTemplate(INFO), landscape: true };

const STAFF = [0, 1].map((i) => ({
  name: `Staff Member ${i + 1}`,
  staffRef: `ST-${1000 + i}`,
  roleName: 'Bar Staff',
  scheduledStart: INFO.startsAt,
  scheduledEnd: INFO.endsAt,
  clockInAt: INFO.startsAt,
  clockOutAt: INFO.endsAt,
  breakMinutes: 30,
  workedMinutes: 135, // stored minutes; the total printed is 2 × 135 = 4h 30m
  status: 'approved',
  assignmentStatus: 'confirmed',
  corrected: false,
  review: null,
}));

function finalTimesheet(notes: string, unsigned: boolean): string {
  const data: FinalTimesheetData = {
    ...INFO,
    notes,
    staff: STAFF,
    unsigned,
    finalisedByName: 'Morgan Manager',
    finalisedAt: '2026-11-17T09:30:00.000Z',
    signedOffName: unsigned ? null : 'Morgan A. Manager',
    breakConfirmed: unsigned ? null : true,
  };
  return renderFinalTimesheetHtml(data);
}

let qrBase64: string;
beforeAll(async () => {
  qrBase64 = (await new QrImageService().generatePng('rab-qr-v1.fixture-notes-layout.fixture-signature')).toString('base64');
});
const preShift = (notes: string): string => renderPreShiftReportHtml({ ...INFO, notes, staff: STAFF.map(({ name, staffRef, roleName, scheduledStart, scheduledEnd, breakMinutes }) => ({ name, staffRef, roleName, scheduledStart, scheduledEnd, breakMinutes })), qrPngBase64: qrBase64 });

interface DocumentCase {
  name: string;
  html: (notes: string) => string;
  /** The right-hand `.bottom` column: heading plus every line it prints for this fixture. */
  rightColumn: string[];
}

const DOCUMENTS: DocumentCase[] = [
  {
    name: 'final timesheet (signed)',
    html: (n) => finalTimesheet(n, false),
    rightColumn: [
      'MANAGER SIGN-OFF',
      'Reviewed by Morgan Manager - Finalised at Tue, 17 Nov 2026, 09:30',
      'Signed off as "Morgan A. Manager" - break details confirmed accurate',
      'Typed sign-off recorded with the account above; not a handwritten signature.',
      'Total worked hours: 4h 30m',
    ],
  },
  {
    name: 'final timesheet (unsigned original)',
    html: (n) => finalTimesheet(n, true),
    rightColumn: ['MANAGER SIGN-OFF', 'Original Timesheet - Unsigned. Not yet reviewed by a manager.', 'Total worked hours: 4h 30m'],
  },
  {
    name: 'pre-shift roster',
    html: preShift,
    rightColumn: ['BEFORE-SHIFT DOCUMENT', 'Use the QR above to clock in and clock out.', 'Ratings, confirmation and signatures are not included yet.'],
  },
];

/** A4 landscape (297 mm) less the renderer's 12 mm left and right margins, in CSS px: the printable width. */
const PRINTABLE_WIDTH_PX = Math.floor(((297 - 24) * 96) / 25.4);

interface Layout {
  /** Elements whose right edge is past the printable width (tag.class and right edge), or that overflow their box. */
  overflowing: string[];
  columns: { left: number; right: number }[];
  /** Top of each rendered line of the notes paragraph that draws text, in order. */
  noteLineTops: number[];
}

/**
 * Runs inside the page (plain JS: this package has no DOM typings). Lists every element whose right edge is past the
 * printable width or whose content overflows its box, the `.bottom` columns, and the tops of the notes paragraph's
 * text lines (only boxes that draw text: a kept blank line also gets a zero-width box for its line break).
 */
const LAYOUT_PROBE = `(limit) => {
  const overflowing = [];
  for (const el of Array.from(document.body.querySelectorAll('*'))) {
    const r = el.getBoundingClientRect();
    const label = el.tagName.toLowerCase() + '.' + el.className;
    if (r.right > limit + 0.5) overflowing.push(label + ' right=' + r.right);
    if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) overflowing.push(label + ' scrollWidth=' + el.scrollWidth + ' > clientWidth=' + el.clientWidth);
  }
  if (document.documentElement.scrollWidth > limit + 1) overflowing.push('document scrollWidth=' + document.documentElement.scrollWidth);
  const columns = Array.from(document.querySelectorAll('.bottom > div')).map((d) => {
    const r = d.getBoundingClientRect();
    return { left: r.left, right: r.right };
  });
  const notes = document.querySelector('.notes-text');
  const tops = [];
  if (notes && notes.firstChild) {
    const range = document.createRange();
    range.selectNodeContents(notes.firstChild);
    for (const r of Array.from(range.getClientRects())) if (r.width > 1 && !tops.some((t) => Math.abs(t - r.top) < 1)) tops.push(r.top);
  }
  return { overflowing, columns, noteLineTops: tops };
}`;

/**
 * Chromium's own print layout of the same HTML at the printable width (print media, same browser build as the
 * renderer). The PDF proves what is printed; this proves where: every box inside the page, no box wider than its parent.
 */
async function measureLayout(html: string): Promise<Layout> {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined });
  try {
    const page = await browser.newPage({ viewport: { width: PRINTABLE_WIDTH_PX, height: 800 } });
    await page.emulateMedia({ media: 'print' });
    await page.setContent(html, { waitUntil: 'load' });
    return (await page.evaluate(`(${LAYOUT_PROBE})(${PRINTABLE_WIDTH_PX})`)) as Layout;
  } finally {
    await browser.close();
  }
}

const compact = (s: string): string => s.replace(/\s+/g, '');

describe('F-PDF-1: a long unbroken token in the notes keeps every column on the page', () => {
  it.each(DOCUMENTS.map((d) => [d.name, d] as const))('%s', async (_name, d) => {
    const html = d.html(TOKEN_NOTE);
    const pdf = inspectPdf(await renderHtmlToPdf(html, OPTIONS));
    const lines = pdf.pageTexts.join('\n').split('\n');

    // The whole token is printed, in order (wrapped across lines, so compare without whitespace).
    expect(compact(pdf.text)).toContain(compact(TOKEN_NOTE));
    // The right-hand column and every value in it are in the PDF, each exactly once.
    for (const line of d.rightColumn) expect(lines.filter((l) => l === line)).toHaveLength(1);
    expect(lines).toContain('NOTES');
    expect(pdf.pageCount).toBe(1);

    // …and laid out inside the page: nothing past the printable width, two equal columns side by side.
    const layout = await measureLayout(html);
    expect(layout.overflowing).toEqual([]);
    expect(layout.columns).toHaveLength(2);
    const [notes, right] = layout.columns as [{ left: number; right: number }, { left: number; right: number }];
    expect(right.right).toBeLessThanOrEqual(PRINTABLE_WIDTH_PX + 0.5);
    expect(right.left).toBeGreaterThan(notes.right);
    expect(Math.abs(notes.right - notes.left - (right.right - right.left))).toBeLessThan(1);
  });
});

describe('notes keep their original line breaks (white-space: pre-line)', () => {
  it.each(DOCUMENTS.map((d) => [d.name, d] as const))('%s', async (_name, d) => {
    const html = d.html(PARAGRAPH_NOTE);
    const pdf = inspectPdf(await renderHtmlToPdf(html, OPTIONS));
    const lines = pdf.pageTexts.join('\n').split('\n');

    // One printed line per authored line (LF and CRLF both break), in order, directly under the NOTES heading.
    const at = lines.indexOf('NOTES');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(lines.slice(at + 1, at + 1 + PARAGRAPH_LINES.length)).toEqual(PARAGRAPH_LINES);
    for (const line of d.rightColumn) expect(lines).toContain(line);

    // The blank line between the paragraphs is kept: the third line sits two line-heights below the second.
    const layout = await measureLayout(html);
    expect(layout.overflowing).toEqual([]);
    const tops = layout.noteLineTops;
    expect(tops).toHaveLength(4);
    const step = tops[1]! - tops[0]!;
    expect(step).toBeGreaterThan(0);
    expect(tops[2]! - tops[1]!).toBeCloseTo(2 * step, 0);
    expect(tops[3]! - tops[2]!).toBeCloseTo(step, 0);
  });

  it('runs of spaces and tabs still collapse, and spaces around a line break are dropped', async () => {
    const pdf = inspectPdf(await renderHtmlToPdf(finalTimesheet('Gate  \t B   \nRear  door', false), OPTIONS));
    const lines = pdf.pageTexts.join('\n').split('\n');
    const at = lines.indexOf('NOTES');
    expect(lines.slice(at + 1, at + 3)).toEqual(['Gate B', 'Rear door']);
  });
});

describe('documents with ordinary notes are unchanged by the fix', () => {
  /** The stylesheet as it was before F-PDF-1 (main @ 2733c7fb): the reference these renders must equal. */
  const PRE_FIX_CSS = DOCUMENT_CSS.replace('  .bottom > div { flex: 1; min-width: 0; overflow-wrap: anywhere; }\n  .notes-text { white-space: pre-line; }\n', '  .bottom > div { flex: 1; }\n');

  it('the pre-fix reference really is the old stylesheet', () => {
    expect(PRE_FIX_CSS).not.toBe(DOCUMENT_CSS);
    expect(PRE_FIX_CSS).toContain('.bottom > div { flex: 1; }');
    expect(PRE_FIX_CSS).not.toContain('notes-text');
  });

  it.each(DOCUMENTS.map((d) => [d.name, d] as const))('%s: byte-identical PDF to the pre-fix stylesheet', async (_name, d) => {
    const html = d.html('Black tie. Report to the staff entrance <rear>.');
    const fixed = await renderHtmlToPdf(html, OPTIONS);
    const reference = await renderHtmlToPdf(html.replace(DOCUMENT_CSS, PRE_FIX_CSS).replace(' class="notes-text"', ''), OPTIONS);
    expect(html).toContain(DOCUMENT_CSS);
    expect(normalisedPdfBytes(fixed) === normalisedPdfBytes(reference)).toBe(true);
  });
});
