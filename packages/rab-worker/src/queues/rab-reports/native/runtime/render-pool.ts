import { existsSync } from 'fs';
import { join } from 'path';
import { performance } from 'perf_hooks';
import { Worker } from 'worker_threads';

import {
  PDF_RENDER_STEP_TIMEOUT_MS,
  PdfRenderTimeoutError,
} from '../../render-pdf.util';

import {
  assertPlainViewModel,
  deserializeRenderError,
  FromThreadMessage,
  NativeRenderRequest,
  PdfNativeInputError,
  PdfNativeRenderError,
  PdfNativeThreadCrashError,
  PdfRenderPoolClosedError,
  PdfRenderPoolSaturatedError,
  RenderJobMessage,
  RenderThreadData,
  RenderTimings,
  ThreadProbeReport,
} from './render-protocol';

/**
 * Native PDF render pool (PDF renderer migration P1, plan §4.2, trade-off T1 accepted by the owner).
 *
 * react-pdf lays out synchronously and its paginator is superlinear in table length (MEASURED: 500 rows in one table
 * took 17.6 s). Run in the jobs process's own event loop, one long render would stall BullMQ lock renewal and the email
 * poll, and no timer could interrupt it. So every native render runs in a `worker_threads` thread:
 *
 *  - SIZE: `PDF_NATIVE_CONCURRENCY`, default 2 (the Worker's `cpus: 2` and the statement consumer's concurrency), an
 *    integer from 1 to 4; anything else refuses (fail closed). Requests beyond the size wait in a FIFO queue of at most
 *    `maxQueue`; a full queue refuses the render rather than buffering without bound.
 *  - DEADLINE: 30 s per render (`PDF_RENDER_STEP_TIMEOUT_MS`, the same bound the Chromium path had), enforced by
 *    `worker.terminate()`: a hung layout cannot outlive it. The caller gets `PdfRenderTimeoutError('native-render')`;
 *    the slot is refilled by a fresh thread on the next request.
 *  - MEMORY: `resourceLimits.maxOldGenerationSizeMb` (default 512) per thread. Exceeding it kills only that thread
 *    (`PdfNativeThreadCrashError`, code `error_PDF_NATIVE_OUT_OF_MEMORY`); the jobs process and the other thread live on.
 *  - NO CREDENTIALS: `env: {}`. The thread's `process.env` is an empty object, so no DATABASE_URL, REDIS_URL,
 *    APP_SECRET, S3 or SMTP value can reach the code that parses fonts, images and text. No `SHARE_ENV`, no stdin, no
 *    inherited execArgv.
 *  - NO NETWORK / NO PROCESSES / NO CLOCK: `thread-guard.ts`, installed before anything else in the thread.
 *  - NO STATE BETWEEN TENANTS: the thread receives one plain view-model per message, holds no DB handle or tenant
 *    context, and is recycled after `maxRendersPerThread` renders and after `idleMs` without work.
 *
 * The layouts (react-pdf components) run INSIDE the thread: the jobs process sends `{ kind, viewModel, generatedAt }`
 * and gets the PDF bytes back. The thread finds the layout in the document registry module (`native-documents`).
 */

export const PDF_NATIVE_POOL_SIZE_DEFAULT = 2;
export const PDF_NATIVE_POOL_SIZE_MAX = 4;
export const PDF_NATIVE_HEAP_LIMIT_MB_DEFAULT = 512;
export const PDF_NATIVE_QUEUE_MAX_DEFAULT = 256;
export const PDF_NATIVE_RENDERS_PER_THREAD_DEFAULT = 200;
export const PDF_NATIVE_IDLE_MS_DEFAULT = 60_000;

/** Default document registry: `native/native-documents` (owned by the documents agent; exports NATIVE_DOCUMENT_REGISTRY). */
export const DEFAULT_DOCUMENTS_MODULE = join(
  __dirname,
  '..',
  'native-documents',
);

/**
 * `PDF_NATIVE_CONCURRENCY`: unset → 2; exactly one of "1".."4" → that size; anything else (empty, spaces, "0", "5",
 * "2.0", "two") throws. The Worker's EnvironmentVariables validation applies the same rule at boot.
 */
export function pdfNativeConcurrency(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.PDF_NATIVE_CONCURRENCY;
  if (raw === undefined) return PDF_NATIVE_POOL_SIZE_DEFAULT;
  if (/^[1-4]$/.test(raw)) return Number(raw);
  throw new Error(
    `PDF_NATIVE_CONCURRENCY must be an integer from 1 to ${PDF_NATIVE_POOL_SIZE_MAX}`,
  );
}

