import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

import {
  FONT_DIR,
  FONT_FAMILY_STACK,
  loadVendoredFonts,
  PdfFontIntegrityError,
  registerVendoredFonts,
  ReactPdfFontStore,
  VENDORED_FONT_LICENCES,
  VENDORED_FONTS,
} from './native-fonts';

/** Vendored fonts (D11, D3): pinned by sha256 in code, verified on load, fail closed on any change. */
describe('vendored fonts', () => {
  it('every pinned font and licence file is present and matches its sha256', () => {
    const fonts = loadVendoredFonts();
    expect(fonts.map((f) => `${f.family}/${f.weight}`)).toEqual([
      'Liberation Sans/400',
      'Liberation Sans/700',
      'Noto Sans/400',
      'Noto Sans/700',
    ]);
    for (const f of fonts) expect(f.bytes.readUInt32BE(0)).toBe(0x00010000); // TrueType sfnt
  });

  it('the human-readable fonts.sha256 manifests agree with the pins in code', () => {
    const pins = new Map(
      [...VENDORED_FONTS, ...VENDORED_FONT_LICENCES].map((f) => [
        f.file,
        f.sha256,
      ]),
    );
    const listed = new Map<string, string>();
    for (const [manifest, prefix] of [
      ['fonts.sha256', ''],
      ['noto-sans/fonts.sha256', 'noto-sans/'],
    ] as const) {
      for (const line of readFileSync(join(FONT_DIR, manifest), 'utf8').split(
        '\n',
      )) {
        const m = /^([0-9a-f]{64})\s+\*?(\S+)$/.exec(line.trim());
        if (m) listed.set(prefix + m[2]!, m[1]!);
      }
    }
    expect(listed).toEqual(pins);
  });

  it('the family stack is the primary font, then the fallback; both are pinned', () => {
    expect(FONT_FAMILY_STACK).toEqual(['Liberation Sans', 'Noto Sans']);
    for (const family of FONT_FAMILY_STACK)
      expect(
        VENDORED_FONTS.filter((f) => f.family === family).map((f) => f.weight),
      ).toEqual([400, 700]);
  });

  describe('tampering', () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'rab-fonts-'));
      for (const f of [...VENDORED_FONTS, ...VENDORED_FONT_LICENCES]) {
        mkdirSync(dirname(join(dir, f.file)), { recursive: true });
        copyFileSync(join(FONT_DIR, f.file), join(dir, f.file));
      }
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('an unmodified copy loads', () => {
      expect(loadVendoredFonts(dir)).toHaveLength(4);
    });

    it('one altered byte refuses (sha256 mismatch), naming the file', () => {
      const file = join(dir, 'noto-sans/NotoSans-Bold.ttf');
      const bytes = readFileSync(file);
      bytes[bytes.length - 1] ^= 0xff;
      writeFileSync(file, bytes);
      expect(() => loadVendoredFonts(dir)).toThrow(PdfFontIntegrityError);
      expect(() => loadVendoredFonts(dir)).toThrow(
        'noto-sans/NotoSans-Bold.ttf',
      );
    });

    it('a missing font or licence refuses', () => {
      unlinkSync(join(dir, 'LiberationSans-Regular.ttf'));
      expect(() => loadVendoredFonts(dir)).toThrow(
        'missing: LiberationSans-Regular.ttf',
      );
    });

    it('a missing licence refuses (OFL 1.1: the licence travels with the font)', () => {
      unlinkSync(join(dir, 'noto-sans/OFL.txt'));
      expect(() => loadVendoredFonts(dir)).toThrow(
        'missing: noto-sans/OFL.txt',
      );
    });
  });

  it('registers from memory (data: sources only, never a path or URL) and disables hyphenation', () => {
    const registered: {
      family: string;
      fonts: { src: string; fontWeight: number }[];
    }[] = [];
    let hyphenate: ((w: string) => string[]) | undefined;
    const store: ReactPdfFontStore = {
      register: (d) => registered.push(d),
      registerHyphenationCallback: (cb) => (hyphenate = cb),
      getRegisteredFontFamilies: () => ['Helvetica'],
    };
    registerVendoredFonts(store, loadVendoredFonts());
    expect(registered.map((r) => r.family)).toEqual([
      'Liberation Sans',
      'Noto Sans',
    ]);
    for (const r of registered)
      for (const f of r.fonts)
        expect(f.src.startsWith('data:font/ttf;base64,')).toBe(true);
    expect(hyphenate!('Unbreakable-Wordinglongword')).toEqual([
      'Unbreakable-Wordinglongword',
    ]);
  });

  it('refuses to register a family twice (no silent second source for the same name)', () => {
    const store: ReactPdfFontStore = {
      register: () => undefined,
      registerHyphenationCallback: () => undefined,
      getRegisteredFontFamilies: () => ['Liberation Sans'],
    };
    expect(() => registerVendoredFonts(store, loadVendoredFonts())).toThrow(
      PdfFontIntegrityError,
    );
  });
});
