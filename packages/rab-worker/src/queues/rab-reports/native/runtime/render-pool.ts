import { existsSync } from 'fs';
import { join } from 'path';
import { performance } from 'perf_hooks';
import { Worker } from 'worker_threads';

import { Logger } from '@nestjs/common';

import {
  assertPdfNativeMemoryFits,
  parsePdfNativeMemoryBudgetMb,
  PDF_NATIVE_HEAP_LIMIT_MB,
} from '@rab/server/engine/worker-shared/pdf-native-memory.contract';

import {
  PDF_RENDER_STEP_TIMEOUT_MS,
  PdfRenderTimeoutError,
} from './render-timeout';

import {
  assertPlainViewModel,
  deserializeRenderError,
  FromThreadMessage,
  GlyphSubstitutionCount,
  NativeRenderRequest,
  PdfNativeInputError,
  PdfNativeRenderError,
  PdfNativeThreadCrashError,
  PdfRenderPoolClosedError,
  PdfRenderPoolSaturatedError,
  RenderJobMessage,
  RenderThreadData,
  RenderTimings,
  ThreadInitBreakdown,
  ThreadProbeReport,
} from './render-protocol';

/**
 * Native PDF render pool (PDF renderer migration P1, plan §4.2, trade-off T1 accepted by the owner; F1/F3 of §15).
 *
 * react-pdf lays out synchronously and its paginator is superlinear in table length (MEASURED: 500 rows in one table
 * took 17.6 s). Run in the jobs process's own event loop, one long render would stall BullMQ lock renewal and the email
 * poll, and no timer could interrupt it. So every native render runs in a `worker_threads` thread:
 *
 *  - SIZE: `PDF_NATIVE_CONCURRENCY`, default 2 (the Worker's `cpus: 2` and the statement consumer's concurrency), an
 *    integer from 1 to 4; anything else refuses (fail closed). Requests beyond the size wait in a FIFO queue of at most
 *    `maxQueue`; a full queue refuses the render rather than buffering without bound.
 *  - DEADLINE: 30 s per render (`PDF_RENDER_STEP_TIMEOUT_MS`, the same bound the Chromium path had), enforced by
 *    `worker.terminate()`: a hung layout cannot outlive it. The caller gets `PdfRenderTimeoutError('native-render')`.
 *  - MEMORY: `resourceLimits.maxOldGenerationSizeMb` (default 384) per thread. Exceeding it kills only that thread
 *    (`PdfNativeThreadCrashError`, code `error_PDF_NATIVE_OUT_OF_MEMORY`); the jobs process and the other thread live on.
 *    The process-wide pool refuses to exist unless size × 384 MB ≤ `PDF_NATIVE_MEMORY_BUDGET_MB` (default 768, half of
 *    the Worker's 1536m mem_limit; review M-3, `pdfNativeMemoryPlan`), so the threads together can never outgrow the
 *    container and get the whole Worker OOM-killed.
 *  - NO CREDENTIALS: `env: {}`. The thread's `process.env` is an empty object, so no DATABASE_URL, REDIS_URL,
 *    APP_SECRET, S3 or SMTP value can reach the code that parses fonts, images and text. No `SHARE_ENV`, no stdin, no
 *    inherited execArgv.
 *  - NO NETWORK / NO PROCESSES / NO CLOCK: `thread-guard.ts`, installed before anything else in the thread.
 *  - NO STATE BETWEEN TENANTS: the thread receives one plain view-model per message, holds no DB handle or tenant
 *    context, and is recycled after `maxRendersPerThread` renders and after `idleMs` without work (above `minThreads`).
 *  - PRE-WARM (F3): `prewarm(n)` / `prewarmRenderPool()` starts `n` threads in the background and keeps at least `n`
 *    alive (replacing recycled, timed-out or crashed ones), so a render rarely pays the thread start. Nothing ever
 *    waits on it: it returns immediately, and its failures are logged, never thrown.
 *  - UNPRINTABLE CHARACTERS (F1): replaced in the thread by a visible marker; the pool logs, per render, the document
 *    kind and per-field COUNTS only (never text, characters or code points).
 *
 * The layouts (react-pdf components) run INSIDE the thread: the jobs process sends `{ kind, viewModel, generatedAt }`
 * and gets the PDF bytes back. The thread finds the layout in the document registry module (`native-documents`).
 */