export interface NativeRenderPoolOptions {
  /** Threads, 1..4. Default 2. */
  size?: number;
  /** Per-render deadline in ms, 100..30 000 (never above the 30 s production bound). Default 30 000. */
  timeoutMs?: number;
  /** Per-thread V8 old-space cap in MB, 32..2048. Default 512. */
  maxOldGenerationSizeMb?: number;
  /** Waiting requests beyond the running ones, 1..10 000. Default 256. */
  maxQueue?: number;
  /** A thread is replaced after this many renders, 1..10 000. Default 200. */
  maxRendersPerThread?: number;
  /** An idle thread is ended after this many ms, 1 000..3 600 000. Default 60 000. */
  idleMs?: number;
  /** Absolute path of the document registry module. Default `native/native-documents`. */
  documentsModule?: string;
  /** Tests only: threads answer `probe()` (env keys, guard report, heap). Production threads never do. */
  allowProbe?: boolean;
  /** Tests only: called with the submission sequence number of each request as it is handed to a thread. */
  onDispatch?: (submissionSeq: number) => void;
}

export interface NativeRenderResult {
  pdf: Buffer;
  timings: RenderTimings & { queueMs: number; totalMs: number };
}

export interface NativeRenderPoolStats {
  size: number;
  live: number;
  starting: number;
  busy: number;
  idle: number;
  queued: number;
  spawned: number;
  exited: number;
  completed: number;
  failed: number;
  timedOut: number;
  crashed: number;
}

interface Job {
  seq: number;
  message: RenderJobMessage;
  submittedAt: number;
  dispatchedAt?: number;
  timer?: NodeJS.Timeout;
  resolve: (r: NativeRenderResult) => void;
  reject: (e: Error) => void;
}

interface Slot {
  worker: Worker;
  state: 'starting' | 'idle' | 'busy' | 'gone';
  job?: Job;
  renders: number;
  startTimer?: NodeJS.Timeout;
  idleTimer?: NodeJS.Timeout;
  probes: Map<number, (r: ThreadProbeReport) => void>;
}

function bounded(
  name: string,
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max)
    throw new RangeError(
      `native PDF render pool: ${name} must be an integer from ${min} to ${max}`,
    );
  return value;
}

const KIND = /^[a-z0-9][a-z0-9-]{0,63}$/;

function generatedAtMs(value: unknown): number {
  const ms =
    value instanceof Date
      ? value.getTime()
      : typeof value === 'string'
        ? Date.parse(value)
        : NaN;
  if (!Number.isFinite(ms))
    throw new PdfNativeInputError(
      'native PDF renderer: generatedAt must be a valid ISO-8601 timestamp or Date',
    );
  return ms;
}

/** How a thread is started: the compiled entry in `dist`, or (source tree, Jest / ts-node dev only) the .ts entry. */
function threadEntry(): { filename: string; eval: boolean } {
  const js = join(__dirname, 'render-thread.js');
  if (existsSync(js)) return { filename: js, eval: false };
  const ts = join(__dirname, 'render-thread.ts');
  if (!existsSync(ts))
    throw new Error('native PDF render pool: render-thread entry not found');
  // Never reached in an image (dist has render-thread.js; ts-node is not installed there). ts-node is configured in
  // code, not through TS_NODE_* variables, because the thread's environment is empty.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const tsNode = require.resolve('ts-node');
  const project = join(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    '..',
    'tsconfig.json',
  );
  // ts-node's v8-compile-cache would write a cache under "$TMPDIR" — "undefined/temp" with an empty env — so it is
  // switched off for the duration of the register call and the variable removed again (the env stays empty).
  const code =
    `process.env.DISABLE_V8_COMPILE_CACHE = '1';\n` +
    `require(${JSON.stringify(tsNode)}).register({ transpileOnly: true, project: ${JSON.stringify(project)}, ` +
    `compilerOptions: { module: 'commonjs', moduleResolution: 'node' } });\n` +
    `delete process.env.DISABLE_V8_COMPILE_CACHE;\n` +
    `require(${JSON.stringify(ts)});\n`;
  return { filename: code, eval: true };
}

export class NativeRenderPool {
  readonly size: number;
  readonly timeoutMs: number;
  readonly maxOldGenerationSizeMb: number;
  readonly maxQueue: number;
  readonly maxRendersPerThread: number;
  readonly idleMs: number;
  private readonly documentsModule: string;
  private readonly allowProbe: boolean;
  private readonly onDispatch?: (seq: number) => void;

