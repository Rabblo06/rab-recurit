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


interface PlacedLine {
  /** Page x (PDF points from the left edge) where the BT…ET text object starts. */
  x: number;
  text: string;
}

/**
 * The text lines of a pdfkit (react-pdf) PDF with their page x, per page, in content-stream order. Self-contained on
 * purpose: it decodes each font's ToUnicode CMap (both `bfchar` and both `bfrange` forms — pdfkit writes the array form)
 * and tracks the current transformation matrix through `q` / `cm` / `Q` and `Tm`, which is how pdfkit positions text.
 */
function placedLines(pdf: Buffer): PlacedLine[][] {
  const latin = pdf.toString('latin1');
  const object = (n: string): { dict: string; stream?: Buffer } => {
    const at = latin.indexOf(`\n${n} 0 obj`);
    const end = latin.indexOf('endobj', at);
    const body = latin.slice(at, end);
    const head = /<<([^]*?)>>\s*stream\r?\n/.exec(body);
    if (!head) return { dict: body };
    const start = at + head.index + head[0].length;
    const raw = pdf.subarray(start, start + Number(/\/Length\s+(\d+)/.exec(head[1]!)![1]));
    return { dict: head[1]!, stream: /\/FlateDecode/.test(head[1]!) ? inflateSync(raw) : raw };
  };
  const toUnicode = (cmap: string): Map<number, string> => {
    const map = new Map<number, string>();
    const hex = (h: string) => parseInt(h, 16);
    const str = (h: string) => String.fromCodePoint(...(h.match(/.{4}/g) ?? []).map(hex));
    for (const b of cmap.matchAll(/beginbfchar([^]*?)endbfchar/g)) for (const m of b[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) map.set(hex(m[1]!), str(m[2]!));
    for (const b of cmap.matchAll(/beginbfrange([^]*?)endbfrange/g)) {
      for (const m of b[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(\[[^\]]*\]|<[0-9a-fA-F]+>)/g)) {
        const lo = hex(m[1]!);
        const hi = hex(m[2]!);
        if (m[3]!.startsWith('[')) [...m[3]!.matchAll(/<([0-9a-fA-F]+)>/g)].forEach((u, i) => map.set(lo + i, str(u[1]!)));
        else for (let c = lo; c <= hi; c++) map.set(c, String.fromCodePoint(hex(m[3]!.slice(1, -1)) + (c - lo)));
      }
    }
    return map;
  };
  type M = [number, number, number, number, number, number];
  const mul = (a: M, b: M): M => [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3], a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]];

  const pages: PlacedLine[][] = [];
  for (const page of latin.matchAll(/\/Type\s*\/Page\b([^]*?)>>/g)) {
    const resources = object(/\/Resources\s+(\d+)\s+0\s+R/.exec(page[1]!)![1]!).dict;
    const fonts = new Map<string, Map<number, string>>();
    const fontBlock = /\/Font\s*<<([^]*?)>>/.exec(resources)?.[1] ?? '';
    for (const f of fontBlock.matchAll(/\/(\w+)\s+(\d+)\s+0\s+R/g)) {
      const tu = /\/ToUnicode\s+(\d+)\s+0\s+R/.exec(object(f[2]!).dict)?.[1];
      fonts.set(f[1]!, tu ? toUnicode(object(tu).stream!.toString('latin1')) : new Map());
    }
    const ops = object(/\/Contents\s+(\d+)\s+0\s+R/.exec(page[1]!)![1]!).stream!.toString('latin1');
    const lines: PlacedLine[] = [];
    let ctm: M = [1, 0, 0, 1, 0, 0];
    const stack: M[] = [];
    let font = new Map<number, string>();
    let line: PlacedLine | null = null;
    let operands: string[] = [];
    for (const tok of ops.match(/\[[^\]]*\]|<[0-9a-fA-F]*>|\/[^\s/[\]<>()]+|-?[\d.]+|[A-Za-z*'"]+/g) ?? []) {
      if (/^[[<\/\-\d.]/.test(tok)) {
        operands.push(tok);
        continue;
      }
      const nums = () => operands.slice(-6).map(Number) as M;
      if (tok === 'q') stack.push(ctm);
      else if (tok === 'Q') ctm = stack.pop()!;
      else if (tok === 'cm') ctm = mul(nums(), ctm);
      else if (tok === 'BT') line = { x: NaN, text: '' };
      else if (tok === 'Tf') font = fonts.get(operands[0]!.slice(1)) ?? new Map();
      else if (tok === 'Tm' && line) line.x = mul(nums(), ctm)[4];
      else if ((tok === 'TJ' || tok === 'Tj') && line) {
        for (const h of operands.join(' ').matchAll(/<([0-9a-fA-F]*)>/g)) for (const c of h[1]!.match(/.{4}/g) ?? []) line.text += font.get(parseInt(c, 16)) ?? '�';
      } else if (tok === 'ET' && line) {
        lines.push(line);
        line = null;
      }
      operands = [];
    }
    pages.push(lines);
  }
  return pages;
}

describe('F-PDF-1: a long unbroken token in the shift notes keeps every column (native layout)', () => {
  // The harness fixture: "Token: " + 1,000 characters with no break opportunity.
  const TOKEN = Array.from({ length: 1000 }, (_, i) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[i % 36]).join('');
  const PAGE_WIDTH = 841.89; // A4 landscape, points
  const MARGIN = (12 * 72) / 25.4;

  it('the helper reads this document correctly (positive control on a normal roster)', async () => {
    const pages = placedLines(await renderNativePdf({ kind: 'pre-shift', data: PRE_SHIFT_FIXTURES['four-staff']! }));
    const all = pages.flat().map((l) => l.text.trim());
    expect(all).toEqual(expect.arrayContaining(['NOTES', 'BEFORE-SHIFT DOCUMENT', 'Black tie. Report to the side door.', 'Staff Member 01']));
    expect(all.join('')).not.toContain('�');
  });

  it.each([['four-staff'], ['sixty-staff']])('%s: "Token: " + 1,000 characters wraps inside NOTES; BEFORE-SHIFT DOCUMENT stays on the page', async (name) => {
    const pdf = await renderNativePdf({ kind: 'pre-shift', data: { ...PRE_SHIFT_FIXTURES[name]!, notes: `Token: ${TOKEN}` } });
    const pages = placedLines(pdf);
    const last = pages[pages.length - 1]!.map((l) => ({ ...l, text: l.text.trim() }));
    const find = (text: string) => last.find((l) => l.text === text);

    // Both bottom columns are printed, on the same (last) page; the right one starts inside the page.
    for (const text of ['NOTES', 'BEFORE-SHIFT DOCUMENT', 'Use the QR above to clock in and clock out.', 'Ratings, confirmation and signatures are not included yet.']) {
      expect([text, find(text) !== undefined]).toEqual([text, true]);
    }
    const notesX = find('NOTES')!.x;
    const rightX = find('BEFORE-SHIFT DOCUMENT')!.x;
    expect(notesX).toBeCloseTo(MARGIN, 0);
    expect(rightX).toBeGreaterThan(PAGE_WIDTH / 2 - 10);
    expect(rightX).toBeLessThan(PAGE_WIDTH - MARGIN - 100);
    expect(find('Use the QR above to clock in and clock out.')!.x).toBeCloseTo(rightX, 0);

    // The token is broken INSIDE the NOTES column: many lines, each starting at the column's x, none long enough to reach
    // the right column (an 8.25 pt Liberation Sans capital or digit is at least 4.5 pt wide, so a line of the ~370 pt
    // column holds at most ~82 of them).
    const tokenLines = last.filter((l) => /^(Token: ?)?[A-Z0-9]{3,}-?$/.test(l.text));
    expect(tokenLines.length).toBeGreaterThanOrEqual(12);
    for (const l of tokenLines) expect([l.text.length <= 90, Math.abs(l.x - notesX) < 1]).toEqual([true, true]);

    // Nothing is lost: all 1,000 characters print, in order, once react-pdf's inserted break hyphens are ignored.
    expect(last.map((l) => l.text).join('').replace(/[\s-]/g, '')).toContain(`Token:${TOKEN}`);
  });
});
