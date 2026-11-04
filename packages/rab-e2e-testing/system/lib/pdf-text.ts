import { inflateSync } from 'node:zlib';

/**
 * Plain-text extraction from a PDF the product rendered, for the system e2e (what a document SAYS). Reads both
 * renderers' output:
 *   - Chromium (Skia/PDF): inline page /Resources, Type0/Identity-H fonts with a ToUnicode CMap, one BT…ET per run.
 *   - @react-pdf/renderer (PDFKit): an INDIRECT page `/Resources n 0 R`, each glyph run in its own BT…ET positioned by
 *     `cm`, Type0 fonts for embedded TrueType and simple WinAnsi fonts (no ToUnicode) for the standard 14 fonts.
 * Also compressed object streams, PNG predictors, inherited resources, Form XObjects and literal strings. Not a general
 * PDF parser: no encryption (refused), no Type3 glyph programs, no non-Identity CID CMaps, no text in annotations.
 *
 * Pages in order; within a page, a new text object or a new baseline starts a new line, and a run that continues the
 * previous one with no gap on the same baseline joins it ("5" + "h 28m"). Kerning is dropped and a TJ gap wider than a
 * quarter em becomes a space, so compare with whitespace removed (`compact`) where a phrase may be laid out in several
 * runs. This is a port of rab-worker's test oracle (`src/__tests__/helpers/pdf-inspect.ts`); keep the two in step.
 */
