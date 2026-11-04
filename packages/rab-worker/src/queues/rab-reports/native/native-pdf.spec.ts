// Default imports: the real core-module objects (a `* as` namespace copy has non-configurable getters and cannot be spied).
import http from 'http';
import https from 'https';
import net from 'net';

import { Document, Page, renderToBuffer } from '@react-pdf/renderer';
import jsQR from 'jsqr';

import { QrImageService } from '@rab/server/modules/attendance/services/qr-image.service';
import { FinalTimesheetData } from '@rab/server/modules/attendance/templates/final-timesheet.view-model';

import { FINAL_TIMESHEET_CASES, SHIFT_INFO, staffRows } from '../../../__tests__/helpers/final-timesheet-fixtures';
import { inlinePageResources, rasterImages } from '../../../__tests__/helpers/pdf-images';
import { inspectPdf as inspectRaw } from '../../../__tests__/helpers/pdf-inspect';

/** pdf-inspect, reading pdfkit's indirect page /Resources too (see inlinePageResources). */
const inspectPdf = (pdf: Buffer) => inspectRaw(inlinePageResources(pdf));
import { DataTable, h, imageBytesFromDataUri, pngBytes, QrCode } from './document-components';
import { breakOnlyOverlongTokens, OVERLONG_TOKEN_CHARS } from './fonts';
import { renderNativePdf } from './render-native';
import { PdfGlyphCoverageError } from './runtime/render-protocol';
import { shutdownRenderPool } from './runtime/render-pool';

/**
 * Native renderer (PDF renderer migration P1) — security properties, without a browser or a database:
 *   - user-supplied text is printed literally, never interpreted as markup (react-pdf lays out text; there is no HTML,
 *     CSS or script engine), including entities, URLs, Hebrew, Latin diacritics and very long names; characters that
 *     cannot be printed faithfully (bidi controls, zero-width, C0 controls, emoji, unsupported scripts) are REFUSED by
 *     the render pool's glyph guard (fail closed), with the field named and the value never echoed;
 *   - nothing leaves the process: a counting TCP listener that every hostile URL points at receives no connection and
 *     no http(s) request is made while rendering (positive control: a real fetch IS counted);
 *   - only the expected image (the 166x70 logo) is embedded, whatever URLs the text contains;
 *   - images are accepted only as bytes; the QR component prints exactly the QR service's PNG (decoded back here).
 */
jest.setTimeout(60_000);

const LOGO = '166x70';
/**
 * Network detector: a real TCP listener on 127.0.0.1 that counts every connection it accepts (as the Chromium hardening
 * suite does). Every URL in the hostile text points at it, so any fetch the renderer made because of the data would land
 * here. http/https request spies add the request-level view. The positive control below proves a real fetch from this
 * process IS counted (a spy on net.Socket.prototype.connect was MEASURED blind to Node's built-in fetch/undici).
 */
let listener: { server: net.Server; sockets: Set<net.Socket>; connections: number; origin: string };

