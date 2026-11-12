import * as nodeModule from 'module';

/**
 * Installed FIRST in every native PDF render thread, before react-pdf or any layout is loaded (plan §4.2/§8 P3,
 * trade-off T1). The render path needs no network, no child process, no nested thread and no inspector; this makes
 * each of those fail closed inside the thread, and records every attempt so tests can assert there were none.
 *
 *  1. Module resolution: a synchronous `module.registerHooks` resolve hook refuses `http`, `https`, `http2`, `net`,
 *     `tls`, `dgram`, `dns`, `child_process`, `cluster`, `worker_threads`, `inspector` (with or without `node:`) and the
 *     userland HTTP clients, for `require` AND `import` alike (react-pdf is ESM loaded through require(esm)). If the
 *     running Node has no `registerHooks`, the thread refuses to start.
 *  2. Globals: `fetch`, `WebSocket` and `EventSource` are replaced by stubs that record the call and reject (react-pdf
 *     would `fetch()` an `<Image src="http…">` or a URL font source; yoga's wasm loader checks `typeof fetch` but uses
 *     its embedded base64 binary, so a rejecting stub is safe).
 *  3. Clock (D7): `Date` is replaced by a subclass whose no-argument constructor and `Date.now()` return the current
 *     request's `generatedAt`. Nothing in a rendered PDF can come from the wall clock (pdfkit's default CreationDate,
 *     its file /ID hash input, a layout calling `new Date()`), so the same request yields the same bytes.
 *     `performance.now()` is untouched and is what the thread uses for timings.
 */

const BLOCKED_MODULES: ReadonlySet<string> = new Set([
  'http',
  'https',
  'http2',
  'net',
  'tls',
  'dgram',
  'dns',
  'dns/promises',
  '_http_client',
  '_http_agent',
  '_tls_wrap',
  'child_process',
  'cluster',
  'worker_threads',
  'inspector',
  'inspector/promises',
  'undici',
  'node-fetch',
  'cross-fetch',
  'axios',
  'ws',
]);

/** `process.moduleLoadList` entries for builtins that can open a connection. */
const NETWORK_BUILTIN =
  /^NativeModule (?:net|http|https|http2|tls|dgram|dns|_http_client|_http_agent|_tls_wrap|internal\/http2\/core|internal\/dns\/promises)$/;

const blockedModules: string[] = [];
const blockedGlobals: string[] = [];
let installed = false;
let clockMs = 0;

export class PdfRenderThreadGuardError extends Error {
  readonly code = 'error_PDF_THREAD_GUARD';
  constructor(message: string) {
    super(message);
    this.name = 'PdfRenderThreadGuardError';
  }
}

function blockedName(specifier: string): string | undefined {
  const bare = specifier.startsWith('node:') ? specifier.slice(5) : specifier;
  if (BLOCKED_MODULES.has(bare)) return bare;
  const pkg = bare.split('/')[0]!;
  return BLOCKED_MODULES.has(pkg) && !bare.startsWith('.') ? pkg : undefined;
}

type RegisterHooks = (hooks: {
  resolve: (
    specifier: string,
    context: unknown,
    next: (specifier: string, context?: unknown) => unknown,
  ) => unknown;
}) => unknown;

function installModuleHook(): void {
  const registerHooks = (
    nodeModule as unknown as { registerHooks?: RegisterHooks }
  ).registerHooks;
  if (typeof registerHooks !== 'function') {
    throw new PdfRenderThreadGuardError(
      'native PDF render thread: module.registerHooks is unavailable (Node >= 22.15 required); refusing to start',
    );
  }
  registerHooks({
    resolve(specifier, context, next) {
      const name = blockedName(specifier);
      if (name !== undefined) {
        blockedModules.push(name);
        throw new PdfRenderThreadGuardError(
          `native PDF render thread: module "${name}" is not available (no network, no processes)`,
        );
      }
      return next(specifier, context);
    },
  });
}

/** Only the scheme of a refused URL is recorded (`fetch(data:)`, `fetch(http:)`), never the URL itself. */
function schemeOf(target: unknown): string {
  const m =
    typeof target === 'string'
      ? /^([a-z][a-z0-9+.-]{0,15}):/i.exec(target)
      : null;
  return m ? `${m[1]!.toLowerCase()}:` : typeof target;
}

function installGlobalStubs(): void {
  const g = globalThis as Record<string, unknown>;
  const stub = (name: string) =>
    function blocked(target?: unknown): Promise<never> {
      blockedGlobals.push(`${name}(${schemeOf(target)})`);
      return Promise.reject(
        new PdfRenderThreadGuardError(
          `native PDF render thread: ${name} is disabled (no network)`,
        ),
      );
    };
  for (const name of ['fetch', 'WebSocket', 'EventSource']) {
    // delete first: Node defines WebSocket as a lazy global, and redefining it in place would load undici (and with it
    // the net/http/tls builtins) just to replace it.
    delete g[name];
    Object.defineProperty(g, name, {
      value: stub(name),
      writable: false,
      configurable: false,
      enumerable: false,
    });
  }
}

function installFrozenClock(): void {
  const RealDate = Date;
  class RenderClockDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(clockMs);
      else super(...(args as [string | number | Date]));
    }
    static override now(): number {
      return clockMs;
    }
    static override [Symbol.hasInstance](v: unknown): boolean {
      return v instanceof RealDate;
    }
  }
  Object.defineProperty(globalThis, 'Date', {
    value: RenderClockDate,
    writable: false,
    configurable: false,
    enumerable: false,
  });
}

/** Idempotent. Throws `PdfRenderThreadGuardError` if the module hook cannot be installed (the thread then refuses). */
export function installThreadGuard(): void {
  if (installed) return;
  installModuleHook();
  installGlobalStubs();
  installFrozenClock();
  installed = true;
}

/** D7: the clock every `new Date()` / `Date.now()` in this thread returns until the next call. */
export function setRenderClock(ms: number): void {
  clockMs = ms;
}

export function guardReport(): {
  blockedModules: string[];
  blockedGlobals: string[];
  networkBuiltinsLoaded: string[];
} {
  const loaded =
    (process as unknown as { moduleLoadList?: string[] }).moduleLoadList ?? [];
  return {
    blockedModules: [...blockedModules],
    blockedGlobals: [...blockedGlobals],
    networkBuiltinsLoaded: loaded.filter((m) => NETWORK_BUILTIN.test(m)),
  };
}
