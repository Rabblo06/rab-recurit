import { createServer, Server } from 'http';
import { AddressInfo, Socket } from 'net';

import { Logger } from '@nestjs/common';
import * as playwright from 'playwright';
import { chromium } from 'playwright';

import { renderHtmlToPdf } from '../../queues/rab-reports/render-pdf.util';
import { inspectPdf } from '../helpers/pdf-inspect';

/**
 * S-7 and S-9 (Phase 0 review) — MEASUREMENT ONLY, nothing here changes the renderer.
 *
 * S-7: `CHROMIUM_NO_SANDBOX=true` (set by the production image, packages/rab-docker/rab/Dockerfile) launches Chromium with
 *      `--no-sandbox --disable-setuid-sandbox`. Pinned here: exactly which flags each env value produces, and that the
 *      in-page hardening (no JavaScript, no network, no navigation) still holds with the OS sandbox turned off.
 * S-9: the PDF footer template is rendered by Chromium's print pipeline, outside the page whose requests `page.route`
 *      intercepts. A synthetic footer referencing resources on a LOCAL loopback test server (and a closed local port) is
 *      rendered; the local server records whether any request actually arrives. No real external host is ever used.
 */
jest.setTimeout(180_000);

interface CountingServer {
  base: string;
  hits: string[];
  server: Server;
  sockets: Set<Socket>;
}

