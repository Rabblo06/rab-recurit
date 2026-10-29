import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { createServer, Server } from 'http';
import { AddressInfo, Socket } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

import { Logger } from '@nestjs/common';
import * as playwright from 'playwright';
import { chromium } from 'playwright';

import { QrImageService } from '@rab/server/modules/attendance/services/qr-image.service';
import {
  documentFooterTemplate,
  documentHeaderHtml,
  DOCUMENT_CSS,
  DocumentShiftInfo,
  shiftDetailsHtml,
  staffCellHtml,
} from '@rab/server/modules/attendance/templates/adolphus-document';
import { renderFinalTimesheetHtml, FinalTimesheetData } from '@rab/server/modules/attendance/templates/final-timesheet.html';
import { renderPreShiftReportHtml, PreShiftReportData } from '@rab/server/modules/attendance/templates/pre-shift-report.html';
import { renderApprovedShiftStatementHtml } from '@rab/server/modules/payroll/templates/approved-shift-statement.html';

import * as renderPdfModule from '../../queues/rab-reports/render-pdf.util';
import { renderHtmlToPdf, RenderPdfOptions } from '../../queues/rab-reports/render-pdf.util';
import { inspectPdf, normalisedPdfBytes } from '../helpers/pdf-inspect';

/**
 * PDF rendering hardening (Phase 0). Real Chromium, no mocks: every case renders through `renderHtmlToPdf` and reads the
 * resulting PDF back (page count, embedded images, text decoded via the fonts' ToUnicode maps).
 *
 *   (a) page JavaScript never runs;
 *   (b) no network request leaves the renderer (img, CSS url(), @import, <link>, @font-face, iframe, object, srcset,
 *       poster, prefetch, meta-refresh navigation) — proven by a local HTTP server receiving zero requests;
 *   (c) no local file is read (file:// image, stylesheet, iframe);
 *   (d) every real template renders exactly as the pre-hardening renderer did — same page count, same text, same
 *       images and byte-identical PDF apart from the creation/modification timestamps;
 *   (e) a hanging resource cannot stall the render, and each render step is bounded by a timeout.
 *
 * Every Chromium the renderer launches is checked to be disconnected (closed) after each render, success or failure.
 */
jest.setTimeout(180_000);

// ─── fixtures ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** 1×1 PNG — a size no template image and no Chromium placeholder icon has, so "an image 1x1 is embedded" = it loaded. */
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const PNG_1X1_DATA_URI = `data:image/png;base64,${PNG_1X1.toString('base64')}`;

interface CountingServer {
  base: string;
  hits: string[];
  server: Server;
  sockets: Set<Socket>;
}