export function pdfText(pdf: Buffer): string {
  if (pdf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('not a PDF (no %PDF- header)');
  const doc = new Doc(parseObjects(pdf));
  return orderedPages(doc)
    .map((page) => {
      const scan: PageScan = { runs: [], images: [] };
      scanContent(doc, pageContent(doc, page.dict), page.resources, IDENTITY, scan, { textObject: 0 }, 0, new Set());
      return linesOf(scan.runs).join('\n');
    })
    .join('\n');
}

/** Whitespace-free form for containment checks on extracted text. */
export const compact = (s: string) => s.replace(/\s+/g, '');

interface PdfObject {
  /** The object's source text before `stream` (the dictionary for a stream object; the whole body otherwise). */
  dict: string;
  /** Decoded stream data (FlateDecode inflated, PNG predictor undone); raw bytes for any other filter. */
  stream: Buffer | null;
}

// ------------------------------------------------------------------------------------------------- object syntax
class PdfName {
  constructor(readonly name: string) {}
}
class PdfRef {
  constructor(readonly id: number) {}
}
class PdfString {
  constructor(
    readonly bytes: Buffer,
    readonly hex: boolean,
  ) {}
}
type PdfDict = Map<string, PdfValue>;
type PdfValue = number | boolean | null | PdfName | PdfRef | PdfString | PdfDict | PdfValue[] | PdfOperator;
class PdfOperator {
  constructor(readonly op: string) {}
}

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIMITERS = new Set('()<>[]{}/%'.split('').map((c) => c.charCodeAt(0)));
const ARRAY_END = Symbol('array-end');
const DICT_END = Symbol('dict-end');

/** Tokeniser + value parser shared by object bodies and content streams (latin1 string, one char per byte). */
class Lexer {
  pos = 0;
  constructor(private readonly s: string) {}

  private skipSpace(): void {
    const s = this.s;
    while (this.pos < s.length) {
      const c = s.charCodeAt(this.pos);
      if (WHITESPACE.has(c)) this.pos++;
      else if (c === 0x25 /* % */) {
        while (this.pos < s.length && s[this.pos] !== '\n' && s[this.pos] !== '\r') this.pos++;
      } else break;
    }
  }

  private literal(): PdfString {
    const s = this.s;
    const out: number[] = [];
    let depth = 1;
    this.pos++; // (
    while (this.pos < s.length) {
      const ch = s[this.pos++]!;
      if (ch === '\\') {
        const e = s[this.pos++] ?? '';
        const simple: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12, '(': 40, ')': 41, '\\': 92 };
        if (e in simple) out.push(simple[e]!);
        else if (/[0-7]/.test(e)) {
          let oct = e;
          while (oct.length < 3 && /[0-7]/.test(s[this.pos] ?? '')) oct += s[this.pos++];
          out.push(parseInt(oct, 8) & 0xff);
        } else if (e === '\r') {
          if (s[this.pos] === '\n') this.pos++;
        } else if (e !== '\n') out.push(e.charCodeAt(0));
        continue;
      }
      if (ch === '(') depth++;
      else if (ch === ')' && --depth === 0) break;
      out.push(ch.charCodeAt(0));
    }
    return new PdfString(Buffer.from(out), false);
  }

  /** Next raw value or structural marker; arrays and dictionaries are returned fully parsed. */
  private raw(): PdfValue | typeof ARRAY_END | typeof DICT_END | undefined {
    this.skipSpace();
    const s = this.s;
    if (this.pos >= s.length) return undefined;
    const c = s[this.pos]!;
    if (c === '(') return this.literal();
    if (c === '<') {
      if (s[this.pos + 1] === '<') {
        this.pos += 2;
        const dict: PdfDict = new Map();
        for (;;) {
          const k = this.value();
          if (k === DICT_END || k === undefined) return dict;
          if (!(k instanceof PdfName)) continue;
          const v = this.value();
          if (v === DICT_END || v === undefined) return dict;
          if (v !== ARRAY_END) dict.set(k.name, v);
        }
      }
      const end = s.indexOf('>', this.pos);
      const hex = s.slice(this.pos + 1, end < 0 ? s.length : end).replace(/[^0-9A-Fa-f]/g, '');
      this.pos = end < 0 ? s.length : end + 1;
      return new PdfString(Buffer.from(hex.length % 2 ? hex + '0' : hex, 'hex'), true);
    }
    if (c === '>' && s[this.pos + 1] === '>') {
      this.pos += 2;
      return DICT_END;
    }
    if (c === '[') {
      this.pos++;
      const arr: PdfValue[] = [];
      for (;;) {
        const v = this.value();
        if (v === ARRAY_END || v === undefined) return arr;
        if (v !== DICT_END) arr.push(v);
      }
    }
    if (c === ']') {
      this.pos++;
      return ARRAY_END;
    }
    if (c === '/') {
      let end = this.pos + 1;
      while (end < s.length && !WHITESPACE.has(s.charCodeAt(end)) && !DELIMITERS.has(s.charCodeAt(end))) end++;
      const name = s.slice(this.pos + 1, end).replace(/#([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
      this.pos = end;
      return new PdfName(name);
    }
    let end = this.pos;
    while (end < s.length && !WHITESPACE.has(s.charCodeAt(end)) && !DELIMITERS.has(s.charCodeAt(end))) end++;
    if (end === this.pos) end++; // a stray delimiter such as `{`, `}` or a lone `>`
    const word = s.slice(this.pos, end);
    this.pos = end;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) return Number(word);
    if (word === 'true') return true;
    if (word === 'false') return false;
    if (word === 'null') return null;
    return new PdfOperator(word);
  }

  /** Next value, folding `n g R` into a reference (by look-ahead and backtracking, so nested parsing stays simple). */
  value(): PdfValue | typeof ARRAY_END | typeof DICT_END | undefined {
    const v = this.raw();
    if (typeof v !== 'number' || !Number.isInteger(v)) return v;
    const save = this.pos;
    const g = this.raw();
    if (typeof g === 'number' && Number.isInteger(g)) {
      const r = this.raw();
      if (r instanceof PdfOperator && r.op === 'R') return new PdfRef(v);
    }
    this.pos = save;
    return v;
  }

  /** Inline image data after `ID`: skip to the `EI` that ends it. */
  skipInlineImage(): void {
    const re = /\sEI(?=[\s/[<(%]|$)/g;
    re.lastIndex = this.pos;
    const m = re.exec(this.s);
    this.pos = m ? m.index + m[0].length : this.s.length;
  }
}

function parseValue(text: string): PdfValue | undefined {
  const v = new Lexer(text).value();
  return v === ARRAY_END || v === DICT_END ? undefined : v;
}

// ------------------------------------------------------------------------------------------------- object table
function pngUnpredict(data: Buffer, parms: PdfDict | null): Buffer {
  const predictor = num(parms?.get('Predictor')) ?? 1;
  if (predictor < 10) return data; // TIFF predictor 2 is not produced by either renderer
  const colors = num(parms?.get('Colors')) ?? 1;
  const bpc = num(parms?.get('BitsPerComponent')) ?? 8;
  const columns = num(parms?.get('Columns')) ?? 1;
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowLen = Math.ceil((colors * bpc * columns) / 8);
  const rows = Math.floor(data.length / (rowLen + 1));
  const out = Buffer.alloc(rows * rowLen);
  for (let r = 0; r < rows; r++) {
    const type = data[r * (rowLen + 1)]!;
    const src = r * (rowLen + 1) + 1;
    const dst = r * rowLen;
    for (let i = 0; i < rowLen; i++) {
      const x = data[src + i]!;
      const a = i >= bpp ? out[dst + i - bpp]! : 0;
      const b = r > 0 ? out[dst - rowLen + i]! : 0;
      const c = r > 0 && i >= bpp ? out[dst - rowLen + i - bpp]! : 0;
      let v = x;
      if (type === 1) v = x + a;
      else if (type === 2) v = x + b;
      else if (type === 3) v = x + ((a + b) >> 1);
      else if (type === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      out[dst + i] = v & 0xff;
    }
  }
  return out;
}

function decodeStream(dictText: string, raw: Buffer): Buffer {
  const dict = parseValue(dictText);
  if (!(dict instanceof Map)) return raw;
  const filters = asArray(dict.get('Filter')).filter((f): f is PdfName => f instanceof PdfName).map((f) => f.name);
  const parms = asArray(dict.get('DecodeParms'));
  let data = raw;
  for (let i = 0; i < filters.length; i++) {
    if (filters[i] !== 'FlateDecode' && filters[i] !== 'Fl') return data; // e.g. DCTDecode: leave the encoded bytes
    try {
      data = inflateSync(data);
    } catch {
      return data;
    }
    const p = parms[i];
    data = pngUnpredict(data, p instanceof Map ? p : null);
  }
  return data;
}

function parseObjects(pdf: Buffer): Map<number, PdfObject> {
  const text = pdf.toString('latin1');
  if (/\/Encrypt\s+\d+\s+\d+\s+R/.test(text)) throw new Error('encrypted PDF: not supported');
  const objects = new Map<number, PdfObject>();
  const re = /(\d+)\s+\d+\s+obj\b\s*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const id = Number(m[1]);
    const bodyStart = m.index + m[0].length;
    const end = text.indexOf('endobj', bodyStart);
    if (end < 0) break;
    const body = text.slice(bodyStart, end);
    const streamAt = body.search(/>>\s*stream\r?\n/);
    if (streamAt < 0) {
      objects.set(id, { dict: body, stream: null });
      continue;
    }
    const header = /stream\r?\n/.exec(body.slice(streamAt))!;
    const dataStart = bodyStart + streamAt + header.index + header[0].length;
    const dict = body.slice(0, streamAt + 2);
    // A direct /Length is authoritative when `endstream` really follows it (binary data may contain "endstream").
    const len = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
    let dataEnd = -1;
    if (len && /^\s*endstream/.test(text.slice(dataStart + Number(len[1]), dataStart + Number(len[1]) + 12))) {
      dataEnd = dataStart + Number(len[1]);
    } else {
      dataEnd = text.indexOf('endstream', dataStart);
      if (dataEnd < 0) break;
      // Trailing EOL before `endstream` is not part of the data.
      if (pdf[dataEnd - 1] === 0x0a) dataEnd--;
      if (pdf[dataEnd - 1] === 0x0d) dataEnd--;
    }
    objects.set(id, { dict, stream: decodeStream(dict, pdf.subarray(dataStart, dataEnd)) });
    re.lastIndex = text.indexOf('endobj', dataEnd);
    if (re.lastIndex < 0) break;
  }
  // Compressed object streams (PDF 1.5+): their members are objects too. A directly written object wins.
  for (const o of [...objects.values()]) {
    if (!o.stream || !/\/Type\s*\/ObjStm\b/.test(o.dict)) continue;
    const d = parseValue(o.dict);
    if (!(d instanceof Map)) continue;
    const n = num(d.get('N')) ?? 0;
    const first = num(d.get('First')) ?? 0;
    const data = o.stream.toString('latin1');
    const head = data.slice(0, first).trim().split(/\s+/).map(Number);
    for (let i = 0; i < n; i++) {
      const id = head[2 * i]!;
      const start = first + head[2 * i + 1]!;
      const stop = i + 1 < n ? first + head[2 * i + 3]! : data.length;
      if (!objects.has(id)) objects.set(id, { dict: data.slice(start, stop), stream: null });
    }
  }
  return objects;
}

function num(v: PdfValue | undefined): number | null {
  return typeof v === 'number' ? v : null;
}
function asArray(v: PdfValue | undefined): PdfValue[] {
  return v === undefined || v === null ? [] : Array.isArray(v) ? v : [v];
}

/** Parsed-object access with reference resolution. */
class Doc {
  private cache = new Map<number, PdfValue | undefined>();

  constructor(readonly objects: Map<number, PdfObject>) {}

  value(id: number): PdfValue | undefined {
    if (!this.cache.has(id)) {
      const o = this.objects.get(id);
      this.cache.set(id, o ? parseValue(o.dict) : undefined);
    }
    return this.cache.get(id);
  }

  resolve(v: PdfValue | undefined): PdfValue | undefined {
    for (let i = 0; i < 32 && v instanceof PdfRef; i++) v = this.value(v.id);
    return v instanceof PdfRef ? undefined : v;
  }

  dict(v: PdfValue | undefined): PdfDict | null {
    const r = this.resolve(v);
    return r instanceof Map ? r : null;
  }

  stream(v: PdfValue | undefined): Buffer | null {
    return v instanceof PdfRef ? (this.objects.get(v.id)?.stream ?? null) : null;
  }
}

// ------------------------------------------------------------------------------------------------- fonts
interface FontInfo {
  /** Bytes per character code in a shown string. */
  bytes: number;
  decode(code: number): string;
  /** Advance width in glyph space (1/1000 em), or undefined when the PDF does not say (standard 14 fonts). */
  width(code: number): number | undefined;
}

// A font this file cannot resolve: bytes as Latin-1 (pdf-text.ts has always done this).
const UNKNOWN_FONT: FontInfo = { bytes: 1, decode: (code) => String.fromCharCode(code), width: () => undefined };

function utf16(bytes: Buffer): string {
  let s = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) s += String.fromCharCode(bytes.readUInt16BE(i));
  return s;
}

function parseToUnicode(cmap: string): { map: Map<number, string>; bytes: number | null } {
  const map = new Map<number, string>();
  const cs = /begincodespacerange\s*<([0-9A-Fa-f]+)>/.exec(cmap);
  const hexStr = (h: string) => utf16(Buffer.from(h.length % 4 ? h.padStart(Math.ceil(h.length / 4) * 4, '0') : h, 'hex'));
  for (const block of cmap.matchAll(/beginbfchar([^]*?)endbfchar/g)) {
    for (const pair of block[1]!.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g)) map.set(parseInt(pair[1]!, 16), hexStr(pair[2]!));
  }
  for (const block of cmap.matchAll(/beginbfrange([^]*?)endbfrange/g)) {
    for (const r of block[1]!.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<[0-9A-Fa-f]*>|\[[^\]]*\])/g)) {
      const lo = parseInt(r[1]!, 16);
      const hi = parseInt(r[2]!, 16);
      if (hi - lo > 0xffff) continue;
      if (r[3]!.startsWith('[')) {
        const items = [...r[3]!.matchAll(/<([0-9A-Fa-f]*)>/g)].map((x) => hexStr(x[1]!));
        for (let c = lo; c <= hi; c++) map.set(c, items[c - lo] ?? '');
      } else {
        // The destination's LAST UTF-16 unit is incremented across the range.
        const base = hexStr(r[3]!.slice(1, -1));
        const head = base.slice(0, -1);
        const last = base.charCodeAt(base.length - 1);
        for (let c = lo; c <= hi; c++) map.set(c, head + String.fromCharCode(last + (c - lo)));
      }
    }
  }
  return { map, bytes: cs ? cs[1]!.length / 2 : null };
}