export const PDF_NATIVE_POOL_SIZE_DEFAULT = 2;
export const PDF_NATIVE_POOL_SIZE_MAX = 4;
/** Per-thread old-generation cap (MB): the shared contract's 384 (review M-3; was 512). */
export const PDF_NATIVE_HEAP_LIMIT_MB_DEFAULT = PDF_NATIVE_HEAP_LIMIT_MB;
export const PDF_NATIVE_QUEUE_MAX_DEFAULT = 256;
export const PDF_NATIVE_RENDERS_PER_THREAD_DEFAULT = 200;
export const PDF_NATIVE_IDLE_MS_DEFAULT = 60_000;
export const PDF_NATIVE_PREWARM_DEFAULT = 2;
/** At most this many fields are named in one substitution log line; the total count is always given. */
const MAX_LOGGED_FIELDS = 20;

/** Default document registry: `native/native-documents` (owned by the documents agent; exports NATIVE_DOCUMENT_REGISTRY). */
export const DEFAULT_DOCUMENTS_MODULE = join(
  __dirname,
  '..',
  'native-documents',
);

/**
 * `PDF_NATIVE_CONCURRENCY`: unset or empty → 2; exactly one of "1".."4" → that size; anything else (spaces, "0", "5",
 * "2.0", "two") throws. The same rule as the Worker's boot validation (env.validation.ts), which treats an empty value
 * (`KEY=` in a .env file) as unset for every variable and refuses the rest through EnvironmentVariables.
 */
export function pdfNativeConcurrency(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.PDF_NATIVE_CONCURRENCY;
  if (raw === undefined || raw === '') return PDF_NATIVE_POOL_SIZE_DEFAULT;
  if (/^[1-4]$/.test(raw)) return Number(raw);
  throw new Error(
    `PDF_NATIVE_CONCURRENCY must be an integer from 1 to ${PDF_NATIVE_POOL_SIZE_MAX}`,
  );
}

/**
 * `PDF_NATIVE_PREWARM`: threads started at Worker boot. Unset or empty → min(2, pool size), as boot validation treats an
 * empty value as unset; exactly "0".."4" → that number ("0" = no pre-warm); more than the pool size, or anything else
 * (spaces, "1.0", "two"), throws.
 */
export function pdfNativePrewarm(
  env: NodeJS.ProcessEnv = process.env,
  size = pdfNativeConcurrency(env),
): number {
  const raw = env.PDF_NATIVE_PREWARM;
  if (raw === undefined || raw === '') return Math.min(PDF_NATIVE_PREWARM_DEFAULT, size);
  if (/^[0-4]$/.test(raw) && Number(raw) <= size) return Number(raw);
  throw new Error(
    `PDF_NATIVE_PREWARM must be an integer from 0 to PDF_NATIVE_CONCURRENCY (${size})`,
  );
}

/** What the process-wide pool is created with (review M-3). */
export interface PdfNativeMemoryPlan {
  size: number;
  heapLimitMb: number;
  budgetMb: number;
}

/**
 * The process-wide pool's size and per-thread heap cap, checked against `PDF_NATIVE_MEMORY_BUDGET_MB` (unset or empty →
 * 768; strict integer 384..16384): throws `PdfNativeMemoryBudgetError` when size × 384 MB exceeds the budget, or for an
 * invalid budget / concurrency. The same rule as boot validation (env.validation.ts, one shared contract); the Worker
 * calls it at boot (native mode) and the pool again before it creates any thread — fail closed both times.
 */
export function pdfNativeMemoryPlan(
  env: NodeJS.ProcessEnv = process.env,
): PdfNativeMemoryPlan {
  const size = pdfNativeConcurrency(env);
  const budgetMb = parsePdfNativeMemoryBudgetMb(env.PDF_NATIVE_MEMORY_BUDGET_MB);
  assertPdfNativeMemoryFits(size, budgetMb);
  return { size, heapLimitMb: PDF_NATIVE_HEAP_LIMIT_MB_DEFAULT, budgetMb };
}

/** The logging surface the pool uses (Nest's Logger by default). */
export interface RenderPoolLogger {
  log(message: string): void;
  warn(message: string): void;
}