async function startServer(respond: boolean): Promise<CountingServer> {
  const hits: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((req, res) => {
    hits.push(req.url ?? '');
    if (!respond) return; // hang: never answer
    const isCss = (req.url ?? '').endsWith('.css');
    res.writeHead(200, { 'content-type': isCss ? 'text/css' : req.url?.includes('page') ? 'text/html' : 'image/png' });
    res.end(isCss ? 'body::after { content: "REMOTE-CSS-MARKER"; }' : req.url?.includes('page') ? '<p>REMOTE-PAGE-MARKER</p>' : PNG_1X1);
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits, server, sockets };
}

async function stopServer(s: CountingServer | undefined): Promise<void> {
  if (!s) return;
  for (const socket of s.sockets) socket.destroy();
  await new Promise<void>((resolve) => s.server.close(() => resolve()));
}

let server: CountingServer;
let hangingServer: CountingServer;
let fileDir: string;
let launched: playwright.Browser[] = [];

beforeAll(async () => {
  server = await startServer(true);
  hangingServer = await startServer(false);
  fileDir = mkdtempSync(join(tmpdir(), 'rab-pdf-hardening-'));
  writeFileSync(join(fileDir, 'pixel.png'), PNG_1X1);
  writeFileSync(join(fileDir, 'local.css'), 'body::after { content: "LOCAL-FILE-CSS-MARKER"; }');
  writeFileSync(join(fileDir, 'local.html'), '<p>LOCAL-FILE-HTML-MARKER</p>');
});

afterAll(async () => {
  await stopServer(server);
  await stopServer(hangingServer);
  rmSync(fileDir, { recursive: true, force: true });
});

// Record every Chromium the code under test launches, so each test can prove it was closed.
let launchSpy: jest.SpyInstance;
beforeEach(() => {
  server.hits.length = 0;
  hangingServer.hits.length = 0;
  launched = [];
  const realLaunch = chromium.launch.bind(chromium);
  launchSpy = jest.spyOn(chromium, 'launch').mockImplementation(async (opts) => {
    const browser = await realLaunch(opts);
    launched.push(browser);
    return browser;
  });
});

afterEach(async () => {
  launchSpy.mockRestore();
  const leaked = launched.filter((b) => b.isConnected());
  for (const b of leaked) await b.close().catch(() => undefined);
  expect(leaked).toHaveLength(0);
});

const fileUrl = (name: string) => pathToFileURL(join(fileDir, name)).href;

// ─── (a) JavaScript ─────────────────────────────────────────────────────────────────────────────────────────────────

describe('(a) page JavaScript does not run', () => {
  it('a <script>, an inline handler and a javascript: URL leave the document exactly as authored', async () => {
    const html = `<!doctype html><html><body onload="document.getElementById('h').textContent='REWRITTEN-BY-ONLOAD'">
      <p id="t">ORIGINAL-SCRIPT-TARGET</p>
      <p id="h">ORIGINAL-HANDLER-TARGET</p>
      <img src="${PNG_1X1_DATA_URI}" onload="this.insertAdjacentHTML('afterend','<p>INSERTED-BY-IMG-ONLOAD</p>')">
      <iframe src="javascript:'<p>JAVASCRIPT-URL-MARKER</p>'"></iframe>
      <script>
        document.getElementById('t').textContent = 'REWRITTEN-BY-SCRIPT';
        for (let i = 0; i < 3; i++) { const d = document.createElement('div'); d.style.pageBreakBefore = 'always'; d.textContent = 'SCRIPT-PAGE-' + i; document.body.appendChild(d); }
      </script>
    </body></html>`;

    const pdf = inspectPdf(await renderHtmlToPdf(html));

    expect(pdf.text).toContain('ORIGINAL-SCRIPT-TARGET');
    expect(pdf.text).toContain('ORIGINAL-HANDLER-TARGET');
    expect(pdf.text).not.toMatch(/REWRITTEN-BY|INSERTED-BY|SCRIPT-PAGE-|JAVASCRIPT-URL-MARKER/);
    expect(pdf.pageCount).toBe(1); // the script would have added three forced page breaks
  });
});

// ─── (b) network ────────────────────────────────────────────────────────────────────────────────────────────────────

describe('(b) no network request leaves the renderer', () => {
  it('img, CSS url(), @import, <link> stylesheet, @font-face, iframe, object, svg image, srcset, poster and prefetch reach the server zero times', async () => {
    const B = server.base;
    const html = `<!doctype html><html><head>
      <link rel="stylesheet" href="${B}/link.css">
      <link rel="prefetch" href="${B}/prefetch">
      <style>
        @import url("${B}/import.css");
        @font-face { font-family: Remote; src: url("${B}/font.woff"); }
        body { background: url("${B}/css-background.png"); font-family: Remote, Arial; }
        .bg { width: 50px; height: 50px; background-image: url('${B}/css-div.png'); }
      </style></head><body>
      <p>NETWORK-CASE-BODY</p>
      <img src="${B}/img.png" width="50" height="50">
      <img srcset="${B}/srcset.png 1x" width="50" height="50">
      <div class="bg"></div>
      <iframe src="${B}/page-iframe"></iframe>
      <object data="${B}/page-object"></object>
      <video poster="${B}/poster.png" width="50" height="50"></video>
      <svg width="50" height="50"><image href="${B}/svg.png" width="50" height="50"/></svg>
    </body></html>`;
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const pdf = inspectPdf(await renderHtmlToPdf(html));

      expect(server.hits).toEqual([]);
      expect(pdf.text).toContain('NETWORK-CASE-BODY');
      expect(pdf.text).not.toMatch(/REMOTE-CSS-MARKER|REMOTE-PAGE-MARKER/);
      expect(pdf.images).not.toContain('1x1');
      // The blocked requests are counted and logged as a number only — never a URL, host or path.
      const messages = warn.mock.calls.map((c) => String(c[0]));
      expect(messages.some((m) => /blocked \d+ /i.test(m))).toBe(true);
      for (const m of messages) expect(m).not.toMatch(/127\.0\.0\.1|https?:|\.png|\.css/);
    } finally {
      warn.mockRestore();
    }
  });

  it('a meta-refresh to a remote page sends no request and fails closed instead of printing another document', async () => {
    const html = `<!doctype html><html><head><meta http-equiv="refresh" content="0;url=${server.base}/page-meta-refresh"></head><body><p>BEFORE-REFRESH</p></body></html>`;

    const outcome = await renderHtmlToPdf(html).then(
      (pdf) => ({ ok: true as const, text: inspectPdf(pdf).text }),
      (err: Error) => ({ ok: false as const, message: err.message }),
    );

    expect(server.hits).toEqual([]);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toMatch(/navigat/i);
  });
});

