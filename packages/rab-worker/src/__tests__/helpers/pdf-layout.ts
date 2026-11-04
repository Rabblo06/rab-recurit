import { inflateSync } from 'zlib';

/**
 * Renderer-agnostic, position-aware PDF reader for the PDF renderer migration harness (Chromium → native,
 * `src/__tests__/pdf-equality/`). Test-only; never imported by production code.
 *
 * `pdf-inspect.ts` (owned by its maintainers; it answers "is this text / image in the document") stays the oracle the
 * hardening suites use. This file answers "in what visual order, where on the page": compressed object streams, an exact
 * `/Length` stream reader, a real PDF value parser (indirect `/Resources`, `/Font`, `/XObject` all resolved), simple
 * (1-byte) and composite (2-byte) fonts, literal and hex strings, glyph widths, the text and graphics state machine,
 * marked-content `ActualText` / `ReversedChars` (Skia's bidi and complex-script markup), Form XObjects and inline
 * images — so a PDF from any producer (Skia, pdfkit / react-pdf) reads back in the same logical order.
 */
export interface PdfObject {
  dict: string;
  stream: Buffer | null;
  /** The stream bytes as stored (before any filter); null for a non-stream object or an object from an object stream. */
  raw: Buffer | null;
}

export function parseObjects(pdf: Buffer): Map<number, PdfObject> {
  const text = pdf.toString('latin1');
  const objects = new Map<number, PdfObject>();
  const re = /(\d+) 0 obj\s*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const id = Number(m[1]);
    const bodyStart = m.index + m[0].length;
    const end = text.indexOf('endobj', bodyStart);
    if (end < 0) break;
    const body = text.slice(bodyStart, end);
    let streamAt = body.search(/>>\s*stream\r?\n/);
    if (streamAt < 0) {
      // A binary stream can contain the bytes "endobj"; it is a non-stream object only if no `stream` keyword follows
      // its dictionary before the next object header.
      const late = /^[^]*?>>\s*stream\r?\n/.exec(text.slice(bodyStart, bodyStart + 65536));
      if (!late || /\d+ 0 obj/.test(late[0])) {
        objects.set(id, { dict: body, stream: null, raw: null });
        continue;
      }
      streamAt = late[0].search(/>>\s*stream\r?\n/);
    }
    const streamKw = /stream\r?\n/.exec(text.slice(bodyStart + streamAt))!;
    const dataStart = bodyStart + streamAt + streamKw.index + streamKw[0].length;
    const dict = text.slice(bodyStart, bodyStart + streamAt + 2);
    // An exact direct /Length is authoritative (binary data may end in CR/LF bytes or contain "endstream").
    const len = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
    const exact = len != null && /^\s*endstream/.test(text.slice(dataStart + Number(len[1]), dataStart + Number(len[1]) + 16));
    const dataEnd = exact ? dataStart + Number(len![1]) : text.indexOf('endstream', dataStart);
    let raw = pdf.subarray(dataStart, dataEnd);
    if (!exact) {
      // Trailing EOL before `endstream` is not part of the data.
      if (raw.length && raw[raw.length - 1] === 0x0a) raw = raw.subarray(0, raw.length - 1);
      if (raw.length && raw[raw.length - 1] === 0x0d) raw = raw.subarray(0, raw.length - 1);
    }
    let stream: Buffer = raw;
    if (/\/FlateDecode/.test(dict)) {
      try {
        stream = inflateSync(raw);
      } catch {
        stream = raw;
      }
    }
    objects.set(id, { dict, stream, raw });
    re.lastIndex = dataEnd;
  }
  // Compressed object streams (PDF 1.5+, e.g. pdf-lib's default): "objnum offset ..." header, then the objects.
  for (const [, o] of [...objects]) {
    if (!/\/Type\s*\/ObjStm/.test(o.dict) || !o.stream) continue;
    const n = Number(/\/N\s+(\d+)/.exec(o.dict)?.[1] ?? 0);
    const first = Number(/\/First\s+(\d+)/.exec(o.dict)?.[1] ?? 0);
    const data = o.stream.toString('latin1');
    const header = data.slice(0, first).trim().split(/\s+/).map(Number);
    for (let k = 0; k < n; k++) {
      const num = header[2 * k]!;
      const start = first + header[2 * k + 1]!;
      const stop = k + 1 < n ? first + header[2 * k + 3]! : data.length;
      if (!objects.has(num)) objects.set(num, { dict: data.slice(start, stop), stream: null, raw: null });
    }
  }
  return objects;
}


