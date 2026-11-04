/**
 * Native PDF render runtime: the request shape, the messages between the jobs process and a render thread, and the
 * errors both sides raise (PDF renderer migration P1, plan §4.2-§4.4, owner decisions D3/D7, trade-off T1).
 *
 * This module is imported by BOTH sides, so it imports nothing but Node's `util` types: never react-pdf, never the
 * Chromium renderer, never anything that opens a socket.
 */

/**
 * One document to render. Structured-cloneable data only: it crosses a `postMessage` boundary into a thread that has no
 * database, no credentials and no network.
 *
 *  - `kind`: the document type; the thread looks it up in the native document registry (`native-documents`).
 *  - `viewModel`: the document's view-model, built in the jobs process by the document's rab-server builder. Allowed
 *    values: strings, booleans, finite numbers, null/undefined, arrays, plain objects, and `Buffer`/`Uint8Array`
 *    (image bytes; the thread hands them to the layout as `Buffer`). Anything else (Date, Map, class instances,
 *    functions, symbols, NaN/Infinity) is refused before the thread sees it.
 *  - `generatedAt`: the document's own timestamp (ISO-8601 string or Date). D7: it becomes the PDF's
 *    CreationDate/ModDate and the render thread's only clock, so the same request always yields the same bytes.
 */
export interface NativeRenderRequest<K extends string = string, VM = unknown> {
  kind: K;
  viewModel: VM;
  generatedAt: string | Date;
}

/** What a registry function receives besides the view-model (D7): spread these onto `<Document>`. */
export interface NativeDocumentMeta {
  creationDate: Date;
  modificationDate: Date;
}

// ─── messages ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface RenderJobMessage {
  type: 'render';
  id: number;
  kind: string;
  viewModel: unknown;
  generatedAtMs: number;
}
export interface ProbeMessage {
  type: 'probe';
  id: number;
}
export type ToThreadMessage = RenderJobMessage | ProbeMessage;

export interface SerializedRenderError {
  name: string;
  code: string;
  message: string;
  field?: string;
}

export interface RenderTimings {
  /** Glyph-coverage pre-check of every string in the view-model. */
  coverageMs: number;
  /** Element build + react-pdf layout + PDF serialisation. */
  renderMs: number;
}

export type FromThreadMessage =
  | { type: 'ready'; initMs: number }
  | { type: 'init-error'; error: SerializedRenderError }
  | {
      type: 'result';
      id: number;
      ok: true;
      pdf: ArrayBuffer;
      timings: RenderTimings;
    }
  | { type: 'result'; id: number; ok: false; error: SerializedRenderError }
  | { type: 'probe-result'; id: number; report: ThreadProbeReport };

/** Test-only introspection (answered only when the pool was created with `allowProbe: true`). */
export interface ThreadProbeReport {
  threadId: number;
  envKeys: string[];
  /** Module specifiers the guard refused (network, process, thread or inspector modules). */
  blockedModules: string[];
  /** Calls to the disabled `fetch`/`WebSocket`/`EventSource` globals. */
  blockedGlobals: string[];
  /** Node builtins loaded in this thread that can open a connection (`process.moduleLoadList`). */
  networkBuiltinsLoaded: string[];
  registeredFontFamilies: string[];
  coverageFamilies: string[];
  heapUsedBytes: number;
  rendersServed: number;
  /** `Date.now()` inside the thread right now (the frozen render clock, D7). */
  clockNowMs: number;
}

/** Data passed as `workerData` when a render thread is created. */
export interface RenderThreadData {
  documentsModule: string;
  allowProbe: boolean;
}

// ─── errors ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Base class: every failure of the native runtime carries a stable, non-personal `code`. */
export class PdfNativeRenderError extends Error {
  constructor(
    message: string,
    readonly code: string = 'error_PDF_NATIVE_RENDER',
  ) {
    super(message);
    this.name = 'PdfNativeRenderError';
  }
}

/**
 * D3: a string in the view-model contains a character none of the embedded fonts can draw. The render is refused
 * (never a silent blank). `field` is the structural path inside the view-model (`rows[3].name`); the VALUE and the
 * offending character are never included, because the value may be personal data.
 */
export class PdfGlyphCoverageError extends PdfNativeRenderError {
  constructor(
    readonly field: string,
    readonly unsupportedCount: number,
  ) {
    super(
      `native PDF renderer: field "${field}" contains ${unsupportedCount} character(s) the embedded fonts cannot draw; ` +
        'render refused (D3, never dropped silently)',
      'error_PDF_GLYPH_UNSUPPORTED',
    );
    this.name = 'PdfGlyphCoverageError';
  }
}

