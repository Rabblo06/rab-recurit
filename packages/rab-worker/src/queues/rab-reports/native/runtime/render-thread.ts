/* eslint-disable @typescript-eslint/no-require-imports -- everything after the guard is loaded lazily, on purpose */
import { parentPort, threadId, workerData } from 'worker_threads';

import {
  installThreadGuard,
  guardReport,
  setRenderClock,
} from './thread-guard';

import type { CoveragePredicate, GlyphFont } from './glyph-coverage';
import type {
  NativeDocumentMeta,
  RenderJobMessage,
  RenderThreadData,
  ToThreadMessage,
  FromThreadMessage,
} from './render-protocol';

/**
 * Entry point of one native PDF render thread (worker_threads; plan §4.2, trade-off T1). Created by `render-pool.ts`
 * with an EMPTY environment (`env: {}`), a heap cap (`resourceLimits`) and no stdin; terminated by the pool on the
 * 30 s deadline. It holds no database handle, no credentials and no tenant context: it receives one view-model per
 * message and returns bytes, and keeps nothing between messages but the fonts and the loaded code.
 *
 * Order matters: `worker_threads` (for `parentPort`) and the guard are the ONLY top-level imports. The guard is
 * installed before react-pdf, the fonts or any layout module is loaded, so nothing loaded after it can open a socket,
 * spawn a process or a thread, or read the wall clock.
 */

const port = parentPort;
if (!port) throw new Error('render-thread must run as a worker thread');
const data = workerData as RenderThreadData;

function send(msg: FromThreadMessage, transfer: ArrayBuffer[] = []): void {
  port!.postMessage(msg, transfer);
}

/** The registry a document module exports: one function per document kind returning the `<Document>` element. */
export type NativeDocumentRegistry = Readonly<
  Record<string, (viewModel: unknown, meta: NativeDocumentMeta) => unknown>
>;

interface ThreadState {
  renderToBuffer: (element: never) => Promise<Buffer>;
  registry: NativeDocumentRegistry;
  covers: CoveragePredicate;
  coverageFamilies: string[];
  registeredFamilies: () => string[];
}

let state: ThreadState | undefined;
let rendersServed = 0;

async function init(): Promise<ThreadState> {
  const fonts = require('./native-fonts') as typeof import('./native-fonts');
  const protocol =
    require('./render-protocol') as typeof import('./render-protocol');
  const coverage =
    require('./glyph-coverage') as typeof import('./glyph-coverage');
  // ESM-only package, loaded by Node's require(esm) (Node >= 22.12; the Worker image runs Node 24).
  const reactPdf =
    require('@react-pdf/renderer') as typeof import('@react-pdf/renderer');

  const loaded = fonts.loadVendoredFonts();
  fonts.registerVendoredFonts(
    reactPdf.Font as unknown as import('./native-fonts').ReactPdfFontStore,
    loaded,
  );

  const docs = require(data.documentsModule) as {
    NATIVE_DOCUMENT_REGISTRY?: NativeDocumentRegistry;
  };
  const registry = docs.NATIVE_DOCUMENT_REGISTRY;
  if (!registry || typeof registry !== 'object') {
    throw new protocol.PdfNativeRenderError(
      'native PDF renderer: the documents module exports no NATIVE_DOCUMENT_REGISTRY',
    );
  }

  // Coverage is computed over FONT_FAMILY_STACK, the families react-pdf actually falls back through.
  const families: GlyphFont[][] = [];
  for (const family of fonts.FONT_FAMILY_STACK) {
    const weights: GlyphFont[] = [];
    for (const f of loaded.filter((x) => x.family === family)) {
      await reactPdf.Font.load({ fontFamily: family, fontWeight: f.weight });
      const source = reactPdf.Font.getFont({
        fontFamily: family,
        fontWeight: f.weight,
      }) as unknown as { data?: GlyphFont } | undefined;
      if (
        !source?.data ||
        typeof source.data.hasGlyphForCodePoint !== 'function'
      ) {
        throw new protocol.PdfNativeRenderError(
          `native PDF renderer: font ${f.file} did not load`,
        );
      }
      weights.push(source.data);
    }
    families.push(weights);
  }

  return {
    renderToBuffer:
      reactPdf.renderToBuffer as unknown as ThreadState['renderToBuffer'],
    registry,
    covers: coverage.coveragePredicate(families),
    coverageFamilies: [...fonts.FONT_FAMILY_STACK],
    registeredFamilies: () => reactPdf.Font.getRegisteredFontFamilies(),
  };
}

