import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

import { expect, test } from '@playwright/test';

import { compact, pdfText } from './pdf-text';

/**
 * pdfText against both renderers' output. The fixtures are shared with rab-worker's PDF oracle tests (synthetic data
 * only; provenance in packages/rab-worker/src/__tests__/helpers/pdf-inspect.spec.ts): the same two-page document from
 * Chromium (Skia/PDF, inline /Resources) and from @react-pdf/renderer 4.9.0 (indirect /Resources, one BT…ET per glyph
 * run, a WinAnsi standard font).
 */
const FIXTURES = join(__dirname, '..', '..', '..', 'rab-worker', 'src', '__tests__', 'fixtures', 'pdf');
const NEEDLES = [
  'SYNTHETIC FIXTURE REPORT',
  'The <Hostile> & "Quoted" Venue',
  'Reference FIXTURE-0001',
  'Alex Example',
  '5h 28m',
  '£1,234.56',
  '<script>alert(1)</script>',
  '<img src="http://example.invalid/x.png">',
  'Zoë Ł. O’Brien-Ñúñez',
  'Fixture Workspace · FIXTURE-0001',
  'Page 1 of 2',
  'Second page: totals 13h 33m · £1,335.55 – end',
  'Page 2 of 2',
];

for (const [name, file] of [
  ['Chromium (Skia/PDF)', 'chromium-skia.pdf'],
  ['@react-pdf/renderer 4.9.0', 'react-pdf-4.9.0.pdf'],
] as const) {
  test.describe(`pdfText on ${name} output`, () => {
    const text = pdfText(readFileSync(join(FIXTURES, file)));

    test('every phrase the document prints, compared the way the system specs compare', () => {
      for (const n of NEEDLES) expect(compact(text), n).toContain(compact(n));
    });

    test('pages in order; phrases intact on one line; no stray replacement characters', () => {
      expect(text.indexOf('Page 1 of 2')).toBeGreaterThan(-1);
      expect(text.indexOf('Second page')).toBeGreaterThan(text.indexOf('Page 1 of 2'));
      const lines = text.split('\n');
      for (const n of ['Alex Example', '5h 28m', '<script>alert(1)</script>', 'Reference FIXTURE-0001']) expect(lines).toContain(n);
      expect(text).not.toContain('�');
    });
  });
}

test('react-pdf: the standard-14 font line (simple font, WinAnsiEncoding, no ToUnicode) decodes', () => {
  const text = pdfText(readFileSync(join(FIXTURES, 'react-pdf-4.9.0.pdf')));
  expect(text.split('\n')).toContain('Standard font: Café £5 – naïve “quotes”');
});

test('literal strings, the quote operator, a Form XObject and a compressed object stream', () => {
  const enc = (s: string) => Buffer.from(s, 'latin1');
  const stream = (dict: string, data: Buffer) =>
    Buffer.concat([enc(`<< ${dict} /Filter /FlateDecode /Length ${deflateSync(data).length} >>\nstream\n`), deflateSync(data), enc('\nendstream')]);
  const members: [number, string][] = [
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
    [3, '<< /Type /Page /Parent 2 0 R /Contents 6 0 R /Resources 4 0 R >>'],
    [5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'],
  ];
  let head = '';
  let body = '';
  for (const [id, t] of members) {
    head += `${id} ${body.length} `;
    body += `${t}\n`;
  }
  const objects: [number, Buffer][] = [
    [4, enc('<< /Font << /F1 5 0 R >> /XObject << /X1 7 0 R >> >>')],
    [6, stream('', enc("BT /F1 12 Tf 72 700 Td (Hello \\(world\\) caf\\351) Tj 14 TL (Next line) ' ET /X1 Do"))],
    [7, stream('/Type /XObject /Subtype /Form /BBox [0 0 100 100] /Matrix [1 0 0 1 72 600]', enc('BT /F1 10 Tf (Inside a form) Tj ET'))],
    [8, stream(`/Type /ObjStm /N ${members.length} /First ${head.length}`, enc(head + body))],
  ];
  const pdf = Buffer.concat([
    enc('%PDF-1.5\n'),
    ...objects.flatMap(([id, o]) => [enc(`${id} 0 obj\n`), o, enc('\nendobj\n')]),
    enc('trailer << /Root 1 0 R >>\n%%EOF\n'),
  ]);
  expect(pdfText(pdf)).toBe('Hello (world) café\nNext line\nInside a form');
});

test('refuses a non-PDF and an encrypted PDF', () => {
  expect(() => pdfText(Buffer.from('<html></html>'))).toThrow('not a PDF');
  expect(() => pdfText(Buffer.from('%PDF-1.4\n1 0 obj\n<< >>\nendobj\ntrailer << /Encrypt 2 0 R >>\n%%EOF\n'))).toThrow('encrypted');
});