// ─── (c) local files ────────────────────────────────────────────────────────────────────────────────────────────────

describe('(c) no local file is read', () => {
  it('a file:// image, stylesheet and iframe are not loaded (positive control: the same image as a data: URI is)', async () => {
    const html = `<!doctype html><html><head><link rel="stylesheet" href="${fileUrl('local.css')}"></head><body>
      <p>FILE-CASE-BODY</p>
      <img src="${fileUrl('pixel.png')}" width="50" height="50">
      <iframe src="${fileUrl('local.html')}"></iframe>
    </body></html>`;

    const pdf = inspectPdf(await renderHtmlToPdf(html));
    expect(pdf.text).toContain('FILE-CASE-BODY');
    expect(pdf.images).not.toContain('1x1');
    expect(pdf.text).not.toMatch(/LOCAL-FILE-CSS-MARKER|LOCAL-FILE-HTML-MARKER/);

    // Positive control for the oracle: the identical pixel inlined as data: IS embedded.
    const control = inspectPdf(await renderHtmlToPdf(`<p>CONTROL</p><img src="${PNG_1X1_DATA_URI}" width="50" height="50">`));
    expect(control.images).toContain('1x1');
  });

  it('a meta-refresh to a file:// page never prints the local file', async () => {
    const html = `<!doctype html><html><head><meta http-equiv="refresh" content="0;url=${fileUrl('local.html')}"></head><body><p>BEFORE-FILE-REFRESH</p></body></html>`;
    const outcome = await renderHtmlToPdf(html).then(
      (pdf) => inspectPdf(pdf).text,
      (err: Error) => `REJECTED: ${err.message}`,
    );
    expect(outcome).not.toContain('LOCAL-FILE-HTML-MARKER');
  });
});

// ─── (d) legitimate templates ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Verbatim copy of `renderHtmlToPdf` as it was before the Phase 0 hardening (render-pdf.util.ts at de921c56): the
 * reference the hardened renderer's output is compared against. Test-only; never imported by production code.
 */
