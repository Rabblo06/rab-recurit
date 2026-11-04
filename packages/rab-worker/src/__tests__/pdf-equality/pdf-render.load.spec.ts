import { Logger } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';

import { bullmqWorkerOptionsOf, CONSUMER_QUEUES } from '@rab/server/engine/worker-shared/queue-registry';

import { createConsumerJobProcessor } from '../../core/scheduler/bullmq-scheduler';
import { normalisedPdfBytes } from '../helpers/pdf-inspect';
import { buildFixtures, FixtureDocument } from './fixtures';
import { extractFixture, outDir, saveArtifact } from './harness';
import { percentile, ResourceSampler, ResourceSummary } from './load-metrics';
import { NATIVE_ONLY } from './mode';
import { loadNativeRenderer, chromiumRenderer, Renderer, RendererName } from './renderers';

/**
 * PDF RENDER LOAD TEST (P0 plan §8 P3 performance; owner-approved D4: pool of 2). Opt-in: RAB_PDF_LOAD=1.
 *
 * For each renderer (PDF_LOAD_RENDERERS, default "chromium,native", "native" with PDF_EQUALITY_MODE=native-only; a missing native renderer is reported, not failed)
 * and each table size (PDF_LOAD_ROWS, default "5,40,300"; the final timesheet, finalised variant):
 *   1. one SERIAL render = the determinism reference;
 *   2. PDF_LOAD_RENDERS (default 50) render requests submitted AT ONCE into a pool of 2 — the `rab-shift-statements`
 *      consumer's registry concurrency (`bullmqWorkerOptionsOf(...).concurrency`, asserted = 2 = the approved pool);
 *   3. measured: render time p50 / p95 / max (the render alone), queue-inclusive latency p95, wall time, failures, peak
 *      resident memory of the whole process tree and CPU time (see load-metrics.ts for exactness per OS); every output
 *      must parse and be byte-identical to the serial render (apart from /CreationDate and /ModDate).
 *
 * Submission path (PDF_LOAD_VIA):
 *   direct (default)  the harness's own pool of 2 around the renderer (renderPdf / renderHtmlToPdf) — what the P0 plan
 *                     calls "50 concurrent renders through renderReportPdf (pool size 2)";
 *   bullmq            the REAL BullMQ consumer path: a `Worker` on `rab-shift-statements` with the registry's options and
 *                     the production `createConsumerJobProcessor` wrapper, 50 jobs added at once, on a DISPOSABLE Redis
 *                     (PDF_LOAD_REDIS_URL, required; an isolated `pdf-load-<ts>` prefix). The handler renders; the DB and
 *                     storage stages of processShiftStatementJob are not part of it (they need a database).
 *
 * Thresholds (P0 plan §8, to be measured inside the Worker image with --cpus=1 --memory=1g): p95 40 rows <= 1.5 s,
 * 500 rows <= 10 s, peak memory <= 768 MB. Reported PASS/FAIL; enforced only with PDF_LOAD_ENFORCE=1.
 *
 *   RAB_PDF_LOAD=1 bash C:/rab-ai-wt/setup/heavy-run.sh pdf-tests npx jest -c packages/rab-worker/src/__tests__/pdf-equality/jest.config.ts pdf-render.load
 */
const RUN = process.env.RAB_PDF_LOAD === '1';
const describeIf = RUN ? describe : describe.skip;
jest.setTimeout(2 * 60 * 60_000);

const RENDERS = Number(process.env.PDF_LOAD_RENDERS) || 50;
const ROWS = (process.env.PDF_LOAD_ROWS ?? '5,40,300').split(',').map((n) => Number(n.trim()));
// native-only mode (P5, mode.ts): the default is native alone; asking for chromium there fails loudly (ChromiumRemovedError).
const RENDERER_NAMES = (process.env.PDF_LOAD_RENDERERS ?? (NATIVE_ONLY ? 'native' : 'chromium,native')).split(',').map((n) => n.trim() as RendererName);
const VIA = process.env.PDF_LOAD_VIA === 'bullmq' ? 'bullmq' : 'direct';
const POOL = bullmqWorkerOptionsOf(CONSUMER_QUEUES.shiftStatements.name).concurrency;
const THRESHOLD_P95_MS: Record<number, number> = { 40: 1500, 500: 10_000 };
const THRESHOLD_PEAK_MB = 768;

