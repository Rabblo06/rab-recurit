import { chromium } from 'playwright';

import { documentFooterTemplate } from '@rab/server/modules/attendance/templates/adolphus-document';
import { renderFinalTimesheetHtml } from '@rab/server/modules/attendance/templates/final-timesheet.html';

import { FINAL_TIMESHEET_CASES } from '../../__tests__/helpers/final-timesheet-fixtures';
import { inlinePageResources } from '../../__tests__/helpers/pdf-images';
import { inspectPdf } from '../../__tests__/helpers/pdf-inspect';
import * as nativeModule from './native/render-native';
import * as renderPool from './native/runtime/render-pool';
import { shutdownRenderPool } from './native/runtime/render-pool';
import * as renderTimeout from './native/runtime/render-timeout';
import { PdfNativeRenderError, PdfNativeThreadCrashError } from './native/runtime/render-protocol';
import {
  describePdfRendering,
  errorCodeSuffix,
  htmlFor,
  NATIVE_KINDS,
  optionsFor,
  PDF_RENDER_STEP_TIMEOUT_MS,
  PdfRenderTimeoutError,
  pdfRendererMode,
  renderReportPdf,
  ReportDocument,
} from './render-pdf.util';

/**
 * PDF renderer P1 — the PDF_RENDERER switch at the data-in seam `renderReportPdf(doc)` (owner decisions D1, T3).
 * Strict: unset or empty → chromium (the default); exactly "chromium" or "native" otherwise; anything else is refused
 * before either renderer runs. No browser is started: `chromium.launch` is intercepted, so "Chromium was / was not
 * used" is observed directly; the native renderer is observed through a spy that still renders for real.
 */
jest.setTimeout(60_000);

const data = FINAL_TIMESHEET_CASES['one-page']!;
const doc: ReportDocument = { kind: 'final-timesheet', data };

class LaunchIntercepted extends Error {}

describe('pdfRendererMode (strict PDF_RENDERER parsing)', () => {
  it.each([[{}], [{ PDF_RENDERER: '' }]])('defaults to chromium when unset or empty (%p)', (env) => {
    expect(pdfRendererMode(env)).toBe('chromium');
  });

  it.each(['chromium', 'native'] as const)('accepts exactly %p', (value) => {
    expect(pdfRendererMode({ PDF_RENDERER: value })).toBe(value);
  });

  it.each([' ', 'Native', 'NATIVE', 'Chromium', ' native', 'native ', 'chrome', 'pdfkit', 'react-pdf', 'true', '1', 'chromium,native'])('refuses %p', (value) => {
    expect(() => pdfRendererMode({ PDF_RENDERER: value })).toThrow(/PDF_RENDERER must be exactly "chromium" \(the default\) or "native"/);
  });

  it('the boot line names the native kinds, and refuses a bad value the same way', () => {
    expect([...NATIVE_KINDS]).toEqual(['final-timesheet']);
    expect(describePdfRendering({ PDF_RENDERER: 'native' })).toBe('PDF_RENDERER=native: native final-timesheet; Chromium for every other report kind');
    expect(describePdfRendering({})).toBe('PDF_RENDERER=chromium: native none; Chromium for every other report kind');
    expect(() => describePdfRendering({ PDF_RENDERER: 'Native' })).toThrow(/PDF_RENDERER must be exactly/);
  });
});

describe('one deadline error class for both renderers', () => {
  it('render-pdf.util re-exports the dependency-free runtime/render-timeout class and constant (instanceof holds everywhere)', () => {
    expect(PdfRenderTimeoutError).toBe(renderTimeout.PdfRenderTimeoutError);
    expect(PDF_RENDER_STEP_TIMEOUT_MS).toBe(renderTimeout.PDF_RENDER_STEP_TIMEOUT_MS);
    expect(new renderTimeout.PdfRenderTimeoutError('native-render', 1)).toBeInstanceOf(PdfRenderTimeoutError);
  });
});

describe('Chromium input is exactly what the job passed before the seam changed', () => {
  it('final timesheet: the template output and the landscape footer options, unchanged', () => {
    expect(htmlFor(doc)).toBe(renderFinalTimesheetHtml(data));
    expect(optionsFor(doc)).toEqual({ footerTemplate: documentFooterTemplate(data), landscape: true });
  });
});

/**
 * I-1 regression: the PRODUCTION native path (renderReportPdf → renderNativePdf) renders in the worker-thread pool, not
 * in-process. Evidence from the bytes, not only from a spy: the creation date is a valid PDF date built inside the
 * thread (an in-process render under Jest writes `Date.toString()`), and an unprintable note becomes the F1 marker
 * (only the thread's glyph guard does that).
 */
describe('native renders go through the render pool (I-1)', () => {
  afterAll(() => shutdownRenderPool());

  it('renderReportPdf(native) submits the view-model to the pool; the thread applies D7 and the F1 glyph guard', async () => {
    const pooled = jest.spyOn(renderPool, 'renderInPool');
    try {
      const pdf = await renderReportPdf({ kind: 'final-timesheet', data: { ...data, notes: 'Arabic محمد end' } }, { PDF_RENDERER: 'native' });
      expect(pooled).toHaveBeenCalledTimes(1);
      expect(pooled.mock.calls[0]![0]).toMatchObject({ kind: 'final-timesheet', generatedAt: data.generatedAt });
      const raw = pdf.toString('latin1');
      expect(raw).toMatch(/\(D:20261020150000Z?\)/); // a real PDF date, built in the thread realm
      expect(raw).not.toMatch(/GMT[+-]\d{4}/); // never Date.toString()
      // F1: the four Arabic letters (no glyphs in the font stack) print as four visible markers, the rest as written.
      expect(inspectPdf(inlinePageResources(pdf)).text).toContain('Arabic □□□□ end');
    } finally {
      pooled.mockRestore();
    }
  });
});

