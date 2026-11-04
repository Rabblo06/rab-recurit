import { execFileSync } from 'child_process';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { FILE_KIND_RULES } from '@rab/server/engine/core-modules/storage/file-kinds';
import { FileService } from '@rab/server/engine/core-modules/storage/file.service';
import { contentDisposition, sanitiseFilename } from '@rab/server/engine/core-modules/storage/safe-filename';

import type { Finding } from './checker';
import { DOCUMENT_FILES, DOCUMENT_SPECS } from './documents';
import { extractPdf, PdfExtraction } from './extract';
import { fixtureAttendanceQr, FixtureDocument, scenarioSeeds, shiftEntity } from './fixtures';
import { REQUIRE_GOLDEN } from './mode';

/** Where suites write rendered PDFs and reports: PDF_EQUALITY_OUT, else <tmp>/rab-pdf-equality. Never inside the repo. */
export function outDir(suite: string): string {
  const dir = join(process.env.PDF_EQUALITY_OUT || join(tmpdir(), 'rab-pdf-equality'), suite);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function saveArtifact(dir: string, fixtureId: string, suffix: string, data: Buffer | string): string {
  const file = join(dir, `${fixtureId.replace(/[^A-Za-z0-9._-]+/g, '__')}.${suffix}`);
  writeFileSync(file, data);
  return file;
}

export function extractFixture(f: Pick<FixtureDocument, 'kind'>, pdf: Buffer): PdfExtraction {
  return extractPdf(pdf, { tableHeader: DOCUMENT_SPECS[f.kind].tableHeader ?? undefined });
}

/** Renders in flight at once in the equality suites (each Chromium render is its own browser process). */
export const RENDER_CONCURRENCY = Math.max(1, Number(process.env.PDF_EQUALITY_CONCURRENCY) || 3);

/**
 * QR verification (P0 plan §5.2 4(e)): the decoded payload is checked by the REAL `AttendanceQrService.validateQr`
 * against the fixture's own shift (read through a fake manager that returns only that shift). It must be accepted for
 * that shift and refused (InvalidQrException) for another shift id. Returns the problems found (empty = verified).
 */
export async function verifyShiftQr(scenarioId: string, payload: string): Promise<string[]> {
  const seed = scenarioSeeds().find((s) => s.id === scenarioId);
  if (!seed) return [`no scenario ${scenarioId}`];
  const shift = shiftEntity(seed);
  const manager = { findOneByOrFail: async () => shift } as never;
  const problems: string[] = [];
  try {
    await fixtureAttendanceQr.validateQr(manager, shift.id, payload);
  } catch (error) {
    problems.push(`validateQr refused the payload for its own shift: ${(error as Error).message}`);
  }
  const other = '00000000-0000-4000-8000-0000000000ff';
  const refused = await fixtureAttendanceQr.validateQr(manager, other, payload).then(
    () => false,
    () => true,
  );
  if (!refused) problems.push('validateQr accepted the payload for ANOTHER shift');
  return problems;
}

/**
 * How the production job would store this render (DOCUMENT_FILES, pinned to the job sources by the unit spec): the
 * storage layer's own content validation for the document's FileKind (`FileService.validateContent`: PDF magic bytes,
 * the kind's size ceiling) accepts the bytes as application/pdf; the filename the job passes is already safe (the
 * storage layer's `sanitiseFilename` leaves it unchanged) and is served as an attachment, never inline.
 */
export function fileFindings(f: Pick<FixtureDocument, 'kind' | 'doc'>, pdf: Buffer, name: string): Finding[] {
  const spec = DOCUMENT_FILES[f.kind];
  const rules = FILE_KIND_RULES[spec.fileKind];
  const out: Finding[] = [];
  try {
    // The real validator; `this.env` only supplies the deployment-wide upload cap, set above every kind's own ceiling.
    const fake = { env: { get: (key: string) => (key === 'S3_MAX_UPLOAD_BYTES' ? Number.MAX_SAFE_INTEGER : undefined) } };
    const accepted = FileService.prototype.validateContent.call(fake as unknown as FileService, spec.fileKind, pdf);
    const ok = accepted.ext === 'pdf' && accepted.mimeType === 'application/pdf' && rules.content === 'pdf' && !rules.inline;
    out.push({ check: `file-kind(${name})`, ok, detail: `${spec.fileKind} (${spec.job}): accepted as ${accepted.mimeType}, ${pdf.length} of ${rules.maxBytes} bytes, ${rules.inline ? 'inline' : 'attachment'}` });
  } catch (error) {
    out.push({ check: `file-kind(${name})`, ok: false, detail: `${spec.fileKind} (${spec.job}): the storage layer refuses the bytes: ${(error as Error).message}` });
  }
  const filename = spec.filename(f.doc);
  const safe = sanitiseFilename(filename, 'file') === filename && /\.pdf$/.test(filename);
  const disposition = contentDisposition(filename, rules.inline);
  out.push({
    check: `filename(${name})`,
    ok: safe && disposition.startsWith('attachment;'),
    detail: `${JSON.stringify(filename)} (${spec.job}): ${safe ? 'unchanged by sanitiseFilename' : 'CHANGED by sanitiseFilename or not .pdf'}; ${disposition.split(';')[0]}`,
  });
  return out;
}

const RASTER_SCRIPT = join(__dirname, 'rasterise.mjs');

/** Page 1 and the last page of a PDF as PNGs (rasterise.mjs, its own process); returns the files written. */
export function rasterise(pdfFile: string, prefix: string): string[] {
  const out = execFileSync(process.execPath, [RASTER_SCRIPT, 'render', pdfFile, prefix], { encoding: 'utf8' });
  return (JSON.parse(out) as { files: string[] }).files;
}

function pixelDiff(a: string, b: string, diffFile: string): { sameSize: boolean; ratio: number } {
  return JSON.parse(execFileSync(process.execPath, [RASTER_SCRIPT, 'diff', a, b, diffFile], { encoding: 'utf8' })) as { sameSize: boolean; ratio: number };
}

export const GOLDEN_DIR = process.env.PDF_EQUALITY_GOLDEN_DIR || join(__dirname, 'golden');
const PIXEL_THRESHOLD = Number(process.env.PDF_EQUALITY_PIXEL_THRESHOLD) || 0.001;

/**
 * D6 golden rasters: page 1 and the last page of the NATIVE render, written to `rastersDir` for owner review, and compared
 * with the owner-approved golden (`GOLDEN_DIR/<fixture>.p1.png` / `.last.png`) where one exists, within
 * PDF_EQUALITY_PIXEL_THRESHOLD (fraction of pixels, default 0.001). No golden yet: INFO (the owner has not signed one
 * off), or a failure with PDF_EQUALITY_REQUIRE_GOLDEN=1. PDF_EQUALITY_UPDATE_GOLDEN=1 writes the current rasters as the
 * goldens — run it ONLY to record an owner sign-off.
 */
export function goldenFindings(nativePdfFile: string, fixtureId: string, rastersDir: string): Finding[] {
  mkdirSync(rastersDir, { recursive: true });
  const base = fixtureId.replace(/[^A-Za-z0-9._-]+/g, '__');
  const out: Finding[] = [];
  for (const file of rasterise(nativePdfFile, join(rastersDir, `${base}.native`))) {
    const page = file.endsWith('.last.png') ? 'last' : 'p1';
    const golden = join(GOLDEN_DIR, `${base}.${page}.png`);
    if (process.env.PDF_EQUALITY_UPDATE_GOLDEN === '1') {
      mkdirSync(GOLDEN_DIR, { recursive: true });
      copyFileSync(file, golden);
      out.push({ check: `golden-${page}`, ok: true, info: true, detail: `golden written: ${golden}` });
    } else if (existsSync(golden)) {
      const diff = pixelDiff(golden, file, join(rastersDir, `${base}.${page}.golden-diff.png`));
      out.push({
        check: `golden-${page}`,
        ok: diff.sameSize && diff.ratio <= PIXEL_THRESHOLD,
        detail: diff.sameSize ? `${(diff.ratio * 100).toFixed(3)}% pixels differ (threshold ${(PIXEL_THRESHOLD * 100).toFixed(3)}%)` : 'raster size differs from the golden',
      });
    } else {
      out.push({
        check: `golden-${page}`,
        ok: !REQUIRE_GOLDEN,
        info: !REQUIRE_GOLDEN,
        detail: `no owner-approved golden yet (NEEDS OWNER APPROVAL); raster for review: ${file}`,
      });
    }
  }
  return out;
}
