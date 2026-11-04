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
  NATIVE_KINDS,
  PDF_RENDER_STEP_TIMEOUT_MS,
  PdfRenderTimeoutError,
  pdfRendererMode,
  renderReportPdf,
  ReportDocument,
} from './render-pdf.util';

/**
 * PDF renderer P5 — native only, at the data-in seam `renderReportPdf(doc)` (owner decisions D1, T3, D10).
 * PDF_RENDERER: unset / empty / "native" → native; "chromium" is refused (retired: no browser in the Worker); anything
 * else is refused before the renderer runs. No browser package is ever loaded.
 */
jest.setTimeout(60_000);

const data = FINAL_TIMESHEET_CASES['one-page']!;
const doc: ReportDocument = { kind: 'final-timesheet', data };

describe('pdfRendererMode (native only, strict)', () => {
  it.each([[{}], [{ PDF_RENDERER: '' }], [{ PDF_RENDERER: 'native' }]])('native for %p', (env) => {
    expect(pdfRendererMode(env)).toBe('native');
  });

  it('refuses chromium and names the rollback', () => {
    expect(() => pdfRendererMode({ PDF_RENDERER: 'chromium' })).toThrow(/retired .*redeploying the previous Worker image/);
  });

  it.each([' ', 'Native', 'NATIVE', ' native', 'native ', 'chrome', 'pdfkit', 'true', '1', 'chromium,native'])('refuses %p', (value) => {
    expect(() => pdfRendererMode({ PDF_RENDERER: value })).toThrow(/PDF_RENDERER must be exactly "native"/);
  });

  it('every report kind is native, and the boot line says so', () => {
    expect([...NATIVE_KINDS].sort()).toEqual(['approved-shift-statement', 'final-timesheet', 'pre-shift']);
    expect(describePdfRendering({})).toBe('PDF rendering: native for pre-shift, final-timesheet, approved-shift-statement; no browser');
    expect(() => describePdfRendering({ PDF_RENDERER: 'chromium' })).toThrow(/retired/);
  });
});

describe('one deadline error class for both renderers', () => {
  it('render-pdf.util re-exports the dependency-free runtime/render-timeout class and constant (instanceof holds everywhere)', () => {
    expect(PdfRenderTimeoutError).toBe(renderTimeout.PdfRenderTimeoutError);
    expect(PDF_RENDER_STEP_TIMEOUT_MS).toBe(renderTimeout.PDF_RENDER_STEP_TIMEOUT_MS);
    expect(new renderTimeout.PdfRenderTimeoutError('native-render', 1)).toBeInstanceOf(PdfRenderTimeoutError);
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

describe('renderReportPdf', () => {
  let native: jest.SpyInstance;

  beforeEach(() => {
    native = jest.spyOn(nativeModule, 'renderNativePdf');
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(() => shutdownRenderPool());

  it('renders a PDF from the data, and no browser package is ever loaded', async () => {
    const pdf = await renderReportPdf(doc, {});
    expect(native).toHaveBeenCalledWith(doc);
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const loaded = Object.keys(require.cache).filter((k) => /[\\/]node_modules[\\/](playwright|playwright-core|chromium-bidi)[\\/]/.test(k));
    expect(loaded).toEqual([]);
  });

  it('an unknown kind is refused before the renderer runs (fail closed)', async () => {
    await expect(renderReportPdf({ kind: 'no-such-document', data: {} } as unknown as ReportDocument, {})).rejects.toThrow(/no native layout/);
    expect(native).not.toHaveBeenCalled();
  });

  it.each(['chromium', ' ', 'Native'])('PDF_RENDERER=%p: rejects before the renderer runs', async (value) => {
    await expect(renderReportPdf(doc, { PDF_RENDERER: value })).rejects.toThrow(/PDF_RENDERER/);
    expect(native).not.toHaveBeenCalled();
  });

  it('the render pool deadline error (PdfRenderTimeoutError, step "native-render") reaches the job unchanged', async () => {
    // The 30 s deadline itself is enforced by the render pool terminating the thread (runtime/render-pool.spec.ts).
    native.mockRejectedValue(new PdfRenderTimeoutError('native-render', PDF_RENDER_STEP_TIMEOUT_MS));
    await expect(renderReportPdf(doc, {})).rejects.toMatchObject({ name: 'PdfRenderTimeoutError', step: 'native-render', timeoutMs: PDF_RENDER_STEP_TIMEOUT_MS });
  });

  it('a renderer failure propagates unchanged (T3: no fallback)', async () => {
    native.mockRejectedValue(new Error('native boom'));
    await expect(renderReportPdf(doc, {})).rejects.toThrow('native boom');
  });

  // Visible and auditable: a failure inside the render pool reaches the job as the pool's own error, with its stable
  // code (there is no other renderer to fall back to).
  it.each([
    ['a render error', () => new PdfNativeRenderError('native PDF render thread failed to start'), 'error_PDF_NATIVE_RENDER'],
    ['a thread crash', () => new PdfNativeThreadCrashError('native PDF render thread exited', 'ERR_UNKNOWN'), 'error_PDF_NATIVE_THREAD_CRASH'],
    ['the deadline', () => new PdfRenderTimeoutError('native-render', PDF_RENDER_STEP_TIMEOUT_MS), 'error_PDF_RENDER_TIMEOUT'],
  ])('%s inside the render pool rejects with its code', async (_label, make, code) => {
    native.mockRestore();
    const pooled = jest.spyOn(renderPool, 'renderInPool').mockRejectedValue(make());
    const err = await renderReportPdf(doc, {}).then(
      () => { throw new Error('expected a rejection'); },
      (e: unknown) => e,
    );
    expect(pooled).toHaveBeenCalledTimes(1);
    expect(err).toMatchObject({ code });
    expect(errorCodeSuffix(err)).toBe(` [${code}]`);
  });

  it('deterministic output (D7) — the same data renders to the same bytes', async () => {
    const a = await renderReportPdf(doc, {});
    const b = await renderReportPdf(doc, {});
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