describe('renderReportPdf dispatch', () => {
  let launch: jest.SpyInstance;
  let native: jest.SpyInstance;

  beforeEach(() => {
    launch = jest.spyOn(chromium, 'launch').mockRejectedValue(new LaunchIntercepted('chromium.launch intercepted'));
    native = jest.spyOn(nativeModule, 'renderNativePdf');
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(() => shutdownRenderPool());

  it.each([[{}], [{ PDF_RENDERER: '' }], [{ PDF_RENDERER: 'chromium' }]])('%p: the Chromium path, never the native one', async (env) => {
    await expect(renderReportPdf(doc, env)).rejects.toBeInstanceOf(LaunchIntercepted);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(native).not.toHaveBeenCalled();
  });

  it('native: renders a PDF from the data without ever launching Chromium', async () => {
    const pdf = await renderReportPdf(doc, { PDF_RENDERER: 'native' });
    expect(launch).not.toHaveBeenCalled();
    expect(native).toHaveBeenCalledWith(doc);
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('native: a kind without a native layout (P1: the pre-shift roster) still goes to Chromium', async () => {
    const preShift = { kind: 'pre-shift', data: { ...data, staff: [], qrPngBase64: 'iVBORw0KGgo=' } } as ReportDocument;
    await expect(renderReportPdf(preShift, { PDF_RENDERER: 'native' })).rejects.toBeInstanceOf(LaunchIntercepted);
    expect(native).not.toHaveBeenCalled();
  });

  it.each([' ', 'Native', 'pdfkit'])('refused value %p: rejects before either renderer runs', async (value) => {
    await expect(renderReportPdf(doc, { PDF_RENDERER: value })).rejects.toThrow(/PDF_RENDERER must be exactly/);
    expect(launch).not.toHaveBeenCalled();
    expect(native).not.toHaveBeenCalled();
  });

  it('native: the render pool deadline error (PdfRenderTimeoutError, step "native-render") reaches the job unchanged', async () => {
    // The 30 s deadline itself is enforced by the render pool terminating the thread (runtime/render-pool.spec.ts).
    native.mockRejectedValue(new PdfRenderTimeoutError('native-render', PDF_RENDER_STEP_TIMEOUT_MS));
    await expect(renderReportPdf(doc, { PDF_RENDERER: 'native' })).rejects.toMatchObject({ name: 'PdfRenderTimeoutError', step: 'native-render', timeoutMs: PDF_RENDER_STEP_TIMEOUT_MS });
    expect(launch).not.toHaveBeenCalled();
  });

  it('native: a renderer failure propagates unchanged — no runtime fallback to Chromium (T3)', async () => {
    native.mockRejectedValue(new Error('native boom'));
    await expect(renderReportPdf(doc, { PDF_RENDERER: 'native' })).rejects.toThrow('native boom');
    expect(launch).not.toHaveBeenCalled();
  });

  // Visible and auditable, never a silent Chromium fallback: a failure inside the render pool reaches the job as the
  // pool's own error, with its stable code, and Chromium is never started instead.
  it.each([
    ['a render error', () => new PdfNativeRenderError('native PDF render thread failed to start'), 'error_PDF_NATIVE_RENDER'],
    ['a thread crash', () => new PdfNativeThreadCrashError('native PDF render thread exited', 'ERR_UNKNOWN'), 'error_PDF_NATIVE_THREAD_CRASH'],
    ['the deadline', () => new PdfRenderTimeoutError('native-render', PDF_RENDER_STEP_TIMEOUT_MS), 'error_PDF_RENDER_TIMEOUT'],
  ])('native: %s inside the render pool rejects with its code; Chromium is never launched', async (_label, make, code) => {
    native.mockRestore();
    const pooled = jest.spyOn(renderPool, 'renderInPool').mockRejectedValue(make());
    const err = await renderReportPdf(doc, { PDF_RENDERER: 'native' }).then(
      () => { throw new Error('expected a rejection'); },
      (e: unknown) => e,
    );
    expect(pooled).toHaveBeenCalledTimes(1);
    expect(err).toMatchObject({ code });
    expect(errorCodeSuffix(err)).toBe(` [${code}]`);
    expect(launch).not.toHaveBeenCalled();
  });

  it('native: deterministic output (D7) — the same data renders to the same bytes', async () => {
    const a = await renderReportPdf(doc, { PDF_RENDERER: 'native' });
    const b = await renderReportPdf(doc, { PDF_RENDERER: 'native' });
    expect(a.equals(b)).toBe(true);
    // The creation date is the document's generatedAt (2026-10-20T15:00:00Z), built inside the render thread.
    expect(a.toString('latin1')).toContain('D:20261020150000');
  });
});

describe('errorCodeSuffix (report-job failure log lines)', () => {
  it("prints only a code of the renderers' fixed shape, never free text", () => {
    expect(errorCodeSuffix(new PdfNativeRenderError('x'))).toBe(' [error_PDF_NATIVE_RENDER]');
    expect(errorCodeSuffix(new PdfRenderTimeoutError('pdf', 1))).toBe(' [error_PDF_RENDER_TIMEOUT]');
    for (const e of [new Error('boom'), Object.assign(new Error('x'), { code: 'error_<script>' }), Object.assign(new Error('x'), { code: 'Jane Doe' }), null, undefined, 'error_PDF_NATIVE_RENDER'])
      expect(errorCodeSuffix(e)).toBe('');
  });
});