/** The request itself is malformed (not serialisable data, unknown document kind, bad timestamp). */
export class PdfNativeInputError extends PdfNativeRenderError {
  constructor(message: string) {
    super(message, 'error_PDF_NATIVE_INPUT');
    this.name = 'PdfNativeInputError';
  }
}

/** The render thread died (heap limit, crash, unexpected exit). The thread is discarded; the next render gets a new one. */
export class PdfNativeThreadCrashError extends PdfNativeRenderError {
  constructor(
    message: string,
    readonly causeCode: string,
  ) {
    super(
      message,
      causeCode === 'ERR_WORKER_OUT_OF_MEMORY'
        ? 'error_PDF_NATIVE_OUT_OF_MEMORY'
        : 'error_PDF_NATIVE_THREAD_CRASH',
    );
    this.name = 'PdfNativeThreadCrashError';
  }
}

/** The pool's queue is full (fail closed instead of buffering without bound). */
export class PdfRenderPoolSaturatedError extends PdfNativeRenderError {
  constructor(maxQueue: number) {
    super(
      `native PDF render pool: queue full (${maxQueue} waiting); render refused`,
      'error_PDF_NATIVE_SATURATED',
    );
    this.name = 'PdfRenderPoolSaturatedError';
  }
}

/** The pool was shut down; pending and new renders are refused. */
export class PdfRenderPoolClosedError extends PdfNativeRenderError {
  constructor() {
    super('native PDF render pool: shut down', 'error_PDF_NATIVE_POOL_CLOSED');
    this.name = 'PdfRenderPoolClosedError';
  }
}

export function serializeRenderError(err: unknown): SerializedRenderError {
  if (err instanceof PdfGlyphCoverageError) {
    return {
      name: err.name,
      code: err.code,
      message: err.message,
      field: err.field,
    };
  }
  if (err instanceof PdfNativeRenderError)
    return { name: err.name, code: err.code, message: err.message };
  const e = err instanceof Error ? err : new Error(String(err));
  // Library messages (react-pdf, fontkit, yoga) describe layout state, not document text; bounded anyway.
  return {
    name: 'PdfNativeRenderError',
    code: 'error_PDF_NATIVE_RENDER',
    message: `native PDF renderer: ${e.message}`.slice(0, 500),
  };
}

export function deserializeRenderError(
  s: SerializedRenderError,
): PdfNativeRenderError {
  if (s.code === 'error_PDF_GLYPH_UNSUPPORTED' && typeof s.field === 'string') {
    const m = /contains (\d+) character/.exec(s.message);
    return new PdfGlyphCoverageError(s.field, m ? Number(m[1]) : 1);
  }
  if (s.code === 'error_PDF_NATIVE_INPUT')
    return new PdfNativeInputError(s.message);
  const e = new PdfNativeRenderError(s.message, s.code);
  return e;
}

// ─── view-model validation (jobs-process side, before postMessage) ───────────────────────────────────────────────────

const MAX_DEPTH = 32;

/**
 * Refuses anything that is not plain data. Structured clone would silently turn a class instance into a plain object
 * and a Date into a Date (giving the layout a clock and a way to compute); both are refused here instead.
 */
export function assertPlainViewModel(
  value: unknown,
  path = 'viewModel',
  depth = 0,
): void {
  if (depth > MAX_DEPTH)
    throw new PdfNativeInputError(
      `native PDF renderer: ${path} is nested deeper than ${MAX_DEPTH}`,
    );
  if (value === null || value === undefined) return;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return;
    case 'number':
      if (!Number.isFinite(value))
        throw new PdfNativeInputError(
          `native PDF renderer: ${path} is not a finite number`,
        );
      return;
    case 'object':
      break;
    default:
      throw new PdfNativeInputError(
        `native PDF renderer: ${path} is a ${typeof value}; view-models carry data only`,
      );
  }
  if (value instanceof Uint8Array) return; // Buffer included: image bytes
  if (Array.isArray(value)) {
    value.forEach((item, i) =>
      assertPlainViewModel(item, `${path}[${i}]`, depth + 1),
    );
    return;
  }
  const proto = Object.getPrototypeOf(value) as unknown;
  if (proto !== Object.prototype && proto !== null) {
    throw new PdfNativeInputError(
      `native PDF renderer: ${path} is not a plain object (Date, Map, class instances are refused)`,
    );
  }
  for (const key of Object.keys(value)) {
    assertPlainViewModel(
      (value as Record<string, unknown>)[key],
      `${path}${fieldSegment(key)}`,
      depth + 1,
    );
  }
}

/**
 * One path segment for error messages. View-model keys are code-defined identifiers; a key that does not look like one
 * (it could be data used as a key) is masked so an error message can never carry it.
 */
export function fieldSegment(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(key) ? `.${key}` : '[<key>]';
}
