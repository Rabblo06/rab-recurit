import { inflateSync } from 'zlib';

import jsQR from 'jsqr';
import { isValidElement, ReactElement, ReactNode } from 'react';

import { QrImageService } from '@rab/server/modules/attendance/services/qr-image.service';
import { documentFooterTemplate } from '@rab/server/modules/attendance/templates/adolphus-document';
import { renderPreShiftReportHtml } from '@rab/server/modules/attendance/templates/pre-shift-report.html';
import { buildPreShiftReportViewModel, PreShiftReportData } from '@rab/server/modules/attendance/templates/pre-shift-report.view-model';

// Test-only fixtures live under rab-server/src/__tests__ (never shipped in its dist), so they are imported by path.
import { PRE_SHIFT_FIXTURE_NAMES, PRE_SHIFT_FIXTURES } from '../../../../../rab-server/src/__tests__/fixtures/pre-shift-report.fixtures';
import { NATIVE_KINDS, renderReportPdf } from '../render-pdf.util';
import { h, PageFooter, TABLE_SEGMENT_ROWS } from './document-components';
import { PreShiftReportDocument } from './pre-shift-report.native';
import { renderNativePdf } from './render-native';

/**
 * Pre-shift attendance sheet (roster), native layout — PDF renderer P2. No browser, no database.
 *
 *   - The native layout prints exactly the Chromium template's text: the text content of the HTML the Chromium path
 *     renders (tags stripped, entities decoded) equals the text the native element tree prints, in the same order, for
 *     every fixture — including hostile values, which therefore print literally rather than being interpreted.
 *   - The footer prints the same strings as the Chromium footer template, plus react-pdf's page numbers.
 *   - The 40-row page segments (D4) each repeat the table header; the bottom section is printed once, at the end.
 *   - The QR printed is the QR service's own image: decoded back from the PDF it is the signed token, unchanged.
 *   - Output is deterministic (D7) and goes through the switch: PDF_RENDERER=native renders this kind natively.
 */
jest.setTimeout(120_000);

const GENERATED_AT = (d: PreShiftReportData) => new Date(d.generatedAt);
const nows = (s: string) => s.replace(/\s+/g, '');

/** Text content of the Chromium HTML body, as a browser would print it (CSS text-transform aside). */
function htmlBodyText(html: string): string {
  const body = html.slice(html.indexOf('<body>'), html.indexOf('</body>'));
  return body
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

interface Collected {
  texts: string[];
  /** Strings printed by the per-page footer (`PageFooter`), which is not part of the page body. */
  footerTexts: string[];
  /** Text drawn with a `render` callback (the page numbers), evaluated for page 1 of 1. */
  rendered: string[];
  tables: number;
  pages: number;
  images: number;
}

/**
 * Expands the element tree the way react-pdf would (function components are plain functions of their props here) and
 * collects every string handed to a <Text>, in document order. Host primitives are react-pdf's string element types.
 */
function collect(node: ReactNode, out: Collected = { texts: [], footerTexts: [], rendered: [], tables: 0, pages: 0, images: 0 }): Collected {
  if (node === null || node === undefined || typeof node === 'boolean') return out;
  if (typeof node === 'string' || typeof node === 'number') {
    out.texts.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) collect(child, out);
    return out;
  }
  if (!isValidElement(node)) throw new Error('unexpected node in the native element tree');
  const el = node as ReactElement<Record<string, unknown>>;
  if (el.type === PageFooter) {
    // Identified by component, not by style, so the check survives layout changes inside the kit's footer.
    const sink: Collected = { ...out, texts: [] };
    collect((el.type as (p: unknown) => ReactNode)(el.props), sink);
    out.footerTexts.push(...sink.texts);
    return out;
  }
  if (typeof el.type === 'function') {
    if ((el.type as { name?: string }).name === 'DataTable') out.tables += 1;
    return collect((el.type as (p: unknown) => ReactNode)(el.props), out);
  }
  if (el.type === 'PAGE') out.pages += 1;
  if (el.type === 'IMAGE') out.images += 1;
  if (el.type === 'TEXT' && typeof el.props.render === 'function') {
    out.rendered.push((el.props.render as (p: { pageNumber: number; totalPages: number }) => string)({ pageNumber: 1, totalPages: 1 }));
  }
  return collect(el.props.children as ReactNode, out);
}

function nativeTree(data: PreShiftReportData): Collected {
  return collect(h(PreShiftReportDocument, { vm: buildPreShiftReportViewModel(data), creationDate: GENERATED_AT(data) }));
}