export interface NativeRenderPoolOptions {
  /** Threads, 1..4. Default 2. */
  size?: number;
  /** Per-render deadline in ms, 100..30 000 (never above the 30 s production bound). Default 30 000. */
  timeoutMs?: number;
  /** Deadline for a thread to become ready, 1 000..30 000 ms. Default 30 000 (independent of the render deadline). */
  startTimeoutMs?: number;
  /** Per-thread V8 old-space cap in MB, 32..2048. Default 384 (the process-wide pool always uses the default). */
  maxOldGenerationSizeMb?: number;
  /** Waiting requests beyond the running ones, 1..10 000. Default 256. */
  maxQueue?: number;
  /** A thread is replaced after this many renders, 1..10 000. Default 200. */
  maxRendersPerThread?: number;
  /** An idle thread above `minThreads` is ended after this many ms, 1 000..3 600 000. Default 60 000. */
  idleMs?: number;
  /** Absolute path of the document registry module. Default `native/native-documents`. */
  documentsModule?: string;
  /** Where substitution counts and thread start-up times are logged. Default: Nest `Logger('NativePdfRender')`. */
  logger?: RenderPoolLogger;
  /** Tests only: threads answer `probe()` (env keys, guard report, heap). Production threads never do. */
  allowProbe?: boolean;
  /** Tests only: called with the submission sequence number of each request as it is handed to a thread. */
  onDispatch?: (submissionSeq: number) => void;
}

export interface NativeRenderResult {
  pdf: Buffer;
  timings: RenderTimings & { queueMs: number; totalMs: number };
  /** F1: fields whose unprintable characters were replaced by the marker, with counts. Empty when none. */
  substitutions: GlyphSubstitutionCount[];
}

