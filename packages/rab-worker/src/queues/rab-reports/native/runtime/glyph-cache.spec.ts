import { readFileSync } from 'fs';
import { createRequire } from 'module';
import { join } from 'path';

import {
  assertGlyphCache,
  GlyphCacheUnsupportedError,
  hasGlyphCache,
  resetGlyphCaches,
} from './glyph-cache';
import { FONT_DIR, VENDORED_FONTS } from './native-fonts';
import { PdfNativeRenderError } from './render-protocol';

/**
 * fontkit's glyph cache against the vendored fonts (glyph-cache.ts): the mechanism behind the pdf-equality flake of
 * 2026-11-05/06, and the reset the render thread now runs before every render. Pure fontkit, no thread, no react-pdf.
 */

interface FontkitFont {
  _glyphs: Record<number, unknown>;
  glyphForCodePoint(cp: number): { id: number; codePoints: number[] };
  layout(text: string): { glyphs: Array<{ codePoints: number[] }> };
  createSubset(): {
    includeGlyph(glyph: { id: number }): number;
    encode(): unknown;
  };
}

/**
 * react-pdf's own fontkit, the one the render thread's font objects come from, resolved along react-pdf's dependency
 * chain with Node's resolver (rab-worker does not depend on fontkit directly; Jest's mapper would hand back the ESM loader).
 */
function reactPdfFontkit(): { create(bytes: Buffer): unknown } {
  const worker = createRequire(__filename);
  const renderer = createRequire(worker.resolve('@react-pdf/renderer'));
  return createRequire(renderer.resolve('@react-pdf/font'))('fontkit') as {
    create(bytes: Buffer): unknown;
  };
}
const { create } = reactPdfFontkit();

const fonts = VENDORED_FONTS.map((f) => ({
  file: f.file,
  font: create(readFileSync(join(FONT_DIR, f.file))) as unknown as FontkitFont,
}));
const liberation = fonts.filter((f) => f.file.startsWith('Liberation'));
const Z_DOT = 'Ż'.codePointAt(0)!;
const Z = 'Z'.codePointAt(0)!;

/** What pdfkit does when it embeds a font: subset it, which fetches the components of every composite glyph. */
function embed(font: FontkitFont, cp: number): void {
  const subset = font.createSubset();
  subset.includeGlyph(font.glyphForCodePoint(cp));
  subset.encode();
}

describe('fontkit glyph cache (render isolation)', () => {
  it.each(liberation)(
    '$file: embedding "Ż" before any "Z" was laid out leaves "Z" with no code points in the cache (the bug)',
    ({ file }) => {
      const font = create(
        readFileSync(join(FONT_DIR, file)),
      ) as unknown as FontkitFont;
      embed(font, Z_DOT);
      // The text engine's view of "ZW[" afterwards: "Z" maps to no character, so every later string index shifts.
      expect(font.layout('ZW[').glyphs.map((g) => g.codePoints)).toEqual([
        [],
        ['W'.codePointAt(0)],
        ['['.codePointAt(0)],
      ]);
      // After the reset the render thread runs before every render, "Z" is a "Z" again.
      resetGlyphCaches([font]);
      expect(font.layout('ZW[').glyphs.map((g) => g.codePoints)).toEqual([
        [Z],
        ['W'.codePointAt(0)],
        ['['.codePointAt(0)],
      ]);
    },
  );

  it('every vendored font has a resettable cache, and a reset empties it', () => {
    for (const { file, font } of fonts) {
      font.glyphForCodePoint(Z);
      expect({ file, cached: Object.keys(font._glyphs).length > 0 }).toEqual({
        file,
        cached: true,
      });
      expect(hasGlyphCache(font)).toBe(true);
    }
    resetGlyphCaches(fonts.map((f) => f.font));
    for (const { file, font } of fonts)
      expect({ file, cached: Object.keys(font._glyphs) }).toEqual({
        file,
        cached: [],
      });
  });

  it('fails closed when a font has no resettable cache (fontkit internals changed): nothing is reset', () => {
    const [{ font }] = fonts;
    font!.glyphForCodePoint(Z);
    const before = font!._glyphs;
    for (const odd of [
      {},
      { _glyphs: null },
      { _glyphs: [] },
      Object.freeze({ _glyphs: {} }),
      null,
      'Liberation Sans',
    ]) {
      expect(hasGlyphCache(odd)).toBe(false);
      expect(() => assertGlyphCache(odd)).toThrow(GlyphCacheUnsupportedError);
      expect(() => resetGlyphCaches([font, odd])).toThrow(PdfNativeRenderError);
      expect(font!._glyphs).toBe(before); // all or nothing
    }
  });
});
