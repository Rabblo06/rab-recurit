import { execFileSync } from 'child_process';
import { copyFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

import { compareExtractions, ComparisonResult, formatReport, tokens } from './checker';
import { expectationFor, renderCall } from './documents';
import { buildFixtures, FixtureDocument, fixtureIds } from './fixtures';
import { GlyphTransform, loadGlyphTransform } from './glyph-transform';
import { extractFixture, outDir, RENDER_CONCURRENCY, saveArtifact, verifyShiftQr } from './harness';
import { clippingEvidence, F_PDF_1, F_PDF_1_FIXTURES } from './known-findings';
import { changedByF1, htmlReference, nativeExpectation, tokensJoiningForcedBreaks } from './native-reference';
import { chromiumRenderer, loadNativeRenderer, mapLimit, NativeNotConvertedError, switchChromiumHtml } from './renderers';

/**
 * OWNER DECISION D6 — PENDING (not accepted here). On the long-text timesheets Chromium wraps a hyphenated surname after
 * its hyphen ("Worthington-" / "Smythe"); react-pdf's textkit splits words on spaces only and keeps
 * "Worthington-Smythe" whole (word-breaking.ts). The words differ, so `tokens` fails. Until the owner decides D6 these
 * comparisons stay `test.failing` (RED the day they pass), and `d6Evidence` pins that this hyphen-wrap difference is the
 * ONLY failure on them.
 */
const D6 = 'D6 (owner decision pending: Chromium wraps "Worthington-" / "Smythe", native keeps "Worthington-Smythe")';
const D6_FIXTURES = ['long-text/final-timesheet-original', 'long-text/final-timesheet'];

/**
 * CHROMIUM vs NATIVE equality (P0 plan §5.2, owner-approved 2026-11-04) over the whole fixture matrix:
 *   - every check of checker.ts, with D4 (40-row segments: one extra page allowed per segment boundary) and the native
 *     renderer held to the page bounds (no overflow; long tokens wrap);
 *   - the Chromium HTML produced through the switch equals today's template output byte for byte (view-model refactor);
 *   - the native QR is verified by AttendanceQrService.validateQr for its shift only;
 *   - D6 golden rasters: page 1 and the last page of both renders are written to <out>/native/rasters for owner review;
 *     where an owner-approved native golden exists (golden/<fixture>.p1.png), the native raster must match it within
 *     PDF_EQUALITY_PIXEL_THRESHOLD (fraction of pixels, default 0.001). PDF_EQUALITY_UPDATE_GOLDEN=1 writes the current
 *     native rasters as the goldens — run it ONLY to record an owner sign-off.
 *
 * Skips (with the reason) until `render-pdf.util.ts` has the `renderPdf` switch; PDF_EQUALITY_REQUIRE_NATIVE=1 turns
 * the skip, and every NOT CONVERTED document, into a failure (use it in CI once P2 has converted all three).
 *
 *   bash C:/rab-ai-wt/setup/heavy-run.sh pdf-tests npx jest -c packages/rab-worker/src/__tests__/pdf-equality/jest.config.ts pdf-equality.native
 */
jest.setTimeout(60 * 60_000);

const native = loadNativeRenderer();
const REQUIRE = process.env.PDF_EQUALITY_REQUIRE_NATIVE === '1';
const OUT = outDir('native');
const RASTERS = join(OUT, 'rasters');
const GOLDEN = process.env.PDF_EQUALITY_GOLDEN_DIR || join(__dirname, 'golden');
const THRESHOLD = Number(process.env.PDF_EQUALITY_PIXEL_THRESHOLD) || 0.001;
const SCRIPT = join(__dirname, 'rasterise.mjs');
const IDS = fixtureIds();

function rasterise(pdfFile: string, prefix: string): string[] {
  const out = execFileSync(process.execPath, [SCRIPT, 'render', pdfFile, prefix], { encoding: 'utf8' });
  return (JSON.parse(out) as { files: string[] }).files;
}
function pixelDiff(a: string, b: string, diffFile: string): { sameSize: boolean; ratio: number } {
  return JSON.parse(execFileSync(process.execPath, [SCRIPT, 'diff', a, b, diffFile], { encoding: 'utf8' })) as { sameSize: boolean; ratio: number };
}

if ('unavailable' in native) {
  // eslint-disable-next-line no-console
  console.warn(`[pdf-equality] native renderer unavailable: ${native.unavailable}`);
  (REQUIRE ? describe : describe.skip)('Chromium vs native (renderer unavailable)', () => {
    it('native renderer is available', () => {
      throw new Error(native.unavailable);
    });
  });
} else {
  describe('Chromium vs native', () => {
    let fixtures: Map<string, FixtureDocument>;
    const renders = new Map<string, { chromium: Buffer; native: Buffer | NativeNotConvertedError; chromiumFile: string; nativeFile: string | null }>();
    const results: ComparisonResult[] = [];
    const notConverted: string[] = [];

    beforeAll(async () => {
      mkdirSync(RASTERS, { recursive: true });
      fixtures = new Map((await buildFixtures()).map((f) => [f.id, f]));
      await mapLimit([...fixtures.values()], RENDER_CONCURRENCY, async (f) => {
        const chromium = await chromiumRenderer.render(f.doc);
        const n = await native.render(f.doc).catch((e: unknown) => {
          if (e instanceof NativeNotConvertedError) return e;
          throw e;
        });
        renders.set(f.id, {
          chromium,
          native: n,
          chromiumFile: saveArtifact(OUT, f.id, 'chromium.pdf', chromium),
          nativeFile: Buffer.isBuffer(n) ? saveArtifact(OUT, f.id, 'native.pdf', n) : null,
        });
      });
    });

    afterAll(() => {
      const extra = notConverted.length ? `\n\nNOT CONVERTED to native yet (${notConverted.length}): ${notConverted.join(', ')}` : '';
      saveArtifact(OUT, 'report', 'txt', formatReport(results, 'PDF equality: Chromium vs native') + extra);
    });

    /**
     * The comparison of one fixture (null when native has not converted its kind). The native side is held to its own
     * expectation: F1 (□ for every character the bundled fonts cannot print, from the runtime's GlyphCoverage) and
     * react-pdf's forced-break hyphens. Where F1 changes the document or Chromium is known to drop text (F-PDF-1), the
     * native render's cross-checks run against the document itself (native-reference.ts), not against Chromium.
     */
    const compared = new Map<string, Promise<ComparisonResult | null>>();
    const compare = (id: string): Promise<ComparisonResult | null> => {
      if (!compared.has(id)) compared.set(id, compareOnce(id));
      return compared.get(id)!;
    };
    async function compareOnce(id: string): Promise<ComparisonResult | null> {
      const f = fixtures.get(id)!;
      const r = renders.get(id)!;
      if (!Buffer.isBuffer(r.native)) {
        notConverted.push(id);
        if (REQUIRE) throw r.native;
        return null;
      }
      const glyphs = await loadGlyphTransform();
      if ('unavailable' in glyphs) throw new Error(`native renderer present but its F1 glyph transform is not: ${glyphs.unavailable}`);
      const transform: GlyphTransform = glyphs.transform;
      const switchHtml = switchChromiumHtml(f.doc);
      const chromiumX = extractFixture(f, r.chromium);
      const nativeX = extractFixture(f, r.native);
      const expectChromium = expectationFor(f.doc);
      const known = F_PDF_1_FIXTURES[id];
      const useDocument = known !== undefined || (await changedByF1(f.doc, transform));
      const reference = useDocument ? await htmlReference(f.doc, nativeX, transform) : undefined;
      const result = compareExtractions(id, expectChromium, chromiumX, nativeX, ['chromium', 'native'], {
        segmentRows: 40,
        boundsStrict: ['native'],
        forcedBreakHyphens: ['native'],
        expectB: await nativeExpectation(expectChromium, transform),
        referenceB: reference && { ...reference, tokensB: (x) => tokensJoiningForcedBreaks(x, reference.tokens) },
      });
      if (known) {
        // F-PDF-1: Chromium's own input checks fail exactly as pinned in the self-test (known-findings.ts) — INFO here;
        // any other Chromium failure, or a different shape of this one, still fails.
        const e = clippingEvidence(f.doc, chromiumX, 'chromium', known.droppedHeading);
        const asPinned =
          JSON.stringify(e.missing) === JSON.stringify(known.missing) && e.parseBack === known.parseBack && e.tokenCharsPrinted > 0 && e.tokenCharsPrinted < 1000 && !e.droppedHeadingPrinted;
        for (const finding of result.findings) {
          if (asPinned && (finding.check === 'values-present(chromium)' || finding.check === 'parse-back(chromium)') && !finding.ok) {
            finding.info = true;
            finding.detail = `KNOWN FINDING ${F_PDF_1}: ${finding.detail}`;
          }
        }
      }
      if (switchHtml !== null) {
        const same = switchHtml === renderCall(f.doc).html;
        result.findings.push({ check: 'html-unchanged', ok: same, detail: same ? 'switch HTML byte-identical to the template' : 'the HTML Chromium renders through the switch differs from the template output' });
      }
      if (f.kind === 'pre-shift-report') {
        const payload = extractFixture(f, r.native).qrPayloads[0];
        const problems = payload ? await verifyShiftQr(f.scenario, payload) : ['no QR decoded from the native PDF'];
        result.findings.push({ check: 'qr-verified(native)', ok: problems.length === 0, detail: problems.length ? problems.join('; ') : 'validateQr accepts it for its shift and refuses another shift' });
      }
      // Rasters for review; native vs its owner-approved golden.
      const base = id.replace(/[^A-Za-z0-9._-]+/g, '__');
      rasterise(r.chromiumFile, join(RASTERS, `${base}.chromium`));
      const nativeRasters = rasterise(r.nativeFile!, join(RASTERS, `${base}.native`));
      for (const file of nativeRasters) {
        const page = file.endsWith('.last.png') ? 'last' : 'p1';
        const golden = join(GOLDEN, `${base}.${page}.png`);
        if (process.env.PDF_EQUALITY_UPDATE_GOLDEN === '1') {
          mkdirSync(GOLDEN, { recursive: true });
          copyFileSync(file, golden);
          result.findings.push({ check: `golden-${page}`, ok: true, info: true, detail: `golden written: ${golden}` });
        } else if (existsSync(golden)) {
          const diff = pixelDiff(golden, file, join(RASTERS, `${base}.${page}.golden-diff.png`));
          result.findings.push({
            check: `golden-${page}`,
            ok: diff.sameSize && diff.ratio <= THRESHOLD,
            detail: diff.sameSize ? `${(diff.ratio * 100).toFixed(3)}% pixels differ (threshold ${(THRESHOLD * 100).toFixed(3)}%)` : 'raster size differs from the golden',
          });
        } else {
          result.findings.push({ check: `golden-${page}`, ok: true, info: true, detail: `no owner-approved golden yet; raster for review: ${file}` });
        }
      }
      result.ok = result.findings.every((x) => x.ok || x.info);
      results.push(result);
      return result;
    }

    const assertEqual = async (id: string) => {
      const result = await compare(id);
      if (result && !result.ok) throw new Error(formatReport([result]));
    };
    it.each(IDS.filter((id) => !D6_FIXTURES.includes(id)))('%s', assertEqual);

    // D6 is pending: the full comparison stays, as `test.failing` …
    test.failing.each(D6_FIXTURES)(`%s — ${D6}`, assertEqual);
    // … and the hyphen-wrap difference is the only thing that fails on those fixtures.
    it.each(D6_FIXTURES)(`%s: ${D6} — evidence, and no other failure`, async (id) => {
      const result = await compare(id);
      if (!result) throw new Error(`${id}: native not converted`);
      expect(result.findings.filter((x) => !x.ok && !x.info).map((x) => x.check)).toEqual(['tokens']);
      const r = renders.get(id)!;
      const f = fixtures.get(id)!;
      const count = (ws: string[]) => ws.reduce((m, w) => m.set(w, (m.get(w) ?? 0) + 1), new Map<string, number>());
      const a = count(tokens(extractFixture(f, r.chromium).text));
      const b = count(tokens(extractFixture(f, r.native as Buffer).text));
      const onlyA = new Map([...a].map(([w, n]) => [w, n - (b.get(w) ?? 0)] as const).filter(([, n]) => n > 0));
      const onlyB = new Map([...b].map(([w, n]) => [w, n - (a.get(w) ?? 0)] as const).filter(([, n]) => n > 0));
      const k = onlyB.get('Worthington-Smythe') ?? 0;
      expect(k).toBeGreaterThan(0);
      expect(Object.fromEntries(onlyA)).toEqual({ 'Worthington-': k, Smythe: k });
      expect(Object.fromEntries(onlyB)).toEqual({ 'Worthington-Smythe': k });
    });
  });
}
