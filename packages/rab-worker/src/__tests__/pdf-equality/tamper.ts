import { deflateSync, inflateSync } from 'zlib';

/**
 * Deliberate, byte-level alterations of a rendered PDF — the self-test's proof that the checker catches a difference it
 * did not cause through the input. The parser in helpers/pdf-inspect.ts locates objects by their headers (not the xref
 * table), so an edited object need not keep its length. Test-only.
 */

interface StreamLoc {
  dictStart: number;
  dataStart: number;
  dataEnd: number;
  dict: string;
}

function contentStreams(pdf: Buffer): StreamLoc[] {
  const s = pdf.toString('latin1');
  const out: StreamLoc[] = [];
  const re = /\d+ 0 obj\s*(<<[^]*?>>)\s*stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const dict = m[1]!;
    const len = Number(/\/Length\s+(\d+)/.exec(dict)?.[1] ?? -1);
    const dataStart = m.index + m[0].length;
    if (len < 0) continue;
    out.push({ dictStart: m.index + m[0].indexOf('<<'), dataStart, dataEnd: dataStart + len, dict });
    re.lastIndex = dataStart + len;
  }
  return out;
}

function replaceStream(pdf: Buffer, loc: StreamLoc, data: Buffer): Buffer {
  const compressed = /\/FlateDecode/.test(loc.dict) ? deflateSync(data) : data;
  const dict = loc.dict.replace(/\/Length\s+\d+/, `/Length ${compressed.length}`);
  return Buffer.concat([pdf.subarray(0, loc.dictStart), Buffer.from(dict, 'latin1'), Buffer.from('\nstream\n', 'latin1'), compressed, pdf.subarray(loc.dataEnd)]);
}

/**
 * Swaps one glyph for another in the first page content stream that draws text: the `nth` hex-string glyph code is
 * replaced by the next DIFFERENT code drawn after it. One character of one word changes; nothing else does.
 */
export function swapOneGlyph(pdf: Buffer, nth = 25): Buffer {
  for (const loc of contentStreams(pdf)) {
    if (/\/(Subtype|Type)\s*\/(Image|XObject|Font|FontDescriptor|ObjStm|XRef)|\/Length1|\/N\s+\d/.test(loc.dict)) continue;
    let data: Buffer;
    try {
      data = /\/FlateDecode/.test(loc.dict) ? inflateSync(pdf.subarray(loc.dataStart, loc.dataEnd)) : pdf.subarray(loc.dataStart, loc.dataEnd);
    } catch {
      continue;
    }
    const text = data.toString('latin1');
    if (!/\bBT\b/.test(text)) continue;
    // Skia (Chromium) draws one glyph per `<XXXX> Tj`.
    const glyphs = [...text.matchAll(/<([0-9A-Fa-f]{4})>\s*Tj/g)];
    if (glyphs.length > nth + 1) {
      const target = glyphs[nth]!;
      const other = glyphs.slice(nth + 1).find((g) => g[1]!.toUpperCase() !== target[1]!.toUpperCase());
      if (other) {
        const at = target.index! + 1;
        const edited = text.slice(0, at) + other[1] + text.slice(at + 4);
        return replaceStream(pdf, loc, Buffer.from(edited, 'latin1'));
      }
    }
    // pdfkit (react-pdf, the native renderer) draws words as 2-byte glyph strings inside `[<…> kern <…>] TJ` arrays: in
    // the `nth` such string of two or more glyphs, the first glyph code becomes the next DIFFERENT code of that string.
    const strings = [...text.matchAll(/\[([^\]]*)\]\s*TJ/g)].flatMap((m) => [...m[1]!.matchAll(/<([0-9A-Fa-f]{8,})>/g)].map((s) => ({ hex: s[1]!, at: m.index! + 1 + s.index! + 1 })));
    const candidates = strings.filter((s) => s.hex.length % 4 === 0 && new Set(s.hex.toUpperCase().match(/.{4}/g)).size > 1);
    const target = candidates[Math.min(nth, candidates.length - 1)];
    if (!target) continue;
    const codes = target.hex.match(/.{4}/g)!;
    const other = codes.slice(1).find((c) => c.toUpperCase() !== codes[0]!.toUpperCase())!;
    const edited = text.slice(0, target.at) + other + text.slice(target.at + 4);
    return replaceStream(pdf, loc, Buffer.from(edited, 'latin1'));
  }
  throw new Error('swapOneGlyph: no content stream with enough single-glyph Tj strings or multi-glyph TJ strings');
}

/** Removes the last page from the page tree (/Kids and /Count). */
export function dropLastPage(pdf: Buffer): Buffer {
  const s = pdf.toString('latin1');
  const m = /\/Type\s*\/Pages\s*\/Count\s+(\d+)\s*\/Kids\s*\[([^\]]*)\]/.exec(s);
  if (!m) throw new Error('dropLastPage: page tree not found');
  const kids = [...m[2]!.matchAll(/\d+\s+0\s+R/g)].map((k) => k[0]);
  if (kids.length < 2) throw new Error('dropLastPage: need at least two pages');
  const replacement = `/Type /Pages /Count ${Number(m[1]) - 1} /Kids [${kids.slice(0, -1).join(' ')}]`;
  return Buffer.from(s.slice(0, m.index) + replacement + s.slice(m.index + m[0].length), 'latin1');
}
