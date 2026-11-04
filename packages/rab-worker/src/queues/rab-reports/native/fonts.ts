import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';

import { Font } from '@react-pdf/renderer';

import { breakOnlyOverlongTokens } from './word-breaking';

export { breakOnlyOverlongTokens, OVERLONG_TOKEN_CHARS } from './word-breaking';

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
/**
 * The family stack every layout uses (`fontFamily: [...FONT_FAMILY_STACK]`). In-process (this interim module) only the
 * primary family is registered; the render runtime's own stack (runtime/native-fonts.ts: Liberation Sans, then the Noto
 * Sans fallback) replaces this export when the runtime is wired in, with no layout change.
 */
export const FONT_FAMILY_STACK: readonly string[] = Object.freeze([FONT_FAMILY]);
export const FONT_DIR = join(__dirname, 'assets', 'fonts');

const FONT_FILES: Readonly<Record<400 | 700, string>> = Object.freeze({ 400: 'LiberationSans-Regular.ttf', 700: 'LiberationSans-Bold.ttf' });

let registered = false;

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