async function renderHtmlToPdfUnhardenedReference(html: string, options: RenderPdfOptions = {}): Promise<Buffer> {
  const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || undefined;
  const args = ['--disable-dev-shm-usage'];
  if (process.env.CHROMIUM_NO_SANDBOX === 'true') args.push('--no-sandbox', '--disable-setuid-sandbox');
  const browser = await chromium.launch({ executablePath, args });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    return await page.pdf({
      format: 'A4',
      landscape: options.landscape ?? false,
      printBackground: true,
      ...(options.footerTemplate
        ? {
            displayHeaderFooter: true,
            headerTemplate: '<span></span>',
            footerTemplate: options.footerTemplate,
            margin: { top: '12mm', bottom: '16mm', left: '12mm', right: '12mm' },
          }
        : {}),
    });
  } finally {
    await browser.close();
  }
}

const TZ = 'Europe/London';
const SHIFT_INFO: DocumentShiftInfo = {
  venueName: 'The Grand Hall & Terrace <Main>',
  venueAddress: '1 Example Street, London SW1A 1AA',
  roleName: 'Bar Staff',
  department: 'Hospitality',
  startsAt: '2026-10-20T17:00:00.000Z',
  endsAt: '2026-10-21T01:00:00.000Z',
  contactName: 'Jamie "JJ" Duty-Manager',
  contactPhone: '+44 20 7946 0000',
  shiftReference: 'SHF-20261020-4F2A',
  workspaceName: 'Adolphus Events',
  notes: 'Black tie. Report to the staff entrance <rear>.',
  timezone: TZ,
  generatedAt: '2026-10-20T15:00:00.000Z',
};

function staffRows(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    name: `Staff Member ${String(i + 1).padStart(2, '0')}`,
    staffRef: `ST-${1000 + i}`,
    roleName: i % 3 === 0 ? 'Supervisor' : 'Bar Staff',
    scheduledStart: '2026-10-20T17:00:00.000Z',
    scheduledEnd: '2026-10-21T01:00:00.000Z',
    breakMinutes: i % 4 === 0 ? null : 30,
  }));
}

function finalTimesheet(unsigned: boolean): FinalTimesheetData {
  const statuses = ['approved', 'clocked_out', 'missing_clock_out', 'under_review', 'absent', 'disputed'];
  return {
    ...SHIFT_INFO,
    unsigned,
    finalisedByName: 'Morgan Manager',
    finalisedAt: '2026-10-21T09:30:00.000Z',
    signedOffName: unsigned ? null : 'Morgan A. Manager',
    breakConfirmed: unsigned ? null : true,
    staff: staffRows(14).map((s, i) => ({
      ...s,
      clockInAt: i === 4 ? null : '2026-10-20T16:58:00.000Z',
      clockOutAt: i === 2 || i === 4 ? null : '2026-10-21T01:03:00.000Z',
      workedMinutes: i === 4 ? null : 455 + i,
      status: statuses[i % statuses.length]!,
      assignmentStatus: i === 4 ? 'no_show' : 'confirmed',
      corrected: i % 5 === 1,
      review: i % 2 === 0 ? { grooming: 5, attitude: 4, skills: 4, attendance: 5, timeKeeping: 3 } : null,
    })),
  };
}

interface TemplateCase {
  name: string;
  html: () => Promise<string>;
  options: RenderPdfOptions;
  expectText: string[];
  expectImages: string[];
}

const LOGO = '166x70';

