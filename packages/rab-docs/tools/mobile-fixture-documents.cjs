/*
 * Report PDFs for the mobile fixture server — rendered from rab-server's REAL document templates
 * (packages/rab-server/src/modules/attendance/templates/*.html.ts), the same HTML the worker
 * (packages/rab-worker/src/queues/rab-reports/*.job.ts) prints, with the same page options as the
 * worker's render-pdf.util.ts (A4 landscape, background, footer template). Only the data is synthetic
 * (the fixture's fictional story/legacy data). Nothing here touches a database, storage or email.
 *
 * The TypeScript template sources are transpiled in-process with the repo's own `typescript` package
 * (the same approach as tools/web/fixtures.cjs loadTimesheetTemplate), with relative imports resolved
 * recursively so the templates' own helpers (adolphus-document.ts, adolphus-logo.ts, escape-html.ts)
 * load from source too. Chromium comes from the repo-root `playwright` package, channel 'chrome', like
 * tools/web/common.cjs.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const TEMPLATES = path.join(REPO_ROOT, 'packages', 'rab-server', 'src', 'modules', 'attendance', 'templates');

let ts = null;
const moduleCache = new Map();

/** Loads a .ts module from source (transpiled to CommonJS), resolving relative imports recursively. */
function loadTs(file) {
  const abs = path.resolve(file);
  if (moduleCache.has(abs)) return moduleCache.get(abs).exports;
  ts = ts || require(path.join(REPO_ROOT, 'node_modules', 'typescript'));
  const out = ts.transpileModule(fs.readFileSync(abs, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    fileName: abs,
  }).outputText;
  const mod = { exports: {} };
  moduleCache.set(abs, mod);
  const localRequire = (id) => {
    if (id.startsWith('.')) {
      const base = path.resolve(path.dirname(abs), id);
      const candidate = [`${base}.ts`, path.join(base, 'index.ts')].find((f) => fs.existsSync(f));
      if (!candidate) throw new Error(`mobile-fixture-documents: cannot resolve ${id} from ${abs}`);
      return loadTs(candidate);
    }
    return require(id);
  };
  new Function('module', 'exports', 'require', out)(mod, mod.exports, localRequire);
  return mod.exports;
}

const templates = () => ({
  final: loadTs(path.join(TEMPLATES, 'final-timesheet.html.ts')),
  preShift: loadTs(path.join(TEMPLATES, 'pre-shift-report.html.ts')),
  doc: loadTs(path.join(TEMPLATES, 'adolphus-document.ts')),
});

/** Same derivation as rab-server templates/document-context.ts shiftReference(). */
function shiftReference(shiftId, startsAt, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(startsAt));
  return `SHIFT-${parts.replace(/-/g, '')}-${shiftId.replace(/-/g, '').slice(0, 6).toUpperCase()}`;
}

let browserPromise = null;
function browser() {
  if (!browserPromise) {
    const { chromium } = require(path.join(REPO_ROOT, 'node_modules', 'playwright'));
    browserPromise = chromium.launch({ channel: 'chrome', headless: true }).catch((e) => {
      browserPromise = null;
      throw e;
    });
  }
  return browserPromise;
}

/** rab-worker render-pdf.util.ts options: A4, landscape, printBackground, footer with 12/16mm margins. */
async function htmlToPdf(html, footerTemplate) {
  const b = await browser();
  const ctx = await b.newContext();
  try {
    const page = await ctx.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    return await page.pdf({
      format: 'A4',
      landscape: true,
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate,
      margin: { top: '12mm', bottom: '16mm', left: '12mm', right: '12mm' },
    });
  } finally {
    await ctx.close();
  }
}

/** `info` is a DocumentShiftInfo (adolphus-document.ts); `data` the template-specific fields. */
async function renderFinalTimesheetPdf(info, data) {
  const t = templates();
  const html = t.final.renderFinalTimesheetHtml({ ...info, ...data });
  return htmlToPdf(html, t.doc.documentFooterTemplate(info));
}

/** Pre-shift attendance sheet. `qrText` is what the printed QR encodes (the fixture's synthetic shift QR). */
async function renderPreShiftPdf(info, staff, qrText) {
  const t = templates();
  const QRCode = require(path.join(REPO_ROOT, 'node_modules', 'qrcode'));
  // Same options as rab-server QrImageService.generatePng.
  const png = await QRCode.toBuffer(qrText, { type: 'png', width: 600, errorCorrectionLevel: 'H', margin: 2 });
  const html = t.preShift.renderPreShiftReportHtml({ ...info, staff, qrPngBase64: png.toString('base64') });
  return htmlToPdf(html, t.doc.documentFooterTemplate(info));
}

async function close() {
  if (!browserPromise) return;
  const b = await browserPromise.catch(() => null);
  browserPromise = null;
  if (b) await b.close().catch(() => {});
}

module.exports = { renderFinalTimesheetPdf, renderPreShiftPdf, shiftReference, close };