interface TierResult {
  renderer: RendererName;
  rows: number;
  via: string;
  pool: number;
  renders: number;
  failures: number;
  nonDeterministic: number;
  serialMs: number;
  renderMs: { p50: number; p95: number; max: number };
  latencyP95Ms: number;
  wallMs: number;
  pages: number;
  bytes: number;
  resources: ResourceSummary;
  thresholds: string[];
}

async function runDirect(render: () => Promise<Buffer>, onDone: (ms: number, pdf: Buffer | Error, latencyMs: number) => void): Promise<void> {
  const submitted = Date.now();
  let next = 0;
  await Promise.all(
    Array.from({ length: POOL }, async () => {
      while (next < RENDERS) {
        next++;
        const t = Date.now();
        const out = await render().catch((e: Error) => e);
        onDone(Date.now() - t, out, Date.now() - submitted);
      }
    }),
  );
}

async function runBullmq(render: () => Promise<Buffer>, onDone: (ms: number, pdf: Buffer | Error, latencyMs: number) => void): Promise<void> {
  const url = process.env.PDF_LOAD_REDIS_URL;
  if (!url) throw new Error('PDF_LOAD_VIA=bullmq needs PDF_LOAD_REDIS_URL (a DISPOSABLE Redis, never a shared one)');
  const prefix = `pdf-load-${Date.now()}`;
  const connection = new Redis(url, { maxRetriesPerRequest: null });
  const def = CONSUMER_QUEUES.shiftStatements;
  const queue = new Queue(def.name, { connection, prefix });
  const submitted = Date.now();
  let done = 0;
  let resolveAll!: () => void;
  const all = new Promise<void>((r) => (resolveAll = r));
  const handler = async () => {
    const t = Date.now();
    const out = await render().catch((e: Error) => e);
    onDone(Date.now() - t, out, Date.now() - submitted);
    if (++done === RENDERS) resolveAll();
    if (out instanceof Error) throw out;
    return 'rendered';
  };
  const worker = new Worker(def.name, createConsumerJobProcessor(def, handler, new Logger('PdfLoad')), { connection, prefix, ...bullmqWorkerOptionsOf(def.name) });
  try {
    await queue.addBulk(Array.from({ length: RENDERS }, (_, i) => ({ name: def.jobName, data: { i }, opts: { attempts: 1, removeOnComplete: true, removeOnFail: true } })));
    await all;
  } finally {
    await worker.close();
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close();
    connection.disconnect();
  }
}