export class PdfName {
  constructor(readonly name: string) {}
}
export class PdfRef {
  constructor(readonly num: number) {}
}
/** A bare keyword operand (content streams only). */
export class PdfKeyword {
  constructor(readonly word: string) {}
}
export interface PdfString {
  bytes: Buffer;
  hex: boolean;
}
export type PdfDict = Map<string, PdfValue>;
export type PdfValue = number | boolean | null | PdfName | PdfRef | PdfString | PdfValue[] | PdfDict | PdfKeyword;

const isWs = (c: number) => c === 0x00 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d || c === 0x20;
const isDelim = (c: number) =>
  c === 0x28 || c === 0x29 || c === 0x3c || c === 0x3e || c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d || c === 0x2f || c === 0x25;

type Tok = { t: 'num'; v: number } | { t: 'name'; v: string } | { t: 'str'; v: PdfString } | { t: 'kw'; v: string } | { t: '[' | ']' | '<<' | '>>' };

const isPdfString = (v: unknown): v is PdfString => !!v && typeof v === 'object' && Buffer.isBuffer((v as PdfString).bytes);

/** PDF lexer over a latin1 string (1 char = 1 byte). */
export class PdfLexer {
  constructor(
    readonly s: string,
    public i = 0,
  ) {}

  skipWs(): void {
    const s = this.s;
    while (this.i < s.length) {
      const c = s.charCodeAt(this.i);
      if (isWs(c)) this.i++;
      else if (c === 0x25) while (this.i < s.length && s[this.i] !== '\n' && s[this.i] !== '\r') this.i++;
      else break;
    }
  }

  next(): Tok | null {
    this.skipWs();
    const s = this.s;
    if (this.i >= s.length) return null;
    const c = s[this.i]!;
    if (c === '[' || c === ']') {
      this.i++;
      return { t: c };
    }
    if (c === '<' && s[this.i + 1] === '<') {
      this.i += 2;
      return { t: '<<' };
    }
    if (c === '>' && s[this.i + 1] === '>') {
      this.i += 2;
      return { t: '>>' };
    }
    if (c === '<') {
      const end = s.indexOf('>', this.i);
      let hex = s.slice(this.i + 1, end < 0 ? s.length : end).replace(/[^0-9A-Fa-f]/g, '');
      if (hex.length % 2) hex += '0';
      this.i = end < 0 ? s.length : end + 1;
      return { t: 'str', v: { bytes: Buffer.from(hex, 'hex'), hex: true } };
    }
    if (c === '(') return { t: 'str', v: { bytes: this.literal(), hex: false } };
    if (c === '/') {
      let j = this.i + 1;
      while (j < s.length && !isWs(s.charCodeAt(j)) && !isDelim(s.charCodeAt(j))) j++;
      const name = s.slice(this.i + 1, j).replace(/#([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
      this.i = j;
      return { t: 'name', v: name };
    }
    if (c === ')' || c === '>' || c === '{' || c === '}') {
      this.i++;
      return this.next();
    }
    let j = this.i;
    while (j < s.length && !isWs(s.charCodeAt(j)) && !isDelim(s.charCodeAt(j))) j++;
    const word = s.slice(this.i, j);
    this.i = j;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) return { t: 'num', v: Number(word) };
    return { t: 'kw', v: word };
  }

  private literal(): Buffer {
    const s = this.s;
    const out: number[] = [];
    const simple: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12, '(': 40, ')': 41, '\\': 92 };
    let depth = 1;
    this.i++;
    while (this.i < s.length) {
      const ch = s[this.i++]!;
      if (ch === '\\') {
        const e = s[this.i++] ?? '';
        if (e in simple) out.push(simple[e]!);
        else if (/[0-7]/.test(e)) {
          let oct = e;
          while (oct.length < 3 && /[0-7]/.test(s[this.i] ?? '')) oct += s[this.i++];
          out.push(parseInt(oct, 8) & 0xff);
        } else if (e === '\r') {
          if (s[this.i] === '\n') this.i++;
        } else if (e !== '\n' && e !== '') out.push(e.charCodeAt(0));
      } else if (ch === '(') {
        depth++;
        out.push(40);
      } else if (ch === ')') {
        if (--depth === 0) break;
        out.push(41);
      } else out.push(ch.charCodeAt(0) & 0xff);
    }
    return Buffer.from(out);
  }

  /** One complete value. `refs` enables `n g R` detection (object syntax; never in content streams). */
  value(first: Tok | null = this.next(), refs = true): PdfValue | undefined {
    if (!first) return undefined;
    switch (first.t) {
      case 'num': {
        if (!refs) return first.v;
        const save = this.i;
        const g = this.next();
        if (g?.t === 'num') {
          const r = this.next();
          if (r?.t === 'kw' && r.v === 'R') return new PdfRef(first.v);
        }
        this.i = save;
        return first.v;
      }
      case 'name':
        return new PdfName(first.v);
      case 'str':
        return first.v;
      case '[': {
        const arr: PdfValue[] = [];
        for (let t = this.next(); t && t.t !== ']'; t = this.next()) {
          const v = this.value(t, refs);
          if (v !== undefined) arr.push(v);
        }
        return arr;
      }
      case '<<': {
        const dict: PdfDict = new Map();
        for (let t = this.next(); t && t.t !== '>>'; t = this.next()) {
          if (t.t !== 'name') continue;
          const v = this.value(this.next(), refs);
          if (v !== undefined) dict.set(t.v, v);
        }
        return dict;
      }
      case 'kw':
        if (first.v === 'true') return true;
        if (first.v === 'false') return false;
        if (first.v === 'null') return null;
        return new PdfKeyword(first.v);
      default:
        return undefined;
    }
  }
}