const TEMPLATE_CASES: TemplateCase[] = [
  {
    name: 'pre-shift attendance sheet (roster + signed shift QR)',
    html: async () => {
      const qr = await new QrImageService().generatePng('rab-qr-v1.fixture-shift.fixture-signature');
      const data: PreShiftReportData = { ...SHIFT_INFO, staff: staffRows(4), qrPngBase64: qr.toString('base64') };
      return renderPreShiftReportHtml(data);
    },
    options: { footerTemplate: documentFooterTemplate(SHIFT_INFO), landscape: true },
    expectText: ['SHIFT ATTENDANCE SHEET', 'The Grand Hall & Terrace <Main>', 'CLOCK IN / OUT', 'Staff Member 04', 'Page 1 of 1'],
    expectImages: [LOGO, '600x600'],
  },
  {
    name: 'pre-shift attendance sheet, multi-page roster (footer pagination)',
    html: async () => {
      const qr = await new QrImageService().generatePng('rab-qr-v1.fixture-shift-long.fixture-signature');
      return renderPreShiftReportHtml({ ...SHIFT_INFO, staff: staffRows(60), qrPngBase64: qr.toString('base64') });
    },
    options: { footerTemplate: documentFooterTemplate(SHIFT_INFO), landscape: true },
    expectText: ['Staff Member 60', 'Page 1 of', 'Page 2 of'],
    expectImages: [LOGO, '600x600'],
  },
  {
    name: 'final timesheet — unsigned original',
    html: async () => renderFinalTimesheetHtml(finalTimesheet(true)),
    options: { footerTemplate: documentFooterTemplate(SHIFT_INFO), landscape: true },
    expectText: ['ORIGINAL TIMESHEET', 'Original Timesheet - Unsigned', 'After manager review', 'Missing'],
    expectImages: [LOGO],
  },
  {
    name: 'final timesheet — signed (manager sign-off, reviews, corrections, no-show)',
    html: async () => renderFinalTimesheetHtml(finalTimesheet(false)),
    options: { footerTemplate: documentFooterTemplate(SHIFT_INFO), landscape: true },
    expectText: ['FINAL TIMESHEET', 'Signed off as "Morgan A. Manager"', 'Grooming 5/5', 'No-show', '(corrected)'],
    expectImages: [LOGO],
  },
  {
    name: 'approved shift statement',
    html: async () =>
      renderApprovedShiftStatementHtml({
        statementReference: 'ASS-20261020-1A2B3C4D',
        employerName: 'Adolphus Group Ltd',
        workspaceName: 'Adolphus Events',
        staffName: 'Alex <Staff> Example',
        staffRef: 'ST-1001',
        venueName: SHIFT_INFO.venueName,
        roleName: 'Bar Staff',
        scheduledStart: SHIFT_INFO.startsAt,
        scheduledEnd: SHIFT_INFO.endsAt,
        clockInAt: '2026-10-20T16:58:00.000Z',
        clockOutAt: '2026-10-21T01:03:00.000Z',
        breakMinutes: 30,
        breakPaid: false,
        payableMinutes: 455,
        payRatePence: 1250,
        amountPence: 9479,
        approvedAt: '2026-10-22T10:00:00.000Z',
        approvedByName: 'Pat Payroll',
        payrollPeriodLabel: '13 Oct – 26 Oct 2026',
        paydayLabel: 'Fri 30 Oct 2026',
        timezone: TZ,
        generatedAt: '2026-10-22T10:05:00.000Z',
      }),
    options: {}, // production call: renderHtmlToPdf(html) — portrait, no footer
    expectText: ['APPROVED SHIFT STATEMENT', 'Alex <Staff> Example', '£94.79', 'This statement is not a payslip'],
    expectImages: [LOGO],
  },
  {
    name: 'Adolphus shared document layout (header, details, staff cell, footer) with hostile-looking values',
    html: async () => {
      const hostile: DocumentShiftInfo = {
        ...SHIFT_INFO,
        venueName: `<img src="${server.base}/escaped-venue.png"><script>document.title='x'</script>`,
        notes: `<link rel="stylesheet" href="${server.base}/escaped.css">`,
      };
      return `<!doctype html><html><head><meta charset="utf-8"><style>${DOCUMENT_CSS}</style></head><body>
        ${documentHeaderHtml('Adolphus document')}
        <section class="top"><div>${shiftDetailsHtml(hostile)}</div></section>
        <table><tbody><tr><td>${staffCellHtml('Sam <b>Bold</b> Person', 'ST-1 · Bar')}</td></tr></tbody></table>
      </body></html>`;
    },
    options: { footerTemplate: documentFooterTemplate({ ...SHIFT_INFO, workspaceName: `<img src="${'http://127.0.0.1:9/footer.png'}">` }), landscape: true },
    expectText: ['ADOLPHUS DOCUMENT', 'escaped-venue.png', 'Sam <b>Bold</b> Person', 'Page 1 of 1'],
    expectImages: [LOGO],
  },
];

