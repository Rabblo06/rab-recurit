import { FINAL_TIMESHEET_CASES } from '../../__tests__/helpers/final-timesheet-fixtures';
import * as nativeModule from './native/render-native';
import * as renderTimeout from './native/runtime/render-timeout';
import {
  describePdfRendering,
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

describe('renderReportPdf', () => {
  let native: jest.SpyInstance;

  beforeEach(() => {
    native = jest.spyOn(nativeModule, 'renderNativePdf');
  });
  afterEach(() => jest.restoreAllMocks());

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

  it('a render that never settles is rejected with PdfRenderTimeoutError (step "native")', async () => {
    jest.useFakeTimers();
    try {
      native.mockImplementation(() => new Promise<Buffer>(() => undefined));
      const pending = renderReportPdf(doc, {});
      const assertion = expect(pending).rejects.toMatchObject({ name: 'PdfRenderTimeoutError', step: 'native', timeoutMs: PDF_RENDER_STEP_TIMEOUT_MS });
      await jest.advanceTimersByTimeAsync(PDF_RENDER_STEP_TIMEOUT_MS + 1);
      await assertion;
      await expect(pending).rejects.toBeInstanceOf(PdfRenderTimeoutError);
    } finally {
      jest.useRealTimers();
    }
  });

  it('a renderer failure propagates unchanged (T3: no fallback)', async () => {
    native.mockRejectedValue(new Error('native boom'));
    await expect(renderReportPdf(doc, {})).rejects.toThrow('native boom');
  });
});