export interface PdfStreamObject {
  num: number;
  dict: PdfDict;
  /** FlateDecode-decoded bytes (or the raw bytes for any other filter). */
  data: Buffer | null;
  /** The stored bytes, before any filter. */
  raw: Buffer | null;
}

export interface PdfReader {
  /** Parsed value of an indirect object. */
  value(num: number): PdfValue;
  /** Follows indirect references until a direct value. */
  resolve(v: PdfValue | undefined): PdfValue | undefined;
  dict(v: PdfValue | undefined): PdfDict | undefined;
  stream(v: PdfValue | undefined): PdfStreamObject | undefined;
  /** Every indirect object number (distinct-object counts, e.g. images). */
  objectNumbers(): number[];
  pages: Array<{ num: number; dict: PdfDict }>;
}

export function openPdf(pdf: Buffer): PdfReader {
  if (pdf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('not a PDF');
  const objects = parseObjects(pdf);
  const cache = new Map<number, PdfValue>();
  const value = (n: number): PdfValue => {
    if (cache.has(n)) return cache.get(n)!;
    const o = objects.get(n);
    const v = o ? (new PdfLexer(o.dict).value() ?? null) : null;
    cache.set(n, v);
    return v;
  };
  const resolve = (v: PdfValue | undefined): PdfValue | undefined => {
    let cur = v;
    for (let k = 0; k < 32 && cur instanceof PdfRef; k++) cur = value(cur.num);
    return cur;
  };
  const dict = (v: PdfValue | undefined) => {
    const r = resolve(v);
    return r instanceof Map ? r : undefined;
  };
  const stream = (v: PdfValue | undefined): PdfStreamObject | undefined => {
    if (!(v instanceof PdfRef)) return undefined;
    const o = objects.get(v.num);
    const d = dict(v);
    if (!o || !d) return undefined;
    return { num: v.num, dict: d, data: o.stream, raw: o.raw };
  };
  const pages: Array<{ num: number; dict: PdfDict }> = [];
  const walk = (ref: PdfValue | undefined, depth: number) => {
    if (!(ref instanceof PdfRef) || depth > 64) return;
    const d = dict(ref);
    if (!d) return;
    const type = d.get('Type');
    if (type instanceof PdfName && type.name === 'Pages') {
      const kids = resolve(d.get('Kids'));
      if (Array.isArray(kids)) for (const k of kids) walk(k, depth + 1);
    } else pages.push({ num: ref.num, dict: d });
  };
  const catalog = [...objects.entries()].find(([, o]) => /\/Type\s*\/Catalog/.test(o.dict));
  if (catalog) walk(dict(new PdfRef(catalog[0]))?.get('Pages'), 0);
  return { value, resolve, dict, stream, objectNumbers: () => [...objects.keys()], pages };
}

/** Inherited page attribute (Resources, MediaBox): looks up the /Parent chain. */
function inherited(reader: PdfReader, page: PdfDict, key: string): PdfValue | undefined {
  let cur: PdfDict | undefined = page;
  for (let k = 0; cur && k < 64; k++) {
    if (cur.has(key)) return reader.resolve(cur.get(key));
    cur = reader.dict(cur.get('Parent'));
  }
  return undefined;
}

export function pdfNumber(v: PdfValue | undefined, fallback = 0): number {
  return typeof v === 'number' ? v : fallback;
}
const num = pdfNumber;

// ─── fonts ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** WinAnsiEncoding 0x80–0x9F (the rest of 0x20–0xFF is Latin-1). */
const WIN_ANSI_HIGH: Record<number, string> = {
  0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡', 0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š', 0x8b: '‹',
  0x8c: 'Œ', 0x8e: 'Ž', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x98: '˜', 0x99: '™',
  0x9a: 'š', 0x9b: '›', 0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ',
};
/** Glyph names (Adobe Glyph List subset) for /Differences without a ToUnicode map; `uniXXXX` / `uXXXX[XX]` too. */
const GLYPH_NAMES: Record<string, string> = {
  space: ' ', exclam: '!', quotedbl: '"', numbersign: '#', dollar: '$', percent: '%', ampersand: '&', quotesingle: "'",
  parenleft: '(', parenright: ')', asterisk: '*', plus: '+', comma: ',', hyphen: '-', period: '.', slash: '/', zero: '0',
  one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', colon: ':',
  semicolon: ';', less: '<', equal: '=', greater: '>', question: '?', at: '@', bracketleft: '[', backslash: '\\',
  bracketright: ']', asciicircum: '^', underscore: '_', grave: '`', braceleft: '{', bar: '|', braceright: '}',
  asciitilde: '~', endash: '–', emdash: '—', quoteleft: '‘', quoteright: '’', quotedblleft: '“', quotedblright: '”',
  bullet: '•', ellipsis: '…', Euro: '€', sterling: '£', periodcentered: '·', middot: '·', nbspace: '\u00A0',
  eacute: 'é', egrave: 'è', edieresis: 'ë', ecircumflex: 'ê', aacute: 'á', agrave: 'à', adieresis: 'ä', acircumflex: 'â',
  aring: 'å', atilde: 'ã', iacute: 'í', idieresis: 'ï', icircumflex: 'î', oacute: 'ó', odieresis: 'ö', ocircumflex: 'ô',
  otilde: 'õ', oslash: 'ø', uacute: 'ú', udieresis: 'ü', ucircumflex: 'û', ccedilla: 'ç', ntilde: 'ñ', ydieresis: 'ÿ',
  Eacute: 'É', Adieresis: 'Ä', Odieresis: 'Ö', Udieresis: 'Ü', Aring: 'Å', germandbls: 'ß', degree: '°', copyright: '©',
};

function glyphNameToUnicode(name: string): string | undefined {
  if (name.length === 1) return name;
  if (GLYPH_NAMES[name]) return GLYPH_NAMES[name];
  let m = /^uni([0-9A-Fa-f]{4,})$/.exec(name);
  if (m) {
    let out = '';
    for (let i = 0; i + 4 <= m[1]!.length; i += 4) out += String.fromCharCode(parseInt(m[1]!.slice(i, i + 4), 16));
    return out;
  }
  m = /^u([0-9A-Fa-f]{4,6})$/.exec(name);
  if (m) return String.fromCodePoint(parseInt(m[1]!, 16));
  return undefined;
}

interface FontModel {
  /** Splits a shown string into character codes. */
  codes(bytes: Buffer): number[];
  unicode(code: number): string;
  /** Horizontal advance in text-space units per unit font size (glyph width × FontMatrix). */
  advance(code: number): number;
  singleByte: boolean;
}

function parseCMapToUnicode(cmap: string): Map<number, string> {
  const map = new Map<number, string>();
  const utf16 = (hex: string) => {
    let s = '';
    for (let i = 0; i + 4 <= hex.length; i += 4) s += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
    if (hex.length % 4 === 2) s += String.fromCharCode(parseInt(hex.slice(-2), 16));
    return s;
  };
  for (const block of cmap.matchAll(/beginbfchar([^]*?)endbfchar/g)) {
    for (const pair of block[1]!.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g)) map.set(parseInt(pair[1]!, 16), utf16(pair[2]!));
  }
  for (const block of cmap.matchAll(/beginbfrange([^]*?)endbfrange/g)) {
    for (const r of block[1]!.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<[0-9A-Fa-f]+>|\[[^\]]*\])/g)) {
      const lo = parseInt(r[1]!, 16);
      const hi = parseInt(r[2]!, 16);
      if (hi - lo > 65535) continue;
      if (r[3]!.startsWith('[')) {
        const items = [...r[3]!.matchAll(/<([0-9A-Fa-f]+)>/g)].map((x) => utf16(x[1]!));
        for (let c = lo; c <= hi; c++) map.set(c, items[c - lo] ?? '');
      } else {
        const base = utf16(r[3]!.slice(1, -1));
        const last = base.charCodeAt(base.length - 1);
        for (let c = lo; c <= hi; c++) map.set(c, base.slice(0, -1) + String.fromCharCode(last + (c - lo)));
      }
    }
  }
  return map;
}