const WIN_ANSI = new TextDecoder('windows-1252');
const MAC_ROMAN = (() => {
  try {
    return new TextDecoder('macintosh');
  } catch {
    return WIN_ANSI;
  }
})();

function glyphNameToUnicode(name: string): string {
  const uni = /^uni([0-9A-Fa-f]{4})$/.exec(name) ?? /^u([0-9A-Fa-f]{4,6})$/.exec(name);
  if (uni) return String.fromCodePoint(parseInt(uni[1]!, 16));
  if (name.length === 1) return name;
  return '�';
}

function buildFont(doc: Doc, fontRef: PdfValue | undefined): FontInfo {
  const font = doc.dict(fontRef);
  if (!font) return UNKNOWN_FONT;
  const subtype = (font.get('Subtype') as PdfName | undefined)?.name;
  const tuStream = doc.stream(font.get('ToUnicode'));
  const tu = tuStream ? parseToUnicode(tuStream.toString('latin1')) : null;
  if (subtype === 'Type0') {
    const cid = doc.dict(asArray(doc.resolve(font.get('DescendantFonts')))[0]);
    const widths = new Map<number, number>();
    const w = asArray(doc.resolve(cid?.get('W'))).map((x) => doc.resolve(x));
    for (let i = 0; i < w.length; ) {
      const first = w[i];
      const next = w[i + 1];
      if (typeof first !== 'number') break;
      if (Array.isArray(next)) {
        next.forEach((x, k) => {
          const v = doc.resolve(x);
          if (typeof v === 'number') widths.set(first + k, v);
        });
        i += 2;
      } else {
        const last = next;
        const v = w[i + 2];
        if (typeof last !== 'number' || typeof v !== 'number') break;
        for (let c = first; c <= last && c - first <= 0xffff; c++) widths.set(c, v);
        i += 3;
      }
    }
    const dw = num(doc.resolve(cid?.get('DW'))) ?? 1000;
    // Identity-H/V: CID = code. Codes are read at the ToUnicode codespace width (2 bytes for both renderers).
    return {
      bytes: tu?.bytes ?? 2,
      decode: (code) => tu?.map.get(code) ?? '', // unmapped codes are dropped, as pdf-text.ts always did
      width: (code) => widths.get(code) ?? dw,
    };
  }
  // Simple font (Type1 / TrueType / MMType1 / Type3): one byte per code.
  let base: TextDecoder = WIN_ANSI;
  const differences = new Map<number, string>();
  const enc = doc.resolve(font.get('Encoding'));
  const pick = (n: string | undefined) => (n === 'MacRomanEncoding' ? MAC_ROMAN : WIN_ANSI);
  if (enc instanceof PdfName) base = pick(enc.name);
  else if (enc instanceof Map) {
    base = pick((enc.get('BaseEncoding') as PdfName | undefined)?.name);
    let code = 0;
    for (const d of asArray(doc.resolve(enc.get('Differences')))) {
      if (typeof d === 'number') code = d;
      else if (d instanceof PdfName) differences.set(code++, glyphNameToUnicode(d.name));
    }
  }
  const firstChar = num(doc.resolve(font.get('FirstChar'))) ?? 0;
  const widthsArr = asArray(doc.resolve(font.get('Widths'))).map((x) => doc.resolve(x));
  const hasWidths = font.has('Widths');
  return {
    bytes: 1,
    decode: (code) => tu?.map.get(code) ?? differences.get(code) ?? base.decode(Buffer.from([code])),
    width: (code) => {
      if (!hasWidths) return undefined;
      const v = widthsArr[code - firstChar];
      return typeof v === 'number' ? v : 0;
    },
  };
}

