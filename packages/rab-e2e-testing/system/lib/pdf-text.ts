import { inflateSync } from 'node:zlib';

/**
 * Plain-text extraction from a PDF the product rendered (Chromium/Skia output: FlateDecode content streams, Type0 fonts with
 * Identity-H encoding and a ToUnicode CMap each). Enough to assert what a document SAYS — not a general PDF parser: no
 * object streams, no encryption, no Type3 glyph programs. A new baseline starts a new line; kerning is dropped, so compare
 * with whitespace removed (`compact`) where a phrase may be laid out in several runs.
 */
export function pdfText(pdf: Buffer): string {
  const raw = pdf.toString('latin1');
  if (!raw.startsWith('%PDF-')) throw new Error('not a PDF (no %PDF- header)');
  const objects = new Map<number, { dict: string; stream: Buffer | null }>();
  for (const m of raw.matchAll(/(\d+)\s+0\s+obj\b([\s\S]*?)\bendobj/g)) {
    const body = m[2]!;
    const si = body.search(/\bstream\r?\n/);
    if (si < 0) {
      objects.set(Number(m[1]), { dict: body, stream: null });
      continue;
    }
    const dict = body.slice(0, si);
    const start = si + body.slice(si).indexOf('\n') + 1;
    const end = body.lastIndexOf('endstream');
    let data = Buffer.from(body.slice(start, end).replace(/\r?\n$/, ''), 'latin1');
    if (/\/FlateDecode/.test(dict)) data = inflateSync(data);
    objects.set(Number(m[1]), { dict, stream: data });
  }

  // Font resource name → that font's ToUnicode map (code → text), from every /Font dictionary, inline or referenced.
  const fonts = new Map<string, { map: Map<number, string>; bytes: number }>();
  const fontDictOf = (dict: string): string | null => {
    const inline = dict.match(/\/Font\s*<<([\s\S]*?)>>/);
    if (inline) return inline[1]!;
    const ref = dict.match(/\/Font\s+(\d+)\s+0\s+R/);
    return ref ? (objects.get(Number(ref[1]))?.dict ?? null) : null;
  };
  for (const { dict } of objects.values()) {
    const fd = fontDictOf(dict);
    if (!fd) continue;
    for (const [, name, num] of fd.matchAll(/\/([^\s/<>[\]()]+)\s+(\d+)\s+0\s+R/g)) {
      const tu = objects.get(Number(num))?.dict.match(/\/ToUnicode\s+(\d+)\s+0\s+R/);
      const cmap = tu ? objects.get(Number(tu[1]))?.stream : null;
      if (cmap && !fonts.has(name!)) fonts.set(name!, parseToUnicode(cmap.toString('latin1')));
    }
  }

  const out: string[] = [];
  for (const { dict, stream } of objects.values()) {
    if (!stream || /\/(Subtype\s*\/(Image|Type1C|CIDFontType0C|OpenType)|Length1|FontFile)/.test(dict)) continue;
    const content = stream.toString('latin1');
    if (!/\b(Tj|TJ)\b/.test(content)) continue;
    out.push(showText(content, fonts));
  }
  return out.join('\n');
}

/** Whitespace-free form for containment checks on extracted text. */
export const compact = (s: string) => s.replace(/\s+/g, '');

function parseToUnicode(cmap: string): { map: Map<number, string>; bytes: number } {
  const map = new Map<number, string>();
  const utf16 = (hex: string) => {
    const units: number[] = [];
    for (let i = 0; i + 4 <= hex.length; i += 4) units.push(parseInt(hex.slice(i, i + 4), 16));
    return String.fromCharCode(...units);
  };
  let bytes = 2;
  const cs = cmap.match(/begincodespacerange\s*<([0-9A-Fa-f]+)>/);
  if (cs) bytes = cs[1]!.length / 2;
  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const [, src, dst] of block[1]!.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) map.set(parseInt(src!, 16), utf16(dst!));
  }
  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const [, lo, hi, rest] of block[1]!.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<[0-9A-Fa-f]+>|\[[^\]]*\])/g)) {
      const a = parseInt(lo!, 16);
      const b = parseInt(hi!, 16);
      if (rest!.startsWith('[')) {
        const dsts = [...rest!.matchAll(/<([0-9A-Fa-f]+)>/g)].map((x) => x[1]!);
        for (let c = a; c <= b; c++) if (dsts[c - a]) map.set(c, utf16(dsts[c - a]!));
      } else {
        const base = rest!.slice(1, -1);
        const head = base.slice(0, -4);
        const last = parseInt(base.slice(-4), 16);
        for (let c = a; c <= b; c++) map.set(c, utf16(head + (last + c - a).toString(16).padStart(4, '0')));
      }
    }
  }
  return { map, bytes };
}

function showText(content: string, fonts: Map<string, { map: Map<number, string>; bytes: number }>): string {
  const tokens = content.match(/\/[^\s/<>[\]()]+|<[0-9A-Fa-f\s]*>|\((?:\\[\s\S]|[^\\)])*\)|\[|\]|-?\d*\.?\d+|[A-Za-z'"*]+/g) ?? [];
  let font: { map: Map<number, string>; bytes: number } | undefined;
  let line = '';
  let lastTmY = '';
  const lines: string[] = [];
  const operands: string[] = [];
  const decode = (tok: string): string => {
    let codes: number[] = [];
    if (tok.startsWith('<')) {
      const hex = tok.slice(1, -1).replace(/\s/g, '');
      const width = (font?.bytes ?? 1) * 2;
      for (let i = 0; i + width <= hex.length; i += width) codes.push(parseInt(hex.slice(i, i + width), 16));
    } else {
      const s = tok.slice(1, -1).replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, e: string) => (/^[0-7]/.test(e) ? String.fromCharCode(parseInt(e, 8)) : ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' } as Record<string, string>)[e] ?? e));
      codes = [...s].map((ch) => ch.charCodeAt(0));
    }
    return codes.map((c) => font?.map.get(c) ?? (font ? '' : String.fromCharCode(c))).join('');
  };
  const newline = () => {
    if (line.trim()) lines.push(line);
    line = '';
  };
  for (const tok of tokens) {
    if (/^[A-Za-z'"*]+$/.test(tok) && !/^(true|false|null)$/.test(tok)) {
      if (tok === 'Tf') font = fonts.get(operands[operands.length - 2]!.slice(1));
      else if (tok === 'Tj' || tok === "'" || tok === '"') line += decode(operands[operands.length - 1] ?? '()');
      else if (tok === 'TJ') {
        const open = operands.lastIndexOf('[');
        for (const op of operands.slice(open + 1)) {
          if (op.startsWith('<') || op.startsWith('(')) line += decode(op);
          else if (op !== ']' && Number(op) < -250) line += ' ';
        }
      } else if (tok === 'Td' || tok === 'TD') {
        // A horizontal move continues the line (Chromium places letter-spaced runs glyph by glyph); a vertical one ends it.
        if (Number(operands[operands.length - 1]) !== 0) newline();
      } else if (tok === 'Tm') {
        const y = operands[operands.length - 1]!;
        if (y !== lastTmY) newline();
        lastTmY = y;
      } else if (tok === 'T*') newline();
      operands.length = 0;
    } else {
      operands.push(tok);
    }
  }
  newline();
  return lines.join('\n');
}