function buildFont(reader: PdfReader, fontRef: PdfValue | undefined): FontModel {
  const font = reader.dict(fontRef) ?? new Map<string, PdfValue>();
  const subtype = (font.get('Subtype') as PdfName | undefined)?.name;
  const tuStream = reader.stream(font.get('ToUnicode'));
  const toUnicode = tuStream?.data ? parseCMapToUnicode(tuStream.data.toString('latin1')) : undefined;

  if (subtype === 'Type0') {
    const descendants = reader.resolve(font.get('DescendantFonts'));
    const desc = reader.dict(Array.isArray(descendants) ? descendants[0] : undefined);
    const dw = num(reader.resolve(desc?.get('DW')), 1000);
    const widths = new Map<number, number>();
    const w = reader.resolve(desc?.get('W'));
    if (Array.isArray(w)) {
      for (let i = 0; i < w.length; ) {
        const first = num(reader.resolve(w[i]));
        const second = reader.resolve(w[i + 1]);
        if (Array.isArray(second)) {
          second.forEach((x, k) => widths.set(first + k, num(reader.resolve(x))));
          i += 2;
        } else {
          const last = num(second);
          const width = num(reader.resolve(w[i + 2]));
          for (let c = first; c <= last && c - first < 65536; c++) widths.set(c, width);
          i += 3;
        }
      }
    }
    // Identity-H/V (and every CMap the producers in scope use) are 2-byte; an embedded CMap's codespace is not read.
    return {
      singleByte: false,
      codes: (b) => {
        const out: number[] = [];
        for (let i = 0; i + 1 < b.length; i += 2) out.push((b[i]! << 8) | b[i + 1]!);
        return out;
      },
      unicode: (c) => toUnicode?.get(c) ?? '�',
      advance: (c) => (widths.get(c) ?? dw) / 1000,
    };
  }

  // Simple fonts: Type1, TrueType, Type3, MMType1 — one byte per code.
  const firstChar = num(reader.resolve(font.get('FirstChar')), 0);
  const widthsArr = reader.resolve(font.get('Widths'));
  const descriptor = reader.dict(font.get('FontDescriptor'));
  const missing = num(reader.resolve(descriptor?.get('MissingWidth')), 0);
  const fontMatrix = reader.resolve(font.get('FontMatrix'));
  const scale = subtype === 'Type3' && Array.isArray(fontMatrix) ? Math.abs(num(fontMatrix[0] as PdfValue, 0.001)) : 0.001;
  const encodingMap = new Map<number, string>();
  for (let c = 0x20; c <= 0xff; c++) encodingMap.set(c, WIN_ANSI_HIGH[c] ?? (c >= 0x7f && c < 0xa0 ? '' : String.fromCharCode(c)));
  const enc = reader.resolve(font.get('Encoding'));
  const diffs = enc instanceof Map ? reader.resolve(enc.get('Differences')) : undefined;
  if (Array.isArray(diffs)) {
    let code = 0;
    for (const d of diffs) {
      const v = reader.resolve(d);
      if (typeof v === 'number') code = v;
      else if (v instanceof PdfName) {
        const u = glyphNameToUnicode(v.name);
        if (u !== undefined) encodingMap.set(code, u);
        code++;
      }
    }
  }
  return {
    singleByte: true,
    codes: (b) => [...b],
    unicode: (c) => toUnicode?.get(c) ?? encodingMap.get(c) ?? '�',
    advance: (c) => {
      // A standard-14 font may carry no /Widths: 0.5 em (only the spacing heuristics use advances).
      if (!Array.isArray(widthsArr)) return 0.5;
      const w = widthsArr[c - firstChar];
      return (w === undefined ? missing : num(reader.resolve(w), missing)) * scale;
    },
  };
}

