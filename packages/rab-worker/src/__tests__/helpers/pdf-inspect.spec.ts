import { readFileSync } from 'fs';
import { join } from 'path';
import { deflateSync } from 'zlib';
import QRCode from 'qrcode';

import { extractImages, imageLuminance, inspectPdf, normalisedPdfBytes, readQrModules } from './pdf-inspect';

/**
 * The PDF oracle against both producers the Worker has had. Fixtures (synthetic data only, generated once outside the
 * repository with a throwaway script; Liberation Sans 2.1.5, OFL 1.1, embedded as subsets):
 *   - chromium-skia.pdf         Chromium headless shell 1248 (Skia/PDF m156), page.pdf with the production options
 *                               (A4 landscape, printBackground, footer template, 12/16 mm margins). Inline /Resources.
 *   - react-pdf-4.9.0.pdf       @react-pdf/renderer 4.9.0 + React 18.3.1. INDIRECT /Resources, one BT…ET per glyph run,
 *                               a standard-14 Helvetica line (simple font, WinAnsiEncoding, no ToUnicode), the QR as
 *                               RGB pixels + /SMask, fixed creationDate.
 *   - react-pdf-4.9.0-undated.pdf  react-pdf without a creationDate: the dates are INDIRECT string objects.
 * Both full fixtures draw the same text, the same synthetic 166×70 JPEG and the same QR PNG (qrcode, 600 px, ECC H,
 * margin 2 — the production options) of TOKEN.
 */
const FIXTURES = join(__dirname, '..', 'fixtures', 'pdf');
const fixture = (name: string) => readFileSync(join(FIXTURES, name));
const CHROMIUM = fixture('chromium-skia.pdf');
const REACT_PDF = fixture('react-pdf-4.9.0.pdf');
const REACT_PDF_UNDATED = fixture('react-pdf-4.9.0-undated.pdf');
const TOKEN = 'FIXTURE-NOT-A-REAL-TOKEN.synthetic-payload-0123456789';

const PAGE_1_NEEDLES = [
  'SYNTHETIC FIXTURE REPORT',
  'The <Hostile> & "Quoted" Venue',
  'Reference FIXTURE-0001',
  'Alex Example',
  'S-001',
  '5h 28m',
  '£1,234.56',
  '<script>alert(1)</script>',
  '<img src="http://example.invalid/x.png">',
  '7h 05m',
  '£99.99',
  'Zoë Ł. O’Brien-Ñúñez',
  '£1.00',
  'Fixture Workspace · FIXTURE-0001',
  'Page 1 of 2',
];
const PAGE_2_NEEDLES = ['Second page: totals 13h 33m · £1,335.55 – end', 'Page 2 of 2'];
const collapse = (s: string) => s.replace(/\s+/g, ' ');

function qrSymbols(pdf: Buffer): boolean[][][] {
  return extractImages(pdf)
    .map((img) => {
      const lum = imageLuminance(img);
      return lum ? readQrModules(lum, img.width, img.height) : null;
    })
    .filter((m): m is boolean[][] => m !== null);
}

function expectedQr(payload: string): boolean[][] {
  const { modules } = QRCode.create(payload, { errorCorrectionLevel: 'H' });
  return Array.from({ length: modules.size }, (_, r) => Array.from({ length: modules.size }, (_, c) => modules.get(r, c) === 1));
}

