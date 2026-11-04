import { mkdirSync } from 'fs';
import { join } from 'path';

import { checkAgainstDocument, compareExtractions, ComparisonResult, Finding, formatReport } from './checker';
import { DocumentKind, expectationFor, renderCall } from './documents';
import { PdfExtraction } from './extract';
import { buildFixtures, FixtureDocument, fixtureIds } from './fixtures';
import { GlyphTransform, loadGlyphTransform } from './glyph-transform';
import { extractFixture, fileFindings, goldenFindings, outDir, rasterise, RENDER_CONCURRENCY, saveArtifact, verifyShiftQr } from './harness';
import { clippingEvidence, F_PDF_1, F_PDF_1_FIXTURES, NOTES_LINE_BREAKS_IN_TEMPLATE } from './known-findings';
import { MODE, NATIVE_ONLY } from './mode';
import { changedByF1, documentWords, htmlReference, nativeExpectation } from './native-reference';
import { chromiumRenderer, loadNativeRenderer, mapLimit, NativeNotConvertedError, switchChromiumHtml } from './renderers';

/**
 * D6 hyphen wraps (approved with conditions, FINAL brief 2026-11-04) need no pin any more: the native kit now wraps a
 * hyphenated name after its own hyphen like Chromium (#55 bd7f7834), so the long-text words are an identical multiset in
 * compare mode. The rule itself stays in checker.ts `tokens` (accepted only with the joined text identical and every
 * other check passing), with its regressions in pdf-harness.unit.spec.ts; in native-only mode it is what accepts native's
 * wrap against the document's whole word.
 *
 * OWNER-ACCEPTED page-count delta (owner decision 2026-11-04). In compare mode the long-text documents paginate
 * differently: final timesheet (both variants) Chromium 6 / native 7 pages, roster 5 / 6. Agent A measured the cause:
 * Chromium rounds Liberation Sans' line box to whole px (9.00 pt baseline-to-baseline), react-pdf does not (9.49 pt), and
 * the 56-paragraph pre-line note runs ~5% longer. A matching lineHeight was tried and reverted (react-pdf 4.9.0 then
 * dropped a paragraph). The owner accepted it as a rule (checker.ts `extraPageAccepted` / `acceptOneExtraPage`): the
 * native render may print at most ONE page more than Chromium (beyond D4), and only when every other check passes. It
 * applies to every fixture, and the evidence test below pins that on these three the page count is the only difference,
 * at exactly the measured counts.
 */
const OWNER_PAGE_COUNT_DELTA = 'OWNER-ACCEPTED page-count delta (long note paginates one page longer natively)';
const OWNER_PAGE_COUNT_FIXTURES: Readonly<Record<string, { chromium: number; native: number }>> = Object.freeze({
  'long-text/final-timesheet-original': { chromium: 6, native: 7 },
  'long-text/final-timesheet': { chromium: 6, native: 7 },
  'long-text/pre-shift-report': { chromium: 5, native: 6 },
});

/**
 * NATIVE RENDERER EQUALITY over the whole fixture matrix (P0 plan §5.2, owner-approved 2026-11-04). Two modes
 * (mode.ts, PDF_EQUALITY_MODE, chosen by the workflow):
 *
 *   compare (default)  CHROMIUM vs NATIVE: every check of checker.ts, with D4 (40-row segments: one extra page allowed per
 *                      segment boundary) and the native renderer held to the page bounds (no overflow, no overlap; long
 *                      tokens wrap); the Chromium HTML produced through the seam equals today's template output byte for
 *                      byte (view-model refactor).
 *   native-only        P5 (no Chromium in the tree): the native render against the input and the DOCUMENT's own text
 *                      (checker.ts `checkAgainstDocument`: values, words, per-page footer, images), never Chromium.
 *
 * Both modes: the native QR is verified by AttendanceQrService.validateQr for its shift only; the storage layer accepts
 * the bytes as the job's FileKind and the job's filename is safe (`fileFindings`); D6 golden rasters (page 1 and the last
 * page) are written to <out>/native/rasters for owner review and compared with an owner-approved golden where one exists
 * (harness.ts `goldenFindings`; PDF_EQUALITY_REQUIRE_GOLDEN=1 once the owner has signed them off). The last test checks
 * coverage: ordinary, empty, long and hostile fixtures of every kind ran every required check, and it passed.
 *
 * Skips (with the reason) until `render-pdf.util.ts` has the native seam; PDF_EQUALITY_REQUIRE_NATIVE=1 turns the skip,
 * and every NOT CONVERTED document, into a failure.
 *
 *   bash C:/rab-ai-wt/setup/heavy-run.sh pdf-tests npx jest -c packages/rab-worker/src/__tests__/pdf-equality/jest.config.ts pdf-equality.native
 */