// ─── content interpretation ─────────────────────────────────────────────────────────────────────────────────────────

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
function mul(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

/** One drawn piece of text in default user space (points, origin bottom-left, y up). */
export interface TextRun {
  text: string;
  x: number;
  y: number;
  endX: number;
  /** Rendered font size in points. */
  size: number;
}

/** An image drawn by the page content: an image XObject (by object number) or an inline image. */
export interface ImagePlacement {
  ref: number | null;
  width: number;
  height: number;
  /** Inline images only: the image dictionary and data (for decoding). */
  inline?: { dict: PdfDict; data: Buffer };
}

interface MarkedContent {
  actualText?: string;
  emitted?: boolean;
  reversed?: TextRun[];
}

/** PDF text string: UTF-16BE with BOM, UTF-8 with BOM, else PDFDocEncoding (≈ Latin-1 here). */
export function decodeTextString(b: Buffer): string {
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
    let s = '';
    for (let i = 2; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i]! << 8) | b[i + 1]!);
    return s;
  }
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return b.subarray(3).toString('utf8');
  return b.toString('latin1');
}

function interpretContent(
  reader: PdfReader,
  content: string,
  resources: PdfDict | undefined,
  baseCtm: Matrix,
  runs: TextRun[],
  images: ImagePlacement[],
  fontCache: Map<string, FontModel>,
  depth: number,
): void {
  if (depth > 12) return;
  const lx = new PdfLexer(content);
  const fontsDict = reader.dict(resources?.get('Font'));
  const xobjects = reader.dict(resources?.get('XObject'));
  const properties = reader.dict(resources?.get('Properties'));
  const fontOf = (name: string): FontModel | undefined => {
    const ref = fontsDict?.get(name);
    if (ref === undefined) return undefined;
    const key = ref instanceof PdfRef ? `ref:${ref.num}` : `inline:${name}:${depth}:${content.length}`;
    if (!fontCache.has(key)) fontCache.set(key, buildFont(reader, ref));
    return fontCache.get(key);
  };

  let ctm: Matrix = baseCtm;
  const stack: Matrix[] = [];
  let tm: Matrix = IDENTITY;
  let tlm: Matrix = IDENTITY;
  let font: FontModel | undefined;
  let fs = 0;
  let tc = 0;
  let tw = 0;
  let th = 1;
  let tl = 0;
  let rise = 0;
  const marked: MarkedContent[] = [];
  const innermost = (pred: (m: MarkedContent) => boolean) => {
    for (let k = marked.length - 1; k >= 0; k--) if (pred(marked[k]!)) return marked[k];
    return undefined;
  };
  const target = (): TextRun[] => innermost((m) => !!m.reversed)?.reversed ?? runs;

  const show = (bytes: Buffer) => {
    if (!font) return;
    for (const code of font.codes(bytes)) {
      const trm = mul([fs * th, 0, 0, fs, 0, rise], mul(tm, ctm));
      const tx = (font.advance(code) * fs + tc + (font.singleByte && code === 32 ? tw : 0)) * th;
      tm = mul([1, 0, 0, 1, tx, 0], tm);
      const endX = mul([fs * th, 0, 0, fs, 0, rise], mul(tm, ctm))[4];
      const run: TextRun = { text: font.unicode(code), x: trm[4], y: trm[5], endX, size: Math.hypot(trm[2], trm[3]) };
      // ActualText replaces the glyphs of its span: emitted once, at the first glyph, extended over the rest.
      const span = innermost((m) => m.actualText !== undefined);
      const list = target();
      if (span) {
        if (!span.emitted) {
          span.emitted = true;
          list.push({ ...run, text: span.actualText! });
        } else {
          const last = list[list.length - 1];
          if (last) last.endX = Math.max(last.endX, endX);
        }
      } else list.push(run);
    }
  };

  const operands: PdfValue[] = [];
  for (let tok = lx.next(); tok; tok = lx.next()) {
    if (tok.t !== 'kw' || tok.v === 'true' || tok.v === 'false' || tok.v === 'null') {
      const v = lx.value(tok, false);
      if (v !== undefined) operands.push(v);
      continue;
    }
    const op = tok.v;
    const n = (k: number) => num(operands[k]);
    switch (op) {
      case 'q':
        stack.push(ctm);
        break;
      case 'Q':
        ctm = stack.pop() ?? baseCtm;
        break;
      case 'cm':
        ctm = mul([n(0), n(1), n(2), n(3), n(4), n(5)], ctm);
        break;
      case 'BT':
        tm = IDENTITY;
        tlm = IDENTITY;
        break;
      case 'Tf':
        font = operands[0] instanceof PdfName ? fontOf(operands[0].name) : undefined;
        fs = n(1);
        break;
      case 'Tc':
        tc = n(0);
        break;
      case 'Tw':
        tw = n(0);
        break;
      case 'Tz':
        th = n(0) / 100;
        break;
      case 'TL':
        tl = n(0);
        break;
      case 'Ts':
        rise = n(0);
        break;
      case 'Td':
        tlm = mul([1, 0, 0, 1, n(0), n(1)], tlm);
        tm = tlm;
        break;
      case 'TD':
        tl = -n(1);
        tlm = mul([1, 0, 0, 1, n(0), n(1)], tlm);
        tm = tlm;
        break;
      case 'Tm':
        tlm = [n(0), n(1), n(2), n(3), n(4), n(5)];
        tm = tlm;
        break;
      case 'T*':
        tlm = mul([1, 0, 0, 1, 0, -tl], tlm);
        tm = tlm;
        break;
      case 'Tj':
        if (isPdfString(operands[0])) show(operands[0].bytes);
        break;
      case "'":
        tlm = mul([1, 0, 0, 1, 0, -tl], tlm);
        tm = tlm;
        if (isPdfString(operands[0])) show(operands[0].bytes);
        break;
      case '"':
        tw = n(0);
        tc = n(1);
        tlm = mul([1, 0, 0, 1, 0, -tl], tlm);
        tm = tlm;
        if (isPdfString(operands[2])) show(operands[2].bytes);
        break;
      case 'TJ':
        if (Array.isArray(operands[0])) {
          for (const el of operands[0]) {
            if (typeof el === 'number') tm = mul([1, 0, 0, 1, (-el / 1000) * fs * th, 0], tm);
            else if (isPdfString(el)) show(el.bytes);
          }
        }
        break;
      case 'BMC':
        marked.push(operands[0] instanceof PdfName && operands[0].name === 'ReversedChars' ? { reversed: [] } : {});
        break;
      case 'BDC': {
        const tag = operands[0] instanceof PdfName ? operands[0].name : '';
        let props = operands[1] instanceof Map ? operands[1] : undefined;
        if (!props && operands[1] instanceof PdfName) props = reader.dict(properties?.get(operands[1].name));
        const at = props ? reader.resolve(props.get('ActualText')) : undefined;
        const mc: MarkedContent = tag === 'ReversedChars' ? { reversed: [] } : {};
        if (isPdfString(at)) mc.actualText = decodeTextString(at.bytes);
        marked.push(mc);
        break;
      }
      case 'EMC': {
        const mc = marked.pop();
        if (mc?.reversed && mc.reversed.length) {
          // Glyphs were drawn in visual (right-to-left) order: the logical text is the units in reverse. Each unit is
          // one glyph or one ActualText span (already logical), so the units are reversed, not their characters.
          const units = mc.reversed;
          target().push({
            text: units
              .map((u) => u.text)
              .reverse()
              .join(''),
            x: Math.min(...units.map((u) => u.x)),
            y: units[0]!.y,
            endX: Math.max(...units.map((u) => u.endX)),
            size: Math.max(...units.map((u) => u.size)),
          });
        }
        break;
      }
      case 'Do': {
        const name = operands[0] instanceof PdfName ? operands[0].name : '';
        const xs = reader.stream(xobjects?.get(name));
        if (!xs) break;
        const sub = (xs.dict.get('Subtype') as PdfName | undefined)?.name;
        if (sub === 'Image') {
          images.push({ ref: xs.num, width: num(reader.resolve(xs.dict.get('Width'))), height: num(reader.resolve(xs.dict.get('Height'))) });
        } else if (sub === 'Form' && xs.data) {
          const m = reader.resolve(xs.dict.get('Matrix'));
          const fm: Matrix = Array.isArray(m) && m.length === 6 ? (m.map((x) => num(reader.resolve(x))) as Matrix) : IDENTITY;
          const formRes = reader.dict(xs.dict.get('Resources')) ?? resources;
          interpretContent(reader, xs.data.toString('latin1'), formRes, mul(fm, ctm), runs, images, fontCache, depth + 1);
        }
        break;
      }
      case 'BI': {
        const dict: PdfDict = new Map();
        for (let t = lx.next(); t && !(t.t === 'kw' && t.v === 'ID'); t = lx.next()) {
          if (t.t !== 'name') continue;
          const v = lx.value(lx.next(), false);
          if (v !== undefined) dict.set(t.v, v);
        }
        const dataStart = lx.i + 1;
        const end = /\sEI(?=\s|$)/g;
        end.lastIndex = dataStart;
        const m = end.exec(content);
        const dataEnd = m ? m.index : content.length;
        lx.i = m ? m.index + m[0].length : content.length;
        images.push({
          ref: null,
          width: num(reader.resolve(dict.get('W') ?? dict.get('Width'))),
          height: num(reader.resolve(dict.get('H') ?? dict.get('Height'))),
          inline: { dict, data: Buffer.from(content.slice(dataStart, dataEnd), 'latin1') },
        });
        break;
      }
      default:
        break;
    }
    operands.length = 0;
  }
}