describe.each([
  ['Chromium (Skia/PDF)', CHROMIUM],
  ['@react-pdf/renderer 4.9.0', REACT_PDF],
])('inspectPdf on %s output', (_name, pdf) => {
  const inspection = inspectPdf(pdf);

  it('counts the pages', () => {
    expect(inspection.pageCount).toBe(2);
    expect(inspection.pageTexts).toHaveLength(2);
  });

  it('extracts the text of each page, hostile markup and non-ASCII literally', () => {
    for (const n of PAGE_1_NEEDLES) expect(collapse(inspection.pageTexts[0]!)).toContain(n);
    for (const n of PAGE_2_NEEDLES) expect(collapse(inspection.pageTexts[1]!)).toContain(n);
    for (const n of [...PAGE_1_NEEDLES, ...PAGE_2_NEEDLES]) expect(inspection.text).toContain(n);
    expect(inspection.pageTexts[1]).not.toContain('Alex Example');
    expect(inspection.text).not.toContain('\uFFFD');
  });

  it('keeps separate table cells on separate lines (no false joins across a gap)', () => {
    const lines = inspection.pageTexts[0]!.split('\n');
    expect(lines).toContain('Alex Example');
    expect(lines).toContain('S-001');
    expect(lines).toContain('5h 28m');
    expect(inspection.text).not.toContain('Alex ExampleS-001');
  });

  it('lists the embedded images (soft masks excluded) and the images each page draws', () => {
    expect(inspection.images).toEqual(['166x70', '600x600']);
    expect(inspection.pageImages).toEqual([['166x70', '600x600'], []]);
    const jpeg = extractImages(pdf).find((i) => i.filters.includes('DCTDecode'))!;
    expect(jpeg.data.subarray(0, 2).toString('hex')).toBe('ffd8'); // the still-encoded JPEG
    expect(imageLuminance(jpeg)).toBeNull();
  });

  it('reads the QR symbol from the embedded raster: exactly the symbol of the token', () => {
    const symbols = qrSymbols(pdf);
    expect(symbols).toHaveLength(1);
    expect(symbols[0]).toEqual(expectedQr(TOKEN));
    expect(symbols[0]).not.toEqual(expectedQr(`${TOKEN}x`));
  });

  it('normalisedPdfBytes is stable and still sensitive to the drawing', () => {
    expect(normalisedPdfBytes(pdf)).toBe(normalisedPdfBytes(Buffer.from(pdf)));
    const text = pdf.toString('latin1');
    const tampered = Buffer.from(text.replace('/Width 166', '/Width 167'), 'latin1');
    expect(normalisedPdfBytes(tampered)).not.toBe(normalisedPdfBytes(pdf));
  });
});