/** The image XObjects of a pdfkit PDF: dictionary text and raw (still Flate-encoded) stream bytes. */
function imageXObjects(pdf: Buffer): { dict: string; stream: Buffer }[] {
  const latin = pdf.toString('latin1');
  const out: { dict: string; stream: Buffer }[] = [];
  const re = /<<((?:(?!>>\s*stream)[\s\S])*?\/Subtype\s*\/Image[\s\S]*?)>>\s*stream\r?\n/g;
  for (let m = re.exec(latin); m; m = re.exec(latin)) {
    const length = Number(/\/Length\s+(\d+)/.exec(m[1]!)?.[1]);
    const start = m.index + m[0].length;
    out.push({ dict: m[1]!, stream: pdf.subarray(start, start + length) });
  }
  return out;
}

function dictNumber(dict: string, key: string): number {
  return Number(new RegExp(`/${key}\\s+(\\d+)`).exec(dict)?.[1]);
}

/** Decodes a Flate image stream (raw samples, or PNG-predictor rows) to RGBA for jsQR. */
function decodeImage(x: { dict: string; stream: Buffer }): { rgba: Uint8ClampedArray; width: number; height: number } {
  const width = dictNumber(x.dict, 'Width');
  const height = dictNumber(x.dict, 'Height');
  const colors = /\/DeviceGray/.test(x.dict) ? 1 : 3;
  let raw = inflateSync(x.stream);
  const rowBytes = width * colors;
  if (raw.length === height * (rowBytes + 1)) {
    // PNG predictor rows (filter byte + row); unfilter (None / Sub / Up / Average / Paeth).
    const outBuf = Buffer.alloc(height * rowBytes);
    for (let y = 0; y < height; y++) {
      const f = raw[y * (rowBytes + 1)]!;
      for (let i = 0; i < rowBytes; i++) {
        const v = raw[y * (rowBytes + 1) + 1 + i]!;
        const a = i >= colors ? outBuf[y * rowBytes + i - colors]! : 0;
        const b = y > 0 ? outBuf[(y - 1) * rowBytes + i]! : 0;
        const c = i >= colors && y > 0 ? outBuf[(y - 1) * rowBytes + i - colors]! : 0;
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f]!;
        outBuf[y * rowBytes + i] = (v + pred) & 0xff;
      }
    }
    raw = outBuf;
  }
  if (raw.length !== height * rowBytes) throw new Error(`unexpected image sample size ${raw.length}`);
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    for (let k = 0; k < 3; k++) rgba[p * 4 + k] = raw[p * colors + (colors === 1 ? 0 : k)]!;
    rgba[p * 4 + 3] = 255;
  }
  return { rgba, width, height };
}

describe('pre-shift attendance sheet, native layout: prints exactly the Chromium template\'s text', () => {
  it.each(PRE_SHIFT_FIXTURE_NAMES.map((n) => [n]))('%s: page text equals the Chromium HTML text, in order', (name) => {
    const data = PRE_SHIFT_FIXTURES[name]!;
    const tree = nativeTree(data);
    // The Chromium body prints the header row once; the native layout repeats it in every 40-row segment (D4).
    const header = buildPreShiftReportViewModel(data).columns;
    const nativeText = tree.texts.join(' ');
    const segments = Math.max(1, Math.ceil(data.staff.length / TABLE_SEGMENT_ROWS));
    let chromiumText = htmlBodyText(renderPreShiftReportHtml(data));
    if (segments > 1) {
      // Re-insert the header before each later segment's first row, exactly where the native layout repeats it.
      const rows = buildPreShiftReportViewModel(data).rows;
      for (let s = segments - 1; s >= 1; s--) {
        const first = rows[s * TABLE_SEGMENT_ROWS]!;
        const at = nows(chromiumText).indexOf(nows(`${first.initials} ${first.name} ${first.sub} ${first.start}`));
        expect(at).toBeGreaterThan(0);
        // Work on the whitespace-free form from here on.
        chromiumText = nows(chromiumText);
        chromiumText = chromiumText.slice(0, at) + nows(header.join('')) + chromiumText.slice(at);
      }
    }
    expect(nows(nativeText)).toBe(nows(chromiumText));
  });

  it.each(PRE_SHIFT_FIXTURE_NAMES.map((n) => [n]))('%s: footer prints the Chromium footer template\'s strings', (name) => {
    const data = PRE_SHIFT_FIXTURES[name]!;
    const tree = nativeTree(data);
    const segments = Math.max(1, Math.ceil(data.staff.length / TABLE_SEGMENT_ROWS));
    const chromiumFooter = htmlBodyText(`<body>${documentFooterTemplate(data).replace(/<span class="pageNumber"><\/span>/, '1').replace(/<span class="totalPages"><\/span>/, '1')}</body>`);
    const vm = buildPreShiftReportViewModel(data);
    // One footer per segment page: the left text (when there is one) plus the rendered right text.
    expect(tree.rendered).toEqual(Array(segments).fill(`${vm.footer.generated} · Page 1 of 1`));
    expect(tree.footerTexts).toEqual(vm.footer.left ? Array(segments).fill(vm.footer.left) : []);
    expect(nows(`${vm.footer.left} ${tree.rendered[0]}`)).toBe(nows(chromiumFooter));
  });

  it('long rosters: one header row per 40-row segment, the bottom section once, the QR panel once', () => {
    for (const [rows, segments] of [[0, 1], [4, 1], [40, 1], [41, 2], [60, 2], [120, 3]] as const) {
      const base = PRE_SHIFT_FIXTURES['sixty-staff']!;
      const staff = Array.from({ length: rows }, (_, i) => base.staff[i % base.staff.length]!);
      const tree = nativeTree({ ...base, staff });
      expect([rows, tree.pages, tree.tables]).toEqual([rows, segments, segments]);
      expect([rows, tree.images]).toEqual([rows, 2]); // logo + QR, on the first segment only
      const flat = tree.texts.join('|');
      expect(flat.split('Assigned staff').length - 1).toBe(segments);
      expect(flat.split('BEFORE-SHIFT DOCUMENT').length - 1).toBe(1);
      expect(flat.split('CLOCK IN / OUT').length - 1).toBe(1);
    }
  });
});

