import { PdfNativeRenderError } from './render-protocol';

/**
 * Render isolation for fontkit's glyph cache (pdf-equality flake of 2026-11-05/06, PR #78 and #80).
 *
 * A render thread keeps its fontkit font objects between renders (they are react-pdf's own, parsed once per thread).
 * fontkit 2.0.4 caches every glyph object by glyph id in `font._glyphs`, and the object keeps the code points of the
 * FIRST request for that id (`TTFFont.getGlyph(id, characters = [])`). Both consumers of a glyph read those code points
 * as if they belonged to the current occurrence:
 *
 *  - textkit maps glyphs back to string indices with `glyph.codePoints.length` (`resolve` / `resolve$1`), so a glyph
 *    with no code points shifts every later index of its run: lines break one glyph late or early;
 *  - pdfkit writes the ToUnicode CMap from them (`EmbeddedFont.encode`: `unicode[gid] = glyph.codePoints`): no code
 *    points, an empty mapping (`<>`), and the letter is missing from the text layer (copy, search, screen readers).
 *
 * The PDF subsetter asks for the COMPONENTS of every composite glyph with no code points at all (`TTFSubset`:
 * `font.getGlyph(gid)`). In Liberation Sans, "Ż", "Ź" and "Ž" are composites of "Z" plus an accent (as "ë" is of "e",
 * "Å" of "A", ...). So once a thread had embedded a "Ż" before it ever laid out a plain "Z" in that weight, every later
 * render in that thread, whoever it was for, laid "Z" out with no code points: a hostile note wrapped differently and
 * lost its "Z" from the text layer, depending only on which earlier document the pool happened to give that thread.
 *
 * The fix: every render starts from an EMPTY glyph cache in every font object the thread has parsed, so a render's
 * output is a function of its own input only (never of an earlier render, another tenant's included). The cache is a
 * pure memo (glyph objects are rebuilt from the parsed tables on demand), so emptying it changes no output of a fresh
 * thread; it costs re-creating the few hundred glyph objects a document uses.
 *
 * `_glyphs` is fontkit-internal. A fontkit whose font objects do not have it as a plain own object FAILS CLOSED: the
 * thread refuses to start (and a font found later without it refuses the render), never renders with a cache it cannot
 * reset. `glyph-cache.spec.ts` pins the behaviour against the vendored fonts.
 */

/** The part of a fontkit 2.x font object this module touches. */
export interface GlyphCachedFont {
  _glyphs: Record<number, unknown>;
}

export class GlyphCacheUnsupportedError extends PdfNativeRenderError {
  constructor() {
    super(
      'native PDF renderer: the font engine has no resettable glyph cache (fontkit internals changed); refusing to render',
      'error_PDF_GLYPH_CACHE_UNSUPPORTED',
    );
    this.name = 'GlyphCacheUnsupportedError';
  }
}

export function hasGlyphCache(font: unknown): font is GlyphCachedFont {
  if (font === null || typeof font !== 'object') return false;
  const cache = Object.getOwnPropertyDescriptor(font, '_glyphs');
  return (
    cache !== undefined &&
    cache.writable === true &&
    cache.value !== null &&
    typeof cache.value === 'object' &&
    !Array.isArray(cache.value)
  );
}

/** Throws GlyphCacheUnsupportedError unless `font` has fontkit's resettable glyph cache. */
export function assertGlyphCache(
  font: unknown,
): asserts font is GlyphCachedFont {
  if (!hasGlyphCache(font)) throw new GlyphCacheUnsupportedError();
}

/** Empties the glyph cache of every font (fail closed: throws, resetting none, if any font lacks one). */
export function resetGlyphCaches(fonts: readonly unknown[]): void {
  for (const font of fonts) assertGlyphCache(font);
  for (const font of fonts as readonly GlyphCachedFont[]) font._glyphs = {};
}
