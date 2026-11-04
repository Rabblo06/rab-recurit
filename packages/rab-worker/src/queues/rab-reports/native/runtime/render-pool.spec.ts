import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'fs';
import { createServer, Server } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { inflateSync } from 'zlib';

import QRCode from 'qrcode';

import { createInstanceHeartbeat } from '../../../../core/runtime/instance-heartbeat';
import { PdfRenderTimeoutError } from '../../render-pdf.util';

import { REPLACEMENT_MARKER } from './glyph-coverage';

import { FONT_FAMILY_STACK } from './native-fonts';
import {
  NativeRenderPool,
  pdfNativeConcurrency,
  pdfNativePrewarm,
  prewarmRenderPool,
  PDF_NATIVE_POOL_SIZE_DEFAULT,
  shutdownRenderPool,
} from './render-pool';
import {
  NativeRenderRequest,
  PdfNativeInputError,
  PdfNativeRenderError,
  PdfNativeThreadCrashError,
  PdfRenderPoolClosedError,
  PdfRenderPoolSaturatedError,
} from './render-protocol';

/**
 * Native PDF render runtime (PDF renderer migration P1, plan §4.2-§4.4, §8 T6, D7, T1; §15 F1-F3). Real worker threads, real
 * @react-pdf/renderer, real vendored fonts; no database. The documents are the TEST registry
 * (`__tests__/helpers/native-render-test-documents.ts`), loaded inside the thread exactly like the production one.
 */

const DOCS = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  '__tests__',
  'helpers',
  'native-render-test-documents.ts',
);
const SLOW_DOCS = join(DOCS, '..', 'native-render-slow-documents.ts');
const AT = '2026-10-25T01:30:00.000Z'; // the Europe/London DST change night
const pools: NativeRenderPool[] = [];
/** Warnings the pools logged in the current test (substitution counts, start failures). */
const logs: string[] = [];

function pool(
  options: ConstructorParameters<typeof NativeRenderPool>[0] = {},
): NativeRenderPool {
  const p = new NativeRenderPool({
    documentsModule: DOCS,
    allowProbe: true,
    logger: { log: () => undefined, warn: (m) => logs.push(`warn: ${m}`) },
    ...options,
  });
  pools.push(p);
  return p;
}

afterEach(async () => {
  await Promise.all(pools.splice(0).map((p) => p.destroy()));
  logs.length = 0;
});

const text = (
  lines: string[],
  title = 'Runtime test',
  bold = false,
): NativeRenderRequest => ({
  kind: 'test-text',
  viewModel: { title, lines, bold },
  generatedAt: AT,
});

const table = (
  rows: number,
  footerLeft = 'Venue · 25 Oct 2026',
): NativeRenderRequest => ({
  kind: 'test-table',
  viewModel: {
    title: 'Final timesheet',
    columns: ['Staff', 'Start', 'Finish', 'Break', 'Hours', 'Status'],
    rows: Array.from({ length: rows }, (_, i) => [
      `Staff member ${i}`,
      '01:30',
      '06:29',
      '30 min',
      '4h 59m',
      i % 7 ? 'Completed' : 'Missing clock-out',
    ]),
    footerLeft,
  },
  generatedAt: AT,
});

/** Every Unicode scalar the PDF's ToUnicode CMaps map a glyph to (pdfkit's `beginbfrange [<…> …]` form). */
function printedCharacters(pdf: Buffer): Set<string> {
  const chars = new Set<string>();
  const s = pdf.toString('latin1');
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length;
    const end = s.indexOf('endstream', start);
    if (end < 0) break;
    let body: string;
    try {
      body = inflateSync(pdf.subarray(start, end)).toString('latin1');
    } catch {
      continue;
    }
    if (!body.includes('beginbfrange')) continue;
    for (const arr of body.matchAll(/\[([^\]]*)\]/g)) {
      for (const entry of arr[1]!.matchAll(/<([0-9a-fA-F ]+)>/g)) {
        const units = entry[1]!
          .trim()
          .split(/\s+/)
          .map((h) => parseInt(h, 16));
        chars.add(String.fromCharCode(...units));
      }
    }
  }
  return chars;
}

/** Distinct embedded font names (pdfkit names each subset twice: in the Type0 font and its CIDFont descendant). */
function embeddedFonts(pdf: Buffer): string[] {
  return [
    ...new Set(
      [
        ...pdf
          .toString('latin1')
          .matchAll(/\/BaseFont \/[A-Z]{6}\+([A-Za-z-]+)/g),
      ].map((x) => x[1]!),
    ),
  ].sort();
}