  private readonly slots = new Set<Slot>();
  private readonly queue: Job[] = [];
  private closed = false;
  private seq = 0;
  private nextId = 1;
  private counters = {
    spawned: 0,
    exited: 0,
    completed: 0,
    failed: 0,
    timedOut: 0,
    crashed: 0,
  };

  constructor(options: NativeRenderPoolOptions = {}) {
    this.size = bounded(
      'size',
      options.size,
      PDF_NATIVE_POOL_SIZE_DEFAULT,
      1,
      PDF_NATIVE_POOL_SIZE_MAX,
    );
    this.timeoutMs = bounded(
      'timeoutMs',
      options.timeoutMs,
      PDF_RENDER_STEP_TIMEOUT_MS,
      100,
      PDF_RENDER_STEP_TIMEOUT_MS,
    );
    this.maxOldGenerationSizeMb = bounded(
      'maxOldGenerationSizeMb',
      options.maxOldGenerationSizeMb,
      PDF_NATIVE_HEAP_LIMIT_MB_DEFAULT,
      32,
      2048,
    );
    this.maxQueue = bounded(
      'maxQueue',
      options.maxQueue,
      PDF_NATIVE_QUEUE_MAX_DEFAULT,
      1,
      10_000,
    );
    this.maxRendersPerThread = bounded(
      'maxRendersPerThread',
      options.maxRendersPerThread,
      PDF_NATIVE_RENDERS_PER_THREAD_DEFAULT,
      1,
      10_000,
    );
    this.idleMs = bounded(
      'idleMs',
      options.idleMs,
      PDF_NATIVE_IDLE_MS_DEFAULT,
      1_000,
      3_600_000,
    );
    this.documentsModule = options.documentsModule ?? DEFAULT_DOCUMENTS_MODULE;
    this.allowProbe = options.allowProbe === true;
    this.onDispatch = options.onDispatch;
  }

  /** Renders one document in a pool thread. Resolves to the PDF bytes (`%PDF-…`). */
  async render(request: NativeRenderRequest): Promise<Buffer> {
    return (await this.renderWithTimings(request)).pdf;
  }

  /** As `render`, plus where the time went (queue wait, glyph check, layout + serialisation). */
  renderWithTimings(request: NativeRenderRequest): Promise<NativeRenderResult> {
    if (this.closed) return Promise.reject(new PdfRenderPoolClosedError());
    let message: RenderJobMessage;
    try {
      if (typeof request?.kind !== 'string' || !KIND.test(request.kind))
        throw new PdfNativeInputError(
          'native PDF renderer: kind must be a lowercase document type',
        );
      assertPlainViewModel(request.viewModel);
      message = {
        type: 'render',
        id: this.nextId++,
        kind: request.kind,
        viewModel: request.viewModel,
        generatedAtMs: generatedAtMs(request.generatedAt),
      };
    } catch (err) {
      return Promise.reject(err);
    }
    if (this.queue.length >= this.maxQueue)
      return Promise.reject(new PdfRenderPoolSaturatedError(this.maxQueue));
    return new Promise<NativeRenderResult>((resolve, reject) => {
      this.queue.push({
        seq: this.seq++,
        message,
        submittedAt: performance.now(),
        resolve,
        reject,
      });
      this.pump();
    });
  }

  stats(): NativeRenderPoolStats {
    const by = (s: Slot['state']) =>
      [...this.slots].filter((x) => x.state === s).length;
    return {
      size: this.size,
      live: this.slots.size,
      starting: by('starting'),
      busy: by('busy'),
      idle: by('idle'),
      queued: this.queue.length,
      ...this.counters,
    };
  }

  /** Tests only (`allowProbe`): asks an idle thread (spawning one if needed) for its environment and guard report. */
  async probe(): Promise<ThreadProbeReport> {
    if (!this.allowProbe)
      throw new Error('native PDF render pool: probe() needs allowProbe');
    let slot = [...this.slots].find(
      (s) => s.state === 'idle' || s.state === 'busy',
    );
    if (!slot) {
      slot = this.spawn();
      await new Promise<void>((resolve, reject) => {
        const check = setInterval(() => {
          if (slot!.state === 'gone') {
            clearInterval(check);
            reject(new Error('render thread failed to start'));
          } else if (slot!.state !== 'starting') {
            clearInterval(check);
            resolve();
          }
        }, 5);
      });
    }
    const id = this.nextId++;
    const s = slot;
    s.worker.ref(); // keep the process alive while the answer is outstanding (idle threads are unref'd)
    return new Promise<ThreadProbeReport>((resolve) => {
      s.probes.set(id, (report) => {
        if (s.state !== 'busy') s.worker.unref();
        resolve(report);
      });
      s.worker.postMessage({ type: 'probe', id });
    });
  }