// ─── lines, segments, blocks ────────────────────────────────────────────────────────────────────────────────────────

/** A column-separated piece of one baseline (a table cell, a footer half). */
export interface LayoutSegment {
  x: number;
  endX: number;
  y: number;
  size: number;
  text: string;
}
/** Text on one baseline, left to right. */
export interface LayoutLine {
  y: number;
  size: number;
  text: string;
  segments: LayoutSegment[];
}
/** Vertically stacked, left-aligned segments (a wrapped cell or paragraph), joined with spaces. */
export interface LayoutBlock {
  x: number;
  top: number;
  text: string;
}
export interface LayoutPage {
  width: number;
  height: number;
  runs: TextRun[];
  /** Top to bottom. */
  lines: LayoutLine[];
  /** Reading order: top to bottom, then left to right. */
  blocks: LayoutBlock[];
  images: ImagePlacement[];
}

function joinRuns(items: TextRun[]): LayoutSegment[] {
  const segments: LayoutSegment[] = [];
  let cur: LayoutSegment | null = null;
  for (const r of items) {
    if (!cur) {
      cur = { ...r };
      continue;
    }
    const gap = r.x - cur.endX;
    const size = Math.max(cur.size, r.size, 1);
    if (gap > 1.2 * size) {
      segments.push(cur);
      cur = { ...r };
      continue;
    }
    const needsSpace = gap > 0.15 * size && !/\s$/.test(cur.text) && !/^\s/.test(r.text);
    cur.text += (needsSpace ? ' ' : '') + r.text;
    cur.endX = Math.max(cur.endX, r.endX);
    cur.size = size;
  }
  if (cur) segments.push(cur);
  return segments;
}