/** pdfkit objects: number → body (dictionary text) and inflated stream (if any). */
function pdfObjects(
  pdf: Buffer,
): Map<number, { dict: string; stream?: string }> {
  const s = pdf.toString('latin1');
  const out = new Map<number, { dict: string; stream?: string }>();
  for (const m of s.matchAll(/(\d+) 0 obj\s*([\s\S]*?)endobj/g)) {
    const body = m[2]!;
    const at = body.indexOf('stream');
    if (at < 0) {
      out.set(Number(m[1]), { dict: body });
      continue;
    }
    const start =
      m.index! + m[0].indexOf(body) + at + (body[at + 6] === '\r' ? 8 : 7);
    const end = s.indexOf('endstream', start);
    let stream: string | undefined;
    try {
      stream = inflateSync(pdf.subarray(start, end)).toString('latin1');
    } catch {
      stream = undefined;
    }
    out.set(Number(m[1]), { dict: body.slice(0, at), stream });
  }
  return out;
}

/**
 * The text of each line IN DRAWING ORDER (left to right), read back from the page content stream: glyph ids from the
 * TJ operators, mapped through each font's ToUnicode CMap. A y move starts a new line. This is the VISUAL order the
 * reader sees, which for right-to-left text must be the reverse of the logical order.
 */
function visualLines(pdf: Buffer): string[] {
  const objs = pdfObjects(pdf);
  const cmapOf = new Map<string, Map<number, string>>(); // font resource name → cid → text
  for (const { dict } of objs.values()) {
    const fonts = /\/Font\s*<<([^>]*)>>/.exec(dict);
    if (!fonts) continue;
    for (const [, name, ref] of fonts[1]!.matchAll(/\/(F\d+)\s+(\d+) 0 R/g)) {
      const font = objs.get(Number(ref))?.dict ?? '';
      const tu = /\/ToUnicode (\d+) 0 R/.exec(font);
      const cmap = new Map<number, string>();
      const body = tu ? (objs.get(Number(tu[1]))?.stream ?? '') : '';
      for (const range of body.matchAll(
        /<([0-9a-fA-F]+)> <[0-9a-fA-F]+> \[([^\]]*)\]/g,
      )) {
        let cid = parseInt(range[1]!, 16);
        for (const entry of range[2]!.matchAll(/<([0-9a-fA-F ]+)>/g)) {
          cmap.set(
            cid++,
            String.fromCharCode(
              ...entry[1]!
                .trim()
                .split(/\s+/)
                .map((h) => parseInt(h, 16)),
            ),
          );
        }
      }
      cmapOf.set(name!, cmap);
    }
  }
  const content = [...objs.values()]
    .map((o) => o.stream ?? '')
    .filter((st) => / T[Jj]\b/.test(st) && !st.includes('begincmap'));
  const lines: string[] = [];
  let current = '';
  let font = '';
  for (const st of content) {
    for (const op of st.matchAll(
      /1 0 0 1 (-?[\d.]+) (-?[\d.]+) cm|\/(F\d+) [\d.]+ Tf|\[([^\]]*)\] TJ/g,
    )) {
      if (op[1] !== undefined) {
        if (Number(op[1]) === 0 && Number(op[2]) !== 0 && current) {
          lines.push(current);
          current = '';
        }
      } else if (op[3] !== undefined) font = op[3];
      else {
        const cmap = cmapOf.get(font) ?? new Map<number, string>();
        for (const hex of op[4]!.matchAll(/<([0-9a-fA-F]+)>/g)) {
          for (let i = 0; i < hex[1]!.length; i += 4)
            current += cmap.get(parseInt(hex[1]!.slice(i, i + 4), 16)) ?? '?';
        }
      }
    }
  }
  if (current) lines.push(current);
  return lines;
}

/** The log line must not carry the value, any multi-character piece of it, or a code point. */
function assertNoValueLeak(line: string, value: string): void {
  for (const piece of value.split(/\s+/))
    if (piece.length > 1) expect(line).not.toContain(piece);
  for (const ch of value) {
    const cp = ch.codePointAt(0)!;
    if (cp > 0x7e) expect(line).not.toContain(ch);
    expect(line.toLowerCase()).not.toContain(
      `u+${cp.toString(16).padStart(4, '0')}`,
    );
  }
  expect(line).not.toMatch(/\\u[0-9a-f]{4}|U\+[0-9A-F]{4}/i);
}

async function until(cond: () => boolean, ms = 20_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 20));
  }
}

// ─── configuration ────────────────────────────────────────────────────────────────────────────────────────────────────