beforeAll(async () => {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    listener.connections += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  listener = { server, sockets, connections: 0, origin: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}` };
});

afterAll(async () => {
  for (const socket of listener.sockets) socket.destroy();
  await new Promise<void>((resolve) => listener.server.close(() => resolve()));
});

type PrintableKey = 'script' | 'img' | 'link' | 'entity' | 'jsUrl' | 'file' | 'css' | 'rtlHebrew' | 'latin' | 'long';

/** Hostile values the renderer must PRINT literally; URLs point at the counting listener. */
function hostile(): Readonly<Record<PrintableKey, string>> {
  const o = listener.origin;
  return {
    script: `<script>fetch("${o}/script")</script>`,
    img: `<img src="${o}/x.png" onerror="alert(1)">`,
    link: `<link rel="stylesheet" href="${o}/a.css">`,
    entity: '&lt;b&gt;not bold&lt;/b&gt; &amp; &#x3C;',
    jsUrl: 'javascript:alert(1)',
    file: 'file:///etc/passwd',
    css: `<style>@import url(${o}/i.css)</style>`,
    rtlHebrew: '\u05e9\u05dc\u05d5\u05dd \u05e2\u05d5\u05dc\u05dd',
    latin: '\u0141ukasz \u017B\u00f3\u0142\u0107 \u00b7 \u00d1and\u00fa \u2014 \u201cquoted\u201d \u2026 \u20ac\u00a3$',
    long: 'Wolfeschlegelsteinhausenbergerdorff'.repeat(9),
  };
}

/**
 * Characters the render pool REFUSES (fail closed, runtime/glyph-coverage.ts, plan D3): react-pdf would draw nothing
 * for them or consume them before the text layer, so printing would silently change the data. Invisible characters are
 * written as escapes on purpose.
 */
const REFUSED: ReadonlyArray<readonly [string, string]> = [
  ['bidi override (U+202E)', 'abc\u202edcba\u202c xyz'],
  ['bidi isolate (U+2066)', 'a\u2066isolated\u2069b'],
  ['zero-width space (U+200B)', 'Zero\u200bWidth'],
  ['zero-width joiner (U+200D)', 'Join\u200dHere'],
  ['byte-order mark (U+FEFF)', 'BOM\ufeffHere'],
  ['tab (C0 control)', 'Tab\there'],
  ['carriage return', 'Line\rBreak'],
  ['NUL', 'Nul\u0000Here'],
  ['emoji (no font draws it)', 'Party \u{1F389}'],
  ['Arabic (outside the agreed fallback scripts)', '\u0645\u0631\u062d\u0628\u0627'],
];

/** Every printed field of the final timesheet carries printable hostile text. */
function hostileTimesheet(): FinalTimesheetData {
  const H = hostile();
  const values = Object.values(H);
  return {
    ...SHIFT_INFO,
    venueName: `${H.script} ${H.img}`,
    venueAddress: H.link,
    contactName: H.jsUrl,
    contactPhone: H.file,
    workspaceName: H.css,
    notes: `${H.entity} ${H.latin}`,
    unsigned: false,
    finalisedByName: H.rtlHebrew,
    finalisedAt: '2026-10-21T09:30:00.000Z',
    signedOffName: H.latin,
    breakConfirmed: true,
    staff: staffRows(values.length, (i) => values[i]!).map((s, i) => ({ ...s, staffRef: i % 2 ? H.css : H.long, roleName: 'Bar Staff' })),
  };
}

const strip = (s: string) => s.replace(/\s+/g, '');

interface NetworkWatch {
  connectionsBefore: number;
  httpRequest: jest.SpyInstance;
  httpsRequest: jest.SpyInstance;
}

function watchNetwork(): NetworkWatch {
  return { connectionsBefore: listener.connections, httpRequest: jest.spyOn(http, 'request'), httpsRequest: jest.spyOn(https, 'request') };
}

function expectNoNetwork(w: NetworkWatch): void {
  expect(listener.connections - w.connectionsBefore).toBe(0);
  expect(w.httpRequest).not.toHaveBeenCalled();
  expect(w.httpsRequest).not.toHaveBeenCalled();
}

afterEach(() => jest.restoreAllMocks());
afterAll(() => shutdownRenderPool());

describe('network detector (positive control)', () => {
  it('counts a real fetch from this process, so a blind detector cannot pass the tests below', async () => {
    const before = listener.connections;
    await fetch(`${listener.origin}/control`).catch(() => undefined);
    expect(listener.connections - before).toBe(1);
  });
});

describe('hostile text is printed, never interpreted (through the render pool)', () => {
  let pdf: Buffer;
  let connections: number;
  let requests: number;

  beforeAll(async () => {
    const watch = watchNetwork();
    pdf = await renderNativePdf({ kind: 'final-timesheet', data: hostileTimesheet() });
    connections = listener.connections - watch.connectionsBefore;
    requests = watch.httpRequest.mock.calls.length + watch.httpsRequest.mock.calls.length;
  });

  it('renders a PDF; no connection reached the listener the hostile URLs point at, and no http(s) request was made', () => {
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect({ connections, requests }).toEqual({ connections: 0, requests: 0 });
  });

  it('embeds only the logo: no URL in the text became an image, stylesheet or link', () => {
    const doc = inspectPdf(pdf);
    expect(doc.images).toEqual([LOGO]);
    const raw = pdf.toString('latin1');
    expect(raw).not.toMatch(/\/URI|\/Launch|\/JavaScript|\/JS\b|\/Annots|\/OpenAction|\/AA\b|\/EmbeddedFile|\/AcroForm/);
  });

  it.each([
    ['<script>', 'script'],
    ['<img src=http…>', 'img'],
    ['<link href=http…>', 'link'],
    ['entity-looking text', 'entity'],
    ['javascript: URL', 'jsUrl'],
    ['file:// URL', 'file'],
    ['<style>@import', 'css'],
    ['Latin with diacritics and typographic punctuation', 'latin'],
  ] as const)('%s prints literally, character for character', (_label, key) => {
    expect(strip(inspectPdf(pdf).pageTexts.join(''))).toContain(strip(hostile()[key]));
  });

  it('a very long unbroken token is wrapped inside its cell, not drawn over its neighbours, and nothing is dropped', () => {
    const text = strip(inspectPdf(pdf).pageTexts.join(''));
    // Broken across lines (react-pdf draws a "-" at each forced break: owner-visible delta, see word-breaking.ts) ...
    expect(text).not.toContain(hostile().long);
    // ... and every character is still there, in order.
    expect(text.replace(/-/g, '')).toContain(hostile().long);
  });
});

describe('characters that cannot be printed faithfully are refused (fail closed), never blanked', () => {
  it.each(REFUSED)('%s → PdfGlyphCoverageError naming the field, never the value', async (_label, value) => {
    const watch = watchNetwork();
    const data: FinalTimesheetData = { ...FINAL_TIMESHEET_CASES['one-page']!, notes: `Before ${value} after` };
    const error = await renderNativePdf({ kind: 'final-timesheet', data }).then(
      () => null,
      (e: unknown) => e as Error & { code?: string },
    );
    expect(error).toBeInstanceOf(PdfGlyphCoverageError);
    expect(error!.code).toBe('error_PDF_GLYPH_UNSUPPORTED');
    expect(error!.message).toContain('notes');
    expect(error!.message).not.toContain(value);
    expectNoNetwork(watch);
  });
});

describe('word breaking (fonts.ts)', () => {
  it('keeps ordinary words whole (Chromium never hyphenates these templates)', () => {
    for (const w of ['Staff', 'Maximilian-Alexander', 'internationalization', 'x'.repeat(OVERLONG_TOKEN_CHARS)]) expect(breakOnlyOverlongTokens(w)).toEqual([w]);
  });

  it('lets a token longer than the limit break between any two code points (never inside a surrogate pair)', () => {
    const long = `${'A'.repeat(OVERLONG_TOKEN_CHARS)}😀B`;
    const parts = breakOnlyOverlongTokens(long);
    expect(parts.join('')).toBe(long);
    expect(parts).toContain('😀');
    expect(parts).toHaveLength(OVERLONG_TOKEN_CHARS + 2);
  });
});

describe('images are bytes only', () => {
  it.each([
    'http://127.0.0.1:9/logo.png',
    'https://example.invalid/logo.jpg',
    'file:///etc/passwd',
    '/app/packages/rab-worker/assets/logo.png',
    'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
    'data:text/html;base64,PHNjcmlwdD4=',
    'data:image/png;base64,iVBOR w0K',
  ])('refuses %p as an image source', (uri) => {
    expect(() => imageBytesFromDataUri(uri)).toThrow(/base64 PNG\/JPEG data URIs/);
  });

  it('refuses non-PNG bytes for a PNG image', () => {
    expect(() => pngBytes(Buffer.from('<svg/>'))).toThrow(/not a PNG/);
  });

  it('the table refuses column widths that do not add up to 100%', () => {
    expect(() => DataTable({ columns: [{ label: 'a', widthPct: 60 }, { label: 'b', widthPct: 30 }], rows: [], emptyText: 'x' })).toThrow(/90%/);
  });
});

describe('QR component', () => {
  it('prints exactly the QR service PNG: the embedded image decodes to the same payload', async () => {
    const payload = 'rab-qr-v1.fixture-shift-0000.fixture-signature-ABCDEF';
    const png = await new QrImageService().generatePng(payload);
    const watch = watchNetwork();
    const pdf = await renderToBuffer(h(Document, null, h(Page, { size: 'A4' }, h(QrCode, { png, sizePx: 128 }))) as Parameters<typeof renderToBuffer>[0]);
    expectNoNetwork(watch);
    const images = rasterImages(pdf);
    expect(images).toHaveLength(1);
    const [image] = images;
    expect(jsQR(image!.rgba, image!.width, image!.height)?.data).toBe(payload);
  });
});

describe('every comparison fixture renders natively', () => {
  it.each(Object.keys(FINAL_TIMESHEET_CASES))('%s', async (name) => {
    const watch = watchNetwork();
    const pdf = await renderNativePdf({ kind: 'final-timesheet', data: FINAL_TIMESHEET_CASES[name]! });
    expectNoNetwork(watch);
    expect(inspectPdf(pdf).images).toEqual([LOGO]);
  });
});