const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function startServer(): Promise<CountingServer> {
  const hits: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((req, res) => {
    hits.push(req.url ?? '');
    const url = req.url ?? '';
    const isCss = url.endsWith('.css');
    res.writeHead(200, { 'content-type': isCss ? 'text/css' : url.includes('page') ? 'text/html' : 'image/png' });
    res.end(isCss ? 'span::after { content: "FOOTER-REMOTE-CSS-MARKER"; }' : url.includes('page') ? '<p>FOOTER-REMOTE-PAGE-MARKER</p>' : PNG_1X1);
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

/** A local port that was just released: nothing listens on it. */
async function closedLocalPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return port;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 750));

let server: CountingServer;
let launchArgs: string[][] = [];
let launched: playwright.Browser[] = [];
let launchSpy: jest.SpyInstance;
const savedEnv = process.env.CHROMIUM_NO_SANDBOX;

beforeAll(async () => {
  server = await startServer();
});

afterAll(async () => {
  await stopServer(server);
  if (savedEnv === undefined) delete process.env.CHROMIUM_NO_SANDBOX;
  else process.env.CHROMIUM_NO_SANDBOX = savedEnv;
});

beforeEach(() => {
  server.hits.length = 0;
  launchArgs = [];
  launched = [];
  delete process.env.CHROMIUM_NO_SANDBOX;
  const realLaunch = chromium.launch.bind(chromium);
  launchSpy = jest.spyOn(chromium, 'launch').mockImplementation(async (opts) => {
    launchArgs.push([...(opts?.args ?? [])]);
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

// ─── S-7 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('S-7: CHROMIUM_NO_SANDBOX (measured, not changed)', () => {
  it('unset: Chromium keeps its sandbox (only --disable-dev-shm-usage is passed)', async () => {
    await renderHtmlToPdf('<p>plain</p>');
    expect(launchArgs).toEqual([['--disable-dev-shm-usage']]);
  });

  it('"true" (the production image value): --no-sandbox and --disable-setuid-sandbox are added', async () => {
    process.env.CHROMIUM_NO_SANDBOX = 'true';
    await renderHtmlToPdf('<p>plain</p>');
    expect(launchArgs).toEqual([['--disable-dev-shm-usage', '--no-sandbox', '--disable-setuid-sandbox']]);
  });

  it.each(['TRUE', '1', 'yes', 'True', ' true'])('any other value (%p) leaves the sandbox ON (exact match only)', async (value) => {
    process.env.CHROMIUM_NO_SANDBOX = value;
    await renderHtmlToPdf('<p>plain</p>');
    expect(launchArgs).toEqual([['--disable-dev-shm-usage']]);
  });

  it('with the sandbox OFF, page JavaScript still does not run and no request reaches the network', async () => {
    process.env.CHROMIUM_NO_SANDBOX = 'true';
    const html = `<html><body>
      <p id="t">ORIGINAL-TEXT</p>
      <script>document.getElementById('t').textContent = 'SCRIPT-RAN'; fetch('${server.base}/from-script');</script>
      <img src="${server.base}/img.png"><link rel="stylesheet" href="${server.base}/style.css">
      <iframe src="${server.base}/page"></iframe></body></html>`;
    const pdf = await renderHtmlToPdf(html);
    await settle();
    const text = inspectPdf(pdf).text;
    expect(launchArgs[0]).toContain('--no-sandbox');
    expect(text).toContain('ORIGINAL-TEXT');
    expect(text).not.toContain('SCRIPT-RAN');
    expect(server.hits).toEqual([]);
  });
});

// ─── S-9 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('S-9: external references inside the FOOTER template (measured, not changed)', () => {
  /** One subresource kind per case, each pointing at `base` (the local counting server or a closed local port). */
  const FOOTER_KINDS: Array<[string, (base: string) => string]> = [
    ['img', (b) => `<img src="${b}/footer-img.png" width="4" height="4">`],
    ['css background url()', (b) => `<div style="height:4px; background-image:url('${b}/footer-bg.png')"></div>`],
    ['@import', (b) => `<style>@import url("${b}/footer-import.css");</style>`],
    ['<link> stylesheet', (b) => `<link rel="stylesheet" href="${b}/footer-link.css">`],
    ['@font-face', (b) => `<style>@font-face { font-family: Ext; src: url("${b}/footer-font.woff"); } span.f { font-family: Ext; }</style><span class="f">x</span>`],
    ['iframe', (b) => `<iframe src="${b}/footer-page" width="4" height="4"></iframe>`],
    ['object', (b) => `<object data="${b}/footer-object.png" width="4" height="4"></object>`],
    ['script + fetch', (b) => `<script>document.write('FOOTER-SCRIPT-RAN'); fetch('${b}/footer-fetch');</script>`],
  ];
  const footer = (inner: string) =>
    `<div style="font-size:8px; width:100%;">${inner}<span>FOOTER-TEXT</span> <span class="pageNumber"></span>/<span class="totalPages"></span></div>`;

  async function renderFooter(inner: string): Promise<{ outcome: string; text: string; images: string[]; ms: number }> {
    const t0 = Date.now();
    try {
      const pdf = await renderHtmlToPdf('<p>BODY-TEXT</p>', { footerTemplate: footer(inner) });
      const inspection = inspectPdf(pdf);
      return { outcome: 'rendered', text: inspection.text, images: inspection.images, ms: Date.now() - t0 };
    } catch (error) {
      return { outcome: `threw: ${(error as Error).message.split('\n')[0]}`, text: '', images: [], ms: Date.now() - t0 };
    }
  }

  it('control: a plain footer renders and makes no request', async () => {
    const r = await renderFooter('');
    expect(r.outcome).toBe('rendered');
    expect(r.text).toContain('FOOTER-TEXT');
    expect(server.hits).toEqual([]);
  });

  it.each(FOOTER_KINDS)('%s in the footer, local counting server: no request arrives (render outcome recorded)', async (kind, make) => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    let r: Awaited<ReturnType<typeof renderFooter>>;
    try {
      r = await renderFooter(make(server.base));
      await settle();
    } finally {
      warn.mockRestore();
    }
    // eslint-disable-next-line no-console
    console.log(
      `[S-9] kind=${kind} outcome=${r!.outcome} ms=${r!.ms} hits=${JSON.stringify(server.hits)} footerText=${r!.text.includes('FOOTER-TEXT')} ` +
        `scriptRan=${r!.text.includes('FOOTER-SCRIPT-RAN')} remoteCss=${r!.text.includes('FOOTER-REMOTE-CSS-MARKER')} images=${JSON.stringify(r!.images)} ` +
        `rendererBlockedWarnings=${warn.mock.calls.length}`,
    );
    expect(server.hits).toEqual([]);
    expect(r!.text).not.toContain('FOOTER-SCRIPT-RAN');
    expect(r!.images).not.toContain('1x1');
  });

  it.each(FOOTER_KINDS)('baseline (NOT the renderer): %s in a footer printed by a bare ONLINE Playwright page with no route/offline — does Chromium fetch it at all?', async (kind, make) => {
    // Tells WHICH layer keeps footer resources off the network: if a bare online page fetches them, the renderer's
    // context options (offline) are what protect the footer, since page.route never sees footer requests.
    const browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] });
    let outcome = 'rendered';
    try {
      const page = await browser.newPage();
      await page.setContent('<p>BODY-TEXT</p>');
      await page
        .pdf({ format: 'A4', displayHeaderFooter: true, headerTemplate: '<span></span>', footerTemplate: footer(make(server.base)), margin: { top: '12mm', bottom: '16mm' } })
        .catch((error: Error) => {
          outcome = `threw: ${error.message.split('\n')[0]}`;
        });
      await settle();
    } finally {
      await browser.close();
    }
    // eslint-disable-next-line no-console
    console.log(`[S-9 baseline-online] kind=${kind} outcome=${outcome} hits=${JSON.stringify(server.hits)}`);
    // Measured 2026-10-27 on Playwright's bundled Chromium: zero. If a Chromium upgrade (or the production image's system
    // Chromium) starts fetching footer resources, this fails — and page.route would NOT see those requests.
    expect(server.hits).toEqual([]);
  });

  it.each(FOOTER_KINDS)('%s in the footer pointed at a CLOSED local port: the render does not stall', async (kind, make) => {
    const port = await closedLocalPort();
    const r = await renderFooter(make(`http://127.0.0.1:${port}`));
    // eslint-disable-next-line no-console
    console.log(`[S-9 closed-port] kind=${kind} outcome=${r.outcome} ms=${r.ms}`);
    expect(r.ms).toBeLessThan(15_000);
  });
});
