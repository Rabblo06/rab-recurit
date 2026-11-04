import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';

import { Font } from '@react-pdf/renderer';

/**
 * Embedded fonts for the native PDF renderer (PDF renderer P1, owner decision D11). INTERIM: the render-runtime agent
 * (P) owns the font assets, the Noto fallback subsets (D3) and the glyph-coverage guard; this module is the minimal
 * registration the final timesheet needs until that lands, and keeps the same location and rules.
 *
 * Liberation Sans 2.1.5 (SIL Open Font License 1.1, `assets/fonts/OFL.txt`), from the upstream release tarball
 * liberation-fonts-ttf-2.1.5. Metric-compatible with Arial, which the Chromium templates ask for; the files are
 * byte-identical to the Alpine `font-liberation` 2.1.5 package that Chromium substitutes for Arial in the Worker image.
 * The build copies `assets/` next to the compiled file (project.json), so `__dirname/assets/fonts` resolves from `src`
 * and from `dist`. Read from disk by path, never fetched; every file is checked against `fonts.sha256` before it is
 * registered, and a missing or altered file refuses the render (fail closed).
 */
export const FONT_FAMILY = 'Liberation Sans';
export const FONT_DIR = join(__dirname, 'assets', 'fonts');

const FONT_FILES: Readonly<Record<400 | 700, string>> = Object.freeze({ 400: 'LiberationSans-Regular.ttf', 700: 'LiberationSans-Bold.ttf' });

let registered = false;

/** A token longer than this many characters (no space or hyphen in it) may be broken anywhere. */
export const OVERLONG_TOKEN_CHARS = 24;

/**
 * Word breaking. Chromium never hyphenates these templates, and react-pdf's default English hyphenation would, so
 * ordinary words stay whole. But with no break opportunity at all an unbroken token wider than its box (a 140-character
 * name, a URL in the notes) overflows it and is drawn over the neighbouring text (MEASURED; Chromium instead shrinks the
 * whole page to fit). A token longer than OVERLONG_TOKEN_CHARS may therefore break between any two characters. react-pdf
 * always draws a "-" at such a break (textkit inserts it; it cannot be turned off), so a broken token shows hyphens that
 * are not in the data — the price of keeping every character on the page (plan §6 native/fonts.ts; owner to confirm).
 */
export function breakOnlyOverlongTokens(word: string): string[] {
  return word.length > OVERLONG_TOKEN_CHARS ? Array.from(word) : [word];
}

function expectedHashes(): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of readFileSync(join(FONT_DIR, 'fonts.sha256'), 'utf8').split('\n')) {
    const m = /^([0-9a-f]{64})\s+\*?(\S+)$/.exec(line.trim());
    if (m) map.set(m[2]!, m[1]!);
  }
  return map;
}

/** Registers the embedded font once per process (react-pdf's font store is global). Throws if a file is missing or altered. */
export function ensureNativePdfFonts(): void {
  if (registered) return;
  const hashes = expectedHashes();
  const fonts = Object.entries(FONT_FILES).map(([weight, file]) => {
    const src = join(FONT_DIR, file);
    let bytes: Buffer;
    try {
      bytes = readFileSync(src);
    } catch {
      throw new Error(`native PDF renderer: embedded font missing: ${file}`);
    }
    if (createHash('sha256').update(bytes).digest('hex') !== hashes.get(file)) throw new Error(`native PDF renderer: embedded font altered: ${file}`);
    return { src, fontWeight: Number(weight) };
  });
  Font.register({ family: FONT_FAMILY, fonts });
  Font.registerHyphenationCallback(breakOnlyOverlongTokens);
  registered = true;
}