jest.setTimeout(60 * 60_000);

const native = loadNativeRenderer();
const REQUIRE = process.env.PDF_EQUALITY_REQUIRE_NATIVE === '1';
const OUT = outDir('native');
const RASTERS = join(OUT, 'rasters');
const IDS = fixtureIds();

/** Images each document embeds: the 166×70 logo, plus the signed Shift QR on the pre-shift roster. */
const DOCUMENT_IMAGES: Record<DocumentKind, number> = { 'final-timesheet-original': 1, 'final-timesheet': 1, 'pre-shift-report': 2, 'approved-shift-statement': 1 };

if ('unavailable' in native) {
  // eslint-disable-next-line no-console
  console.warn(`[pdf-equality] native renderer unavailable: ${native.unavailable}`);
  (REQUIRE ? describe : describe.skip)('native renderer equality (renderer unavailable)', () => {
    it('native renderer is available', () => {
      throw new Error(native.unavailable);
    });
  });
} else {
  describe(NATIVE_ONLY ? 'native only: the document is the reference (no Chromium)' : 'Chromium vs native', () => {
    let fixtures: Map<string, FixtureDocument>;
    const renders = new Map<string, { chromium: Buffer | null; native: Buffer | NativeNotConvertedError; chromiumFile: string | null; nativeFile: string | null }>();
    const results: ComparisonResult[] = [];
    const extractions = new Map<string, PdfExtraction>();
    const notConverted: string[] = [];

    beforeAll(async () => {
      mkdirSync(RASTERS, { recursive: true });
      fixtures = new Map((await buildFixtures()).map((f) => [f.id, f]));
      await mapLimit([...fixtures.values()], RENDER_CONCURRENCY, async (f) => {
        const chromium = NATIVE_ONLY ? null : await chromiumRenderer.render(f.doc);
        const n = await native.render(f.doc).catch((e: unknown) => {
          if (e instanceof NativeNotConvertedError) return e;
          throw e;
        });
        renders.set(f.id, {
          chromium,
          native: n,
          chromiumFile: chromium ? saveArtifact(OUT, f.id, 'chromium.pdf', chromium) : null,
          nativeFile: Buffer.isBuffer(n) ? saveArtifact(OUT, f.id, 'native.pdf', n) : null,
        });
      });
    });

    afterAll(() => {
      const extra = notConverted.length ? `\n\nNOT CONVERTED to native yet (${notConverted.length}): ${notConverted.join(', ')}` : '';
      saveArtifact(OUT, 'report', 'txt', formatReport(results, `PDF equality (${MODE}): ${NATIVE_ONLY ? 'native vs the document' : 'Chromium vs native'}`) + extra);
    });

    /**
     * The comparison of one fixture (null when native has not converted its kind). The native side is held to its own
     * expectation: F1 (□ for every character the bundled fonts cannot print, from the runtime's GlyphCoverage) and
     * react-pdf's forced-break hyphens. Where F1 changes the document, Chromium is known to drop text (F-PDF-1), or there
     * is no Chromium (native-only), the native render's cross-checks run against the document itself
     * (native-reference.ts), not against Chromium.
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
      const nativeX = extractFixture(f, r.native);
      extractions.set(id, nativeX);
      const expectInput = expectationFor(f.doc);
      const expectNative = await nativeExpectation(expectInput, transform);
      let result: ComparisonResult;
      if (NATIVE_ONLY) {
        const reference = await htmlReference(f.doc, nativeX, transform);
        result = checkAgainstDocument(id, expectNative, nativeX, 'native', reference, {
          boundsStrict: ['native'],
          forcedBreakHyphens: ['native'],
          images: DOCUMENT_IMAGES[f.kind],
        });
      } else {
        const switchHtml = switchChromiumHtml(f.doc);
        const chromiumX = extractFixture(f, r.chromium!);
        const known = F_PDF_1_FIXTURES[id];
        const useDocument = known !== undefined || (await changedByF1(f.doc, transform));
        const reference = useDocument ? await htmlReference(f.doc, nativeX, transform) : undefined;
        const words = documentWords(f.doc);
        result = compareExtractions(id, expectInput, chromiumX, nativeX, ['chromium', 'native'], {
          segmentRows: 40,
          boundsStrict: ['native'],
          forcedBreakHyphens: ['native'],
          expectB: expectNative,
          referenceB: reference,
          documentWords: { a: words, b: reference ? reference.tokens : words },
          // Chromium only, and only while this tree's template collapses notes (pinned in the self-test); never native.
          lineBreaksInfo: NOTES_LINE_BREAKS_IN_TEMPLATE ? [] : ['chromium'],
          // Owner-accepted (2026-11-04): native may print one page more than Chromium, only with every other check passing.
          extraPageAccepted: 'native',
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
        rasterise(r.chromiumFile!, join(RASTERS, `${id.replace(/[^A-Za-z0-9._-]+/g, '__')}.chromium`));
      }
      if (f.kind === 'pre-shift-report') {
        const payload = nativeX.qrPayloads[0];
        const problems = payload ? await verifyShiftQr(f.scenario, payload) : ['no QR decoded from the native PDF'];
        result.findings.push({ check: 'qr-verified(native)', ok: problems.length === 0, detail: problems.length ? problems.join('; ') : 'validateQr accepts it for its shift and refuses another shift' });
      }
      result.findings.push(...fileFindings(f, r.native, 'native'), ...goldenFindings(r.nativeFile!, id, RASTERS));
      result.ok = result.findings.every((x) => x.ok || x.info);
      results.push(result);
      return result;
    }

    const assertEqual = async (id: string) => {
      const result = await compare(id);
      if (result && !result.ok) throw new Error(formatReport([result]));
    };
    // Every fixture is a plain test; the owner-accepted page-count delta is a checker rule (see OWNER_PAGE_COUNT_DELTA).
    it.each(IDS)('%s', assertEqual);

    // Compare mode only (native-only mode has no Chromium page count): on the long-text fixtures the page count is the
    // ONLY difference, at exactly the measured counts, and it is accepted only because every other check passed.
    const pageAccepted = NATIVE_ONLY ? [] : Object.keys(OWNER_PAGE_COUNT_FIXTURES);
    if (pageAccepted.length) {
      it.each(pageAccepted)(`%s: ${OWNER_PAGE_COUNT_DELTA} — evidence: page count is the only difference`, async (id) => {
        const result = await compare(id);
        if (!result) throw new Error(`${id}: native not converted`);
        expect(result.ok).toBe(true);
        const page = result.findings.find((x) => x.check === 'page-count')!;
        const want = OWNER_PAGE_COUNT_FIXTURES[id]!;
        expect(page).toMatchObject({ ok: false, info: true });
        expect(page.detail).toBe(`chromium ${want.chromium}, native ${want.native} — ACCEPTED (owner 2026-11-04): native prints one page more; every other check passed`);
        // Nothing else failed and nothing else was waved through as INFO by this rule.
        expect(result.findings.filter((x) => !x.ok && x !== page && !x.info).map((x) => x.check)).toEqual([]);
        expect(result.findings.filter((x) => x.detail.includes('ACCEPTED (owner 2026-11-04)')).map((x) => x.check)).toEqual(['page-count']);
        expect(result.findings.find((x) => x.check === 'tokens')).toMatchObject({ ok: true });
      });
    }

    /**
     * Task-7 coverage (FINAL brief): ordinary (one-row), empty, long (long-text) and hostile fixtures of all three kinds
     * (the timesheet in both variants) ran, and passed, every check that applies to them: values (signature / sign-off
     * names included), parse-back, footers on every page, repeated table headings on multipage tables, the decoded and
     * verified QR payload, notes' line breaks, page bounds and overlap, active content, file kind and filename.
     */
    it('coverage: ordinary, empty, long and hostile fixtures of every kind ran every required check, and it passed', async () => {
      const scenarios = ['one-row', 'empty', 'long-text', 'hostile'];
      const kinds: DocumentKind[] = ['final-timesheet-original', 'final-timesheet', 'pre-shift-report', 'approved-shift-statement'];
      const gaps: string[] = [];
      const passed = (r: ComparisonResult, check: string): Finding | undefined => r.findings.find((x) => x.check === check && x.ok && !x.info);
      let multipageTables = 0;
      let signatures = 0;
      for (const scenario of scenarios) {
        for (const kind of kinds) {
          const ids = [...fixtures.values()].filter((f) => f.scenario === scenario && f.kind === kind).map((f) => f.id);
          if (ids.length === 0) gaps.push(`${scenario}/${kind}: no fixture`);
          for (const id of ids) {
            const r = await compare(id);
            if (!r) {
              gaps.push(`${id}: not rendered natively`);
              continue;
            }
            const f = fixtures.get(id)!;
            const x = extractions.get(id)!;
            const expectation = expectationFor(f.doc);
            const required = [
              'values-present(native)',
              'parse-back(native)',
              'values-equal',
              'tokens',
              'line-breaks(native)',
              'within-page(native)',
              'no-overlap(native)',
              'no-active-content(native)',
              'logo-166x70(native)',
              'qr-payloads(native)',
              'file-kind(native)',
              'filename(native)',
            ];
            if (kind === 'approved-shift-statement') required.push('no-footer(native)');
            else required.push('footer-numbering(native)', 'table-header-repeated(native)', NATIVE_ONLY ? 'footer-text' : 'footer-text-equal');
            if (kind === 'pre-shift-report') required.push('qr-verified(native)');
            for (const check of required) if (!passed(r, check)) gaps.push(`${id}: ${check} did not run and pass`);
            if (kind === 'pre-shift-report' && x.qrPayloads.length !== 1) gaps.push(`${id}: QR payload not decoded`);
            if (expectation.values.some((v) => /signature name/.test(v.label))) signatures++;
          }
        }
      }
      // Multipage tables: the 45-row documents carry rows on two or more pages, each with the heading repeated.
      for (const id of ['rows-45/final-timesheet-original', 'rows-45/final-timesheet', 'rows-45/pre-shift-report']) {
        const r = await compare(id);
        const x = extractions.get(id);
        if (!r || !x || !passed(r, 'table-header-repeated(native)')) gaps.push(`${id}: table-header-repeated(native) did not run and pass`);
        else if (x.pages.filter((p) => p.tableHeaderLines.length > 0).length >= 2) multipageTables++;
      }
      expect(gaps).toEqual([]);
      expect(multipageTables).toBe(3);
      expect(signatures).toBeGreaterThanOrEqual(6); // finalised-by / typed sign-off / approved-by names were checked
    });
  });
}
