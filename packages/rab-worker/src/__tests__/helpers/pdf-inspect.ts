import { inflateSync } from 'zlib';

/**
 * Test-only, dependency-free reader for the PDFs Chromium (Skia/PDF) produces: page count, embedded image XObjects and
 * the text drawn on each page, decoded through each font's ToUnicode CMap. Deliberately minimal: it understands exactly
 * the shapes Skia emits (uncompressed object dictionaries, FlateDecode streams, Type0/Identity-H fonts drawn with hex
 * `Tj` / `TJ` strings) and is not a general PDF parser. Used by the PDF-hardening regression suite as the oracle for
 * "this text / image is / is not in the rendered document".
 */
interface PdfObject {
  dict: string;
  stream: Buffer | null;
}

function parseObjects(pdf: Buffer): Map<number, PdfObject> {
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
    const streamAt = body.search(/>>\s*stream\r?\n/);
    if (streamAt < 0) {
      objects.set(id, { dict: body, stream: null });
    } else {
      const header = /stream\r?\n/.exec(body.slice(streamAt))!;
      const dataStart = bodyStart + streamAt + header.index + header[0].length;
      const dataEnd = text.indexOf('endstream', dataStart);
      const dict = body.slice(0, streamAt + 2);
      let raw = pdf.subarray(dataStart, dataEnd);
      // Trailing EOL before `endstream` is not part of the data.
      if (raw.length && raw[raw.length - 1] === 0x0a) raw = raw.subarray(0, raw.length - 1);
      if (raw.length && raw[raw.length - 1] === 0x0d) raw = raw.subarray(0, raw.length - 1);
      let stream: Buffer = raw;
      if (/\/FlateDecode/.test(dict)) {
        try {
          stream = inflateSync(raw);
        } catch {
          stream = raw;
        }
      }
      objects.set(id, { dict, stream });
      re.lastIndex = dataEnd;
    }
  }
  return objects;
}

function ref(dict: string, key: string): number | null {
  const m = new RegExp(`/${key}\\s+(\\d+)\\s+0\\s+R`).exec(dict);
  return m ? Number(m[1]) : null;
}

function parseToUnicode(cmap: string): Map<string, string> {
  const map = new Map<string, string>();
  const hexToStr = (hex: string) => {
    let s = '';
    for (let i = 0; i + 4 <= hex.length; i += 4) s += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
    return s;
  };
  for (const block of cmap.matchAll(/beginbfchar([^]*?)endbfchar/g)) {
    for (const pair of block[1]!.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) map.set(pair[1]!.toUpperCase(), hexToStr(pair[2]!));
  }
  for (const block of cmap.matchAll(/beginbfrange([^]*?)endbfrange/g)) {
    for (const r of block[1]!.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<[0-9A-Fa-f]+>|\[[^\]]*\])/g)) {
      const lo = parseInt(r[1]!, 16);
      const hi = parseInt(r[2]!, 16);
      const width = r[1]!.length;
      if (r[3]!.startsWith('[')) {
        const items = [...r[3]!.matchAll(/<([0-9A-Fa-f]+)>/g)].map((x) => hexToStr(x[1]!));
        for (let c = lo; c <= hi; c++) map.set(c.toString(16).toUpperCase().padStart(width, '0'), items[c - lo] ?? '');
      } else {
        const base = parseInt(r[3]!.slice(1, -1), 16);
        for (let c = lo; c <= hi; c++) map.set(c.toString(16).toUpperCase().padStart(width, '0'), String.fromCharCode(base + (c - lo)));
      }
    }
  }
  return map;
}

function decodeHex(hex: string, cmap: Map<string, string> | undefined): string {
  const clean = hex.replace(/\s+/g, '').toUpperCase();
  let out = '';
  for (let i = 0; i + 4 <= clean.length; i += 4) {
    const code = clean.slice(i, i + 4);
    out += cmap?.get(code) ?? '�';
  }
  return out;
}

function pageFontMaps(page: PdfObject, objects: Map<number, PdfObject>): Map<string, Map<string, string>> {
  const fonts = new Map<string, Map<string, string>>();
  const fontDict = /\/Font\s*<<([^]*?)>>/.exec(page.dict)?.[1] ?? '';
  for (const f of fontDict.matchAll(/\/(\w+)\s+(\d+)\s+0\s+R/g)) {
    const font = objects.get(Number(f[2]));
    const tu = font ? ref(font.dict, 'ToUnicode') : null;
    const cmap = tu != null ? objects.get(tu)?.stream?.toString('latin1') : undefined;
    fonts.set(f[1]!, cmap ? parseToUnicode(cmap) : new Map());
  }
  return fonts;
}

