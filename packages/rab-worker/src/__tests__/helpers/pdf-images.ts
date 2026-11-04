import { inflateSync } from 'zlib';

/**
 * Test-only: the raw-pixel images a PDF embeds for a PNG source, decoded to RGBA — e.g. to read a QR code back with a
 * JS decoder. Both writers in use embed a PNG the same way (MEASURED: Skia/Chromium and pdfkit/@react-pdf/renderer
 * write 8-bit FlateDecode pixels without a predictor, in DeviceRGB / DeviceGray or an ICCBased space of N components).
 * Soft masks and DCT (JPEG) images are skipped; any other shape throws instead of returning wrong pixels.
 * Deliberately separate from pdf-inspect.ts (text and image sizes), which it does not change.
 */
export interface RasterImage {
  width: number;
  height: number;
  /** RGBA, 8 bits per channel, opaque (soft masks are ignored). */
  rgba: Uint8ClampedArray;
}

interface RawObject {
  dict: string;
  stream: Buffer | null;
}

function objects(pdf: Buffer): Map<number, RawObject> {
  const text = pdf.toString('latin1');
  const out = new Map<number, RawObject>();
  const re = /(\d+) 0 obj\s*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const start = m.index + m[0].length;
    const end = text.indexOf('endobj', start);
    if (end < 0) break;
    const body = text.slice(start, end);
    const at = body.search(/>>\s*stream\r?\n/);
    if (at < 0) {
      out.set(Number(m[1]), { dict: body, stream: null });
      continue;
    }
    const header = /stream\r?\n/.exec(body.slice(at))!;
    const dataStart = start + at + header.index + header[0].length;
    const dataEnd = text.indexOf('endstream', dataStart);
    let raw = pdf.subarray(dataStart, dataEnd);
    if (raw.length && raw[raw.length - 1] === 0x0a) raw = raw.subarray(0, raw.length - 1);
    if (raw.length && raw[raw.length - 1] === 0x0d) raw = raw.subarray(0, raw.length - 1);
    const dict = body.slice(0, at + 2);
    out.set(Number(m[1]), { dict, stream: /\/FlateDecode/.test(dict) ? inflateSync(raw) : raw });
    re.lastIndex = dataEnd;
  }
  return out;
}

export function rasterImages(pdf: Buffer): RasterImage[] {
  const objs = objects(pdf);
  const masks = new Set<number>();
  for (const o of objs.values()) for (const s of o.dict.matchAll(/\/SMask\s+(\d+)\s+0\s+R/g)) masks.add(Number(s[1]));
  const out: RasterImage[] = [];
  for (const [id, o] of objs) {
    if (!/\/Subtype\s*\/Image/.test(o.dict) || masks.has(id) || /\/DCTDecode/.test(o.dict) || !o.stream) continue;
    if (/\/DecodeParms/.test(o.dict) || !/\/BitsPerComponent\s+8\b/.test(o.dict)) throw new Error(`image ${id}: unsupported encoding`);
    const width = Number(/\/Width\s+(\d+)/.exec(o.dict)?.[1]);
    const height = Number(/\/Height\s+(\d+)/.exec(o.dict)?.[1]);
    let components: number;
    if (/\/ColorSpace\s*\/DeviceRGB/.test(o.dict)) components = 3;
    else if (/\/ColorSpace\s*\/DeviceGray/.test(o.dict)) components = 1;
    else {
      const icc = /\/ColorSpace\s*\[\s*\/ICCBased\s+(\d+)\s+0\s+R\s*\]/.exec(o.dict);
      const n = icc ? /\/N\s+(\d+)/.exec(objs.get(Number(icc[1]))?.dict ?? '')?.[1] : undefined;
      if (!n) throw new Error(`image ${id}: unsupported colour space`);
      components = Number(n);
    }
    if (components !== 1 && components !== 3) throw new Error(`image ${id}: ${components} colour components`);
    if (o.stream.length !== width * height * components) throw new Error(`image ${id}: ${o.stream.length} bytes for ${width}x${height}x${components}`);
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let p = 0; p < width * height; p++) {
      const src = p * components;
      rgba[p * 4] = o.stream[src]!;
      rgba[p * 4 + 1] = o.stream[components === 3 ? src + 1 : src]!;
      rgba[p * 4 + 2] = o.stream[components === 3 ? src + 2 : src]!;
      rgba[p * 4 + 3] = 255;
    }
    out.push({ width, height, rgba });
  }
  return out;
}

/**
 * Test-only adapter for pdf-inspect.ts until its own indirect-/Resources support lands (owned by the inspector work, not
 * changed here): pdfkit (the native renderer) writes each page's `/Resources` as an indirect object, while the inspector
 * reads fonts from an inline page dictionary. This returns the same PDF with every `/Resources n 0 R` replaced by that
 * object's dictionary text, so `inspectPdf(inlinePageResources(pdf))` reads both writers. A no-op for Chromium output
 * (its resources are already inline). Byte offsets change, which the regex-based inspector never uses.
 */
export function inlinePageResources(pdf: Buffer): Buffer {
  const text = pdf.toString('latin1');
  const replaced = text.replace(/\/Resources\s+(\d+)\s+0\s+R/g, (whole, id: string) => {
    const m = new RegExp(`(?:^|[\\r\\n])${id} 0 obj\\s*(<<[^]*?>>)\\s*endobj`).exec(text);
    return m ? `/Resources ${m[1]}` : whole;
  });
  return Buffer.from(replaced, 'latin1');
}