// ------------------------------------------------------------------------------------------------- content
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

interface TextRun {
  text: string;
  /** Index of the BT…ET text object the run was shown in (unique per page, including Form XObjects). */
  textObject: number;
  /** Device-space origin of the run, its end point (null when the font gives no widths) and its font size there. */
  x: number;
  y: number;
  end: { x: number; y: number } | null;
  size: number;
}

interface PageScan {
  runs: TextRun[];
  /** "WxH" of each image XObject drawn on the page (`Do`), in drawing order. */
  images: string[];
}

function scanContent(
  doc: Doc,
  content: string,
  resources: PdfDict | null,
  baseCtm: Matrix,
  out: PageScan,
  counter: { textObject: number },
  depth: number,
  seenForms: Set<number>,
): void {
  const fontCache = new Map<string, FontInfo>();
  const fontDict = doc.dict(resources?.get('Font'));
  const xobjects = doc.dict(resources?.get('XObject'));
  const fontFor = (name: string): FontInfo => {
    if (!fontCache.has(name)) fontCache.set(name, fontDict?.has(name) ? buildFont(doc, fontDict.get(name)) : UNKNOWN_FONT);
    return fontCache.get(name)!;
  };

  let ctm = baseCtm;
  // q/Q save and restore the CTM and the text state (font, size, spacing, scaling, leading); the text matrix is not saved.
  const stack: { ctm: Matrix; font: FontInfo; fontSize: number; charSpacing: number; wordSpacing: number; hScale: number; leading: number }[] = [];
  let tm: Matrix = IDENTITY;
  let tlm: Matrix = IDENTITY;
  let font: FontInfo = UNKNOWN_FONT;
  let fontSize = 0;
  let charSpacing = 0;
  let wordSpacing = 0;
  let hScale = 1;
  let leading = 0;
  let inText = false;
  let textObject = -1;

  const show = (str: PdfValue | undefined, adjustments?: PdfValue[]) => {
    if (!inText) return;
    const parts = adjustments ?? [str ?? null];
    const start = mul(tm, ctm);
    let text = '';
    let measurable = true;
    for (const p of parts) {
      if (typeof p === 'number') {
        if (p < -250) text += ' '; // a large TJ gap reads as a word space (pdf-text.ts heuristic, kept)
        tm = mul([1, 0, 0, 1, (-p / 1000) * fontSize * hScale, 0], tm);
        continue;
      }
      if (!(p instanceof PdfString)) continue;
      const b = p.bytes;
      for (let i = 0; i + font.bytes <= b.length; i += font.bytes) {
        const code = font.bytes === 1 ? b[i]! : font.bytes === 2 ? b.readUInt16BE(i) : b.readUIntBE(i, font.bytes);
        text += font.decode(code);
        const w = font.width(code);
        if (w === undefined) measurable = false;
        const tx = (((w ?? 0) / 1000) * fontSize + charSpacing + (font.bytes === 1 && code === 32 ? wordSpacing : 0)) * hScale;
        tm = mul([1, 0, 0, 1, tx, 0], tm);
      }
    }
    if (!text) return;
    const endM = mul(tm, ctm);
    out.runs.push({
      text,
      textObject,
      x: start[4],
      y: start[5],
      end: measurable ? { x: endM[4], y: endM[5] } : null,
      size: Math.abs(fontSize) * Math.hypot(start[2], start[3]),
    });
  };
  const nextLine = () => {
    tlm = mul([1, 0, 0, 1, 0, -leading], tlm);
    tm = tlm;
  };

  const lexer = new Lexer(content);
  const operands: PdfValue[] = [];
  for (;;) {
    const v = lexer.value();
    if (v === undefined) break;
    if (v === ARRAY_END || v === DICT_END) continue;
    if (!(v instanceof PdfOperator)) {
      operands.push(v);
      continue;
    }
    const n = (i: number) => num(operands[operands.length - i]) ?? 0;
    switch (v.op) {
      case 'q':
        stack.push({ ctm, font, fontSize, charSpacing, wordSpacing, hScale, leading });
        break;
      case 'Q': {
        const saved = stack.pop();
        if (saved) ({ ctm, font, fontSize, charSpacing, wordSpacing, hScale, leading } = saved);
        else ctm = baseCtm;
        break;
      }
      case 'cm':
        ctm = mul([n(6), n(5), n(4), n(3), n(2), n(1)], ctm);
        break;
      case 'BT':
        inText = true;
        tm = tlm = IDENTITY;
        textObject = counter.textObject++;
        break;
      case 'ET':
        inText = false;
        break;
      case 'Tf': {
        const name = operands[operands.length - 2];
        font = name instanceof PdfName ? fontFor(name.name) : UNKNOWN_FONT;
        fontSize = n(1);
        break;
      }
      case 'Tc':
        charSpacing = n(1);
        break;
      case 'Tw':
        wordSpacing = n(1);
        break;
      case 'Tz':
        hScale = n(1) / 100;
        break;
      case 'TL':
        leading = n(1);
        break;
      case 'Td':
        tlm = mul([1, 0, 0, 1, n(2), n(1)], tlm);
        tm = tlm;
        break;
      case 'TD':
        leading = -n(1);
        tlm = mul([1, 0, 0, 1, n(2), n(1)], tlm);
        tm = tlm;
        break;
      case 'Tm':
        tlm = tm = [n(6), n(5), n(4), n(3), n(2), n(1)];
        break;
      case 'T*':
        nextLine();
        break;
      case 'Tj':
        show(operands[operands.length - 1]);
        break;
      case "'":
        nextLine();
        show(operands[operands.length - 1]);
        break;
      case '"':
        wordSpacing = n(3);
        charSpacing = n(2);
        nextLine();
        show(operands[operands.length - 1]);
        break;
      case 'TJ': {
        const arr = operands[operands.length - 1];
        if (Array.isArray(arr)) show(undefined, arr);
        break;
      }
      case 'Do': {
        const name = operands[operands.length - 1];
        const ref = name instanceof PdfName ? xobjects?.get(name.name) : undefined;
        const xo = ref instanceof PdfRef ? doc.dict(ref) : null;
        const sub = (xo?.get('Subtype') as PdfName | undefined)?.name;
        if (xo && sub === 'Image') out.images.push(`${num(doc.resolve(xo.get('Width')))}x${num(doc.resolve(xo.get('Height')))}`);
        else if (xo && sub === 'Form' && ref instanceof PdfRef && depth < 12 && !seenForms.has(ref.id)) {
          const fm = asArray(doc.resolve(xo.get('Matrix'))).map((x) => num(doc.resolve(x)) ?? 0);
          const matrix: Matrix = fm.length === 6 ? (fm as Matrix) : IDENTITY;
          const body = doc.stream(ref)?.toString('latin1') ?? '';
          seenForms.add(ref.id);
          scanContent(doc, body, doc.dict(xo.get('Resources')) ?? resources, mul(matrix, ctm), out, counter, depth + 1, seenForms);
          seenForms.delete(ref.id);
        }
        break;
      }
      case 'ID':
        lexer.skipInlineImage();
        break;
      default:
        break;
    }
    operands.length = 0;
  }
}

