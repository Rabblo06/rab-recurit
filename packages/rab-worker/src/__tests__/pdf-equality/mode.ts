/**
 * PDF_EQUALITY_MODE — which reference the harness holds the native renderer to. Selected by the workflow
 * (ci-pdf-equality), never guessed from the tree:
 *
 *   compare      (default) Chromium is in the tree: native is compared with Chromium (and with the document where F1 or
 *                F-PDF-1 make Chromium an invalid reference), and Chromium is self-tested. If this tree has no Chromium,
 *                the Chromium renderer FAILS LOUDLY (ChromiumRemovedError) — it never skips.
 *   native-only  P5, Chromium removed (INTEGRATION-ISSUES I-6). Nothing touches Chromium. The native render is checked
 *                against the input (every check) and against the document's own text (the view-model printed through
 *                the template HTML, F1 applied: native-reference.ts), plus the owner-reviewed golden rasters; the
 *                self-test becomes native vs native (deterministic bytes, D7) plus the altered-PDF checks; hostile text
 *                and load run native only.
 *
 * Any other value refuses to run (fail closed): a typo must not silently select a weaker mode.
 */
export type EqualityMode = 'compare' | 'native-only';

export function equalityMode(env: NodeJS.ProcessEnv = process.env): EqualityMode {
  const value = env.PDF_EQUALITY_MODE;
  if (value === undefined || value === '' || value === 'compare') return 'compare';
  if (value === 'native-only') return 'native-only';
  throw new Error(`PDF_EQUALITY_MODE must be "compare" or "native-only", got ${JSON.stringify(value)}`);
}

export const MODE: EqualityMode = equalityMode();
export const NATIVE_ONLY = MODE === 'native-only';

/**
 * PDF_EQUALITY_REQUIRE_GOLDEN=1: a fixture without an owner-approved golden raster fails (instead of INFO). Set it once
 * the owner has signed the golden rasters off (D6); until then the rasters are written for review only.
 */
export const REQUIRE_GOLDEN = process.env.PDF_EQUALITY_REQUIRE_GOLDEN === '1';
