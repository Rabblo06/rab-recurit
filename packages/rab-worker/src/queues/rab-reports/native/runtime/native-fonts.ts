import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';

import { breakOnlyOverlongTokens } from '../word-breaking';

/**
 * Embedded fonts for the native PDF renderer (PDF renderer migration P1; owner decisions D11, F1 and F3).
 *
 * Every file is vendored in `../assets/fonts/` (beside the compiled code in `dist` too), pinned by the sha256 below,
 * read from disk ONCE, verified, and handed to react-pdf as in-memory bytes (a `data:` source, so react-pdf never opens
 * a path or fetches a URL itself). A missing or altered file refuses to start the render thread: fail closed, no
 * system-font lookup, no fontconfig, no network.
 *
 *  Primary: Liberation Sans 2.1.5 Regular + Bold (SIL OFL 1.1, `OFL.txt`), metric-compatible with Arial, the font the
 *    Chromium templates ask for. Source: upstream release tarball liberation-fonts-ttf-2.1.5.tar.gz
 *    (github.com/liberationfonts/liberation-fonts/files/7261482, tarball sha256
 *    7191c669bf38899f73a2094ed00f7b800553364f90e2637010a69c0e268f25d0). No italic: no template uses one.
 *
 *  Fallback: Noto Sans 2.015 Regular + Bold, unhinted TTF (SIL OFL 1.1, `noto-sans/OFL.txt`): the Latin, Greek
 *    and Cyrillic member of the Noto family. Source: github.com/notofonts/latin-greek-cyrillic release NotoSans-v2.015
 *    (NotoSans-v2.015.zip sha256 0c34df072a3fa7efbb7cbf34950e1f971a4447cffe365d3a359e2d4089b958f5, files
 *    NotoSans/unhinted/ttf/NotoSans-{Regular,Bold}.ttf and OFL.txt).
 *    Owner decision F1 (plan §15): exactly these two families. Any character outside them (CJK, Arabic, Devanagari,
 *    emoji, ...) is printed as a visible replacement marker and logged as a count (glyph-coverage.ts); more Noto
 *    families only if counted data shows a need, and then loaded lazily. Liberation Sans itself maps Hebrew (MEASURED;
 *    react-pdf's bidi prints it in correct right-to-left order, render-pool.spec.ts "F2").
 *    The fallback is parsed lazily: only when a string or a layout first needs it in a thread (F3).
 *
 * `fontWeight` 600 resolves to Bold (react-pdf picks the nearest registered weight), as Chromium did with Liberation.
 */

export const FONT_DIR = join(__dirname, '..', 'assets', 'fonts');

export const PRIMARY_FONT_FAMILY = 'Liberation Sans';
export const FALLBACK_FONT_FAMILY = 'Noto Sans';

/**
 * The family stack every native layout must use for text (`style.fontFamily`). react-pdf picks, per character, the
 * first family in the stack that has a glyph; the glyph-coverage guard accepts exactly the characters this stack can
 * draw, so the guard and the renderer can never disagree.
 */
export const FONT_FAMILY_STACK: readonly string[] = Object.freeze([
  PRIMARY_FONT_FAMILY,
  FALLBACK_FONT_FAMILY,
]);

export interface VendoredFontFile {
  family: string;
  weight: 400 | 700;
  /** Relative to FONT_DIR. */
  file: string;
  sha256: string;
}

