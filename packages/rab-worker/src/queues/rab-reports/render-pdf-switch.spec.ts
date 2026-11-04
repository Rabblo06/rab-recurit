import { chromium } from 'playwright';

import { documentFooterTemplate } from '@rab/server/modules/attendance/templates/adolphus-document';
import { renderFinalTimesheetHtml } from '@rab/server/modules/attendance/templates/final-timesheet.html';

import { FINAL_TIMESHEET_CASES } from '../../__tests__/helpers/final-timesheet-fixtures';
import * as nativeModule from './native/render-native';
import * as renderTimeout from './native/runtime/render-timeout';
import {
  describePdfRendering,
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
    expect([...NATIVE_KINDS]).toEqual(['final-timesheet', 'pre-shift', 'approved-shift-statement']);
    expect(describePdfRendering({ PDF_RENDERER: 'native' })).toBe(
      'PDF_RENDERER=native: native final-timesheet, pre-shift, approved-shift-statement; Chromium for every other report kind',
    );
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

describe('renderReportPdf dispatch', () => {
  let launch: jest.SpyInstance;
  let native: jest.SpyInstance;

  beforeEach(() => {
    launch = jest.spyOn(chromium, 'launch').mockRejectedValue(new LaunchIntercepted('chromium.launch intercepted'));
    native = jest.spyOn(nativeModule, 'renderNativePdf');
  });
  afterEach(() => jest.restoreAllMocks());

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

  // Integration of #59 (roster) with #57 (payroll): the statement now has a native layout too, so no kind is left without
  // one. Both directions are pinned for it instead: native renders it natively, chromium still sends it to Chromium.
  const statement = {
    kind: 'approved-shift-statement',
    data: {
      statementReference: 'ASS-20261020-1A2B3C4D', employerName: 'Adolphus Group Ltd', workspaceName: 'Adolphus Events', staffName: 'Alex Example',
      staffRef: 'ST-1001', venueName: 'The Grand Hall', roleName: 'Bar Staff', scheduledStart: '2026-10-20T17:00:00.000Z', scheduledEnd: '2026-10-21T01:00:00.000Z',
      clockInAt: '2026-10-20T16:58:00.000Z', clockOutAt: '2026-10-21T01:03:00.000Z', breakMinutes: 30, breakPaid: false, payableMinutes: 455, payRatePence: 1250,
      amountPence: 9479, approvedAt: '2026-10-22T10:00:00.000Z', approvedByName: 'Pat Payroll', payrollPeriodLabel: '13 Oct – 26 Oct 2026', paydayLabel: 'Fri 30 Oct 2026',
      timezone: 'Europe/London', generatedAt: '2026-10-22T10:05:00.000Z',
    },
  } as ReportDocument;

  it('native: the shift statement renders natively, without ever launching Chromium', async () => {
    const pdf = await renderReportPdf(statement, { PDF_RENDERER: 'native' });
    expect(launch).not.toHaveBeenCalled();
    expect(native).toHaveBeenCalledWith(statement);
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('chromium: the shift statement still goes to Chromium, never the native renderer', async () => {
    await expect(renderReportPdf(statement, { PDF_RENDERER: 'chromium' })).rejects.toBeInstanceOf(LaunchIntercepted);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(native).not.toHaveBeenCalled();
  });

  it.each([' ', 'Native', 'pdfkit'])('refused value %p: rejects before either renderer runs', async (value) => {
    await expect(renderReportPdf(doc, { PDF_RENDERER: value })).rejects.toThrow(/PDF_RENDERER must be exactly/);
    expect(launch).not.toHaveBeenCalled();
    expect(native).not.toHaveBeenCalled();
  });

  it('native: a render that never settles is rejected with PdfRenderTimeoutError (step "native")', async () => {
    jest.useFakeTimers();
    try {
      native.mockImplementation(() => new Promise<Buffer>(() => undefined));
      const pending = renderReportPdf(doc, { PDF_RENDERER: 'native' });
      const assertion = expect(pending).rejects.toMatchObject({ name: 'PdfRenderTimeoutError', step: 'native', timeoutMs: PDF_RENDER_STEP_TIMEOUT_MS });
      await jest.advanceTimersByTimeAsync(PDF_RENDER_STEP_TIMEOUT_MS + 1);
      await assertion;
      await expect(pending).rejects.toBeInstanceOf(PdfRenderTimeoutError);
    } finally {
      jest.useRealTimers();
    }
  });

  it('native: a renderer failure propagates unchanged — no runtime fallback to Chromium (T3)', async () => {
    native.mockRejectedValue(new Error('native boom'));
    await expect(renderReportPdf(doc, { PDF_RENDERER: 'native' })).rejects.toThrow('native boom');
    expect(launch).not.toHaveBeenCalled();
  });

  it('native: deterministic output (D7) — the same data renders to the same bytes', async () => {
    const a = await renderReportPdf(doc, { PDF_RENDERER: 'native' });
    const b = await renderReportPdf(doc, { PDF_RENDERER: 'native' });
    expect(a.equals(b)).toBe(true);
    // The /CreationDate value itself (D:20261020150000Z) is checked outside Jest (the Worker-image run): under Jest the
    // Date is created in the test realm and react-pdf runs in Node's realm (react-pdf-node-loader.ts), where pdfkit's
    // `instanceof Date` does not recognise it.
  });
});