describe('pool configuration (fail closed)', () => {
  it('PDF_NATIVE_CONCURRENCY: unset → 2, "1".."4" → n, anything else refuses', () => {
    expect(pdfNativeConcurrency({})).toBe(PDF_NATIVE_POOL_SIZE_DEFAULT);
    for (const n of [1, 2, 3, 4])
      expect(pdfNativeConcurrency({ PDF_NATIVE_CONCURRENCY: String(n) })).toBe(
        n,
      );
    for (const bad of ['', ' 2', '2 ', '0', '5', '2.0', 'two', '-1', '02']) {
      expect(() =>
        pdfNativeConcurrency({ PDF_NATIVE_CONCURRENCY: bad }),
      ).toThrow('PDF_NATIVE_CONCURRENCY');
    }
  });

  it('options are bounded: size ≤ 4, deadline ≤ 30 s, heap within 32..2048 MB', () => {
    expect(() => new NativeRenderPool({ size: 5 })).toThrow(RangeError);
    expect(() => new NativeRenderPool({ size: 0 })).toThrow(RangeError);
    expect(() => new NativeRenderPool({ timeoutMs: 30_001 })).toThrow(
      RangeError,
    );
    expect(() => new NativeRenderPool({ maxOldGenerationSizeMb: 16 })).toThrow(
      RangeError,
    );
    const p = new NativeRenderPool();
    expect([p.size, p.timeoutMs, p.maxOldGenerationSizeMb]).toEqual([
      2, 30_000, 512,
    ]);
  });

  it('refuses a request that is not plain data, before any thread exists', async () => {
    const p = pool();
    class Row {
      name = 'x';
    }
    const bad: NativeRenderRequest[] = [
      {
        kind: 'test-text',
        viewModel: { title: 'x', lines: [], when: new Date() },
        generatedAt: AT,
      },
      {
        kind: 'test-text',
        viewModel: { title: 'x', lines: [new Row()] },
        generatedAt: AT,
      },
      {
        kind: 'test-text',
        viewModel: { title: 'x', lines: [], f: () => 1 },
        generatedAt: AT,
      },
      {
        kind: 'test-text',
        viewModel: { title: 'x', lines: [], n: NaN },
        generatedAt: AT,
      },
      {
        kind: 'Test Text',
        viewModel: { title: 'x', lines: [] },
        generatedAt: AT,
      },
      {
        kind: 'test-text',
        viewModel: { title: 'x', lines: [] },
        generatedAt: 'not a date',
      },
    ];
    for (const req of bad)
      await expect(p.render(req)).rejects.toBeInstanceOf(PdfNativeInputError);
    expect(p.stats().spawned).toBe(0);
  });
});

// ─── isolation: environment and network ───────────────────────────────────────────────────────────────────────────────