/**
 * Lines of a page: every text object (BT…ET) starts a new line — Chromium lays out one run per text object — EXCEPT
 * when its first run continues the previous run exactly where that run ended on the same baseline (react-pdf draws each
 * glyph run of one line in its own text object: "5" + "h 28m", "<" + "script>…"). Runs separated by any visible gap
 * (a table cell, a word space not drawn as a glyph) stay on separate lines, as with Chromium. Inside one text object a
 * move to another baseline (Td, TD, T-star, the quote operators or a new Tm) also starts a new line.
 */
function linesOf(runs: TextRun[]): string[] {
  const lines: string[] = [];
  let line = '';
  let prev: TextRun | null = null;
  for (const r of runs) {
    let continues = false;
    if (prev) {
      const tol = Math.max(r.size, prev.size) * 0.1;
      const baseline = prev.end?.y ?? prev.y;
      if (r.textObject === prev.textObject) continues = Math.abs(r.y - baseline) <= Math.max(tol, 0.01);
      else if (prev.end) continues = Math.abs(r.y - prev.end.y) <= tol && Math.abs(r.x - prev.end.x) <= tol;
    }
    if (!continues && line) {
      lines.push(line);
      line = '';
    }
    line += r.text;
    prev = r;
  }
  if (line) lines.push(line);
  return lines;
}