function layoutLines(runs: TextRun[]): LayoutLine[] {
  const sorted = runs.filter((r) => r.text.length > 0).sort((a, b) => b.y - a.y || a.x - b.x);
  const groups: TextRun[][] = [];
  for (const r of sorted) {
    const g = groups[groups.length - 1];
    if (g && Math.abs(g[0]!.y - r.y) <= 0.3 * Math.max(1, Math.min(g[0]!.size, r.size))) g.push(r);
    else groups.push([r]);
  }
  return groups.map((g) => {
    // Stable: equal x keeps content-stream order (e.g. a combining mark drawn at its base glyph's origin).
    const segments = joinRuns([...g].sort((a, b) => a.x - b.x));
    return { y: g[0]!.y, size: Math.max(...g.map((i) => i.size)), text: segments.map((s) => s.text).join(' '), segments };
  });
}

function layoutBlocks(lines: LayoutLine[]): LayoutBlock[] {
  type Open = { x: number; top: number; lastY: number; size: number; parts: string[] };
  const open: Open[] = [];
  const done: Open[] = [];
  for (const line of lines) {
    for (let k = open.length - 1; k >= 0; k--) if (open[k]!.lastY - line.y > 2 * open[k]!.size) done.push(...open.splice(k, 1));
    for (const seg of line.segments) {
      const hit = open.find((b) => Math.abs(b.x - seg.x) <= 1.5 && b.lastY - seg.y > 0.5 && b.lastY - seg.y <= 1.8 * Math.max(b.size, seg.size));
      if (hit) {
        hit.parts.push(seg.text);
        hit.lastY = seg.y;
        hit.size = Math.max(hit.size, seg.size);
      } else open.push({ x: seg.x, top: seg.y, lastY: seg.y, size: seg.size, parts: [seg.text] });
    }
  }
  done.push(...open);
  return done.sort((a, b) => b.top - a.top || a.x - b.x).map((b) => ({ x: b.x, top: b.top, text: b.parts.join(' ') }));
}

