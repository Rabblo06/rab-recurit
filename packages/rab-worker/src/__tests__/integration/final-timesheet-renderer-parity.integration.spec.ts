import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

import { Document, Page, renderToBuffer } from '@react-pdf/renderer';
import jsQR from 'jsqr';

import { QrImageService } from '@rab/server/modules/attendance/services/qr-image.service';
import { buildFinalTimesheetViewModel, FinalTimesheetViewModel } from '@rab/server/modules/attendance/templates/final-timesheet.view-model';

import { h, QrCode, TABLE_SEGMENT_ROWS } from '../../queues/rab-reports/native/document-components';
import { shutdownRenderPool } from '../../queues/rab-reports/native/runtime/render-pool';
import { renderReportPdf, ReportDocument } from '../../queues/rab-reports/render-pdf.util';
import { FINAL_TIMESHEET_CASES, SHIFT_INFO } from '../helpers/final-timesheet-fixtures';
import { inlinePageResources, rasterImages } from '../helpers/pdf-images';
import { inspectPdf as inspectRaw, PdfInspection } from '../helpers/pdf-inspect';

/** pdf-inspect, reading pdfkit's indirect page /Resources too (see inlinePageResources); a no-op for Chromium output. */
const inspectPdf = (pdf: Buffer): PdfInspection => inspectRaw(inlinePageResources(pdf));

/**
 * PDF renderer P1 — final timesheet parity: the SAME data through `renderReportPdf` with PDF_RENDERER=chromium (real
 * Chromium) and PDF_RENDERER=native, read back with the repo's pdf-inspect oracle:
 *   - same embedded images (the 166x70 logo, nothing else);
 *   - identical text (whitespace-insensitive: the two writers split text runs differently) once the per-page repeats —
 *     the table header row and the footer — are taken out, so a page break moved by a 40-row segment boundary (owner
 *     decision D4) cannot hide or fake a difference;
 *   - every view-model string printed by both (each renderer equals the view model);
 *   - "Page x of N" on every page with that renderer's own N; the table header repeated on every page that has rows;
 *   - the same page count while the table fits one segment (≤ 40 rows); beyond, at most one extra page per boundary.
 * The QR component is checked the same way: Chromium's pre-shift roster and a native page embed the same QR PNG, and
 * both decode (jsQR, test-only) to the payload. Render times are logged for both renderers.
 * PDF_PARITY_OUT_DIR=<dir> also writes every PDF there (visual comparison / golden-raster review, D6).
 */
jest.setTimeout(300_000);

const strip = (s: string): string => s.replace(/\s+/g, '');
const OUT = process.env.PDF_PARITY_OUT_DIR;
if (OUT) mkdirSync(OUT, { recursive: true });

function viewStrings(vm: FinalTimesheetViewModel): string[] {
  const d = vm.details;
  return [
    vm.title.toUpperCase(),
    d.venueName,
    ...(d.address ? [d.address] : []),
    d.role,
    d.date,
    d.scheduled,
    ...(d.contact ? [d.contact] : []),
    d.shiftReference,
    vm.summary,
    ...vm.columns,
    ...vm.rows.flatMap((r) => [r.initials, r.name, r.sub, r.clockIn, r.clockOut, r.breakText, r.hours, r.status, ...(r.correctedNote ? [r.correctedNote] : []), ...r.review.lines]),
    ...(vm.rows.length ? [] : [vm.emptyText]),
    vm.scaleLegend,
    vm.notesHeading,
    vm.notes.text,
    vm.counts,
    vm.signOffHeading,
    ...vm.signOff.map((l) => l.text),
    vm.totalWorked,
    vm.footer.left,
    vm.footer.generated,
  ].filter((s) => strip(s).length > 0);
}

