import { readFileSync, readdirSync, statSync } from 'fs';
import { createServer, Server } from 'net';
import { join } from 'path';
import { inflateSync } from 'zlib';

import QRCode from 'qrcode';

import { PdfRenderTimeoutError } from '../../render-pdf.util';

import { FONT_FAMILY_STACK } from './native-fonts';
import {
  NativeRenderPool,
  pdfNativeConcurrency,
  PDF_NATIVE_POOL_SIZE_DEFAULT,
} from './render-pool';
import {
  NativeRenderRequest,
  PdfGlyphCoverageError,
  PdfNativeInputError,
  PdfNativeRenderError,
  PdfNativeThreadCrashError,
  PdfRenderPoolClosedError,
  PdfRenderPoolSaturatedError,
} from './render-protocol';

/**
 * Native PDF render runtime (PDF renderer migration P1, plan §4.2-§4.4, §8 T6, D3, D7, T1). Real worker threads, real
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
const AT = '2026-10-25T01:30:00.000Z'; // the Europe/London DST change night
const pools: NativeRenderPool[] = [];

function pool(
  options: ConstructorParameters<typeof NativeRenderPool>[0] = {},
): NativeRenderPool {
  const p = new NativeRenderPool({
    documentsModule: DOCS,
    allowProbe: true,
    ...options,
  });
  pools.push(p);
  return p;
}

afterEach(async () => {
  await Promise.all(pools.splice(0).map((p) => p.destroy()));
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

function embeddedFonts(pdf: Buffer): string[] {
  return [
    ...pdf.toString('latin1').matchAll(/\/BaseFont \/[A-Z]{6}\+([A-Za-z-]+)/g),
  ]
    .map((x) => x[1]!)
    .sort();
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

// ─── glyph coverage (D3) ──────────────────────────────────────────────────────────────────────────────────────────────

describe('glyph coverage guard (D3)', () => {
  const supported = [
    'Zoë Ł. O’Brien-Ñúñez — “quoted” · £1,234.56 – €5',
    'Ελληνικά: Αθηνά Παπαδοπούλου',
    'Кириллица: Ёлка Щукина, Ґанна Їжак',
    'Latin Extended: Şţefan Țepeș, Dvořák, Łódź, Ærø, Øyvind, Ŝ, ẞ, Việt Nam',
    // Only in the Noto Sans fallback, not in Liberation Sans: proves the fallback is really drawn, not just accepted.
    'Fallback: Ԥ Ϳ ẟ',
    '<script>alert(1)</script> {{constructor}} ${process.env.X} %PDF- endstream endobj ( ) \\',
    // Liberation Sans 2.1.5 itself maps Hebrew, so it passes the guard (glyphs exist; RTL order is react-pdf's bidi).
    'Hebrew: שלום',
  ];

  it('supported Unicode renders, every character reaches the PDF text layer, and the Noto fallback is embedded', async () => {
    const p = pool();
    for (const bold of [false, true]) {
      const pdf = await p.render(text(supported, 'Glyphs', bold));
      const printed = printedCharacters(pdf);
      for (const line of supported) {
        for (const ch of line.replace(/\s/g, ''))
          expect({ ch, printed: printed.has(ch) }).toEqual({
            ch,
            printed: true,
          });
      }
      const fonts = embeddedFonts(pdf);
      expect(fonts).toContain(bold ? 'LiberationSans-Bold' : 'LiberationSans');
      expect(fonts).toContain(bold ? 'NotoSans-Bold' : 'NotoSans-Regular');
      expect(
        fonts.filter((f) => !/^(LiberationSans|NotoSans)/.test(f)),
      ).toEqual([]);
    }
  }, 60_000);

  it.each([
    ['CJK', '王小明'],
    ['Arabic', 'محمد'],
    ['Devanagari', 'नमस्ते'],
    ['emoji', 'Sam 😀'],
    ['lone surrogate', 'bad \ud800 half'],
    ['NUL', 'a\u0000b'],
    ['TAB', 'a\tb'],
    ['CR', 'line\r\nbreak'],
    ['C1 control', 'a\u0085b'],
    ['zero-width space', 'Ann​Smith'],
    ['bidi override', 'Ann ‮htimS'],
    ['bidi isolate', 'Ann ⁦x⁩'],
    ['soft hyphen', 'Ann­Smith'],
    ['BOM', '﻿Ann'],
    ['private use', 'Ann '],
  ])(
    '%s fails closed, naming the field and never the value',
    async (_label, hostile) => {
      const p = pool();
      const req: NativeRenderRequest = {
        kind: 'test-table',
        viewModel: {
          title: 'T',
          columns: ['Staff'],
          rows: [['ok'], ['ok'], ['ok'], [hostile]],
          footerLeft: 'Venue',
        },
        generatedAt: AT,
      };
      const err = (await p
        .render(req)
        .catch((e: unknown) => e)) as PdfGlyphCoverageError;
      expect(err).toBeInstanceOf(PdfGlyphCoverageError);
      expect(err.code).toBe('error_PDF_GLYPH_UNSUPPORTED');
      expect(err.field).toBe('viewModel.rows[3][0]');
      expect(err.message).toContain('viewModel.rows[3][0]');
      for (const piece of hostile.split(/\s+/))
        if (piece.length > 1) expect(err.message).not.toContain(piece);
      expect(p.stats().crashed).toBe(0); // a refusal, not a crash: the thread serves the next render
      await expect(p.render(text(['next']))).resolves.toBeInstanceOf(Buffer);
    },
    60_000,
  );

  it('a key that could be data is masked in the field path', async () => {
    const p = pool();
    const err = (await p
      .render({
        kind: 'test-text',
        viewModel: { title: 'x', lines: [], byName: { 'Ann Smith': '王' } },
        generatedAt: AT,
      })
      .catch((e: unknown) => e)) as PdfGlyphCoverageError;
    expect(err.field).toBe('viewModel.byName[<key>]');
    expect(err.message).not.toContain('Ann Smith');
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

  it('layouts use the font stack the guard checks', () => {
    expect(FONT_FAMILY_STACK).toEqual(['Liberation Sans', 'Noto Sans']);
  });
});