describe('(d) every real template renders unchanged', () => {
  it.each(TEMPLATE_CASES.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    const html = await c.html();

    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    let hardenedPdf: Buffer;
    try {
      hardenedPdf = await renderHtmlToPdf(html, c.options);
      // A real template needs no external resource: nothing was blocked, so nothing was logged.
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
    const referencePdf = await renderHtmlToPdfUnhardenedReference(html, c.options);
    const hardened = inspectPdf(hardenedPdf);
    const reference = inspectPdf(referencePdf);

    // Sanity: the document really contains what the template prints (so equality below is not vacuous).
    for (const t of c.expectText) expect(hardened.text).toContain(t);
    for (const img of c.expectImages) expect(hardened.images).toContain(img);

    // Equivalence with the pre-hardening renderer.
    expect(hardened.pageCount).toBe(reference.pageCount);
    expect(hardened.pageTexts).toEqual(reference.pageTexts);
    expect(hardened.images).toEqual(reference.images);
    expect(normalisedPdfBytes(hardenedPdf) === normalisedPdfBytes(referencePdf)).toBe(true);

    // Escaped hostile values must not have produced a request either.
    expect(server.hits).toEqual([]);

    // eslint-disable-next-line no-console
    console.log(`[template-equivalence] ${c.name}: pages=${hardened.pageCount} images=[${hardened.images.join(',')}] textChars=${hardened.text.length} bytes=${hardenedPdf.length} identicalToReference=true`);
  });
});

// ─── (e) timeouts ───────────────────────────────────────────────────────────────────────────────────────────────────

describe('(e) a hanging resource cannot stall the render', () => {
  it('an image and a stylesheet on a server that never answers do not delay the render', async () => {
    const H = hangingServer.base;
    const html = `<!doctype html><html><head><link rel="stylesheet" href="${H}/hang.css"></head><body>
      <p>HANG-CASE-BODY</p><img src="${H}/hang.png" width="20" height="20"></body></html>`;

    const started = Date.now();
    const pdf = inspectPdf(await renderHtmlToPdf(html));
    const elapsed = Date.now() - started;

    expect(pdf.text).toContain('HANG-CASE-BODY');
    expect(hangingServer.hits).toEqual([]);
    expect(elapsed).toBeLessThan(15_000);
  });

  it('each render step is bounded: a step that never settles is rejected with a clear timeout error', async () => {
    const { PDF_RENDER_STEP_TIMEOUT_MS, PdfRenderTimeoutError, withRenderStepTimeout } = renderPdfModule as typeof renderPdfModule & {
      PDF_RENDER_STEP_TIMEOUT_MS?: number;
      PdfRenderTimeoutError?: new (...args: never[]) => Error;
      withRenderStepTimeout?: <T>(step: string, ms: number, work: Promise<T>) => Promise<T>;
    };
    expect(PDF_RENDER_STEP_TIMEOUT_MS).toBe(30_000);
    expect(typeof withRenderStepTimeout).toBe('function');

    const never = new Promise<never>(() => undefined);
    const started = Date.now();
    const err = await withRenderStepTimeout!('pdf', 200, never).then(
      () => null,
      (e: Error) => e,
    );
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(err).toBeInstanceOf(PdfRenderTimeoutError!);
    expect(err!.message).toMatch(/pdf.*200 ?ms/i);

    // A step that settles in time passes its value through untouched.
    await expect(withRenderStepTimeout!('setContent', 1_000, Promise.resolve('ok'))).resolves.toBe('ok');
  });
});