describe('render thread isolation (T1)', () => {
  it('the thread has an EMPTY process.env: no key of the parent reaches it', async () => {
    process.env.RAB_RUNTIME_SPEC_SENTINEL =
      'postgres://crewflow_app:secret@127.0.0.1/rab';
    try {
      const p = pool();
      await p.render(text(['env check']));
      const report = await p.probe();
      expect(Object.keys(process.env).length).toBeGreaterThan(1);
      expect(report.envKeys).toEqual([]);
    } finally {
      delete process.env.RAB_RUNTIME_SPEC_SENTINEL;
    }
  }, 60_000);

  it('static: nothing in the @react-pdf/renderer closure imports a network or process module', () => {
    // Walk the installed production closure from the worker's own resolution root.
    const root = join(
      require
        .resolve('@react-pdf/renderer/package.json')
        .split('@react-pdf')[0]!,
    );
    const seen = new Set<string>();
    const queue = ['@react-pdf/renderer', 'react'];
    while (queue.length) {
      const name = queue.shift()!;
      if (seen.has(name)) continue;
      seen.add(name);
      const pkg = JSON.parse(
        readFileSync(join(root, name, 'package.json'), 'utf8'),
      ) as { dependencies?: Record<string, string> };
      queue.push(...Object.keys(pkg.dependencies ?? {}));
    }
    const net =
      /(?:require\(\s*|from\s*|import\(\s*|import\s+)['"](?:node:)?(http|https|http2|net|tls|dgram|dns|dns\/promises|child_process|cluster|undici|node-fetch|cross-fetch|axios|ws)['"]/;
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        const st = statSync(p);
        if (st.isDirectory()) {
          if (entry !== 'node_modules') walk(p);
        } else if (/\.(c|m)?js$/.test(entry) && !entry.endsWith('.d.ts')) {
          const m = net.exec(readFileSync(p, 'utf8'));
          if (m) hits.push(`${p}: ${m[1]}`);
        }
      }
    };
    for (const name of seen) walk(join(root, name));
    expect(seen.size).toBeGreaterThan(50); // the real closure (61 packages at 4.9.0), not an empty walk
    expect(hits).toEqual([]);
  });

  it('runtime: a normal render loads no network builtin and refuses nothing (only yoga probes fetch with its data: URL)', async () => {
    const p = pool();
    await p.render(table(40));
    await p.render(text(['second render']));
    const report = await p.probe();
    expect(report.networkBuiltinsLoaded).toEqual([]);
    expect(report.blockedModules).toEqual([]);
    expect(report.blockedGlobals.every((g) => g === 'fetch(data:)')).toBe(true);
  }, 60_000);

  it('a layout that tries the network reaches nothing: modules refused, fetch refused, zero connections', async () => {
    let connections = 0;
    const server: Server = createServer((s) => {
      connections += 1;
      s.destroy();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const { port } = server.address() as { port: number };
      const p = pool();
      await p
        .render({
          kind: 'test-network',
          viewModel: { url: `http://127.0.0.1:${port}` },
          generatedAt: AT,
        })
        .catch(() => undefined);
      const report = await p.probe();
      expect(report.blockedModules).toEqual(
        expect.arrayContaining([
          'http',
          'https',
          'net',
          'tls',
          'dns',
          'child_process',
          'worker_threads',
        ]),
      );
      expect(report.blockedGlobals).toContain('fetch(http:)');
      expect(report.networkBuiltinsLoaded).toEqual([]);
      await new Promise((r) => setTimeout(r, 200));
      expect(connections).toBe(0);
    } finally {
      await new Promise((r) => server.close(r));
    }
  }, 60_000);
});

// ─── unprintable characters (F1) ──────────────────────────────────────────────────────────────────────────────────────

describe('unprintable characters: visible marker + count-only log (F1)', () => {
  const supported = [
    'Zoë Ł. O’Brien-Ñúñez — “quoted” · £1,234.56 – €5',
    'Ελληνικά: Αθηνά Παπαδοπούλου',
    'Кириллица: Ёлка Щукина, Ґанна Їжак',
    'Latin Extended: Şţefan Țepeș, Dvořák, Łódź, Ærø, Øyvind, Ŝ, ẞ, Việt Nam',
    // Only in the Noto Sans fallback, not in Liberation Sans: proves the fallback is really drawn, not just accepted.
    'Fallback: Ԥ Ϳ ẟ',
    '<script>alert(1)</script> {{constructor}} ${process.env.X} %PDF- endstream endobj ( ) \\',
    // Liberation Sans 2.1.5 itself maps Hebrew (order checked in the F2 block below).
    'Hebrew: שלום',
  ];

  it('supported Unicode renders unchanged, reaches the text layer, the Noto fallback is embedded; nothing is logged', async () => {
    const p = pool();
    for (const bold of [false, true]) {
      const r = await p.renderWithTimings(text(supported, 'Glyphs', bold));
      expect(r.substitutions).toEqual([]);
      const printed = printedCharacters(r.pdf);
      for (const line of supported) {
        for (const ch of line.replace(/\s/g, ''))
          expect({ ch, printed: printed.has(ch) }).toEqual({
            ch,
            printed: true,
          });
      }
      expect(printed.has(REPLACEMENT_MARKER)).toBe(false);
      const fonts = embeddedFonts(r.pdf);
      expect(fonts).toContain(bold ? 'LiberationSans-Bold' : 'LiberationSans');
      expect(fonts).toContain(bold ? 'NotoSans-Bold' : 'NotoSans-Regular');
      expect(
        fonts.filter((f) => !/^(LiberationSans|NotoSans)/.test(f)),
      ).toEqual([]);
    }
    expect(logs).toEqual([]);
  }, 60_000);

  // [label, hostile value, characters replaced by the marker]
  const hostile: [string, string, number][] = [
    ['CJK', '王小明', 3],
    ['Arabic', 'محمد', 4],
    ['Devanagari', 'नमस्ते', 6],
    ['emoji', 'Sam 😀', 1],
    ['lone surrogate', 'bad \ud800 half', 1],
    ['NUL', 'a\u0000b', 1],
    ['lone CR', 'a\rb', 1],
    ['ESC', 'a\u001bb', 1],
    ['C1 control', 'a\u0085b', 1],
    ['zero-width space', 'Ann​Smith', 1],
    ['ZWJ', 'Ann‍Smith', 1],
    ['bidi override', 'Ann ‮htimS', 1],
    ['bidi isolate', 'Ann ⁦x⁩', 2],
    ['soft hyphen', 'Ann­Smith', 1],
    ['BOM', '﻿Ann', 1],
    ['private use', 'Ann ', 1],
    ['unassigned', 'Ann ͸', 1],
  ];

  it.each(hostile)(
    '%s: renders with the visible marker; the log names kind, field and count, never the value',
    async (_label, value, replaced) => {
      const p = pool();
      const req: NativeRenderRequest = {
        kind: 'test-table',
        viewModel: {
          title: 'T',
          columns: ['Staff'],
          rows: [['ok'], ['ok'], ['ok'], [value]],
          footerLeft: 'Venue',
        },
        generatedAt: AT,
      };
      const r = await p.renderWithTimings(req);
      expect(r.pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect(r.substitutions).toEqual([
        { field: 'viewModel.rows[3][0]', count: replaced },
      ]);
      // The marker is really printed, by the primary font (no fallback needed for it).
      expect(printedCharacters(r.pdf).has(REPLACEMENT_MARKER)).toBe(true);
      expect(embeddedFonts(r.pdf)).toContain('LiberationSans');
      // Exactly one count-only log line.
      expect(logs).toHaveLength(1);
      expect(logs[0]).toBe(
        `warn: native PDF render (kind=test-table): ${replaced} unprintable character(s) replaced by the visible marker in 1 field(s): viewModel.rows[3][0]=${replaced}`,
      );
      assertNoValueLeak(logs[0]!, value);
      expect(p.stats()).toMatchObject({ crashed: 0, failed: 0, completed: 1 });
    },
    60_000,
  );

  it('CRLF becomes LF and TAB a space (normalised, not counted, not logged)', async () => {
    const p = pool();
    const r = await p.renderWithTimings(
      text(['line one\r\nline two', 'col\tcol']),
    );
    expect(r.substitutions).toEqual([]);
    expect(logs).toEqual([]);
    expect(printedCharacters(r.pdf).has(REPLACEMENT_MARKER)).toBe(false);
  }, 60_000);

  it('the marker prints in bold too, and every field is counted separately (one log line per render)', async () => {
    const p = pool();
    const r = await p.renderWithTimings({
      kind: 'test-text',
      viewModel: {
        title: 'Bold 王',
        lines: ['ok', '😀😀', 'fine', 'a\u0000b'],
        bold: true,
      },
      generatedAt: AT,
    });
    expect(r.substitutions).toEqual([
      { field: 'viewModel.title', count: 1 },
      { field: 'viewModel.lines[1]', count: 2 },
      { field: 'viewModel.lines[3]', count: 1 },
    ]);
    expect(embeddedFonts(r.pdf)).toEqual(['LiberationSans-Bold']);
    expect(printedCharacters(r.pdf).has(REPLACEMENT_MARKER)).toBe(true);
    expect(logs).toEqual([
      'warn: native PDF render (kind=test-text): 4 unprintable character(s) replaced by the visible marker in 3 field(s): viewModel.title=1, viewModel.lines[1]=2, viewModel.lines[3]=1',
    ]);
  }, 60_000);

  it('a key that could be data is masked in the logged field path', async () => {
    const p = pool();
    const r = await p.renderWithTimings({
      kind: 'test-text',
      viewModel: { title: 'x', lines: [], byName: { 'Ann Smith': '王' } },
      generatedAt: AT,
    });
    expect(r.substitutions).toEqual([
      { field: 'viewModel.byName[<key>]', count: 1 },
    ]);
    expect(logs[0]).not.toContain('Ann Smith');
  }, 60_000);

  it('the fallback font is parsed lazily: not at thread start, once when first needed', async () => {
    const p = pool({ size: 1 });
    const plain = await p.render(text(['Only Latin-1: Zoë, £5']));
    expect((await p.probe()).fallbackFontLoads).toBe(0);
    expect(embeddedFonts(plain)).toEqual([
      'LiberationSans',
      'LiberationSans-Bold',
    ]);
    await p.render(text(['Needs the fallback: Ԥ']));
    await p.render(text(['Again: ẟ']));
    expect((await p.probe()).fallbackFontLoads).toBe(1);
  }, 60_000);
});

// ─── RTL order (F2) ───────────────────────────────────────────────────────────────────────────────────────────────────

describe('right-to-left order (F2): what react-pdf prints, read back from the content stream', () => {
  it('Hebrew prints in correct visual order (rightmost = first logical letter), also inside a left-to-right line', async () => {
    const p = pool();
    const lines = ['שלום', 'abc שלום def', 'דוד כהן 12'];
    const pdf = await p.render(text(lines, 'RTL', true)); // all bold: one font, one CMap
    const visual = visualLines(pdf);
    // Line 0 is the title. Logical "שלום" (shin, lamed, vav, final mem) must be DRAWN left-to-right as "םולש".
    expect(visual.slice(1)).toEqual(['םולש', 'abc םולש def', '12 ןהכ דוד']);
    // Logical order is what a reader means; visual order reversed per RTL run is what a correct renderer draws.
    expect(visual[1]).toBe([...lines[0]!].reverse().join(''));
  }, 60_000);

  it('Arabic has no glyphs in the stack: it prints markers (counted), never blank and never mis-shaped letters', async () => {
    const p = pool();
    const r = await p.renderWithTimings(text(['مرحبا']));
    expect(r.substitutions).toEqual([
      { field: 'viewModel.lines[0]', count: 5 },
    ]);
    expect(visualLines(r.pdf)[1]).toBe(REPLACEMENT_MARKER.repeat(5));
  }, 60_000);
});

// ─── pre-warm and health (F3) ─────────────────────────────────────────────────────────────────────────────────────────

describe('pre-warm (F3)', () => {
  it('PDF_NATIVE_PREWARM: unset → min(2, size); "0".."4" up to the pool size; anything else refuses', () => {
    expect(pdfNativePrewarm({})).toBe(2);
    expect(pdfNativePrewarm({ PDF_NATIVE_CONCURRENCY: '1' })).toBe(1);
    expect(pdfNativePrewarm({ PDF_NATIVE_PREWARM: '0' })).toBe(0);
    expect(pdfNativePrewarm({ PDF_NATIVE_PREWARM: '1' })).toBe(1);
    for (const bad of ['', ' 1', '3', '-1', 'two', '1.0'])
      expect(() => pdfNativePrewarm({ PDF_NATIVE_PREWARM: bad })).toThrow(
        'PDF_NATIVE_PREWARM',
      );
  });

  it('prewarm() returns at once, starts threads in the background, and the next render does not wait for a start', async () => {
    const p = pool({ size: 2 });
    const t0 = performance.now();
    expect(p.prewarm(2)).toBeUndefined();
    expect(performance.now() - t0).toBeLessThan(50);
    expect(p.stats()).toMatchObject({ starting: 2, minThreads: 2 });
    await until(() => p.stats().idle === 2);
    const start = p.stats().lastThreadStart!;
    expect(start.spawnToReadyMs).toBeGreaterThan(0);
    for (const k of [
      'modulesMs',
      'fontFilesVerifyMs',
      'primaryFontParseMs',
      'warmupRenderMs',
    ] as const)
      expect(start[k]).toBeGreaterThanOrEqual(0);
    const r = await p.renderWithTimings(table(5));
    expect(r.timings.queueMs).toBeLessThan(50); // dispatched to a warm thread at once
    expect(p.stats().spawned).toBe(2);
  }, 60_000);

  it('pre-warmed threads survive the idle timeout and are replaced when recycled', async () => {
    const p = pool({ size: 2, idleMs: 1_000, maxRendersPerThread: 1 });
    p.prewarm(1);
    await until(() => p.stats().idle === 1);
    await new Promise((r) => setTimeout(r, 1_500)); // past idleMs
    expect(p.stats()).toMatchObject({ live: 1, idle: 1, spawned: 1 });
    await p.render(text(['recycle me'])); // maxRendersPerThread 1 → retired, then replaced
    await until(() => p.stats().idle === 1 && p.stats().spawned === 2);
    expect(p.stats().live).toBe(1);
  }, 60_000);

  it('a thread that fails to start is logged and NOT respawned in a loop', async () => {
    const p = pool({
      size: 2,
      documentsModule: join(__dirname, 'render-protocol.ts'),
    });
    p.prewarm(2);
    await until(() => p.stats().live === 0 && p.stats().spawned >= 1);
    await new Promise((r) => setTimeout(r, 1_000));
    expect(p.stats().spawned).toBeLessThanOrEqual(2);
    expect(
      logs.some((l) =>
        l.startsWith('warn: native PDF render thread failed to start'),
      ),
    ).toBe(true);
  }, 60_000);

  it('the Worker health heartbeat never waits on the pool: it keeps beating while threads are still starting', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rab-health-'));
    const file = join(dir, 'jobs.health.json');
    try {
      const heartbeat = createInstanceHeartbeat(
        'jobs',
        { progress: () => ({}) } as never,
        { CREWFLOW_INSTANCE_HEALTH_FILE: file },
      );
      const beats: number[] = [];
      const timer = setInterval(() => {
        heartbeat.beat();
        beats.push(
          (JSON.parse(readFileSync(file, 'utf8')) as { at: number }).at,
        );
      }, 50);
      try {
        // SLOW_DOCS spends ~2 s at module load INSIDE the thread, so the threads stay "starting" for a while.
        const p = pool({ size: 2, documentsModule: SLOW_DOCS });
        const t0 = performance.now();
        p.prewarm(2);
        expect(performance.now() - t0).toBeLessThan(50);
        await new Promise((r) => setTimeout(r, 1_000));
        expect(p.stats().starting).toBe(2); // still not ready...
        const during = beats.slice();
        // ...yet the heartbeat file was rewritten every ~50 ms the whole time.
        expect(during.length).toBeGreaterThanOrEqual(12);
        for (let i = 1; i < during.length; i++)
          expect(during[i]! - during[i - 1]!).toBeLessThan(500);
        await until(() => p.stats().idle === 2);
      } finally {
        clearInterval(timer);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('prewarmRenderPool() (the boot call) returns void and never throws for a thread failure', async () => {
    // The default registry (native/native-documents) belongs to the documents branch; here it does not exist, so the
    // threads fail to start. Boot must not notice.
    expect(prewarmRenderPool(1)).toBeUndefined();
    await new Promise((r) => setTimeout(r, 2_500));
    await shutdownRenderPool();
  }, 60_000);
});

// ─── deadline and memory cap ──────────────────────────────────────────────────────────────────────────────────────────

describe('deadline and memory cap', () => {
  it('a layout that never returns is terminated at 30 s (PdfRenderTimeoutError) and the pool recovers', async () => {
    const p = pool({ size: 1 });
    const t0 = Date.now();
    const err = await p
      .render({ kind: 'test-forever', viewModel: {}, generatedAt: AT })
      .catch((e: unknown) => e);
    const elapsed = Date.now() - t0;
    expect(err).toBeInstanceOf(PdfRenderTimeoutError);
    expect((err as PdfRenderTimeoutError).step).toBe('native-render');
    expect((err as PdfRenderTimeoutError).timeoutMs).toBe(30_000);
    expect(elapsed).toBeGreaterThanOrEqual(30_000);
    expect(elapsed).toBeLessThan(33_000);
    expect(p.stats()).toMatchObject({ timedOut: 1, live: 0 });
    await expect(p.render(text(['after the timeout']))).resolves.toBeInstanceOf(
      Buffer,
    );
    expect(p.stats()).toMatchObject({ live: 1, spawned: 2 });
  }, 60_000);

  it('a huge real document is terminated at the deadline too (bounded deadline for the test), and the pool recovers', async () => {
    const p = pool({ size: 1, timeoutMs: 1_500 });
    await expect(p.render(table(5_000))).rejects.toBeInstanceOf(
      PdfRenderTimeoutError,
    );
    await expect(p.render(table(5))).resolves.toBeInstanceOf(Buffer);
  }, 60_000);

  it('a layout that exhausts the heap kills only its thread at the default 512 MB cap; the pool recovers', async () => {
    const p = pool({ size: 1 });
    const err = (await p
      .render({ kind: 'test-heap-bomb', viewModel: {}, generatedAt: AT })
      .catch((e: unknown) => e)) as PdfNativeThreadCrashError;
    expect(err).toBeInstanceOf(PdfNativeThreadCrashError);
    expect(err.code).toBe('error_PDF_NATIVE_OUT_OF_MEMORY');
    expect(err.causeCode).toBe('ERR_WORKER_OUT_OF_MEMORY');
    await expect(p.render(text(['after OOM']))).resolves.toBeInstanceOf(Buffer);
    expect(p.stats()).toMatchObject({ crashed: 1, live: 1 });
  }, 60_000);

  it('an oversized real document hits a lowered heap cap (64 MB): thread killed, pool recovers', async () => {
    const p = pool({ size: 1, maxOldGenerationSizeMb: 64 });
    const err = (await p
      .render(table(3_000))
      .catch((e: unknown) => e)) as PdfNativeThreadCrashError;
    expect(err).toBeInstanceOf(PdfNativeThreadCrashError);
    expect(err.code).toBe('error_PDF_NATIVE_OUT_OF_MEMORY');
    await expect(p.render(table(10))).resolves.toBeInstanceOf(Buffer);
  }, 60_000);
});

// ─── pool behaviour, determinism ──────────────────────────────────────────────────────────────────────────────────────

describe('pool behaviour', () => {
  it('50 concurrent requests with a pool of 2: all complete, dispatched in submission order, never more than 2 threads, none leaked', async () => {
    const dispatched: number[] = [];
    let maxLive = 0;
    const p = pool({
      size: 2,
      onDispatch: (seq) => {
        dispatched.push(seq);
        maxLive = Math.max(maxLive, p.stats().live);
      },
    });
    const requests = Array.from({ length: 50 }, (_, i) =>
      table(5 + (i % 3) * 10, `Venue ${i}`),
    );
    const results = await Promise.all(requests.map((r) => p.render(r)));
    expect(results).toHaveLength(50);
    for (const pdf of results)
      expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(dispatched).toEqual(Array.from({ length: 50 }, (_, i) => i));
    expect(maxLive).toBeLessThanOrEqual(2);
    expect(p.stats()).toMatchObject({
      completed: 50,
      failed: 0,
      queued: 0,
      live: 2,
      spawned: 2,
    });
    // Each result belongs to its own request: identical to a serial render of the same request (D7 determinism).
    for (const i of [0, 1, 2, 17, 49])
      expect((await p.render(requests[i]!)).equals(results[i]!)).toBe(true);
    expect(results[0]!.equals(results[3]!)).toBe(false); // different footer → different bytes
    await p.destroy();
    expect(p.stats()).toMatchObject({ live: 0, spawned: 2, exited: 2 });
  }, 120_000);

  it('D7: same request → same bytes on another thread and later; the thread clock is the request generatedAt', async () => {
    const a = pool({ size: 1 });
    const b = pool({ size: 1 });
    const first = await a.render(table(12));
    await new Promise((r) => setTimeout(r, 1_100)); // the wall clock moves; the bytes must not
    const second = await b.render(table(12));
    expect(second.equals(first)).toBe(true);
    const later = await a.render({
      ...table(12),
      generatedAt: '2026-10-26T09:00:00.000Z',
    });
    expect(later.equals(first)).toBe(false);
    await a.render({ kind: 'test-clock', viewModel: {}, generatedAt: AT });
    expect((await a.probe()).clockNowMs).toBe(Date.parse(AT));
  }, 60_000);

  it('image bytes cross into the thread and reach the layout as a Buffer', async () => {
    // The production QR path: qrcode's PNG (QrImageService uses the same library and options).
    const png = await QRCode.toBuffer('SHIFT-QR-TEST', {
      type: 'png',
      width: 600,
      errorCorrectionLevel: 'H',
      margin: 2,
    });
    const pdf = await pool().render({
      kind: 'test-image',
      viewModel: { title: 'QR', png },
      generatedAt: AT,
    });
    expect(pdf.toString('latin1')).toContain('/Subtype /Image');
  }, 60_000);

  it('a full queue refuses instead of buffering without bound; destroy refuses queued and later work', async () => {
    const p = pool({ size: 1, maxQueue: 2 });
    await p.render(text(['warm-up'])); // the thread is ready, so the next request is dispatched at once
    const running = p.render(table(200));
    const q1 = p.render(text(['q1']));
    const q2 = p.render(text(['q2']));
    await expect(p.render(text(['q3']))).rejects.toBeInstanceOf(
      PdfRenderPoolSaturatedError,
    );
    const destroying = p.destroy();
    await expect(running).rejects.toBeInstanceOf(PdfRenderPoolClosedError);
    await expect(q1).rejects.toBeInstanceOf(PdfRenderPoolClosedError);
    await expect(q2).rejects.toBeInstanceOf(PdfRenderPoolClosedError);
    await destroying;
    await expect(p.render(text(['after']))).rejects.toBeInstanceOf(
      PdfRenderPoolClosedError,
    );
    expect(p.stats().live).toBe(0);
  }, 60_000);

  it('an unknown document kind is refused by the thread without killing it', async () => {
    const p = pool();
    await expect(
      p.render({ kind: 'payslip', viewModel: {}, generatedAt: AT }),
    ).rejects.toBeInstanceOf(PdfNativeInputError);
    await expect(p.render(text(['still alive']))).resolves.toBeInstanceOf(
      Buffer,
    );
    expect(p.stats().crashed).toBe(0);
  }, 60_000);

  it('a documents module without NATIVE_DOCUMENT_REGISTRY refuses every queued render (fail closed at thread start)', async () => {
    const p = pool({ documentsModule: join(__dirname, 'render-protocol.ts') });
    const err = await p.render(text(['x'])).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PdfNativeRenderError);
    expect((err as Error).message).toContain('NATIVE_DOCUMENT_REGISTRY');
  }, 60_000);

  it('layouts use the font stack the glyph pass checks', () => {
    expect(FONT_FAMILY_STACK).toEqual(['Liberation Sans', 'Noto Sans']);
  });
});