export interface NativeRenderPoolStats {
  size: number;
  minThreads: number;
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
  /** Start-up of the most recent thread that became ready: total and per step (F3). */
  lastThreadStart?: ThreadInitBreakdown & {
    initMs: number;
    spawnToReadyMs: number;
  };
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
  spawnedAt: number;
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
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(
      `native PDF render pool: ${name} must be an integer from ${min} to ${max}`,
    );
  }
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
  readonly startTimeoutMs: number;
  readonly maxOldGenerationSizeMb: number;
  readonly maxQueue: number;
  readonly maxRendersPerThread: number;
  readonly idleMs: number;
  private readonly documentsModule: string;
  private readonly allowProbe: boolean;
  private readonly onDispatch?: (seq: number) => void;
  private readonly logger: RenderPoolLogger;

  private readonly slots = new Set<Slot>();
  private readonly queue: Job[] = [];
  private closed = false;
  private minThreads = 0;
  /** Set when a thread failed to start: eager (pre-warm) respawns stop until a request asks for a thread again. */
  private startFailed = false;
  private seq = 0;
  private nextId = 1;
  private lastThreadStart?: NativeRenderPoolStats['lastThreadStart'];
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
    this.startTimeoutMs = bounded(
      'startTimeoutMs',
      options.startTimeoutMs,
      PDF_RENDER_STEP_TIMEOUT_MS,
      1_000,
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
    this.logger = options.logger ?? new Logger('NativePdfRender');
  }

  /** Renders one document in a pool thread. Resolves to the PDF bytes (`%PDF-…`). */
  async render(request: NativeRenderRequest): Promise<Buffer> {
    return (await this.renderWithTimings(request)).pdf;
  }

  /** As `render`, plus where the time went (queue wait, glyph pass, layout + serialisation) and substitution counts. */
  renderWithTimings(request: NativeRenderRequest): Promise<NativeRenderResult> {
    if (this.closed) return Promise.reject(new PdfRenderPoolClosedError());
    let message: RenderJobMessage;
    try {
      if (typeof request?.kind !== 'string' || !KIND.test(request.kind)) {
        throw new PdfNativeInputError(
          'native PDF renderer: kind must be a lowercase document type',
        );
      }
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
    this.startFailed = false; // a real request may always try to start a thread
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

  /**
   * F3: starts up to `threads` render threads in the background and keeps at least that many alive from now on.
   * Returns at once (never awaits a thread); a thread that fails to start is logged and not retried until a render
   * request arrives. `threads` is clamped to the pool size.
   */
  prewarm(
    threads: number = Math.min(PDF_NATIVE_PREWARM_DEFAULT, this.size),
  ): void {
    if (!Number.isInteger(threads) || threads < 0)
      throw new RangeError(
        'native PDF render pool: prewarm threads must be a non-negative integer',
      );
    if (this.closed) return;
    this.minThreads = Math.min(threads, this.size);
    this.ensureMinThreads();
  }

  stats(): NativeRenderPoolStats {
    const by = (s: Slot['state']) =>
      [...this.slots].filter((x) => x.state === s).length;
    return {
      size: this.size,
      minThreads: this.minThreads,
      live: this.slots.size,
      starting: by('starting'),
      busy: by('busy'),
      idle: by('idle'),
      queued: this.queue.length,
      ...this.counters,
      ...(this.lastThreadStart
        ? { lastThreadStart: this.lastThreadStart }
        : {}),
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
      slot =
        [...this.slots].find((s) => s.state === 'starting') ?? this.spawn();
      const s0 = slot;
      await new Promise<void>((resolve, reject) => {
        const check = setInterval(() => {
          if (s0.state === 'gone') {
            clearInterval(check);
            reject(new Error('render thread failed to start'));
          } else if (s0.state !== 'starting') {
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
    this.minThreads = 0;
    for (const job of this.queue.splice(0))
      job.reject(new PdfRenderPoolClosedError());
    await Promise.all(
      [...this.slots].map((slot) =>
        this.retire(slot, new PdfRenderPoolClosedError()),
      ),
    );
  }

  // ─── internals ──────────────────────────────────────────────────────────────────────────────────────────────────────

  private pump(): void {
    // A queued request waits on starting threads: those must keep the process alive (pre-warm threads start unref'd).
    if (this.queue.length > 0)
      for (const s of this.slots) if (s.state === 'starting') s.worker.ref();
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
    if (this.queue.length > 0)
      for (const s of this.slots) if (s.state === 'starting') s.worker.ref();
    this.ensureMinThreads();
  }

  /** Keeps `minThreads` threads alive (pre-warm), unless the pool is closed or the last start failed. */
  private ensureMinThreads(): void {
    if (this.closed || this.startFailed) return;
    while (this.slots.size < this.minThreads) this.spawn();
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
    worker.unref(); // a pre-warm thread never keeps the process alive; pump() refs it once a request waits on it
    this.counters.spawned += 1;
    const slot: Slot = {
      worker,
      state: 'starting',
      renders: 0,
      spawnedAt: performance.now(),
      probes: new Map(),
    };
    this.slots.add(slot);

    // A thread that cannot even start within the render deadline is ended, never waited on forever.
    slot.startTimer = setTimeout(() => {
      if (slot.state !== 'starting') return;
      const head = this.queue.shift();
      head?.reject(
        new PdfRenderTimeoutError('native-thread-start', this.startTimeoutMs),
      );
      this.counters.timedOut += head ? 1 : 0;
      this.startFailed = true;
      this.logger.warn(
        `native PDF render thread did not start within ${this.startTimeoutMs} ms; terminated`,
      );
      void this.retire(slot);
      this.pump();
    }, this.startTimeoutMs);
    slot.startTimer.unref();

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
      case 'ready': {
        clearTimeout(slot.startTimer);
        const spawnToReadyMs = Math.round(performance.now() - slot.spawnedAt);
        this.lastThreadStart = {
          ...msg.breakdown,
          initMs: Math.round(msg.initMs),
          spawnToReadyMs,
        };
        const b = msg.breakdown;
        this.logger.log(
          `native PDF render thread ready in ${spawnToReadyMs} ms (modules ${b.modulesMs} ms, font files ${b.fontFilesVerifyMs} ms, ` +
            `primary font ${b.primaryFontParseMs} ms, warm-up ${b.warmupRenderMs} ms)`,
        );
        this.markIdle(slot);
        this.pump();
        return;
      }
      case 'init-error': {
        // e.g. a vendored font altered or missing: every render would fail the same way, so refuse what is queued.
        clearTimeout(slot.startTimer);
        const err = deserializeRenderError(msg.error);
        this.startFailed = true;
        this.logger.warn(
          `native PDF render thread failed to start (${err.code}): ${err.message}`,
        );
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
            if (msg.substitutions.length > 0)
              this.logSubstitutions(job.message.kind, msg.substitutions);
            const now = performance.now();
            job.resolve({
              pdf,
              timings: {
                ...msg.timings,
                queueMs: (job.dispatchedAt ?? now) - job.submittedAt,
                totalMs: now - job.submittedAt,
              },
              substitutions: msg.substitutions,
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

  /** F1: counts only — the document kind (a code-defined type), structural field paths and numbers. */
  private logSubstitutions(kind: string, subs: GlyphSubstitutionCount[]): void {
    const total = subs.reduce((n, s) => n + s.count, 0);
    const named = subs
      .slice(0, MAX_LOGGED_FIELDS)
      .map((s) => `${s.field}=${s.count}`)
      .join(', ');
    const more =
      subs.length > MAX_LOGGED_FIELDS
        ? `, +${subs.length - MAX_LOGGED_FIELDS} more field(s)`
        : '';
    this.logger.warn(
      `native PDF render (kind=${kind}): ${total} unprintable character(s) replaced by the visible marker in ${subs.length} field(s): ${named}${more}`,
    );
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
      // Pre-warmed threads (up to minThreads) stay; extra idle threads are ended.
      if (slot.state === 'idle' && this.slots.size > this.minThreads)
        void this.retire(slot);
      else if (slot.state === 'idle') this.markIdle(slot);
    }, this.idleMs);
    slot.idleTimer.unref();
  }

  private onCrash(slot: Slot, code: string, detail: string): void {
    if (slot.state === 'gone') return;
    this.counters.crashed += 1;
    if (slot.state === 'starting') this.startFailed = true;
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
    const exited = slot.worker.terminate().then(
      () => undefined,
      () => undefined,
    );
    // Recycled after maxRendersPerThread, timed out or crashed: keep the pre-warmed minimum (F3).
    queueMicrotask(() => this.ensureMinThreads());
    return exited;
  }
}

// ─── the process-wide pool used by the renderer switch ────────────────────────────────────────────────────────────────

let defaultPool: NativeRenderPool | undefined;

function processPool(): NativeRenderPool {
  if (!defaultPool) {
    const plan = pdfNativeMemoryPlan(process.env); // throws before any thread exists when it does not fit (M-3)
    defaultPool = new NativeRenderPool({
      size: plan.size,
      maxOldGenerationSizeMb: plan.heapLimitMb,
    });
  }
  return defaultPool;
}

/**
 * THE entry point for `renderReportPdf` / `renderNativePdf` in native mode: renders `{ kind, viewModel, generatedAt }`
 * in the process-wide pool (created on first use with `PDF_NATIVE_CONCURRENCY` threads) and resolves to the PDF bytes.
 * Unprintable characters are replaced by a visible marker and logged as counts (F1); they never fail the render.
 *
 * Rejects with:
 *  - `PdfRenderTimeoutError` (step `native-render`, 30 s): the thread was terminated;
 *  - `PdfNativeThreadCrashError` (`error_PDF_NATIVE_OUT_OF_MEMORY` / `error_PDF_NATIVE_THREAD_CRASH`);
 *  - `PdfNativeInputError`: not plain data, unknown kind, bad generatedAt;
 *  - `PdfRenderPoolSaturatedError` / `PdfRenderPoolClosedError`; `PdfNativeRenderError` for anything else.
 * No fallback to Chromium (T3): every failure propagates to the job's normal failure and retry path.
 */
export function renderInPool(request: NativeRenderRequest): Promise<Buffer> {
  return processPool().render(request);
}

/**
 * F3: call once at Worker boot, WITHOUT awaiting (it returns void): starts `PDF_NATIVE_PREWARM` threads (default 2, at
 * most `PDF_NATIVE_CONCURRENCY`) in the background of the process-wide pool. Never throws for a thread problem (logged
 * by the pool); throws only for an invalid `PDF_NATIVE_PREWARM` value, which the Worker's env validation also refuses.
 * The health heartbeat never depends on it: no thread, ready or not, keeps or blocks the event loop.
 */
export function prewarmRenderPool(
  threads: number = pdfNativePrewarm(process.env),
): void {
  processPool().prewarm(threads);
}

/** Graceful shutdown of the process-wide pool (Worker shutdown hook, tests). Safe to call when none exists. */
export async function shutdownRenderPool(): Promise<void> {
  const pool = defaultPool;
  defaultPool = undefined;
  await pool?.destroy();
}