interface PageNode {
  dict: PdfDict;
  resources: PdfDict | null;
}

/** Pages in document order (follows /Pages /Kids), each with its effective (possibly inherited) /Resources. */
function orderedPages(doc: Doc): PageNode[] {
  const catalogId = [...doc.objects.keys()].find((id) => /\/Type\s*\/Catalog\b/.test(doc.objects.get(id)!.dict));
  const out: PageNode[] = [];
  const seen = new Set<number>();
  const walk = (v: PdfValue | undefined, inherited: PdfDict | null, depth: number) => {
    if (!(v instanceof PdfRef) || seen.has(v.id) || depth > 64) return;
    seen.add(v.id);
    const node = doc.dict(v);
    if (!node) return;
    const type = (node.get('Type') as PdfName | undefined)?.name;
    const resources = node.has('Resources') ? doc.dict(node.get('Resources')) : inherited;
    if (type === 'Pages') for (const k of asArray(doc.resolve(node.get('Kids')))) walk(k, resources, depth + 1);
    else if (type === 'Page') out.push({ dict: node, resources });
  };
  const catalog = catalogId != null ? doc.dict(new PdfRef(catalogId)) : null;
  walk(catalog?.get('Pages'), null, 0);
  return out;
}

function pageContent(doc: Doc, page: PdfDict): string {
  return asArray(page.get('Contents'))
    .flatMap((c) => (c instanceof PdfRef && Array.isArray(doc.resolve(c)) ? asArray(doc.resolve(c)) : [c]))
    .map((c) => doc.stream(c)?.toString('latin1') ?? '')
    .join('\n');
}