  /** Refuses new and queued work, terminates every thread, resolves when all have exited. */
  async destroy(): Promise<void> {
    this.closed = true;
    for (const job of this.queue.splice(0))
      job.reject(new PdfRenderPoolClosedError());
    const exits = [...this.slots].map((slot) =>
      this.retire(slot, new PdfRenderPoolClosedError()),
    );
    await Promise.all(exits);
  }

  // ─── internals ──────────────────────────────────────────────────────────────────────────────────────────────────────

  private pump(): void {
    while (this.queue.length > 0 && !this.closed) {
      const idle = [...this.slots].find((s) => s.state === 'idle');
      if (idle) {
        this.dispatch(idle, this.queue.shift()!);
        continue;
      }
      const starting = [...this.slots].filter(
        (s) => s.state === 'starting',
      ).length;
      // Spawn only as many threads as there are queued requests not already covered by a starting thread.
      if (this.slots.size < this.size && starting < this.queue.length) {
        this.spawn();
        continue;
      }
      break;
    }
  }

  private spawn(): Slot {
    const entry = threadEntry();
    const data: RenderThreadData = {
      documentsModule: this.documentsModule,
      allowProbe: this.allowProbe,
    };
    const worker = new Worker(entry.filename, {
      eval: entry.eval,
      env: {}, // T1: the render thread never sees the jobs process's credentials
      workerData: data,
      execArgv: [],
      argv: [],
      stdin: false,
      resourceLimits: {
        maxOldGenerationSizeMb: this.maxOldGenerationSizeMb,
        stackSizeMb: 4,
      },
      name: 'native-pdf-render',
    });
    this.counters.spawned += 1;
    const slot: Slot = {
      worker,
      state: 'starting',
      renders: 0,
      probes: new Map(),
    };
    this.slots.add(slot);

    // A thread that cannot even start within the render deadline is ended, never waited on forever.
    slot.startTimer = setTimeout(() => {
      if (slot.state !== 'starting') return;
      const head = this.queue.shift();
      head?.reject(
        new PdfRenderTimeoutError('native-thread-start', this.timeoutMs),
      );
      this.counters.timedOut += head ? 1 : 0;
      void this.retire(slot);
      this.pump();
    }, this.timeoutMs);

    worker.on('message', (msg: FromThreadMessage) => this.onMessage(slot, msg));
    worker.on('error', (err: Error & { code?: string }) =>
      this.onCrash(slot, err.code ?? 'ERR_RENDER_THREAD', err.message),
    );
    worker.on('messageerror', () =>
      this.onCrash(
        slot,
        'ERR_RENDER_THREAD_MESSAGE',
        'unreadable message from render thread',
      ),
    );
    worker.on('exit', (code) => {
      this.counters.exited += 1;
      if (slot.state !== 'gone')
        this.onCrash(
          slot,
          'ERR_RENDER_THREAD_EXIT',
          `render thread exited (code ${code})`,
        );
    });
    return slot;
  }

  private onMessage(slot: Slot, msg: FromThreadMessage): void {
    if (slot.state === 'gone') return;
    switch (msg.type) {
      case 'ready':
        clearTimeout(slot.startTimer);
        slot.state = 'idle';
        this.markIdle(slot);
        this.pump();
        return;
      case 'init-error': {
        // e.g. a vendored font altered or missing: every render would fail the same way, so refuse what is queued.
        clearTimeout(slot.startTimer);
        const err = deserializeRenderError(msg.error);
        for (const job of this.queue.splice(0)) {
          this.counters.failed += 1;
          job.reject(err);
        }
        void this.retire(slot);
        return;
      }
      case 'probe-result':
        slot.probes.get(msg.id)?.(msg.report);
        slot.probes.delete(msg.id);
        return;
      case 'result': {
        const job = slot.job;
        if (!job || job.message.id !== msg.id) return;
        clearTimeout(job.timer);
        slot.job = undefined;
        slot.renders += 1;
        if (msg.ok) {
          const pdf = Buffer.from(msg.pdf);
          if (pdf.subarray(0, 5).toString('latin1') !== '%PDF-') {
            this.counters.failed += 1;
            job.reject(
              new PdfNativeRenderError(
                'native PDF renderer: output is not a PDF',
              ),
            );
          } else {
            this.counters.completed += 1;
            const now = performance.now();
            job.resolve({
              pdf,
              timings: {
                ...msg.timings,
                queueMs: (job.dispatchedAt ?? now) - job.submittedAt,
                totalMs: now - job.submittedAt,
              },
            });
          }
        } else {
          this.counters.failed += 1;
          job.reject(deserializeRenderError(msg.error));
        }
        if (slot.renders >= this.maxRendersPerThread) void this.retire(slot);
        else this.markIdle(slot);
        this.pump();
        return;
      }
    }
  }

