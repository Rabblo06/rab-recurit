import { inflateSync } from 'zlib';

import jsQR from 'jsqr';

import { inspectPdf } from '../helpers/pdf-inspect';
import { ImagePlacement, inspectPdfLayout, LayoutBlock, PdfDict, PdfName, pdfNumber, PdfReader, PdfRef, PdfString, PdfValue } from '../helpers/pdf-layout';

/**
 * PDF EXTRACTOR for the renderer migration (Chromium → native). Text, positions and images come from
 * `helpers/pdf-layout.ts` (`inspectPdfLayout`), so any producer's PDF reads in reading order (top to bottom, left to
 * right, right-to-left phrases in logical order) and paragraphs split by a page break are rejoined; the repo's own
 * `helpers/pdf-inspect.ts` (`inspectPdf`) runs on the same bytes as an independent cross-check (`oracle`).
 * Given a PDF it returns: normalised text per page (order-stable: top to bottom, left to right), the page count, each page's footer line and its "Page n of N" numbering, the table header
 * lines found on each page, the embedded image count and every decoded QR payload (jsQR, a pure-JS decoder, devDependency
 * only). Test-only.
 */

/** Characters that carry no visible text: C0/C1 controls (NUL included), soft hyphen, zero-width, bidi controls, BOM, VS. */
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u0084\u0086-\u009F\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFE00-\uFE0F\uFEFF]/g;
const SPACES = /[\u0085\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
/** An unpaired UTF-16 surrogate cannot be encoded: every UTF-8 hop (and so every renderer) turns it into U+FFFD. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * The comparison form of a piece of text: lone surrogates as U+FFFD, NFC, invisible characters removed, every
 * space-like character (NEL included) a plain space, whitespace collapsed. Both renderers' output and every expected
 * value go through this one function.
 */
export function normaliseText(s: string): string {
  return s.replace(LONE_SURROGATE, '\uFFFD').normalize('NFC').replace(INVISIBLE, '').replace(SPACES, ' ').replace(/\s+/g, ' ').trim();
}

/** Normalised and with ALL whitespace removed: insensitive to line wrapping and to how a renderer splits text runs. */
export function compact(s: string): string {
  return normaliseText(s).replace(/\s+/g, '');
}

export interface ExtractSpec {
  /** Column labels of the document's table header, in order (e.g. ['Staff member', 'Start', …]). */
  tableHeader?: readonly string[];
}

export interface PageExtraction {
  number: number;
  /** Normalised lines, top to bottom; within a line the column segments are joined by one space. */
  lines: string[];
  /** `lines` joined with "\n". */
  text: string;
  /** Wrapped cells / paragraphs joined (reading order). Used to find values that wrap over several lines. */
  blocks: string[];
  /** Each block's normalised lines, aligned with `blocks` (for line-end rules such as forced-break hyphens). */
  blockLines: string[][];
  /** The page's footer line (the lowest line carrying "Page n of N"), normalised; null when the page has none. */
  footer: string | null;
  footerNumbering: { page: number; of: number } | null;
  /** Lines that contain the whole table header (all labels, in order). */
  tableHeaderLines: string[];
  /** Images drawn on this page (placements, not distinct objects). */
  imagePlacements: number;
}

export interface ExtractedImage {
  width: number;
  height: number;
  placements: number;
  /** null when decoded; otherwise why it could not be (e.g. a JPEG — only QR-type lossless images are decoded). */
  undecodable: string | null;
  qrPayload: string | null;
}

export interface PdfExtraction {
  pageCount: number;
  pages: PageExtraction[];
  /** All pages' `text`, separated by a form feed. */
  text: string;
  /** Distinct embedded images drawn by page content (an image placed on several pages counts once). */
  imageCount: number;
  images: ExtractedImage[];
  /** Every decoded QR payload, sorted. */
  qrPayloads: string[];
  /**
   * Text that flows over a page break: a paragraph (e.g. a 10 KB note) whose last block on page n carries on as the first
   * block of page n+1, in the same column. `parts` are the normalised per-page blocks, in order. See `pageContinuations`.
   */
  continuations: Continuation[];
  /** Dictionary keys that make a PDF active (scripts, actions, links, attachments, forms), wherever they occur. */
  activeContentKeys: string[];
  /** Text drawn past the page's right edge, or left of its left edge (per page: count of runs). */
  outOfPageRuns: number[];
  /** The page size of every page, points, rounded to 0.01. */
  pageSizes: Array<[number, number]>;
  /**
   * `pdf-inspect.ts`'s independent reading of the same bytes. `agrees` = same page count and the same ASCII letters and
   * digits per page (bidi / ActualText handling, which pdf-inspect does not do, cannot affect those).
   */
  oracle: { pageCount: number; images: string[]; agrees: boolean; detail: string };
}

const ACTIVE_KEYS = ['JavaScript', 'JS', 'OpenAction', 'Launch', 'URI', 'EmbeddedFile', 'EmbeddedFiles', 'AA', 'AcroForm', 'SubmitForm', 'GoToR', 'RichMedia'];

const PAGE_OF = /Page\s*(\d+)\s*of\s*(\d+)/i;

export interface Continuation {
  /** 1-based page numbers, consecutive. */
  pages: number[];
  parts: string[];
}

/** What `pageContinuations` needs of one page. */
export interface ContinuationPage {
  blocks: ReadonlyArray<Pick<LayoutBlock, 'x' | 'top' | 'bottom' | 'text'>>;
  /** Baseline of the page footer ("Page n of N"), which is not part of the flow; null when the page has none. */
  footerY: number | null;
  /** The page repeats the table header: the table carries on there, and table rows never split (`tr` avoids breaks). */
  hasTableHeader: boolean;
}

/**
 * Paragraphs that a page break splits. Block P (the LOWEST block of page n, footer excluded) continues as block Q (the
 * HIGHEST block of page n+1, footer excluded) when both stand in the same column (left edges within 1.5 pt) and page n+1
 * does not repeat the table header (then the table carries on, and its rows never break). A chain goes on while each
 * continuation is also the lowest block of its own page. Anything else (two columns that both break, a centred line)
 * yields no continuation, so a value split that way is reported missing, never found by a guess.
 */
export function pageContinuations(pages: readonly ContinuationPage[]): Continuation[] {
  type Block = ContinuationPage['blocks'][number];
  const body = (p: ContinuationPage) => p.blocks.filter((b) => p.footerY === null || Math.abs(b.top - p.footerY) > 0.5);
  const lowest = (p: ContinuationPage) => body(p).reduce<Block | null>((m, b) => (!m || b.bottom < m.bottom ? b : m), null);
  const highest = (p: ContinuationPage) => body(p).reduce<Block | null>((m, b) => (!m || b.top > m.top ? b : m), null);
  const out: Continuation[] = [];
  let open: Continuation | null = null;
  for (let i = 0; i + 1 < pages.length; i++) {
    const from = lowest(pages[i]!);
    const next = pages[i + 1]!;
    const to = next.hasTableHeader ? null : highest(next);
    if (!from || !to || Math.abs(from.x - to.x) > 1.5) {
      open = null;
      continue;
    }
    if (!open) {
      open = { pages: [i + 1], parts: [normaliseText(from.text)] };
      out.push(open);
    }
    open.pages.push(i + 2);
    open.parts.push(normaliseText(to.text));
    // The chain carries on to page i+3 only if this block is also where page i+2's text ends.
    if (lowest(next) !== to) open = null;
  }
  return out;
}

export function extractPdf(pdf: Buffer, spec: ExtractSpec = {}): PdfExtraction {
  const { reader, pages } = inspectPdfLayout(pdf);
  const header = spec.tableHeader ? compact(spec.tableHeader.join('')) : null;

  const outPages: PageExtraction[] = pages.map((p, i) => {
    const lines = p.lines.map((l) => normaliseText(l.text)).filter((l) => l.length > 0);
    let footer: string | null = null;
    let footerNumbering: PageExtraction['footerNumbering'] = null;
    for (let k = lines.length - 1; k >= 0; k--) {
      const m = PAGE_OF.exec(lines[k]!);
      if (m) {
        footer = lines[k]!;
        footerNumbering = { page: Number(m[1]), of: Number(m[2]) };
        break;
      }
    }
    return {
      number: i + 1,
      lines,
      text: lines.join('\n'),
      blocks: p.blocks.map((b) => normaliseText(b.text)).filter((b) => b.length > 0),
      blockLines: p.blocks.filter((b) => normaliseText(b.text).length > 0).map((b) => b.lines.map(normaliseText).filter((l) => l.length > 0)),
      footer,
      footerNumbering,
      tableHeaderLines: header ? lines.filter((l) => compact(l).includes(header)) : [],
      imagePlacements: p.images.length,
    };
  });

  const continuations = pageContinuations(
    pages.map((p, i) => {
      const footerLine = [...p.lines].reverse().find((l) => PAGE_OF.test(normaliseText(l.text)));
      return {
        blocks: p.blocks.filter((b) => normaliseText(b.text).length > 0),
        footerY: footerLine ? footerLine.y : null,
        hasTableHeader: outPages[i]!.tableHeaderLines.length > 0,
      };
    }),
  );

  // Distinct images: an XObject by object number; every inline image is its own.
  const distinct = new Map<string, { placement: ImagePlacement; placements: number }>();
  pages.forEach((p, i) =>
    p.images.forEach((img, k) => {
      const key = img.ref != null ? `ref:${img.ref}` : `inline:${i}:${k}`;
      const seen = distinct.get(key);
      if (seen) seen.placements++;
      else distinct.set(key, { placement: img, placements: 1 });
    }),
  );
  const images: ExtractedImage[] = [...distinct.values()].map(({ placement, placements }) => {
    const decoded = decodePlacement(reader, placement);
    let qrPayload: string | null = null;
    if (typeof decoded !== 'string' && decoded.width >= 21 && decoded.height >= 21) {
      qrPayload = jsQR(decoded.rgba, decoded.width, decoded.height, { inversionAttempts: 'attemptBoth' })?.data ?? null;
    }
    return { width: placement.width, height: placement.height, placements, undecodable: typeof decoded === 'string' ? decoded : null, qrPayload };
  });

  // Active content: every object's parsed dictionary, KEYS only — hostile text such as "/JavaScript" printed on the page is
  // glyph codes inside a content stream, never a dictionary key.
  const active = new Set<string>();
  const ACTIVE_TYPES = ['JavaScript', 'Launch', 'URI', 'Link', 'FileAttachment', 'Widget', 'SubmitForm', 'GoToR'];
  const walkKeys = (v: PdfValue | undefined, depth: number): void => {
    if (depth > 32 || v === undefined || v === null) return;
    if (v instanceof Map) {
      for (const [k, x] of v) {
        if (ACTIVE_KEYS.includes(k)) active.add(k);
        if ((k === 'S' || k === 'Subtype') && x instanceof PdfName && ACTIVE_TYPES.includes(x.name)) active.add(`${k}/${x.name}`);
        walkKeys(x, depth + 1);
      }
    } else if (Array.isArray(v)) for (const x of v) walkKeys(x, depth + 1);
  };
  for (const n of reader.objectNumbers()) walkKeys(reader.value(n), 0);

  // The repo's own oracle on the same bytes.
  const asciiSignature = (t: string) => [...t.replace(/[^A-Za-z0-9]/g, '')].sort().join('');
  let oracle: PdfExtraction['oracle'];
  try {
    const o = inspectPdf(pdf);
    const mismatched = o.pageTexts.map((t, i) => (asciiSignature(t) === asciiSignature(outPages[i]?.text ?? '') ? 0 : i + 1)).filter((x) => x > 0);
    const agrees = o.pageCount === outPages.length && mismatched.length === 0;
    oracle = {
      pageCount: o.pageCount,
      images: o.images,
      agrees,
      detail: agrees
        ? `pdf-inspect agrees (${o.pageCount} page(s), same letters and digits)`
        : `pdf-inspect reads ${o.pageCount} page(s); letters/digits differ on page(s) ${mismatched.join(', ') || '-'}`,
    };
  } catch (error) {
    oracle = { pageCount: -1, images: [], agrees: false, detail: `pdf-inspect failed: ${(error as Error).message}` };
  }

  return {
    pageCount: outPages.length,
    pages: outPages,
    text: outPages.map((p) => p.text).join('\n\f\n'),
    imageCount: images.length,
    images,
    qrPayloads: images.map((i) => i.qrPayload).filter((q): q is string => q !== null).sort(),
    continuations,
    activeContentKeys: [...active].sort(),
    outOfPageRuns: pages.map((p) => p.runs.filter((r) => r.text.trim() && (r.endX > p.width + 0.5 || r.x < -0.5)).length),
    pageSizes: pages.map((p): [number, number] => [Math.round(p.width * 100) / 100, Math.round(p.height * 100) / 100]),
    oracle,
  };
}

// ─── image decoding (enough for QR codes: Flate / ASCIIHex / none, PNG + TIFF predictors, Gray / RGB / CMYK / Indexed / ICC / stencil masks) ───

interface Rgba {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
}

const FILTER_ABBREV: Record<string, string> = { AHx: 'ASCIIHexDecode', A85: 'ASCII85Decode', LZW: 'LZWDecode', Fl: 'FlateDecode', RL: 'RunLengthDecode', CCF: 'CCITTFaxDecode', DCT: 'DCTDecode' };
const CS_ABBREV: Record<string, string> = { G: 'DeviceGray', RGB: 'DeviceRGB', CMYK: 'DeviceCMYK', I: 'Indexed' };

function asArray(v: PdfValue | undefined): PdfValue[] {
  return v === undefined || v === null ? [] : Array.isArray(v) ? v : [v];
}

function decodePlacement(reader: PdfReader, p: ImagePlacement): Rgba | string {
  if (p.inline) return decodeImage(reader, p.inline.dict, p.inline.data);
  if (p.ref == null) return 'image reference missing';
  const st = reader.stream(new PdfRef(p.ref));
  if (!st?.raw) return 'image stream missing';
  return decodeImage(reader, st.dict, st.raw);
}

function decodeImage(reader: PdfReader, dict: PdfDict, raw: Buffer): Rgba | string {
  const get = (long: string, short: string) => reader.resolve(dict.get(long) ?? dict.get(short));
  const width = pdfNumber(get('Width', 'W'));
  const height = pdfNumber(get('Height', 'H'));
  if (!width || !height) return 'no dimensions';
  const filters = asArray(get('Filter', 'F')).map((f) => {
    const n = (reader.resolve(f) as PdfName | undefined)?.name ?? '';
    return FILTER_ABBREV[n] ?? n;
  });
  const params = asArray(get('DecodeParms', 'DP')).map((d) => reader.dict(d));
  let data = raw;
  for (const [k, f] of filters.entries()) {
    if (f === 'FlateDecode') {
      try {
        data = inflateSync(data);
      } catch {
        return 'FlateDecode failed';
      }
      const dp = params[k];
      const predictor = pdfNumber(reader.resolve(dp?.get('Predictor')), 1);
      if (predictor > 1) {
        const colors = pdfNumber(reader.resolve(dp?.get('Colors')), 1);
        const bpc = pdfNumber(reader.resolve(dp?.get('BitsPerComponent')), 8);
        const columns = pdfNumber(reader.resolve(dp?.get('Columns')), 1);
        const out = unpredict(data, predictor, colors, bpc, columns);
        if (typeof out === 'string') return out;
        data = out;
      }
    } else if (f === 'ASCIIHexDecode') {
      const hex = data.toString('latin1').replace(/>.*$/s, '').replace(/[^0-9A-Fa-f]/g, '');
      data = Buffer.from(hex.length % 2 ? `${hex}0` : hex, 'hex');
    } else {
      return `${f} not decoded`;
    }
  }

  const imageMask = get('ImageMask', 'IM') === true;
  const bpc = imageMask ? 1 : pdfNumber(get('BitsPerComponent', 'BPC'), 8);
  const decodeArr = asArray(get('Decode', 'D')).map((v) => pdfNumber(reader.resolve(v)));
  // Colour model.
  let components = 1;
  let palette: { base: number; lookup: Buffer } | null = null;
  let model = 'DeviceGray';
  if (!imageMask) {
    const csResolved = reader.resolve(get('ColorSpace', 'CS'));
    const cs = describeColorSpace(reader, csResolved);
    if (typeof cs === 'string') return cs;
    ({ components, model } = cs);
    palette = cs.palette ?? null;
  }

  const rgba = new Uint8ClampedArray(width * height * 4);
  const rowBytes = Math.ceil((width * components * bpc) / 8);
  if (data.length < rowBytes * height) return 'image data truncated';
  const max = (1 << bpc) - 1;
  for (let y = 0; y < height; y++) {
    const row = y * rowBytes;
    for (let x = 0; x < width; x++) {
      const sample = (c: number): number => {
        const bitIndex = (x * components + c) * bpc;
        if (bpc === 8) return data[row + x * components + c]!;
        if (bpc === 16) return data[row + (x * components + c) * 2]!;
        const byte = data[row + (bitIndex >> 3)]!;
        return (byte >> (8 - bpc - (bitIndex & 7))) & max;
      };
      let r: number;
      let g: number;
      let b: number;
      if (imageMask) {
        const s = sample(0);
        const painted = decodeArr[0] === 1 ? s === 1 : s === 0; // default Decode [0 1]: 0 paints
        r = g = b = painted ? 0 : 255;
      } else if (palette) {
        const idx = sample(0);
        const base = palette.base;
        const at = idx * base;
        if (base === 1) r = g = b = palette.lookup[at] ?? 0;
        else if (base === 3) [r, g, b] = [palette.lookup[at] ?? 0, palette.lookup[at + 1] ?? 0, palette.lookup[at + 2] ?? 0];
        else [r, g, b] = cmyk(palette.lookup[at] ?? 0, palette.lookup[at + 1] ?? 0, palette.lookup[at + 2] ?? 0, palette.lookup[at + 3] ?? 0);
      } else {
        const scale = (v: number) => (bpc === 8 || bpc === 16 ? v : Math.round((v * 255) / max));
        if (model === 'DeviceGray') {
          let v = scale(sample(0));
          if (decodeArr[0] === 1 && decodeArr[1] === 0) v = 255 - v;
          r = g = b = v;
        } else if (model === 'DeviceRGB') [r, g, b] = [scale(sample(0)), scale(sample(1)), scale(sample(2))];
        else [r, g, b] = cmyk(scale(sample(0)), scale(sample(1)), scale(sample(2)), scale(sample(3)));
      }
      const o = (y * width + x) * 4;
      rgba[o] = r;
      rgba[o + 1] = g;
      rgba[o + 2] = b;
      rgba[o + 3] = 255;
    }
  }
  return { width, height, rgba };
}

function cmyk(c: number, m: number, y: number, k: number): [number, number, number] {
  return [255 - Math.min(255, c + k), 255 - Math.min(255, m + k), 255 - Math.min(255, y + k)];
}

function describeColorSpace(
  reader: PdfReader,
  cs: PdfValue | undefined,
): { components: number; model: string; palette?: { base: number; lookup: Buffer } } | string {
  if (cs instanceof PdfName) {
    const n = CS_ABBREV[cs.name] ?? cs.name;
    if (n === 'DeviceGray' || n === 'CalGray') return { components: 1, model: 'DeviceGray' };
    if (n === 'DeviceRGB' || n === 'CalRGB') return { components: 3, model: 'DeviceRGB' };
    if (n === 'DeviceCMYK') return { components: 4, model: 'DeviceCMYK' };
    return `colour space ${n} not decoded`;
  }
  if (Array.isArray(cs) && cs[0] instanceof PdfName) {
    const kind = CS_ABBREV[cs[0].name] ?? cs[0].name;
    if (kind === 'ICCBased') {
      const n = pdfNumber(reader.resolve(reader.dict(cs[1])?.get('N')), 3);
      return { components: n, model: n === 1 ? 'DeviceGray' : n === 4 ? 'DeviceCMYK' : 'DeviceRGB' };
    }
    if (kind === 'CalRGB' || kind === 'Lab') return { components: 3, model: 'DeviceRGB' };
    if (kind === 'CalGray') return { components: 1, model: 'DeviceGray' };
    if (kind === 'Indexed') {
      const base = describeColorSpace(reader, reader.resolve(cs[1]));
      if (typeof base === 'string') return base;
      const lk = cs[3];
      let lookup: Buffer | null = null;
      if (lk instanceof PdfRef) lookup = reader.stream(lk)?.data ?? null;
      else if (lk && typeof lk === 'object' && Buffer.isBuffer((lk as PdfString).bytes)) lookup = (lk as PdfString).bytes;
      if (!lookup) return 'Indexed lookup missing';
      return { components: 1, model: 'Indexed', palette: { base: base.components, lookup } };
    }
    return `colour space ${kind} not decoded`;
  }
  return 'no colour space';
}

function unpredict(data: Buffer, predictor: number, colors: number, bpc: number, columns: number): Buffer | string {
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowLen = Math.ceil((columns * colors * bpc) / 8);
  if (predictor === 2) {
    if (bpc !== 8) return 'TIFF predictor with bpc != 8 not decoded';
    const out = Buffer.from(data);
    for (let r = 0; r * rowLen < out.length; r++) for (let i = bpp; i < rowLen; i++) out[r * rowLen + i] = (out[r * rowLen + i]! + out[r * rowLen + i - bpp]!) & 0xff;
    return out;
  }
  // PNG predictors (10–15): every row starts with its own filter-type byte.
  const rows = Math.floor(data.length / (rowLen + 1));
  const out = Buffer.alloc(rows * rowLen);
  const prev = Buffer.alloc(rowLen);
  for (let r = 0; r < rows; r++) {
    const type = data[r * (rowLen + 1)]!;
    const src = data.subarray(r * (rowLen + 1) + 1, (r + 1) * (rowLen + 1));
    const cur = out.subarray(r * rowLen, (r + 1) * rowLen);
    for (let i = 0; i < rowLen; i++) {
      const a = i >= bpp ? cur[i - bpp]! : 0;
      const b = prev[i]!;
      const c = i >= bpp ? prev[i - bpp]! : 0;
      const x = src[i]!;
      let v: number;
      switch (type) {
        case 0:
          v = x;
          break;
        case 1:
          v = x + a;
          break;
        case 2:
          v = x + b;
          break;
        case 3:
          v = x + ((a + b) >> 1);
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          return `PNG filter type ${type} invalid`;
      }
      cur[i] = v & 0xff;
    }
    cur.copy(prev);
  }
  return out;
}