/** Whole-document text without the per-page repeats (header row, footer), whitespace removed. */
function bodyText(doc: PdfInspection, vm: FinalTimesheetViewModel): string {
  const header = strip(vm.columns.join(''));
  const footer = new RegExp(`${escapeRe(strip(vm.footer.left))}|${escapeRe(strip(vm.footer.generated))}·Page\\d+of\\d+`, 'g');
  return doc.pageTexts.map((t) => strip(t).replace(footer, '').split(header).join('')).join('');
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const timings: string[] = [];

afterAll(async () => {
  await shutdownRenderPool();
  // eslint-disable-next-line no-console
  console.log(`[renderer-parity] render times (ms, this host):\n${timings.join('\n')}`);
});

describe.each(Object.keys(FINAL_TIMESHEET_CASES))('final timesheet "%s": chromium vs native', (name) => {
  const data = FINAL_TIMESHEET_CASES[name]!;
  const doc: ReportDocument = { kind: 'final-timesheet', data };
  const vm = buildFinalTimesheetViewModel(data);
  const pdf: Record<'chromium' | 'native', Buffer> = {} as never;
  const read: Record<'chromium' | 'native', PdfInspection> = {} as never;

  beforeAll(async () => {
    for (const mode of ['chromium', 'native'] as const) {
      const t0 = process.hrtime.bigint();
      pdf[mode] = await renderReportPdf(doc, { ...process.env, PDF_RENDERER: mode });
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      read[mode] = inspectPdf(pdf[mode]);
      timings.push(`  ${name.padEnd(18)} ${mode.padEnd(8)} ${ms.toFixed(0).padStart(6)} ms  pages=${read[mode].pageCount} bytes=${pdf[mode].length}`);
      if (OUT) writeFileSync(join(OUT, `${name}-${mode}.pdf`), pdf[mode]);
    }
  });

  it('embeds the same images: the 166x70 logo only', () => {
    expect(read.chromium.images).toEqual(['166x70']);
    expect(read.native.images).toEqual(read.chromium.images);
  });

  it('prints identical text, apart from the per-page header row and footer', () => {
    expect(bodyText(read.native, vm)).toBe(bodyText(read.chromium, vm));
  });

  it('both renderers print every view-model string (neither drops nor invents a value)', () => {
    for (const mode of ['chromium', 'native'] as const) {
      const text = strip(read[mode].pageTexts.join(''));
      for (const s of viewStrings(vm)) expect({ mode, s, found: text.includes(strip(s)) }).toEqual({ mode, s, found: true });
    }
  });

  it('every page carries "Page x of N" (its own N) and the table header repeats on every page with rows', () => {
    for (const mode of ['chromium', 'native'] as const) {
      const r = read[mode];
      r.pageTexts.forEach((t, i) => {
        const page = strip(t);
        expect({ mode, page: i + 1, footer: page.includes(`·Page${i + 1}of${r.pageCount}`) }).toEqual({ mode, page: i + 1, footer: true });
        const hasRow = vm.rows.some((row) => page.includes(strip(row.sub)));
        if (hasRow) expect({ mode, page: i + 1, header: page.includes(strip(vm.columns.join(''))) }).toEqual({ mode, page: i + 1, header: true });
      });
    }
  });

  it('same page count within one 40-row segment; beyond, at most one extra page per segment boundary (D4)', () => {
    const boundaries = Math.max(0, Math.ceil(vm.rows.length / TABLE_SEGMENT_ROWS) - 1);
    if (boundaries === 0) expect(read.native.pageCount).toBe(read.chromium.pageCount);
    else {
      expect(read.native.pageCount).toBeGreaterThanOrEqual(read.chromium.pageCount);
      expect(read.native.pageCount).toBeLessThanOrEqual(read.chromium.pageCount + boundaries);
    }
  });
});

describe('QR component parity', () => {
  it('Chromium (pre-shift roster) and the native QrCode embed the same QR PNG; both decode to the payload', async () => {
    const payload = 'rab-qr-v1.fixture-shift-parity.fixture-signature-0123456789';
    const png = await new QrImageService().generatePng(payload);
    const chromium = await renderReportPdf(
      { kind: 'pre-shift', data: { ...SHIFT_INFO, staff: [], qrPngBase64: png.toString('base64') } },
      { ...process.env, PDF_RENDERER: 'chromium' },
    );
    const native = await renderToBuffer(h(Document, null, h(Page, { size: 'A4' }, h(QrCode, { png, sizePx: 128 }))) as Parameters<typeof renderToBuffer>[0]);
    if (OUT) {
      writeFileSync(join(OUT, 'qr-chromium.pdf'), chromium);
      writeFileSync(join(OUT, 'qr-native.pdf'), native);
    }
    const decode = (bytes: Buffer) => rasterImages(bytes).map((im) => jsQR(im.rgba, im.width, im.height)?.data ?? null);
    expect(decode(chromium)).toEqual([payload]);
    expect(decode(native)).toEqual([payload]);
  });
});