export const VENDORED_FONTS: readonly VendoredFontFile[] = Object.freeze([
  {
    family: PRIMARY_FONT_FAMILY,
    weight: 400,
    file: 'LiberationSans-Regular.ttf',
    sha256: '76d04c18ea243f426b7de1f3ad208e927008f961dc5945e5aad352d0dfde8ee8',
  },
  {
    family: PRIMARY_FONT_FAMILY,
    weight: 700,
    file: 'LiberationSans-Bold.ttf',
    sha256: '788abee4c806d660e8aee46689dd8540cd4bb98da03dcc9d171ce3efd99a9173',
  },
  {
    family: FALLBACK_FONT_FAMILY,
    weight: 400,
    file: 'noto-sans/NotoSans-Regular.ttf',
    sha256: 'f3961a9cde016d41a4879aecda1474d3a36d6bf54fa0e4643de029cc2248b0e8',
  },
  {
    family: FALLBACK_FONT_FAMILY,
    weight: 700,
    file: 'noto-sans/NotoSans-Bold.ttf',
    sha256: '87cb2d84472a7d66da659ee47b6cdb9552326e8c128245231f191b6ac72529d9',
  },
]);

/** Licence texts shipped with the fonts (OFL 1.1 §2 requires the licence to travel with the font software). */
export const VENDORED_FONT_LICENCES: readonly {
  file: string;
  sha256: string;
}[] = Object.freeze([
  {
    file: 'OFL.txt',
    sha256: '93fed46019c38bbe566b479d22148e2e8a1e85ada614accb0211c37b2c61c19b',
  },
  {
    file: 'noto-sans/OFL.txt',
    sha256: 'cee9892f9f0cc8fe882c9e9537ee6a89621d86ee7ceaf70b02e2b2b1c25c061a',
  },
]);

export class PdfFontIntegrityError extends Error {
  readonly code = 'error_PDF_FONT_INTEGRITY';
  constructor(message: string) {
    super(message);
    this.name = 'PdfFontIntegrityError';
  }
}

export interface LoadedFont extends VendoredFontFile {
  bytes: Buffer;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function readPinned(file: string, expected: string, dir: string): Buffer {
  let bytes: Buffer;
  try {
    bytes = readFileSync(join(dir, file));
  } catch {
    throw new PdfFontIntegrityError(
      `native PDF renderer: vendored font file missing: ${file}`,
    );
  }
  if (sha256(bytes) !== expected)
    throw new PdfFontIntegrityError(
      `native PDF renderer: vendored font file altered (sha256 mismatch): ${file}`,
    );
  return bytes;
}

/** Reads and verifies every vendored font and licence file. Throws `PdfFontIntegrityError` on any mismatch. */
export function loadVendoredFonts(dir: string = FONT_DIR): LoadedFont[] {
  for (const l of VENDORED_FONT_LICENCES) readPinned(l.file, l.sha256, dir);
  return VENDORED_FONTS.map((f) => ({
    ...f,
    bytes: readPinned(f.file, f.sha256, dir),
  }));
}

/** The subset of react-pdf's `Font` store this module uses (passed in, so this file never imports react-pdf). */
export interface ReactPdfFontStore {
  register(data: {
    family: string;
    fonts: { src: string; fontWeight: number }[];
  }): void;
  registerHyphenationCallback(cb: (word: string) => string[]): void;
  getRegisteredFontFamilies(): string[];
}

/**
 * Registers the verified fonts with react-pdf's (per-thread) font store, from memory, and the word-breaking rule
 * (../word-breaking.ts): ordinary words are never hyphenated (as in Chromium); only a token longer than 24 characters
 * may break, and the layouts' Text makes that a last resort (it would otherwise overflow its box).
 */
export function registerVendoredFonts(
  store: ReactPdfFontStore,
  fonts: readonly LoadedFont[],
): void {
  const already = new Set(store.getRegisteredFontFamilies());
  const byFamily = new Map<string, LoadedFont[]>();
  for (const f of fonts)
    byFamily.set(f.family, [...(byFamily.get(f.family) ?? []), f]);
  for (const [family, files] of byFamily) {
    if (already.has(family))
      throw new PdfFontIntegrityError(
        `native PDF renderer: font family registered twice: ${family}`,
      );
    store.register({
      family,
      fonts: files.map((f) => ({
        src: `data:font/ttf;base64,${f.bytes.toString('base64')}`,
        fontWeight: f.weight,
      })),
    });
  }
  store.registerHyphenationCallback(breakOnlyOverlongTokens);
}
