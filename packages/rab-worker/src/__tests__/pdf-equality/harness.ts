import { mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { DOCUMENT_SPECS } from './documents';
import { extractPdf, PdfExtraction } from './extract';
import { fixtureAttendanceQr, FixtureDocument, scenarioSeeds, shiftEntity } from './fixtures';

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
