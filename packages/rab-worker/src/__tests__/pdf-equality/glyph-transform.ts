import { join } from 'path';

/**
 * OWNER DECISION F1 (PDF plan §15, 2026-11-04) for the NATIVE side of the equality harness: every character the bundled
 * fonts cannot print visibly is printed as U+25A1 □ (CRLF becomes LF, TAB a space). The native expectation of a business
 * value is therefore the F1-transformed value, character for character.
 *
 * The transform is NOT reimplemented here. It is the runtime's own `GlyphCoverage`
 * (`queues/rab-reports/native/runtime/glyph-coverage.ts`), fed with the runtime's own vendored, sha256-verified fonts
 * (`native-fonts.ts` `loadVendoredFonts`, same families, same weights) parsed by fontkit — the font parser react-pdf uses
 * for its own per-character coverage (`Font.getFont(...).data` is a fontkit font). So a character the harness expects as
 * □ is exactly a character the render thread replaces.
 *
 * Feature-detected: in a tree without the native renderer (origin/main) `loadGlyphTransform()` says why it is
 * unavailable, and the native suites skip (or, with PDF_EQUALITY_REQUIRE_NATIVE=1, fail) for their own reasons.
 */
export type GlyphTransform = (values: readonly string[]) => Promise<string[]>;

interface GlyphFontLike {
  hasGlyphForCodePoint(codePoint: number): boolean;
}
interface CoverageModule {
  REPLACEMENT_MARKER: string;
  GlyphCoverage: new (primary: readonly GlyphFontLike[], loadFallback: () => Promise<readonly GlyphFontLike[]>) => {
    substitute(viewModel: unknown): Promise<{ value: unknown }>;
  };
}
interface FontsModule {
  PRIMARY_FONT_FAMILY: string;
  FALLBACK_FONT_FAMILY: string;
  loadVendoredFonts(): Array<{ family: string; weight: number; file: string; bytes: Buffer }>;
}

const NATIVE_RUNTIME = join(__dirname, '..', '..', 'queues', 'rab-reports', 'native', 'runtime');

let cached: Promise<{ transform: GlyphTransform; marker: string } | { unavailable: string }> | null = null;

export function loadGlyphTransform(): Promise<{ transform: GlyphTransform; marker: string } | { unavailable: string }> {
  cached ??= (async () => {
    let coverageModule: CoverageModule;
    let fonts: FontsModule;
    let fontkit: { create(bytes: Buffer): unknown };
    try {
      /* eslint-disable @typescript-eslint/no-require-imports */
      coverageModule = require(join(NATIVE_RUNTIME, 'glyph-coverage')) as CoverageModule;
      fonts = require(join(NATIVE_RUNTIME, 'native-fonts')) as FontsModule;
      fontkit = require('fontkit') as { create(bytes: Buffer): unknown };
      /* eslint-enable @typescript-eslint/no-require-imports */
    } catch (error) {
      return { unavailable: `no native glyph-coverage runtime in this tree (${(error as Error).message.split('\n')[0]})` };
    }
    const loaded = fonts.loadVendoredFonts();
    const family = (name: string): GlyphFontLike[] => {
      const out = loaded
        .filter((f) => f.family === name)
        .map((f) => {
          const font = fontkit.create(f.bytes) as Partial<GlyphFontLike>;
          if (typeof font.hasGlyphForCodePoint !== 'function') throw new Error(`glyph transform: ${f.file} is not a single font`);
          return font as GlyphFontLike;
        });
      if (out.length === 0) throw new Error(`glyph transform: no vendored font for family ${name}`);
      return out;
    };
    const coverage = new coverageModule.GlyphCoverage(family(fonts.PRIMARY_FONT_FAMILY), async () => family(fonts.FALLBACK_FONT_FAMILY));
    const transform: GlyphTransform = async (values) => {
      const { value } = await coverage.substitute([...values]);
      if (!Array.isArray(value) || value.length !== values.length || value.some((v) => typeof v !== 'string')) {
        throw new Error('glyph transform: GlyphCoverage.substitute did not return the strings it was given');
      }
      return value as string[];
    };
    return { transform, marker: coverageModule.REPLACEMENT_MARKER };
  })();
  return cached;
}