function pageContents(page: PdfObject, objects: Map<number, PdfObject>): string {
  const single = ref(page.dict, 'Contents');
  if (single != null) return objects.get(single)?.stream?.toString('latin1') ?? '';
  const arr = /\/Contents\s*\[([^\]]*)\]/.exec(page.dict)?.[1] ?? '';
  return [...arr.matchAll(/(\d+)\s+0\s+R/g)].map((x) => objects.get(Number(x[1]))?.stream?.toString('latin1') ?? '').join('\n');
}

/** Pages in document order (follows /Pages /Kids). */
function orderedPages(objects: Map<number, PdfObject>): PdfObject[] {
  const catalog = [...objects.values()].find((o) => /\/Type\s*\/Catalog/.test(o.dict));
  const out: PdfObject[] = [];
  const walk = (id: number) => {
    const node = objects.get(id);
    if (!node) return;
    if (/\/Type\s*\/Pages/.test(node.dict)) {
      const kids = /\/Kids\s*\[([^\]]*)\]/.exec(node.dict)?.[1] ?? '';
      for (const k of kids.matchAll(/(\d+)\s+0\s+R/g)) walk(Number(k[1]));
    } else if (/\/Type\s*\/Page\b/.test(node.dict)) {
      out.push(node);
    }
  };
  const root = catalog ? ref(catalog.dict, 'Pages') : null;
  if (root != null) walk(root);
  return out;
}

export interface PdfInspection {
  pageCount: number;
  /** Text per page, one line per BT…ET text object, in content-stream order. */
  pageTexts: string[];
  /** Whole-document text with whitespace collapsed — convenient for `toContain`. */
  text: string;
  /** "WxH" of every embedded raster image (soft masks excluded). */
  images: string[];
}

export function inspectPdf(pdf: Buffer): PdfInspection {
  if (pdf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('not a PDF');
  const objects = parseObjects(pdf);
  const pages = orderedPages(objects);
  const pageTexts = pages.map((page) => {
    const fonts = pageFontMaps(page, objects);
    const content = pageContents(page, objects);
    const lines: string[] = [];
    for (const bt of content.matchAll(/BT([^]*?)ET/g)) {
      let current: Map<string, string> | undefined;
      let line = '';
      const tokens = bt[1]!.matchAll(/\/(\w+)\s+[-\d.]+\s+Tf|<([0-9A-Fa-f\s]*)>\s*Tj|\[([^\]]*)\]\s*TJ/g);
      for (const t of tokens) {
        if (t[1]) current = fonts.get(t[1]);
        else if (t[2] !== undefined) line += decodeHex(t[2], current);
        else if (t[3] !== undefined) for (const h of t[3].matchAll(/<([0-9A-Fa-f\s]*)>/g)) line += decodeHex(h[1]!, current);
      }
      if (line) lines.push(line);
    }
    return lines.join('\n');
  });
  // A soft mask is itself an /Image referenced via /SMask from its colour image — count only the colour image.
  const masks = new Set<number>();
  for (const o of objects.values()) for (const s of o.dict.matchAll(/\/SMask\s+(\d+)\s+0\s+R/g)) masks.add(Number(s[1]));
  const images: string[] = [];
  for (const [id, o] of objects) {
    if (!/\/Subtype\s*\/Image/.test(o.dict) || masks.has(id)) continue;
    const w = /\/Width\s+(\d+)/.exec(o.dict)?.[1];
    const h = /\/Height\s+(\d+)/.exec(o.dict)?.[1];
    images.push(`${w}x${h}`);
  }
  return {
    pageCount: pages.length,
    pageTexts,
    text: pageTexts.join('\n').replace(/\s+/g, ' ').trim(),
    images: images.sort(),
  };
}

/**
 * The PDF bytes with the only intentionally time-varying fields removed (Skia writes /CreationDate and /ModDate; it
 * writes no /ID). Two renders of the same HTML with the same Chromium produce identical normalised bytes, so equality
 * here means "same drawing operations, same fonts, same images" — i.e. visually identical output.
 */
export function normalisedPdfBytes(pdf: Buffer): string {
  return pdf
    .toString('latin1')
    .replace(/\/(CreationDate|ModDate)\s*\([^)]*\)/g, '')
    .replace(/\/ID\s*\[[^\]]*\]/g, '');
}