  private dispatch(slot: Slot, job: Job): void {
    clearTimeout(slot.idleTimer);
    slot.state = 'busy';
    slot.job = job;
    slot.worker.ref();
    job.dispatchedAt = performance.now();
    job.timer = setTimeout(() => {
      if (slot.job !== job) return;
      this.counters.timedOut += 1;
      slot.job = undefined;
      job.reject(new PdfRenderTimeoutError('native-render', this.timeoutMs));
      void this.retire(slot);
      this.pump();
    }, this.timeoutMs);
    this.onDispatch?.(job.seq);
    slot.worker.postMessage(job.message);
  }

  private markIdle(slot: Slot): void {
    slot.state = 'idle';
    slot.worker.unref(); // an idle render thread never keeps the jobs process alive
    clearTimeout(slot.idleTimer);
    slot.idleTimer = setTimeout(() => {
      if (slot.state === 'idle') void this.retire(slot);
    }, this.idleMs);
    slot.idleTimer.unref();
  }

  private onCrash(slot: Slot, code: string, detail: string): void {
    if (slot.state === 'gone') return;
    this.counters.crashed += 1;
    const job = slot.job;
    slot.job = undefined;
    if (job) {
      clearTimeout(job.timer);
      this.counters.failed += 1;
      job.reject(
        new PdfNativeThreadCrashError(
          `native PDF renderer: render thread failed (${code}): ${detail}`.slice(
            0,
            500,
          ),
          code,
        ),
      );
    }
    void this.retire(slot);
    this.pump();
  }

  /** Removes the slot, rejects its in-flight job if any, and terminates the thread. Resolves once it has exited. */
  private retire(slot: Slot, reason?: Error): Promise<void> {
    if (slot.state === 'gone') return Promise.resolve();
    slot.state = 'gone';
    clearTimeout(slot.startTimer);
    clearTimeout(slot.idleTimer);
    this.slots.delete(slot);
    if (slot.job) {
      clearTimeout(slot.job.timer);
      slot.job.reject(reason ?? new PdfRenderPoolClosedError());
      slot.job = undefined;
    }
    return slot.worker.terminate().then(
      () => undefined,
      () => undefined,
    );
  }
}

// ─── the process-wide pool used by the renderer switch ────────────────────────────────────────────────────────────────

let defaultPool: NativeRenderPool | undefined;

/**
 * THE entry point for `renderReportPdf` / `renderNativePdf` in native mode: renders `{ kind, viewModel, generatedAt }`
 * in the process-wide pool (created on first use with `PDF_NATIVE_CONCURRENCY` threads) and resolves to the PDF bytes.
 *
 * Rejects with:
 *  - `PdfRenderTimeoutError` (step `native-render`, 30 s): the thread was terminated;
 *  - `PdfGlyphCoverageError` (`error_PDF_GLYPH_UNSUPPORTED`, `.field`): a character no embedded font can draw (D3);
 *  - `PdfNativeThreadCrashError` (`error_PDF_NATIVE_OUT_OF_MEMORY` / `error_PDF_NATIVE_THREAD_CRASH`);
 *  - `PdfNativeInputError`: not plain data, unknown kind, bad generatedAt;
 *  - `PdfRenderPoolSaturatedError` / `PdfRenderPoolClosedError`; `PdfNativeRenderError` for anything else.
 * No fallback to Chromium (T3): every failure propagates to the job's normal failure and retry path.
 */
export function renderInPool(request: NativeRenderRequest): Promise<Buffer> {
  defaultPool ??= new NativeRenderPool({
    size: pdfNativeConcurrency(process.env),
  });
  return defaultPool.render(request);
}

/** Graceful shutdown of the process-wide pool (Worker shutdown hook, tests). Safe to call when none exists. */
export async function shutdownRenderPool(): Promise<void> {
  const pool = defaultPool;
  defaultPool = undefined;
  await pool?.destroy();
}