/** Image bytes arrive as Uint8Array (structured clone drops the Buffer prototype); layouts get Buffers back. */
function reviveBuffers(value: unknown): unknown {
  if (value instanceof Uint8Array)
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value)) return value.map(reviveBuffers);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = reviveBuffers(v);
    return out;
  }
  return value;
}

async function render(s: ThreadState, msg: RenderJobMessage): Promise<void> {
  const protocol =
    require('./render-protocol') as typeof import('./render-protocol');
  const coverage =
    require('./glyph-coverage') as typeof import('./glyph-coverage');
  try {
    const build = Object.prototype.hasOwnProperty.call(s.registry, msg.kind)
      ? s.registry[msg.kind]
      : undefined;
    if (typeof build !== 'function')
      throw new protocol.PdfNativeInputError(
        `native PDF renderer: no native layout for document kind "${msg.kind}"`,
      );

    const t0 = performance.now();
    coverage.assertGlyphCoverage(msg.viewModel, s.covers);
    const t1 = performance.now();

    setRenderClock(msg.generatedAtMs);
    const meta: NativeDocumentMeta = {
      creationDate: new Date(msg.generatedAtMs),
      modificationDate: new Date(msg.generatedAtMs),
    };
    const element = build(reviveBuffers(msg.viewModel), meta);
    const pdf = await s.renderToBuffer(element as never);
    const t2 = performance.now();

    if (
      !Buffer.isBuffer(pdf) ||
      pdf.subarray(0, 5).toString('latin1') !== '%PDF-'
    ) {
      throw new protocol.PdfNativeRenderError(
        'native PDF renderer: output is not a PDF',
      );
    }
    // Copy into an exactly-sized ArrayBuffer and transfer it (no second copy; never transfers a pooled slab).
    const out = new ArrayBuffer(pdf.length);
    new Uint8Array(out).set(pdf);
    rendersServed += 1;
    send(
      {
        type: 'result',
        id: msg.id,
        ok: true,
        pdf: out,
        timings: { coverageMs: t1 - t0, renderMs: t2 - t1 },
      },
      [out],
    );
  } catch (err) {
    send({
      type: 'result',
      id: msg.id,
      ok: false,
      error: protocol.serializeRenderError(err),
    });
  }
}

function probe(id: number): void {
  if (!data.allowProbe) return; // production threads never answer
  const g = guardReport();
  send({
    type: 'probe-result',
    id,
    report: {
      threadId,
      envKeys: Object.keys(process.env),
      blockedModules: g.blockedModules,
      blockedGlobals: g.blockedGlobals,
      networkBuiltinsLoaded: g.networkBuiltinsLoaded,
      registeredFontFamilies: state ? state.registeredFamilies() : [],
      coverageFamilies: state ? state.coverageFamilies : [],
      heapUsedBytes: process.memoryUsage().heapUsed,
      rendersServed,
      clockNowMs: Date.now(),
    },
  });
}

async function main(): Promise<void> {
  const t0 = performance.now();
  try {
    installThreadGuard();
    state = await init();
  } catch (err) {
    const protocol =
      require('./render-protocol') as typeof import('./render-protocol');
    send({ type: 'init-error', error: protocol.serializeRenderError(err) });
    return;
  }
  // One message at a time: the pool never sends a second render before the first result.
  let chain: Promise<void> = Promise.resolve();
  port!.on('message', (msg: ToThreadMessage) => {
    if (msg.type === 'probe') probe(msg.id);
    else if (msg.type === 'render')
      chain = chain.then(() => render(state!, msg));
  });
  send({ type: 'ready', initMs: performance.now() - t0 });
}

void main();