describe('pre-shift attendance sheet, native PDF bytes', () => {
  it('hostile text renders, embeds only the logo and the QR, and carries no link or action', async () => {
    const pdf = await renderNativePdf({ kind: 'pre-shift', data: PRE_SHIFT_FIXTURES.hostile! });
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const images = imageXObjects(pdf).map((x) => `${dictNumber(x.dict, 'Width')}x${dictNumber(x.dict, 'Height')}`);
    // The 1x1 fixture QR, the 166x70 logo, and any soft mask belonging to them — never an image named by the text.
    expect(new Set(images)).toEqual(new Set(['166x70', '1x1']));
    const latin = pdf.toString('latin1');
    expect(latin).not.toMatch(/\/URI|\/Launch|\/JavaScript|\/JS\b|\/OpenAction|\/AA\b/);
  });

  it('the printed QR is the QR service\'s image: decoded from the PDF it is the signed token, byte for byte', async () => {
    // Any string the QR service encodes; the payload is opaque here (the comparison harness uses real signed tokens).
    const token = 'rab-qr-v1.fixture-shift-0001.fixture-signature-not-a-credential';
    const png = await new QrImageService().generatePng(token);
    const pdf = await renderNativePdf({ kind: 'pre-shift', data: { ...PRE_SHIFT_FIXTURES['four-staff']!, qrPngBase64: png.toString('base64') } });
    const qrImages = imageXObjects(pdf).filter((x) => dictNumber(x.dict, 'Width') === 600 && dictNumber(x.dict, 'Height') === 600);
    // The colour image carries /SMask (pdfkit splits the PNG's alpha into a separate mask image); without alpha there is one.
    const qr = qrImages.find((x) => /\/SMask\b/.test(x.dict)) ?? qrImages[0];
    expect(qr).toBeDefined();
    const { rgba, width, height } = decodeImage(qr!);
    expect(jsQR(rgba, width, height)?.data).toBe(token);
  });

  it('is deterministic (D7): the same data renders to the same bytes, dated generatedAt', async () => {
    const data = PRE_SHIFT_FIXTURES['four-staff']!;
    const a = await renderNativePdf({ kind: 'pre-shift', data });
    const b = await renderNativePdf({ kind: 'pre-shift', data });
    expect(a.equals(b)).toBe(true);
    // The document's metadata dates are the data's generatedAt, never the wall clock. Asserted on the element, not on the
    // bytes: under Jest, react-pdf is loaded outside the test realm (react-pdf-node-loader), so a test-realm Date fails
    // pdfkit's `instanceof Date` and is written as Date#toString(). Under plain Node (production) the same render writes
    // `(D:20261020150000Z)`; the renderer comparison (ts-node) checks that on the real bytes.
    const doc = h(PreShiftReportDocument, { vm: buildPreShiftReportViewModel(data), creationDate: GENERATED_AT(data) });
    const rendered = (doc.type as (p: unknown) => ReactElement<{ creationDate: Date; modificationDate: Date; title: string }>)(doc.props);
    expect([rendered.props.creationDate.toISOString(), rendered.props.modificationDate.toISOString()]).toEqual([data.generatedAt, data.generatedAt]);
    expect(rendered.props.title).toBe('Shift attendance sheet — The Grand Hall & Terrace <Main>');
  });

  it('goes through the switch: PDF_RENDERER=native renders the pre-shift kind natively', async () => {
    expect(NATIVE_KINDS.has('pre-shift')).toBe(true);
    const data = PRE_SHIFT_FIXTURES['four-staff']!;
    const viaSwitch = await renderReportPdf({ kind: 'pre-shift', data }, { PDF_RENDERER: 'native' });
    expect(viaSwitch.equals(await renderNativePdf({ kind: 'pre-shift', data }))).toBe(true);
  });
});