describe('Chromium output keeps its existing shape', () => {
  it('has inline page /Resources and Type0 fonts (what the oracle was first written for)', () => {
    const raw = CHROMIUM.toString('latin1');
    expect(/\/Type\s*\/Page\s*\/Resources\s*<</.test(raw)).toBe(true);
    expect(raw).toContain('/Producer (Skia/PDF');
  });

  it('one line per text object, except a footer page number that continues the same baseline', () => {
    const lines = inspectPdf(CHROMIUM).pageTexts[0]!.split('\n');
    expect(lines.slice(0, 3)).toEqual(['SYNTHETIC FIXTURE REPORT', 'The <Hostile> & "Quoted" Venue', 'Reference FIXTURE-0001']);
    expect(lines).toContain('Page 1 of 2');
  });

  it('normalisedPdfBytes drops the inline /CreationDate and /ModDate, as before', () => {
    const raw = CHROMIUM.toString('latin1');
    expect(/\/CreationDate\s*\(D:\d{14}/.test(raw)).toBe(true);
    const redated = Buffer.from(raw.replace(/\(D:\d{14}/g, '(D:19990101000000'), 'latin1');
    expect(redated.equals(CHROMIUM)).toBe(false);
    expect(normalisedPdfBytes(redated)).toBe(normalisedPdfBytes(CHROMIUM));
  });
});

describe('react-pdf output: the shapes the Skia-only oracle could not read', () => {
  const raw = REACT_PDF.toString('latin1');

  it('fixture really has an indirect /Resources, a WinAnsi standard font and an /SMask', () => {
    expect(/\/Resources\s+\d+\s+0\s+R/.test(raw)).toBe(true);
    expect(/\/Resources\s*<</.test(raw)).toBe(false);
    expect(/\/BaseFont\s*\/Helvetica\s*\/Subtype\s*\/Type1\s*\/Encoding\s*\/WinAnsiEncoding/.test(raw)).toBe(true);
    expect(/\/SMask\s+\d+\s+0\s+R/.test(raw)).toBe(true);
  });

  it('joins glyph runs that continue one another on the same baseline ("5" + "h 28m", "<" + "script>")', () => {
    const lines = inspectPdf(REACT_PDF).pageTexts[0]!.split('\n');
    expect(lines).toContain('5h 28m');
    expect(lines).toContain('<script>alert(1)</script>');
  });

  it('decodes the simple WinAnsi font (no ToUnicode) including £, –, ï and curly quotes', () => {
    expect(inspectPdf(REACT_PDF).pageTexts[1]!.split('\n')).toContain('Standard font: Café £5 – naïve “quotes”');
  });

  it('normalisedPdfBytes blanks INDIRECT date objects (PDFKit writes /CreationDate n 0 R) and the /ID', () => {
    const undated = REACT_PDF_UNDATED.toString('latin1');
    const ref = /\/CreationDate (\d+) 0 R/.exec(undated);
    expect(ref).not.toBeNull();
    const re = new RegExp(`(\\n${ref![1]} 0 obj\\s*)\\(D:\\d{14}`);
    expect(re.test(undated)).toBe(true);
    const redated = Buffer.from(undated.replace(re, '$1(D:19990101000000').replace(/\/ID \[<[0-9a-f]+> <[0-9a-f]+>\]/, '/ID [<00> <00>]'), 'latin1');
    expect(redated.equals(REACT_PDF_UNDATED)).toBe(false);
    expect(normalisedPdfBytes(redated)).toBe(normalisedPdfBytes(REACT_PDF_UNDATED));
    expect(inspectPdf(REACT_PDF_UNDATED).text).toBe('Undated synthetic render');
  });
});

describe('both producers agree on the document content', () => {
  it('the same needles, page count, images and QR from the same synthetic data', () => {
    const c = inspectPdf(CHROMIUM);
    const r = inspectPdf(REACT_PDF);
    expect(r.pageCount).toBe(c.pageCount);
    expect(r.images).toEqual(c.images);
    expect(qrSymbols(REACT_PDF)).toEqual(qrSymbols(CHROMIUM));
    for (const n of [...PAGE_1_NEEDLES, ...PAGE_2_NEEDLES]) {
      expect(c.text.includes(n)).toBe(true);
      expect(r.text.includes(n)).toBe(true);
    }
  });
});

/** A hand-built PDF 1.5 with the structures neither renderer emits today but a future version might. */
function syntheticPdf(): Buffer {
  const enc = (s: string) => Buffer.from(s, 'latin1');
  const stream = (dict: string, data: Buffer) =>
    Buffer.concat([enc(`<< ${dict} /Filter /FlateDecode /Length ${deflateSync(data).length} >>\nstream\n`), deflateSync(data), enc('\nendstream')]);
  // Page content: a literal string with escapes and an octal é (WinAnsi \351), the ' operator, a Form XObject.
  const content = enc("BT /F1 12 Tf 72 700 Td (Hello \\(world\\) caf\\351) Tj 14 TL (Next line) ' ET /X1 Do");
  const form = enc('BT /F1 10 Tf 0 0 Td (Inside a form) Tj ET');
  // Objects 1 (catalog), 2 (pages), 3 (page) and 5 (font) live in a compressed object stream (/Type /ObjStm).
  const members: [number, string][] = [
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 /Resources 4 0 R >>'],
    [3, '<< /Type /Page /Parent 2 0 R /Contents 6 0 R >>'],
    [5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'],
  ];
  let head = '';
  let body = '';
  for (const [id, text] of members) {
    head += `${id} ${body.length} `;
    body += `${text}\n`;
  }
  const objstm = enc(head + body);
  const objects: Buffer[] = [
    enc('<< /Font << /F1 5 0 R >> /XObject << /X1 7 0 R >> >>'), // 4: inherited from /Pages
    stream('', content), // 6
    stream('/Type /XObject /Subtype /Form /BBox [0 0 100 100] /Matrix [1 0 0 1 72 600]', form), // 7
    stream(`/Type /ObjStm /N ${members.length} /First ${head.length}`, objstm), // 8
  ];
  const ids = [4, 6, 7, 8];
  return Buffer.concat([
    enc('%PDF-1.5\n'),
    ...objects.flatMap((o, i) => [enc(`${ids[i]} 0 obj\n`), o, enc('\nendobj\n')]),
    enc('trailer << /Root 1 0 R >>\n%%EOF\n'),
  ]);
}

describe('other PDF structures', () => {
  it('object streams, inherited resources, literal strings, the quote operator and Form XObjects', () => {
    const inspection = inspectPdf(syntheticPdf());
    expect(inspection.pageCount).toBe(1);
    expect(inspection.pageTexts[0]!.split('\n')).toEqual(['Hello (world) café', 'Next line', 'Inside a form']);
  });

  it('refuses what it cannot read rather than returning nothing', () => {
    expect(() => inspectPdf(Buffer.from('<html>not a pdf</html>'))).toThrow('not a PDF');
    const encrypted = Buffer.concat([syntheticPdf().subarray(0, -6), Buffer.from('trailer << /Encrypt 9 0 R >>\n%%EOF\n')]);
    expect(() => inspectPdf(encrypted)).toThrow('encrypted');
  });
});