describeIf('PDF render load test', () => {
  const results: TierResult[] = [];
  let fixtures: Map<string, FixtureDocument>;

  beforeAll(async () => {
    fixtures = new Map((await buildFixtures({ scenarios: ROWS.map((n) => `rows-${n}`), kinds: ['final-timesheet'] })).map((f) => [f.scenario, f]));
  });

  afterAll(() => {
    const out = outDir('load');
    saveArtifact(out, 'results', 'json', JSON.stringify({ via: VIA, pool: POOL, renders: RENDERS, host: process.platform, node: process.version, results }, null, 2));
    const table = results.map(
      (r) =>
        `${r.renderer.padEnd(8)} rows ${String(r.rows).padStart(3)}  ${r.renders}× pool ${r.pool} via ${r.via}: render p50 ${r.renderMs.p50} ms, p95 ${r.renderMs.p95} ms, max ${r.renderMs.max} ms; ` +
        `latency p95 ${r.latencyP95Ms} ms; wall ${r.wallMs} ms; failures ${r.failures}; non-deterministic ${r.nonDeterministic}; ` +
        `peak tree ${r.resources.peakTreeRssMb} MB (node ${r.resources.peakNodeRssMb} MB, ${r.resources.peakProcesses} procs); ` +
        `CPU node ${r.resources.nodeCpuSeconds} s + children ${r.resources.childCpuSeconds} s${r.resources.childCpuIsLowerBound ? ' (lower bound)' : ''}; ` +
        `${r.pages} page(s), ${r.bytes} bytes; thresholds: ${r.thresholds.join(', ') || 'n/a'}`,
    );
    saveArtifact(out, 'results', 'txt', table.join('\n'));
    // eslint-disable-next-line no-console
    console.log(`PDF load results (${process.platform}, ${process.version})\n${table.join('\n')}`);
  });

  it('the pool equals the registry concurrency of the rab-shift-statements consumer and the approved pool of 2', () => {
    expect(POOL).toBe(2);
  });

  for (const name of RENDERER_NAMES) {
    for (const rows of ROWS) {
      it(`${name}: ${RENDERS} renders of a ${rows}-row final timesheet, pool ${POOL}, via ${VIA}`, async () => {
        const r: Renderer | { unavailable: string } = name === 'chromium' ? chromiumRenderer : loadNativeRenderer();
        if ('unavailable' in r) {
          // eslint-disable-next-line no-console
          console.warn(`[pdf-load] ${name} skipped: ${r.unavailable}`);
          return;
        }
        const f = fixtures.get(`rows-${rows}`)!;
        const t0 = Date.now();
        const serial = await r.render(f.doc);
        const serialMs = Date.now() - t0;
        const reference = normalisedPdfBytes(serial);
        const times: number[] = [];
        const latencies: number[] = [];
        let failures = 0;
        let nonDeterministic = 0;
        const sampler = new ResourceSampler();
        sampler.start();
        const wall = Date.now();
        const onDone = (ms: number, out: Buffer | Error, latency: number) => {
          times.push(ms);
          latencies.push(latency);
          if (out instanceof Error) failures++;
          else if (normalisedPdfBytes(out) !== reference) nonDeterministic++;
        };
        await (VIA === 'bullmq' ? runBullmq(() => r.render(f.doc), onDone) : runDirect(() => r.render(f.doc), onDone));
        const wallMs = Date.now() - wall;
        const resources = await sampler.stop();
        times.sort((a, b) => a - b);
        latencies.sort((a, b) => a - b);
        const p95 = percentile(times, 95);
        const thresholds: string[] = [];
        if (THRESHOLD_P95_MS[rows]) thresholds.push(`p95 ${p95} <= ${THRESHOLD_P95_MS[rows]} ms: ${p95 <= THRESHOLD_P95_MS[rows]! ? 'PASS' : 'FAIL'}`);
        thresholds.push(`peak ${resources.peakTreeRssMb} <= ${THRESHOLD_PEAK_MB} MB: ${resources.peakTreeRssMb <= THRESHOLD_PEAK_MB ? 'PASS' : 'FAIL'}`);
        const x = extractFixture(f, serial);
        results.push({
          renderer: name,
          rows,
          via: VIA,
          pool: POOL,
          renders: RENDERS,
          failures,
          nonDeterministic,
          serialMs,
          renderMs: { p50: percentile(times, 50), p95, max: times[times.length - 1]! },
          latencyP95Ms: percentile(latencies, 95),
          wallMs,
          pages: x.pageCount,
          bytes: serial.length,
          resources,
          thresholds,
        });
        expect(times).toHaveLength(RENDERS);
        expect(failures).toBe(0);
        expect(nonDeterministic).toBe(0);
        if (process.env.PDF_LOAD_ENFORCE === '1') expect(thresholds.filter((t) => t.endsWith('FAIL'))).toEqual([]);
      });
    }
  }
});