/**
 * Every page's text runs (user-space points), lines (top to bottom, left to right), blocks (wrapped cells joined) and
 * image placements. Works on any producer's output, not only Skia's.
 */
export function inspectPdfLayout(pdf: Buffer): { reader: PdfReader; pages: LayoutPage[] } {
  const reader = openPdf(pdf);
  const fontCache = new Map<string, FontModel>();
  const pages = reader.pages.map(({ dict }) => {
    const resources = inherited(reader, dict, 'Resources');
    const box = inherited(reader, dict, 'MediaBox');
    const mb = Array.isArray(box) ? box.map((v) => num(reader.resolve(v))) : [0, 0, 612, 792];
    const contents = reader.resolve(dict.get('Contents'));
    const refs = Array.isArray(contents) ? contents : [dict.get('Contents')];
    const content = refs.map((r) => reader.stream(r)?.data?.toString('latin1') ?? '').join('\n');
    const runs: TextRun[] = [];
    const images: ImagePlacement[] = [];
    interpretContent(reader, content, resources instanceof Map ? resources : undefined, IDENTITY, runs, images, fontCache, 0);
    const lines = layoutLines(runs);
    return { width: mb[2]! - mb[0]!, height: mb[3]! - mb[1]!, runs, lines, blocks: layoutBlocks(lines), images };
  });
  return { reader, pages };
}
